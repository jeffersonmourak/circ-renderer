import { ComponentKind, PortName } from "../wasm/topology";
import { inputSlots, outputRow } from "./ports";
import { concatSize, ledSize, macroSize, memoryLabel, memorySize, pinSize, primitiveSizing, type PrimitiveSize, sliceSize } from "./sizing";
import { chipHeight, isPrimitive, type PortCoord, type PortSlot, type Slot, type VirtualNode } from "./types";

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
  /** The first (for a primitive, the only) output port. */
  outPort: PortCoord;
  /** Every output port: none for a sink, one for a source or a gate, one
   * per declared output for a chip. */
  outPorts: PortSlot[];
}

const SINKS = new Set<ComponentKind>([ComponentKind.OutputPin, ComponentKind.Led, ComponentKind.Wire]);

export function resolvePortCoords(node: VirtualNode, x: number, y: number, w: number, h: number): Ports {
  const inPorts = inputSlots(node).map((s) => ({ portName: s.name, port: s.port, coord: { x: sat(x - 1), y: y + s.row } }));
  let outPorts: PortSlot[];
  if (!isPrimitive(node.kind)) {
    outPorts = (node.outSlots ?? []).map((s) => ({ portName: s.name, port: s.port, coord: { x: x + w, y: y + s.row } }));
  } else if (SINKS.has(node.kind.kind)) {
    outPorts = [];
  } else {
    outPorts = [{ portName: "out", port: PortName.Out, coord: { x: x + w, y: y + outputRow(node, h, PortName.Out) } }];
  }
  const outPort = outPorts.length > 0 ? outPorts[0].coord : { x: x + w, y: y + Math.floor(h / 2) };
  return { inPorts, outPort, outPorts };
}

export function sizeOf(node: VirtualNode): PrimitiveSize {
  if (isPrimitive(node.kind)) {
    const k = node.kind.kind;
    if (k === ComponentKind.InputPin || k === ComponentKind.OutputPin) {
      return pinSize(node.name.length, node.bitWidth);
    }
    if (k === ComponentKind.Led) {
      return ledSize(node.bitWidth);
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
  return chipSize(node.kind.subcircuit, node);
}

/**
 * A chip box: tall enough for one port on every other row, and wide enough
 * for its `[<chip>:<name>]` title. With port labels it is also wide enough
 * for each row's input and output names side by side, and for the title to
 * clear the names that share its row.
 */
function chipSize(sub: string, node: VirtualNode): PrimitiveSize {
  const ins = node.inSlots ?? [];
  const outs = node.outSlots ?? [];
  const title = sub.length + node.name.length + 3; // [, :, ]
  const height = chipHeight(ins.length, outs.length);
  let width = macroSize(title, 1).width;
  if (!node.portLabels) return { width, height };

  const mid = Math.floor(height / 2);
  for (let row = 1; row + 1 < height; row++) {
    const inLen = labelLenAt(ins, row);
    const outLen = labelLenAt(outs, row);
    // Two names on one row keep a cell between them.
    let need = inLen + outLen + (inLen > 0 && outLen > 0 ? 1 : 0);
    // The title is centred, so it clears the longer name on both sides.
    if (row === mid) {
      const side = Math.max(inLen, outLen);
      need = title + (side > 0 ? 2 * (side + 1) : 0);
    }
    width = Math.max(width, need + 2);
  }
  return { width, height };
}

function labelLenAt(slots: Slot[], row: number): number {
  for (const s of slots) if (s.row === row) return s.name.length;
  return 0;
}

/** Number of distinct operand ports feeding a concat node. */
function operandCount(node: VirtualNode): number {
  const seen = new Set<number>();
  for (const e of node.inputs) seen.add(e.dstPort);
  return Math.max(1, seen.size);
}
