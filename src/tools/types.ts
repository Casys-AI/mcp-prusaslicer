/**
 * Shared types for mcp-prusaslicer tools.
 *
 * One file per category; all categories export SlicerTool instances registered
 * via SlicerToolsClient.
 */

export type SlicerToolCategory = "estimation";

export type SlicerToolHandler = (
  args: Record<string, unknown>,
) => Promise<unknown> | unknown;

export interface SlicerTool {
  name: string;
  description: string;
  category: SlicerToolCategory;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  handler: SlicerToolHandler;
}
