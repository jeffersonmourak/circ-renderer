import { resolvePortCoords, sizeOf } from "./boxes";
import { inputSlots, outputRow, slotIndex } from "./ports";
import type { ChannelWidths, Coords, LayeredGraph, Ordering, PlacedComponent, VirtualGraph } from "./types";

/**
 * Stage 4: coordinates — mirrors `lib/preview/layout/coords.zig`. Every
 * node gets its own row: the top that makes the wire into its highest input
 * port a straight horizontal, packed in the ordering with `ROW_GUTTER` free
 * rows between boxes (a dummy is a wire row and needs none); a reverse pass
 * moves a node with one out-edge down to straighten it; columns are each
 * layer's widest box plus the gap the router asks for.
 */
export const ROW_GUTTER = 1;
/** The old gutter, used for every gap until the channel stage measures demand. */
export const STUB_CHANNEL_WIDTH = 5;

export function stubWidths(numLayers: number): ChannelWidths {
  return { after: new Array<number>(numLayers).fill(STUB_CHANNEL_WIDTH) };
}

function buildAdj(layered: LayeredGraph, which: "ins" | "outs"): number[][] {
  const lists: number[][] = Array.from({ length: layered.nodes.length }, () => []);
  for (let ei = 0; ei < layered.edges.length; ei++) {
    const e = layered.edges[ei];
    lists[which === "ins" ? e.dst : e.src].push(ei);
  }
  return lists;
}

function outputOffset(graph: VirtualGraph, layered: LayeredGraph, h: number[], ni: number): number {
  const ln = layered.nodes[ni];
  return ln.real !== null ? outputRow(graph.nodes[ln.real], h[ni]) : 0;
}

function inputPortRow(graph: VirtualGraph, layered: LayeredGraph, y: number[], ni: number, dstPort: number): number | null {
  const ln = layered.nodes[ni];
  if (ln.real !== null) {
    const node = graph.nodes[ln.real];
    const s = slotIndex(node, dstPort);
    if (s === null) return null;
    return y[ni] + inputSlots(node)[s].row;
  }
  return y[ni];
}

function outputPortRow(graph: VirtualGraph, layered: LayeredGraph, y: number[], h: number[], ni: number): number {
  const ln = layered.nodes[ni];
  return ln.real !== null ? y[ni] + outputRow(graph.nodes[ln.real], h[ni]) : y[ni];
}

/** The top row that makes the node's highest input wire straight, if any. */
function preferredRow(graph: VirtualGraph, layered: LayeredGraph, ins: number[][], y: number[], h: number[], ni: number): number | null {
  const ln = layered.nodes[ni];
  const edges = ins[ni];
  if (edges.length === 0) return null;
  if (ln.real !== null) {
    const node = graph.nodes[ln.real];
    let bestSlot: number | null = null;
    let bestEdge = 0;
    for (const ei of edges) {
      const e = layered.edges[ei];
      const s = slotIndex(node, e.dstPort);
      if (s === null) continue;
      if (bestSlot === null || s < bestSlot) {
        bestSlot = s;
        bestEdge = ei;
      }
    }
    if (bestSlot === null) return null;
    const e = layered.edges[bestEdge];
    const srcRow = outputPortRow(graph, layered, y, h, e.src);
    const portRow = inputSlots(node)[bestSlot].row;
    return Math.max(0, srcRow - portRow);
  }
  return outputPortRow(graph, layered, y, h, layered.edges[edges[0]].src);
}

/**
 * `rowGutter` is the free rows a box leaves below itself; `ROW_GUTTER` unless
 * a host asks for more (a theme whose marks reach above a box needs the room).
 * The compiler's preview always uses the default.
 */
export function assign(graph: VirtualGraph, layered: LayeredGraph, ordering: Ordering, widths: ChannelWidths, rowGutter: number = ROW_GUTTER): Coords {
  const n = layered.nodes.length;
  const numLayers = layered.numLayers;

  const w = new Array<number>(n).fill(0);
  const h = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const ln = layered.nodes[i];
    if (ln.real !== null) {
      const sz = sizeOf(graph.nodes[ln.real]);
      w[i] = sz.width;
      h[i] = sz.height;
    } else {
      w[i] = 0;
      h[i] = 1;
    }
  }

  const ins = buildAdj(layered, "ins");
  const y = new Array<number>(n).fill(0);

  // Rows: preferred row then packing, with a box cursor and an any cursor.
  for (let l = 0; l < numLayers; l++) {
    let boxCursor = 0;
    let anyCursor = 0;
    for (const ni of ordering.order[l]) {
      const isBox = layered.nodes[ni].real !== null;
      const cursor = isBox ? boxCursor : anyCursor;
      const preferred = preferredRow(graph, layered, ins, y, h, ni);
      const top = preferred !== null ? Math.max(cursor, preferred) : cursor;
      y[ni] = top;
      anyCursor = top + h[ni];
      boxCursor = isBox ? top + h[ni] + rowGutter : top + h[ni];
    }
  }

  // Reverse pass: straighten a lone out-wire by moving its source down.
  if (numLayers >= 2) {
    const outs = buildAdj(layered, "outs");
    for (let lr = numLayers - 1; lr > 0; lr--) {
      const lo = ordering.order[lr - 1];
      for (let i = 0; i < lo.length; i++) {
        const ni = lo[i];
        const es = outs[ni];
        if (es.length !== 1) continue;
        const pref = preferredRow(graph, layered, ins, y, h, ni);
        if (pref !== null && pref === y[ni]) continue;
        const e = layered.edges[es[0]];
        const sinkRow = inputPortRow(graph, layered, y, e.dst, e.dstPort);
        if (sinkRow === null) continue;
        const outOff = outputOffset(graph, layered, h, ni);
        if (sinkRow < outOff) continue;
        const target = sinkRow - outOff;
        if (target <= y[ni]) continue;
        let room = true;
        if (i + 1 < lo.length) {
          const next = lo[i + 1];
          const gap = layered.nodes[ni].real !== null && layered.nodes[next].real !== null ? rowGutter : 0;
          room = target + h[ni] + gap <= y[next];
        }
        if (room) y[ni] = target;
      }
    }
  }

  // Columns.
  const layerW = new Array<number>(numLayers).fill(0);
  for (let i = 0; i < n; i++) {
    const l = layered.nodes[i].layer;
    if (w[i] > layerW[l]) layerW[l] = w[i];
  }
  for (let k = 0; k < numLayers; k++) if (layerW[k] === 0) layerW[k] = 1;
  const coords: Coords = {
    x: new Array<number>(n).fill(0),
    y,
    w,
    h,
    layerX: new Array<number>(numLayers).fill(0),
    layerW,
    channelX: new Array<number>(numLayers).fill(0),
    width: 0,
    height: 0,
  };
  relayoutColumns(coords, layered, widths);
  let height = 0;
  for (let i = 0; i < n; i++) if (y[i] + h[i] > height) height = y[i] + h[i];
  coords.height = height;
  return coords;
}

/** Every node at or below row `at` moves down one row; the grid grows by one. */
export function insertSpacerRow(coords: Coords, at: number): void {
  for (let i = 0; i < coords.y.length; i++) if (coords.y[i] >= at) coords.y[i] += 1;
  coords.height += 1;
}

/** Append `n` rows below the diagram for return lanes. */
export function reserveReturnRows(coords: Coords, n: number): void {
  coords.height += n;
}

/** Recompute every column from `layerW` and the given widths; rows are untouched. */
export function relayoutColumns(coords: Coords, layered: LayeredGraph, widths: ChannelWidths): void {
  let acc = 0;
  for (let k = 0; k < layered.numLayers; k++) {
    coords.layerX[k] = acc;
    coords.channelX[k] = acc + coords.layerW[k];
    acc += coords.layerW[k] + widths.after[k];
  }
  let width = 0;
  for (let i = 0; i < layered.nodes.length; i++) {
    coords.x[i] = coords.layerX[layered.nodes[i].layer];
    if (coords.x[i] + coords.w[i] > width) width = coords.x[i] + coords.w[i];
  }
  coords.width = width;
}

/** The `PlacedComponent` list for the real nodes, in `VirtualGraph` order. */
export function toPlaced(graph: VirtualGraph, layered: LayeredGraph, coords: Coords): PlacedComponent[] {
  const placed: PlacedComponent[] = new Array(graph.nodes.length);
  for (let i = 0; i < layered.nodes.length; i++) {
    const ln = layered.nodes[i];
    if (ln.real === null) continue;
    const node = graph.nodes[ln.real];
    const x = coords.x[i];
    const y = coords.y[i];
    const w = coords.w[i];
    const h = coords.h[i];
    const pc = resolvePortCoords(node, x, y, w, h);
    placed[ln.real] = {
      id: node.id,
      kind: node.kind,
      name: node.name,
      origin: node.origin,
      x,
      y,
      width: w,
      height: h,
      inPorts: pc.inPorts,
      outPort: pc.outPort,
      bitWidth: node.bitWidth,
      slice: node.slice,
      memory: node.memory,
    };
  }
  return placed;
}
