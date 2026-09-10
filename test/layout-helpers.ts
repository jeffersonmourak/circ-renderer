/**
 * Shared helpers for the layout-parity and layout-invariants tests: the
 * vendored fixture-mode list, the `.wasm` loader, the JSON golden reader and
 * the projection onto the cross-language contract. Kept out of the test
 * files so neither imports the other's `test()` registrations.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CircRuntime } from "../src/wasm/runtime";
import { buildLayout } from "../src/layout";
import type { LayoutGrid } from "../src/layout";

export type Mode = "opaque" | "expanded";

export const FIX = join(import.meta.dir, "fixtures");
export const LAYOUTS = join(FIX, "layouts");

/** Every vendored fixture-mode, sorted, from the JSON files present. */
export function vendoredFixtureModes(): Array<[string, Mode]> {
  return readdirSync(LAYOUTS)
    .filter((f) => f.endsWith(".layout.json"))
    .sort()
    .map((f) => {
      const m = /^(.+)\.(opaque|expanded)\.layout\.json$/.exec(f);
      if (!m) throw new Error(`unexpected layout golden name: ${f}`);
      return [m[1], m[2] as Mode];
    });
}

export const load = (name: string) =>
  CircRuntime.loadFromBytes(new Uint8Array(readFileSync(join(FIX, `${name}.wasm`))));

export const golden = (name: string, mode: Mode) =>
  JSON.parse(readFileSync(join(LAYOUTS, `${name}.${mode}.layout.json`), "utf8"));

/** Project a `LayoutGrid` onto the contract's field set, in the contract's key order. */
export function projectLayout(grid: LayoutGrid) {
  return {
    width: grid.width,
    height: grid.height,
    components: grid.components.map((c) => ({
      id: c.id,
      kind: c.kind,
      name: c.name,
      x: c.x,
      y: c.y,
      width: c.width,
      height: c.height,
      inPorts: c.inPorts.map((p) => ({
        portName: p.portName,
        coord: { x: p.coord.x, y: p.coord.y },
      })),
      outPort: { x: c.outPort.x, y: c.outPort.y },
      bitWidth: c.bitWidth,
    })),
    wires: grid.wires.map((w) => ({
      srcId: w.srcId,
      srcPort: w.srcPort,
      dstId: w.dstId,
      dstPort: w.dstPort,
      segments: w.segments.map((s) => ({
        from: { x: s.from.x, y: s.from.y },
        to: { x: s.to.x, y: s.to.y },
      })),
    })),
  };
}

export type Projected = ReturnType<typeof projectLayout>;

export async function layoutOf(name: string, mode: Mode): Promise<Projected> {
  const rt = await load(name);
  return projectLayout(buildLayout(rt.topology, { expandMacros: mode === "expanded" }));
}
