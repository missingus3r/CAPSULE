// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  packSite,
  siteContentType,
  unpackSite,
  type SiteBundle,
  type SiteFile,
} from "@capsule/protocol";
import {
  frameNavigation,
  renderSitePage,
  resolveReference,
  sandboxFor,
} from "../src/render.js";

const encoder = new TextEncoder();
const VIEWER = "chrome-extension://abc/viewer.html";
const NAME = `${"a".repeat(56)}.capsule`;

function file(path: string, body: string): SiteFile {
  return { path, type: siteContentType(path), bytes: encoder.encode(body) };
}

function bundleOf(...files: SiteFile[]): SiteBundle {
  return unpackSite(packSite(files));
}

function render(bundle: SiteBundle, path = "index.html", allowScripts = false) {
  return renderSitePage({
    bundle,
    path,
    name: NAME,
    viewerUrl: VIEWER,
    allowScripts,
  });
}

describe("reference resolution", () => {
  it("resolves relative, absolute and parent paths inside the bundle", () => {
    expect(resolveReference("app.css", "index.html")).toBe("app.css");
    expect(resolveReference("/a/b.css", "deep/page.html")).toBe("a/b.css");
    expect(resolveReference("../up.css", "deep/page.html")).toBe("up.css");
    expect(resolveReference("./same.css", "deep/page.html")).toBe(
      "deep/same.css",
    );
  });

  it("refuses to climb out of the bundle or follow a scheme", () => {
    expect(resolveReference("../../escape", "index.html")).toBeUndefined();
    expect(
      resolveReference("https://evil.test/x.js", "index.html"),
    ).toBeUndefined();
    expect(resolveReference("//evil.test/x.js", "index.html")).toBeUndefined();
    expect(
      resolveReference("javascript:alert(1)", "index.html"),
    ).toBeUndefined();
    expect(resolveReference("#anchor", "index.html")).toBeUndefined();
  });
});

describe("rendering a page", () => {
  it("inlines styles and images from the bundle as data URLs", () => {
    const bundle = bundleOf(
      file(
        "index.html",
        '<link rel="stylesheet" href="app.css"><img src="/img/logo.svg">',
      ),
      file("app.css", "body{background:url(img/logo.svg)}"),
      file("img/logo.svg", "<svg/>"),
    );
    const { html } = render(bundle);
    expect(html).toContain("data:text/css;base64,");
    expect(html).toContain("data:image/svg+xml;base64,");
    expect(html).not.toContain('href="app.css"');
  });

  it("removes every reference that points outside the site", () => {
    const bundle = bundleOf(
      file(
        "index.html",
        '<script src="https://cdn.test/a.js"></script>' +
          '<img src="https://tracker.test/pixel.gif">' +
          '<link rel="stylesheet" href="https://fonts.test/f.css">',
      ),
    );
    const { html, blockedExternals } = render(bundle);
    expect(html).not.toContain("cdn.test");
    expect(html).not.toContain("tracker.test");
    expect(html).not.toContain("fonts.test");
    expect(blockedExternals).toContain("https://tracker.test/pixel.gif");
  });

  it("sends internal links back through the viewer and keeps in-page anchors", () => {
    const bundle = bundleOf(
      file(
        "index.html",
        '<a href="/about/">about</a><a href="#section">jump</a>',
      ),
      file("about/index.html", "<p>about</p>"),
    );
    const { html } = render(bundle);
    expect(html).toContain(`${VIEWER}#http://${NAME}/about/index.html`);
    expect(html).toContain('href="#section"');
  });

  it("routes a link that leaves CAPSULE through a confirmation", () => {
    const bundle = bundleOf(
      file("index.html", '<a href="https://example.test/x">out</a>'),
    );
    const { html, externalLinks } = render(bundle);
    expect(externalLinks).toEqual(["https://example.test/x"]);
    expect(html).toContain(
      `${VIEWER}#external:${encodeURIComponent("https://example.test/x")}`,
    );
    expect(html).not.toContain('href="https://example.test/x"');
  });

  it("gives an outbound link the new tab it asked for, and nothing else one", () => {
    // The confirmation still stands in front of both: what `_blank` changes is
    // which tab the reader ends up reading it in. Anything that did not ask
    // goes to the top context, because the frame must never be what navigates.
    const bundle = bundleOf(
      file(
        "index.html",
        '<a href="https://a.test/" target="_blank">new</a>' +
          '<a href="https://b.test/">same</a>' +
          '<a href="https://c.test/" target="evil">named</a>',
      ),
    );
    const { html } = render(bundle);

    expect(html).toContain('target="_blank"');
    expect((html.match(/target="_blank"/gu) ?? []).length).toBe(1);
    expect((html.match(/target="_top"/gu) ?? []).length).toBe(2);
    // A named target would be a handle onto this tab from another document.
    expect(html).not.toContain('target="evil"');
    // Opening a tab never hands it a window.opener or a referrer.
    expect((html.match(/rel="noreferrer noopener"/gu) ?? []).length).toBe(3);
  });

  it("keeps an internal link in the same tab even when it asks for a new one", () => {
    const bundle = bundleOf(
      file("index.html", '<a href="a.html" target="_blank">next</a>'),
      file("a.html", "<p>a</p>"),
    );
    const { html } = render(bundle);
    expect(html).toContain('target="_top"');
    expect(html).not.toContain('target="_blank"');
  });

  it("drops scripts unless the visitor turned them on for this site", () => {
    const bundle = bundleOf(
      file(
        "index.html",
        "<script>fetch('https://evil.test')</script><p>hi</p>",
      ),
    );
    expect(render(bundle).html).not.toContain("evil.test");
    expect(render(bundle).html).toContain("script-src 'none'");

    const withScripts = render(bundle, "index.html", true);
    expect(withScripts.html).toContain("evil.test");
    expect(withScripts.html).toContain("script-src 'unsafe-inline' data:");
  });

  it("puts a policy that forbids every network request at the top of the head", () => {
    const bundle = bundleOf(file("index.html", "<p>hi</p>"));
    const { html } = render(bundle);
    const policy = html.slice(html.indexOf("Content-Security-Policy"));
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("form-action 'none'");
    expect(policy).not.toMatch(/https?:/u);
    // The meta must be the first thing in the head or it applies too late.
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(
      html.indexOf("<title") >= 0 ? html.indexOf("<title") : html.length,
    );
  });

  it("removes a base tag and a meta refresh that would undo the rewriting", () => {
    const bundle = bundleOf(
      file(
        "index.html",
        '<base href="https://evil.test/"><meta http-equiv="refresh" content="0;url=https://evil.test">',
      ),
    );
    const { html } = render(bundle);
    expect(html).not.toContain("<base");
    expect(html).not.toContain("refresh");
  });

  it("rewrites a bare @import as well as one written with url()", () => {
    const bundle = bundleOf(
      file("index.html", '<link rel="stylesheet" href="app.css">'),
      file("app.css", '@import "base.css";@import url("theme.css");'),
      file("base.css", "body{margin:0}"),
      file("theme.css", "body{color:red}"),
    );
    const { html } = render(bundle);
    expect(html).not.toContain("base.css");
    expect(html).not.toContain("theme.css");
  });

  it("drops an outside @import instead of leaving it to the policy", () => {
    const bundle = bundleOf(
      file("index.html", '<link rel="stylesheet" href="app.css">'),
      file("app.css", '@import "https://fonts.test/f.css";'),
    );
    const decoded = atob(
      render(bundle)
        .html.split("data:text/css;base64,")[1]
        ?.split(/["')]/u)[0] ?? "",
    );
    expect(decoded).not.toContain("fonts.test");
  });

  it("strips a URL from an object, a use element and an xlink:href", () => {
    const bundle = bundleOf(
      file(
        "index.html",
        '<object data="https://evil.test/x.swf"></object>' +
          '<svg><use href="https://evil.test/s.svg#i"></use>' +
          '<image xlink:href="https://evil.test/p.png"></image></svg>',
      ),
    );
    const { html } = render(bundle);
    expect(html).not.toContain("evil.test");
  });

  it("keeps scripts out of the sandbox unless they were allowed", () => {
    expect(sandboxFor(false)).toBe("allow-top-navigation-by-user-activation");
    expect(sandboxFor(false)).not.toContain("allow-scripts");
    expect(sandboxFor(true)).toContain("allow-scripts");
    // Never same-origin: that would put the site in the extension's origin.
    expect(sandboxFor(true)).not.toContain("allow-same-origin");
    expect(sandboxFor(false)).not.toContain("allow-same-origin");
  });

  it("never lets a page that runs scripts reach the top window", () => {
    // A navigation is not a request and no CSP directive covers one, so this
    // flag is the whole difference between a site that can take the visitor
    // somewhere on a click and one that cannot.
    expect(sandboxFor(true)).toBe("allow-scripts");
    expect(sandboxFor(true)).not.toContain("allow-top-navigation");
  });
});

describe("what the sandboxed frame is allowed to ask the viewer for", () => {
  const ask = (href: string): string | undefined =>
    frameNavigation({ href, viewerUrl: VIEWER, name: NAME });

  it("follows a link inside the site on screen", () => {
    expect(ask(`${VIEWER}#http://${NAME}/about/index.html`)).toBe(
      `#http://${NAME}/about/index.html`,
    );
  });

  it("keeps an external link behind the confirmation it already had", () => {
    const href = `${VIEWER}#external:${encodeURIComponent("https://example.org/")}`;
    expect(ask(href)).toBe(
      `#external:${encodeURIComponent("https://example.org/")}`,
    );
  });

  it("turns an address a script invented into that same confirmation", () => {
    // The point of the whole arrangement: a script cannot navigate anywhere by
    // itself, and what it asks for is shown to the visitor before it happens.
    expect(ask("https://evil.test/?stolen=1")).toBe(
      `#external:${encodeURIComponent("https://evil.test/?stolen=1")}`,
    );
  });

  it("refuses a viewer link that names a different site", () => {
    const other = `${"b".repeat(56)}.capsule`;
    expect(ask(`${VIEWER}#http://${other}/index.html`)).toBeUndefined();
  });

  it("refuses anything that is not an address at all", () => {
    expect(ask("javascript:alert(1)")).toBeUndefined();
    expect(ask("data:text/html,<b>hi</b>")).toBeUndefined();
    expect(ask("not a url")).toBeUndefined();
    expect(ask(`${VIEWER}#`)).toBeUndefined();
  });
});
