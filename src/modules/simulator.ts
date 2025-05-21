import type { Circuit, CircuitComponent } from "./loader";

class CircuitSimulator {
  circuit: Circuit | null = null;
  subscribers: Map<number, number[]> = new Map();
  operationQueue: [number, number][] = [];
  private tickLimit = 10;

  loadCircuit(circuit: Circuit) {
    this.circuit = circuit;

    for (let i = 0; i < circuit.components.list.length; i++) {
      const component = circuit.components.list[i];

      if (component.name === "Pin") {
        continue;
      }

      const { inputs, outputs } = component.dependencies;

      if (component.name === "NOT Gate") {
        this.circuit.state[outputs[0]] = 1;
      }

      for (const input of inputs) {
        if (!this.subscribers.has(input)) {
          this.subscribers.set(input, []);
        }

        this.subscribers.get(input)?.push(i);
      }
    }

    this.step();
  }

  step() {
    if (!this.circuit) {
      throw new Error("Circuit not loaded");
    }

    for (let i = 0; i < this.tickLimit; i++) {
      const nextOperation = this.operationQueue.shift();

      if (nextOperation === undefined) {
        return;
      }

      this.updateStateValue(nextOperation[0], nextOperation[1]);
    }
  }

  updateStateValue(index: number, value: number) {
    if (!this.circuit) {
      throw new Error("Circuit not loaded");
    }

    const oldStateValue = this.circuit.state[index];

    if (oldStateValue !== value) {
      this.circuit.state[index] = value;
      const nextUpdates: [number, number][] = [];

      for (const subscriber of this.subscribers.get(index) ?? []) {
        const component = this.circuit.components.list[
          subscriber
        ] as CircuitComponent;
        const { inputs, outputs } = component.dependencies;
        const inputSignals: number[] = [];
        const outputSignals: number[] = [];
        for (const input of inputs) {
          const signal = this.circuit.state[input];
          inputSignals.push(signal);
        }
        for (const output of outputs) {
          const signal = this.circuit.state[output];
          outputSignals.push(signal);
        }

        const result = this.computeOutputSignals(component.name, inputSignals);

        for (let i = 0; i < outputs.length; i++) {
          const output = outputs[i];

          if (
            this.circuit.state[output] === result[i] ||
            component.name === "Pin"
          ) {
            continue;
          }
          nextUpdates.push([output, result[i]]);
        }
      }

      while (nextUpdates.length > 0) {
        // biome-ignore lint/style/noNonNullAssertion: The while above ensures that there is at least one element in nextUpdates
        const op = nextUpdates.pop()!;
        this.operationQueue.push(op);
      }
    }
  }

  computeOutputSignals(type: string, [a, b]: number[]): number[] {
    switch (type) {
      case "NOT Gate":
        return [a === 1 ? 0 : 1];
      case "AND Gate":
        return [a === 1 && b === 1 ? 1 : 0];
      case "NAND Gate":
        return [a === 1 && b === 1 ? 0 : 1];
      case "OR Gate":
        return [a === 1 || b === 1 ? 1 : 0];
      case "XOR Gate":
        return [a === 1 && b === 1 ? 0 : a === 1 || b === 1 ? 1 : 0];
      case "NOR Gate":
        return [a === 1 || b === 1 ? 0 : 1];
      case "Adder":
        return [a === 1 && b === 1 ? 0 : 1];
      default:
        return [];
    }
  }
}

export default CircuitSimulator;
