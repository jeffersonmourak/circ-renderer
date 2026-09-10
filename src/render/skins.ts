import { ComponentKind, type Signal } from "../wasm/topology";
import {
  type CircTheme,
  type Skin,
  type SkinContext,
  type ThemeColorKey,
  styleForSignal,
} from "../utils/theme";
import { isPrimitive } from "../layout/types";
import { memoryLabel } from "../layout/sizing";

/** Resolve a single theme color, falling back to a sentinel if missing. */
export const color = <C extends string>(theme: CircTheme<C>, key: C, fallback = "#000"): string =>
  theme.colors[key] ?? fallback;

/** The box fill for a signal: `fillActive`, `fillIdle` or `fillUndefined`. */
export const fill = <C extends string>(theme: CircTheme<C>, sig: Signal): string => {
  const k: ThemeColorKey = (
    styleForSignal(sig) === "active" ? "fillActive"
      : styleForSignal(sig) === "idle" ? "fillIdle"
      : "fillUndefined"
  );
  return color(theme as CircTheme<string>, k as string, "#fff");
};

export const stroke = <C extends string>(theme: CircTheme<C>): string =>
  color(theme as CircTheme<string>, "stroke" as string, "#222");

export const labelColor = <C extends string>(theme: CircTheme<C>): string =>
  color(theme as CircTheme<string>, "label" as string, "#222");

/**
 * Box rectangle in *cell* units → fills by signal then strokes the border.
 *
 * Exported, with `drawLabel` and `memoryLabel`, so a host can build a rom, ram,
 * slice or concat skin in its own palette from the same pieces the defaults
 * are built from, rather than re-deriving the geometry.
 */
export function boxOutline<C extends string>(
  ctx: CanvasRenderingContext2D,
  theme: CircTheme<C>,
  cell: number,
  x: number, y: number,
  w: number, h: number,
  signal: Signal
) {
  ctx.fillStyle = fill(theme, signal);
  ctx.strokeStyle = stroke(theme);
  ctx.lineWidth = Math.max(1, cell * 0.12);
  const px = x * cell;
  const py = y * cell;
  const pw = w * cell;
  const ph = h * cell;
  const r = Math.min(cell * 0.4, pw / 2, ph / 2);
  ctx.beginPath();
  ctx.roundRect(px + ctx.lineWidth / 2, py + ctx.lineWidth / 2, pw - ctx.lineWidth, ph - ctx.lineWidth, r);
  ctx.fill();
  ctx.stroke();
}

export function drawLabel<C extends string>(
  ctx: CanvasRenderingContext2D,
  theme: CircTheme<C>,
  cell: number,
  text: string,
  cx: number, cy: number
) {
  ctx.fillStyle = labelColor(theme);
  ctx.font = (theme as CircTheme<string>).font ?? `${Math.round(cell * 1.1)}px ui-monospace, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, cx, cy);
}

export { memoryLabel };

export const drawPin: Skin<ThemeColorKey> = ({ ctx, theme, cell, component, outputSignal }) => {
  boxOutline(ctx, theme, cell, component.x, component.y, component.width, component.height, outputSignal);
  drawLabel(
    ctx, theme, cell,
    component.name || "pin",
    (component.x + component.width / 2) * cell,
    (component.y + component.height / 2) * cell
  );
};

export const drawOutputPin: Skin<ThemeColorKey> = ({ ctx, theme, cell, component, inputSignals }) => {
  const sig = inputSignals[0] ?? 2;
  boxOutline(ctx, theme, cell, component.x, component.y, component.width, component.height, sig);
  drawLabel(
    ctx, theme, cell,
    component.name || "out",
    (component.x + component.width / 2) * cell,
    (component.y + component.height / 2) * cell
  );
};

export const drawNot: Skin<ThemeColorKey> = ({ ctx, theme, cell, component, outputSignal }) => {
  // Triangle + bubble. Cell is 5×3.
  const x0 = component.x * cell;
  const y0 = component.y * cell;
  const w = component.width * cell;
  const h = component.height * cell;
  ctx.fillStyle = fill(theme, outputSignal);
  ctx.strokeStyle = stroke(theme);
  ctx.lineWidth = Math.max(1, cell * 0.12);
  ctx.beginPath();
  // Triangle pointing right, body uses cells 0..3, bubble at cell 4.
  const triRight = x0 + w * 0.78;
  ctx.moveTo(x0 + cell * 0.2, y0 + h * 0.18);
  ctx.lineTo(x0 + cell * 0.2, y0 + h * 0.82);
  ctx.lineTo(triRight, y0 + h / 2);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  const bubbleR = Math.min(cell * 0.3, h * 0.18);
  ctx.beginPath();
  ctx.arc(triRight + bubbleR + cell * 0.05, y0 + h / 2, bubbleR, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
};

export const drawAnd: Skin<ThemeColorKey> = ({ ctx, theme, cell, component, outputSignal }) => {
  // D-shape silhouette in 5×5.
  const x0 = component.x * cell;
  const y0 = component.y * cell;
  const w = component.width * cell;
  const h = component.height * cell;
  ctx.fillStyle = fill(theme, outputSignal);
  ctx.strokeStyle = stroke(theme);
  ctx.lineWidth = Math.max(1, cell * 0.12);
  const left = x0 + cell * 0.15;
  const top = y0 + cell * 0.15;
  const bot = y0 + h - cell * 0.15;
  const flat = x0 + w * 0.5;
  const right = x0 + w - cell * 0.15;
  ctx.beginPath();
  ctx.moveTo(left, top);
  ctx.lineTo(flat, top);
  ctx.bezierCurveTo(right, top, right, bot, flat, bot);
  ctx.lineTo(left, bot);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
};

export const drawLed: Skin<ThemeColorKey> = ({ ctx, theme, cell, component, inputSignals }) => {
  const sig = inputSignals[0] ?? 2;
  const x0 = component.x * cell;
  const y0 = component.y * cell;
  const w = component.width * cell;
  const h = component.height * cell;
  const cx = x0 + w / 2;
  const cy = y0 + h / 2;
  const r = Math.min(w, h) * 0.4;
  ctx.fillStyle = fill(theme, sig);
  ctx.strokeStyle = stroke(theme);
  ctx.lineWidth = Math.max(1, cell * 0.14);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  if (sig === 1) {
    // Inner glow ring.
    ctx.strokeStyle = color(theme as CircTheme<string>, "fillActive" as string, "#28a745");
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = Math.max(1, cell * 0.3);
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
};

export const drawSlice: Skin<ThemeColorKey> = ({ ctx, theme, cell, component, outputSignal }) => {
  boxOutline(ctx, theme, cell, component.x, component.y, component.width, component.height, outputSignal);
  const { lo, hi } = component.slice ?? { lo: 0, hi: 1 };
  const label = hi - lo <= 1 ? `[${lo}]` : `[${lo}:${hi}]`;
  drawLabel(
    ctx, theme, cell, label,
    (component.x + component.width / 2) * cell,
    (component.y + component.height / 2) * cell
  );
};

export const drawConcat: Skin<ThemeColorKey> = ({ ctx, theme, cell, component, outputSignal }) => {
  boxOutline(ctx, theme, cell, component.x, component.y, component.width, component.height, outputSignal);
  drawLabel(
    ctx, theme, cell, "{·}",
    (component.x + component.width / 2) * cell,
    (component.y + component.height / 2) * cell
  );
};

export const drawSubcircuit: Skin<ThemeColorKey> = ({ ctx, theme, cell, component }) => {
  const x0 = component.x * cell;
  const y0 = component.y * cell;
  const w = component.width * cell;
  const h = component.height * cell;
  ctx.fillStyle = fill(theme, 2);
  ctx.strokeStyle = color(theme as CircTheme<string>, "macro" as string, "#6f42c1");
  ctx.lineWidth = Math.max(1, cell * 0.12);
  const r = cell * 0.25;
  ctx.beginPath();
  ctx.roundRect(
    x0 + ctx.lineWidth / 2,
    y0 + ctx.lineWidth / 2,
    w - ctx.lineWidth,
    h - ctx.lineWidth,
    r
  );
  ctx.fill();
  ctx.stroke();

  if (!isPrimitive(component.kind) && component.kind.tag === "subcircuit") {
    const label = `${component.kind.subcircuit}:${component.name}`;
    drawLabel(ctx, theme, cell, label, x0 + w / 2, y0 + h / 2);
  }
};

/** Memory box: macro-coloured border, `rom code[8,4]` label, fill by output signal. */
export const drawMemory: Skin<ThemeColorKey> = ({ ctx, theme, cell, component, outputSignal }) => {
  boxOutline(ctx, theme, cell, component.x, component.y, component.width, component.height, outputSignal);
  ctx.strokeStyle = color(theme as CircTheme<string>, "macro" as string, "#6f42c1");
  ctx.lineWidth = Math.max(1, cell * 0.12);
  const px = component.x * cell, py = component.y * cell;
  const pw = component.width * cell, ph = component.height * cell;
  ctx.beginPath();
  ctx.roundRect(px + ctx.lineWidth / 2, py + ctx.lineWidth / 2, pw - ctx.lineWidth, ph - ctx.lineWidth, cell * 0.25);
  ctx.stroke();
  if (isPrimitive(component.kind)) {
    const label = memoryLabel(component.kind.kind, component.name, component.bitWidth, component.memory?.addrWidth ?? 0);
    drawLabel(ctx, theme, cell, label, px + pw / 2, py + ph / 2);
  }
};

export const defaultSkins: Required<NonNullable<CircTheme<ThemeColorKey>["skins"]>> = {
  [ComponentKind.InputPin]: drawPin,
  [ComponentKind.OutputPin]: drawOutputPin,
  [ComponentKind.NotGate]: drawNot,
  [ComponentKind.AndGate]: drawAnd,
  [ComponentKind.Led]: drawLed,
  [ComponentKind.Wire]: () => {}, // wires are collapsed; never drawn as a component
  [ComponentKind.Slice]: drawSlice,
  [ComponentKind.Concat]: drawConcat,
  [ComponentKind.Rom]: drawMemory,
  [ComponentKind.Ram]: drawMemory,
  subcircuit: drawSubcircuit,
};

export function pickSkin<C extends string>(
  theme: CircTheme<C>,
  ctxArg: SkinContext<C>
): Skin<C> {
  const overrides = theme.skins ?? {};
  if (isPrimitive(ctxArg.component.kind)) {
    const k = ctxArg.component.kind.kind;
    return (overrides[k] as Skin<C> | undefined) ?? (defaultSkins[k] as unknown as Skin<C>);
  }
  return (overrides.subcircuit as Skin<C> | undefined) ?? (defaultSkins.subcircuit as unknown as Skin<C>);
}
