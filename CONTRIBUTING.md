# Contributing

CAPSULE is protocol-first. Changes must keep the implementation, requirements and security claims aligned.

## Development checks

Before submitting a change, run:

```powershell
npm run build
npm test
npm run typecheck
npm run format:check
```

For user-interface changes, also execute the send/receive flow in a real browser.

## Security rules

- Do not invent cryptographic primitives.
- Never log keys, read/write/delete tokens or full capability URLs.
- A nonce must never be reused with the same AES-GCM key.
- New relay metadata must be treated as observable and documented in the threat model.
- Protocol changes require a versioning and compatibility decision.
- Claims such as “anonymous”, “untraceable” or “zero knowledge” require a written threat model and independent evidence.

## Scope discipline

The v0.1 acceptance criteria live in `docs/REQUIREMENTS.md`. P2P, Bluetooth, multi-relay replication, mix routing and public discovery belong to later roadmap stages unless a proposal explicitly changes the release scope.
