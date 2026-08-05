/**
 * Tests for mcp-slicer.
 *
 * Tests requiring prusa-slicer are guarded by an environment variable:
 *   SLICER_RUN_NATIVE=1  — enable integration tests against the real slicer.
 *
 * Unit tests (parsePrusaTime, G-code parsing, schema invariants, MCP wire)
 * run without any guard.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { parsePrusaTime } from "../src/api/slicer.ts";
import { allTools } from "../src/tools/mod.ts";
import { createSlicerServer } from "../server.ts";

const RUN_NATIVE = Deno.env.get("SLICER_RUN_NATIVE") === "1";

// ---------------------------------------------------------------------------
// parsePrusaTime — pure unit tests, no subprocess
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Schema invariants — every tool must declare closed outputSchema with
// required not_checked, violations is absent (slicer is not a DFM checker)
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
      required.includes("input_artifact"),
      `${tool.name}: outputSchema.required must include 'input_artifact'`,
    );
    assert(
      required.includes("estimated_print_time_s"),
      `${tool.name}: outputSchema.required must include 'estimated_print_time_s'`,
    );
    assert(
      required.includes("filament_used_mm"),
      `${tool.name}: outputSchema.required must include 'filament_used_mm'`,
    );
  }
});

Deno.test("All slicer tools declare readOnlyHint and openWorldHint = false", () => {
  for (const tool of allTools) {
    const ann = tool.annotations;
    assertEquals(
      ann.openWorldHint,
      false,
      `${tool.name}: openWorldHint must be false (deterministic slicer)`,
    );
    assertEquals(
      ann.destructiveHint,
      false,
      `${tool.name}: destructiveHint must be false`,
    );
  }
});

// ---------------------------------------------------------------------------
// MCP wire contract — stateless server starts and serves discover
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
  // Deterministic offset from a base port to avoid conflicts in parallel runs.
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
// Input validation — no subprocess, no prusa-slicer
// ---------------------------------------------------------------------------

Deno.test("slicer_estimate_fff rejects missing stl_path", async () => {
  const tool = allTools.find((t) => t.name === "slicer_estimate_fff");
  assert(tool, "tool must exist");
  await assertRejects(
    () => tool.handler({ profile_ini: "printer_technology = FFF" }) as Promise<unknown>,
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
        profile_ini: "printer_technology = FFF",
      }) as Promise<unknown>,
    TypeError,
    "stl_path",
  );
});

Deno.test("slicer_estimate_fff rejects invalid expected_stl_sha256 format", async () => {
  const tool = allTools.find((t) => t.name === "slicer_estimate_fff");
  assert(tool, "tool must exist");
  await assertRejects(
    () =>
      tool.handler({
        stl_path: "/tmp/x.stl",
        profile_ini: "printer_technology = FFF",
        expected_stl_sha256: "not-a-sha256",
      }) as Promise<unknown>,
    // InputArtifactError extends Error
    Error,
    "expected_stl_sha256",
  );
});

// ---------------------------------------------------------------------------
// Native integration tests — require SLICER_RUN_NATIVE=1 and prusa-slicer
// ---------------------------------------------------------------------------

const CUBE_STL = new URL("./fixtures/cube.stl", import.meta.url).pathname;

Deno.test({
  name: "slicer_estimate_fff slices a 10mm cube and returns plausible stats",
  ignore: !RUN_NATIVE,
  fn: async () => {
    const tool = allTools.find((t) => t.name === "slicer_estimate_fff");
    assert(tool, "tool must exist");

    // Minimal PLA profile for a 10mm cube — measured values documented below.
    const profileIni = [
      "printer_technology = FFF",
      "nozzle_diameter = 0.4",
      "layer_height = 0.2",
      "first_layer_height = 0.2",
      "bed_shape = 0x0,250x0,250x210,0x210",
      "filament_diameter = 1.75",
      "filament_density = 1.24",
      "temperature = 215",
      "first_layer_temperature = 215",
      "bed_temperature = 60",
      "first_layer_bed_temperature = 60",
      "fill_density = 20%",
      "perimeters = 3",
      "gcode_flavor = marlin",
    ].join("\n");

    const result = await tool.handler({
      stl_path: CUBE_STL,
      profile_ini: profileIni,
    }) as { structuredContent: Record<string, unknown> };

    const sc = result.structuredContent;

    // Real pipeline (PrusaSlicer 2.9.2, 10mm cube, PLA 1.24 g/cm3):
    //   filament_used_mm = 426.64
    //   filament_used_cm3 = 1.03
    //   filament_used_g = 1.27
    //   estimated_print_time_s = 765  (12m 45s)
    assert(
      typeof sc.estimated_print_time_s === "number" &&
        sc.estimated_print_time_s > 0,
      "estimated_print_time_s must be positive",
    );
    assert(
      typeof sc.filament_used_mm === "number" && sc.filament_used_mm > 100,
      "filament_used_mm must be > 100 for a 10mm cube",
    );
    assert(
      typeof sc.filament_used_cm3 === "number" && sc.filament_used_cm3 > 0,
      "filament_used_cm3 must be positive",
    );
    assert(
      typeof sc.filament_used_g === "number" && sc.filament_used_g > 0,
      "filament_used_g must be positive when density is set",
    );
    // Tolerance ±20% on the reference values (printer config may vary).
    assert(
      Math.abs((sc.filament_used_mm as number) - 426.64) < 426.64 * 0.2,
      `filament_used_mm out of tolerance: ${sc.filament_used_mm}`,
    );
    assert(
      typeof sc.print_time_normal_mode === "string" &&
        (sc.print_time_normal_mode as string).length > 0,
      "print_time_normal_mode must be a non-empty string",
    );
    const artifact = sc.input_artifact as Record<string, unknown>;
    assert(
      typeof artifact.sha256 === "string" && artifact.sha256.length === 64,
      "input_artifact.sha256 must be a 64-char hex string",
    );
  },
});

Deno.test({
  name: "slicer_estimate_fff returns null filament_used_g when density is absent",
  ignore: !RUN_NATIVE,
  fn: async () => {
    const tool = allTools.find((t) => t.name === "slicer_estimate_fff");
    assert(tool, "tool must exist");

    // Profile without filament_density — mass must be null.
    const profileIni = [
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
    ].join("\n");

    const result = await tool.handler({
      stl_path: CUBE_STL,
      profile_ini: profileIni,
    }) as { structuredContent: Record<string, unknown> };

    assertEquals(
      result.structuredContent.filament_used_g,
      null,
      "filament_used_g must be null when filament_density is absent from profile",
    );
  },
});
