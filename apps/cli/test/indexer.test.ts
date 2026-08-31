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

function pageFor(listings: Listing[], path = "index.html"): string {
  const site = generateSite(listings, "2026-08-30T12:00:00.000Z");
  const page = site.find((file) => file.path === path);
  return decoder.decode(page?.bytes);
}

function many(count: number): Listing[] {
  return Array.from({ length: count }, (_, index) =>
    listing({
      title: `Site ${index}`,
      // A valid-looking distinct name per row, so paging is testable.
      name: `${String(index).padStart(2, "0")}ijvuvwrd5jqp4efjbb4hwcsmtsf6sgi3at4jeto63k7x5fkbwat2yb.capsule`,
    }),
  );
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

  it("links each site with an anchor that opens in a new tab", () => {
    const page = pageFor([listing({ title: "Recetas" })]);
    expect(page).toContain('target="_blank"');
    expect(page).toContain('rel="noreferrer noopener"');
    expect(page).toContain(
      'href="http://6dijvuvwrd5jqp4efjbb4hwcsmtsf6sgi3at4jeto63k7x5fkbwat2yb.capsule/"',
    );
  });

  it("dates each entry", () => {
    const page = pageFor([
      listing({ publishedAt: "2026-08-30T11:00:00.000Z" }),
    ]);
    expect(page).toMatch(/Published/u);
    expect(page).toMatch(/2026/u);
  });

  it("explains how to get the filter, since the box is not there yet", () => {
    // Scripts are off by default, so the page has to say what the reader is
    // missing and what turning them on would and would not do.
    const page = pageFor([listing()]);
    expect(page).toContain("Allowing scripts for this site");
    expect(page).toContain("Nothing is sent anywhere");
  });

  it("pages at fifty, in files rather than in script", () => {
    const site = generateSite(many(120), "2026-08-30T12:00:00.000Z");
    const paths = site.map((file) => file.path);
    expect(paths).toEqual(
      expect.arrayContaining(["index.html", "page-2.html", "page-3.html"]),
    );
    expect(paths).not.toContain("page-4.html");

    const first = decoder.decode(
      site.find((f) => f.path === "index.html")?.bytes,
    );
    // Fifty rows on the first page, and a link to the next one that is an
    // ordinary anchor: paging a static site cannot depend on a script.
    expect((first.match(/<li data-haystack=/gu) ?? []).length).toBe(50);
    expect(first).toContain('href="page-2.html"');
    expect(first).not.toContain("Previous");
  });

  it("does not page a list that fits on one", () => {
    const paths = generateSite(many(10), "2026-08-30T12:00:00.000Z").map(
      (file) => file.path,
    );
    expect(paths).not.toContain("page-2.html");
  });

  it("writes each language as its own directory, linked by anchors", () => {
    const site = generateSite(many(60), "2026-08-30T12:00:00.000Z");
    const paths = site.map((file) => file.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "index.html",
        "es/index.html",
        "es/page-2.html",
        "pt/index.html",
      ]),
    );

    const english = decoder.decode(
      site.find((f) => f.path === "index.html")?.bytes,
    );
    expect(english).toContain('href="es/index.html"');

    const spanish = decoder.decode(
      site.find((f) => f.path === "es/index.html")?.bytes,
    );
    // From inside a language directory every shared file is one level up.
    expect(spanish).toContain('href="../index.html"');
    expect(spanish).toContain('href="../style.css"');
    expect(spanish).toContain('href="page-2.html"');
    expect(spanish).toContain('lang="es"');
    expect(spanish).toContain("Índice de CAPSULE");
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
