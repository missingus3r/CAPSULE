# Changelog

Every released version of CAPSULE, with what changed and, where it applies,
what stopped being true. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed

- **`.capsule` addresses did not open at all.** The extension declared no host
  permission, and a `declarativeNetRequest` **redirect** rule, unlike `block`,
  only applies where the extension holds host access to the address being
  redirected. Chrome accepted the rule and ignored it, so every `.capsule`
  address fell through to DNS and failed like the extension was not installed.
  It now declares `*://*.capsule/*`, which matches nothing that resolves on the
  open web, and says so in the service worker log if it is ever taken away.
- **Turning scripts on for a site did nothing.** The page was handed to the
  frame through `srcdoc`, and a `srcdoc` document inherits the
  Content-Security-Policy of the page embedding it: `script-src 'self'` for an
  extension page. The policy the viewer injects can only add restrictions to an
  inherited one, never lift one, so a site's own scripts were blocked whatever
  the visitor chose, with the violation reported against a policy the visitor
  never set. With scripts on the page now goes into a frame declared under
  `sandbox` in the manifest, which Chrome gives its own policy and an opaque
  origin with no extension API in it. `connect-src 'none'` still applies on top,
  so a site with scripts allowed can compute anything and still cannot send it
  anywhere: checked in a browser rather than assumed.
- **A relay forgot every `.capsule` name when it restarted.** Records were held
  in memory only, while the capsules they point at were on disk, so a restart
  emptied a relay's half of the name space, including names its own operator had
  published minutes earlier. They are now kept in `sites.json` in the data
  directory and re-verified on load: the name is re-derived from the key, the
  signature checked and the age limit applied, so a file edited on disk can no
  more insert a record than a lying peer can. An unreadable file is logged and
  the relay starts empty rather than refusing to start.

- **A site with scripts allowed could still navigate the tab.** The frame
  carried `allow-top-navigation-by-user-activation`, which is what a
  scripts-off page uses to follow a link and is safe there because nothing can
  run to abuse it. Once scripts actually ran, it became the way out: a
  navigation is not a request subject to CSP, so a script could put whatever it
  had computed into a URL and take the visitor there on any click. The frame no
  longer has that reach. Links are passed up to the viewer, which honours a page
  of the site on screen and turns everything else, including an address a
  script invented, into the confirmation naming where it goes.

### Added

- `examples/site/`, a small `.capsule` site to publish against a local relay.
  Three of its checks are deliberate: an external image the viewer must drop, an
  inline script it must not run, and an outbound link it must ask about first.
- **An index running in production, and the link to it in the app.**
  `nubiyua5tkgc54mklml3xr4piafhgtqcvdy6gjscxddu7pepv3iyqiyb.capsule`
  is published by the genesis operator and rebuilt daily by a systemd timer,
  with a seven-day TTL so one failed run is not an index that vanishes. The web
  app links to it beside send, receive and publish, saying that opening it
  needs the extension. Hardcoding this name is safe in a way a relay address is
  not: a `.capsule` name is a public key and its record is signed, so it can be
  seized from nobody: there is nothing extra to pin.
- **The relay's root redirects to the project page** instead of answering 404.
  It is an exact-match location: everything under `/v1` still reaches the
  relay, which was checked rather than assumed.
- **A genesis relay, pinned.**
  `https://68.211.136.69.sslip.io#W0rKZRPcxcCWT4So5LorArlH4O3slgXiUxs4EWx4n2M`
  ships as the default seed, so a fresh checkout reaches the network without
  also running a relay. The hostname is the address `68.211.136.69` spelled so
  a certificate can exist for it: Let's Encrypt does not sign bare IPs through
  the ordinary flow, and `<ip>.sslip.io` resolves to that IP and nothing else.
  The pin is the point: the relay signs a challenge the client just generated,
  so seizing the name, the certificate or the host is not enough to stand in
  for it. Verified against the running relay, not only in tests.

  It is one relay run by one person, which is not a network: it sees the
  address, the timing and the size of everything sent through it, and a mix
  path across relays a single party operates protects nobody. The README and
  the showcase page say so where they name it.

- **A pinned seed now has to prove itself, and the check it replaces was
  decorative.** `fetchRelayInfo` compared the `relayId` a relay sent back
  against the pinned one, but `relayId` and `publicKey` are both public, so
  anyone who fetched a relay's `/v1/info` once could serve those values and
  pass. A pinned lookup sends a fresh challenge and requires an Ed25519
  signature over it, and derives `relayId` from the key rather than reading it,
  so an identifier cannot be claimed for a key the relay does not hold. A
  relay too old to answer a challenge is **refused when pinned** rather than
  believed. Unpinned discovery is unchanged, and the query parameter is
  optional, so nothing else moved. Specified in
  [docs/PROTOCOL.md](docs/PROTOCOL.md) §`GET /v1/info`; the attack is in
  `tests/seeds.test.ts`, written from the impostor's side.
- **One place to put the seeds a fresh install starts from.**
  `DEFAULT_SEEDS` in `@capsule/protocol`, shared by the CLI, the web app and
  the extension, in `url#relayId` form. It **ships empty**: a seed that arrives
  with the software is the address every new install believes before anything
  else, and an unpinned one would hand whoever controls it the opening view of
  the network for everybody. The web app also remembers the relays it reached
  and tries them, pinned to what they announced, before falling back to a seed:
  a default should be how a browser finds the network once, not a party it
  depends on for good.
- **`capsule index`, a directory of sites that asked to be listed.** It reads
  every name the reachable relays admit to holding, downloads each bundle,
  keeps the ones whose `capsule.json` opts in, and publishes the result as a
  `.capsule` site of its own. Three things it does deliberately: **a site that
  says nothing is treated as one that said no**, since a relay listing a name
  is not its author asking to be catalogued; the page is a snapshot rather
  than a live search, because a `.capsule` page cannot query anything; and
  every site is fetched to find out whether it wanted to be there, because a
  bundle has no partial download. With scripts off the page is a full list,
  and allowing them reveals a filter over the rows already rendered: the
  rebuilder strips every `<script>`, so a page whose data lived in one would
  show nothing. Titles and descriptions come from other people's sites and are
  escaped; `apps/cli/test/indexer.test.ts` covers that boundary.
- **A link to an index in the web app**, beside send, receive and publish,
  saying that opening it needs the extension. Configured with
  `VITE_CAPSULE_INDEX` and hidden when unset.
- **A one-click Hello world in the publish tab.** It goes up for an hour and
  does not ask to be indexed, so trying the feature out leaves nothing behind.
- **A site can be published from the web app.** The **Publish** tab takes a
  folder or a `.zip`, packs and encrypts it in the page, and announces the
  signed record: the same `publishSite` the CLI calls, given its files from a
  `FileList` instead of a directory walk, and routed through the mix network
  like everything else. The zip reader is a hundred lines over
  `DecompressionStream` rather than a dependency inside the page that handles a
  signing key; ZIP64, encrypted entries and unusual compression methods are
  refused by name instead of dropping files silently, and `.DS_Store`,
  `__MACOSX/` and friends are left out with a count shown.
- **`capsule.json`, an opt-in to being indexed.** A switch in the publish form
  writes it into the bundle. Nothing indexes CAPSULE yet; when something does,
  the rule is that **a site which says nothing has not opted in**, because
  publishing openly is not the same as asking to be catalogued. It lives in the
  bundle rather than the record deliberately: the record's signed message is a
  fixed field list, so adding to it would make records existing clients cannot
  verify, and a client that cannot verify a record refuses the site entirely.
  Inside the bundle it is covered by the same signature chain as the pages, and
  no version of anything had to change. Specified in
  [docs/PROTOCOL.md](docs/PROTOCOL.md) §17.3.1.
- **The extension routes `.capsule` reads through the mix network, by
  default.** Opening a site used to tell the relay holding it which address
  asked for which name: the gap [docs/SITES.md](docs/SITES.md) §7 called the
  most important one in this version. Both halves of the read now go over the
  mix: the record lookup through a new operation `8`, and the capsule download
  through the same path. It uses only relays the visitor has already allowed,
  needs at least two of them, and when it cannot lay a path it asks directly
  and says on screen that it did rather than letting the protection be assumed.
  A switch in the settings turns it off.
- **Mix operation `8`, reading a `.capsule` record.** It answers exactly what
  `GET /v1/sites/<name>` answers, including for a name the relay does not hold,
  so the mix path is not a different oracle from the direct one. A relay that
  predates it answers `unsupported operation` and the caller treats that like
  any other relay that did not answer, so no version bump was needed.
- **The web app can route through the mix network.** A switch beside anonymous
  mode sends every request over three hops, so the relay storing the capsule
  never learns who uploaded or fetched it: the thing `--mix` has done in the
  CLI since 1.1. Under the switch it prints what the live network actually
  offers, because a four-node network is not anonymity and should not be sold
  as it. The switch is off when no relay in reach forwards for others, and says
  so rather than failing at upload.

### Changed

- **The mailbox never sits on the relay a request is addressed to.**
  `buildMixNetwork` picked the mailbox provider at random from every relay it
  knew, including the destination. When they were the same relay it learned the
  reply token by answering the request, and saw the address polling for that
  token: enough to put a name and an address back together and undo the point
  of routing at all. The mailbox now moves to another relay whenever the
  destination is the provider and there is anywhere else to put it. Found by
  the integration test written for the extension's path, not by reading.
- **Site keys in the browser are stored as handles, not as bytes.** Creating a
  name downloads its `.capsulekey` before the key is used for anything, and
  what the browser keeps afterwards is the non-extractable `CryptoKey` that
  `loadSiteIdentity` produces, in IndexedDB by structured clone so the flag
  survives. It can sign the next version and cannot be exported by the page or
  by anything else reaching the origin. Publishing from another machine needs
  the backup file, which is the point of handing it over first.
- **Mix routing is on by default in the web app**, not an option to discover.
  The protection worth defaulting to is the one that holds in a small network:
  the relay storing a capsule does not learn who sent it.
- **The mix packet layer runs in a browser.** It was built on `node:crypto`,
  which is the whole reason mix routing was CLI-only: X25519, HKDF, AES-CTR and
  HMAC now come from the audited `@noble` packages, and the byte helpers from
  `@capsule/protocol`, which the browser already had. **Nothing about the wire
  format changed**, every primitive was compared against what `node:crypto`
  produced, a packet built by either version is processed by the other, and
  `packages/mixnet/test/interop.test.ts` pins those bytes so a relay on an older
  version and one on a newer version cannot drift apart. The functions stayed
  synchronous: Web Crypto has no synchronous form and cannot derive a public key
  from a private one, so using it would have turned the packet layer into
  promises for no gain.
- **Capsules without expiry are accepted by default.**
  `CAPSULE_ALLOW_PERSISTENT_CAPSULES` was `false`, so the ordinary relay refused
  an option the apps had already put in front of the sender, and the web app
  showed "no expiry" as unavailable on almost every relay there was. It is now
  `true`, bounded by the quota that was already there: 1 GiB in total and
  128 MiB per sender unless the operator raises it. An operator who does not
  want to hold anything with no end date sets it to `false`, and the apps go
  back to showing the option as unavailable rather than failing at upload.
  Relays already running are unaffected until they restart, and one that set
  the variable explicitly keeps what it set. The reasoning, and the residual
  risk this accepts, are in
  [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) §12.2.
- The publishing examples asked for `--ttl 30d`, which a relay with the default
  seven-day ceiling refuses. They ask for `--ttl 7d`, and the ceiling is named
  where it bites.

## [1.3.0]: 2026-08-30

Three of the four gaps the comparison table called out, and an honest note
about the fourth.

**Before anything else:** a bridge stops a censor enumerating and probing. It
does not stop one who obtains the bridge line, and it does not hide the TLS
fingerprint. An offline capsule works with no network at all, and is not a mesh.
The anonymity set is still small and no commit changes that. See
[docs/CENSORSHIP.md](docs/CENSORSHIP.md), [docs/OFFLINE.md](docs/OFFLINE.md)
and [docs/COMPARISON.md](docs/COMPARISON.md).

### Added

**Bridges: reaching the network when it is blocked**

- A relay started with `CAPSULE_BRIDGE=true` never announces itself, so it
  appears in nobody's peer list. Enumerating the public directory does not find
  it.
- Every route hides behind a secret path prefix derived from the bridge key. A
  scan for `/v1/info` finds nothing.
- Every real request carries a **session-cookie authenticator** over its own
  method and path, so a cookie captured on one request cannot be replayed onto
  another, and a recorded request cannot be replayed at all.
- The cookie's name is derived from the key and chosen from ordinary session
  cookie names, so two bridges do not look alike and there is no single string
  to write a DPI rule for.
- Everything without a valid one, wrong prefix, missing cookie, malformed,
  expired, replayed, or for another path, gets exactly what an unconfigured web
  server gives: a page at `/` and a 404 everywhere else. The operator can point
  `CAPSULE_BRIDGE_DECOY` at a real file.
- `--bridge <line>` in the CLI works everywhere, because it wraps `fetch`
  rather than the relay client: transfers, relay discovery, `.capsule`
  resolution and record announcements all included. It stacks with `--tor`.

**Working with no internet**

- `capsule offline pack` / `open` puts a capsule in one file that travels on a
  memory stick or across an air gap. **Sealed by default**: the file is
  ciphertext and the key goes by another route, so a lost stick is a lost stick.
  `--with-key` puts the key inside and says what that costs.
- `capsule lan` finds a relay over UDP multicast with no DNS, no seed list and
  no uplink. A relay announces itself only with `CAPSULE_LAN=true`, which is off
  by default because a beacon tells the whole network that CAPSULE is running
  here.
- A beacon may only name a plain `http(s)` origin, no path, no credentials, no
  other scheme, because anybody on the network can send one.

**The part of the anonymity set that code can affect**

- **Every encrypted manifest is now padded to a size class.** AES-GCM does not
  hide length, so the manifest used to measure the filename and the note: a
  capsule called `x.txt` and one called `Ana Pereira - passport scan.jpg` were
  visibly different to the relay. It is unconditional on purpose: an anonymity
  feature some senders enable splits everyone into two distinguishable groups.
- `capsule network` reports what the live network can offer: relays reachable,
  apparent operators, mix nodes, mix operators. It also says plainly that the
  anonymity set itself cannot be measured here, because there are no accounts
  and no counters, so there is nobody to count.

### Changed

- **The documentation is in English.** Every file in `docs/` and this changelog.
- **Wire format:** manifests changed length. It is visible on the wire but
  compatible in both directions, readers ignore unknown fields, and the test
  vectors were regenerated. Manifest padding is specified in
  [docs/PROTOCOL.md](docs/PROTOCOL.md) §13.4.
- The showcase page is monochrome, with a capsule mark in the header.
- `npm run build:libs` now builds `@capsule/lan` as well.

### Documentation

- [docs/CENSORSHIP.md](docs/CENSORSHIP.md): what a probe gets, what a bridge
  does not protect against, and how to run one.
- [docs/OFFLINE.md](docs/OFFLINE.md): offline capsules and LAN discovery, and
  why neither is a mesh.
- `PROTOCOL.md` §13.4, §18 and §19; `THREAT_MODEL.md` §16; `RUN_A_RELAY.md`
  §10 and §11; `ROADMAP.md` §16.

### Still unresolved

- **Bridge distribution.** A censor who gets the line has the bridge. Tor has
  spent fifteen years on this; CAPSULE has no answer at all.
- **The TLS fingerprint is Node's**, not a browser's.
- **No pluggable transports.** For protocol obfuscation, put Tor or obfs4
  underneath with `--proxy`.
- **No mesh or radio transport.** Where there is no IP and nobody to carry a
  file, Briar and Meshtastic work and this does not.
- **The anonymity set is still small**, and that is adoption rather than
  engineering.
- **A general-purpose TCP tunnel** is designed but not built; see
  [docs/ROADMAP.md](docs/ROADMAP.md) §16.1.

## [1.2.0]: 2026-08-30

Websites with a name of their own. The capsule format, the relay API and the
capabilities are unchanged: a site is an ordinary v3 capsule plus a naming
layer on top.

**Before anything else:** a `.capsule` site is **public**. Anyone who obtains
the record can read it, and records circulate between relays on purpose. What a
site guarantees is that nobody can replace your pages or hand you an old
version without it being noticed. Anything private is sent as a capsule, not
published as a site. See [docs/SITES.md](docs/SITES.md).

### Added

- **Self-certifying `.capsule` names.** The name is an Ed25519 public key in
  base32 with a checksum and a version: 56 characters plus `.capsule`. There is
  no registry, no registrar and no certificate to renew.
- **Signed site records**, with a monotonic sequence number. A relay cannot
  forge one because it has no key, nor roll back to an old one because the
  browser remembers the highest it accepted.
- **A site bundle format** (`CAPSITE1`): a whole folder inside one capsule. No
  partial download, on purpose: asking file by file would tell the relay which
  pages were read.
- **Three relay endpoints**, `GET`/`PUT /v1/sites/:name` and `GET /v1/sites`,
  and record gossip between relays, so a name resolves anywhere rather than only
  where its author announced it. Turned off with `CAPSULE_SITES_ENABLED=false`.
- **`capsule site` commands**: `key`, `publish`, `resolve`, `get` and
  `announce`. Size-class padding and a neutral filename are the default when
  publishing, not something to remember to switch on.
- **A browser extension (MV3)** that opens `http://<name>.capsule/` in any
  Chromium. It intercepts the navigation before DNS, resolves the name, verifies
  the signature, downloads the capsule and **rebuilds the page**: every
  reference that resolves inside the bundle becomes a `data:` URL and every one
  pointing outside is removed.
- **A `.capsule` site cannot make any network request.** The frame runs with no
  `allow-scripts` and `connect-src 'none'`; not a font, not a pixel, not a
  beacon. Scripts are enabled per site, with the warning that a script can take
  the frame to an external address.
- **Host permissions on demand** in the extension: it asks for none up front and
  asks for a relay's when somebody adds it, for that origin and nothing else.
- **Diagrams** generated from `scripts/diagrams.mjs`, and a single-file showcase
  page (`docs/index.html`) for GitHub Pages.
- **[docs/COMPARISON.md](docs/COMPARISON.md)**: the 21 networks on the map,
  each one's limitation, and whether CAPSULE covers it.

### Changed

- The README leads with what it is and what it is for, with two diagrams and a
  four-step installation guide. The reference material stays below.
- `npm run build` builds the extension too; `npm run build:extension` builds it
  alone and `npm run diagrams` regenerates the SVGs and re-inlines them into the
  page.

### Still unresolved

- **The extension talks to relays directly.** A relay sees an address asking
  about a name. The CLI can go through the mix network; the extension cannot,
  because that requires Node.
- **Chromium only.** Firefox and Safari need a port of the extension.
- **The page rebuilder is not audited.** It is a hand-written security boundary
  tested against the cases we thought of.

## [1.1.0]: 2026-08-30

CAPSULE has its own mix network. The capsule format, the relay API and the
capabilities do not change: a capsule sent through the network is identical to
one sent directly.

**Before anything else:** a network's anonymity comes from the size of the set
you hide in, not from its code. With few nodes and one operator this is not an
anonymity network, and the tool says so on every send rather than suggesting
otherwise. The full design and its limits are in
[docs/MIXNET.md](docs/MIXNET.md).

### Added

**The mix network**

- Sphinx packets of a single size (65,920 bytes), with the header blinded at
  every hop, filler that prevents deducing a position in the path, and a body
  encrypted with LIONESS: changing one bit randomises the whole packet, which
  is what defeats tagging.
- Per-hop delays drawn from an exponential distribution. This is what Tor
  cannot do, somebody waiting for a web page will not wait, and it is what
  breaks end-to-end timing correlation.
- Single-use reply blocks: the relay answers without knowing whom.
- Mailboxes on a provider relay, for clients that cannot receive connections.
- Cover traffic: every node sends packets to itself along random paths,
  indistinguishable from real ones.
- Replay protection by a tag derived from the shared secret.
- **No exit nodes**: the destination is the relay storing the capsule, so no
  party sees the request in the clear without being its recipient.
- Every relay is a mix node by default, with its own Curve25519 key published in
  `/v1/info` and propagated by the existing gossip.

**In the CLI**

- `--mix` on `send`, `receive` and `delete`, with `--mix-hops`, `--mix-delay`
  and `--mix-provider`.
- It combines with `--tor`: Tor hides CAPSULE from your internet provider, the
  mix hides you from the relays.
- Before every send it prints how many nodes and how many apparent operators
  there are, and what that number means.

**In the SDK**

- `RelayTransport`, the interface a transfer needs from a relay. The direct
  client and the network one implement it identically, so uploading and
  downloading work without knowing which way they travel.

### Fixed

- **A relay stopped propagating the directory as soon as it knew one
  neighbour**, and kept a partial view until the next gossip cycle. With the mix
  network that stops being a detail: a node that has not heard of the node a
  packet names has no choice but to drop it. It now keeps propagating until the
  directory stops growing.
- **Mix traffic and mailbox polling counted against the API rate limit**, which
  exhausted it exactly when the network was working. They now have their own
  limit, and what bounds the mix is the size of its queue.
- A relay shutting down cancels in-flight probes instead of waiting for them to
  time out.

### Still unresolved

- The web application does not use the network: it needs X25519 in Web Crypto.
- There are no guard nodes; the first hop is re-chosen on every request, and
  that decision deserves the analysis Tor actually did.
- An active n−1 attack remains open, as in the literature.
- There is no censorship resistance: no bridges and no pluggable transports.
- This composition has no external cryptographic review.

## [1.0.0]: 2026-08-29

The first stable release: the capsule format, the relay API and the
capabilities are frozen and published with test vectors. v1 and v2 capsules are
still read unchanged.

### Added

**Content anonymisation**

- Stripping embedded metadata before encrypting, with support for JPEG (APPn
  and comments), PNG (`tEXt`/`zTXt`/`iTXt`/`eXIf`/`tIME`), WebP (`EXIF`/`XMP`
  and the `VP8X` flags), GIF (comments and application extensions, keeping the
  NETSCAPE2.0 loop), MP4/MOV/HEIC/AVIF (`udta`, `uuid` and `meta` boxes
  overwritten in place) and ZIP containers (Office/ODF/EPUB: document
  properties emptied and timestamps normalised).
- In PDF, XMP packets are blanked without moving a single byte; the `/Info`
  dictionary is **reported** as not removable instead of pretending it was
  cleaned.
- A neutral filename and MIME type in the manifest.
- Size-class padding: the relay sees a category, not the real size.
- Optional jitter between chunks.

**Transport anonymisation**

- A hand-rolled SOCKS5 client in the CLI (`--proxy`, `--tor`), with no new
  dependencies, name resolution at the proxy and `.onion` support.
- The relay operates without retaining addresses: no IPs in logs and rate
  limiting by a hash with a rotating salt (`CAPSULE_IP_BLIND`, on by default).

**Capsules without expiry**

- `expiresAt: null` in the manifest and `expiresInSeconds: null` in the API.
- Off by default; the operator enables it and sets a global quota and a
  per-sender one.

**An open relay network**

- An Ed25519 identity per relay, generated at startup and persisted.
- `GET /v1/info`, `GET /v1/peers` and `POST /v1/peers/announce` with signed
  announcements and configurable proof of work.
- Gossip with startup retries, verification of every learned address against
  `/v1/info`, a cap per apparent operator, and SSRF defence.
- Client-side discovery with pinnable seeds (`url#relayId`) and selection that
  prefers distinct operators.

**Replication and availability**

- Full mirrors on several relays, with read failover and deletion addressed to
  all of them with an honest report.
- Optional `k`-of-`n` erasure coding: no relay stores enough to reconstruct the
  capsule, and it costs `n/k` instead of `n`. A relay serving corrupt shards
  does not break the download: another combination is tried.

**Recovery (opt-in)**

- Capabilities protected with a passphrase (PBKDF2-SHA-256 + AES-GCM).
- Shamir `k`-of-`n` splitting of a capability between people or devices.

**Operation**

- Resumable uploads via a ticket, and retries with backoff.
- Conformance vectors published in
  `packages/protocol/vectors/capsule-test-vectors.json`.
- Fuzzing of every parser and of the relay's HTTP surface.
- `npm run release`: SHA-256 checksums and a CycloneDX SBOM.

### Changed

- Protocol version **3**. The AAD is bound to the capsule's version, so a
  downgrade fails authentication instead of passing unnoticed.
- A relay with `CAPSULE_PUBLIC_URL` accepts CORS from any origin by default:
  without that it cannot serve web applications it does not host itself.
  Capabilities are explicit bearer tokens, never cookies, so a permissive policy
  grants no ambient authority.
- The web application's CSP allows `https:` in `connect-src`, necessary to talk
  to relays discovered in the network. The development server adds loopback; the
  production build does not.

### Fixed

- A relay that started before its seed stayed isolated until the next gossip
  interval (5 minutes by default). It now retries startup with a short backoff.

### Security

Findings from this version's security review, all fixed before publishing. The
detail and the reasoning are in [the threat model](docs/THREAT_MODEL.md) §13.3.

- **The relay's address filter could be bypassed (medium).** The blocklist
  compared strings: `127.0.0.1` was blocked and `[::ffff:7f00:1]`, the same
  address in IPv6, passed. Anyone could make a public relay query its
  operator's internal services and republish that address to the whole network.
  Replaced with a parser that normalises every equivalent form and blocks
  private, loopback, link-local, CGNAT, multicast, reserved and documentation
  ranges; the relay also resolves names and refuses those that point there.
- **Client-side discovery had no such filter, and the CSP allowed it
  (medium).** A hostile relay could return loopback addresses in its peer list
  and the browser of whoever opened the application would query them. The SDK
  now applies the same filter; following private addresses is an explicit option
  the application enables only when its own relay is already local. The
  production CSP went back to `connect-src 'self' https:`.
- **The announcement signature did not cover the relay's name (low).** The name
  was removed from the announcement: it now claims only "I am this relay at this
  address", and everything else is read from that address.
- **A valid announcement did not prove control of the announced address
  (low).** The receiver now queries the address before believing it.
- **Resuming with a different file of the same size could reuse a nonce
  (low).** The ticket carries a commitment to the content and any other file is
  refused; in addition a chunk is re-sent to every relay as soon as one is
  missing it, so a relay that already had it verifies the bytes.

Reviewed with no findings: the GF(256) arithmetic, Reed-Solomon and Shamir, the
nonce space, the binding of the AAD to the version, the PBKDF2 parameters, TLS
validation through the SOCKS5 proxy, the relay's authorisation and path
handling, the seven binary parsers, and the absence of secrets in logs.

### Still unresolved

These are not omissions: they are known limits documented in
[the threat model](docs/THREAT_MODEL.md).

- The web application does not route through Tor; only the CLI can.
- The timing and volume of a transfer remain observable.
- There is no P2P or proximity transport.
- There is no mix routing and no resistance to a global observer.
- A PDF's `/Info` dictionary and the metadata of exotic TIFF/HEIF are not
  cleaned.

## [0.1.0]: 2026-08-29

- The first runnable version: web, CLI, SDK and a temporary relay
  interoperating, with AES-256-GCM encryption on the client, capability links
  and a TTL.
