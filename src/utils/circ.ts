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

export function isWireElement(element: Element): element is WireComponent {
  return (
    element.tagName === "wire" &&
    element.hasAttribute("from") &&
    element.hasAttribute("to")
  );
}

function assertValidWire(
  wireElement: Element
): asserts wireElement is WireComponent {
  if (wireElement.tagName !== "wire") {
    throw new Error("Invalid wire element");
  }

  if (!wireElement.hasAttribute("from")) {
    throw new Error("Wire element does not have coords attribute");
  }

  if (!wireElement.hasAttribute("to")) {
    throw new Error("Wire element does not have facing attribute");
  }
}

export function parseWire(wireElement: Element) {
  assertValidWire(wireElement);

  const from = wireElement.getAttribute("from");
  const to = wireElement.getAttribute("to");

  return {
    from,
    to,
  };
}

export interface CircComponent extends Omit<Element, "getAttribute"> {
  getAttribute(qualifiedName: "loc" | "name"): string;
}

export function isComponentElement(element: Element): element is CircComponent {
  return (
    element.tagName === "comp" &&
    element.hasAttribute("loc") &&
    element.hasAttribute("name")
  );
}

export function assertValidComponent(
  componentElement: Element
): asserts componentElement is CircComponent {
  if (componentElement.tagName !== "comp") {
    throw new Error("Invalid component element");
  }

  if (!componentElement.hasAttribute("loc")) {
    throw new Error("Component element does not have coords attribute");
  }

  if (!componentElement.hasAttribute("name")) {
    throw new Error("Component element does not have name attribute");
  }
}

export function parseComponent(componentElement: Element) {
  assertValidComponent(componentElement);

  const name = componentElement.getAttribute("name");
  const location = componentElement.getAttribute("loc");

  const attributes = {
    facing: "east" as ComponentFace,
    size: "50",
    output: false,
    label: undefined as string | undefined,
  };

  for (let i = 0; i < componentElement.children.length; i++) {
    if (componentElement.children[i].tagName !== "a") {
      continue;
    }

    const attribute = componentElement.children[i];
    const attributeName = attribute.getAttribute("name");
    const attributeValue = attribute.getAttribute("val");

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
