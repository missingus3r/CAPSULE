# CAPSULE

CAPSULE is an experimental transport for private, temporary encrypted payloads. A sender encrypts a file locally, uploads only ciphertext to a relay, and shares a URL whose fragment contains the decryption capability. URL fragments are not sent to web servers.

The current release is an executable **v0.2**. It proves the complete capsule lifecycle:

1. Select a file and optional private note.
2. Encrypt metadata and file chunks locally with AES-256-GCM.
3. Upload ciphertext to one or more temporary relays.
4. Share a capability URL.
5. Download, authenticate and decrypt in the receiver's device.
6. Expire automatically, keep it until deleted, or delete early with a separate owner capability.

## What v0.2 added

- **Payload anonymisation.** EXIF/XMP/PNG text metadata is stripped from the file before encryption, the filename and mime type can be replaced with neutral ones, the capsule is padded to a coarse size class so the relay reads a bucket instead of a file size, and chunk uploads can be spaced with jitter.
- **Transport anonymisation.** The CLI routes every relay request through a SOCKS5 proxy with `--proxy` or `--tor`; hostnames resolve at the proxy, so `.onion` relays work unchanged. Relays run IP-blind by default: no addresses in logs, and rate limiting keyed by a rotating salted hash.
- **Capsules without expiry.** A relay whose operator enables it accepts capsules with no expiry date, bounded by a storage quota. They are removed only by the owner capability.
- **An open relay network.** Anyone can run a relay and join: publish `/v1/info`, point it at one relay you already know, and relays exchange signed announcements. Clients discover the network from any relay and can mirror a capsule across several of them, with automatic read failover.

## Current security statement

CAPSULE protects file contents and encrypted metadata from the relay when used over a trustworthy HTTPS deployment. The anonymisation in v0.2 is **partial and honest about its limits**: it hides file metadata, the filename and the exact size, and — in the CLI, through Tor or another SOCKS5 proxy — the client address. It does **not** hide timing, volume or the fact that a transfer happened, and the web app does not route through Tor. Anyone who receives the share URL can read the capsule until it expires or is deleted; a capsule created without expiry stays readable until someone uses the owner capability.

Do not use this prototype for life-critical, journalistic or activist communications. Read [the threat model](docs/THREAT_MODEL.md) before testing with sensitive material.

## Repository layout

```text
apps/
  web/       Installable React PWA
  relay/     Temporary ciphertext relay
  cli/       Command-line sender and receiver
packages/
  protocol/  Versioned capsule format and cryptographic primitives
  sdk/       Browser/Node relay client and transfer orchestration
docs/        Requirements, protocol, threat model, relay guide and roadmap
infra/       Container deployment files
```

## Run locally

Requirements: Node.js 22 or newer.

```powershell
npm install
npm run dev
```

Then open `http://localhost:5173`. The relay listens on `http://localhost:8787` by default. Local defaults work without an `.env` file; copy `.env.example` to `.env` when you want to change limits or origins.

For production, serve both components over HTTPS and configure the web host to send `Content-Security-Policy: frame-ancestors 'none'`, `Referrer-Policy: no-referrer` and `X-Frame-Options: DENY`. The development server already sends the latter two headers; `frame-ancestors` must be an HTTP response header rather than an HTML meta directive.

## Build and verify

```powershell
npm run build
npm test
npm run typecheck
npm run format:check
```

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

## Design principles

- No accounts or global user identifiers.
- Encryption happens on the edge, not on the relay.
- Different capabilities for reading, writing and deleting.
- No blockchain, token or permanent public ledger.
- Expiration and bounded storage by default; no expiry only when an operator opts in.
- Anyone can run a relay; no registry, no gatekeeper, no privileged node.
- Versioned, documented protocol using standard cryptography.
- Honest security labels: private content and partial metadata protection today; anonymous routing only when its model, cost and evidence are honest.

Future versions add direct P2P transfer, offline transports and independently audited anonymous routing. See [the roadmap](docs/ROADMAP.md).

## Project status and license

This is an early research prototype. The source license has intentionally not been selected yet; until the owner chooses one, treat the repository as all rights reserved.
