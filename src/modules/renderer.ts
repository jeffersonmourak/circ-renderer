import { baseTheme, type CircTheme } from "../utils/theme";
import type { Circuit, CircuitComponent } from "./loader";
import { circle, line } from "./ui";

export const decodeCircCoords = (
  coords?: string,
  divider = 10
): [number, number] => {
  const location = (coords
    ?.slice(1, -1)
    .split(",")
    .map((n) => Number(n) / divider) ?? [0, 0]) as [number, number];

  return location;
};

type RenderOptions<C extends string> = {
  theme: CircTheme<C>;
  scale: number;
  width: number;
  height: number;
  rotate?: number;
  limitFPS?: number;
  onClick?: (context: RenderContext) => void;
};

export type ComponentRenderArgument<C extends string> = {
  ctx: CanvasRenderingContext2D;
  theme: CircTheme<C>;
  component: CircuitComponent;
  dimensions: [number, number];
  pointerLocation: [number, number] | null;
  rotationAngle: number;
  portsSignals: number[];
};

export interface RenderContext {
  size: number;
  pointerLocation?: [number, number];
  activePin: number | null;
}

const DEFAULT_RENDER_CONTEXT: RenderContext = {
  size: 1,
  pointerLocation: undefined,
  activePin: null,
};

function defaultBackgroundDrawer<C extends string>(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  theme: CircTheme<C>,
  gridSize = 10
) {
  ctx.fillStyle =
    (theme as CircTheme<string>).colors.background ??
    baseTheme.colors.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.fillStyle =
    (theme as CircTheme<string>).colors.blue ?? baseTheme.colors.blue;

  for (let x = 0; x < canvas.width; x += gridSize) {
    for (let y = 0; y < canvas.height; y += gridSize) {
      // if (y === 0 || x === 0) {
      //   continue;
      // }
      ctx.beginPath();
      ctx.arc(x, y, 1, 0, 2 * Math.PI);
      ctx.fill();
    }
  }
}

function defaultWireDrawer<C extends string>(
  ctx: CanvasRenderingContext2D,
  theme: CircTheme<C>,
  circuit: Circuit,
  gridSize = 10
) {
  const { wires, state } = circuit;

  for (let i = 0; i < state.length; i++) {
    const groups = wires.connections.get(i);

    if (!groups) {
      continue;
    }

    for (const j of groups) {
      const wire = wires.list[j];
      const to = decodeCircCoords(wire.to);
      const from = decodeCircCoords(wire.from);

      const x1 = from[0] * gridSize;
      const y1 = from[1] * gridSize;
      const x2 = to[0] * gridSize;
      const y2 = to[1] * gridSize;
      const isOn = state[i] === 1;

      line({
        ctx,
        from: [x1, y1],
        to: [x2, y2],
        style: {
          lineWidth: 2,
          lineCap: "round",
          strokeStyle: isOn
            ? (theme as CircTheme<string>).colors.green ??
              baseTheme.colors.green
            : (theme as CircTheme<string>).colors.blue ?? baseTheme.colors.blue,
        },
      });
    }
  }
}

function defaultPortDrawer<C extends string>(
  ctx: CanvasRenderingContext2D,
  theme: CircTheme<C>,
  component: CircuitComponent,
  circuit: Circuit,
  _: RenderContext,
  gridSize = 10
) {
  const inputStateAddr = circuit.wireConnections.get(component.location);

  if (inputStateAddr === undefined) {
    return;
  }

  const coords = decodeCircCoords(component.location);
  const inputFillStyle =
    circuit.state[inputStateAddr] === 1
      ? (theme as CircTheme<string>).colors.green ?? baseTheme.colors.green
      : (theme as CircTheme<string>).colors.yellow ?? baseTheme.colors.yellow;

  circle({
    ctx,
    center: [coords[0] * gridSize, coords[1] * gridSize],
    radius: 0.25 * gridSize,
    style: {
      fillStyle: inputFillStyle,
    },
  });

  for (const port of component.ports) {
    const portStateAdrr = circuit.wireConnections.get(port);
    if (portStateAdrr === undefined) {
      continue;
    }

    const portLoc = decodeCircCoords(port);
    const fillStyle =
      circuit.state[portStateAdrr] === 1
        ? (theme as CircTheme<string>).colors.green ?? baseTheme.colors.green
        : (theme as CircTheme<string>).colors.yellow ?? baseTheme.colors.yellow;

    circle({
      ctx,
      center: [portLoc[0] * gridSize, portLoc[1] * gridSize],
      radius: 0.25 * gridSize,
      style: {
        fillStyle,
      },
    });
  }
}

function defaultComponentDrawer<C extends string>({
  dimensions,
  ctx,
  theme,
  rotationAngle,
  component,
}: ComponentRenderArgument<C>) {
  const [width, height] = dimensions;

  ctx.fillStyle =
    (theme as CircTheme<string>).colors.white ?? baseTheme.colors.white;

  ctx.save();
  ctx.translate(-width / 2, height);
  ctx.rotate(-Math.PI / 2);
  ctx.fillRect(0, height / 2, width, height);
  ctx.restore();

  ctx.beginPath();
  ctx.font = `${6}px monospace`;

  ctx.fillStyle =
    (theme as CircTheme<string>).colors.blue ?? baseTheme.colors.blue;
  ctx.strokeStyle =
    (theme as CircTheme<string>).colors.blue ?? baseTheme.colors.blue;
  ctx.lineWidth = 0.5;
  ctx.textAlign = "center";
  ctx.fill();

  ctx.translate(width / 2, height / 2);
  ctx.rotate(-rotationAngle);
  ctx.strokeText(component.name, -2.5, 2.5);
  ctx.fillText(component.name, -2.5, 2.5);
}

function renderBackground<C extends string>(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  theme: CircTheme<C>,
  t: number,
  gridSize = 10
) {
  ctx.save();
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const drawBackground = theme.background ?? defaultBackgroundDrawer;
  drawBackground(ctx, canvas, theme, gridSize);

  ctx.restore();
}

function renderWires<C extends string>(
  ctx: CanvasRenderingContext2D,
  theme: CircTheme<C>,
  circuit: Circuit,
  gridSize = 10
) {
  ctx.save();

  const drawWires = theme.wires ?? defaultWireDrawer;
  drawWires(ctx, theme, circuit, gridSize);

  ctx.restore();
}

const rotationAngles = (facing: string) => {
  switch (facing) {
    case "north":
      return 0.5 * Math.PI;
    case "west":
      return 0;
    case "south":
      return -0.5 * Math.PI;
    case "east":
      return Math.PI;
    default:
      return 0;
  }
};

function renderComponents<C extends string>(
  ctx: CanvasRenderingContext2D,
  theme: CircTheme<C>,
  circuit: Circuit,
  context: RenderContext,
  gridSize = 10
) {
  const { components } = circuit;

  let overPin: number | null = null;

  for (let i = 0; i < components.list.length; i++) {
    ctx.save();
    const component = components.list[i];

    const width =
      component.name === "Pin"
        ? 10
        : (Number(component.attributes.size) / 10) * gridSize;
    let height =
      component.name === "Pin"
        ? 10
        : (Number(component.attributes.size) / 10) * gridSize;

    if (component.name === "NOT Gate") {
      height = 10;
    }

    const coords = decodeCircCoords(component.location);
    const x = coords[0] * gridSize;
    const y = coords[1] * gridSize;

    const rotationAngle = rotationAngles(component.attributes.facing);
    ctx.translate(x, y);
    ctx.rotate(rotationAngle);
    ctx.translate(0, -height / 2);

    if (component.name === "Pin" && !component.attributes.output) {
      ctx.fillStyle = `rgba(255, ${i}, 0, 255)`;
      ctx.fillRect(5, 1, width - 2, height - 2);

      if (context.pointerLocation && overPin === null) {
        const [r, g, b, a] = ctx.getImageData(
          context.pointerLocation[0],
          context.pointerLocation[1],
          1,
          1
        ).data;

        if (r === 255 && g === i && b === 0 && a === 255) {
          overPin = i;
        }
      }
    }

    let portsSignals: number[] = [];

    if (component.name === "Pin" || component.name === "LED") {
      // biome-ignore lint/style/noNonNullAssertion: this is always defined
      const valueIndex = circuit.wireConnections.get(component.location)!;
      const value = circuit.state[valueIndex];

      portsSignals = [value];
    }

    const textLayer: ((angle: number) => void)[] = [];

    if (theme.library?.[component.name] !== undefined) {
      theme.library[component.name]({
        ctx: ctx,
        theme: theme,
        component: component,
        dimensions:
          component.name !== "Not Gate" ? [width, height] : [width, 10],
        pointerLocation: overPin === i ? context.pointerLocation ?? null : null,
        rotationAngle,
        portsSignals,
      });
    } else {
      defaultComponentDrawer({
        ctx: ctx,
        theme: theme,
        component: component,
        dimensions:
          component.name !== "Not Gate" ? [width, height] : [width, 10],
        pointerLocation: overPin === i ? context.pointerLocation ?? null : null,
        rotationAngle,
        portsSignals,
      });
    }

    for (const text of textLayer) {
      text(rotationAngles(component.attributes.facing));
    }
    context.activePin = overPin;
    ctx.restore();

    const drawPorts = theme.ports ?? defaultPortDrawer;
    drawPorts(ctx, theme, component, circuit, context, gridSize);
  }
}

export class RenderEngine<C extends string> {
  private enabled = false;
  private _canvasElement = document.createElement("canvas");
  private context: RenderContext;
  private time: number | null = null;

  get canvasElement() {
    return this._canvasElement;
  }

  constructor(private circuit: Circuit, public options: RenderOptions<C>) {
    this.context = {
      ...DEFAULT_RENDER_CONTEXT,
      size: options.scale,
    };

    this._canvasElement.addEventListener(
      "pointermove",
      this.registerMouseMovement
    );

    this._canvasElement.addEventListener("click", this.handleClick);
  }

  private handleClick = (event: MouseEvent) => {
    this.options.onClick?.(this.context);
  };

  private registerMouseMovement = (event: PointerEvent) => {
    const x = event.clientX;
    const y = event.clientY;

    this.context.pointerLocation = [x, y];
  };

  destory() {
    this.stop();
    this.canvasElement.remove();

    this._canvasElement.removeEventListener(
      "pointermove",
      this.registerMouseMovement
    );

    this._canvasElement.removeEventListener("click", this.handleClick);
  }

  render() {
    if (!this.enabled) {
      this.enabled = true;
      this.processRender();
    }
  }

  stop() {
    this.enabled = false;
  }

  private processDrawing(
    ctx: CanvasRenderingContext2D,
    delta: number,
    context: RenderContext
  ) {
    renderBackground(
      ctx,
      this.canvasElement,
      this.options.theme,
      delta / (60 * 10)
    );

    renderWires(ctx, this.options.theme, this.circuit);
    renderComponents(ctx, this.options.theme, this.circuit, context);
  }

  private processRender() {
    const {
      limitFPS = 60,
      width = 300,
      height = 300,
      rotate = 0,
    } = this.options;

    const ctx = this.canvasElement.getContext("2d");

    if (!ctx) {
      throw new Error("Could not get 2d context");
    }

    const delay = 1000 / limitFPS;

    let frame = -1;

    const renderLoop = (timestamp: DOMHighResTimeStamp) => {
      if (this.time === null) this.time = timestamp;
      const seg = Math.floor((timestamp - this.time) / delay);
      if (seg > frame) {
        frame = seg;

        ctx.clearRect(
          0,
          0,
          this.canvasElement.width,
          this.canvasElement.height
        );

        ctx.save();
        ctx.scale(this.context.size, this.context.size);
        this.processDrawing(ctx, timestamp - this.time, this.context);
        ctx.restore();
      }
      if (this.enabled) {
        requestAnimationFrame(renderLoop);
      }
    };

    requestAnimationFrame(renderLoop);
  }
}
