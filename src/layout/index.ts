import type { FullTopology } from "../wasm/topology";
import { emit, plan, widths } from "./channels";
import { collapse } from "./collapse";
import { ROW_GUTTER, assign, relayoutColumns, stubWidths, toPlaced } from "./coords";
import { layer } from "./layering";
import { order } from "./ordering";
import type { LayoutGrid, LayoutOptions } from "./types";

export * from "./types";
export { collapse, layer, order, plan, emit };

/**
 * Compose the layout stages — mirrors `lib/preview/layout/orchestrator.zig`:
 * collapse → layering (dummies for long edges) → port-aware ordering →
 * per-node rows → channel routing in two passes (the plan on stub-width
 * columns decides tracks, doglegs, spacer rows and return lanes; the
 * columns are laid out again from the measured gap widths; the wires are
 * emitted on those).
 */
export function buildLayout(
  topology: FullTopology,
  opts: LayoutOptions = {}
): LayoutGrid {
  const graph = collapse(topology, opts);
  const layered = layer(graph);
  const ordering = order(graph, layered);
  const coords = assign(graph, layered, ordering, stubWidths(layered.numLayers), opts.rowGutter ?? ROW_GUTTER);
  const routePlan = plan(graph, layered, coords);
  relayoutColumns(coords, layered, widths(routePlan, layered.numLayers));
  const placed = toPlaced(graph, layered, coords);
  const routed = emit(graph, layered, coords, routePlan);
  return {
    width: routed.width,
    height: routed.height,
    components: placed,
    wires: routed.wires,
  };
}
