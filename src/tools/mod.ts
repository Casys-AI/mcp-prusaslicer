/**
 * Tool registry for mcp-prusaslicer.
 *
 * allTools is the authoritative list. SlicerToolsClient builds handler maps
 * from it; tests enumerate it to assert invariants.
 */

import { estimateFffTool } from "./estimate.ts";
import type { SlicerTool, SlicerToolCategory } from "./types.ts";

export const allTools: SlicerTool[] = [
  estimateFffTool,
];

export function getToolByName(name: string): SlicerTool | undefined {
  return allTools.find((t) => t.name === name);
}

export const toolsByCategory: Partial<Record<SlicerToolCategory, SlicerTool[]>> = Object
  .groupBy(allTools, (t) => t.category);
