import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  decodeShareCapability,
  readSiteManifest,
  siteContentType,
  type CapsuleSiteRecord,
  type SiteFile,
} from "@capsule/protocol";
import {
  discoverRelays,
  fetchSiteBundle,
  listRelaySites,
  loadSiteIdentity,
  publishSite,
  type FetchLike,
  type RelaySeed,
  type SiteIdentityFile,
} from "@capsule/sdk";
import type { Command } from "commander";
import { parseTtl, defaultRelayUrl } from "./options.js";

/**
 * `capsule index` — building a directory of `.capsule` sites.
 *
 * Three things about this are worth stating before the code, because each one
 * is a constraint somebody will otherwise mistake for a bug.
 *
 * **Being listed is opt in, and silence means no.** A relay will tell anyone
 * the names it holds — that endpoint exists so relays can gossip records — so
 * discovering a site says nothing about permission to catalogue it. The
 * permission is `capsule.json` inside the bundle, and a site that carries none
 * is skipped. Publishing openly is not the same as asking to be indexed.
 *
 * **The result is a static site, because it has to be.** The index is itself
 * published under a `.capsule` name, and a `.capsule` page cannot make a single
 * network request. So there is no query API and no live search: the whole
 * directory is baked into the page, and it is as fresh as the last time this
 * command ran. That is a real limitation and the interface says so.
 *
 * **Every site is downloaded to find out whether it wanted to be here.** A
 * bundle has no partial download by design, so there is no cheap way to read
 * one file out of it. Sites that did not opt in are fetched, checked and
 * discarded. That cost is the price of the reading-pattern protection, and it
 * is paid by whoever runs the index rather than by the visitor.
 */

/** Written as escapes rather than as the bytes themselves, so it stays legible. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/gu;

const MAX_TITLE = 120;
const MAX_DESCRIPTION = 300;

export interface IndexerContext {
  json: () => boolean;
  transport: () => FetchLike | undefined;
  parseSeed: (value: string) => RelaySeed;
  discoveryScope: (seeds: RelaySeed[]) => { allowPrivateRelays?: boolean };
}

export interface Listing {
  name: string;
  title: string;
  description: string;
  lang: string;
  sequence: number;
  publishedAt: string;
  bytes: number;
}

/** Untrusted text becomes text, never markup. */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function clean(value: string | undefined, limit: number): string {
  if (!value) return "";
  // Control characters and newlines would break a listing out of its own row.
  return value.replace(CONTROL_CHARACTERS, " ").trim().slice(0, limit);
}

const STYLE = `:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;padding:2.5rem 1.25rem 4rem;font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f3efe6;color:#18352f}
main{max-width:52rem;margin:0 auto}
h1{margin:0 0 .35rem;font-size:1.9rem;letter-spacing:-.02em}
.lede{margin:0 0 .35rem;color:#5a6b65}
.built{margin:0 0 2rem;font-size:.82rem;color:#8b9691}
.filter{width:100%;padding:.7rem .9rem;margin-bottom:1.5rem;border:1px solid rgba(27,62,54,.22);border-radius:.75rem;background:#fffdf8;font:inherit}
ul{margin:0;padding:0;list-style:none}
li{padding:1.1rem 0;border-top:1px solid rgba(27,62,54,.13)}
li a{color:#18352f;font-size:1.02rem;font-weight:650;text-decoration:none;overflow-wrap:anywhere}
li a:hover{text-decoration:underline}
.addr{display:block;margin:.2rem 0;font-family:ui-monospace,monospace;font-size:.72rem;color:#8b9691;overflow-wrap:anywhere}
.desc{margin:.35rem 0 0;color:#5a6b65;font-size:.92rem}
.empty,.note{padding:1.4rem;border:1px dashed rgba(27,62,54,.22);border-radius:.9rem;color:#5a6b65;font-size:.9rem}
.note{margin-top:2.5rem;background:#fffdf8}
footer{margin-top:2rem;color:#8b9691;font-size:.8rem}
@media(prefers-color-scheme:dark){body{background:#12201d;color:#e8efec}li a{color:#e8efec}.filter{background:#18302b;color:#e8efec}.note{background:#18302b}}`;

/**
 * Filtering happens over the list that is already on the page.
 *
 * The rebuilder strips every `<script>` when a visitor has not allowed them,
 * so a page whose data lived in a script tag would show nothing at all. Here
 * the listing is the HTML: with scripts off it is a complete directory, and
 * with them on this reveals a box that hides the rows that do not match.
 */
const SCRIPT = `(function(){
  var box = document.getElementById("filter");
  if (!box) return;
  box.hidden = false;
  var rows = Array.prototype.slice.call(document.querySelectorAll("li[data-haystack]"));
  var count = document.getElementById("count");
  box.addEventListener("input", function(){
    var needle = box.value.toLowerCase().trim();
    var shown = 0;
    rows.forEach(function(row){
      var match = !needle || row.getAttribute("data-haystack").indexOf(needle) !== -1;
      row.hidden = !match;
      if (match) shown += 1;
    });
    if (count) count.textContent = String(shown);
  });
})();`;

function renderPage(listings: Listing[], builtAt: string): string {
  const rows = listings
    .map((listing) => {
      const haystack = escapeHtml(
        `${listing.title} ${listing.description} ${listing.name}`.toLowerCase(),
      );
      const address = `http://${listing.name}/`;
      return `      <li data-haystack="${haystack}">
        <a href="${escapeHtml(address)}">${escapeHtml(listing.title || listing.name)}</a>
        <code class="addr">${escapeHtml(listing.name)}</code>
        ${listing.description ? `<p class="desc">${escapeHtml(listing.description)}</p>` : ""}
      </li>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CAPSULE index</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <main>
      <h1>CAPSULE index</h1>
      <p class="lede">
        <span id="count">${listings.length}</span> site(s) that asked to be
        listed.
      </p>
      <p class="built">
        Built ${escapeHtml(builtAt)}. This page is itself a .capsule site, so it
        cannot query anything: what you see is a snapshot from when it was
        built, not a live search.
      </p>

      <input
        id="filter"
        class="filter"
        type="search"
        hidden
        placeholder="Filter this list…"
        aria-label="Filter this list"
      />

${
  listings.length > 0
    ? `      <ul>\n${rows}\n      </ul>`
    : `      <p class="empty">
        Nothing has asked to be listed yet. A site appears here when it carries
        a capsule.json saying <code>"index": true</code>.
      </p>`
}

      <p class="note">
        Being listed is something a site asks for. This index only holds sites
        whose author put an opt-in inside the site itself; a site that says
        nothing is treated as one that said no, whether or not a relay will
        admit to holding it. Nothing here was crawled into against the wishes
        of whoever published it.
      </p>

      <footer>
        Every address opens in a browser with the CAPSULE extension. Nothing on
        this page can reach the network, including this list.
      </footer>
    </main>
    <script src="search.js"></script>
  </body>
</html>
`;
}

export function generateSite(listings: Listing[], builtAt: string): SiteFile[] {
  const encoder = new TextEncoder();
  return [
    {
      path: "index.html",
      type: siteContentType("index.html"),
      bytes: encoder.encode(renderPage(listings, builtAt)),
    },
    {
      path: "style.css",
      type: siteContentType("style.css"),
      bytes: encoder.encode(STYLE),
    },
    {
      path: "search.js",
      type: siteContentType("search.js"),
      bytes: encoder.encode(SCRIPT),
    },
    // The index itself does not ask to be listed: an index of indexes is not
    // what anybody wants, and it should follow the rule it enforces.
    {
      path: "capsule.json",
      type: siteContentType("capsule.json"),
      bytes: encoder.encode(
        `${JSON.stringify({ index: false, description: "A directory of .capsule sites that asked to be listed." }, null, 2)}\n`,
      ),
    },
  ];
}

interface CrawlResult {
  listings: Listing[];
  seen: number;
  skipped: number;
  failed: number;
}

async function crawl(
  records: CapsuleSiteRecord[],
  fetchImpl: FetchLike | undefined,
  onProgress: (name: string) => void,
): Promise<CrawlResult> {
  const listings: Listing[] = [];
  let skipped = 0;
  let failed = 0;

  for (const record of records) {
    onProgress(record.name);
    try {
      const bundle = await fetchSiteBundle(
        decodeShareCapability(record.capability),
        { ...(fetchImpl ? { fetchImpl } : {}) },
      );
      const manifest = readSiteManifest(bundle);
      if (!manifest.index) {
        skipped += 1;
        continue;
      }
      listings.push({
        name: record.name,
        title: clean(record.title, MAX_TITLE),
        description: clean(manifest.description, MAX_DESCRIPTION),
        lang: clean(manifest.lang, 35),
        sequence: record.sequence,
        publishedAt: record.publishedAt,
        bytes: bundle.files.reduce(
          (sum, file) => sum + file.bytes.byteLength,
          0,
        ),
      });
    } catch {
      // A capsule that expired, a relay that went away, a bundle that will not
      // unpack: none of those is a reason to abandon the whole run.
      failed += 1;
    }
  }

  return { listings, seen: records.length, skipped, failed };
}

export function registerIndexerCommands(
  program: Command,
  context: IndexerContext,
): void {
  program
    .command("index")
    .description(
      "Build a directory of .capsule sites that asked to be listed, and publish it as one",
    )
    .option(
      "--seed <url>",
      "relay to discover the network from (repeatable)",
      (value: string, previous: string[]) => [...previous, value],
      [] as string[],
    )
    .option(
      "--key <path>",
      "site key the index is published under; omitted writes the site to --out instead",
    )
    .option(
      "--out <path>",
      "write the generated site here instead of publishing",
    )
    .option("--relay <url>", "relay that stores the index", defaultRelayUrl())
    .option("--ttl <duration>", "how long the relay keeps the index", "7d")
    .option("--sequence <n>", "version number for the published index")
    .option("--limit <n>", "records to ask each relay for", "500")
    .action(
      async (options: {
        seed: string[];
        key?: string;
        out?: string;
        relay: string;
        ttl: string;
        sequence?: string;
        limit: string;
      }) => {
        const json = context.json();
        const fetchImpl = context.transport();
        const seeds = (
          options.seed.length > 0 ? options.seed : [options.relay]
        ).map(context.parseSeed);

        const relays = await discoverRelays({
          seeds,
          ...context.discoveryScope(seeds),
          ...(fetchImpl ? { fetchImpl } : {}),
        });
        const urls = relays.map((relay) => relay.url);
        if (urls.length === 0) {
          throw new Error(
            "No relay answered, so there is nothing to build an index from.",
          );
        }

        const records = await listRelaySites(urls, {
          limit: Number.parseInt(options.limit, 10) || 500,
          ...(fetchImpl ? { fetchImpl } : {}),
        });

        if (!json) {
          process.stderr.write(
            `${urls.length} relay(s), ${records.length} name(s) known. Reading each one to see if it asked to be listed.\n`,
          );
        }

        const result = await crawl(records, fetchImpl, (name) => {
          if (!json) process.stderr.write(`  ${name}\n`);
        });

        const builtAt = new Date().toISOString();
        const files = generateSite(result.listings, builtAt);

        if (!options.key) {
          const out = resolve(options.out ?? "./capsule-index");
          for (const file of files) {
            const target = join(out, file.path);
            await mkdir(dirname(target), { recursive: true });
            await writeFile(target, file.bytes);
          }
          if (json) {
            process.stdout.write(
              `${JSON.stringify({ ...result, out, builtAt }, null, 2)}\n`,
            );
            return;
          }
          process.stdout.write(
            `Listed ${result.listings.length} of ${result.seen} name(s); ${result.skipped} did not ask, ${result.failed} could not be read.\nWrote ${out}\n\nPublish it with:\n  capsule site publish ${out} --key <your key>\n`,
          );
          return;
        }

        const keyFile = JSON.parse(
          await readFile(resolve(options.key), "utf8"),
        ) as SiteIdentityFile;
        const identity = await loadSiteIdentity(keyFile);

        const published = await publishSite({
          identity,
          files,
          relayUrl: options.relay,
          ttlSeconds: parseTtl(options.ttl),
          sequence: Number.parseInt(options.sequence ?? "", 10) || Date.now(),
          title: "CAPSULE index",
          ...(fetchImpl ? { fetchImpl } : {}),
        });

        if (json) {
          process.stdout.write(
            `${JSON.stringify({ ...result, name: published.name, sequence: published.record.sequence, announcedTo: published.announcedTo, builtAt }, null, 2)}\n`,
          );
          return;
        }
        process.stdout.write(
          `Listed ${result.listings.length} of ${result.seen} name(s); ${result.skipped} did not ask, ${result.failed} could not be read.\n\nIndex published at:\n  http://${published.name}/\n\nAnnounced to ${published.announcedTo.length} relay(s). Run this again to refresh it;\nthe page is a snapshot, not a live search.\n`,
        );
      },
    );
}
