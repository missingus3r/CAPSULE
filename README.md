# CAPSULE

CAPSULE is a transport for private, temporary encrypted payloads. A sender encrypts a file locally, uploads only ciphertext to a relay, and shares a URL whose fragment contains the decryption capability. URL fragments are not sent to web servers.

The current release is **v1.0**: the capsule format, the relay API and the capability encoding are frozen and published with [official test vectors](packages/protocol/vectors/capsule-test-vectors.json). Versions 1 and 2 of the format stay readable.

1. Select a file and optional private note.
2. Strip the file's embedded metadata, then encrypt metadata and chunks locally with AES-256-GCM.
3. Upload ciphertext to one relay, mirror it across several, or split it across them so no single relay holds enough to rebuild it.
4. Share a capability URL.
5. Download, authenticate and decrypt on the receiver's device.
6. Expire automatically, keep it until deleted, or delete early with a separate owner capability.

## What it does

**Hides the file from the relay.** Content and manifest are encrypted before anything leaves the device. The relay stores bytes it cannot read.

**Hides what the file says about you.** Embedded metadata is removed before encryption — EXIF and GPS from JPEG, text chunks from PNG, EXIF/XMP from WebP, comments from GIF, `udta`/`meta` boxes from MP4/MOV/HEIC, author and company from Office and ODF documents, XMP packets from PDF. What cannot be removed safely is _reported_, never silently skipped. The filename and mime type can be replaced with neutral ones.

**Hides the size.** Capsules are padded to a coarse size class, so the relay sees a bucket rather than a file size, and every chunk is identical in length.

**Hides the client address, in the CLI.** `--tor` or `--proxy socks5h://…` routes every relay request through a SOCKS5 proxy, resolving hostnames at the proxy so `.onion` relays work unchanged. Relays themselves run IP-blind by default: no addresses in logs, rate limiting keyed by a rotating salted hash.

**Survives a relay.** Mirror a capsule across relays for availability, or split it `k`-of-`n` with Reed-Solomon erasure coding: each relay holds a shard that is useless on its own, any `k` of them can serve the capsule, and it costs `n/k` of the capsule instead of `n`.

**Lets anyone run a relay.** No registry and no permission: publish `/v1/info`, point it at one relay you already know, and relays introduce themselves with signed announcements backed by proof of work. Clients discover the network from any relay.

**Keeps a capsule until you delete it, if an operator allows it.** Off by default, bounded by a global and a per-sender quota.

**Lets you not lose the key.** A capability can be wrapped under a passphrase, or split among people and devices so that any `k` of them restore it and fewer reveal nothing. Both are opt-in and the relay never participates.

## Current security statement

CAPSULE protects file contents and encrypted metadata from the relay when used over a trustworthy HTTPS deployment, and it removes the metadata a file carries about its author. Anonymisation is **partial, and named precisely**: it hides file metadata, the filename, the exact size and — in the CLI, through Tor or another SOCKS5 proxy — the client address.

It does **not** hide the timing or the volume of a transfer, nor the fact that one happened. The web app does not route through Tor; only the CLI can. Anyone who receives the share URL can read the capsule until it expires or is deleted, and a capsule created without expiry stays readable until someone uses the owner capability.

The v1.0 security review was **internal**. It found and fixed two exploitable issues and three smaller ones, all documented in [the threat model](docs/THREAT_MODEL.md) §13.3 along with the risks that remain. An independent audit has not happened; when it does, it will be published with scope, method and date.

Read the threat model before testing with sensitive material.

## Repository layout

```text
apps/
  web/       Installable React PWA
  relay/     Ciphertext relay and network node
  cli/       Command-line sender and receiver
packages/
  protocol/  Versioned capsule format, cryptographic primitives and test vectors
  sdk/       Browser/Node relay client, discovery and transfer orchestration
docs/        Requirements, protocol, threat model, relay guide and roadmap
infra/       Container deployment files
scripts/     Release tooling (checksums, SBOM)
```

## Run locally

Requirements: Node.js 22 or newer.

```powershell
npm install
npm run dev
```

Then open `http://localhost:5173`. The relay listens on `http://localhost:8787` by default. Local defaults work without an `.env` file; copy `.env.example` to `.env` when you want to change limits or origins.

For production, serve both components over HTTPS and configure the web host to send `Content-Security-Policy: frame-ancestors 'none'`, `Referrer-Policy: no-referrer` and `X-Frame-Options: DENY`. The development server already sends the latter two headers; `frame-ancestors` must be an HTTP response header rather than an HTML meta directive. The production build ships `connect-src 'self' https:`, so a relay discovered through gossip can never aim the page at the visitor's own machine.

## Build and verify

```powershell
npm run build
npm test
npm run typecheck
npm run format:check
```

`npm run vectors` regenerates the protocol test vectors — if that changes the file, the protocol changed. `npm run release` produces `release/SHA256SUMS` and a CycloneDX SBOM; signing is the maintainer's step and the command prints it.

## Run your own relay

There is nothing to register and nobody to ask. Set the address other relays can reach, point yours at one relay you already know, and they introduce themselves:

```powershell
$env:CAPSULE_PUBLIC_URL = "https://relay.example.org"
$env:CAPSULE_PEERS = "https://relay-you-already-know.example"
node apps/relay/dist/main.js
```

See which relays are reachable from a seed:

```powershell
node apps/cli/dist/index.js relays --seed https://relay.example.org
```

Full operator guide — capsules without expiry, IP-blind operation, proof of work, quotas and the anti-SSRF switch: [docs/RUN_A_RELAY.md](docs/RUN_A_RELAY.md).

## CLI

Build once, then send a file:

```powershell
npm run build
node apps/cli/dist/index.js send .\example.pdf --ttl 24h
```

The command prints two different capabilities:

- **Share URL:** give this to the recipient.
- **Deletion capability:** keep it private; it can delete the capsule early.

Receive or delete:

```powershell
node apps/cli/dist/index.js receive "<share-url>" --out .\downloads\
node apps/cli/dist/index.js delete "<owner-capability>"
```

Anonymisation, no expiry, mirroring and splitting:

```powershell
# Strip metadata, hide the filename, pad the size and space the uploads
node apps/cli/dist/index.js send .\photo.jpg --anonymous

# Route every relay request through Tor
node apps/cli/dist/index.js --tor send .\photo.jpg
node apps/cli/dist/index.js --proxy socks5h://127.0.0.1:9050 receive "<share-url>"

# Keep the capsule until you delete it (the relay must allow it)
node apps/cli/dist/index.js send .\archive.zip --ttl never

# Store copies on two more relays discovered in the network
node apps/cli/dist/index.js send .\archive.zip --mirror 2

# Split across three relays: any two can rebuild it, one alone cannot
node apps/cli/dist/index.js send .\archive.zip --mirror 2 --shards 2

# Survive an interrupted upload
node apps/cli/dist/index.js send .\big.iso --resume .\ticket.json
```

Each anonymisation flag is separate on purpose: `--pad`, `--scrub`, `--hide-name` and `--jitter <ms>` can be used on their own, and `--anonymous` turns on all four.

Never lose the key:

```powershell
# Wrap a capability under a passphrase you choose
node apps/cli/dist/index.js protect "<owner-capability>" --label "tax return"
node apps/cli/dist/index.js reveal "capsule-recovery:…"

# Or split it: any 2 of 3 shares restore it, one alone reveals nothing
node apps/cli/dist/index.js split "<owner-capability>" --threshold 2 --shares 3
node apps/cli/dist/index.js combine "capsule-share:…" "capsule-share:…"
```

## Design principles

- No accounts or global user identifiers.
- Encryption happens on the edge, not on the relay.
- Different capabilities for reading, writing and deleting.
- No blockchain, token or permanent public ledger.
- Expiration and bounded storage by default; no expiry only when an operator opts in.
- Anyone can run a relay; no registry, no gatekeeper, no privileged node.
- Versioned, documented protocol using standard cryptography, with published test vectors.
- Honest security labels: say what is hidden, name what is not, and report when a file could not be cleaned.

What comes next — closing the gaps in PDF metadata and DNS pinning, then P2P and proximity transports, and metadata protection only once its adversary, cost and evidence are defined — is in [the roadmap](docs/ROADMAP.md) §14.

## Project status and license

The protocol is stable and the implementation is tested, but it has not been independently audited. The source license has intentionally not been selected yet; until the owner chooses one, treat the repository as all rights reserved.
