import {
  createCipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { basePoint, derive, multiply, randomScalar } from "./group.js";
import { lionessDecrypt, lionessEncrypt } from "./lioness.js";

/**
 * The Sphinx packet format (Danezis and Goldberg, 2009), as used here.
 *
 * A packet is the same size at every hop, and a hop learns exactly two things:
 * who handed it the packet, and who to hand it to next. It cannot tell how far
 * along the path it is, how long the path is, where the packet came from, or
 * where it is ultimately going. Those are properties of the format, not of the
 * honesty of the hops.
 *
 * Three pieces do the work:
 *
 * - **The blinded header.** Each hop derives a shared secret from the packet's
 *   ephemeral point and its own key, uses it to peel one routing block, and
 *   blinds the point for the next hop. The point changes at every hop, so the
 *   same packet is unrecognisable from one link to the next.
 * - **The filler.** The routing block that a hop peels off is replaced by
 *   pseudo-random bytes the sender pre-computed, so the header never shrinks
 *   and the position in the path never shows.
 * - **The wide-block body.** Any tampering randomises the entire payload
 *   rather than a chosen part of it, which is what defeats tagging attacks.
 *
 * What this format does not do: hide that you are talking to a mix, or protect
 * you when the anonymity set is small. Those live in the threat model.
 */

export const SPHINX_VERSION = 1;
/** Longest path a packet can take. Every packet reserves room for this many. */
export const MAX_HOPS = 5;
export const NODE_ID_BYTES = 16;
const ROUTING_BYTES = 32;
const MAC_BYTES = 32;
const BLOCK_BYTES = ROUTING_BYTES + MAC_BYTES;
export const BETA_BYTES = MAX_HOPS * BLOCK_BYTES;
export const HEADER_BYTES = 32 + BETA_BYTES + MAC_BYTES;
/** Every packet body is exactly this size, whatever it carries. */
export const PAYLOAD_BYTES = 65_536;
export const PACKET_BYTES = HEADER_BYTES + PAYLOAD_BYTES;

/** Plaintext framing inside the body: magic, length, then the message. */
const MAGIC = Buffer.from("CAPSULEMIX1", "utf8");
const ENVELOPE_BYTES = MAGIC.byteLength + 4;
export const MAX_MESSAGE_BYTES = PAYLOAD_BYTES - ENVELOPE_BYTES;

export const MixCommand = {
  /** Pass the packet to another mix. */
  Forward: 1,
  /** The packet is for you: act on the message inside. */
  Deliver: 2,
  /** Put the body in a mailbox under the given token. */
  Mailbox: 3,
  /** Drop it. Cover traffic that has finished its loop. */
  Discard: 4,
} as const;

export type MixCommandValue = (typeof MixCommand)[keyof typeof MixCommand];

export interface MixHop {
  /** 16-byte identifier, the truncated digest of the hop's public key. */
  id: Uint8Array;
  /** The hop's Curve25519 public key. */
  publicKey: Uint8Array;
  /** How long this hop should hold the packet before forwarding it. */
  delayMs: number;
}

export interface MixDestination {
  command: MixCommandValue;
  /** Identifier of the final destination, or the mailbox token. */
  id: Uint8Array;
}

export interface SphinxHeader {
  alpha: Uint8Array;
  beta: Uint8Array;
  gamma: Uint8Array;
}

export interface BuiltHeader {
  header: SphinxHeader;
  /** Per-hop payload keys, in path order. The sender keeps these. */
  payloadKeys: Uint8Array[];
}

export interface ProcessedPacket {
  command: MixCommandValue;
  delayMs: number;
  /** Next hop, destination, or mailbox token depending on the command. */
  id: Uint8Array;
  /** Replay identifier for this packet at this hop. */
  tag: Uint8Array;
  /** The packet to pass on. Absent when the packet ends here. */
  packet?: Uint8Array;
  /** The body, already unwrapped one layer. Present when it ends here. */
  body?: Uint8Array;
}

export function nodeIdFor(publicKey: Uint8Array): Uint8Array {
  return derive(publicKey, "node-id", NODE_ID_BYTES);
}

function stream(key: Uint8Array, byteLength: number): Uint8Array {
  const cipher = createCipheriv("aes-256-ctr", key, Buffer.alloc(16));
  return new Uint8Array(
    Buffer.concat([cipher.update(Buffer.alloc(byteLength)), cipher.final()]),
  );
}

function xorInto(target: Uint8Array, source: Uint8Array): Uint8Array {
  for (let index = 0; index < target.byteLength; index += 1) {
    target[index] = (target[index] as number) ^ (source[index] as number);
  }
  return target;
}

function mac(key: Uint8Array, data: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac("sha256", key).update(data).digest());
}

interface HopKeys {
  blind: Uint8Array;
  macKey: Uint8Array;
  streamKey: Uint8Array;
  payloadKey: Uint8Array;
  tag: Uint8Array;
}

function hopKeys(secret: Uint8Array): HopKeys {
  return {
    blind: derive(secret, "blind", 32),
    macKey: derive(secret, "mac", 32),
    streamKey: derive(secret, "stream", 32),
    payloadKey: derive(secret, "payload", 32),
    tag: derive(secret, "replay-tag", 16),
  };
}

function routingBlock(
  command: MixCommandValue,
  delayMs: number,
  id: Uint8Array,
  nextMac: Uint8Array,
): Uint8Array {
  if (id.byteLength !== NODE_ID_BYTES) {
    throw new Error("A mix identifier has 16 bytes");
  }
  if (!Number.isSafeInteger(delayMs) || delayMs < 0 || delayMs > 0xffff_ffff) {
    throw new Error("Invalid mix delay");
  }
  const block = new Uint8Array(BLOCK_BYTES);
  block[0] = command;
  new DataView(block.buffer).setUint32(1, delayMs, false);
  block.set(id, 5);
  block.set(nextMac, ROUTING_BYTES);
  return block;
}

/**
 * Derives the shared secret for every hop, plus the blinded point each hop
 * will see. The sender reaches a hop's secret by multiplying that hop's public
 * key by the ephemeral scalar and then by every earlier blinding factor; the
 * hop reaches the same value from its own key and the point in the header.
 */
function pathSecrets(
  path: MixHop[],
  ephemeral: Uint8Array,
): { alphas: Uint8Array[]; keys: HopKeys[] } {
  const alphas: Uint8Array[] = [];
  const keys: HopKeys[] = [];
  const blindings: Uint8Array[] = [];

  let alpha = basePoint(ephemeral);
  for (const [index, hop] of path.entries()) {
    alphas.push(alpha);

    let secret = multiply(ephemeral, hop.publicKey);
    for (const blinding of blindings) secret = multiply(blinding, secret);
    const derived = hopKeys(secret);
    keys.push(derived);

    if (index < path.length - 1) {
      blindings.push(derived.blind);
      alpha = multiply(derived.blind, alpha);
    }
  }
  return { alphas, keys };
}

/** Pseudo-random bytes that stand in for the blocks already peeled off. */
function fillerFor(keys: HopKeys[]): Uint8Array {
  let filler = new Uint8Array(0);
  for (let index = 0; index < keys.length - 1; index += 1) {
    const rho = stream(
      (keys[index] as HopKeys).streamKey,
      BETA_BYTES + BLOCK_BYTES,
    );
    const grown = new Uint8Array(filler.byteLength + BLOCK_BYTES);
    grown.set(filler);
    xorInto(grown, rho.subarray(rho.byteLength - grown.byteLength));
    filler = grown;
  }
  return filler;
}

export function buildHeader(
  path: MixHop[],
  destination: MixDestination,
): BuiltHeader {
  if (path.length === 0 || path.length > MAX_HOPS) {
    throw new Error(`A path needs between 1 and ${MAX_HOPS} hops`);
  }

  const ephemeral = randomScalar();
  const { alphas, keys } = pathSecrets(path, ephemeral);
  const filler = fillerFor(keys);
  const last = path.length - 1;

  // The final hop's block names the destination; there is no next MAC, so the
  // slot is filled with random bytes that are indistinguishable from one.
  const tailBytes = BETA_BYTES - filler.byteLength;
  const tail = new Uint8Array(tailBytes);
  tail.set(
    routingBlock(
      destination.command,
      (path[last] as MixHop).delayMs,
      destination.id,
      new Uint8Array(randomBytes(MAC_BYTES)),
    ),
  );
  tail.set(new Uint8Array(randomBytes(tailBytes - BLOCK_BYTES)), BLOCK_BYTES);
  xorInto(
    tail,
    stream(
      (keys[last] as HopKeys).streamKey,
      BETA_BYTES + BLOCK_BYTES,
    ).subarray(0, tailBytes),
  );

  let beta = new Uint8Array(BETA_BYTES);
  beta.set(tail);
  beta.set(filler, tailBytes);
  let gamma = mac((keys[last] as HopKeys).macKey, beta);

  for (let index = last - 1; index >= 0; index -= 1) {
    const hop = path[index + 1] as MixHop;
    const next = new Uint8Array(BETA_BYTES);
    next.set(
      routingBlock(
        MixCommand.Forward,
        (path[index] as MixHop).delayMs,
        hop.id,
        gamma,
      ),
    );
    next.set(beta.subarray(0, BETA_BYTES - BLOCK_BYTES), BLOCK_BYTES);
    xorInto(
      next,
      stream(
        (keys[index] as HopKeys).streamKey,
        BETA_BYTES + BLOCK_BYTES,
      ).subarray(0, BETA_BYTES),
    );
    beta = next;
    gamma = mac((keys[index] as HopKeys).macKey, beta);
  }

  return {
    header: { alpha: alphas[0] as Uint8Array, beta, gamma },
    payloadKeys: keys.map((key) => key.payloadKey),
  };
}

/** Wraps a message so the destination can tell a real body from noise. */
export function frameMessage(message: Uint8Array): Uint8Array {
  if (message.byteLength > MAX_MESSAGE_BYTES) {
    throw new Error(`A mix message cannot exceed ${MAX_MESSAGE_BYTES} bytes`);
  }
  const body = new Uint8Array(randomBytes(PAYLOAD_BYTES));
  body.set(MAGIC, 0);
  new DataView(body.buffer).setUint32(
    MAGIC.byteLength,
    message.byteLength,
    false,
  );
  body.set(message, ENVELOPE_BYTES);
  return body;
}

export function readMessage(body: Uint8Array): Uint8Array | undefined {
  if (body.byteLength !== PAYLOAD_BYTES) return undefined;
  const magic = Buffer.from(body.subarray(0, MAGIC.byteLength));
  if (magic.byteLength !== MAGIC.byteLength || !timingSafeEqual(magic, MAGIC)) {
    return undefined;
  }
  const length = new DataView(
    body.buffer,
    body.byteOffset,
    body.byteLength,
  ).getUint32(MAGIC.byteLength, false);
  if (length > MAX_MESSAGE_BYTES) return undefined;
  return body.subarray(ENVELOPE_BYTES, ENVELOPE_BYTES + length);
}

/** Puts one encryption layer on the body for every hop, last hop innermost. */
export function wrapBody(
  payloadKeys: Uint8Array[],
  body: Uint8Array,
): Uint8Array {
  const wrapped = Uint8Array.from(body);
  for (let index = payloadKeys.length - 1; index >= 0; index -= 1) {
    lionessEncrypt(payloadKeys[index] as Uint8Array, wrapped);
  }
  return wrapped;
}

export function encodePacket(
  header: SphinxHeader,
  body: Uint8Array,
): Uint8Array {
  if (body.byteLength !== PAYLOAD_BYTES) {
    throw new Error("A mix packet body has a fixed size");
  }
  const packet = new Uint8Array(PACKET_BYTES);
  packet.set(header.alpha, 0);
  packet.set(header.beta, 32);
  packet.set(header.gamma, 32 + BETA_BYTES);
  packet.set(body, HEADER_BYTES);
  return packet;
}

export function decodePacket(packet: Uint8Array): {
  header: SphinxHeader;
  body: Uint8Array;
} {
  if (packet.byteLength !== PACKET_BYTES) {
    throw new Error("A mix packet has a fixed size");
  }
  return {
    header: {
      alpha: packet.subarray(0, 32),
      beta: packet.subarray(32, 32 + BETA_BYTES),
      gamma: packet.subarray(32 + BETA_BYTES, HEADER_BYTES),
    },
    body: packet.subarray(HEADER_BYTES),
  };
}

/** Builds a complete packet for a path and a message. */
export function createPacket(
  path: MixHop[],
  destination: MixDestination,
  message: Uint8Array,
): { packet: Uint8Array; payloadKeys: Uint8Array[] } {
  const built = buildHeader(path, destination);
  const body = wrapBody(built.payloadKeys, frameMessage(message));
  return {
    packet: encodePacket(built.header, body),
    payloadKeys: built.payloadKeys,
  };
}

/**
 * Peels one layer. Returns what this hop should do next, or throws when the
 * packet does not authenticate — which is the only signal a mix gets, and all
 * it needs: a packet that fails here is dropped and never mentioned again.
 */
export function processPacket(
  privateKey: Uint8Array,
  packet: Uint8Array,
): ProcessedPacket {
  const { header, body } = decodePacket(packet);
  const secret = multiply(privateKey, header.alpha);
  const keys = hopKeys(secret);

  const expected = mac(keys.macKey, header.beta);
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(header.gamma))) {
    throw new Error("Mix packet failed authentication");
  }

  const padded = new Uint8Array(BETA_BYTES + BLOCK_BYTES);
  padded.set(header.beta);
  xorInto(padded, stream(keys.streamKey, BETA_BYTES + BLOCK_BYTES));

  const command = padded[0] as MixCommandValue;
  const delayMs = new DataView(padded.buffer, padded.byteOffset).getUint32(
    1,
    false,
  );
  const id = padded.slice(5, 5 + NODE_ID_BYTES);
  const nextGamma = padded.slice(ROUTING_BYTES, BLOCK_BYTES);
  const nextBeta = padded.slice(BLOCK_BYTES);

  const unwrapped = lionessDecrypt(keys.payloadKey, Uint8Array.from(body));

  if (command === MixCommand.Forward) {
    const nextAlpha = multiply(keys.blind, header.alpha);
    return {
      command,
      delayMs,
      id,
      tag: keys.tag,
      packet: encodePacket(
        { alpha: nextAlpha, beta: nextBeta, gamma: nextGamma },
        unwrapped,
      ),
    };
  }

  if (
    command !== MixCommand.Deliver &&
    command !== MixCommand.Mailbox &&
    command !== MixCommand.Discard
  ) {
    throw new Error("Mix packet carries an unknown command");
  }
  return { command, delayMs, id, tag: keys.tag, body: unwrapped };
}

/**
 * A single-use reply block: a header addressed back to whoever built it, handed
 * to a destination so it can answer without ever learning who it is answering.
 */
export interface ReplyBlock {
  /** Where the reply's first hop is. */
  firstHopId: Uint8Array;
  header: SphinxHeader;
  /** Key the destination uses to seal the reply. */
  sealKey: Uint8Array;
}

export interface ReplyBlockSecrets {
  /** Per-hop payload keys of the reply path, in path order. */
  payloadKeys: Uint8Array[];
  sealKey: Uint8Array;
}

/** Builds a reply block whose last hop drops the body in `mailboxToken`. */
export function createReplyBlock(
  path: MixHop[],
  mailboxToken: Uint8Array,
): { block: ReplyBlock; secrets: ReplyBlockSecrets } {
  const built = buildHeader(path, {
    command: MixCommand.Mailbox,
    id: mailboxToken,
  });
  const sealKey = new Uint8Array(randomBytes(32));
  return {
    block: {
      firstHopId: (path[0] as MixHop).id,
      header: built.header,
      sealKey,
    },
    secrets: { payloadKeys: built.payloadKeys, sealKey },
  };
}

/** Used by a destination: seals a reply into a packet the reply block routes. */
export function sealReply(block: ReplyBlock, message: Uint8Array): Uint8Array {
  const body = lionessEncrypt(block.sealKey, frameMessage(message));
  return encodePacket(block.header, body);
}

/**
 * Used by whoever built the reply block: undoes the layers every hop applied
 * on the way back, then the destination's seal.
 */
export function openReply(
  secrets: ReplyBlockSecrets,
  body: Uint8Array,
): Uint8Array | undefined {
  const opened = Uint8Array.from(body);
  for (let index = secrets.payloadKeys.length - 1; index >= 0; index -= 1) {
    lionessEncrypt(secrets.payloadKeys[index] as Uint8Array, opened);
  }
  lionessDecrypt(secrets.sealKey, opened);
  return readMessage(opened);
}
