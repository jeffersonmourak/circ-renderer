/**
 * circ-renderer — render and simulate the WASM artifacts produced by
 * `circ-compiler` in the browser.
 *
 *   import { renderCircuit } from "circ-renderer";
 *   const view = await renderCircuit({ url: "./adder.wasm" });
 *   document.body.appendChild(view.canvas);
 */

import { CircRuntime, type LoadOptions } from "./wasm/runtime";
import { CircCanvas, type RenderOptions } from "./render/canvas";

export * from "./wasm/topology";
export { CircRuntime } from "./wasm/runtime";
export type { LoadOptions } from "./wasm/runtime";

export {
  buildLayout,
  collapse,
  assignColumns,
  assignRows,
  place,
  route,
} from "./layout";
export type {
  LayoutGrid,
  LayoutOptions,
  PlacedComponent,
  RoutedWire,
  Segment,
  PortCoord,
  PortSlot,
  VirtualGraph,
  VirtualNode,
  NodeKind,
} from "./layout";

export { CircCanvas } from "./render/canvas";
export type { RenderOptions } from "./render/canvas";

export {
  baseTheme,
  defaultColors,
  styleForSignal,
  type CircTheme,
  type ThemeColorKey,
  type Skin,
  type SkinContext,
  type WireDrawContext,
  type BackgroundContext,
  type PortMarkerContext,
  type SignalStyle,
} from "./utils/theme";

export { defaultSkins } from "./render/skins";

export interface RenderCircuitOptions<C extends string = string>
  extends RenderOptions<C> {
  /** WASM source — exactly one of these must be provided. */
  url?: string;
  bytes?: Uint8Array;
  load?: LoadOptions;
}

export interface CircView<C extends string = string> {
  runtime: CircRuntime;
  view: CircCanvas<C>;
  canvas: HTMLCanvasElement;
  destroy(): void;
}

export async function renderCircuit<C extends string = string>(
  opts: RenderCircuitOptions<C>
): Promise<CircView<C>> {
  if (!opts.url && !opts.bytes) {
    throw new Error("renderCircuit: provide either `url` or `bytes`");
  }
  const runtime = opts.bytes
    ? await CircRuntime.loadFromBytes(opts.bytes, opts.load)
    : await CircRuntime.loadFromUrl(opts.url!, opts.load);

  const view = new CircCanvas<C>(runtime, opts);
  return {
    runtime,
    view,
    canvas: view.canvas,
    destroy() {
      view.destroy();
      runtime.destroy();
    },
  };
}
