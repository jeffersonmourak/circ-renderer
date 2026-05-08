import { PortName } from "../wasm/topology";
import {
  type PlacedComponent,
  type PortCoord,
  type RoutedWire,
  type Segment,
  type VirtualGraph,
} from "./types";

export interface RouteResult {
  wires: RoutedWire[];
  width: number;
  height: number;
}

interface PendingWire {
  srcId: number;
  srcPort: number;
  dstId: number;
  dstPort: number;
  sx: number; sy: number;
  dx: number; dy: number;
  trackX: number;
  segments: Segment[];
}

interface Trunk {
  sx: number;
  sy: number;
  srcId: number;
  srcPort: number;
  yMin: number;
  yMax: number;
  wires: number[];
  trackX: number;
}

interface SuperTrunk {
  members: number[]; // indices into `trunks`
  yMin: number;
  yMax: number;
}

const SRC_OUT = PortName.Out;
const min = Math.min;
const max = Math.max;

/**
 * Stage 5: route every edge as axis-aligned segments. Each source's fan-out
 * shares one vertical track; touching y-ranges chain into super-trunks that
 * each get a unique column. Falls back to a 5-leg detour when the natural
 * 3-leg L would cross a component body.
 */
export function route(
  graph: VirtualGraph,
  placed: PlacedComponent[]
): RouteResult {
  const placedById = new Map<number, PlacedComponent>();
  for (const p of placed) placedById.set(p.id, p);

  // 1. Pre-compute endpoints.
  const pending: PendingWire[] = [];
  for (const node of graph.nodes) {
    const srcP = placedById.get(node.id);
    if (!srcP) continue;
    for (const edge of node.outputs) {
      const dstP = placedById.get(edge.dstId);
      if (!dstP) continue;
      const dstCoord = portCoordOf(dstP, edge.dstPort) ?? { x: dstP.x, y: dstP.y };
      pending.push({
        srcId: node.id,
        srcPort: SRC_OUT,
        dstId: edge.dstId,
        dstPort: edge.dstPort,
        sx: srcP.outPort.x,
        sy: srcP.outPort.y,
        dx: dstCoord.x,
        dy: dstCoord.y,
        trackX: 0,
        segments: [],
      });
    }
  }

  // 2. Group wires into trunks by (sx, srcId, srcPort).
  const trunks: Trunk[] = [];
  for (let i = 0; i < pending.length; i++) {
    const w = pending[i];
    const yMin = min(w.sy, w.dy);
    const yMax = max(w.sy, w.dy);
    let foundIdx = -1;
    for (let ti = 0; ti < trunks.length; ti++) {
      const t = trunks[ti];
      if (t.sx === w.sx && t.srcId === w.srcId && t.srcPort === w.srcPort) {
        foundIdx = ti;
        break;
      }
    }
    if (foundIdx >= 0) {
      const t = trunks[foundIdx];
      t.yMin = min(t.yMin, yMin);
      t.yMax = max(t.yMax, yMax);
      t.wires.push(i);
    } else {
      trunks.push({
        sx: w.sx, sy: w.sy,
        srcId: w.srcId, srcPort: w.srcPort,
        yMin, yMax,
        wires: [i],
        trackX: 0,
      });
    }
  }

  // 3. Group trunks into sx-buckets (deterministic: sorted by sx ascending).
  const sxBuckets = new Map<number, number[]>();
  for (let ti = 0; ti < trunks.length; ti++) {
    const sx = trunks[ti].sx;
    let arr = sxBuckets.get(sx);
    if (!arr) { arr = []; sxBuckets.set(sx, arr); }
    arr.push(ti);
  }
  const sxKeys = [...sxBuckets.keys()].sort((a, b) => a - b);

  for (const sx of sxKeys) {
    const trunkIndices = sxBuckets.get(sx)!;

    // Sort trunks by yMin asc, trunk-index asc.
    trunkIndices.sort((a, b) => {
      const ta = trunks[a], tb = trunks[b];
      if (ta.yMin !== tb.yMin) return ta.yMin - tb.yMin;
      return a - b;
    });

    // Each trunk gets its own super-trunk (and therefore its own column).
    // The Zig CLI merges trunks with touching y-ranges into a shared bus
    // and uses `┴`/`├` glyphs to differentiate signals at junctions —
    // canvas drawing can't do that without ambiguity, so different
    // sources never share a vertical here.
    const supers: SuperTrunk[] = trunkIndices.map((ti) => {
      const t = trunks[ti];
      return { members: [ti], yMin: t.yMin, yMax: t.yMax };
    });

    // Sort super-trunks: bilateral first, then yExtent asc, then index.
    const superOrder = supers.map((_, i) => i);
    superOrder.sort((a, b) => {
      const sa = supers[a], sb = supers[b];
      const aBi = isSuperTrunkBilateral(sa, trunks);
      const bBi = isSuperTrunkBilateral(sb, trunks);
      if (aBi !== bBi) return aBi ? -1 : 1;
      const aSpread = sa.yMax - sa.yMin;
      const bSpread = sb.yMax - sb.yMin;
      if (aSpread !== bSpread) return aSpread - bSpread;
      return a - b;
    });

    // Allocate one unique trackX per super-trunk.
    const taken = new Set<number>();
    for (const stIdx of superOrder) {
      const st = supers[stIdx];
      const stSx = trunks[st.members[0]].sx;
      let candidate = stSx + 1;
      while (
        taken.has(candidate) ||
        bboxBlocksColumn(placed, candidate, st.yMin, st.yMax) ||
        portApproachInRange(placed, candidate, st.yMin, st.yMax)
      ) {
        candidate++;
        if (candidate > 1_000_000) throw new Error("route: track allocation runaway");
      }
      taken.add(candidate);
      for (const ti of st.members) {
        trunks[ti].trackX = candidate;
        for (const wi of trunks[ti].wires) pending[wi].trackX = candidate;
      }
    }
  }

  // 4. Generate segments.
  let placementMaxY = 0;
  for (const p of placed) {
    if (p.y + p.height > placementMaxY) placementMaxY = p.y + p.height;
  }

  for (const w of pending) {
    const tx = w.trackX;
    const segs: Segment[] = [];
    const adjacentDirect = w.sy === w.dy && tx === w.sx + 1 && tx + 1 === w.dx;
    const canUseLAtTx =
      w.dx > w.sx &&
      !isHSegBlocked(placed, w.sx, tx, w.sy) &&
      !isVSegBlocked(placed, tx, w.sy, w.dy) &&
      !isHSegBlocked(placed, tx, w.dx, w.dy);

    const txDst = w.dx >= 1 ? w.dx - 1 : w.dx;
    const canUseLAtTxDst =
      w.dx > w.sx && txDst !== tx && txDst > w.sx &&
      !isHSegBlocked(placed, w.sx, txDst, w.sy) &&
      !isVSegBlocked(placed, txDst, w.sy, w.dy) &&
      !isHSegBlocked(placed, txDst, w.dx, w.dy);

    if (adjacentDirect) {
      segs.push({ from: { x: w.sx, y: w.sy }, to: { x: w.dx, y: w.dy } });
    } else if (canUseLAtTx) {
      segs.push({ from: { x: w.sx, y: w.sy }, to: { x: tx, y: w.sy } });
      if (w.sy !== w.dy) segs.push({ from: { x: tx, y: w.sy }, to: { x: tx, y: w.dy } });
      segs.push({ from: { x: tx, y: w.dy }, to: { x: w.dx, y: w.dy } });
    } else if (canUseLAtTxDst) {
      segs.push({ from: { x: w.sx, y: w.sy }, to: { x: txDst, y: w.sy } });
      if (w.sy !== w.dy) segs.push({ from: { x: txDst, y: w.sy }, to: { x: txDst, y: w.dy } });
      segs.push({ from: { x: txDst, y: w.dy }, to: { x: w.dx, y: w.dy } });
    } else {
      const haveRoom = w.dx >= 1;
      const xLo = min(tx, txDst);
      const xHi = max(tx, txDst);
      const freeY = haveRoom
        ? findFreeY(placed, xLo, xHi, tx, txDst, w.sy, w.dy, placementMaxY)
        : null;

      if (freeY !== null) {
        segs.push({ from: { x: w.sx, y: w.sy }, to: { x: tx, y: w.sy } });
        if (freeY !== w.sy) segs.push({ from: { x: tx, y: w.sy }, to: { x: tx, y: freeY } });
        if (tx !== txDst) segs.push({ from: { x: tx, y: freeY }, to: { x: txDst, y: freeY } });
        if (freeY !== w.dy) segs.push({ from: { x: txDst, y: freeY }, to: { x: txDst, y: w.dy } });
        if (txDst !== w.dx) segs.push({ from: { x: txDst, y: w.dy }, to: { x: w.dx, y: w.dy } });
      } else {
        segs.push({ from: { x: w.sx, y: w.sy }, to: { x: tx, y: w.sy } });
        if (w.sy !== w.dy) segs.push({ from: { x: tx, y: w.sy }, to: { x: tx, y: w.dy } });
        segs.push({ from: { x: tx, y: w.dy }, to: { x: w.dx, y: w.dy } });
      }
    }
    w.segments = segs;
  }

  // 5. Pairwise crossing detection. Only true crossings — where one wire's
  // horizontal passes STRICTLY through another wire's vertical (or vice
  // versa) at a non-endpoint, non-corner cell. Skip:
  //   - same-source pairs (fan-out wires share segments by design)
  //   - endpoint coincidences (a horizontal ENDING on another wire's
  //     vertical isn't a crossing — it's a junction; leave it un-bridged)
  const crossings: PortCoord[][] = pending.map(() => []);
  for (let ai = 0; ai < pending.length; ai++) {
    const a = pending[ai];
    for (let bi = ai + 1; bi < pending.length; bi++) {
      const b = pending[bi];
      if (a.srcId === b.srcId) continue; // shared fan-out
      for (const sa of a.segments) {
        for (const sb of b.segments) {
          const pt = segmentCrossStrict(sa, sb);
          if (pt) {
            crossings[ai].push(pt);
            crossings[bi].push(pt);
          }
        }
      }
    }
  }

  // 6. Materialize.
  const wires: RoutedWire[] = pending.map((w, i) => ({
    srcId: w.srcId,
    srcPort: w.srcPort,
    dstId: w.dstId,
    dstPort: w.dstPort,
    segments: w.segments,
    crossings: crossings[i],
  }));

  // 7. Grid extents.
  let maxX = 0, maxY = 0;
  for (const p of placed) {
    if (p.x + p.width > maxX) maxX = p.x + p.width;
    if (p.y + p.height > maxY) maxY = p.y + p.height;
  }
  for (const w of wires) {
    for (const seg of w.segments) {
      if (seg.from.x + 1 > maxX) maxX = seg.from.x + 1;
      if (seg.to.x + 1 > maxX) maxX = seg.to.x + 1;
      if (seg.from.y + 1 > maxY) maxY = seg.from.y + 1;
      if (seg.to.y + 1 > maxY) maxY = seg.to.y + 1;
    }
  }

  return { wires, width: maxX, height: maxY };
}

function portCoordOf(pc: PlacedComponent, dstPort: number): PortCoord | null {
  for (const slot of pc.inPorts) {
    if (portByteOf(slot.portName) === dstPort) return slot.coord;
  }
  return null;
}

function portByteOf(name: string): number {
  switch (name) {
    case "in": return PortName.In;
    case "a":  return PortName.A;
    case "b":  return PortName.B;
    case "out": return PortName.Out;
    default: return 0xff;
  }
}

function isSuperTrunkBilateral(st: SuperTrunk, trunks: Trunk[]): boolean {
  let minSy = Infinity, maxSy = -Infinity;
  for (const ti of st.members) {
    const sy = trunks[ti].sy;
    if (sy < minSy) minSy = sy;
    if (sy > maxSy) maxSy = sy;
  }
  return st.yMin < minSy && st.yMax > maxSy;
}

function bboxBlocksColumn(placed: PlacedComponent[], x: number, yMin: number, yMax: number): boolean {
  for (const p of placed) {
    if (x < p.x || x >= p.x + p.width) continue;
    const pyTop = p.y;
    const pyBot = p.height > 0 ? p.y + p.height - 1 : p.y;
    if (yMin > pyBot) continue;
    if (yMax < pyTop) continue;
    return true;
  }
  return false;
}

function portApproachInRange(placed: PlacedComponent[], x: number, yMin: number, yMax: number): boolean {
  for (const p of placed) {
    for (const port of p.inPorts) {
      if (port.coord.x !== x) continue;
      if (port.coord.y >= yMin && port.coord.y <= yMax) return true;
    }
  }
  return false;
}

function isCellBlocked(placed: PlacedComponent[], x: number, y: number): boolean {
  for (const p of placed) {
    if (x < p.x || x >= p.x + p.width) continue;
    if (y < p.y || y >= p.y + p.height) continue;
    return true;
  }
  return false;
}

function isHSegBlocked(placed: PlacedComponent[], xa: number, xb: number, y: number): boolean {
  const lo = min(xa, xb), hi = max(xa, xb);
  for (let x = lo; x <= hi; x++) {
    if (isCellBlocked(placed, x, y)) return true;
  }
  return false;
}

function isVSegBlocked(placed: PlacedComponent[], x: number, ya: number, yb: number): boolean {
  const lo = min(ya, yb), hi = max(ya, yb);
  for (let y = lo; y <= hi; y++) {
    if (isCellBlocked(placed, x, y)) return true;
  }
  return false;
}

function findFreeY(
  placed: PlacedComponent[],
  xLo: number, xHi: number,
  tx: number, txDst: number,
  sy: number, dy: number,
  bound: number
): number | null {
  const searchLimit = bound + 16;
  for (let radius = 0; radius <= searchLimit; radius++) {
    if (radius > 0) {
      const below = sy + radius;
      if (below <= searchLimit && detourYIsClear(placed, xLo, xHi, tx, txDst, sy, dy, below)) {
        return below;
      }
    }
    if (sy >= radius) {
      const above = sy - radius;
      if (detourYIsClear(placed, xLo, xHi, tx, txDst, sy, dy, above)) {
        return above;
      }
    }
  }
  return null;
}

function detourYIsClear(
  placed: PlacedComponent[],
  xLo: number, xHi: number,
  tx: number, txDst: number,
  sy: number, dy: number,
  candidate: number
): boolean {
  if (isHSegBlocked(placed, xLo, xHi, candidate)) return false;
  if (isVSegBlocked(placed, tx, sy, candidate)) return false;
  if (isVSegBlocked(placed, txDst, candidate, dy)) return false;
  // Avoid rows that any in_port sits on — another wire is going to lay a
  // horizontal at that row to reach its port, and our detour's H leg
  // would overlap it. Source out_port rows are also reserved for the
  // same reason.
  for (const p of placed) {
    for (const port of p.inPorts) {
      if (port.coord.y === candidate) return false;
    }
    if (p.outPort.y === candidate) return false;
  }
  return true;
}

/**
 * Strict crossing: one segment's interior crosses the other's interior.
 * If the meeting point coincides with EITHER segment's endpoint, return
 * null — corners and junctions are handled by the renderer at draw time
 * and shouldn't get arc-bridged.
 */
function segmentCrossStrict(a: Segment, b: Segment): PortCoord | null {
  const aHoriz = a.from.y === a.to.y;
  const bHoriz = b.from.y === b.to.y;
  if (aHoriz === bHoriz) return null;
  const horiz = aHoriz ? a : b;
  const vert = aHoriz ? b : a;
  const hY = horiz.from.y;
  const hXMin = min(horiz.from.x, horiz.to.x);
  const hXMax = max(horiz.from.x, horiz.to.x);
  const vX = vert.from.x;
  const vYMin = min(vert.from.y, vert.to.y);
  const vYMax = max(vert.from.y, vert.to.y);
  // Strict containment: crossing point must be strictly inside both ranges.
  if (vX <= hXMin || vX >= hXMax) return null;
  if (hY <= vYMin || hY >= vYMax) return null;
  return { x: vX, y: hY };
}
