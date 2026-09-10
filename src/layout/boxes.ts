import { ComponentKind, PortName } from "../wasm/topology";
import { inputSlots, outputRow } from "./ports";
import { concatSize, macroSize, memoryLabel, memorySize, pinSize, primitiveSizing, type PrimitiveSize, sliceSize } from "./sizing";
import { isPrimitive, type PortCoord, type PortSlot, type VirtualNode } from "./types";

/**
 * Box geometry per node — mirrors `lib/preview/layout/boxes.zig`: size and
 * port coordinates. Port coordinates are the `ports.ts` rows plus the box
 * origin, one cell outside the border (`x - 1` for inputs, `x + width` for
 * the output). `Slice` and `Concat` keep boxes here (the canvas draws them)
 * where the compiler's collapse stage folds them away.
 */
const sat = (x: number) => (x < 0 ? 0 : x);

export interface Ports {
  inPorts: PortSlot[];
  outPort: PortCoord;
}

export function resolvePortCoords(node: VirtualNode, x: number, y: number, w: number, h: number): Ports {
  const inPorts = inputSlots(node).map((s) => ({ portName: s.name, coord: { x: sat(x - 1), y: y + s.row } }));
  return { inPorts, outPort: { x: x + w, y: y + outputRow(node, h) } };
}

export function sizeOf(node: VirtualNode): PrimitiveSize {
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
    if (k === ComponentKind.Rom || k === ComponentKind.Ram) {
      const label = memoryLabel(k, node.name, node.bitWidth, node.memory?.addrWidth ?? 0);
      return memorySize(label.length, k === ComponentKind.Rom ? 1 : 4);
    }
    return primitiveSizing[k];
  }
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

function countActiveSubcircuitInputs(node: VirtualNode): number {
  let hasIn = false, hasA = false, hasB = false;
  for (const e of node.inputs) {
    if (e.dstPort === PortName.In) hasIn = true;
    else if (e.dstPort === PortName.A) hasA = true;
    else if (e.dstPort === PortName.B) hasB = true;
  }
  return (hasA ? 1 : 0) + (hasIn ? 1 : 0) + (hasB ? 1 : 0);
}
