// The element's size can be the host's instead of the grid's: a size, or the
// parent's, followed as it changes. Either way the circuit starts fitted to
// it, the hit-test and boxOf keep working in the element's own size, and a
// canvas built before it is mounted fits itself once it is measured.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CircRuntime } from "../src/wasm/runtime";
import { CircCanvas } from "../src/render/canvas";
import { ComponentKind } from "../src/wasm/topology";
import { isPrimitive } from "../src/layout/types";
import { installStubDocument } from "./canvas-stub";

const FIX = join(import.meta.dir, "fixtures");
let stub: ReturnType<typeof installStubDocument>;

/** A ResizeObserver that a test fires by hand. */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: unknown[] = [];
  disconnected = false;
  constructor(private cb: (entries: { contentRect: { width: number; height: number } }[]) => void) {
    FakeResizeObserver.instances.push(this);
  }
  observe(el: unknown) { this.observed.push(el); }
  disconnect() { this.disconnected = true; }
  fire(width: number, height: number) { this.cb([{ contentRect: { width, height } }]); }
}

beforeEach(() => {
  stub = installStubDocument();
  FakeResizeObserver.instances = [];
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
});
afterEach(() => {
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
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

/** The rendered rect follows whatever the renderer wrote into `style`, or the
 *  size a test says the parent has. */
function mountAt(el: (typeof stub.created)[0], width: number, height: number) {
  el.getBoundingClientRect = () => ({ left: 0, top: 0, width, height });
}

test("a sized viewport sizes the element, and the circuit starts fitted and centred", async () => {
  const rt = await load("half_adder.wasm");
  stub.window.devicePixelRatio = 2;
  const canvas = new CircCanvas(rt, { interactive: false, cell: 10, padding: 6, viewport: { width: 400, height: 300 } });
  const el = stub.created[0];
  expect(el.style.width).toBe("400px");
  expect(el.style.height).toBe("300px");
  expect(el.width).toBe(800);
  expect(el.height).toBe(600);
  const layout = canvas.getLayout();
  const gw = layout.width * 10;
  const gh = layout.height * 10;
  const scale = Math.min((400 - 12) / gw, (300 - 12) / gh);
  const v = canvas.getView();
  expect(v.scale).toBeCloseTo(Math.min(8, scale));
  expect(v.x).toBeCloseTo((400 - gw * v.scale) / 2);
  expect(v.y).toBeCloseTo((300 - gh * v.scale) / 2);
  // No observer for a fixed size.
  expect(FakeResizeObserver.instances).toHaveLength(0);
});

test("the hit-test and boxOf work in the viewport's size", async () => {
  const rt = await load("half_adder.wasm");
  const hovers: (number | null)[] = [];
  const canvas = new CircCanvas(rt, { cell: 10, padding: 6, viewport: { width: 400, height: 300 }, onHover: (id) => hovers.push(id) });
  const el = stub.created[0];
  mountAt(el, 400, 300);
  const a = pin(canvas, "a");
  const v = canvas.getView();
  const box = canvas.boxOf(a.id)!;
  expect(box.x).toBeCloseTo(a.x * 10 * v.scale + v.x);
  expect(box.width).toBeCloseTo(a.width * 10 * v.scale);
  el.dispatchEvent("pointermove", { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 });
  expect(hovers).toEqual([a.id]);
});

test("viewport: parent fills the parent and fits once it is measured, then keeps the view", async () => {
  const rt = await load("half_adder.wasm");
  const views: number[] = [];
  const canvas = new CircCanvas(rt, { interactive: false, cell: 10, padding: 6, viewport: "parent", onViewChange: (v) => views.push(v.scale) });
  const el = stub.created[0];
  expect(el.style.width).toBe("100%");
  expect(el.style.height).toBe("100%");
  expect(el.style.display).toBe("block");
  // Unmeasured: the grid's size stands in, and the view is the default.
  const layout = canvas.getLayout();
  expect(el.width).toBe(layout.width * 10 + 12);
  expect(canvas.getView()).toEqual({ scale: 1, x: 6, y: 6 });
  expect(FakeResizeObserver.instances).toHaveLength(1);
  const ro = FakeResizeObserver.instances[0];
  expect(ro.observed).toEqual([el]);

  // Mounted in a 500 by 200 parent: the backing store follows, and the
  // circuit is fitted.
  ro.fire(500, 200);
  mountAt(el, 500, 200);
  expect(el.width).toBe(500);
  expect(el.height).toBe(200);
  const gw = layout.width * 10;
  const gh = layout.height * 10;
  const fitted = Math.min((500 - 12) / gw, (200 - 12) / gh);
  expect(canvas.getView().scale).toBeCloseTo(fitted);
  expect(views).toHaveLength(1);

  // The reader zooms; then the pane grows. The view is kept: more of the
  // circuit shows, and nothing jumps.
  canvas.setView({ scale: 2, x: 10, y: 10 });
  ro.fire(800, 400);
  expect(el.width).toBe(800);
  expect(canvas.getView()).toEqual({ scale: 2, x: 10, y: 10 });
  // The same size again is nothing.
  ro.fire(800, 400);
  expect(views).toHaveLength(2);
  expect(views[1]).toBe(2);

  // A zero-sized measurement (the parent hidden) is ignored.
  ro.fire(0, 0);
  expect(el.width).toBe(800);

  canvas.destroy();
  expect(ro.disconnected).toBe(true);
});

test("setViewport changes the sizing in place, and null goes back to the grid's own size", async () => {
  const rt = await load("half_adder.wasm");
  const canvas = new CircCanvas(rt, { interactive: false, cell: 10, padding: 6 });
  const el = stub.created[0];
  const layout = canvas.getLayout();
  canvas.setViewport({ width: 300, height: 300 });
  expect(el.style.width).toBe("300px");
  expect(canvas.getView().scale).not.toBe(1);

  canvas.setViewport("parent");
  expect(el.style.width).toBe("100%");
  expect(FakeResizeObserver.instances).toHaveLength(1);
  FakeResizeObserver.instances[0].fire(640, 480);
  expect(el.width).toBe(640);

  canvas.setViewport(null);
  expect(FakeResizeObserver.instances[0].disconnected).toBe(true);
  expect(el.style.width).toBe(`${layout.width * 10 + 12}px`);
  expect(canvas.getView()).toEqual({ scale: 1, x: 6, y: 6 });
});

test("a measurement closes an open value field, and a view kept across it drives nothing", async () => {
  const rt = await load("rom_lookup.wasm");
  const changes: unknown[] = [];
  const canvas = new CircCanvas(rt, { viewport: "parent", onPinChange: (...a) => changes.push(a) });
  const el = stub.created[0];
  const ro = FakeResizeObserver.instances[0];
  ro.fire(600, 400);
  mountAt(el, 600, 400);
  const pc = pin(canvas, "pc");
  const box = canvas.boxOf(pc.id)!;
  el.dispatchEvent("click", { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 });
  expect(stub.dialogs).toHaveLength(1);
  ro.fire(700, 400);
  expect(stub.dialogs[0].removed).toBe(true);
  expect(changes).toEqual([]);
});

test("without ResizeObserver, viewport: parent still draws at the grid's size", async () => {
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  const rt = await load("half_adder.wasm");
  const canvas = new CircCanvas(rt, { interactive: false, cell: 10, padding: 6, viewport: "parent" });
  expect(canvas.getView()).toEqual({ scale: 1, x: 6, y: 6 });
  expect(stub.created[0].style.width).toBe("100%");
});
