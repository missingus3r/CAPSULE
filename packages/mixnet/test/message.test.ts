import { describe, expect, it } from "vitest";
import {
  MIX_CHUNK_SIZE,
  MixOp,
  createReplyBlock,
  decodeReplyBlock,
  decodeRequest,
  decodeResponse,
  encodeReplyBlock,
  encodeRequest,
  encodeResponse,
  generateMixKeyPair,
  nodeIdFor,
  MAX_MESSAGE_BYTES,
} from "../src/index.js";

/**
 * The message layer is the seam between the packet format and the relay API.
 * A field that shifts by one byte here does not fail loudly: the relay decodes
 * a request that is subtly wrong, or a reply goes to the wrong first hop and
 * simply never arrives. So the round trip is checked field by field.
 */

function replyBlock() {
  const keys = generateMixKeyPair();
  return createReplyBlock(
    [
      {
        id: nodeIdFor(keys.publicKey),
        publicKey: keys.publicKey,
        delayMs: 42,
      },
    ],
    new Uint8Array(16).fill(9),
  ).block;
}

describe("mix messages", () => {
  it("round-trips a reply block byte for byte", () => {
    const block = replyBlock();
    const decoded = decodeReplyBlock(encodeReplyBlock(block));
    expect(decoded.firstHopId).toEqual(block.firstHopId);
    expect(decoded.header.alpha).toEqual(block.header.alpha);
    expect(decoded.header.beta).toEqual(block.header.beta);
    expect(decoded.header.gamma).toEqual(block.header.gamma);
    expect(decoded.sealKey).toEqual(block.sealKey);
  });

  it("round-trips every field of a request", () => {
    const block = replyBlock();
    const data = Uint8Array.from({ length: 500 }, (_v, i) => i % 256);
    const decoded = decodeRequest(
      encodeRequest({
        op: MixOp.PutChunk,
        replyBlock: block,
        capsuleId: "A".repeat(32),
        token: "B".repeat(43),
        index: 4_000_000,
        data,
      }),
    );
    expect(decoded.op).toBe(MixOp.PutChunk);
    expect(decoded.capsuleId).toBe("A".repeat(32));
    expect(decoded.token).toBe("B".repeat(43));
    expect(decoded.index).toBe(4_000_000);
    expect(decoded.data).toEqual(data);
    expect(decoded.replyBlock.firstHopId).toEqual(block.firstHopId);
  });

  it("round-trips a request with no capsule, token or data", () => {
    const decoded = decodeRequest(
      encodeRequest({ op: MixOp.Create, replyBlock: replyBlock() }),
    );
    expect(decoded.op).toBe(MixOp.Create);
    expect(decoded.capsuleId).toBeUndefined();
    expect(decoded.token).toBeUndefined();
    expect(decoded.data).toBeUndefined();
  });

  it("fits a whole capsule chunk, its framing and a reply block in one packet", () => {
    // The chunk size exists so that one chunk is one packet. If this stops
    // holding, transfers silently fall back to more packets per chunk.
    const ciphertext = new Uint8Array(MIX_CHUNK_SIZE + 16);
    const message = encodeRequest({
      op: MixOp.PutChunk,
      replyBlock: replyBlock(),
      capsuleId: "A".repeat(32),
      token: "B".repeat(43),
      index: 0,
      data: ciphertext,
    });
    expect(message.byteLength).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
  });

  it("round-trips a response and refuses a malformed one", () => {
    const data = Uint8Array.from({ length: 300 }, (_v, i) => (i * 7) % 256);
    expect(decodeResponse(encodeResponse({ ok: true, data }))).toEqual({
      ok: true,
      data,
    });
    expect(
      decodeResponse(encodeResponse({ ok: false, data: new Uint8Array(0) })),
    ).toEqual({ ok: false, data: new Uint8Array(0) });
    expect(() => decodeResponse(new Uint8Array(3))).toThrow("Malformed");
  });

  it("refuses requests that are truncated or carry an unknown operation", () => {
    const valid = encodeRequest({
      op: MixOp.Status,
      replyBlock: replyBlock(),
      capsuleId: "A".repeat(32),
      token: "B".repeat(43),
    });
    expect(() => decodeRequest(valid.subarray(0, valid.length - 5))).toThrow();

    const unknown = Uint8Array.from(valid);
    unknown[1] = 99;
    expect(() => decodeRequest(unknown)).toThrow("Unknown mix operation");

    const wrongVersion = Uint8Array.from(valid);
    wrongVersion[0] = 7;
    expect(() => decodeRequest(wrongVersion)).toThrow("Unsupported");
  });
});
