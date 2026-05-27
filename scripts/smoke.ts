// Sanity check: load a compiled WASM, decode topology, build layout.
// Run with: bun run scripts/smoke.ts
import { CircRuntime } from "../src/wasm/runtime";
import { buildLayout } from "../src/layout";
import { ComponentKind, kindName } from "../src/wasm/topology";

const path = process.argv[2] ?? "example/static/and_gate.wasm";
const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
const rt = await CircRuntime.loadFromBytes(bytes);

console.log(`# ${path}`);
console.log(`components: ${rt.topology.components.length}`);
console.log(`connections: ${rt.topology.connections.length}`);
for (const c of rt.topology.components) {
  console.log(
    `  ${c.id.toString().padStart(3)}  ${kindName(c.kind).padEnd(11)}  ${c.name}` +
    (c.origin.length ? `  (in ${c.origin[0].subcircuit}:${c.origin[0].alias})` : "")
  );
}
console.log("connections:");
for (const e of rt.topology.connections) {
  console.log(`  ${e.fromId} → ${e.toId}  port=${e.port}`);
}

const layout = buildLayout(rt.topology);
console.log(`\nlayout: ${layout.width}×${layout.height} cells`);
for (const p of layout.components) {
  console.log(
    `  ${p.id.toString().padStart(3)}  (${p.x},${p.y}) ${p.width}×${p.height}  ${p.name}`
  );
}
console.log("wires:");
for (const w of layout.wires) {
  console.log(`  ${w.srcId} → ${w.dstId}: ${w.segments.length} seg, ${w.crossings.length} cross`);
}

// Drive every input pin high, settle, read.
const pins = rt.topology.components.filter((c) => c.kind === ComponentKind.InputPin);
console.log(`\nall HIGH:`);
for (const p of pins) rt.setPinSignal(p.id, 1);
rt.run();
for (const c of rt.topology.components) {
  console.log(`  ${c.id} ${c.name} = ${rt.getOutputState(c.id)}`);
}

if (pins.length >= 2) {
  console.log(`\nfirst LOW, rest HIGH:`);
  rt.setPinSignal(pins[0].id, 0);
  rt.run();
  for (const c of rt.topology.components) {
    console.log(`  ${c.id} ${c.name} = ${rt.getOutputState(c.id)}`);
  }
}

rt.destroy();
