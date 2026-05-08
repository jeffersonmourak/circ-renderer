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
}

export interface VirtualNode {
  id: number;
  kind: NodeKind;
  name: string;
  origin: OriginFrame[];
  inputs: InputEdge[];
  outputs: OutputEdge[];
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
  /** Port label as drawn on the box border: "in" | "a" | "b" (no "out" — out is the single output port). */
  portName: string;
  coord: PortCoord;
}

export interface PlacedComponent {
  id: number;
  kind: NodeKind;
  name: string;
  origin: OriginFrame[];
  x: number;
  y: number;
  width: number;
  height: number;
  inPorts: PortSlot[];
  outPort: PortCoord;
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
