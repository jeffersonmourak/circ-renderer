import { buildCanvas } from "src/render";
import InteractionEngine from "src/services/interaction";
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

  const element = buildCanvas(input, interactionEngine, initialWidth, {
    theme: effectiveTheme,
  });

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
