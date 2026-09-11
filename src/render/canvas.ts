import { buildLayout, type LayoutGrid, type LayoutOptions, type PlacedComponent, type RoutedWire } from "../layout";
import { isPrimitive } from "../layout/types";
import { type BitValue, ComponentKind, type Signal, portByteOfName, signalOf, undefinedValue, widthMask } from "../wasm/topology";
import type { CircRuntime } from "../wasm/runtime";
import {
  baseTheme,
  type CircTheme,
  type ThemeColorKey,
  wireColorKey,
  wireStyleOf,
} from "../utils/theme";
import { pickSkin } from "./skins";
import { entryLength, formatPinValue, parsePinValue, type ValueFormat } from "./pin-value";
import { defaultArcRadius, traceWire } from "./wire-path";
import {
  DEFAULT_ZOOM,
  type Size,
  type View,
  clampScale,
  fitView,
  sameView,
  visibleWorld,
  zoomAbout,
} from "./view";

/**
 * What a host receives when a reader clicks a multi-bit pin and the host has
 * asked to handle the entry itself. `box` is in CSS pixels relative to the
 * canvas element, so a host can anchor its own field over the pin.
 */
export interface PinEditRequest {
  id: number;
  value: BitValue;
  box: { x: number; y: number; width: number; height: number };
  /** Drive the pin and close. Masked to the pin's width. */
  commit: (value: bigint, defined: bigint) => void;
  cancel: () => void;
}

/**
 * The cells where a group of wires from one source branch: every cell the
 * union of their segments leaves in three or more directions. Sorted
 * `"x,y"` keys, so a caller draws in a stable order.
 */
export function junctionCells(group: readonly RoutedWire[]): string[] {
  const neighbours = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!neighbours.has(a)) neighbours.set(a, new Set());
    neighbours.get(a)!.add(b);
  };
  for (const w of group) {
    for (const seg of w.segments) {
      const dx = Math.sign(seg.to.x - seg.from.x);
      const dy = Math.sign(seg.to.y - seg.from.y);
      const len = Math.max(Math.abs(seg.to.x - seg.from.x), Math.abs(seg.to.y - seg.from.y));
      for (let k = 0; k < len; k++) {
        const a = `${seg.from.x + dx * k},${seg.from.y + dy * k}`;
        const b = `${seg.from.x + dx * (k + 1)},${seg.from.y + dy * (k + 1)}`;
        link(a, b);
        link(b, a);
      }
    }
  }
  const out: string[] = [];
  for (const [key, set] of neighbours) if (set.size >= 3) out.push(key);
  return out.sort();
}

export interface RenderOptions<C extends string = ThemeColorKey> {
  /** Pixel width of one layout cell. Default 12. */
  cell?: number;
  /** Theme. Defaults to `baseTheme`. */
  theme?: CircTheme<C>;
  /** Re-layout if topology changes (currently topology is static). */
  layoutOptions?: LayoutOptions;
  /** Outer pixel padding around the grid. Default 4. */
  padding?: number;
  /** When true, the canvas pointer can toggle input-pin states. */
  interactive?: boolean;
  /**
   * Called after a click toggled an input pin. Hosts that rebuild the canvas
   * (theme flips, recompiles) record pins here and replay them through
   * `setInputSignal` on the fresh instance.
   */
  onPinToggle?: (id: number, signal: Signal) => void;
  /**
   * Called after a reader changed an input pin, with its whole value: a
   * width-1 toggle, or a value typed into a bus pin. This is the callback to
   * mirror, and `getInputValue` is the other way to read the same thing.
   * `onPinToggle` is kept for hosts that predate it, and is LOSSY for a bus —
   * it reports `signalOf(value)`, which collapses any mixed bus to High.
   * Neither fires for a host's own `setInputValue` / `setInputSignal` call.
   */
  onPinChange?: (id: number, value: BitValue) => void;
  /**
   * Called when a reader clicks a pin wider than one bit. Return `true` to
   * say the host has opened its own editor; the built-in field then stays
   * closed. Return nothing to let the canvas open its field as usual.
   */
  onPinEdit?: (req: PinEditRequest) => boolean | void;
  /**
   * The base a bare (unprefixed) typed value is read in, and the base the bus
   * badge above each multi-bit box is written in. Default `hex`. An explicit
   * `0x` or `0b` in the field overrides it either way.
   */
  valueFormat?: ValueFormat;
  /**
   * Called when the pointer moves onto a different component box, and with
   * `null` when it leaves the canvas. Fires only on a change, so a host can
   * drive an editor highlight straight from it without debouncing.
   *
   * Ids are LAYOUT ids: a collapsed subcircuit box carries a synthetic id that
   * does not exist in `runtime.topology.components`, so resolve it through
   * `getLayout()` rather than through the topology.
   */
  onHover?: (id: number | null) => void;
  /**
   * Called after the view changed: a zoom, a pan, a `fit`, a reset. Fires
   * only on a change and never for the view a canvas is built with, so a host
   * can keep its zoom label or its saved view in step without a debounce.
   * Nothing about the simulation is reported here; a view change drives no
   * pin and fires no pin callback.
   */
  onViewChange?: (view: View) => void;
  /** The zoom range `setView` and `zoomBy` keep to. Default 0.25 and 8. */
  minZoom?: number;
  maxZoom?: number;
  /**
   * The gestures that move the view. On by default, with the defaults in
   * `NavigationOptions`; `false` attaches none, and the view then moves only
   * through the API. Independent of `interactive`: a canvas that takes no pin
   * clicks can still be zoomed.
   */
  navigation?: boolean | NavigationOptions;
}

/**
 * Which gestures move the view. Each is chosen so that it cannot be mistaken
 * for a click on a pin, or take a gesture the page needs.
 */
export interface NavigationOptions {
  /**
   * Which wheel zooms, about the pointer. `modifier` (default): a wheel with
   * Ctrl or ⌘ held, which is also what a trackpad pinch arrives as; a plain
   * wheel stays the page's, so a reader can scroll past the canvas. `always`:
   * every wheel, for a host whose pane the canvas fills. `off`: none.
   */
  wheel?: "modifier" | "always" | "off";
  /**
   * A drag with the primary or middle mouse button pans. Default true. A
   * press that moves less than four pixels is a click, and reaches the pin
   * under it exactly as before; one that moves further is a pan, and the
   * click the browser fires after it is swallowed.
   */
  drag?: boolean;
  /**
   * What a touch does. `page` (default): one finger is the page's — it
   * scrolls, and a tap clicks a pin — and two fingers pinch to zoom and pan.
   * `own`: one finger pans too, for a host whose pane the canvas fills and
   * that has nowhere else to scroll.
   */
  touch?: "page" | "own";
}

/** A press becomes a pan once it has moved this far, in CSS pixels. */
const DRAG_THRESHOLD = 4;

const DEFAULTS = { cell: 12, padding: 4 };

export class CircCanvas<C extends string = ThemeColorKey> {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private layout: LayoutGrid;
  private signals = new Map<number, BitValue>();
  /** What the canvas drove each root input pin to. Width-aware, so a bus
   *  value survives a click on a neighbouring width-1 pin. */
  private inputState = new Map<number, BitValue>();
  /** The open value editor, if any. One at a time: opening a second closes
   *  the first uncommitted, the way a reader would expect. */
  private editor: { id: number; root: HTMLElement; off: () => void } | null = null;
  private hoverId: number | null = null;
  /** Host-driven highlight, kept apart from `hoverId` so the canvas's own
   *  pointer bookkeeping can never clobber it. */
  private highlightId: number | null = null;
  private listeners: Array<() => void> = [];
  /**
   * Where the circuit sits in the element; see `View`. The one place the
   * placement is kept: the transform, the hit-test and `boxOf` each read it,
   * so a zoom cannot move the picture without moving where a click lands.
   */
  private view: View = { scale: 1, x: 0, y: 0 };
  /** Every pointer down on the canvas, by id, in CSS pixels of the rendered
   *  rect. Two at once is a pinch. */
  private pointers = new Map<number, { x: number; y: number }>();
  /**
   * The gesture in progress. A `press` is a pointer down that has not yet
   * moved far enough to be a pan, and may still be a click; a `pan` and a
   * `pinch` move the view and end with the trailing click swallowed. Pinch
   * keeps its starting view and its starting pair, so each move is computed
   * from the start rather than accumulated, and cannot drift.
   */
  private gesture:
    | { kind: "press"; id: number; x: number; y: number }
    | { kind: "pan"; id: number; x: number; y: number }
    | { kind: "pinch"; view: View; mid: { x: number; y: number }; dist: number }
    | null = null;
  /** Set when a pan or a pinch ends, so the click the browser fires next
   *  reaches no pin. Consumed by that click, or by the next pointer down. */
  private swallowClick = false;

  /** Per-wire value (snapshot of source's output). Recomputed on refresh. */
  private wireValue = new Map<number, BitValue>();
  /**
   * Per-wire conflict tier for theme-driven sub-cell bias. 0 = no
   * horizontal-on-horizontal collision; 1+ = collides with a wire from
   * a different source at the same row. Stable across draws so themes
   * that bend wires for visual separation only do so where it helps.
   */
  private wireTier = new Map<number, number>();
  /**
   * Map from a component id (real or synthetic subcircuit) to the real
   * primitive that drives its outgoing wires. For real components this is
   * the component itself; for collapsed subcircuits it's the inner gate
   * that feeds the subcircuit's external connections. Lets the renderer
   * read settled signals for synth nodes that aren't in the runtime.
   */
  private realDriverByComp = new Map<number, number>();

  constructor(
    private runtime: CircRuntime,
    private options: RenderOptions<C> = {}
  ) {
    this.layout = buildLayout(runtime.topology, options.layoutOptions ?? {});
    this.canvas = document.createElement("canvas");
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("CircCanvas: 2d context unavailable");
    this.ctx = ctx;
    this.view = this.defaultView();
    this.resize();
    this.computeWireTiers();
    for (const w of this.layout.wires) {
      if (!this.realDriverByComp.has(w.srcId)) {
        this.realDriverByComp.set(w.srcId, w.realSrcId);
      }
    }
    // The gestures first: on one pointer move, the gesture decides whether the
    // view is moving before the hover asks.
    if (options.navigation !== false) this.attachNavigation();
    if (options.interactive ?? true) this.attach();
    this.refreshState();
  }

  /**
   * Walk all horizontal segments grouped by row. For any pair of H
   * segments from DIFFERENT sources whose x-ranges overlap, mark the
   * higher-srcId wire as tier 1. Themes can use this hint to bias
   * wires off-grid only when a real collision exists, leaving other
   * wires straight.
   */
  private computeWireTiers(): void {
    this.wireTier.clear();
    type HSeg = { wireIdx: number; srcId: number; xMin: number; xMax: number };
    const segByRow = new Map<number, HSeg[]>();
    for (let i = 0; i < this.layout.wires.length; i++) {
      const w = this.layout.wires[i];
      for (const seg of w.segments) {
        if (seg.from.y !== seg.to.y) continue;
        const y = seg.from.y;
        const xMin = Math.min(seg.from.x, seg.to.x);
        const xMax = Math.max(seg.from.x, seg.to.x);
        let arr = segByRow.get(y);
        if (!arr) { arr = []; segByRow.set(y, arr); }
        arr.push({ wireIdx: i, srcId: w.srcId, xMin, xMax });
      }
    }
    for (const segs of segByRow.values()) {
      for (let i = 0; i < segs.length; i++) {
        for (let j = i + 1; j < segs.length; j++) {
          const a = segs[i], b = segs[j];
          if (a.srcId === b.srcId) continue;
          // Strict overlap: shared endpoint at a single x doesn't count
          // as a visual conflict, since segment endpoints are corners
          // already differentiated by their direction change.
          if (a.xMax <= b.xMin || b.xMax <= a.xMin) continue;
          // Different sources, overlapping H — bump the higher-srcId one.
          const loser = a.srcId > b.srcId ? a.wireIdx : b.wireIdx;
          if ((this.wireTier.get(loser) ?? 0) < 1) this.wireTier.set(loser, 1);
        }
      }
    }
  }

  private get cell(): number { return this.options.cell ?? DEFAULTS.cell; }
  private get padding(): number { return this.options.padding ?? DEFAULTS.padding; }
  private get theme(): CircTheme<string> {
    return (this.options.theme as CircTheme<string> | undefined) ?? (baseTheme as CircTheme<string>);
  }
  private get valueFormat(): ValueFormat { return this.options.valueFormat ?? "hex"; }
  private get minZoom(): number { return this.options.minZoom ?? DEFAULT_ZOOM.min; }
  private get maxZoom(): number { return this.options.maxZoom ?? DEFAULT_ZOOM.max; }
  private get navigation(): Required<NavigationOptions> {
    const o = this.options.navigation;
    const given = typeof o === "object" && o !== null ? o : {};
    return { wheel: given.wheel ?? "modifier", drag: given.drag ?? true, touch: given.touch ?? "page" };
  }
  private get dpr(): number {
    return (typeof window !== "undefined" && window.devicePixelRatio) || 1;
  }

  // ---- changing the look of a live canvas -----------------------------------
  //
  // Every option below used to be captured at construction, so a host that
  // wanted a different theme had to destroy the canvas and build another — and
  // contents are runtime state of ONE instance, so the reader's toggled pins,
  // typed bus values and loaded memory images went with it. The drawing already
  // reads each option through a getter; these swap the option and redraw.

  /** Swap the theme in place and redraw. Nothing else changes: the runtime,
   *  its pins and its memories are untouched. */
  setTheme(theme: CircTheme<C>): void {
    this.options = { ...this.options, theme };
    this.draw();
  }

  /** Change the pixel size of a layout cell. The element resizes to match,
   *  and the view goes back to the default: a pan is measured in pixels of
   *  the old cell, and means nothing in the new one. */
  setCell(cell: number): void {
    this.options = { ...this.options, cell };
    this.relayout();
  }

  /** Change the padding around the grid. The element resizes to match, and
   *  the view goes back to the default, which the padding is part of. */
  setPadding(padding: number): void {
    this.options = { ...this.options, padding };
    this.relayout();
  }

  /** Resize the element for new metrics and start again from the default
   *  view, drawing exactly once either way. */
  private relayout(): void {
    this.resize();
    if (!this.changeView(this.defaultView())) this.draw();
  }

  // ---- the view: zoom and pan -----------------------------------------------
  //
  // A view is where the circuit sits in the element (`View`). Every method
  // below ends in `changeView`, the one funnel: it clamps the scale, ignores
  // a view equal to the current one, closes an open value field (the pin it
  // sat under has moved), re-applies the transform, redraws and tells the
  // host. None of them touch the runtime, drive a pin or fire a pin callback:
  // moving the picture is not a change to the circuit.

  /** The placement the canvas is built with: the grid one padding in, at its
   *  natural size. What `resetView` and `fit` at natural size return to. */
  private defaultView(): View {
    const pad = this.padding;
    return { scale: 1, x: pad, y: pad };
  }

  /** The current view, as a copy: changing it changes nothing. */
  getView(): View {
    return { ...this.view };
  }

  /**
   * Place the circuit. `scale` is clamped to `minZoom`..`maxZoom`; `x` and
   * `y` are the element point, in CSS pixels at the element's drawn size, that
   * the grid's top-left corner lands on. A view equal to the current one is a
   * no-op: nothing redraws and `onViewChange` stays silent.
   */
  setView(view: View): void {
    this.changeView(view);
  }

  /** Back to the default view. */
  resetView(): void {
    this.changeView(this.defaultView());
  }

  /**
   * Zoom by a factor (2 doubles, 0.5 halves) about a point in the element, in
   * CSS pixels relative to its rendered rect — the space `boxOf` reports in,
   * and what `clientX - rect.left` gives. The world point under `about` stays
   * where it is. Without `about`, the element's centre.
   */
  zoomBy(factor: number, about?: { x: number; y: number }): void {
    const ext = this.extent();
    let px = ext.width / 2;
    let py = ext.height / 2;
    if (about) {
      const p = this.intendedPoint(about.x, about.y);
      px = p.x;
      py = p.y;
    }
    this.changeView(zoomAbout(this.view, factor, px, py, this.minZoom, this.maxZoom));
  }

  /** Show the whole grid, centred, with the padding kept clear on every side.
   *  At the element's natural size this is the default view. */
  fit(): void {
    const { cell, layout } = this;
    const grid = { width: layout.width * cell, height: layout.height * cell };
    this.changeView(fitView(grid, this.extent(), this.padding, this.minZoom, this.maxZoom));
  }

  /** Apply a view if it differs from the current one. True when it did. */
  private changeView(view: View): boolean {
    const next: View = { scale: clampScale(view.scale, this.minZoom, this.maxZoom), x: view.x, y: view.y };
    if (sameView(next, this.view)) return false;
    this.view = next;
    // The field sat under a pin that has now moved; closing it is the same
    // rule it already follows for a scroll or a resize.
    this.closeEditor();
    this.applyView();
    this.draw();
    this.options.onViewChange?.(this.getView());
    return true;
  }

  /** The element's drawn size in CSS pixels: the grid plus its padding. */
  private extent(): Size {
    const { cell, padding, layout } = this;
    return { width: layout.width * cell + padding * 2, height: layout.height * cell + padding * 2 };
  }

  /**
   * Write the view into the context's transform. The scale is the view's
   * times the device pixel ratio; the translation is in DEVICE pixels, so the
   * view's offset — which is in CSS pixels, like the padding it defaults to —
   * is scaled by the ratio too.
   */
  private applyView(): void {
    const { dpr } = this;
    const { scale, x, y } = this.view;
    this.ctx.setTransform(dpr * scale, 0, 0, dpr * scale, x * dpr, y * dpr);
  }

  /**
   * A point in the element's rendered rect, in CSS pixels, mapped to the
   * element's drawn size. The renderer sizes the element in CSS pixels, but
   * page CSS (`max-width: 100%`) can shrink the rendered rect; the transform
   * and the view live in the drawn size, so everything the pointer says is
   * mapped there first.
   */
  private intendedPoint(ex: number, ey: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    const ext = this.extent();
    const sx = rect.width > 0 ? ext.width / rect.width : 1;
    const sy = rect.height > 0 ? ext.height / rect.height : 1;
    return { x: ex * sx, y: ey * sy };
  }

  /** A point in the element's drawn size, in CSS pixels, mapped to world
   *  pixels: the inverse of the view. */
  private toWorld(px: number, py: number): { x: number; y: number } {
    const { scale, x, y } = this.view;
    return { x: (px - x) / scale, y: (py - y) / scale };
  }

  /** Change the base the bus badges are written in and a bare typed value is
   *  read in. An open value field keeps the base it opened with. */
  setValueFormat(format: ValueFormat): void {
    this.options = { ...this.options, valueFormat: format };
    this.draw();
  }

  /** Repaint from the current state, for a host that changed something the
   *  canvas cannot see — a sprite sheet finishing its load, say. */
  redraw(): void {
    this.draw();
  }

  /** Resize canvas to match the grid extents at the current cell size. */
  resize(): void {
    const { dpr } = this;
    const { width: w, height: h } = this.extent();
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    // Sizing the backing store resets the context; the view has to be
    // written back.
    this.applyView();
  }

  /** Pull every component's current state from the WASM runtime. */
  refreshState(): void {
    this.signals = this.runtime.snapshot();
    // Wire value := real driver's output. `realSrcId` is set during the
    // collapse stage and points at the un-collapsed primitive that feeds
    // the edge — for real sources it equals srcId, for collapsed
    // subcircuits it's the inner gate, so the lookup is uniform.
    this.wireValue.clear();
    for (let i = 0; i < this.layout.wires.length; i++) {
      const w = this.layout.wires[i];
      this.wireValue.set(i, this.signals.get(w.realSrcId) ?? undefinedValue(1));
    }
    this.draw();
  }

  destroy(): void {
    this.closeEditor();
    for (const off of this.listeners) off();
    this.listeners = [];
    this.canvas.remove();
  }

  private attach(): void {
    // No hover while the view is moving under the pointer: the box under it
    // changes with every pan, and a host listening to `onHover` would be told
    // about each one.
    const onMove = (e: PointerEvent) => {
      if (this.moving()) return;
      this.setHover(this.componentAtEvent(e));
    };
    const onLeave = () => this.setHover(null);
    const onClick = (e: MouseEvent) => {
      // The click the browser fires after a pan or a pinch: the reader moved
      // the picture, and drove nothing.
      if (this.swallowClick) {
        this.swallowClick = false;
        return;
      }
      const id = this.componentAtEvent(e);
      if (id === null || !this.isToggleable(id)) return;
      // A bus is a value, not a switch: a click opens a field rather than
      // driving every bit at once. A single bit keeps its toggle exactly.
      if (this.widthOf(id) > 1) {
        this.openEditor(id);
        return;
      }
      const current = this.currentValue(id);
      const isHigh = (current.defined & 1n) === 1n && (current.value & 1n) === 1n;
      const next: Signal = isHigh ? 0 : 1;
      this.setInputSignal(id, next);
      this.options.onPinToggle?.(id, next);
      this.options.onPinChange?.(id, this.getInputValue(id)!);
    };
    this.canvas.addEventListener("pointermove", onMove);
    this.canvas.addEventListener("pointerleave", onLeave);
    this.canvas.addEventListener("click", onClick);
    this.listeners.push(
      () => this.canvas.removeEventListener("pointermove", onMove),
      () => this.canvas.removeEventListener("pointerleave", onLeave),
      () => this.canvas.removeEventListener("click", onClick),
    );
  }

  /**
   * Drive an input pin from the host and redraw. Keeps the canvas's own
   * toggle state in sync, so a later click flips from the value the host
   * set rather than from a stale one (replaying through the runtime alone
   * leaves the private map behind). Ignored for anything but a root input pin.
   */
  /**
   * The single funnel for hover changes: cursor, redraw and callback in one
   * place, which is what makes `pointerleave` idempotent and the callback
   * change-only.
   */
  private setHover(id: number | null): void {
    if (id === this.hoverId) return;
    this.hoverId = id;
    this.updateCursor();
    this.draw();
    this.options.onHover?.(id);
  }

  /** Grabbing while the view moves, a pointer over a pin, a default elsewhere. */
  private updateCursor(): void {
    const id = this.hoverId;
    this.canvas.style.cursor = this.moving() ? "grabbing"
      : id !== null && this.isToggleable(id) ? "pointer"
      : "default";
  }

  /** Whether a pan or a pinch is in progress. */
  private moving(): boolean {
    return this.gesture !== null && this.gesture.kind !== "press";
  }

  // ---- the gestures ---------------------------------------------------------
  //
  // The rule these keep: a gesture that moves the view never reaches the
  // simulation, and a click never moves the view. A pointer down is a press
  // until it has moved DRAG_THRESHOLD pixels; under that, the pointer up is a
  // click and the toggle or the value field runs exactly as before. Over it,
  // the press is a pan, the hover is frozen, and the click the browser fires
  // afterwards is swallowed. A second pointer makes a pinch. A wheel zooms
  // only with a modifier held, unless the host says otherwise, so the page
  // keeps its scroll; a wheel that zooms keeps the world point under the
  // pointer where it is.

  private attachNavigation(): void {
    const { canvas } = this;
    const nav = this.navigation;
    // One finger is the page's under `page`: it scrolls, and a tap clicks.
    // Declaring that is what lets the browser scroll past a canvas on a
    // phone, and what stops it pinch-zooming the page when two fingers land.
    canvas.style.touchAction = nav.touch === "own" ? "none" : "pan-x pan-y";
    // A drag across a canvas would otherwise start selecting the text round
    // it in some browsers.
    canvas.style.userSelect = "none";
    (canvas.style as unknown as Record<string, string>).webkitUserSelect = "none";

    const onDown = (e: PointerEvent) => this.pointerDown(e);
    const onMove = (e: PointerEvent) => this.pointerMove(e);
    const onUp = (e: PointerEvent) => this.pointerUp(e);
    const onWheel = (e: WheelEvent) => this.wheel(e);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    this.listeners.push(
      () => canvas.removeEventListener("pointerdown", onDown),
      () => canvas.removeEventListener("pointermove", onMove),
      () => canvas.removeEventListener("pointerup", onUp),
      () => canvas.removeEventListener("pointercancel", onUp),
      () => canvas.removeEventListener("wheel", onWheel),
    );
  }

  /** A pointer's place in the rendered rect, in CSS pixels. */
  private pointAt(e: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private pointerDown(e: PointerEvent): void {
    const nav = this.navigation;
    // A stale flag from a pan whose click never came must not eat this one.
    this.swallowClick = false;
    const touch = e.pointerType === "touch";
    if (!touch && e.button !== 0 && e.button !== 1) return;
    if (!touch && !nav.drag) return;
    const p = this.pointAt(e);
    this.pointers.set(e.pointerId, p);

    if (this.pointers.size >= 2) {
      // Two down: a pinch, from these two, whatever the first was doing.
      const [a, b] = [...this.pointers.values()];
      this.gesture = { kind: "pinch", view: this.getView(), mid: midpoint(a, b), dist: distance(a, b) };
      this.capture(e.pointerId);
      this.updateCursor();
      return;
    }
    // One finger under `page` is the page's: no press, so no pan can follow.
    // It is still tracked, so a second finger can make a pinch of the two.
    if (touch && nav.touch === "page") return;
    // The middle button would otherwise start the browser's autoscroll.
    if (e.button === 1) e.preventDefault();
    this.gesture = { kind: "press", id: e.pointerId, x: p.x, y: p.y };
    this.capture(e.pointerId);
  }

  private pointerMove(e: PointerEvent): void {
    if (!this.pointers.has(e.pointerId)) return;
    const p = this.pointAt(e);
    this.pointers.set(e.pointerId, p);
    const g = this.gesture;
    if (!g) return;

    if (g.kind === "pinch") {
      const [a, b] = [...this.pointers.values()];
      if (!a || !b) return;
      const mid = midpoint(a, b);
      const dist = distance(a, b);
      if (g.dist === 0) return;
      // From the start, not from the last move: the world point under the
      // starting midpoint lands under the current one, at the scale the
      // fingers' spread says, and rounding never accumulates.
      const scale = clampScale(g.view.scale * (dist / g.dist), this.minZoom, this.maxZoom);
      const k = scale / g.view.scale;
      const m0 = this.intendedPoint(g.mid.x, g.mid.y);
      const m1 = this.intendedPoint(mid.x, mid.y);
      this.changeView({ scale, x: m1.x - (m0.x - g.view.x) * k, y: m1.y - (m0.y - g.view.y) * k });
      return;
    }
    if (g.id !== e.pointerId) return;
    if (g.kind === "press") {
      if (Math.hypot(p.x - g.x, p.y - g.y) < DRAG_THRESHOLD) return;
      this.gesture = { kind: "pan", id: g.id, x: g.x, y: g.y };
      this.updateCursor();
    }
    const pan = this.gesture as { kind: "pan"; id: number; x: number; y: number };
    // The delta is in the rendered rect; the view is in the drawn size.
    const from = this.intendedPoint(pan.x, pan.y);
    const to = this.intendedPoint(p.x, p.y);
    pan.x = p.x;
    pan.y = p.y;
    const { scale, x, y } = this.view;
    this.changeView({ scale, x: x + (to.x - from.x), y: y + (to.y - from.y) });
  }

  private pointerUp(e: PointerEvent): void {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);
    this.release(e.pointerId);
    const g = this.gesture;
    if (!g) return;
    if (g.kind === "pinch") {
      // A pinch ends when either finger lifts. The other is still down and
      // still tracked, but starts nothing: under `page` it is the page's,
      // and under `own` a fresh press is a fresh gesture.
      this.gesture = null;
      this.swallowClick = true;
      this.updateCursor();
      return;
    }
    if (g.id !== e.pointerId) return;
    this.gesture = null;
    if (g.kind === "pan") {
      this.swallowClick = true;
      this.updateCursor();
    }
    // A press that never became a pan ends here with nothing to do: the
    // click that follows is a real one, and reaches the pin.
  }

  private wheel(e: WheelEvent): void {
    const policy = this.navigation.wheel;
    if (policy === "off") return;
    if (policy === "modifier" && !e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    // Lines and pages are turned into pixels first; then one mouse notch of a
    // hundred pixels halves or doubles, and a trackpad pinch, which arrives
    // as many small deltas, zooms smoothly by the same rule. No single event
    // jumps more than a factor of two.
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 100 : e.deltaY;
    const factor = Math.min(2, Math.max(0.5, Math.pow(2, -dy / 100)));
    if (factor === 1) return;
    const p = this.pointAt(e);
    this.zoomBy(factor, p);
  }

  private capture(id: number): void {
    try { this.canvas.setPointerCapture(id); } catch { /* a pointer already gone */ }
  }

  private release(id: number): void {
    try {
      if (this.canvas.hasPointerCapture(id)) this.canvas.releasePointerCapture(id);
    } catch { /* already released */ }
  }

  /**
   * Highlight one component from the host — an editor cursor, a table header.
   * Feeds the same `hovered` flag the pointer does, so a skin needs no second
   * branch; `null` clears it, and an id with no box is a harmless no-op.
   */
  setHighlight(id: number | null): void {
    if (id === this.highlightId) return;
    this.highlightId = id;
    this.draw();
  }

  /**
   * The grid this canvas drew. Live and read-only by contract: a host needs it
   * to map a declared name to a box, which the topology alone cannot do for a
   * collapsed subcircuit — those carry synthetic ids that exist only here.
   */
  getLayout(): LayoutGrid {
    return this.layout;
  }

  setInputSignal(id: number, signal: Signal): void {
    if (!this.isToggleable(id)) return;
    const mask = widthMask(this.widthOf(id));
    if (signal === 2) this.setInputValue(id, 0n, 0n);
    else this.setInputValue(id, signal === 1 ? mask : 0n, mask);
  }

  /**
   * Drive an input pin to an exact value and redraw. The width-aware sibling
   * of `setInputSignal`, and what a bus needs: `value` and `defined` are masked
   * to the pin's width, so a stray high bit cannot cross the boundary. Ignored
   * for anything but a root input pin. Fires no callback — the host called it.
   */
  setInputValue(id: number, value: bigint, defined: bigint): void {
    if (!this.isToggleable(id)) return;
    const width = this.widthOf(id);
    const mask = widthMask(width);
    const v = value & mask;
    const d = defined & mask;
    this.inputState.set(id, { value: v & d, defined: d, width });
    this.runtime.setValueAndRun(id, v, d);
    this.refreshState();
  }

  /** What this canvas last drove a pin to, or null for a pin it never has —
   *  so a host can replay a rebuilt canvas without mirroring every callback. */
  getInputValue(id: number): BitValue | null {
    return this.inputState.get(id) ?? null;
  }

  /**
   * A component's box in CSS pixels relative to the canvas element, or null.
   *
   * The canvas draws at its intended size but page CSS may shrink the element;
   * this applies the same rescale the hit-test does, in reverse, so a host can
   * anchor something over a box and have it land on the box at every size.
   */
  boxOf(id: number): { x: number; y: number; width: number; height: number } | null {
    const c = this.layout.components.find((p) => p.id === id);
    if (!c) return null;
    const { cell } = this;
    const { scale, x, y } = this.view;
    const rect = this.canvas.getBoundingClientRect();
    const ext = this.extent();
    const sx = rect.width > 0 ? rect.width / ext.width : 1;
    const sy = rect.height > 0 ? rect.height / ext.height : 1;
    return {
      x: (c.x * cell * scale + x) * sx,
      y: (c.y * cell * scale + y) * sy,
      width: c.width * cell * scale * sx,
      height: c.height * cell * scale * sy,
    };
  }

  private widthOf(id: number): number {
    return this.layout.components.find((p) => p.id === id)?.bitWidth ?? 1;
  }

  /**
   * What a pin holds NOW, from the runtime rather than from this canvas's
   * own memory of what it drove. The runtime drives every input to Low at
   * load and a host may drive one behind the canvas's back; the toggle, the
   * field's seed and an edit request all have to start from the truth, or a
   * field opens showing `?` over a badge that reads `0x0`.
   */
  private currentValue(id: number): BitValue {
    return this.runtime.readValue(id);
  }

  // ---- the value editor -----------------------------------------------------

  /**
   * Open an editor under a bus pin, unless the host takes the gesture over.
   *
   * The editor is a small dialog on `document.body`, positioned `fixed` from
   * the canvas's client rect: the canvas owns no parent and cannot position
   * anything relative to one. It holds a text field, a slider over the pin's
   * whole range when that range fits a number, and three buttons: Apply drives
   * what the field says, Clear drives zero, Close drives nothing. Enter and
   * Escape are Apply and Close. A pointer down outside the dialog, focus
   * leaving it for somewhere else on the page, a scroll and a resize each
   * close it uncommitted, which is simpler and more honest than following the
   * page around.
   *
   * Class names (`circ-pin-editor`, `circ-pin-editor__field`, `__slider`,
   * `__name`, `__actions`, `__apply`, `__clear`, `__close`) are stable, so a
   * host can restyle it; the inline styles are only a legible default.
   */
  private openEditor(id: number): void {
    this.closeEditor();
    const box = this.boxOf(id);
    if (!box) return;
    const current = this.currentValue(id);

    if (this.options.onPinEdit) {
      const handled = this.options.onPinEdit({
        id,
        value: current,
        box,
        commit: (value, defined) => {
          this.setInputValue(id, value, defined);
          this.announce(id);
        },
        cancel: () => {},
      });
      if (handled === true) return;
    }
    if (typeof document === "undefined") return;

    const width = current.width;
    const mask = widthMask(width);
    const format = this.valueFormat;
    const name = this.layout.components.find((c) => c.id === id)?.name ?? `pin ${id}`;
    const colors = this.theme.colors as Partial<Record<ThemeColorKey, string>>;
    const font = this.theme.font ?? `${Math.round(this.cell)}px ui-monospace, monospace`;
    const rect = this.canvas.getBoundingClientRect();

    const root = document.createElement("div");
    root.className = "circ-pin-editor";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", `Value of ${name}, ${width} bit${width === 1 ? "" : "s"}`);
    Object.assign(root.style, {
      position: "fixed",
      left: `${rect.left + box.x}px`,
      top: `${rect.top + box.y + box.height + 4}px`,
      display: "grid",
      gap: "6px",
      padding: "8px",
      minWidth: "180px",
      boxSizing: "border-box",
      background: colors.background ?? "#ffffff",
      color: colors.label ?? "#212529",
      border: `1px solid ${colors.stroke ?? "#212529"}`,
      borderRadius: "6px",
      boxShadow: "0 4px 16px rgba(0, 0, 0, 0.18)",
      font,
      zIndex: "2147483647",
    });

    const label = document.createElement("span");
    label.className = "circ-pin-editor__name";
    label.textContent = `${name} · ${width} bit${width === 1 ? "" : "s"}`;
    Object.assign(label.style, { opacity: "0.75", fontSize: "0.85em" });
    root.appendChild(label);

    const field = document.createElement("input");
    field.type = "text";
    field.className = "circ-pin-editor__field";
    field.value = formatPinValue(current, format);
    field.maxLength = entryLength(width, format);
    field.setAttribute("aria-label", `Value of ${name}, ${width} bits`);
    field.setAttribute("aria-invalid", "false");
    field.setAttribute("autocomplete", "off");
    field.setAttribute("spellcheck", "false");
    Object.assign(field.style, {
      boxSizing: "border-box",
      width: "100%",
      margin: "0",
      padding: "2px 4px",
      font,
      textAlign: "center",
      color: "inherit",
      background: "transparent",
      border: `1px solid ${colors.stroke ?? "#212529"}`,
      borderRadius: "4px",
    });
    root.appendChild(field);

    // A slider spans the pin's range only when that range is a number the
    // slider can hold exactly; past 53 bits the field is the only entry.
    const slider = width <= 53 ? document.createElement("input") : null;
    if (slider) {
      slider.type = "range";
      slider.className = "circ-pin-editor__slider";
      slider.min = "0";
      slider.max = mask.toString();
      slider.step = "1";
      slider.value = ((current.value & current.defined & mask)).toString();
      slider.setAttribute("aria-label", `Slide the value of ${name}`);
      Object.assign(slider.style, { width: "100%", margin: "0" });
      root.appendChild(slider);
    }

    const actions = document.createElement("div");
    actions.className = "circ-pin-editor__actions";
    Object.assign(actions.style, { display: "flex", gap: "4px", justifyContent: "flex-end" });
    const button = (kind: "apply" | "clear" | "close", text: string) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `circ-pin-editor__${kind}`;
      b.textContent = text;
      Object.assign(b.style, {
        font,
        fontSize: "0.85em",
        padding: "2px 8px",
        cursor: "pointer",
        color: "inherit",
        background: "transparent",
        border: `1px solid ${colors.stroke ?? "#212529"}`,
        borderRadius: "4px",
      });
      actions.appendChild(b);
      return b;
    };
    const apply = button("apply", "Apply");
    const clear = button("clear", "Clear");
    const close = button("close", "Close");
    root.appendChild(actions);

    const complain = (message: string) => {
      // Stay open. A refusal that closes the editor throws away what the
      // reader typed and makes them find the pin again to try once more.
      field.setAttribute("aria-invalid", "true");
      field.title = message;
      field.focus();
      field.select();
    };
    const answered = () => {
      if (field.getAttribute("aria-invalid") === "true") {
        field.setAttribute("aria-invalid", "false");
        field.title = "";
      }
    };

    let done = false;
    const drive = (value: bigint, defined: bigint) => {
      done = true;
      this.closeEditor();
      this.setInputValue(id, value, defined);
      this.announce(id);
    };
    const finish = (commit: boolean) => {
      if (done) return;
      if (!commit) {
        done = true;
        this.closeEditor();
        return;
      }
      const parsed = parsePinValue(field.value, width, format);
      if (!parsed.ok) {
        complain(parsed.message);
        return;
      }
      drive(parsed.value, parsed.defined);
    };

    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
      else answered(); // typing again is the reader answering the complaint
    };
    // The field and the slider say the same number: a legal, fully known
    // entry moves the slider, and a slide rewrites the field in the format.
    const onType = () => {
      answered();
      if (!slider) return;
      const parsed = parsePinValue(field.value, width, format);
      if (parsed.ok && parsed.defined === mask) slider.value = parsed.value.toString();
    };
    const onSlide = () => {
      if (!slider) return;
      answered();
      field.value = formatPinValue({ value: BigInt(slider.value), defined: mask, width }, format);
    };
    const onApply = () => finish(true);
    const onClear = () => { if (!done) drive(0n, mask); };
    const onClose = () => finish(false);
    // Clicking away closes, uncommitted, even from a value that will not
    // parse: the editor never traps the pointer. Focus leaving for somewhere
    // else on the page is the keyboard's way of saying the same thing; a
    // focusout with no destination (a button that takes no focus on click,
    // the window losing focus) is not, and is left alone.
    const onPointerDown = (e: Event) => {
      const target = e.target as Node | null;
      if (target && root.contains(target)) return;
      finish(false);
    };
    const onFocusOut = (e: FocusEvent) => {
      const to = e.relatedTarget as Node | null;
      if (!to || root.contains(to)) return;
      finish(false);
    };
    const onMove = () => finish(false);

    field.addEventListener("keydown", onKey);
    field.addEventListener("input", onType);
    slider?.addEventListener("input", onSlide);
    slider?.addEventListener("keydown", onKey);
    apply.addEventListener("click", onApply);
    clear.addEventListener("click", onClear);
    close.addEventListener("click", onClose);
    root.addEventListener("focusout", onFocusOut);
    document.addEventListener("pointerdown", onPointerDown, true);
    if (typeof window !== "undefined") {
      window.addEventListener("scroll", onMove, true);
      window.addEventListener("resize", onMove);
    }
    const off = () => {
      field.removeEventListener("keydown", onKey);
      field.removeEventListener("input", onType);
      slider?.removeEventListener("input", onSlide);
      slider?.removeEventListener("keydown", onKey);
      apply.removeEventListener("click", onApply);
      clear.removeEventListener("click", onClear);
      close.removeEventListener("click", onClose);
      root.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("pointerdown", onPointerDown, true);
      if (typeof window !== "undefined") {
        window.removeEventListener("scroll", onMove, true);
        window.removeEventListener("resize", onMove);
      }
    };
    this.editor = { id, root, off };
    document.body.appendChild(root);
    // Keep the dialog on screen: a pin at the right or bottom edge would
    // otherwise open it partly off the page.
    if (typeof window !== "undefined") {
      const r = root.getBoundingClientRect();
      const overRight = r.right - window.innerWidth;
      const overBottom = r.bottom - window.innerHeight;
      if (overRight > 0) root.style.left = `${Math.max(0, rect.left + box.x - overRight - 8)}px`;
      if (overBottom > 0) root.style.top = `${Math.max(0, rect.top + box.y - r.height - 4)}px`;
    }
    field.focus();
    field.select();
  }

  private closeEditor(): void {
    if (!this.editor) return;
    const { root, off } = this.editor;
    this.editor = null;
    off();
    root.remove();
  }

  /** Both change callbacks, for a change the reader made. */
  private announce(id: number): void {
    const value = this.getInputValue(id);
    if (!value) return;
    this.options.onPinChange?.(id, value);
    this.options.onPinToggle?.(id, signalOf(value));
  }

  private isToggleable(id: number): boolean {
    const c = this.layout.components.find((p) => p.id === id);
    if (!c) return false;
    return isPrimitive(c.kind) && c.kind.kind === ComponentKind.InputPin;
  }

  /** Hit-test using cell-aligned bounding boxes. */
  private componentAtEvent(e: MouseEvent): number | null {
    const rect = this.canvas.getBoundingClientRect();
    // Client → the element's drawn size → world, through the same view the
    // transform drew with, so what is under the pointer is what it hits.
    const p = this.intendedPoint(e.clientX - rect.left, e.clientY - rect.top);
    const w = this.toWorld(p.x, p.y);
    const cx = w.x / this.cell;
    const cy = w.y / this.cell;
    for (const c of this.layout.components) {
      if (cx >= c.x && cx < c.x + c.width && cy >= c.y && cy < c.y + c.height) {
        return c.id;
      }
    }
    return null;
  }

  private draw(): void {
    const { ctx, theme, cell, layout } = this;
    // Clear in physical (untransformed) pixels.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();

    // Background. The default fills what the element SHOWS, not the grid:
    // zoomed out, the grid is smaller than the element, and a fill of the grid
    // alone would leave the page showing round it.
    const viewport = this.extent();
    if (theme.background) {
      theme.background({
        ctx, theme: theme as CircTheme<string>, cell,
        width: layout.width, height: layout.height,
        view: this.getView(), viewport,
      });
    } else {
      const shown = visibleWorld(this.view, viewport);
      ctx.fillStyle = theme.colors["background"] ?? "#fff";
      ctx.fillRect(shown.x, shown.y, shown.width, shown.height);
    }

    // Index components by id once per draw.
    const compById = new Map<number, PlacedComponent>();
    for (const c of layout.components) compById.set(c.id, c);

    // Wires under components, but with leading + trailing port stubs that
    // extend INTO the source/destination boxes so the wire visually meets
    // the gate edge. The component fills paint over the inside parts.
    for (let i = 0; i < layout.wires.length; i++) {
      this.drawWire(layout.wires[i], this.wireValue.get(i) ?? undefinedValue(1), compById, i);
    }

    // Components.
    for (const comp of layout.components) {
      // Synthetic subcircuit nodes aren't in the runtime snapshot — fall
      // back to the inner gate that drives this group's outputs so the
      // box's output tail/dot match the wires leaving it.
      const driver = this.realDriverByComp.get(comp.id) ?? comp.id;
      const outValue = this.signals.get(driver) ?? undefinedValue(comp.bitWidth);
      const inValues = comp.inPorts.map((slot) => {
        const wireIdx = layout.wires.findIndex((w) => w.dstId === comp.id && portByteOfName(slot.portName) === w.dstPort);
        return wireIdx >= 0 ? this.wireValue.get(wireIdx) ?? undefinedValue(1) : undefinedValue(1);
      });
      const skinArgs = {
        ctx, theme: theme as CircTheme<string>, cell, component: comp,
        inputSignals: inValues.map(signalOf),
        outputSignal: signalOf(outValue),
        inputValues: inValues,
        outputValue: outValue,
        hovered: this.hoverId === comp.id || this.highlightId === comp.id,
      };
      const skin = pickSkin(theme as CircTheme<string>, skinArgs);
      skin(skinArgs);
    }

    // Markers on top: fan-out dots, port markers (out circle, in arrow).
    this.drawFanOutMarkers(compById);
    this.drawPortMarkers(compById);
    // Bus value badges for multi-bit nets, above everything.
    this.drawBusValues();
    // The highlight, above even those: one ring per marked component, drawn
    // here for every kind so no skin has to read `hovered` to be reachable.
    this.drawHighlights(compById);
  }

  /**
   * Mark the hovered and the host-highlighted components.
   *
   * Every default skin used to ignore the `hovered` flag it was handed, so a
   * host highlight was invisible on any kind the host did not skin itself —
   * the playground's source-to-picture link drew nothing on a rom, a ram, a
   * slice or a concat. One ring drawn here covers all of them at once.
   */
  private drawHighlights(compById: Map<number, PlacedComponent>): void {
    const ids = new Set<number>();
    if (this.hoverId !== null) ids.add(this.hoverId);
    if (this.highlightId !== null) ids.add(this.highlightId);
    if (ids.size === 0) return;
    const { ctx, cell, theme } = this;
    for (const id of ids) {
      const comp = compById.get(id);
      if (!comp) continue;
      const reason =
        this.hoverId === id && this.highlightId === id ? "both" : this.hoverId === id ? "hover" : "highlight";
      if (theme.highlight) {
        theme.highlight({ ctx, theme: theme as CircTheme<string>, cell, component: comp, reason });
        continue;
      }
      const pad = cell * 0.18;
      const x = comp.x * cell - pad;
      const y = comp.y * cell - pad;
      const w = comp.width * cell + pad * 2;
      const h = comp.height * cell + pad * 2;
      const r = Math.min(cell * 0.4, w / 2, h / 2);
      ctx.save();
      ctx.strokeStyle = theme.colors["highlight"] ?? "#f59f00";
      ctx.lineWidth = Math.max(1, cell * 0.1);
      ctx.beginPath();
      if (typeof ctx.roundRect === "function") ctx.roundRect(x, y, w, h, r);
      else ctx.rect(x, y, w, h);
      ctx.stroke();
      ctx.restore();
    }
  }

  /**
   * Label every multi-bit (width > 1) component's output net with its current
   * value, drawn just above the box. Input pins show their driven value;
   * output pins / LEDs show what they receive; gates and bit-shape nodes show
   * their computed output.
   */
  private drawBusValues(): void {
    const { ctx, cell, layout, theme } = this;
    ctx.save();
    ctx.font = (theme.font ?? `${Math.round(cell)}px ui-monospace, monospace`);
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = theme.colors["busLabel"] ?? "#1971c2";
    for (const comp of layout.components) {
      if (comp.bitWidth <= 1) continue;
      const driver = this.realDriverByComp.get(comp.id) ?? comp.id;
      const v = this.signals.get(driver) ?? undefinedValue(comp.bitWidth);
      const value = { ...v, width: comp.bitWidth };
      // The same spelling the value field seeds with, so what is shown can be
      // typed back; a half-known bus shows which bits are known rather than
      // hiding them all behind one `?`.
      const text = formatPinValue(value, this.valueFormat);
      if (theme.busValue) {
        theme.busValue({ ctx, theme: theme as CircTheme<string>, cell, component: comp, value, text });
        continue;
      }
      const cx = (comp.x + comp.width / 2) * cell;
      const cy = comp.y * cell - cell * 0.15;
      ctx.fillText(text, cx, cy);
    }
    ctx.restore();
  }

  /**
   * Mark every cell where a source's wires branch: fold the group's segments
   * into one graph of adjacent cells and stamp `●` on every cell the net
   * leaves in three or more directions. A trunk that several wires share
   * is degree two along its run and marks nothing; a bend they all take is
   * degree two; only a tap is three. The old rule counted segment touches,
   * which marked every cell of a shared trunk — invisible while the dot was
   * the wire's own colour, a ring on every cell once a theme drew one.
   */
  private drawFanOutMarkers(compById: Map<number, PlacedComponent>): void {
    const { ctx, cell, layout, theme } = this;
    // group wires by srcId
    const bySrc = new Map<number, RoutedWire[]>();
    for (const w of layout.wires) {
      let arr = bySrc.get(w.srcId);
      if (!arr) { arr = []; bySrc.set(w.srcId, arr); }
      arr.push(w);
    }
    for (const [, group] of bySrc) {
      if (group.length < 2) continue; // single wire can't fan out
      // All wires in a fan-out group share a real driver, so any of them
      // works for picking the dot color.
      const v = this.signals.get(group[0].realSrcId) ?? undefinedValue(1);
      ctx.fillStyle = theme.colors[wireColorKey(wireStyleOf(v))] ?? "#444";
      for (const key of junctionCells(group)) {
        const [xs, ys] = key.split(",");
        const cx = Number(xs);
        const cy = Number(ys);
        if (theme.fanOutMarker) {
          // A theme that marks junctions itself gets the cell and the group's
          // value; the site draws a ring with the pane showing through.
          theme.fanOutMarker({
            ctx, theme: theme as CircTheme<string>, cell,
            x: cx, y: cy, value: v, signal: signalOf(v),
          });
          continue;
        }
        const x = cx * cell + cell / 2;
        const y = cy * cell + cell / 2;
        ctx.beginPath();
        ctx.arc(x, y, cell * 0.18, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  /**
   * Stamp markers at every wire's source and destination port. Themes can
   * override the appearance via `theme.portMarker`; the default draws an
   * unfilled circle on the source side and a filled arrowhead on the
   * destination side, both colored to match the wire's signal.
   */
  private drawPortMarkers(compById: Map<number, PlacedComponent>): void {
    const { ctx, cell, layout, theme } = this;
    const stampedSources = new Set<string>();
    for (let wi = 0; wi < layout.wires.length; wi++) {
      const wire = layout.wires[wi];
      const value = this.wireValue.get(wi) ?? undefinedValue(1);
      const sig = signalOf(value);
      const wireColor = theme.colors[wireColorKey(wireStyleOf(value))] ?? "#444";

      // Source marker — drawn at most once per (component, source).
      const src = compById.get(wire.srcId);
      const srcKey = `${wire.srcId}`;
      if (src && !stampedSources.has(srcKey)) {
        if (theme.portMarker) {
          theme.portMarker({
            ctx, theme: theme as CircTheme<string>, cell,
            x: src.outPort.x, y: src.outPort.y,
            signal: sig, side: "source",
          });
        } else {
          const cx = src.outPort.x * cell + cell / 2;
          const cy = src.outPort.y * cell + cell / 2;
          ctx.fillStyle = theme.colors["background"] ?? "#fff";
          ctx.strokeStyle = wireColor;
          ctx.lineWidth = Math.max(1, cell * 0.14);
          ctx.beginPath();
          ctx.arc(cx, cy, cell * 0.18, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
        stampedSources.add(srcKey);
      }

      // Destination marker.
      const dst = compById.get(wire.dstId);
      if (!dst) continue;
      const slot = dst.inPorts.find((p) => portByteOfName(p.portName) === wire.dstPort);
      if (!slot) continue;
      if (theme.portMarker) {
        theme.portMarker({
          ctx, theme: theme as CircTheme<string>, cell,
          x: slot.coord.x, y: slot.coord.y,
          signal: sig, side: "destination",
        });
      } else {
        const arrowSize = cell * 0.32;
        const tipX = (slot.coord.x + 1) * cell;
        const tipY = slot.coord.y * cell + cell / 2;
        ctx.fillStyle = wireColor;
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(tipX - arrowSize, tipY - arrowSize / 2);
        ctx.lineTo(tipX - arrowSize, tipY + arrowSize / 2);
        ctx.closePath();
        ctx.fill();
      }
    }
  }

  private drawWire(
    wire: RoutedWire,
    value: BitValue,
    compById: Map<number, PlacedComponent>,
    wireIdx: number
  ): void {
    const { ctx, cell, theme } = this;
    const conflictTier = this.wireTier.get(wireIdx) ?? 0;
    const style = wireStyleOf(value);
    if (theme.wire) {
      theme.wire({ ctx, theme: theme as CircTheme<string>, cell, wire, signal: signalOf(value), value, conflictTier });
      return;
    }
    ctx.strokeStyle = theme.colors[wireColorKey(style)] ?? "#444";
    // Buses (width > 1) draw a touch heavier so they read as multi-bit.
    ctx.lineWidth = Math.max(1, cell * (style === "bus" ? 0.28 : 0.18));
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    // Source-side stub: from the source box's right edge into the out_port.
    const src = compById.get(wire.srcId);
    if (src) {
      const sy = src.outPort.y * cell + cell / 2;
      ctx.beginPath();
      ctx.moveTo((src.x + src.width - 0.5) * cell, sy);
      ctx.lineTo(src.outPort.x * cell + cell / 2, sy);
      ctx.stroke();
    }
    // Destination-side stub: from the in_port into the destination box.
    const dst = compById.get(wire.dstId);
    if (dst) {
      const slot = dst.inPorts.find((p) => portByteOfName(p.portName) === wire.dstPort);
      if (slot) {
        const dy = slot.coord.y * cell + cell / 2;
        ctx.beginPath();
        ctx.moveTo(slot.coord.x * cell + cell / 2, dy);
        ctx.lineTo((dst.x + 0.5) * cell, dy);
        ctx.stroke();
      }
    }
    // The route itself: every segment, with horizontal ones arcing over their
    // recorded crossings. Traced by the same function a theme's `wire` hook
    // can call, so the two cannot disagree about where a jump goes.
    ctx.beginPath();
    traceWire(ctx, wire, cell, defaultArcRadius(cell));
    ctx.stroke();
  }
}

const midpoint = (a: { x: number; y: number }, b: { x: number; y: number }) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const distance = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(b.x - a.x, b.y - a.y);
