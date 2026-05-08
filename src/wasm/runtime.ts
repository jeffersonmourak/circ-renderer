import {
  ComponentKind,
  decodeFullTopology,
  type FullTopology,
  type Signal,
} from "./topology";

/**
 * Exports of a per-circuit `.wasm` artifact emitted by `circ-compiler`
 * (see `templates/main.zig`). The host stages the topology blob into
 * linear memory via `topology_alloc` + memcpy, then calls `init()`. The
 * runtime parses it from there. Other lifecycle exports (`reset`,
 * `deinit`, …) are looked up best-effort — they may not exist yet.
 */
interface RuntimeExports {
  memory: WebAssembly.Memory;
  /** Allocate `size` bytes in linear memory; returns a pointer the host
   * must write the topology blob to before calling `init()`. */
  topology_alloc: (size: number) => number;
  init: () => void;
  run: () => void;
  setPin: (componentId: number, state: number) => void;
  getOutputState: (componentId: number) => number;
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
  /**
   * JS-side mirror of every `setPin` call. We keep this so wire/component
   * colors stay correct for input pins even if the WASM runtime doesn't
   * surface their state through `getOutputState` (today's emitter only
   * gates that read for declared output_pins).
   */
  private localPinStates = new Map<number, Signal>();

  constructor(
    instance: WebAssembly.Instance,
    rawBytes: Uint8Array,
    topology: FullTopology
  ) {
    this.exports = instance.exports as unknown as RuntimeExports;
    this.rawBytes = rawBytes;
    this._topology = topology;
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
        if (c.kind === ComponentKind.InputPin) rt.setPin(c.id, 0);
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

  /** Drive an input pin. Caller must `run()` afterwards. */
  setPin(componentId: number, state: Signal): void {
    this.localPinStates.set(componentId, state);
    this.exports.setPin(componentId, state);
  }

  /**
   * Read the current settled output of a component. The runtime returns
   * real values for every primitive (pins, gates, output pins). The
   * JS-mirrored input-pin state is only consulted as a defensive
   * fallback when the runtime returns `undefined` for a pin we've driven.
   */
  getOutputState(componentId: number): Signal {
    const v = this.exports.getOutputState(componentId);
    const sig = ((v === 0 || v === 1 || v === 2) ? v : 2) as Signal;
    if (sig === 2) {
      const fallback = this.localPinStates.get(componentId);
      if (fallback !== undefined) return fallback;
    }
    return sig;
  }

  /** Drive an input pin and immediately settle. Convenience for UI events. */
  setPinAndRun(componentId: number, state: Signal): void {
    this.setPin(componentId, state);
    this.run();
  }

  /**
   * Read the settled state for every component in the topology, including
   * non-pin nodes — useful for the renderer to pick wire colors per signal.
   */
  snapshot(): Map<number, Signal> {
    const out = new Map<number, Signal>();
    for (const c of this._topology.components) {
      out.set(c.id, this.getOutputState(c.id));
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
