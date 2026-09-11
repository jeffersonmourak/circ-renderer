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
  /** The pointers the canvas holds captured, by id. */
  captured: Set<number>;
  setPointerCapture(id: number): void;
  releasePointerCapture(id: number): void;
  hasPointerCapture(id: number): boolean;
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
    captured: new Set<number>(),
    setPointerCapture(id) { el.captured.add(id); },
    releasePointerCapture(id) { el.captured.delete(id); },
    hasPointerCapture(id) { return el.captured.has(id); },
  };
  return el;
}

/**
 * An element the value editor creates: the dialog, its text field and slider,
 * its three buttons and the name label. It records what the canvas sets on it
 * and lets a test type into it, press keys and click; nothing is rendered.
 * `contains` walks the children, since the editor uses it to tell a click
 * inside the dialog from one outside.
 */
export interface StubElement {
  tagName: string;
  type: string;
  value: string;
  title: string;
  textContent: string;
  className: string;
  maxLength: number;
  min: string;
  max: string;
  step: string;
  style: Record<string, string>;
  attrs: Map<string, string>;
  children: StubElement[];
  parent: StubElement | null;
  focused: boolean;
  selected: boolean;
  removed: boolean;
  listeners: Map<string, Set<(e: unknown) => void>>;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  removeAttribute(name: string): void;
  appendChild(el: StubElement): StubElement;
  contains(el: unknown): boolean;
  addEventListener(type: string, fn: (e: unknown) => void): void;
  removeEventListener(type: string, fn: (e: unknown) => void): void;
  dispatchEvent(type: string, event?: unknown): void;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number; right: number; bottom: number };
  focus(): void;
  select(): void;
  blur(): void;
  click(): void;
  remove(): void;
  /** Press a key as the reader would: a keydown carrying `key`. */
  press(key: string): void;
}

/** Kept for readers of older tests: the text field is a StubElement. */
export type StubInput = StubElement;

export function makeStubElement(tag: string): StubElement {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  const attrs = new Map<string, string>();
  const el: StubElement = {
    tagName: tag.toUpperCase(),
    type: tag === 'input' ? 'text' : tag === 'button' ? 'submit' : '',
    value: '',
    title: '',
    textContent: '',
    className: '',
    maxLength: -1,
    min: '',
    max: '',
    step: '',
    style: {},
    attrs,
    children: [],
    parent: null,
    focused: false,
    selected: false,
    removed: false,
    listeners,
    setAttribute: (n, v) => { attrs.set(n, v); },
    getAttribute: (n) => attrs.get(n) ?? null,
    removeAttribute: (n) => { attrs.delete(n); },
    appendChild(child) {
      child.parent = el;
      el.children.push(child);
      return child;
    },
    contains(node) {
      if (node === el) return true;
      return el.children.some((c) => c.contains(node));
    },
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
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 }),
    focus() { el.focused = true; },
    select() { el.selected = true; },
    blur() {
      el.focused = false;
      el.dispatchEvent('blur', {});
      // A blur is a focusout that bubbles to the dialog, going nowhere.
      let up: StubElement | null = el;
      while (up) { up.dispatchEvent('focusout', { target: el, relatedTarget: null }); up = up.parent; }
    },
    click() { el.dispatchEvent('click', { target: el, preventDefault: () => {} }); },
    remove() {
      // A removed subtree is gone from the document, children included: the
      // tests ask a field inside a dialog whether it is still on the page.
      const mark = (n: StubElement) => { n.removed = true; n.children.forEach(mark); };
      mark(el);
      if (el.parent) el.parent.children = el.parent.children.filter((c) => c !== el);
    },
    press(key) {
      el.dispatchEvent('keydown', { key, preventDefault: () => {}, stopPropagation: () => {} });
    },
  };
  return el;
}

export interface StubWindow {
  innerWidth: number;
  innerHeight: number;
  /** Set by a test to stand in for a high-density display; 1 by default. */
  devicePixelRatio?: number;
  listeners: Map<string, Set<(e: unknown) => void>>;
  addEventListener(type: string, fn: (e: unknown) => void, opts?: unknown): void;
  removeEventListener(type: string, fn: (e: unknown) => void, opts?: unknown): void;
  dispatchEvent(type: string, event?: unknown): void;
}

export interface StubDocument {
  activeElement: unknown;
  body: { appendChild(el: unknown): unknown };
  listeners: Map<string, Set<(e: unknown) => void>>;
  addEventListener(type: string, fn: (e: unknown) => void, opts?: unknown): void;
  removeEventListener(type: string, fn: (e: unknown) => void, opts?: unknown): void;
  dispatchEvent(type: string, event?: unknown): void;
  createElement(tag: string): unknown;
}

/**
 * Installs a `document` that hands back stub canvases and stub elements, holds
 * a `body` that records what is appended, and a `window` that records the
 * listeners the value editor attaches. Returns the uninstaller and everything
 * it created; `inputs` is the text fields alone, in creation order, so the
 * first field a test opens is `inputs[0]` whatever else the dialog holds.
 */
export function installStubDocument(): {
  created: StubCanvas[];
  elements: StubElement[];
  readonly inputs: StubElement[];
  readonly sliders: StubElement[];
  readonly buttons: StubElement[];
  readonly dialogs: StubElement[];
  body: { children: unknown[] };
  window: StubWindow;
  document: StubDocument;
  uninstall: () => void;
} {
  const created: StubCanvas[] = [];
  const elements: StubElement[] = [];
  const body = { children: [] as unknown[] };
  const g = globalThis as { document?: unknown; window?: unknown };
  const hadDocument = 'document' in g;
  const previousDocument = g.document;
  const hadWindow = 'window' in g;
  const previousWindow = g.window;

  const listenerBag = () => {
    const map = new Map<string, Set<(e: unknown) => void>>();
    return {
      listeners: map,
      addEventListener(type: string, fn: (e: unknown) => void) {
        if (!map.has(type)) map.set(type, new Set());
        map.get(type)!.add(fn);
      },
      removeEventListener(type: string, fn: (e: unknown) => void) {
        map.get(type)?.delete(fn);
      },
      dispatchEvent(type: string, event: unknown = {}) {
        for (const fn of map.get(type) ?? []) fn(event);
      },
    };
  };

  const window: StubWindow = { innerWidth: 1024, innerHeight: 768, ...listenerBag() };

  const document: StubDocument = {
    ...listenerBag(),
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
      if (tag === 'input' || tag === 'div' || tag === 'button' || tag === 'span' || tag === 'label') {
        const el = makeStubElement(tag);
        const focus = el.focus;
        // Focusing makes it the active element, the way a document would.
        el.focus = () => { focus(); document.activeElement = el; };
        elements.push(el);
        return el;
      }
      throw new Error(`canvas-stub: unexpected <${tag}>`);
    },
  };
  g.document = document;
  g.window = window;
  return {
    created,
    elements,
    get inputs() { return elements.filter((e) => e.tagName === 'INPUT' && e.type !== 'range'); },
    get sliders() { return elements.filter((e) => e.tagName === 'INPUT' && e.type === 'range'); },
    get buttons() { return elements.filter((e) => e.tagName === 'BUTTON'); },
    get dialogs() { return elements.filter((e) => e.getAttribute('role') === 'dialog'); },
    body,
    window,
    document,
    uninstall() {
      if (hadDocument) g.document = previousDocument;
      else delete g.document;
      if (hadWindow) g.window = previousWindow;
      else delete g.window;
    },
  };
}
