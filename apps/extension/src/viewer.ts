import {
  normalizeSitePath,
  parseSiteName,
  unpackSite,
  type SiteBundle,
} from "@capsule/protocol";
import { fetchSiteBytes, resolveSite } from "@capsule/sdk";
import {
  base64,
  frameNavigation,
  renderSitePage,
  sandboxFor,
} from "./render.js";
import {
  DEFAULT_RELAYS,
  originsOf,
  readSettings,
  writeSettings,
  type Settings,
} from "./settings.js";

/**
 * The viewer: what a `.capsule` address actually opens.
 *
 * The order of operations here is the security argument, so it is worth
 * stating before the code:
 *
 * 1. The name is parsed into a public key. If it does not parse, nothing else
 *    happens — there is no fallback, no "did you mean", no search.
 * 2. Several relays are asked for a record. Every answer is verified against
 *    the key from step 1, so a lying relay is indistinguishable from a silent
 *    one, and the newest verified record wins.
 * 3. The sequence number is compared with the highest this browser has seen
 *    for the name. Going backwards is refused: signatures stop forgery, not
 *    replay of an older signed truth.
 * 4. The capsule is downloaded and decrypted with the key from the record.
 * 5. The page is rebuilt with every reference pointing inside the bundle and
 *    handed to a sandboxed frame that cannot reach the network.
 */

const CACHE_LIMIT_BYTES = 8 * 1024 * 1024;

const bar = document.getElementById("bar") as HTMLElement;
const siteNameLabel = document.getElementById("siteName") as HTMLElement;
const badge = document.getElementById("badge") as HTMLElement;
const scriptsButton = document.getElementById("scripts") as HTMLButtonElement;
const relaysButton = document.getElementById("relays") as HTMLButtonElement;
const frame = document.getElementById("frame") as HTMLIFrameElement;
const panel = document.getElementById("panel") as HTMLElement;
const panelTitle = document.getElementById("panelTitle") as HTMLElement;
const panelBody = document.getElementById("panelBody") as HTMLElement;
const panelActions = document.getElementById("panelActions") as HTMLElement;
const panelNote = document.getElementById("panelNote") as HTMLElement;
const warn = document.getElementById("warn") as HTMLElement;

interface Target {
  name: string;
  path: string;
}

function showPanel(
  title: string,
  body: string,
  actions: Array<{ label: string; primary?: boolean; run: () => void }> = [],
  note = "",
): void {
  frame.hidden = true;
  panel.hidden = false;
  panelTitle.textContent = title;
  panelBody.textContent = body;
  panelNote.textContent = note;
  panelActions.replaceChildren();
  for (const action of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.label;
    if (action.primary) button.className = "primary";
    button.addEventListener("click", action.run);
    panelActions.append(button);
  }
}

/** `#http://<name>/<path>` or `#external:<encoded url>`. */
function readHash(): { target?: Target; external?: string } {
  const raw = decodeURIComponent(location.hash.replace(/^#/u, ""));
  if (raw.startsWith("external:")) {
    return { external: decodeURIComponent(raw.slice("external:".length)) };
  }
  if (raw === "") return {};

  const withScheme = raw.includes("://") ? raw : `http://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return {};
  }
  const path = normalizeSitePath(url.pathname) ?? "index.html";
  return { target: { name: url.hostname.toLowerCase(), path } };
}

async function ensurePermissions(relays: string[]): Promise<boolean> {
  const origins = originsOf(relays);
  if (origins.length === 0) return true;
  return chrome.permissions.contains({ origins });
}

function requestPermissions(relays: string[]): Promise<boolean> {
  return chrome.permissions.request({ origins: originsOf(relays) });
}

interface CachedBundle {
  sequence: number;
  bytes: string;
}

async function cachedBundle(name: string): Promise<CachedBundle | undefined> {
  const stored = await chrome.storage.session.get(`bundle:${name}`);
  return stored[`bundle:${name}`] as CachedBundle | undefined;
}

async function cacheBundle(
  name: string,
  sequence: number,
  bytes: Uint8Array,
): Promise<void> {
  // The session store lives in memory and is gone when the browser closes,
  // which is the right lifetime for the contents of a site someone visited.
  if (bytes.byteLength > CACHE_LIMIT_BYTES) return;
  await chrome.storage.session.set({
    [`bundle:${name}`]: { sequence, bytes: base64(bytes) },
  });
}

function decodeCached(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Puts a rebuilt page into the frame.
 *
 * Two routes, and the reason is a rule that is easy to miss: a document created
 * from `srcdoc` **inherits the Content-Security-Policy of the page embedding
 * it**, and this page's policy is `script-src 'self'`. A `<meta>` policy in the
 * written document can only add restrictions on top, never lift one, so through
 * `srcdoc` a site's own scripts can never run whatever the visitor chose.
 *
 * With scripts off that does not matter — nothing needs to execute — and
 * `srcdoc` is the simpler thing. With scripts on the page goes into a frame
 * declared under `sandbox` in the manifest, which Chrome gives its own policy
 * and an opaque origin with no extension API reachable from it.
 */
/**
 * Navigation asked for by the sandboxed frame.
 *
 * With scripts on the frame cannot reach the top browsing context — that is
 * the whole point — so the links the renderer wrote arrive here as a request
 * instead. The frame shares a global with the site's own scripts, so nothing
 * it says is trusted: `frameNavigation` decides, and an address outside
 * CAPSULE becomes the same confirmation a visitor gets with scripts off.
 */
function listenForFrameNavigation(name: string): void {
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.source !== frame.contentWindow) return;
    const data = event.data as { type?: string; href?: unknown };
    if (data?.type !== "capsule:navigate") return;
    if (typeof data.href !== "string") return;

    const hash = frameNavigation({
      href: data.href,
      viewerUrl: chrome.runtime.getURL("viewer.html"),
      name,
    });
    if (!hash) return;
    location.hash = hash;
    location.reload();
  });
}

async function show(html: string, allowScripts: boolean): Promise<void> {
  if (!allowScripts) {
    frame.removeAttribute("src");
    frame.srcdoc = html;
    return;
  }

  frame.removeAttribute("srcdoc");
  await new Promise<void>((resolve) => {
    const onMessage = (event: MessageEvent<unknown>): void => {
      if (event.source !== frame.contentWindow) return;
      if ((event.data as { type?: string })?.type !== "capsule:ready") return;
      window.removeEventListener("message", onMessage);
      // "*" because the frame has an opaque origin and cannot be named. Only
      // that frame receives it, because the message is posted into it.
      frame.contentWindow?.postMessage({ type: "capsule:render", html }, "*");
      resolve();
    };
    window.addEventListener("message", onMessage);
    frame.src = chrome.runtime.getURL("sandboxed.html");
  });
}

async function present(
  settings: Settings,
  target: Target,
  bundle: SiteBundle,
  sequence: number,
): Promise<void> {
  const file = bundle.get(target.path);
  if (!file) {
    showPanel("No such page", `${target.name} has no ${target.path}.`, [
      {
        label: "Go to the front page",
        primary: true,
        run: () => {
          location.hash = `#http://${target.name}/`;
          location.reload();
        },
      },
    ]);
    return;
  }

  const allowScripts = settings.scriptSites.includes(target.name);
  bar.hidden = false;
  siteNameLabel.textContent = `${target.name}/${target.path === "index.html" ? "" : target.path}`;
  badge.textContent = `verified · v${sequence}`;
  scriptsButton.textContent = allowScripts ? "Scripts on" : "Scripts off";

  if (!file.type.startsWith("text/html")) {
    // Anything that is not a page is shown on its own, still from a data URL,
    // so it cannot reach the network either.
    frame.hidden = false;
    panel.hidden = true;
    frame.setAttribute("sandbox", "");
    // Chunked: spreading a multi-megabyte array into String.fromCharCode
    // overflows the call stack, and a large image is an ordinary thing for a
    // site to contain.
    frame.setAttribute("src", `data:${file.type};base64,${base64(file.bytes)}`);
    return;
  }

  const rendered = renderSitePage({
    bundle,
    path: target.path,
    name: target.name,
    viewerUrl: chrome.runtime.getURL("viewer.html"),
    allowScripts,
  });

  frame.setAttribute("sandbox", sandboxFor(allowScripts));
  frame.hidden = false;
  panel.hidden = true;
  if (allowScripts) listenForFrameNavigation(target.name);
  await show(rendered.html, allowScripts);

  const notes: string[] = [];
  if (rendered.blockedExternals.length > 0) {
    notes.push(
      `${rendered.blockedExternals.length} outside resource(s) blocked — a .capsule site cannot load anything from the web.`,
    );
  }
  if (allowScripts) {
    notes.push(
      "Scripts are on for this site. A script can send the browser to an outside address, which would reveal your IP to it.",
    );
  }
  warn.textContent = notes.join(" ");
  warn.hidden = notes.length === 0;
}

async function open(target: Target): Promise<void> {
  const parsed = await parseSiteName(target.name);
  if (!parsed) {
    showPanel(
      "Not a .capsule name",
      `${target.name} is not a valid .capsule address. A name is 56 characters of base32 followed by .capsule, and its last two characters are a checksum — so a typo fails here instead of leading somewhere else.`,
    );
    return;
  }

  const settings = await readSettings();
  if (settings.relays.length === 0) {
    showPanel(
      "No relays configured",
      "The extension does not know any relay to ask about this name.",
      [
        {
          label: "Open settings",
          primary: true,
          run: () => void chrome.runtime.openOptionsPage(),
        },
      ],
      "A relay is an ordinary server anyone can run. It stores encrypted capsules and hands out signed site records; it cannot read a site or forge one.",
    );
    return;
  }

  if (!(await ensurePermissions(settings.relays))) {
    showPanel(
      "Permission needed",
      `CAPSULE has not been allowed to contact ${settings.relays.join(", ")}.`,
      [
        {
          label: "Allow",
          primary: true,
          run: () => {
            void requestPermissions(settings.relays).then((granted) => {
              if (granted) location.reload();
            });
          },
        },
      ],
      "The extension asks for the relays you configured and nothing else, so it can never see the rest of your browsing.",
    );
    return;
  }

  showPanel(
    "Resolving…",
    `Asking ${settings.relays.length} relay(s) about ${target.name}.`,
  );

  const pinned = settings.pins[parsed.name];
  let resolved;
  try {
    resolved = await resolveSite(parsed.name, settings.relays, {
      ...(pinned !== undefined ? { pinnedSequence: pinned } : {}),
    });
  } catch (error) {
    showPanel(
      "Refused an older version",
      error instanceof Error ? error.message : String(error),
      [],
      "A relay offered a version of this site older than one this browser has already seen. That is what a rollback attack looks like, so the page was not shown.",
    );
    return;
  }

  if (!resolved) {
    showPanel(
      "No record found",
      `None of the relays you asked knows ${parsed.name}.`,
      [
        {
          label: "Try again",
          primary: true,
          run: () => location.reload(),
        },
        {
          label: "Add a relay",
          run: () => void chrome.runtime.openOptionsPage(),
        },
      ],
      "Either the site was never published, or the relays it was published to are not among the ones you ask. Records spread between relays over time.",
    );
    return;
  }

  const sequence = resolved.record.sequence;
  let bytes: Uint8Array | undefined;
  const cached = await cachedBundle(parsed.name);
  if (cached && cached.sequence === sequence) {
    bytes = decodeCached(cached.bytes);
  }

  if (!bytes) {
    showPanel(
      resolved.record.title || "Loading…",
      `Downloading ${parsed.name} from ${new URL(resolved.capability.relayUrl).host}.`,
    );
    try {
      const downloaded = await fetchSiteBytes(resolved.capability);
      const bundle = unpackSite(downloaded);
      await cacheBundle(parsed.name, sequence, downloaded);
      await writeSettings({
        pins: { ...settings.pins, [parsed.name]: sequence },
      });
      await present(settings, target, bundle, sequence);
      return;
    } catch (error) {
      showPanel(
        "Could not read the site",
        error instanceof Error ? error.message : String(error),
        [{ label: "Try again", primary: true, run: () => location.reload() }],
        "The record verified, so the name is real. The capsule behind it could not be fetched or decrypted — the relay holding it may be gone.",
      );
      return;
    }
  }

  await writeSettings({ pins: { ...settings.pins, [parsed.name]: sequence } });
  await present(settings, target, unpackSite(bytes), sequence);
}

function showExternal(url: string): void {
  showPanel(
    "This link leaves CAPSULE",
    url,
    [
      {
        label: "Open in a new tab",
        primary: true,
        run: () => {
          window.open(url, "_blank", "noreferrer");
        },
      },
      { label: "Go back", run: () => history.back() },
    ],
    "Following it contacts an ordinary web server, which will see your address. CAPSULE will not do that for you without being asked.",
  );
}

relaysButton.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
});

scriptsButton.addEventListener("click", () => {
  void (async () => {
    const { target } = readHash();
    if (!target) return;
    const settings = await readSettings();
    const on = settings.scriptSites.includes(target.name);
    await writeSettings({
      scriptSites: on
        ? settings.scriptSites.filter((name) => name !== target.name)
        : [...settings.scriptSites, target.name],
    });
    location.reload();
  })();
});

window.addEventListener("hashchange", () => location.reload());

void (async () => {
  const { target, external } = readHash();
  if (external) {
    showExternal(external);
    return;
  }
  if (!target) {
    showPanel(
      "CAPSULE",
      "Open a .capsule address, or type `capsule <name>` in the address bar.",
      [
        {
          label: "Settings",
          primary: true,
          run: () => void chrome.runtime.openOptionsPage(),
        },
      ],
      `Relays configured by default: ${DEFAULT_RELAYS.join(", ") || "none"}.`,
    );
    return;
  }
  await open(target);
})();
