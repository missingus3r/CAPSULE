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
  about that name. With `--mix` it does not; from the extension, it still does
  (see §7).

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

Relays pass records to each other on every sync round, capped per round
(`CAPSULE_SITE_GOSSIP_LIMIT`, 200 by default) and in total
(`CAPSULE_MAX_SITES`, 5000). Without this a name would only resolve at the
relays its author announced to, and every visitor would have to be told which
those are — which is a registry with extra steps.

A relay can **stay silent**, not lie. That is why the client asks several and
keeps the highest sequence that verifies: for silence to be worth anything,
they would all have to be silent.

## 6. The extension

`http://<name>.capsule/` does not resolve in DNS and never will. The extension
intercepts the navigation with a `declarativeNetRequest` rule before the
browser resolves anything, and turns it into a page of its own with the
original address in the **fragment** — which never travels to any server, the
same as in a capsule link.

Then:

1. It parses the name. If it does not parse, it stops there: no search, no
   "did you mean".
2. It asks the configured relays and verifies every answer.
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

They can be enabled per site, with a visible warning. A script _can_ take the
frame to an external address, and that would reveal the visitor's IP to it. The
policy still blocks `fetch`, external images and external fonts, but a
navigation is not a request subject to CSP and no directive covers it since
`navigate-to` left the standard.

`allow-same-origin` is never used. The frame lives in an opaque origin; if it
shared the extension's origin the site would have access to `chrome.*`.

### 6.3 Permissions

The extension asks for `declarativeNetRequest` and `storage`, and **no** host
permission at all up front. Access to a relay is requested when somebody adds
it in the settings, for that origin and nothing else, and given back when they
remove it. An extension that can read any site is an extension that has to be
trusted far more than necessary.

## 7. What is missing

**The visitor is still exposed to the relay.** The extension queries relays
directly from the browser, so a relay sees an IP address asking about a name.
The CLI can go through the mix network; the extension cannot, because that
requires Node. This is the most important gap in this version.

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
