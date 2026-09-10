import { insertSpacerRow, reserveReturnRows } from "./coords";
import { inputSlots, outputRow, slotIndex } from "./ports";
import type {
  ChannelWidths,
  Coords,
  Gap,
  Jog,
  LayerEdge,
  LayeredGraph,
  Net,
  OriginalEdge,
  Piece,
  PortCoord,
  RoutePlan,
  RoutedWire,
  Segment,
  Terminal,
  VirtualGraph,
} from "./types";

/**
 * Stage 5: channel routing — mirrors `lib/preview/layout/channels.zig`.
 * Every wire is routed per inter-layer gap: nets, left-edge tracks under a
 * constraint graph, doglegs and spacer rows for constraint cycles, return
 * lanes below the diagram for back edges, demand-sized gap widths, and a
 * bounded cell search as the counted fallback. `plan` decides on the
 * first-pass coordinates (rows), `emit` draws on the second (columns).
 *
 * One deliberate difference from the compiler: `RoutedWire.crossings` here
 * lists only cells where two *different* nets cross, because the canvas
 * reads it for jump arcs and has no notion of a fan-out tap; the ASCII
 * renderer's tap cells are not needed. `crossings` is outside the parity
 * contract.
 */
export const MIN_GAP_WIDTH = 5;
export const TURN_COST = 3;

// ---------- Nets ----------

function inputRow(graph: VirtualGraph, layered: LayeredGraph, coords: Coords, ni: number, dstPort: number): number | null {
  const ln = layered.nodes[ni];
  if (ln.real !== null) {
    const node = graph.nodes[ln.real];
    const s = slotIndex(node, dstPort);
    if (s === null) return null;
    return coords.y[ni] + inputSlots(node)[s].row;
  }
  return coords.y[ni];
}

function outRow(graph: VirtualGraph, layered: LayeredGraph, coords: Coords, ni: number): number {
  const ln = layered.nodes[ni];
  return ln.real !== null ? coords.y[ni] + outputRow(graph.nodes[ln.real], coords.h[ni]) : coords.y[ni];
}

const lessTerminalByRow = (a: Terminal, b: Terminal): number => (a.row !== b.row ? a.row - b.row : a.node - b.node);

const lessNet = (a: Net, b: Net): number => {
  if (a.lo !== b.lo) return a.lo - b.lo;
  if (a.srcReal !== b.srcReal) return a.srcReal - b.srcReal;
  return a.srcPort - b.srcPort;
};

/** The forward nets of gap `k`, sorted by `(lo, srcReal, srcPort)`. */
export function extractNets(graph: VirtualGraph, layered: LayeredGraph, coords: Coords, k: number): Net[] {
  type Key = { real: number; port: number; srcNode: number };
  const keys: Key[] = [];
  const sinksOf: Terminal[][] = [];
  for (const e of layered.edges) {
    if (layered.nodes[e.src].layer !== k) continue;
    const o = layered.originals[e.original];
    let idx = keys.findIndex((key) => key.real === o.src && key.port === o.srcPort && key.srcNode === e.src);
    if (idx < 0) {
      keys.push({ real: o.src, port: o.srcPort, srcNode: e.src });
      sinksOf.push([]);
      idx = keys.length - 1;
    }
    const row = inputRow(graph, layered, coords, e.dst, e.dstPort);
    if (row === null) continue;
    sinksOf[idx].push({ node: e.dst, port: e.dstPort, row, rail: "right" });
  }
  const nets: Net[] = [];
  for (let i = 0; i < keys.length; i++) {
    const sinks = sinksOf[i];
    if (sinks.length === 0) continue;
    sinks.sort(lessTerminalByRow);
    const key = keys[i];
    const srcRow = outRow(graph, layered, coords, key.srcNode);
    let lo = srcRow;
    let hi = srcRow;
    let straight = true;
    for (const t of sinks) {
      if (t.row < lo) lo = t.row;
      if (t.row > hi) hi = t.row;
      if (t.row !== srcRow) straight = false;
    }
    nets.push({
      srcReal: key.real,
      srcPort: key.port,
      src: { node: key.srcNode, port: key.port, row: srcRow, rail: "left" },
      sinks,
      lo,
      hi,
      straight,
      pieces: [],
      jogs: [],
      back: false,
      fallback: false,
    });
  }
  nets.sort(lessNet);
  return nets;
}

// ---------- Tracks ----------

const overlaps = (aLo: number, aHi: number, bLo: number, bHi: number): boolean => aLo <= bHi && bLo <= aHi;

interface Unit {
  net: number;
  piece: number;
  lo: number;
  hi: number;
  leftRows: number[];
  rightRows: number[];
}

export type TrackResult = { tracks: number } | { cycle: { net: number; lo: number; hi: number } };

export function tryAssignTracks(nets: Net[]): TrackResult {
  const units: Unit[] = [];
  for (let ni = 0; ni < nets.length; ni++) {
    const net = nets[ni];
    if (net.straight) continue;
    if (net.pieces.length === 0) net.pieces = [{ track: 0, lo: net.lo, hi: net.hi }];
    for (let pi = 0; pi < net.pieces.length; pi++) {
      const pc = net.pieces[pi];
      const left: number[] = [];
      const right: number[] = [];
      if (net.src.rail === "left" && net.src.row >= pc.lo && net.src.row <= pc.hi) left.push(net.src.row);
      for (const t of net.sinks) if (t.rail === "right" && t.row >= pc.lo && t.row <= pc.hi) right.push(t.row);
      units.push({ net: ni, piece: pi, lo: pc.lo, hi: pc.hi, leftRows: left, rightRows: right });
    }
  }
  const n = units.length;
  if (n === 0) return { tracks: 0 };

  const preds: number[][] = Array.from({ length: n }, () => []);
  const succs: number[][] = Array.from({ length: n }, () => []);
  const indeg = new Array<number>(n).fill(0);
  const addArc = (from: number, to: number) => {
    if (succs[from].includes(to)) return;
    succs[from].push(to);
    preds[to].push(from);
    indeg[to]++;
  };
  for (let ia = 0; ia < n; ia++) {
    const ua = units[ia];
    for (let ib = 0; ib < n; ib++) {
      if (ia === ib) continue;
      const ub = units[ib];
      if (ua.net === ub.net) continue;
      for (const r of ua.leftRows) for (const rb of ub.rightRows) if (r === rb) addArc(ia, ib);
    }
  }
  for (let ni = 0; ni < nets.length; ni++) {
    const net = nets[ni];
    if (!net.back || net.src.rail !== "left") continue;
    for (let oi = 0; oi < nets.length; oi++) {
      const other = nets[oi];
      if (oi === ni || !other.back || other.src.rail !== "none") continue;
      if (other.srcReal !== net.srcReal || other.srcPort !== net.srcPort) continue;
      let ua: number | null = null;
      let ub: number | null = null;
      for (let ui = 0; ui < n; ui++) {
        if (units[ui].net === ni) ua = ui;
        if (units[ui].net === oi) ub = ui;
      }
      if (ua !== null && ub !== null) addArc(ua, ub);
    }
  }

  const order: number[] = [];
  const done = new Array<boolean>(n).fill(false);
  while (order.length < n) {
    let picked = -1;
    for (let i = 0; i < n; i++) {
      if (!done[i] && indeg[i] === 0) {
        picked = i;
        break;
      }
    }
    if (picked < 0) {
      let widest = -1;
      for (let j = 0; j < n; j++) {
        if (done[j]) continue;
        if (widest < 0 || units[j].hi - units[j].lo > units[widest].hi - units[widest].lo) widest = j;
      }
      const u = units[widest];
      return { cycle: { net: u.net, lo: u.lo, hi: u.hi } };
    }
    done[picked] = true;
    order.push(picked);
    for (const s of succs[picked]) indeg[s]--;
  }

  const trackOf = new Array<number>(n).fill(0);
  const tracks: number[][] = [];
  for (const ui of order) {
    const u = units[ui];
    let minTrack = 0;
    for (const p of preds[ui]) if (trackOf[p] + 1 > minTrack) minTrack = trackOf[p] + 1;
    let t = minTrack;
    for (;;) {
      if (t >= tracks.length) tracks.push([]);
      let free = true;
      for (const o of tracks[t]) {
        const ou = units[o];
        if (overlaps(u.lo, u.hi, ou.lo, ou.hi)) {
          free = false;
          break;
        }
      }
      if (free) break;
      t++;
    }
    trackOf[ui] = t;
    tracks[t].push(ui);
    nets[u.net].pieces[u.piece].track = t;
  }
  for (const net of nets) {
    for (let ji = 0; ji < net.jogs.length; ji++) {
      net.jogs[ji].fromTrack = net.pieces[ji].track;
      net.jogs[ji].toTrack = net.pieces[ji + 1].track;
    }
  }
  return { tracks: tracks.length };
}

export function gapWidth(tracks: number): number {
  return Math.max(MIN_GAP_WIDTH, tracks + 2);
}

// ---------- Doglegs, spacer rows, return lanes ----------

function rowIsFree(nets: Net[], row: number): boolean {
  for (const net of nets) {
    if (net.src.row === row) return false;
    for (const t of net.sinks) if (t.row === row) return false;
    for (const j of net.jogs) if (j.row === row) return false;
  }
  return true;
}

function freeJogRow(nets: Net[], lo: number, hi: number): number | null {
  if (hi <= lo + 1) return null;
  const mid = Math.floor((lo + hi) / 2);
  for (let d = 0; ; d++) {
    const below = mid + d;
    const above = mid >= d ? mid - d : 0;
    let tried = false;
    if (below < hi && below > lo) {
      tried = true;
      if (rowIsFree(nets, below)) return below;
    }
    if (d > 0 && above > lo && above < hi) {
      tried = true;
      if (rowIsFree(nets, above)) return above;
    }
    if (!tried && below >= hi && above <= lo) return null;
  }
}

function splitNet(net: Net, row: number): void {
  if (net.pieces.length === 0) net.pieces = [{ track: 0, lo: net.lo, hi: net.hi }];
  let idx = -1;
  for (let i = 0; i < net.pieces.length; i++) if (net.pieces[i].lo < row && row < net.pieces[i].hi) idx = i;
  if (idx < 0) throw new Error("channels: no piece to split");
  const pc = net.pieces[idx];
  const pieces: Piece[] = [...net.pieces.slice(0, idx), { track: 0, lo: pc.lo, hi: row }, { track: 0, lo: row, hi: pc.hi }, ...net.pieces.slice(idx + 1)];
  const jogs: Jog[] = [...net.jogs.slice(0, idx), { row, fromTrack: 0, toTrack: 0 }, ...net.jogs.slice(idx)];
  net.pieces = pieces;
  net.jogs = jogs;
}

type GapOutcome = { tracks: number } | { spacer: number } | { unroutable: number };

function planGap(nets: Net[]): GapOutcome {
  let budget = nets.length * 2 + 2;
  while (budget > 0) {
    budget--;
    const r = tryAssignTracks(nets);
    if ("tracks" in r) return { tracks: r.tracks };
    const c = r.cycle;
    const row = freeJogRow(nets, c.lo, c.hi);
    if (row !== null) splitNet(nets[c.net], row);
    else return { spacer: Math.floor((c.lo + c.hi) / 2) + 1 };
  }
  const last = tryAssignTracks(nets);
  if ("tracks" in last) return { tracks: last.tracks };
  return { unroutable: last.cycle.net };
}

function tryAssignTracksIgnoring(nets: Net[], skip: number): TrackResult {
  const was = nets[skip].straight;
  nets[skip].straight = true;
  try {
    return tryAssignTracks(nets);
  } finally {
    nets[skip].straight = was;
  }
}

function appendReturnLaneNets(graph: VirtualGraph, layered: LayeredGraph, coords: Coords, backEdges: number[], k: number, nets: Net[]): void {
  for (let i = 0; i < backEdges.length; i++) {
    const o = layered.originals[backEdges[i]];
    const srcNode = o.src;
    const dstNode = o.dst;
    const lSrc = layered.nodes[srcNode].layer;
    const lDst = layered.nodes[dstNode].layer;
    if (lDst === 0) throw new Error("channels: a back edge into layer zero");
    const returnRow = coords.height + i;
    const srcRow = outRow(graph, layered, coords, srcNode);
    const dstRow = inputRow(graph, layered, coords, dstNode, o.dstPort);
    if (dstRow === null) continue;
    if (lSrc === k) {
      nets.push({
        srcReal: o.src,
        srcPort: o.srcPort,
        src: { node: srcNode, port: o.srcPort, row: srcRow, rail: "left" },
        sinks: [{ node: dstNode, port: o.dstPort, row: returnRow, rail: "none" }],
        lo: Math.min(srcRow, returnRow),
        hi: Math.max(srcRow, returnRow),
        straight: false,
        pieces: [],
        jogs: [],
        back: true,
        fallback: false,
      });
    }
    if (lDst - 1 === k) {
      nets.push({
        srcReal: o.src,
        srcPort: o.srcPort,
        src: { node: srcNode, port: o.srcPort, row: returnRow, rail: "none" },
        sinks: [{ node: dstNode, port: o.dstPort, row: dstRow, rail: "right" }],
        lo: Math.min(dstRow, returnRow),
        hi: Math.max(dstRow, returnRow),
        straight: false,
        pieces: [],
        jogs: [],
        back: true,
        fallback: false,
      });
    }
  }
}

/** The plan: nets and tracks for every gap, return lanes, spacer rows
 * inserted into `coords`. Rows are final when this returns. */
export function plan(graph: VirtualGraph, layered: LayeredGraph, coords: Coords): RoutePlan {
  const numLayers = layered.numLayers;
  const spacerRows: number[] = [];
  let fallbacks = 0;
  const backEdges: number[] = [];
  for (let oi = 0; oi < layered.originals.length; oi++) if (layered.originals[oi].back) backEdges.push(oi);

  const maxRestarts = layered.edges.length + backEdges.length + 1;
  for (let restarts = 0; restarts <= maxRestarts; restarts++) {
    const gaps: Gap[] = new Array(numLayers);
    let needSpacer: number | null = null;
    for (let k = 0; k < numLayers; k++) {
      const items = extractNets(graph, layered, coords, k);
      appendReturnLaneNets(graph, layered, coords, backEdges, k, items);
      const outcome = planGap(items);
      if ("tracks" in outcome) {
        gaps[k] = { afterLayer: k, nets: items, tracks: outcome.tracks, width: k + 1 < numLayers || items.length > 0 ? gapWidth(outcome.tracks) : 0 };
      } else if ("spacer" in outcome) {
        needSpacer = outcome.spacer;
        break;
      } else {
        items[outcome.unroutable].fallback = true;
        fallbacks++;
        const r = tryAssignTracksIgnoring(items, outcome.unroutable);
        if (!("tracks" in r)) throw new Error("channels: unroutable gap");
        gaps[k] = { afterLayer: k, nets: items, tracks: r.tracks, width: gapWidth(r.tracks) };
      }
    }
    if (needSpacer !== null) {
      insertSpacerRow(coords, needSpacer);
      spacerRows.push(needSpacer);
      continue;
    }
    reserveReturnRows(coords, backEdges.length);
    return { gaps, returnRows: backEdges.length, spacerRows, fallbacks };
  }
  throw new Error("channels: spacer loop exceeded");
}

export function widths(p: RoutePlan, numLayers: number): ChannelWidths {
  const after = new Array<number>(numLayers).fill(0);
  for (const g of p.gaps) after[g.afterLayer] = g.width;
  return { after };
}

// ---------- Emission ----------

export interface RouteResult {
  wires: RoutedWire[];
  width: number;
  height: number;
}

const seg = (x0: number, y0: number, x1: number, y1: number): Segment => ({ from: { x: x0, y: y0 }, to: { x: x1, y: y1 } });
const trackX = (coords: Coords, k: number, t: number): number => coords.channelX[k] + 1 + t;
const sinkX = (coords: Coords, k: number): number => coords.layerX[k + 1] - 1;
const sourceX = (layered: LayeredGraph, coords: Coords, ni: number, k: number): number =>
  layered.nodes[ni].real !== null ? coords.x[ni] + coords.w[ni] : coords.channelX[k];

function findNet(gap: Gap, srcNode: number, srcReal: number, srcPort: number, wantBack: boolean, railLeft: boolean): Net | null {
  for (const net of gap.nets) {
    if (net.back !== wantBack) continue;
    if (net.srcReal !== srcReal || net.srcPort !== srcPort) continue;
    if (!wantBack && net.src.node !== srcNode) continue;
    if (wantBack && (net.src.rail === "left") !== railLeft) continue;
    return net;
  }
  return null;
}

function pieceContaining(net: Net, row: number): number | null {
  for (let i = 0; i < net.pieces.length; i++) if (net.pieces[i].lo <= row && row <= net.pieces[i].hi) return i;
  return null;
}

function appendVertical(out: Segment[], net: Net, coords: Coords, k: number, fromRow: number, toRow: number, startX: number): number {
  const pi0 = pieceContaining(net, fromRow);
  const target = pieceContaining(net, toRow);
  if (pi0 === null || target === null) throw new Error("channels: row outside net");
  let pi: number = pi0;
  if (net.pieces.length > 1 && pi > target && net.pieces[pi].lo === fromRow) pi--;
  let x = startX;
  let row = fromRow;
  if (trackX(coords, k, net.pieces[pi].track) !== x) {
    out.push(seg(x, row, trackX(coords, k, net.pieces[pi].track), row));
    x = trackX(coords, k, net.pieces[pi].track);
  }
  while (pi !== target) {
    const stepDown: boolean = target > pi;
    const next: number = stepDown ? pi + 1 : pi - 1;
    const jog = net.jogs[stepDown ? pi : next];
    if (jog.row !== row) out.push(seg(x, row, x, jog.row));
    row = jog.row;
    const nx = trackX(coords, k, net.pieces[next].track);
    if (nx !== x) out.push(seg(x, row, nx, row));
    x = nx;
    pi = next;
  }
  if (toRow !== row) out.push(seg(x, row, x, toRow));
  return x;
}

function mergeSegments(segs: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segs) {
    if (s.from.x === s.to.x && s.from.y === s.to.y) continue;
    if (out.length > 0) {
      const last = out[out.length - 1];
      const lastH = last.from.y === last.to.y;
      const sH = s.from.y === s.to.y;
      if (lastH === sH && last.to.x === s.from.x && last.to.y === s.from.y) {
        last.to = s.to;
        continue;
      }
    }
    out.push({ from: { ...s.from }, to: { ...s.to } });
  }
  return out;
}

function pickHalf(gap: Gap, o: OriginalEdge, down: boolean, row: number): Net | null {
  for (const net of gap.nets) {
    if (!net.back) continue;
    if (net.srcReal !== o.src || net.srcPort !== o.srcPort) continue;
    const s0 = net.sinks[0];
    if (down && net.src.rail === "left" && s0.row === row && s0.node === o.dst && s0.port === o.dstPort) return net;
    if (!down && net.src.rail === "none" && net.src.row === row && s0.node === o.dst && s0.port === o.dstPort) return net;
  }
  return null;
}

const cellKey = (c: PortCoord): string => `${c.x},${c.y}`;

function occupancyOf(wires: RoutedWire[]): Set<string> {
  const occ = new Set<string>();
  for (const w of wires) {
    for (const s of w.segments) {
      const horizontal = s.from.y === s.to.y;
      const lo = horizontal ? Math.min(s.from.x, s.to.x) : Math.min(s.from.y, s.to.y);
      const hi = horizontal ? Math.max(s.from.x, s.to.x) : Math.max(s.from.y, s.to.y);
      for (let i = lo; i <= hi; i++) occ.add(cellKey(horizontal ? { x: i, y: s.from.y } : { x: s.from.x, y: i }));
    }
  }
  return occ;
}

type Dir = 0 | 1 | 2 | 3; // e s w n
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

/** A bounded best-first search over free cells: cost 1 per step, `TURN_COST`
 * per change of direction, inside `[x0, x1] × [y0, y1]`. */
export function searchPath(occupied: Set<string>, x0: number, x1: number, y0: number, y1: number, start: PortCoord, goal: PortCoord): PortCoord[] | null {
  type State = { x: number; y: number; dir: Dir };
  const key = (s: State) => `${s.x},${s.y},${s.dir}`;
  const best = new Map<string, number>();
  const parent = new Map<string, State>();
  const queue: { cost: number; state: State }[] = [];
  const less = (a: { cost: number; state: State }, b: { cost: number; state: State }) =>
    a.cost !== b.cost ? a.cost - b.cost : a.state.y !== b.state.y ? a.state.y - b.state.y : a.state.x !== b.state.x ? a.state.x - b.state.x : a.state.dir - b.state.dir;
  const push = (e: { cost: number; state: State }) => {
    queue.push(e);
    let i = queue.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (less(queue[i], queue[p]) < 0) {
        [queue[i], queue[p]] = [queue[p], queue[i]];
        i = p;
      } else break;
    }
  };
  const pop = () => {
    const top = queue[0];
    const last = queue.pop()!;
    if (queue.length > 0) {
      queue[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < queue.length && less(queue[l], queue[m]) < 0) m = l;
        if (r < queue.length && less(queue[r], queue[m]) < 0) m = r;
        if (m === i) break;
        [queue[i], queue[m]] = [queue[m], queue[i]];
        i = m;
      }
    }
    return top;
  };
  for (const d of [0, 1, 2, 3] as Dir[]) {
    const st = { x: start.x, y: start.y, dir: d };
    best.set(key(st), 0);
    push({ cost: 0, state: st });
  }
  let found: State | null = null;
  while (queue.length > 0) {
    const e = pop();
    const st = e.state;
    if ((best.get(key(st)) ?? Infinity) < e.cost) continue;
    if (st.x === goal.x && st.y === goal.y) {
      found = st;
      break;
    }
    for (const d of [0, 1, 2, 3] as Dir[]) {
      const nx = st.x + DX[d];
      const ny = st.y + DY[d];
      if (nx < x0 || nx > x1 || ny < y0 || ny > y1) continue;
      const cell = { x: nx, y: ny };
      const isGoal = cell.x === goal.x && cell.y === goal.y;
      if (!isGoal && occupied.has(cellKey(cell))) continue;
      const cost = e.cost + 1 + (d !== st.dir ? TURN_COST : 0);
      const ns = { x: nx, y: ny, dir: d };
      if (cost < (best.get(key(ns)) ?? Infinity)) {
        best.set(key(ns), cost);
        parent.set(key(ns), st);
        push({ cost, state: ns });
      }
    }
  }
  if (found === null) return null;
  const cells: PortCoord[] = [];
  let cur: State = found;
  for (;;) {
    cells.push({ x: cur.x, y: cur.y });
    if (cur.x === start.x && cur.y === start.y) break;
    const p = parent.get(key(cur));
    if (!p) return null;
    cur = p;
  }
  cells.reverse();
  return cells;
}

function cellsToSegments(cells: PortCoord[]): Segment[] {
  const segs: Segment[] = [];
  for (let i = 1; i < cells.length; i++) segs.push(seg(cells[i - 1].x, cells[i - 1].y, cells[i].x, cells[i].y));
  return mergeSegments(segs);
}

export function emit(graph: VirtualGraph, layered: LayeredGraph, coords: Coords, p: RoutePlan): RouteResult {
  const slots: (RoutedWire | null)[] = new Array(layered.originals.length).fill(null);

  const deferred = new Set<number>();
  for (let oi = 0; oi < layered.originals.length; oi++) {
    const o = layered.originals[oi];
    if (o.back) continue;
    let cur = o.src;
    let k = layered.nodes[cur].layer;
    let usesFallback = false;
    for (;;) {
      const e = layered.edges.find((x) => x.original === oi && x.src === cur);
      if (!e) break;
      const net = findNet(p.gaps[k], cur, o.src, o.srcPort, false, true);
      if (net && net.fallback) usesFallback = true;
      cur = e.dst;
      k++;
      if (layered.nodes[cur].real !== null) break;
    }
    if (usesFallback) deferred.add(oi);
  }

  for (let pass = 0; pass < 2; pass++) {
    const occupied = pass === 1 ? occupancyOf(slots.filter((w): w is RoutedWire => w !== null)) : new Set<string>();
    let backIndex = 0;
    for (let oi = 0; oi < layered.originals.length; oi++) {
      const o = layered.originals[oi];
      const isDeferred = deferred.has(oi);
      if (o.back) {
        if (pass === 1) continue;
      } else if ((pass === 0) === isDeferred) continue;
      const segs: Segment[] = [];
      if (o.back) {
        const j = layered.nodes[o.src].layer;
        const i = layered.nodes[o.dst].layer;
        const returnRow = coords.height - p.returnRows + backIndex;
        backIndex++;
        const down = pickHalf(p.gaps[j], o, true, returnRow) ?? findNet(p.gaps[j], o.src, o.src, o.srcPort, true, true);
        const up = pickHalf(p.gaps[i - 1], o, false, returnRow) ?? findNet(p.gaps[i - 1], o.src, o.src, o.srcPort, true, false);
        if (!down || !up) throw new Error("channels: missing return-lane net");
        const srcRow = down.src.row;
        const dstRow = up.sinks[0].row;
        const xS = sourceX(layered, coords, o.src, j);
        const t1 = trackX(coords, j, down.pieces[0].track);
        const t2 = trackX(coords, i - 1, up.pieces[0].track);
        segs.push(seg(xS, srcRow, t1, srcRow));
        segs.push(seg(t1, srcRow, t1, returnRow));
        segs.push(seg(t1, returnRow, t2, returnRow));
        segs.push(seg(t2, returnRow, t2, dstRow));
        segs.push(seg(t2, dstRow, sinkX(coords, i - 1), dstRow));
      } else {
        let cur = o.src;
        let k = layered.nodes[cur].layer;
        for (;;) {
          const e = layered.edges.find((x) => x.original === oi && x.src === cur);
          if (!e) break;
          const net = findNet(p.gaps[k], cur, o.src, o.srcPort, false, true);
          if (!net) throw new Error("channels: missing net");
          const srcRow = net.src.row;
          let dstRow = 0;
          for (const t of net.sinks) if (t.node === e.dst && t.port === e.dstPort) dstRow = t.row;
          const xS = sourceX(layered, coords, cur, k);
          const xD = sinkX(coords, k);
          if (net.straight) {
            segs.push(seg(xS, srcRow, xD, dstRow));
          } else if (net.fallback) {
            const path = searchPath(occupied, Math.min(xS, coords.channelX[k]), xD, 0, coords.height - 1, { x: xS, y: srcRow }, { x: xD, y: dstRow });
            if (path) {
              segs.push(...cellsToSegments(path));
              for (const c of path) occupied.add(cellKey(c));
            } else {
              const tx = trackX(coords, k, 0);
              segs.push(seg(xS, srcRow, tx, srcRow), seg(tx, srcRow, tx, dstRow), seg(tx, dstRow, xD, dstRow));
            }
          } else {
            const xEnd = appendVertical(segs, net, coords, k, srcRow, dstRow, xS);
            segs.push(seg(xEnd, dstRow, xD, dstRow));
          }
          cur = e.dst;
          k++;
          if (layered.nodes[cur].real !== null) break;
          segs.push(seg(xD, dstRow, coords.channelX[k], dstRow));
        }
      }
      slots[oi] = {
        srcId: graph.nodes[o.src].id,
        srcPort: o.srcPort,
        dstId: graph.nodes[o.dst].id,
        dstPort: o.dstPort,
        segments: mergeSegments(segs),
        crossings: [],
        realSrcId: o.realSrcId,
      };
    }
  }

  const wires = slots.filter((w): w is RoutedWire => w !== null);
  computeCrossings(wires);

  let width = coords.width;
  let height = coords.height;
  for (const w of wires) {
    for (const s of w.segments) {
      width = Math.max(width, s.from.x + 1, s.to.x + 1);
      height = Math.max(height, s.from.y + 1, s.to.y + 1);
    }
  }
  return { wires, width, height };
}

/** Cells where two *different* nets cross (the canvas draws a jump arc
 * there). Same-net cells — fan-out trunks and taps — are not listed. */
function computeCrossings(wires: RoutedWire[]): void {
  type Claim = { wire: number; net: string };
  const claims = new Map<string, Claim[]>();
  const cells = new Map<string, PortCoord>();
  for (let wi = 0; wi < wires.length; wi++) {
    const w = wires[wi];
    const net = `${w.srcId}.${w.srcPort}`;
    for (const s of w.segments) {
      const horizontal = s.from.y === s.to.y;
      const lo = horizontal ? Math.min(s.from.x, s.to.x) : Math.min(s.from.y, s.to.y);
      const hi = horizontal ? Math.max(s.from.x, s.to.x) : Math.max(s.from.y, s.to.y);
      for (let i = lo; i <= hi; i++) {
        const cell = horizontal ? { x: i, y: s.from.y } : { x: s.from.x, y: i };
        const k = cellKey(cell);
        if (!claims.has(k)) {
          claims.set(k, []);
          cells.set(k, cell);
        }
        claims.get(k)!.push({ wire: wi, net });
      }
    }
  }
  const lists: PortCoord[][] = wires.map(() => []);
  const sorted = Array.from(cells.values()).sort((a, b) => (a.y !== b.y ? a.y - b.y : a.x - b.x));
  for (const cell of sorted) {
    const list = claims.get(cellKey(cell))!;
    if (list.length < 2) continue;
    const nets = new Set(list.map((c) => c.net));
    if (nets.size < 2) continue;
    const seen = new Set<number>();
    for (const c of list) {
      if (seen.has(c.wire)) continue;
      seen.add(c.wire);
      lists[c.wire].push({ x: cell.x, y: cell.y });
    }
  }
  for (let i = 0; i < wires.length; i++) wires[i].crossings = lists[i];
}
