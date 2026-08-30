import { RELAY_API_VERSION } from "@capsule/protocol";
import type { FetchLike } from "./network.js";

export interface RelayCreateRequest {
  encryptedManifest: string;
  chunkCount: number;
  totalCiphertextBytes: number;
  /** `null` asks the relay for a capsule without expiry. */
  expiresInSeconds: number | null;
}

export interface RelayCreateResponse {
  capsuleId: string;
  readToken: string;
  writeToken: string;
  deleteToken: string;
  expiresAt: string | null;
}

export interface RelayStatus {
  capsuleId: string;
  state: "uploading" | "ready";
  chunkCount: number;
  uploadedChunks: number;
  totalCiphertextBytes: number;
  uploadedCiphertextBytes: number;
  expiresAt: string | null;
  receivedChunks?: number[];
}

export interface RelayPublicConfig {
  version: typeof RELAY_API_VERSION;
  maxCapsuleBytes: number;
  maxChunkBytes: number;
  maxManifestBytes: number;
  maxChunkCount: number;
  defaultTtlSeconds: number;
  maxTtlSeconds: number;
  /** True when the relay accepts capsules without expiry. */
  persistentCapsules: boolean;
}

/**
 * What a transfer needs from a relay, whatever carries the bytes.
 *
 * `CapsuleRelayClient` is the direct implementation: an HTTPS request to the
 * relay, which learns the client's address. The mix network implements the
 * same interface over a path of relays, so an upload does not need to know or
 * care which one it is using.
 */
export interface RelayTransport {
  readonly relayUrl: string;
  config(signal?: AbortSignal): Promise<RelayPublicConfig>;
  create(
    request: RelayCreateRequest,
    signal?: AbortSignal,
  ): Promise<RelayCreateResponse>;
  uploadChunk(
    capsuleId: string,
    index: number,
    ciphertext: Uint8Array,
    writeToken: string,
    signal?: AbortSignal,
  ): Promise<void>;
  finalize(
    capsuleId: string,
    writeToken: string,
    signal?: AbortSignal,
  ): Promise<RelayStatus>;
  status(
    capsuleId: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<RelayStatus>;
  manifest(
    capsuleId: string,
    readToken: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  chunk(
    capsuleId: string,
    index: number,
    readToken: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  delete(
    capsuleId: string,
    deleteToken: string,
    signal?: AbortSignal,
  ): Promise<void>;
}

/** Builds the transport used to reach one relay. */
export type RelayTransportFactory = (relayUrl: string) => RelayTransport;

export class CapsuleRelayError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code = "relay_error") {
    super(message);
    this.name = "CapsuleRelayError";
    this.status = status;
    this.code = code;
  }

  /** Whether trying the same request again could plausibly succeed. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export interface RetryPolicy {
  /** Attempts after the first one. Zero disables retrying. */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  attempts: 3,
  baseDelayMs: 400,
  maxDelayMs: 5_000,
};

export function normalizeRelayUrl(relayUrl: string): string {
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

export function parseRelayPublicConfig(value: unknown): RelayPublicConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Relay returned an invalid public configuration");
  }
  const config = value as Record<string, unknown>;
  if (config.version !== RELAY_API_VERSION) {
    throw new Error(
      `Relay API version ${String(config.version)} is not supported`,
    );
  }
  const parsed: RelayPublicConfig = {
    version: RELAY_API_VERSION,
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
    persistentCapsules: config.persistentCapsules === true,
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

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("The transfer was cancelled"));
      },
      { once: true },
    );
  });
}

export class CapsuleRelayClient implements RelayTransport {
  readonly relayUrl: string;
  private readonly request: FetchLike;
  private readonly retry: RetryPolicy;

  constructor(
    relayUrl: string,
    options: { fetchImpl?: FetchLike; retry?: Partial<RetryPolicy> } = {},
  ) {
    this.relayUrl = normalizeRelayUrl(relayUrl);
    if (!options.fetchImpl && typeof globalThis.fetch !== "function") {
      throw new Error("No fetch implementation is available");
    }
    // The browser's fetch refuses to run with anything but the global object as
    // its receiver, so it is wrapped instead of stored as a method.
    this.request =
      options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.retry = { ...DEFAULT_RETRY_POLICY, ...options.retry };
  }

  /**
   * Runs a relay request, retrying only what is worth retrying: a timeout, a
   * dropped connection, a rate limit or a server error. A rejected capability
   * or a malformed request is returned immediately — repeating it would only
   * add noise to the relay's logs.
   */
  private async send(
    path: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retry.attempts; attempt += 1) {
      if (attempt > 0) {
        const backoff = Math.min(
          this.retry.maxDelayMs,
          this.retry.baseDelayMs * 2 ** (attempt - 1),
        );
        // Jitter keeps a fleet of clients from retrying in lockstep.
        await delay(backoff / 2 + Math.random() * (backoff / 2), signal);
      }
      try {
        const response = await this.request(`${this.relayUrl}${path}`, {
          ...init,
          ...requestSignal(signal),
        });
        if (response.ok) return response;
        const error = await errorFromResponse(response);
        if (!error.retryable) throw error;
        lastError = error;
      } catch (error) {
        if (error instanceof CapsuleRelayError && !error.retryable) throw error;
        if (signal?.aborted) throw error;
        lastError = error;
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(`Relay request to ${this.relayUrl} failed`);
  }

  async config(signal?: AbortSignal): Promise<RelayPublicConfig> {
    const response = await this.send("/v1/config", {}, signal);
    return parseRelayPublicConfig(await response.json());
  }

  async create(
    request: RelayCreateRequest,
    signal?: AbortSignal,
  ): Promise<RelayCreateResponse> {
    const response = await this.send(
      "/v1/capsules",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      },
      signal,
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
    await this.send(
      `/v1/capsules/${encodeURIComponent(capsuleId)}/chunks/${index}`,
      {
        method: "PUT",
        headers: {
          ...authorization(writeToken),
          "Content-Type": "application/octet-stream",
        },
        body: asArrayBuffer(ciphertext),
      },
      signal,
    );
  }

  async finalize(
    capsuleId: string,
    writeToken: string,
    signal?: AbortSignal,
  ): Promise<RelayStatus> {
    const response = await this.send(
      `/v1/capsules/${encodeURIComponent(capsuleId)}/finalize`,
      { method: "POST", headers: authorization(writeToken) },
      signal,
    );
    return (await response.json()) as RelayStatus;
  }

  async status(
    capsuleId: string,
    token: string,
    signal?: AbortSignal,
  ): Promise<RelayStatus> {
    const response = await this.send(
      `/v1/capsules/${encodeURIComponent(capsuleId)}/status`,
      { headers: authorization(token) },
      signal,
    );
    return (await response.json()) as RelayStatus;
  }

  async manifest(
    capsuleId: string,
    readToken: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const response = await this.send(
      `/v1/capsules/${encodeURIComponent(capsuleId)}/manifest`,
      { headers: authorization(readToken) },
      signal,
    );
    return new Uint8Array(await response.arrayBuffer());
  }

  async chunk(
    capsuleId: string,
    index: number,
    readToken: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    const response = await this.send(
      `/v1/capsules/${encodeURIComponent(capsuleId)}/chunks/${index}`,
      { headers: authorization(readToken) },
      signal,
    );
    return new Uint8Array(await response.arrayBuffer());
  }

  async delete(
    capsuleId: string,
    deleteToken: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.send(
      `/v1/capsules/${encodeURIComponent(capsuleId)}`,
      { method: "DELETE", headers: authorization(deleteToken) },
      signal,
    );
  }
}
