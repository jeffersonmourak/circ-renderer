import { type BitValue, type ComponentKind, type Signal, signalOf, widthMask } from "../wasm/topology";
import type { PlacedComponent, RoutedWire } from "../layout/types";

export type ThemeColorKey =
  | "background"
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
  | "macro"
  | "highlight";

export const defaultColors: Record<ThemeColorKey, string> = {
  background: "#f8f9fa",
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
  // The ring drawn around a hovered or host-highlighted component.
  highlight: "#f59f00",
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

/**
 * What a theme is handed to mark one fan-out junction: a cell where three or
 * more segments of one source's wires meet, so a signal visibly splits there.
 * Called once per junction, after every skin and before the port markers, in
 * place of the default dot.
 */
export interface FanOutMarkerContext<C extends string = ThemeColorKey> {
  ctx: CanvasRenderingContext2D;
  theme: CircTheme<C>;
  cell: number;
  /** Junction cell, in CELL coordinates (cell-center is at (x+0.5, y+0.5)). */
  x: number;
  y: number;
  /** Width-aware value the fan-out group carries, and its collapsed signal. */
  value: BitValue;
  signal: Signal;
}

/**
 * What a theme is handed to draw the highlight on one component. It is drawn
 * once per highlighted component, after every skin, marker and badge, so it
 * sits on top of whatever the skin drew.
 */
export interface HighlightContext<C extends string = ThemeColorKey> {
  ctx: CanvasRenderingContext2D;
  theme: CircTheme<C>;
  cell: number;
  component: PlacedComponent;
  /** Why it is highlighted: the pointer is over it, the host asked, or both. */
  reason: "hover" | "highlight" | "both";
}

export type Skin<C extends string = ThemeColorKey> = (
  ctx: SkinContext<C>
) => void;

/**
 * What a theme is handed to draw one bus value badge. `text` is already
 * formatted in the canvas's value format, so a theme that only wants to
 * restyle can draw it as given; one that wants another spelling has `value`.
 */
export interface BusValueContext<C extends string = ThemeColorKey> {
  ctx: CanvasRenderingContext2D;
  theme: CircTheme<C>;
  cell: number;
  component: PlacedComponent;
  value: BitValue;
  text: string;
}

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
  /**
   * Override how a fan-out junction is marked, or pass a no-op to mark none.
   * Called once per cell where three or more segments of one source's wires
   * meet. If absent, a filled dot of 0.18 cells is stamped in the wire's
   * colour.
   */
  fanOutMarker?: (args: FanOutMarkerContext<C>) => void;
  /**
   * Override how a multi-bit net's value badge is drawn above its box, or
   * pass a no-op to draw none. If absent, the value is written centred just
   * above the box in `busLabel`.
   */
  busValue?: (args: BusValueContext<C>) => void;
  /**
   * Override how a hovered or host-highlighted component is marked, or pass a
   * no-op to mark none. If absent, a ring is drawn around its box in
   * `highlight`. Drawn by the canvas after every skin, for every kind, so a
   * skin never has to read `hovered` itself — though it still may.
   */
  highlight?: (args: HighlightContext<C>) => void;
}

export const baseTheme: CircTheme = {
  colors: defaultColors,
  font: '500 8px "JetBrains Mono", ui-monospace, monospace',
};
