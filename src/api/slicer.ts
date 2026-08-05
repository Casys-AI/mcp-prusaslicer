/**
 * Bridge to the PrusaSlicer CLI.
 *
 * The caller supplies an INI profile string (printer + filament + print
 * settings). We write it to a temp file, invoke prusa-slicer, then parse
 * the G-code comment block that PrusaSlicer emits at the end of every file.
 *
 * Validated CLI syntax (PrusaSlicer 2.9.2, aarch64 Debian trixie):
 *   prusa-slicer --load <profile.ini> --export-gcode --output <out.gcode> <in.stl>
 *
 * Stats always present in the G-code comment block:
 *   ; filament used [mm] = 426.64
 *   ; filament used [cm3] = 1.03
 *   ; filament used [g] = 1.27        (only when filament_density is set)
 *   ; estimated printing time (normal mode) = 12m 45s
 *   ; estimated printing time (silent mode) = 12m 50s
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
  /** Path to the frozen STL snapshot (read-only, absolute). */
  stlPath: string;
  /**
   * Full INI profile content as a string (printer + filament + print
   * settings). The caller is the authority on what parameters are used;
   * the server never injects hidden defaults.
   */
  profileIni: string;
  /** Maximum time to wait for prusa-slicer before sending SIGKILL. */
  timeoutMs?: number;
}

export interface SliceResult {
  /** Filament length consumed, in mm. */
  filament_used_mm: number;
  /** Filament volume consumed, in cm³. */
  filament_used_cm3: number;
  /**
   * Filament mass consumed, in grams.
   * null when filament_density is absent from the profile (no density → no mass).
   */
  filament_used_g: number | null;
  /** Raw time string as written by PrusaSlicer, e.g. "12m 45s". */
  print_time_normal_mode: string;
  /** Raw time string for silent mode (lower accelerations), e.g. "12m 50s". */
  print_time_silent_mode: string | null;
  /** Estimated print time in seconds (normal mode). */
  estimated_print_time_s: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Parse "12m 45s", "1h 2m 30s", "45s" etc. into total seconds.
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

/**
 * Slice an STL using a caller-supplied INI profile. Returns measurements
 * extracted from the G-code comment block. Does not emit prices.
 */
export async function sliceFff(options: SliceOptions): Promise<SliceResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  if (!options.profileIni.trim()) {
    throw new SlicingError(
      "[slicer_estimate_fff] profile_ini must not be empty. " +
        "Provide a PrusaSlicer-compatible INI with at minimum: " +
        "nozzle_diameter, layer_height, filament_diameter, bed_shape.",
    );
  }

  const workDir = await Deno.makeTempDir({ prefix: "slicer-run-" });
  const profilePath = `${workDir}/profile.ini`;
  const gcodeOut = `${workDir}/output.gcode`;
  const cleanup = () => Deno.remove(workDir, { recursive: true }).catch(() => {});

  try {
    await Deno.writeTextFile(profilePath, options.profileIni);

    let child;
    try {
      child = new Deno.Command("prusa-slicer", {
        args: [
          "--load",
          profilePath,
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
    let gcodeText: string;
    try {
      gcodeText = await Deno.readTextFile(gcodeOut);
    } catch {
      throw new SlicingError(
        "prusa-slicer reported success but wrote no G-code file. Log: " +
          log.slice(-400),
      );
    }

    if (!gcodeText.trim()) {
      throw new SlicingError(
        "prusa-slicer wrote an empty G-code file. Log: " + log.slice(-400),
      );
    }

    return parseGcodeStats(gcodeText);
  } finally {
    await cleanup();
  }
}

/**
 * Extract measurement fields from the PrusaSlicer G-code comment block.
 * These comment lines always appear near the end of the file.
 */
function parseGcodeStats(gcode: string): SliceResult {
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

  if (!mmRaw || !cm3Raw || !timeNormalRaw) {
    throw new SlicingError(
      "G-code output is missing expected stat comments " +
        "(filament used [mm], filament used [cm3], estimated printing time). " +
        "The profile may have caused a partially failed slice.",
    );
  }

  const filament_used_mm = parseFloat(mmRaw);
  const filament_used_cm3 = parseFloat(cm3Raw);

  if (!isFinite(filament_used_mm) || !isFinite(filament_used_cm3)) {
    throw new SlicingError(
      `Could not parse filament stats from G-code: mm="${mmRaw}" cm3="${cm3Raw}".`,
    );
  }

  // g is only present when filament_density is declared in the profile.
  let filament_used_g: number | null = null;
  if (gRaw !== null) {
    const parsed = parseFloat(gRaw);
    // PrusaSlicer emits "0.00" when density is missing — treat as absent.
    if (isFinite(parsed) && parsed > 0) {
      filament_used_g = parsed;
    }
  }

  const estimated_print_time_s = parsePrusaTime(timeNormalRaw);
  if (estimated_print_time_s === null) {
    throw new SlicingError(
      `Could not parse print time from G-code: "${timeNormalRaw}".`,
    );
  }

  return {
    filament_used_mm,
    filament_used_cm3,
    filament_used_g,
    print_time_normal_mode: timeNormalRaw,
    print_time_silent_mode: timeSilentRaw,
    estimated_print_time_s,
  };
}
