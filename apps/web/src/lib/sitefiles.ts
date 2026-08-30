import { siteContentType, type SiteFile } from "@capsule/protocol";
import { readZip } from "./zip";

/**
 * Turning what somebody dropped into the page into a site bundle.
 *
 * The same `SiteFile[]` the CLI builds by walking a directory, built here from
 * a folder picker or a zip. Everything after this point — packing, encrypting,
 * signing, announcing — is the code the CLI already uses, unchanged.
 */

/** Matches the CLI's ceiling, so a site that publishes here publishes there. */
export const MAX_SITE_FILES = 4096;
export const MAX_SITE_BYTES = 64 * 1024 * 1024;

/**
 * Files that are on the disk because an operating system put them there, not
 * because anybody wants them served. Publishing them would leak the shape of
 * the author's machine into a bundle that cannot be edited afterwards.
 */
const JUNK = [
  /(^|\/)\.DS_Store$/u,
  /(^|\/)Thumbs\.db$/u,
  /(^|\/)desktop\.ini$/u,
  /^__MACOSX\//u,
  /(^|\/)\.git\//u,
  /(^|\/)node_modules\//u,
];

function isJunk(path: string): boolean {
  return JUNK.some((pattern) => pattern.test(path));
}

/**
 * Drops the wrapper directory a zip or a folder picker adds.
 *
 * Both give paths beginning with the folder that was chosen, so a site would
 * publish with every page one level down and no `index.html` at the root. The
 * prefix is only removed when *every* file shares it, because a site whose
 * files genuinely live in different top-level directories has no wrapper to
 * strip.
 */
export function stripCommonRoot(paths: string[]): string[] {
  if (paths.length === 0) return paths;
  const first = paths[0] as string;
  const slash = first.indexOf("/");
  if (slash <= 0) return paths;
  const prefix = first.slice(0, slash + 1);
  if (!paths.every((path) => path.startsWith(prefix))) return paths;
  const stripped = paths.map((path) => path.slice(prefix.length));
  // One more level may be wrapping it; a nested single root is common in
  // archives made by a build tool.
  return stripCommonRoot(stripped);
}

export interface GatheredSite {
  files: SiteFile[];
  totalBytes: number;
  /** Paths that were left out, so the interface can say so rather than hide it. */
  skipped: string[];
}

function assemble(
  named: Array<{ path: string; bytes: Uint8Array }>,
): GatheredSite {
  const skipped: string[] = [];
  const kept = named.filter((entry) => {
    if (isJunk(entry.path)) {
      skipped.push(entry.path);
      return false;
    }
    return true;
  });

  const roots = stripCommonRoot(kept.map((entry) => entry.path));
  const files: SiteFile[] = kept.map((entry, index) => ({
    path: roots[index] as string,
    type: siteContentType(roots[index] as string),
    bytes: entry.bytes,
  }));

  if (files.length === 0) {
    throw new Error("There are no files to publish here.");
  }
  if (files.length > MAX_SITE_FILES) {
    throw new Error(`A site holds at most ${MAX_SITE_FILES} files.`);
  }
  const totalBytes = files.reduce(
    (sum, file) => sum + file.bytes.byteLength,
    0,
  );
  if (totalBytes > MAX_SITE_BYTES) {
    throw new Error("This site is larger than 64 MiB.");
  }
  if (!files.some((file) => file.path === "index.html")) {
    throw new Error(
      "There is no index.html at the top of this site, so it would open on nothing.",
    );
  }
  return { files, totalBytes, skipped };
}

/** From a `<input type="file" webkitdirectory>` selection. */
export async function gatherFromFolder(
  selection: readonly File[],
): Promise<GatheredSite> {
  const named = await Promise.all(
    selection.map(async (file) => ({
      // `webkitRelativePath` is the path inside the chosen folder, which is
      // exactly what a bundle entry wants. It is empty for a lone file.
      path: (file.webkitRelativePath || file.name).replaceAll("\\", "/"),
      bytes: new Uint8Array(await file.arrayBuffer()),
    })),
  );
  return assemble(named);
}

/** From the bytes of a `.zip`. Separate so it can be tested without a File. */
export async function gatherFromZipBytes(
  bytes: Uint8Array,
): Promise<GatheredSite> {
  return assemble(await readZip(bytes));
}

/** From a single `.zip` the person chose. */
export async function gatherFromZip(archive: File): Promise<GatheredSite> {
  return gatherFromZipBytes(new Uint8Array(await archive.arrayBuffer()));
}
