import type { Circuit, CircuitComponent } from "..";
import type {
  ComponentRenderArgument,
  RenderContext,
} from "../modules/renderer";

const baseThemeColors = {
  background: "#f8f9fa",
  red: "#dc3545",
  orange: "#fd7e14",
  yellow: "#ffc107",
  green: "#28a745",
  cyan: "#17a2b8",
  blue: "#007bff",
  purple: "#6f42c1",
  pink: "#e83e8c",
  white: "#ffffff",
} satisfies Record<ThemeColor, string>;

const themeColorKeys = [
  "background",
  "red",
  "orange",
  "yellow",
  "green",
  "cyan",
  "blue",
  "purple",
  "pink",
  "white",
] as const;

export type ThemeColor = (typeof themeColorKeys)[number];

export type CircTheme<C extends string> = {
  colors: Record<C, string>;
  library: Record<string, (args: ComponentRenderArgument<C>) => void>;
  background?: (
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    theme: CircTheme<C>,
    gridSize?: number
  ) => void;
  wires?: (
    ctx: CanvasRenderingContext2D,
    theme: CircTheme<C>,
    circuit: Circuit,
    gridSize?: number
  ) => void;
  ports?: (
    ctx: CanvasRenderingContext2D,
    theme: CircTheme<C>,
    component: CircuitComponent,
    circuit: Circuit,
    context: RenderContext,
    gridSize?: number
  ) => void;
};

export const baseTheme: CircTheme<ThemeColor> = {
  colors: baseThemeColors,
  library: {},
};

export function stringToColor(string: string, randomize?: boolean): string {
  let saltedString = string;
  let hash = 0;
  let i = 0;

  if (randomize) {
    saltedString = string + Math.random();
  }

  for (i = 0; i < saltedString.length; i += 1) {
    hash = saltedString.charCodeAt(i) + ((hash << 5) - hash);
  }

  let color = "#";

  for (i = 0; i < 3; i += 1) {
    const value = (hash >> (i * 8)) & 0xff;
    color += `00${value.toString(16)}`.substr(-2);
  }

  return color;
}

export default stringToColor;
