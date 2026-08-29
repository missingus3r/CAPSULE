import {
  CAPSULE_PROTOCOL_VERSION,
  DEFAULT_CHUNK_SIZE,
  buildShareUrl,
  createCapsuleSecrets,
  decryptChunk,
  decryptMetadata,
  encryptChunk,
  encryptMetadata,
  fromBase64Url,
  toBase64Url,
  type CapsuleMetadata,
  type CapsuleOwnerCapability,
  type CapsuleSecrets,
  type CapsuleShareCapability,
} from "@capsule/protocol";

export type TransferPhase =
  | "creating"
  | "encrypting"
  | "uploading"
  | "finalizing"
  | "downloading"
  | "decrypting"
  | "complete";

export interface TransferProgress {
  phase: TransferPhase;
  completedBytes: number;
  totalBytes: number;
  completedChunks: number;
  totalChunks: number;
}

export interface UploadCapsuleOptions {
  data: Blob;
  filename: string;
  mimeType?: string;
  note?: string;
  ttlSeconds: number;
  relayUrl: string;
  appUrl: string;
  chunkSize?: number;
  signal?: AbortSignal;
  onProgress?: (progress: TransferProgress) => void;
}

export interface UploadedCapsule {
  shareUrl: string;
  capability: CapsuleShareCapability;
  ownerCapability: CapsuleOwnerCapability;
  metadata: CapsuleMetadata;
}

export interface DownloadCapsuleOptions {
  capability: CapsuleShareCapability;
  signal?: AbortSignal;
  onProgress?: (progress: TransferProgress) => void;
}

export interface DownloadedCapsule {
  metadata: CapsuleMetadata;
  blob: Blob;
}

export interface RelayCreateRequest {
  encryptedManifest: string;
  chunkCount: number;
  totalCiphertextBytes: number;
  expiresInSeconds: number;
}

export interface RelayCreateResponse {
  capsuleId: string;
  readToken: string;
  writeToken: string;
  deleteToken: string;
  expiresAt: string;
}

export interface RelayStatus {
  capsuleId: string;
  state: "uploading" | "ready";
  chunkCount: number;
  uploadedChunks: number;
  totalCiphertextBytes: number;
  uploadedCiphertextBytes: number;
  expiresAt: string;
}

export interface RelayPublicConfig {
  version: typeof CAPSULE_PROTOCOL_VERSION;
  maxCapsuleBytes: number;
  maxChunkBytes: number;
  maxManifestBytes: number;
  maxChunkCount: number;
  defaultTtlSeconds: number;
  maxTtlSeconds: number;
}

export class CapsuleRelayError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code = "relay_error") {
    super(message);
    this.name = "CapsuleRelayError";
    this.status = status;
    this.code = code;
  }
}

function normalizeRelayUrl(relayUrl: string): string {
  const url = new URL(relayUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The relay URL must use HTTP or HTTPS");
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(
      "The relay URL must be an HTTP(S) origin without credentials, path, query or fragment",
    );
  }
  return url.origin;
}

function readPositiveSafeInteger(
  value: unknown,
  field: string,
  minimum = 1,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`Relay returned an invalid ${field}`);
  }
  return value as number;
}

function parseRelayPublicConfig(value: unknown): RelayPublicConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Relay returned an invalid public configuration");
  }
  const config = value as Record<string, unknown>;
  if (config.version !== CAPSULE_PROTOCOL_VERSION) {
    throw new Error(
      `Relay protocol version ${String(config.version)} is not supported`,
    );
  }
  const parsed: RelayPublicConfig = {
    version: CAPSULE_PROTOCOL_VERSION,
    maxCapsuleBytes: readPositiveSafeInteger(
      config.maxCapsuleBytes,
      "maxCapsuleBytes",
    ),
    maxChunkBytes: readPositiveSafeInteger(
      config.maxChunkBytes,
      "maxChunkBytes",
      17,
    ),
    maxManifestBytes: readPositiveSafeInteger(
      config.maxManifestBytes,
      "maxManifestBytes",
      17,
    ),
    maxChunkCount: readPositiveSafeInteger(
      config.maxChunkCount,
      "maxChunkCount",
    ),
    defaultTtlSeconds: readPositiveSafeInteger(
      config.defaultTtlSeconds,
      "defaultTtlSeconds",
    ),
    maxTtlSeconds: readPositiveSafeInteger(
      config.maxTtlSeconds,
      "maxTtlSeconds",
    ),
  };
  if (parsed.defaultTtlSeconds > parsed.maxTtlSeconds) {
    throw new Error("Relay returned an invalid TTL range");
  }
  return parsed;
}

async function errorFromResponse(
  response: Response,
): Promise<CapsuleRelayError> {
  let message = `Relay request failed with status ${response.status}`;
  let code = "relay_error";
  try {
    const body = (await response.json()) as {
      error?: string;
      message?: string;
      code?: string;
    };
    message = body.message ?? body.error ?? message;
    code = body.code ?? code;
  } catch {
    // A relay may intentionally return no body for an error.
  }
  return new CapsuleRelayError(message, response.status, code);
}

async function requireOk(response: Response): Promise<Response> {
  if (!response.ok) throw await errorFromResponse(response);
  return response;
}

function authorization(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` };
}

function requestSignal(
  signal: AbortSignal | undefined,
): { signal: AbortSignal } | Record<string, never> {
  return signal ? { signal } : {};
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function report(
  callback:
    UploadCapsuleOptions["onProgress"] | DownloadCapsuleOptions["onProgress"],
  progress: TransferProgress,
): void {
  callback?.(progress);
}

export class CapsuleRelayClient {
  readonly relayUrl: string;

  constructor(relayUrl: string) {
    this.relayUrl = normalizeRelayUrl(relayUrl);
  }

  async config(signal?: AbortSignal): Promise<RelayPublicConfig> {
    const response = await requireOk(
      await fetch(`${this.relayUrl}/v1/config`, {
        ...requestSignal(signal),
      }),
    );
    return parseRelayPublicConfig(await response.json());
  }

  async create(
    request: RelayCreateRequest,
    signal?: AbortSignal,
  ): Promise<RelayCreateResponse> {
    const response = await requireOk(
      await fetch(`${this.relayUrl}/v1/capsules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        ...requestSignal(signal),
      }),
    );
    return (await response.json()) as RelayCreateResponse;
  }

  async uploadChunk(
    capsuleId: string,
    index: number,
    ciphertext: Uint8Array,
    writeToken: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await requireOk(
      await fetch(
        `${this.relayUrl}/v1/capsules/${encodeURIComponent(capsuleId)}/chunks/${index}`,
        {
          method: "PUT",
          headers: {
            ...authorization(writeToken),
            "Content-Type": "application/octet-stream",
          },
          body: asArrayBuffer(ciphertext),
          ...requestSignal(signal),
        },
      ),
    );
  }

  async finalize(
    capsuleId: string,
    writeToken: string,
    signal?: AbortSignal,
  ): Promise<RelayStatus> {
    const response = await requireOk(
      await fetch(
        `${this.relayUrl}/v1/capsules/${encodeURIComponent(capsuleId)}/finalize`,
        {
          method: "POST",
          headers: authorization(writeToken),
          ...requestSignal(signal),
        },
      ),
    );
    return (await response.json()) as RelayStatus;
  }

  async status(
    capsuleId: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<RelayStatus> {
    const response = await requireOk(
      await fetch(
        `${this.relayUrl}/v1/capsules/${encodeURIComponent(capsuleId)}/status`,
        {
          headers: authorization(token),
          ...requestSignal(signal),
        },
      ),
    );
    return (await response.json()) as RelayStatus;
  }

  async manifest(
    capsuleId: string,
    readToken: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const response = await requireOk(
      await fetch(
        `${this.relayUrl}/v1/capsules/${encodeURIComponent(capsuleId)}/manifest`,
        {
          headers: authorization(readToken),
          ...requestSignal(signal),
        },
      ),
    );
    return new Uint8Array(await response.arrayBuffer());
  }

  async chunk(
    capsuleId: string,
    index: number,
    readToken: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const response = await requireOk(
      await fetch(
        `${this.relayUrl}/v1/capsules/${encodeURIComponent(capsuleId)}/chunks/${index}`,
        {
          headers: authorization(readToken),
          ...requestSignal(signal),
        },
      ),
    );
    return new Uint8Array(await response.arrayBuffer());
  }

  async delete(
    capsuleId: string,
    deleteToken: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await requireOk(
      await fetch(
        `${this.relayUrl}/v1/capsules/${encodeURIComponent(capsuleId)}`,
        {
          method: "DELETE",
          headers: authorization(deleteToken),
          ...requestSignal(signal),
        },
      ),
    );
  }
}

export async function uploadCapsule(
  options: UploadCapsuleOptions,
): Promise<UploadedCapsule> {
  if (!Number.isFinite(options.ttlSeconds) || options.ttlSeconds <= 0) {
    throw new Error("Capsule TTL must be greater than zero");
  }
  if (!options.filename.trim()) throw new Error("A filename is required");

  const relay = new CapsuleRelayClient(options.relayUrl);
  report(options.onProgress, {
    phase: "creating",
    completedBytes: 0,
    totalBytes: options.data.size,
    completedChunks: 0,
    totalChunks: 0,
  });
  const relayConfig = await relay.config(options.signal);
  if (options.ttlSeconds > relayConfig.maxTtlSeconds) {
    throw new Error(
      `Capsule TTL exceeds the relay limit of ${relayConfig.maxTtlSeconds} seconds`,
    );
  }

  const maximumPlaintextChunkBytes = relayConfig.maxChunkBytes - 16;
  const chunkSize =
    options.chunkSize ??
    Math.min(DEFAULT_CHUNK_SIZE, maximumPlaintextChunkBytes);
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0)
    throw new Error("Invalid chunk size");
  if (chunkSize > maximumPlaintextChunkBytes) {
    throw new Error(
      `Chunk size exceeds the relay limit of ${maximumPlaintextChunkBytes} plaintext bytes`,
    );
  }
  const chunkCount = Math.ceil(options.data.size / chunkSize);
  if (chunkCount > relayConfig.maxChunkCount) {
    throw new Error(
      `Capsule requires ${chunkCount} chunks, above the relay limit of ${relayConfig.maxChunkCount}`,
    );
  }
  const totalCiphertextBytes = options.data.size + chunkCount * 16;
  if (
    !Number.isSafeInteger(totalCiphertextBytes) ||
    totalCiphertextBytes > relayConfig.maxCapsuleBytes
  ) {
    throw new Error(
      `Capsule exceeds the relay limit of ${relayConfig.maxCapsuleBytes} encrypted bytes`,
    );
  }

  const secrets = createCapsuleSecrets();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + options.ttlSeconds * 1000);
  const metadata: CapsuleMetadata = {
    version: CAPSULE_PROTOCOL_VERSION,
    filename: options.filename,
    mimeType: options.mimeType?.trim() || "application/octet-stream",
    byteLength: options.data.size,
    chunkSize,
    chunkCount,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    ...(options.note?.trim() ? { note: options.note.trim() } : {}),
  };

  const encryptedManifest = await encryptMetadata(metadata, secrets);
  if (encryptedManifest.byteLength > relayConfig.maxManifestBytes) {
    throw new Error(
      `Encrypted metadata exceeds the relay limit of ${relayConfig.maxManifestBytes} bytes`,
    );
  }
  const created = await relay.create(
    {
      encryptedManifest: toBase64Url(encryptedManifest),
      chunkCount,
      totalCiphertextBytes,
      expiresInSeconds: options.ttlSeconds,
    },
    options.signal,
  );

  let completedBytes = 0;
  for (let index = 0; index < chunkCount; index += 1) {
    const start = index * chunkSize;
    const end = Math.min(start + chunkSize, options.data.size);
    report(options.onProgress, {
      phase: "encrypting",
      completedBytes,
      totalBytes: options.data.size,
      completedChunks: index,
      totalChunks: chunkCount,
    });
    const plaintext = new Uint8Array(
      await options.data.slice(start, end).arrayBuffer(),
    );
    const ciphertext = await encryptChunk(plaintext, index + 1, secrets);
    await relay.uploadChunk(
      created.capsuleId,
      index,
      ciphertext,
      created.writeToken,
      options.signal,
    );
    completedBytes += plaintext.byteLength;
    report(options.onProgress, {
      phase: "uploading",
      completedBytes,
      totalBytes: options.data.size,
      completedChunks: index + 1,
      totalChunks: chunkCount,
    });
  }

  report(options.onProgress, {
    phase: "finalizing",
    completedBytes,
    totalBytes: options.data.size,
    completedChunks: chunkCount,
    totalChunks: chunkCount,
  });
  await relay.finalize(created.capsuleId, created.writeToken, options.signal);

  const capability: CapsuleShareCapability = {
    version: CAPSULE_PROTOCOL_VERSION,
    relayUrl: relay.relayUrl,
    capsuleId: created.capsuleId,
    readToken: created.readToken,
    key: secrets.key,
    noncePrefix: secrets.noncePrefix,
  };
  const ownerCapability: CapsuleOwnerCapability = {
    capsuleId: created.capsuleId,
    deleteToken: created.deleteToken,
    relayUrl: relay.relayUrl,
  };
  const shareUrl = buildShareUrl(options.appUrl, capability);

  report(options.onProgress, {
    phase: "complete",
    completedBytes,
    totalBytes: options.data.size,
    completedChunks: chunkCount,
    totalChunks: chunkCount,
  });
  return { shareUrl, capability, ownerCapability, metadata };
}

export async function downloadCapsule(
  options: DownloadCapsuleOptions,
): Promise<DownloadedCapsule> {
  const relay = new CapsuleRelayClient(options.capability.relayUrl);
  const secrets: CapsuleSecrets = {
    key: options.capability.key,
    noncePrefix: options.capability.noncePrefix,
  };
  const status = await relay.status(
    options.capability.capsuleId,
    options.capability.readToken,
    options.signal,
  );
  if (status.state !== "ready") {
    throw new Error("Capsule is not ready for download");
  }
  const encryptedManifest = await relay.manifest(
    options.capability.capsuleId,
    options.capability.readToken,
    options.signal,
  );
  const metadata = await decryptMetadata(encryptedManifest, secrets);
  const expectedChunkCount = Math.ceil(
    metadata.byteLength / metadata.chunkSize,
  );
  const expectedCiphertextBytes =
    metadata.byteLength + metadata.chunkCount * 16;
  if (
    metadata.chunkCount !== expectedChunkCount ||
    metadata.chunkCount !== status.chunkCount ||
    status.uploadedChunks !== status.chunkCount ||
    expectedCiphertextBytes !== status.totalCiphertextBytes ||
    status.uploadedCiphertextBytes !== status.totalCiphertextBytes
  ) {
    throw new Error(
      "Capsule metadata does not match the authenticated relay inventory",
    );
  }
  const parts: Uint8Array[] = [];
  let completedBytes = 0;

  for (let index = 0; index < metadata.chunkCount; index += 1) {
    report(options.onProgress, {
      phase: "downloading",
      completedBytes,
      totalBytes: metadata.byteLength,
      completedChunks: index,
      totalChunks: metadata.chunkCount,
    });
    const ciphertext = await relay.chunk(
      options.capability.capsuleId,
      index,
      options.capability.readToken,
      options.signal,
    );
    const plaintext = await decryptChunk(ciphertext, index + 1, secrets);
    const expectedPlaintextBytes = Math.min(
      metadata.chunkSize,
      metadata.byteLength - index * metadata.chunkSize,
    );
    if (
      ciphertext.byteLength !== expectedPlaintextBytes + 16 ||
      plaintext.byteLength !== expectedPlaintextBytes
    ) {
      throw new Error(
        `Capsule chunk ${index} has an invalid authenticated size`,
      );
    }
    parts.push(plaintext);
    completedBytes += plaintext.byteLength;
    report(options.onProgress, {
      phase: "decrypting",
      completedBytes,
      totalBytes: metadata.byteLength,
      completedChunks: index + 1,
      totalChunks: metadata.chunkCount,
    });
  }

  if (completedBytes !== metadata.byteLength) {
    throw new Error(
      "The capsule size does not match its authenticated metadata",
    );
  }
  report(options.onProgress, {
    phase: "complete",
    completedBytes,
    totalBytes: metadata.byteLength,
    completedChunks: metadata.chunkCount,
    totalChunks: metadata.chunkCount,
  });
  return {
    metadata,
    blob: new Blob(parts.map(asArrayBuffer), { type: metadata.mimeType }),
  };
}

export async function deleteCapsule(
  capability: CapsuleOwnerCapability,
  signal?: AbortSignal,
): Promise<void> {
  const relay = new CapsuleRelayClient(capability.relayUrl);
  await relay.delete(capability.capsuleId, capability.deleteToken, signal);
}

export function isEncodedManifestWithinLimit(
  encoded: string,
  maxBytes: number,
): boolean {
  return fromBase64Url(encoded).byteLength <= maxBytes;
}
