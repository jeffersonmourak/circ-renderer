import { partition, throttle } from "lodash";
import { createCanvasController } from "./canvasController";
import type InteractionEngine from "./services/interaction";
import { type Component, parseCircuit } from "./services/parser";
import SimulationEngine from "./services/simulation";
import { type CnMat2x2, resolveCn } from "./utils";
import { pt } from "./utils/renderPoints";
import type { CircTheme } from "./utils/theme";

export interface RenderContext {
  size: number;
  pointerLocation?: [number, number];
}

const DEFAULT_RENDER_CONTEXT: RenderContext = {
  size: 3,
  pointerLocation: undefined,
};

type BuildCanvasOptions = {
  theme: CircTheme;
};

function renderComponentPorts<S>(
  ctx: CanvasRenderingContext2D,
  component: Component<S>,
  scaleFactor: number
) {
  for (const port of component.ports) {
    const [portX, portY, _mode] = port;
    const [resolvedX, resolvedY] = [
      resolveCn(portX, scaleFactor),
      resolveCn(portY, scaleFactor),
    ];

    const [rotatedPortX, rotatedPortY] = pt(
      resolvedX,
      resolvedY,
      component.bounds,
      component.facing,
      component.faceAngles,
      scaleFactor
    );

    ctx.fillStyle = "red";
    ctx.fillRect(rotatedPortX - 2.5, rotatedPortY - 2.5, 5, 5);
  }
}

export function buildCanvas(
  content: string,
  interaction: InteractionEngine,
  initialWidth: number,
  options: BuildCanvasOptions
) {
  const parser = new DOMParser();
  const xmlDoc = parser.parseFromString(content, "text/xml");

  let didUserClicked = false;

  function processPointerAction(collidingComponents: Set<number>) {
    for (const index of collidingComponents) {
      const component = components[index];

      const newSignals = component.onPress?.(simulation.portsSignals[index]);

      if (newSignals) {
        simulation.propagateComponentOutput(index, newSignals);
      }
    }
  }

  const gridSize = 10;
  const circuit = parseCircuit(xmlDoc.getElementsByTagName("circuit")[0]);

  const [wires, components] = partition(circuit, (c) => c.name === "wire");

  const simulation = new SimulationEngine(gridSize, 20, 20);

  simulation.connectWires(wires);
  simulation.connectPorts(components);

  const processPointerPress = throttle((colidingPoints: Set<number>) => {
    if (!didUserClicked) {
      didUserClicked = true;
      processPointerAction(colidingPoints);
    }
  }, 1000);

  const checkPointerCollision = (
    pointerLocation: [number, number] | undefined,
    bounds: CnMat2x2,
    scaleFactor: number
  ) => {
    const xBegin = resolveCn(bounds[0][0], scaleFactor);
    const xEnd = xBegin + resolveCn(bounds[1][0], scaleFactor);

    const yBegin = resolveCn(bounds[0][1], scaleFactor);
    const yEnd = yBegin + resolveCn(bounds[1][1], scaleFactor);

    if (!pointerLocation) {
      return false;
    }

    const [x, y] = pointerLocation;

    return x >= xBegin && x <= xEnd && y >= yBegin && y <= yEnd;
  };

  const collidingComponents = new Set<number>();

  const canvasElement = createCanvasController({
    initialContext: { ...DEFAULT_RENDER_CONTEXT },
    draw: ({ canvas, context }) => {
      const ctx = canvas.getContext("2d");

      if (!ctx) {
        throw new Error("Could not get 2d context");
      }

      // Draw background
      ctx.fillStyle = options.theme.colors.backgroundSecondary;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Draw grid dots
      ctx.fillStyle = options.theme.colors.blue;

      const toGridIndex = (value: number) =>
        ~~(value / context.size / gridSize);

      for (let x = 0; x < canvas.width; x += context.size * gridSize) {
        for (let y = 0; y < canvas.height; y += context.size * gridSize) {
          ctx.beginPath();
          ctx.arc(x, y, 1, 0, 2 * Math.PI);
          ctx.fill();
        }
      }

      for (let i = 0; i < wires.length; i++) {
        const wire = wires[i];
        const signal = simulation.wireSignals[i];

        wire.draw({
          ctx,
          theme: options.theme,
          state: wire.state,
          pointerLocation: null,
          bounds: wire.bounds,
          face: wire.facing,
          scaleFactor: context.size,
          ports: wire.ports,
          faceAngles: wire.faceAngles,
          portsSignals: [signal],
        });
      }

      for (let i = 0; i < components.length; i++) {
        const component = components[i];
        const portsSignals = simulation.portsSignals[i];

        const coliding = checkPointerCollision(
          context.pointerLocation,
          component.bounds,
          context.size
        );

        if (coliding) {
          collidingComponents.add(i);
        }

        component.draw({
          ctx,
          theme: options.theme,
          state: component.state,
          pointerLocation: coliding ? context.pointerLocation ?? null : null,
          bounds: component.bounds,
          face: component.facing,
          scaleFactor: context.size,
          ports: component.ports,
          portsSignals,
          faceAngles: component.faceAngles,
        });
      }

      for (const component of components) {
        renderComponentPorts(ctx, component, context.size);
      }

      if (context.pointerLocation) {
        ctx.beginPath();
        ctx.arc(
          context.pointerLocation[0],
          context.pointerLocation[1],
          4,
          0,
          2 * Math.PI
        );

        ctx.fillStyle =
          collidingComponents.size > 0
            ? options.theme.colors.green
            : options.theme.colors.purple;
        ctx.fill();
        ctx.closePath();
      }
      canvas.style.cursor = "none";
    },
    update: ({ context }) => {
      context.pointerLocation = interaction.getPointerLocation();

      if (interaction.isMouseDown()) {
        processPointerPress(collidingComponents);
      } else {
        didUserClicked = false;
        processPointerPress.cancel();
      }

      collidingComponents.clear();
    },
    config: {
      limitFPS: 60,
      initialWidth,
      theme: options.theme,
    },
  });

  return canvasElement;
}
