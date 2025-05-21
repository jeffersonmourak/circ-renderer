export function roundToNearest(value: number, step = 10) {
  return Math.round(value / step) * step;
}

export function rotationMatrix(angle: number) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);

  return [
    [cos, -sin, 0],
    [sin, cos, 0],
    [0, 0, 1],
  ];
}

export function translationMatrix(x: number, y: number) {
  return [
    [1, 0, x],
    [0, 1, y],
    [0, 0, 1],
  ];
}

export function as3x1Matrix([a, b]: [number, number]) {
  return [[a], [b], [1]];
}

export function matrixMultiply(a: number[][], b: number[][]) {
  const result: number[][] = [];
  for (let i = 0; i < a.length; i++) {
    result[i] = [];
    for (let j = 0; j < b[0].length; j++) {
      result[i][j] = 0;
      for (let k = 0; k < a[0].length; k++) {
        result[i][j] += a[i][k] * b[k][j];
      }
    }
  }
  return result;
}

export const fromCoordString = (coords?: string): [number, number] => {
  const location = (coords
    ?.slice(1, -1)
    .split(",")
    .map((n) => Number(n)) ?? [0, 0]) as [number, number];

  return location;
};

const to2x1matrix = (coords: number[][]): [number, number] => {
  return [coords[0][0], coords[1][0]];
};

export function toCoordString(coords: number[][]): string;
export function toCoordString(coords: [number, number]): string;
export function toCoordString(coords: [number, number] | number[][]): string {
  let lCoord = coords;
  if (Array.isArray(coords[0])) {
    lCoord = to2x1matrix(coords as number[][]);
  }
  return `(${lCoord[0]},${lCoord[1]})`;
}

export function triangleWave(p: number, t: number) {
  const hp = p / 2;
  const max = p / 2;
  const min = -p / 2;
  const r = max - min;
  const x = t % p;
  const tta = x - hp;
  const ab = Math.abs(tta);

  return max - (r / hp) * ab;
}

export function lerp(start: number, end: number, t: number) {
  return start * (1 - t) + end * t;
}
