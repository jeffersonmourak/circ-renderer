import { ComponentKind, PortName } from "../wasm/topology";
import { concatSize, macroSize, pinSize, primitiveSizing, sliceSize, type PrimitiveSize } from "./sizing";
import {
  type ColumnAssignment,
  isPrimitive,
  type PlacedComponent,
  type PortCoord,
  type PortSlot,
  type RowAssignment,
  type VirtualGraph,
  type VirtualNode,
} from "./types";

const COL_GUTTER = 5;
const ROW_GUTTER = 1;

const sat = (x: number) => (x < 0 ? 0 : x);

/**
 * Stage 4: turn (graph, columns, rows) into PlacedComponent[].
 * Per-column max width and per-row max height applied uniformly.
 * Port coordinates live ONE CELL OUTSIDE the box border.
 */
export function place(
  graph: VirtualGraph,
  columns: ColumnAssignment,
  rows: RowAssignment
): PlacedComponent[] {
  const n = graph.nodes.length;

  const sizes: PrimitiveSize[] = new Array(n);
  for (let i = 0; i < n; i++) sizes[i] = sizeOf(graph.nodes[i]);

  const colWidths = new Array<number>(columns.numColumns).fill(0);
  const rowHeights = new Array<number>(Math.max(rows.numRows, 1)).fill(0);
  for (let i = 0; i < n; i++) {
    const c = columns.columnOf[i];
    const r = rows.rowOf[i];
    if (sizes[i].width > colWidths[c]) colWidths[c] = sizes[i].width;
    if (sizes[i].height > rowHeights[r]) rowHeights[r] = sizes[i].height;
  }

  const colX = new Array<number>(columns.numColumns).fill(0);
  {
    let acc = 0;
    for (let k = 0; k < colWidths.length; k++) {
      colX[k] = acc;
      acc += colWidths[k] + COL_GUTTER;
    }
  }
  const rowY = new Array<number>(rowHeights.length).fill(0);
  {
    let acc = 0;
    for (let k = 0; k < rowHeights.length; k++) {
      rowY[k] = acc;
      acc += rowHeights[k] + ROW_GUTTER;
    }
  }

  const placed: PlacedComponent[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const node = graph.nodes[i];
    const x = colX[columns.columnOf[i]];
    const y = rowY[rows.rowOf[i]];
    const w = sizes[i].width;
    const h = sizes[i].height;
    const ports = resolvePortCoords(node, x, y, w, h);
    placed[i] = {
      id: node.id,
      kind: node.kind,
      name: node.name,
      origin: node.origin,
      x,
      y,
      width: w,
      height: h,
      inPorts: ports.inPorts,
      outPort: ports.outPort,
      bitWidth: node.bitWidth,
      slice: node.slice,
    };
  }
  return placed;
}

function sizeOf(node: VirtualNode): PrimitiveSize {
  if (isPrimitive(node.kind)) {
    const k = node.kind.kind;
    if (k === ComponentKind.InputPin || k === ComponentKind.OutputPin) {
      return pinSize(node.name.length);
    }
    if (k === ComponentKind.Slice) {
      const { lo, hi } = node.slice ?? { lo: 0, hi: 1 };
      return sliceSize(lo, hi);
    }
    if (k === ComponentKind.Concat) {
      return concatSize(operandCount(node));
    }
    return primitiveSizing[k];
  }
  // subcircuit
  return macroSize(
    node.kind.subcircuit.length + node.name.length + 3, // [, :, ]
    countActiveSubcircuitInputs(node)
  );
}

/** Number of distinct operand ports feeding a concat node. */
function operandCount(node: VirtualNode): number {
  const seen = new Set<number>();
  for (const e of node.inputs) seen.add(e.dstPort);
  return Math.max(1, seen.size);
}

/** Port-slot label for concat operand `index`. Decoded by `portByteOf`. */
export const operandPortName = (index: number): string => `op${index}`;

function countActiveSubcircuitInputs(node: VirtualNode): number {
  let hasIn = false, hasA = false, hasB = false;
  for (const e of node.inputs) {
    if (e.dstPort === PortName.In) hasIn = true;
    else if (e.dstPort === PortName.A) hasA = true;
    else if (e.dstPort === PortName.B) hasB = true;
  }
  return (hasA ? 1 : 0) + (hasIn ? 1 : 0) + (hasB ? 1 : 0);
}

interface Ports {
  inPorts: PortSlot[];
  outPort: PortCoord;
}

function resolvePortCoords(node: VirtualNode, x: number, y: number, w: number, h: number): Ports {
  const inPorts: PortSlot[] = [];
  let outPort: PortCoord = { x: x + w, y: y + Math.floor(h / 2) };

  if (isPrimitive(node.kind)) {
    const k = node.kind.kind;
    switch (k) {
      case ComponentKind.InputPin:
        outPort = { x: x + w, y: y + 1 };
        break;
      case ComponentKind.OutputPin:
        inPorts.push({ portName: "in", coord: { x: sat(x - 1), y: y + 1 } });
        break;
      case ComponentKind.NotGate:
        inPorts.push({ portName: "in", coord: { x: sat(x - 1), y: y + 1 } });
        outPort = { x: x + w, y: y + 1 };
        break;
      case ComponentKind.AndGate:
        inPorts.push({ portName: "a", coord: { x: sat(x - 1), y: y + 1 } });
        inPorts.push({ portName: "b", coord: { x: sat(x - 1), y: y + 3 } });
        outPort = { x: x + w, y: y + 2 };
        break;
      case ComponentKind.Led:
        inPorts.push({ portName: "in", coord: { x: sat(x - 1), y: y + 1 } });
        break;
      case ComponentKind.Slice:
        inPorts.push({ portName: "in", coord: { x: sat(x - 1), y: y + 1 } });
        outPort = { x: x + w, y: y + 1 };
        break;
      case ComponentKind.Concat: {
        // One stacked input port per operand index, ascending. Port labels
        // are `op<index>` so the canvas can match them to the operand-index
        // port bytes carried on concat connections.
        const indices = Array.from(new Set(node.inputs.map((e) => e.dstPort))).sort((a, b) => a - b);
        indices.forEach((idx, slotIdx) => {
          inPorts.push({ portName: operandPortName(idx), coord: { x: sat(x - 1), y: y + 1 + 2 * slotIdx } });
        });
        outPort = { x: x + w, y: y + Math.floor(h / 2) };
        break;
      }
      case ComponentKind.Wire:
        // wires were collapsed in stage 1
        break;
    }
  } else {
    // subcircuit
    let hasIn = false, hasA = false, hasB = false;
    for (const e of node.inputs) {
      if (e.dstPort === PortName.In) hasIn = true;
      else if (e.dstPort === PortName.A) hasA = true;
      else if (e.dstPort === PortName.B) hasB = true;
    }
    let slotIdx = 0;
    if (hasA) {
      inPorts.push({ portName: "a", coord: { x: sat(x - 1), y: y + 1 + 2 * slotIdx } });
      slotIdx++;
    }
    if (hasIn) {
      inPorts.push({ portName: "in", coord: { x: sat(x - 1), y: y + 1 + 2 * slotIdx } });
      slotIdx++;
    }
    if (hasB) {
      inPorts.push({ portName: "b", coord: { x: sat(x - 1), y: y + 1 + 2 * slotIdx } });
      slotIdx++;
    }
    outPort = { x: x + w, y: y + Math.floor(h / 2) };
  }
  return { inPorts, outPort };
}
