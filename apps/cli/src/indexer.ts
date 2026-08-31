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

const STYLE = `:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;padding:2.5rem 1.25rem 4rem;font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f3efe6;color:#18352f}
main{max-width:52rem;margin:0 auto}
h1{margin:0 0 .35rem;font-size:1.9rem;letter-spacing:-.02em}
.lede{margin:0 0 .35rem;color:#5a6b65}
.built{margin:0 0 1.25rem;font-size:.82rem;color:#8b9691}
.langs{margin:0 0 1.75rem;font-size:.82rem;color:#8b9691}
.langs a{color:#5a6b65;margin-right:.6rem}
.langs strong{margin-right:.6rem;color:#18352f}
.filter{width:100%;padding:.7rem .9rem;margin-bottom:.5rem;border:1px solid rgba(27,62,54,.22);border-radius:.75rem;background:#fffdf8;font:inherit}
.hint{margin:0 0 1.5rem;padding:.9rem 1.1rem;border-left:3px solid rgba(27,62,54,.22);background:#fffdf8;font-size:.86rem;color:#5a6b65}
ul{margin:0;padding:0;list-style:none}
li{padding:1.1rem 0;border-top:1px solid rgba(27,62,54,.13)}
li a{color:#18352f;font-size:1.02rem;font-weight:650;text-decoration:none;overflow-wrap:anywhere}
li a:hover{text-decoration:underline}
.addr{display:block;margin:.2rem 0;font-family:ui-monospace,monospace;font-size:.72rem;color:#8b9691;overflow-wrap:anywhere}
.desc{margin:.35rem 0 0;color:#5a6b65;font-size:.92rem}
.meta{margin:.3rem 0 0;font-size:.74rem;color:#8b9691}
.empty,.note{padding:1.4rem;border:1px dashed rgba(27,62,54,.22);border-radius:.9rem;color:#5a6b65;font-size:.9rem}
.note{margin-top:2.5rem;background:#fffdf8}
.pager{display:flex;gap:1rem;align-items:center;margin-top:1.75rem;font-size:.88rem}
.pager a{color:#18352f}
.pager span{color:#8b9691}
footer{margin-top:2rem;color:#8b9691;font-size:.8rem}
@media(prefers-color-scheme:dark){body{background:#12201d;color:#e8efec}li a,.pager a,.langs strong{color:#e8efec}.filter{background:#18302b;color:#e8efec}.note,.hint{background:#18302b}}`;

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
        <a href="${escapeHtml(address)}" target="_blank" rel="noreferrer noopener">${escapeHtml(listing.title || listing.name)}</a>
        <code class="addr">${escapeHtml(address)}</code>
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
    <main>
      <h1>${escapeHtml(s.title)}</h1>
      <p class="lede">
        <span id="count">${listings.length}</span> ${escapeHtml(s.listed)}
      </p>
      <p class="built">
        ${escapeHtml(s.built)} ${escapeHtml(formatDate(builtAt, locale))}. ${escapeHtml(s.snapshot)}
      </p>
      <p class="langs" aria-label="${escapeHtml(s.language)}">${langs}</p>

      <input
        id="filter"
        class="filter"
        type="search"
        hidden
        placeholder="${escapeHtml(s.filterPlaceholder)}"
        aria-label="${escapeHtml(s.filterPlaceholder)}"
      />
      <p class="hint" id="hint" data-scope="${escapeHtml(s.filterScope)}">
        ${escapeHtml(s.filterHint)}
      </p>

${
  slice.length > 0
    ? `      <ul>\n${rows}\n      </ul>`
    : `      <p class="empty">${escapeHtml(s.empty)}</p>`
}
${pager}

      <p class="note">${escapeHtml(s.optIn)}</p>

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
