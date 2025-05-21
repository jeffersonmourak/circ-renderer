import type { CircTheme } from "./utils/theme";

export type CircRendererConfig = {
  theme?: CircTheme;
  scale?: number;
  width?: number;
  height?: number;
};

export * from "./utils";
export * from "./modules/loader";
export * from "./modules/simulator";
export * from "./modules/renderer";
