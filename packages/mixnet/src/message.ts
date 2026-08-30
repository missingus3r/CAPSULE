import {
  HEADER_BYTES,
  NODE_ID_BYTES,
  type ReplyBlock,
  type SphinxHeader,
} from "./sphinx.js";

/**
 * What a packet carries once it reaches the relay it was addressed to.
 *
 * The destination of a CAPSULE packet is the storage relay itself, not a
 * separate exit node. That is a deliberate difference from onion routing for
 * the web: there is no exit, so there is no party that sees a request in the
 * clear without being the party the request was for anyway. The relay learns
 * the capsule operation — which it would learn regardless — and does not learn
 * who asked.
 *
 * A request carries the reply block the relay must use to answer. The relay
 * cannot tell where that reply goes; it can only hand it to the first hop.
 */

export const MIX_MESSAGE_VERSION = 1;
/** Plaintext chunk size for capsules sent over the mix, so a chunk fits a packet. */
export const MIX_CHUNK_SIZE = 63 * 1024;
const SEAL_KEY_BYTES = 32;
export const REPLY_BLOCK_BYTES = NODE_ID_BYTES + HEADER_BYTES + SEAL_KEY_BYTES;

export const MixOp = {
  Create: 1,
  PutChunk: 2,
  Finalize: 3,
  Manifest: 4,
  GetChunk: 5,
  Status: 6,
  Delete: 7,
} as const;

export type MixOpValue = (typeof MixOp)[keyof typeof MixOp];

export interface MixRequest {
  op: MixOpValue;
  replyBlock: ReplyBlock;
  capsuleId?: string;
  token?: string;
  index?: number;
  /** JSON body for control operations, ciphertext for a chunk. */
  data?: Uint8Array;
}

export interface MixResponse {
  ok: boolean;
  /** JSON for control operations and errors, ciphertext for reads. */
  data: Uint8Array;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeReplyBlock(block: ReplyBlock): Uint8Array {
  const bytes = new Uint8Array(REPLY_BLOCK_BYTES);
  let offset = 0;
  bytes.set(block.firstHopId, offset);
  offset += NODE_ID_BYTES;
  bytes.set(block.header.alpha, offset);
  offset += block.header.alpha.byteLength;
  bytes.set(block.header.beta, offset);
  offset += block.header.beta.byteLength;
  bytes.set(block.header.gamma, offset);
  offset += block.header.gamma.byteLength;
  bytes.set(block.sealKey, offset);
  return bytes;
}

export function decodeReplyBlock(bytes: Uint8Array): ReplyBlock {
  if (bytes.byteLength !== REPLY_BLOCK_BYTES) {
    throw new Error("Malformed reply block");
  }
  let offset = NODE_ID_BYTES;
  const alpha = bytes.slice(offset, offset + 32);
  offset += 32;
  const betaBytes = HEADER_BYTES - 64;
  const beta = bytes.slice(offset, offset + betaBytes);
  offset += betaBytes;
  const gamma = bytes.slice(offset, offset + 32);
  offset += 32;
  const header: SphinxHeader = { alpha, beta, gamma };
  return {
    firstHopId: bytes.slice(0, NODE_ID_BYTES),
    header,
    sealKey: bytes.slice(offset, offset + SEAL_KEY_BYTES),
  };
}

function writeString(parts: Uint8Array[], value: string | undefined): void {
  const bytes = value ? encoder.encode(value) : new Uint8Array(0);
  if (bytes.byteLength > 255) throw new Error("Field is too long for a packet");
  parts.push(Uint8Array.of(bytes.byteLength), bytes);
}

function readString(
  bytes: Uint8Array,
  cursor: { at: number },
): string | undefined {
  const length = bytes[cursor.at] as number;
  cursor.at += 1;
  if (length === 0) return undefined;
  const value = decoder.decode(bytes.subarray(cursor.at, cursor.at + length));
  cursor.at += length;
  return value;
}

export function encodeRequest(request: MixRequest): Uint8Array {
  const parts: Uint8Array[] = [
    Uint8Array.of(MIX_MESSAGE_VERSION, request.op),
    encodeReplyBlock(request.replyBlock),
  ];
  writeString(parts, request.capsuleId);
  writeString(parts, request.token);

  const numbers = new Uint8Array(8);
  const view = new DataView(numbers.buffer);
  view.setUint32(0, request.index ?? 0, false);
  view.setUint32(4, request.data?.byteLength ?? 0, false);
  parts.push(numbers);
  if (request.data) parts.push(request.data);

  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const message = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    message.set(part, offset);
    offset += part.byteLength;
  }
  return message;
}

export function decodeRequest(message: Uint8Array): MixRequest {
  if (message.byteLength < 2 + REPLY_BLOCK_BYTES + 2 + 8) {
    throw new Error("Malformed mix request");
  }
  if (message[0] !== MIX_MESSAGE_VERSION) {
    throw new Error("Unsupported mix message version");
  }
  const op = message[1] as MixOpValue;
  if (!Object.values(MixOp).includes(op)) {
    throw new Error("Unknown mix operation");
  }
  const replyBlock = decodeReplyBlock(
    message.subarray(2, 2 + REPLY_BLOCK_BYTES),
  );

  const cursor = { at: 2 + REPLY_BLOCK_BYTES };
  const capsuleId = readString(message, cursor);
  const token = readString(message, cursor);
  if (cursor.at + 8 > message.byteLength) {
    throw new Error("Malformed mix request");
  }
  const view = new DataView(message.buffer, message.byteOffset + cursor.at, 8);
  const index = view.getUint32(0, false);
  const dataLength = view.getUint32(4, false);
  cursor.at += 8;
  if (cursor.at + dataLength > message.byteLength) {
    throw new Error("Malformed mix request");
  }

  return {
    op,
    replyBlock,
    ...(capsuleId ? { capsuleId } : {}),
    ...(token ? { token } : {}),
    index,
    ...(dataLength > 0
      ? { data: message.slice(cursor.at, cursor.at + dataLength) }
      : {}),
  };
}

const RESPONSE_HEADER_BYTES = 6;

export function encodeResponse(response: MixResponse): Uint8Array {
  const message = new Uint8Array(
    RESPONSE_HEADER_BYTES + response.data.byteLength,
  );
  message[0] = MIX_MESSAGE_VERSION;
  message[1] = response.ok ? 1 : 0;
  new DataView(message.buffer).setUint32(2, response.data.byteLength, false);
  message.set(response.data, RESPONSE_HEADER_BYTES);
  return message;
}

export function decodeResponse(message: Uint8Array): MixResponse {
  if (
    message.byteLength < RESPONSE_HEADER_BYTES ||
    message[0] !== MIX_MESSAGE_VERSION
  ) {
    throw new Error("Malformed mix response");
  }
  const length = new DataView(
    message.buffer,
    message.byteOffset,
    message.byteLength,
  ).getUint32(2, false);
  if (RESPONSE_HEADER_BYTES + length > message.byteLength) {
    throw new Error("Malformed mix response");
  }
  return {
    ok: message[1] === 1,
    data: message.slice(RESPONSE_HEADER_BYTES, RESPONSE_HEADER_BYTES + length),
  };
}
