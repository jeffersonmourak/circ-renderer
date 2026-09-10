/**
 * The layering stage's unit tests, transliterated from
 * `lib/preview/layout/layering.zig` and `ordering.zig` in circ-compiler.
 */
import { test, expect } from "bun:test";
import { ComponentKind, PortName } from "../src/wasm/topology";
import { layer } from "../src/layout/layering";
import { countCrossings, order } from "../src/layout/ordering";
import type { InputEdge, NodeKind, OutputEdge, VirtualGraph, VirtualNode } from "../src/layout/types";

const SRC_OUT = PortName.Out;
const DST_IN = PortName.In;
const DST_A = PortName.A;
const DST_B = PortName.B;

const prim = (k: ComponentKind): NodeKind => ({ tag: "primitive", kind: k });

function mk(id: number, kind: NodeKind, inputs: InputEdge[], outputs: Omit<OutputEdge, "realSrcId">[]): VirtualNode {
  return { id, kind, name: "", origin: [], inputs, outputs: outputs.map((o) => ({ ...o, realSrcId: id })), bitWidth: 1 };
}

const graphOf = (nodes: VirtualNode[]): VirtualGraph => ({ nodes, nextId: nodes.length });

test("layering: longest path, input pins at 0, sinks last, dummies for a long edge", () => {
  // pin → not → and → led, plus a second led fed straight from the pin.
  const nodes = [
    mk(0, prim(ComponentKind.InputPin), [], [
      { dstId: 1, srcPort: SRC_OUT, dstPort: DST_IN },
      { dstId: 4, srcPort: SRC_OUT, dstPort: DST_IN },
    ]),
    mk(1, prim(ComponentKind.NotGate), [{ srcId: 0, srcPort: SRC_OUT, dstPort: DST_IN }], [{ dstId: 2, srcPort: SRC_OUT, dstPort: DST_A }]),
    mk(2, prim(ComponentKind.AndGate), [{ srcId: 1, srcPort: SRC_OUT, dstPort: DST_A }], [{ dstId: 3, srcPort: SRC_OUT, dstPort: DST_IN }]),
    mk(3, prim(ComponentKind.Led), [{ srcId: 2, srcPort: SRC_OUT, dstPort: DST_IN }], []),
    mk(4, prim(ComponentKind.Led), [{ srcId: 0, srcPort: SRC_OUT, dstPort: DST_IN }], []),
  ];
  const lg = layer(graphOf(nodes));
  expect(lg.numLayers).toBe(4);
  expect(lg.nodes.slice(0, 5).map((n) => n.layer)).toEqual([0, 1, 2, 3, 3]);
  expect(lg.nodes.length).toBe(7);
  expect(lg.nodes[5]).toEqual({ real: null, layer: 1, carries: 1 });
  expect(lg.nodes[6].layer).toBe(2);
  expect(lg.edges.length).toBe(6);
  const segs = lg.edges.slice(1, 4);
  expect(segs.map((e) => [e.src, e.dst])).toEqual([[0, 5], [5, 6], [6, 4]]);
  expect(segs[2].dstPort).toBe(DST_IN);
  expect(segs[1].dstPort).toBe(0);
  for (const s of segs) expect(s.original).toBe(1);
});

test("layering: a back edge is flagged, gets no dummy, and bumps its destination to layer 1", () => {
  const nodes = [
    mk(0, prim(ComponentKind.NotGate), [{ srcId: 1, srcPort: SRC_OUT, dstPort: DST_IN }], [{ dstId: 1, srcPort: SRC_OUT, dstPort: DST_IN }]),
    mk(1, prim(ComponentKind.NotGate), [{ srcId: 0, srcPort: SRC_OUT, dstPort: DST_IN }], [{ dstId: 0, srcPort: SRC_OUT, dstPort: DST_IN }]),
  ];
  const lg = layer(graphOf(nodes));
  expect(lg.originals.map((o) => o.back)).toEqual([false, true]);
  expect(lg.nodes.length).toBe(2);
  expect(lg.edges.length).toBe(1);
  expect(lg.nodes.map((n) => n.layer)).toEqual([1, 2]);
  expect(lg.numLayers).toBe(3);
});

test("layering: a sink driving a gate to its left is a back edge", () => {
  const nodes = [
    mk(0, prim(ComponentKind.InputPin), [], [
      { dstId: 1, srcPort: SRC_OUT, dstPort: DST_IN },
      { dstId: 2, srcPort: SRC_OUT, dstPort: DST_B },
    ]),
    mk(1, prim(ComponentKind.Led), [{ srcId: 0, srcPort: SRC_OUT, dstPort: DST_IN }], [{ dstId: 2, srcPort: SRC_OUT, dstPort: DST_A }]),
    mk(2, prim(ComponentKind.AndGate), [
      { srcId: 1, srcPort: SRC_OUT, dstPort: DST_A },
      { srcId: 0, srcPort: SRC_OUT, dstPort: DST_B },
    ], [{ dstId: 3, srcPort: SRC_OUT, dstPort: DST_IN }]),
    mk(3, prim(ComponentKind.OutputPin), [{ srcId: 2, srcPort: SRC_OUT, dstPort: DST_IN }], []),
  ];
  const lg = layer(graphOf(nodes));
  expect(lg.originals[2].back).toBe(true);
  expect(lg.originals[0].back).toBe(false);
  expect(lg.nodes[1].layer).toBe(3);
  expect(lg.nodes[2].layer).toBe(2);
  expect(lg.nodes.length).toBe(7);
  expect(lg.edges.length).toBe(6);
});

test("ordering: order resolves a crossed pair and keeps an uncrossed one", () => {
  const nodes = [
    mk(0, prim(ComponentKind.InputPin), [], [{ dstId: 3, srcPort: SRC_OUT, dstPort: DST_IN }]),
    mk(1, prim(ComponentKind.InputPin), [], [{ dstId: 2, srcPort: SRC_OUT, dstPort: DST_IN }]),
    mk(2, prim(ComponentKind.NotGate), [{ srcId: 1, srcPort: SRC_OUT, dstPort: DST_IN }], []),
    mk(3, prim(ComponentKind.NotGate), [{ srcId: 0, srcPort: SRC_OUT, dstPort: DST_IN }], []),
  ];
  const graph = graphOf(nodes);
  const lg = layer(graph);
  const o = order(graph, lg);
  expect(countCrossings(graph, lg, o)).toBe(0);
  expect(o.order[1]).toEqual([3, 2]);
  expect(o.order[0]).toEqual([0, 1]);
});

test("ordering: equal barycenters keep the current order, and a and b ports count", () => {
  const fan = [
    mk(0, prim(ComponentKind.InputPin), [], [1, 2, 3].map((d) => ({ dstId: d, srcPort: SRC_OUT, dstPort: DST_IN }))),
    mk(1, prim(ComponentKind.NotGate), [{ srcId: 0, srcPort: SRC_OUT, dstPort: DST_IN }], []),
    mk(2, prim(ComponentKind.NotGate), [{ srcId: 0, srcPort: SRC_OUT, dstPort: DST_IN }], []),
    mk(3, prim(ComponentKind.NotGate), [{ srcId: 0, srcPort: SRC_OUT, dstPort: DST_IN }], []),
  ];
  const g1 = graphOf(fan);
  expect(order(g1, layer(g1)).order[1]).toEqual([1, 2, 3]);
  // pin0 → and.b, pin1 → and.a with pin0 above pin1: crossed by the ports.
  const ab = [
    mk(0, prim(ComponentKind.InputPin), [], [{ dstId: 2, srcPort: SRC_OUT, dstPort: DST_B }]),
    mk(1, prim(ComponentKind.InputPin), [], [{ dstId: 2, srcPort: SRC_OUT, dstPort: DST_A }]),
    mk(2, prim(ComponentKind.AndGate), [
      { srcId: 0, srcPort: SRC_OUT, dstPort: DST_B },
      { srcId: 1, srcPort: SRC_OUT, dstPort: DST_A },
    ], []),
  ];
  const g2 = graphOf(ab);
  const lg2 = layer(g2);
  const crossed = { order: [[0, 1], [2]], pos: [0, 1, 0], rounds: 0 };
  expect(countCrossings(g2, lg2, crossed)).toBe(1);
  const o2 = order(g2, lg2);
  expect(countCrossings(g2, lg2, o2)).toBe(0);
  expect(o2.order[0]).toEqual([1, 0]);
});
