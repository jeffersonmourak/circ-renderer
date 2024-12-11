import { cn, resolveCn } from "src/utils";
import type { ComponentDefinition } from "../services/parser";

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
  draw(drawArgs) {
    if (drawArgs.theme.library?.LED) {
      drawArgs.theme.library.LED(drawArgs);
      return;
    }

    const { ctx, state, scaleFactor = 1, bounds, portsSignals } = drawArgs;

    const [loc, dim] = bounds;

    const [x, y] = loc;
    const [width, height] = dim;

    const isOn = portsSignals[0] === 1;

    ctx.fillStyle = isOn ? state.color : state.offColor;

    ctx.fillRect(
      resolveCn(x, scaleFactor),
      resolveCn(y, scaleFactor),
      resolveCn(width, scaleFactor),
      resolveCn(height, scaleFactor)
    );
  },
  onSignalChange(signal) {
    return signal;
  },
} satisfies ComponentDefinition<LEDState>;
