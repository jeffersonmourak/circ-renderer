import { andComponentDefinition } from "src/components/AND";
import { nandComponentDefinition } from "src/components/NAND";
import { notComponentDefinition } from "src/components/NOT";
import { orComponentDefinition } from "src/components/OR";
import {
  type CircTheme,
  type CnMat2x2,
  type CnVector2,
  type ComponentFace,
  type ComputableNumber,
  cn,
  decodeCircCoords,
  resolveCn,
} from "src/utils";
import { pt } from "src/utils/renderPoints";
import { ledComponentDefinition } from "../components/LED";
import { pinComponentDefinition } from "../components/pin";
import { wireComponentDefinition } from "../components/wire";
import type { ElectricSignal } from "./simulation";

export type ComponentState = {
  location: [number, number];
  dimensions: [number, number];
  face: ComponentFace;
};

export type DrawArguments<S> = {
  scaleFactor?: number;
  ctx: CanvasRenderingContext2D;
  theme: CircTheme;
  state: S;
  bounds: CnMat2x2;
  face: ComponentFace;
  pointerLocation: [number, number] | null;
  faceAngles: [number, number, number, number];
  ports: Port[];
  portsSignals: ElectricSignal[];
};

export type PortMode = "input" | "output";

type Port = [ComputableNumber, ComputableNumber, PortMode];

export type ComponentDefinition<S> = {
  name: string;
  parse: (values: Record<string, string | null>, component: Element) => S;
  dimensions: ((state: S) => CnVector2) | CnVector2;
  draw(args: DrawArguments<S>): void;
  onSignalChange: (
    ports: ElectricSignal[],
    changedPort: number
  ) => ElectricSignal[];
  onPress?(ports: ElectricSignal[]): ElectricSignal[];
  isInteractable?: boolean;
  defaultFacing: ComponentFace;
  faceAngles: [number, number, number, number];
  skipLocationCheck?: boolean;
  ports: Port[] | ((state: S) => Port[]);
};

export type Component<S> = {
  name: string;
  state: S;
  facing: ComponentFace;
  draw(args: DrawArguments<S>): void;
  bounds: CnMat2x2;
  onPress?(ports: ElectricSignal[]): ElectricSignal[];
  onSignalChange: (
    ports: ElectricSignal[],
    changedPort: number
  ) => ElectricSignal[];
  faceAngles: [number, number, number, number];
  ports: Port[];
};

export const getFacingOffset = (facing: ComponentFace) => {
  switch (facing) {
    case "north":
      return [cn((size) => -1 * (size / 2)), 0];
    case "south":
      return [cn((size) => -1 * (size / 2)), cn((size) => -2 * (size / 2))];
    case "east":
      return [cn((size) => -2 * (size / 2)), cn((size) => -1 * (size / 2))];
    case "west":
      return [cn((size) => 0 * (size / 2)), cn((size) => -1 * (size / 2))];
  }
};

export const parseComponent = <S>(
  component: Element,
  {
    parse,
    dimensions,
    defaultFacing = "east",
    isInteractable = false,
    skipLocationCheck = false,
    ports,
    ...defs
  }: ComponentDefinition<S>
): Component<S> => {
  const locationAttribute = component.getAttribute("loc");

  if (!skipLocationCheck && !locationAttribute) {
    throw new Error("Component is missing a location attribute");
  }

  const location =
    !locationAttribute || skipLocationCheck
      ? [0, 0]
      : decodeCircCoords(locationAttribute);

  let facing = defaultFacing;

  const values: Record<string, string | null> = {};

  for (let i = 0; i < component.children.length; i++) {
    const attribute = component.children[i];
    const name = attribute.getAttribute("name");

    if (!name) {
      continue;
    }

    switch (name) {
      case "facing": {
        const value = attribute.getAttribute("val");

        if (!value) {
          continue;
        }

        facing = value as ComponentFace;
        break;
      }
      default: {
        values[name] = attribute.getAttribute("val");
      }
    }
  }

  const directionOffsets = getFacingOffset(facing);
  const state = parse(values, component);

  const ogX = resolveCn(location[0]);
  const ogY = resolveCn(location[1]);

  const dimensionValues = Array.isArray(dimensions)
    ? dimensions
    : dimensions(state);

  const width = resolveCn(dimensionValues[0]);
  const height = resolveCn(dimensionValues[1]);

  const offsetX = resolveCn(directionOffsets[0], width);
  const offsetY = resolveCn(directionOffsets[1], height);

  const normalizedLocation = [
    cn((m) => (ogX + offsetX) * m),
    cn((m) => (ogY + offsetY) * m),
  ] satisfies CnVector2;

  return {
    state,
    facing,
    ports: Array.isArray(ports) ? ports : ports(state),
    bounds: [normalizedLocation, dimensionValues],
    ...defs,
  };
};

const Library = {
  Pin: pinComponentDefinition,
  LED: ledComponentDefinition,
  "NOT Gate": notComponentDefinition,
  "AND Gate": andComponentDefinition,
  "NAND Gate": nandComponentDefinition,
  "OR Gate": orComponentDefinition,
};

export const parseCircuit = (root: Element) => {
  // biome-ignore lint/suspicious/noExplicitAny: This is a hack to get around the type system
  const parsedComponents: Component<any>[] = [];

  for (let i = 0; i < root.children.length; i++) {
    const component = root.children[i];

    const type = component.tagName;
    const name = component.getAttribute("name");

    // Ignore attribute nodes for now!
    if (type === "a") {
      continue;
    }

    if (type === "wire") {
      parsedComponents.push(parseComponent(component, wireComponentDefinition));
      continue;
    }

    if (!name) {
      continue;
    }

    const libraryComponent = Library[name as keyof typeof Library];

    if (!libraryComponent) {
      console.log(`Unknown component type: ${name}`);
      continue;
    }

    // @ts-expect-error - This is a hack to get around the type system
    const parsedComponent = parseComponent(component, libraryComponent);

    parsedComponents.push(parsedComponent);
  }

  return parsedComponents;
};

export const parseCircuitPorts = <S>(
  component: Component<S>,
  gridSize: number
) => {
  const portData: [number, number, PortMode][] = [];
  for (const port of component.ports) {
    const [x, y, mode] = port;
    const [resolvedX, resolvedY] = [resolveCn(x), resolveCn(y)];
    const [rotatedPortX, rotatedPortY] = pt(
      resolvedX,
      resolvedY,
      component.bounds,
      component.facing,
      component.faceAngles,
      1
    );

    portData.push([rotatedPortX / gridSize, rotatedPortY / gridSize, mode]);
  }

  return portData;
};
