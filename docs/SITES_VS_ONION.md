# `.capsule` sites and Tor `.onion` services

**Status:** a design comparison, with no external audit
**Date:** 2026-08-30

The two look alike from the address bar: an unreadable name, no registrar, no
certificate, nobody to ask for permission. They are not the same kind of thing,
and the differences matter more than the resemblance.

This document is about `.capsule` sites only. For CAPSULE against Tor as a
transport, see [COMPARISON.md](./COMPARISON.md). For how a `.capsule` site works
on its own, see [SITES.md](./SITES.md).

## 1. The one difference everything else follows from

An `.onion` address is **a route to a process that is running right now**. A
`.capsule` address is **a signed pointer to a static blob already replicated
across relays**.

Tor moves connections. CAPSULE moves content. An onion service is a web server
you reach through a tunnel; a `.capsule` site is closer to IPFS with IPNS —
immutable content at rest, plus a mutable pointer signed by a key.

Everything below is a consequence of that sentence.

## 2. The name is the same decision

There is no difference here, and CAPSULE never pretended otherwise. Onion v3:

```
base32( Ed25519 public key (32) ‖ checksum (2) ‖ version (1) ) ‖ ".onion"
```

CAPSULE:

```
base32( Ed25519 public key (32) ‖ checksum (2) ‖ version (1) ) ‖ ".capsule"
```

Same fields, same order, 56 characters either way. Only the checksum's domain
separator differs — `SHA3-256(".onion checksum" ‖ …)` against
`SHA-256("CAPSULE/site-name/v1" ‖ …)` — and in both cases the checksum protects
against nothing. It is there so that a mistyped name fails instead of resolving
to a different site.

The reasoning is identical too: a readable name needs a registry, a registry
needs a registrar, and a registrar is somebody who can be leaned on. Both
networks paid the same price — an address nobody can remember — to avoid that.

## 3. How each one resolves

**`.onion`.** The service publishes an encrypted **descriptor** to a small set
of relays carrying the `HSDir` flag. Which relays is decided by a hash ring
derived from the blinded public key and the daily shared random value, so the
set rotates and the service does not get to choose it. The descriptor does not
contain the site: it contains **introduction points**. A visitor picks a
rendezvous point, sends `INTRODUCE1` through an introduction point, the service
builds its own circuit to that rendezvous, and a **six-hop** circuit carries
ordinary HTTP.

Note what that means for anyone who has just read about directory authorities:
**the HSDir ring is derived from the consensus**, so an onion service inherits
Tor's dependency on its directory authorities.

**`.capsule`.** The publisher signs a record — `name`, `sequence`,
`publishedAt`, `capability`, `signature` — and `PUT`s it to relays it already
knows. Relays **gossip records to each other** on every sync round. The record
points at one capsule holding the entire site in a single encrypted blob
(`CAPSITE1`). There is no consensus, no ring and no authority: a record is
verified against the key that is inside the name, and against nothing else.

The practical consequence: **a `.capsule` publisher can be offline.** An onion
service operator cannot. If the process stops, the onion site does not exist.

## 4. What happens when someone visits

**`.onion`.** The circuit opens and the visitor talks to a real server. Each
request is a request: the service sees the path, the timing, the headers and the
order the pages were read in, and it can answer differently every time.

**`.capsule`.** The extension intercepts the navigation before DNS with a
`declarativeNetRequest` rule, asks relays for the record, checks the signature
against the key in the name, refuses a `sequence` lower than the highest this
browser has accepted, downloads the capsule, decrypts it and unpacks the
bundle. Then it does something no ordinary browser does: it **rebuilds the
page** instead of displaying it. References that resolve inside the bundle
become `data:` URLs, references pointing outside are removed, `<base>` and
`<meta http-equiv="refresh">` are deleted, and the result goes into a frame in
an opaque origin under `default-src 'none'; … script-src 'none'; connect-src
'none'`.

There is no partial download, on purpose. Fetching one file at a time would tell
the relay which pages were read.

## 5. The table

|                                      | `.onion` v3                      | `.capsule`                                              |
| ------------------------------------ | -------------------------------- | ------------------------------------------------------- |
| What is on the other side            | a live server                    | a static blob on relays                                 |
| Publisher must stay online           | **yes, 24/7**                    | no                                                      |
| Dynamic content, forms, login, DB    | **yes, all of it**               | none                                                    |
| JavaScript                           | whatever the site wants          | off by default, opt-in per site                         |
| The page can reach the network       | **yes**                          | **no** — `connect-src 'none'`                           |
| The site learns which pages you read | **yes, every request**           | no — the bundle arrives whole                           |
| The site learns your IP              | no, the circuit hides it         | there is no server to learn it                          |
| **The relay/HSDir learns your IP**   | no, six hops                     | no, three hops — when there are relays to route through |
| Names can be enumerated              | no, blinded keys                 | **yes** — `GET /v1/sites`                               |
| What the signature covers            | the server's identity            | the bytes you are shown                                 |
| Anti-rollback                        | `revision-counter`               | monotonic `sequence`                                    |
| Latency                              | six hops, slow                   | one fetch, fast                                         |
| Size                                 | unbounded                        | **64 MiB, downloaded whole**                            |
| What the visitor installs            | Tor Browser or a `tor` daemon    | a Chromium extension                                    |
| Depends on a central authority       | **yes** — consensus → HSDir ring | no — gossip                                             |

## 6. What `.capsule` does that an onion service cannot

**It limits what the site can do to the visitor.** This is the largest
difference and the least obvious one. An onion service is a normal web server:
it can run scripts, fingerprint the browser, pull in external resources, log
every path, and serve different content to different people. An anonymous
connection does not change any of that — Tor protects the visitor from the
network, not from the site.

A `.capsule` page cannot make a single network request. Not a font, not a pixel,
not a beacon. That is a property of the rebuilder and the sandbox rather than a
setting somebody can forget, and it is checked in `tests/viewer.test.ts` and
`apps/extension/test/render.test.ts`.

**The signature covers the content, not the host.** An onion address proves you
are talking to the machine holding that key. It says nothing about what that
machine chooses to send you, and nothing stops it sending one visitor what it
does not send another. A `.capsule` record signs the capability for that exact
bundle, and the browser keeps the highest `sequence` it has accepted, so a relay
cannot quietly hand back an older version.

**No reading pattern exists to observe.** The whole site arrives at once. On an
onion service the server holds a complete log of the visit whether it keeps it
or not.

**The publisher can turn the machine off.** Relays hold the content, so
availability comes from replication rather than from uptime.

## 7. What an onion service does that `.capsule` cannot

**It is a real web.** Sessions, `POST`, search, messaging, uploads, anything. A
`.capsule` site is static and always will be. That is not a gap to be closed
later; it is the shape of the thing.

**It hides the visitor from the network without needing a crowd to be there
first.** Tor's guarantee holds because thousands of relays already exist.
CAPSULE routes a record lookup and a capsule download through its own mix
network — the extension does it by default now — but a path needs relays, and
with fewer than two the extension asks directly and says so. The mechanism is
built; the network it needs is not, and that is a difference of degree that
matters more than the design.

**Its names cannot be enumerated.** Onion v3 fixed this deliberately — a blinded
key means an HSDir stores a descriptor without being able to tell which service
it belongs to. In CAPSULE, `GET /v1/sites?limit=n` exists so that relays can
gossip records, which means anyone can ask a relay for the list of names it
holds. The _content_ of a `.capsule` site is public by definition, so nothing
secret leaks — but **the existence of your site is discoverable**, and in Tor it
is not. If you need a name nobody can stumble onto, this is not the layer for
it.

**It scales past 64 MiB**, and it does not make the visitor download the parts
they will never open.

## 8. Where each one breaks

An onion site dies when its operator stops running the process, or when enough
of Tor's directory authorities cannot produce a consensus for long enough that
the HSDir ring stops working.

A `.capsule` site dies when the relays holding its capsule let it expire and
nobody republishes. A record is also refused once it is more than ninety days
old (`MAX_SITE_RECORD_AGE_MS`), so a name that is never re-announced stops
resolving even if the bytes are still sitting somewhere. Relays cannot lie about
a record — the signature is checked against the key in the name — but they can
**stay silent**, which is why a client asks several and keeps the highest
sequence that verifies.

Neither name can be taken from its holder and neither can be reassigned. Both
are lost for good if the key file is lost.

## 9. They are not competitors

None of this is exclusive. A CAPSULE relay can be reached over Tor, `capsule
--tor` routes the CLI through a SOCKS proxy with `.onion` support, and running a
relay as a hidden service is the cheapest way to have one with no domain, no
static IP and no forwarded port. The two answer different questions: Tor asks
how a connection can be anonymous, and CAPSULE asks how little a host can be
allowed to know about what it is holding.

Use an onion service when the site has to _do_ something. Use a `.capsule` site
when the site only has to _say_ something, and you would rather it could not
watch who is reading.
