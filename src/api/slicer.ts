/**
 * Bridge to the PrusaSlicer CLI.
 *
 * The caller supplies a path to an INI profile (printer + filament + print
 * settings) plus the frozen STL snapshot path. Both are the caller's
 * responsibility — the server injects no hidden defaults.
 *
 * Optional explicit overrides are forwarded as CLI flags on top of the profile:
 *   --layer-height N       (layer_height_mm)
 *   --fill-density N%      (infill_percent, expressed as integer 0-100)
 *   --filament-density N   (filament_density_g_cm3)
 *
 * Validated CLI syntax (PrusaSlicer 2.9.2, aarch64 Debian trixie):
 *   prusa-slicer --load <profile.ini> [overrides...] \
 *     --export-gcode --output <out.gcode> <in.stl>
 *
 * Stats always present in the G-code comment block:
 *   ; filament used [mm] = 1487.15
 *   ; filament used [cm3] = 3.58         → filament_volume_mm3 = 3580
 *   ; filament used [g]   = 4.44         (only when filament_density is set)
 *   ; estimated printing time (normal mode) = 19m 50s
 *   ; estimated printing time (silent mode) = 20m 40s
 *
 * Reference values for the 20 mm cube at pla_0.4_0.2.ini (PrusaSlicer 2.9.2):
 *   filament_length_mm  = 1487.15
 *   filament_volume_mm3 = 3580
 *   filament_mass_g     = 4.44
 *   print_time_s        = 1190  (19m 50s)
 */

/** Raised when the prusa-slicer executable cannot be found on PATH. */
export class SlicerNotFoundError extends Error {
  constructor() {
    super(
      "The prusa-slicer executable was not found on PATH. " +
        "Install it first: `apt install prusa-slicer` (Debian trixie/sid).",
    );
    this.name = "SlicerNotFoundError";
  }
}

/** Raised on slicing failures; attaches the tail of prusa-slicer output. */
export class SlicingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlicingError";
  }
}

export interface SliceOptions {
  /** Path to the frozen STL snapshot (read-only, from snapshotStlArtifact). */
  stlPath: string;
  /** Path to the frozen INI profile snapshot (read-only, from snapshotIniArtifact). */
  profileIniPath: string;
  /**
   * Override the layer height from the profile.
   * Forwarded as --layer-height N to prusa-slicer.
   */
  layerHeightMm?: number;
  /**
   * Override the infill density from the profile (integer, 0-100 percent).
   * Forwarded as --fill-density N% to prusa-slicer.
   */
  infillPercent?: number;
  /**
   * Override the filament density from the profile (g/cm³).
   * Forwarded as --filament-density N to prusa-slicer.
   * When absent and the profile also lacks density, filament_mass_g is absent.
   */
  filamentDensityGcm3?: number;
  /** Maximum time to wait for prusa-slicer before sending SIGKILL. */
  timeoutMs?: number;
}

export interface SliceResult {
  /** Filament length consumed, in mm. */
  filament_length_mm: number;
  /**
   * Filament volume consumed, in mm³.
   * Converted from the "filament used [cm3]" G-code comment (× 1000).
   */
  filament_volume_mm3: number;
  /**
   * Filament mass consumed, in grams.
   * Absent when neither the profile nor the override provides filament_density.
   */
  filament_mass_g: number | null;
  /** Estimated print time in seconds (normal mode). */
  print_time_s: number;
  /** Raw time string as written by PrusaSlicer, e.g. "19m 50s". */
  print_time_normal_mode: string;
  /** Raw time string for silent mode, e.g. "20m 40s". null if absent from G-code. */
  print_time_silent_mode: string | null;
  /**
   * SHA-256 hex digest of the produced G-code file.
   * NOTE: PrusaSlicer embeds a build timestamp — identical inputs on different
   * dates produce different hashes. The hash is an audit trail, not a
   * reproducibility guarantee.
   */
  gcode_sha256: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Parse "19m 50s", "1h 2m 30s", "45s" etc. into total seconds.
 * Returns null if the format is unrecognised.
 */
export function parsePrusaTime(raw: string): number | null {
  // Matches tokens like "1h", "2m", "30s" in any order.
  const pattern = /(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?/;
  const m = raw.trim().match(pattern);
  if (!m || (!m[1] && !m[2] && !m[3])) return null;
  const h = parseInt(m[1] ?? "0", 10);
  const min = parseInt(m[2] ?? "0", 10);
  const sec = parseInt(m[3] ?? "0", 10);
  return h * 3600 + min * 60 + sec;
}

function sha256Hex(bytes: Uint8Array): Promise<string> {
  const contiguous = Uint8Array.from(bytes);
  return crypto.subtle.digest("SHA-256", contiguous.buffer).then((digest) =>
    Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
  );
}

/**
 * Slice an STL using a caller-supplied INI profile. Returns measurements
 * extracted from the G-code comment block plus the G-code hash.
 * Does not emit prices.
 */
export async function sliceFff(options: SliceOptions): Promise<SliceResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Validate layer height override if provided.
  if (
    options.layerHeightMm !== undefined &&
    (!isFinite(options.layerHeightMm) || options.layerHeightMm <= 0)
  ) {
    throw new SlicingError(
      "[slicer_estimate_fff] layer_height_mm must be a positive finite number.",
    );
  }
  // Validate infill override if provided.
  if (
    options.infillPercent !== undefined &&
    (!Number.isInteger(options.infillPercent) ||
      options.infillPercent < 0 ||
      options.infillPercent > 100)
  ) {
    throw new SlicingError(
      "[slicer_estimate_fff] infill_percent must be an integer in 0-100.",
    );
  }
  // Validate density override if provided.
  if (
    options.filamentDensityGcm3 !== undefined &&
    (!isFinite(options.filamentDensityGcm3) || options.filamentDensityGcm3 <= 0)
  ) {
    throw new SlicingError(
      "[slicer_estimate_fff] filament_density_g_cm3 must be a positive finite number.",
    );
  }

  const workDir = await Deno.makeTempDir({ prefix: "slicer-run-" });
  const gcodeOut = `${workDir}/output.gcode`;
  const cleanup = () => Deno.remove(workDir, { recursive: true }).catch(() => {});

  // Build CLI override flags (applied on top of the profile).
  const overrideArgs: string[] = [];
  if (options.layerHeightMm !== undefined) {
    overrideArgs.push("--layer-height", String(options.layerHeightMm));
  }
  if (options.infillPercent !== undefined) {
    overrideArgs.push("--fill-density", `${options.infillPercent}%`);
  }
  if (options.filamentDensityGcm3 !== undefined) {
    overrideArgs.push("--filament-density", String(options.filamentDensityGcm3));
  }

  try {
    let child;
    try {
      child = new Deno.Command("prusa-slicer", {
        args: [
          "--load",
          options.profileIniPath,
          ...overrideArgs,
          "--export-gcode",
          "--output",
          gcodeOut,
          options.stlPath,
        ],
        stdout: "piped",
        stderr: "piped",
      }).spawn();
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) throw new SlicerNotFoundError();
      throw e;
    }

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch { /* already exited */ }
    }, timeoutMs);
    const { success, stdout, stderr } = await child.output();
    clearTimeout(timer);

    const log = new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr);

    if (!success) {
      throw new SlicingError(
        `prusa-slicer failed (killed after ${timeoutMs}ms or slicing error): ` +
          log.slice(-800),
      );
    }

    // exit 0 does not guarantee the G-code file was written — verify.
    let gcodeBytes: Uint8Array;
    try {
      gcodeBytes = await Deno.readFile(gcodeOut);
    } catch {
      throw new SlicingError(
        "prusa-slicer reported success but wrote no G-code file. Log: " +
          log.slice(-400),
      );
    }

    if (!gcodeBytes.length) {
      throw new SlicingError(
        "prusa-slicer wrote an empty G-code file. Log: " + log.slice(-400),
      );
    }

    const gcodeText = new TextDecoder().decode(gcodeBytes);
    const gcode_sha256 = await sha256Hex(gcodeBytes);
    const sliceResult = parseGcodeStats(gcodeText);

    return { ...sliceResult, gcode_sha256 };
  } finally {
    await cleanup();
  }
}

/**
 * Extract measurement fields from the PrusaSlicer G-code comment block.
 * These comment lines always appear near the end of the file.
 *
 * Fail-closed: any format deviation raises a SlicingError naming the exact
 * line that could not be parsed.
 */
function parseGcodeStats(
  gcode: string,
): Omit<SliceResult, "gcode_sha256"> {
  function extract(pattern: RegExp): string | null {
    const m = gcode.match(pattern);
    return m ? m[1].trim() : null;
  }

  const mmRaw = extract(/^;\s*filament used \[mm\]\s*=\s*(.+)$/m);
  const cm3Raw = extract(/^;\s*filament used \[cm3\]\s*=\s*(.+)$/m);
  const gRaw = extract(/^;\s*filament used \[g\]\s*=\s*(.+)$/m);
  const timeNormalRaw = extract(
    /^;\s*estimated printing time \(normal mode\)\s*=\s*(.+)$/m,
  );
  const timeSilentRaw = extract(
    /^;\s*estimated printing time \(silent mode\)\s*=\s*(.+)$/m,
  );

  if (!mmRaw) {
    throw new SlicingError(
      "G-code is missing expected stat comment: '; filament used [mm] = ...'. " +
        "The profile may have caused a partially failed slice.",
    );
  }
  if (!cm3Raw) {
    throw new SlicingError(
      "G-code is missing expected stat comment: '; filament used [cm3] = ...'. " +
        "The profile may have caused a partially failed slice.",
    );
  }
  if (!timeNormalRaw) {
    throw new SlicingError(
      "G-code is missing expected stat comment: " +
        "'; estimated printing time (normal mode) = ...'. " +
        "The profile may have caused a partially failed slice.",
    );
  }

  const filament_length_mm = parseFloat(mmRaw);
  const filament_cm3 = parseFloat(cm3Raw);

  if (!isFinite(filament_length_mm)) {
    throw new SlicingError(
      `Could not parse filament length from G-code: '; filament used [mm] = ${mmRaw}'.`,
    );
  }
  if (!isFinite(filament_cm3)) {
    throw new SlicingError(
      `Could not parse filament volume from G-code: '; filament used [cm3] = ${cm3Raw}'.`,
    );
  }

  // Convert cm³ → mm³ for the output contract.
  const filament_volume_mm3 = Math.round(filament_cm3 * 1000 * 100) / 100;

  // Mass is only present when filament_density is declared in the profile.
  // PrusaSlicer emits "0.00" when density is missing — treat as absent.
  let filament_mass_g: number | null = null;
  if (gRaw !== null) {
    const parsed = parseFloat(gRaw);
    if (!isFinite(parsed)) {
      throw new SlicingError(
        `Could not parse filament mass from G-code: '; filament used [g] = ${gRaw}'.`,
      );
    }
    if (parsed > 0) {
      filament_mass_g = parsed;
    }
  }

  const print_time_s = parsePrusaTime(timeNormalRaw);
  if (print_time_s === null) {
    throw new SlicingError(
      `Could not parse print time from G-code: '; estimated printing time (normal mode) = ${timeNormalRaw}'.`,
    );
  }

  return {
    filament_length_mm,
    filament_volume_mm3,
    filament_mass_g,
    print_time_s,
    print_time_normal_mode: timeNormalRaw,
    print_time_silent_mode: timeSilentRaw,
  };
}
