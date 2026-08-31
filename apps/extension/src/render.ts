import {
  normalizeSitePath,
  siteContentType,
  type SiteBundle,
  type SiteFile,
} from "@capsule/protocol";

/**
 * Turning a page from a bundle into something a browser can display without
 * ever letting it talk to the outside world.
 *
 * The site is untrusted content. It was written by whoever holds a key, it
 * arrived through relays nobody vouches for, and it is about to run inside the
 * browser of someone who came here specifically to not be watched. So the
 * document is rebuilt rather than displayed:
 *
 * - every reference that resolves inside the bundle becomes a `data:` URL or a
 *   link back into the viewer;
 * - every reference that points outside is removed, or turned into a click the
 *   visitor has to confirm;
 * - a Content-Security-Policy is put at the top of the document, and the frame
 *   it lands in is sandboxed into an opaque origin.
 *
 * With scripts off — the default — the result cannot issue a single network
 * request. Not an image, not a font, not a beacon. A `.capsule` site does not
 * learn the address of the person reading it, and neither does anyone the site
 * might have wanted to tell.
 */

/** Directives shared by both modes. Scripts are added only when asked for. */
function policy(allowScripts: boolean): string {
  return [
    "default-src 'none'",
    "img-src data:",
    "media-src data:",
    "font-src data:",
    "style-src 'unsafe-inline' data:",
    allowScripts ? "script-src 'unsafe-inline' data:" : "script-src 'none'",
    "frame-src 'none'",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

export interface RenderOptions {
  bundle: SiteBundle;
  /** Bundle path of the page being rendered. */
  path: string;
  /** `<label>.capsule`, used to build links back into the viewer. */
  name: string;
  /** Absolute URL of the viewer page. */
  viewerUrl: string;
  allowScripts?: boolean;
  /** Injected in tests; defaults to the page's own DOMParser. */
  parse?: (html: string) => Document;
}

export interface RenderedPage {
  html: string;
  /** Subresources dropped because they pointed outside the site. */
  blockedExternals: string[];
  /** Links that leave CAPSULE; the viewer asks before following one. */
  externalLinks: string[];
}

const ASSET_ATTRIBUTES = ["src", "poster", "data-src", "data"];
/** Anything carrying a URL that is not an ordinary link or stylesheet. */
const STRAY_URL_ATTRIBUTES = ["href", "xlink:href"];
const MAX_CSS_DEPTH = 4;

function directoryOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut + 1);
}

/** Resolves a reference the way a browser would, but only inside the bundle. */
export function resolveReference(
  reference: string,
  fromPath: string,
): string | undefined {
  const value = reference.trim();
  if (value === "") return undefined;
  if (value.startsWith("#")) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(value)) return undefined;
  if (value.startsWith("//")) return undefined;

  const base = value.startsWith("/") ? "" : directoryOf(fromPath);
  const joined = `${base}${value.replace(/^\//u, "")}`;

  const segments: string[] = [];
  for (const segment of joined.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return undefined;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  // A trailing slash is the difference between `about` and `about/index.html`,
  // and splitting on "/" throws it away, so it is put back before normalising.
  const suffix = joined === "" || joined.endsWith("/") ? "/" : "";
  return normalizeSitePath(`/${segments.join("/")}${suffix}`);
}

function isExternal(reference: string): boolean {
  const value = reference.trim();
  if (value.startsWith("#")) return false;
  return /^(https?:|\/\/|mailto:|tel:)/iu.test(value);
}

export function base64(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step));
  }
  return btoa(binary);
}

function dataUrl(file: SiteFile): string {
  return `data:${file.type || siteContentType(file.path)};base64,${base64(file.bytes)}`;
}

/** Rewrites `url(...)` inside a stylesheet, following imports a few levels. */
function rewriteCss(
  css: string,
  fromPath: string,
  bundle: SiteBundle,
  depth: number,
): string {
  if (depth > MAX_CSS_DEPTH) return "";
  // `@import "x"` is the same reference as `@import url("x")` and has to be
  // rewritten too; normalising it here means one code path handles both.
  const normalised = css.replace(
    /@import\s+(['"])([^'"]+)\1/giu,
    (_match, _quote: string, reference: string) =>
      `@import url("${reference}")`,
  );
  return normalised.replace(
    /url\(\s*(['"]?)([^'")]+)\1\s*\)/giu,
    (match, _quote: string, reference: string) => {
      const target = resolveReference(reference, fromPath);
      if (!target) return isExternal(reference) ? "url(about:blank)" : match;
      const file = bundle.get(target);
      if (!file) return "url(about:blank)";
      if (target.endsWith(".css")) {
        return `url(data:text/css;base64,${base64(
          new TextEncoder().encode(
            rewriteCss(
              new TextDecoder().decode(file.bytes),
              target,
              bundle,
              depth + 1,
            ),
          ),
        )})`;
      }
      return `url(${dataUrl(file)})`;
    },
  );
}

function assetUrl(
  reference: string,
  fromPath: string,
  bundle: SiteBundle,
): string | undefined {
  const target = resolveReference(reference, fromPath);
  if (!target) return undefined;
  const file = bundle.get(target);
  if (!file) return undefined;
  if (target.endsWith(".css")) {
    const rewritten = rewriteCss(
      new TextDecoder().decode(file.bytes),
      target,
      bundle,
      1,
    );
    return `data:text/css;base64,${base64(new TextEncoder().encode(rewritten))}`;
  }
  return dataUrl(file);
}

export function renderSitePage(options: RenderOptions): RenderedPage {
  const { bundle, path, name, viewerUrl } = options;
  const allowScripts = options.allowScripts === true;
  const file = bundle.get(path);
  if (!file) throw new Error(`${path} is not in this site`);

  const parse =
    options.parse ??
    ((html: string) => new DOMParser().parseFromString(html, "text/html"));
  const document = parse(new TextDecoder().decode(file.bytes));
  const blockedExternals: string[] = [];
  const externalLinks: string[] = [];

  const internalLink = (target: string): string =>
    `${viewerUrl}#http://${name}/${target}`;
  const externalLink = (target: string): string =>
    `${viewerUrl}#external:${encodeURIComponent(target)}`;

  // A `<base>` would silently undo every rewrite below it.
  for (const element of [...document.querySelectorAll("base")]) {
    element.remove();
  }
  // A refresh is a navigation the visitor never asked for.
  for (const element of [...document.querySelectorAll("meta")]) {
    if (
      (element.getAttribute("http-equiv") ?? "").toLowerCase() === "refresh"
    ) {
      element.remove();
    }
  }

  for (const anchor of [...document.querySelectorAll("a[href], area[href]")]) {
    const href = anchor.getAttribute("href") ?? "";
    if (href.startsWith("#")) continue;
    const target = resolveReference(href, path);
    if (target && bundle.get(target)) {
      anchor.setAttribute("href", internalLink(target));
      anchor.setAttribute("target", "_top");
      continue;
    }
    if (isExternal(href)) {
      externalLinks.push(href);
      anchor.setAttribute("href", externalLink(href));
      // A page that asked for a new tab gets one; anything else goes to the
      // top context, because the frame itself must never be the thing that
      // navigates. `_blank` is not the loose option here: the pair below is
      // set either way, so the opened tab gets no `window.opener` and no
      // referrer, and the destination still passes through the confirmation
      // that names where it goes.
      const wants = (anchor.getAttribute("target") ?? "").toLowerCase();
      anchor.setAttribute("target", wants === "_blank" ? "_blank" : "_top");
      anchor.setAttribute("rel", "noreferrer noopener");
      continue;
    }
    anchor.removeAttribute("href");
  }

  for (const element of [
    ...document.querySelectorAll("[src], [poster], [data-src], [data]"),
  ]) {
    for (const attribute of ASSET_ATTRIBUTES) {
      const reference = element.getAttribute(attribute);
      if (reference === null) continue;
      const url = assetUrl(reference, path, bundle);
      if (url) {
        element.setAttribute(attribute, url);
        continue;
      }
      if (isExternal(reference)) blockedExternals.push(reference);
      element.removeAttribute(attribute);
    }
  }

  for (const element of [...document.querySelectorAll("[srcset]")]) {
    const rewritten = (element.getAttribute("srcset") ?? "")
      .split(",")
      .map((candidate) => {
        const [reference, ...rest] = candidate.trim().split(/\s+/u);
        const url = reference ? assetUrl(reference, path, bundle) : undefined;
        if (!url) {
          if (reference && isExternal(reference))
            blockedExternals.push(reference);
          return undefined;
        }
        return [url, ...rest].join(" ");
      })
      .filter((candidate): candidate is string => candidate !== undefined);
    if (rewritten.length > 0) {
      element.setAttribute("srcset", rewritten.join(", "));
    } else {
      element.removeAttribute("srcset");
    }
  }

  for (const link of [...document.querySelectorAll("link[href]")]) {
    const reference = link.getAttribute("href") ?? "";
    const url = assetUrl(reference, path, bundle);
    if (url) {
      link.setAttribute("href", url);
      continue;
    }
    if (isExternal(reference)) blockedExternals.push(reference);
    link.remove();
  }

  // Anything else that carries a URL: an SVG `<use>`, an `xlink:href`, an
  // `href` on an element that is neither a link nor a stylesheet. The policy
  // already blocks these, but a reference that never reaches the document
  // cannot become a bug in whatever parses it next.
  for (const element of [
    ...document.querySelectorAll("[href], [xlink\\:href]"),
  ]) {
    const tag = element.tagName.toLowerCase();
    if (tag === "a" || tag === "area" || tag === "link") continue;
    for (const attribute of STRAY_URL_ATTRIBUTES) {
      const reference = element.getAttribute(attribute);
      if (reference === null) continue;
      const url = assetUrl(reference, path, bundle);
      if (url) {
        element.setAttribute(attribute, url);
        continue;
      }
      if (isExternal(reference)) blockedExternals.push(reference);
      element.removeAttribute(attribute);
    }
  }

  for (const style of [...document.querySelectorAll("style")]) {
    style.textContent = rewriteCss(style.textContent ?? "", path, bundle, 1);
  }
  for (const element of [...document.querySelectorAll("[style]")]) {
    element.setAttribute(
      "style",
      rewriteCss(element.getAttribute("style") ?? "", path, bundle, 1),
    );
  }

  if (!allowScripts) {
    for (const script of [...document.querySelectorAll("script")]) {
      script.remove();
    }
  }

  // A form that cannot submit anywhere is better than one that looks like it
  // can. `form-action 'none'` already blocks it; this makes it visible.
  for (const form of [...document.querySelectorAll("form[action]")]) {
    form.removeAttribute("action");
  }

  const head = document.head ?? document.documentElement;
  const meta = document.createElement("meta");
  meta.setAttribute("http-equiv", "Content-Security-Policy");
  meta.setAttribute("content", policy(allowScripts));
  head.insertBefore(meta, head.firstChild);

  return {
    html: `<!doctype html>${document.documentElement.outerHTML}`,
    blockedExternals: [...new Set(blockedExternals)],
    externalLinks: [...new Set(externalLinks)],
  };
}

/** Sandbox flags for the frame a rendered page goes into. */
export function sandboxFor(allowScripts: boolean): string {
  // Without `allow-scripts` the frame runs no code at all, so the only thing
  // that can navigate anywhere is a real click on a link this renderer wrote,
  // and letting the frame take the tab there is safe.
  //
  // With scripts on it is not. A navigation is not a request: no CSP directive
  // has covered one since `navigate-to` left the standard, so a script that
  // could reach the top browsing context could take the visitor — and anything
  // it put in the URL — to an address of its choosing on any click. So the
  // frame does not get that reach, and the links the renderer wrote ask the
  // viewer to navigate instead. See `frameNavigation`.
  return allowScripts
    ? "allow-scripts"
    : "allow-top-navigation-by-user-activation";
}

/**
 * What the viewer should do when the sandboxed frame asks to navigate.
 *
 * The frame cannot reach the top browsing context, so with scripts on every
 * link goes through a message asking the viewer to do it. That message comes
 * from a document a site's own scripts share, so it is a request, not an
 * instruction: this decides what is honoured.
 *
 * Returns the fragment to move to, or `undefined` for anything that is not a
 * destination the renderer would have written. An address outside CAPSULE is
 * never followed here — it becomes the same confirmation a visitor gets when
 * they click one with scripts off, naming where they are about to go.
 */
export function frameNavigation(options: {
  href: string;
  viewerUrl: string;
  /** The site currently on screen, as `<label>.capsule`. */
  name: string;
}): string | undefined {
  const { href, viewerUrl, name } = options;
  let url: URL;
  try {
    url = new URL(href, viewerUrl);
  } catch {
    return undefined;
  }

  // Every link the renderer wrote points back at the viewer with the real
  // destination in the fragment. Anything else was invented by a script.
  //
  // Compared field by field rather than through `origin`, which is the string
  // "null" for a scheme the URL standard does not call special — and
  // `chrome-extension:` is one of those wherever this runs outside Chrome.
  const page = (value: URL): string =>
    `${value.protocol}//${value.host}${value.pathname}`;
  if (page(url) !== page(new URL(viewerUrl))) {
    return url.protocol === "http:" || url.protocol === "https:"
      ? `#external:${encodeURIComponent(url.href)}`
      : undefined;
  }

  const raw = decodeURIComponent(url.hash.replace(/^#/u, ""));
  if (raw.startsWith("external:")) return url.hash;

  let destination: URL;
  try {
    destination = new URL(raw.includes("://") ? raw : `http://${raw}`);
  } catch {
    return undefined;
  }
  // Only within the site on screen. Reaching a different name is not something
  // a rebuilt page can express, so a message asking for one is not honoured.
  return destination.hostname.toLowerCase() === name.toLowerCase()
    ? url.hash
    : undefined;
}
