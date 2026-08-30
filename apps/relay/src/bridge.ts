import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BRIDGE_KEY_BYTES,
  BRIDGE_LINE_VERSION,
  deriveBridgeSecrets,
  encodeBridgeLine,
  fromBase64Url,
  randomBridgeKey,
  toBase64Url,
  verifyBridgeCookie,
  type BridgeSecrets,
} from "@capsule/protocol";

/**
 * A relay in bridge mode.
 *
 * The goal is narrow and worth stating exactly: **a censor who connects to
 * this address must not be able to tell it is CAPSULE.** Not "must find it
 * inconvenient" — must not be able to tell, using the probe that costs them
 * one HTTP request, which is the probe they actually run at scale.
 *
 * So a bridge has two faces. Behind the secret prefix, with a valid
 * authenticator, it is an ordinary relay. Everywhere else it is a static web
 * server with nothing interesting on it, and it answers that way to malformed
 * tokens, expired tokens, replayed tokens and wrong paths alike. There is no
 * error message that distinguishes them, because an error message is an
 * answer, and the whole point is to have nothing to say.
 *
 * What this does not do, and no amount of code here will: keep the bridge line
 * out of the censor's hands. If they get the line they get the bridge. That is
 * a distribution problem, and it is unsolved here as it is elsewhere.
 */

/** How long a used nonce is remembered. Matches the accepted clock skew. */
const NONCE_WINDOW_MS = 5 * 60 * 1000;
const MAX_REMEMBERED_NONCES = 20_000;

const DEFAULT_DECOY = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>It works</title></head>
<body><h1>It works!</h1><p>This is the default web page for this server.</p>
<p>The web server software is running but no content has been added, yet.</p>
</body></html>
`;

export interface BridgeOptions {
  key: Uint8Array;
  /** File served for everything that is not an authenticated request. */
  decoyFile?: string | undefined;
  now?: () => number;
}

export class RelayBridge {
  private readonly seen = new Map<string, number>();
  private readonly now: () => number;
  private decoy = DEFAULT_DECOY;
  private decoyType = "text/html; charset=utf-8";

  private constructor(
    readonly secrets: BridgeSecrets,
    private readonly options: BridgeOptions,
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  static async create(options: BridgeOptions): Promise<RelayBridge> {
    const bridge = new RelayBridge(
      await deriveBridgeSecrets(options.key),
      options,
    );
    if (options.decoyFile) {
      try {
        bridge.decoy = await readFile(options.decoyFile, "utf8");
      } catch (error) {
        throw new Error(
          `The bridge decoy file could not be read: ${String(error)}`,
        );
      }
    }
    return bridge;
  }

  /** The single URL segment real traffic travels under. */
  get pathPrefix(): string {
    return this.secrets.pathPrefix;
  }

  get decoyBody(): string {
    return this.decoy;
  }

  get decoyContentType(): string {
    return this.decoyType;
  }

  /**
   * Strips the secret prefix from a URL, or returns `undefined` when the
   * request was not addressed to the bridge at all.
   */
  unwrap(url: string): string | undefined {
    const marker = `/${this.secrets.pathPrefix}`;
    if (url === marker) return "/";
    if (!url.startsWith(`${marker}/`)) return undefined;
    return url.slice(marker.length);
  }

  /**
   * Checks the authenticator on a request whose prefix already matched.
   *
   * The nonce is remembered so the identical request cannot be replayed inside
   * the clock-skew window. Without this a censor could record one request off
   * the wire and send it again to confirm what the server is.
   */
  async authorize(
    method: string,
    innerPath: string,
    cookieHeader: string | undefined,
  ): Promise<boolean> {
    const now = this.now();
    const check = await verifyBridgeCookie(
      this.secrets,
      cookieHeader,
      method,
      innerPath,
      now,
    );
    if (!check.ok || !check.nonce) return false;

    this.forget(now);
    if (this.seen.has(check.nonce)) return false;
    if (this.seen.size >= MAX_REMEMBERED_NONCES) return false;
    this.seen.set(check.nonce, now);
    return true;
  }

  private forget(now: number): void {
    if (this.seen.size === 0) return;
    for (const [nonce, at] of this.seen) {
      if (now - at > NONCE_WINDOW_MS) this.seen.delete(nonce);
    }
  }

  /** Bytes remembered for replay protection, for the operator's own logs. */
  get pendingNonces(): number {
    return this.seen.size;
  }

  /**
   * The line an operator hands to one person at a time.
   *
   * How it travels is the whole unsolved part. Publishing it anywhere a censor
   * can read defeats the point; the value of a bridge is exactly the value of
   * the channel it was shared over.
   */
  line(host: string, port: number, tls: boolean): string {
    return encodeBridgeLine({
      version: BRIDGE_LINE_VERSION,
      host,
      port,
      tls,
      key: this.options.key,
    });
  }
}

/**
 * The bridge key, from the environment or from disk, generated once if neither
 * has one. It is written with the same permissions as the relay identity: it
 * is the whole secret, and anyone holding it can use the bridge.
 */
export async function loadBridgeKey(
  storageDir: string,
  configured?: string | undefined,
): Promise<string> {
  if (configured) {
    if (fromBase64Url(configured).byteLength !== BRIDGE_KEY_BYTES) {
      throw new Error("CAPSULE_BRIDGE_KEY must be 32 base64url-encoded bytes");
    }
    return configured;
  }

  const file = join(storageDir, "bridge-key");
  try {
    const existing = (await readFile(file, "utf8")).trim();
    if (existing && fromBase64Url(existing).byteLength === BRIDGE_KEY_BYTES) {
      return existing;
    }
  } catch {
    // No key yet, which is the ordinary case on a first start.
  }

  const key = toBase64Url(randomBridgeKey());
  await writeFile(file, `${key}\n`, { mode: 0o600 });
  return key;
}
