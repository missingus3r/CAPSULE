# Security policy

CAPSULE 1.0 has a frozen protocol, published test vectors and an internal
security review. It has **not** received an independent audit. When one
happens, its scope, method, date and remediation status will be published here.

## Reporting a vulnerability

Do not place exploitable details in a public issue. Report them privately to
the project owner and include:

- affected component and version;
- reproduction steps or a minimal proof of concept;
- expected and observed behavior;
- likely impact;
- any suggested mitigation.

A public security contact will be added before the repository is published.
Until then, this local repository is the coordination point.

## In scope

- capsule confidentiality or authentication failures;
- nonce or key reuse, in any code path including resumed uploads;
- unauthorized read, write or deletion;
- path traversal or storage escape in the relay;
- addresses that reach a relay operator's own network, or a client's, through
  the peer directory or discovery;
- forged, replayed or unverifiable relay announcements;
- reconstruction of a capsule from fewer than `k` shards;
- recovery blobs or shares that reveal something below their threshold;
- bypasses of size, TTL, quota or rate limits;
- capability leakage through logs, URLs, tickets or browser requests;
- metadata that survives scrubbing without being reported as remaining;
- cross-site scripting or unsafe filename handling;
- denial-of-service issues with a practical bounded reproduction.

## Explicit non-guarantees

- sender or receiver network anonymity in the web application;
- protection of transfer timing or volume;
- resistance to a global traffic observer;
- protection of a compromised endpoint;
- recall of plaintext already downloaded by a recipient;
- relay availability, or the availability of `k` of `n` relays;
- protection when the share URL is disclosed;
- removal of metadata from formats reported as unsupported, notably a PDF
  `/Info` dictionary;
- safe operation over untrusted plain HTTP outside local development.

## Known residual risks

These are tracked, not hidden. The reasoning for each is in
[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) §13.4.

- A hostname verified before a request may resolve elsewhere by the time the
  request is made; pinning the connection to the verified address needs a
  custom connector.
- A PDF `/Info` dictionary may live inside a compressed object stream and is
  not rewritten.
- Proof of work and per-operator caps raise the cost of a Sybil attack on the
  relay directory; they do not prevent one.
- PBKDF2 protects a recovery passphrase less well than a memory-hard function
  would against an attacker with GPUs.
