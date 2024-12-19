import type { ComponentDefinition } from "../services/parser";
import { cn } from "../utils";

export type PinState = {
  output: boolean;
};

export const pinComponentDefinition = {
  name: "pin",
  parse(values: Record<string, string | null>) {
    return {
      output: values.output === "true",
    };
  },
  dimensions: [10, 10],
  ports: ({ output }) => [[cn(5), cn(0), output ? "input" : "output"]],
  defaultFacing: "east",
  faceAngles: [270, 0, 90, 180],
  draw({ dimensions: [width, height], ctx, theme, state, pointerLocation }) {
    ctx.fillStyle = state.output
      ? "blue"
      : pointerLocation !== null
      ? theme.colors.yellow
      : "green";

    ctx.fillRect(0, 0, width, height);
  },
  onPress(signal, { output }) {
    if (output) {
      return signal;
    }
    
    return [signal[0] === 0 ? 1 : 0];
  },
  onSignalChange(signal) {
    return signal;
  },
} satisfies ComponentDefinition<PinState>;
