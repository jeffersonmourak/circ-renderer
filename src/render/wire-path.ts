// The shape of one routed wire, as a path a host can stroke however it likes.
//
// The canvas draws a wire as its segments, with a horizontal segment arcing
// over every crossing the router recorded on it, so two signals that share a
// row read as separate wires. A theme that overrides `wire` used to have to
// re-derive those jumps from `wire.crossings` — the circ playground carried a
// copy of this loop — which meant a change to the arc here was a change the
// theme would silently miss. Tracing lives here once; the canvas and any host
// both call it.
//
// The path is the segments only. The stubs from a source box into its `out`
// port and from an `in` port into a destination box are not part of a wire's
// route — a skin that draws its own tails, as the playground's do, does not
// want them — so the canvas draws them separately.
//
// Two shapes come out of the same segments. Without a corner radius, each
// segment is its own subpath and a corner is where two of them meet, hard.
// With one, the whole wire is one continuous subpath whose corners round
// through `arcTo`, and the crossing hops are spliced into the horizontal runs
// as it goes — so a wire with a hop keeps the same corners as one without,
// which is what a theme that rounds its corners could not get by tracing the
// segments one at a time.

import type { RoutedWire } from "../layout";

/** Where a wire's jump arc goes when the caller does not say: 0.4 cells. */
export const defaultArcRadius = (cell: number): number => cell * 0.4;

export interface TraceOptions {
  /** Radius of the hop over a crossing. Default 0.4 cells. */
  arcRadius?: number;
  /**
   * Radius to round each corner with. Default 0: hard corners, one subpath
   * per segment. Clamped at every corner to half the shorter adjacent run,
   * so a one-cell jog cannot overshoot.
   */
  cornerRadius?: number;
}

function resolve(cell: number, opts: number | TraceOptions | undefined): Required<TraceOptions> {
  const o = typeof opts === "number" ? { arcRadius: opts } : opts ?? {};
  return { arcRadius: o.arcRadius ?? defaultArcRadius(cell), cornerRadius: o.cornerRadius ?? 0 };
}

/**
 * Trace a wire into `path`.
 *
 * `path` is anything with the `CanvasPath` methods — a `Path2D`, or a 2D
 * context after `beginPath()`. Nothing is stroked and no style is touched;
 * the caller strokes the result with whatever width and colour it chose.
 * A crossing on a vertical segment is not a jump; the router records the
 * horizontal one as the wire that arcs. The fourth argument is either the
 * arc radius alone, as it always was, or a `TraceOptions`.
 */
export function traceWire(path: CanvasPath, wire: RoutedWire, cell: number, opts?: number | TraceOptions): void {
  const { arcRadius, cornerRadius } = resolve(cell, opts);
  if (cornerRadius > 0) {
    traceRounded(path, wire, cell, arcRadius, cornerRadius);
    return;
  }
  const centre = (n: number): number => n * cell + cell / 2;
  for (const seg of wire.segments) {
    const startX = centre(seg.from.x);
    const startY = centre(seg.from.y);
    const endX = centre(seg.to.x);
    const endY = centre(seg.to.y);
    if (seg.from.y !== seg.to.y) {
      path.moveTo(startX, startY);
      path.lineTo(endX, endY);
      continue;
    }
    const segLo = Math.min(startX, endX);
    const segHi = Math.max(startX, endX);
    const y = startY;
    // Crossings landing on this exact horizontal segment, left to right.
    const jumps = wire.crossings
      .filter((c) => c.y === seg.from.y && centre(c.x) >= segLo && centre(c.x) <= segHi)
      .map((c) => centre(c.x))
      .sort((a, b) => a - b);
    let cursor = segLo;
    for (const jx of jumps) {
      path.moveTo(cursor, y);
      path.lineTo(jx - arcRadius, y);
      path.arc(jx, y, arcRadius, Math.PI, 0, false); // arc above the line
      cursor = jx + arcRadius;
    }
    path.moveTo(cursor, y);
    path.lineTo(segHi, y);
  }
}

/**
 * One continuous subpath for the whole wire: corners round through `arcTo`,
 * and each horizontal run hops its crossings in travel order, so the hop is
 * always above the line whichever way the run goes.
 */
function traceRounded(path: CanvasPath, wire: RoutedWire, cell: number, arcRadius: number, cornerRadius: number): void {
  if (wire.segments.length === 0) return;
  const centre = (n: number): number => n * cell + cell / 2;
  // The polyline's points: the first segment's start, then every segment's
  // end, with a zero-length step dropped so `arcTo` never sees a repeated point.
  const pts: { x: number; y: number }[] = [{ x: centre(wire.segments[0].from.x), y: centre(wire.segments[0].from.y) }];
  for (const seg of wire.segments) {
    const p = { x: centre(seg.to.x), y: centre(seg.to.y) };
    const last = pts[pts.length - 1];
    if (p.x !== last.x || p.y !== last.y) pts.push(p);
  }
  const hops = wire.crossings.map((c) => ({ x: centre(c.x), y: centre(c.y) }));

  path.moveTo(pts[0].x, pts[0].y);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (a.y === b.y) {
      const dir = Math.sign(b.x - a.x) || 1;
      const lo = Math.min(a.x, b.x);
      const hi = Math.max(a.x, b.x);
      // Hops strictly inside the run, in travel order; one on a corner cell
      // would fight the corner's own arc.
      const row = hops
        .filter((h) => h.y === a.y && h.x > lo && h.x < hi)
        .sort((p, q) => (dir > 0 ? p.x - q.x : q.x - p.x));
      for (const h of row) {
        path.lineTo(h.x - dir * arcRadius, a.y);
        if (dir > 0) path.arc(h.x, a.y, arcRadius, Math.PI, 0, false);
        else path.arc(h.x, a.y, arcRadius, 0, Math.PI, true);
      }
    }
    if (i < pts.length - 2) {
      const c = pts[i + 2];
      const inLen = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
      const outLen = Math.abs(c.x - b.x) + Math.abs(c.y - b.y);
      path.arcTo(b.x, b.y, c.x, c.y, Math.min(cornerRadius, inLen / 2, outLen / 2));
    } else {
      path.lineTo(b.x, b.y);
    }
  }
}

/**
 * The same trace as a fresh `Path2D`, for a host that wants to stroke a wire
 * more than once — a halo under the colour, say — without tracing it twice.
 * Needs `Path2D`, which a browser has and a headless test does not; use
 * `traceWire` on a context where that matters.
 */
export function wirePath(wire: RoutedWire, cell: number, opts?: number | TraceOptions): Path2D {
  const path = new Path2D();
  traceWire(path, wire, cell, opts);
  return path;
}
