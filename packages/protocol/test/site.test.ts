import { describe, expect, it } from "vitest";
import {
  CAPSULE_SITE_NAME_LENGTH,
  base32Decode,
  base32Encode,
  isSafeSitePath,
  normalizeSitePath,
  packSite,
  parseSiteName,
  siteContentType,
  siteNameFor,
  siteRecordStatement,
  signSiteRecord,
  unpackSite,
  verifySiteRecord,
  type CapsuleSiteRecord,
  type SiteFile,
} from "../src/index.js";

const encoder = new TextEncoder();

async function newSite(): Promise<{
  name: string;
  publicKey: Uint8Array;
  privateKey: CryptoKey;
}> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKey = new Uint8Array(
    await crypto.subtle.exportKey("raw", pair.publicKey),
  );
  return {
    name: await siteNameFor(publicKey),
    publicKey,
    privateKey: pair.privateKey,
  };
}

function file(path: string, body: string): SiteFile {
  return { path, type: siteContentType(path), bytes: encoder.encode(body) };
}

describe("base32", () => {
  it("round-trips arbitrary bytes", () => {
    for (let length = 0; length < 40; length += 1) {
      const bytes = crypto.getRandomValues(new Uint8Array(length));
      expect([...base32Decode(base32Encode(bytes))]).toEqual([...bytes]);
    }
  });

  it("refuses a second spelling of the same bytes", () => {
    // The final character of a 35-byte encoding carries a single significant
    // bit; the other four must be zero, or one name would have many spellings.
    const bytes = crypto.getRandomValues(new Uint8Array(35));
    const encoded = base32Encode(bytes);
    const tampered = `${encoded.slice(0, -1)}${encoded.at(-1) === "a" ? "b" : "a"}`;
    const decoded = (() => {
      try {
        return base32Decode(tampered);
      } catch {
        return undefined;
      }
    })();
    if (decoded) expect([...decoded]).not.toEqual([...bytes]);
  });
});

describe(".capsule names", () => {
  it("derives a fixed-length name from a key and reads the key back", async () => {
    const { name, publicKey } = await newSite();
    expect(name.endsWith(".capsule")).toBe(true);
    expect(name.length).toBe(CAPSULE_SITE_NAME_LENGTH + ".capsule".length);

    const parsed = await parseSiteName(name);
    expect(parsed).toBeDefined();
    expect([...(parsed?.publicKey ?? [])]).toEqual([...publicKey]);
  });

  it("accepts a URL, a trailing dot and mixed case as the same name", async () => {
    const { name } = await newSite();
    for (const spelling of [
      name,
      name.toUpperCase(),
      `${name}.`,
      `http://${name}/some/path`,
      `${name}/index.html`,
    ]) {
      expect((await parseSiteName(spelling))?.name).toBe(name);
    }
  });

  it("rejects a mistyped name instead of resolving it to nothing", async () => {
    const { name } = await newSite();
    const label = name.slice(0, -".capsule".length);
    const swapped = `${label[0] === "a" ? "b" : "a"}${label.slice(1)}.capsule`;
    expect(await parseSiteName(swapped)).toBeUndefined();
    expect(await parseSiteName("example.capsule")).toBeUndefined();
    expect(await parseSiteName("example.com")).toBeUndefined();
  });
});

describe("site records", () => {
  const base = {
    version: 1 as const,
    sequence: 3,
    publishedAt: new Date().toISOString(),
    capability: "capsule=abc",
    title: "A site",
  };

  it("verifies a record signed by the key inside its own name", async () => {
    const site = await newSite();
    const record = await signSiteRecord(
      { ...base, name: site.name },
      site.privateKey,
    );
    expect(await verifySiteRecord(record)).toBe(true);
  });

  it("refuses a record whose capability was swapped", async () => {
    const site = await newSite();
    const record = await signSiteRecord(
      { ...base, name: site.name },
      site.privateKey,
    );
    const tampered: CapsuleSiteRecord = {
      ...record,
      capability: "capsule=attacker",
    };
    expect(await verifySiteRecord(tampered)).toBe(false);
  });

  it("refuses a record signed by a different key under someone else's name", async () => {
    const victim = await newSite();
    const attacker = await newSite();
    const record = await signSiteRecord(
      { ...base, name: victim.name },
      attacker.privateKey,
    );
    expect(await verifySiteRecord(record)).toBe(false);
  });

  it("refuses a record dated in the future or long past", async () => {
    const site = await newSite();
    const future = await signSiteRecord(
      {
        ...base,
        name: site.name,
        publishedAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      site.privateKey,
    );
    expect(await verifySiteRecord(future)).toBe(false);

    const old = await signSiteRecord(
      {
        ...base,
        name: site.name,
        publishedAt: new Date(Date.now() - 400 * 86_400_000).toISOString(),
      },
      site.privateKey,
    );
    expect(await verifySiteRecord(old)).toBe(false);
    expect(await verifySiteRecord(old, { allowStale: true })).toBe(true);
  });

  it("binds every field, so no two records share a statement", async () => {
    const site = await newSite();
    const one = siteRecordStatement({ ...base, name: site.name, sequence: 1 });
    const two = siteRecordStatement({ ...base, name: site.name, sequence: 2 });
    expect(new TextDecoder().decode(one)).not.toBe(
      new TextDecoder().decode(two),
    );
  });
});

describe("site bundles", () => {
  it("round-trips a directory of files", () => {
    const files = [
      file("index.html", "<h1>hola</h1>"),
      file("assets/app.css", "body{}"),
      file("assets/deep/logo.svg", "<svg/>"),
    ];
    const bundle = unpackSite(packSite(files));
    expect(bundle.files).toHaveLength(3);
    expect(new TextDecoder().decode(bundle.get("index.html")?.bytes)).toBe(
      "<h1>hola</h1>",
    );
    expect(bundle.get("assets/app.css")?.type).toBe("text/css");
    expect(bundle.get("missing.html")).toBeUndefined();
  });

  it("insists on an index.html", () => {
    expect(() => packSite([file("page.html", "x")])).toThrow(/index\.html/u);
  });

  it("refuses unsafe paths in both directions", () => {
    for (const path of [
      "../escape.html",
      "/absolute.html",
      "a//b.html",
      "a/./b.html",
      "windows\\path.html",
      "",
    ]) {
      expect(isSafeSitePath(path)).toBe(false);
    }
    expect(isSafeSitePath("assets/app.css")).toBe(true);
  });

  it("refuses an index that points outside the bundle", () => {
    const packed = packSite([file("index.html", "hello")]);
    const decoder = new TextDecoder();
    const text = decoder.decode(packed.subarray(12, 12 + 200));
    expect(text).toContain("index.html");

    // Rebuild the bundle with a length that runs past the body.
    const magic = encoder.encode("CAPSITE1");
    const index = encoder.encode(
      JSON.stringify({
        v: 1,
        entries: [
          { path: "index.html", type: "text/html", offset: 0, length: 9_999 },
        ],
      }),
    );
    const forged = new Uint8Array(magic.length + 4 + index.length + 5);
    forged.set(magic, 0);
    new DataView(forged.buffer).setUint32(magic.length, index.length, false);
    forged.set(index, magic.length + 4);
    expect(() => unpackSite(forged)).toThrow(/out of range/u);
  });

  it("maps what a browser asks for onto a bundle path", () => {
    expect(normalizeSitePath("/")).toBe("index.html");
    expect(normalizeSitePath("/about/")).toBe("about/index.html");
    expect(normalizeSitePath("/assets/app.css?v=2")).toBe("assets/app.css");
    expect(normalizeSitePath("/a%2Fb.html")).toBe("a/b.html");
    expect(normalizeSitePath("/../secret")).toBeUndefined();
    expect(normalizeSitePath("/%2e%2e/secret")).toBeUndefined();
  });
});
