import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ComponentKind,
  decodeFullTopology,
  extractCustomSection,
} from "../src/wasm/topology";

const FIX = join(import.meta.dir, "fixtures");
const cirf = (name: string) => {
  const bytes = new Uint8Array(readFileSync(join(FIX, name)));
  const section = extractCustomSection(bytes, "circ.topology.v0.full");
  if (!section) throw new Error(`no CIRF section in ${name}`);
  return decodeFullTopology(section);
};

test("decodes a v02 payload with width + slice aux", () => {
  // slice_then_concat: input[4] a; output[4] o(in={a[0..2], a[2..4]})
  const topo = cirf("slice_then_concat.wasm");
  expect(topo.components.length).toBe(5);

  const byName = (n: string) => topo.components.find((c) => c.name === n)!;
  expect(byName("a").kind).toBe(ComponentKind.InputPin);
  expect(byName("a").width).toBe(4);
  expect(byName("o").kind).toBe(ComponentKind.OutputPin);
  expect(byName("o").width).toBe(4);

  const slices = topo.components.filter((c) => c.kind === ComponentKind.Slice);
  expect(slices.length).toBe(2);
  expect(slices.map((s) => s.slice).sort((a, b) => a!.lo - b!.lo)).toEqual([
    { lo: 0, hi: 2 },
    { lo: 2, hi: 4 },
  ]);
  for (const s of slices) expect(s.width).toBe(2);

  const concat = topo.components.find((c) => c.kind === ComponentKind.Concat)!;
  expect(concat.width).toBe(4);
  // Concat operands ride the connection table with port = operand index.
  const operandPorts = topo.connections
    .filter((c) => c.toId === concat.id)
    .map((c) => c.port)
    .sort();
  expect(operandPorts).toEqual([0, 1]);
});

test("decodes a frozen v01 payload (no width, no aux)", () => {
  const topo = cirf("and_v01.wasm");
  expect(topo.components.length).toBeGreaterThan(0);
  // v01 carries no width byte; every component defaults to width 1.
  for (const c of topo.components) expect(c.width).toBe(1);
  // v01 predates slice/concat.
  expect(topo.components.some((c) => c.kind === ComponentKind.Slice)).toBe(false);
});

test("rejects an unknown CIRF version", () => {
  // Forge a header with version 0x09.
  const bytes = new Uint8Array([0x43, 0x49, 0x52, 0x46, 0x09, 0, 0, 0, 0, 0, 0, 0, 0]);
  expect(() => decodeFullTopology(bytes)).toThrow(/unsupported CIRF version/);
});
