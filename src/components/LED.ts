import type { ComponentDefinition } from "../services/parser";
import { cn } from "../utils";

export type LEDState = {
  color: string;
  offColor: string;
};

export const ledComponentDefinition = {
  name: "LED",
  parse(values: Record<string, string | null>) {
    return {
      color: values.color ?? "#ff0000",
      offColor: values.offColor ?? "#404040",
    };
  },
  dimensions: [10, 10],
  ports: [[cn(5), cn(0), "input"]],
  faceAngles: [270, 0, 90, 180],
  defaultFacing: "west",
  draw({ ctx, state, dimensions: [width, height], portsSignals }) {
    const isOn = portsSignals[0] === 1;

    ctx.fillStyle = isOn ? state.color : state.offColor;
    ctx.fillRect(0, 0, width, height);
  },
  onSignalChange(signal) {
    return signal;
  },
} satisfies ComponentDefinition<LEDState>;
