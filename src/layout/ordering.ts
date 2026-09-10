import { SLOT_KEY_BASE, slotIndex } from "./ports";
import type { LayeredGraph, Ordering, VirtualGraph } from "./types";

/**
 * Stage 3: the order of nodes inside each layer — mirrors
 * `lib/preview/layout/ordering.zig`. Barycenters are `[sum, count]` pairs
 * compared by cross-multiplication; a node's key inside its layer is
 * `pos * SLOT_KEY_BASE + slot` where `slot` is the sink's input-port index
 * (0 for an output, a dummy, or an unknown port), so an `and`'s `a` above
 * its `b` is a crossing constraint, not a tie.
 */
export const MAX_ROUNDS = 4;
export const MAX_TRANSPOSE_PASSES = 16;

function endKey(graph: VirtualGraph, layered: LayeredGraph, pos: number[], node: number, dstPort: number | null): number {
  const ln = layered.nodes[node];
  let s = 0;
  if (dstPort !== null && ln.real !== null) {
    const idx = slotIndex(graph.nodes[ln.real], dstPort);
    // The key base is the compiler's; a concat with more operands than the
    // base can hold is clamped, which the compiler never sees (it folds
    // concats away) so parity is untouched.
    if (idx !== null) s = Math.min(idx, SLOT_KEY_BASE - 1);
  }
  return pos[node] * SLOT_KEY_BASE + s;
}

function countBilayer(graph: VirtualGraph, layered: LayeredGraph, pos: number[], l: number): number {
  const items: [number, number][] = [];
  for (const e of layered.edges) {
    if (layered.nodes[e.src].layer !== l) continue;
    items.push([endKey(graph, layered, pos, e.src, null), endKey(graph, layered, pos, e.dst, e.dstPort)]);
  }
  let n = 0;
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j];
      if ((a[0] < b[0] && a[1] > b[1]) || (a[0] > b[0] && a[1] < b[1])) n++;
    }
  }
  return n;
}

export function countCrossings(graph: VirtualGraph, layered: LayeredGraph, ordering: Ordering): number {
  let total = 0;
  for (let l = 0; l + 1 < layered.numLayers; l++) total += countBilayer(graph, layered, ordering.pos, l);
  return total;
}

interface Adjacency {
  ins: number[][];
  outs: number[][];
}

function buildAdjacency(layered: LayeredGraph): Adjacency {
  const n = layered.nodes.length;
  const ins: number[][] = Array.from({ length: n }, () => []);
  const outs: number[][] = Array.from({ length: n }, () => []);
  for (let ei = 0; ei < layered.edges.length; ei++) {
    const e = layered.edges[ei];
    ins[e.dst].push(ei);
    outs[e.src].push(ei);
  }
  return { ins, outs };
}

type Bary = [number, number];
const lessBary = (a: Bary, b: Bary): boolean => a[0] * b[1] < b[0] * a[1];

function sweepLayer(
  graph: VirtualGraph,
  layered: LayeredGraph,
  adj: Adjacency,
  orderL: number[],
  pos: number[],
  dir: "down" | "up"
): void {
  const entries = orderL.map((ni) => {
    let sum = 0;
    let count = 0;
    const edges = dir === "down" ? adj.ins[ni] : adj.outs[ni];
    for (const ei of edges) {
      const e = layered.edges[ei];
      sum += dir === "down" ? endKey(graph, layered, pos, e.src, null) : endKey(graph, layered, pos, e.dst, e.dstPort);
      count++;
    }
    const bary: Bary = count === 0 ? [pos[ni] * SLOT_KEY_BASE, 1] : [sum, count];
    return { node: ni, bary, cur: pos[ni] };
  });
  entries.sort((a, b) => {
    if (lessBary(a.bary, b.bary)) return -1;
    if (lessBary(b.bary, a.bary)) return 1;
    return a.cur - b.cur;
  });
  for (let i = 0; i < entries.length; i++) {
    orderL[i] = entries[i].node;
    pos[entries[i].node] = i;
  }
}

function crossingsAround(graph: VirtualGraph, layered: LayeredGraph, pos: number[], l: number): number {
  let n = 0;
  if (l > 0) n += countBilayer(graph, layered, pos, l - 1);
  if (l + 1 < layered.numLayers) n += countBilayer(graph, layered, pos, l);
  return n;
}

export function order(graph: VirtualGraph, layered: LayeredGraph): Ordering {
  const n = layered.nodes.length;
  const adj = buildAdjacency(layered);
  const pos = new Array<number>(n).fill(0);
  const current: number[][] = Array.from({ length: layered.numLayers }, () => []);
  for (let i = 0; i < n; i++) {
    const ln = layered.nodes[i];
    pos[i] = current[ln.layer].length;
    current[ln.layer].push(i);
  }

  let bestPos = pos.slice();
  let best = current.map((l) => l.slice());
  let bestCount = countCrossings(graph, layered, { order: current, pos, rounds: 0 });

  let rounds = 0;
  while (rounds < MAX_ROUNDS) {
    rounds++;
    for (let l = 1; l < layered.numLayers; l++) sweepLayer(graph, layered, adj, current[l], pos, "down");
    for (let l = layered.numLayers - 1; l > 0; l--) sweepLayer(graph, layered, adj, current[l - 1], pos, "up");
    const count = countCrossings(graph, layered, { order: current, pos, rounds });
    if (count < bestCount) {
      bestCount = count;
      bestPos = pos.slice();
      best = current.map((l) => l.slice());
    } else break;
  }
  for (let i = 0; i < n; i++) pos[i] = bestPos[i];
  for (let l = 0; l < layered.numLayers; l++) current[l] = best[l].slice();

  for (let pass = 0; pass < MAX_TRANSPOSE_PASSES; pass++) {
    let swapped = false;
    for (let l = 0; l < layered.numLayers; l++) {
      const lo = current[l];
      if (lo.length < 2) continue;
      let before = crossingsAround(graph, layered, pos, l);
      for (let i = 0; i + 1 < lo.length; i++) {
        const v = lo[i];
        const w = lo[i + 1];
        lo[i] = w;
        lo[i + 1] = v;
        pos[w] = i;
        pos[v] = i + 1;
        const after = crossingsAround(graph, layered, pos, l);
        if (after < before) {
          before = after;
          swapped = true;
        } else {
          lo[i] = v;
          lo[i + 1] = w;
          pos[v] = i;
          pos[w] = i + 1;
        }
      }
    }
    if (!swapped) break;
  }

  return { order: current, pos, rounds };
}
