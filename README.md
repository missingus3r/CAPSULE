# CAPSULE

CAPSULE is an experimental transport for private, temporary encrypted payloads. A sender encrypts a file locally, uploads only ciphertext to a relay, and shares a URL whose fragment contains the decryption capability. URL fragments are not sent to web servers.

The current release is an executable **v0.1 MVP**. It proves the complete capsule lifecycle:

1. Select a file and optional private note.
2. Encrypt metadata and file chunks locally with AES-256-GCM.
3. Upload ciphertext to a temporary relay.
4. Share a capability URL.
5. Download, authenticate and decrypt in the receiver's device.
6. Expire automatically or delete early with a separate owner capability.

## Current security statement

CAPSULE v0.1 protects file contents and encrypted metadata from the relay when used over a trustworthy HTTPS deployment. It does **not** yet provide strong network anonymity. The relay can observe IP addresses, timing, capsule sizes and access patterns. Anyone who receives the share URL can read the capsule until it expires or is deleted.

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
docs/        Requirements, protocol, threat model and roadmap
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
- Expiration and bounded storage by default.
- Versioned, documented protocol using standard cryptography.
- Honest security labels: private content today; stronger metadata protection later.

Future versions add direct P2P transfer, multiple relays, offline transports and independently audited anonymous routing. See [the roadmap](docs/ROADMAP.md).

## Project status and license

This is an early research prototype. The source license has intentionally not been selected yet; until the owner chooses one, treat the repository as all rights reserved.
