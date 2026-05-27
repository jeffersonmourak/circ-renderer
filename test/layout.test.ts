import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CircRuntime } from "../src/wasm/runtime";
import { buildLayout } from "../src/layout";
import { ComponentKind } from "../src/wasm/topology";
import { isPrimitive } from "../src/layout/types";

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
