import {
  ComponentKind,
  type FullTopology,
  PortName,
} from "../wasm/topology";
import {
  type InputEdge,
  type LayoutOptions,
  type OutputEdge,
  type VirtualGraph,
  type VirtualNode,
} from "./types";

const SRC_PORT_OUT = PortName.Out;

interface GroupKey {
  alias: string;
  subcircuit: string;
}
const groupKeyEq = (a: GroupKey, b: GroupKey) =>
  a.alias === b.alias && a.subcircuit === b.subcircuit;

/**
 * Stage 1: produce a `VirtualGraph` from a `FullTopology`.
 *
 * Always:
 *   - Drops every `wire` primitive. Edges A→wire→B (possibly through chains)
 *     are reissued as direct A→B edges.
 *
 * Opaque mode (default):
 *   - Primitives sharing the same outermost OriginFrame collapse into one
 *     virtual subcircuit node with a synthetic id allocated above max(id)+1.
 *
 * Expanded mode:
 *   - Inner subcircuit pins are also passthroughs; every other non-wire
 *     primitive becomes its own VirtualNode preserving its real id.
 */
export function collapse(
  topology: FullTopology,
  opts: LayoutOptions = {}
): VirtualGraph {
  const expand = !!opts.expandMacros;

  // 1. Lookups + passthrough flags.
  const kindOf = new Map<number, ComponentKind>();
  const nameOf = new Map<number, string>();
  const isInnerPin = new Set<number>();
  let maxId = 0;
  for (const c of topology.components) {
    kindOf.set(c.id, c.kind);
    nameOf.set(c.id, c.name);
    if (
      c.origin.length > 0 &&
      (c.kind === ComponentKind.InputPin || c.kind === ComponentKind.OutputPin)
    ) {
      isInnerPin.add(c.id);
    }
    if (c.id > maxId) maxId = c.id;
  }

  const isPassthrough = (id: number): boolean => {
    const k = kindOf.get(id);
    if (k === undefined) return false;
    if (k === ComponentKind.Wire) return true;
    if (!expand) return false;
    return isInnerPin.has(id);
  };

  // 2. Resolve passthrough chains.
  const driverOf = new Map<number, number>();
  for (const conn of topology.connections) {
    if (isPassthrough(conn.toId)) driverOf.set(conn.toId, conn.fromId);
  }
  const resolvedSource = new Map<number, number>();
  for (const c of topology.components) {
    if (!isPassthrough(c.id)) continue;
    let current = c.id;
    for (let depth = 0; depth < 64; depth++) {
      const drv = driverOf.get(current);
      if (drv === undefined) break;
      if (!isPassthrough(drv)) {
        resolvedSource.set(c.id, drv);
        break;
      }
      current = drv;
    }
  }

  // 3. Determine groups (opaque mode only).
  const groupKeys: GroupKey[] = [];
  const groupOfId = new Map<number, number>();
  if (!expand) {
    for (const c of topology.components) {
      if (c.kind === ComponentKind.Wire) continue;
      if (c.origin.length === 0) continue;
      const outer = c.origin[0];
      const key = { alias: outer.alias, subcircuit: outer.subcircuit };
      let foundIdx = -1;
      for (let i = 0; i < groupKeys.length; i++) {
        if (groupKeyEq(groupKeys[i], key)) {
          foundIdx = i;
          break;
        }
      }
      if (foundIdx === -1) {
        foundIdx = groupKeys.length;
        groupKeys.push(key);
      }
      groupOfId.set(c.id, foundIdx);
    }
  }

  // 4. Allocate virtual ids.
  let nextSyntheticId = maxId + 1;
  const groupVirtualId: number[] = new Array(groupKeys.length);
  for (let i = 0; i < groupKeys.length; i++) {
    groupVirtualId[i] = nextSyntheticId++;
  }
  const virtualIdOf = new Map<number, number>();
  for (const c of topology.components) {
    if (isPassthrough(c.id)) continue;
    const g = groupOfId.get(c.id);
    virtualIdOf.set(c.id, g !== undefined ? groupVirtualId[g] : c.id);
  }

  // 5. Walk connections, accumulate edges per virtual node.
  const nodeInputs = new Map<number, InputEdge[]>();
  const nodeOutputs = new Map<number, OutputEdge[]>();
  for (const c of topology.components) {
    if (isPassthrough(c.id)) continue;
    const vid = virtualIdOf.get(c.id);
    if (vid === undefined) continue;
    if (!nodeInputs.has(vid)) {
      nodeInputs.set(vid, []);
      nodeOutputs.set(vid, []);
    }
  }

  for (const conn of topology.connections) {
    if (isPassthrough(conn.toId)) continue;

    let effectiveSource = conn.fromId;
    if (isPassthrough(conn.fromId)) {
      const r = resolvedSource.get(conn.fromId);
      if (r === undefined) continue; // dangling
      effectiveSource = r;
    }

    const srcVid = virtualIdOf.get(effectiveSource);
    const dstVid = virtualIdOf.get(conn.toId);
    if (srcVid === undefined || dstVid === undefined) continue;
    if (srcVid === dstVid) continue; // internal to a collapsed group

    const dstPort = remappedPort(conn.port, conn.toId, dstVid, kindOf, nameOf);
    const srcPort = remappedPort(SRC_PORT_OUT, effectiveSource, srcVid, kindOf, nameOf);

    nodeOutputs.get(srcVid)!.push({ dstId: dstVid, srcPort, dstPort });
    nodeInputs.get(dstVid)!.push({ srcId: srcVid, srcPort, dstPort });
  }

  // 6. Materialize VirtualNodes.
  const nodes: VirtualNode[] = [];
  for (const c of topology.components) {
    if (isPassthrough(c.id)) continue;
    if (groupOfId.has(c.id)) continue;
    const vid = virtualIdOf.get(c.id)!;
    nodes.push({
      id: c.id,
      kind: { tag: "primitive", kind: c.kind },
      name: c.name,
      origin: c.origin,
      inputs: nodeInputs.get(vid)!,
      outputs: nodeOutputs.get(vid)!,
    });
  }
  for (let i = 0; i < groupKeys.length; i++) {
    const key = groupKeys[i];
    const vid = groupVirtualId[i];
    nodes.push({
      id: vid,
      kind: { tag: "subcircuit", subcircuit: key.subcircuit },
      name: key.alias,
      origin: [],
      inputs: nodeInputs.get(vid)!,
      outputs: nodeOutputs.get(vid)!,
    });
  }

  // Sort by id ascending — universal determinism anchor.
  nodes.sort((a, b) => a.id - b.id);

  return { nodes, nextId: nextSyntheticId };
}

function remappedPort(
  defaultPort: number,
  realId: number,
  vid: number,
  kindOf: Map<number, ComponentKind>,
  nameOf: Map<number, string>
): number {
  if (realId === vid) return defaultPort;
  const inner = kindOf.get(realId);
  if (inner !== ComponentKind.InputPin && inner !== ComponentKind.OutputPin) {
    return defaultPort;
  }
  const innerName = nameOf.get(realId);
  if (innerName === undefined) return defaultPort;
  switch (innerName) {
    case "in": return PortName.In;
    case "a": return PortName.A;
    case "b": return PortName.B;
    case "out": return PortName.Out;
    default: return defaultPort;
  }
}
