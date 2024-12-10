import type { ComponentFace } from "./circ";
import { type CnMat2x2, type Mat2x2, resolveCn } from "./numbers";

function rotatePoint(x: number, y: number, rotation: number): [number, number] {
  const angle = rotation * (Math.PI / 180);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  const rotationMatrix = [
    [cos, -sin],
    [sin, cos],
  ];

  const rotatedPortX = x * rotationMatrix[0][0] + y * rotationMatrix[0][1];
  const rotatedPortY = x * rotationMatrix[1][0] + y * rotationMatrix[1][1];

  return [rotatedPortX, rotatedPortY];
}

export function getBoxMiddle(bounds: Mat2x2): [number, number];
export function getBoxMiddle(bounds: CnMat2x2): [number, number];
export function getBoxMiddle(bounds: Mat2x2 | CnMat2x2) {
  const [loc, dim] = bounds;
  const [ogX, ogY] = loc;
  const [width, height] = dim;

  const cX = resolveCn(ogX) + resolveCn(width) / 2;
  const cY = resolveCn(ogY) + resolveCn(height) / 2;

  return [cX, cY];
}

/**
 * Face angles is a tuple of 4 numbers, each representing the angle of a face in degrees.
 * following the convention of [north, east, south, west]
 */
export type FaceAngles = [number, number, number, number];

const toFaceIndex = (face: ComponentFace) => {
  switch (face) {
    case "north":
      return 0;
    case "east":
      return 1;
    case "south":
      return 2;
    case "west":
      return 3;
  }
};

export function pt(
  x: number,
  y: number,
  bounds: Mat2x2,
  face: ComponentFace,
  faceAngles: FaceAngles,
  scale: number
): [number, number];
export function pt(
  x: number,
  y: number,
  bounds: CnMat2x2,
  face: ComponentFace,
  faceAngles: FaceAngles,
  scale: number
): [number, number];
export function pt(
  x: number,
  y: number,
  bounds: CnMat2x2 | Mat2x2,
  face: ComponentFace,
  faceAngles: FaceAngles,
  scale: number
) {
  const [cX, cY] = getBoxMiddle(bounds);

  const [rotX, rotY] = rotatePoint(x, y, faceAngles[toFaceIndex(face)]);

  const newX = resolveCn(cX, scale) + rotX;
  const newY = resolveCn(cY, scale) + rotY;

  return [newX, newY];
}
