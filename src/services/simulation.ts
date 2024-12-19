import type { WireState } from "../components/wire";
import { resolveCn } from "../utils";
import { type Component, type PortMode, parseCircuitPorts } from "./parser";

export enum ElectricSignal {
  LOW = 0,
  HIGH = 1,
}

class SimulationEngine {
  gridMap: string[][];
  gridSize: number;
  width: number;
  height: number;
  wires: Component<WireState>[] = [];
  components: Component<unknown>[] = [];
  portsMap: Map<string, [number, number][]> = new Map();

  wireSignals: ElectricSignal[] = [];
  portsSignals: ElectricSignal[][] = [];

  constructor(gridSize: number, width: number, height: number) {
    this.width = width;
    this.height = height;
    this.gridSize = gridSize;

    this.gridMap = new Array(width)
      .fill(0)
      .map(() => new Array(height).fill("."));
  }

  connectWires(wires: Component<WireState>[]) {
    this.wires.push(...wires);

    const wireSignals = wires.map((w) => {
      const fromX = w.state.from[0] / this.gridSize;
      const fromY = w.state.from[1] / this.gridSize;
      const toX = w.state.to[0] / this.gridSize;
      const toY = w.state.to[1] / this.gridSize;

      const fromPorts = this.getComponentPortAt(fromX, fromY);

      const toPorts = this.getComponentPortAt(toX, toY);

      if (fromPorts.length === 0 && toPorts.length === 0) {
        return ElectricSignal.LOW;
      }

      const computedSignal = ElectricSignal.LOW;

      const limit = Math.max(fromPorts.length, toPorts.length);

      for (let i = 0; i < limit; i++) {
        const fromPort = fromPorts[i];
        const toPort = toPorts[i];

        const fromSignal = fromPort
          ? this.portsSignals[fromPort[0]][fromPort[1]]
          : ElectricSignal.LOW;

        const toSinal = toPort
          ? this.portsSignals[toPort[0]][toPort[1]]
          : ElectricSignal.LOW;

        if (fromSignal !== toSinal) {
          if (fromSignal === ElectricSignal.HIGH) {
            this.propagateSignal(toX, toY, ElectricSignal.HIGH);
          } else {
            this.propagateSignal(toX, toY, ElectricSignal.LOW);
          }
        }
      }

      return ElectricSignal.LOW;
    });

    this.wireSignals.push(...wireSignals);
  }

  connectPorts(components: Component<unknown>[]) {
    for (let i = 0; i < components.length; i++) {
      const component = components[i];

      const portSignals = component.ports.map(() => ElectricSignal.LOW);
      this.components.push(component);

      const computedSignal = component.onSignalChange(
        portSignals,
        0,
        component.state
      );

      this.portsSignals.push(computedSignal);

      const ports = parseCircuitPorts(component, this.gridSize);

      for (let portNo = 0; portNo < ports.length; portNo++) {
        const [x, y, _mode] = ports[portNo];

        const key = `${x},${y}`;
        const components = this.portsMap.get(key) || [];
        components.push([i, portNo]);

        this.portsMap.set(key, components);
      }
    }
  }

  getWireIntercecting(x: number, y: number) {
    return this.wires.filter((wire) => {
      const [x1, y1] = wire.state.from;
      const [x2, y2] = wire.state.to;

      return (
        x >= x1 / this.gridSize &&
        x <= x2 / this.gridSize &&
        y >= y1 / this.gridSize &&
        y <= y2 / this.gridSize
      );
    });
  }

  getWireIndexIntercecting(x: number, y: number) {
    return this.wires.reduce<number[]>((collided, wire, index) => {
      const [x1, y1] = wire.state.from;
      const [x2, y2] = wire.state.to;

      if (
        x >= resolveCn(x1) / this.gridSize &&
        x <= resolveCn(x2) / this.gridSize &&
        y >= resolveCn(y1) / this.gridSize &&
        y <= resolveCn(y2) / this.gridSize
      ) {
        collided.push(index);
      }

      return collided;
    }, []);
  }

  getComponentPortAt(x: number, y: number) {
    const key = `${x},${y}`;
    return this.portsMap.get(key) ?? [];
  }

  canPropagateSignal(x: number, y: number) {
    return (
      x >= 0 &&
      y >= 0 &&
      x < this.width &&
      y < this.height &&
      this.gridMap[y][x] !== "."
    );
  }

  read(x: number, y: number) {
    const wireIndexes = this.getWireIndexIntercecting(x, y);

    if (wireIndexes.length === 0) {
      return null;
    }

    return wireIndexes.map((index) => this.wireSignals[index]);
  }

  propagateComponentOutput(
    componentIndex: number,
    outputSignal: ElectricSignal[]
  ) {
    const component = this.components[componentIndex];
    const ports = parseCircuitPorts(component, this.gridSize);

    for (let i = 0; i < ports.length; i++) {
      const [x, y] = ports[i];
      this.propagateSignal(x, y, outputSignal[i]);
    }
  }

  propagateSignal(x: number, y: number, signal: ElectricSignal) {
    const wireIndexes = this.getWireIndexIntercecting(x, y);

    for (const wireIndex of wireIndexes) {
      if (this.wireSignals[wireIndex] !== signal) {
        this.wireSignals[wireIndex] = signal;
        const wire = this.wires[wireIndex];

        const [x1, y1] = wire.state.from;
        const [x2, y2] = wire.state.to;

        const fromX = resolveCn(x1) / this.gridSize;
        const fromY = resolveCn(y1) / this.gridSize;
        const toX = resolveCn(x2) / this.gridSize;
        const toY = resolveCn(y2) / this.gridSize;

        this.propagateSignal(fromX, fromY, signal);
        this.propagateSignal(toX, toY, signal);
      }
    }

    const key = `${x},${y}`;
    const components = this.portsMap.get(key) ?? [];

    for (let i = 0; i < components.length; i++) {
      const [componentIndex, portIndex] = components[i];
      const component = this.components[componentIndex];

      const ports = parseCircuitPorts(component, this.gridSize);
      const wireSignals = ports.map(
        ([x, y]) => this.read(x, y) as ElectricSignal[]
      );

      const portsSignals = this.portsSignals[componentIndex];

      const hasChanged = portsSignals.some(
        (signal, index) =>
          signal !==
          (wireSignals[index]?.reduce(
            (a, b) => (a === 1 || b === 1 ? 1 : 0),
            0
          ) ?? 0)
      );

      if (hasChanged) {
        const computedSignal = component.onSignalChange(
          wireSignals.flat(),
          portIndex,
          component.state
        );

        const hasChanged = portsSignals.some(
          (signal, index) => signal !== computedSignal[index]
        );

        this.portsSignals[componentIndex] = computedSignal;

        if (hasChanged) {
          this.propagateComponentOutput(componentIndex, computedSignal);
        }
      }
    }
  }

  getPortMajorityMode(ports: [number, number][]) {
    const modes = new Map<PortMode, number>();

    for (let i = 0; i < ports.length; i++) {
      const [componentIndex, portIndex] = ports[i];
      const component = this.components[componentIndex];
      const port = component.ports[portIndex];

      const [x, y, mode] = port;
      modes.set(mode, (modes.get(mode) ?? 0) + 1);
    }

    let majorityMode: PortMode = "output";
    let majorityCount = 0;

    for (const [mode, count] of modes) {
      if (count > majorityCount) {
        majorityCount = count;
        majorityMode = mode;
      }
    }

    return majorityMode;
  }

  getWireDirection(x: number, y: number) {
    const wires = this.getWireIntercecting(x, y);

    if (wires.length === 0) {
      return null;
    }

    const [wire] = wires;

    const [x1, y1] = wire.state.from;
    const [x2, y2] = wire.state.to;

    const dx = resolveCn(x2) - resolveCn(x1);
    const dy = resolveCn(y2) - resolveCn(y1);

    if (dx === 0) {
      return "y";
    }

    return "x";
  }

  drawGrid(mark: [number, number] | null = null) {
    let gridString = "";
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const wires = this.getWireIntercecting(x, y);
        const ports = this.getComponentPortAt(x, y);

        const wireDirection = this.getWireDirection(x, y);

        if (wires.length > 0 && wireDirection !== null) {
          this.gridMap[y][x] =
            this.wireSignals[
              this.getWireIndexIntercecting(x, y)[0]
            ]?.toString() ?? ".";
        }

        if (ports.length > 0 && wires.length > 0) {
          this.gridMap[y][x] =
            this.getPortMajorityMode(ports) === "input" ? "⊖" : "⊕";
        } else if (ports.length > 0) {
          this.gridMap[y][x] =
            this.getPortMajorityMode(ports) === "input" ? "⊟" : "⊞";
        }

        if (mark && mark[0] === x && mark[1] === y) {
          this.gridMap[y][x] = "X";
        }
      }
      gridString += `${this.gridMap[y].join(" ")}\n`;
    }

    console.log(gridString);
  }
}

export default SimulationEngine;
