/**
 * Native stdio is the transport Docker MCP Toolkit clients will actually use,
 * so this suite exercises the real server end to end. No mocks: this must
 * prove the MCP SDK's legacy initialize handling and actual tool dispatch.
 */
import { assert, assertEquals } from "@std/assert";
import { TextLineStream } from "@std/streams/text-line-stream";
import denoConfig from "../deno.json" with { type: "json" };

async function collectResponses(
  stdout: ReadableStream<Uint8Array>,
  expected: number,
  timeoutMs: number,
): Promise<Record<string, unknown>[]> {
  const responses: Record<string, unknown>[] = [];
  const lines = stdout
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new TextLineStream());
  const deadline = AbortSignal.timeout(timeoutMs);
  const reader = lines.getReader();
  try {
    while (responses.length < expected) {
      if (deadline.aborted) break;
      const { value, done } = await reader.read();
      if (done) break;
      if (value.trim() === "") continue;
      responses.push(JSON.parse(value) as Record<string, unknown>);
    }
  } finally {
    reader.releaseLock();
  }
  return responses;
}

Deno.test(
  "native stdio serves modern server/discover as its first request",
  async () => {
    const server = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-all",
        new URL("../server.ts", import.meta.url).pathname,
        "--stdio",
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "null",
    }).spawn();

    const writer = server.stdin.getWriter();
    try {
      await writer.write(new TextEncoder().encode(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "server/discover",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }) + "\n",
      ));

      const responses = await collectResponses(server.stdout, 1, 30_000);
      assertEquals(responses.length, 1);
      assertEquals(responses[0].id, 1);
      const result = responses[0].result as Record<string, unknown>;
      assertEquals(result.resultType, "complete");
      const meta = result._meta as Record<string, unknown>;
      const serverInfo = meta["io.modelcontextprotocol/serverInfo"] as Record<
        string,
        unknown
      >;
      assertEquals(serverInfo.name, "mcp-prusaslicer");
      assertEquals(serverInfo.version, denoConfig.version);
    } finally {
      await writer.close();
      server.kill("SIGTERM");
      await server.status;
    }
  },
);

Deno.test(
  "native stdio accepts legacy initialize and dispatches tools/call to the tool schema",
  async () => {
    const server = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-all",
        new URL("../server.ts", import.meta.url).pathname,
        "--stdio",
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "null",
    }).spawn();

    const writer = server.stdin.getWriter();
    const send = (message: Record<string, unknown>) =>
      writer.write(new TextEncoder().encode(JSON.stringify(message) + "\n"));

    try {
      await send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "native-stdio-test", version: "0" },
        },
      });
      await send({ jsonrpc: "2.0", method: "notifications/initialized" });
      await send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
      await send({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "prusaslicer_estimate_fff",
          // Deliberately incomplete: this must reach native tool schema validation.
          arguments: {},
        },
      });

      const responses = await collectResponses(server.stdout, 3, 30_000);
      assertEquals(
        responses.length,
        3,
        "expected initialize, tools/list, and tools/call responses",
      );

      const init = responses[0].result as Record<string, unknown>;
      assertEquals(responses[0].id, 1);
      assertEquals(
        init.protocolVersion,
        "2025-06-18",
        "native stdio must negotiate the legacy client revision",
      );
      const serverInfo = init.serverInfo as Record<string, unknown>;
      assertEquals(serverInfo.name, "mcp-prusaslicer");
      assertEquals(
        serverInfo.version,
        denoConfig.version,
        "stdio initialize version must match the package manifest",
      );

      const listed = responses[1].result as Record<string, unknown>;
      assertEquals(responses[1].id, 2);
      const names = (listed.tools as { name: string }[]).map((t) => t.name).sort();
      assertEquals(names, [
        "prusaslicer_estimate_fff",
      ]);

      const toolCall = responses[2];
      assertEquals(toolCall.id, 3);
      const toolCallError = toolCall.error as
        | { code?: unknown }
        | undefined;
      const toolCallResult = toolCall.result as
        | { isError?: unknown }
        | undefined;
      const toolCallText = JSON.stringify(toolCall);
      assert(
        toolCallError !== undefined || toolCallResult?.isError === true,
        `incomplete tool call must be refused by the tool schema, got: ${toolCallText}`,
      );
      assert(
        toolCallError?.code !== -32020,
        `tools/call must reach native schema validation, got: ${toolCallText}`,
      );
      assert(
        toolCallText.includes("stl_path") ||
          toolCallText.includes("profile_ini_path") ||
          toolCallText.includes("Invalid arguments"),
        `tool call must reach schema validation, got: ${toolCallText}`,
      );
    } finally {
      await writer.close();
      server.kill("SIGTERM");
      await server.status;
    }
  },
);

Deno.test(
  "native stdio surfaces the server's typed refusal instead of inventing a success",
  async () => {
    const server = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--allow-all",
        new URL("../server.ts", import.meta.url).pathname,
        "--stdio",
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "null",
    }).spawn();

    const writer = server.stdin.getWriter();
    try {
      await writer.write(new TextEncoder().encode(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 7,
          method: "no/such-method",
          params: {},
        }) + "\n",
      ));
      const responses = await collectResponses(server.stdout, 1, 30_000);
      assertEquals(responses.length, 1);
      assertEquals(responses[0].id, 7);
      assert(
        responses[0].error !== undefined,
        "an unknown method must come back as a JSON-RPC error, never silence",
      );
    } finally {
      await writer.close();
      server.kill("SIGTERM");
      await server.status;
    }
  },
);
