import { buildCanvas } from "src/render";
import InteractionEngine from "src/services/interaction";
import SimulationEngine from "src/services/simulation";
import {
  type CircTheme as BaseCircTheme,
  type ThemeColor as BaseThemeColor,
  baseTheme,
} from "src/utils/theme";

import type { DrawArguments as ParserDrawArguments } from "src/services/parser";

import type { AndState as TAndState } from "src/components/AND";
import type { LEDState as TLEDState } from "src/components/LED";
import type { NandState as TNandState } from "src/components/NAND";
import type { NotState as TNotState } from "src/components/NOT";
import type { PinState as TPinState } from "src/components/pin";
import type { WireState as TWireState } from "src/components/wire";

import { resolveCn as rcn } from "src/utils";

export type LEDState = TLEDState;
export type NotState = TNotState;
export type PinState = TPinState;
export type WireState = TWireState;
export type AndState = TAndState;
export type NandState = TNandState;

export const resolveCn = rcn;

export type DrawArguments<S> = ParserDrawArguments<S>;

export type CircRendererConfig = {
  theme?: CircTheme;
  scale?: number;
  width?: number;
  height?: number;
};

export type CircTheme = BaseCircTheme;
export type ThemeColor = BaseThemeColor;

const gridSize = 10;

export function CircRenderer(
  input: string,
  config: CircRendererConfig = {}
): HTMLElement {
  const effectiveTheme: CircTheme = config.theme ?? baseTheme;
  const scale = config.scale ?? 3;

  const interactionEngine = new InteractionEngine();
  const simulationEngine = new SimulationEngine(gridSize, 20, 20);

  const element = buildCanvas(input, interactionEngine, simulationEngine, {
    theme: effectiveTheme,
    scale,
    width: config.width ?? 640,
    height: config.height ?? 480,
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
