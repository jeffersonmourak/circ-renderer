/**
 * Decoder for the `circ.topology.v0.full` payload (CIRF) embedded in
 * compiled `.wasm` artifacts produced by `circ-compiler`.
 *
 * Wire format mirrors `lib/topology/full_format.zig` / `full_serializer.zig`.
 * Three versions are accepted; the only difference is the per-component body:
 *
 *   magic[4]="CIRF", version u8 (0x01, 0x02 or 0x03),
 *   num_components u32 LE,
 *     per component (v01): id u32, kind u8, name (u32 len + bytes),
 *                          origin_len u32, per frame: alias, subcircuit, target_file u32
 *     per component (v02): id u32, kind u8, width u8, name (u32 len + bytes),
 *                          origin_len u32, [frames...],
 *                          AUX: if kind == slice → lo u8, hi u8  (else nothing)
 *     per component (v03): as v02, plus AUX: if kind == rom | ram → addr_width u8
 *   num_connections u32 LE,
 *     per connection: from_id u32, to_id u32, port u8
 *
 * v01 components carry no width (defaulted to 1) and no aux. Downstream code
 * is version-agnostic: it always sees `width` and an optional `slice` field.
 *
 * NOTE: the kind byte uses the *topology* numbering from `lib/topology/
 * format.zig` (and_gate=2, wire=3, led=4), which differs from the engine's
 * internal `ComponentType` ordering. Keep this enum aligned with format.zig.
 */

export enum ComponentKind {
  InputPin = 0,
  NotGate = 1,
  AndGate = 2,
  Wire = 3,
  Led = 4,
  OutputPin = 5,
  Slice = 6,
  Concat = 7,
  /** Memories (v03) carry one trailing `addr_width` byte after name/origin. */
  Rom = 8,
  Ram = 9,
}

export enum PortName {
  In = 0,
  A = 1,
  B = 2,
  Out = 3,
  Addr = 4,
  Din = 5,
  We = 6,
  Clk = 7,
}

/**
 * Port label ↔ connection port byte. `in/a/b/out` are the gate ports,
 * `addr/din/we/clk` the memory ports, and `op<N>` a concat operand index
 * (which overlaps the numeric range — the target's kind disambiguates).
 */
export function portByteOfName(name: string): number {
  switch (name) {
    case "in": return PortName.In;
    case "a": return PortName.A;
    case "b": return PortName.B;
    case "out": return PortName.Out;
    case "addr": return PortName.Addr;
    case "din": return PortName.Din;
    case "we": return PortName.We;
    case "clk": return PortName.Clk;
  }
  const m = /^op(\d+)$/.exec(name);
  if (m) return parseInt(m[1], 10);
  return 0xff;
}

/**
 * Collapsed single-bit view of a signal. Mirrors the old scalar `engine.State`
 * and is what the per-component skins/coloring consume. Multi-bit nets are
 * collapsed to one of these for stroke/fill purposes via `signalOf`.
 */
export type Signal = 0 | 1 | 2;
export const Low: Signal = 0;
export const High: Signal = 1;
export const Undefined: Signal = 2;

/**
 * Full width-aware value of a net, mirroring the engine's `BitVecState`.
 * `value` / `defined` are bitmasks (LSB = bit 0); a bit is meaningful only
 * where the matching `defined` bit is set. `width` is 1..64. Crosses the
 * WASM boundary as paired `i64`, so the masks are `bigint`.
 */
export interface BitValue {
  value: bigint;
  defined: bigint;
  width: number;
}

/** A fully-undefined value of the given width. */
export const undefinedValue = (width: number): BitValue => ({ value: 0n, defined: 0n, width });

/** Low bitmask of `width` ones, e.g. width 4 → 0b1111. */
export const widthMask = (width: number): bigint =>
  width >= 64 ? (1n << 64n) - 1n : (1n << BigInt(width)) - 1n;

/**
 * Collapse a width-aware value to a single tri-state for coloring:
 *   - any bit undefined           → Undefined
 *   - all (defined) bits are 1    → High
 *   - all (defined) bits are 0    → Low
 *   - a mix of 0s and 1s (a bus)  → High (treated as "carrying signal")
 * Callers that need to distinguish a true bus from a single bit use `width`.
 */
export const signalOf = (v: BitValue): Signal => {
  const mask = widthMask(v.width);
  if ((v.defined & mask) !== mask) return Undefined;
  const bits = v.value & mask;
  if (bits === 0n) return Low;
  return High;
};

/** Map a single-bit tri-state into a width-1 `BitValue`. */
export const valueOfSignal = (s: Signal): BitValue =>
  s === Undefined ? { value: 0n, defined: 0n, width: 1 } : { value: BigInt(s), defined: 1n, width: 1 };

export interface OriginFrame {
  alias: string;
  subcircuit: string;
  targetFile: number;
}

export interface FullComponent {
  id: number;
  kind: ComponentKind;
  /** Bit width 1..64. Always present (defaulted to 1 for v01 payloads). */
  width: number;
  name: string;
  origin: OriginFrame[];
  /** Present only for `Slice` components: the `[lo, hi)` bit range. */
  slice?: { lo: number; hi: number };
  /** Present only for `Rom`/`Ram` components: address width 1..16. */
  memory?: { addrWidth: number };
}

export interface FullConnection {
  fromId: number;
  toId: number;
  /**
   * For most targets this is a `PortName`. For a `Concat` target it is the
   * operand index (0..N), which overlaps the `PortName` numeric range — the
   * `to` component's kind disambiguates. See `lib/topology/format.zig`.
   */
  port: number;
}

export interface FullTopology {
  components: FullComponent[];
  connections: FullConnection[];
}

const FULL_MAGIC = "CIRF";
const FULL_VERSION_V1 = 0x01;
const FULL_VERSION_V2 = 0x02;
const FULL_VERSION_V3 = 0x03;

/**
 * CIRF (`circ.topology.v0.full`) versions this decoder reads. A host that
 * compiles circuits at runtime (the circ playground) compares the compiler's
 * reported `full_version` against this list before handing artifacts to
 * `renderCircuit`.
 */
export const SUPPORTED_TOPOLOGY_VERSIONS: readonly number[] = [FULL_VERSION_V1, FULL_VERSION_V2, FULL_VERSION_V3];

class Cursor {
  pos = 0;
  constructor(readonly bytes: Uint8Array) {}
  remaining() { return this.bytes.length - this.pos; }
  u8(): number {
    if (this.remaining() < 1) throw new Error("topology: truncated u8");
    return this.bytes[this.pos++];
  }
  u32le(): number {
    if (this.remaining() < 4) throw new Error("topology: truncated u32");
    const b = this.bytes;
    const i = this.pos;
    this.pos += 4;
    // Little-endian u32; >>> 0 to keep unsigned.
    return ((b[i]) | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
  }
  bytes_n(n: number): Uint8Array {
    if (this.remaining() < n) throw new Error("topology: truncated bytes");
    const slice = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }
  ascii(n: number): string {
    return new TextDecoder("utf-8").decode(this.bytes_n(n));
  }
  str(): string {
    const len = this.u32le();
    return this.ascii(len);
  }
}

export function decodeFullTopology(bytes: Uint8Array): FullTopology {
  const cur = new Cursor(bytes);
  const magic = cur.ascii(4);
  if (magic !== FULL_MAGIC) {
    throw new Error(`topology: bad magic ${JSON.stringify(magic)}, expected ${FULL_MAGIC}`);
  }
  const version = cur.u8();
  if (!SUPPORTED_TOPOLOGY_VERSIONS.includes(version)) {
    const list = SUPPORTED_TOPOLOGY_VERSIONS.map((v) => `0x${v.toString(16).padStart(2, "0")}`).join(" and ");
    throw new Error(
      `topology: unsupported CIRF version 0x${version.toString(16)} (this decoder reads ${list})`
    );
  }
  const hasWidthAndAux = version >= FULL_VERSION_V2;

  const numComponents = cur.u32le();
  const components: FullComponent[] = new Array(numComponents);
  for (let i = 0; i < numComponents; i++) {
    const id = cur.u32le();
    const kindByte = cur.u8();
    if (!(kindByte in ComponentKind)) {
      throw new Error(`topology: unknown kind byte ${kindByte} for component ${id}`);
    }
    // v02 adds a width byte right after kind; v01 has no width (width 1).
    const width = hasWidthAndAux ? cur.u8() : 1;
    const name = cur.str();
    const originLen = cur.u32le();
    const origin: OriginFrame[] = new Array(originLen);
    for (let j = 0; j < originLen; j++) {
      const alias = cur.str();
      const subcircuit = cur.str();
      const targetFile = cur.u32le();
      origin[j] = { alias, subcircuit, targetFile };
    }
    const comp: FullComponent = { id, kind: kindByte as ComponentKind, width, name, origin };
    // Kind-dispatched aux suffix: `slice` carries (lo, hi) from v02;
    // `rom`/`ram` carry `addr_width` from v03.
    if (hasWidthAndAux && comp.kind === ComponentKind.Slice) {
      const lo = cur.u8();
      const hi = cur.u8();
      comp.slice = { lo, hi };
    } else if (hasWidthAndAux && isMemory(comp.kind)) {
      comp.memory = { addrWidth: cur.u8() };
    }
    components[i] = comp;
  }

  const numConnections = cur.u32le();
  const connections: FullConnection[] = new Array(numConnections);
  for (let i = 0; i < numConnections; i++) {
    const fromId = cur.u32le();
    const toId = cur.u32le();
    const port = cur.u8();
    connections[i] = { fromId, toId, port };
  }

  return { components, connections };
}

/**
 * Walk a `.wasm` binary and extract a custom section by name.
 * Used as a fallback when the runtime doesn't expose `getTopology()`.
 *
 * WASM module layout: 8-byte header, then sections.
 * Each section: id u8, size LEB128 u32, body[size].
 * Custom section (id=0) body: name_len LEB128, name bytes, payload.
 */
export function extractCustomSection(
  wasmBytes: Uint8Array,
  name: string
): Uint8Array | null {
  if (wasmBytes.length < 8) throw new Error("wasm: too short");
  if (
    wasmBytes[0] !== 0x00 ||
    wasmBytes[1] !== 0x61 ||
    wasmBytes[2] !== 0x73 ||
    wasmBytes[3] !== 0x6d
  ) {
    throw new Error("wasm: bad magic");
  }
  let pos = 8;
  while (pos < wasmBytes.length) {
    const id = wasmBytes[pos++];
    const [size, sizeBytes] = readUleb128(wasmBytes, pos);
    pos += sizeBytes;
    const sectionEnd = pos + size;
    if (id === 0) {
      const [nameLen, nameLenBytes] = readUleb128(wasmBytes, pos);
      const nameStart = pos + nameLenBytes;
      const sectionName = new TextDecoder("utf-8").decode(
        wasmBytes.subarray(nameStart, nameStart + nameLen)
      );
      if (sectionName === name) {
        return wasmBytes.subarray(nameStart + nameLen, sectionEnd);
      }
    }
    pos = sectionEnd;
  }
  return null;
}

function readUleb128(bytes: Uint8Array, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  let consumed = 0;
  while (true) {
    const byte = bytes[pos + consumed];
    consumed++;
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) throw new Error("uleb128: too long");
  }
  return [result >>> 0, consumed];
}

export const isPrimitive = (k: ComponentKind): boolean =>
  k !== ComponentKind.Wire;

export const isPin = (k: ComponentKind): boolean =>
  k === ComponentKind.InputPin || k === ComponentKind.OutputPin;

export const isSink = (k: ComponentKind): boolean =>
  k === ComponentKind.Led || k === ComponentKind.OutputPin;

/** Bit-shape kinds (slice / concat) — single output, no gate silhouette. */
export const isBitShape = (k: ComponentKind): boolean =>
  k === ComponentKind.Slice || k === ComponentKind.Concat;

/** Memory kinds (rom / ram) — a labelled box with one output. */
export const isMemory = (k: ComponentKind): boolean =>
  k === ComponentKind.Rom || k === ComponentKind.Ram;

export const kindName = (k: ComponentKind): string => {
  switch (k) {
    case ComponentKind.InputPin: return "input_pin";
    case ComponentKind.NotGate: return "not_gate";
    case ComponentKind.AndGate: return "and_gate";
    case ComponentKind.Wire: return "wire";
    case ComponentKind.Led: return "led";
    case ComponentKind.OutputPin: return "output_pin";
    case ComponentKind.Slice: return "slice";
    case ComponentKind.Concat: return "concat";
    case ComponentKind.Rom: return "rom";
    case ComponentKind.Ram: return "ram";
  }
};
