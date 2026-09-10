// The three host hooks, driven headlessly. `setHighlight` has to reach the flag
// a skin reads, or a host highlight draws nothing; `getLayout` has to hand back
// the grid the canvas actually drew, synthetic subcircuit ids included, because
// that is the only place a collapsed macro box exists; and `onHover` has to
// fire on a change and only on a change, or a host debounces it forever.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CircRuntime } from "../src/wasm/runtime";
import { CircCanvas } from "../src/render/canvas";
import { baseTheme } from "../src/utils/theme";
import type { SkinContext } from "../src/utils/theme";
import { installStubDocument } from "./canvas-stub";

const FIX = join(import.meta.dir, "fixtures");
let stub: ReturnType<typeof installStubDocument>;

beforeEach(() => {
  stub = installStubDocument();
});
afterEach(() => {
  stub.uninstall();
});

async function halfAdder() {
  return CircRuntime.loadFromBytes(new Uint8Array(readFileSync(join(FIX, "half_adder.wasm"))));
}

/** A theme whose every skin records the context it was handed. */
function recordingTheme() {
  const seen: SkinContext[] = [];
  const record = (ctx: SkinContext) => {
    seen.push({ ...ctx });
  };
  const skins: Record<string | number, unknown> = { subcircuit: record };
  for (const kind of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) skins[kind] = record;
  return { theme: { ...baseTheme, skins }, seen };
}

const hoveredIds = (seen: SkinContext[]) =>
  seen.filter((c) => c.hovered).map((c) => c.component.id);

test("getLayout returns the grid the canvas drew", async () => {
  const rt = await halfAdder();
  const canvas = new CircCanvas(rt, { interactive: false });
  const layout = canvas.getLayout();

  expect(layout.components).toHaveLength(6);
  expect(layout.components.map((c) => c.name).sort()).toEqual(
    ["a", "b", "c", "carry", "s", "sum"].sort(),
  );
  // The collapsed macro box carries a synthetic id that exists nowhere in the
  // topology — which is the whole reason a host needs this accessor.
  const macro = layout.components.find((c) => c.kind.tag === "subcircuit")!;
  expect(macro.name).toBe("s");
  expect(rt.topology.components.some((c) => c.id === macro.id)).toBe(false);
  expect(macro.id).toBeGreaterThan(Math.max(...rt.topology.components.map((c) => c.id)));
});

test("setHighlight reaches the flag a skin reads", async () => {
  const rt = await halfAdder();
  const { theme, seen } = recordingTheme();
  const canvas = new CircCanvas(rt, { interactive: false, theme: theme as never });
  const andId = canvas.getLayout().components.find((c) => c.name === "c")!.id;

  seen.length = 0;
  canvas.setHighlight(andId);
  expect(hoveredIds(seen)).toEqual([andId]);

  // Clearing redraws with nothing hovered.
  seen.length = 0;
  canvas.setHighlight(null);
  expect(hoveredIds(seen)).toEqual([]);
});

test("setHighlight works for a collapsed subcircuit box", async () => {
  const rt = await halfAdder();
  const { theme, seen } = recordingTheme();
  const canvas = new CircCanvas(rt, { interactive: false, theme: theme as never });
  const macroId = canvas.getLayout().components.find((c) => c.kind.tag === "subcircuit")!.id;

  seen.length = 0;
  canvas.setHighlight(macroId);
  // A synthetic id has no runtime component, so this is the case a
  // topology-only lookup gets wrong.
  expect(hoveredIds(seen)).toEqual([macroId]);
});

test("setHighlight is idempotent and an unknown id is a no-op", async () => {
  const rt = await halfAdder();
  const { theme, seen } = recordingTheme();
  const canvas = new CircCanvas(rt, { interactive: false, theme: theme as never });
  const andId = canvas.getLayout().components.find((c) => c.name === "c")!.id;

  canvas.setHighlight(andId);
  seen.length = 0;
  canvas.setHighlight(andId); // same id: no redraw
  expect(seen).toHaveLength(0);

  // An id with no box draws, but nothing is flagged.
  seen.length = 0;
  canvas.setHighlight(9999);
  expect(seen.length).toBeGreaterThan(0);
  expect(hoveredIds(seen)).toEqual([]);
});

test("a host highlight and a pointer hover do not clobber each other", async () => {
  const rt = await halfAdder();
  const { theme, seen } = recordingTheme();
  const canvas = new CircCanvas(rt, { theme: theme as never });
  const layout = canvas.getLayout();
  const andId = layout.components.find((c) => c.name === "c")!.id;

  canvas.setHighlight(andId);
  // A pointer leave clears the canvas's own hover; the host's must survive.
  stub.created[0].dispatchEvent("pointerleave", {});
  seen.length = 0;
  canvas.setHighlight(null);
  canvas.setHighlight(andId);
  expect(hoveredIds(seen)).toEqual([andId]);
});

test("onHover fires only on a change", async () => {
  const rt = await halfAdder();
  const calls: (number | null)[] = [];
  const canvas = new CircCanvas(rt, { onHover: (id) => calls.push(id) });
  const el = stub.created[0];

  // The pointer starts off any box; the canvas's hoverId is already null, so a
  // leave changes nothing and must not call back.
  el.dispatchEvent("pointerleave", {});
  expect(calls).toEqual([]);

  // Aim at the first box's centre. The stub's rect matches the intended
  // extent, so the rescale is the identity.
  // Cell units, converted the way the hit test converts them back.
  const box = canvas.getLayout().components[0];
  const cell = 12;
  const padding = 4;
  const x = padding + (box.x + box.width / 2) * cell;
  const y = padding + (box.y + box.height / 2) * cell;
  el.dispatchEvent("pointermove", { clientX: x, clientY: y });
  expect(calls).toEqual([box.id]);

  // The same position again is not a change.
  el.dispatchEvent("pointermove", { clientX: x, clientY: y });
  expect(calls).toEqual([box.id]);

  el.dispatchEvent("pointerleave", {});
  expect(calls).toEqual([box.id, null]);
});

test("destroy removes every listener it attached", async () => {
  const rt = await halfAdder();
  const canvas = new CircCanvas(rt, {});
  const el = stub.created[0];
  expect([...el.listeners.keys()].sort()).toEqual(["click", "pointerleave", "pointermove"]);
  canvas.destroy();
  for (const set of el.listeners.values()) expect(set.size).toBe(0);
  expect(el.removed).toBe(true);
});

// ---------------------------------------------------------------------------
// A bus pin takes a value.
//
// A click used to compute `inputState === 1 ? 0 : 1` and drive EVERY bit of a
// pin to it, so an 8-bit pin could only ever be 0x00 or 0xFF. These pin the
// new contract: a single bit still toggles on click, a bus opens a field, and
// what is typed is what is driven.
// ---------------------------------------------------------------------------

import { isPrimitive } from "../src/layout/types";
import { ComponentKind, widthMask } from "../src/wasm/topology";
import type { PinEditRequest } from "../src/render/canvas";

async function load(name: string) {
  return CircRuntime.loadFromBytes(new Uint8Array(readFileSync(join(FIX, name))));
}

/** A root input pin by declared name, from the layout the canvas drew. */
function pin(canvas: CircCanvas, name: string) {
  const c = canvas.getLayout().components.find(
    (p) => p.name === name && isPrimitive(p.kind) && p.kind.kind === ComponentKind.InputPin,
  );
  if (!c) throw new Error(`no input pin named ${name}`);
  return c;
}

/** Client coordinates of a component's centre. The stub reports the intended
 *  extent as its rect, so the hit-test's rescale is the identity. */
function centre(c: { x: number; y: number; width: number; height: number }, cell = 12, padding = 4) {
  return { clientX: (c.x + c.width / 2) * cell + padding, clientY: (c.y + c.height / 2) * cell + padding };
}

test("a width-1 pin still toggles on click", async () => {
  const rt = await halfAdder();
  const toggles: [number, number][] = [];
  const changes: [number, bigint, bigint][] = [];
  const canvas = new CircCanvas(rt, {
    onPinToggle: (id, s) => toggles.push([id, s]),
    onPinChange: (id, v) => changes.push([id, v.value, v.defined]),
  });
  const a = pin(canvas, "a");
  expect(a.bitWidth).toBe(1);
  const el = stub.created[0];

  el.dispatchEvent("click", centre(a));
  expect(rt.readValue(a.id)).toEqual({ value: 1n, defined: 1n, width: 1 });
  el.dispatchEvent("click", centre(a));
  expect(rt.readValue(a.id)).toEqual({ value: 0n, defined: 1n, width: 1 });

  // Both callbacks, both times, and no field was ever created.
  expect(toggles).toEqual([[a.id, 1], [a.id, 0]]);
  expect(changes).toEqual([[a.id, 1n, 1n], [a.id, 0n, 1n]]);
  expect(stub.inputs).toHaveLength(0);
});

test("a click on a bus pin opens a field and drives nothing", async () => {
  const rt = await load("rom_lookup.wasm");
  const toggles: unknown[] = [];
  const canvas = new CircCanvas(rt, { onPinToggle: (...a) => toggles.push(a) });
  const a = pin(canvas, "pc");
  expect(a.bitWidth).toBe(4);
  const before = rt.readValue(a.id);

  stub.created[0].dispatchEvent("click", centre(a));

  // The bug this exists for: the pin is NOT all-ones now.
  expect(rt.readValue(a.id)).toEqual(before);
  expect(toggles).toEqual([]);
  expect(stub.inputs).toHaveLength(1);
  const field = stub.inputs[0];
  expect(stub.body.children).toContain(field);
  expect(field.focused).toBe(true);
  expect(field.selected).toBe(true);
  // Seeded from the RUNTIME's value: it drives every input to Low at load, so
  // a fresh pin reads 0x0 here and in the badge, never `?` over `0x0`.
  expect(field.value).toBe("0x0");
  expect(field.style.position).toBe("fixed");
});

test("what is typed is what is driven, and both callbacks hear it", async () => {
  const rt = await load("rom_lookup.wasm");
  const toggles: [number, number][] = [];
  const changes: [number, bigint, bigint, number][] = [];
  const canvas = new CircCanvas(rt, {
    onPinToggle: (id, s) => toggles.push([id, s]),
    onPinChange: (id, v) => changes.push([id, v.value, v.defined, v.width]),
  });
  const a = pin(canvas, "pc");
  stub.created[0].dispatchEvent("click", centre(a));
  const field = stub.inputs[0];

  field.value = "a";
  field.press("Enter");

  expect(rt.readValue(a.id)).toEqual({ value: 0xan, defined: 0xfn, width: 4 });
  expect(canvas.getInputValue(a.id)).toEqual({ value: 0xan, defined: 0xfn, width: 4 });
  expect(changes).toEqual([[a.id, 0xan, 0xfn, 4]]);
  // onPinToggle is lossy by construction: a mixed bus collapses to High.
  expect(toggles).toEqual([[a.id, 1]]);
  expect(field.removed).toBe(true);
});

test("a refused value keeps the field open and says why", async () => {
  const rt = await load("rom_lookup.wasm");
  const canvas = new CircCanvas(rt, {});
  const a = pin(canvas, "pc");
  const before = rt.readValue(a.id);
  stub.created[0].dispatchEvent("click", centre(a));
  const field = stub.inputs[0];

  field.value = "1f"; // 31 into four bits
  field.press("Enter");
  expect(field.removed).toBe(false);
  expect(field.getAttribute("aria-invalid")).toBe("true");
  expect(field.title).toContain("15");
  expect(rt.readValue(a.id)).toEqual(before);

  // Typing again clears the complaint; a legal value then commits.
  field.press("f");
  expect(field.getAttribute("aria-invalid")).toBe("false");
  field.value = "f";
  field.press("Enter");
  expect(rt.readValue(a.id)).toEqual({ value: 0xfn, defined: 0xfn, width: 4 });
  expect(field.removed).toBe(true);
});

test("Escape, blur, scroll and resize each close the field uncommitted", async () => {
  const rt = await load("rom_lookup.wasm");
  const canvas = new CircCanvas(rt, {});
  const a = pin(canvas, "pc");
  const before = rt.readValue(a.id);
  const el = stub.created[0];

  const open = () => {
    el.dispatchEvent("click", centre(a));
    const field = stub.inputs[stub.inputs.length - 1];
    field.value = "9";
    return field;
  };

  let field = open();
  field.press("Escape");
  expect(field.removed).toBe(true);

  field = open();
  field.blur();
  expect(field.removed).toBe(true);

  field = open();
  stub.window.dispatchEvent("scroll");
  expect(field.removed).toBe(true);

  field = open();
  stub.window.dispatchEvent("resize");
  expect(field.removed).toBe(true);

  // Nothing above drove the pin.
  expect(rt.readValue(a.id)).toEqual(before);
  // …and each close took its window listeners with it.
  for (const set of stub.window.listeners.values()) expect(set.size).toBe(0);
});

test("opening a second field closes the first", async () => {
  const rt = await load("rom_lookup.wasm");
  const canvas = new CircCanvas(rt, {});
  const a = pin(canvas, "pc");
  const el = stub.created[0];
  el.dispatchEvent("click", centre(a));
  el.dispatchEvent("click", centre(a));
  expect(stub.inputs).toHaveLength(2);
  expect(stub.inputs[0].removed).toBe(true);
  expect(stub.inputs[1].removed).toBe(false);
});

test("setInputValue drives an exact word, masked to the width, and fires nothing", async () => {
  const rt = await load("rom_lookup.wasm");
  const heard: unknown[] = [];
  const canvas = new CircCanvas(rt, {
    onPinToggle: (...x) => heard.push(x),
    onPinChange: (...x) => heard.push(x),
  });
  const a = pin(canvas, "pc");

  canvas.setInputValue(a.id, 0x1ffn, 0x1ffn);
  expect(rt.readValue(a.id)).toEqual({ value: 0xfn, defined: 0xfn, width: 4 });
  expect(canvas.getInputValue(a.id)).toEqual({ value: 0xfn, defined: 0xfn, width: 4 });

  // A value the host asked for is not a change the host needs telling about.
  expect(heard).toEqual([]);
});

test("a pin the canvas never drove reads as null, not as zero", async () => {
  const rt = await load("rom_lookup.wasm");
  const canvas = new CircCanvas(rt, {});
  expect(canvas.getInputValue(pin(canvas, "pc").id)).toBeNull();
});

test("? makes a driven pin unknown again, and the field seeds from the driven value", async () => {
  const rt = await load("rom_lookup.wasm");
  const canvas = new CircCanvas(rt, {});
  const a = pin(canvas, "pc");
  canvas.setInputValue(a.id, 0xan, 0xfn);

  stub.created[0].dispatchEvent("click", centre(a));
  const field = stub.inputs[0];
  expect(field.value).toBe("0xA");

  field.value = "?";
  field.press("Enter");
  expect(rt.readValue(a.id)).toEqual({ value: 0n, defined: 0n, width: 4 });
});

test("valueFormat chooses the base the field seeds in and bare entry is read in", async () => {
  const rt = await load("rom_lookup.wasm");
  const canvas = new CircCanvas(rt, { valueFormat: "binary" });
  const a = pin(canvas, "pc");
  canvas.setInputValue(a.id, 0xan, 0xfn);
  stub.created[0].dispatchEvent("click", centre(a));
  const field = stub.inputs[0];
  expect(field.value).toBe("0b1010");

  // A bare entry is binary here; a prefix still overrides.
  field.value = "0011";
  field.press("Enter");
  expect(rt.readValue(a.id).value).toBe(3n);
});

test("setInputSignal still drives every bit, through the same path", async () => {
  const rt = await load("rom_lookup.wasm");
  const canvas = new CircCanvas(rt, {});
  const a = pin(canvas, "pc");
  canvas.setInputSignal(a.id, 1);
  expect(rt.readValue(a.id)).toEqual({ value: 0xfn, defined: 0xfn, width: 4 });
  canvas.setInputSignal(a.id, 0);
  expect(rt.readValue(a.id)).toEqual({ value: 0n, defined: 0xfn, width: 4 });
  canvas.setInputSignal(a.id, 2);
  expect(rt.readValue(a.id)).toEqual({ value: 0n, defined: 0n, width: 4 });
});

test("a click after setInputValue flips from the value the host set", async () => {
  // The invariant the doc comment on setInputSignal has always claimed.
  const rt = await halfAdder();
  const toggles: number[] = [];
  const canvas = new CircCanvas(rt, { onPinToggle: (_, s) => toggles.push(s) });
  const a = pin(canvas, "a");
  canvas.setInputValue(a.id, 1n, 1n);
  stub.created[0].dispatchEvent("click", centre(a));
  expect(toggles).toEqual([0]);
  expect(rt.readValue(a.id).value).toBe(0n);
});

test("onPinEdit returning true takes the gesture over; its commit drives and announces", async () => {
  const rt = await load("rom_lookup.wasm");
  const requests: PinEditRequest[] = [];
  const changes: bigint[] = [];
  const canvas = new CircCanvas(rt, {
    onPinEdit: (req) => { requests.push(req); return true; },
    onPinChange: (_, v) => changes.push(v.value),
  });
  const a = pin(canvas, "pc");
  stub.created[0].dispatchEvent("click", centre(a));

  // No built-in field: the host said it has one.
  expect(stub.inputs).toHaveLength(0);
  expect(requests).toHaveLength(1);
  const req = requests[0];
  expect(req.id).toBe(a.id);
  expect(req.value).toEqual({ value: 0n, defined: 0xfn, width: 4 });
  // The box is where the host should put its field.
  expect(req.box).toEqual(canvas.boxOf(a.id)!);

  req.commit(0x5n, 0xfn);
  expect(rt.readValue(a.id)).toEqual({ value: 0x5n, defined: 0xfn, width: 4 });
  expect(changes).toEqual([0x5n]);
});

test("onPinEdit returning nothing lets the built-in field open", async () => {
  const rt = await load("rom_lookup.wasm");
  let asked = 0;
  const canvas = new CircCanvas(rt, { onPinEdit: () => { asked += 1; } });
  stub.created[0].dispatchEvent("click", centre(pin(canvas, "pc")));
  expect(asked).toBe(1);
  expect(stub.inputs).toHaveLength(1);
});

test("boxOf is the box in CSS pixels, and null for an id that has none", async () => {
  const rt = await load("rom_lookup.wasm");
  const canvas = new CircCanvas(rt, { cell: 10, padding: 6 });
  const a = pin(canvas, "pc");
  expect(canvas.boxOf(a.id)).toEqual({
    x: a.x * 10 + 6,
    y: a.y * 10 + 6,
    width: a.width * 10,
    height: a.height * 10,
  });
  expect(canvas.boxOf(999_999)).toBeNull();
});

test("boxOf follows the element when page CSS shrinks it", async () => {
  const rt = await load("rom_lookup.wasm");
  const canvas = new CircCanvas(rt, {});
  const el = stub.created[0];
  const a = pin(canvas, "pc");
  const full = canvas.boxOf(a.id)!;
  // Halve the rendered rect, as `max-width: 100%` on a narrow screen would.
  const intendedW = Number.parseFloat(el.style.width);
  const intendedH = Number.parseFloat(el.style.height);
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: intendedW / 2, height: intendedH / 2 });
  const half = canvas.boxOf(a.id)!;
  expect(half.x).toBeCloseTo(full.x / 2);
  expect(half.width).toBeCloseTo(full.width / 2);
});

test("setInputValue on a non-pin or unknown id is a no-op", async () => {
  const rt = await halfAdder();
  const canvas = new CircCanvas(rt, {});
  const gate = canvas.getLayout().components.find(
    (p) => isPrimitive(p.kind) && p.kind.kind === ComponentKind.AndGate,
  )!;
  canvas.setInputValue(gate.id, 1n, 1n);
  canvas.setInputValue(999_999, 1n, 1n);
  expect(canvas.getInputValue(gate.id)).toBeNull();
});

test("the bus badge shows the driven value in the chosen format and a theme can take it over", async () => {
  const rt = await load("rom_lookup.wasm");
  const badges: string[] = [];
  const canvas = new CircCanvas(rt, {
    valueFormat: "decimal",
    theme: { ...baseTheme, busValue: ({ text }) => { badges.push(text); } },
  });
  const a = pin(canvas, "pc");
  badges.length = 0;
  canvas.setInputValue(a.id, 0xan, 0xfn);
  // Every multi-bit component is badged on each draw; the pin's own reads 10.
  expect(badges).toContain("10");
  // A half-known bus is written bit by bit rather than hidden behind one `?`.
  badges.length = 0;
  canvas.setInputValue(a.id, 0b1000n, 0b1100n);
  expect(badges).toContain("10xx");
});

test("destroy closes an open field and removes every listener it attached", async () => {
  const rt = await load("rom_lookup.wasm");
  const canvas = new CircCanvas(rt, {});
  const el = stub.created[0];
  el.dispatchEvent("click", centre(pin(canvas, "pc")));
  const field = stub.inputs[0];
  expect(field.removed).toBe(false);

  canvas.destroy();
  expect(field.removed).toBe(true);
  for (const set of stub.window.listeners.values()) expect(set.size).toBe(0);
  for (const set of el.listeners.values()) expect(set.size).toBe(0);
  // The canvas element itself still carries only the three it always did.
  expect([...el.listeners.keys()].sort()).toEqual(["click", "pointerleave", "pointermove"]);
});

// ---------------------------------------------------------------------------
// The highlight is drawn by the canvas, for every kind.
//
// Every default skin used to ignore the `hovered` flag it was handed, so a
// host highlight was invisible on any kind the host did not skin itself. The
// ring is drawn here now, once per marked component, after everything else.
// ---------------------------------------------------------------------------

import { boxOutline, drawLabel, memoryLabel, drawMemory, drawSlice, drawConcat } from "../src/render/skins";
import type { HighlightContext } from "../src/utils/theme";

/** A theme whose highlight hook records what it was handed. */
function recordingHighlight() {
  const seen: { id: number; reason: string }[] = [];
  const theme = {
    ...baseTheme,
    highlight: ({ component, reason }: HighlightContext) => { seen.push({ id: component.id, reason }); },
  };
  return { theme, seen };
}

test("the highlight hook fires for the hovered component, on every kind, and only while marked", async () => {
  const rt = await load("rom_lookup.wasm");
  const { theme, seen } = recordingHighlight();
  const canvas = new CircCanvas(rt, { theme });
  const el = stub.created[0];
  seen.length = 0;

  // A rom is a kind the site never skinned; it is reachable now like any other.
  const rom = canvas.getLayout().components.find(
    (p) => isPrimitive(p.kind) && p.kind.kind === ComponentKind.Rom,
  )!;
  el.dispatchEvent("pointermove", centre(rom));
  expect(seen).toEqual([{ id: rom.id, reason: "hover" }]);

  // Leaving redraws with nothing marked.
  seen.length = 0;
  el.dispatchEvent("pointerleave", {});
  expect(seen).toEqual([]);
});

test("a host highlight reaches the hook too, and both at once is one ring", async () => {
  const rt = await load("rom_lookup.wasm");
  const { theme, seen } = recordingHighlight();
  const canvas = new CircCanvas(rt, { theme });
  const el = stub.created[0];
  const pc = pin(canvas, "pc");
  const rom = canvas.getLayout().components.find(
    (p) => isPrimitive(p.kind) && p.kind.kind === ComponentKind.Rom,
  )!;

  seen.length = 0;
  canvas.setHighlight(rom.id);
  expect(seen).toEqual([{ id: rom.id, reason: "highlight" }]);

  // Hovering a different component marks both, each with its own reason.
  seen.length = 0;
  el.dispatchEvent("pointermove", centre(pc));
  expect(seen.map((s) => s.id).sort((a, b) => a - b)).toEqual([pc.id, rom.id].sort((a, b) => a - b));
  expect(seen.find((s) => s.id === pc.id)!.reason).toBe("hover");
  expect(seen.find((s) => s.id === rom.id)!.reason).toBe("highlight");

  // Hovering the highlighted one is a single ring that says so.
  seen.length = 0;
  el.dispatchEvent("pointermove", centre(rom));
  expect(seen).toEqual([{ id: rom.id, reason: "both" }]);
});

test("without a hook the default ring draws, and a no-op hook draws nothing", async () => {
  const rt = await load("rom_lookup.wasm");
  // Default: must not throw on the recording context, which is all the stub
  // can tell us — the ring has no pixels to inspect here.
  const canvas = new CircCanvas(rt, {});
  const rom = canvas.getLayout().components.find(
    (p) => isPrimitive(p.kind) && p.kind.kind === ComponentKind.Rom,
  )!;
  expect(() => canvas.setHighlight(rom.id)).not.toThrow();

  // A theme that wants no mark at all says so with a no-op.
  let called = 0;
  const silent = new CircCanvas(rt, { theme: { ...baseTheme, highlight: () => { called += 1; } } });
  silent.setHighlight(rom.id);
  expect(called).toBe(1);
});

test("the skin still receives hovered, for a skin that wants to react on its own", async () => {
  // The ring covers every kind; a skin may ALSO change its own fill. Both
  // paths stay open, which is what lets a host keep an existing skin.
  const rt = await halfAdder();
  const { theme, seen } = recordingTheme();
  const canvas = new CircCanvas(rt, { theme });
  const a = pin(canvas, "a");
  seen.length = 0;
  canvas.setHighlight(a.id);
  expect(hoveredIds(seen)).toEqual([a.id]);
});

test("the exported helpers draw the default boxes and labels without a real context", async () => {
  // A host builds its own rom/ram/slice/concat skins from these; they have to
  // be callable with the same arguments the defaults use.
  const rt = await load("rom_lookup.wasm");
  const canvas = new CircCanvas(rt, {});
  const ctx = (stub.created[0].getContext("2d") as CanvasRenderingContext2D);
  const rom = canvas.getLayout().components.find(
    (p) => isPrimitive(p.kind) && p.kind.kind === ComponentKind.Rom,
  )!;
  expect(() => boxOutline(ctx, baseTheme, 12, rom.x, rom.y, rom.width, rom.height, 1)).not.toThrow();
  expect(() => drawLabel(ctx, baseTheme, 12, "code", 0, 0)).not.toThrow();
  expect(memoryLabel(ComponentKind.Rom, "code", 8, 4)).toBe("rom code[8,4]");
  const args = {
    ctx, theme: baseTheme, cell: 12, component: rom,
    inputSignals: [], outputSignal: 2 as const, inputValues: [], outputValue: { value: 0n, defined: 0n, width: 8 },
    hovered: false,
  };
  for (const skin of [drawMemory, drawSlice, drawConcat]) expect(() => skin(args)).not.toThrow();
});
