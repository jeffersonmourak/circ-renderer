/**
 * Cross-language layout parity.
 *
 * `test/fixtures/layouts/<name>.<opaque|expanded>.layout.json` are the
 * `LayoutGrid` dumps circ-compiler pins under
 * `tests/fixtures/preview/layouts-json/` (its `tests/preview/
 * layout_conformance_test.zig`, emitted by `lib/preview/dump_json.zig`),
 * copied verbatim; the matching `.wasm` was compiled from the same `.circ`
 * by the same compiler commit — see `test/fixtures/layouts/MANIFEST.md`.
 *
 * The contract is the common subset of both `LayoutGrid`s: `width`, `height`,
 * `components[]` (id, kind, name, x, y, width, height, inPorts, outPort,
 * bitWidth) and `wires[]` (srcId, srcPort, dstId, dstPort, segments). Fields
 * only one side has (`origin`, `slice`, `memory`, `realSrcId`) and derived
 * data (`crossings`) are projected away.
 *
 * Every vendored fixture-mode must match byte for byte: the two layouts are
 * the same algorithm in two languages.
 */
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIX, golden, layoutOf, vendoredFixtureModes, type Projected } from "./layout-helpers";

const wireKey = (w: { srcId: number; srcPort: number; dstId: number; dstPort: number }) =>
  `${w.srcId}.${w.srcPort}->${w.dstId}.${w.dstPort}`;

/** Wires whose `segments` differ between the two grids, by key, in TS order. */
function differingWires(ts: Projected, zig: Projected): string[] {
  const zigByKey = new Map(zig.wires.map((w) => [wireKey(w), w]));
  return ts.wires
    .filter((w) => JSON.stringify(w.segments) !== JSON.stringify(zigByKey.get(wireKey(w))?.segments))
    .map(wireKey);
}

test("every vendored layout golden has its .wasm beside it", () => {
  const modes = vendoredFixtureModes();
  expect(modes.length).toBeGreaterThan(0);
  for (const [name] of modes) {
    expect(() => readFileSync(join(FIX, `${name}.wasm`))).not.toThrow();
  }
});

for (const [name, mode] of vendoredFixtureModes()) {
  test(`${name} (${mode}) lays out identically to the compiler`, async () => {
    const ts = await layoutOf(name, mode);
    const zig = golden(name, mode);
    // Name the first divergence before the full diff, which is long.
    expect(differingWires(ts, zig)).toEqual([]);
    expect(ts).toEqual(zig);
  });
}
