/**
 * Layout invariants — the TypeScript twin of circ-compiler's
 * `lib/preview/layout/invariants.zig`, over segments only (no glyphs):
 *
 *   I0 `body`      wire cells strictly inside a component box;
 *   I1 `shared`    cells two or more nets cover with the same orientation;
 *   I2 `junction`  cells where two or more nets meet other than as a clean
 *                  perpendicular pass-through;
 *   I3 `tree`      nets whose cells are not one 4-connected set from their
 *                  source cell, or whose wires have a broken or
 *                  non-axis-aligned segment chain;
 *
 * plus `crossings`, `bends` (orientation changes), `straight` (wires with no
 * orientation change, however many collinear pieces) and `wires`. A net is
 * `(srcId, srcPort)`; a net may share cells with itself.
 *
 * Two checks. First, this checker run over the compiler's vendored JSON grids
 * must reproduce the compiler's own rows (`test/fixtures/layouts/
 * invariants.txt`, copied from `tests/fixtures/preview/layout-invariants.golden`)
 * — the two implementations agree on the definition. Second, the checker
 * over this port's `buildLayout` must give the same row: identical layouts
 * have identical invariants, all zero on this corpus.
 */
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildLayout } from "../src/layout";
import { golden, load, vendoredFixtureModes, type Mode } from "./layout-helpers";

interface Coord {
  x: number;
  y: number;
}
interface GridLike {
  width: number;
  height: number;
  components: Array<{ x: number; y: number; width: number; height: number }>;
  wires: Array<{ srcId: number; srcPort: number; segments: Array<{ from: Coord; to: Coord }> }>;
}

export interface Report {
  body: number;
  shared: number;
  junction: number;
  tree: number;
  crossings: number;
  bends: number;
  straight: number;
  wires: number;
}

interface Claim {
  net: string;
  horizontal: boolean;
  through: boolean;
}

const cellKey = (x: number, y: number) => `${x},${y}`;
const isHorizontal = (s: { from: Coord; to: Coord }) => s.from.y === s.to.y;
const isAxisAligned = (s: { from: Coord; to: Coord }) => s.from.x === s.to.x || s.from.y === s.to.y;
const sameCell = (a: Coord, b: Coord) => a.x === b.x && a.y === b.y;

export function invariantReport(grid: GridLike): Report {
  const report: Report = { body: 0, shared: 0, junction: 0, tree: 0, crossings: 0, bends: 0, straight: 0, wires: 0 };
  const claims = new Map<string, Claim[]>();
  const nets = new Map<string, { cells: Set<string>; source: Coord | null; broken: boolean }>();

  const insideAnyBox = (x: number, y: number) =>
    grid.components.some((c) => x >= c.x && x < c.x + c.width && y >= c.y && y < c.y + c.height);

  for (const w of grid.wires) {
    report.wires++;
    let wireBends = 0;
    for (let i = 0; i + 1 < w.segments.length; i++) {
      if (isHorizontal(w.segments[i]) !== isHorizontal(w.segments[i + 1])) wireBends++;
    }
    report.bends += wireBends;
    if (w.segments.length > 0 && wireBends === 0) report.straight++;

    const netKey = `${w.srcId}.${w.srcPort}`;
    let net = nets.get(netKey);
    if (!net) {
      net = { cells: new Set(), source: null, broken: false };
      nets.set(netKey, net);
    }
    if (w.segments.length === 0) {
      net.broken = true;
      continue;
    }
    const start = w.segments[0].from;
    if (net.source) {
      if (!sameCell(net.source, start)) net.broken = true;
    } else {
      net.source = { x: start.x, y: start.y };
    }

    for (let si = 0; si < w.segments.length; si++) {
      const seg = w.segments[si];
      if (!isAxisAligned(seg)) {
        net.broken = true;
        continue;
      }
      if (si > 0 && !sameCell(w.segments[si - 1].to, seg.from)) net.broken = true;
      const horizontal = isHorizontal(seg);
      const prev = si > 0 ? w.segments[si - 1] : null;
      const next = si + 1 < w.segments.length ? w.segments[si + 1] : null;
      const fromThrough = !!prev && isAxisAligned(prev) && isHorizontal(prev) === horizontal && sameCell(prev.to, seg.from);
      const toThrough = !!next && isAxisAligned(next) && isHorizontal(next) === horizontal && sameCell(next.from, seg.to);
      const lo = horizontal ? Math.min(seg.from.x, seg.to.x) : Math.min(seg.from.y, seg.to.y);
      const hi = horizontal ? Math.max(seg.from.x, seg.to.x) : Math.max(seg.from.y, seg.to.y);
      for (let i = lo; i <= hi; i++) {
        const x = horizontal ? i : seg.from.x;
        const y = horizontal ? seg.from.y : i;
        const isFrom = x === seg.from.x && y === seg.from.y;
        const isTo = x === seg.to.x && y === seg.to.y;
        const through = isFrom && isTo ? false : isFrom ? fromThrough : isTo ? toThrough : true;
        if (insideAnyBox(x, y)) report.body++;
        net.cells.add(cellKey(x, y));
        const k = cellKey(x, y);
        let list = claims.get(k);
        if (!list) {
          list = [];
          claims.set(k, list);
        }
        list.push({ net: netKey, horizontal, through });
      }
    }
  }

  // Fold one net's claims first: a fan-out's wires all cover the trunk, and
  // that is one net passing through — unless one of them corners there.
  for (const list of claims.values()) {
    const folded = new Map<string, { horizontal: boolean; vertical: boolean; corner: boolean }>();
    for (const c of list) {
      const f = folded.get(c.net) ?? { horizontal: false, vertical: false, corner: false };
      if (c.horizontal) f.horizontal = true;
      else f.vertical = true;
      if (!c.through) f.corner = true;
      folded.set(c.net, f);
    }
    if (folded.size < 2) continue;
    const fs = Array.from(folded.values());
    const allH = fs.every((f) => f.horizontal && !f.vertical);
    const allV = fs.every((f) => f.vertical && !f.horizontal);
    if (allH || allV) {
      report.shared++;
      continue;
    }
    const [a, b] = fs;
    const clean =
      fs.length === 2 &&
      !a.corner &&
      !b.corner &&
      ((a.horizontal && !a.vertical && b.vertical && !b.horizontal) || (b.horizontal && !b.vertical && a.vertical && !a.horizontal));
    if (clean) report.crossings++;
    else report.junction++;
  }

  for (const net of nets.values()) {
    if (net.broken || !net.source) {
      report.tree++;
      continue;
    }
    if (!connectedFrom(net.cells, net.source)) report.tree++;
  }
  return report;
}

function connectedFrom(cells: Set<string>, start: Coord): boolean {
  if (!cells.has(cellKey(start.x, start.y))) return false;
  const seen = new Set<string>([cellKey(start.x, start.y)]);
  const stack: Coord[] = [start];
  while (stack.length > 0) {
    const c = stack.pop()!;
    for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const n = { x: c.x + dx, y: c.y + dy };
      if (n.x < 0 || n.y < 0) continue;
      const k = cellKey(n.x, n.y);
      if (!cells.has(k) || seen.has(k)) continue;
      seen.add(k);
      stack.push(n);
    }
  }
  return seen.size === cells.size;
}

/** The compiler's row format, byte for byte. */
export function formatRow(name: string, mode: Mode, grid: GridLike): string {
  const r = invariantReport(grid);
  return `${name} ${mode} I0=${r.body} I1=${r.shared} I2=${r.junction} I3=${r.tree} X=${r.crossings} B=${r.bends} S=${r.straight}/${r.wires} size=${grid.width}x${grid.height}`;
}

/** The compiler's row without the columns this checker cannot compute —
 * `C=` (ordering crossings) and `F=` (fallback nets) come from its stages,
 * not from the grid. */
const stripStageColumns = (row: string): string => row.replace(/ C=\d+/, "").replace(/ F=\d+/, "");

const ZIG_ROWS = new Map(
  readFileSync(join(import.meta.dir, "fixtures", "layouts", "invariants.txt"), "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => {
      const [name, mode] = l.split(" ");
      return [`${name} ${mode}`, stripStageColumns(l)];
    })
);

test("the compiler's invariant rows cover exactly the vendored fixture-modes", () => {
  const modes = vendoredFixtureModes().map(([n, m]) => `${n} ${m}`);
  expect([...ZIG_ROWS.keys()].sort()).toEqual(modes.sort());
});

for (const [name, mode] of vendoredFixtureModes()) {
  test(`${name} (${mode}): this checker reproduces the compiler's row over the compiler's grid`, () => {
    expect(formatRow(name, mode, golden(name, mode))).toBe(ZIG_ROWS.get(`${name} ${mode}`) ?? "<no compiler row>");
  });
}

for (const [name, mode] of vendoredFixtureModes()) {
  test(`${name} (${mode}): this port's layout has the compiler's invariants`, async () => {
    const rt = await load(name);
    const row = formatRow(name, mode, buildLayout(rt.topology, { expandMacros: mode === "expanded" }));
    expect(row).toBe(ZIG_ROWS.get(`${name} ${mode}`) ?? "<no compiler row>");
  });
}
