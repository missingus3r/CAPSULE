# Security policy

CAPSULE v0.1 is a research prototype and has not received an independent security audit.

## Reporting a vulnerability

Do not place exploitable details in a public issue. Report them privately to the project owner and include:

- affected component and version;
- reproduction steps or a minimal proof of concept;
- expected and observed behavior;
- likely impact;
- any suggested mitigation.

A public security contact will be added before the repository is published. Until then, this local repository is the coordination point.

## In scope

- capsule confidentiality or authentication failures;
- nonce/key reuse;
- unauthorized read, write or deletion;
- path traversal or storage escape in the relay;
- bypasses of size, TTL or rate limits;
- capability leakage through logs, URLs or browser requests;
- cross-site scripting or unsafe filename handling;
- denial-of-service issues with a practical bounded reproduction.

## Explicit non-guarantees in v0.1

- sender or receiver network anonymity;
- resistance to a global traffic observer;
- protection of a compromised endpoint;
- recall of plaintext already downloaded by a recipient;
- relay availability;
- protection when the share URL is disclosed;
- safe operation over untrusted plain HTTP outside local development.
