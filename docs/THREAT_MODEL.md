# CAPSULE — threat model

**Status:** current for CAPSULE 1.3
**Date:** 2026-08-30
**Scope:** protocol v1, v2 and v3; the web app, CLI, SDK, browser extension and
reference relay

Sections 1 to 11 describe the v0.1 model and remain the foundation. Section 12
covers what changed in v0.2 (partial anonymisation, capsules without expiry, an
open network), 13 covers v1.0 (`k`-of-`n` sharing, recovery, and the findings of
the security review with their fixes), 14 the mix network of 1.1, 15 the
`.capsule` sites of 1.2, and 16 the bridges, offline capsules and uniform
manifests of 1.3.

## 1. Executive summary

CAPSULE is designed so that a relay can store and deliver a temporary file
**without knowing its content or its private metadata**. The file is encrypted
on the client and the key travels in the link's fragment, not in the HTTP
requests to the relay.

The promise ends there. CAPSULE **is not an anonymity network**. The relay, the
internet provider, a CDN or a network observer can infer who connects, when, how
much they transfer and which relay they use. There is also no technical way to
stop a recipient copying the file, or to prove that a malicious relay deleted
all of its backups.

A safe statement for the product:

> CAPSULE protects the content and detects tampering for as long as the key
> stays secret. The link grants access. It does not hide network identities and
> does not guarantee that copies disappear.

## 2. System and trust boundaries

```text
              external channel carrying the capability URL
   Sender ---------------------------------------------------> Recipient
      |                                                             |
      | client encrypts locally                         client decrypts
      |                                                             |
      +---------------- HTTPS ------------+------------- HTTPS -----+
                                           |
                                     Untrusted relay
                                ciphertext, TTL and capabilities
                                           |
                                  storage / backups / logs
```

Relevant boundaries:

1. **The sender's device.** Sees plaintext, the name, the note, the keys and
   every capability.
2. **The web application's origin.** Serves the JavaScript that later reads the
   fragment. It is part of the trust base; a compromised origin can steal the
   capability even though the relay never receives it as a URL.
3. **The sender–relay channel.** Must use TLS in production. The file keeps its
   end-to-end encryption as well.
4. **The relay and its storage.** Treated as honest or malicious depending on
   the threat. Never trusted for confidentiality or integrity; depended on for
   availability, TTL enforcement and deletion.
5. **The channel used to share the link.** Sees the complete capability. If it
   is not confidential, any observer of it can read the capsule.
6. **The recipient's device.** Sees the capability and the plaintext. After
   download it is outside CAPSULE's control.

The CLI reduces the dependence on dynamically served JavaScript, but still
trusts the binary, its dependencies, the operating system and its distribution
mechanism.

## 3. Assets

| Asset                              | Confidentiality                          | Integrity                            | Availability/retention                  |
| ---------------------------------- | ---------------------------------------- | ------------------------------------ | --------------------------------------- |
| File content                       | High                                     | High                                 | Until the TTL, with no strong guarantee |
| Name, MIME, note and original size | Name/MIME/note: high; size: partial only | High, via the authenticated manifest | Same as the capsule                     |
| `key` and `noncePrefix`            | Critical                                 | High                                 | Not recoverable                         |
| Capability URL and `readToken`     | Critical                                 | High                                 | Valid until deleted or expired          |
| `writeToken`                       | Critical during upload                   | High                                 | Can be discarded after finalising       |
| `deleteToken`                      | Critical to the owner                    | High                                 | Not recoverable                         |
| IP address and access pattern      | Desirable, but not protected by default  | Not applicable                       | May appear in infrastructure and logs   |
| Capsule state/TTL                  | Partly visible to the relay              | Important                            | Enforced by the relay                   |
| Relay availability                 | Not applicable                           | High                                 | Not guaranteed                          |

## 4. Observable information

### 4.1 What the relay can observe

- The client's IP and connection characteristics, unless the client uses a
  compatible privacy network of its own.
- The time of creation, uploads, reads, deletion and expiry.
- The identifier, state, chunk count and encrypted byte count.
- The requested and effective TTL, and the frequency of retries.
- Bearer tokens while it processes a request. It should keep only their hashes,
  but a malicious relay can record the values.
- A probable correlation between an upload and later reads, by size and time.

### 4.2 What the relay should not be able to observe

- The AES key or the nonce prefix.
- The file's plaintext.
- The name, MIME type, note and exact original size inside the manifest, though
  it can approximate the size from the ciphertext and overhead.
- The channel or human identity through which the link was shared.

### 4.3 Other observers

- ISPs, DNS, CDNs and network observers can see IPs, domains, times and
  volumes. TLS hides paths, headers and bodies from passive observers, but not
  from the TLS endpoint.
- The messaging service used to share the link can see the complete capability
  and decrypt the capsule.
- Browser history and sync, the clipboard, extensions, screenshots, antivirus
  and local malware can capture the link or the plaintext.

## 5. Adversaries considered

| ID  | Adversary                             | Capabilities                                                                        |
| --- | ------------------------------------- | ----------------------------------------------------------------------------------- |
| A1  | Curious relay                         | Reads storage, operational metadata and requests; follows the protocol              |
| A2  | Malicious or compromised relay        | Omits, replaces, reorders or retains data; records tokens; lies about TTL and state |
| A3  | Passive local or network observer     | Observes connections, timing, volume, DNS/IP and potentially traffic without TLS    |
| A4  | Active network attacker               | Blocks, redirects or alters traffic; does not break correctly validated TLS         |
| A5  | Unauthorised reader                   | Obtains an ID, guesses tokens, enumerates endpoints or finds a leaked link          |
| A6  | Malicious recipient                   | Holds a legitimate capability, downloads, copies and redistributes plaintext        |
| A7  | Compromised web origin / supply chain | Modifies JavaScript or binaries to extract fragments, files or keys                 |
| A8  | Compromised device                    | Reads memory, disk, keyboard, screen, clipboard and files                           |
| A9  | Availability/abuse attacker           | Exhausts bandwidth, disk, CPU, descriptors or IDs through uploads and reads         |
| A10 | Global observer                       | Correlates ingress and egress at network scale, by time and size                    |
| A11 | Censor                                | Enumerates and blocks relay addresses, probes suspected ones, fingerprints traffic  |

It is not assumed that an attacker can break AES-256-GCM, SHA-256, a healthy
CSPRNG or correctly implemented modern TLS. If that assumption changes, the
protocol version has to be revisited.

## 6. Guarantees

These are conditional on correct clients, safe entropy and the capability
staying secret:

1. **Content confidentiality at the relay.** Stored ciphertext without the
   `key` does not practically reveal plaintext, name, MIME type or note.
2. **Cryptographic integrity and authenticity.** Altering one bit of the
   manifest, a chunk or a tag makes AES-GCM fail.
3. **Authenticated position.** The index-dependent nonce and AAD detect
   reordering or substitution between positions.
4. **Isolation between capsules.** Independent keys and prefixes stop the
   compromise of one capsule decrypting the others.
5. **Non-enumerable capability access.** With random IDs and tokens plus rate
   limits, guessing a 256-bit capability is not feasible.
6. **The key is absent from the relay's normal API.** The format uses the URL
   fragment, which the browser does not send in standard HTTP requests.
7. **Time bounds with a conforming relay.** An honest relay refuses reads after
   the TTL and deletes its primary copy per the documented policy.
8. **Operational revocation.** The owner can request early deletion through a
   capability distinct from the read one.

Content authentication means "produced by somebody who had the key". It does
not identify the sender legally and provides neither a signature nor
non-repudiation.

## 7. Explicit non-guarantees

CAPSULE does not guarantee:

- **Anonymity, unlinkability or network metadata protection by default.**
  Without `--mix`, there is no mixing, padding of the connection, or cover
  traffic.
- **Correlation resistance.** An observer can link an upload of size X with a
  similar download shortly afterwards.
- **Availability or censorship resistance in general.** A relay can go down,
  block a country, delete data or be blocked. Bridges (§16) address enumeration
  and probing, not traffic analysis.
- **Verifiable deletion.** TTL and DELETE do not prove that backups, snapshots,
  logs, retained ciphertext or the recipient's copies are gone.
- **Control after download.** There is no DRM; the recipient can save,
  photograph or redistribute.
- **Endpoint security.** Malware, extensions, the browser, the operating
  system, malicious JavaScript or a compromised supply chain can steal
  plaintext and secrets.
- **Secrecy of the sharing channel.** The link is the credential. A preview
  bot, a chat history or any third party that sees it can open it.
- **Forward secrecy within a capsule.** If the key leaks in the future,
  previously recorded ciphertext can be decrypted. Key separation does limit
  the incident to that capsule.
- **Plausible deniability, signature, authorship or non-repudiation.** The
  format signs no identities.
- **Protection against malicious files.** Encrypting and authenticating does not
  make an executable, active document or payload safe.
- **Recovery.** Losing the link, the key or the `deleteToken` is irreversible
  unless recovery was set up in advance.
- **Comprehensive post-quantum privacy.** No such promise is made, and the
  endpoints and external channels are not protected against that adversary.
- **Automatic legal compliance.** Encryption does not replace policies,
  contracts or obligations applying to the operator.

## 8. Threat analysis and controls

| Threat                                | Control                                                                                       | Residual risk                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Relay or disk thief reads files       | AES-256-GCM on the client; the key never reaches the relay                                    | Size, time and pattern stay visible; a leaked capability decrypts                                      |
| Relay alters or reorders ciphertext   | GCM tags, per-index nonce and AAD; size and count authenticated in the manifest               | It can omit everything or deny service                                                                 |
| GCM nonce reuse                       | CSPRNG; a new prefix per capsule; index 0 exclusive to the manifest; chunks never overwritten | A client bug can destroy the security; needs tests and review                                          |
| Enumeration and brute force           | IDs ≥128 bits, 256-bit tokens, uniform errors and rate limiting                               | The relay knows all of its own IDs; leaked links bypass brute force                                    |
| Network interception                  | HTTPS required in production, plus content encryption                                         | TLS does not hide IP/domain/volume; the TLS endpoint sees bearer tokens                                |
| Redirect steals a bearer token        | Endpoints with no redirects; clients must refuse them                                         | A compromised proxy or origin can still capture requests                                               |
| Leak through the fragment             | The fragment is not sent over HTTP; CSP, no third parties, `no-referrer`, address bar cleared | History, clipboard, extensions, preview bots and the external channel remain                           |
| Malicious web code                    | CSP, pinned build, minimal dependencies, future audit; the CLI as an alternative              | Dynamically served web code remains a strong trust point                                               |
| Token in logs                         | Redaction in the application, reverse proxy and errors; hashes at rest                        | A malicious operator or external configuration can still record it                                     |
| Path traversal / XSS via name or MIME | Metadata authenticated but treated as untrusted; name sanitised and download forced           | The user can still open a dangerous file locally                                                       |
| Use after the TTL                     | Validation before every read and an automatic cleaner                                         | A malicious clock or relay, backups, or an earlier download make disappearance impossible to guarantee |
| Storage abuse                         | Maximum size and TTL, reservations, quotas, rate limiting and cleanup of incomplete uploads   | Botnets and distributed DDoS can overwhelm a single instance                                           |
| Sender/receiver correlation           | `--mix` where the network is large enough; otherwise Tor or a VPN externally                  | High; deliberately a non-guarantee at small network sizes                                              |
| Relay unavailable or censored         | Mirrors, `k`-of-`n` sharing, clear errors and chunked download                                | No P2P; a censor who blocks every known relay blocks the network                                       |

## 9. Operational security requirements

A conforming production deployment must:

- terminate TLS with a modern configuration and disable public HTTP;
- redact `Authorization`, fragments and query strings in the app, proxy, WAF,
  observability and error reports;
- deploy no analytics or third-party scripts in the application that processes
  capabilities;
- send `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, a restrictive
  CSP and appropriate anti-sniffing headers;
- bound request size before buffering, as well as rate, connections, incomplete
  reservations, bytes per capsule and TTL;
- run the relay as an unprivileged user with access only to its own directory;
- separate configuration backups from ephemeral data and document whether they
  exist;
- keep the clock synchronised and monitor failures of the expiry process;
- keep metrics free of complete IDs or per-capability cardinality;
- rotate infrastructure credentials without pretending to rotate user
  capabilities already issued;
- have an administrative mechanism to withdraw abusive ciphertext without
  decrypting it.

## 10. Abuse and illegal content

Encryption prevents content-based moderation inside the relay. That protects
legitimate privacy and can also be abused. The controls are over observable
behaviour, not inspection of plaintext:

- small maximum TTL and size;
- rate limiting and quotas per origin, with a documented policy;
- cleanup of incomplete reservations;
- a reporting channel that accepts a `capsuleId` without publicly requesting the
  key;
- the operator's ability to withdraw an identified capsule;
- minimal log retention, with an explicit and proportionate exception in cases
  of abuse;
- clear terms that do not claim cryptography avoids liability.

Blocking by IP can affect NAT, proxies and privacy networks. Every anti-abuse
control must weigh false positives and must not quietly become a persistent
tracking mechanism.

## 11. Validation before publishing

### 11.1 Minimum automated tests

- Cross round trip between web/SDK/CLI at chunk boundaries.
- Alteration of ciphertext, tag, AAD and index.
- Wrong key, prefix and token.
- A duplicated index with different bytes.
- An incomplete reservation and premature finalisation.
- TTL, a race between reading and expiry, repeated DELETE.
- External equality of errors for a non-existent ID, an invalid token and an
  expired capsule.
- Body limits before allocating significant memory.
- A check that logs, URLs and fixtures contain no secrets.
- Authenticated redirects refused.

### 11.2 Minimum human review

- The exact entropy flow and nonce uniqueness.
- Web Crypto usage and tag lengths.
- CORS/CSP/header configuration and the absence of third parties.
- Sanitisation of name, MIME type and error messages.
- File handling, permissions, symlinks and atomic operations in the relay's
  storage.
- Dependencies, lockfile, SBOM and vulnerability alerts.

### 11.3 The condition for changing the claims

CAPSULE must not be described as "anonymous", "untraceable",
"self-destructing" or "trustless" until a future version defines a concrete
adversary, implements the necessary controls and passes external review. Adding
P2P or several relays does not on its own create anonymity.

## 12. Changes introduced in v0.2

v0.2 adds three capabilities that change the model: partial anonymisation,
capsules without expiry, and an open relay network. None of them makes CAPSULE
an anonymity network.

### 12.1 Anonymisation: what it covers and what it does not

| Mechanism                              | What an observer stops seeing                | What they still see                                               |
| -------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------- |
| Stripping the file's metadata          | EXIF/GPS/camera serial, XMP, PNG text chunks | The content itself, to whoever receives it; watermarks            |
| Neutral name and mime type             | The real name inside the encrypted manifest  | Nothing new: the manifest was already encrypted                   |
| Size-class padding                     | The exact size of the capsule                | The size class and the number of chunks                           |
| Jitter between chunks                  | The exact upload pattern                     | The start, the end and the total volume                           |
| SOCKS5/Tor in the CLI                  | The client's IP, from the relay              | That the connection exists, to the proxy and the local ISP        |
| Relay without IPs (`CAPSULE_IP_BLIND`) | The IP in logs and rate-limit state          | The IP on the socket while the connection lasts, and at the proxy |

Limits that have to be said out loud:

- Metadata stripping understands JPEG, PNG, WebP, ISO-BMFF containers, Office
  and ODF, and PDF XMP packets. For anything else the file is sent
  **unchanged** and the SDK reports it as unsupported. It must not be presented
  as "clean".
- Padding protects the size, not the moment or the frequency. An observer who
  sees "an 8 MiB-class capsule at 03:14" still has an event.
- `CAPSULE_IP_BLIND` reduces retention, not observation. The operating system,
  the load balancer and the network provider still see the connection.
- Tor in the CLI protects against the relay, not against an adversary watching
  both ends.
- The web application does not route through Tor. Saying otherwise would be
  false: the browser uses the user's own network.

### 12.2 Capsules without expiry

The TTL was the main retention control. Turning it off changes two things:

- **Sustained exposure.** A leaked link no longer stops working on its own.
  Whoever holds it reads until somebody uses the `deleteToken`.
- **Irreversible loss of control.** If the owner capability is lost there is no
  way to delete the capsule: there are no accounts and no support desk that can
  do it.

Controls in place:

- It is **on by default and bounded**, which is a deliberate change from
  earlier versions, where it was off and the operator opted in. What replaced
  the opt-in is the cap: a relay nobody configured accepts a gigabyte of
  storage without expiry and an eighth of that from any one sender, so the
  default commitment is a known quantity rather than an unbounded one. An
  operator who does not want it sets
  `CAPSULE_ALLOW_PERSISTENT_CAPSULES=false`.
- The residual risk this accepts is that a relay run by somebody who never read
  this document holds capsules with no end date. That was traded against the
  opposite failure, which was the common one: apps offering an option that
  almost every relay refused.
- `CAPSULE_MAX_PERSISTENT_BYTES` bounds how much storage without expiry can
  occupy; the relay answers `507 insufficient_storage` at the cap.
- Periodic cleanup never touches a capsule without expiry.
- The interface says so explicitly before the capsule is created, and the relay
  publishes it in `/v1/config` so the client does not discover it by failing.

A relay promising "forever" is promising something it does not control: it can
be switched off, lose its disk, or be seized. The documentation and the UI say
"until you delete it", not "permanent".

### 12.3 An open relay network

Letting anyone run a relay removes a single point of censorship and adds
surface:

| New risk                                       | Control applied                                                                                    |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| A peer invents relays that do not exist        | Every learned address is probed against `GET /v1/info` and kept only if the identity matches       |
| An attacker impersonates a relay's identity    | `relayId` is the digest of the public key; the announcement is Ed25519-signed with a ±5 min window |
| Directory poisoning (Sybil)                    | A `CAPSULE_MAX_PEERS` limit, eviction after repeated failures, and no automatic trust decisions    |
| SSRF from the relay itself while probing peers | Loopback, link-local, private ranges and CGNAT are refused unless `CAPSULE_ALLOW_PRIVATE_PEERS`    |
| A mirror widening the observation surface      | Mirroring is explicit and optional; each extra copy is one more operator seeing size and time      |
| A relay keeps a copy after deletion            | Deletion is best-effort and reported relay by relay; it is never claimed that the copy is gone     |

What the network does **not** solve: correlation between relays, real
jurisdictional diversity, or an operator's reputation. A large directory is not
evidence of independence. Choosing a mirror is still trusting a third party
with the size and timing of the transfer.

## 13. Changes introduced in v1.0

v1.0 froze the protocol and added three capabilities on top of v0.2: erasure
coded sharing, optional recovery of capabilities, and a hardening of the
network that came out of a security review of the code itself.

### 13.1 `k`-of-`n` sharing: what changes in the model

With full replication, **every** relay has the whole capsule: anyone who
compromises or pressures a single one has all the ciphertext and is only
missing the key from the link. With `k`-of-`n` sharing, a relay holds a shard
that on its own reconstructs not one byte, and `k` separate operators are
needed.

| Situation                      | Full replica           | `k`-of-`n` sharing                |
| ------------------------------ | ---------------------- | --------------------------------- |
| One relay seized               | Has all the ciphertext | Has a shard that is useless alone |
| `k - 1` relays colluding       | Have everything        | Reconstruct nothing               |
| `n - k + 1` relays down        | Any survivor serves it | The capsule cannot be read        |
| Storage cost                   | `n` times              | `n/k` times                       |
| Operators seeing size and time | `n`                    | `n` (the same)                    |

What does **not** change: the `n` relays still see that a transfer happened,
when, and of what size class. Sharing protects the content against a subset of
operators; it protects the metadata against none of them.

A relay that serves altered shards cannot corrupt the capsule: reconstruction
produces noise, the AES-GCM tag rejects it, and the reader tries another
combination of `k` shards. It can deny service, which is the honest counterpart
of requiring `k` of `n`.

### 13.2 Recovery: one more door, by choice

Protecting a capability with a passphrase, or splitting it into shares, **adds
a path to the secret**. That is desirable when the alternative is losing a
capsule without expiry forever, and it is a risk when the passphrase is weak or
the shares all end up in the same drawer.

- The passphrase is derived with PBKDF2-HMAC-SHA-256 at 600,000 iterations. It
  is the only password KDF available in Web Crypto on every platform CAPSULE
  runs on. **Against an attacker with a GPU it is weaker than Argon2id**: a
  short passphrase breaks. The format carries a KDF identifier so that a
  memory-hard function can be added later without breaking what is stored.
- Shamir shares carry no digest of the secret, precisely so that holding one
  share does not allow verifying guesses offline. Fewer than `k` shares reveal
  nothing, and that is a property of the construction rather than an assumption
  about the attacker.
- The relay takes part in neither and does not learn that they exist.

### 13.3 Findings of the v1.0 security review

The new code was reviewed with a focus on cryptography, authorisation, binary
parsers and network surface. Two exploitable problems and three smaller notes
were found. All are fixed; they are documented because the finding and the fix
are both part of the security history.

**1. The relay's address filter could be bypassed (medium).** The blocklist
compared strings, so `127.0.0.1` was blocked but `[::ffff:7f00:1]` — the same
address written in IPv6 — passed and reached the same socket. Verified by
execution. Since announcing requires no permission, anyone could make a public
relay query its operator's internal services, and republish that address to the
whole network.

_Fix:_ replaced with an address parser that normalises every equivalent form
(decimal IPv4, compressed IPv6, IPv4 embedded in IPv6, NAT64) and blocks
private, loopback, link-local, CGNAT, multicast, reserved and documentation
ranges, plus local names. The relay also **resolves** names and rejects those
pointing at such addresses.

**2. Client-side discovery had no such filter, and the CSP allowed it
(medium).** A relay's peer list is written by that relay. A hostile relay could
return loopback addresses, and the browser of whoever opened the application
would query them, turning it into a port scanner of its own machine. The v0.2
CSP had been widened to `http://localhost:*` and `http://127.0.0.1:*`, which is
exactly what was needed to achieve it.

_Fix:_ the SDK applies the same address filter to discovered peers and to the
address a relay declares for itself; following private addresses is now an
explicit option (`allowPrivateRelays`) that the application enables only when
its own relay is already local. The production CSP went back to
`connect-src 'self' https:`; the development server adds loopback and the build
does not.

**3. The announcement signature did not cover the relay's name (low).**
Resolved by removing the name from the announcement: an announcement now claims
only "I am `relayId` at `url`", and everything else is read from that address.

**4. A valid announcement did not prove control of the announced address
(low).** A signature proves who wrote the message, not who controls the address
inside it, so a directory could fill with other people's addresses. The
receiver now queries the address before believing it and stores it only if it
answers with the same identity.

**5. Resuming with a different file of the same size could reuse a nonce (low
in the review, fixed anyway).** With several relays at different points of
progress, two different plaintexts could end up encrypted under the same
`(key, nonce)` pair, which breaks AES-GCM. The resume ticket now carries a
commitment to the file's content and any other file is refused before a single
byte is sent; in addition, a chunk is re-sent to **every** relay as soon as one
is missing it, so a relay that already had it verifies that the bytes match.

**Reviewed with no findings:** the GF(256) arithmetic, Reed-Solomon and Shamir
(verified exhaustively by execution), the AES-GCM nonce space, the binding of
the AAD to the version, the PBKDF2 parameters, TLS validation through the
SOCKS5 proxy, authorisation and path handling in the relay, the seven binary
parsers (28,000 fuzzing inputs with no exceptions or hangs), and the absence of
secrets in logs.

### 13.4 Known residual risks

Listed because they are still there, not because they are acceptable forever.

- **DNS rebinding.** The relay resolves a name and verifies the addresses
  before connecting, but the platform does not allow pinning the connection to
  the verified address. Between the check and the request, a name can start
  resolving elsewhere. Closing it requires a custom connector; until then, an
  operator hosting sensitive internal services should isolate the relay on the
  network.
- **PDF `/Info`.** XMP packets are blanked without moving a byte, but the
  `/Info` dictionary can live inside a compressed object stream and is not
  touched. The interface says so explicitly rather than calling the file clean.
- **Unsupported formats.** TIFF, exotic HEIF and proprietary containers are
  sent unchanged, and that is reported.
- **The web application does not route through Tor.** Only the CLI can. Saying
  otherwise would be false: the browser uses the network of whoever opens it.
- **Timing and volume.** Still observable by every relay involved. Padding
  protects the size; nothing yet protects the moment.
- **Operator diversity.** The cap per apparent operator and the proof of work
  make Sybil expensive, not impossible. A large directory is not evidence of
  jurisdictional or operational independence.
- **The first relay a fresh install asks.** Bootstrapping needs an entry point,
  and whoever answers there decides which relays that install ever hears about
  — an eclipse, not a forgery, and mix routing through relays one party
  controls protects nobody. Two things bound it. A **pinned** seed must prove
  it holds the identity it was pinned to, by signing a challenge the client
  generated a moment ago; the identifier itself is `SHA-256(publicKey)`, so it
  cannot be claimed for a key the relay does not have. And a seed **can hide
  relays but cannot invent them**, because every relay learned through one is
  verified independently. What remains is that a seed which answers correctly
  can still show a partial view, and that the safest default is more than one
  seed run by more than one person. `DEFAULT_SEEDS` ships empty: an unpinned
  default would be strictly worse than none.

## 14. The mix network (1.1)

CAPSULE has its own mix network. This section says what changes in the threat
model; the design is in [MIXNET.md](./MIXNET.md).

### 14.1 What changes

Up to 1.0, the relay storing a capsule saw the address of whoever uploaded and
whoever downloaded it. In the CLI that could be covered with Tor. Now the
traffic can travel through a network of nodes that are the relays themselves.

| Observer              | Without the network      | With the network                         |
| --------------------- | ------------------------ | ---------------------------------------- |
| Storing relay         | Client IP, timing, size  | Only the operation and the previous node |
| First hop on the path | —                        | The client's IP, and nothing else        |
| Intermediate nodes    | —                        | Two node addresses; neither end          |
| Mailbox provider      | —                        | That an address polls a mailbox          |
| Internet provider     | That you talk to a relay | That you talk to a relay                 |
| Global observer       | All of the above         | Statistical analysis, far more expensive |

What does **not** change: whoever holds the link can still read the capsule, the
content is still end-to-end encrypted with the fragment's key, and the internet
provider still sees that there is a connection.

### 14.2 New guarantees, and where they come from

- **No intermediate node knows where it is in the path.** The header is always
  the same length and the consumed block is replaced by pseudorandom filler the
  sender computed. It is a property of the format.
- **A packet cannot be followed from one link to the next.** The ephemeral
  point is transformed at each hop and the body is decrypted one layer, so the
  bytes change completely. Verified in the tests.
- **A node cannot tag a packet.** The body is a wide-block permutation: one
  changed bit randomises all 64 KiB and the destination rejects it. Verified in
  the tests.
- **A repeated packet is discarded.** Each hop stores a tag derived from the
  shared secret for a window. Without it, resending a packet and watching which
  one comes out twice links the two ends.
- **A node does not reveal why it dropped something.** Every response is `202`.
- **There is no exit node.** The destination is the relay storing the capsule,
  so no party sees the request in the clear without also being its recipient.

### 14.3 New risks

**The mailbox provider knows you exist.** It sees an address polling a mailbox.
It does not see what you asked or of whom. That is inherent to a client that
cannot receive connections. Mitigation: choose the provider deliberately, or
put Tor underneath with `--tor --mix`.

**The first hop sees your address.** Like a guard in Tor, and for the same
reason. Unlike Tor, there are **no guard nodes** here: the first hop is chosen
afresh on every request, which spreads the exposure across more nodes but also
raises the probability of eventually touching a hostile one. It is a known
trade-off and it is unresolved; Tor chose the other way after years of
analysis, and that decision deserves revisiting here.

**Withholding packets is a weapon.** A node can delay or omit forwarding. The
client sees a timeout, not an attack, and retries by another path. A node doing
this selectively can bias which paths work.

**Cover traffic costs.** One loop is a 65,920-byte packet for every hop it
crosses. An operator who turns it off saves traffic and leaves their link
legible; one who raises it pays bandwidth for everyone.

**An n−1 attack is still open.** An adversary controlling the neighbouring
nodes and able to suppress everyone else's traffic isolates a packet and
follows it. Loops and random path selection make it expensive; they do not
solve it, and it is an open problem in the literature, not an omission of this
implementation.

**The anonymity set is whatever it is.** Repeated here because it is the risk
that dominates all the others. With few nodes and one operator, everything
above is machinery around a single party that sees both ends. The CLI says so
before every send and the design document says it first.

### 14.4 Outside the model

- **A global passive observer.** With enough traffic and time, statistical flow
  analysis works against any network of this size.
- **Active traffic confirmation.** An adversary who can inject and block at
  will on several links.
- **Endpoint compromise.** If the device is compromised, none of this matters.

### 14.5 What is needed before calling it anonymous

In order, and none of them optional:

1. **Independent operators**, in different jurisdictions, who do not know each
   other. Without this the rest is decoration.
2. **Enough users** for a message to hide among others. A small anonymity set
   is a small suspect list.
3. **Published measurements**: real latency, cover volume, effective set size,
   measured correlation resistance.
4. **External cryptographic review** of this composition, not only of the
   constructions it is made of.
5. **A reasoned decision about guard nodes**, with the analysis behind it.

Until those five exist, the correct phrase is "mix network", not "anonymity
network", and the interface says it that way.

## 15. `.capsule` sites (1.2)

The design is in [SITES.md](./SITES.md). This section covers only what changes
in the threat model.

### 15.1 First: what is public

A `.capsule` site **is public content**. The read capability is inside the
record and the record is spread between relays on purpose. That is not a leak:
it is what publishing means. A relay, a visitor, and anyone passing by can read
the site.

What the naming layer protects is not confidentiality but **integrity and
continuity**: that the pages are the ones their author signed, and that nobody
can serve an earlier version without it being noticed.

### 15.2 New guarantees, and where they come from

- **Only the key holder can publish under a name.** The name _is_ the public
  key, so verifying requires no trust in whoever delivered the record. A
  property of the format.
- **A relay cannot modify a record.** Changing any field invalidates the
  signature. Verified in the tests.
- **A relay cannot roll a site back without it being noticed.** The client
  stores the highest sequence it accepted per name and refuses a lower one.
  Verified in the tests.
- **Silence is worth little.** The client asks several relays and keeps the
  highest sequence that verifies; suppressing an update requires every relay the
  visitor asks to be silent.
- **The relay does not know what it is storing.** The site travels as an
  encrypted capsule, padded to a size class, under a neutral filename. The
  record says nothing about the content beyond an optional title the author
  chose.
- **The relay does not know which page was read.** The bundle is downloaded
  whole. There is no per-file request to reveal.
- **The page cannot contact anybody.** With scripts off — the default mode —
  the document's policy and the frame's isolation prevent every network
  request. Verified in the tests.

### 15.3 New risks

**The site key is a single point of failure.** Whoever copies it can replace
the pages; whoever loses it loses the name. There is no recovery because there
is nobody to ask. It is the same property as an onion address and it has the
same cost.

**The relay sees who is asking.** The extension queries relays directly from
the browser, so a relay sees an IP address asking about a name — and, if it is
the one storing the capsule, downloading it. This is the most important gap in
this version. The CLI can go through the mix network; the extension cannot yet.

**A record is an announcement.** Publishing a site tells relays that the name
exists and when it was updated. A name's update pattern is observable by
anybody who queries `GET /v1/sites`.

**Scripts, if enabled, can take the visitor out.** A script can navigate the
frame to an external address, which would reveal the visitor's IP to it. The
policy still blocks `fetch`, external images and external fonts, but a
navigation is not a request subject to CSP and no directive covers it since
`navigate-to` left the standard. That is why they are off by default and the
warning is visible when they are turned on.

**A site that expires disappears.** If the capsule expires or the relays
holding it leave, the name resolves to a record pointing at nothing. The record
still verifies; the content is not there.

**The page rebuilder is a hand-written security boundary.** It is tested
against the cases we thought of — `<base>`, `meta refresh`, `srcset`, nested
`url()`, paths that climb out of a directory, `<object data>`, `xlink:href`,
bare `@import` — and it is not audited. A mistake there is an escape from the
isolation.

### 15.4 Outside the model

- **Availability.** Nobody guarantees a site stays up.
- **Censorship of a name.** Relays can refuse to store a record. With enough
  relays cooperating, a name stops resolving.
- **Reputation.** A name says nothing about who is behind it. Verifying that a
  page has not changed is not verifying that it is from who you think.
- **Publisher anonymity.** The relay sees who uploads, unless `--mix`, `--tor`
  or `--bridge` is used.

## 16. Bridges, offline capsules and uniform manifests (1.3)

### 16.1 Bridges: what a censor can and cannot do

Full design in [CENSORSHIP.md](./CENSORSHIP.md). Adversary A11 was added to §5
for this.

| Censor's move                         | Against a public relay                   | Against a bridge                        |
| ------------------------------------- | ---------------------------------------- | --------------------------------------- |
| Enumerate the directory               | Works: `/v1/peers` lists everything      | Finds nothing: a bridge never announces |
| Probe a suspected address             | `GET /v1/info` identifies it immediately | Answers like an unconfigured web server |
| Probe with the secret prefix          | —                                        | Same answer, without a valid cookie     |
| Replay a recorded request             | —                                        | Refused; the nonce is remembered        |
| Write one DPI rule for all of CAPSULE | Works on the API shape                   | The cookie name differs per bridge      |
| Obtain the bridge line                | —                                        | **Works completely**                    |
| Fingerprint TLS                       | Works                                    | **Works**: the handshake is Node's      |
| Traffic analysis                      | Works                                    | Partly: sizes are padded, timing is not |

**New guarantees, and where they come from:**

- **A probe learns nothing.** Wrong prefix, missing cookie, malformed cookie,
  expired cookie, replayed cookie and a cookie for another path all produce the
  same 404. There is no error that distinguishes them. Verified in the tests.
- **A cookie cannot be moved between requests.** The MAC covers the method and
  path, so one captured on a chunk upload does not open `/v1/info`. Verified.
- **A bridge does not appear in any peer list.** It pulls the directory and
  never announces itself. Verified.

**New risks:**

- **Distribution is unsolved, and it is the whole ballgame.** A censor who gets
  the line has the bridge. Tor has spent fifteen years on this and CAPSULE has
  no answer at all.
- **The TLS fingerprint is Node's, not a browser's.** A censor fingerprinting
  client hellos sees something unusual. Real, and not addressed.
- **Bridge users are a smaller, separately identifiable population.** Using a
  bridge shrinks your anonymity set relative to using the public network. Tor
  bridge users pay the same cost.
- **A share link created directly on a bridge contains the bridge's address.**
  Anyone given that link learns the bridge. The CLI's documentation says to
  combine `--bridge` with `--mix` when this matters.
- **Sustained probing may still find a signal.** The rate limiter answers a
  flood differently from an idle server. One probe learns nothing; ten thousand
  might.

### 16.2 Offline capsules

| Property                          | Consequence                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------- |
| No relay is involved at any point | Nothing observes the transfer. There is also nothing to enforce a TTL, so there is none. |
| Sealed by default                 | The file is ciphertext; a lost memory stick is a lost memory stick                       |
| `--with-key`                      | The file opens on its own; whoever finds it can read it. The tool says so.               |
| No deletion capability            | There is nobody to ask. Whoever holds the file holds it.                                 |

The new risk is physical and it is the point: an offline capsule is an object.
It can be copied without a trace, seized at a border, or found in a drawer years
later. That is the trade for needing no network.

### 16.3 The LAN beacon

**A beacon tells everyone on the local network that this machine is running
CAPSULE.** That is a disclosure, and on a network that is not yours it is the
kind this project spends its effort avoiding. It is off by default and should be
turned on only when the local network is the only network there is.

A beacon is unauthenticated and cannot be otherwise: the point is to find a
relay you have never heard of, with no infrastructure to check a signature
against. What protects the content is that it was already encrypted before it
went anywhere — a hostile relay on the LAN sees ciphertext, exactly as a hostile
relay on the internet does. What a beacon is prevented from doing is naming
anything other than a plain `http(s)` origin. Verified in the tests.

### 16.4 Uniform manifests

AES-GCM does not hide length. Until 1.3, the encrypted manifest's length
measured the filename and the note, so a capsule called `x.txt` and one called
`Ana Pereira - passport scan.jpg` were visibly different to the relay even
though both were unreadable.

Every manifest is now padded to a size class. It is **unconditional**, and that
is the security argument rather than a convenience: an anonymity feature some
users switch on splits the population into those who did and those who did not,
and each group is smaller than the whole. Uniformity only works when it is not
a choice.

This is the only kind of work that improves an anonymity set from inside the
code. The rest of that number is adoption, and no commit changes it — see
[COMPARISON.md](./COMPARISON.md).
