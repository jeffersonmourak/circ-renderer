import type { RenderContext } from "./render";
import type { CircTheme } from "./utils/theme";

export interface RenderInfo {
  canvas: HTMLCanvasElement;
  context: RenderContext;
}

export interface RuntimeConfig {
  limitFPS?: number;
  width: number;
  height: number;
  theme: CircTheme;
}

export interface CreateCanvasControllerOptions {
  initialContext: RenderContext;
  draw: (payload: {
    canvas: HTMLCanvasElement;
    context: RenderContext;
  }) => void;
  update?: (info: RenderInfo) => void;
  config?: RuntimeConfig;
}

export function createCanvasController(
  canvasElement: HTMLCanvasElement,
  {
    initialContext,
    draw,
    config,
    update = () => {},
  }: CreateCanvasControllerOptions
) {
  const { limitFPS = 60, width = 300, height = 300, theme } = config ?? {};

  canvasElement.width = width;
  canvasElement.height = height;

  const ctx = canvasElement.getContext("2d");

  if (!ctx) {
    throw new Error("Could not get 2d context");
  }

  const context = { ...initialContext };

  const delay = 1000 / limitFPS;
  let time: number | null = null;
  let frame = -1;
  let tref: number;

  function renderLoop(timestamp: DOMHighResTimeStamp) {
    if (time === null) time = timestamp;
    const seg = Math.floor((timestamp - time) / delay);
    if (seg > frame) {
      frame = seg;

      ctx?.clearRect(0, 0, canvasElement.width, canvasElement.height);
      update({ context, canvas: canvasElement });
      draw({
        canvas: canvasElement,
        context,
      });
    }
    tref = requestAnimationFrame(renderLoop);
  }

  tref = requestAnimationFrame(renderLoop);
}
