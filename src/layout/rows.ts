import type {
  ColumnAssignment,
  RowAssignment,
  VirtualGraph,
} from "./types";

/**
 * Stage 3: barycenter-method row assignment.
 *   - Group nodes by column. Initial order = id-ascending (graph.nodes).
 *   - L→R sweep: per node, barycenter = mean row of upstream neighbours.
 *   - R→L sweep: per node, barycenter = mean row of downstream neighbours.
 *   - Sort each bucket by (barycenter asc, node id asc).
 *
 * Determinism: stable input order, exact float compare, id tie-break.
 */
export function assignRows(
  graph: VirtualGraph,
  columns: ColumnAssignment
): RowAssignment {
  const n = graph.nodes.length;
  const indexOf = new Map<number, number>();
  for (let i = 0; i < n; i++) indexOf.set(graph.nodes[i].id, i);

  // buckets[col] = ordered graph-indices in that column.
  const buckets: number[][] = new Array(columns.numColumns);
  for (let i = 0; i < columns.numColumns; i++) buckets[i] = [];
  for (let i = 0; i < n; i++) buckets[columns.columnOf[i]].push(i);

  sweep(graph, columns, buckets, indexOf, "leftToRight");
  sweep(graph, columns, buckets, indexOf, "rightToLeft");

  const rowOf = new Array<number>(n).fill(0);
  let maxRows = 0;
  for (const bucket of buckets) {
    for (let pos = 0; pos < bucket.length; pos++) {
      rowOf[bucket[pos]] = pos;
    }
    if (bucket.length > maxRows) maxRows = bucket.length;
  }
  return { rowOf, numRows: maxRows };
}

type Direction = "leftToRight" | "rightToLeft";

function sweep(
  graph: VirtualGraph,
  columns: ColumnAssignment,
  buckets: number[][],
  indexOf: Map<number, number>,
  dir: Direction
): void {
  const start = dir === "leftToRight" ? 1 : columns.numColumns - 2;
  const endInclusive = dir === "leftToRight" ? columns.numColumns - 1 : 0;
  const step = dir === "leftToRight" ? 1 : -1;

  for (
    let col = start;
    step > 0 ? col <= endInclusive : col >= endInclusive;
    col += step
  ) {
    const bucket = buckets[col];
    if (bucket.length <= 1) continue;

    const pairs: { idx: number; bary: number }[] = new Array(bucket.length);
    for (let i = 0; i < bucket.length; i++) {
      const nodeIdx = bucket[i];
      pairs[i] = { idx: nodeIdx, bary: barycenter(graph, columns, buckets, indexOf, nodeIdx, dir, i) };
    }

    pairs.sort((a, b) => {
      if (a.bary !== b.bary) return a.bary - b.bary;
      return graph.nodes[a.idx].id - graph.nodes[b.idx].id;
    });

    buckets[col] = pairs.map((p) => p.idx);
  }
}

function barycenter(
  graph: VirtualGraph,
  columns: ColumnAssignment,
  buckets: number[][],
  indexOf: Map<number, number>,
  nodeIdx: number,
  dir: Direction,
  fallbackPos: number
): number {
  const node = graph.nodes[nodeIdx];
  let sum = 0;
  let count = 0;
  const neighbourIds = dir === "leftToRight"
    ? node.inputs.map((e) => e.srcId)
    : node.outputs.map((e) => e.dstId);
  for (const neighbourId of neighbourIds) {
    const neighbourIdx = indexOf.get(neighbourId);
    if (neighbourIdx === undefined) continue;
    const neighbourCol = columns.columnOf[neighbourIdx];
    const bucket = buckets[neighbourCol];
    for (let pos = 0; pos < bucket.length; pos++) {
      if (bucket[pos] === neighbourIdx) {
        sum += pos;
        count += 1;
        break;
      }
    }
  }
  return count > 0 ? sum / count : fallbackPos;
}
