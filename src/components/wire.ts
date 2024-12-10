import { type CnVector2, resolveCn } from "src/utils";
import type { ComponentDefinition } from "../services/parser";
import { decodeCircCoords } from "../utils/circ";

export type WireState = {
  from: CnVector2;
  to: CnVector2;
};

export const wireComponentDefinition = {
  name: "wire",
  parse(_: Record<string, string | null>, component) {
    const fromAttribute = component.getAttribute("from");
    const toAttribute = component.getAttribute("to");

    if (!fromAttribute || !toAttribute) {
      throw new Error("Wire component is missing 'from' or 'to' attribute");
    }

    const from = decodeCircCoords(fromAttribute);

    const to = decodeCircCoords(toAttribute);

    return {
      from,
      to,
    };
  },
  dimensions: [0, 0],
  ports: [],
  faceAngles: [0, 0, 0, 0],
  defaultFacing: "east",
  draw({ bounds, ctx, theme, state, pointerLocation, scaleFactor = 1 }) {
    const [loc, dim] = bounds;

    const [x1, y1] = state.from;
    const [x2, y2] = state.to;

    const isError = false;
    const isOn = false;

    ctx.beginPath();
    ctx.moveTo(resolveCn(x1, scaleFactor), resolveCn(y1, scaleFactor));
    ctx.lineTo(resolveCn(x2, scaleFactor), resolveCn(y2, scaleFactor));
    ctx.lineWidth = ~~(scaleFactor * 2.5);
    ctx.lineCap = "round";
    ctx.strokeStyle = isError
      ? theme.colors.red
      : isOn
      ? theme.colors.green
      : theme.colors.blue;
    ctx.stroke();
    ctx.closePath();
  },
  onSignalChange(signal) {
    return signal;
  },
  skipLocationCheck: true,
} satisfies ComponentDefinition<WireState>;
