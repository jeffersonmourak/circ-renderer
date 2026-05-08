import type { ComponentKind, Signal } from "../wasm/topology";
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
  label: "#212529",
  labelMuted: "#868e96",
  macro: "#6f42c1",
};

export type SignalStyle = "idle" | "active" | "undefined";

export const styleForSignal = (s: Signal): SignalStyle =>
  s === 1 ? "active" : s === 0 ? "idle" : "undefined";

export interface SkinContext<C extends string = ThemeColorKey> {
  ctx: CanvasRenderingContext2D;
  theme: CircTheme<C>;
  cell: number;
  component: PlacedComponent;
  inputSignals: Signal[];
  outputSignal: Signal;
  hovered: boolean;
}

export interface WireDrawContext<C extends string = ThemeColorKey> {
  ctx: CanvasRenderingContext2D;
  theme: CircTheme<C>;
  cell: number;
  wire: RoutedWire;
  signal: Signal;
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
