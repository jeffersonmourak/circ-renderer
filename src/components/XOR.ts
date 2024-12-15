import { cn, resolveCn } from "src/utils";
import { toFaceIndex } from "src/utils/renderPoints";
import type { ComponentDefinition } from "../services/parser";

export type XorState = {
  size: number;
};

export const xorComponentDefinition = {
  name: "XOR",
  parse(values: Record<string, string | null>) {
    return {
      size: Number.parseInt(values.size ?? "30"),
    };
  },
  async loadAssets() {
    return {};
  },
  dimensions: ({ size }) => [size, size],
  ports: ({ size }) => [
    [cn(-size + 5), cn(-size / 2 + 5), "input"],
    [cn(-size + 5), cn(size / 2 - 5), "input"],
    [cn(size / 2), cn(0), "output"],
  ],
  defaultFacing: "east",
  faceAngles: [-90, 0, 90, 180],
  draw(drawArgs) {
    if (drawArgs.theme.library?.XOR) {
      drawArgs.theme.library.XOR(drawArgs);
      return;
    }

    const {
      bounds,
      ctx,
      theme,
      scaleFactor = 1,
      assets,
      faceAngles,
    } = drawArgs;

    ctx.save();

    const angle = faceAngles[toFaceIndex(drawArgs.face)] + 90;

    const rad = (angle * Math.PI) / 180;

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

    ctx.restore();
  },

  onSignalChange(signal) {
    const [a, b] = signal;

    const result = a === 1 && b === 1 ? 0 : a === 1 || b === 1 ? 1 : 0;

    return [a, b, result];
  },
} satisfies ComponentDefinition<XorState>;
