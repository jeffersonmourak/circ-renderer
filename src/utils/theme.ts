import type { DrawArguments } from "../services/parser";

const baseThemeColors = {
  primary: "#007bff",
  primary1: "#007bff",
  primary2: "#0056b3",
  backgroundPrimary: "#f8f9fa",
  backgroundPrimaryAlt: "#f8f9fa",
  backgroundSecondary: "#f8f9fa",
  red: "#dc3545",
  orange: "#fd7e14",
  yellow: "#ffc107",
  green: "#28a745",
  cyan: "#17a2b8",
  blue: "#007bff",
  purple: "#6f42c1",
  pink: "#e83e8c",
  base00: "#ffffff",
  base05: "#f8f9fa",
  base10: "#f1f3f5",
  base20: "#e9ecef",
  base25: "#dee2e6",
  base30: "#ced4da",
  base35: "#adb5bd",
  base40: "#868e96",
  base50: "#495057",
  base60: "#343a40",
  base70: "#212529",
  base100: "#000000",
} satisfies Record<ThemeColor, string>;

const themeColorKeys = [
  "primary",
  "primary1",
  "primary2",
  "backgroundPrimary",
  "backgroundPrimaryAlt",
  "backgroundSecondary",
  "red",
  "orange",
  "yellow",
  "green",
  "cyan",
  "blue",
  "purple",
  "pink",
  "base00",
  "base05",
  "base10",
  "base20",
  "base25",
  "base30",
  "base35",
  "base40",
  "base50",
  "base60",
  "base70",
  "base100",
] as const;

export type ThemeColor = (typeof themeColorKeys)[number];

export type CircTheme = {
  colors: Record<ThemeColor, string>;
  library: Record<string, <S>(args: DrawArguments<S>) => void>;
};

export const baseTheme: CircTheme = {
  colors: baseThemeColors,
  library: {},
};

export function drawFitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  fontface: string,
  width: number,
  x: number,
  y: number
) {
  // start with a large font size
  let fontsize = 300;

  // lower the font size until the text fits the canvas
  do {
    fontsize--;
    ctx.font = `${fontsize}px ${fontface}`;
  } while (ctx.measureText(text).width > width);

  // draw the text
  ctx.fillText(text, x, y);
}

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
