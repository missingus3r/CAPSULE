# `.capsule` sites

**Status:** implemented and working; no external audit
**Date:** 2026-08-30

## 1. First: what it protects and what it does not

A `.capsule` site is **public**. Anyone who obtains the record can read the
page, and records circulate between relays on purpose so that the name resolves
anywhere. If something has to be private it is not published as a site: it is
sent as a capsule, with its link.

What a `.capsule` site does guarantee:

- **Nobody can replace your pages** except whoever holds your key, because the
  name _is_ the key.
- **Nobody can hand you an older version** without the browser noticing.
- **The visitor tells nobody what they read**, because the page cannot make any
  network request.
- **The relay does not know what it is storing**: it receives an encrypted
  capsule, padded to a size class, under a neutral filename.

What it does not guarantee:

- **That the site keeps existing.** It lives on relays somebody maintains. If
  the capsules expire or the relays disappear, the name resolves to nothing.
- **That publishing is anonymous by itself.** The relay sees the address of
  whoever uploads, unless `--mix`, `--tor` or `--bridge` is used.
- **That nobody knows you visited.** The relay you ask sees that you asked
  about that name — unless the request goes through the mix network, which the
  CLI does with `--mix` and the extension does by default when it has enough
  relays to lay a path. When it cannot, it asks directly and says so (see §7).

## 2. The name

```
<56 base32 characters>.capsule
```

More precisely: 35 bytes in base32 with no padding, being the Ed25519 public
key (32), two checksum bytes and one version byte. That gives 56 characters
plus `.capsule`.

```
6dijvuvwrd5jqp4efjbb4hwcsmtsf6sgi3at4jeto63k7x5fkbwat2yb.capsule
```

It is ugly and unmemorable. That is the price of nobody having to issue it. It
is the same decision Tor made for onion v3 addresses, for the same reason: a
readable name needs a registry, a registry needs a registrar, and a registrar
is somebody who can be leaned on.

The checksum protects against nothing. It exists so that a mistyped name fails
in the browser instead of resolving to a different site.

- Encoding: the RFC 4648 alphabet in lowercase, no padding. The leftover bits
  of the final character must be zero, so a name has exactly one spelling.
- Checksum: `SHA-256("CAPSULE/site-name/v1" ‖ key ‖ version)[0..2]`.

## 3. The record

A record says "version N of this name is this capability":

```json
{
  "version": 1,
  "name": "<name>.capsule",
  "sequence": 7,
  "publishedAt": "2026-08-30T16:39:44.940Z",
  "capability": "capsule=eyJ2ZXJzaW9uIjoz...",
  "title": "Optional, 120 characters",
  "signature": "<base64url, 64 bytes>"
}
```

This exact text is what gets signed, fields separated by newlines and none of
them able to contain one:

```
CAPSULE/site-record/v1
<version>
<name>
<sequence>
<publishedAt>
<capability>
<title, or empty>
```

Rules the relay and the client both apply:

- The signature is verified against the key that is **inside the name**. There
  is no other source of truth.
- `sequence` may only go up. A relay keeps the highest it has seen; a browser
  keeps the highest it has accepted.
- A record dated more than ten minutes in the future is refused; so is one more
  than ninety days old, so that a stale record does not circulate forever.

## 4. The bundle

The whole site is a single capsule. The format is deliberately boring:

```
"CAPSITE1"        8 bytes
index length      uint32 big-endian
index             UTF-8 JSON
files             concatenated, in index order
```

The index is `{ "v":1, "entries":[ {"path","type","offset","length"} ] }`.

**There is no partial download, and that is on purpose.** If a visitor asked
for one file at a time, the relay would learn which pages they read.
Downloading the whole site costs more bandwidth and buys the absence of a
reading pattern.

Everything a capsule already does applies on top: end-to-end encryption,
size-class padding, mirrors, `k`-of-`n` sharing and mix routing. Nothing in the
v3 format had to change.

## 5. The relays

Three endpoints, all optional (`CAPSULE_SITES_ENABLED=false` turns them off):

| Endpoint                | What it does                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PUT /v1/sites/:name`   | Accepts a record if it verifies and its sequence moves forward. `202` if stored, `200` if it already had an equal or newer one, `400` if it does not verify. |
| `GET /v1/sites/:name`   | Returns the record, or `404`.                                                                                                                                |
| `GET /v1/sites?limit=n` | Lists recent records, for gossip between relays.                                                                                                             |

A relay keeps its records in `sites.json` inside its data directory, and
reads them back when it starts. Every restored record goes through the same
checks an announcement does — the name is re-derived from the key, the
signature is verified, the age limit applies — so a file edited on disk can no
more insert a record than a lying peer can. An unreadable file is not fatal:
the relay says so in its log and starts empty, because publishers re-announce
and gossip refills the directory.

Relays pass records to each other on every sync round, capped per round
(`CAPSULE_SITE_GOSSIP_LIMIT`, 200 by default) and in total
(`CAPSULE_MAX_SITES`, 5000). Without this a name would only resolve at the
relays its author announced to, and every visitor would have to be told which
those are — which is a registry with extra steps.

A relay can **stay silent**, not lie. That is why the client asks several and
keeps the highest sequence that verifies: for silence to be worth anything,
they would all have to be silent.

## 5b. Publishing from the web app

The same publish the CLI does, from a page. A folder picker or a `.zip` becomes
the `SiteFile[]` that `publishSite` already takes — the CLI builds that array by
walking a directory, the browser builds it from a `FileList`, and everything
after that point is identical code: the same bundle, the same encryption, the
same signed record, and the mix network underneath when it is available.

The zip reader is a hundred lines rather than a dependency: the central
directory is walked by hand and each entry inflated with `DecompressionStream`,
which the browser already has. ZIP64, encrypted entries and unusual compression
methods are refused by name rather than producing a bundle with files silently
missing. Files an operating system added — `.DS_Store`, `__MACOSX/`,
`Thumbs.db` — are dropped, and the interface says how many, because a bundle
cannot be edited after it is published.

A wrapper directory is stripped when _every_ file shares it, so a zip of
`mysite/` publishes with `index.html` at the root rather than one level down. A
site with no `index.html` at the top is refused before anything is encrypted:
the name would resolve to nothing.

### 5b.1 The key

A site key **is** the name. There is no registrar to appeal to, so the web app
does two things and neither is optional:

- **The backup leaves first.** Creating a name downloads its `.capsulekey`
  before that key is used for anything at all.
- **What stays behind cannot be read.** The browser keeps the `CryptoKey` that
  `loadSiteIdentity` produces, which Web Crypto marks non-extractable and
  usable only for signing, held in IndexedDB by structured clone so the flag
  survives. Publishing the next version is one click; what sits at rest is a
  handle that can sign and cannot be exported — not by the page, not by
  anything else that reaches this origin.

Publishing from another machine needs the file. That is the trade, and it is
the honest one: a key that exists only in a browser profile is one cleared
cache away from a name nobody can ever publish under again.

### 5b.2 Asking to be indexed

The publish form has a switch that writes `capsule.json` into the bundle:

```json
{ "index": true, "description": "One line for a search result", "lang": "en" }
```

Nothing indexes CAPSULE yet. When something does, the rule it must follow is in
[PROTOCOL.md](./PROTOCOL.md) §17.3.1: **a site that says nothing has not opted
in.** Publishing openly is not the same as asking to be catalogued, and an
index that treats silence as consent is doing something the author did not ask
for.

It lives in the bundle rather than the record because the record's signed
message is a fixed field list — adding to it would make records older clients
cannot verify, and a client that cannot verify a record refuses the site
entirely. Inside the bundle it is covered by the same signature chain as the
pages, and no version of anything had to change.

## 6. The extension

`http://<name>.capsule/` does not resolve in DNS and never will. The extension
intercepts the navigation with a `declarativeNetRequest` rule before the
browser resolves anything, and turns it into a page of its own with the
original address in the **fragment** — which never travels to any server, the
same as in a capsule link.

Then:

1. It parses the name. If it does not parse, it stops there: no search, no
   "did you mean".
2. It asks the configured relays and verifies every answer. By default the
   asking goes through the mix network — mix operation `8` carries the record
   lookup and the same path carries the capsule — so the relay holding the site
   answers without learning who asked. With fewer than two allowed relays there
   is no path to build, and it asks directly instead.
3. It compares the sequence with the highest this browser has accepted for the
   name. If it is lower, it shows an error instead of the page.
4. It downloads the capsule, decrypts it and unpacks the bundle.
5. It rebuilds the page and hands it to an isolated frame.

### 6.1 How a page is rebuilt

A site's content is not trusted: it was written by whoever holds a key and
arrived through relays nobody vouches for. So the document is not displayed, it
is remade:

- Every reference that resolves inside the bundle becomes a `data:` URL —
  stylesheets, images, fonts, `srcset`, `url()` inside CSS.
- Every reference pointing outside is removed.
- Internal links point back at the viewer's own page, so navigating updates the
  address bar and history works.
- A link that leaves CAPSULE becomes a confirmation: it shows where it goes and
  takes a second click.
- `<base>` and `<meta http-equiv="refresh">` are deleted: the first would undo
  every rewrite and the second is a navigation nobody asked for.
- A policy is inserted at the very top of the `<head>`:

```
default-src 'none'; img-src data:; media-src data:; font-src data:;
style-src 'unsafe-inline' data:; script-src 'none'; frame-src 'none';
connect-src 'none'; form-action 'none'; base-uri 'none'
```

### 6.2 Scripts, and why they are off

By default the frame carries
`sandbox="allow-top-navigation-by-user-activation"` and **no**
`allow-scripts`. With no scripts, the only thing that can navigate the frame is
a real click on a link the rebuilder wrote. That makes the guarantee absolute:
the page cannot make a single network request.

The page arrives through `srcdoc` in that mode, and through a different route
when scripts are allowed. The reason is a rule that is easy to miss and was
missed here at first: **a document created from `srcdoc` inherits the
Content-Security-Policy of the page embedding it.** An extension page's policy
is `script-src 'self'`, and a `<meta>` policy in the written document can only
add restrictions on top of an inherited one, never lift it — so through
`srcdoc` a site's own scripts could never run, whatever the visitor chose.

With scripts on, the page therefore goes into `sandboxed.html`, declared under
`sandbox` in the manifest. Chrome gives such a page its own policy and loads it
into an opaque origin with no extension API reachable from it: the same
isolation `srcdoc` gave, arrived at deliberately rather than as a side effect.
The viewer hands it the rebuilt HTML by `postMessage` and it writes it. The
policy injected into that HTML still applies on top of the sandbox policy, so
`connect-src 'none'` holds either way — verified in a browser, not assumed.

They can be enabled per site, with a visible warning.

The frame that runs them is **not** given
`allow-top-navigation-by-user-activation`. That flag is what the scripts-off
frame uses to follow a link, and it is safe there because nothing can run to
abuse it. With scripts on it would be the way out: a navigation is not a
request subject to CSP, and no directive has covered one since `navigate-to`
left the standard, so a script could put anything it had computed into a URL
and take the visitor there on any click.

So links go the other way instead. The bootstrap in the frame catches the
click and passes the address up; the viewer decides what to honour, in
`frameNavigation`:

| What the frame asks for              | What happens                                |
| ------------------------------------ | ------------------------------------------- |
| A page of the site on screen         | The viewer goes there.                      |
| A link out that the rebuilder wrote  | The usual confirmation, naming the address. |
| An address a script invented         | The same confirmation, naming it.           |
| Another `.capsule` name, or nonsense | Nothing.                                    |

That bootstrap is a convenience, not a control: a script can remove the
listener or swallow the click, and all that costs is the site's own links. It
cannot navigate the tab either way. What remains is that a visitor who
approves a confirmation naming an outside address has still gone there — which
is the same decision, and the same warning, as with scripts off.

`allow-same-origin` is never used. The frame lives in an opaque origin; if it
shared the extension's origin the site would have access to `chrome.*`.

### 6.3 Permissions

The extension asks for `declarativeNetRequest`, `storage` and one host
permission: `*://*.capsule/*`.

That last one is not optional and not a convenience. The `declarativeNetRequest`
permission covers `allow`, `allowAllRequests` and `block` rules on its own, but
a **redirect** rule only applies where the extension holds host access to the
address being redirected. Without it Chrome accepts the rule and then ignores
it, every `.capsule` address falls through to DNS, and the failure is
indistinguishable from the extension not being installed. It grants nothing on
the open web: `.capsule` resolves nowhere, so the pattern matches no site that
exists.

Access to a **relay** is still requested one origin at a time, when somebody
adds it in the settings, and given back when they remove it. An extension that
can read any site is an extension that has to be trusted far more than
necessary.

## 7. What is missing

**The visitor is exposed to the relay when the mix cannot be used.** The
extension routes through the mix network by default: the record lookup goes
over mix operation `8` and the capsule download over the same path, so the
relay holding a site answers a request with no address attached to it.

That needs at least two relays the visitor has already allowed, and it is not
always available. When it is not, the extension asks directly — a relay then
sees an address asking about a name — and the panel says which of the two
happened rather than leaving it to be assumed. Turning it off is a switch in
the settings.

What remains is the shape of the fallback: a reader with one relay configured
gets no mix at all, and the honest fix for that is more relays rather than more
code.

**No cache between sessions.** The bundle is kept in
`chrome.storage.session`, which lives in memory and is cleared when the browser
closes. That is the right thing for privacy and it means downloading the site
again each time.

**Chromium only.** The extension is MV3 with `declarativeNetRequest`. Firefox
needs a port; Safari, another.

**Size is a real limit.** A site is downloaded whole. The CLI caps it at 64
MiB, and in practice a useful site is well under a few MiB.

**None of this is audited.** The page rebuilder is a hand-written security
boundary, tested against the cases we thought of.
