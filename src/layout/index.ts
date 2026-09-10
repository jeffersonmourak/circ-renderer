import type { FullTopology } from "../wasm/topology";
import { collapse } from "./collapse";
import { assign, stubWidths, toPlaced } from "./coords";
import { layer } from "./layering";
import { order } from "./ordering";
import { route } from "./route";
import type { LayoutGrid, LayoutOptions } from "./types";

export * from "./types";
export { collapse, layer, order, route };

/**
 * Compose the layout stages: collapse → layering → ordering → coordinates
 * → route. Mirrors `lib/preview/layout/orchestrator.zig` as it stood after
 * Phase 2 of the layout rewrite; the old route stage still consumes the
 * placed components, with channel widths stubbed at the old gutter.
 */
export function buildLayout(
  topology: FullTopology,
  opts: LayoutOptions = {}
): LayoutGrid {
  const graph = collapse(topology, opts);
  const layered = layer(graph);
  const ordering = order(graph, layered);
  const coords = assign(graph, layered, ordering, stubWidths(layered.numLayers));
  const placed = toPlaced(graph, layered, coords);
  const routed = route(graph, placed);
  return {
    width: routed.width,
    height: routed.height,
    components: placed,
    wires: routed.wires,
  };
}
