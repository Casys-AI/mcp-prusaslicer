/**
 * @module @casys/mcp-prusaslicer
 *
 * FDM slicing estimation MCP server.
 * Slice an STL with a PrusaSlicer INI profile; get print-time and
 * material-consumption measurements from the real G-code.
 */

export { createSlicerServer } from "./server.ts";
export type { CreateSlicerServerOptions } from "./server.ts";

export { SlicerToolsClient } from "./src/client.ts";
export { allTools, getToolByName, toolsByCategory } from "./src/tools/mod.ts";
export type {
  SlicerTool,
  SlicerToolCategory,
  SlicerToolHandler,
} from "./src/tools/types.ts";
export {
  parsePrusaTime,
  sliceFff,
  SlicerNotFoundError,
  SlicingError,
} from "./src/api/prusa-slicer.ts";
export {
  InputArtifactError,
  snapshotIniArtifact,
  snapshotStlArtifact,
} from "./src/api/input-artifact.ts";
