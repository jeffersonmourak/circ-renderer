import { type BitValue, type ComponentKind, type Signal, signalOf, widthMask } from "../wasm/topology";
import type { PlacedComponent, RoutedWire } from "../layout/types";

export type ThemeColorKey =
  | "background"
  | "grid"
  | "stroke"
  | "fillIdle"
  | "fillActive"
  | "fillUndefined"
  | "wireIdle"
  | "wireActive"
  | "wireUndefined"
  | "wireBus"
  | "busLabel"
  | "label"
  | "labelMuted"
  | "macro";

export const defaultColors: Record<ThemeColorKey, string> = {
  background: "#f8f9fa",
  grid: "#e9ecef",
  stroke: "#212529",
  fillIdle: "#ffffff",
  fillActive: "#28a745",
  fillUndefined: "#adb5bd",
  wireIdle: "#495057",
  wireActive: "#28a745",
  wireUndefined: "#ced4da",
  // Multi-bit (width > 1) bus nets carrying a fully-defined value.
  wireBus: "#1971c2",
  // Text color for bus value badges (e.g. `0x0F`).
  busLabel: "#1971c2",
  label: "#212529",
  labelMuted: "#868e96",
  macro: "#6f42c1",
};

export type SignalStyle = "idle" | "active" | "undefined";

export const styleForSignal = (s: Signal): SignalStyle =>
  s === 1 ? "active" : s === 0 ? "idle" : "undefined";

/** Wire-render style, extending the tri-state set with a bus (width > 1) case. */
export type WireStyle = SignalStyle | "bus";

/**
 * Pick a wire style from a width-aware value: width-1 nets reduce to the
 * tri-state styles; wider nets are `bus` when fully defined and `undefined`
 * if any bit is unknown.
 */
export const wireStyleOf = (v: BitValue): WireStyle => {
  if (v.width <= 1) return styleForSignal(signalOf(v));
  const mask = widthMask(v.width);
  if ((v.defined & mask) !== mask) return "undefined";
  return "bus";
};

/** Theme color key for a wire style. */
export const wireColorKey = (style: WireStyle): ThemeColorKey =>
  style === "active" ? "wireActive"
    : style === "idle" ? "wireIdle"
    : style === "bus" ? "wireBus"
    : "wireUndefined";

export interface SkinContext<C extends string = ThemeColorKey> {
  ctx: CanvasRenderingContext2D;
  theme: CircTheme<C>;
  cell: number;
  component: PlacedComponent;
  /** Collapsed tri-state per input port (declaration order). */
  inputSignals: Signal[];
  /** Collapsed tri-state of the output. */
  outputSignal: Signal;
  /** Width-aware value per input port (declaration order). */
  inputValues: BitValue[];
  /** Width-aware value of the output. */
  outputValue: BitValue;
  hovered: boolean;
}

export interface WireDrawContext<C extends string = ThemeColorKey> {
  ctx: CanvasRenderingContext2D;
  theme: CircTheme<C>;
  cell: number;
  wire: RoutedWire;
  signal: Signal;
  /** Width-aware value carried by the wire's source net. */
  value: BitValue;
  /**
   * Suggested vertical-bias TIER for parallel-horizontal separation.
   * `0` = no conflict, draw on grid; `1+` = shift by N rows of sub-cell
   * offset to keep distinct from other wires at the same y. Computed by
   * the renderer from actual H-on-H overlaps, so themes can avoid bending
   * wires that don't need it.
   */
  conflictTier: number;
}

export interface BackgroundContext<C extends string = ThemeColorKey> {
  ctx: CanvasRenderingContext2D;
  theme: CircTheme<C>;
  cell: number;
  width: number;
  height: number;
}

export interface PortMarkerContext<C extends string = ThemeColorKey> {
  ctx: CanvasRenderingContext2D;
  theme: CircTheme<C>;
  cell: number;
  /** Port location in CELL coordinates (cell-center is at (x+0.5, y+0.5)). */
  x: number;
  y: number;
  signal: Signal;
  /** "source" = wire-leaving end, "destination" = wire-arriving end. */
  side: "source" | "destination";
}

export type Skin<C extends string = ThemeColorKey> = (
  ctx: SkinContext<C>
) => void;

export interface CircTheme<C extends string = ThemeColorKey> {
  colors: Record<C, string>;
  font?: string;
  /**
   * Skin overrides per primitive component kind. Subcircuit boxes always
   * fall back to the macro skin if no `subcircuit` entry is supplied.
   */
  skins?: Partial<Record<ComponentKind | "subcircuit", Skin<C>>>;
  background?: (args: BackgroundContext<C>) => void;
  wire?: (args: WireDrawContext<C>) => void;
  /**
   * Override how port endpoints (the dots/arrows where wires meet boxes)
   * are drawn. Called once per source port AFTER all wires + components
   * are drawn, then once per destination port. If absent, the default
   * unfilled-circle + filled-arrow pair is drawn.
   */
  portMarker?: (args: PortMarkerContext<C>) => void;
}

export const baseTheme: CircTheme = {
  colors: defaultColors,
  font: '500 8px "JetBrains Mono", ui-monospace, monospace',
};
