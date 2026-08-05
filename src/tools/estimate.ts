/**
 * slicer_estimate_fff — FDM slicing estimation tool.
 *
 * Slices an STL with a caller-supplied PrusaSlicer INI profile and returns
 * print-time and material-consumption measurements extracted from the real
 * G-code. No prices — pricing is downstream (erpnext).
 */

import { InputArtifactError, snapshotStlArtifact } from "../api/input-artifact.ts";
import { sliceFff, SlicerNotFoundError, SlicingError } from "../api/slicer.ts";
import type { SlicerTool } from "./types.ts";

const TOOL_NAME = "slicer_estimate_fff";

const NOT_CHECKED: string[] = [
  "Support volume is not included in the material estimate; enable supports in the profile if needed.",
  "Print time depends on printer acceleration/jerk settings declared in the profile; unset values fall back to PrusaSlicer defaults.",
  "Multi-material or multi-extruder configurations are not tested; use a single-extruder profile.",
  "The tool does not validate that the part fits within the declared bed_shape; oversized parts may fail silently.",
  "Mass (filament_used_g) is only reported when filament_density is set in the profile; omitting it yields null.",
];

const INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["stl_path", "profile_ini"],
  properties: {
    stl_path: {
      type: "string",
      description:
        "Absolute path to the STL file to slice. The file must be accessible on the server filesystem.",
    },
    profile_ini: {
      type: "string",
      description:
        "PrusaSlicer INI profile content as a string. Must include at minimum: " +
        "nozzle_diameter, layer_height, filament_diameter, bed_shape, " +
        "printer_technology = FFF. Include filament_density to get mass output.",
    },
    expected_stl_sha256: {
      type: "string",
      description:
        "Optional SHA-256 hex digest of the STL file. When provided, the server " +
        "verifies the file content matches before slicing. Provides attestation that " +
        "the exact geometry that was committed was sliced.",
    },
    timeout_ms: {
      type: "number",
      description:
        "Maximum time in milliseconds to wait for prusa-slicer before aborting. " +
        "Default: 120000 (2 minutes). Complex models may need more.",
    },
  },
};

const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "estimated_print_time_s",
    "print_time_normal_mode",
    "print_time_silent_mode",
    "filament_used_mm",
    "filament_used_cm3",
    "filament_used_g",
    "not_checked",
    "input_artifact",
  ],
  properties: {
    estimated_print_time_s: {
      type: "number",
      description: "Estimated print time in seconds (normal/quality mode).",
    },
    print_time_normal_mode: {
      type: "string",
      description:
        'Raw time string from the G-code header, e.g. "12m 45s" or "1h 2m 30s".',
    },
    print_time_silent_mode: {
      type: ["string", "null"],
      description:
        "Raw time string for silent mode (lower accelerations). null if absent from G-code.",
    },
    filament_used_mm: {
      type: "number",
      description: "Total filament length consumed, in millimetres.",
    },
    filament_used_cm3: {
      type: "number",
      description: "Total filament volume consumed, in cm³.",
    },
    filament_used_g: {
      type: ["number", "null"],
      description:
        "Total filament mass consumed, in grams. null when filament_density is " +
        "absent from the profile — the server never invents a density.",
    },
    not_checked: {
      type: "array",
      items: { type: "string" },
      description:
        "Aspects not verified by this tool. Read before deciding if the estimate is sufficient.",
    },
    input_artifact: {
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
    "Slice an STL with a caller-supplied PrusaSlicer INI profile and return " +
    "estimated print time and material consumption from the real G-code stats. " +
    "The tool measures — it does not price. Pricing (filament cost, machine time) " +
    "is handled downstream by erpnext. " +
    "The profile_ini string is the sole authority on print parameters; " +
    "the server injects no hidden defaults.",
  category: "estimation",
  inputSchema: INPUT_SCHEMA,
  outputSchema: OUTPUT_SCHEMA,
  annotations: {
    readOnlyHint: false, // writes to temp dirs
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  handler: async (args) => {
    const stlPath = args["stl_path"];
    const profileIni = args["profile_ini"];
    const expectedSha256 = args["expected_stl_sha256"];
    const timeoutMs = args["timeout_ms"];

    if (typeof stlPath !== "string" || !stlPath.trim()) {
      throw new TypeError(`[${TOOL_NAME}] stl_path must be a non-empty string.`);
    }
    if (typeof profileIni !== "string") {
      throw new TypeError(`[${TOOL_NAME}] profile_ini must be a string.`);
    }
    if (expectedSha256 !== undefined && typeof expectedSha256 !== "string") {
      throw new TypeError(
        `[${TOOL_NAME}] expected_stl_sha256 must be a string when provided.`,
      );
    }
    if (timeoutMs !== undefined && typeof timeoutMs !== "number") {
      throw new TypeError(`[${TOOL_NAME}] timeout_ms must be a number when provided.`);
    }

    const snapshot = await snapshotStlArtifact(
      TOOL_NAME,
      stlPath,
      expectedSha256 as string | undefined,
    );
    try {
      const result = await sliceFff({
        stlPath: snapshot.artifact.path,
        profileIni,
        timeoutMs: timeoutMs as number | undefined,
      });

      const structuredContent = {
        estimated_print_time_s: result.estimated_print_time_s,
        print_time_normal_mode: result.print_time_normal_mode,
        print_time_silent_mode: result.print_time_silent_mode,
        filament_used_mm: result.filament_used_mm,
        filament_used_cm3: result.filament_used_cm3,
        filament_used_g: result.filament_used_g,
        not_checked: NOT_CHECKED,
        input_artifact: {
          sha256: snapshot.artifact.sha256,
          bytes: snapshot.artifact.bytes,
          source_path: snapshot.artifact.sourcePath,
        },
      };

      const massPart = result.filament_used_g !== null
        ? ` ${result.filament_used_g}g`
        : ` ${result.filament_used_cm3}cm3`;

      return {
        content: `[${TOOL_NAME}] sha256:${snapshot.artifact.sha256}: ` +
          `${result.print_time_normal_mode} / ${result.filament_used_mm}mm${massPart}`,
        structuredContent,
      };
    } finally {
      await snapshot.cleanup();
    }
  },
};

export { estimateFffTool };
export { InputArtifactError, SlicerNotFoundError, SlicingError };
