# circ-renderer

Render and simulate compiled `circ-compiler` WebAssembly artifacts in the browser. The `.wasm` ships with both the simulation runtime and a topology blob — this library reads the topology, lays the circuit out, draws it to a canvas, and forwards user interaction (clicks on input pins) into the WASM.

> **Status.** Replaces the old `.circ` XML loader. The lib stages the topology into linear memory and drives the WASM directly; click an input pin and the simulation propagates through gates back into the canvas.

## Quick start

```bash
bun install circ-renderer
```

```ts
import { renderCircuit } from "circ-renderer";

const view = await renderCircuit({
  url: "/static/and_gate.wasm",
  cell: 16,         // pixels per layout cell
  interactive: true // click input pins to toggle
});
document.body.appendChild(view.canvas);
```

When the user clicks an input pin the lib calls `setPin` + `run` on the WASM, snapshots the new state, and re-renders.

Multi-bit nets (buses, widths 1–64) are supported: bus wires render heavier in the `wireBus` color and carry a hex value badge above each component. The runtime reads values as width-aware `BitValue`s (`{ value, defined, width }`, the masks are `bigint`); single-bit nets collapse to the usual idle/active/undefined coloring.

## API

### `renderCircuit(opts) → Promise<CircView>`

| field          | type                                | notes |
|----------------|-------------------------------------|-------|
| `url` \| `bytes` | `string` \| `Uint8Array`           | one is required |
| `cell`         | `number` (default 12)               | pixels per layout cell |
| `padding`      | `number` (default 4)                | pixels around the canvas grid |
| `theme`        | `CircTheme`                         | colors + skins, see below |
| `interactive`  | `boolean` (default true)            | enable pin clicks |
| `layoutOptions`| `{ expandMacros?: boolean }`        | passed through to layout |
| `onPinChange`  | `(id, value: BitValue) => void`     | called after a reader changes an input pin — a click on a single bit, or a value typed into a bus. This is the one to mirror; replay it with `view.setInputValue(id, value, defined)` |
| `onPinToggle`  | `(id, signal) => void`              | the older, scalar form of the same event. Still fires, but it is **lossy for a bus**: a mixed value collapses to `High`, so a host that replays what it reports will replay all-ones. Prefer `onPinChange` |
| `onPinEdit`    | `(req) => boolean \| void`         | called when a reader clicks a pin wider than one bit. Return `true` to open your own editor; the built-in field then stays closed. `req` carries the pin's `id`, its current `value`, its `box` in CSS pixels relative to the canvas, and `commit(value, defined)` / `cancel()` |
| `valueFormat`  | `'hex' \| 'binary' \| 'decimal'`  | the base the bus badge is written in and a bare typed value is read in. Default `hex`. `0x` and `0b` in the field override it |
| `onHover`      | `(id \| null) => void`              | called when the pointer moves onto a different component box, and with `null` on leave; fires only on a change, so a host can drive an editor highlight straight from it |

Returns `{ runtime, view, canvas, destroy() }`.

### Lower-level building blocks

```ts
import { CircRuntime, buildLayout, CircCanvas } from "circ-renderer";

const runtime = await CircRuntime.loadFromBytes(wasmBytes);
const layout  = buildLayout(runtime.topology);   // pure data, no DOM
const view    = new CircCanvas(runtime, { cell: 14 });
```

### Driving a bus pin

A click on a pin wider than one bit opens a small text field over the pin,
seeded with its current value. Enter drives what was typed; Escape, clicking
away, scrolling or resizing closes it without driving anything. The field
accepts the same spellings as the circ playground's memory grid: hex by
default, `0x` and `0b` prefixes override, `_` groups digits, and `?` or an
empty field means unknown. A value the pin cannot hold keeps the field open
with the reason as its tooltip.

A single-bit pin keeps its click-to-toggle exactly as before.

`CircCanvas` also exposes these host hooks:

- `view.setInputValue(id, value, defined)` drives an input pin to an exact
  value, masked to its width, and redraws. `view.setInputSignal(id, signal)` is
  the scalar form and drives every bit. Neither fires a callback.
- `view.getInputValue(id)` returns what the canvas last drove a pin to, or
  `null` for one it never has — enough to replay a rebuilt canvas from.
- `view.boxOf(id)` returns a component's box in CSS pixels relative to the
  canvas element, following any shrink page CSS applies, so a host can anchor
  its own editor over a pin.

- `view.setHighlight(id | null)` highlights one component from outside the canvas — an editor cursor, a table header — through the same `hovered` flag the pointer drives, so a skin needs no second branch. `null` clears it, and an id with no box is a no-op.
- `view.getLayout()` returns the `LayoutGrid` the canvas drew. A host needs it to map a declared name to a box: a collapsed subcircuit carries a synthetic id that exists only in the layout, never in `runtime.topology.components`.

### Changing the look of a live canvas

`view.setTheme(theme)`, `view.setCell(px)`, `view.setPadding(px)` and
`view.setValueFormat(base)` change a canvas in place and redraw it. Nothing
else changes: the runtime, its pins, its typed bus values and its loaded
memories are untouched. Before these, a host that wanted a different theme
had to destroy the canvas and build another, and every one of those was lost
with the old instance. `view.redraw()` repaints from the current state, for
something the canvas cannot see change — a sprite sheet finishing its load.

### Memories

A `rom` or `ram` carries its shape in the artifact and none of its contents;
they are runtime state the host loads and reads back. `CircRuntime` types
that whole surface, so nothing has to reach through `raw`:

```ts
const [code] = runtime.memories();          // { id, name: "code", info: { kind: "rom", width: 8, addrWidth: 4 } }
runtime.loadMemImage(code.id, bytes);       // ceil(W/8) little-endian bytes per word, at most 2^A words
runtime.readMemWord(code.id, 3);            // { value, defined, width } — unknown until something loads it
runtime.writeMemWord(code.id, 3, 0x7fn, 0xffn);
runtime.storeMemImage(code.id);             // the contents back as an image, unknown words as zero
runtime.clearMem(code.id);                  // every word unknown again
```

`memories()` lists top-level memories the runtime confirms, so a name from
the source maps to an id without a second lookup. Every mutator returns the
runtime's own status (`0` is success; the codes are in circ-compiler's
`DOCS/wasm-api.md`), or `MEM_ABSENT` on an artifact built before memories
existed — check `runtime.hasMemory` first to avoid that case. A mutator
re-presents the memory's `out` at once, so `view.refreshState()` is enough
afterwards; no `run()` is needed. A ram loads exactly as a rom does.

`buildLayout` is a pure function — useful if you want to skip Canvas and render the layout to SVG, React, or anything else. It runs the same five-stage pipeline (collapse → columns → rows → place → route) that the Zig CLI's `--preview` uses, ported to TypeScript.

## Theming

A theme is a record of colors plus optional per-kind drawing functions. A skin's
`hovered` flag is true when the pointer is over that component **or** when the
host highlighted it with `setHighlight`, so one branch covers both. Defaults are tuned for a light blog page; supply your own to match your site.

```ts
import {
  renderCircuit,
  defaultColors,
  type CircTheme,
  type ThemeColorKey,
} from "circ-renderer";
import { ComponentKind } from "circ-renderer";

const theme: CircTheme<ThemeColorKey> = {
  colors: {
    ...defaultColors,
    background: "#0f172a",
    stroke:     "#94a3b8",
    fillIdle:   "#1e293b",
    fillActive: "#22d3ee",
    fillUndefined: "#334155",
    wireIdle:   "#475569",
    wireActive: "#22d3ee",
    wireUndefined: "#334155",
    label:      "#e2e8f0",
    labelMuted: "#64748b",
    macro:      "#a78bfa",
    grid:       "#1e293b",
  },
  font: '600 10px "JetBrains Mono", ui-monospace, monospace',
  // override a single component skin
  skins: {
    [ComponentKind.Led]: ({ ctx, cell, component, inputSignals, theme }) => {
      // ... your custom Canvas drawing for an LED
    },
  },
};

await renderCircuit({ url: "/static/foo.wasm", theme });
```

### Theme color keys

| key              | used for                                       |
|------------------|-----------------------------------------------|
| `background`     | canvas fill                                   |
| `grid`           | reserved for future grid backgrounds           |
| `stroke`         | gate borders                                  |
| `fillIdle`       | gate body when its output is `0`              |
| `fillActive`     | gate body / LED ring when output is `1`       |
| `fillUndefined`  | gate body when output is undefined            |
| `wireIdle`       | width-1 wire showing a `0` signal             |
| `wireActive`     | width-1 wire showing a `1` signal             |
| `wireUndefined`  | wire showing an undefined signal              |
| `wireBus`        | multi-bit (width > 1) wire with a defined value |
| `busLabel`       | text color of bus value badges (e.g. `0x0F`)  |
| `label`          | text on gates                                 |
| `labelMuted`     | reserved for secondary labels                 |
| `macro`          | subcircuit (collapsed) box border             |
| `highlight`      | ring around a hovered or host-highlighted box |

### Highlight

A hovered component, and one the host marks with `view.setHighlight(id)`, gets
a ring drawn around its box — by the canvas, after every skin, for every kind.
A skin does not have to read `hovered` to be reachable, though it still may.
A theme can take the ring over with `highlight({ ctx, theme, cell, component,
reason })`, where `reason` is `hover`, `highlight` or `both`, or pass a no-op
to draw none. The default ring uses the `highlight` colour.

### Building a skin from the default pieces

The helpers the default skins are built from are exported — `boxOutline`,
`drawLabel`, `memoryLabel`, and the colour resolvers `fill`, `stroke`,
`labelColor` and `color` — along with each default skin (`drawMemory`,
`drawSlice`, `drawConcat`, `drawSubcircuit` and the rest). A host that draws
its own gates can give a rom, ram, slice or concat the same look in a few
lines, or wrap a default skin and add to it.

### The bus value badge

Every multi-bit net is labelled with its value above its box. A theme can take
that over with `busValue({ ctx, theme, cell, component, value, text })`, where
`text` is already spelled in the canvas's `valueFormat`; pass a no-op to draw no
badge. A half-known bus is written bit by bit with `x` for each unknown bit
rather than hidden behind one `?`.

### Skin functions

Each skin receives:

```ts
type Skin = (ctx: {
  ctx: CanvasRenderingContext2D;
  theme: CircTheme;
  cell: number;
  component: PlacedComponent;     // x, y, width, height in CELLS, not pixels;
                                  // plus bitWidth and (for slices) slice {lo,hi}
  inputSignals: Signal[];          // collapsed tri-state, one per in_port
  outputSignal: Signal;            // 0 | 1 | 2
  inputValues: BitValue[];         // width-aware value per in_port
  outputValue: BitValue;           // { value, defined, width }, masks are bigint
  hovered: boolean;
}) => void;
```

Multiply cell-space numbers by `cell` to get pixels. Use `outputValue`/`inputValues` for width-aware (bus) rendering and `outputSignal`/`inputSignals` for simple tri-state coloring. The default skins live in `src/render/skins.ts` if you want to copy a starting point.

## How it gets the topology

The compiled `.wasm` carries two custom sections produced by `circ-compile`:

- **`circ.topology.v0.min`** (magic `CIRC`) — the lightweight payload the *runtime* parses (`id`, `kind`, `width`, connections). Boot path: `topology_alloc(size) → memcpy → init()`.
- **`circ.topology.v0.full`** (magic `CIRF`) — the rich payload the *renderer* parses (adds `name`, `width`, origin chain, and slice `[lo, hi)` aux). Decoded directly from the module bytes; no extra fetch.

The decoder accepts **CIRF v0x01, v0x02 and v0x03** (exported as `SUPPORTED_TOPOLOGY_VERSIONS` for hosts that compile at runtime). v03 adds the `rom`/`ram` kinds (`8`/`9`) with a trailing `addr_width` byte, exposed as `FullComponent.memory`, and the `addr`/`din`/`we`/`clk` port bytes (`4..7`); memory boxes are laid out and drawn with the CLI's `--preview` geometry (`rom code[8,4]`, one `addr` port; a 9-row `ram` box with four ports). The runtime's eight memory exports (`getMemInfo` … `getMemDefined`) are typed on `runtime.raw`; loading images from the canvas is not part of the renderer. v02 added a per-component `width` byte and the slice aux suffix; v01 payloads (pre-2.0 artifacts) decode with width defaulted to 1 and no `slice`/`concat` kinds.

The simulation runtime is driven through one of two export ABIs, detected automatically:

- **v2** (current): `topology_alloc / init / run / setPin(id, value, defined) / getOutputValue(id) / getOutputDefined(id)`, with the `BitVecState` halves crossing as `i64`/`BigInt`.
- **v1** (pre-2.0 artifacts): `topology_alloc / init / run / setPin(id, state) / getOutputState(id)`, scalar tri-state, width-1 only.

`CircRuntime` exposes the width-aware surface (`setValue`/`readValue`/`snapshot`) over both, plus `setPinSignal`/`getOutputState` convenience wrappers. Component IDs are the same across both sections and the runtime.

## Example

`example/` is a small Bun-served demo. To run it:

```bash
bun install
bun run dev
# open http://localhost:3000
```

`example/static/*.wasm` are pre-compiled fixtures from `circ-compiler` (`circ-compile path/to.circ -o foo.wasm`).

## Tests

```bash
bun test        # decode (v01..v03), runtime ABI (incl. memory exports), and layout tests
bun run typecheck
```

`test/fixtures/` holds compiled `.wasm` fixtures: v02 artifacts, the v03 `rom_lookup.wasm` / `ram_write_read.wasm` (memory records, ports and exports), plus a frozen `and_v01.wasm` that guards the v01 decode + scalar-ABI fallback path. The v01/v02 fixtures are never regenerated.