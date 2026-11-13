import { ComponentKind, PortName } from "../wasm/topology";
import { isPrimitive, type Slot, type VirtualNode } from "./types";

/**
 * Port tables — mirrors `lib/preview/layout/ports.zig`: which input ports a
 * node exposes, in border order, at which row offset from its box top, and
 * where its output port sits. `ordering.ts` reads the order, `coords.ts`
 * the rows, `boxes.ts` both.
 *
 * Two kinds the compiler's collapse stage folds away keep boxes here (the
 * canvas draws them): a `Slice` has one `in` port, a `Concat` one stacked
 * `op<index>` port per operand.
 */
export type { Slot };

/** Multiplier that keeps a neighbour's position and its port slot in one
 * integer key (`pos * SLOT_KEY_BASE + slot`). Identical to the compiler's. */
export const SLOT_KEY_BASE = 512;

const slot = (name: string, port: number, row: number): Slot => ({ name, port, row });

const IN_1: Slot[] = [slot("in", PortName.In, 1)];
const AND_AB: Slot[] = [slot("a", PortName.A, 1), slot("b", PortName.B, 3)];
const ROM_ADDR: Slot[] = [slot("addr", PortName.Addr, 1)];
const RAM_4: Slot[] = [
  slot("addr", PortName.Addr, 1),
  slot("din", PortName.Din, 3),
  slot("we", PortName.We, 5),
  slot("clk", PortName.Clk, 7),
];

/** Port-slot label for concat operand `index`. */
export const operandPortName = (index: number): string => `op${index}`;

/** The node's input ports in border order (top to bottom). */
export function inputSlots(node: VirtualNode): Slot[] {
  if (isPrimitive(node.kind)) {
    switch (node.kind.kind) {
      case ComponentKind.InputPin:
        return [];
      case ComponentKind.OutputPin:
      case ComponentKind.NotGate:
      case ComponentKind.Led:
      case ComponentKind.Slice:
        return IN_1;
      case ComponentKind.AndGate:
        return AND_AB;
      case ComponentKind.Rom:
        return ROM_ADDR;
      case ComponentKind.Ram:
        return RAM_4;
      case ComponentKind.Concat: {
        // One stacked port per operand index, ascending.
        const indices = Array.from(new Set(node.inputs.map((e) => e.dstPort))).sort((a, b) => a - b);
        return indices.map((idx, i) => slot(operandPortName(idx), idx, 1 + 2 * i));
      }
      case ComponentKind.Wire:
        return [];
    }
    return [];
  }
  // Stage 1 lists a chip's declared inputs, in declaration order.
  return node.inSlots ?? [];
}

/** Index of the slot that receives `dstPort`, or null. */
export function slotIndex(node: VirtualNode, dstPort: number): number | null {
  const slots = inputSlots(node);
  for (let i = 0; i < slots.length; i++) if (slots[i].port === dstPort) return i;
  return null;
}

/** Row offset of the output port `srcPort` from the box's top edge. A chip
 * looks it up among its outputs and centres an unknown one. */
export function outputRow(node: VirtualNode, height: number, srcPort: number): number {
  if (isPrimitive(node.kind)) {
    switch (node.kind.kind) {
      case ComponentKind.AndGate:
        return 2;
      case ComponentKind.InputPin:
      case ComponentKind.NotGate:
      case ComponentKind.Rom:
      case ComponentKind.Slice:
        return 1;
      default:
        return Math.floor(height / 2);
    }
  }
  for (const s of node.outSlots ?? []) if (s.port === srcPort) return s.row;
  return Math.floor(height / 2);
}
