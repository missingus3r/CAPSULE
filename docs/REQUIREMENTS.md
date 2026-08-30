# CAPSULE — requirements specification v0.1

**Status:** implementable draft
**Document version:** 0.1
**Target product version:** 0.1
**Date:** 2026-08-29

## 1. Purpose

CAPSULE lets somebody send a file through a temporary link without handing the
content in the clear to the relay that stores it. The client encrypts the file
and its metadata before uploading. Whoever holds the link holds the capability
to read and decrypt the capsule; whoever keeps the owner capability can ask for
it to be deleted early.

Version 0.1 offers **content privacy, cryptographic integrity and time-bounded
access**. It does not offer strong anonymity, resistance to traffic analysis,
verifiable deletion of every copy, or protection against a compromised device
or a malicious recipient.

The normative terms **MUST**, **MUST NOT**, **SHOULD** and **MAY** mean
mandatory requirements, prohibitions, recommendations and options
respectively.

## 2. Scope of v0.1

> **Note from later versions.** This document describes the scope of v0.1 and
> is kept as a historical reference. Several items moved from "out of scope" to
> "implemented": replication across relays (explicit, chosen by the sender),
> hiding the exact size with size-class padding, hiding the IP from the relay in
> the CLI via SOCKS5/Tor, storage without expiry under a quota the operator sets,
> recovery of a lost key by passphrase or `k`-of-`n` sharing, mix routing
> (1.1), `.capsule` sites (1.2), and censorship-resistant bridges plus offline
> and local-network operation (1.3).
>
> Still out of scope: resistance to a global observer, hiding the timing and
> pattern of access, network anonymity in the web app, and peer-to-peer or
> proximity transports. The detail is in [ROADMAP.md](./ROADMAP.md) and in
> [THREAT_MODEL.md](./THREAT_MODEL.md).

### 2.1 Included

- A web application for creating and opening capsules.
- A command-line client for automation and diagnosis.
- An HTTP relay that stores only encrypted metadata and chunks.
- A shared protocol library and a client SDK.
- Local per-chunk encryption with AES-256-GCM.
- Capability-based read links, with no accounts.
- A configurable TTL, defaulting to 24 hours with 7 days as the initial
  maximum.
- Early deletion through a capability distinct from the read one.
- Configurable operational limits; initial values of 100 MiB per capsule and
  1 MiB of plaintext per chunk.

### 2.2 Out of scope

- Accounts, profiles, user directories or recovery by email.
- Editing a capsule that has been finalised.
- Chat, folder synchronisation or real-time collaboration.
- Peer-to-peer, Bluetooth or Wi-Fi Direct transfer.
- Automatic replication between relays or tolerance of a relay going down.
- Mix routing, onion routing, IP hiding or resistance to a global observer.
- Hiding the size, chunk count, timing or access pattern.
- Recovery of a lost key, key custody or escrow.
- Any guarantee of deletion from backups, logs, caches or the recipient's
  copies.
- Malware scanning inside the relay: the relay does not hold the key.

## 3. Actors

| Actor                 | Goal                                      | Capabilities and limits                                                                                            |
| --------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Sender                | Create a capsule and share it             | Controls the original file, the TTL and the link; must keep the deletion capability separately in order to revoke  |
| Recipient             | Open and save a capsule                   | Can do so while the relay keeps it and the link is valid; can copy the content indefinitely                        |
| Relay operator        | Provide temporary storage                 | Configures limits and retention; observes network and storage metadata, but must never receive the content key     |
| Integrator / CLI user | Automate sends and downloads              | Uses the same protocol and gains no extra privileges                                                               |
| Adversary             | Read, alter, enumerate or block transfers | Detailed in [THREAT_MODEL.md](./THREAT_MODEL.md); the relay is not assumed honest for confidentiality or integrity |

## 4. Assumptions and dependencies

- Sender and recipient run an uncompromised CAPSULE client.
- The system entropy and `crypto.getRandomValues` / Web Crypto are
  trustworthy.
- In production, the application and the relay are served over valid HTTPS.
  Plain HTTP is allowed only on `localhost` for development.
- The external channel used to share the link is the user's responsibility. If
  that channel leaks the link, it leaks the read capability.
- The relay's clock is authoritative for enforcing the TTL. The time inside the
  encrypted metadata is informational and is validated against the relay's.
- The relay may deny service, discard or withhold ciphertext. Cryptography
  stops it from fabricating valid content, but cannot compel it to serve or to
  delete.

## 5. User stories

| ID    | Story                                                                                                                                         | Priority  |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| US-01 | As a sender, I want to pick a file and an expiry and get a link I can share without the relay reading the content.                            | Mandatory |
| US-02 | As a sender, I want to see progress and get a clear error if the upload cannot complete.                                                      | Mandatory |
| US-03 | As a sender, I want to keep a private capability that deletes the capsule before it expires.                                                  | Mandatory |
| US-04 | As a recipient, I want to open the link, verify the capsule cryptographically and download the file with its original name and type.          | Mandatory |
| US-05 | As a recipient, I want a wrong key, an altered chunk or an incomplete download to fail closed, rather than producing a file that looks valid. | Mandatory |
| US-06 | As a technical user, I want to create, download and delete capsules from a CLI with results suitable for scripting.                           | Mandatory |
| US-07 | As an operator, I want to bound size, chunk size, TTL and CORS origin without recompiling.                                                    | Mandatory |
| US-08 | As an operator, I want expired capsules removed automatically and capabilities kept out of logs.                                              | Mandatory |
| US-09 | As a user, I want an honest and visible explanation that the link is a secret and that v0.1 does not hide my IP.                              | Mandatory |

## 6. Functional requirements

### 6.1 Creation and encryption

- **FR-001 — Selection.** The client MUST accept a file, a permitted TTL and an
  optional note. It MUST reject locally any file or TTL beyond the limits the
  relay announced.
- **FR-002 — Secrets.** For each capsule the client MUST generate, with a
  CSPRNG, a 32-byte AES key and an 8-byte nonce prefix. It MUST NOT reuse the
  key/prefix combination in another capsule.
- **FR-003 — Chunks.** The client MUST split the file into independent chunks
  and encrypt them as described in [PROTOCOL.md](./PROTOCOL.md). File chunks are
  numbered from 1; index 0 is reserved for the encrypted metadata.
- **FR-004 — Metadata.** Name, MIME type, size, chunk count, timestamps and the
  optional note MUST be encrypted. The relay MUST NOT require those values in
  the clear, beyond the minimum operational information: chunk count, encrypted
  bytes and requested expiry.
- **FR-005 — Reservation.** The relay MUST create an unfinalised reservation
  and return a capsule identifier, random write, read and delete capabilities,
  and the effective expiry.
- **FR-006 — Upload.** The client MUST upload the encrypted metadata block and
  each encrypted chunk. A byte-for-byte retry of the same ciphertext MUST be
  idempotent. The client MUST NOT encrypt different content under the same
  index, key and nonce prefix.
- **FR-007 — Finalisation.** The relay MUST publish a capsule for reading only
  after it has received the metadata and every declared chunk. An unfinalised
  capsule MUST expire and be cleaned up automatically within a short,
  configurable operational window.
- **FR-008 — Link.** The client MUST produce a link carrying the read
  capability and the cryptographic secrets exclusively in the URL fragment
  (`#capsule=...`). The write and delete capabilities MUST NOT be part of the
  shared link.
- **FR-009 — Owner.** The client MUST show or store the delete capability
  separately, and warn that it cannot be recovered if lost.

### 6.2 Reading and downloading

- **FR-010 — Safe parsing.** The client MUST validate version, types, lengths
  and relay URL before starting a download. Invalid values MUST fail without
  making further requests.
- **FR-011 — Authorisation.** The relay MUST require the read capability for
  the manifest and every object. An invalid capability, a non-existent capsule
  and an expired capsule SHOULD be indistinguishable in the public response.
- **FR-012 — Decryption.** The client MUST authenticate and decrypt the
  metadata first, then each chunk with its index. It MUST NOT report success if
  a chunk is missing, an extra one appears, a tag fails, or the reconstructed
  size does not match.
- **FR-013 — File.** After validating the complete capsule, the client MUST
  allow saving the file under a sanitised name. The MIME type is treated as
  untrusted data and MUST NOT cause automatic execution.
- **FR-014 — Errors.** The UI and CLI MUST distinguish at least: invalid link,
  unavailable/expired, failed cryptographic authentication, limit exceeded,
  network error and internal error. They MUST NOT reveal secrets in messages.

### 6.3 Expiry and deletion

- **FR-015 — TTL.** The relay MUST set `expiresAt` using its own clock, within
  the configured maximum. After that instant it MUST refuse new reads.
- **FR-016 — Cleanup.** An automatic process MUST remove expired capsules from
  primary storage. The v0.1 target is to begin cleanup within 60 seconds of
  expiry on a healthy instance.
- **FR-017 — Early deletion.** The delete capability MUST allow removing a
  capsule before its TTL. The operation MUST be idempotent.
- **FR-018 — Uniform responses.** The relay MUST NOT publicly confirm whether
  an identifier exists when a valid capability is absent.

### 6.4 Operation and compatibility

- **FR-019 — Configuration.** Host, port, storage directory, CORS origin,
  maximum size, maximum chunk size, default TTL and maximum TTL MUST be
  configurable from the environment.
- **FR-020 — Limit discovery.** The relay MUST expose a public configuration
  endpoint with no secrets, so clients learn the version and limits before
  reserving.
- **FR-021 — Health.** The relay MUST expose a liveness check that neither
  enumerates capsules nor reveals internal paths.
- **FR-022 — CLI.** The CLI MUST support `create`, `download` and `delete`; an
  error MUST produce a non-zero exit code. A structured mode SHOULD emit JSON
  without mixing it with human-readable messages.
- **FR-023 — Interoperability.** Web, CLI and SDK MUST produce mutually
  compatible v1 capsules from the same protocol library.

## 7. Non-functional requirements

### 7.1 Security and privacy

- **NFR-SEC-01.** All private content and metadata MUST be encrypted on the
  client with AES-256-GCM and a 128-bit tag.
- **NFR-SEC-02.** Keys, nonce prefixes and capabilities MUST NOT appear in
  query strings, paths, telemetry, logs, server-side filenames or error
  messages.
- **NFR-SEC-03.** The relay MUST store preimage-resistant hashes of the tokens,
  not their values.
- **NFR-SEC-04.** Token comparisons MUST avoid observable timing differences
  once their lengths are normalised.
- **NFR-SEC-05.** The web application MUST NOT load analytics, advertising or
  third-party scripts into the view that processes the fragment. It MUST use a
  restrictive CSP and `Referrer-Policy: no-referrer` in production.
- **NFR-SEC-06.** The relay MUST apply body, reservation-count, rate and storage
  limits before committing significant resources.
- **NFR-SEC-07.** No UI output may call v0.1 "anonymous". It must state that the
  relay and the network can observe IP, timing, size and access pattern.

### 7.2 Performance and resources

- **NFR-PERF-01.** Encryption, upload, download and decryption SHOULD process
  chunks sequentially or with bounded concurrency, without requiring two extra
  complete copies of the file in memory.
- **NFR-PERF-02.** Each encrypted chunk adds exactly 16 bytes of GCM tag;
  clients MUST account for that overhead when validating relay limits.
- **NFR-PERF-03.** A reference installation MUST complete a 10 MiB round trip on
  localhost without exceeding the configured limits and without corruption,
  regardless of the absolute speed of the hardware.

### 7.3 Availability and consistency

- **NFR-AVL-01.** A finalised capsule is immutable. There are no visible partial
  writes and no in-place updates.
- **NFR-AVL-02.** A process crash MUST NOT turn an incomplete reservation into a
  finalised capsule, nor skip its later cleanup.
- **NFR-AVL-03.** v0.1 promises no high availability. The UI MUST communicate
  that the link depends on the chosen relay.

### 7.4 Portability, accessibility and maintainability

- **NFR-PORT-01.** The relay and the CLI MUST run on Node.js 22 or newer on
  Windows, macOS and Linux where the file system allows it.
- **NFR-PORT-02.** The web app MUST work in current browser versions with Web
  Crypto; if a required API is unavailable it MUST fail with an explanation
  before reading the file.
- **NFR-A11Y-01.** The main flows MUST be usable with a keyboard, with
  accessible labels, visible focus and messages that do not depend on colour
  alone.
- **NFR-MNT-01.** Cryptographic logic MUST live in the protocol library and not
  be duplicated in each client.
- **NFR-MNT-02.** Changing the cryptographic format or endpoint semantics
  requires a new version; a client MUST reject versions it does not know.

## 8. Acceptance criteria for v0.1

| ID    | Given / when / then                                                                                                                                                                                                            |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AC-01 | Given a 0-byte file, a 1-byte file, one exactly the chunk size and one of chunk size + 1, when they are created with the web app or CLI and downloaded with the other client, then the reconstructed bytes and metadata match. |
| AC-02 | Given a 10 MiB file, when the flow completes on localhost, then the SHA-256 before and after is identical.                                                                                                                     |
| AC-03 | Given a chunk, when a bit of the ciphertext or the tag is altered, or it is decrypted with a different index, then the client fails on authentication and does not publish the file.                                           |
| AC-04 | Given a shared link, when the browser's HTTP requests are inspected, then `key`, `noncePrefix` and `readToken` appear in no path, query, non-authorisation header or body; the fragment never reaches the web server.          |
| AC-05 | Given the relay's storage, when a capsule is inspected, then it contains no name, MIME type, note, key or token in the clear.                                                                                                  |
| AC-06 | Given an incomplete reservation, when it is read, then the response is "unavailable"; after its reservation window it is deleted.                                                                                              |
| AC-07 | Given a finalised capsule, when it expires, then every later read is refused and cleanup of primary storage begins within 60 seconds on a healthy instance.                                                                    |
| AC-08 | Given a live capsule, when it is deleted with the owner capability, then a later read fails; repeating the deletion does not reveal whether it existed.                                                                        |
| AC-09 | Given a valid ID and an invalid token, when any object is requested, then the public response reveals no more than it would for a non-existent ID.                                                                             |
| AC-10 | Given a file or TTL above the announced limits, when the user tries to create it, then the client rejects it before uploading content, and the relay also rejects it if the client skipped validation.                         |
| AC-11 | Given a malformed link or one of an unknown version, when it is opened, then no download starts and a safe error is shown.                                                                                                     |
| AC-12 | Given any successful or failed flow in the suite, when the relay and CLI logs are reviewed, then no keys or complete capabilities appear.                                                                                      |
| AC-13 | Given the documentation and the UI, when the privacy description is read, then it explicitly states that v0.1 provides neither strong anonymity nor verifiable deletion of copies.                                             |

## 9. Definition of done

v0.1 is considered done when:

1. Every mandatory requirement and AC-01 to AC-13 has an automated test or
   reproducible evidence.
2. Web, CLI and SDK interoperate against a clean relay instance.
3. The negative paths for authentication, TTL, deletion and limits are covered.
4. [PROTOCOL.md](./PROTOCOL.md) describes exactly the bytes and endpoints that
   are deployed.
5. No secrets remain in fixtures, test logs or build artefacts.
6. The limitations in [THREAT_MODEL.md](./THREAT_MODEL.md) are visible to the
   user before a link is shared.
