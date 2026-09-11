// The padding a host asks for is in CSS pixels, and has to come out that way
// on a high-density display. The transform's translation is in device pixels,
// so it scales with the ratio; before this a 2x display drew the grid half a
// padding up and left of where the hit-test looked for it, and a mark drawn
// above the top row — a value chip — was cut at the canvas edge.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CircRuntime } from "../src/wasm/runtime";
import { CircCanvas } from "../src/render/canvas";
import { installStubDocument } from "./canvas-stub";

const FIX = join(import.meta.dir, "fixtures");
let stub: ReturnType<typeof installStubDocument>;
let transforms: number[][];

beforeEach(() => {
  stub = installStubDocument();
  transforms = [];
  const create = stub.document.createElement.bind(stub.document);
  stub.document.createElement = (tag: string) => {
    const el = create(tag) as { getContext: (kind: string) => unknown };
    if (tag === "canvas") {
      const ctx = el.getContext("2d") as Record<string, unknown>;
      ctx.setTransform = (...args: number[]) => { transforms.push(args); };
      el.getContext = () => ctx;
    }
    return el;
  };
});
afterEach(() => {
  stub.uninstall();
});

async function halfAdder() {
  return CircRuntime.loadFromBytes(new Uint8Array(readFileSync(join(FIX, "half_adder.wasm"))));
}

test("the padding is in CSS pixels whatever the device pixel ratio", async () => {
  const rt = await halfAdder();
  for (const dpr of [1, 2, 3]) {
    stub.window.devicePixelRatio = dpr;
    transforms = [];
    const canvas = new CircCanvas(rt, { interactive: false, cell: 14, padding: 28 });
    // The first transform is the resize's; the draw's own is the identity clear.
    const [a, b, c, d, e, f] = transforms[0];
    expect([a, b, c, d]).toEqual([dpr, 0, 0, dpr]);
    expect([e, f]).toEqual([28 * dpr, 28 * dpr]);
    // The element is sized in CSS pixels with the padding on every side, and
    // its backing store scaled by the ratio.
    const layout = canvas.getLayout();
    expect(canvas.canvas.style.width).toBe(`${layout.width * 14 + 56}px`);
    expect(canvas.canvas.width).toBe(Math.round((layout.width * 14 + 56) * dpr));
  }
});

test("a box reports where it is drawn, padding included, at any ratio", async () => {
  const rt = await halfAdder();
  stub.window.devicePixelRatio = 2;
  const canvas = new CircCanvas(rt, { interactive: false, cell: 10, padding: 20 });
  const a = canvas.getLayout().components.find((c) => c.name === "a")!;
  const box = canvas.boxOf(a.id)!;
  // boxOf is CSS pixels relative to the element: the grid origin is one
  // padding in, the same padding the transform now places it at.
  expect(box.x).toBe(a.x * 10 + 20);
  expect(box.y).toBe(a.y * 10 + 20);
});
