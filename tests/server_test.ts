/**
 * Tests for mcp-slicer.
 *
 * Tests requiring prusa-slicer are guarded by an environment variable:
 *   SLICER_RUN_NATIVE=1  — enable integration tests against the real slicer.
 *
 * Unit tests (parsePrusaTime, G-code fixture parsing, schema invariants, MCP
 * wire, input validation) run without any guard and require no subprocess.
 *
 * Reference values for tests/fixtures/cube_20mm_pla.gcode
 * (PrusaSlicer 2.9.2, aarch64 Debian trixie, cube_20mm.stl + pla_0.4_0.2.ini):
 *   filament used [mm]  = 1487.15   → filament_length_mm  = 1487.15
 *   filament used [cm3] = 3.58      → filament_volume_mm3 = 3580
 *   filament used [g]   = 4.44      → filament_mass_g     = 4.44
 *   estimated printing time (normal mode) = 19m 50s → print_time_s = 1190
 *   estimated printing time (silent mode) = 20m 40s
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { parsePrusaTime } from "../src/api/slicer.ts";
import { allTools } from "../src/tools/mod.ts";
import { createSlicerServer } from "../server.ts";

const RUN_NATIVE = Deno.env.get("SLICER_RUN_NATIVE") === "1";

// Fixture paths — used in both unit and native tests.
const CUBE_10MM_STL = new URL("./fixtures/cube.stl", import.meta.url).pathname;
const CUBE_20MM_STL = new URL("./fixtures/cube_20mm.stl", import.meta.url).pathname;
const PROFILE_INI = new URL("./fixtures/pla_0.4_0.2.ini", import.meta.url).pathname;
const GCODE_FIXTURE = new URL(
  "./fixtures/cube_20mm_pla.gcode",
  import.meta.url,
).pathname;

// ---------------------------------------------------------------------------
// parsePrusaTime — pure unit tests, no subprocess
// ---------------------------------------------------------------------------

Deno.test("parsePrusaTime converts '19m 50s' to 1190 seconds", () => {
  assertEquals(parsePrusaTime("19m 50s"), 1190);
});

Deno.test("parsePrusaTime converts '12m 45s' to 765 seconds", () => {
  assertEquals(parsePrusaTime("12m 45s"), 765);
});

Deno.test("parsePrusaTime converts '1h 2m 30s' to 3750 seconds", () => {
  assertEquals(parsePrusaTime("1h 2m 30s"), 3750);
});

Deno.test("parsePrusaTime converts '45s' to 45 seconds", () => {
  assertEquals(parsePrusaTime("45s"), 45);
});

Deno.test("parsePrusaTime converts '2h' to 7200 seconds", () => {
  assertEquals(parsePrusaTime("2h"), 7200);
});

Deno.test("parsePrusaTime converts '5m' to 300 seconds", () => {
  assertEquals(parsePrusaTime("5m"), 300);
});

Deno.test("parsePrusaTime returns null for empty string", () => {
  assertEquals(parsePrusaTime(""), null);
});

Deno.test("parsePrusaTime converts '20m 40s' (silent mode) to 1240 seconds", () => {
  assertEquals(parsePrusaTime("20m 40s"), 1240);
});

// ---------------------------------------------------------------------------
// G-code fixture parsing — unit tests against committed real G-code stats
// (no subprocess, no prusa-slicer required)
// ---------------------------------------------------------------------------

Deno.test(
  "parseGcodeStats from cube_20mm_pla.gcode: filament_length_mm = 1487.15",
  async () => {
    const gcode = await Deno.readTextFile(GCODE_FIXTURE);
    const mmMatch = gcode.match(/^;\s*filament used \[mm\]\s*=\s*(.+)$/m);
    assert(mmMatch, "filament used [mm] line must be present");
    assertEquals(parseFloat(mmMatch[1].trim()), 1487.15);
  },
);

Deno.test(
  "parseGcodeStats from cube_20mm_pla.gcode: filament_volume_mm3 = 3580",
  async () => {
    const gcode = await Deno.readTextFile(GCODE_FIXTURE);
    const cm3Match = gcode.match(/^;\s*filament used \[cm3\]\s*=\s*(.+)$/m);
    assert(cm3Match, "filament used [cm3] line must be present");
    const cm3 = parseFloat(cm3Match[1].trim());
    const mm3 = Math.round(cm3 * 1000 * 100) / 100;
    assertEquals(mm3, 3580);
  },
);

Deno.test(
  "parseGcodeStats from cube_20mm_pla.gcode: filament_mass_g = 4.44",
  async () => {
    const gcode = await Deno.readTextFile(GCODE_FIXTURE);
    const gMatch = gcode.match(/^;\s*filament used \[g\]\s*=\s*(.+)$/m);
    assert(gMatch, "filament used [g] line must be present");
    assertEquals(parseFloat(gMatch[1].trim()), 4.44);
  },
);

Deno.test(
  "parseGcodeStats from cube_20mm_pla.gcode: print_time_s = 1190 (19m 50s)",
  async () => {
    const gcode = await Deno.readTextFile(GCODE_FIXTURE);
    const tMatch = gcode.match(
      /^;\s*estimated printing time \(normal mode\)\s*=\s*(.+)$/m,
    );
    assert(tMatch, "estimated printing time (normal mode) line must be present");
    const rawTime = tMatch[1].trim();
    assertEquals(rawTime, "19m 50s");
    assertEquals(parsePrusaTime(rawTime), 1190);
  },
);

Deno.test(
  "parseGcodeStats from cube_20mm_pla.gcode: silent mode = 20m 40s (1240 s)",
  async () => {
    const gcode = await Deno.readTextFile(GCODE_FIXTURE);
    const tMatch = gcode.match(
      /^;\s*estimated printing time \(silent mode\)\s*=\s*(.+)$/m,
    );
    assert(tMatch, "estimated printing time (silent mode) line must be present");
    const rawTime = tMatch[1].trim();
    assertEquals(rawTime, "20m 40s");
    assertEquals(parsePrusaTime(rawTime), 1240);
  },
);

// ---------------------------------------------------------------------------
// Schema invariants
// ---------------------------------------------------------------------------

Deno.test("All slicer tools declare closed outputSchemas with required not_checked", () => {
  for (const tool of allTools) {
    const schema = tool.outputSchema as Record<string, unknown>;
    assertEquals(
      schema.additionalProperties,
      false,
      `${tool.name}: outputSchema must have additionalProperties: false`,
    );
    const required = schema.required as string[];
    assert(
      required.includes("not_checked"),
      `${tool.name}: outputSchema.required must include 'not_checked'`,
    );
    assert(
      required.includes("print_time_s"),
      `${tool.name}: outputSchema.required must include 'print_time_s'`,
    );
    assert(
      required.includes("filament_length_mm"),
      `${tool.name}: outputSchema.required must include 'filament_length_mm'`,
    );
    assert(
      required.includes("stl_artifact"),
      `${tool.name}: outputSchema.required must include 'stl_artifact'`,
    );
    assert(
      required.includes("profile_artifact"),
      `${tool.name}: outputSchema.required must include 'profile_artifact'`,
    );
    assert(
      required.includes("gcode_sha256"),
      `${tool.name}: outputSchema.required must include 'gcode_sha256'`,
    );
  }
});

Deno.test("filament_mass_g is NOT required in outputSchema (absent when no density)", () => {
  for (const tool of allTools) {
    const schema = tool.outputSchema as Record<string, unknown>;
    const required = schema.required as string[];
    assert(
      !required.includes("filament_mass_g"),
      `${tool.name}: filament_mass_g must not be in required (absent, not null, when no density)`,
    );
  }
});

Deno.test("All slicer tools declare openWorldHint=false and destructiveHint=false", () => {
  for (const tool of allTools) {
    const ann = tool.annotations;
    assertEquals(ann.openWorldHint, false, `${tool.name}: openWorldHint must be false`);
    assertEquals(
      ann.destructiveHint,
      false,
      `${tool.name}: destructiveHint must be false`,
    );
  }
});

// ---------------------------------------------------------------------------
// MCP wire contract
// ---------------------------------------------------------------------------

const PROTOCOL_VERSION = "2026-07-28";

async function rpc(
  url: string,
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ response: Response; body: { result: unknown } }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": PROTOCOL_VERSION,
      "mcp-method": method,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
          "io.modelcontextprotocol/clientCapabilities": {},
          "io.modelcontextprotocol/clientInfo": {
            name: "mcp-slicer-test",
            version: "0.1.0",
          },
        },
      },
    }),
  });
  const body = await response.json();
  return { response, body };
}

function freePort(): number {
  return 13022 + Math.floor(Math.random() * 100);
}

Deno.test("Slicer server starts and serves stateless MCP server/discover", async () => {
  const { app } = createSlicerServer({ logger: () => {} });
  const port = freePort();
  const http = await app.startHttp({
    port,
    hostname: "127.0.0.1",
    onListen: () => {},
  });
  const url = `http://127.0.0.1:${port}/mcp`;
  try {
    const { response, body } = await rpc(url, "server/discover");
    // Stateless transport: no session ID.
    assertEquals(response.headers.get("mcp-session-id"), null);
    const result = body.result as Record<string, unknown>;
    const serverInfo = result.serverInfo as Record<string, unknown>;
    assertEquals(serverInfo.name, "mcp-slicer");
    assertEquals(serverInfo.version, "0.1.0");
  } finally {
    await http.shutdown();
  }
});

Deno.test("Slicer server lists slicer_estimate_fff in tools/list", async () => {
  const { app } = createSlicerServer({ logger: () => {} });
  const port = freePort();
  const http = await app.startHttp({
    port,
    hostname: "127.0.0.1",
    onListen: () => {},
  });
  const url = `http://127.0.0.1:${port}/mcp`;
  try {
    const { body } = await rpc(url, "tools/list");
    const result = body.result as Record<string, unknown>;
    const tools = result.tools as Array<{ name: string }>;
    assert(Array.isArray(tools), "tools must be an array");
    const names = tools.map((t) => t.name);
    assert(names.includes("slicer_estimate_fff"), "must include slicer_estimate_fff");
  } finally {
    await http.shutdown();
  }
});

// ---------------------------------------------------------------------------
// Input validation — no subprocess required
// ---------------------------------------------------------------------------

Deno.test("slicer_estimate_fff rejects missing stl_path", async () => {
  const tool = allTools.find((t) => t.name === "slicer_estimate_fff");
  assert(tool, "tool must exist");
  await assertRejects(
    () =>
      tool.handler({
        profile_ini_path: PROFILE_INI,
      }) as Promise<unknown>,
    TypeError,
    "stl_path",
  );
});

Deno.test("slicer_estimate_fff rejects empty stl_path", async () => {
  const tool = allTools.find((t) => t.name === "slicer_estimate_fff");
  assert(tool, "tool must exist");
  await assertRejects(
    () =>
      tool.handler({
        stl_path: "   ",
        profile_ini_path: PROFILE_INI,
      }) as Promise<unknown>,
    TypeError,
    "stl_path",
  );
});

Deno.test("slicer_estimate_fff rejects missing profile_ini_path", async () => {
  const tool = allTools.find((t) => t.name === "slicer_estimate_fff");
  assert(tool, "tool must exist");
  await assertRejects(
    () =>
      tool.handler({
        stl_path: "/tmp/x.stl",
      }) as Promise<unknown>,
    TypeError,
    "profile_ini_path",
  );
});

Deno.test("slicer_estimate_fff rejects invalid stl_sha256 format", async () => {
  const tool = allTools.find((t) => t.name === "slicer_estimate_fff");
  assert(tool, "tool must exist");
  await assertRejects(
    () =>
      tool.handler({
        stl_path: "/tmp/x.stl",
        profile_ini_path: PROFILE_INI,
        stl_sha256: "not-a-sha256",
      }) as Promise<unknown>,
    Error,
    "expected_stl_sha256",
  );
});

Deno.test("slicer_estimate_fff rejects invalid profile_sha256 format", async () => {
  const tool = allTools.find((t) => t.name === "slicer_estimate_fff");
  assert(tool, "tool must exist");
  // Use a real STL so the STL snapshot succeeds; the profile hash check fires next.
  await assertRejects(
    () =>
      tool.handler({
        stl_path: CUBE_20MM_STL,
        profile_ini_path: PROFILE_INI,
        profile_sha256: "not-a-sha256",
      }) as Promise<unknown>,
    Error,
    "expected_ini_sha256",
  );
});

Deno.test("slicer_estimate_fff reports STL not found as InputArtifactError", async () => {
  const tool = allTools.find((t) => t.name === "slicer_estimate_fff");
  assert(tool, "tool must exist");
  await assertRejects(
    () =>
      tool.handler({
        stl_path: "/nonexistent/x.stl",
        profile_ini_path: PROFILE_INI,
      }) as Promise<unknown>,
    Error,
    "STL file not found",
  );
});

Deno.test("slicer_estimate_fff reports profile not found as InputArtifactError", async () => {
  const tool = allTools.find((t) => t.name === "slicer_estimate_fff");
  assert(tool, "tool must exist");
  await assertRejects(
    () =>
      tool.handler({
        stl_path: CUBE_20MM_STL,
        profile_ini_path: "/nonexistent/profile.ini",
      }) as Promise<unknown>,
    Error,
    "INI file not found",
  );
});

// ---------------------------------------------------------------------------
// Native integration tests — require SLICER_RUN_NATIVE=1 and prusa-slicer
// ---------------------------------------------------------------------------

Deno.test({
  name:
    "slicer_estimate_fff slices a 20mm cube and returns stats matching the committed fixture",
  ignore: !RUN_NATIVE,
  fn: async () => {
    const tool = allTools.find((t) => t.name === "slicer_estimate_fff");
    assert(tool, "tool must exist");

    const result = await tool.handler({
      stl_path: CUBE_20MM_STL,
      profile_ini_path: PROFILE_INI,
    }) as { structuredContent: Record<string, unknown> };

    const sc = result.structuredContent;

    // Reference values (PrusaSlicer 2.9.2, cube_20mm.stl, pla_0.4_0.2.ini):
    //   filament_length_mm  = 1487.15
    //   filament_volume_mm3 = 3580
    //   filament_mass_g     = 4.44
    //   print_time_s        = 1190  (19m 50s)
    assert(
      typeof sc.print_time_s === "number" && sc.print_time_s > 0,
      "print_time_s > 0",
    );
    assert(
      typeof sc.filament_length_mm === "number" && sc.filament_length_mm > 500,
      "filament_length_mm > 500 for 20mm cube",
    );
    assert(
      typeof sc.filament_volume_mm3 === "number" && sc.filament_volume_mm3 > 0,
      "filament_volume_mm3 > 0",
    );
    assert(
      typeof sc.filament_mass_g === "number" && sc.filament_mass_g > 0,
      "filament_mass_g present and positive when density is set",
    );

    // Tolerance ±20% on reference values (printer config may vary).
    assert(
      Math.abs((sc.filament_length_mm as number) - 1487.15) < 1487.15 * 0.2,
      `filament_length_mm out of tolerance: ${sc.filament_length_mm}`,
    );
    assert(
      Math.abs((sc.filament_volume_mm3 as number) - 3580) < 3580 * 0.2,
      `filament_volume_mm3 out of tolerance: ${sc.filament_volume_mm3}`,
    );
    assert(
      Math.abs((sc.filament_mass_g as number) - 4.44) < 4.44 * 0.2,
      `filament_mass_g out of tolerance: ${sc.filament_mass_g}`,
    );

    // G-code hash must be a 64-char hex string.
    assert(
      typeof sc.gcode_sha256 === "string" && (sc.gcode_sha256 as string).length === 64,
      "gcode_sha256 must be a 64-char hex string",
    );

    // Attestation fields.
    const stlArt = sc.stl_artifact as Record<string, unknown>;
    assert(
      typeof stlArt.sha256 === "string" && (stlArt.sha256 as string).length === 64,
      "stl_artifact.sha256 must be 64-char hex",
    );
    const profArt = sc.profile_artifact as Record<string, unknown>;
    assert(
      typeof profArt.sha256 === "string" && (profArt.sha256 as string).length === 64,
      "profile_artifact.sha256 must be 64-char hex",
    );
  },
});

Deno.test({
  name: "slicer_estimate_fff: filament_mass_g absent when profile has no density",
  ignore: !RUN_NATIVE,
  fn: async () => {
    const tool = allTools.find((t) => t.name === "slicer_estimate_fff");
    assert(tool, "tool must exist");

    // Write a profile without filament_density to a temp file.
    const tmpProfile = await Deno.makeTempFile({
      prefix: "slicer-test-",
      suffix: ".ini",
    });
    await Deno.writeTextFile(
      tmpProfile,
      [
        "printer_technology = FFF",
        "nozzle_diameter = 0.4",
        "layer_height = 0.2",
        "first_layer_height = 0.2",
        "bed_shape = 0x0,250x0,250x210,0x210",
        "filament_diameter = 1.75",
        "temperature = 215",
        "first_layer_temperature = 215",
        "bed_temperature = 60",
        "first_layer_bed_temperature = 60",
        "fill_density = 20%",
        "perimeters = 3",
        "gcode_flavor = marlin",
      ].join("\n"),
    );

    try {
      const result = await tool.handler({
        stl_path: CUBE_20MM_STL,
        profile_ini_path: tmpProfile,
      }) as { structuredContent: Record<string, unknown> };

      // When density is absent: field must be absent (not null, not 0).
      assert(
        !("filament_mass_g" in result.structuredContent),
        "filament_mass_g must be absent (not null) when profile has no density",
      );
    } finally {
      await Deno.remove(tmpProfile).catch(() => {});
    }
  },
});

Deno.test({
  name: "slicer_estimate_fff: layer_height_mm override changes slice result",
  ignore: !RUN_NATIVE,
  fn: async () => {
    const tool = allTools.find((t) => t.name === "slicer_estimate_fff");
    assert(tool, "tool must exist");

    // Baseline at default 0.2mm layer.
    const base = await tool.handler({
      stl_path: CUBE_20MM_STL,
      profile_ini_path: PROFILE_INI,
    }) as { structuredContent: Record<string, unknown> };

    // 0.3mm layer → fewer layers → less filament and less time.
    const override = await tool.handler({
      stl_path: CUBE_20MM_STL,
      profile_ini_path: PROFILE_INI,
      layer_height_mm: 0.3,
    }) as { structuredContent: Record<string, unknown> };

    const baseMm = base.structuredContent.filament_length_mm as number;
    const overrideMm = override.structuredContent.filament_length_mm as number;
    assert(
      overrideMm < baseMm,
      `layer_height_mm=0.3 should use less filament than 0.2: ${overrideMm} < ${baseMm}`,
    );
  },
});

Deno.test({
  name:
    "slicer_estimate_fff: filament_density_g_cm3 override provides mass when profile lacks density",
  ignore: !RUN_NATIVE,
  fn: async () => {
    const tool = allTools.find((t) => t.name === "slicer_estimate_fff");
    assert(tool, "tool must exist");

    // Write a profile without filament_density.
    const tmpProfile = await Deno.makeTempFile({
      prefix: "slicer-test-",
      suffix: ".ini",
    });
    await Deno.writeTextFile(
      tmpProfile,
      [
        "printer_technology = FFF",
        "nozzle_diameter = 0.4",
        "layer_height = 0.2",
        "first_layer_height = 0.2",
        "bed_shape = 0x0,250x0,250x210,0x210",
        "filament_diameter = 1.75",
        "temperature = 215",
        "first_layer_temperature = 215",
        "bed_temperature = 60",
        "first_layer_bed_temperature = 60",
        "fill_density = 20%",
        "perimeters = 3",
        "gcode_flavor = marlin",
      ].join("\n"),
    );

    try {
      const result = await tool.handler({
        stl_path: CUBE_20MM_STL,
        profile_ini_path: tmpProfile,
        filament_density_g_cm3: 1.24,
      }) as { structuredContent: Record<string, unknown> };

      assert(
        "filament_mass_g" in result.structuredContent,
        "filament_mass_g must be present when filament_density_g_cm3 override is provided",
      );
      assert(
        typeof result.structuredContent.filament_mass_g === "number" &&
          (result.structuredContent.filament_mass_g as number) > 0,
        "filament_mass_g must be positive",
      );
    } finally {
      await Deno.remove(tmpProfile).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "slicer_estimate_fff slices a 10mm cube (legacy fixture) and returns plausible stats",
  ignore: !RUN_NATIVE,
  fn: async () => {
    const tool = allTools.find((t) => t.name === "slicer_estimate_fff");
    assert(tool, "tool must exist");

    const result = await tool.handler({
      stl_path: CUBE_10MM_STL,
      profile_ini_path: PROFILE_INI,
    }) as { structuredContent: Record<string, unknown> };

    const sc = result.structuredContent;

    // Reference values (PrusaSlicer 2.9.2, cube.stl 10mm, pla_0.4_0.2.ini):
    //   filament_length_mm  ≈ 426.64
    //   filament_volume_mm3 ≈ 1030
    //   filament_mass_g     ≈ 1.27
    //   print_time_s        ≈ 765  (12m 45s)
    assert(
      typeof sc.print_time_s === "number" && sc.print_time_s > 0,
      "print_time_s > 0",
    );
    assert(
      typeof sc.filament_length_mm === "number" && sc.filament_length_mm > 100,
      "filament_length_mm > 100 for 10mm cube",
    );
    // Tolerance ±20%
    assert(
      Math.abs((sc.filament_length_mm as number) - 426.64) < 426.64 * 0.2,
      `filament_length_mm out of tolerance: ${sc.filament_length_mm}`,
    );
  },
});
