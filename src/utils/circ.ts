import type { CircComp, CircWire } from "../types";
import {
  as3x1Matrix,
  fromCoordString,
  matrixMultiply,
  rotationMatrix,
  toCoordString,
  translationMatrix,
} from "./math";

export type ComponentFace = "north" | "south" | "east" | "west";

const primitiveComponents = [
  "Pin",
  "LED",
  "NOT Gate",
  "AND Gate",
  "NAND Gate",
  "OR Gate",
  "XOR Gate",
  "NOR Gate",
  "Adder",
] as const;

export const isPrimitiveComponent = (
  name: string
): name is PrimitiveComponentKey => {
  return primitiveComponents.includes(name as PrimitiveComponentKey);
};

export type PrimitiveComponentKey = (typeof primitiveComponents)[number];

export interface WireComponent extends Omit<Element, "getAttribute"> {
  getAttribute(qualifiedName: "from" | "to"): string;
}

export type WireData = {
  from: string;
  to: string;
};

export function isWireElement(element: any): element is CircWire {
  if (!element || typeof element !== "object") {
    return false;
  }

  return (
    "from" in element &&
    "to" in element &&
    typeof element.from === "string" &&
    typeof element.to === "string"
  );
}

function assertValidWire(wireObject: any): asserts wireObject is CircWire {
  if (typeof wireObject !== "object") {
    throw new Error("Invalid wire object");
  }

  if (!("from" in wireObject) || !("to" in wireObject)) {
    throw new Error("Wire object does not have from or to attributes");
  }

  if (
    typeof wireObject.from !== "string" ||
    typeof wireObject.to !== "string"
  ) {
    throw new Error("Wire object from or to attributes are not strings");
  }
}

export function parseWire(wireObject: any): WireData {
  assertValidWire(wireObject);

  return wireObject;
}

export interface CircComponent extends Omit<Element, "getAttribute"> {
  getAttribute(qualifiedName: "loc" | "name"): string;
}

export function isComponentElement(element: any): element is CircComp {
  if (!element || typeof element !== "object") {
    return false;
  }

  return (
    "loc" in element &&
    "name" in element &&
    typeof element.loc === "string" &&
    typeof element.name === "string"
  );
}

export function assertValidComponent(
  componentElement: any
): asserts componentElement is CircComp {
  if (typeof componentElement !== "object") {
    throw new Error("Invalid component object");
  }

  if (!("loc" in componentElement) || !("name" in componentElement)) {
    throw new Error("Component object does not have loc or name attributes");
  }

  if (typeof componentElement.loc !== "string") {
    throw new Error("Component object loc attribute is not a string");
  }

  if (typeof componentElement.name !== "string") {
    throw new Error("Component object name attribute is not a string");
  }
}

export function parseComponent(componentObject: any) {
  assertValidComponent(componentObject);

  const { name, loc: location } = componentObject;

  const attributes = {
    facing: "east" as ComponentFace,
    size: "50",
    output: false,
    label: undefined as string | undefined,
  };

  for (const attribute of componentObject.a ?? []) {
    const { name: attributeName, val: attributeValue } = attribute;

    if (!attributeName || !attributeValue) {
      continue;
    }

    switch (attributeName) {
      case "inputs": {
        throw new Error("Input sizes are not supported yet");
      }
      case "label": {
        attributes.label = attributeValue;
        break;
      }
      case "output": {
        attributes.output = attributeValue === "true";
        break;
      }
      case "facing": {
        attributes.facing = attributeValue as ComponentFace;
        break;
      }
      case "size": {
        attributes.size = attributeValue;
        break;
      }
    }
  }

  const ports = (() => {
    switch (name) {
      case "Pin":
      case "LED":
        return [];
      case "NOT Gate":
        return parseNotPorts(location, attributes.facing, attributes.size);
      case "NAND Gate":
      case "NOR Gate":
      case "XOR Gate":
        return parsePorts(
          location,
          attributes.facing,
          attributes.size,
          [0, 10]
        );
      case "XNOR Gate":
        return parsePorts(
          location,
          attributes.facing,
          attributes.size,
          [0, 20]
        );
      default:
        return parsePorts(location, attributes.facing, attributes.size);
    }
  })();

  return {
    name,
    location,
    type: isPrimitiveComponent(name) ? "primary" : "composed",
    attributes,
    ports,
  };
}

const getFacingRotation = (facing: ComponentFace) => {
  switch (facing) {
    case "east":
      return 0;
    case "south":
      return 0.5 * Math.PI;
    case "west":
      return Math.PI;
    case "north":
      return 1.5 * Math.PI;
  }
};

function getPortFor(
  [x, y]: [number, number],
  [tx, ty]: [number, number],
  facing: ComponentFace
) {
  const rotationMat = rotationMatrix(getFacingRotation(facing));
  const [[rx], [ry]] = matrixMultiply(rotationMat, as3x1Matrix([tx, ty]));

  return matrixMultiply(translationMatrix(x, y), as3x1Matrix([rx, ry]));
}

export function parsePorts(
  location: string,
  facing: ComponentFace,
  sizeAttribute: string,
  expand: [number, number] = [0, 0]
) {
  const [x, y] = fromCoordString(location);
  const size = Number(sizeAttribute);

  const ty = size > 30 ? -20 : -10;
  const tx = -(size + expand[1]);

  const portA = getPortFor([x, y], [tx, ty], facing);
  const portB = getPortFor([x, y], [tx, -ty], facing);

  return [toCoordString(portA), toCoordString(portB)];
}

export function parseNotPorts(
  location: string,
  facing: ComponentFace,
  sizeAttribute: string
) {
  const [x, y] = fromCoordString(location);
  const size = Number(sizeAttribute);

  let px: number;
  let py: number;

  switch (facing) {
    case "east":
      px = x - size;
      py = y;
      break;
    case "west":
      px = x + size;
      py = y;
      break;
    case "north":
      px = x;
      py = y + size;
      break;
    case "south":
      px = x;
      py = y - size;
      break;
  }

  return [toCoordString([px, py])];
}
