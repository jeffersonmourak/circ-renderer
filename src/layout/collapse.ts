import {
  ComponentKind,
  type FullTopology,
  PortName,
} from "../wasm/topology";
import {
  CHIP_PORT_BASE,
  assignChipRows,
  type InputEdge,
  type LayoutOptions,
  type OutputEdge,
  type VirtualGraph,
  type Slot,
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

  // 4b. A collapsed chip's ports: its own pins (origin depth 1), in
  // declaration order. Each gets a port byte, so two inputs never share a
  // slot and two outputs never share a pin.
  const groupIns: Slot[][] = groupKeys.map(() => []);
  const groupOuts: Slot[][] = groupKeys.map(() => []);
  const portOfPin = new Map<number, number>();
  for (const c of topology.components) {
    const g = groupOfId.get(c.id);
    if (g === undefined || c.origin.length !== 1) continue;
    const list =
      c.kind === ComponentKind.InputPin ? groupIns[g] : c.kind === ComponentKind.OutputPin ? groupOuts[g] : null;
    if (list === null) continue;
    const port = chipPortByte(c.name, list.length);
    portOfPin.set(c.id, port);
    list.push({ name: c.name, port, row: 0 });
  }
  for (let g = 0; g < groupKeys.length; g++) assignChipRows(groupIns[g], groupOuts[g]);

  // A chip's output pin is a tap: whatever reads the output outside the chip
  // is wired to the pin's driver inside it, not to the pin. So the port a
  // wire leaves by is the output pin its source drives (the first, when one
  // signal is exported twice).
  const outPortOfDriver = new Map<number, number>();
  for (const conn of topology.connections) {
    if (kindOf.get(conn.toId) !== ComponentKind.OutputPin) continue;
    const port = portOfPin.get(conn.toId);
    if (port === undefined) continue;
    const driver = isPassthrough(conn.fromId) ? resolvedSource.get(conn.fromId) : conn.fromId;
    if (driver === undefined || groupOfId.get(driver) !== groupOfId.get(conn.toId)) continue;
    if (!outPortOfDriver.has(driver)) outPortOfDriver.set(driver, port);
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

    const dstPort = portOfPin.get(conn.toId) ?? conn.port;
    const srcPort = outPortOfDriver.get(effectiveSource) ?? SRC_PORT_OUT;

    nodeOutputs.get(srcVid)!.push({
      dstId: dstVid, srcPort, dstPort, realSrcId: effectiveSource,
    });
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
      bitWidth: c.width,
      slice: c.slice,
      memory: c.memory,
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
      bitWidth: 1,
      inSlots: groupIns[i],
      outSlots: groupOuts[i],
      portLabels: !gateShaped(groupIns[i], groupOuts[i]),
    });
  }

  // Sort by id ascending — universal determinism anchor.
  nodes.sort((a, b) => a.id - b.id);

  return { nodes, nextId: nextSyntheticId };
}

function portByteFromName(name: string): number | null {
  switch (name) {
    case "in": return PortName.In;
    case "a": return PortName.A;
    case "b": return PortName.B;
    case "out": return PortName.Out;
    default: return null;
  }
}

/** The port byte of a chip pin: see `CHIP_PORT_BASE`. */
function chipPortByte(name: string, index: number): number {
  return portByteFromName(name) ?? CHIP_PORT_BASE + Math.min(index, 255 - CHIP_PORT_BASE);
}

/** True for a chip with a built-in gate's ports: inputs among `a`, `in`,
 * `b`, and the one output `out`. */
function gateShaped(ins: Slot[], outs: Slot[]): boolean {
  if (outs.length !== 1 || outs[0].name !== "out") return false;
  return ins.every((s) => s.name !== "out" && portByteFromName(s.name) !== null);
}
