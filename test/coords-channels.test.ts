/**
 * The coordinate and channel stages' unit tests, transliterated from
 * `lib/preview/layout/coords.zig` and `channels.zig` in circ-compiler.
 */
import { test, expect } from "bun:test";
import { ComponentKind, PortName } from "../src/wasm/topology";
import { emit, gapWidth, plan, tryAssignTracks, widths } from "../src/layout/channels";
import { assign, relayoutColumns, stubWidths } from "../src/layout/coords";
import { layer } from "../src/layout/layering";
import { order } from "../src/layout/ordering";
import type { InputEdge, Net, NodeKind, OutputEdge, Terminal, VirtualGraph, VirtualNode } from "../src/layout/types";

const SRC_OUT = PortName.Out;
const DST_IN = PortName.In;
const DST_A = PortName.A;
const DST_B = PortName.B;
const prim = (k: ComponentKind): NodeKind => ({ tag: "primitive", kind: k });

function mk(id: number, kind: NodeKind, inputs: InputEdge[], outputs: Omit<OutputEdge, "realSrcId">[]): VirtualNode {
  return { id, kind, name: "", origin: [], inputs, outputs: outputs.map((o) => ({ ...o, realSrcId: id })), bitWidth: 1 };
}

function build(nodes: VirtualNode[]) {
  const graph: VirtualGraph = { nodes, nextId: nodes.length };
  const layered = layer(graph);
  const ordering = order(graph, layered);
  const coords = assign(graph, layered, ordering, stubWidths(layered.numLayers));
  return { graph, layered, ordering, coords };
}

test("coords: a NOT feeding an AND's b port sits two rows lower", () => {
  const b = build([
    mk(0, prim(ComponentKind.InputPin), [], [{ dstId: 3, srcPort: SRC_OUT, dstPort: DST_A }]),
    mk(1, prim(ComponentKind.InputPin), [], [{ dstId: 2, srcPort: SRC_OUT, dstPort: DST_IN }]),
    mk(2, prim(ComponentKind.NotGate), [{ srcId: 1, srcPort: SRC_OUT, dstPort: DST_IN }], [{ dstId: 3, srcPort: SRC_OUT, dstPort: DST_B }]),
    mk(3, prim(ComponentKind.AndGate), [
      { srcId: 0, srcPort: SRC_OUT, dstPort: DST_A },
      { srcId: 2, srcPort: SRC_OUT, dstPort: DST_B },
    ], [{ dstId: 4, srcPort: SRC_OUT, dstPort: DST_IN }]),
    mk(4, prim(ComponentKind.OutputPin), [{ srcId: 3, srcPort: SRC_OUT, dstPort: DST_IN }], []),
  ]);
  expect(b.coords.y.slice(0, 4)).toEqual([0, 4, 4, 0]);
});

test("coords: a lone source is pulled level with its sink, and layer 0 packs from row 0", () => {
  const b = build([
    mk(0, prim(ComponentKind.InputPin), [], [{ dstId: 1, srcPort: SRC_OUT, dstPort: DST_B }]),
    mk(1, prim(ComponentKind.AndGate), [{ srcId: 0, srcPort: SRC_OUT, dstPort: DST_B }], []),
  ]);
  expect(b.coords.y).toEqual([2, 0]);
  const three = build([
    mk(0, prim(ComponentKind.InputPin), [], [{ dstId: 3, srcPort: SRC_OUT, dstPort: DST_IN }]),
    mk(1, prim(ComponentKind.InputPin), [], []),
    mk(2, prim(ComponentKind.InputPin), [], []),
    mk(3, prim(ComponentKind.Led), [{ srcId: 0, srcPort: SRC_OUT, dstPort: DST_IN }], []),
  ]);
  expect(three.coords.y).toEqual([0, 4, 8, 0]);
  expect(three.coords.x[3]).toBe(5 + 5);
  expect(three.coords.height).toBe(11);
});

function mkNet(id: number, srcRow: number, sinkRows: number[]): Net {
  const sinks: Terminal[] = sinkRows.map((r, i) => ({ node: 100 + i, port: 0, row: r, rail: "right" }));
  const lo = Math.min(srcRow, ...sinkRows);
  const hi = Math.max(srcRow, ...sinkRows);
  return { srcReal: id, srcPort: 3, src: { node: id, port: 3, row: srcRow, rail: "left" }, sinks, lo, hi, straight: false, pieces: [], jogs: [], back: false, fallback: false };
}

test("channels: disjoint intervals share a track, a source on a row is left of a sink on it, and a cycle is reported", () => {
  const nets = [mkNet(0, 1, [3]), mkNet(1, 5, [7]), mkNet(2, 2, [6])];
  const r = tryAssignTracks(nets);
  expect(r).toEqual({ tracks: 2 });
  expect(nets[0].pieces[0].track).toBe(nets[1].pieces[0].track);
  expect(nets[2].pieces[0].track).not.toBe(nets[0].pieces[0].track);
  const chained = [mkNet(0, 1, [5]), mkNet(1, 5, [9])];
  tryAssignTracks(chained);
  expect(chained[1].pieces[0].track).toBeLessThan(chained[0].pieces[0].track);
  const cyc = [mkNet(0, 1, [5]), mkNet(1, 5, [1])];
  expect("cycle" in tryAssignTracks(cyc)).toBe(true);
  expect([gapWidth(0), gapWidth(3), gapWidth(4), gapWidth(20)]).toEqual([5, 5, 6, 22]);
});

test("channels: a back edge gets two tracks and a return row below the diagram", () => {
  const b = build([
    mk(0, prim(ComponentKind.NotGate), [{ srcId: 1, srcPort: SRC_OUT, dstPort: DST_IN }], [{ dstId: 1, srcPort: SRC_OUT, dstPort: DST_IN }]),
    mk(1, prim(ComponentKind.NotGate), [{ srcId: 0, srcPort: SRC_OUT, dstPort: DST_IN }], [{ dstId: 0, srcPort: SRC_OUT, dstPort: DST_IN }]),
  ]);
  const heightBefore = b.coords.height;
  const p = plan(b.graph, b.layered, b.coords);
  expect(p.returnRows).toBe(1);
  expect(b.coords.height).toBe(heightBefore + 1);
  expect(p.gaps.length).toBe(3);
  expect(p.gaps[2].nets.length).toBe(1);
  expect(p.gaps[2].nets[0].back).toBe(true);
  expect(p.gaps[2].width).toBe(5);
  expect(p.gaps[1].nets[0].straight).toBe(true);
  relayoutColumns(b.coords, b.layered, widths(p, b.layered.numLayers));
  const r = emit(b.graph, b.layered, b.coords, p);
  expect(r.wires.length).toBe(2);
  const lane = r.wires[1];
  expect(lane.srcId).toBe(1);
  expect(lane.segments.length).toBe(5);
  expect(lane.segments[2].from.y).toBe(heightBefore);
  expect(lane.segments[4].to.x).toBeGreaterThan(lane.segments[4].from.x);
  expect(r.height).toBe(heightBefore + 1);
});

test("coords: the row gutter is the caller's, and stacked boxes keep it", () => {
  // Two input pins into one AND: nothing prefers a row for a pin, so the
  // second is packed under the first at exactly box height plus the gutter.
  const nodes = () => [
    mk(0, prim(ComponentKind.InputPin), [], [{ dstId: 2, srcPort: SRC_OUT, dstPort: DST_A }]),
    mk(1, prim(ComponentKind.InputPin), [], [{ dstId: 2, srcPort: SRC_OUT, dstPort: DST_B }]),
    mk(2, prim(ComponentKind.AndGate), [
      { srcId: 0, srcPort: SRC_OUT, dstPort: DST_A },
      { srcId: 1, srcPort: SRC_OUT, dstPort: DST_B },
    ], [{ dstId: 3, srcPort: SRC_OUT, dstPort: DST_IN }]),
    mk(3, prim(ComponentKind.OutputPin), [{ srcId: 2, srcPort: SRC_OUT, dstPort: DST_IN }], []),
  ];
  for (const gutter of [1, 2, 3]) {
    const graph: VirtualGraph = { nodes: nodes(), nextId: 4 };
    const layered = layer(graph);
    const ordering = order(graph, layered);
    const coords = assign(graph, layered, ordering, stubWidths(layered.numLayers), gutter);
    const at = (id: number) => layered.nodes.findIndex((n) => n.real === id);
    expect(coords.y[at(1)] - coords.y[at(0)]).toBe(coords.h[at(0)] + gutter);
  }
  // The default is the compiler's.
  const graph: VirtualGraph = { nodes: nodes(), nextId: 4 };
  const layered = layer(graph);
  const ordering = order(graph, layered);
  const dflt = assign(graph, layered, ordering, stubWidths(layered.numLayers));
  const at = (id: number) => layered.nodes.findIndex((n) => n.real === id);
  expect(dflt.y[at(1)] - dflt.y[at(0)]).toBe(dflt.h[at(0)] + 1);
});
