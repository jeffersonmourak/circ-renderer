import type { ComponentDefinition } from "../services/parser";
import { cn } from "../utils";

export type NorState = {
  size: number;
};

export const norComponentDefinition = {
  name: "NOR",
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
  faceAngles: [-90, 0, 90, 180],
  draw({ dimensions: [width, height], ctx, theme }) {
    ctx.fillStyle = theme.colors.pink;
    ctx.fillRect(0, 0, width, height);
  },

  onSignalChange(signal) {
    const [a, b] = signal;

    const result = a === 1 || b === 1 ? 0 : 1;

    return [a, b, result];
  },
} satisfies ComponentDefinition<NorState>;
