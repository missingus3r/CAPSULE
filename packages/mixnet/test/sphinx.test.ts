import { describe, expect, it } from "vitest";
import {
  MAX_HOPS,
  MAX_MESSAGE_BYTES,
  MixCommand,
  PACKET_BYTES,
  PAYLOAD_BYTES,
  createPacket,
  createReplyBlock,
  generateMixKeyPair,
  lionessDecrypt,
  lionessEncrypt,
  nodeIdFor,
  openReply,
  processPacket,
  readMessage,
  sealReply,
  type MixHop,
  type MixKeyPair,
} from "../src/index.js";

interface Node {
  keys: MixKeyPair;
  hop: MixHop;
}

function makeNode(delayMs = 0): Node {
  const keys = generateMixKeyPair();
  return {
    keys,
    hop: { id: nodeIdFor(keys.publicKey), publicKey: keys.publicKey, delayMs },
  };
}

/** Walks a packet through a path the way the network would. */
function route(
  nodes: Node[],
  packet: Uint8Array,
): {
  hops: Array<{ command: number; delayMs: number; id: Uint8Array }>;
  seen: Uint8Array[];
  body?: Uint8Array;
} {
  const hops: Array<{ command: number; delayMs: number; id: Uint8Array }> = [];
  const seen: Uint8Array[] = [packet];
  let current = packet;

  for (const node of nodes) {
    const processed = processPacket(node.keys.privateKey, current);
    hops.push({
      command: processed.command,
      delayMs: processed.delayMs,
      id: processed.id,
    });
    if (processed.packet) {
      current = processed.packet;
      seen.push(current);
      continue;
    }
    return { hops, seen, ...(processed.body ? { body: processed.body } : {}) };
  }
  return { hops, seen };
}

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

describe("LIONESS", () => {
  it("round-trips a block", () => {
    const key = new Uint8Array(32).fill(3);
    const original = Uint8Array.from({ length: 1000 }, (_v, i) => i % 256);
    const encrypted = lionessEncrypt(key, Uint8Array.from(original));
    expect(encrypted).not.toEqual(original);
    expect(lionessDecrypt(key, encrypted)).toEqual(original);
  });

  it("randomises the whole block when one bit changes", () => {
    // This is the property that defeats tagging: a mix cannot mark a packet in
    // a way that survives to be recognised, because the mark destroys
    // everything rather than a chosen part.
    const key = new Uint8Array(32).fill(5);
    const original = new Uint8Array(2048).fill(0xaa);
    const encrypted = lionessEncrypt(key, Uint8Array.from(original));

    const tampered = Uint8Array.from(encrypted);
    tampered[1500] = (tampered[1500] as number) ^ 0x01;
    const recovered = lionessDecrypt(key, tampered);

    let identical = 0;
    for (let index = 0; index < original.length; index += 1) {
      if (recovered[index] === original[index]) identical += 1;
    }
    // Random bytes would match about 1 in 256; anything close to the whole
    // block matching would mean the change stayed local.
    expect(identical).toBeLessThan(original.length / 8);
  });
});

describe("Sphinx packets", () => {
  it("delivers a message through a path and reports each hop", () => {
    const nodes = [makeNode(100), makeNode(250), makeNode(0)];
    const destination = makeNode();
    const message = text("un chunk de cápsula");

    const { packet } = createPacket(
      nodes.map((node) => node.hop),
      { command: MixCommand.Deliver, id: destination.hop.id },
      message,
    );
    expect(packet.byteLength).toBe(PACKET_BYTES);

    const result = route(nodes, packet);
    expect(result.hops.map((hop) => hop.command)).toEqual([
      MixCommand.Forward,
      MixCommand.Forward,
      MixCommand.Deliver,
    ]);
    expect(result.hops.map((hop) => hop.delayMs)).toEqual([100, 250, 0]);
    expect(result.hops[0]?.id).toEqual(nodes[1]?.hop.id);
    expect(result.hops[1]?.id).toEqual(nodes[2]?.hop.id);
    expect(result.hops[2]?.id).toEqual(destination.hop.id);
    expect(readMessage(result.body as Uint8Array)).toEqual(message);
  });

  it("keeps every packet the same size and appearance at every hop", () => {
    const nodes = [makeNode(), makeNode(), makeNode(), makeNode()];
    const { packet } = createPacket(
      nodes.map((node) => node.hop),
      { command: MixCommand.Deliver, id: nodes[3]?.hop.id as Uint8Array },
      text("x"),
    );
    const { seen } = route(nodes, packet);

    for (const observed of seen) {
      expect(observed.byteLength).toBe(PACKET_BYTES);
    }
    // No two links carry the same bytes, so a packet cannot be followed by
    // sight from one hop to the next.
    for (let a = 0; a < seen.length; a += 1) {
      for (let b = a + 1; b < seen.length; b += 1) {
        expect(seen[a]).not.toEqual(seen[b]);
      }
    }
  });

  it("looks identical whether the path is short or long", () => {
    // A hop cannot tell how far along it is, because the header it receives is
    // always the same size and the rest is indistinguishable from padding.
    for (const hopCount of [1, 2, 3, 4, MAX_HOPS]) {
      const nodes = Array.from({ length: hopCount }, () => makeNode());
      const { packet } = createPacket(
        nodes.map((node) => node.hop),
        { command: MixCommand.Deliver, id: nodes[0]?.hop.id as Uint8Array },
        text("mismo tamaño"),
      );
      expect(packet.byteLength).toBe(PACKET_BYTES);
      const result = route(nodes, packet);
      expect(readMessage(result.body as Uint8Array)).toEqual(
        text("mismo tamaño"),
      );
    }
  });

  it("refuses a packet whose header was altered", () => {
    const nodes = [makeNode(), makeNode()];
    const { packet } = createPacket(
      nodes.map((node) => node.hop),
      { command: MixCommand.Deliver, id: nodes[1]?.hop.id as Uint8Array },
      text("intacto"),
    );
    const tampered = Uint8Array.from(packet);
    tampered[100] = (tampered[100] as number) ^ 0xff;
    expect(() =>
      processPacket((nodes[0] as Node).keys.privateKey, tampered),
    ).toThrow("failed authentication");
  });

  it("turns a tagged body into noise the destination rejects", () => {
    const nodes = [makeNode(), makeNode(), makeNode()];
    const { packet } = createPacket(
      nodes.map((node) => node.hop),
      { command: MixCommand.Deliver, id: nodes[2]?.hop.id as Uint8Array },
      text("mensaje real"),
    );

    // The first mix marks the body, hoping to recognise the packet later.
    const first = processPacket((nodes[0] as Node).keys.privateKey, packet);
    const marked = Uint8Array.from(first.packet as Uint8Array);
    marked[PACKET_BYTES - 500] = (marked[PACKET_BYTES - 500] as number) ^ 0x80;

    const second = processPacket((nodes[1] as Node).keys.privateKey, marked);
    const third = processPacket(
      (nodes[2] as Node).keys.privateKey,
      second.packet as Uint8Array,
    );
    // The mark does not survive: the body is noise and the envelope is gone.
    expect(readMessage(third.body as Uint8Array)).toBeUndefined();
  });

  it("gives each hop a different packet even for the same route", () => {
    const nodes = [makeNode(), makeNode()];
    const path = nodes.map((node) => node.hop);
    const destination = { command: MixCommand.Deliver, id: path[1]!.id };
    const first = createPacket(path, destination, text("igual"));
    const second = createPacket(path, destination, text("igual"));
    expect(first.packet).not.toEqual(second.packet);

    // And each carries a different replay tag, so a mix can tell a genuine
    // retransmission from two separate sends.
    const tagA = processPacket(
      (nodes[0] as Node).keys.privateKey,
      first.packet,
    ).tag;
    const tagB = processPacket(
      (nodes[0] as Node).keys.privateKey,
      second.packet,
    ).tag;
    expect(tagA).not.toEqual(tagB);
  });

  it("gives the same replay tag when the same packet arrives twice", () => {
    const nodes = [makeNode(), makeNode()];
    const { packet } = createPacket(
      nodes.map((node) => node.hop),
      { command: MixCommand.Deliver, id: nodes[1]!.hop.id },
      text("una vez"),
    );
    const first = processPacket((nodes[0] as Node).keys.privateKey, packet);
    const again = processPacket((nodes[0] as Node).keys.privateKey, packet);
    expect(first.tag).toEqual(again.tag);
  });

  it("refuses a packet processed with the wrong key", () => {
    const nodes = [makeNode(), makeNode()];
    const stranger = makeNode();
    const { packet } = createPacket(
      nodes.map((node) => node.hop),
      { command: MixCommand.Deliver, id: nodes[1]!.hop.id },
      text("ajeno"),
    );
    expect(() => processPacket(stranger.keys.privateKey, packet)).toThrow(
      "failed authentication",
    );
  });

  it("rejects paths that are empty or too long", () => {
    const node = makeNode();
    const destination = { command: MixCommand.Deliver, id: node.hop.id };
    expect(() => createPacket([], destination, text("x"))).toThrow(
      "between 1 and",
    );
    const tooLong = Array.from({ length: MAX_HOPS + 1 }, () => makeNode().hop);
    expect(() => createPacket(tooLong, destination, text("x"))).toThrow(
      "between 1 and",
    );
  });

  it("carries a message that fills the body", () => {
    const nodes = [makeNode(), makeNode()];
    const big = Uint8Array.from(
      { length: MAX_MESSAGE_BYTES },
      (_v, i) => i % 251,
    );
    const { packet } = createPacket(
      nodes.map((node) => node.hop),
      { command: MixCommand.Deliver, id: nodes[1]!.hop.id },
      big,
    );
    const result = route(nodes, packet);
    expect(readMessage(result.body as Uint8Array)).toEqual(big);
    expect(packet.byteLength).toBe(PACKET_BYTES);
    // One byte more does not fit, and says so rather than truncating.
    expect(() =>
      createPacket(
        nodes.map((node) => node.hop),
        { command: MixCommand.Deliver, id: nodes[1]!.hop.id },
        new Uint8Array(MAX_MESSAGE_BYTES + 1),
      ),
    ).toThrow("cannot exceed");
  });
});

describe("reply blocks", () => {
  it("lets a destination answer without learning who it answers", () => {
    const replyPath = [makeNode(50), makeNode(0)];
    const mailbox = new Uint8Array(16).fill(7);
    const { block, secrets } = createReplyBlock(
      replyPath.map((node) => node.hop),
      mailbox,
    );

    // The destination only ever holds the block; it never sees the path.
    const answer = text("acá está tu chunk");
    const replyPacket = sealReply(block, answer);

    const result = route(replyPath, replyPacket);
    expect(result.hops.map((hop) => hop.command)).toEqual([
      MixCommand.Forward,
      MixCommand.Mailbox,
    ]);
    expect(result.hops[1]?.id).toEqual(mailbox);
    expect(openReply(secrets, result.body as Uint8Array)).toEqual(answer);
  });

  it("produces a body only the block's author can open", () => {
    const replyPath = [makeNode(), makeNode()];
    const { block, secrets } = createReplyBlock(
      replyPath.map((node) => node.hop),
      new Uint8Array(16).fill(1),
    );
    const other = createReplyBlock(
      replyPath.map((node) => node.hop),
      new Uint8Array(16).fill(2),
    );

    const result = route(replyPath, sealReply(block, text("secreto")));
    expect(openReply(secrets, result.body as Uint8Array)).toEqual(
      text("secreto"),
    );
    expect(openReply(other.secrets, result.body as Uint8Array)).toBeUndefined();
  });

  it("keeps a reply the same size as any other packet", () => {
    const replyPath = [makeNode(), makeNode(), makeNode()];
    const { block } = createReplyBlock(
      replyPath.map((node) => node.hop),
      new Uint8Array(16),
    );
    const packet = sealReply(block, text("corto"));
    expect(packet.byteLength).toBe(PACKET_BYTES);
    expect(packet.byteLength - PAYLOAD_BYTES).toBeLessThan(PAYLOAD_BYTES);
  });
});
