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

test("v03 artifact: memory exports load an image and the lookup reads back", async () => {
  const rt = await load("rom_lookup.wasm");
  const code = idOf(rt, "code");
  const pc = idOf(rt, "pc");
  const out = idOf(rt, "out");
  const raw = rt.raw;
  // (kind << 16) | (W << 8) | A with the topology kind byte (rom = 8).
  expect(raw.getMemInfo!(code)).toBe((8 << 16) | (8 << 8) | 4);
  const ptr = raw.memBuffer!(code);
  expect(ptr).toBeGreaterThan(0);
  // Re-view memory.buffer after the call: the allocation may have grown it.
  const image = new Uint8Array(16);
  for (let i = 0; i < 16; i++) image[i] = i * 0x11;
  new Uint8Array(raw.memory.buffer).set(image, ptr);
  expect(raw.memLoad!(code, 16)).toBe(0);
  rt.setValueAndRun(pc, 3n, 0xfn);
  expect(rt.readValue(out)).toEqual({ value: 0x33n, defined: 0xffn, width: 8 });
});

// ---------------------------------------------------------------------------
// The typed memory API.
//
// A rom or ram carries its shape in the artifact and none of its contents,
// so everything here is read back from a running circuit through the same
// eight exports a host used to reach through `raw`. These pin the wrappers
// against the real fixtures, and the one case that has no fixture: an
// artifact built before memories existed.
// ---------------------------------------------------------------------------

import { MEM_ABSENT } from "../src/wasm/runtime";

test("memories() names every declared memory with the shape the runtime reports", async () => {
  const rom = await load("rom_lookup.wasm");
  expect(rom.hasMemory).toBe(true);
  expect(rom.memories()).toEqual([
    { id: idOf(rom, "code"), name: "code", info: { kind: "rom", width: 8, addrWidth: 4 } },
  ]);

  const ram = await load("ram_write_read.wasm");
  expect(ram.memories()).toEqual([
    { id: idOf(ram, "data"), name: "data", info: { kind: "ram", width: 8, addrWidth: 4 } },
  ]);
});

test("an artifact from before memories existed has no family, and says so without throwing", async () => {
  // The v1 fixture predates the memory exports entirely.
  const rt = await load("and_v01.wasm");
  expect(rt.hasMemory).toBe(false);
  expect(rt.memories()).toEqual([]);
  const anyId = rt.topology.components[0].id;
  expect(rt.memInfo(anyId)).toBeNull();
  expect(rt.readMemWord(anyId, 0)).toEqual({ value: 0n, defined: 0n, width: 1 });
  expect(rt.writeMemWord(anyId, 0, 1n, 1n)).toBe(MEM_ABSENT);
  expect(rt.loadMemImage(anyId, new Uint8Array([1]))).toBe(MEM_ABSENT);
  expect(rt.storeMemImage(anyId)).toBeNull();
  expect(rt.clearMem(anyId)).toBe(MEM_ABSENT);
});

test("a circuit with no memory still carries the family, and refuses a non-memory id in its own words", async () => {
  // Every artifact from the current compiler embeds the same runtime, so the
  // exports are there whether or not the source declared a rom or ram. That
  // is why `hasMemory` says "this compiler", `memories()` says "this
  // circuit", and MEM_ABSENT is reserved for the first being false.
  const rt = await load("half_adder.wasm");
  expect(rt.hasMemory).toBe(true);
  expect(rt.memories()).toEqual([]);
  const a = idOf(rt, "a");
  expect(rt.memInfo(a)).toBeNull();
  expect(rt.readMemWord(a, 0)).toEqual({ value: 0n, defined: 0n, width: 1 });
  for (const rc of [rt.writeMemWord(a, 0, 1n, 1n), rt.loadMemImage(a, new Uint8Array([1])), rt.clearMem(a)]) {
    expect(rc).toBeLessThan(0);
    expect(rc).not.toBe(MEM_ABSENT);
  }
  expect(rt.storeMemImage(a)).toBeNull();
});

test("memInfo is null for a component that is not a memory", async () => {
  const rt = await load("rom_lookup.wasm");
  expect(rt.memInfo(idOf(rt, "pc"))).toBeNull();
  expect(rt.memInfo(idOf(rt, "out"))).toBeNull();
  expect(rt.memInfo(999_999)).toBeNull();
});

test("an unloaded memory reads as unknown, not as zeros", async () => {
  const rt = await load("rom_lookup.wasm");
  const code = idOf(rt, "code");
  for (let addr = 0; addr < 16; addr += 1) {
    expect(rt.readMemWord(code, addr)).toEqual({ value: 0n, defined: 0n, width: 8 });
  }
});

test("loadMemImage puts an image in and the circuit reads it back", async () => {
  const rt = await load("rom_lookup.wasm");
  const code = idOf(rt, "code");
  const image = new Uint8Array(16);
  for (let i = 0; i < 16; i++) image[i] = i * 0x11;

  expect(rt.loadMemImage(code, image)).toBe(0);
  // Word by word through the getters…
  expect(rt.readMemWord(code, 3)).toEqual({ value: 0x33n, defined: 0xffn, width: 8 });
  expect(rt.readMemWord(code, 15)).toEqual({ value: 0xffn, defined: 0xffn, width: 8 });
  // …and through the circuit, which is what proves memLoad reached the runtime.
  rt.setValueAndRun(idOf(rt, "pc"), 3n, 0xfn);
  expect(rt.readValue(idOf(rt, "out"))).toEqual({ value: 0x33n, defined: 0xffn, width: 8 });
});

test("a short image is a prefix: the rest stays unknown", async () => {
  const rt = await load("rom_lookup.wasm");
  const code = idOf(rt, "code");
  expect(rt.loadMemImage(code, new Uint8Array([0xde, 0xad]))).toBe(0);
  expect(rt.readMemWord(code, 1).value).toBe(0xadn);
  expect(rt.readMemWord(code, 2).defined).toBe(0n);
});

test("an image the runtime refuses comes back as its own code, and writes nothing", async () => {
  const rt = await load("rom_lookup.wasm");
  const code = idOf(rt, "code");
  // Seventeen words into a sixteen-word memory.
  const rc = rt.loadMemImage(code, new Uint8Array(17));
  expect(rc).toBeLessThan(0);
  expect(rc).not.toBe(MEM_ABSENT);
  expect(rt.readMemWord(code, 0).defined).toBe(0n);
});

test("writeMemWord drives one cell, masked to the width, and ? takes it back", async () => {
  const rt = await load("ram_write_read.wasm");
  const data = idOf(rt, "data");
  expect(rt.writeMemWord(data, 5, 0x1a5n, 0x1ffn)).toBe(0);
  expect(rt.readMemWord(data, 5)).toEqual({ value: 0xa5n, defined: 0xffn, width: 8 });
  // The neighbours are untouched.
  expect(rt.readMemWord(data, 4).defined).toBe(0n);
  expect(rt.readMemWord(data, 6).defined).toBe(0n);
  expect(rt.writeMemWord(data, 5, 0n, 0n)).toBe(0);
  expect(rt.readMemWord(data, 5).defined).toBe(0n);
});

test("a ram loads an image exactly as a rom does", async () => {
  // The truth table declines to preload a ram; the runtime never did.
  const rt = await load("ram_write_read.wasm");
  const data = idOf(rt, "data");
  const image = new Uint8Array(16);
  for (let i = 0; i < 16; i++) image[i] = 0xa0 + i;
  expect(rt.loadMemImage(data, image)).toBe(0);
  expect(rt.readMemWord(data, 5).value).toBe(0xa5n);
});

test("storeMemImage hands back what was loaded, with unknown words as zero", async () => {
  const rt = await load("rom_lookup.wasm");
  const code = idOf(rt, "code");
  rt.loadMemImage(code, new Uint8Array([0xde, 0xad, 0xbe, 0xef]));
  const out = rt.storeMemImage(code)!;
  expect(out).not.toBeNull();
  // The whole memory, sixteen words of one byte, the rest unknown-as-zero.
  expect(out.length).toBe(16);
  expect(Array.from(out.subarray(0, 4))).toEqual([0xde, 0xad, 0xbe, 0xef]);
  expect(Array.from(out.subarray(4))).toEqual(new Array(12).fill(0));
  // A copy, not a view: it must survive the runtime growing its memory.
  expect(out.buffer).not.toBe(rt.raw.memory.buffer);
});

test("clearMem makes every word unknown again, and an empty image is the same instruction", async () => {
  const rt = await load("rom_lookup.wasm");
  const code = idOf(rt, "code");
  rt.loadMemImage(code, new Uint8Array(16).fill(0xff));
  expect(rt.readMemWord(code, 9).value).toBe(0xffn);
  expect(rt.clearMem(code)).toBe(0);
  expect(rt.readMemWord(code, 9).defined).toBe(0n);

  rt.loadMemImage(code, new Uint8Array(16).fill(0x55));
  expect(rt.loadMemImage(code, new Uint8Array(0))).toBe(0);
  expect(rt.readMemWord(code, 9).defined).toBe(0n);
});

test("a load re-presents the memory's output without a run()", async () => {
  // The runtime's own contract, relied on by the canvas's refresh: after a
  // mutator the addressed word is already on `out`.
  const rt = await load("rom_lookup.wasm");
  const code = idOf(rt, "code");
  const pc = idOf(rt, "pc");
  rt.setValueAndRun(pc, 2n, 0xfn);
  const image = new Uint8Array(16);
  image[2] = 0x42;
  rt.loadMemImage(code, image);
  expect(rt.readValue(idOf(rt, "out")).value).toBe(0x42n);
});

test("loadMemImage takes its byte view AFTER memBuffer, which may grow memory", () => {
  // No shipped fixture provokes this: their staging buffers fit in the pages
  // already allocated, so a view taken too early stays valid by luck. A fake
  // instance whose memBuffer swaps the buffer — what a real grow does — is
  // the only way to make the bug fail rather than pass.
  let buffer = new ArrayBuffer(64);
  const loads: number[] = [];
  const exports = {
    get memory() { return { buffer }; },
    topology_alloc: () => 0,
    init: () => {},
    run: () => {},
    setPin: () => {},
    getOutputValue: () => 0n,
    getOutputDefined: () => 0n,
    getMemInfo: (id: number) => (id === 7 ? (8 << 16) | (8 << 8) | 4 : -1),
    memBuffer: () => {
      buffer = new ArrayBuffer(64); // "grown": every earlier view is stale
      return 16;
    },
    memLoad: (_id: number, len: number) => { loads.push(len); return 0; },
    memStore: () => 0,
    memClear: () => 0,
    setMemWord: () => 0,
    getMemValue: () => 0n,
    getMemDefined: () => 0n,
  };
  const topology = {
    components: [{ id: 7, kind: 8, name: "code", width: 8, origin: [] }],
  } as unknown as import("../src/wasm/topology").FullTopology;
  const rt = new CircRuntime({ exports } as unknown as WebAssembly.Instance, new Uint8Array(), topology);

  expect(rt.loadMemImage(7, new Uint8Array([1, 2, 3, 4]))).toBe(0);
  expect(loads).toEqual([4]);
  // The bytes are in the buffer memBuffer handed back, not in the one that
  // existed before the call.
  expect(Array.from(new Uint8Array(buffer, 16, 4))).toEqual([1, 2, 3, 4]);
});
