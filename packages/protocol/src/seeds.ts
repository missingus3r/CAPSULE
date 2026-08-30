import { fromBase64Url, getCrypto, toBase64Url } from "./bytes.js";

/**
 * Where a fresh install starts, and why that is dangerous.
 *
 * Every peer-to-peer network has a bootstrap problem and every one solves it
 * the same way: some fixed entry point ships with the software. The danger is
 * not that the entry point exists, it is what believing it buys an attacker.
 * Whoever answers at a seed address decides which relays a new install ever
 * hears about, so an impostor there does not have to forge anything — it just
 * has to be the only voice, and the client's whole view of the network is the
 * attacker's. Mix routing through relays one party controls protects nobody.
 *
 * So a seed is trusted for exactly one thing — being a door — and nothing else
 * it says is believed without proof:
 *
 * - **A pinned seed must prove it holds its key.** Not claim an identifier:
 *   `relayId` and `publicKey` are both public, so copying them costs an
 *   attacker nothing. It signs a challenge the client just generated.
 * - **`relayId` is derived, never taken on trust.** It is the digest of the
 *   public key, so a relay cannot claim an identity that does not match the
 *   key it presented.
 * - **A seed can hide relays; it cannot invent them.** That is the property
 *   that makes shipping a default acceptable at all, and it comes from the
 *   directory, not from here.
 *
 * The last resort is still the person: a seed is a starting point, and anyone
 * can point their client somewhere else.
 */

/** Domain separator for the proof a pinned relay gives. Never reuse it. */
export const RELAY_CHALLENGE_CONTEXT = "CAPSULE/relay-challenge/v1";
export const RELAY_CHALLENGE_BYTES = 32;

export interface RelaySeedRef {
  url: string;
  /** Digest of the relay's public key. Present makes the seed verifiable. */
  relayId?: string;
}

/**
 * The relays a fresh install starts from.
 *
 * Empty on purpose. A default seed is somebody's decision to operate a piece
 * of infrastructure that every new install will believe first, and an
 * unpinned one is worse than none: it hands whoever controls that name or that
 * host the opening view of the network for everybody. Fill this in with
 * `url#relayId` entries — the id comes from `GET /v1/info` — and prefer more
 * than one, run by more than one person.
 */
export const DEFAULT_SEEDS: readonly string[] = [
  // The genesis relay. The hostname is the address it runs at, spelled the way
  // a certificate authority can issue for: Let's Encrypt does not sign bare
  // IPs through the ordinary flow, and `<ip>.sslip.io` resolves to exactly
  // that IP. Pinned, so seizing the name, the certificate or the host is not
  // enough to stand in for it — only the key can answer the challenge.
  "https://68.211.136.69.sslip.io#W0rKZRPcxcCWT4So5LorArlH4O3slgXiUxs4EWx4n2M",
];

/** The seed origins, with no fragment. Use for anything that builds a URL. */
export function defaultSeedOrigins(): string[] {
  return parseSeedRefs(DEFAULT_SEEDS).map((seed) => seed.url);
}

/**
 * `https://relay.example#<relayId>`, or a bare origin.
 *
 * A bare origin is accepted and is the weaker form: without an id there is
 * nothing to prove, so the client falls back to believing whatever answers.
 * That is fine for a relay somebody typed in and wrong for one that ships with
 * the software, which is why {@link DEFAULT_SEEDS} should never hold one.
 */
export function parseSeedRef(value: string): RelaySeedRef | undefined {
  const [rawUrl, relayId, ...rest] = value.trim().split("#");
  if (!rawUrl || rest.length > 0) return undefined;
  let origin: string;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    if (url.username || url.password || url.search || url.hash)
      return undefined;
    origin = url.origin;
  } catch {
    return undefined;
  }
  if (relayId === undefined || relayId === "") return { url: origin };
  if (!/^[A-Za-z0-9_-]{16,64}$/u.test(relayId)) return undefined;
  return { url: origin, relayId };
}

export function formatSeedRef(seed: RelaySeedRef): string {
  return seed.relayId ? `${seed.url}#${seed.relayId}` : seed.url;
}

/** Parses a list, dropping what does not parse rather than failing the lot. */
export function parseSeedRefs(values: readonly string[]): RelaySeedRef[] {
  const seeds: RelaySeedRef[] = [];
  for (const value of values) {
    const seed = parseSeedRef(value);
    if (seed && !seeds.some((held) => held.url === seed.url)) seeds.push(seed);
  }
  return seeds;
}

/**
 * The identifier a public key must have.
 *
 * `relayId` is not a name a relay chooses, it is `sha256(publicKey)`. Deriving
 * it here rather than reading it means a relay presenting a key it does not
 * own is caught by arithmetic instead of by trust.
 */
export async function relayIdForPublicKey(
  publicKeyBase64Url: string,
): Promise<string> {
  const digest = await getCrypto().subtle.digest(
    "SHA-256",
    fromBase64Url(publicKeyBase64Url).slice() as unknown as BufferSource,
  );
  return toBase64Url(new Uint8Array(digest));
}

/** The exact bytes a relay signs to prove it holds the key it presented. */
export function relayChallengeMessage(
  relayId: string,
  challenge: string,
): Uint8Array {
  return new TextEncoder().encode(
    `${RELAY_CHALLENGE_CONTEXT}\n${relayId}\n${challenge}`,
  );
}

/** A fresh challenge. Never reused, so a recorded answer is worth nothing. */
export function newRelayChallenge(): string {
  const bytes = new Uint8Array(RELAY_CHALLENGE_BYTES);
  getCrypto().getRandomValues(bytes);
  return toBase64Url(bytes);
}

export interface RelayIdentityClaim {
  relayId: string;
  publicKey: string;
  /** Echoed back by the relay, and compared with what was sent. */
  challenge?: string;
  /** base64url Ed25519 signature over {@link relayChallengeMessage}. */
  challengeSignature?: string;
}

export type RelayProofFailure =
  | "identifier-does-not-match-key"
  | "no-proof-offered"
  | "challenge-mismatch"
  | "bad-signature"
  | "unsupported-runtime";

/**
 * Whether a relay really is the one that was pinned.
 *
 * Two separate questions, and both have to be yes. Does the identifier follow
 * from the key it presented — arithmetic, not trust. And does it hold the
 * private half — which needs a signature over a challenge this client chose a
 * moment ago, because the public half is public and copying it is free.
 *
 * Returns the failure rather than throwing: a caller trying several relays
 * wants to skip one and say why, not stop.
 */
export async function verifyRelayIdentity(
  claim: RelayIdentityClaim,
  expected: { relayId: string; challenge: string },
): Promise<RelayProofFailure | undefined> {
  if ((await relayIdForPublicKey(claim.publicKey)) !== claim.relayId) {
    return "identifier-does-not-match-key";
  }
  if (claim.relayId !== expected.relayId) {
    return "identifier-does-not-match-key";
  }
  if (!claim.challengeSignature) return "no-proof-offered";
  if (claim.challenge !== expected.challenge) return "challenge-mismatch";

  try {
    const key = await getCrypto().subtle.importKey(
      "raw",
      fromBase64Url(claim.publicKey).slice() as unknown as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    const ok = await getCrypto().subtle.verify(
      { name: "Ed25519" },
      key,
      fromBase64Url(
        claim.challengeSignature,
      ).slice() as unknown as BufferSource,
      relayChallengeMessage(
        claim.relayId,
        expected.challenge,
      ).slice() as unknown as BufferSource,
    );
    return ok ? undefined : "bad-signature";
  } catch {
    // A runtime without Ed25519 cannot check this, and must not pretend it did.
    return "unsupported-runtime";
  }
}
