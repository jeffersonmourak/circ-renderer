import type { ComponentDefinition } from "../services/parser";
import { cn } from "../utils";

export type LEDState = {
  color: string;
  offColor: string;
  asset: Generator<string | undefined, string | undefined, unknown>;
};

const fakePromise = new Promise((resolve) => {
  setTimeout(() => {
    resolve(undefined);
  }, 1000);
});

function* loadAsset() {
  let ready = false;
  let asset: string | undefined;

  fakePromise.then(() => {
    ready = true;
    asset = "asset";
  });

  while (!ready) {
    yield asset;
  }

  return asset;
}

const k = loadAsset();

export const ledComponentDefinition = {
  name: "LED",
  parse(values: Record<string, string | null>) {
    return {
      color: values.color ?? "#ff0000",
      offColor: values.offColor ?? "#404040",
      asset: loadAsset(),
    };
  },
  dimensions: [10, 10],
  ports: [[cn(5), cn(0), "input"]],
  faceAngles: [270, 0, 90, 180],
  defaultFacing: "west",
  draw({ ctx, state, dimensions: [width, height], portsSignals }) {
    // console.log(state.asset.next());

    const isOn = portsSignals[0] === 1;

    ctx.fillStyle = isOn ? state.color : state.offColor;
    ctx.fillRect(0, 0, width, height);
  },
  onSignalChange(signal) {
    return signal;
  },
} satisfies ComponentDefinition<LEDState>;
