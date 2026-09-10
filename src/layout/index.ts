import type { FullTopology } from "../wasm/topology";
import { collapse } from "./collapse";
import { layer } from "./layering";
import { order } from "./ordering";
import { place } from "./place";
import { route } from "./route";
import type { ColumnAssignment, LayeredGraph, LayoutGrid, LayoutOptions, Ordering, RowAssignment } from "./types";

export * from "./types";
export { collapse, layer, order, place, route };

/** The old column view over the real nodes (until coords.ts lands). */
function toColumns(layered: LayeredGraph, realCount: number): ColumnAssignment {
  const columnOf = new Array<number>(realCount);
  for (let i = 0; i < realCount; i++) columnOf[i] = layered.nodes[i].layer;
  return { columnOf, numColumns: layered.numLayers };
}

/** The old row view over the real nodes: a real node's row is its index
 * among the real nodes of its layer. */
function toRows(layered: LayeredGraph, ordering: Ordering, realCount: number): RowAssignment {
  const rowOf = new Array<number>(realCount).fill(0);
  let numRows = 0;
  for (const lo of ordering.order) {
    let r = 0;
    for (const ni of lo) {
      const real = layered.nodes[ni].real;
      if (real !== null) rowOf[real] = r++;
    }
    if (r > numRows) numRows = r;
  }
  return { rowOf, numRows };
}

/**
 * Compose the layout stages: collapse → layering → ordering → place → route.
 * Mirrors `lib/preview/layout/orchestrator.zig` as it stood after Phase 1
 * of the layout rewrite; the old place and route stages consume the
 * column/row views over the real nodes.
 */
export function buildLayout(
  topology: FullTopology,
  opts: LayoutOptions = {}
): LayoutGrid {
  const graph = collapse(topology, opts);
  const layered = layer(graph);
  const ordering = order(graph, layered);
  const cols = toColumns(layered, graph.nodes.length);
  const rows = toRows(layered, ordering, graph.nodes.length);
  const placed = place(graph, cols, rows);
  const routed = route(graph, placed);
  return {
    width: routed.width,
    height: routed.height,
    components: placed,
    wires: routed.wires,
  };
}
