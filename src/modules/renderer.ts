import type { CircTheme } from "../utils/theme";
import type { Circuit, CircuitComponent } from "./loader";

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

type RenderOptions = {
  theme: CircTheme;
  scale: number;
  width: number;
  height: number;
  limitFPS?: number;
  onClick?: (context: RenderContext) => void;
};

export type ComponentRenderArgument = {
  ctx: CanvasRenderingContext2D;
  theme: CircTheme;
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

function renderBackground(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  theme: CircTheme,
  t: number,
  gridSize = 10
) {
  ctx.save();
  // Draw background
  ctx.fillStyle = theme.colors.backgroundPrimary;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Draw grid dots
  ctx.fillStyle = theme.colors.blue;

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
  ctx.restore();
}

function renderWires(
  ctx: CanvasRenderingContext2D,
  theme: CircTheme,
  circuit: Circuit,
  gridSize = 10
) {
  const { wires, state } = circuit;

  ctx.save();

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

      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.lineWidth = 2;
      ctx.lineCap = "round";
      ctx.strokeStyle = isOn ? theme.colors.green : theme.colors.blue;
      ctx.stroke();
      ctx.closePath();
    }
  }

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

function renderComponents(
  ctx: CanvasRenderingContext2D,
  theme: CircTheme,
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
    }

    for (const text of textLayer) {
      text(rotationAngles(component.attributes.facing));
    }
    context.activePin = overPin;
    ctx.restore();

    const valueIndex = circuit.wireConnections.get(component.location)!;
    const value = circuit.state[valueIndex];

    ctx.beginPath();
    ctx.fillStyle = value === 1 ? theme.colors.green : theme.colors.yellow;
    ctx.arc(x, y, 0.25 * gridSize, 0, Math.PI * 2);
    ctx.fill();
    ctx.closePath();

    for (const port of component.ports) {
      const portLoc = decodeCircCoords(port);
      const portX = portLoc[0] * gridSize;
      const portY = portLoc[1] * gridSize;
      const valueIndex = circuit.wireConnections.get(port)!;
      const value = circuit.state[valueIndex];

      ctx.beginPath();
      ctx.fillStyle = value === 1 ? theme.colors.green : theme.colors.yellow;
      ctx.arc(portX, portY, 0.25 * gridSize, 0, Math.PI * 2);
      ctx.fill();
      ctx.closePath();
    }
  }
}

export class RenderEngine {
  private enabled = false;
  private _canvasElement = document.createElement("canvas");
  private context: RenderContext;
  private time: number | null = null;

  get canvasElement() {
    return this._canvasElement;
  }

  constructor(private circuit: Circuit, private options: RenderOptions) {
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
    const { limitFPS = 60, width = 300, height = 300 } = this.options;

    this.canvasElement.width = width;
    this.canvasElement.height = height;

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

        ctx?.clearRect(
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
