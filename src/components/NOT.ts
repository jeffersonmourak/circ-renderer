import { cn, resolveCn } from "src/utils";
import type { ComponentDefinition } from "../services/parser";

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
  draw(drawArgs) {
    if (drawArgs.theme.library?.NOT) {
      drawArgs.theme.library.NOT(drawArgs);
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
    return [signal[0], signal[0] === 0 ? 1 : 0];
  },
} satisfies ComponentDefinition<NotState>;