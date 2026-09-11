/**
 * The view: where the circuit sits in the element.
 *
 * The canvas draws in WORLD pixels, where the grid's top-left cell corner is
 * the origin and one layout cell is `cell` pixels. A view maps a world point
 * to a point in the element, in CSS pixels at the element's drawn size:
 *
 *     element = world * scale + (x, y)
 *
 * The default view is `{ scale: 1, x: padding, y: padding }`, which is the
 * one placement the canvas had before it could zoom: the grid one padding in
 * from the top-left corner, drawn at its natural size. Every zoom and pan is
 * a different view, and nothing else about the canvas moves.
 *
 * The helpers here are pure, so a test can pin the arithmetic without a
 * canvas and the gesture code cannot disagree with the API about it.
 */
export interface View {
  scale: number;
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

/** The zoom range a canvas keeps to unless a host widens it. */
export const DEFAULT_ZOOM = { min: 0.25, max: 8 } as const;

export function clampScale(scale: number, min: number, max: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return min;
  return Math.min(max, Math.max(min, scale));
}

export function sameView(a: View, b: View): boolean {
  return a.scale === b.scale && a.x === b.x && a.y === b.y;
}

/**
 * Zoom by `factor` about an element point, so the world point under it stays
 * under it. This is what keeps the pin a reader is looking at from sliding
 * away as they zoom: the point they aimed at is the one that does not move.
 */
export function zoomAbout(view: View, factor: number, px: number, py: number, min: number, max: number): View {
  const scale = clampScale(view.scale * factor, min, max);
  const k = scale / view.scale;
  return { scale, x: px - (px - view.x) * k, y: py - (py - view.y) * k };
}

/**
 * The view that shows the whole grid, centred, with `padding` kept clear on
 * every side. At the element's natural size this is the default view, so
 * `fit` after a zoom is a way back that a host can offer without knowing the
 * padding.
 */
export function fitView(grid: Size, viewport: Size, padding: number, min: number, max: number): View {
  const gw = Math.max(1, grid.width);
  const gh = Math.max(1, grid.height);
  const roomW = Math.max(1, viewport.width - padding * 2);
  const roomH = Math.max(1, viewport.height - padding * 2);
  const scale = clampScale(Math.min(roomW / gw, roomH / gh), min, max);
  return {
    scale,
    x: (viewport.width - gw * scale) / 2,
    y: (viewport.height - gh * scale) / 2,
  };
}

/** The world rectangle the viewport shows under a view. */
export function visibleWorld(view: View, viewport: Size): { x: number; y: number; width: number; height: number } {
  return {
    x: -view.x / view.scale,
    y: -view.y / view.scale,
    width: viewport.width / view.scale,
    height: viewport.height / view.scale,
  };
}
