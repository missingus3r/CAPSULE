# CAPSULE: product and protocol roadmap

**Status:** 1.3 released; what follows is proposed by milestone, with no dates
**Date:** 2026-08-30

## 1. Where the project is going

CAPSULE aims to make sending a private, temporary file as simple as sharing a
link, with no account, no wallet and no network configuration. The architecture
grows in layers: first an encrypted transport that can be run and tested; then
distributed availability, direct and local transport; and only after specific
research, strong metadata protection.

Version 0.1 was not to be sold as an anonymity network. Its concrete value was:

- encryption and authentication on the client;
- a relay unable to read content or private metadata;
- a temporary capability link;
- early deletion and operation with no accounts;
- a small, auditable, interoperable implementation.

## 2. Principles of evolution

1. **A usable product before an empty network.** Every layer must solve a
   complete flow for real people.
2. **Do not invent cryptography.** Use reviewed primitives and protocols; any
   new construction needs specialist review.
3. **Claims proportional to evidence.** P2P does not imply anonymity, multi-relay
   does not imply unlinkability, and a TTL does not imply self-destruction.
4. **No mandatory token.** No user should have to hold a cryptoasset to send or
   receive. Operator incentives are considered after costs are measured.
5. **Versioned compatibility.** A published capsule keeps its semantics; nonce,
   AAD, fragment and API do not change silently.
6. **Privacy by default.** Minimise logs, dependencies, third parties, identity
   and retention before adding complex mechanisms.
7. **Milestones behind quality gates.** Do not advance just because it "works
   in a demo".

## 3. Overview

| Milestone | Main result                                                    | Improvement                                                | Still unsolved                                       |
| --------- | -------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------- |
| v0.1 ✅   | Web + CLI + temporary relay, interoperable                     | Content confidentiality, integrity and TTL                 | Anonymity, high availability, recovery               |
| v0.1.x    | Hardening and reproducible operation                           | Fewer failures, less abuse, fewer operational leaks        | Dependence on one relay                              |
| v0.2 ✅   | Open relay network, partial anonymisation, optional permanence | Availability, less metadata in name/size/IP                | Global correlation, network anonymity in the web app |
| v0.3      | P2P transfer                                                   | Less central storage, local speed                          | P2P reveals IP to peers and infrastructure           |
| v0.4      | Proximity: BLE and local Wi-Fi                                 | Exchange with no internet                                  | Proximity anonymity and perfect mobile background    |
| v0.5 ✅   | Opt-in recovery (shipped in 1.0)                               | Fewer irreversible losses                                  | Recovery without widening the attack surface         |
| v0.6 ✅   | Mix transport (shipped in 1.1)                                 | Metadata protection against a defined adversary            | Free low latency, or anonymity with a small network  |
| v1.0 ✅   | Stable protocol, internal review                               | Verifiable trust for third parties                         | Absolute security; an external audit                 |
| v1.2 ✅   | `.capsule` sites and a browser extension                       | Publishing with no registrar and no certificate            | Mix routing from the browser                         |
| v1.3 ✅   | Bridges, offline capsules, uniform manifests                   | Reaching the network when it is blocked; working with none | A large anonymity set; a TCP tunnel                  |

Future labels are directional: they can be reordered if testing shows a
different dependency. Every milestone either preserves read compatibility or
publishes a new protocol version.

Recovery was pulled forward into 1.0 because capsules without expiry made it
urgent: losing the owner capability of a capsule that never expires is a
permanent loss, and waiting two milestones for that had no defence.

## 4. v0.1: Minimum runnable

### 4.1 Deliverables

#### Protocol and SDK

- CAPSULE v1 format as described in [PROTOCOL.md](./PROTOCOL.md).
- A random AES-256-GCM key and nonce prefix per capsule.
- The encrypted manifest at cryptographic index 0, and independent chunks from 1.
- A capability URL in the fragment, and a separate owner capability.
- An SDK with create/upload/finalize/download/delete and progress.
- Interoperability, limit and tampering tests.

#### Relay

- HTTP v1 API with reservations, chunked upload, atomic finalisation, reading
  and deletion.
- Local storage with minimum permissions and hashed tokens.
- TTL applied before reading, and periodic cleanup of primary storage.
- Environment configuration for CORS, sizes, chunk count and TTL.
- Request limits, basic rate limiting and cleanup of incomplete reservations.
- A health check that reveals nothing about capsules.

#### Web application

- Create flow: file, TTL, optional note, progress, link and owner capability.
- Receive flow: validate the fragment, download, authenticate, save.
- Keyboard-usable interface, visible focus and actionable errors.
- No analytics, advertising or third-party scripts in the sensitive view.
- A visible notice: "whoever holds the link can read it; v0.1 does not hide
  your IP".

#### CLI

- `create`, `download` and `delete` with stable exit codes.
- Terminal progress and optional JSON output for scripting.
- Protection against accidentally printing secrets in verbose mode.

#### Operation and documentation

- Reproducible local execution and example configuration.
- An HTTPS deployment guide and log/proxy redaction.
- The SRS, protocol, threat model and this roadmap kept in sync.
- A vulnerability policy and security contact before any public instance.

### 4.2 v0.1 exit gate

v0.1 ships only if:

- web, CLI and SDK exchange 0-byte files, chunk-boundary files and at least
  10 MiB with an identical final hash;
- altering the manifest, a chunk, a tag or an index always fails closed;
- no keys or complete capabilities appear in logs, relay URLs, errors or test
  artefacts;
- an incomplete capsule is never readable;
- expiry and DELETE have race and cleanup tests;
- limits are applied before consuming unbounded memory or disk;
- the web headers, CORS, CSP and redirects have been reviewed;
- the UI never says "anonymous", "untraceable" or "self-destructing".

## 5. v0.1.x: Hardening

Goal: operate v0.1 honestly before distributing the architecture.

- Resumable upload and download from a chunk inventory.
- Defined idempotency for chunk/finalize retries, without permitting an
  overwrite with different bytes.
- Uniform external errors, to reduce enumeration of valid IDs.
- Per-instance quotas and defence against abandoned reservations.
- Aggregate metrics with no IDs, tokens, persistent IPs or high cardinality.
- Interchangeable storage backends and crash/recovery tests.
- Signed CLI builds, checksums and an SBOM.
- Fuzzing of the fragment, the manifest, relay JSON and the state machines.
- Cross-compatibility on Windows, macOS, Linux and the target browsers.
- Review of dependencies, supply-chain surface and an upgrade policy.

**Gate:** a test instance must run for a sustained period, with cleanup
failures and disk usage observable, retaining no secrets in telemetry.

## 6. v0.2: Open network, partial anonymisation and optional permanence

**Status: implemented.** Goal: that one relay going down or being blocked does
not destroy the capsule, that the sender can decide how much is revealed, and
that anyone wanting to contribute infrastructure can do so without asking.

### 6.0 Delivered

**Open relay network**

- An Ed25519 identity per relay, generated at startup and persisted in
  `identity.json`; `relayId` is the digest of the public key.
- `GET /v1/info`, `GET /v1/peers` and `POST /v1/peers/announce` with signed
  announcements and a ±5 minute window.
- Periodic gossip: greeting configured and known peers, verifying every learned
  address against `/v1/info`, eviction after repeated failures, and a
  `CAPSULE_MAX_PEERS` cap.
- SSRF defence: loopback, link-local, private ranges and CGNAT are refused
  unless explicitly enabled for local networks.
- Client-side discovery (`discoverRelays`, `selectRelays`), optional
  replication with `mirrors` in the capability, read failover, and deletion
  addressed to every relay with an honest report of the ones that did not
  confirm.

**Anonymisation**

- Stripping the file's own metadata before encrypting: JPEG (APPn and
  comments), PNG (`tEXt`/`zTXt`/`iTXt`/`eXIf`/`tIME`) and WebP (`EXIF`/`XMP`
  plus the `VP8X` flags). Unsupported formats are reported as such.
- A neutral name and mime type in the manifest.
- Size-class padding in quarter-octave steps with a 64 KiB floor; every chunk
  ends up the same size and the receiver downloads the padding too.
- Optional jitter between chunks.
- SOCKS5/Tor transport in the CLI (`--proxy`, `--tor`), with name resolution at
  the proxy and `.onion` support.
- A relay that retains no IPs by default: no addresses in logs, and rate
  limiting by a hash with a rotating salt.

**Capsules without expiry**

- `expiresAt: null` in the v2 manifest and `expiresInSeconds: null` in the API.
- On by default under a quota (`CAPSULE_MAX_PERSISTENT_BYTES`, a gigabyte
  unless raised), with `507` when it runs out and an operator switch to refuse
  them entirely.
- Periodic cleanup never touches them; only the owner capability deletes them.

### 6.1 Design still to be validated

- A capability with an authenticated list of relays and independent tokens.
- A configurable policy:
  - **full replica** (implemented), simple but expensive and correlatable; or
  - **`k`-of-`n` erasure coding** (implemented in 1.0), more efficient but more
    complex.
- Bounded concurrent download, fallback and deterministic reconstruction.
- Client consensus on TTL and state; no relay extends the retention the others
  promised.
- Best-effort deletion addressed to every relay, with an honest report of the
  ones that did not confirm.
- Selecting independent operators, and signed, versioned discovery.

### 6.2 New risks

- More relays observe timing and size, widening the metadata surface.
- A manifest carrying endpoints can make correlation easier.
- Colluding operators can withhold shards or block reconstruction.
- Erasure coding is not encryption; shards stay inside the encrypted envelope
  and do not replace AES-GCM.

**Permitted claim:** "it tolerates the configured unavailability of relays".
**Not permitted:** "it is anonymous because it uses several servers".

## 7. v0.3: P2P transfer

Goal: allow direct delivery when both devices are available, keeping the relay
as a temporary fallback.

- Session negotiation authenticated by an ephemeral capability.
- Candidate initial transport: WebRTC DataChannel or QUIC/libp2p, evaluated on
  portability and identification surface.
- ICE/STUN/TURN documented; the user must know when their IP is revealed to a
  peer or to signalling infrastructure.
- Resumption, congestion control and per-chunk verification identical to the
  relay flow.
- "Direct only" and "relay fallback" modes clearly separated.
- Minimal signalling, with no global user directory.

**Gate:** web/desktop interoperability, correct behaviour behind NAT and across
disconnections, and a screen explaining IP exposure before P2P begins.

## 8. v0.4: BLE and local Wi-Fi

Goal: share nearby capsules without depending on the internet, especially on
mobile and unstable networks.

- Pairing via QR/NFC or a short authenticated code.
- BLE discovery with ephemeral, rotating identifiers.
- Data transport over local Wi-Fi / Wi-Fi Direct where available; BLE is
  preferred for discovery and control, not for large files.
- Optional store-and-forward with a local TTL and battery/space limits.
- Protection against replay, the wrong device, and transport downgrade.
- An explicit strategy for background restrictions on Android and iOS.

**Non-guarantees:** nearby devices can observe radio, presence and patterns;
operating-system permissions and APIs remain trust points.

## 9. v0.5: Opt-in recovery

**Status: implemented in 1.0.** Two of the candidates below shipped: encrypted
export under a passphrase (PBKDF2-SHA-256 + AES-GCM, with versioned parameters
bound to the ciphertext) and `k`-of-`n` splitting of a capability between people
or devices, with no digest of the secret in the shares. Central escrow and
"reset by email" were not added and will not be. Argon2id is still pending, and
is noted in §14.1.

In v0.1 a lost key could not be recovered. Adding recovery always creates
another access path; that is why it must be optional, visible and separate from
the content relay.

Candidates to prototype:

- an offline recovery code generated by the client;
- `k`-of-`n` secret splitting across chosen devices or contacts;
- an encrypted export under a passphrase with a brute-force-resistant KDF, for
  example Argon2id with versioned parameters;
- E2EE synchronisation between already-authorised devices;
- recovery of the `deleteToken` independently, without granting read access
  where it is not needed.

Central escrow by default will not be added, nor a "reset by email" that hands
the server unilateral decryption power.

**Gate:** a formal analysis of the trade-offs, a UI showing who can recover,
loss/rotation tests, and cryptographic review of the chosen scheme.

## 10. v0.6: Experimental mix routing

Goal: investigate metadata protection against a defined adversary, not add a
cosmetic chain of proxies.

Mandatory prior work:

1. Decide whether the aim is to resist the relay, the local ISP, several
   colluding relays, or a global passive observer.
2. Measure acceptable latency, bandwidth and battery on real mobile networks.
3. Select a published construction, for example Sphinx-style packets and a
   mixnet with batching and delays, rather than designing ad hoc cryptography.
4. Design the directory, rotation and node admission with Sybil defence.
5. Evaluate size-class padding, fragmentation, delays, reordering and cover
   traffic.
6. Solve censorable bootstrap and list updates without a single silent
   authority.
7. Publish simulations and a testnet before integrating the mode into the
   stable application.

The client should be able to choose a fast path for ordinary transfers and a
mix path for high risk, showing the cost and the guarantee. That choice must not
hide the fact that a small anonymity set offers little protection.

**Gate:** a specific threat model, public measurements, academic or external
review, real operator diversity, and no anonymity claims based only on the
number of hops.

## 11. v1.0: Stability and external audit

v1.0 does not mean "no bugs"; it means a stable contract, reproducible evidence
and a mature response process.

### 11.1 Freeze beforehand

- A byte-for-byte specification and API that are candidates for stability.
- Official test vectors and a conformance suite for third parties.
- A compatibility, migration and end-of-life policy for versions.
- A threat model updated for every transport enabled by default.
- Reproducible builds, signed artefacts, lockfiles and an SBOM.

### 11.2 Independent reviews

- A cryptographic audit of the protocol, nonces, capabilities and recovery.
- A pentest of the web app, CLI, relay, CORS/CSP, storage and deployment.
- A privacy/metadata review with traffic capture.
- Continuous fuzzing and static/dynamic analysis.
- A mobile review for keystore, background, BLE/Wi-Fi and OS backups.

Critical and high findings must be fixed and revalidated before v1.0. The public
report may redact exploitable detail during an embargo, but it must publish
scope, methodology, date and remediation status.

### 11.3 Operation afterwards

- `security.txt`, a coordinated disclosure channel and a triage SLA.
- A public incident history and advisories per version.
- Rotation and revocation of distribution keys.
- A bug bounty programme once there is capacity to respond.
- Repeated audits after protocol changes, not a permanent seal.

## 12. Decision metrics

Metrics are for deciding architecture, not for claiming security by
popularity.

| Area                | Useful measure                                                                                    |
| ------------------- | ------------------------------------------------------------------------------------------------- |
| Reliability         | Percentage of complete round trips by size/network, and the cause of failures                     |
| Integrity           | Zero files published after a partial or failed authentication                                     |
| Time bounds         | p50/p95 delay between expiry and primary deletion                                                 |
| Operational privacy | Zero secrets in logs/telemetry; an inventory of retained metadata                                 |
| Resources           | CPU, memory, extra bytes and battery per MiB                                                      |
| Multi-relay         | Reconstruction success under `n-k` failures, and storage cost                                     |
| P2P/local           | Success behind NAT, connection time, IP exposure and battery spend                                |
| Mix                 | Latency, padding, cover traffic, effective anonymity set size and measured correlation resistance |
| Recovery            | Legitimate recovery rate, user errors, and new compromise paths                                   |

"Number of nodes" will not be used as a substitute for jurisdictional
diversity, operational independence, real usage or Sybil resistance.

## 13. Decisions that need evidence before adoption

- A blockchain or network token.
- A cryptographic algorithm of our own.
- A public DHT that exposes IDs or eases enumeration.
- Server-side preview of encrypted files.
- Third-party CDN or analytics in the sensitive application.
- Global identity, phone numbers or a centralised social graph.
- Custodial recovery enabled by default.
- Marketing labels like "anonymous", "traceless" or "self-destructing".

The preferred route is to keep a small, composable core: a usable encrypted
transport first; distribution and proximity next; anonymity only when its
model, cost and evidence are honest.

## 14. After 1.0: options and improvements for the next version

v1.0 closed out the encrypted transport, content anonymisation and the open
network. What remained fell into four classes, ordered by what they actually
give somebody using CAPSULE today rather than by how impressive they sound.

### 14.1 Finish what was half-done (v1.1)

Bounded work with a clear definition of done and no protocol change.

| Pending                                        | Why it matters                                                          | Definition of done                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Cleaning `/Info` in PDFs                       | The most common document format, and the one that leaks authorship most | Incremental rewriting verified against a real corpus, without corruption  |
| TIFF, exotic HEIF, audio containers            | Today they are sent unchanged                                           | Support or explicit refusal per format, never silence                     |
| Pinning the connection to the resolved address | Closes the DNS rebinding window described in the threat model           | A custom connector using the verified address, with a regression test     |
| Argon2id as the recovery KDF                   | PBKDF2 protects a short passphrase poorly against GPUs                  | `kdf: "argon2id"` with versioned parameters, still reading the old form   |
| Interchangeable storage backends               | A serious relay does not want everything on one local disk              | A storage interface and one non-local implementation, with crash tests    |
| Aggregate metrics                              | An operator needs to see usage without retaining anything               | Counters with no IDs, no tokens, no IPs and no high cardinality           |
| Reproducible and signed builds                 | Checksums and an SBOM are published today, but signing is manual        | A reproducible build a third party can verify, and signing in the process |

### 14.2 New scope with new transport (v1.2 onwards)

Each of these changes the threat model and needs its own section before a line
of code is written.

**P2P transfer.** Direct delivery when both devices are available, with the
relay as backup. Entry gate: a screen explaining IP exposure **before**
connecting, correct behaviour behind NAT, and "direct only" and "with fallback"
modes separated without ambiguity. It does not start without deciding the
transport (WebRTC or QUIC) by measuring its identification surface, not its
convenience.

**Proximity: BLE and local Wi-Fi.** Exchange with no internet. Entry gate:
pairing authenticated by QR or a short code, ephemeral rotating identifiers in
discovery, and an explicit strategy for Android and iOS background
restrictions. BLE for discovery and control; files over Wi-Fi.

**E2EE synchronisation between the sender's own devices.** Today a capability
lives where it was created. Entry gate: a design where the second device is
authorised without any server being able to decrypt.

### 14.3 Metadata protection

**Built in 1.1**, with points 1, 3 and 4 of the original list resolved: the
adversary is defined (the storing relay, and to a degree the intermediate
nodes), the construction is published (Sphinx and Loopix, used as specified),
and there are delays and cover traffic. The design is in
[MIXNET.md](./MIXNET.md) and the model in [THREAT_MODEL.md](./THREAT_MODEL.md).

What is **missing**, in order of importance:

1. **Independent operators and users.** This dominates everything else and is
   the only one that is not solved by writing code. Without several operators
   who do not know each other, the network is machinery around a single party
   that sees both ends.
2. **Published measurements**: real latency, the cost of cover traffic, the
   effective anonymity set size and measured correlation resistance, on real
   mobile networks.
3. **A reasoned decision about guard nodes.** Today the first hop is re-chosen
   on every request. Tor chose the other way after years of analysis; here the
   decision was made by default, not by evidence.
4. **Browser support**, once X25519 in Web Crypto is available everywhere.
5. **External cryptographic review** of this composition.

Point 6 of the original list, censorship resistance, was addressed in 1.3
with bridges; see [CENSORSHIP.md](./CENSORSHIP.md) for what that does and does
not cover.

None of this is on by default, and no version will say "anonymous" for having
more hops. A small anonymity set offers little protection however impressive
the topology looks, which is why the CLI prints its real size before every
send.

### 14.4 Trust that third parties can verify

- **An external cryptographic audit** of the protocol, the nonces, the
  capabilities and recovery. The v1.0 review was internal and is labelled that
  way; an independent audit is a different thing.
- **A pentest** of the web app, CLI, relay, CORS/CSP, storage and deployment.
- **A privacy review with traffic capture**, to compare what the threat model
  claims with what is visible on the wire.
- **Continuous fuzzing** in CI, not just the current suite.
- **`security.txt`, a coordinated disclosure channel and a triage SLA** before
  operating a public instance with real users.
- **A public incident history** and advisories per version.

Critical and high findings are fixed and revalidated before any audit is
announced; the report may omit exploitable detail during an embargo, but must
publish scope, method, date and remediation status.

### 14.5 What still needs evidence before adoption

Unchanged since v0.1, and for the same reasons:

- a blockchain or network token;
- a cryptographic algorithm of our own;
- a public DHT that exposes identifiers or eases enumeration;
- server-side preview of files;
- third-party CDN or analytics in the sensitive application;
- global identity, phone numbers or a centralised social graph;
- custodial recovery enabled by default;
- marketing labels like "anonymous", "traceless" or "self-destructing".

## 15. After 1.2: sites and the mix network

### 15.1 What has to be fixed before anything is added

**Letting the extension use the mix network.** Today it queries relays directly
and a relay sees an address asking about a name. That is the difference between
"a site that cannot track you" and "a site that cannot track you but the relay
can". It needs the mix client ported to WebCrypto and the problem of an MV3
service worker going to sleep solved; neither is trivial and both are
necessary.

**An external audit.** Of the composition, not the primitives. With scope,
method and date published, and the result published whatever it is. Until that
exists, everything this repository says rests only on this repository.

**A reasoned decision about guard nodes.** Today the first hop is re-chosen on
every request. Tor chose the other way after years of analysis. CAPSULE's
decision was made by default, not by argument, and that needs correcting with
analysis that either supports or reverses it.

**Independent operators.** None of the above matters without relays in
different jurisdictions that do not know each other. That is community work,
not code, and it is the real bottleneck.

### 15.2 Sites: what 1.2 left open

- **Firefox and Safari.** The extension is MV3 with `declarativeNetRequest`.
  Firefox needs a port; Safari, another.
- **Large sites.** Today the bundle is downloaded whole so that no page-read
  pattern exists. A scheme that fetched fixed-size padded blocks could keep the
  property and scale; it needs designing, not improvising.
- **Readable names, with no registrar.** A signed pointer file published by
  somebody the visitor already trusts, like an organisation publishing its
  `.onion` on its own site, does not reintroduce a central registrar. It is
  worth exploring, carefully enough not to become one.
- **A real "reading only" mode.** Today scripts are turned off per site. There
  is no way yet to say "never, on any site" and have that be the extension's
  default with no exception possible.

## 16. After 1.3: what is next

### 16.1 A general-purpose TCP tunnel: _work in progress_

Tor, I2P, Lokinet and Yggdrasil carry any TCP connection. CAPSULE carries files
and static sites, and the comparison tables say so. This is the design intended
to close that, written down here so the claim "in progress" means something
more than an intention.

**Why it is not an extension of the capsule format.** A capsule assumes the
content is known in full before anything is sent: that is what makes size-class
padding, chunk counts and `k`-of-`n` sharing possible. A stream is the opposite:
unbounded, interactive, with timing that carries meaning. So this is a second
format beside the existing one, not a change to it.

**The shape it should take.**

- A **stream frame** that fits exactly one mix packet payload, so a tunnel is
  indistinguishable on the wire from a capsule transfer and from cover traffic.
  The 64,512-byte plaintext budget is already the unit everything else uses.
- **Constant-rate framing**, with padding frames sent when there is nothing to
  send. Otherwise the shape of the stream is the shape of the conversation, and
  a tunnel over a mix network would leak more than a capsule does.
- A **SOCKS5 listener** on the client, because everything already speaks it,
  including CAPSULE's own `--proxy`.
- An **exit decision that is explicitly the operator's**, not a default. This is
  the hard part and it is not technical: an exit node sees plaintext traffic to
  the open internet, with the legal exposure Tor exit operators know well. It
  must be off unless deliberately switched on, with the consequences stated in
  the operator guide before the switch exists.

**What has to be settled first.**

1. Whether CAPSULE should have exit nodes at all. Everything in the design so
   far has avoided them: the destination is always the relay itself, so no
   party ever sees plaintext without being its recipient. A TCP tunnel breaks
   that property, and it may be the wrong trade for this project.
2. The latency budget. Per-hop delays that are reasonable for a file are
   unusable for a shell session. Either the tunnel gets a shorter delay profile,
   and says what that costs, or it is only useful for things that tolerate
   seconds.
3. Congestion and backpressure across a mix network that deliberately reorders
   and delays, which is not a solved problem in the literature.

**Definition of done.** A SOCKS5 endpoint carrying a real TCP session through
at least three hops; constant-rate framing verified by capture; exits off by
default with documented operator consequences; and an updated threat model
section written **before** the feature is enabled anywhere.

### 16.2 What would widen the scope

- **P2P transport.** Two clients that can see each other passing a capsule with
  no relay, with the relay as backup.
- **Proximity transports.** Bluetooth or Wi-Fi Direct. Offline capsules and LAN
  discovery cover the "no internet" case in 1.3; radio and mesh are still not
  covered, and are what Briar and Meshtastic are for.
- **Pluggable transports.** Bridges landed in 1.3, but there is no protocol
  obfuscation and the TLS fingerprint is Node's. Worth looking hard at what
  already exists before writing anything.
- **Messaging.** The capsule format assumes content known in advance. A
  conversation is not. It would be a different format over the same network, not
  an extension of this one.

### 16.3 What will not be done

- **A token, blockchain or relay economy.** It solves the incentive by creating
  a worse problem: something to capture.
- **Accounts.** A persistent identifier is exactly what this project exists in
  order not to have.
- **Cryptography of our own.** The primitives come from the literature. What is
  new is the composition, and that is already enough unaudited surface.
