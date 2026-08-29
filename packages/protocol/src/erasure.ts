import { gfAdd, gfDivide, gfInverse, gfMultiply } from "./gf256.js";

/**
 * Systematic Reed-Solomon erasure coding over GF(256).
 *
 * A capsule split with `k of n` gives every relay a shard that is useless on
 * its own: fewer than `k` relays cannot reconstruct a single byte of the
 * ciphertext, and any `k` of them can. Compared with storing a full copy on
 * every relay this costs `n/k` of the capsule instead of `n`, and it removes
 * the property that any single relay holds everything.
 *
 * The parity rows come from a Cauchy matrix, whose every square submatrix is
 * invertible. That is what makes "any k shards" true rather than "usually
 * any k shards", which is the failure mode of naive Vandermonde constructions.
 */

export const MAX_ERASURE_SHARDS = 16;
export const MIN_ERASURE_DATA_SHARDS = 2;

export interface ErasureLayout {
  /** Shards needed to reconstruct a block. */
  k: number;
  /** Shards produced in total. */
  n: number;
}

export function assertErasureLayout(layout: ErasureLayout): void {
  const { k, n } = layout;
  if (
    !Number.isSafeInteger(k) ||
    !Number.isSafeInteger(n) ||
    k < MIN_ERASURE_DATA_SHARDS ||
    n <= k ||
    n > MAX_ERASURE_SHARDS
  ) {
    throw new Error(
      `Invalid erasure layout: k must be at least ${MIN_ERASURE_DATA_SHARDS}, n greater than k and at most ${MAX_ERASURE_SHARDS}`,
    );
  }
}

/** Bytes each shard holds for a block of `blockLength` bytes. */
export function shardLengthFor(blockLength: number, k: number): number {
  if (!Number.isSafeInteger(blockLength) || blockLength < 0) {
    throw new Error("Invalid block length");
  }
  return Math.ceil(blockLength / k);
}

/**
 * Row `row` of the systematic generator matrix: the identity for data shards,
 * a Cauchy row for parity shards.
 */
function generatorRow(row: number, k: number): Uint8Array {
  const coefficients = new Uint8Array(k);
  if (row < k) {
    coefficients[row] = 1;
    return coefficients;
  }
  // Cauchy: C[i][j] = 1 / (x_i + y_j) with disjoint {x_i} and {y_j}.
  const x = row;
  for (let column = 0; column < k; column += 1) {
    coefficients[column] = gfInverse(gfAdd(x, column));
  }
  return coefficients;
}

/** Splits a block into `k` data shards and appends `n - k` parity shards. */
export function encodeShards(
  block: Uint8Array,
  layout: ErasureLayout,
): Uint8Array[] {
  assertErasureLayout(layout);
  const { k, n } = layout;
  const shardBytes = shardLengthFor(block.byteLength, k);

  const shards: Uint8Array[] = [];
  for (let index = 0; index < k; index += 1) {
    const shard = new Uint8Array(shardBytes);
    const start = Math.min(index * shardBytes, block.byteLength);
    const end = Math.min(start + shardBytes, block.byteLength);
    if (end > start) shard.set(block.subarray(start, end));
    shards.push(shard);
  }

  for (let row = k; row < n; row += 1) {
    const coefficients = generatorRow(row, k);
    const parity = new Uint8Array(shardBytes);
    for (let column = 0; column < k; column += 1) {
      const factor = coefficients[column] as number;
      if (factor === 0) continue;
      const source = shards[column] as Uint8Array;
      for (let offset = 0; offset < shardBytes; offset += 1) {
        parity[offset] = gfAdd(
          parity[offset] as number,
          gfMultiply(factor, source[offset] as number),
        );
      }
    }
    shards.push(parity);
  }

  return shards;
}

function invertMatrix(rows: Uint8Array[], size: number): Uint8Array[] {
  const left: Uint8Array[] = rows.map((row) => Uint8Array.from(row));
  const right: Uint8Array[] = [];
  for (let index = 0; index < size; index += 1) {
    const identity = new Uint8Array(size);
    identity[index] = 1;
    right.push(identity);
  }

  for (let column = 0; column < size; column += 1) {
    let pivot = -1;
    for (let row = column; row < size; row += 1) {
      if ((left[row] as Uint8Array)[column] !== 0) {
        pivot = row;
        break;
      }
    }
    if (pivot === -1) {
      throw new Error("The supplied shards do not form an invertible set");
    }
    if (pivot !== column) {
      const leftSwap = left[pivot] as Uint8Array;
      left[pivot] = left[column] as Uint8Array;
      left[column] = leftSwap;
      const rightSwap = right[pivot] as Uint8Array;
      right[pivot] = right[column] as Uint8Array;
      right[column] = rightSwap;
    }

    const pivotLeft = left[column] as Uint8Array;
    const pivotRight = right[column] as Uint8Array;
    const scale = pivotLeft[column] as number;
    for (let index = 0; index < size; index += 1) {
      pivotLeft[index] = gfDivide(pivotLeft[index] as number, scale);
      pivotRight[index] = gfDivide(pivotRight[index] as number, scale);
    }

    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = (left[row] as Uint8Array)[column] as number;
      if (factor === 0) continue;
      const targetLeft = left[row] as Uint8Array;
      const targetRight = right[row] as Uint8Array;
      for (let index = 0; index < size; index += 1) {
        targetLeft[index] = gfAdd(
          targetLeft[index] as number,
          gfMultiply(factor, pivotLeft[index] as number),
        );
        targetRight[index] = gfAdd(
          targetRight[index] as number,
          gfMultiply(factor, pivotRight[index] as number),
        );
      }
    }
  }

  return right;
}

/**
 * Rebuilds a block from any `k` shards. `shards[i]` is the shard produced for
 * index `i`, or `undefined` when that shard is unavailable.
 */
export function decodeShards(
  shards: ReadonlyArray<Uint8Array | undefined>,
  layout: ErasureLayout,
  blockLength: number,
): Uint8Array {
  assertErasureLayout(layout);
  const { k, n } = layout;
  if (shards.length !== n) {
    throw new Error("The shard list must have one entry per shard index");
  }

  const available: Array<{ index: number; shard: Uint8Array }> = [];
  let shardBytes = -1;
  for (let index = 0; index < n && available.length < k; index += 1) {
    const shard = shards[index];
    if (!shard) continue;
    if (shardBytes === -1) shardBytes = shard.byteLength;
    else if (shard.byteLength !== shardBytes) {
      throw new Error("Every shard must have the same length");
    }
    available.push({ index, shard });
  }
  if (available.length < k) {
    throw new Error(`Reconstruction needs ${k} shards`);
  }
  if (shardBytes !== shardLengthFor(blockLength, k)) {
    throw new Error("Shard length does not match the declared block length");
  }

  const matrix = available.map((entry) => generatorRow(entry.index, k));
  const inverse = invertMatrix(matrix, k);

  const block = new Uint8Array(k * shardBytes);
  for (let target = 0; target < k; target += 1) {
    const coefficients = inverse[target] as Uint8Array;
    const destination = block.subarray(
      target * shardBytes,
      (target + 1) * shardBytes,
    );
    for (let source = 0; source < k; source += 1) {
      const factor = coefficients[source] as number;
      if (factor === 0) continue;
      const shard = (available[source] as { shard: Uint8Array }).shard;
      for (let offset = 0; offset < shardBytes; offset += 1) {
        destination[offset] = gfAdd(
          destination[offset] as number,
          gfMultiply(factor, shard[offset] as number),
        );
      }
    }
  }

  return block.subarray(0, blockLength);
}

/** Every distinct set of `k` indices drawn from the available ones. */
export function shardCombinations(
  available: number[],
  k: number,
  limit = 32,
): number[][] {
  const combinations: number[][] = [];
  const current: number[] = [];

  const walk = (start: number): void => {
    if (combinations.length >= limit) return;
    if (current.length === k) {
      combinations.push([...current]);
      return;
    }
    for (let index = start; index < available.length; index += 1) {
      current.push(available[index] as number);
      walk(index + 1);
      current.pop();
      if (combinations.length >= limit) return;
    }
  };

  walk(0);
  return combinations;
}
