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
 * `capsule index`: building a directory of `.capsule` sites.
 *
 * Three things about this are worth stating before the code, because each one
 * is a constraint somebody will otherwise mistake for a bug.
 *
 * **Being listed is opt in, and silence means no.** A relay will tell anyone
 * the names it holds, that endpoint exists so relays can gossip records, so
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
/** Entries per page. Paging is HTML files, so this works with no scripts. */
const PAGE_SIZE = 50;

/**
 * The index reads in three languages without running anything.
 *
 * A `.capsule` page cannot execute a script unless the visitor allows it for
 * that site, so choosing a language at runtime is not available. Each language
 * is a directory of its own instead, and the switcher is three links. English
 * sits at the root because something has to.
 */
const LOCALES = ["en", "es", "pt"] as const;
type Locale = (typeof LOCALES)[number];

interface Strings {
  title: string;
  listed: string;
  built: string;
  snapshot: string;
  empty: string;
  optIn: string;
  filterPlaceholder: string;
  filterHint: string;
  filterScope: string;
  published: string;
  opensNewTab: string;
  page: string;
  previous: string;
  next: string;
  footer: string;
  language: string;
}

const STRINGS: Record<Locale, Strings> = {
  en: {
    title: "CAPSULE index",
    listed: "site(s) that asked to be listed",
    built: "Indexed",
    snapshot:
      "This page is itself a .capsule site, so it cannot query anything: what you see is a snapshot from when it was built, not a live search.",
    empty:
      'Nothing has asked to be listed yet. A site appears here when it carries a capsule.json saying "index": true.',
    optIn:
      "Being listed is something a site asks for. This index only holds sites whose author put an opt-in inside the site itself; a site that says nothing is treated as one that said no, whether or not a relay will admit to holding it. Nothing here was crawled into against the wishes of whoever published it.",
    filterPlaceholder: "Filter this page…",
    filterHint:
      "There is no search box because scripts are off, which is the default and the reason this page cannot watch you. Allowing scripts for this site turns the list into a filter you can type in. Nothing is sent anywhere either way: the filter only hides rows that are already on the page.",
    filterScope: "The filter covers this page only, not the other pages.",
    published: "Published",
    opensNewTab: "opens in a new tab",
    page: "Page",
    previous: "Previous",
    next: "Next",
    footer:
      "Every address opens in a browser with the CAPSULE extension. Nothing on this page can reach the network, including this list.",
    language: "Language",
  },
  es: {
    title: "Índice de CAPSULE",
    listed: "sitio(s) que pidieron ser listados",
    built: "Indexado",
    snapshot:
      "Esta página es ella misma un sitio .capsule, así que no puede consultar nada: lo que ves es una foto de cuando se construyó, no una búsqueda en vivo.",
    empty:
      'Todavía nadie pidió ser listado. Un sitio aparece acá cuando lleva un capsule.json que dice "index": true.',
    optIn:
      "Ser listado es algo que un sitio pide. Este índice sólo tiene sitios cuyo autor puso el permiso adentro del propio sitio; a uno que no dice nada se lo trata como a uno que dijo que no, admita o no un relay que lo tiene. Nada de lo que está acá fue rastreado en contra de quien lo publicó.",
    filterPlaceholder: "Filtrar esta página…",
    filterHint:
      "No hay caja de búsqueda porque los scripts están apagados, que es el default y la razón por la que esta página no te puede mirar. Si le permitís scripts a este sitio, la lista se convierte en un filtro donde podés escribir. En ninguno de los dos casos se manda nada a ningún lado: el filtro sólo esconde filas que ya están en la página.",
    filterScope: "El filtro cubre sólo esta página, no las otras.",
    published: "Publicado",
    opensNewTab: "abre en una pestaña nueva",
    page: "Página",
    previous: "Anterior",
    next: "Siguiente",
    footer:
      "Cada dirección abre en un navegador con la extensión CAPSULE. Nada en esta página puede alcanzar la red, esta lista incluida.",
    language: "Idioma",
  },
  pt: {
    title: "Índice da CAPSULE",
    listed: "site(s) que pediram para ser listados",
    built: "Indexado",
    snapshot:
      "Esta página é ela mesma um site .capsule, então não consegue consultar nada: o que você vê é um retrato de quando foi construída, não uma busca ao vivo.",
    empty:
      'Ninguém pediu para ser listado ainda. Um site aparece aqui quando carrega um capsule.json dizendo "index": true.',
    optIn:
      "Ser listado é algo que um site pede. Este índice só tem sites cujo autor colocou a permissão dentro do próprio site; um que não diz nada é tratado como um que disse não, admita ou não um relay que o tem. Nada aqui foi rastreado contra a vontade de quem publicou.",
    filterPlaceholder: "Filtrar esta página…",
    filterHint:
      "Não há caixa de busca porque os scripts estão desligados, que é o padrão e a razão de esta página não poder observar você. Permitir scripts para este site transforma a lista num filtro onde você pode digitar. Em nenhum dos casos algo é enviado a lugar nenhum: o filtro apenas esconde linhas que já estão na página.",
    filterScope: "O filtro cobre apenas esta página, não as outras.",
    published: "Publicado",
    opensNewTab: "abre em uma nova aba",
    page: "Página",
    previous: "Anterior",
    next: "Próxima",
    footer:
      "Cada endereço abre em um navegador com a extensão CAPSULE. Nada nesta página consegue alcançar a rede, incluindo esta lista.",
    language: "Idioma",
  },
};

const LANGUAGE_NAMES: Record<Locale, string> = {
  en: "English",
  es: "Español",
  pt: "Português",
};

const STYLE = `:root{color-scheme:light dark;--ink:#18352f;--muted:#5a6b65;--faint:#8b9691;--bg:#fffdf8;--line:rgba(27,62,54,.14);--visited:#6b4fa8;--accent:#c2543a}
@media(prefers-color-scheme:dark){:root{--ink:#e8efec;--muted:#a8b8b2;--faint:#7d8e88;--bg:#12201d;--line:rgba(255,255,255,.11);--visited:#b39ddb;--accent:#ef7959}}
*{box-sizing:border-box}
body{margin:0;padding:0;background:var(--bg);color:var(--ink);font:15px/1.58 arial,system-ui,-apple-system,sans-serif}

/* The masthead behaves the way a search engine's does: a wordmark, the box,
   and then results. Nothing else competes for the top of the page. */
.top{padding:1.6rem 1.5rem 0;border-bottom:1px solid var(--line)}
.top-in{max-width:44rem;margin:0 auto}
.brand{display:block;margin:0 0 1rem;font-size:1.35rem;font-weight:700;letter-spacing:-.02em;color:var(--ink);text-decoration:none}
.brand b{color:var(--accent);font-weight:700}
.filter{width:100%;max-width:36rem;padding:.72rem 1.1rem;border:1px solid var(--line);border-radius:999px;background:var(--bg);color:var(--ink);font:inherit;box-shadow:0 1px 5px rgba(27,62,54,.06)}
.filter:focus{outline:none;border-color:rgba(27,62,54,.34);box-shadow:0 1px 9px rgba(27,62,54,.13)}
.tabs{display:flex;gap:1.25rem;margin:.95rem 0 0;font-size:.8rem;color:var(--faint)}
.tabs a{color:var(--faint);text-decoration:none;padding-bottom:.7rem}
.tabs a:hover{color:var(--ink)}
.tabs strong{color:var(--accent);font-weight:600;padding-bottom:.7rem;border-bottom:3px solid var(--accent)}

main{max-width:44rem;margin:0 auto;padding:1.1rem 1.5rem 4rem}
.stats{margin:0 0 1.6rem;font-size:.78rem;color:var(--faint)}

/* One result: title link, then the address in green the way a URL line reads,
   then the snippet. The shape people already know how to skim. */
ul{margin:0;padding:0;list-style:none}
li{margin:0 0 1.7rem}
.addr{display:block;font-size:.78rem;color:var(--muted);overflow-wrap:anywhere}
li a.title{display:block;margin:.1rem 0 .25rem;font-size:1.24rem;line-height:1.3;font-weight:400;color:#1a5fb4;text-decoration:none;overflow-wrap:anywhere}
@media(prefers-color-scheme:dark){li a.title{color:#8ab4f8}}
li a.title:hover{text-decoration:underline}
li a.title:visited{color:var(--visited)}
.desc{margin:0;color:var(--muted);font-size:.875rem;line-height:1.58}
.meta{margin:.15rem 0 0;font-size:.75rem;color:var(--faint)}

.hint{margin:0 0 1.8rem;padding:.85rem 1rem;border:1px solid var(--line);border-radius:.6rem;font-size:.8rem;color:var(--muted)}
.empty{padding:2.5rem 0;color:var(--muted);font-size:.92rem}
.note{margin-top:3rem;padding-top:1.4rem;border-top:1px solid var(--line);color:var(--faint);font-size:.78rem;line-height:1.6}
.pager{display:flex;gap:1.4rem;align-items:center;margin-top:2.4rem;font-size:.85rem}
.pager a{color:#1a5fb4;text-decoration:none}
@media(prefers-color-scheme:dark){.pager a{color:#8ab4f8}}
.pager a:hover{text-decoration:underline}
.pager span{color:var(--faint)}
footer{margin-top:2rem;color:var(--faint);font-size:.75rem}`;

/**
 * Filtering happens over the list that is already on the page.
 *
 * The rebuilder strips every `<script>` when a visitor has not allowed them,
 * so a page whose data lived in a script tag would show nothing at all. Here
 * the listing is the HTML: with scripts off it is a complete directory, and
 * with them on this reveals a box that hides the rows that do not match. It
 * also removes the paragraph explaining how to get the box, which is only
 * useful to somebody who does not have it.
 */
const SCRIPT = `(function(){
  var box = document.getElementById("filter");
  if (!box) return;
  box.hidden = false;
  var hint = document.getElementById("hint");
  if (hint) hint.textContent = hint.getAttribute("data-scope") || "";
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

function formatDate(iso: string, locale: Locale): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(
      date,
    );
  } catch {
    return iso.slice(0, 10);
  }
}

/** The file name of a page. Pages of one language share a directory. */
function pageFile(page: number): string {
  return page === 1 ? "index.html" : `page-${page}.html`;
}

/** `index.html`, `page-2.html`, and the same under a language directory. */
function pagePath(locale: Locale, page: number): string {
  const file = pageFile(page);
  return locale === "en" ? file : `${locale}/${file}`;
}

/** A link from one generated page to another, relative to the bundle. */
function relativeTo(from: Locale, to: string): string {
  return from === "en" ? to : `../${to}`;
}

function renderPage(
  listings: Listing[],
  builtAt: string,
  locale: Locale,
  page: number,
  pageCount: number,
): string {
  const s = STRINGS[locale];
  const start = (page - 1) * PAGE_SIZE;
  const slice = listings.slice(start, start + PAGE_SIZE);
  const asset = (name: string) => relativeTo(locale, name);

  const rows = slice
    .map((listing) => {
      const haystack = escapeHtml(
        `${listing.title} ${listing.description} ${listing.name}`.toLowerCase(),
      );
      const address = `http://${listing.name}/`;
      const published = formatDate(listing.publishedAt, locale);
      return `      <li data-haystack="${haystack}">
        <span class="addr">${escapeHtml(address)}</span>
        <a class="title" href="${escapeHtml(address)}" target="_blank" rel="noreferrer noopener">${escapeHtml(listing.title || listing.name)}</a>
        ${listing.description ? `<p class="desc">${escapeHtml(listing.description)}</p>` : ""}
        <p class="meta">${escapeHtml(s.published)} ${escapeHtml(published)} · ${escapeHtml(s.opensNewTab)}</p>
      </li>`;
    })
    .join("\n");

  const langs = LOCALES.map((option) =>
    option === locale
      ? `<strong>${escapeHtml(LANGUAGE_NAMES[option])}</strong>`
      : `<a href="${escapeHtml(relativeTo(locale, pagePath(option, 1)))}">${escapeHtml(LANGUAGE_NAMES[option])}</a>`,
  ).join("");

  const pager =
    pageCount > 1
      ? `      <nav class="pager" aria-label="${escapeHtml(s.page)}">
        ${page > 1 ? `<a href="${escapeHtml(pageFile(page - 1))}">← ${escapeHtml(s.previous)}</a>` : ""}
        <span>${escapeHtml(s.page)} ${page} / ${pageCount}</span>
        ${page < pageCount ? `<a href="${escapeHtml(pageFile(page + 1))}">${escapeHtml(s.next)} →</a>` : ""}
      </nav>`
      : "";

  return `<!doctype html>
<html lang="${locale}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(s.title)}</title>
    <link rel="stylesheet" href="${escapeHtml(asset("style.css"))}" />
  </head>
  <body>
    <div class="top">
      <div class="top-in">
        <a class="brand" href="${escapeHtml(pageFile(1))}">CAPSULE <b>index</b></a>
        <input
          id="filter"
          class="filter"
          type="search"
          hidden
          placeholder="${escapeHtml(s.filterPlaceholder)}"
          aria-label="${escapeHtml(s.filterPlaceholder)}"
        />
        <nav class="tabs" aria-label="${escapeHtml(s.language)}">${langs}</nav>
      </div>
    </div>

    <main>
      <p class="stats">
        <span id="count">${listings.length}</span> ${escapeHtml(s.listed)} &middot;
        ${escapeHtml(s.built)} ${escapeHtml(formatDate(builtAt, locale))}
      </p>

      <p class="hint" id="hint" data-scope="${escapeHtml(s.filterScope)}">
        ${escapeHtml(s.filterHint)}
      </p>

${
  slice.length > 0
    ? `      <ul>\n${rows}\n      </ul>`
    : `      <p class="empty">${escapeHtml(s.empty)}</p>`
}
${pager}

      <p class="note">${escapeHtml(s.snapshot)} ${escapeHtml(s.optIn)}</p>

      <footer>${escapeHtml(s.footer)}</footer>
    </main>
    <script src="${escapeHtml(asset("search.js"))}"></script>
  </body>
</html>
`;
}

export function generateSite(listings: Listing[], builtAt: string): SiteFile[] {
  const encoder = new TextEncoder();
  const pageCount = Math.max(1, Math.ceil(listings.length / PAGE_SIZE));
  const files: SiteFile[] = [];

  for (const locale of LOCALES) {
    for (let page = 1; page <= pageCount; page += 1) {
      const path = pagePath(locale, page);
      files.push({
        path,
        type: siteContentType(path),
        bytes: encoder.encode(
          renderPage(listings, builtAt, locale, page, pageCount),
        ),
      });
    }
  }

  files.push(
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
  );

  return files;
}

interface CrawlResult {
  listings: Listing[];
  seen: number;
  skipped: number;
  failed: number;
  /** Names taken from the cache without downloading anything. */
  reused: number;
}

/**
 * What the last run learned, so the next one does not learn it again.
 *
 * A bundle has no partial download by design, so finding out whether a site
 * asked to be listed costs the whole site. Doing that hourly for every name on
 * the network would spend bandwidth to re-read files nobody touched. A record
 * carries a sequence number that only moves when its author publishes again,
 * which is exactly the signal needed: same name and same sequence means the
 * same bundle, and the answer from last time still holds.
 *
 * The cache is a convenience and never a source of truth. Losing it costs one
 * slow run, and every entry is still verified the ordinary way when its
 * sequence moves.
 */
interface CachedEntry {
  sequence: number;
  /** Whether that version opted in. `false` is worth caching too. */
  listed: boolean;
  listing?: Listing;
}

interface IndexCache {
  version: 1;
  entries: Record<string, CachedEntry>;
  /** When the index was last published, so a quiet network still refreshes. */
  publishedAt?: string;
  /** What was published, to tell a real change from a re-run. */
  fingerprint?: string;
}

const EMPTY_CACHE: IndexCache = { version: 1, entries: {} };

async function readCache(path: string | undefined): Promise<IndexCache> {
  if (!path) return { ...EMPTY_CACHE };
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as IndexCache;
    if (parsed?.version !== 1 || typeof parsed.entries !== "object") {
      return { ...EMPTY_CACHE };
    }
    return { ...parsed, entries: parsed.entries ?? {} };
  } catch {
    // No cache, or one this version cannot read. A slow run is the whole cost.
    return { ...EMPTY_CACHE };
  }
}

async function writeCache(
  path: string | undefined,
  cache: IndexCache,
): Promise<void> {
  if (!path) return;
  try {
    await mkdir(dirname(resolve(path)), { recursive: true });
    await writeFile(
      resolve(path),
      `${JSON.stringify(cache, null, 2)}
`,
    );
  } catch {
    // Failing to write it costs the next run its shortcut and nothing else.
  }
}

/** What the published page depends on, so an unchanged network is detectable. */
function fingerprintOf(listings: Listing[]): string {
  return listings
    .map((listing) => `${listing.name}@${listing.sequence}`)
    .sort()
    .join(",");
}

async function crawl(
  records: CapsuleSiteRecord[],
  cache: IndexCache,
  relayUrls: string[],
  fetchImpl: FetchLike | undefined,
  onProgress: (name: string, cached: boolean) => void,
): Promise<CrawlResult> {
  const listings: Listing[] = [];
  const entries: Record<string, CachedEntry> = {};
  let skipped = 0;
  let failed = 0;
  let reused = 0;

  for (const record of records) {
    const held = cache.entries[record.name];
    if (held && held.sequence === record.sequence) {
      onProgress(record.name, true);
      entries[record.name] = held;
      if (held.listed && held.listing) listings.push(held.listing);
      else skipped += 1;
      reused += 1;
      continue;
    }

    onProgress(record.name, false);
    try {
      const bundle = await fetchSiteBundle(
        decodeShareCapability(record.capability),
        {
          // A site whose origin relay is gone is still indexable from
          // whichever relay took a copy of it.
          relayUrls,
          ...(fetchImpl ? { fetchImpl } : {}),
        },
      );
      const manifest = readSiteManifest(bundle);
      if (!manifest.index) {
        entries[record.name] = { sequence: record.sequence, listed: false };
        skipped += 1;
        continue;
      }
      const listing: Listing = {
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
      };
      entries[record.name] = {
        sequence: record.sequence,
        listed: true,
        listing,
      };
      listings.push(listing);
    } catch {
      // A capsule that expired, a relay that went away, a bundle that will not
      // unpack: none of those is a reason to abandon the whole run. It is also
      // not cached, so the next run tries again.
      failed += 1;
    }
  }

  // Only names still on the network survive, so the cache cannot outgrow it.
  cache.entries = entries;
  return { listings, seen: records.length, skipped, failed, reused };
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
    .option(
      "--cache <path>",
      "remembers which names were already read, so an unchanged site is not downloaded again",
    )
    .option(
      "--refresh-after <hours>",
      "republish even when nothing changed, so the record does not expire",
      "12",
    )
    .action(
      async (options: {
        seed: string[];
        key?: string;
        out?: string;
        relay: string;
        ttl: string;
        sequence?: string;
        limit: string;
        cache?: string;
        refreshAfter: string;
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

        const cache = await readCache(options.cache);
        const result = await crawl(
          records,
          cache,
          urls,
          fetchImpl,
          (name, cached) => {
            if (!json) {
              process.stderr.write(
                `  ${name}${cached ? " (unchanged)" : ""}\n`,
              );
            }
          },
        );

        const builtAt = new Date().toISOString();
        const files = generateSite(result.listings, builtAt);

        if (!options.key) {
          // Writing the site out is still a run: what it learned is worth
          // keeping, or a `--cache` on this path would do nothing at all.
          await writeCache(options.cache, cache);
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

        /**
         * A republish that changes nothing still costs a capsule, a record and
         * a round of gossip, so it happens only when the directory actually
         * moved. The exception is the TTL: a record nobody refreshes expires,
         * and an index that expires is worse than one that is slightly stale.
         */
        const fingerprint = fingerprintOf(result.listings);
        const publishedAt = cache.publishedAt
          ? Date.parse(cache.publishedAt)
          : Number.NaN;
        const refreshAfterMs =
          (Number.parseInt(options.refreshAfter, 10) || 12) * 3_600_000;
        const stale =
          Number.isNaN(publishedAt) ||
          Date.now() - publishedAt > refreshAfterMs;

        if (cache.fingerprint === fingerprint && !stale) {
          await writeCache(options.cache, cache);
          if (json) {
            process.stdout.write(
              `${JSON.stringify({ ...result, published: false, reason: "unchanged" }, null, 2)}
`,
            );
            return;
          }
          process.stdout.write(
            `Nothing changed: ${result.listings.length} listed, ${result.reused} read from cache. Not republishing.
`,
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

        cache.publishedAt = new Date().toISOString();
        cache.fingerprint = fingerprint;
        await writeCache(options.cache, cache);

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
