# CAPSULE

**A file the relay cannot read. A website nobody can rewrite.**

CAPSULE encrypts a file in your browser, uploads only the ciphertext to a server
anyone can run, and puts the key in the part of the link that browsers never
send to a server. The same machinery publishes websites under a `.capsule`
address whose name _is_ its own key.

📄 [Full showcase page](https://missingus3r.github.io/CAPSULE/) · 🔒 [Threat model](docs/THREAT_MODEL.md) · 📊 [Compared to 21 other networks](docs/COMPARISON.md)

---

## What is it

Two tools built on one idea: **a server should be able to hold your data without
being able to read it, and the thing that unlocks it should never travel the
same road.**

![How a capsule travels](docs/diagrams/capsule-flow.svg)

**Send a file.** It is encrypted on your device with AES-256-GCM. The relay
stores bytes it cannot decrypt. The key lives in the `#fragment` of the share
link — the one part of a URL that, by specification, is never sent to a server.
The person you send it to needs nothing installed.

**Publish a site.** Point the same machinery at a folder and you get a website at
`<key>.capsule`. There is nothing to register, no certificate to renew, and no
authority that could be asked to hand your name to somebody else — because the
name and the signing key are the same object.

## Why

Every mainstream file service encrypts in transit and at rest. What none of them
give up is the ability to read the file, and that ability is what gets
subpoenaed, breached, scanned and sold. The interesting question is not "is it
encrypted" but **who holds the key**.

Publishing has the same shape. A domain is rented, a certificate is issued, a
host serves the bytes — three parties, any of whom can be leaned on to make a
page disappear or say something else.

> A relay that _could_ read your file eventually _will_ be asked to.

CAPSULE's answer is to give the server less to hold: ciphertext of an unknown
size, with no account attached, for a bounded time, and — if you ask — split
across several relays so no single one has enough to rebuild anything.

## Compared

|                                       | CAPSULE | Tor | IPFS | Nostr | Matrix | Briar |
| ------------------------------------- | :-----: | :-: | :--: | :---: | :----: | :---: |
| Server cannot read the content        |   ✅    |  ~  |  ❌  |  ❌   |   ~    |  ✅   |
| No account, no identifier             |   ✅    | ✅  |  ❌  |  ❌   |   ❌   |  ❌   |
| Content size hidden from the host     |   ✅    | ❌  |  ❌  |  ❌   |   ❌   |  ❌   |
| Resists end-to-end timing correlation |   ✅    | ❌  |  ❌  |  ❌   |   ❌   |   ~   |
| Split so no single host has enough    |   ✅    | ❌  |  ❌  |  ❌   |   ❌   |  ❌   |
| Self-certifying site names            |   ✅    | ✅  |  ~   |  ❌   |   ❌   |  ❌   |
| Pages cannot phone home               |   ✅    |  ~  |  ❌  |  ❌   |   ❌   |  ❌   |
| **Works with no internet at all**     |   ❌    | ❌  |  ❌  |  ❌   |   ❌   |  ✅   |
| **Censorship-resistant transport**    |   ❌    | ✅  |  ~   |   ~   |   ❌   |  ✅   |
| **General-purpose TCP tunnel**        |   ❌    | ✅  |  ❌  |  ❌   |   ❌   |  ❌   |
| **Large anonymity set today**         |   ❌    | ✅  |  ❌  |  ❌   |   ❌   |  ❌   |

The last four rows are CAPSULE's, and they are honest losses rather than
oversights. All 21 systems, one limitation each, with a verdict for every row:
[docs/COMPARISON.md](docs/COMPARISON.md).

---

## Get started

Requires **Node.js 22 or newer**. Nothing else — no database, no account, no
API key.

### 1. Install

```bash
git clone https://github.com/missingus3r/CAPSULE
cd CAPSULE
npm install
npm run build
```

### 2. Send a file

```bash
# Start a relay of your own on :8787 (a second terminal)
npm run dev:relay

# Encrypt, upload and print a link
node apps/cli/dist/index.js send ./secret.pdf --anonymous --ttl 24h
```

It prints two things:

- a **share URL** — give it to the recipient, who needs nothing installed;
- a **deletion capability** — keep it; it removes the capsule early.

```bash
node apps/cli/dist/index.js receive "<share-url>" --out ./downloads/
node apps/cli/dist/index.js delete "<deletion-capability>"
```

### 3. Join the network

A relay is one process. There is no registry and nobody to ask: point yours at a
relay you already know and they introduce themselves with signed announcements.

```bash
export CAPSULE_PUBLIC_URL="https://relay.example.org"   # where others reach you
export CAPSULE_PEERS="https://relay-you-already-know.example"
node apps/relay/dist/main.js
```

See who is reachable from a starting point:

```bash
node apps/cli/dist/index.js relays --seed https://relay.example.org
```

Operator guide — quotas, IP-blind mode, storage without expiry, proof of work:
[docs/RUN_A_RELAY.md](docs/RUN_A_RELAY.md).

---

## Publish a `.capsule` site

![How a .capsule site is published and read](docs/diagrams/capsule-site.svg)

```bash
# 1. Make a name. This file IS the site — losing it loses the name.
node apps/cli/dist/index.js site key --out site.capsulekey

# 2. Publish a folder that has an index.html
node apps/cli/dist/index.js site publish ./www --key site.capsulekey --ttl 30d
#    → http://6dijvuvwrd5jqp4efjbb4hwcsmtsf6sgi3at4jeto63k7x5fkbwat2yb.capsule/

# 3. Update it later — the name stays, the version goes up
node apps/cli/dist/index.js site publish ./www --key site.capsulekey
```

### Read one in any Chromium browser

```bash
npm run build:extension
```

Then in Chrome or Edge: **⋮ → Extensions → Manage extensions → Developer mode →
Load unpacked** and choose `apps/extension/dist`. Open the settings, add your
relay, and type the `.capsule` address in the address bar — or `capsule <name>`,
which works even when the browser wants to search instead.

The extension does something ordinary browsers do not: it **rebuilds every page**
before showing it. Stylesheets, images and fonts from the bundle become `data:`
URLs, anything pointing at the open web is removed, and a link that leaves
CAPSULE becomes a click you have to confirm. The result lands in a sandboxed
frame with `connect-src 'none'` and no scripts.

**A `.capsule` site cannot make a single network request.** Not a font, not a
pixel, not a beacon. That is a property of the format, not a setting you can
forget. Details and the exceptions: [docs/SITES.md](docs/SITES.md).

---

## What this does not do

A privacy tool that oversells itself is worse than no tool, because someone will
rely on the part that was exaggerated.

- **The anonymity set is the smallest of any system on this page.** Tor has
  millions of users; CAPSULE has whatever relays someone started today. Every
  property of the mix network is true and none of them matter much at this size.
  This is the risk that dominates all the others.
- **No censorship resistance.** No bridges, no pluggable transports, no protocol
  obfuscation. Blocking the known relays blocks the network.
- **No offline or mesh transport.** CAPSULE needs IP. In a network blackout,
  Briar and Meshtastic work and this does not.
- **No external audit.** The primitives are standard; the composition is not.
  Everything here is supported by the code, the tests and
  [the threat model](docs/THREAT_MODEL.md), and by nothing else.
- **The browser extension talks to relays directly**, so a relay sees an address
  asking about a name. The CLI can go through the mix network; the extension
  cannot yet.

Read the threat model before testing with anything sensitive.

---

## Going further

### Hide who you are, not just what you sent

`--mix` routes every request through CAPSULE's own mix network: relays forward
for each other, each hop holds the packet a random time, every packet is exactly
65,920 bytes, and the relay storing the capsule never learns who asked.

```bash
node apps/cli/dist/index.js --mix send ./report.pdf
node apps/cli/dist/index.js --mix --mix-hops 4 --mix-delay 15000 send ./report.pdf

# Tor hides CAPSULE from your ISP; the mix hides you from the relays
node apps/cli/dist/index.js --tor --mix send ./report.pdf
```

The CLI prints how much protection the live network actually offers **before
every mixed send**, and calls a four-node network what it is. Design and limits:
[docs/MIXNET.md](docs/MIXNET.md).

### Survive a relay disappearing

```bash
# Copies on two more relays found in the network
node apps/cli/dist/index.js send ./archive.zip --mirror 2

# Split across three: any two rebuild it, one alone has nothing
node apps/cli/dist/index.js send ./archive.zip --mirror 2 --shards 2

# Keep it until you delete it (the relay must allow it)
node apps/cli/dist/index.js send ./archive.zip --ttl never

# Continue an interrupted upload
node apps/cli/dist/index.js send ./big.iso --resume ./ticket.json
```

### Not lose the key

```bash
# Wrap a capability under a passphrase
node apps/cli/dist/index.js protect "<capability>" --label "tax return"
node apps/cli/dist/index.js reveal "capsule-recovery:…"

# Or split it: any 2 of 3 shares restore it, one alone reveals nothing
node apps/cli/dist/index.js split "<capability>" --threshold 2 --shares 3
node apps/cli/dist/index.js combine "capsule-share:…" "capsule-share:…"
```

### Anonymisation, one switch at a time

`--pad` hides the size, `--scrub` removes embedded metadata (EXIF and GPS from
JPEG, text chunks from PNG, XMP from PDF, author and company from Office files —
and it _reports_ what it could not remove instead of silently skipping it),
`--hide-name` replaces the filename and mime type, `--jitter <ms>` spaces the
uploads. `--anonymous` turns on all four.

---

## Repository layout

```text
apps/
  web/        Installable React PWA
  relay/      Ciphertext relay, mix node and site directory
  cli/        Command-line sender, receiver and site publisher
  extension/  MV3 browser extension that opens .capsule sites
packages/
  protocol/   Capsule format, .capsule names, primitives and test vectors
  sdk/        Relay client, discovery, transfers and site publishing
  mixnet/     Sphinx packets, mix client and path selection (Node only)
docs/         Protocol, threat model, mix network, sites, comparison, showcase
infra/        Container deployment files
scripts/      Diagram generator and release tooling
```

## Build and verify

```bash
npm run build       # every workspace, including the extension
npm test            # 166 tests, including fuzzing and conformance vectors
npm run typecheck
npm run format:check
npm run diagrams    # regenerate the SVGs and re-inline them into the showcase
```

`npm run vectors` regenerates the protocol test vectors — if that changes the
file, the protocol changed. `npm run release` produces `release/SHA256SUMS` and a
CycloneDX SBOM.

For production, serve the web app over HTTPS with
`Content-Security-Policy: frame-ancestors 'none'`, `Referrer-Policy: no-referrer`
and `X-Frame-Options: DENY`.

## Design principles

- No accounts and no global user identifiers.
- Encryption on the edge, never on the relay.
- Separate capabilities for reading, writing and deleting.
- No blockchain, token or permanent public ledger.
- Expiry and bounded storage by default; permanence only when an operator opts in.
- Anyone can run a relay: no registry, no gatekeeper, no privileged node.
- A versioned, documented protocol using standard cryptography, with published
  test vectors so a second implementation can prove it agrees.
- Honest labels: say what is hidden, name what is not, report what could not be
  cleaned, and state the size of the anonymity set rather than implying a
  guarantee.

What comes next is in [the roadmap](docs/ROADMAP.md).

## Status and license

The capsule format, relay API and capability encoding were frozen in 1.0 and
published with [test vectors](packages/protocol/vectors/capsule-test-vectors.json).
1.1 added the mix network and 1.2 added `.capsule` sites, neither of which
changed them.

The implementation is tested but **has not been independently audited**. The
v1.0 security review was internal; it found and fixed two exploitable issues and
three smaller ones, documented in [the threat model](docs/THREAT_MODEL.md) §13.3
along with the risks that remain.

Licensed under the [Mozilla Public License 2.0](LICENSE): file-level copyleft,
so changes to CAPSULE's own files stay open while the code can be combined with
software under other licences.
