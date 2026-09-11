// The gestures that move the view, and the rule they keep: a gesture that
// moves the view never reaches the simulation, and a click never moves the
// view. A press under the threshold is a click and toggles its pin exactly as
// before; a press over it is a pan, its trailing click drives nothing, and the
// hover is frozen while it lasts. A wheel zooms only with a modifier held, so
// the page keeps its scroll. Two fingers pinch; one finger is the page's.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CircRuntime } from "../src/wasm/runtime";
import { CircCanvas, type RenderOptions } from "../src/render/canvas";
import { ComponentKind } from "../src/wasm/topology";
import { isPrimitive } from "../src/layout/types";
import { installStubDocument, type StubCanvas } from "./canvas-stub";

const FIX = join(import.meta.dir, "fixtures");
let stub: ReturnType<typeof installStubDocument>;

beforeEach(() => {
  stub = installStubDocument();
});
afterEach(() => {
  stub.uninstall();
});

async function load(name: string) {
  return CircRuntime.loadFromBytes(new Uint8Array(readFileSync(join(FIX, name))));
}

function pin(canvas: CircCanvas, name: string) {
  const c = canvas.getLayout().components.find(
    (p) => p.name === name && isPrimitive(p.kind) && p.kind.kind === ComponentKind.InputPin,
  );
  if (!c) throw new Error(`no input pin named ${name}`);
  return c;
}

/** A half adder with every callback recording, so a test can say "nothing". */
async function rig(options: RenderOptions = {}) {
  const rt = await load("half_adder.wasm");
  const pins: unknown[] = [];
  const hovers: (number | null)[] = [];
  const views: number[] = [];
  const canvas = new CircCanvas(rt, {
    cell: 10,
    padding: 6,
    onPinToggle: (...a) => pins.push(["toggle", ...a]),
    onPinChange: (...a) => pins.push(["change", ...a]),
    onHover: (id) => hovers.push(id),
    onViewChange: (v) => views.push(v.scale),
    ...options,
  });
  const el = stub.created[0];
  const a = pin(canvas, "a");
  const box = canvas.boxOf(a.id)!;
  const centre = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  return { rt, canvas, el, a, centre, pins, hovers, views };
}

/** A pointer, as the browser would describe it. */
function pointer(
  x: number,
  y: number,
  extra: { id?: number; type?: string; button?: number; ctrlKey?: boolean; metaKey?: boolean } = {},
) {
  const prevented: boolean[] = [];
  return {
    clientX: x,
    clientY: y,
    pointerId: extra.id ?? 1,
    pointerType: extra.type ?? "mouse",
    button: extra.button ?? 0,
    ctrlKey: extra.ctrlKey ?? false,
    metaKey: extra.metaKey ?? false,
    preventDefault: () => { prevented.push(true); },
    prevented,
  };
}

function wheel(x: number, y: number, deltaY: number, extra: { ctrlKey?: boolean; metaKey?: boolean; deltaMode?: number } = {}) {
  const prevented: boolean[] = [];
  return {
    clientX: x,
    clientY: y,
    deltaY,
    deltaMode: extra.deltaMode ?? 0,
    ctrlKey: extra.ctrlKey ?? false,
    metaKey: extra.metaKey ?? false,
    preventDefault: () => { prevented.push(true); },
    prevented,
  };
}

/** Press, move through `path`, release, and then the click the browser fires. */
function drag(el: StubCanvas, from: { x: number; y: number }, path: { x: number; y: number }[], extra: Parameters<typeof pointer>[2] = {}) {
  el.dispatchEvent("pointerdown", pointer(from.x, from.y, extra));
  for (const p of path) el.dispatchEvent("pointermove", pointer(p.x, p.y, extra));
  const last = path.at(-1) ?? from;
  el.dispatchEvent("pointerup", pointer(last.x, last.y, extra));
  el.dispatchEvent("click", pointer(last.x, last.y, extra));
}

const high = { value: 1n, defined: 1n, width: 1 };
const low = { value: 0n, defined: 1n, width: 1 };

test("a drag past the threshold pans, and the click after it drives no pin", async () => {
  const { rt, canvas, el, a, centre, pins, views } = await rig();
  drag(el, centre, [{ x: centre.x + 30, y: centre.y + 10 }]);
  expect(canvas.getView()).toEqual({ scale: 1, x: 36, y: 16 });
  expect(views).toEqual([1]);
  // The pin under the press is exactly as it was.
  expect(rt.readValue(a.id)).toEqual(low);
  expect(pins).toEqual([]);
  expect(el.captured.size).toBe(0);

  // The flag was consumed by that click: the next plain click is a real one.
  const box = canvas.boxOf(a.id)!;
  el.dispatchEvent("click", pointer(box.x + box.width / 2, box.y + box.height / 2));
  expect(rt.readValue(a.id)).toEqual(high);
  expect(pins).toHaveLength(2);
});

test("a press that moves less than the threshold is a click, and toggles", async () => {
  const { rt, canvas, el, a, centre, pins, views } = await rig();
  drag(el, centre, [{ x: centre.x + 2, y: centre.y + 1 }, { x: centre.x + 3, y: centre.y }]);
  expect(canvas.getView()).toEqual({ scale: 1, x: 6, y: 6 });
  expect(views).toEqual([]);
  expect(rt.readValue(a.id)).toEqual(high);
  expect(pins).toEqual([["toggle", a.id, 1], ["change", a.id, high]]);

  // A press with no move at all, too.
  drag(el, centre, []);
  expect(rt.readValue(a.id)).toEqual(low);
});

test("a pan is measured from the press, and each move pans from the last", async () => {
  const { canvas, el, centre } = await rig();
  drag(el, centre, [
    { x: centre.x + 10, y: centre.y },
    { x: centre.x + 20, y: centre.y + 5 },
    { x: centre.x + 15, y: centre.y + 25 },
  ]);
  expect(canvas.getView()).toEqual({ scale: 1, x: 6 + 15, y: 6 + 25 });
});

test("the hover is frozen while the view moves, and the cursor says grabbing", async () => {
  const { canvas, el, a, centre, hovers } = await rig();
  el.dispatchEvent("pointermove", pointer(centre.x, centre.y));
  expect(hovers).toEqual([a.id]);
  expect(el.style.cursor).toBe("pointer");

  el.dispatchEvent("pointerdown", pointer(centre.x, centre.y));
  // Under the threshold: still a press, still hovering.
  el.dispatchEvent("pointermove", pointer(centre.x + 2, centre.y));
  expect(el.style.cursor).toBe("pointer");
  // Over it: a pan. The boxes slide under the pointer and none is reported.
  el.dispatchEvent("pointermove", pointer(centre.x + 40, centre.y + 40));
  el.dispatchEvent("pointermove", pointer(centre.x + 200, centre.y + 200));
  expect(el.style.cursor).toBe("grabbing");
  expect(hovers).toEqual([a.id]);

  el.dispatchEvent("pointerup", pointer(centre.x + 200, centre.y + 200));
  el.dispatchEvent("click", pointer(centre.x + 200, centre.y + 200));
  expect(el.style.cursor).not.toBe("grabbing");
  // The next move reports the box that is actually under the pointer now.
  // Nothing was reported during the pan, and the pin is still the hover, so
  // a move onto it again reports no change; a move off it reports null.
  const box = canvas.boxOf(a.id)!;
  el.dispatchEvent("pointermove", pointer(box.x + 1, box.y + 1));
  expect(hovers).toEqual([a.id]);
  el.dispatchEvent("pointermove", pointer(box.x - 1, box.y - 1));
  expect(hovers).toEqual([a.id, null]);
});

test("a plain wheel is the page's; with Ctrl or ⌘ it zooms about the pointer", async () => {
  const { canvas, el, a, views } = await rig();
  const box = canvas.boxOf(a.id)!;
  const at = { x: box.x + 3, y: box.y + 2 };

  const plain = wheel(at.x, at.y, -100);
  el.dispatchEvent("wheel", plain);
  expect(plain.prevented).toEqual([]);
  expect(canvas.getView().scale).toBe(1);
  expect(views).toEqual([]);

  const held = wheel(at.x, at.y, -100, { ctrlKey: true });
  el.dispatchEvent("wheel", held);
  expect(held.prevented).toEqual([true]);
  expect(canvas.getView().scale).toBe(2);
  // The point under the pointer stayed put: the box grew away from it.
  const zoomed = canvas.boxOf(a.id)!;
  expect(zoomed.x).toBeCloseTo(at.x - 3 * 2);
  expect(zoomed.y).toBeCloseTo(at.y - 2 * 2);

  // ⌘ works the same, and a positive delta zooms out.
  el.dispatchEvent("wheel", wheel(at.x, at.y, 100, { metaKey: true }));
  expect(canvas.getView().scale).toBe(1);
  expect(views).toEqual([2, 1]);
});

test("a wheel in lines or pages is turned into pixels, and no single event jumps past two", async () => {
  const { canvas, el, centre } = await rig();
  // 25 lines of 16px = 400px = four doublings asked for; capped at one.
  el.dispatchEvent("wheel", wheel(centre.x, centre.y, -25, { ctrlKey: true, deltaMode: 1 }));
  expect(canvas.getView().scale).toBe(2);
  el.dispatchEvent("wheel", wheel(centre.x, centre.y, 1, { ctrlKey: true, deltaMode: 2 }));
  expect(canvas.getView().scale).toBe(1);
  // A tiny trackpad delta zooms a little, not by a whole step.
  el.dispatchEvent("wheel", wheel(centre.x, centre.y, -10, { ctrlKey: true }));
  expect(canvas.getView().scale).toBeCloseTo(Math.pow(2, 0.1));
});

test("wheel: always zooms on a plain wheel; off zooms on none", async () => {
  const always = await rig({ navigation: { wheel: "always" } });
  const plain = wheel(always.centre.x, always.centre.y, -100);
  always.el.dispatchEvent("wheel", plain);
  expect(plain.prevented).toEqual([true]);
  expect(always.canvas.getView().scale).toBe(2);

  stub.uninstall();
  stub = installStubDocument();
  const off = await rig({ navigation: { wheel: "off" } });
  const held = wheel(off.centre.x, off.centre.y, -100, { ctrlKey: true });
  off.el.dispatchEvent("wheel", held);
  expect(held.prevented).toEqual([]);
  expect(off.canvas.getView().scale).toBe(1);
});

test("navigation: false attaches no gesture, and the view moves only by API", async () => {
  const { rt, canvas, el, a, centre, pins } = await rig({ navigation: false });
  expect([...el.listeners.keys()].sort()).toEqual(["click", "pointerleave", "pointermove"]);
  expect(el.style.touchAction).toBeUndefined();
  drag(el, centre, [{ x: centre.x + 50, y: centre.y + 50 }]);
  expect(canvas.getView()).toEqual({ scale: 1, x: 6, y: 6 });
  // With no pan to swallow it, that click was a click, on whatever is there.
  el.dispatchEvent("click", pointer(centre.x, centre.y));
  expect(rt.readValue(a.id)).toEqual(high);
  expect(pins).toHaveLength(2);
  canvas.setView({ scale: 2, x: 0, y: 0 });
  expect(canvas.getView().scale).toBe(2);
});

test("drag: false leaves the wheel, and a press is only ever a click", async () => {
  const { rt, canvas, el, a, centre } = await rig({ navigation: { drag: false } });
  drag(el, centre, [{ x: centre.x + 50, y: centre.y + 50 }]);
  expect(canvas.getView()).toEqual({ scale: 1, x: 6, y: 6 });
  expect(el.captured.size).toBe(0);
  // The click landed where the pointer ended, off the pin, so nothing
  // toggled; a click on the pin still does.
  expect(rt.readValue(a.id)).toEqual(low);
  el.dispatchEvent("click", pointer(centre.x, centre.y));
  expect(rt.readValue(a.id)).toEqual(high);
  el.dispatchEvent("wheel", wheel(centre.x, centre.y, -100, { ctrlKey: true }));
  expect(canvas.getView().scale).toBe(2);
});

test("the middle button pans without the browser's autoscroll; the right button does nothing", async () => {
  const { canvas, el, centre } = await rig();
  const down = pointer(centre.x, centre.y, { button: 1 });
  el.dispatchEvent("pointerdown", down);
  expect(down.prevented).toEqual([true]);
  el.dispatchEvent("pointermove", pointer(centre.x + 20, centre.y, { button: 1 }));
  el.dispatchEvent("pointerup", pointer(centre.x + 20, centre.y, { button: 1 }));
  expect(canvas.getView()).toEqual({ scale: 1, x: 26, y: 6 });

  const right = pointer(centre.x, centre.y, { button: 2 });
  el.dispatchEvent("pointerdown", right);
  el.dispatchEvent("pointermove", pointer(centre.x + 20, centre.y, { button: 2 }));
  el.dispatchEvent("pointerup", pointer(centre.x + 20, centre.y, { button: 2 }));
  expect(canvas.getView()).toEqual({ scale: 1, x: 26, y: 6 });
  expect(right.prevented).toEqual([]);
});

test("a drag on a shrunk element pans in the drawn size, so the picture follows the pointer", async () => {
  const { canvas, el, centre } = await rig();
  const intendedW = Number.parseFloat(el.style.width);
  const intendedH = Number.parseFloat(el.style.height);
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: intendedW / 2, height: intendedH / 2 });
  drag(el, centre, [{ x: centre.x + 10, y: centre.y + 5 }]);
  expect(canvas.getView()).toEqual({ scale: 1, x: 6 + 20, y: 6 + 10 });
});

test("navigation works on a canvas that takes no pin clicks", async () => {
  const { canvas, el, centre } = await rig({ interactive: false });
  expect([...el.listeners.keys()].sort()).toEqual(["pointercancel", "pointerdown", "pointermove", "pointerup", "wheel"]);
  drag(el, centre, [{ x: centre.x + 30, y: centre.y }]);
  expect(canvas.getView()).toEqual({ scale: 1, x: 36, y: 6 });
  el.dispatchEvent("wheel", wheel(centre.x, centre.y, -100, { ctrlKey: true }));
  expect(canvas.getView().scale).toBe(2);
});

test("one finger is the page's: it neither pans nor is captured, and a tap still clicks", async () => {
  const { rt, canvas, el, a, centre, pins } = await rig();
  expect(el.style.touchAction).toBe("pan-x pan-y");
  const t = { id: 7, type: "touch" };
  el.dispatchEvent("pointerdown", pointer(centre.x, centre.y, t));
  expect(el.captured.size).toBe(0);
  el.dispatchEvent("pointermove", pointer(centre.x + 40, centre.y + 40, t));
  el.dispatchEvent("pointerup", pointer(centre.x + 40, centre.y + 40, t));
  expect(canvas.getView()).toEqual({ scale: 1, x: 6, y: 6 });
  // A tap: down, up, click on the pin.
  el.dispatchEvent("pointerdown", pointer(centre.x, centre.y, t));
  el.dispatchEvent("pointerup", pointer(centre.x, centre.y, t));
  el.dispatchEvent("click", pointer(centre.x, centre.y, t));
  expect(rt.readValue(a.id)).toEqual(high);
  expect(pins).toHaveLength(2);
});

test("two fingers pinch: the spread sets the scale about the midpoint, and lifting one ends it", async () => {
  const { rt, canvas, el, a, pins, views } = await rig();
  const f1 = { id: 11, type: "touch" };
  const f2 = { id: 12, type: "touch" };
  const box = canvas.boxOf(a.id)!;
  // Fingers 20px apart, centred on a point 3px into the pin's box.
  const mid = { x: box.x + 3, y: box.y + 2 };
  el.dispatchEvent("pointerdown", pointer(mid.x - 10, mid.y, f1));
  el.dispatchEvent("pointerdown", pointer(mid.x + 10, mid.y, f2));
  expect(el.captured.has(12)).toBe(true);
  // Spread to 40px: a doubling, about the midpoint, which stays put.
  el.dispatchEvent("pointermove", pointer(mid.x - 20, mid.y, f1));
  el.dispatchEvent("pointermove", pointer(mid.x + 20, mid.y, f2));
  expect(canvas.getView().scale).toBe(2);
  const zoomed = canvas.boxOf(a.id)!;
  expect(zoomed.x).toBeCloseTo(mid.x - 3 * 2);
  expect(zoomed.y).toBeCloseTo(mid.y - 2 * 2);
  // Both fingers slide right by 15: the picture follows the midpoint.
  el.dispatchEvent("pointermove", pointer(mid.x - 5, mid.y, f1));
  el.dispatchEvent("pointermove", pointer(mid.x + 35, mid.y, f2));
  expect(canvas.boxOf(a.id)!.x).toBeCloseTo(zoomed.x + 15);
  expect(canvas.getView().scale).toBe(2);

  // Lift one: the pinch is over, the trailing click is swallowed, and the
  // other finger moving on its own moves nothing.
  el.dispatchEvent("pointerup", pointer(mid.x + 35, mid.y, f2));
  const after = canvas.getView();
  el.dispatchEvent("pointermove", pointer(mid.x + 50, mid.y + 50, f1));
  expect(canvas.getView()).toEqual(after);
  el.dispatchEvent("pointerup", pointer(mid.x + 50, mid.y + 50, f1));
  el.dispatchEvent("click", pointer(mid.x + 50, mid.y + 50, f1));
  expect(el.captured.size).toBe(0);
  expect(rt.readValue(a.id)).toEqual(low);
  expect(pins).toEqual([]);
  // Each finger's move is its own event, so the spread passed through 30px
  // on its way to 40, and dipped to 25 as the first finger slid before the
  // second: 1.5, 2, 1.25, 2. Each is computed from the start, so the dip
  // leaves nothing behind once the second finger catches up.
  expect(views).toEqual([1.5, 2, 1.25, 2]);
});

test("touch: own lets one finger pan, and declares the canvas owns every touch", async () => {
  const { rt, canvas, el, a, centre, pins } = await rig({ navigation: { touch: "own" } });
  expect(el.style.touchAction).toBe("none");
  const t = { id: 7, type: "touch" };
  drag(el, centre, [{ x: centre.x + 40, y: centre.y + 40 }], t);
  expect(canvas.getView()).toEqual({ scale: 1, x: 46, y: 46 });
  expect(rt.readValue(a.id)).toEqual(low);
  expect(pins).toEqual([]);
});

test("a pointer cancelled mid-pan ends the pan cleanly", async () => {
  const { canvas, el, centre } = await rig();
  el.dispatchEvent("pointerdown", pointer(centre.x, centre.y));
  el.dispatchEvent("pointermove", pointer(centre.x + 20, centre.y, {}));
  el.dispatchEvent("pointercancel", pointer(centre.x + 20, centre.y));
  expect(el.captured.size).toBe(0);
  expect(el.style.cursor).not.toBe("grabbing");
  const v = canvas.getView();
  // Moves after the cancel move nothing.
  el.dispatchEvent("pointermove", pointer(centre.x + 80, centre.y + 80));
  expect(canvas.getView()).toEqual(v);
});

test("a stale swallow never eats a later real click", async () => {
  const { rt, canvas, el, a, centre, pins } = await rig();
  // A pan whose click never arrived: the pointer was released elsewhere.
  el.dispatchEvent("pointerdown", pointer(centre.x, centre.y));
  el.dispatchEvent("pointermove", pointer(centre.x + 30, centre.y));
  el.dispatchEvent("pointerup", pointer(centre.x + 30, centre.y));
  // The next press resets it, so its click is real. The pin moved with the
  // pan, so it is found afresh.
  const box = canvas.boxOf(a.id)!;
  drag(el, { x: box.x + box.width / 2, y: box.y + box.height / 2 }, []);
  expect(rt.readValue(a.id)).toEqual(high);
  expect(pins).toHaveLength(2);
});

test("destroy removes every gesture listener", async () => {
  const { canvas, el } = await rig();
  canvas.destroy();
  for (const set of el.listeners.values()) expect(set.size).toBe(0);
});
