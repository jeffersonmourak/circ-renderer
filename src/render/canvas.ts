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
}

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
    this.resize();
    this.computeWireTiers();
    for (const w of this.layout.wires) {
      if (!this.realDriverByComp.has(w.srcId)) {
        this.realDriverByComp.set(w.srcId, w.realSrcId);
      }
    }
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

  /** Change the pixel size of a layout cell. The element resizes to match. */
  setCell(cell: number): void {
    this.options = { ...this.options, cell };
    this.resize();
    this.draw();
  }

  /** Change the padding around the grid. The element resizes to match. */
  setPadding(padding: number): void {
    this.options = { ...this.options, padding };
    this.resize();
    this.draw();
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
    const cell = this.cell;
    const pad = this.padding;
    const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
    const w = this.layout.width * cell + pad * 2;
    const h = this.layout.height * cell + pad * 2;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    // The translation of a transform is in DEVICE pixels: the padding is
    // asked for in CSS pixels, so it scales with the ratio like everything
    // else. Before, a 2x display got half the padding on the top and left,
    // and `componentAtEvent` and `boxOf`, which assume the full padding in
    // CSS pixels, were off by the other half.
    this.ctx.setTransform(dpr, 0, 0, dpr, pad * dpr, pad * dpr);
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
    const onMove = (e: PointerEvent) => this.setHover(this.componentAtEvent(e));
    const onLeave = () => this.setHover(null);
    const onClick = (e: MouseEvent) => {
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
    this.canvas.style.cursor = id !== null && this.isToggleable(id) ? "pointer" : "default";
    this.draw();
    this.options.onHover?.(id);
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
    const { cell, padding } = this;
    const rect = this.canvas.getBoundingClientRect();
    const intendedW = this.layout.width * cell + padding * 2;
    const intendedH = this.layout.height * cell + padding * 2;
    const sx = rect.width > 0 ? rect.width / intendedW : 1;
    const sy = rect.height > 0 ? rect.height / intendedH : 1;
    return {
      x: (c.x * cell + padding) * sx,
      y: (c.y * cell + padding) * sy,
      width: c.width * cell * sx,
      height: c.height * cell * sy,
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
    // The renderer set canvas.style.{width,height} = layout-extent * cell + pad*2,
    // but page CSS (e.g. max-width: 100%) can shrink the rendered rect. Scale the
    // pointer coords back into intended-pixel space so they align with the layout
    // grid that was drawn into the canvas's transform.
    const intendedW = this.layout.width * this.cell + this.padding * 2;
    const intendedH = this.layout.height * this.cell + this.padding * 2;
    const scaleX = rect.width > 0 ? intendedW / rect.width : 1;
    const scaleY = rect.height > 0 ? intendedH / rect.height : 1;
    const px = (e.clientX - rect.left) * scaleX - this.padding;
    const py = (e.clientY - rect.top) * scaleY - this.padding;
    const cx = px / this.cell;
    const cy = py / this.cell;
    for (const c of this.layout.components) {
      if (cx >= c.x && cx < c.x + c.width && cy >= c.y && cy < c.y + c.height) {
        return c.id;
      }
    }
    return null;
  }

  private draw(): void {
    const { ctx, theme, cell, layout } = this;
    const { padding } = this;
    // Clear in physical (untransformed) pixels.
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();

    // Background.
    if (theme.background) {
      theme.background({
        ctx, theme: theme as CircTheme<string>, cell,
        width: layout.width, height: layout.height,
      });
    } else {
      ctx.fillStyle = theme.colors["background"] ?? "#fff";
      ctx.fillRect(-padding, -padding, layout.width * cell + padding * 2, layout.height * cell + padding * 2);
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
