/**
 * Bridges: relays that the network does not know about.
 *
 * Everything else in CAPSULE assumes a censor who is not in the way. A censor
 * who *is* in the way has an easy job today, and it is worth being precise
 * about why: the relay directory is public on purpose, so blocking CAPSULE is
 * a matter of asking one relay for `/v1/peers` and walking the graph. Design
 * for discovery and design against enumeration are the same design, pointed in
 * opposite directions.
 *
 * A bridge is the other direction. It never announces itself, never appears in
 * anyone's peer list, and cannot be recognised by connecting to it: without the
 * key, every path on it answers like an ordinary, boring web server. The key
 * travels out of band, in a short line a person hands to another person.
 *
 * This is Tor's bridge design, and it inherits Tor's unsolved problem with it:
 * getting bridge lines to the people who need them, without handing the whole
 * list to the censor who also wants them. CAPSULE does not solve that either.
 * What it does is make a bridge worth having once you have one.
 *
 * Two things the key derives, and why they are separate:
 *
 * - a **path prefix**, so a scan for `/v1/info` finds nothing. This defeats
 *   the cheapest probe, the one that costs a censor a single HTTP request.
 * - an **authenticator on every request**, so a censor who guesses or observes
 *   the prefix still cannot make the bridge admit what it is. This is the one
 *   that matters, because prefixes leak: they appear in proxy logs, in browser
 *   history, in a screenshot.
 */

import { concatBytes, fromBase64Url, getCrypto, toBase64Url } from "./bytes.js";

const textEncoder = new TextEncoder();

export const BRIDGE_LINE_PREFIX = "capsule-bridge:";
export const BRIDGE_LINE_VERSION = 1 as const;
export const BRIDGE_KEY_BYTES = 32;
/** Characters of the secret path segment. 16 base32 chars is 80 bits. */
export const BRIDGE_PATH_LENGTH = 16;
/** How far a request's timestamp may be from the bridge's clock. */
export const BRIDGE_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const BRIDGE_NONCE_BYTES = 16;

const PATH_LABEL = "capsule/bridge/v1/path";
const AUTH_LABEL = "capsule/bridge/v1/auth";
const AUTH_CONTEXT = "CAPSULE/bridge-auth/v1";
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

export interface BridgeDescriptor {
  version: typeof BRIDGE_LINE_VERSION;
  host: string;
  port: number;
  tls: boolean;
  /** Raw 32 bytes. Whoever holds this can use the bridge. */
  key: Uint8Array;
}

/** The origin a client actually connects to. */
export function bridgeOrigin(bridge: BridgeDescriptor): string {
  const host = bridge.host.includes(":") ? `[${bridge.host}]` : bridge.host;
  return `${bridge.tls ? "https" : "http"}://${host}:${bridge.port}`;
}

/**
 * `capsule-bridge:1:<host>:<port>:<tls>:<key>`, with the host base64url-encoded
 * so an IPv6 address does not collide with the separator. One token, no
 * spaces: a bridge line gets pasted into chat apps that would otherwise break
 * it across lines.
 */
export function encodeBridgeLine(bridge: BridgeDescriptor): string {
  if (bridge.key.byteLength !== BRIDGE_KEY_BYTES) {
    throw new Error("A bridge key is 32 bytes");
  }
  if (
    !Number.isSafeInteger(bridge.port) ||
    bridge.port < 1 ||
    bridge.port > 65_535
  ) {
    throw new Error("A bridge port must be between 1 and 65535");
  }
  if (bridge.host.trim() === "") throw new Error("A bridge needs a host");
  return [
    `${BRIDGE_LINE_PREFIX}${BRIDGE_LINE_VERSION}`,
    toBase64Url(textEncoder.encode(bridge.host.trim().toLowerCase())),
    String(bridge.port),
    bridge.tls ? "1" : "0",
    toBase64Url(bridge.key),
  ].join(":");
}

export function decodeBridgeLine(value: string): BridgeDescriptor {
  const trimmed = value.trim();
  if (!trimmed.startsWith(BRIDGE_LINE_PREFIX)) {
    throw new Error("Not a CAPSULE bridge line");
  }
  const parts = trimmed.split(":");
  if (parts.length !== 6) throw new Error("Malformed bridge line");
  const [, version, encodedHost, port, tls, encodedKey] = parts as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (version !== String(BRIDGE_LINE_VERSION)) {
    throw new Error(`Unsupported bridge line version ${version}`);
  }

  const host = new TextDecoder().decode(fromBase64Url(encodedHost));
  const parsedPort = Number(port);
  if (
    !Number.isSafeInteger(parsedPort) ||
    parsedPort < 1 ||
    parsedPort > 65_535
  ) {
    throw new Error("Malformed bridge line: port");
  }
  if (tls !== "0" && tls !== "1") throw new Error("Malformed bridge line: tls");
  const key = fromBase64Url(encodedKey);
  if (key.byteLength !== BRIDGE_KEY_BYTES) {
    throw new Error("Malformed bridge line: key");
  }
  if (host.trim() === "" || /[\s/\\]/u.test(host)) {
    throw new Error("Malformed bridge line: host");
  }
  return {
    version: BRIDGE_LINE_VERSION,
    host,
    port: parsedPort,
    tls: tls === "1",
    key,
  };
}

async function hkdf(
  key: Uint8Array,
  label: string,
  byteLength: number,
): Promise<Uint8Array> {
  const material = await getCrypto().subtle.importKey(
    "raw",
    key.slice() as unknown as BufferSource,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const bits = await getCrypto().subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0) as unknown as BufferSource,
      info: textEncoder.encode(label) as unknown as BufferSource,
    },
    material,
    byteLength * 8,
  );
  return new Uint8Array(bits);
}

export interface BridgeSecrets {
  /** The single URL segment every real request goes under. */
  pathPrefix: string;
  /** Key for the per-request authenticator. */
  authKey: Uint8Array;
}

export async function deriveBridgeSecrets(
  key: Uint8Array,
): Promise<BridgeSecrets> {
  if (key.byteLength !== BRIDGE_KEY_BYTES) {
    throw new Error("A bridge key is 32 bytes");
  }
  const pathBytes = await hkdf(key, PATH_LABEL, 10);
  let pathPrefix = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of pathBytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5 && pathPrefix.length < BRIDGE_PATH_LENGTH) {
      bits -= 5;
      pathPrefix += BASE32[(buffer >>> bits) & 31];
    }
  }
  return { pathPrefix, authKey: await hkdf(key, AUTH_LABEL, 32) };
}

function statement(
  method: string,
  path: string,
  timestamp: number,
  nonce: Uint8Array,
): Uint8Array {
  return concatBytes([
    textEncoder.encode(
      `${AUTH_CONTEXT}\n${method.toUpperCase()}\n${path}\n${timestamp}\n`,
    ),
    nonce,
  ]);
}

async function mac(
  authKey: Uint8Array,
  payload: Uint8Array,
): Promise<Uint8Array> {
  const key = await getCrypto().subtle.importKey(
    "raw",
    authKey.slice() as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await getCrypto().subtle.sign(
      "HMAC",
      key,
      payload as unknown as BufferSource,
    ),
  );
}

/**
 * The authenticator travels as a **session cookie**, for two reasons.
 *
 * The first is camouflage. A custom header would be a single string a censor
 * could write one DPI rule for, matching every CAPSULE bridge in the world. An
 * opaque session cookie is the most ordinary thing on the web, and the name is
 * derived from the bridge's own key, so no two bridges even look alike.
 *
 * The second is that `Authorization` is already taken. A capsule's read, write
 * and delete tokens are bearer tokens in that header, and the bridge is a layer
 * underneath them that must not disturb what it carries.
 */
const COOKIE_NAMES = [
  "sid",
  "sessid",
  "session",
  "PHPSESSID",
  "JSESSIONID",
  "connect.sid",
  "_session",
  "SSID",
];

export function bridgeCookieName(secrets: BridgeSecrets): string {
  const index = (secrets.authKey[0] as number) % COOKIE_NAMES.length;
  return COOKIE_NAMES[index] as string;
}

/** `uint32be(seconds) ‖ nonce(16) ‖ mac(32)`, base64url: an opaque session id. */
export async function bridgeCookie(
  secrets: BridgeSecrets,
  method: string,
  path: string,
  now = Date.now(),
): Promise<{ name: string; value: string; header: string }> {
  const timestamp = Math.floor(now / 1000);
  const nonce = new Uint8Array(BRIDGE_NONCE_BYTES);
  getCrypto().getRandomValues(nonce);
  const signature = await mac(
    secrets.authKey,
    statement(method, path, timestamp, nonce),
  );

  const packed = new Uint8Array(4 + BRIDGE_NONCE_BYTES + 32);
  new DataView(packed.buffer).setUint32(0, timestamp, false);
  packed.set(nonce, 4);
  packed.set(signature, 4 + BRIDGE_NONCE_BYTES);

  const name = bridgeCookieName(secrets);
  const value = toBase64Url(packed);
  return { name, value, header: `${name}=${value}` };
}

export interface BridgeAuthCheck {
  ok: boolean;
  /** Present when the token authenticated; the bridge remembers it. */
  nonce?: string;
}

/**
 * Verifies the cookie on a request whose prefix already matched.
 *
 * Every failure returns the same thing on purpose: a bridge that answered
 * "bad signature" differently from "no such path" would be telling a prober
 * exactly what it is.
 */
export async function verifyBridgeCookie(
  secrets: BridgeSecrets,
  cookieHeader: string | undefined,
  method: string,
  path: string,
  now = Date.now(),
): Promise<BridgeAuthCheck> {
  if (!cookieHeader) return { ok: false };
  const wanted = bridgeCookieName(secrets);

  let raw: string | undefined;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== wanted) continue;
    raw = part.slice(separator + 1).trim();
    break;
  }
  if (!raw) return { ok: false };

  let packed: Uint8Array;
  try {
    packed = fromBase64Url(raw);
  } catch {
    return { ok: false };
  }
  if (packed.byteLength !== 4 + BRIDGE_NONCE_BYTES + 32) return { ok: false };

  const timestamp = new DataView(
    packed.buffer,
    packed.byteOffset,
    packed.byteLength,
  ).getUint32(0, false);
  if (Math.abs(now - timestamp * 1000) > BRIDGE_CLOCK_SKEW_MS) {
    return { ok: false };
  }

  const nonce = packed.slice(4, 4 + BRIDGE_NONCE_BYTES);
  const provided = packed.slice(4 + BRIDGE_NONCE_BYTES);
  const expected = await mac(
    secrets.authKey,
    statement(method, path, timestamp, nonce),
  );

  let difference = 0;
  for (let index = 0; index < expected.byteLength; index += 1) {
    difference |= (expected[index] as number) ^ (provided[index] as number);
  }
  if (difference !== 0) return { ok: false };
  return { ok: true, nonce: toBase64Url(nonce) };
}

export function randomBridgeKey(): Uint8Array {
  const key = new Uint8Array(BRIDGE_KEY_BYTES);
  getCrypto().getRandomValues(key);
  return key;
}
