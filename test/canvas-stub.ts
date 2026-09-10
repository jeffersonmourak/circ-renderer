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

/**
 * The one element the value editor creates. It records what the canvas sets
 * on it and lets a test type into it and press keys; nothing is rendered.
 */
export interface StubInput {
  tagName: 'INPUT';
  type: string;
  value: string;
  title: string;
  maxLength: number;
  style: Record<string, string>;
  attrs: Map<string, string>;
  focused: boolean;
  selected: boolean;
  removed: boolean;
  listeners: Map<string, Set<(e: unknown) => void>>;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
  addEventListener(type: string, fn: (e: unknown) => void): void;
  removeEventListener(type: string, fn: (e: unknown) => void): void;
  dispatchEvent(type: string, event?: unknown): void;
  focus(): void;
  select(): void;
  blur(): void;
  remove(): void;
  /** Press a key as the reader would: a keydown carrying `key`. */
  press(key: string): void;
}

export function makeStubInput(): StubInput {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const attrs = new Map<string, string>();
  const el: StubInput = {
    tagName: 'INPUT',
    type: 'text',
    value: '',
    title: '',
    maxLength: -1,
    style: {},
    attrs,
    focused: false,
    selected: false,
    removed: false,
    listeners,
    setAttribute: (n, v) => { attrs.set(n, v); },
    getAttribute: (n) => attrs.get(n) ?? null,
    removeAttribute: (n) => { attrs.delete(n); },
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent(type, event = {}) {
      for (const fn of listeners.get(type) ?? []) fn(event);
    },
    focus() { el.focused = true; },
    select() { el.selected = true; },
    blur() {
      el.focused = false;
      el.dispatchEvent('blur', {});
    },
    remove() { el.removed = true; },
    press(key) {
      let prevented = false;
      el.dispatchEvent('keydown', { key, preventDefault: () => { prevented = true; }, stopPropagation: () => {} });
      void prevented;
    },
  };
  return el;
}

export interface StubWindow {
  listeners: Map<string, Set<(e: unknown) => void>>;
  addEventListener(type: string, fn: (e: unknown) => void, opts?: unknown): void;
  removeEventListener(type: string, fn: (e: unknown) => void, opts?: unknown): void;
  dispatchEvent(type: string, event?: unknown): void;
}

/**
 * Installs a `document` that hands back stub canvases and stub inputs, holds
 * a `body` that records what is appended, and a `window` that records the
 * listeners the value editor attaches. Returns the uninstaller and everything
 * it created.
 */
export function installStubDocument(): {
  created: StubCanvas[];
  inputs: StubInput[];
  body: { children: unknown[] };
  window: StubWindow;
  uninstall: () => void;
} {
  const created: StubCanvas[] = [];
  const inputs: StubInput[] = [];
  const body = { children: [] as unknown[] };
  const g = globalThis as { document?: unknown; window?: unknown };
  const hadDocument = 'document' in g;
  const previousDocument = g.document;
  const hadWindow = 'window' in g;
  const previousWindow = g.window;

  const windowListeners = new Map<string, Set<(e: unknown) => void>>();
  const window: StubWindow = {
    listeners: windowListeners,
    addEventListener(type, fn) {
      if (!windowListeners.has(type)) windowListeners.set(type, new Set());
      windowListeners.get(type)!.add(fn);
    },
    removeEventListener(type, fn) {
      windowListeners.get(type)?.delete(fn);
    },
    dispatchEvent(type, event = {}) {
      for (const fn of windowListeners.get(type) ?? []) fn(event);
    },
  };

  const document = {
    activeElement: null as unknown,
    body: {
      appendChild(el: unknown) {
        body.children.push(el);
        return el;
      },
    },
    createElement(tag: string) {
      if (tag === 'canvas') {
        const el = makeStubCanvas();
        created.push(el);
        return el;
      }
      if (tag === 'input') {
        const el = makeStubInput();
        const focus = el.focus;
        // Focusing makes it the active element, the way a document would.
        el.focus = () => { focus(); document.activeElement = el; };
        inputs.push(el);
        return el;
      }
      throw new Error(`canvas-stub: unexpected <${tag}>`);
    },
  };
  g.document = document;
  g.window = window;
  return {
    created,
    inputs,
    body,
    window,
    uninstall() {
      if (hadDocument) g.document = previousDocument;
      else delete g.document;
      if (hadWindow) g.window = previousWindow;
      else delete g.window;
    },
  };
}
