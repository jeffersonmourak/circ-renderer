# Plan: bring circ-renderer up to the playground

The circ website's playground and gallery grew a great deal against a renderer
that stood still. Twelve gaps were found by reading both sides and verified by
trying to refute each one against the code; none were refuted, four were
narrowed. This plan closes them in five phases, each one renderer release and one
site pin bump, in the order that puts the reader's most-asked-for thing first.
One gap is deliberately left out; it is named at the end.

**Where this stands.** The site pins `github:jeffersonmourak/circ-renderer#2a76686`,
the tip of `host-pin-api`, at version `2.1.0-alpha.2`. That branch is three
commits ahead of `main` and unmerged. Every phase below branches from
`host-pin-api` until it lands.

**How to read a phase.** *Renderer* is what changes here. *Site* is what the
playground has to change to consume it, named by file so it is not rediscovered.
*Pins* is the guard the site keeps on each phase: `test/renderer-pin.test.ts`
asserts the installed version and probes the prototype for each method it relies
on, so a phase that ships without its probe is a phase the site cannot tell it
has.

---

## Locked decisions

1. **Value entry is renderer-owned.** A click on a pin whose `bitWidth > 1`
   opens a text field over the pin; the renderer draws it, parses it, and drives
   the runtime. The deciding fact is not taste: the gallery's canvases pass no
   pin callbacks at all (`LiveCanvas.astro:135`, `:187`), so the only design
   that fixes every gallery card by a version bump alone is one where the host
   writes nothing.
2. **A host can take the gesture over.** `onPinEdit` receives the pin, its
   current value and its box; a host that returns `true` has drawn its own
   field and the built-in one stays closed. The playground will do this so it
   keeps its own parser and its own value-format setting. Two editors is the
   failure mode; the boolean is what prevents it.
3. **Width-1 pins do not change.** A click still toggles, exactly as at
   `canvas.ts:190`, and a test pins that. The field is for buses only.
4. **`onPinChange(id, BitValue)` is the truth; `onPinToggle` stays and is
   lossy.** `onPinToggle` keeps its signature and keeps firing — after a bus
   entry, with `signalOf(value)`, which collapses any mixed bus to `High`
   (`topology.ts:110`). That loss is documented in the README beside the
   callback, not hidden. A host that wants the value listens to `onPinChange`.
5. **One spelling of a value, shared with the memory grid.** The field accepts
   what the playground's memory panel already accepts at
   `memory-panel.ts:177`: hex by default, `0x` and `0b` prefixes override,
   `_` groups digits, `?` and empty mean unknown. The parser is ported into the
   renderer as `parsePinValue` so the two surfaces cannot drift; the site may
   later import it in place of its own.
6. **The badge and the field share a base.** `valueFormat: 'hex' | 'binary' |
   'decimal'` on `RenderOptions` drives both what the bus badge above a box
   shows and what a bare (unprefixed) entry means. Today the badge is
   hex-only and outside the theme (`canvas.ts:15`); it becomes a theme hook
   with the current badge as its default.
7. **The field is `position: fixed`, and it closes when the page moves.** The
   renderer owns exactly one element today and cannot position anything
   relative to a parent it does not control. A fixed field placed from
   `getBoundingClientRect()` needs no parent cooperation, and closing it on
   scroll, resize and blur is simpler and more honest than tracking them.
8. **The memory API is typed and rams are loadable through it.** Eight exports
   exist on the artifact and the renderer wraps none of them; the site reaches
   them through `runtime.raw` with hand-written casts in two files. The
   wrappers replace those casts, and the site's `decodeMemInfo` goes.
9. **Highlight is drawn once, in the canvas, after the skin.** Every default
   skin ignores the `hovered` flag it is handed (`skins.ts`, all nine), so a
   host-driven highlight is invisible on any kind the host did not skin. One
   ring drawn by `CircCanvas` for whichever id is hovered or highlighted covers
   every kind at once; a theme can override it or turn it off.
10. **A theme flip is a redraw, not a rebuild.** The drawing already reads the
    theme through a getter (`canvas.ts:145`); `setTheme` swaps it and redraws.
    The site then stops destroying every canvas on a theme change, which is
    what has been throwing away toggled pins and loaded memory images.
11. **Types travel without the renderer.** A package `exports` map with a
    `./topology` subpath lets the site import `ComponentKind` and the value
    types into pages that must not carry the renderer. The site's three
    hand-copied kind bytes (`source-link.ts:45` and two more) go.
12. **Drawing memory contents on the canvas is not in this plan.** The
    addressed word is already shown above a rom or ram box by the bus badge;
    the playground has a whole dock panel for the rest. A neighbourhood around
    the addressed word is a nicety, not a gap a reader is stuck on, and it is
    parked rather than scheduled.

---

## The gaps, as verified

| id | title | severity | side | phase |
|---|---|---|---|---|
| G01 | A bus input can only be driven all-on or all-off | blocking | both | 1 |
| G10 | The bus badge is hex-only and outside the theme | minor | renderer | 1 |
| G08 | No public hit-test, box geometry, or interaction toggle | major | renderer | 1 (the part G01 needs) |
| G02 | No typed memory API; the site casts through `raw` | major | both | 2 |
| G06 | Default skins ignore `hovered`; highlight is invisible | major | renderer | 3 |
| G09 | Slice, concat, rom, ram render in a foreign visual language | major | both | 3 |
| G04 | Theme is captured at construction; a flip rebuilds everything | major | renderer | 4 |
| G05 | No types-only entry point; the site hard-codes kind bytes | major | renderer | 5 |
| G07 | Every `renderCircuit` call is `as any` | major | site | 5 |
| G11 | Dead "older renderer" branch calling a method that never existed | minor | site | 5 |
| G12 | The site's wire renderer duplicates the crossing-jump routine | minor | both | 5 |
| G03 | Only the addressed word of a memory is drawn | minor | renderer | parked |

Corrections from verification, kept so they are not re-derived: G03 is narrower
than first stated, since `drawBusValues` already labels every memory box with
its addressed word. G05 needs no new file, since `src/wasm/topology.ts` is
already pure; it needs an `exports` map. G07 is the site's own doing, since the
renderer's generic `C extends string` already types the palette. G09 excludes
`Wire`, whose default skin is a deliberate no-op.

---

## Phase 1 — a bus pin takes a value

The reader's ask, and the only blocking gap. After this, clicking an 8-bit pin
on any canvas on the site opens a field seeded with its current value; typing
`2a`, `0b101010` or `42` and pressing Enter drives exactly that.

**Renderer.**

- `src/render/pin-value.ts` (new): `parsePinValue(text, width, format)` and
  `formatPinValue(value, format)`, ported from the site's `memory-panel.ts`
  with its tests ported alongside. `ValueFormat` is declared here.
- `src/render/canvas.ts`:
  - `inputState` widens from `Map<number, Signal>` to `Map<number, BitValue>`.
    The width-1 toggle at `:190` compares against the mask instead of `1`.
  - `setInputValue(id, value: bigint, defined: bigint): void` — the width-aware
    sibling of `setInputSignal`, same `isToggleable` guard, calls
    `runtime.setValueAndRun` (which already exists at `runtime.ts:291` and
    already masks to the width), refreshes.
  - `getInputValue(id): BitValue | null` — so a host can replay a rebuilt
    canvas from the canvas rather than from its own mirror.
  - `setInputSignal` becomes a thin wrapper over `setInputValue`.
  - `boxOf(id): { x, y, width, height } | null` in CSS pixels of the canvas
    element, applying the same rect scale the hit-test applies at `:257`.
    This is the piece of G08 the field needs.
  - Click on `bitWidth > 1`: if `options.onPinEdit` exists and returns `true`,
    stop; otherwise open the built-in field. Click on `bitWidth === 1`:
    unchanged.
  - The field: one `<input>`, appended to `document.body`, `position: fixed`
    at `boxOf` translated by the canvas rect, seeded with
    `formatPinValue(current, valueFormat)`, `maxLength` generous. Enter parses
    and commits through `setInputValue`, then fires `onPinChange` and
    `onPinToggle(signalOf)`. A parse failure keeps the field open with
    `aria-invalid` and a title carrying the message, matching the memory grid's
    behaviour. Escape, blur, scroll and resize close it uncommitted. `destroy()`
    removes it.
  - `RenderOptions` gains `onPinChange`, `onPinEdit`, `valueFormat`.
  - The bus badge (`drawBusValues`, `:346`) formats through `formatPinValue`
    with `valueFormat`, and becomes a theme hook `busValue` whose default is the
    current drawing, so a theme can restyle or suppress it.
- `src/index.ts`: export the new module and the new option types.
- `README.md`: the two callbacks, `valueFormat`, and the sentence that
  `onPinToggle` is lossy for a bus.
- `package.json`: `2.2.0-alpha.1`.

**Tests** (`test/canvas.test.ts`, `test/pin-value.test.ts`; the stub in
`test/canvas-stub.ts` gains a minimal `document.body.appendChild` and
`activeElement` so the field can be created, driven and removed headlessly):

- a width-1 pin still toggles on click — the regression guard.
- a click on a 4-bit pin does not set every bit, and opens the field.
- `setInputValue` drives an exact word; it is masked to the width; an unknown
  entry renders `?`.
- `onPinChange` reports the `BitValue` and `onPinToggle` reports its collapse.
- `parsePinValue` accepts every spelling the memory grid accepts, table-driven.
- a click after `setInputValue` flips from the value the host set, on width 1.
- `onPinEdit` returning `true` suppresses the field; the callback got the id,
  the value and a box whose origin matches `boxOf`.
- `destroy()` removes the field and every listener, extending the assertion at
  `test/canvas.test.ts:157`.

**Site.**

- `package.json` and `bun.lock`: the new sha. `renderer-versions.ts`: the new
  version. `renderer-pin.test.ts`: probe `setInputValue`, `getInputValue`,
  `boxOf`.
- `Playground.astro`: `sim.pins` becomes `Map<string, BitValue>`; listen to
  `onPinChange`; replay through `setInputValue`; pass `valueFormat` so the
  badge and a bare entry follow the reader's setting, and rebuild the canvas
  when that setting changes, since the canvas captures it at construction.
  **Shipped without `onPinEdit`.** The plan had the playground open its own
  field to keep its own parser and format; `valueFormat` covers the format,
  and the parser is the same code ported with the same tests, so a second
  field would have been a second thing to keep in step for no gain. The hook
  stays for a host that wants a different UI, which the playground is not.
  The unreachable "older renderer" branch (G11) went in the same edit, since
  the replay it guarded now requires a method the pin test asserts.
- `LiveCanvas.astro`: nothing. That is the point.

**Shipped** as renderer `9694198` (`2.2.0-alpha.1`) and the site pin bump
that follows it.

## Phase 2 — memory through a typed door

**Renderer.** `src/wasm/runtime.ts` exports `RuntimeExports` and adds
`memInfo(id)`, `readMemWord(id, addr)`, `writeMemWord(id, addr, value, defined)`,
`loadMemImage(id, bytes)`, `storeMemImage(id)`, `clearMem(id)`, each guarding
on the export's presence and re-taking the byte view after `memBuffer`, since
that call may grow linear memory. `memInfo` unpacks `(kind << 16) | (W << 8) | A`.
`CircCanvas.refreshState` is already public; the README says a mutator needs no
`run()` first, which is true of the runtime and worth stating.

**Site.** `canvas-memory.ts` and the playground's `memHost`/`memIdOf`/
`readCell` drop their casts and call the wrappers; `decodeMemInfo` is deleted
from `rom-image.ts` once nothing reads it. Probe the six methods.

## Phase 3 — highlight on every kind, and skins the site can match

**Renderer.** `CircCanvas` draws one highlight ring after the skin call for the
hovered or highlighted id, through a new theme hook `highlight` with a default;
a theme sets it to a no-op to draw its own. `src/render/skins.ts` exports the
helpers the defaults are built from — `boxOutline`, `drawLabel`, `memoryLabel`
and the box geometry — so a host can write a rom, ram, slice or concat skin in
the site's own visual language in a few lines.

**Site.** `circ-theme.mjs` sets `highlight` to its existing `drawHoverRing`,
and gains four skins built from the exported helpers. Pointing at a rom in the
editor then lights it on the canvas, which has been an open item since the
playground's Phase 5.

## Phase 4 — a theme flip is a redraw

**Renderer.** `CircCanvas.setTheme(theme)`, and `setCell`/`setPadding` while
there, calling `resize()` when metrics change and redrawing. A public `redraw()`
for a host that changed something the canvas cannot see.

**Site.** `LiveCanvas.astro`'s `rebuildAll` and the playground's theme observer
call `setTheme` instead of destroying and rebuilding. Pin state and loaded
memory images then survive a theme change, and the images no longer need to be
reapplied on rebuild, though that code can stay as belt and braces.

## Phase 5 — types, packaging, and the site's dead weight

**Renderer.** `package.json` gains an `exports` map: `.` and `./topology`.
`src/render/canvas.ts` exports `wirePath(wire, cell, arcRadius): Path2D` so a
theme restyles a wire without re-deriving the crossing jumps.

**Site.** `source-link.ts`, `Playground.astro` and `canvas-memory.ts` import
`ComponentKind` from `circ-renderer/topology` and delete their hand-copied
bytes. The local `CircView` types in both components go; `renderCircuit` is
called through the renderer's generic with the site's palette type, and the
three `as any` casts with it. The unreachable "older renderer" branch at
`Playground.astro:2745`, whose fallback calls a `readSignal` that has never
existed, is deleted. `circ-theme.mjs`'s wire renderer takes `value` and styles
a bus as a bus.

---

## Recurring traps

- **The headless stub has no DOM.** `test/canvas-stub.ts` is an object with a
  style bag and a listener map, not a document. Anything that creates an
  element outside the canvas has to grow the stub first, and the growth should
  be the minimum the feature touches.
- **The canvas may be CSS-scaled.** `componentAtEvent` at `canvas.ts:257`
  rescales pointer coordinates by `intended / rect.width`. Anything placed over
  the canvas from layout coordinates must apply the same factor, or the field
  lands beside the pin on a narrow screen.
- **A rebuilt canvas is a new instance with empty state.** Pins, highlight and
  memory contents belong to the instance that was destroyed. Until Phase 4
  lands, every rebuild path on the site replays them, and every new feature
  here has to be replayable.
- **The site pins a sha and a version, separately.** `package.json`,
  `bun.lock` and `renderer-versions.ts` name the same release, and
  `renderer-pin.test.ts` asserts it. A renderer change that ships without
  bumping `package.json`'s version passes that test vacuously against the old
  number.
- **`onPinToggle` is lossy by construction.** `signalOf` maps any mixed bus to
  `High`. A host that stores what `onPinToggle` reports and replays it will
  replay all-ones. The playground does exactly this today and must move to
  `onPinChange` in Phase 1.
- **`memBuffer` may grow linear memory.** A `Uint8Array` view taken before the
  call is detached after it. Every wrapper in Phase 2 re-takes the view.
- **`host-pin-api` is unmerged.** The site pins its tip. Merging it to `main`
  first, or rebasing each phase onto it, is a decision to make before Phase 1
  branches.

## Out of scope

- Keyboard-driven value stepping on a focusable canvas. It composes with the
  field later; on its own it does not reach `0x2A` in fewer than 42 presses.
- Persisting pin values across a page reload. That is the site's envelope, and
  a full bus value per pin fits it; it is site work, not renderer work.
- Drawing a memory's contents on the canvas, whole or in part (G03). The
  playground's dock panel pages through a memory; a canvas should not, and a
  neighbourhood around the addressed word is parked until someone is stuck
  without it.
