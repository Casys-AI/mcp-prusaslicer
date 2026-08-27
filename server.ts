/** MCP server for FDM slicing estimation over stateless HTTP or native stdio. */

import { McpApp } from "@casys/mcp-server";
import { SlicerToolsClient } from "./src/client.ts";

const VERSION = "0.3.1";
const DEFAULT_PORT = 3022;
const DEFAULT_HOSTNAME = "127.0.0.1";

export interface CreateSlicerServerOptions {
  logger?: (message: string) => void;
}

export function createSlicerServer(
  options: CreateSlicerServerOptions = {},
): { app: McpApp } {
  const client = new SlicerToolsClient();
  const handlers = client.buildHandlersMap();

  const app = new McpApp({
    name: "mcp-prusaslicer",
    version: VERSION,
    transport: "stateless",
    maxConcurrent: 4,
    backpressureStrategy: "queue",
    validateSchema: true,
    instructions: "FDM slicing estimation via PrusaSlicer. Supply an STL path and a " +
      "PrusaSlicer INI profile; receive print-time and material-consumption " +
      "measurements from the real G-code. No prices — pricing is downstream (erpnext).",
    logger: options.logger ??
      ((message) => console.error(`[mcp-prusaslicer] ${message}`)),
  });
  app.registerTools(client.toMCPFormat(), handlers);
  return { app };
}

interface CliOptions {
  port: number;
  hostname: string;
  transport: "http" | "stdio";
}

export function parseCli(args: string[]): CliOptions {
  let port = parseInt(Deno.env.get("MCP_PORT") ?? "", 10) || DEFAULT_PORT;
  let hostname = Deno.env.get("MCP_HOSTNAME") ?? DEFAULT_HOSTNAME;
  let transport: CliOptions["transport"] = "http";
  let httpFlag: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--stdio") {
      if (httpFlag) {
        throw new TypeError(`--stdio cannot be combined with ${httpFlag}.`);
      }
      transport = "stdio";
    } else if (arg === "--port" || arg === "-p") {
      if (transport === "stdio") {
        throw new TypeError("--stdio cannot be combined with HTTP flags.");
      }
      httpFlag = "--port";
      const val = args[++i];
      port = parseInt(val, 10);
      if (!isFinite(port) || port < 1 || port > 65535) {
        throw new TypeError(`--port must be an integer in 1-65535, got: ${val}`);
      }
    } else if (arg.startsWith("--port=")) {
      if (transport === "stdio") {
        throw new TypeError("--stdio cannot be combined with HTTP flags.");
      }
      httpFlag = "--port";
      const val = arg.slice("--port=".length);
      port = parseInt(val, 10);
      if (!isFinite(port) || port < 1 || port > 65535) {
        throw new TypeError(`--port must be an integer in 1-65535, got: ${val}`);
      }
    } else if (arg === "--hostname" || arg === "-H") {
      if (transport === "stdio") {
        throw new TypeError("--stdio cannot be combined with HTTP flags.");
      }
      httpFlag = "--hostname";
      hostname = args[++i];
    } else if (arg.startsWith("--hostname=")) {
      if (transport === "stdio") {
        throw new TypeError("--stdio cannot be combined with HTTP flags.");
      }
      httpFlag = "--hostname";
      hostname = arg.slice("--hostname=".length);
    } else {
      throw new TypeError(`Unknown argument: ${arg}`);
    }
  }

  return { port, hostname, transport };
}

if (import.meta.main) {
  const cli = parseCli(Deno.args);
  const { app } = createSlicerServer();
  if (cli.transport === "stdio") {
    await app.start();
  } else {
    await app.startHttp({
      port: cli.port,
      hostname: cli.hostname,
      corsOrigins: ["http://127.0.0.1", "http://localhost"],
      onListen: ({ hostname, port }) => {
        console.error(
          `[mcp-prusaslicer] Stateless MCP: http://${hostname}:${port}/mcp`,
        );
      },
    });
  }
}
