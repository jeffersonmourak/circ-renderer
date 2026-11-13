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
  expect(rom.inPorts).toEqual([{ portName: "addr", port: 4, coord: { x: rom.x - 1, y: rom.y + 1 } }]);
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

test("layoutOptions.rowGutter spaces stacked boxes, and the default is one row", async () => {
  const rt = await load("half_adder.wasm");
  const pinsOf = (rowGutter?: number) =>
    buildLayout(rt.topology, rowGutter === undefined ? {} : { rowGutter })
      .components.filter((c) => isPrimitive(c.kind) && c.kind.kind === ComponentKind.InputPin)
      .sort((p, q) => p.y - q.y);
  const dflt = pinsOf();
  expect(dflt.length).toBe(2);
  expect(dflt[1].y - dflt[0].y).toBe(dflt[0].height + 1);
  const wide = pinsOf(2);
  expect(wide[1].y - wide[0].y).toBe(wide[0].height + 2);
  expect(pinsOf(1)).toEqual(dflt);
});

test("a collapsed chip has one port per declared input and output", async () => {
  // full_adder: `half_adder ha1(a, b)` and `ha2(a, b)`, each with the
  // outputs `sum` and `carry`, and a built-in `or`.
  const rt = await load("project-full_adder.wasm");
  const layout = buildLayout(rt.topology);
  const chip = (name: string) => layout.components.find((c) => !isPrimitive(c.kind) && c.name === name)!;

  const ha1 = chip("ha1");
  expect(ha1.inPorts.map((p) => p.portName)).toEqual(["a", "b"]);
  expect(ha1.outPorts.map((p) => p.portName)).toEqual(["sum", "carry"]);
  expect(ha1.portLabels).toBe(true);
  // Two outputs, two pins, two port bytes.
  expect(ha1.outPorts[0].coord.y).not.toBe(ha1.outPorts[1].coord.y);
  expect(new Set(ha1.outPorts.map((p) => p.port)).size).toBe(2);

  // Every wire that leaves the chip starts on the port it names.
  const leaving = layout.wires.filter((w) => w.srcId === ha1.id);
  expect(new Set(leaving.map((w) => w.srcPort)).size).toBe(2);
  for (const w of leaving) {
    const port = ha1.outPorts.find((p) => p.port === w.srcPort)!;
    expect(w.segments[0].from).toEqual(port.coord);
  }

  // A chip shaped like a gate keeps a gate's box: one centred output, no names.
  const or = chip("cout_or");
  expect(or.portLabels).toBe(false);
  expect(or.outPorts).toEqual([{ portName: "out", port: 3, coord: or.outPort }]);
  expect(or.outPort.y).toBe(or.y + Math.floor(or.height / 2));
});
