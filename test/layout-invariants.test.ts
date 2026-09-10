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
 * over this port's `buildLayout` is pinned per fixture-mode in `TS_TODAY`:
 * the old algorithm's numbers on this side, replaced by all-zero rows when
 * the rewrite lands here.
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

  for (const list of claims.values()) {
    const distinct = new Set(list.map((c) => c.net));
    if (distinct.size < 2) continue;
    if (list.every((c) => c.horizontal === list[0].horizontal)) {
      report.shared++;
      continue;
    }
    if (distinct.size === 2 && list.length === 2 && list[0].through && list[1].through && list[0].horizontal !== list[1].horizontal) {
      report.crossings++;
    } else {
      report.junction++;
    }
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

const ZIG_ROWS = new Map(
  readFileSync(join(import.meta.dir, "fixtures", "layouts", "invariants.txt"), "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => {
      const [name, mode] = l.split(" ");
      return [`${name} ${mode}`, l];
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

/**
 * This port's own numbers, old algorithm, pinned. Regenerate by running the
 * file with `PRINT_TS_ROWS=1` and pasting the output.
 */
export const TS_TODAY: Record<string, string> = {
  "and_of_not opaque": "and_of_not opaque I0=0 I1=0 I2=0 I3=0 X=0 B=2 S=3/4 size=37x7",
  "builtin_xnor expanded": "builtin_xnor expanded I0=0 I1=0 I2=0 I3=0 X=1 B=8 S=8/12 size=67x13",
  "builtin_xnor opaque": "builtin_xnor opaque I0=0 I1=0 I2=0 I3=0 X=0 B=2 S=2/3 size=32x7",
  "builtin_xor expanded": "builtin_xor expanded I0=0 I1=0 I2=0 I3=0 X=1 B=8 S=7/11 size=57x13",
  "builtin_xor opaque": "builtin_xor opaque I0=0 I1=0 I2=0 I3=0 X=0 B=2 S=2/3 size=31x7",
  "chain opaque": "chain opaque I0=0 I1=0 I2=0 I3=0 X=0 B=0 S=4/4 size=47x3",
  "clean_gated_feedback opaque": "clean_gated_feedback opaque I0=0 I1=0 I2=0 I3=0 X=0 B=4 S=1/2 size=23x4",
  "demux_1to2 opaque": "demux_1to2 opaque I0=0 I1=0 I2=1 I3=0 X=1 B=6 S=4/7 size=41x13",
  "demux_2bit_1to2 opaque": "demux_2bit_1to2 opaque I0=0 I1=0 I2=1 I3=0 X=2 B=14 S=6/13 size=42x19",
  "demux_3bit_1to2 opaque": "demux_3bit_1to2 opaque I0=5 I1=0 I2=3 I3=0 X=6 B=24 S=8/19 size=42x31",
  "edge_single_component opaque": "edge_single_component opaque I0=0 I1=0 I2=0 I3=0 X=0 B=4 S=1/2 size=24x7",
  "fan_in opaque": "fan_in opaque I0=0 I1=0 I2=0 I3=0 X=0 B=2 S=2/3 size=25x7",
  "fan_out opaque": "fan_out opaque I0=0 I1=0 I2=0 I3=0 X=0 B=4 S=4/6 size=26x11",
  "full_adder_from_builtins expanded": "full_adder_from_builtins expanded I0=0 I1=0 I2=4 I3=0 X=8 B=34 S=15/31 size=100x39",
  "full_adder_from_builtins opaque": "full_adder_from_builtins opaque I0=0 I1=0 I2=0 I3=0 X=2 B=17 S=5/12 size=64x18",
  "led_4bit_default opaque": "led_4bit_default opaque I0=0 I1=0 I2=0 I3=0 X=0 B=0 S=1/1 size=15x3",
  "mixed_width_preview opaque": "mixed_width_preview opaque I0=0 I1=0 I2=0 I3=0 X=0 B=0 S=3/3 size=42x7",
  "multi_led opaque": "multi_led opaque I0=0 I1=0 I2=0 I3=0 X=0 B=0 S=3/3 size=16x11",
  "multibit_and_preview opaque": "multibit_and_preview opaque I0=0 I1=0 I2=0 I3=0 X=0 B=2 S=2/3 size=30x7",
  "multibit_input_preview opaque": "multibit_input_preview opaque I0=0 I1=0 I2=0 I3=0 X=0 B=0 S=2/2 size=27x3",
  "multibit_output_preview opaque": "multibit_output_preview opaque I0=0 I1=0 I2=0 I3=0 X=0 B=0 S=2/2 size=25x3",
  "parallel_leftward_detours opaque": "parallel_leftward_detours opaque I0=0 I1=0 I2=0 I3=0 X=0 B=8 S=2/4 size=24x8",
  "ram_basic opaque": "ram_basic opaque I0=0 I1=0 I2=1 I3=0 X=0 B=6 S=2/5 size=39x15",
  "ram_write_read opaque": "ram_write_read opaque I0=0 I1=0 I2=1 I3=0 X=0 B=6 S=2/5 size=39x15",
  "regression_led_out_drives_gate opaque": "regression_led_out_drives_gate opaque I0=5 I1=0 I2=0 I3=0 X=0 B=4 S=2/4 size=33x7",
  "rom_basic opaque": "rom_basic opaque I0=0 I1=0 I2=0 I3=0 X=0 B=0 S=2/2 size=40x3",
  "rom_lookup opaque": "rom_lookup opaque I0=0 I1=0 I2=0 I3=0 X=0 B=0 S=2/2 size=40x3",
  "single_gate opaque": "single_gate opaque I0=0 I1=0 I2=0 I3=0 X=0 B=0 S=2/2 size=27x3",
};

for (const [name, mode] of vendoredFixtureModes()) {
  test(`${name} (${mode}): this port's invariants are pinned`, async () => {
    const rt = await load(name);
    const row = formatRow(name, mode, buildLayout(rt.topology, { expandMacros: mode === "expanded" }));
    if (process.env.PRINT_TS_ROWS) console.log(`  "${name} ${mode}": "${row}",`);
    expect(row).toBe(TS_TODAY[`${name} ${mode}`] ?? "<unpinned>");
  });
}
