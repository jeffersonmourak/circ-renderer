// The view: where the circuit sits in the element. One placement feeds the
// transform, the hit-test and `boxOf`, so a zoom that moves the picture moves
// where a click lands by the same amount — the point of keeping one. The
// default view is the placement the canvas always had, so a canvas that never
// zooms draws exactly as before. And a view change is not a change to the
// circuit: it drives no pin and fires no pin callback.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CircRuntime } from "../src/wasm/runtime";
import { CircCanvas } from "../src/render/canvas";
import { fitView, zoomAbout } from "../src/render/view";
import { ComponentKind } from "../src/wasm/topology";
import { isPrimitive } from "../src/layout/types";
import { baseTheme } from "../src/utils/theme";
import { installStubDocument } from "./canvas-stub";

const FIX = join(import.meta.dir, "fixtures");
let stub: ReturnType<typeof installStubDocument>;
/** Every `setTransform` and `fillRect` the canvas's context received. */
let transforms: number[][];
let fills: number[][];

beforeEach(() => {
  stub = installStubDocument();
  transforms = [];
  fills = [];
  const create = stub.document.createElement.bind(stub.document);
  stub.document.createElement = (tag: string) => {
    const el = create(tag) as { getContext: (kind: string) => unknown };
    if (tag === "canvas") {
      const ctx = el.getContext("2d") as Record<string, unknown>;
      ctx.setTransform = (...args: number[]) => { transforms.push(args); };
      ctx.fillRect = (...args: number[]) => { fills.push(args); };
      el.getContext = () => ctx;
    }
    return el;
  };
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

/** The last transform that is not the draw's identity clear. */
const lastView = () => transforms.filter((t) => !(t[0] === 1 && t[4] === 0 && t[5] === 0)).at(-1)!;

test("the default view is the grid one padding in at natural size, and getView is a copy", async () => {
  const rt = await load("half_adder.wasm");
  const canvas = new CircCanvas(rt, { interactive: false, cell: 10, padding: 6 });
  expect(canvas.getView()).toEqual({ scale: 1, x: 6, y: 6 });
  const v = canvas.getView();
  v.scale = 5;
  expect(canvas.getView().scale).toBe(1);
  // The transform is the one the canvas always wrote for this placement.
  expect(lastView()).toEqual([1, 0, 0, 1, 6, 6]);
});

test("setView writes the view into the transform, scaled by the device pixel ratio", async () => {
  const rt = await load("half_adder.wasm");
  stub.window.devicePixelRatio = 2;
  const canvas = new CircCanvas(rt, { interactive: false, cell: 10, padding: 6 });
  canvas.setView({ scale: 2, x: 30, y: -12 });
  expect(canvas.getView()).toEqual({ scale: 2, x: 30, y: -12 });
  expect(lastView()).toEqual([4, 0, 0, 4, 60, -24]);
  // The element itself did not change size: a view moves the picture inside
  // it, and `setCell` is still the way to resize it.
  const layout = canvas.getLayout();
  expect(canvas.canvas.style.width).toBe(`${layout.width * 10 + 12}px`);
});

test("boxOf and the hit-test follow the view together", async () => {
  const rt = await load("half_adder.wasm");
  const hovers: (number | null)[] = [];
  const canvas = new CircCanvas(rt, { cell: 10, padding: 6, onHover: (id) => hovers.push(id) });
  const a = pin(canvas, "a");
  const before = canvas.boxOf(a.id)!;
  canvas.setView({ scale: 2, x: 40, y: 20 });
  const after = canvas.boxOf(a.id)!;
  expect(after).toEqual({
    x: a.x * 10 * 2 + 40,
    y: a.y * 10 * 2 + 20,
    width: a.width * 10 * 2,
    height: a.height * 10 * 2,
  });
  expect(after.width).toBe(before.width * 2);

  const el = stub.created[0];
  // A pointer where the box IS lands on it.
  el.dispatchEvent("pointermove", { clientX: after.x + after.width / 2, clientY: after.y + after.height / 2 });
  expect(hovers).toEqual([a.id]);
  // A pointer where the box WAS, before the zoom, lands on nothing: at
  // (before.x, before.y) the world point is now above and left of the grid.
  el.dispatchEvent("pointermove", { clientX: before.x - 1, clientY: before.y - 1 });
  expect(hovers).toEqual([a.id, null]);
});

test("the hit-test composes the view with a page shrink of the element", async () => {
  const rt = await load("half_adder.wasm");
  const hovers: (number | null)[] = [];
  const canvas = new CircCanvas(rt, { cell: 10, padding: 6, onHover: (id) => hovers.push(id) });
  const el = stub.created[0];
  const a = pin(canvas, "a");
  const intendedW = Number.parseFloat(el.style.width);
  const intendedH = Number.parseFloat(el.style.height);
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width: intendedW / 2, height: intendedH / 2 });
  canvas.setView({ scale: 2, x: 40, y: 20 });
  // boxOf reports in the rendered rect, so its centre is where to aim.
  const box = canvas.boxOf(a.id)!;
  expect(box.x).toBeCloseTo((a.x * 10 * 2 + 40) / 2);
  el.dispatchEvent("pointermove", { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 });
  expect(hovers).toEqual([a.id]);
});

test("zoomBy keeps the world point under `about` where it is, and defaults to the centre", async () => {
  const rt = await load("half_adder.wasm");
  const canvas = new CircCanvas(rt, { interactive: false, cell: 10, padding: 6 });
  const a = pin(canvas, "a");
  const box = canvas.boxOf(a.id)!;
  const about = { x: box.x + 3, y: box.y + 2 };
  canvas.zoomBy(2, about);
  // The pin's box grew away from `about`, which stayed put: the box's
  // top-left is now twice as far from it as before.
  const zoomed = canvas.boxOf(a.id)!;
  expect(zoomed.x).toBeCloseTo(about.x - 3 * 2);
  expect(zoomed.y).toBeCloseTo(about.y - 2 * 2);
  expect(zoomed.width).toBeCloseTo(box.width * 2);

  // Without `about`, the element's centre is the fixed point.
  canvas.resetView();
  const w = Number.parseFloat(canvas.canvas.style.width);
  const h = Number.parseFloat(canvas.canvas.style.height);
  canvas.zoomBy(3);
  const v = canvas.getView();
  expect(v.scale).toBe(3);
  expect(v.x).toBeCloseTo(w / 2 - (w / 2 - 6) * 3);
  expect(v.y).toBeCloseTo(h / 2 - (h / 2 - 6) * 3);
});

test("the scale is clamped to the zoom range, and a host can widen it", async () => {
  const rt = await load("half_adder.wasm");
  const canvas = new CircCanvas(rt, { interactive: false });
  canvas.setView({ scale: 100, x: 0, y: 0 });
  expect(canvas.getView().scale).toBe(8);
  canvas.setView({ scale: 0.01, x: 0, y: 0 });
  expect(canvas.getView().scale).toBe(0.25);
  canvas.zoomBy(0.0001);
  expect(canvas.getView().scale).toBe(0.25);
  // A scale that is not a positive number lands on the floor, not on NaN.
  canvas.setView({ scale: Number.NaN, x: 0, y: 0 });
  expect(canvas.getView().scale).toBe(0.25);

  const wide = new CircCanvas(rt, { interactive: false, minZoom: 0.1, maxZoom: 20 });
  wide.setView({ scale: 100, x: 0, y: 0 });
  expect(wide.getView().scale).toBe(20);
  wide.setView({ scale: 0.01, x: 0, y: 0 });
  expect(wide.getView().scale).toBe(0.1);
});

test("onViewChange fires once per change, not for the built view, not for a no-op", async () => {
  const rt = await load("half_adder.wasm");
  const seen: { scale: number; x: number; y: number }[] = [];
  const canvas = new CircCanvas(rt, { interactive: false, padding: 4, onViewChange: (v) => seen.push(v) });
  expect(seen).toEqual([]);
  canvas.setView({ scale: 1, x: 4, y: 4 });
  expect(seen).toEqual([]);
  canvas.setView({ scale: 2, x: 4, y: 4 });
  expect(seen).toEqual([{ scale: 2, x: 4, y: 4 }]);
  canvas.setView({ scale: 2, x: 4, y: 4 });
  expect(seen).toHaveLength(1);
  // A clamped view equal to the current one is a no-op too.
  canvas.setView({ scale: 2, x: 4, y: 4 });
  expect(seen).toHaveLength(1);
  canvas.resetView();
  expect(seen).toEqual([{ scale: 2, x: 4, y: 4 }, { scale: 1, x: 4, y: 4 }]);
  canvas.resetView();
  expect(seen).toHaveLength(2);
  // What the host receives is a copy.
  seen[0].scale = 99;
  expect(canvas.getView()).toEqual({ scale: 1, x: 4, y: 4 });
});

test("fit at natural size is the default view, and comes back to it after a zoom", async () => {
  const rt = await load("half_adder.wasm");
  const canvas = new CircCanvas(rt, { interactive: false, cell: 10, padding: 6 });
  canvas.setView({ scale: 3, x: -100, y: 50 });
  canvas.fit();
  expect(canvas.getView()).toEqual({ scale: 1, x: 6, y: 6 });
});

test("fitView centres the grid in a viewport of another shape, padding kept clear", () => {
  // A wide grid in a square viewport: the width is the limit, the height
  // has spare room, and the grid sits in the middle of it.
  const v = fitView({ width: 200, height: 50 }, { width: 110, height: 110 }, 5, 0.25, 8);
  expect(v.scale).toBe(0.5);
  expect(v.x).toBe(5);
  expect(v.y).toBe((110 - 25) / 2);
  // Clamped at the floor when the viewport is far too small.
  expect(fitView({ width: 1000, height: 1000 }, { width: 10, height: 10 }, 0, 0.25, 8).scale).toBe(0.25);
});

test("zoomAbout is its own inverse about the same point", () => {
  const start = { scale: 1, x: 6, y: 6 };
  const in2 = zoomAbout(start, 2, 37, 41, 0.25, 8);
  const back = zoomAbout(in2, 0.5, 37, 41, 0.25, 8);
  expect(back.scale).toBe(1);
  expect(back.x).toBeCloseTo(6);
  expect(back.y).toBeCloseTo(6);
  // The fixed point maps to itself under both views.
  const world = { x: (37 - start.x) / start.scale, y: (41 - start.y) / start.scale };
  expect(world.x * in2.scale + in2.x).toBeCloseTo(37);
  expect(world.y * in2.scale + in2.y).toBeCloseTo(41);
});

test("setCell and setPadding start again from the default view", async () => {
  const rt = await load("half_adder.wasm");
  const seen: number[] = [];
  const canvas = new CircCanvas(rt, { interactive: false, cell: 10, padding: 6, onViewChange: (v) => seen.push(v.scale) });
  canvas.setView({ scale: 2, x: 0, y: 0 });
  canvas.setCell(20);
  expect(canvas.getView()).toEqual({ scale: 1, x: 6, y: 6 });
  canvas.setView({ scale: 2, x: 0, y: 0 });
  canvas.setPadding(10);
  expect(canvas.getView()).toEqual({ scale: 1, x: 10, y: 10 });
  expect(seen).toEqual([2, 1, 2, 1]);
  // At the default view already, a metric change reports no view change.
  canvas.setCell(12);
  expect(seen).toHaveLength(4);
});

test("a view change closes an open value field, and drives nothing", async () => {
  const rt = await load("rom_lookup.wasm");
  const changes: unknown[] = [];
  const canvas = new CircCanvas(rt, { onPinChange: (...a) => changes.push(a), onPinToggle: (...a) => changes.push(a) });
  const pc = pin(canvas, "pc");
  expect(pc.bitWidth).toBe(4);
  const box = canvas.boxOf(pc.id)!;
  const before = rt.readValue(pc.id);
  stub.created[0].dispatchEvent("click", { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 });
  expect(stub.dialogs).toHaveLength(1);
  expect(stub.dialogs[0].removed).toBe(false);

  canvas.zoomBy(2);
  expect(stub.dialogs[0].removed).toBe(true);
  expect(rt.readValue(pc.id)).toEqual(before);
  expect(changes).toEqual([]);

  // And a no-op view change leaves a field alone.
  const moved = canvas.boxOf(pc.id)!;
  stub.created[0].dispatchEvent("click", { clientX: moved.x + moved.width / 2, clientY: moved.y + moved.height / 2 });
  expect(stub.dialogs).toHaveLength(2);
  canvas.setView(canvas.getView());
  expect(stub.dialogs[1].removed).toBe(false);
});

test("a view change never touches a driven pin", async () => {
  const rt = await load("half_adder.wasm");
  const changes: unknown[] = [];
  const canvas = new CircCanvas(rt, { onPinChange: (...a) => changes.push(a), onPinToggle: (...a) => changes.push(a) });
  const a = pin(canvas, "a");
  canvas.setInputValue(a.id, 1n, 1n);
  canvas.setView({ scale: 2, x: 10, y: 10 });
  canvas.fit();
  canvas.zoomBy(0.5);
  canvas.resetView();
  expect(rt.readValue(a.id)).toEqual({ value: 1n, defined: 1n, width: 1 });
  expect(canvas.getInputValue(a.id)).toEqual({ value: 1n, defined: 1n, width: 1 });
  expect(changes).toEqual([]);
});

test("the default background fills what the element shows, not the grid", async () => {
  const rt = await load("half_adder.wasm");
  const canvas = new CircCanvas(rt, { interactive: false, cell: 10, padding: 6 });
  const w = Number.parseFloat(canvas.canvas.style.width);
  const h = Number.parseFloat(canvas.canvas.style.height);
  // At the default view that is the grid plus its padding, as it always was.
  expect(fills[0]).toEqual([-6, -6, w, h]);
  fills = [];
  // Zoomed out to a half, the element shows twice the world on each axis,
  // starting further up and left.
  canvas.setView({ scale: 0.5, x: 20, y: 10 });
  expect(fills[0]).toEqual([-40, -20, w * 2, h * 2]);
});

test("a theme's background hook is handed the view and the viewport", async () => {
  const rt = await load("half_adder.wasm");
  const seen: { view: unknown; viewport: unknown; width: number }[] = [];
  const theme = {
    ...baseTheme,
    background: (a: { view: unknown; viewport: unknown; width: number }) => { seen.push({ view: a.view, viewport: a.viewport, width: a.width }); },
  };
  const canvas = new CircCanvas(rt, { interactive: false, cell: 10, padding: 6, theme: theme as never });
  const layout = canvas.getLayout();
  expect(seen.at(-1)).toEqual({
    view: { scale: 1, x: 6, y: 6 },
    viewport: { width: layout.width * 10 + 12, height: layout.height * 10 + 12 },
    width: layout.width,
  });
  canvas.setView({ scale: 2, x: 1, y: 2 });
  expect(seen.at(-1)!.view).toEqual({ scale: 2, x: 1, y: 2 });
});
