import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CircRuntime } from "../src/wasm/runtime";

const FIX = join(import.meta.dir, "fixtures");
const load = (name: string) =>
  CircRuntime.loadFromBytes(new Uint8Array(readFileSync(join(FIX, name))));
const idOf = (rt: CircRuntime, name: string) =>
  rt.topology.components.find((c) => c.name === name)!.id;

test("v02 ABI: multi-bit value flows through slice + concat", async () => {
  // output o = {a[0..2], a[2..4]} reconstructs a, so o == a for all inputs.
  const rt = await load("slice_then_concat.wasm");
  const a = idOf(rt, "a");
  const o = idOf(rt, "o");
  for (const v of [0n, 6n, 9n, 11n, 15n]) {
    rt.setValueAndRun(a, v, 0xfn);
    const out = rt.readValue(o);
    expect(out.width).toBe(4);
    expect(out.defined).toBe(0xfn);
    expect(out.value).toBe(v);
  }
});

test("v02 ABI: undefined bits stay undefined", async () => {
  const rt = await load("slice_then_concat.wasm");
  const a = idOf(rt, "a");
  const o = idOf(rt, "o");
  rt.setValueAndRun(a, 0n, 0n); // drive fully-undefined
  expect(rt.readValue(o).defined).toBe(0n);
});

test("v01 ABI: scalar fixture still drives and reads", async () => {
  const rt = await load("and_v01.wasm");
  const ins = rt.topology.components.filter((c) => c.kind === 0 /* InputPin */);
  expect(ins.length).toBeGreaterThanOrEqual(2);
  const out = rt.topology.components.find((c) => c.kind === 5 /* OutputPin */)!;

  for (const p of ins) rt.setPinSignal(p.id, 1);
  rt.run();
  expect(rt.readValue(out.id).value).toBe(1n); // AND of all-high = 1

  rt.setPinAndRun(ins[0].id, 0);
  expect(rt.readValue(out.id).value).toBe(0n); // one low → 0
});
