/**
 * SlicerToolsClient — builds handler maps and MCP tool descriptors.
 *
 * Consumed by server.ts (composition root) and tests.
 */

import { allTools } from "./tools/mod.ts";
import type { SlicerTool, SlicerToolHandler } from "./tools/types.ts";

export class SlicerToolsClient {
  private readonly tools: SlicerTool[];

  constructor() {
    this.tools = allTools;
  }

  /** Returns a name→handler map for McpApp.registerTools(). */
  buildHandlersMap(): Map<string, SlicerToolHandler> {
    return new Map(this.tools.map((t) => [t.name, t.handler]));
  }

  /** Returns tool descriptors in the format McpApp.registerTools() expects. */
  toMCPFormat(): Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown>;
    annotations: Record<string, unknown>;
  }> {
    return this.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema,
      annotations: t.annotations,
    }));
  }
}
