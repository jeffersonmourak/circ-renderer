import {
  isComponentElement,
  isWireElement,
  parseComponent,
  parseWire,
  type WireData,
} from "../utils";

function mapWireConnectionsToStates(wires: WireData[]): Map<string, number> {
  const wiresMap = new Map<string, number>();
  const groupsMap = new Map<number, number[]>();

  for (let i = 0; i < wires.length; i++) {
    const wire = wires[i];
    const { to, from } = wire;

    const fromGroup = wiresMap.get(from);
    const toGroup = wiresMap.get(to);

    if (fromGroup !== undefined && toGroup === undefined) {
      wiresMap.set(to, fromGroup);

      const group = groupsMap.get(fromGroup) ?? [];
      group.push(i);
      groupsMap.set(fromGroup, group);

      continue;
    }

    if (fromGroup === undefined && toGroup !== undefined) {
      wiresMap.set(from, toGroup);
      const group = groupsMap.get(toGroup) ?? [];
      group.push(i);
      groupsMap.set(toGroup, group);

      continue;
    }

    if (fromGroup !== undefined && toGroup !== undefined) {
      if (fromGroup === toGroup) {
        continue;
      }

      const group = groupsMap.get(fromGroup) ?? [];

      // biome-ignore lint/style/noNonNullAssertion: a group is always present
      group.push(...groupsMap.get(toGroup)!);
      group.push(i);
      groupsMap.delete(toGroup);
      wiresMap.set(from, fromGroup);
      wiresMap.set(to, fromGroup);
    }

    if (fromGroup === undefined && toGroup === undefined) {
      const size = groupsMap.size;
      wiresMap.set(from, size);
      wiresMap.set(to, size);
      groupsMap.set(size, [i]);
    }
  }

  const entries = Array.from(groupsMap.values());

  for (let i = 0; i < entries.length; i++) {
    const value = entries[i];

    for (let j = 0; j < value.length; j++) {
      const wire = wires[value[j]];
      wiresMap.set(wire.from, i);
      wiresMap.set(wire.to, i);
    }
  }

  return wiresMap;
}

export interface CircuitComponent {
  type: "primary" | "composed";
  name: string;
  location: string;
  ports: string[];
  dependencies: {
    inputs: number[];
    outputs: number[];
  };
  attributes: {
    facing: string;
    size: string;
    output: boolean;
    label?: string;
  };
}

export interface Circuit {
  name: string;
  state: number[];

  wireConnections: Map<string, number>;
  wires: {
    list: WireData[];
    connections: Map<number, number[]>;
  };
  components: {
    list: CircuitComponent[];
    connections: Map<number, number[]>;
  };
}

function parseCircuit(circuitElement: Element): Circuit {
  const name = circuitElement.getAttribute("name") ?? "unnamed";

  const wires = Array.from(circuitElement.getElementsByTagName("wire"))
    .filter(isWireElement)
    .map(parseWire);

  const components: CircuitComponent[] = [];
  const rawComponents = Array.from(circuitElement.getElementsByTagName("comp"))
    .filter(isComponentElement)
    .map(parseComponent);

  const wireConnections = mapWireConnectionsToStates(wires);
  const connectionMap = new Map<number, number[]>();

  for (let i = 0; i < rawComponents.length; i++) {
    const component = rawComponents[i];
    const outputPort = wireConnections.get(component.location);

    const outputs = outputPort !== undefined ? [outputPort] : [];
    const inputs = component.ports.reduce((ports, port) => {
      const wire = wireConnections.get(port);

      if (wire !== undefined) {
        ports.push(wire);
      }

      return ports;
    }, [] as number[]);

    const invertOutput =
      component.name === "Pin" && component.attributes.output;

    const parsedComponent = {
      ...component,
      dependencies: {
        inputs: invertOutput ? outputs : inputs,
        outputs: invertOutput ? inputs : outputs,
      },
    };

    for (const input of parsedComponent.dependencies.inputs) {
      const components = connectionMap.get(input) ?? [];

      components.push(i);
      connectionMap.set(input, components);
    }

    components.push(parsedComponent as unknown as (typeof components)[number]);
  }

  let stateSize = 0;

  const mappedWires = wires.reduce((acc, { to, from }, i) => {
    const fromGroup = wireConnections.get(from);
    const toGroup = wireConnections.get(to);

    if (fromGroup !== undefined) {
      const group = acc.get(fromGroup) ?? [];
      group.push(i);
      acc.set(fromGroup, group);
    }

    if (toGroup !== undefined && fromGroup !== toGroup) {
      const group = acc.get(toGroup) ?? [];
      group.push(i);
      acc.set(toGroup, group);
    }

    stateSize = Math.max(fromGroup ?? -1, toGroup ?? -1, stateSize);

    return acc;
  }, new Map<number, number[]>());

  return {
    name,
    state: new Array<number>(stateSize + 1).fill(0),
    wireConnections,
    wires: {
      list: wires,
      connections: mappedWires,
    },
    components: {
      list: components,
      connections: connectionMap,
    },
  };
}

export function loadLogisimInput(xmlSourceCode: string): Circuit[] {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(xmlSourceCode, "text/xml");

  return Array.from(xmlDoc.getElementsByTagName("circuit")).map(parseCircuit);
}
