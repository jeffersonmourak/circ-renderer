import type { ComponentDefinition } from "../services/parser";
import type { Vector2 } from "../utils";
import { decodeCircCoords } from "../utils/circ";

export type WireState = {
  from: Vector2;
  to: Vector2;
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
  draw({ ctx, theme, state, portsSignals: [signal] }) {
    const [x1, y1] = state.from;
    const [x2, y2] = state.to;

    const isError = false;
    const isOn = signal === 1;

    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.lineWidth = 2;
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
