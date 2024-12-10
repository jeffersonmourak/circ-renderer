import { cn, resolveCn } from "src/utils";
import type { ComponentDefinition } from "../services/parser";

type PinState = {
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
  draw({ bounds, ctx, theme, state, pointerLocation, scaleFactor = 1 }) {
    const [loc, dim] = bounds;

    const [ogX, ogY] = loc;
    const [width, height] = dim;

    ctx.fillStyle = state.output
      ? "blue"
      : pointerLocation !== null
      ? theme.colors.yellow
      : "green";

    ctx.fillRect(
      resolveCn(ogX, scaleFactor),
      resolveCn(ogY, scaleFactor),
      resolveCn(width, scaleFactor),
      resolveCn(height, scaleFactor)
    );
  },
  onPress(signal) {
    return [signal[0] === 0 ? 1 : 0];
  },
  onSignalChange(signal) {
    return signal;
  },
} satisfies ComponentDefinition<PinState>;
