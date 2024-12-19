import { type Dictionary, groupBy, partition } from "lodash";
import {
  type ComponentFace,
  cn,
  decodeCircCoords,
  drawFitText,
  stringToColor,
} from "../utils";
import { type ComponentDefinition, type Port, parseCircuit } from "./parser";
import SimulationEngine, { ElectricSignal } from "./simulation";

type SimulatedComponentState = {
  simulation: SimulationEngine;
  name: string;
  chipColor: string;
};

export type LoadedCircuit = {
  component: Element;
  definition: ComponentDefinition<SimulatedComponentState>;
};

function computePortLocation(
  face: ComponentFace,
  width: number,
  height: number,
  i: number,
  ports: {
    location: number[];
    facing: string;
    label: string | null | undefined;
    mag: number;
  }[]
): Port {
  const portsClusters = groupBy(ports, (port) => port.facing);
  const currentPort = ports[i];

  switch (face) {
    case "north": {
      const cluster = portsClusters.north ?? [];
      const index = cluster.findIndex(
        (p) =>
          p.location[0] === currentPort.location[0] &&
          p.location[1] === currentPort.location[1]
      );

      return [
        cn((index - 1) * 10 + 5),
        cn(height * 5),
        index === 0 ? "output" : "input",
      ] satisfies Port;
    }
    case "south": {
      const cluster = portsClusters.south ?? [];
      const index = cluster.findIndex(
        (p) =>
          p.location[0] === currentPort.location[0] &&
          p.location[1] === currentPort.location[1]
      );

      return [
        cn((index - 1) * 10 + 5),
        cn(-height * 5),
        index === 0 ? "output" : "input",
      ] satisfies Port;
    }
    case "east": {
      const cluster = portsClusters.east ?? [];
      const index = cluster.findIndex(
        (p) =>
          p.location[0] === currentPort.location[0] &&
          p.location[1] === currentPort.location[1]
      );

      return [
        cn(-width * 5),
        cn((index - 1) * 10 + 5),
        index === 0 ? "output" : "input",
      ] satisfies Port;
    }
    case "west": {
      const cluster = portsClusters.west ?? [];
      const index = cluster.findIndex(
        (p) =>
          p.location[0] === currentPort.location[0] &&
          p.location[1] === currentPort.location[1]
      );
      return [
        cn(width * 5),
        cn((index - 1) * 10 + 5),
        index === 0 ? "output" : "input",
      ] satisfies Port;
    }
  }
}

function createGenericCircuitDefinition(
  name: string,
  ports: {
    location: number[];
    facing: string;
    label: string | null | undefined;
    mag: number;
  }[],
  portGroups: Dictionary<
    {
      location: number[];
      facing: string;
      label: string | null | undefined;
      mag: number;
    }[]
  >,
  circuitsMap: Record<string, LoadedCircuit>
): ComponentDefinition<SimulatedComponentState> {
  const width = Math.max(
    Math.max(portGroups.south?.length ?? 0, portGroups.north?.length ?? 0),
    3
  );
  const height = Math.max(
    Math.max(portGroups.east?.length ?? 0, portGroups.west?.length ?? 0),
    3
  );

  return {
    name,
    parse: () => {
      const circuit = parseCircuit(circuitsMap, name);
      const simulation = new SimulationEngine(10, 30, 30);

      const [wires, components] = partition(circuit, (c) => c.name === "wire");
      simulation.connectPorts(components);
      simulation.connectWires(wires);

      return {
        name,
        simulation,
        chipColor: stringToColor(name),
      };
    },
    dimensions: [10 * width, 10 * height],
    draw({ dimensions: [width, height], ctx, theme, state }) {
      ctx.fillStyle = state.chipColor;
      ctx.fillRect(0, 0, width, height);

      ctx.fillStyle = theme.colors.base00;
      ctx.textAlign = "center";
      drawFitText(ctx, name, "Arial", width * 0.3, width / 2, height / 2);
    },
    onSignalChange: (signal, fromPort, { simulation }) => {
      const signalTunnel = ports[fromPort].location;

      const [x, y] = signalTunnel;

      simulation.propagateSignal(x / 10, y / 10, signal[fromPort]);

      const computedSignal: ElectricSignal[] = [];

      for (const port of ports) {
        const [simulationPortSignal = ElectricSignal.LOW] =
          simulation.read(port.location[0] / 10, port.location[1] / 10) ?? [];

        computedSignal.push(simulationPortSignal);
      }

      return computedSignal;
    },
    defaultFacing: "east",
    faceAngles: [270, 0, 90, 180],
    ports: () => {
      const computedPorts: Port[] = ports.map((p, i, a) => {
        return computePortLocation(
          p.facing as ComponentFace,
          width,
          height,
          i,
          a
        );
      });

      return computedPorts;
    },
  };
}

export function loadCircFile(fileContent: string) {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(fileContent, "text/xml");

  const circuitsMap: Record<string, LoadedCircuit> = {};

  const circuits = xmlDoc.getElementsByTagName("circuit");

  for (let i = 0; i < circuits.length; i++) {
    const circuit = circuits[i];

    const portElements = circuit.querySelectorAll('comp[name="Pin"]');

    const ports = Array.from(portElements)
      .map((port) => {
        const locationValue = port.getAttribute("loc");

        const location = locationValue
          ? decodeCircCoords(locationValue)
          : [0, 0];
        const label = port
          .querySelector("a[name='label']")
          ?.getAttribute("val");

        const facing =
          port.querySelector('a[name="facing"]')?.getAttribute("val") ?? "east";

        const mag = Math.sqrt(
          location[0] * location[0] + location[1] * location[1]
        );

        return {
          location,
          facing,
          label,
          mag,
        };
      })
      .sort((a, b) => a.mag - b.mag);

    const groupedPorts = groupBy(ports, (port) => port.facing);

    const name = circuit
      .querySelector(`a[name="circuit"]`)
      ?.getAttribute("val");

    if (!name) {
      continue;
    }

    circuitsMap[name] = {
      component: circuit,
      definition: createGenericCircuitDefinition(
        name,
        ports,
        groupedPorts,
        circuitsMap
      ),
    };
  }

  return circuitsMap;
}
