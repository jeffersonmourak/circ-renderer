import type { ComponentDefinition } from "../services/parser";
import { cn } from "../utils";

export type NotState = {
  size: number;
};

export const notComponentDefinition = {
  name: "NOT",
  parse(values: Record<string, string | null>) {
    return {
      size: Number.parseInt(values.size ?? "10"),
    };
  },
  dimensions: ({ size }) => [size, 10],
  ports: ({ size }) => [
    [cn(-size / 2), cn(0), "input"],
    [cn(size / 2), cn(0), "output"],
  ],
  defaultFacing: "east",
  faceAngles: [0, 0, 0, 0],
  draw({ dimensions: [width, height], ctx, theme }) {
    ctx.fillStyle = theme.colors.pink;
    ctx.fillRect(0, 0, width, height);
  },

  onSignalChange(signal) {
    return [signal[0], signal[0] === 0 ? 1 : 0];
  },
} satisfies ComponentDefinition<NotState>;
