// How a pin's value is written down, and what a typed one means.
//
// Ported from the circ playground's memory grid so a reader meets ONE spelling
// of a value across the site: hex by default, `0x` and `0b` prefixes override
// the base, `_` groups digits, and `?` or nothing means unknown. The playground
// may later import this in place of its own copy; until then the two are kept
// identical by the same table of cases in both test suites.
//
// Definedness is the thing to get right. A value carries `(value, defined)` as
// two bit vectors, and the honest rendering of a half-known word is neither its
// value nor a blank — it is the bits that are known and a mark where the others
// are. Every formatter here preserves that distinction.

import { type BitValue, widthMask } from "../wasm/topology";

export type ValueFormat = "hex" | "binary" | "decimal";

/** What a value with no known bits is written as, everywhere. */
export const UNKNOWN = "?";

/**
 * One value as the reader sees it.
 *
 * Fully undefined is `?`. Fully defined follows the format: `0x2A` for hex,
 * `0b0010` for binary, `42` for decimal. A PARTIALLY defined value ignores the
 * format and is written in binary with `x` for each unknown bit, because there
 * is no honest hex digit for four bits of which two are unknown.
 *
 * Hex is upper-case and prefixed, which is what the bus badge has always
 * shown; the parser accepts either case, so what is shown can be typed back.
 */
export function formatPinValue(v: BitValue, format: ValueFormat = "hex"): string {
  const mask = widthMask(v.width);
  const defined = v.defined & mask;
  // The runtime canonicalises to `value & defined`; do it again rather than
  // trust it, so a stray bit above the mask cannot reach the screen.
  const value = v.value & defined;

  if (defined === 0n) return UNKNOWN;
  if (defined !== mask) {
    let out = "";
    for (let bit = v.width - 1; bit >= 0; bit -= 1) {
      const at = 1n << BigInt(bit);
      out += (defined & at) === 0n ? "x" : (value & at) === 0n ? "0" : "1";
    }
    return out;
  }

  switch (format) {
    case "binary":
      return "0b" + value.toString(2).padStart(v.width, "0");
    case "hex":
      return "0x" + value.toString(16).toUpperCase().padStart(Math.ceil(v.width / 4), "0");
    case "decimal":
      return value.toString(10);
  }
}

export type ParsedPinValue =
  | { ok: true; value: bigint; defined: bigint }
  | { ok: false; message: string };

/**
 * Parse one value the reader typed.
 *
 * `?` and the empty string both mean "make this pin unknown", which is the
 * only way back once a value has been driven. An explicit `0x` or `0b` prefix
 * overrides the chosen format, because a reader who typed the prefix meant it.
 */
export function parsePinValue(text: string, width: number, format: ValueFormat = "hex"): ParsedPinValue {
  const trimmed = text.trim();
  if (trimmed === "" || trimmed === UNKNOWN) return { ok: true, value: 0n, defined: 0n };

  const lower = trimmed.toLowerCase().replace(/_/g, "");
  let body = lower;
  let radix = format === "hex" ? 16 : format === "binary" ? 2 : 10;
  if (lower.startsWith("0x")) {
    body = lower.slice(2);
    radix = 16;
  } else if (lower.startsWith("0b")) {
    body = lower.slice(2);
    radix = 2;
  }
  if (body === "") return { ok: false, message: "Type a number, or ? to make the pin unknown." };

  const legal = radix === 16 ? /^[0-9a-f]+$/ : radix === 2 ? /^[01]+$/ : /^[0-9]+$/;
  if (!legal.test(body)) {
    const kind = radix === 16 ? "hexadecimal" : radix === 2 ? "binary" : "decimal";
    return { ok: false, message: `Not a ${kind} number. Use 0x or 0b to give a different base.` };
  }

  let value: bigint;
  try {
    value = radix === 10 ? BigInt(body) : BigInt(`${radix === 16 ? "0x" : "0b"}${body}`);
  } catch {
    return { ok: false, message: "Not a number this pin can hold." };
  }
  const mask = widthMask(width);
  if (value > mask) {
    return { ok: false, message: `Too large for ${width} bit${width === 1 ? "" : "s"}; the most is ${mask}.` };
  }
  return { ok: true, value, defined: mask };
}

/** The longest legal entry for a width and format, plus room for a prefix and
 *  some `_` grouping. A cap, not a fit: the field must never refuse `0x`. */
export function entryLength(width: number, format: ValueFormat): number {
  const digits = format === "hex" ? Math.ceil(width / 4) : format === "decimal" ? `${widthMask(width)}`.length : width;
  // A partially defined value seeds the field as `width` characters of 0/1/x.
  return Math.max(digits, width) + 6;
}
