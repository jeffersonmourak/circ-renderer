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
  // Bit-shape kinds; concat grows with operand count via `concatSize`.
  [ComponentKind.Slice]: { width: 5, height: 3 },
  [ComponentKind.Concat]: { width: 5, height: 3 },
  // Memories size dynamically via `memorySize` (the label carries the
  // instance name and widths); zero sentinels here.
  [ComponentKind.Rom]: { width: 0, height: 0 },
  [ComponentKind.Ram]: { width: 0, height: 0 },
};

/** `rom code[8,4]` — the label a memory box carries (matches `--preview`). */
export function memoryLabel(kind: ComponentKind, name: string, width: number, addrWidth: number): string {
  return `${kind === ComponentKind.Rom ? "rom" : "ram"} ${name}[${width},${addrWidth}]`;
}

/**
 * Memory box: wide enough for its label like a pin, tall enough for one
 * input port per odd border row like a macro box (rom: 3 rows, ram: 9).
 */
export function memorySize(labelLen: number, inputCount: number): PrimitiveSize {
  return { width: Math.max(5, labelLen + 4), height: inputCount <= 1 ? 3 : 2 * inputCount + 1 };
}

/**
 * Slice tap box. Width fits the `[lo:hi]` label (or `[i]` for a single bit)
 * with one cell of padding each side; floor at 5.
 */
export function sliceSize(lo: number, hi: number): PrimitiveSize {
  const label = hi - lo <= 1 ? `[${lo}]` : `[${lo}:${hi}]`;
  return { width: Math.max(5, label.length + 2), height: 3 };
}

/**
 * Concat merge box. One input port per operand, stacked vertically, so the
 * height grows with operand count the same way the subcircuit box does.
 */
export function concatSize(operandCount: number): PrimitiveSize {
  const n = Math.max(1, operandCount);
  return { width: 5, height: n <= 1 ? 3 : 2 * n + 1 };
}

/** `[N]` for widths > 1, empty for scalar pins — mirrors `sizing.zig`. */
export function widthAnnotationLen(bitWidth: number): number {
  if (bitWidth <= 1) return 0;
  return 2 + String(bitWidth).length;
}

/**
 * Pin (input or output) box. Width grows with the label name (and the
 * `[N]` annotation of a multi-bit pin) to keep it centered with one cell of
 * padding each side; floor at 5 so short names still look box-shaped.
 */
export function pinSize(nameLen: number, bitWidth: number = 1): PrimitiveSize {
  return { width: Math.max(5, nameLen + widthAnnotationLen(bitWidth) + 4), height: 3 };
}

/**
 * LED box. Width 1 keeps the 5×3 box; a wider LED needs room for its
 * `0x?…` display label (one `?` per nibble) — the compiler's `ledSize` with
 * `expand_display` off, which is the only mode the canvas draws.
 */
export function ledSize(bitWidth: number): PrimitiveSize {
  if (bitWidth <= 1) return primitiveSizing[ComponentKind.Led];
  const labelLen = 2 + Math.floor((bitWidth + 3) / 4);
  return { width: Math.max(5, labelLen + 4), height: 3 };
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
