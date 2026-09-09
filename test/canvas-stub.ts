// A canvas element and a 2D context with just enough surface for CircCanvas to
// construct, draw and attach under `bun test`. There is no DOM here, and no
// jsdom: the class only needs an element that answers a handful of calls, so
// the stub answers exactly those and records the rest.
//
// `getBoundingClientRect` reports the element's own intended extent, so
// `componentAtEvent`'s `intendedW / rect.width` rescale is the identity and a
// synthesised pointer event lands where the test says it does.

export interface StubCanvas {
  style: Record<string, string>;
  width: number;
  height: number;
  removed: boolean;
  listeners: Map<string, Set<(e: unknown) => void>>;
  getContext(kind: string): unknown;
  remove(): void;
  addEventListener(type: string, fn: (e: unknown) => void): void;
  removeEventListener(type: string, fn: (e: unknown) => void): void;
  dispatchEvent(type: string, event: unknown): void;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
}

/** Every 2D-context member is a no-op; assignments to state are just kept. */
function recordingContext(): unknown {
  const state: Record<string, unknown> = {};
  return new Proxy(state, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      // Methods are no-ops that return something chainable-ish.
      const fn = () => undefined;
      target[prop as string] = fn;
      return fn;
    },
    set(target, prop, value) {
      target[prop as string] = value;
      return true;
    },
  });
}

export function makeStubCanvas(): StubCanvas {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const el: StubCanvas = {
    style: {},
    width: 0,
    height: 0,
    removed: false,
    listeners,
    getContext: () => recordingContext(),
    remove() {
      el.removed = true;
    },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent(type, event) {
      for (const fn of listeners.get(type) ?? []) fn(event);
    },
    // The INTENDED extent — what the renderer wrote into `style` — not the
    // device-pixel backing size, so `componentAtEvent`'s rescale is identity.
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: Number.parseFloat(el.style.width ?? '0') || el.width,
      height: Number.parseFloat(el.style.height ?? '0') || el.height,
    }),
  };
  return el;
}

/** Installs a `document` whose only job is to hand back stub canvases.
 *  Returns the uninstaller and the list of elements it created. */
export function installStubDocument(): { created: StubCanvas[]; uninstall: () => void } {
  const created: StubCanvas[] = [];
  const g = globalThis as { document?: unknown };
  const had = 'document' in g;
  const previous = g.document;
  g.document = {
    createElement(tag: string) {
      if (tag !== 'canvas') throw new Error(`canvas-stub: unexpected <${tag}>`);
      const el = makeStubCanvas();
      created.push(el);
      return el;
    },
  };
  return {
    created,
    uninstall() {
      if (had) g.document = previous;
      else delete g.document;
    },
  };
}
