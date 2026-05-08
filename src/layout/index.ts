import type { FullTopology } from "../wasm/topology";
import { collapse } from "./collapse";
import { assignColumns } from "./columns";
import { place } from "./place";
import { route } from "./route";
import { assignRows } from "./rows";
import type { LayoutGrid, LayoutOptions } from "./types";

export * from "./types";
export { collapse, assignColumns, assignRows, place, route };

/**
 * Compose the five layout stages: collapse → columns → rows → place → route.
 * Mirrors `lib/preview/layout/orchestrator.zig`.
 */
export function buildLayout(
  topology: FullTopology,
  opts: LayoutOptions = {}
): LayoutGrid {
  const graph = collapse(topology, opts);
  const cols = assignColumns(graph);
  const rows = assignRows(graph, cols);
  const placed = place(graph, cols, rows);
  const routed = route(graph, placed);
  return {
    width: routed.width,
    height: routed.height,
    components: placed,
    wires: routed.wires,
  };
}
