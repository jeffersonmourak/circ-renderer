import { ComponentKind } from "../wasm/topology";
import {
  isPrimitive,
  type LayerEdge,
  type LayerNode,
  type LayeredGraph,
  type OriginalEdge,
  type VirtualGraph,
  type VirtualNode,
} from "./types";

/**
 * Stage 2: layer assignment with dummy nodes for long edges — mirrors
 * `lib/preview/layout/layering.zig` line for line.
 *
 *   - every wire of the collapsed graph is an `OriginalEdge`, in node order
 *     and each node's `outputs` order;
 *   - a DFS over output edges marks the edges that close a cycle as `back`;
 *   - a fixed-point longest-path sweep over the non-back edges puts every
 *     input pin at layer 0 and every other node one past its furthest
 *     upstream; a node whose only inputs are back edges is bumped to layer
 *     1; leds and output pins are forced to the last layer; an edge that
 *     sink-forcing turned leftward is flagged `back` too;
 *   - every non-back edge spanning `k > 1` layers is split into `k`
 *     layer-adjacent `LayerEdge`s through `k - 1` dummy nodes.
 */
export function layer(graph: VirtualGraph): LayeredGraph {
  const n = graph.nodes.length;
  const indexOf = new Map<number, number>();
  for (let i = 0; i < n; i++) indexOf.set(graph.nodes[i].id, i);

  // Originals, in node order then outputs order.
  const originals: OriginalEdge[] = [];
  const firstOriginal = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    firstOriginal[i] = originals.length;
    for (const e of graph.nodes[i].outputs) {
      const dst = indexOf.get(e.dstId);
      if (dst === undefined) continue;
      originals.push({ src: i, srcPort: e.srcPort, dst, dstPort: e.dstPort, back: false, realSrcId: e.realSrcId });
    }
  }

  // Back edges: iterative DFS, roots in node order.
  {
    const color = new Array<number>(n).fill(0); // 0 white, 1 gray, 2 black
    type Frame = { nodeIdx: number; nextOutput: number; nextOriginal: number };
    const stack: Frame[] = [];
    for (let start = 0; start < n; start++) {
      if (color[start] !== 0) continue;
      color[start] = 1;
      stack.push({ nodeIdx: start, nextOutput: 0, nextOriginal: firstOriginal[start] });
      while (stack.length > 0) {
        const top = stack[stack.length - 1];
        const node = graph.nodes[top.nodeIdx];
        if (top.nextOutput >= node.outputs.length) {
          color[top.nodeIdx] = 2;
          stack.pop();
          continue;
        }
        const e = node.outputs[top.nextOutput++];
        const dst = indexOf.get(e.dstId);
        if (dst === undefined) continue;
        const oi = top.nextOriginal++;
        if (color[dst] === 1) {
          originals[oi].back = true;
        } else if (color[dst] === 0) {
          color[dst] = 1;
          stack.push({ nodeIdx: dst, nextOutput: 0, nextOriginal: firstOriginal[dst] });
        }
      }
    }
  }

  // Longest path over the non-back originals.
  const layerOf = new Array<number>(n).fill(0);
  const isBackDst = new Array<boolean>(n).fill(false);
  for (const o of originals) if (o.back) isBackDst[o.dst] = true;
  let changed = true;
  let iter = 0;
  while (changed && iter <= n + 1) {
    changed = false;
    for (let i = 0; i < n; i++) {
      if (isInputPin(graph.nodes[i])) {
        if (layerOf[i] !== 0) {
          layerOf[i] = 0;
          changed = true;
        }
        continue;
      }
      let want = 0;
      for (const o of originals) {
        if (o.back || o.dst !== i) continue;
        const cand = layerOf[o.src] + 1;
        if (cand > want) want = cand;
      }
      if (want === 0 && isBackDst[i]) want = 1;
      if (want !== layerOf[i]) {
        layerOf[i] = want;
        changed = true;
      }
    }
    iter++;
  }
  let numLayers = 1;
  for (const l of layerOf) if (l + 1 > numLayers) numLayers = l + 1;
  for (let i = 0; i < n; i++) if (isSink(graph.nodes[i])) layerOf[i] = numLayers - 1;
  for (const o of originals) {
    if (!o.back && layerOf[o.dst] <= layerOf[o.src]) o.back = true;
  }

  // Nodes: real first, then dummies; edges per original, per segment.
  const nodes: LayerNode[] = [];
  for (let i = 0; i < n; i++) nodes.push({ real: i, layer: layerOf[i], carries: null });
  const edges: LayerEdge[] = [];
  for (let oi = 0; oi < originals.length; oi++) {
    const o = originals[oi];
    if (o.back) continue;
    const lSrc = layerOf[o.src];
    const lDst = layerOf[o.dst];
    if (!(lDst > lSrc)) throw new Error("layering: a forward edge must span at least one layer");
    let prev = o.src;
    let prevPort = o.srcPort;
    for (let l = lSrc + 1; l < lDst; l++) {
      const dummy = nodes.length;
      nodes.push({ real: null, layer: l, carries: oi });
      edges.push({ src: prev, dst: dummy, srcPort: prevPort, dstPort: 0, original: oi });
      prev = dummy;
      prevPort = 0;
    }
    edges.push({ src: prev, dst: o.dst, srcPort: prevPort, dstPort: o.dstPort, original: oi });
  }

  return { nodes, edges, originals, numLayers };
}

const isInputPin = (n: VirtualNode): boolean =>
  isPrimitive(n.kind) && n.kind.kind === ComponentKind.InputPin;

const isSink = (n: VirtualNode): boolean =>
  isPrimitive(n.kind) &&
  (n.kind.kind === ComponentKind.Led || n.kind.kind === ComponentKind.OutputPin);
