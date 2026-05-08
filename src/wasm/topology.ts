/**
 * Decoder for the `circ.topology.v0.full` payload (CIRF) embedded in
 * compiled `.wasm` artifacts produced by `circ-compiler`.
 *
 * Wire format mirrors `lib/topology/full_decoder.zig`:
 *   magic[4]="CIRF", version u8=0x01,
 *   num_components u32 LE,
 *     per component: id u32, kind u8, name (u32 len + bytes),
 *                    origin_len u32, per frame: alias, subcircuit, target_file u32
 *   num_connections u32 LE,
 *     per connection: from_id u32, to_id u32, port u8
 */

export enum ComponentKind {
  InputPin = 0,
  NotGate = 1,
  AndGate = 2,
  Wire = 3,
  Led = 4,
  OutputPin = 5,
}

export enum PortName {
  In = 0,
  A = 1,
  B = 2,
  Out = 3,
}

/** Component output state. Mirrors Zig `engine.State`. */
export type Signal = 0 | 1 | 2;
export const Low: Signal = 0;
export const High: Signal = 1;
export const Undefined: Signal = 2;

export interface OriginFrame {
  alias: string;
  subcircuit: string;
  targetFile: number;
}

export interface FullComponent {
  id: number;
  kind: ComponentKind;
  name: string;
  origin: OriginFrame[];
}

export interface FullConnection {
  fromId: number;
  toId: number;
  port: PortName;
}

export interface FullTopology {
  components: FullComponent[];
  connections: FullConnection[];
}

const FULL_MAGIC = "CIRF";
const FULL_VERSION = 0x01;

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
  if (version !== FULL_VERSION) {
    throw new Error(`topology: unsupported version 0x${version.toString(16)}`);
  }

  const numComponents = cur.u32le();
  const components: FullComponent[] = new Array(numComponents);
  for (let i = 0; i < numComponents; i++) {
    const id = cur.u32le();
    const kindByte = cur.u8();
    if (!(kindByte in ComponentKind)) {
      throw new Error(`topology: unknown kind byte ${kindByte} for component ${id}`);
    }
    const name = cur.str();
    const originLen = cur.u32le();
    const origin: OriginFrame[] = new Array(originLen);
    for (let j = 0; j < originLen; j++) {
      const alias = cur.str();
      const subcircuit = cur.str();
      const targetFile = cur.u32le();
      origin[j] = { alias, subcircuit, targetFile };
    }
    components[i] = { id, kind: kindByte as ComponentKind, name, origin };
  }

  const numConnections = cur.u32le();
  const connections: FullConnection[] = new Array(numConnections);
  for (let i = 0; i < numConnections; i++) {
    const fromId = cur.u32le();
    const toId = cur.u32le();
    const port = cur.u8() as PortName;
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

export const kindName = (k: ComponentKind): string => {
  switch (k) {
    case ComponentKind.InputPin: return "input_pin";
    case ComponentKind.NotGate: return "not_gate";
    case ComponentKind.AndGate: return "and_gate";
    case ComponentKind.Wire: return "wire";
    case ComponentKind.Led: return "led";
    case ComponentKind.OutputPin: return "output_pin";
  }
};
