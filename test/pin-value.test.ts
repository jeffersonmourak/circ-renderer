// One spelling of a value, shared with the playground's memory grid.
//
// These cases are the grid's own, carried over so the two surfaces cannot
// drift: a reader who has learned that `?` means unknown and `0b` forces binary
// in one place must find the same in the other. Definedness is the thing to get
// right — a half-known value is neither its value nor a blank.
import { describe, expect, test } from "bun:test";
import { widthMask, type BitValue } from "../src/wasm/topology";
import { UNKNOWN, entryLength, formatPinValue, parsePinValue } from "../src/render/pin-value";

const full = (value: bigint, width: number): BitValue => ({ value, defined: widthMask(width), width });
const cell = (value: bigint, defined: bigint, width: number): BitValue => ({ value, defined, width });

describe("formatPinValue", () => {
  test("a fully defined value follows the format, prefixed so it can be typed back", () => {
    expect(formatPinValue(full(0xa5n, 8), "hex")).toBe("0xA5");
    expect(formatPinValue(full(0xa5n, 8), "binary")).toBe("0b10100101");
    expect(formatPinValue(full(0xa5n, 8), "decimal")).toBe("165");
    // Hex is the default, and is what the bus badge has always shown.
    expect(formatPinValue(full(0xa5n, 8))).toBe("0xA5");
  });

  test("hex and binary pad to the width; decimal does not", () => {
    expect(formatPinValue(full(1n, 8), "hex")).toBe("0x01");
    expect(formatPinValue(full(1n, 8), "binary")).toBe("0b00000001");
    expect(formatPinValue(full(1n, 8), "decimal")).toBe("1");
    expect(formatPinValue(full(3n, 5), "hex")).toBe("0x03");
  });

  test("no known bits is ?, whatever the value bits say", () => {
    for (const format of ["hex", "binary", "decimal"] as const) {
      expect(formatPinValue(cell(0n, 0n, 8), format)).toBe(UNKNOWN);
      expect(formatPinValue(cell(0xffn, 0n, 8), format)).toBe(UNKNOWN);
    }
  });

  test("a partially known value is binary with x, whatever the format", () => {
    // There is no honest hex digit for four bits of which two are unknown.
    const half = cell(0b1010_0000n, 0b1111_0000n, 8);
    for (const format of ["hex", "binary", "decimal"] as const) {
      expect(formatPinValue(half, format)).toBe("1010xxxx");
    }
  });

  test("bits above the width never reach the screen", () => {
    expect(formatPinValue(cell(0xff05n, widthMask(4), 4), "hex")).toBe("0x5");
  });

  test("the full 64-bit width round-trips", () => {
    const all = widthMask(64);
    expect(formatPinValue(full(all, 64), "decimal")).toBe("18446744073709551615");
    expect(formatPinValue(full(all, 64), "hex")).toBe("0x" + "F".repeat(16));
  });
});

describe("parsePinValue", () => {
  test("reads the chosen format by default", () => {
    expect(parsePinValue("ff", 8, "hex")).toEqual({ ok: true, value: 255n, defined: 255n });
    expect(parsePinValue("1010", 8, "binary")).toEqual({ ok: true, value: 10n, defined: 255n });
    expect(parsePinValue("42", 8, "decimal")).toEqual({ ok: true, value: 42n, defined: 255n });
    expect(parsePinValue("2a", 8)).toEqual({ ok: true, value: 42n, defined: 255n });
  });

  test("an explicit prefix overrides the chosen format", () => {
    expect(parsePinValue("0x1f", 8, "decimal")).toEqual({ ok: true, value: 31n, defined: 255n });
    expect(parsePinValue("0b101", 8, "hex")).toEqual({ ok: true, value: 5n, defined: 255n });
  });

  test("what formatPinValue shows can be typed straight back", () => {
    for (const format of ["hex", "binary", "decimal"] as const) {
      const shown = formatPinValue(full(0x2an, 8), format);
      expect(parsePinValue(shown, 8, format)).toEqual({ ok: true, value: 0x2an, defined: 255n });
    }
    // Case does not matter: the badge is upper-case, a reader may not be.
    expect(parsePinValue("0XAB", 8, "hex")).toEqual({ ok: true, value: 0xabn, defined: 255n });
  });

  test("? and empty make the pin unknown again, which is not a zero", () => {
    for (const text of ["?", "", "  "]) {
      expect(parsePinValue(text, 8, "hex")).toEqual({ ok: true, value: 0n, defined: 0n });
    }
    expect(parsePinValue("0", 8, "hex")).toEqual({ ok: true, value: 0n, defined: 255n });
  });

  test("too large for the width is refused with the limit", () => {
    const r = parsePinValue("100", 8, "hex");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("255");
    const one = parsePinValue("2", 1, "decimal");
    expect(one.ok).toBe(false);
    if (!one.ok) expect(one.message).toContain("1 bit;");
  });

  test("garbage is a message, never a throw and never a silent zero", () => {
    for (const bad of ["zz", "0xg", "0b12", "1.5", "-1", "#", "0x"]) {
      const r = parsePinValue(bad, 8, "hex");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message.length).toBeGreaterThan(0);
    }
  });

  test("underscores group digits", () => {
    expect(parsePinValue("1010_1010", 8, "binary")).toEqual({ ok: true, value: 170n, defined: 255n });
  });

  test("the full 64-bit range parses and one past it does not", () => {
    expect(parsePinValue("f".repeat(16), 64, "hex")).toEqual({
      ok: true,
      value: widthMask(64),
      defined: widthMask(64),
    });
    expect(parsePinValue("1" + "0".repeat(16), 64, "hex").ok).toBe(false);
  });
});

describe("entryLength", () => {
  test("never refuses a prefixed or grouped entry the parser accepts", () => {
    for (const width of [1, 4, 8, 16, 64]) {
      for (const format of ["hex", "binary", "decimal"] as const) {
        const cap = entryLength(width, format);
        const shown = formatPinValue(full(widthMask(width), width), format);
        expect(shown.length).toBeLessThanOrEqual(cap);
        // The widest thing the field seeds with is a half-known value.
        expect(width).toBeLessThanOrEqual(cap);
      }
    }
  });
});
