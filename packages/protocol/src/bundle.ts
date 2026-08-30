/**
 * The site bundle: a whole directory of files packed into the bytes of one
 * capsule.
 *
 * There is deliberately no streaming and no partial fetch. A visitor downloads
 * the entire site or none of it, which means the relay storing it never learns
 * *which page* was read. That is a property of the format, not of the client:
 * per-file requests would leak a browsing pattern no amount of encryption
 * would put back.
 *
 * Layout:
 *
 *     "CAPSITE1"        8 bytes
 *     index length      uint32, big-endian
 *     index             UTF-8 JSON
 *     files             concatenated, in index order
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const SITE_BUNDLE_MAGIC = "CAPSITE1";
export const SITE_BUNDLE_VERSION = 1 as const;
export const MAX_SITE_ENTRIES = 4096;
export const MAX_SITE_PATH_LENGTH = 512;
export const MAX_SITE_INDEX_BYTES = 4 * 1024 * 1024;
export const SITE_INDEX_FILE = "index.html";

export interface SiteFile {
  /** Relative, `/`-separated, e.g. `index.html` or `assets/app.css`. */
  path: string;
  type: string;
  bytes: Uint8Array;
}

interface SiteIndexEntry {
  path: string;
  type: string;
  offset: number;
  length: number;
}

export interface SiteBundle {
  version: number;
  files: SiteFile[];
  get(path: string): SiteFile | undefined;
}

/**
 * Accepts only paths that can be handed to a renderer without further thought:
 * relative, no traversal, no backslashes, no control characters, no empty or
 * dot segments. A bundle is authored by whoever publishes the site, and a site
 * is untrusted content, so this runs on unpack as well as on pack.
 */
export function isSafeSitePath(path: string): boolean {
  if (typeof path !== "string") return false;
  if (path.length === 0 || path.length > MAX_SITE_PATH_LENGTH) return false;
  if (path.startsWith("/") || path.endsWith("/")) return false;
  if (path.includes("\\")) return false;
  if (/[\u0000-\u001f\u007f]/u.test(path)) return false;
  for (const segment of path.split("/")) {
    if (segment.length === 0) return false;
    if (segment === "." || segment === "..") return false;
  }
  return true;
}

const TYPES: Record<string, string> = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  txt: "text/plain",
  md: "text/markdown",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  pdf: "application/pdf",
  xml: "application/xml",
  wasm: "application/wasm",
};

export function siteContentType(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return TYPES[extension] ?? "application/octet-stream";
}

/**
 * Maps what a browser asked for onto an entry in the bundle: `/` and any
 * directory become `index.html` inside it, and percent-encoding is undone once
 * — never twice, which is how a traversal sneaks past a check like this one.
 */
export function normalizeSitePath(requested: string): string | undefined {
  let value = requested;
  const hash = value.indexOf("#");
  if (hash >= 0) value = value.slice(0, hash);
  const query = value.indexOf("?");
  if (query >= 0) value = value.slice(0, query);
  try {
    value = decodeURIComponent(value);
  } catch {
    return undefined;
  }
  value = value.replace(/^\/+/u, "");
  if (value === "" || value.endsWith("/")) value += SITE_INDEX_FILE;
  return isSafeSitePath(value) ? value : undefined;
}

export function packSite(files: readonly SiteFile[]): Uint8Array {
  if (files.length === 0)
    throw new Error("A site bundle needs at least one file");
  if (files.length > MAX_SITE_ENTRIES) {
    throw new Error(`A site bundle holds at most ${MAX_SITE_ENTRIES} files`);
  }

  const seen = new Set<string>();
  const entries: SiteIndexEntry[] = [];
  let offset = 0;
  for (const file of files) {
    if (!isSafeSitePath(file.path)) {
      throw new Error(`Unsafe path in site bundle: ${file.path}`);
    }
    if (seen.has(file.path)) {
      throw new Error(`Duplicate path in site bundle: ${file.path}`);
    }
    seen.add(file.path);
    entries.push({
      path: file.path,
      type: file.type || siteContentType(file.path),
      offset,
      length: file.bytes.byteLength,
    });
    offset += file.bytes.byteLength;
  }
  if (!seen.has(SITE_INDEX_FILE)) {
    throw new Error(`A site bundle needs an ${SITE_INDEX_FILE} at its root`);
  }

  const index = textEncoder.encode(
    JSON.stringify({ v: SITE_BUNDLE_VERSION, entries }),
  );
  if (index.byteLength > MAX_SITE_INDEX_BYTES) {
    throw new Error("The site index is too large");
  }

  const magic = textEncoder.encode(SITE_BUNDLE_MAGIC);
  const output = new Uint8Array(
    magic.byteLength + 4 + index.byteLength + offset,
  );
  output.set(magic, 0);
  new DataView(output.buffer).setUint32(
    magic.byteLength,
    index.byteLength,
    false,
  );
  output.set(index, magic.byteLength + 4);
  let cursor = magic.byteLength + 4 + index.byteLength;
  for (const file of files) {
    output.set(file.bytes, cursor);
    cursor += file.bytes.byteLength;
  }
  return output;
}

export function unpackSite(bytes: Uint8Array): SiteBundle {
  const magic = textEncoder.encode(SITE_BUNDLE_MAGIC);
  if (bytes.byteLength < magic.byteLength + 4) {
    throw new Error("Not a CAPSULE site bundle");
  }
  for (let index = 0; index < magic.byteLength; index += 1) {
    if (bytes[index] !== magic[index]) {
      throw new Error("Not a CAPSULE site bundle");
    }
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const indexLength = view.getUint32(magic.byteLength, false);
  if (indexLength > MAX_SITE_INDEX_BYTES) {
    throw new Error("The site index is too large");
  }
  const bodyStart = magic.byteLength + 4 + indexLength;
  if (bodyStart > bytes.byteLength) {
    throw new Error("The site bundle is truncated");
  }

  let parsed: { v?: number; entries?: SiteIndexEntry[] };
  try {
    parsed = JSON.parse(
      textDecoder.decode(bytes.subarray(magic.byteLength + 4, bodyStart)),
    ) as { v?: number; entries?: SiteIndexEntry[] };
  } catch {
    throw new Error("The site index is not valid JSON");
  }
  if (parsed.v !== SITE_BUNDLE_VERSION || !Array.isArray(parsed.entries)) {
    throw new Error("Unsupported site bundle version");
  }
  if (parsed.entries.length === 0 || parsed.entries.length > MAX_SITE_ENTRIES) {
    throw new Error("The site index holds an implausible number of files");
  }

  const body = bytes.subarray(bodyStart);
  const files: SiteFile[] = [];
  const byPath = new Map<string, SiteFile>();
  for (const entry of parsed.entries) {
    if (!entry || typeof entry !== "object") {
      throw new Error("Malformed entry in the site index");
    }
    if (!isSafeSitePath(entry.path)) {
      throw new Error(`Unsafe path in site bundle: ${String(entry.path)}`);
    }
    if (byPath.has(entry.path)) {
      throw new Error(`Duplicate path in site bundle: ${entry.path}`);
    }
    if (
      !Number.isSafeInteger(entry.offset) ||
      !Number.isSafeInteger(entry.length) ||
      entry.offset < 0 ||
      entry.length < 0 ||
      entry.offset + entry.length > body.byteLength
    ) {
      throw new Error(`Entry out of range in site bundle: ${entry.path}`);
    }
    const file: SiteFile = {
      path: entry.path,
      type:
        typeof entry.type === "string" &&
        entry.type.length > 0 &&
        entry.type.length < 128
          ? entry.type
          : siteContentType(entry.path),
      bytes: body.subarray(entry.offset, entry.offset + entry.length),
    };
    files.push(file);
    byPath.set(file.path, file);
  }
  if (!byPath.has(SITE_INDEX_FILE)) {
    throw new Error(`The site bundle has no ${SITE_INDEX_FILE}`);
  }

  return {
    version: SITE_BUNDLE_VERSION,
    files,
    get: (path: string) => byPath.get(path),
  };
}

/** Total bytes of files in a bundle, for reporting before a publish. */
export function siteBundleSize(files: readonly SiteFile[]): number {
  return files.reduce((total, file) => total + file.bytes.byteLength, 0);
}
