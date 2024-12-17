import type { ComponentDefinition } from "../services/parser";
import { cn } from "../utils";

export type NandState = {
  size: number;
};

export const nandComponentDefinition = {
  name: "NAND",
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
  draw({ dimensions: [width, height], ctx, theme }) {
    ctx.fillStyle = theme.colors.pink;
    ctx.fillRect(0, 0, width, height);
  },

  onSignalChange(signal) {
    const [a, b] = signal;

    const result = a === 1 && b === 1 ? 0 : 1;

    return [a, b, result];
  },
} satisfies ComponentDefinition<NandState>;
