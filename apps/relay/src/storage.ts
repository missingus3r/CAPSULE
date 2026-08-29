import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants as fileConstants } from "node:fs";
import {
  access,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { RelayConfig } from "./config.js";
import {
  RelayHttpError,
  badRequest,
  conflict,
  notFound,
  payloadTooLarge,
  storageCorrupt,
} from "./errors.js";

const CAPSULE_ID_PATTERN = /^[A-Za-z0-9_-]{24,64}$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/u;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const CHUNK_FILE_PATTERN = /^(0|[1-9][0-9]*)\.bin$/u;
const MIN_CHUNK_BYTES = 16;

export interface CreateCapsuleInput {
  encryptedManifest: string;
  chunkCount: number;
  totalCiphertextBytes: number;
  expiresInSeconds: number;
}

export interface CreateCapsuleOutput {
  capsuleId: string;
  readToken: string;
  writeToken: string;
  deleteToken: string;
  expiresAt: string;
}

export interface StoredCapsuleRecord {
  schemaVersion: 1;
  capsuleId: string;
  encryptedManifest: string;
  manifestCiphertextBytes: number;
  chunkCount: number;
  totalCiphertextBytes: number;
  createdAt: string;
  expiresAt: string;
  tokenHashes: {
    read: string;
    write: string;
    delete: string;
  };
}

export interface CapsuleStatus {
  capsuleId: string;
  state: "uploading" | "ready";
  chunkCount: number;
  uploadedChunks: number;
  totalCiphertextBytes: number;
  uploadedCiphertextBytes: number;
  expiresAt: string;
  finalized: boolean;
  receivedChunks: number[];
}

interface ChunkInventory {
  indices: number[];
  totalBytes: number;
}

type Capability = "read" | "write" | "delete";

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}

function randomBase64Url(byteLength: number): string {
  return randomBytes(byteLength).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function canonicalBase64UrlBytes(value: string): Buffer {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) {
    throw badRequest(
      "invalid_manifest",
      "encryptedManifest must be canonical base64url",
    );
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length === 0 || bytes.toString("base64url") !== value) {
    throw badRequest(
      "invalid_manifest",
      "encryptedManifest must be canonical base64url",
    );
  }
  return bytes;
}

function assertCapsuleId(capsuleId: string): void {
  if (!CAPSULE_ID_PATTERN.test(capsuleId)) {
    throw notFound();
  }
}

function assertStoredRecord(
  value: unknown,
): asserts value is StoredCapsuleRecord {
  if (!value || typeof value !== "object") throw storageCorrupt();
  const candidate = value as Partial<StoredCapsuleRecord>;
  const hashes = candidate.tokenHashes;
  if (
    candidate.schemaVersion !== 1 ||
    typeof candidate.capsuleId !== "string" ||
    !CAPSULE_ID_PATTERN.test(candidate.capsuleId) ||
    typeof candidate.encryptedManifest !== "string" ||
    !BASE64URL_PATTERN.test(candidate.encryptedManifest) ||
    !Number.isSafeInteger(candidate.manifestCiphertextBytes) ||
    (candidate.manifestCiphertextBytes ?? 0) <= 0 ||
    !Number.isSafeInteger(candidate.chunkCount) ||
    (candidate.chunkCount ?? -1) < 0 ||
    !Number.isSafeInteger(candidate.totalCiphertextBytes) ||
    (candidate.totalCiphertextBytes ?? -1) < 0 ||
    typeof candidate.createdAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.createdAt)) ||
    typeof candidate.expiresAt !== "string" ||
    !Number.isFinite(Date.parse(candidate.expiresAt)) ||
    !hashes ||
    typeof hashes.read !== "string" ||
    !HASH_PATTERN.test(hashes.read) ||
    typeof hashes.write !== "string" ||
    !HASH_PATTERN.test(hashes.write) ||
    typeof hashes.delete !== "string" ||
    !HASH_PATTERN.test(hashes.delete)
  ) {
    throw storageCorrupt();
  }
}

class KeyedMutex {
  private readonly queues = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.queues.set(key, queued);

    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.queues.get(key) === queued) this.queues.delete(key);
    }
  }
}

export class CapsuleStorage {
  readonly rootDirectory: string;
  private readonly capsulesDirectory: string;
  private readonly mutex = new KeyedMutex();

  constructor(private readonly config: RelayConfig) {
    this.rootDirectory = config.storageDir;
    this.capsulesDirectory = join(this.rootDirectory, "capsules");
  }

  async initialize(): Promise<void> {
    await mkdir(this.capsulesDirectory, { recursive: true, mode: 0o700 });
    await this.removeCreationDirectories();
    await this.cleanupExpired();
  }

  async checkHealth(): Promise<void> {
    await access(
      this.capsulesDirectory,
      fileConstants.R_OK | fileConstants.W_OK,
    );
    const probe = join(this.capsulesDirectory, `.health-${randomBase64Url(8)}`);
    const handle = await open(probe, "wx", 0o600);
    await handle.close();
    await unlink(probe);
  }

  validateCreateInput(input: CreateCapsuleInput): void {
    const manifestBytes = canonicalBase64UrlBytes(input.encryptedManifest);
    if (manifestBytes.length > this.config.maxManifestBytes) {
      throw payloadTooLarge(
        `Encrypted manifest exceeds ${this.config.maxManifestBytes} bytes`,
      );
    }
    if (!Number.isSafeInteger(input.chunkCount) || input.chunkCount < 0) {
      throw badRequest(
        "invalid_chunk_count",
        "chunkCount must be a non-negative integer",
      );
    }
    if (input.chunkCount > this.config.maxChunkCount) {
      throw payloadTooLarge(`chunkCount exceeds ${this.config.maxChunkCount}`);
    }
    if (
      !Number.isSafeInteger(input.totalCiphertextBytes) ||
      input.totalCiphertextBytes < 0
    ) {
      throw badRequest(
        "invalid_total_ciphertext_bytes",
        "totalCiphertextBytes must be a non-negative integer",
      );
    }
    if (input.totalCiphertextBytes > this.config.maxCapsuleBytes) {
      throw payloadTooLarge(
        `Capsule exceeds ${this.config.maxCapsuleBytes} ciphertext bytes`,
      );
    }
    if ((input.chunkCount === 0) !== (input.totalCiphertextBytes === 0)) {
      throw badRequest(
        "invalid_capsule_shape",
        "chunkCount and totalCiphertextBytes must both be zero or both be positive",
      );
    }
    if (
      input.chunkCount > 0 &&
      (input.totalCiphertextBytes < input.chunkCount * MIN_CHUNK_BYTES ||
        input.totalCiphertextBytes >
          input.chunkCount * this.config.maxChunkBytes)
    ) {
      throw badRequest(
        "invalid_capsule_shape",
        "Declared ciphertext cannot fit within the requested chunk count",
      );
    }
    if (
      !Number.isSafeInteger(input.expiresInSeconds) ||
      input.expiresInSeconds <= 0 ||
      input.expiresInSeconds > this.config.maxTtlSeconds
    ) {
      throw badRequest(
        "invalid_expiry",
        `expiresInSeconds must be an integer between 1 and ${this.config.maxTtlSeconds}`,
      );
    }
  }

  async create(input: CreateCapsuleInput): Promise<CreateCapsuleOutput> {
    this.validateCreateInput(input);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const capsuleId = randomBase64Url(24);
      const readToken = randomBase64Url(32);
      const writeToken = randomBase64Url(32);
      const deleteToken = randomBase64Url(32);
      const createdAt = new Date();
      const expiresAt = new Date(
        createdAt.getTime() + input.expiresInSeconds * 1000,
      );
      const record: StoredCapsuleRecord = {
        schemaVersion: 1,
        capsuleId,
        encryptedManifest: input.encryptedManifest,
        manifestCiphertextBytes: Buffer.from(
          input.encryptedManifest,
          "base64url",
        ).length,
        chunkCount: input.chunkCount,
        totalCiphertextBytes: input.totalCiphertextBytes,
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        tokenHashes: {
          read: hashToken(readToken),
          write: hashToken(writeToken),
          delete: hashToken(deleteToken),
        },
      };

      const target = this.capsuleDirectory(capsuleId);
      const temporary = join(
        this.capsulesDirectory,
        `.create-${capsuleId}-${randomBase64Url(6)}`,
      );
      try {
        await mkdir(temporary, { mode: 0o700 });
        await mkdir(join(temporary, "chunks"), { mode: 0o700 });
        await writeFile(
          join(temporary, "record.json"),
          `${JSON.stringify(record)}\n`,
          {
            flag: "wx",
            mode: 0o600,
          },
        );
        await rename(temporary, target);
        return {
          capsuleId,
          readToken,
          writeToken,
          deleteToken,
          expiresAt: record.expiresAt,
        };
      } catch (error) {
        await rm(temporary, { recursive: true, force: true });
        if (isNodeError(error, "EEXIST") || isNodeError(error, "ENOTEMPTY"))
          continue;
        throw error;
      }
    }
    throw new Error("Unable to allocate a unique capsule identifier");
  }

  async readRecord(capsuleId: string): Promise<StoredCapsuleRecord> {
    assertCapsuleId(capsuleId);
    try {
      const parsed: unknown = JSON.parse(
        await readFile(
          join(this.capsuleDirectory(capsuleId), "record.json"),
          "utf8",
        ),
      );
      assertStoredRecord(parsed);
      if (parsed.capsuleId !== capsuleId) throw storageCorrupt();
      return parsed;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) throw notFound();
      if (error instanceof SyntaxError) throw storageCorrupt();
      throw error;
    }
  }

  authorize(
    record: StoredCapsuleRecord,
    token: string | undefined,
    capability: Capability,
  ): void {
    if (!token || !TOKEN_PATTERN.test(token)) throw notFound();
    const candidate = Buffer.from(hashToken(token), "hex");
    const expected = Buffer.from(record.tokenHashes[capability], "hex");
    if (
      candidate.length !== expected.length ||
      !timingSafeEqual(candidate, expected)
    ) {
      throw notFound();
    }
  }

  authorizeStatus(
    record: StoredCapsuleRecord,
    token: string | undefined,
  ): void {
    try {
      this.authorize(record, token, "read");
      return;
    } catch {
      this.authorize(record, token, "write");
    }
  }

  assertNotExpired(record: StoredCapsuleRecord): void {
    if (Date.parse(record.expiresAt) <= Date.now()) throw notFound();
  }

  async putChunk(
    capsuleId: string,
    index: number,
    ciphertext: Buffer,
    writeToken: string | undefined,
  ): Promise<"created" | "unchanged"> {
    return this.mutex.run(capsuleId, async () => {
      const record = await this.readRecord(capsuleId);
      this.authorize(record, writeToken, "write");
      this.assertNotExpired(record);
      if (await this.isFinalized(capsuleId)) {
        throw conflict(
          "capsule_finalized",
          "A finalized capsule cannot be modified",
        );
      }
      if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= record.chunkCount
      ) {
        throw badRequest(
          "invalid_chunk_index",
          "Chunk index is outside the capsule range",
        );
      }
      if (ciphertext.length < MIN_CHUNK_BYTES) {
        throw badRequest(
          "invalid_chunk_size",
          `Chunks must contain at least ${MIN_CHUNK_BYTES} ciphertext bytes`,
        );
      }
      if (ciphertext.length > this.config.maxChunkBytes) {
        throw payloadTooLarge(
          `Chunk exceeds ${this.config.maxChunkBytes} bytes`,
        );
      }

      const inventory = await this.chunkInventory(record);
      if (inventory.indices.includes(index)) {
        const existing = await readFile(this.chunkPath(capsuleId, index));
        if (existing.equals(ciphertext)) return "unchanged";
        throw conflict(
          "chunk_mismatch",
          `Chunk ${index} was already uploaded with different bytes`,
        );
      }
      if (
        inventory.totalBytes + ciphertext.length >
        record.totalCiphertextBytes
      ) {
        throw badRequest(
          "invalid_chunk_size",
          "Uploaded chunks exceed the declared totalCiphertextBytes",
        );
      }

      const remainingChunks = record.chunkCount - inventory.indices.length - 1;
      if (
        inventory.totalBytes +
          ciphertext.length +
          remainingChunks * MIN_CHUNK_BYTES >
        record.totalCiphertextBytes
      ) {
        throw badRequest(
          "invalid_chunk_size",
          "Chunk leaves too few bytes for the remaining declared chunks",
        );
      }

      const created = await this.atomicWriteExclusive(
        this.chunkPath(capsuleId, index),
        ciphertext,
      );
      if (created) return "created";

      // Another process sharing the same filesystem may have won the atomic link.
      const existing = await readFile(this.chunkPath(capsuleId, index));
      if (existing.equals(ciphertext)) return "unchanged";
      throw conflict(
        "chunk_mismatch",
        `Chunk ${index} was already uploaded with different bytes`,
      );
    });
  }

  async finalize(
    capsuleId: string,
    writeToken: string | undefined,
  ): Promise<CapsuleStatus> {
    return this.mutex.run(capsuleId, async () => {
      const record = await this.readRecord(capsuleId);
      this.authorize(record, writeToken, "write");
      this.assertNotExpired(record);
      if (await this.isFinalized(capsuleId)) {
        return this.status(record);
      }
      const inventory = await this.chunkInventory(record);
      if (
        inventory.indices.length !== record.chunkCount ||
        inventory.totalBytes !== record.totalCiphertextBytes
      ) {
        throw conflict(
          "capsule_incomplete",
          "All declared chunks and ciphertext bytes must be uploaded before finalization",
        );
      }

      await this.atomicWriteExclusive(
        join(this.capsuleDirectory(capsuleId), "finalized.json"),
        Buffer.from(
          `${JSON.stringify({ finalizedAt: new Date().toISOString() })}\n`,
        ),
      );
      return this.statusFromInventory(record, inventory, true);
    });
  }

  async status(record: StoredCapsuleRecord): Promise<CapsuleStatus> {
    const [inventory, finalized] = await Promise.all([
      this.chunkInventory(record),
      this.isFinalized(record.capsuleId),
    ]);
    return this.statusFromInventory(record, inventory, finalized);
  }

  async manifest(record: StoredCapsuleRecord): Promise<Buffer> {
    if (!(await this.isFinalized(record.capsuleId))) {
      throw conflict(
        "capsule_not_finalized",
        "Capsule is not ready for reading",
      );
    }
    return Buffer.from(record.encryptedManifest, "base64url");
  }

  async chunk(record: StoredCapsuleRecord, index: number): Promise<Buffer> {
    if (!(await this.isFinalized(record.capsuleId))) {
      throw conflict(
        "capsule_not_finalized",
        "Capsule is not ready for reading",
      );
    }
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= record.chunkCount
    ) {
      throw badRequest(
        "invalid_chunk_index",
        "Chunk index is outside the capsule range",
      );
    }
    try {
      return await readFile(this.chunkPath(record.capsuleId, index));
    } catch (error) {
      if (isNodeError(error, "ENOENT"))
        throw storageCorrupt("Finalized capsule is missing a chunk");
      throw error;
    }
  }

  async delete(
    capsuleId: string,
    deleteToken: string | undefined,
  ): Promise<void> {
    await this.mutex.run(capsuleId, async () => {
      let record: StoredCapsuleRecord;
      try {
        record = await this.readRecord(capsuleId);
      } catch (error) {
        // Deletion is intentionally idempotent: absence is indistinguishable
        // from a capsule that was already deleted or cleaned up after expiry.
        if (error instanceof RelayHttpError && error.statusCode === 404) return;
        throw error;
      }

      if (Date.parse(record.expiresAt) <= Date.now()) {
        await rm(this.capsuleDirectory(capsuleId), {
          recursive: true,
          force: true,
        });
        return;
      }
      try {
        this.authorize(record, deleteToken, "delete");
      } catch (error) {
        if (error instanceof RelayHttpError && error.statusCode === 404) return;
        throw error;
      }
      await rm(this.capsuleDirectory(capsuleId), {
        recursive: true,
        force: true,
      });
    });
  }

  async cleanupExpired(): Promise<{ removed: number; errors: number }> {
    let removed = 0;
    let errors = 0;
    let entries;
    try {
      entries = await readdir(this.capsulesDirectory, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return { removed, errors };
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || !CAPSULE_ID_PATTERN.test(entry.name))
        continue;
      try {
        await this.mutex.run(entry.name, async () => {
          const record = await this.readRecord(entry.name);
          if (Date.parse(record.expiresAt) <= Date.now()) {
            await rm(this.capsuleDirectory(entry.name), {
              recursive: true,
              force: true,
            });
            removed += 1;
          }
        });
      } catch {
        errors += 1;
      }
    }
    return { removed, errors };
  }

  private capsuleDirectory(capsuleId: string): string {
    return join(this.capsulesDirectory, capsuleId);
  }

  private chunkPath(capsuleId: string, index: number): string {
    return join(this.capsuleDirectory(capsuleId), "chunks", `${index}.bin`);
  }

  private async isFinalized(capsuleId: string): Promise<boolean> {
    try {
      const file = await stat(
        join(this.capsuleDirectory(capsuleId), "finalized.json"),
      );
      return file.isFile();
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    }
  }

  private async chunkInventory(
    record: StoredCapsuleRecord,
  ): Promise<ChunkInventory> {
    let entries;
    try {
      entries = await readdir(
        join(this.capsuleDirectory(record.capsuleId), "chunks"),
        {
          withFileTypes: true,
        },
      );
    } catch (error) {
      if (isNodeError(error, "ENOENT"))
        throw storageCorrupt("Capsule chunk directory is missing");
      throw error;
    }

    const chunks: Array<{ index: number; bytes: number }> = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const match = CHUNK_FILE_PATTERN.exec(entry.name);
      if (!entry.isFile() || !match?.[1])
        throw storageCorrupt("Invalid file in capsule chunk directory");
      const index = Number(match[1]);
      if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= record.chunkCount
      ) {
        throw storageCorrupt("Stored chunk index is outside the capsule range");
      }
      const details = await stat(
        join(this.capsuleDirectory(record.capsuleId), "chunks", entry.name),
      );
      if (
        details.size < MIN_CHUNK_BYTES ||
        details.size > this.config.maxChunkBytes
      ) {
        throw storageCorrupt("Stored chunk has an invalid size");
      }
      chunks.push({ index, bytes: details.size });
    }
    chunks.sort((left, right) => left.index - right.index);
    return {
      indices: chunks.map((chunk) => chunk.index),
      totalBytes: chunks.reduce((total, chunk) => total + chunk.bytes, 0),
    };
  }

  private statusFromInventory(
    record: StoredCapsuleRecord,
    inventory: ChunkInventory,
    finalized: boolean,
  ): CapsuleStatus {
    return {
      capsuleId: record.capsuleId,
      state: finalized ? "ready" : "uploading",
      chunkCount: record.chunkCount,
      uploadedChunks: inventory.indices.length,
      totalCiphertextBytes: record.totalCiphertextBytes,
      uploadedCiphertextBytes: inventory.totalBytes,
      expiresAt: record.expiresAt,
      finalized,
      receivedChunks: inventory.indices,
    };
  }

  private async atomicWriteExclusive(
    target: string,
    data: Buffer,
  ): Promise<boolean> {
    const temporary = join(
      dirname(target),
      `.${basename(target)}.tmp-${process.pid}-${randomBase64Url(8)}`,
    );
    try {
      await writeFile(temporary, data, { flag: "wx", mode: 0o600 });
      await link(temporary, target);
      return true;
    } catch (error) {
      if (isNodeError(error, "EEXIST")) return false;
      throw error;
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }

  private async removeCreationDirectories(): Promise<void> {
    const entries = await readdir(this.capsulesDirectory, {
      withFileTypes: true,
    });
    await Promise.all(
      entries
        .filter(
          (entry) => entry.isDirectory() && entry.name.startsWith(".create-"),
        )
        .map((entry) =>
          rm(join(this.capsulesDirectory, entry.name), {
            recursive: true,
            force: true,
          }),
        ),
    );
  }
}

export function parseBearerToken(
  authorization: string | undefined,
): string | undefined {
  if (!authorization) return undefined;
  const match = /^Bearer ([A-Za-z0-9_-]+)$/iu.exec(authorization.trim());
  return match?.[1];
}

export function parseChunkIndex(raw: string): number {
  if (!/^(0|[1-9][0-9]*)$/u.test(raw)) {
    throw badRequest(
      "invalid_chunk_index",
      "Chunk index must be a non-negative integer",
    );
  }
  const index = Number(raw);
  if (!Number.isSafeInteger(index)) {
    throw badRequest("invalid_chunk_index", "Chunk index is too large");
  }
  return index;
}
