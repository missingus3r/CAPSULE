/**
 * Arithmetic over GF(2^8) with the AES polynomial (0x11d).
 *
 * Two CAPSULE features need a finite field: Reed-Solomon erasure coding, so a
 * capsule can be split across relays where no single relay holds enough to
 * reconstruct it, and Shamir secret sharing, so a recovery capability can be
 * split among people or devices. Both are classic, published constructions
 * used here as specified; nothing in this file is a new cryptographic idea.
 *
 * Secret sharing needs the field operations to be data independent, so the
 * tables are built once and every operation is a table lookup with no
 * branching on secret values.
 */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);

{
  let value = 1;
  for (let index = 0; index < 255; index += 1) {
    EXP[index] = value;
    LOG[value] = index;
    value <<= 1;
    if (value & 0x100) value ^= 0x11d;
  }
  for (let index = 255; index < 512; index += 1) {
    EXP[index] = EXP[index - 255] as number;
  }
}

export function gfAdd(left: number, right: number): number {
  return (left ^ right) & 0xff;
}

export function gfMultiply(left: number, right: number): number {
  if (left === 0 || right === 0) return 0;
  return EXP[(LOG[left] as number) + (LOG[right] as number)] as number;
}

export function gfDivide(left: number, right: number): number {
  if (right === 0) throw new Error("Division by zero in GF(256)");
  if (left === 0) return 0;
  return EXP[
    ((LOG[left] as number) - (LOG[right] as number) + 255) % 255
  ] as number;
}

export function gfInverse(value: number): number {
  if (value === 0) throw new Error("Zero has no inverse in GF(256)");
  return EXP[255 - (LOG[value] as number)] as number;
}

export function gfPower(base: number, exponent: number): number {
  if (exponent === 0) return 1;
  if (base === 0) return 0;
  return EXP[
    ((((LOG[base] as number) * exponent) % 255) + 255) % 255
  ] as number;
}

/** Evaluates a polynomial given lowest-degree-first coefficients. */
export function gfEvaluate(coefficients: Uint8Array, at: number): number {
  let result = 0;
  for (let index = coefficients.length - 1; index >= 0; index -= 1) {
    result = gfAdd(gfMultiply(result, at), coefficients[index] as number);
  }
  return result;
}

/**
 * Solves `matrix * x = vector` in place by Gaussian elimination.
 * Throws when the matrix is singular, which for our use means the caller
 * supplied duplicate or malformed shares.
 */
export function gfSolve(matrix: Uint8Array[], vector: Uint8Array): Uint8Array {
  const size = vector.length;
  const rows: Uint8Array[] = matrix.map((row) => Uint8Array.from(row));
  const result = Uint8Array.from(vector);

  for (let column = 0; column < size; column += 1) {
    let pivot = -1;
    for (let row = column; row < size; row += 1) {
      if ((rows[row] as Uint8Array)[column] !== 0) {
        pivot = row;
        break;
      }
    }
    if (pivot === -1) throw new Error("Singular matrix in GF(256)");
    if (pivot !== column) {
      const swapRow = rows[pivot] as Uint8Array;
      rows[pivot] = rows[column] as Uint8Array;
      rows[column] = swapRow;
      const swapValue = result[pivot] as number;
      result[pivot] = result[column] as number;
      result[column] = swapValue;
    }

    const pivotRow = rows[column] as Uint8Array;
    const inverse = gfInverse(pivotRow[column] as number);
    for (let index = column; index < size; index += 1) {
      pivotRow[index] = gfMultiply(pivotRow[index] as number, inverse);
    }
    result[column] = gfMultiply(result[column] as number, inverse);

    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = (rows[row] as Uint8Array)[column] as number;
      if (factor === 0) continue;
      const target = rows[row] as Uint8Array;
      for (let index = column; index < size; index += 1) {
        target[index] = gfAdd(
          target[index] as number,
          gfMultiply(factor, pivotRow[index] as number),
        );
      }
      result[row] = gfAdd(
        result[row] as number,
        gfMultiply(factor, result[column] as number),
      );
    }
  }

  return result;
}
