import {
  ComponentKind,
  decodeFullTopology,
  type BitValue,
  type FullComponent,
  type FullTopology,
  type Signal,
  signalOf,
  widthMask,
} from "./topology";

/**
 * Exports of a per-circuit `.wasm` artifact emitted by `circ-compiler`
 * (see `templates/main.zig`). The host stages the topology blob into
 * linear memory via `topology_alloc` + memcpy, then calls `init()`. The
 * runtime parses it from there. Other lifecycle exports (`reset`,
 * `deinit`, …) are looked up best-effort — they may not exist yet.
 *
 * Two ABIs are supported, detected by which exports the module carries:
 *
 *  - **v2 (BitVecState)**, current compiler: `setPin(id, value, defined)` with
 *    the two halves crossing as i64 (`bigint` here), and paired
 *    `getOutputValue` / `getOutputDefined` getters.
 *  - **v1 (scalar)**, pre-2.0 artifacts: `setPin(id, state)` and a single
 *    `getOutputState(id)` returning a tri-state `0|1|2`. Width-1 only.
 *
 * Callers always use the width-aware `BitValue` surface; the v1 path adapts
 * to/from the scalar export transparently. The CIRF section version and the
 * runtime ABI are produced together, so they always agree.
 */
type RuntimeAbi = "v1" | "v2";

interface RuntimeExports {
  memory: WebAssembly.Memory;
  /** Allocate `size` bytes in linear memory; returns a pointer the host
   * must write the topology blob to before calling `init()`. */
  topology_alloc: (size: number) => number;
  init: () => void;
  run: () => void;
  /** v2: (id, value:i64, defined:i64). v1: (id, state:i32). */
  setPin: (componentId: number, a?: number | bigint, b?: bigint) => void;
  // v2 ABI:
  getOutputValue?: (componentId: number) => bigint;
  getOutputDefined?: (componentId: number) => bigint;
  // v1 ABI:
  getOutputState?: (componentId: number) => number;
  // Topology v03 memory exports (rom/ram); absent on older artifacts. See
  // circ-compiler's DOCS/wasm-api.md for the status codes and the raw image
  // layout (`ceil(W/8)` little-endian bytes per word).
  getMemInfo?: (id: number) => number;
  memBuffer?: (id: number) => number;
  memLoad?: (id: number, len: number) => number;
  memStore?: (id: number) => number;
  memClear?: (id: number) => number;
  setMemWord?: (id: number, addr: number, value: bigint, defined: bigint) => number;
  getMemValue?: (id: number, addr: number) => bigint;
  getMemDefined?: (id: number, addr: number) => bigint;
  // Optional / future:
  reset?: () => void;
  deinit?: () => void;
}

export interface LoadOptions {
  /** Extra imports merged on top of the defaults (debug logging stubs). */
  imports?: WebAssembly.Imports;
  /** Skip the implicit init() after instantiation. */
  noAutoInit?: boolean;
  /**
   * After init, every input pin is driven LOW and the circuit is settled
   * once. This boots the simulation into a defined state instead of
   * leaving every gate at `undefined`. Set this to `true` to opt out and
   * keep pins floating.
   */
  noInitialPinDrive?: boolean;
}

function defaultImports(): WebAssembly.Imports {
  // The compiled artifact carries a static engine that may reference
  // log/state-change imports (`env.debugEnabled`, `env.onDebugLog`,
  // `env.onStateChange`) even though `runtime.zig` is pull-based. Stub
  // them so instantiation always succeeds; callers that want logs can
  // override via `opts.imports`.
  return {
    env: {
      debugEnabled: () => 0,
      onDebugLog: (_p: number, _l: number, _t: number) => {},
      onStateChange: () => {},
    },
  };
}

function mergeImports(
  base: WebAssembly.Imports,
  extra: WebAssembly.Imports | undefined
): WebAssembly.Imports {
  if (!extra) return base;
  const out: WebAssembly.Imports = { ...base };
  for (const [ns, nsObj] of Object.entries(extra)) {
    out[ns] = { ...(out[ns] ?? {}), ...nsObj };
  }
  return out;
}

export class CircRuntime {
  private exports: RuntimeExports;
  /** Raw WASM module bytes — kept so we can re-extract the topology section. */
  private rawBytes: Uint8Array;
  private _topology: FullTopology;
  /** id → component, for width lookups when reading/driving by id. */
  private byId: Map<number, FullComponent>;
  /** Which export ABI this module exposes (detected at construction). */
  private abi: RuntimeAbi;
  /**
   * JS-side mirror of every `setPin` call. Kept so input-pin colors stay
   * correct even if the runtime returns undefined for a pin we've driven
   * (defensive — the current runtime echoes driven pins back).
   */
  private localPinStates = new Map<number, BitValue>();

  constructor(
    instance: WebAssembly.Instance,
    rawBytes: Uint8Array,
    topology: FullTopology
  ) {
    this.exports = instance.exports as unknown as RuntimeExports;
    this.rawBytes = rawBytes;
    this._topology = topology;
    this.byId = new Map(topology.components.map((c) => [c.id, c]));
    this.abi =
      typeof this.exports.getOutputValue === "function" &&
      typeof this.exports.getOutputDefined === "function"
        ? "v2"
        : "v1";
  }

  /** Bit width of a component (1 if unknown). */
  private widthOf(componentId: number): number {
    return this.byId.get(componentId)?.width ?? 1;
  }

  static async loadFromUrl(url: string, opts: LoadOptions = {}): Promise<CircRuntime> {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`runtime: fetch ${url} failed: ${resp.status}`);
    const buf = new Uint8Array(await resp.arrayBuffer());
    return CircRuntime.loadFromBytes(buf, opts);
  }

  static async loadFromBytes(
    bytes: Uint8Array,
    opts: LoadOptions = {}
  ): Promise<CircRuntime> {
    const module = await WebAssembly.compile(bytes);
    const imports = mergeImports(defaultImports(), opts.imports);
    const instance = await WebAssembly.instantiate(module, imports);
    const exp = instance.exports as unknown as RuntimeExports;

    // The runtime parses a `circ.topology.v0.min` (CIRC) blob staged in
    // linear memory; we copy the artifact's own custom section into a
    // buffer obtained from `topology_alloc(size)` and then call `init()`.
    // The renderer continues to consume the richer `.v0.full` (CIRF)
    // section directly from the module bytes for names + origin chains.
    const minSections = WebAssembly.Module.customSections(module, "circ.topology.v0.min");
    if (minSections.length === 0) {
      throw new Error(
        "runtime: missing `circ.topology.v0.min` custom section — was this .wasm compiled with `circ-compiler`?"
      );
    }
    const minBytes = new Uint8Array(minSections[0]);

    if (typeof exp.topology_alloc !== "function") {
      throw new Error("runtime: `topology_alloc` export is missing — incompatible runtime");
    }
    const ptr = exp.topology_alloc(minBytes.length);
    if (!ptr) {
      throw new Error(`runtime: topology_alloc(${minBytes.length}) returned null`);
    }
    new Uint8Array(exp.memory.buffer).set(minBytes, ptr);

    if (!opts.noAutoInit) {
      try {
        exp.init();
      } catch (e) {
        throw new Error(`runtime: init() threw: ${(e as Error).message}`);
      }
    }

    const fullSections = WebAssembly.Module.customSections(module, "circ.topology.v0.full");
    if (fullSections.length === 0) {
      throw new Error(
        "runtime: missing `circ.topology.v0.full` custom section — needed for rendering"
      );
    }
    const topology = decodeFullTopology(new Uint8Array(fullSections[0]));
    const rt = new CircRuntime(instance, bytes, topology);

    // Boot every input pin to LOW so downstream gates settle into defined
    // 0/1 states instead of `undefined` — otherwise the user has to click
    // every input once before the first interaction propagates.
    if (!opts.noAutoInit && !opts.noInitialPinDrive) {
      for (const c of topology.components) {
        if (c.kind === ComponentKind.InputPin) rt.setPinSignal(c.id, 0);
      }
      rt.run();
    }

    return rt;
  }

  get topology(): FullTopology {
    return this._topology;
  }

  /** Drain the event queue until the circuit settles. */
  run(): void {
    this.exports.run();
  }

  /** Cold-start: every component's state returns to undefined. */
  reset(): void {
    this.exports.reset?.();
  }

  /**
   * Drive an input pin with a full width-aware value. `value`/`defined` are
   * masked to the pin's width before crossing the boundary. Caller must
   * `run()` afterwards (or use `setValueAndRun`).
   */
  setValue(componentId: number, value: bigint, defined: bigint): void {
    const width = this.widthOf(componentId);
    const mask = widthMask(width);
    const v = value & mask;
    const d = defined & mask;
    this.localPinStates.set(componentId, { value: v, defined: d, width });
    if (this.abi === "v2") {
      this.exports.setPin(componentId, v, d);
    } else {
      // v1 scalar ABI: collapse to a tri-state (width-1 only).
      this.exports.setPin(componentId, signalOf({ value: v, defined: d, width }));
    }
  }

  /**
   * Drive an input pin from a single tri-state level, applied to every bit:
   * High → all-ones (fully defined), Low → all-zeros (fully defined),
   * Undefined → fully undefined. Convenient for click-to-toggle UIs.
   */
  setPinSignal(componentId: number, state: Signal): void {
    const mask = widthMask(this.widthOf(componentId));
    if (state === 2) this.setValue(componentId, 0n, 0n);
    else this.setValue(componentId, state === 1 ? mask : 0n, mask);
  }

  /**
   * Read the current settled value of a component as a width-aware
   * `BitValue`. Pairs the two boundary getters with the component's width.
   * Falls back to the JS-mirrored input-pin value if the runtime reports a
   * driven pin as fully undefined (defensive).
   */
  readValue(componentId: number): BitValue {
    const width = this.widthOf(componentId);
    const mask = widthMask(width);
    let bv: BitValue;
    if (this.abi === "v2") {
      const value = BigInt.asUintN(64, this.exports.getOutputValue!(componentId));
      const defined = BigInt.asUintN(64, this.exports.getOutputDefined!(componentId));
      bv = { value: value & mask, defined: defined & mask, width };
    } else {
      // v1 scalar ABI: 0/1 → defined bit, 2 → undefined (width-1).
      const s = this.exports.getOutputState!(componentId);
      bv = s === 2 ? { value: 0n, defined: 0n, width } : { value: BigInt(s & 1), defined: 1n, width };
    }
    if (bv.defined === 0n) {
      const fallback = this.localPinStates.get(componentId);
      if (fallback) return fallback;
    }
    return bv;
  }

  /** Collapsed single-bit view of a component's value (for coloring). */
  getOutputState(componentId: number): Signal {
    return signalOf(this.readValue(componentId));
  }

  /** Drive an input pin (tri-state) and immediately settle. */
  setPinAndRun(componentId: number, state: Signal): void {
    this.setPinSignal(componentId, state);
    this.run();
  }

  /** Drive an input pin (full value) and immediately settle. */
  setValueAndRun(componentId: number, value: bigint, defined: bigint): void {
    this.setValue(componentId, value, defined);
    this.run();
  }

  /**
   * Read the settled value for every component in the topology, including
   * non-pin nodes — the renderer uses this to color wires and label buses.
   */
  snapshot(): Map<number, BitValue> {
    const out = new Map<number, BitValue>();
    for (const c of this._topology.components) {
      out.set(c.id, this.readValue(c.id));
    }
    return out;
  }

  /** Collapsed single-bit snapshot, for callers that only need tri-state. */
  signalSnapshot(): Map<number, Signal> {
    const out = new Map<number, Signal>();
    for (const c of this._topology.components) {
      out.set(c.id, signalOf(this.readValue(c.id)));
    }
    return out;
  }

  destroy(): void {
    try {
      this.exports.deinit?.();
    } catch {
      // ignore — the module may already be torn down
    }
  }

  /** Escape hatch for callers that need direct access to the WASM exports. */
  get raw(): RuntimeExports {
    return this.exports;
  }
}
