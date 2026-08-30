import { packSite, unpackSite, readSiteManifest } from "@capsule/protocol";
import { describe, expect, it } from "vitest";
import { gatherFromZipBytes, stripCommonRoot } from "./sitefiles";
import { readZip } from "./zip";

/**
 * Reading a site out of what somebody dropped into the page.
 *
 * The zip reader is hand-written, so these tests build real archives — a
 * stored entry and a deflated one — rather than trusting a fixture.
 */

const encoder = new TextEncoder();

/** CRC-32, which a zip entry carries and a reader is entitled to ignore. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb8_8320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes.slice());
      controller.close();
    },
  });
  const stream = source.pipeThrough(
    new CompressionStream("deflate-raw") as unknown as ReadableWritablePair<
      Uint8Array,
      Uint8Array
    >,
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Builds a real archive: local headers, central directory and EOCD. */
async function makeZip(
  entries: Array<{ path: string; body: string; compress?: boolean }>,
): Promise<Uint8Array> {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.path);
    const raw = encoder.encode(entry.body);
    const method = entry.compress ? 8 : 0;
    const data = entry.compress ? await deflate(raw) : raw;

    const local = new Uint8Array(30 + name.byteLength + data.byteLength);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x0403_4b50, true);
    localView.setUint16(8, method, true);
    localView.setUint32(14, crc32(raw), true);
    localView.setUint32(18, data.byteLength, true);
    localView.setUint32(22, raw.byteLength, true);
    localView.setUint16(26, name.byteLength, true);
    local.set(name, 30);
    local.set(data, 30 + name.byteLength);
    locals.push(local);

    const central = new Uint8Array(46 + name.byteLength);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x0201_4b50, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(16, crc32(raw), true);
    centralView.setUint32(20, data.byteLength, true);
    centralView.setUint32(24, raw.byteLength, true);
    centralView.setUint16(28, name.byteLength, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);
    centrals.push(central);

    offset += local.byteLength;
  }

  const directoryBytes = centrals.reduce(
    (sum, part) => sum + part.byteLength,
    0,
  );
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x0605_4b50, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, directoryBytes, true);
  eocdView.setUint32(16, offset, true);

  const parts = [...locals, ...centrals, eocd];
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const archive = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    archive.set(part, at);
    at += part.byteLength;
  }
  return archive;
}

describe("stripCommonRoot", () => {
  it("drops the wrapper a picker or an archive adds", () => {
    expect(stripCommonRoot(["site/index.html", "site/a.css"])).toEqual([
      "index.html",
      "a.css",
    ]);
  });

  it("keeps paths that only look like they share a root", () => {
    // Two real top-level directories: removing anything would flatten the site.
    expect(stripCommonRoot(["docs/index.html", "assets/a.css"])).toEqual([
      "docs/index.html",
      "assets/a.css",
    ]);
  });

  it("unwraps more than one level of nesting", () => {
    expect(stripCommonRoot(["out/site/index.html", "out/site/a.css"])).toEqual([
      "index.html",
      "a.css",
    ]);
  });
});

describe("reading a site out of a zip", () => {
  it("reads stored and deflated entries alike", async () => {
    const archive = await makeZip([
      { path: "index.html", body: "<h1>hola</h1>" },
      { path: "a.css", body: "body{color:red}".repeat(40), compress: true },
    ]);
    const entries = await readZip(archive);
    const decoder = new TextDecoder();

    expect(entries.map((entry) => entry.path)).toEqual(["index.html", "a.css"]);
    expect(decoder.decode(entries[0]?.bytes)).toBe("<h1>hola</h1>");
    expect(decoder.decode(entries[1]?.bytes)).toBe(
      "body{color:red}".repeat(40),
    );
  });

  it("leaves out what an operating system added", async () => {
    const gathered = await gatherFromZipBytes(
      await makeZip([
        { path: "site/index.html", body: "<h1>hola</h1>" },
        { path: "site/.DS_Store", body: "junk" },
        { path: "__MACOSX/site/._index.html", body: "junk" },
      ]),
    );

    expect(gathered.files.map((file) => file.path)).toEqual(["index.html"]);
    expect(gathered.skipped).toHaveLength(2);
  });

  it("refuses a site with no index.html rather than publishing a dead name", async () => {
    await expect(
      gatherFromZipBytes(await makeZip([{ path: "about.html", body: "x" }])),
    ).rejects.toThrow(/index\.html/u);
  });

  it("produces a bundle the reader accepts", async () => {
    const gathered = await gatherFromZipBytes(
      await makeZip([
        { path: "site/index.html", body: "<h1>hola</h1>" },
        { path: "site/a.css", body: "body{color:red}", compress: true },
      ]),
    );
    // The round trip the publisher does before anything leaves the browser.
    const bundle = unpackSite(packSite(gathered.files));
    expect(bundle.files).toHaveLength(2);
    expect(bundle.get("a.css")?.type).toBe("text/css");
  });
});

describe("the indexing opt-in", () => {
  it("treats a site that says nothing as one that said no", () => {
    const bundle = unpackSite(
      packSite([
        { path: "index.html", type: "text/html", bytes: encoder.encode("x") },
      ]),
    );
    expect(readSiteManifest(bundle).index).toBe(false);
  });

  it("reads an opt-in, and refuses to trust a broken one", () => {
    const withOptIn = unpackSite(
      packSite([
        { path: "index.html", type: "text/html", bytes: encoder.encode("x") },
        {
          path: "capsule.json",
          type: "application/json",
          bytes: encoder.encode('{"index":true,"description":"a site"}'),
        },
      ]),
    );
    expect(readSiteManifest(withOptIn)).toMatchObject({
      index: true,
      description: "a site",
    });

    const broken = unpackSite(
      packSite([
        { path: "index.html", type: "text/html", bytes: encoder.encode("x") },
        {
          path: "capsule.json",
          type: "application/json",
          bytes: encoder.encode("not json at all"),
        },
      ]),
    );
    expect(readSiteManifest(broken).index).toBe(false);
  });
});
