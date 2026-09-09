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
