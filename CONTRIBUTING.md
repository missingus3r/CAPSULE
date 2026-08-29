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

If a change touches the capsule format, the relay API or the capability
encoding, regenerate the test vectors and read the diff:

```powershell
npm run vectors
```

A change in `packages/protocol/vectors/capsule-test-vectors.json` **is** a
protocol change. It needs a version bump, a section in `docs/PROTOCOL.md` and a
reviewer who looked at the diff on purpose.

## Security rules

- Do not invent cryptographic primitives.
- Never log keys, read/write/delete tokens or full capability URLs.
- A nonce must never be reused with the same AES-GCM key. This includes paths
  that are not obviously encryption paths: resuming an upload with different
  bytes would do it, which is why the resume ticket commits to the content.
- Any address learned from a relay — a peer, a mirror, a relay's own declared
  URL — must pass the routability check before it is connected to. Adding a
  new place where an address is followed means adding the check there too.
- New relay metadata must be treated as observable and documented in the threat model.
- A metadata scrubber must never corrupt a file to clean it, and must report
  what it could not remove rather than implying success.
- Protocol changes require a versioning and compatibility decision.
- Claims such as “anonymous”, “untraceable” or “zero knowledge” require a written threat model and independent evidence.

## Scope discipline

`docs/ROADMAP.md` §14 holds what comes after 1.0 and why it is ordered that
way. P2P, Bluetooth and mix routing belong to later stages unless a proposal
explicitly changes the release scope — and each of them changes the threat
model, so a proposal that does not update `docs/THREAT_MODEL.md` is incomplete
by definition.
