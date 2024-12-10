import { buildCanvas } from "src/render";
import InteractionEngine from "src/services/interaction";
import SimulationEngine from "src/services/simulation";
import {
  type CircTheme as BaseCircTheme,
  type ThemeColor as BaseThemeColor,
  baseTheme,
} from "src/utils/theme";

export type CircRendererConfig = {
  theme?: CircTheme;
};

export type CircTheme = BaseCircTheme;
export type ThemeColor = BaseThemeColor;

const gridSize = 10;

export function CircRenderer(
  input: string,
  initialWidth: number,
  config: CircRendererConfig = {}
): HTMLCanvasElement {
  const effectiveTheme: CircTheme = {
    ...baseTheme,
    ...config.theme,
  };

  const interactionEngine = new InteractionEngine();
  const simulationEngine = new SimulationEngine(gridSize, 20, 20);

  const element = buildCanvas(
    input,
    interactionEngine,
    simulationEngine,
    initialWidth,
    {
      theme: effectiveTheme,
    }
  );

  element.addEventListener("mousemove", (e) => {
    const x = e.offsetX;
    const y = e.offsetY;

    interactionEngine.notifyPointerInteraction([x, y, undefined]);
  });

  element.addEventListener("mousedown", (e) => {
    const x = e.offsetX;
    const y = e.offsetY;

    interactionEngine.notifyPointerInteraction([x, y, true]);
  });
  element.addEventListener("mouseup", (e) => {
    const x = e.offsetX;
    const y = e.offsetY;

    interactionEngine.notifyPointerInteraction([x, y, false]);
  });

  return element;
}
