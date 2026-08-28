/**
 * prusaslicer_estimate_fff — FDM slicing estimation tool.
 *
 * Slices an STL with a caller-supplied PrusaSlicer INI profile and returns
 * print-time and material-consumption measurements from the real G-code stats.
 *
 * The profile_ini_path supplies the base print configuration. Explicit tool
 * overrides, when present, are forwarded after the profile is loaded.
 * The server embeds no production profile knowledge.
 * No prices — pricing is downstream (erpnext).
 *
 * Output contract:
 *   print_time_s        — normal-mode estimate in seconds
 *   filament_length_mm  — total filament path length in mm
 *   filament_volume_mm3 — total filament volume in mm³ (cm³ × 1000)
 *   filament_mass_g     — ABSENT when density is absent from the profile
 *                         (rule: no density → no mass; never invent a value)
 *   gcode_sha256        — SHA-256 of the produced G-code (audit trail)
 *   engine_name         — observed slicer name from the G-code header
 *   engine_version      — observed slicer version from the G-code header
 *   effective_config_sha256 — SHA-256 of the emitted prusaslicer_config block
 *   effective_config_summary — bounded raw projection tied to that same hash
 *   overrides_applied   — caller-provided print overrides that were forwarded
 *   stl_artifact        — attestation of the STL consumed
 *   profile_artifact    — attestation of the INI profile consumed
 */

import {
  InputArtifactError,
  snapshotIniArtifact,
  snapshotStlArtifact,
} from "../api/input-artifact.ts";
import { sliceFff, SlicerNotFoundError, SlicingError } from "../api/prusa-slicer.ts";
import type { SlicerTool } from "./types.ts";

const TOOL_NAME = "prusaslicer_estimate_fff";

const NOT_CHECKED: string[] = [
  "Bed adhesion (first-layer adhesion to build plate) is not verified.",
  "Warping risk is not assessed; use a brim or enclosure settings in the profile if needed.",
  "Dimensional tolerances of the printed part are not estimated; shrinkage is not modelled.",
  "Print-time accuracy depends on printer firmware and acceleration settings; the estimate" +
  " is PrusaSlicer's own heuristic and may differ from observed print time.",
  "Support volume is not included in the material estimate when supports are disabled in the profile.",
  "Multi-material or multi-extruder configurations are not tested; use a single-extruder profile.",
  "filament_mass_g is absent (not null) when filament_density is not set in the profile or override.",
  "gcode_sha256 includes a build timestamp emitted by PrusaSlicer; identical inputs on" +
  " different dates produce different G-code hashes.",
  "engine_name and engine_version are parsed from the G-code header, not from the" +
  " prusa-slicer binary.",
  "effective_config_sha256 hashes the emitted prusaslicer_config block, not the input INI.",
  "effective_config_summary is a fixed raw-key projection of that emitted block; null means the selected key was absent, not that a PrusaSlicer default was inferred.",
];

const INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["stl_path", "profile_ini_path"],
  properties: {
    stl_path: {
      type: "string",
      description:
        "Absolute path to the admitted STL file to slice. Only .stl paths are accepted;" +
        " the server rejects project archives and non-STL content before snapshotting" +
        " or invoking PrusaSlicer.",
    },
    stl_sha256: {
      type: "string",
      description:
        "Optional SHA-256 hex digest of the STL file. When provided, the server" +
        " verifies the file content before slicing — ensures the exact committed" +
        " geometry was consumed.",
    },
    profile_ini_path: {
      type: "string",
      description:
        "Absolute path to a PrusaSlicer INI profile file. The server reads this" +
        " file and passes it to prusa-slicer via --load. The profile supplies the" +
        " caller-owned base parameters (speeds, temperatures, nozzle, bed shape);" +
        " explicit tool overrides take precedence where provided." +
        " Include filament_density to get filament_mass_g in the output.",
    },
    profile_sha256: {
      type: "string",
      description:
        "Optional SHA-256 hex digest of the profile file. When provided, the server" +
        " verifies the profile content before slicing.",
    },
    layer_height_mm: {
      type: "number",
      description:
        "Override the layer height from the profile. Forwarded as --layer-height N" +
        " to prusa-slicer (mm, positive).",
    },
    infill_percent: {
      type: "number",
      description:
        "Override the infill density from the profile (integer 0-100). Forwarded as" +
        " --fill-density N% to prusa-slicer.",
    },
    filament_density_g_cm3: {
      type: "number",
      description: "Override the filament density (g/cm³, positive). Forwarded as" +
        " --filament-density N. Mass remains the positive statistic emitted by" +
        " PrusaSlicer; the server does not recompute it.",
    },
    timeout_ms: {
      type: "integer",
      minimum: 1,
      description:
        "Maximum time in milliseconds to wait for prusa-slicer before aborting." +
        " Positive integer. Default: 120000 (2 minutes). Complex models may need more.",
    },
  },
};

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "print_time_s",
    "print_time_normal_mode",
    "print_time_silent_mode",
    "filament_length_mm",
    "filament_volume_mm3",
    "gcode_sha256",
    "engine_name",
    "engine_version",
    "effective_config_sha256",
    "effective_config_summary",
    "overrides_applied",
    "not_checked",
    "stl_artifact",
    "profile_artifact",
  ],
  properties: {
    print_time_s: {
      type: "number",
      description: "Estimated print time in seconds (normal/quality mode).",
    },
    print_time_normal_mode: {
      type: "string",
      description: 'Raw time string from the G-code, e.g. "19m 50s" or "1h 2m 30s".',
    },
    print_time_silent_mode: {
      type: ["string", "null"],
      description: "Raw time string for silent mode. null if absent from G-code.",
    },
    filament_length_mm: {
      type: "number",
      description: "Total filament path length consumed, in millimetres.",
    },
    filament_volume_mm3: {
      type: "number",
      description: "Total filament volume consumed, in mm³ (converted from the G-code" +
        " '; filament used [cm3]' comment × 1000).",
    },
    filament_mass_g: {
      type: "number",
      description: "Total filament mass consumed, in grams. ABSENT (not null) when" +
        " filament_density is not set in the profile or the filament_density_g_cm3" +
        " override. The server never invents a density.",
    },
    gcode_sha256: {
      type: "string",
      description: "SHA-256 hex digest of the produced G-code file (audit trail)." +
        " Non-deterministic: includes a PrusaSlicer build timestamp.",
    },
    engine_name: {
      type: "string",
      description:
        "Observed slicer name parsed from the G-code `; generated by` header.",
    },
    engine_version: {
      type: "string",
      description:
        "Observed slicer version parsed from the G-code `; generated by` header.",
    },
    effective_config_sha256: {
      type: "string",
      description:
        "SHA-256 hex digest of the exact emitted `; prusaslicer_config = begin`" +
        " ... `; prusaslicer_config = end` block. Not a hash of the input INI.",
    },
    effective_config_summary: {
      type: "object",
      additionalProperties: false,
      required: ["config_sha256", "values"],
      description:
        "Bounded raw-value projection from the exact emitted prusaslicer_config block. " +
        "config_sha256 equals effective_config_sha256; null means the selected key was " +
        "absent from the emitted block, not a server-inferred default.",
      properties: {
        config_sha256: { type: "string" },
        values: {
          type: "object",
          additionalProperties: false,
          required: [
            "printer_technology",
            "nozzle_diameter",
            "layer_height",
            "first_layer_height",
            "fill_density",
            "fill_pattern",
            "perimeters",
            "top_solid_layers",
            "bottom_solid_layers",
            "support_material",
            "support_material_auto",
            "filament_diameter",
            "filament_density",
            "gcode_flavor",
          ],
          properties: {
            printer_technology: { type: ["string", "null"] },
            nozzle_diameter: { type: ["string", "null"] },
            layer_height: { type: ["string", "null"] },
            first_layer_height: { type: ["string", "null"] },
            fill_density: { type: ["string", "null"] },
            fill_pattern: { type: ["string", "null"] },
            perimeters: { type: ["string", "null"] },
            top_solid_layers: { type: ["string", "null"] },
            bottom_solid_layers: { type: ["string", "null"] },
            support_material: { type: ["string", "null"] },
            support_material_auto: { type: ["string", "null"] },
            filament_diameter: { type: ["string", "null"] },
            filament_density: { type: ["string", "null"] },
            gcode_flavor: { type: ["string", "null"] },
          },
        },
      },
    },
    overrides_applied: {
      type: "object",
      additionalProperties: false,
      description:
        "Caller-provided print overrides actually forwarded to PrusaSlicer." +
        " Empty when none were supplied. Does not include timeout_ms.",
      properties: {
        layer_height_mm: { type: "number" },
        infill_percent: { type: "number" },
        filament_density_g_cm3: { type: "number" },
      },
    },
    not_checked: {
      type: "array",
      items: { type: "string" },
      description:
        "Aspects not verified by this tool. Read before deciding if sufficient.",
    },
    stl_artifact: {
      type: "object",
      additionalProperties: false,
      required: ["sha256", "bytes", "source_path"],
      properties: {
        sha256: { type: "string" },
        bytes: { type: "number" },
        source_path: { type: "string" },
      },
    },
    profile_artifact: {
      type: "object",
      additionalProperties: false,
      required: ["sha256", "bytes", "source_path"],
      properties: {
        sha256: { type: "string" },
        bytes: { type: "number" },
        source_path: { type: "string" },
      },
    },
  },
};

const estimateFffTool: SlicerTool = {
  name: TOOL_NAME,
  description:
    "Slice an STL with a caller-supplied PrusaSlicer INI profile and return estimated" +
    " print time and material consumption from the real G-code stats. The tool measures —" +
    " it does not price. Pricing (filament cost, machine time) is handled downstream by" +
    " erpnext. The profile_ini_path supplies the caller-owned base configuration; optional" +
    " tool arguments override layer height, infill, or filament density. The server" +
    " embeds no production profile. It accepts only admitted ASCII or binary STL inputs," +
    " then returns an attested, bounded effective-config summary read from the emitted" +
    " G-code block.",
  category: "estimation",
  inputSchema: INPUT_SCHEMA,
  outputSchema: OUTPUT_SCHEMA,
  annotations: {
    readOnlyHint: false, // writes G-code to a temp dir
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (args) => {
    const stlPath = args["stl_path"];
    const profileIniPath = args["profile_ini_path"];
    const stlSha256 = args["stl_sha256"];
    const profileSha256 = args["profile_sha256"];
    const layerHeightMm = args["layer_height_mm"];
    const infillPercent = args["infill_percent"];
    const filamentDensityGcm3 = args["filament_density_g_cm3"];
    const timeoutMs = args["timeout_ms"];

    if (typeof stlPath !== "string" || !stlPath.trim()) {
      throw new TypeError(`[${TOOL_NAME}] stl_path must be a non-empty string.`);
    }
    if (typeof profileIniPath !== "string" || !profileIniPath.trim()) {
      throw new TypeError(
        `[${TOOL_NAME}] profile_ini_path must be a non-empty string.`,
      );
    }
    if (stlSha256 !== undefined && typeof stlSha256 !== "string") {
      throw new TypeError(
        `[${TOOL_NAME}] stl_sha256 must be a string when provided.`,
      );
    }
    if (profileSha256 !== undefined && typeof profileSha256 !== "string") {
      throw new TypeError(
        `[${TOOL_NAME}] profile_sha256 must be a string when provided.`,
      );
    }
    if (layerHeightMm !== undefined && typeof layerHeightMm !== "number") {
      throw new TypeError(
        `[${TOOL_NAME}] layer_height_mm must be a number when provided.`,
      );
    }
    if (infillPercent !== undefined && typeof infillPercent !== "number") {
      throw new TypeError(
        `[${TOOL_NAME}] infill_percent must be a number when provided.`,
      );
    }
    if (filamentDensityGcm3 !== undefined && typeof filamentDensityGcm3 !== "number") {
      throw new TypeError(
        `[${TOOL_NAME}] filament_density_g_cm3 must be a number when provided.`,
      );
    }
    if (
      timeoutMs !== undefined &&
      (typeof timeoutMs !== "number" ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1)
    ) {
      throw new TypeError(
        `[${TOOL_NAME}] timeout_ms must be a positive integer.`,
      );
    }

    // Snapshot and attest both inputs before any subprocess.
    const stlSnapshot = await snapshotStlArtifact(
      TOOL_NAME,
      stlPath,
      stlSha256 as string | undefined,
    );
    let profileSnapshot;
    try {
      profileSnapshot = await snapshotIniArtifact(
        TOOL_NAME,
        profileIniPath,
        profileSha256 as string | undefined,
      );
    } catch (err) {
      await stlSnapshot.cleanup();
      throw err;
    }

    try {
      const result = await sliceFff({
        stlPath: stlSnapshot.artifact.path,
        profileIniPath: profileSnapshot.artifact.path,
        layerHeightMm: layerHeightMm as number | undefined,
        infillPercent: infillPercent as number | undefined,
        filamentDensityGcm3: filamentDensityGcm3 as number | undefined,
        timeoutMs: timeoutMs as number | undefined,
      });

      // Build structured output. filament_mass_g is ABSENT (not null) when
      // the slicer returned null — matching the build123d mass rule.
      const structuredContent: Record<string, unknown> = {
        print_time_s: result.print_time_s,
        print_time_normal_mode: result.print_time_normal_mode,
        print_time_silent_mode: result.print_time_silent_mode,
        filament_length_mm: result.filament_length_mm,
        filament_volume_mm3: result.filament_volume_mm3,
        gcode_sha256: result.gcode_sha256,
        engine_name: result.engine_name,
        engine_version: result.engine_version,
        effective_config_sha256: result.effective_config_sha256,
        effective_config_summary: result.effective_config_summary,
        overrides_applied: result.overrides_applied,
        not_checked: NOT_CHECKED,
        stl_artifact: {
          sha256: stlSnapshot.artifact.sha256,
          bytes: stlSnapshot.artifact.bytes,
          source_path: stlSnapshot.artifact.sourcePath,
        },
        profile_artifact: {
          sha256: profileSnapshot.artifact.sha256,
          bytes: profileSnapshot.artifact.bytes,
          source_path: profileSnapshot.artifact.sourcePath,
        },
      };

      // Conditionally include mass (absent ≠ null).
      if (result.filament_mass_g !== null) {
        structuredContent["filament_mass_g"] = result.filament_mass_g;
      }

      const massPart = result.filament_mass_g !== null
        ? ` ${result.filament_mass_g}g`
        : ` ${result.filament_volume_mm3}mm3`;

      return {
        content: `[${TOOL_NAME}] stl:${stlSnapshot.artifact.sha256.slice(0, 12)}` +
          ` profile:${profileSnapshot.artifact.sha256.slice(0, 12)}` +
          `: ${result.print_time_normal_mode} / ${result.filament_length_mm}mm${massPart}`,
        structuredContent,
      };
    } finally {
      await profileSnapshot.cleanup();
      await stlSnapshot.cleanup();
    }
  },
};

export { estimateFffTool };
export { InputArtifactError, SlicerNotFoundError, SlicingError };
