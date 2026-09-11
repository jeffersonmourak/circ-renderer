// The fan-out marker hook. Before it, the canvas stamped its own dot at every
// junction and a theme had no say — the site's ring, with the pane showing
// through its centre, was impossible. The hook has to fire once per junction
// cell with the group's value, and the default dot has to stay out of the way
// when it is present, or a junction gets two marks.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CircRuntime } from "../src/wasm/runtime";
import { CircCanvas } from "../src/render/canvas";
import { baseTheme } from "../src/utils/theme";
import type { FanOutMarkerContext } from "../src/utils/theme";
import { installStubDocument } from "./canvas-stub";

const FIX = join(import.meta.dir, "fixtures");
let stub: ReturnType<typeof installStubDocument>;

/** Every `arc` the canvas asked its context for: centre and radius. */
let arcs: { x: number; y: number; r: number }[];

beforeEach(() => {
  stub = installStubDocument();
  arcs = [];
  // The stub's context is a Proxy of no-ops. Wrap the canvas element so its
  // context writes `arc` calls down, which is the one call the default dot
  // makes and the site's ring makes too.
  const create = stub.document.createElement.bind(stub.document);
  stub.document.createElement = (tag: string) => {
    const el = create(tag) as { getContext: (kind: string) => unknown };
    if (tag === "canvas") {
      const ctx = el.getContext("2d") as Record<string, unknown>;
      ctx.arc = (x: number, y: number, r: number) => { arcs.push({ x, y, r }); };
      el.getContext = () => ctx;
    }
    return el;
  };
});
afterEach(() => {
  stub.uninstall();
});

async function fanOut() {
  return CircRuntime.loadFromBytes(new Uint8Array(readFileSync(join(FIX, "fan_out.wasm"))));
}

/** The cells three or more segments of one source's wires touch — the rule
 *  `drawFanOutMarkers` applies, restated over the layout the canvas drew. */
function junctionCells(canvas: CircCanvas): string[] {
  const bySrc = new Map<number, { x: number; y: number }[][]>();
  for (const w of canvas.getLayout().wires) {
    const cells: { x: number; y: number }[] = [];
    for (const seg of w.segments) {
      const dx = Math.sign(seg.to.x - seg.from.x);
      const dy = Math.sign(seg.to.y - seg.from.y);
      const len = Math.max(Math.abs(seg.to.x - seg.from.x), Math.abs(seg.to.y - seg.from.y));
      for (let k = 0; k <= len; k++) cells.push({ x: seg.from.x + dx * k, y: seg.from.y + dy * k });
    }
    if (!bySrc.has(w.srcId)) bySrc.set(w.srcId, []);
    bySrc.get(w.srcId)!.push(cells);
  }
  const out: string[] = [];
  for (const group of bySrc.values()) {
    if (group.length < 2) continue;
    const counts = new Map<string, number>();
    for (const cells of group) for (const c of cells) {
      const k = `${c.x},${c.y}`;
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    for (const [k, n] of counts) if (n >= 3) out.push(k);
  }
  return out.sort();
}

test("the hook fires once per junction cell with the group's value", async () => {
  const rt = await fanOut();
  const seen: FanOutMarkerContext[] = [];
  const theme = { ...baseTheme, fanOutMarker: (c: FanOutMarkerContext) => { seen.push({ ...c }); } };
  const canvas = new CircCanvas(rt, { interactive: false, theme: theme as never, cell: 10 });

  const expected = junctionCells(canvas);
  expect(expected.length).toBeGreaterThan(0);
  expect(seen.map((c) => `${c.x},${c.y}`).sort()).toEqual(expected);
  for (const c of seen) {
    expect(c.cell).toBe(10);
    expect(c.value.width).toBe(1);
    expect([0, 1, 2]).toContain(c.signal);
  }
});

test("the default dot is drawn only without the hook", async () => {
  const rt = await fanOut();
  const cell = 10;
  // The default source marker is a circle of the same radius at an out port,
  // and a trunk that splits at its own port makes that cell a junction too;
  // so a dot is told apart by where it is: a junction cell that is no port.
  const dotsAt = (junctions: string[]) =>
    [...new Set(arcs
      .filter((a) => a.r === cell * 0.18)
      .map((a) => `${(a.x - cell / 2) / cell},${(a.y - cell / 2) / cell}`)
      .filter((k) => junctions.includes(k)))].sort();

  const plain = new CircCanvas(rt, { interactive: false, cell });
  const ports = new Set(plain.getLayout().components.map((c) => `${c.outPort.x},${c.outPort.y}`));
  const junctions = junctionCells(plain).filter((k) => !ports.has(k));
  expect(junctions.length).toBeGreaterThan(0);
  expect(dotsAt(junctions)).toEqual(junctions);

  arcs = [];
  const theme = { ...baseTheme, fanOutMarker: () => {} };
  new CircCanvas(rt, { interactive: false, theme: theme as never, cell });
  expect(dotsAt(junctions)).toEqual([]);
});
