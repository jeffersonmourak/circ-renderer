# Layout-parity fixtures

Both halves of every entry come from **circ-compiler commit `69e2ed2`** (branch `layout`, the layout-rewrite initiative's Phase 0):

- `<name>.<opaque|expanded>.layout.json` — copied verbatim from `tests/fixtures/preview/layouts-json/` there, the `LayoutGrid` JSON its `tests/preview/layout_conformance_test.zig` pins (emitted by `lib/preview/dump_json.zig` through the library front end on the `.project` route, the path `circ-compile --preview` and the site's `circ_preview` take).
- `../<name>.wasm` — `zig-out/bin/circ-compile tests/fixtures/circuits/<name>.circ -o <name>.wasm` at the same commit. `rom_lookup.wasm` and `ram_write_read.wasm` already existed here byte-identically; the rest are new.
- `invariants.txt` — the matching rows of `tests/fixtures/preview/layout-invariants.golden` there (I0–I3, crossings, bends, straight wires, size), which `test/layout-invariants.test.ts` reproduces over the JSON with its own checker.

The set is a subset of the compiler's 223-fixture-mode corpus: every fixture that has an ASCII render golden there (`tests/fixtures/preview/renders/`) plus the demux family and the two memory fixtures, 28 fixture-modes over 25 circuits. Excluded on purpose: `led_*_expand*` (preview-only fixtures that do not compile to an artifact) and the six circuits whose names collide with this repository's frozen v02 fixtures (`and_4bit`, `bit_index_a2`, `concat_four_bits`, `half_adder`, `inverter`, `slice_then_concat` — those `.wasm` files are older artifacts other tests depend on and are never regenerated).

Re-vendor all three kinds together whenever the compiler side regenerates: `test/layout-parity.test.ts` compares `buildLayout()` against the JSON, and its `MATCHES_TODAY` list is measured, not chosen.
