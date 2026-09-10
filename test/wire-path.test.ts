// One tracer for a wire's route, shared by the canvas and any theme.
//
// The cases are the ones a theme used to get wrong by copying the loop: a
// crossing arcs only when it lies on the horizontal segment that crosses it,
// a vertical segment is a plain line whatever crossings say, and a segment
// traced right-to-left still lays its jumps out left-to-right.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildLayout } from "../src/layout";
import type { RoutedWire } from "../src/layout";
import { defaultArcRadius, traceWire } from "../src/render/wire-path";
import { CircRuntime } from "../src/wasm/runtime";

const FIX = join(import.meta.dir, "fixtures");

type Op = ["moveTo" | "lineTo", number, number] | ["arc", number, number, number, number, number, boolean];

/** A `CanvasPath` that writes down what it was asked to do. */
function recorder(): { path: CanvasPath; ops: Op[] } {
  const ops: Op[] = [];
  const path = {
    moveTo: (x: number, y: number) => ops.push(["moveTo", x, y]),
    lineTo: (x: number, y: number) => ops.push(["lineTo", x, y]),
    arc: (x: number, y: number, r: number, a: number, b: number, ccw?: boolean) =>
      ops.push(["arc", x, y, r, a, b, ccw ?? false]),
  } as unknown as CanvasPath;
  return { path, ops };
}

const wire = (segments: RoutedWire["segments"], crossings: RoutedWire["crossings"] = []): RoutedWire => ({
  srcId: 0, srcPort: 3, dstId: 1, dstPort: 0, realSrcId: 0, segments, crossings,
});
const seg = (x0: number, y0: number, x1: number, y1: number) => ({ from: { x: x0, y: y0 }, to: { x: x1, y: y1 } });

describe("traceWire", () => {
  const cell = 10;
  const c = (n: number) => n * cell + cell / 2;

  test("a horizontal segment with no crossing is one line, cell-centred", () => {
    const { path, ops } = recorder();
    traceWire(path, wire([seg(0, 2, 4, 2)]), cell);
    expect(ops).toEqual([["moveTo", c(0), c(2)], ["lineTo", c(4), c(2)]]);
  });

  test("a crossing on the segment becomes an arc above the line, and the line resumes after it", () => {
    const { path, ops } = recorder();
    const r = defaultArcRadius(cell);
    traceWire(path, wire([seg(0, 2, 4, 2)], [{ x: 2, y: 2 }]), cell);
    expect(ops).toEqual([
      ["moveTo", c(0), c(2)],
      ["lineTo", c(2) - r, c(2)],
      ["arc", c(2), c(2), r, Math.PI, 0, false],
      ["moveTo", c(2) + r, c(2)],
      ["lineTo", c(4), c(2)],
    ]);
  });

  test("a crossing on another row, or past the segment's ends, is not this segment's jump", () => {
    const { path, ops } = recorder();
    traceWire(path, wire([seg(0, 2, 4, 2)], [{ x: 2, y: 3 }, { x: 6, y: 2 }]), cell);
    expect(ops.filter((op) => op[0] === "arc")).toEqual([]);
  });

  test("a vertical segment never arcs, even over a crossing on it", () => {
    const { path, ops } = recorder();
    traceWire(path, wire([seg(3, 0, 3, 4)], [{ x: 3, y: 2 }]), cell);
    expect(ops).toEqual([["moveTo", c(3), c(0)], ["lineTo", c(3), c(4)]]);
  });

  test("a segment routed right-to-left lays its jumps out left-to-right", () => {
    const { path, ops } = recorder();
    traceWire(path, wire([seg(5, 1, 0, 1)], [{ x: 3, y: 1 }, { x: 1, y: 1 }]), cell);
    const arcs = ops.filter((op) => op[0] === "arc").map((op) => op[1]);
    expect(arcs).toEqual([c(1), c(3)]);
    expect(ops[0]).toEqual(["moveTo", c(0), c(1)]);
    expect(ops[ops.length - 1]).toEqual(["lineTo", c(5), c(1)]);
  });

  test("the arc radius is the caller's when given, and 0.4 cells when not", () => {
    const given = recorder();
    traceWire(given.path, wire([seg(0, 0, 4, 0)], [{ x: 2, y: 0 }]), cell, 1);
    expect(given.ops.find((op) => op[0] === "arc")?.[3]).toBe(1);
    expect(defaultArcRadius(cell)).toBe(4);
  });

  test("every wire of a real layout traces, and its crossings are where the arcs are", async () => {
    // The router is the only thing that writes `crossings`; this checks the
    // tracer reads them the way the router meant, on a circuit dense enough
    // to have some.
    const rt = await CircRuntime.loadFromBytes(new Uint8Array(readFileSync(join(FIX, "rom_lookup.wasm"))));
    const layout = buildLayout(rt.topology);
    for (const w of layout.wires) {
      const { path, ops } = recorder();
      traceWire(path, w, cell);
      expect(ops.length).toBeGreaterThanOrEqual(2 * w.segments.length);
      const onHorizontal = w.crossings.filter((x) =>
        w.segments.some((s) => s.from.y === s.to.y && s.from.y === x.y &&
          x.x >= Math.min(s.from.x, s.to.x) && x.x <= Math.max(s.from.x, s.to.x)));
      expect(ops.filter((op) => op[0] === "arc")).toHaveLength(onHorizontal.length);
    }
    expect(layout.wires.length).toBeGreaterThan(0);
  });
});
