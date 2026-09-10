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
 * Two lists, both temporary. `MATCHES_TODAY` names the fixture-modes this
 * port already lays out byte-identically to the compiler's old algorithm;
 * every other vendored fixture-mode is asserted to differ, so a convergence
 * (or a divergence) is loud on whichever side moved. Both lists disappear
 * when the rewrite lands on this side and every fixture-mode must match.
 */
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FIX, golden, layoutOf, vendoredFixtureModes, type Mode, type Projected } from "./layout-helpers";

const wireKey = (w: { srcId: number; srcPort: number; dstId: number; dstPort: number }) =>
  `${w.srcId}.${w.srcPort}->${w.dstId}.${w.dstPort}`;

/** Wires whose `segments` differ between the two grids, by key, in TS order. */
function differingWires(ts: Projected, zig: Projected): string[] {
  const zigByKey = new Map(zig.wires.map((w) => [wireKey(w), w]));
  return ts.wires
    .filter((w) => JSON.stringify(w.segments) !== JSON.stringify(zigByKey.get(wireKey(w))?.segments))
    .map(wireKey);
}

/**
 * Fixture-modes this port lays out identically to the compiler today, with
 * the old algorithm on both sides. Measured, not chosen: a fixture-mode
 * moves in when a run shows it equal, and out when it does not.
 */
export const MATCHES_TODAY: ReadonlySet<string> = new Set<string>([
  "chain opaque",
  "fan_out opaque",
  "multi_led opaque",
  "single_gate opaque",
]);

const key = (name: string, mode: Mode) => `${name} ${mode}`;

test("every vendored layout golden has its .wasm beside it", () => {
  const modes = vendoredFixtureModes();
  expect(modes.length).toBeGreaterThan(0);
  for (const [name] of modes) {
    expect(() => readFileSync(join(FIX, `${name}.wasm`))).not.toThrow();
  }
  for (const k of MATCHES_TODAY) {
    expect(modes.map(([n, m]) => key(n, m))).toContain(k);
  }
});

for (const [name, mode] of vendoredFixtureModes()) {
  if (MATCHES_TODAY.has(key(name, mode))) {
    test(`${name} (${mode}) lays out identically to the compiler`, async () => {
      expect(await layoutOf(name, mode)).toEqual(golden(name, mode));
    });
  } else {
    test(`${name} (${mode}) still differs from the compiler's old layout`, async () => {
      const ts = await layoutOf(name, mode);
      const zig = golden(name, mode);
      // The wire set is the topology's and must agree whatever the router does.
      expect(ts.wires.map(wireKey).sort()).toEqual(zig.wires.map(wireKey).sort());
      // When this fails the two sides converged: move the fixture-mode into
      // MATCHES_TODAY (or, after the rewrite, delete both lists).
      const same = JSON.stringify(ts) === JSON.stringify(zig);
      if (same) throw new Error(`${name} (${mode}) now matches the compiler — promote it to MATCHES_TODAY`);
      expect(differingWires(ts, zig).length + (JSON.stringify(ts.components) === JSON.stringify(zig.components) ? 0 : 1)).toBeGreaterThan(0);
    });
  }
}
