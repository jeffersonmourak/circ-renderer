export type ComputableNumber = number | ((m: number, offset?: number) => number);

export const CN_ZERO = cn(0);

export type CnVector2 = [ComputableNumber, ComputableNumber];
export type Vector2 = [number, number];
export type Mat2x2 = [Vector2, Vector2];
export type CnMat2x2 = [CnVector2, CnVector2];

export function cn(n: number): ComputableNumber;
export function cn(f: (m: number) => number): ComputableNumber;
export function cn(n: number | ((m: number) => number)): ComputableNumber {
  return n;
}

export function resolveCn(n: ComputableNumber, m = 1, offset = 0): number {
  return typeof n === "number" ? (n + offset) * m : n(m);
}

export function parseCn(n: string): ComputableNumber {
  const parsed = Number(n);

  if (Number.isNaN(parsed)) {
    throw new Error(`Could not parse ${n} as a number`);
  }

  return cn(parsed);
}

export function toVector2(v: ComputableNumber[]): CnVector2 | undefined {
  if (v.length !== 2) {
    return;
  }

  return [v[0], v[1]];
}

export function add(
  a: ComputableNumber,
  b: ComputableNumber
): ComputableNumber {
  return (m) => resolveCn(a, m) + resolveCn(b, m);
}

export function subtract(
  a: ComputableNumber,
  b: ComputableNumber
): ComputableNumber {
  return (m) => resolveCn(a, m) - resolveCn(b, m);
}
