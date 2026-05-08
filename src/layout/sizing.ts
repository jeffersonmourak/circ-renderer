import { ComponentKind } from "../wasm/topology";

export interface PrimitiveSize {
  width: number;
  height: number;
}

/**
 * Per-kind cell sizes for fixed-size primitives. Pin sizes are computed
 * dynamically via `pinSize`. `wire`, `input_pin`, `output_pin` entries
 * are zero sentinels — callers route pins through `pinSize`.
 */
export const primitiveSizing: Record<ComponentKind, PrimitiveSize> = {
  [ComponentKind.InputPin]: { width: 0, height: 0 },
  [ComponentKind.NotGate]: { width: 5, height: 3 },
  [ComponentKind.Led]: { width: 5, height: 3 },
  [ComponentKind.AndGate]: { width: 5, height: 5 },
  [ComponentKind.Wire]: { width: 0, height: 0 },
  [ComponentKind.OutputPin]: { width: 0, height: 0 },
};

/**
 * Pin (input or output) box. Width grows with the label name to keep it
 * centered with one cell of padding each side; floor at 5 so short names
 * still look box-shaped.
 */
export function pinSize(nameLen: number): PrimitiveSize {
  return { width: Math.max(5, nameLen + 4), height: 3 };
}

/**
 * Opaque-mode subcircuit box. Width fits `[<sub>:<alias>]` plus padding;
 * height grows with input count so each port lands on a non-corner row.
 */
export function macroSize(labelWidth: number, inputCount: number): PrimitiveSize {
  const width = Math.max(8, labelWidth + 2);
  const height = inputCount <= 1 ? 3 : 2 * inputCount + 1;
  return { width, height };
}
