import { type CnVector2, cn, parseCn, toVector2 } from "./numbers";

export type ComponentFace = "north" | "south" | "east" | "west";

export const decodeCircCoords = (coords?: string): CnVector2 => {
  const location = toVector2(
    coords?.slice(1, -1).split(",").map(parseCn) ?? [cn(0), cn(0)]
  );

  if (!location) {
    throw new Error(`Could not parse ${coords} as a location`);
  }

  return location;
};

export const getFacingOffset = (facing: ComponentFace, size: number) => {
  switch (facing) {
    case "north":
      return [-1 * (size / 2), 0];
    case "south":
      return [-1 * (size / 2), -2 * (size / 2)];
    case "east":
      return [-2 * (size / 2), -1 * (size / 2)];
    case "west":
      return [0, -1 * (size / 2)];
  }
};
