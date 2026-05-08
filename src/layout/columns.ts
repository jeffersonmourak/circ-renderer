import { ComponentKind } from "../wasm/topology";
import {
  type ColumnAssignment,
  isPrimitive,
  type VirtualGraph,
  type VirtualNode,
} from "./types";

/**
 * Stage 2: longest-path column assignment, cycle-aware.
 *   - input_pin pinned at column 0.
 *   - Other nodes: column_of[n] = 1 + max(column_of[upstream]).
 *   - Edges WITHIN the same strongly-connected component (cycles) are
 *     skipped, so cycle members don't push each other forward forever.
 *   - All members of a multi-node SCC get pinned to the SCC's max column
 *     after the sweep.
 *   - led / output_pin forced to num_columns - 1 so all sinks line up right.
 *
 * Fixed-point sweep, capped at `nodes.len + 1` passes.
 */
export function assignColumns(graph: VirtualGraph): ColumnAssignment {
  const n = graph.nodes.length;
  const columnOf = new Array<number>(n).fill(0);

  const indexOf = new Map<number, number>();
  for (let i = 0; i < n; i++) indexOf.set(graph.nodes[i].id, i);

  const { sccOf, sccs } = findSccs(graph, indexOf);

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
        const upIdx = indexOf.get(e.srcId);
        if (upIdx === undefined) continue;
        // Skip same-SCC edges inside multi-node cycles — they're feedback
        // edges and shouldn't grow either node's column.
        if (sccOf[upIdx] === sccOf[i] && sccs[sccOf[i]].length > 1) continue;
        const cand = columnOf[upIdx] + 1;
        if (cand > maxUpstreamPlusOne) maxUpstreamPlusOne = cand;
      }
      if (maxUpstreamPlusOne !== columnOf[i]) {
        columnOf[i] = maxUpstreamPlusOne;
        changed = true;
      }
    }
    iter++;
  }

  // Pin every multi-node SCC's members to the SCC's max column so they
  // share a single column even though they reference each other.
  for (const scc of sccs) {
    if (scc.length <= 1) continue;
    let max = 0;
    for (const idx of scc) if (columnOf[idx] > max) max = columnOf[idx];
    for (const idx of scc) columnOf[idx] = max;
  }

  let numColumns = 1;
  for (const c of columnOf) if (c + 1 > numColumns) numColumns = c + 1;

  for (let i = 0; i < n; i++) {
    if (isSink(graph.nodes[i])) columnOf[i] = numColumns - 1;
  }

  return { columnOf, numColumns };
}

/**
 * Tarjan's strongly-connected components — iterative variant to avoid
 * blowing the stack on long chains. Each returned SCC is a list of
 * node indices into `graph.nodes`.
 */
function findSccs(
  graph: VirtualGraph,
  indexOf: Map<number, number>
): { sccOf: number[]; sccs: number[][] } {
  const n = graph.nodes.length;
  const idx = new Array<number>(n).fill(-1);
  const low = new Array<number>(n).fill(0);
  const onStack = new Array<boolean>(n).fill(false);
  const stk: number[] = [];
  const sccOf = new Array<number>(n).fill(-1);
  const sccs: number[][] = [];
  let counter = 0;

  type Frame = { v: number; outs: number[]; nextOut: number };
  const callStack: Frame[] = [];

  for (let start = 0; start < n; start++) {
    if (idx[start] !== -1) continue;
    callStack.push({
      v: start,
      outs: graph.nodes[start].outputs.map((e) => indexOf.get(e.dstId) ?? -1).filter((i) => i >= 0),
      nextOut: 0,
    });
    idx[start] = counter; low[start] = counter; counter++;
    stk.push(start); onStack[start] = true;

    while (callStack.length > 0) {
      const top = callStack[callStack.length - 1];
      if (top.nextOut < top.outs.length) {
        const w = top.outs[top.nextOut++];
        if (idx[w] === -1) {
          idx[w] = counter; low[w] = counter; counter++;
          stk.push(w); onStack[w] = true;
          callStack.push({
            v: w,
            outs: graph.nodes[w].outputs.map((e) => indexOf.get(e.dstId) ?? -1).filter((i) => i >= 0),
            nextOut: 0,
          });
        } else if (onStack[w]) {
          if (idx[w] < low[top.v]) low[top.v] = idx[w];
        }
      } else {
        if (low[top.v] === idx[top.v]) {
          const scc: number[] = [];
          while (true) {
            const w = stk.pop()!;
            onStack[w] = false;
            sccOf[w] = sccs.length;
            scc.push(w);
            if (w === top.v) break;
          }
          sccs.push(scc);
        }
        callStack.pop();
        if (callStack.length > 0) {
          const parent = callStack[callStack.length - 1];
          if (low[top.v] < low[parent.v]) low[parent.v] = low[top.v];
        }
      }
    }
  }

  return { sccOf, sccs };
}

const isInputPin = (n: VirtualNode): boolean =>
  isPrimitive(n.kind) && n.kind.kind === ComponentKind.InputPin;

const isSink = (n: VirtualNode): boolean =>
  isPrimitive(n.kind) &&
  (n.kind.kind === ComponentKind.Led || n.kind.kind === ComponentKind.OutputPin);
