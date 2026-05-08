import { ComponentKind } from "../wasm/topology";
import {
  type ColumnAssignment,
  isPrimitive,
  type VirtualGraph,
  type VirtualNode,
} from "./types";

/**
 * Stage 2: longest-path column assignment, cycle-aware.
 *
 * Rules:
 *   - `input_pin` primitives are pinned at column 0.
 *   - For every other node: `column_of[n] = 1 + max(column_of[upstream])`
 *     across all incoming edges *excluding back edges that close a cycle*.
 *   - `led` and `output_pin` primitives are forced to `numColumns - 1` so
 *     all sinks line up on the right edge.
 *
 * Cycle handling: a pre-pass DFS classifies each edge as tree/forward/cross
 * (DAG) or back (closes a cycle). Back edges are skipped in the longest-
 * path sweep — without that, every iteration through the cycle bumps each
 * member's column and the sweep only stops at the iteration cap, stranding
 * upstream nodes at low columns and pushing cycle nodes to the far right.
 *
 * Gutter rule: a node whose only incoming edges are back edges (an orphan
 * cycle entry) gets bumped from col 0 → col 1, leaving column 0 empty so
 * the router's 5-leg leftward feedback path has a west gutter to anchor
 * its arc on. At column 0 there is no cell west of the in-port.
 */
export function assignColumns(graph: VirtualGraph): ColumnAssignment {
  const n = graph.nodes.length;
  const columnOf = new Array<number>(n).fill(0);

  const indexOf = new Map<number, number>();
  for (let i = 0; i < n; i++) indexOf.set(graph.nodes[i].id, i);

  const backEdges = detectBackEdges(graph, indexOf);

  // A "back-edge destination" with no forward upstream still needs col ≥ 1.
  const isBackEdgeDst = new Array<boolean>(n).fill(false);
  for (const key of backEdges) {
    const [, dstId] = decodeEdgeKey(key);
    const dstIdx = indexOf.get(dstId);
    if (dstIdx !== undefined) isBackEdgeDst[dstIdx] = true;
  }

  let iter = 0;
  let changed = true;
  while (changed && iter <= n + 1) {
    changed = false;
    for (let i = 0; i < n; i++) {
      const node = graph.nodes[i];
      if (isInputPin(node)) {
        if (columnOf[i] !== 0) {
          columnOf[i] = 0;
          changed = true;
        }
        continue;
      }
      let maxUpstreamPlusOne = 0;
      for (const e of node.inputs) {
        if (backEdges.has(edgeKey(e.srcId, node.id, e.srcPort, e.dstPort))) continue;
        const upIdx = indexOf.get(e.srcId);
        if (upIdx === undefined) continue;
        const cand = columnOf[upIdx] + 1;
        if (cand > maxUpstreamPlusOne) maxUpstreamPlusOne = cand;
      }
      if (maxUpstreamPlusOne === 0 && isBackEdgeDst[i]) {
        maxUpstreamPlusOne = 1;
      }
      if (maxUpstreamPlusOne !== columnOf[i]) {
        columnOf[i] = maxUpstreamPlusOne;
        changed = true;
      }
    }
    iter++;
  }

  let numColumns = 1;
  for (const c of columnOf) if (c + 1 > numColumns) numColumns = c + 1;

  for (let i = 0; i < n; i++) {
    if (isSink(graph.nodes[i])) columnOf[i] = numColumns - 1;
  }

  return { columnOf, numColumns };
}

/** Encode an edge as a string key — both endpoints' ports matter, since a
 * node can fan in from the same source on multiple ports. */
const edgeKey = (srcId: number, dstId: number, srcPort: number, dstPort: number): string =>
  `${srcId}|${dstId}|${srcPort}|${dstPort}`;

const decodeEdgeKey = (k: string): [number, number] => {
  const [srcStr, dstStr] = k.split("|");
  return [Number(srcStr), Number(dstStr)];
};

/**
 * Iterative DFS over output edges. An edge `u → v` is a *back edge* iff `v`
 * is currently on the recursion stack (gray). Back edges are exactly the
 * edges that close cycles in any DFS spanning forest, and removing them
 * leaves a DAG.
 *
 * Roots are visited in `graph.nodes` index order (collapse sorts by id),
 * which makes the back-edge set deterministic across runs.
 */
function detectBackEdges(
  graph: VirtualGraph,
  indexOf: Map<number, number>
): Set<string> {
  const n = graph.nodes.length;
  // 0=white, 1=gray (on stack), 2=black (finished).
  const color = new Array<number>(n).fill(0);
  const back = new Set<string>();
  type Frame = { nodeIdx: number; nextEdge: number };
  const stack: Frame[] = [];

  for (let start = 0; start < n; start++) {
    if (color[start] !== 0) continue;
    color[start] = 1;
    stack.push({ nodeIdx: start, nextEdge: 0 });
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      const node = graph.nodes[top.nodeIdx];
      if (top.nextEdge >= node.outputs.length) {
        color[top.nodeIdx] = 2;
        stack.pop();
        continue;
      }
      const edge = node.outputs[top.nextEdge++];
      const dstIdx = indexOf.get(edge.dstId);
      if (dstIdx === undefined) continue;
      const c = color[dstIdx];
      if (c === 1) {
        back.add(edgeKey(node.id, edge.dstId, edge.srcPort, edge.dstPort));
      } else if (c === 0) {
        color[dstIdx] = 1;
        stack.push({ nodeIdx: dstIdx, nextEdge: 0 });
      }
      // black: forward or cross edge — DAG, no action.
    }
  }
  return back;
}

const isInputPin = (n: VirtualNode): boolean =>
  isPrimitive(n.kind) && n.kind.kind === ComponentKind.InputPin;

const isSink = (n: VirtualNode): boolean =>
  isPrimitive(n.kind) &&
  (n.kind.kind === ComponentKind.Led || n.kind.kind === ComponentKind.OutputPin);
