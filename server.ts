/** MCP server for FDM slicing estimation over stateless HTTP or native stdio. */

import { McpApp } from "@casys/mcp-server";
import { SlicerToolsClient } from "./src/client.ts";

const VERSION = "0.4.0";
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
    instructions:
      "FDM slicing estimation via PrusaSlicer. Supply an admitted .stl path and a " +
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

function parsePort(value: string | undefined, flag: string): number {
  if (value === undefined || !/^[0-9]+$/.test(value)) {
    throw new TypeError(`${flag} must be an integer in 1-65535, got: ${value}`);
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new TypeError(`${flag} must be an integer in 1-65535, got: ${value}`);
  }
  return port;
}

function parseHostname(value: string | undefined, flag: string): string {
  const hostname = value?.trim();
  if (!hostname) {
    throw new TypeError(`${flag} requires a non-empty value.`);
  }
  return hostname;
}

function nextOptionValue(args: string[], index: number): string | undefined {
  const value = args[index + 1];
  return value?.startsWith("-") ? undefined : value;
}

export function parseCli(args: string[]): CliOptions {
  const envPort = Deno.env.get("MCP_PORT");
  const envHostname = Deno.env.get("MCP_HOSTNAME");
  let port = envPort === undefined ? DEFAULT_PORT : parsePort(envPort, "MCP_PORT");
  let hostname = envHostname === undefined
    ? DEFAULT_HOSTNAME
    : parseHostname(envHostname, "MCP_HOSTNAME");
  let transport: CliOptions["transport"] = "http";
  const seen = new Set<"stdio" | "port" | "hostname">();

  function assertNotDuplicate(
    option: "stdio" | "port" | "hostname",
    flag: string,
  ): void {
    if (seen.has(option)) {
      throw new TypeError(`Duplicate option: ${flag}`);
    }
    seen.add(option);
  }

  function assertHttpTransport(flag: string): void {
    if (seen.has("stdio")) {
      throw new TypeError(`--stdio cannot be combined with ${flag}.`);
    }
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--stdio") {
      assertNotDuplicate("stdio", "--stdio");
      if (seen.has("port") || seen.has("hostname")) {
        throw new TypeError("--stdio cannot be combined with HTTP flags.");
      }
      transport = "stdio";
    } else if (arg === "--port" || arg === "-p") {
      assertHttpTransport(arg);
      assertNotDuplicate("port", arg);
      const val = nextOptionValue(args, i);
      i++;
      port = parsePort(val, arg);
    } else if (arg.startsWith("--port=")) {
      assertHttpTransport("--port");
      assertNotDuplicate("port", "--port");
      const val = arg.slice("--port=".length);
      port = parsePort(val, "--port");
    } else if (arg === "--hostname" || arg === "-H") {
      assertHttpTransport(arg);
      assertNotDuplicate("hostname", arg);
      const val = nextOptionValue(args, i);
      i++;
      hostname = parseHostname(val, arg);
    } else if (arg.startsWith("--hostname=")) {
      assertHttpTransport("--hostname");
      assertNotDuplicate("hostname", "--hostname");
      hostname = parseHostname(arg.slice("--hostname=".length), "--hostname");
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
