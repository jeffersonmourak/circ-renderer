import { buildLayout, type LayoutGrid, type LayoutOptions, type PlacedComponent, type RoutedWire } from "../layout";
import { isPrimitive } from "../layout/types";
import { ComponentKind, type Signal } from "../wasm/topology";
import type { CircRuntime } from "../wasm/runtime";
import {
  baseTheme,
  type CircTheme,
  styleForSignal,
  type ThemeColorKey,
} from "../utils/theme";
import { pickSkin } from "./skins";

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
}

const DEFAULTS = { cell: 12, padding: 4 };

export class CircCanvas<C extends string = ThemeColorKey> {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private layout: LayoutGrid;
  private signals = new Map<number, Signal>();
  private inputState = new Map<number, Signal>();
  private hoverId: number | null = null;
  private listeners: Array<() => void> = [];

  /** Per-wire signal (snapshot of source's output). Recomputed on refresh. */
  private wireSignal = new Map<number, Signal>();
  /**
   * Per-wire conflict tier for theme-driven sub-cell bias. 0 = no
   * horizontal-on-horizontal collision; 1+ = collides with a wire from
   * a different source at the same row. Stable across draws so themes
   * that bend wires for visual separation only do so where it helps.
   */
  private wireTier = new Map<number, number>();

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
    this.ctx.setTransform(dpr, 0, 0, dpr, pad, pad);
  }

  /** Pull every component's current state from the WASM runtime. */
  refreshState(): void {
    this.signals = this.runtime.snapshot();
    // Wire signal := source component's output state.
    // For wires whose srcId is a synthetic subcircuit node (created by
    // the collapse stage and therefore unknown to the runtime), trace
    // back through the original topology to find the real underlying
    // source: the component whose connection points at this wire's
    // (dstId, dstPort) in the un-collapsed graph.
    this.wireSignal.clear();
    const realComponentIds = new Set(this.runtime.topology.components.map((c) => c.id));
    for (let i = 0; i < this.layout.wires.length; i++) {
      const w = this.layout.wires[i];
      let sig = this.signals.get(w.srcId);
      if (sig === undefined && !realComponentIds.has(w.srcId)) {
        const realSrcId = this.findRealSourceForWire(w.dstId, w.dstPort);
        if (realSrcId !== undefined) sig = this.signals.get(realSrcId);
      }
      this.wireSignal.set(i, sig ?? 2);
    }
    this.draw();
  }

  /**
   * Walk the un-collapsed topology connections to find the component that
   * actually drives `(dstId, dstPort)`. Used when a wire's `srcId` is a
   * synthetic subcircuit node — the real driver is whatever fed that
   * port in the original graph before the collapse stage rewrote the
   * edge to come from the synthetic id.
   */
  private findRealSourceForWire(dstId: number, dstPort: number): number | undefined {
    for (const conn of this.runtime.topology.connections) {
      if (conn.toId === dstId && conn.port === dstPort) return conn.fromId;
    }
    return undefined;
  }

  destroy(): void {
    for (const off of this.listeners) off();
    this.listeners = [];
    this.canvas.remove();
  }

  private attach(): void {
    const onMove = (e: PointerEvent) => {
      const id = this.componentAtEvent(e);
      if (id !== this.hoverId) {
        this.hoverId = id;
        this.canvas.style.cursor = id !== null && this.isToggleable(id) ? "pointer" : "default";
        this.draw();
      }
    };
    const onLeave = () => {
      this.hoverId = null;
      this.canvas.style.cursor = "default";
      this.draw();
    };
    const onClick = (e: MouseEvent) => {
      const id = this.componentAtEvent(e);
      if (id === null || !this.isToggleable(id)) return;
      const next: Signal = this.inputState.get(id) === 1 ? 0 : 1;
      this.inputState.set(id, next);
      this.runtime.setPinAndRun(id, next);
      this.refreshState();
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

  private isToggleable(id: number): boolean {
    const c = this.layout.components.find((p) => p.id === id);
    if (!c) return false;
    return isPrimitive(c.kind) && c.kind.kind === ComponentKind.InputPin;
  }

  /** Hit-test using cell-aligned bounding boxes. */
  private componentAtEvent(e: MouseEvent): number | null {
    const rect = this.canvas.getBoundingClientRect();
    const px = e.clientX - rect.left - this.padding;
    const py = e.clientY - rect.top - this.padding;
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
      this.drawWire(layout.wires[i], this.wireSignal.get(i) ?? 2, compById, i);
    }

    // Components.
    for (const comp of layout.components) {
      const out = this.signals.get(comp.id) ?? 2;
      const ins = comp.inPorts.map((slot) => {
        const wireIdx = layout.wires.findIndex((w) => w.dstId === comp.id && portByteOf(slot.portName) === w.dstPort);
        return wireIdx >= 0 ? this.wireSignal.get(wireIdx) ?? 2 : (2 as Signal);
      });
      const skin = pickSkin(theme as CircTheme<string>, {
        ctx, theme: theme as CircTheme<string>, cell, component: comp,
        inputSignals: ins,
        outputSignal: out,
        hovered: this.hoverId === comp.id,
      });
      skin({
        ctx, theme: theme as CircTheme<string>, cell, component: comp,
        inputSignals: ins,
        outputSignal: out,
        hovered: this.hoverId === comp.id,
      });
    }

    // Markers on top: fan-out dots, port markers (out circle, in arrow).
    this.drawFanOutMarkers(compById);
    this.drawPortMarkers(compById);
  }

  /**
   * Walk every same-source wire group, count how many segments touch each
   * cell (interior + endpoints), and stamp `●` where ≥3 segment touches
   * land. Mirrors the CLI's fan-out glyph rule.
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
    for (const [srcId, group] of bySrc) {
      if (group.length < 2) continue; // single wire can't fan out
      const counts = new Map<string, number>();
      for (const w of group) {
        for (const seg of w.segments) {
          const dx = Math.sign(seg.to.x - seg.from.x);
          const dy = Math.sign(seg.to.y - seg.from.y);
          const len = Math.max(Math.abs(seg.to.x - seg.from.x), Math.abs(seg.to.y - seg.from.y));
          for (let k = 0; k <= len; k++) {
            const key = `${seg.from.x + dx * k},${seg.from.y + dy * k}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
          }
        }
      }
      // Pick the wire-color for this source.
      const sig = this.signals.get(srcId) ?? 2;
      const colorKey =
        styleForSignal(sig) === "active" ? "wireActive"
        : styleForSignal(sig) === "idle" ? "wireIdle"
        : "wireUndefined";
      ctx.fillStyle = theme.colors[colorKey] ?? "#444";
      for (const [key, n] of counts) {
        if (n < 3) continue;
        const [xs, ys] = key.split(",");
        const x = Number(xs) * cell + cell / 2;
        const y = Number(ys) * cell + cell / 2;
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
      const sig = this.wireSignal.get(wi) ?? 2;
      const colorKey =
        styleForSignal(sig) === "active" ? "wireActive"
        : styleForSignal(sig) === "idle" ? "wireIdle"
        : "wireUndefined";
      const wireColor = theme.colors[colorKey] ?? "#444";

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
      const slot = dst.inPorts.find((p) => portByteOf(p.portName) === wire.dstPort);
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
    signal: Signal,
    compById: Map<number, PlacedComponent>,
    wireIdx: number
  ): void {
    const { ctx, cell, theme } = this;
    const conflictTier = this.wireTier.get(wireIdx) ?? 0;
    if (theme.wire) {
      theme.wire({ ctx, theme: theme as CircTheme<string>, cell, wire, signal, conflictTier });
      return;
    }
    const colorKey =
      styleForSignal(signal) === "active" ? "wireActive"
      : styleForSignal(signal) === "idle" ? "wireIdle"
      : "wireUndefined";
    ctx.strokeStyle = theme.colors[colorKey] ?? "#444";
    ctx.lineWidth = Math.max(1, cell * 0.18);
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
      const slot = dst.inPorts.find((p) => portByteOf(p.portName) === wire.dstPort);
      if (slot) {
        const dy = slot.coord.y * cell + cell / 2;
        ctx.beginPath();
        ctx.moveTo(slot.coord.x * cell + cell / 2, dy);
        ctx.lineTo((dst.x + 0.5) * cell, dy);
        ctx.stroke();
      }
    }
    // For each segment, draw its line — horizontal segments arc over recorded
    // crossings so overlapping signals read as separate wires.
    for (const seg of wire.segments) {
      const horiz = seg.from.y === seg.to.y;
      const startX = seg.from.x * cell + cell / 2;
      const startY = seg.from.y * cell + cell / 2;
      const endX = seg.to.x * cell + cell / 2;
      const endY = seg.to.y * cell + cell / 2;
      if (!horiz) {
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.lineTo(endX, endY);
        ctx.stroke();
        continue;
      }
      const xs = [startX, endX].sort((a, b) => a - b);
      const segLo = xs[0], segHi = xs[1];
      const y = startY;
      // Crossings landing on this exact horizontal segment.
      const jumps = wire.crossings
        .filter((c) => c.y === seg.from.y && c.x * cell + cell / 2 >= segLo && c.x * cell + cell / 2 <= segHi)
        .map((c) => c.x * cell + cell / 2)
        .sort((a, b) => a - b);
      ctx.beginPath();
      let cursor = segLo;
      const arcRadius = cell * 0.4;
      for (const jx of jumps) {
        ctx.moveTo(cursor, y);
        ctx.lineTo(jx - arcRadius, y);
        ctx.arc(jx, y, arcRadius, Math.PI, 0, false); // arc above the line
        cursor = jx + arcRadius;
      }
      ctx.moveTo(cursor, y);
      ctx.lineTo(segHi, y);
      ctx.stroke();
    }
  }
}

function portByteOf(name: string): number {
  switch (name) {
    case "in": return 0;
    case "a":  return 1;
    case "b":  return 2;
    case "out": return 3;
    default: return 0xff;
  }
}
