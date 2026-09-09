import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CircRuntime } from "../src/wasm/runtime";
import { buildLayout } from "../src/layout";
import { ComponentKind } from "../src/wasm/topology";
import { isPrimitive } from "../src/layout/types";
import { memoryLabel, memorySize } from "../src/layout/sizing";

const FIX = join(import.meta.dir, "fixtures");
const load = (name: string) =>
  CircRuntime.loadFromBytes(new Uint8Array(readFileSync(join(FIX, name))));

test("lays out slice + concat nodes with ports", async () => {
  const rt = await load("slice_then_concat.wasm");
  const layout = buildLayout(rt.topology);

  const slices = layout.components.filter(
    (c) => isPrimitive(c.kind) && c.kind.kind === ComponentKind.Slice
  );
  expect(slices.length).toBe(2);
  for (const s of slices) {
    expect(s.slice).toBeDefined();
    expect(s.inPorts.length).toBe(1); // single "in"
  }

  const concat = layout.components.find(
    (c) => isPrimitive(c.kind) && c.kind.kind === ComponentKind.Concat
  )!;
  // One stacked operand port per operand index.
  expect(concat.inPorts.length).toBe(2);
  expect(concat.inPorts.map((p) => p.portName).sort()).toEqual(["op0", "op1"]);
  expect(concat.bitWidth).toBe(4);
});

test("bus components carry their bit width through layout", async () => {
  const rt = await load("and_4bit.wasm");
  const layout = buildLayout(rt.topology);
  // every placed component has a positive bit width
  for (const c of layout.components) expect(c.bitWidth).toBeGreaterThanOrEqual(1);
});

test("sizing: memorySize follows pin-width and macro-height rules", () => {
  expect(memorySize(13, 1)).toEqual({ width: 17, height: 3 });
  expect(memorySize(13, 4)).toEqual({ width: 17, height: 9 });
  expect(memorySize(0, 1).width).toBe(5);
  expect(memoryLabel(ComponentKind.Rom, "code", 8, 4)).toBe("rom code[8,4]");
});

test("lays out a rom box with one addr port", async () => {
  const rt = await load("rom_lookup.wasm");
  const layout = buildLayout(rt.topology);
  const rom = layout.components.find((c) => isPrimitive(c.kind) && c.kind.kind === ComponentKind.Rom)!;
  expect(rom.width).toBe(17);
  expect(rom.height).toBe(3);
  expect(rom.bitWidth).toBe(8);
  expect(rom.memory).toEqual({ addrWidth: 4 });
  expect(rom.inPorts).toEqual([{ portName: "addr", coord: { x: rom.x - 1, y: rom.y + 1 } }]);
  expect(rom.outPort.y).toBe(rom.y + 1);
});

test("lays out a ram box and routes all four inputs onto ports", async () => {
  const rt = await load("ram_write_read.wasm");
  const layout = buildLayout(rt.topology);
  const ram = layout.components.find((c) => isPrimitive(c.kind) && c.kind.kind === ComponentKind.Ram)!;
  expect(ram.height).toBe(9);
  expect(ram.inPorts.map((p) => p.portName)).toEqual(["addr", "din", "we", "clk"]);
  expect(ram.inPorts.map((p) => p.coord.y - ram.y)).toEqual([1, 3, 5, 7]);
  expect(ram.outPort.y).toBe(ram.y + 4);
  const wires = layout.wires.filter((w) => w.dstId === ram.id);
  expect(wires.length).toBe(4);
  for (const w of wires) {
    const last = w.segments[w.segments.length - 1].to;
    const slot = ram.inPorts.find((p) => p.coord.x === last.x && p.coord.y === last.y);
    expect(slot).toBeDefined();
  }
});
