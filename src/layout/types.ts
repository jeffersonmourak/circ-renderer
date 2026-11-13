import { ComponentKind, type OriginFrame, PortName } from "../wasm/topology";

export { ComponentKind, PortName };
export type { OriginFrame };

/** Tagged union: node is either a primitive component or a collapsed subcircuit box. */
export type NodeKind =
  | { tag: "primitive"; kind: ComponentKind }
  | { tag: "subcircuit"; subcircuit: string };

export interface InputEdge {
  srcId: number;
  srcPort: number;
  dstPort: number;
}

export interface OutputEdge {
  dstId: number;
  srcPort: number;
  dstPort: number;
  /**
   * Un-collapsed driver of this edge: the primitive whose output actually
   * feeds `dstId` in the original topology. Equals `srcId` when the source
   * is a real component, or the inner gate that drives the subcircuit's
   * output port when `srcId` is a synthetic collapsed-subcircuit node.
   */
  realSrcId: number;
}

/** One port of a node: its name, the port byte wires address it by, and its
 * row offset from the box's top edge. */
export interface Slot {
  name: string;
  port: number;
  row: number;
}

/**
 * A collapsed chip's port bytes. A port named like a primitive port keeps
 * that port's `PortName` byte; any other takes `CHIP_PORT_BASE` plus its
 * index among the chip's inputs (or outputs), so the two never collide.
 */
export const CHIP_PORT_BASE = 16;

/** Height in rows of a chip box with this many inputs and outputs: one port
 * on every other row, starting under the top border. */
export function chipHeight(nIn: number, nOut: number): number {
  const n = Math.max(nIn, nOut);
  return n <= 1 ? 3 : 2 * n + 1;
}

/** Inputs take every other row from the top; outputs do the same, centred
 * on the box, so a lone output sits on the middle row as a gate's does. */
export function assignChipRows(ins: Slot[], outs: Slot[]): void {
  const h = chipHeight(ins.length, outs.length);
  ins.forEach((s, i) => { s.row = 2 * i + 1; });
  if (outs.length === 0) return;
  const first = (h - (2 * outs.length - 1)) / 2;
  outs.forEach((s, j) => { s.row = first + 2 * j; });
}

export interface VirtualNode {
  id: number;
  kind: NodeKind;
  name: string;
  origin: OriginFrame[];
  inputs: InputEdge[];
  outputs: OutputEdge[];
  /** Bit width of this node's output net (1..64). 1 for collapsed boxes. */
  bitWidth: number;
  /** Bit range for `Slice` nodes, threaded from the topology aux. */
  slice?: { lo: number; hi: number };
  /** Address width for `Rom`/`Ram` nodes, threaded from the topology aux. */
  memory?: { addrWidth: number };
  /** A collapsed chip's declared inputs and outputs, in declaration order
   * (stage 1 fills them); absent on a primitive, whose ports are fixed by
   * its kind (`ports.ts`). */
  inSlots?: Slot[];
  outSlots?: Slot[];
  /** The chip draws its port names inside its box. False for a chip shaped
   * like a built-in gate (inputs among `a`, `in`, `b`; one output `out`). */
  portLabels?: boolean;
}

export interface VirtualGraph {
  nodes: VirtualNode[];
  /** Smallest unused id — used by callers that mint new synthetic ids. */
  nextId: number;
}

export interface ColumnAssignment {
  /** column index per node (matches `graph.nodes` ordering). */
  columnOf: number[];
  numColumns: number;
}

export interface RowAssignment {
  rowOf: number[];
  numRows: number;
}

export interface PortCoord {
  x: number;
  y: number;
}

export interface PortSlot {
  /** The port's name: a primitive's "in" | "a" | "b" | "out" | "addr" | "din" | "we" | "clk" | "op<N>", or a chip's declared pin name. */
  portName: string;
  /** The byte a wire's `srcPort` or `dstPort` names this port by. */
  port: number;
  coord: PortCoord;
}

export interface PlacedComponent {
  id: number;
  kind: NodeKind;
  name: string;
  origin: OriginFrame[];
  x: number;
  y: number;
  /** Box width in layout CELLS (not bits). */
  width: number;
  height: number;
  inPorts: PortSlot[];
  /** The first (for a primitive, the only) output port. */
  outPort: PortCoord;
  /** Every output port: none for a sink, one per declared output for a
   * chip, one for anything else. */
  outPorts: PortSlot[];
  /** A chip that draws its port names inside its box. */
  portLabels: boolean;
  /** Bit width of this component's output net (1..64). */
  bitWidth: number;
  /** Bit range for `Slice` components. */
  slice?: { lo: number; hi: number };
  /** Address width for `Rom`/`Ram` components. */
  memory?: { addrWidth: number };
}

export interface Segment {
  from: PortCoord;
  to: PortCoord;
}

export interface RoutedWire {
  srcId: number;
  srcPort: number;
  dstId: number;
  dstPort: number;
  segments: Segment[];
  crossings: PortCoord[];
  /** See `OutputEdge.realSrcId`. */
  realSrcId: number;
}

export interface LayoutGrid {
  /** Cell extent (max occupied column + 1). */
  width: number;
  /** Cell extent (max occupied row + 1). */
  height: number;
  components: PlacedComponent[];
  wires: RoutedWire[];
}

export interface LayoutOptions {
  expandMacros?: boolean;
  /**
   * Free rows between stacked boxes. Default 1, which is what the compiler's
   * `--preview` uses and what the parity goldens are pinned at; a host whose
   * theme draws above a box (a value chip over a pin) asks for 2.
   */
  rowGutter?: number;
}

// ---------- Layered graph (mirrors lib/preview/layout/types.zig) ----------

/** A node of the layered graph: a real `VirtualGraph` node or a dummy that
 * carries a long edge through an intermediate layer. */
export interface LayerNode {
  /** Index into `VirtualGraph.nodes` for a real node; null for a dummy. */
  real: number | null;
  layer: number;
  /** For a dummy: index into `LayeredGraph.originals` of the edge it carries. */
  carries: number | null;
}

/** One wire as collapse produced it, in node order then each node's `outputs` order. */
export interface OriginalEdge {
  src: number; // VirtualGraph node index
  srcPort: number;
  dst: number;
  dstPort: number;
  /** Closes a cycle (or runs leftward after sink forcing): routed as a return lane. */
  back: boolean;
  /** See `OutputEdge.realSrcId`. */
  realSrcId: number;
}

/** A layer-adjacent segment: `src` in layer `L`, `dst` in `L + 1`. */
export interface LayerEdge {
  src: number; // LayerNode index
  dst: number;
  srcPort: number;
  dstPort: number;
  original: number;
}

export interface LayeredGraph {
  /** Real nodes first in `VirtualGraph` order, then dummies in `originals` order. */
  nodes: LayerNode[];
  edges: LayerEdge[];
  originals: OriginalEdge[];
  numLayers: number;
}

export interface Ordering {
  /** Per layer, `LayerNode` indices top to bottom. */
  order: number[][];
  /** Position of every `LayerNode` inside its layer. */
  pos: number[];
  rounds: number;
}

// ---------- Coordinates ----------

export interface ChannelWidths {
  /** Width of the gap after layer `k`. */
  after: number[];
}

export interface Coords {
  x: number[];
  y: number[];
  w: number[];
  h: number[];
  layerX: number[];
  layerW: number[];
  channelX: number[];
  width: number;
  height: number;
}

// ---------- Channels ----------

export type Rail = "left" | "right" | "none";

export interface Terminal {
  node: number;
  port: number;
  row: number;
  rail: Rail;
}

export interface Piece {
  track: number;
  lo: number;
  hi: number;
}

export interface Jog {
  row: number;
  fromTrack: number;
  toTrack: number;
}

export interface Net {
  srcReal: number;
  srcPort: number;
  src: Terminal;
  sinks: Terminal[];
  lo: number;
  hi: number;
  straight: boolean;
  pieces: Piece[];
  jogs: Jog[];
  back: boolean;
  fallback: boolean;
}

export interface Gap {
  afterLayer: number;
  nets: Net[];
  tracks: number;
  width: number;
}

export interface RoutePlan {
  gaps: Gap[];
  returnRows: number;
  spacerRows: number[];
  fallbacks: number;
}

export const isPrimitive = (k: NodeKind): k is { tag: "primitive"; kind: ComponentKind } =>
  k.tag === "primitive";

export const isSubcircuit = (k: NodeKind): k is { tag: "subcircuit"; subcircuit: string } =>
  k.tag === "subcircuit";

export const isInputPin = (n: VirtualNode): boolean =>
  isPrimitive(n.kind) && n.kind.kind === ComponentKind.InputPin;

export const isSink = (n: VirtualNode): boolean =>
  isPrimitive(n.kind) &&
  (n.kind.kind === ComponentKind.Led || n.kind.kind === ComponentKind.OutputPin);
