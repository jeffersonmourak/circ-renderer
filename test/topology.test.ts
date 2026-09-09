import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ComponentKind,
  PortName,
  SUPPORTED_TOPOLOGY_VERSIONS,
  decodeFullTopology,
  extractCustomSection,
  portByteOfName,
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

test("SUPPORTED_TOPOLOGY_VERSIONS lists v01..v03", () => {
  expect([...SUPPORTED_TOPOLOGY_VERSIONS]).toEqual([1, 2, 3]);
  const bytes = new Uint8Array(readFileSync(join(FIX, "inverter.wasm")));
  const section = extractCustomSection(bytes, "circ.topology.v0.full")!;
  expect(SUPPORTED_TOPOLOGY_VERSIONS).toContain(section[4]);
  const forged = new Uint8Array(section);
  forged[4] = 0x04;
  expect(() => decodeFullTopology(forged)).toThrow(/unsupported CIRF version 0x4/);
});

test("decodes a v03 payload with rom memory aux", () => {
  // rom_lookup: input[4] pc; rom code[8, 4](addr = pc.out); output[8] out(in = code.out)
  const topo = cirf("rom_lookup.wasm");
  expect(topo.components.length).toBe(3);
  const byName = (n: string) => topo.components.find((c) => c.name === n)!;
  expect(byName("code").kind).toBe(ComponentKind.Rom);
  expect(byName("code").width).toBe(8);
  expect(byName("code").memory).toEqual({ addrWidth: 4 });
  expect(byName("out").kind).toBe(ComponentKind.OutputPin);
  expect(byName("out").width).toBe(8);
  const into = topo.connections.filter((c) => c.toId === byName("code").id);
  expect(into.length).toBe(1);
  expect(into[0].port).toBe(PortName.Addr);
});

test("decodes ram ports on the connection table", () => {
  const topo = cirf("ram_write_read.wasm");
  const data = topo.components.find((c) => c.name === "data")!;
  expect(data.kind).toBe(ComponentKind.Ram);
  expect(data.memory).toEqual({ addrWidth: 4 });
  const ports = topo.connections.filter((c) => c.toId === data.id).map((c) => c.port).sort();
  expect(ports).toEqual([PortName.Addr, PortName.Din, PortName.We, PortName.Clk]);
});

test("portByteOfName maps every port label", () => {
  expect(["in", "a", "b", "out"].map(portByteOfName)).toEqual([0, 1, 2, 3]);
  expect(["addr", "din", "we", "clk"].map(portByteOfName)).toEqual([4, 5, 6, 7]);
  expect(portByteOfName("op2")).toBe(2);
  expect(portByteOfName("nope")).toBe(0xff);
});
