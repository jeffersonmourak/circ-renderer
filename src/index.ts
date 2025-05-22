import type { CircTheme } from "./utils/theme";
import * as ui from "./modules/ui";

export type CircRendererConfig<C extends string> = {
  theme?: CircTheme<C>;
  scale?: number;
  width?: number;
  height?: number;
};

export * from "./utils";
export * from "./modules/loader";
export * from "./modules/simulator";
export * from "./modules/renderer";

export { ui };
