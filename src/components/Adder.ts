import type { ComponentDefinition } from "../services/parser";
import { cn } from "../utils";

export type AdderState = {
  size: number;
};

export const adderComponentDefinition = {
  name: "Adder",
  parse(values: Record<string, string | null>) {
    return {
      size: Number.parseInt(values.size ?? "30"),
    };
  },
  dimensions: ({ size }) => [size, size],
  ports: ({ size }) => [
    [cn(-size + 5), cn(-size / 2 + 5), "input"],
    [cn(-size + 5), cn(size / 2 - 5), "input"],
    [cn(size / 2), cn(0), "output"],
  ],
  defaultFacing: "east",
  faceAngles: [0, 0, 0, 0],
  draw({ dimensions, ctx, theme }) {
    const [width, height] = dimensions;

    ctx.fillStyle = theme.colors.pink;
    ctx.fillRect(0, 0, width, height);
  },

  onSignalChange(signal) {
    const [a, b] = signal;

    const result = a === 1 && b === 1 ? 0 : 1;

    return [a, b, result];
  },
} satisfies ComponentDefinition<AdderState>;
