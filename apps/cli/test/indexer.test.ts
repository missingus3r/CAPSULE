import { describe, expect, it } from "vitest";
import { generateSite, type Listing } from "../src/indexer.js";

/**
 * The index page is assembled from text other people wrote.
 *
 * A listing's title comes from a record and its description from a file inside
 * somebody else's bundle, so both are written by whoever holds a key and
 * neither is trustworthy. The page they land in is read through the extension,
 * which rebuilds it and refuses network access — but a listing that escaped
 * its row could still rewrite the directory around it, pointing a visitor at
 * an address its author never published. Escaping is the boundary, so it is
 * what these check.
 */

const decoder = new TextDecoder();

function pageFor(listings: Listing[]): string {
  const site = generateSite(listings, "2026-08-30T12:00:00.000Z");
  const index = site.find((file) => file.path === "index.html");
  return decoder.decode(index?.bytes);
}

function listing(overrides: Partial<Listing> = {}): Listing {
  return {
    name: "6dijvuvwrd5jqp4efjbb4hwcsmtsf6sgi3at4jeto63k7x5fkbwat2yb.capsule",
    title: "A site",
    description: "",
    lang: "en",
    sequence: 1,
    publishedAt: "2026-08-30T11:00:00.000Z",
    bytes: 1024,
    ...overrides,
  };
}

describe("the generated index page", () => {
  it("carries the site, its address and its description", () => {
    const page = pageFor([
      listing({ title: "Recetas", description: "Recipes nobody is selling" }),
    ]);
    expect(page).toContain("Recetas");
    expect(page).toContain("Recipes nobody is selling");
    expect(page).toContain(
      "http://6dijvuvwrd5jqp4efjbb4hwcsmtsf6sgi3at4jeto63k7x5fkbwat2yb.capsule/",
    );
    expect(page).toContain('<span id="count">1</span>');
  });

  it("escapes a title that tries to be markup", () => {
    const page = pageFor([
      listing({ title: '</a><script>alert(1)</script><a href="x' }),
    ]);
    expect(page).not.toContain("<script>alert(1)</script>");
    expect(page).toContain("&lt;script&gt;");
  });

  it("escapes a description that tries to break out of its row", () => {
    const page = pageFor([
      listing({ description: '"><img src=x onerror=alert(1)>' }),
    ]);
    expect(page).not.toContain("<img src=x");
    expect(page).toContain("&lt;img");
  });

  it("escapes the attribute the filter searches over", () => {
    // The haystack sits inside a quoted attribute; a quote in a title would
    // otherwise end it and everything after would be parsed as markup.
    const page = pageFor([listing({ title: 'a" onmouseover="alert(1)' })]);
    expect(page).not.toContain('onmouseover="alert(1)"');
    expect(page).toContain("&quot;");
  });

  it("says plainly that nothing asked to be listed", () => {
    const page = pageFor([]);
    expect(page).toContain("Nothing has asked to be listed yet");
    expect(page).toContain('<span id="count">0</span>');
  });

  it("does not ask to be indexed itself", () => {
    const site = generateSite([], "2026-08-30T12:00:00.000Z");
    const manifest = site.find((file) => file.path === "capsule.json");
    expect(manifest).toBeDefined();
    expect(
      JSON.parse(decoder.decode(manifest?.bytes)) as { index: boolean },
    ).toMatchObject({ index: false });
  });

  it("ships a stylesheet and a filter script from its own bundle", () => {
    const paths = generateSite([], "2026-08-30T12:00:00.000Z").map(
      (file) => file.path,
    );
    // Both are same-bundle references; the rebuilder turns them into data:
    // URLs, and anything pointing outside would simply be removed.
    expect(paths).toEqual(
      expect.arrayContaining(["index.html", "style.css", "search.js"]),
    );
  });
});
