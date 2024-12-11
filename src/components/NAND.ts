import { cn, resolveCn } from "src/utils";
import type { ComponentDefinition } from "../services/parser";

export type NandState = {
  size: number;
};

export const nandComponentDefinition = {
  name: "AND",
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
  draw(drawArgs) {
    if (drawArgs.theme.library?.NAND) {
      drawArgs.theme.library.NAND(drawArgs);
      return;
    }

    const { bounds, ctx, theme, scaleFactor = 1 } = drawArgs;

    const [loc, dim] = bounds;

    const [ogX, ogY] = loc;
    const [width, height] = dim;

    ctx.fillStyle = theme.colors.pink;

    ctx.fillRect(
      resolveCn(ogX, scaleFactor),
      resolveCn(ogY, scaleFactor),
      resolveCn(width, scaleFactor),
      resolveCn(height, scaleFactor)
    );
  },

  onSignalChange(signal) {
    const [a, b] = signal;

    const notA = a === 0 ? 1 : 0;
    const notB = b === 0 ? 1 : 0;

    return [a, b, notA && notB];
  },
} satisfies ComponentDefinition<NandState>;