import { buildCanvas } from "src/render";
import InteractionEngine from "src/services/interaction";
import SimulationEngine from "src/services/simulation";
import {
  type CircTheme as BaseCircTheme,
  type ThemeColor as BaseThemeColor,
  baseTheme,
} from "src/utils/theme";

import type { DrawArguments as ParserDrawArguments } from "src/services/parser";

import { toFaceIndex as toFaceIndexFn } from "src/utils/renderPoints";

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

export const toFaceIndex = toFaceIndexFn;

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

function parseTouchPoint(touch: Touch, element: HTMLElement): [number, number] {
  const { left, top } = element.getBoundingClientRect();

  return [touch.clientX - left, touch.clientY - top];
}

export function CircRenderer(
  input: string,
  config: CircRendererConfig = {}
): HTMLElement {
  const effectiveTheme: CircTheme = config.theme ?? baseTheme;
  const { width = 640, height = 480, scale = 3 } = config;

  const interactionEngine = new InteractionEngine();
  const simulationEngine = new SimulationEngine(gridSize, 20, 20);

  const element = buildCanvas(input, interactionEngine, simulationEngine, {
    theme: effectiveTheme,
    scale,
    width,
    height,
  });

  function movePointer(x: number, y: number) {
    const { width: eWidth, height: eHeight } = element.getBoundingClientRect();

    const xAmplification = width / eWidth;
    const yAmplification = height / eHeight;

    interactionEngine.notifyPointerInteraction([
      x * xAmplification,
      y * yAmplification,
      undefined,
    ]);
  }

  function lowerPointer(x: number, y: number) {
    const { width: eWidth, height: eHeight } = element.getBoundingClientRect();

    const xAmplification = width / eWidth;
    const yAmplification = height / eHeight;

    interactionEngine.notifyPointerInteraction([
      x * xAmplification,
      y * yAmplification,
      true,
    ]);
  }

  function raisePointer(x: number, y: number) {
    const { width: eWidth, height: eHeight } = element.getBoundingClientRect();

    const xAmplification = width / eWidth;
    const yAmplification = height / eHeight;

    interactionEngine.notifyPointerInteraction([
      x * xAmplification,
      y * yAmplification,
      false,
    ]);
  }

  element.addEventListener("mousemove", (e) => {
    const x = e.offsetX;
    const y = e.offsetY;

    movePointer(x, y);
  });

  element.addEventListener("mousedown", (e) => {
    const x = e.offsetX;
    const y = e.offsetY;

    lowerPointer(x, y);
  });
  element.addEventListener("mouseup", (e) => {
    const x = e.offsetX;
    const y = e.offsetY;

    raisePointer(x, y);
  });

  element.addEventListener("touchmove", (e) => {
    const touch = e.changedTouches[0];

    movePointer(...parseTouchPoint(touch, element));
  });

  element.addEventListener("touchstart", (e) => {
    const touch = e.changedTouches[0];

    lowerPointer(...parseTouchPoint(touch, element));
  });

  element.addEventListener("touchend", (e) => {
    const touch = e.changedTouches[0];

    raisePointer(...parseTouchPoint(touch, element));
  });

  return element;
}
