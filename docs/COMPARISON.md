# CAPSULE against the map of networks

**Status:** an honest check, with no external audit
**Date:** 2026-08-30

This document goes through the stated limitation of every network on the map,
one at a time, and says whether CAPSULE addresses it, partly addresses it, or
does not. As of 1.3 the count is twelve yes, seven partly and two that do not
apply. There is a separate section at the end on the one thing no amount of
code fixes, because it is the most important paragraph here.

Two warnings that apply to everything below:

1. **CAPSULE is new and its network is small.** Several of the advantages here
   are properties of the design, not of the deployed network. A design that
   resists correlation, running on four nodes under one operator, resists
   nothing. See [MIXNET.md](./MIXNET.md) §1.
2. **None of this has been audited externally.** Every claim rests on the code,
   the tests and the threat model in this repository, and on nothing else.

## The table

| Network                 | Its stated limitation                                                            | CAPSULE | Why                                                                                                                                                                                                             |
| ----------------------- | -------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tor**                 | Slow, TCP only, vulnerable to correlation by an observer of both ends            | Partly  | Per-hop delays and cover traffic attack correlation, which is what Tor chose not to do. In exchange we are not a general TCP transport: see _Work in progress_ below.                                           |
| **I2P**                 | Installation and technical experience; not oriented to the conventional internet | Yes     | A `.capsule` site opens in Chrome with an extension and an `npm install`. Nobody has to learn a network model to read a page.                                                                                   |
| **Nym**                 | More protection means far more latency; too slow for daily use                   | Partly  | The cost is the same, but it is chosen per operation: `--mix` when it matters, direct when it does not. The CLI reports how much anonymity there actually is before each send rather than selling it wholesale. |
| **Lokinet**             | Smaller anonymity set than Tor, and a dependency on a token network              | Partly  | There is no token, no staking and no economy to capture: a relay is a Node process. CAPSULE's anonymity set today is **smaller still**.                                                                         |
| **Hyphanet (Freenet)**  | Content is hard to withdraw; aged performance and UX                             | Yes     | Every capsule has a deletion token and, if you want, an expiry. Publishing is not an irreversible decision.                                                                                                     |
| **GNUnet**              | Research-oriented                                                                | Yes     | This repository exists so somebody can send a file today. The primitives are well known; what is new is the composition and the product.                                                                        |
| **SimpleX**             | Depends on relays; no true offline physical network                              | Yes     | An offline capsule needs no network at all, and a LAN beacon finds a relay with no DNS and no uplink. See [OFFLINE.md](./OFFLINE.md). Neither is a mesh.                                                        |
| **Session**             | Persistent identifier, own network and token, complexity                         | Yes     | No accounts, no identifiers. A sender does not exist to the relay beyond the minutes an upload takes. No token.                                                                                                 |
| **Briar**               | Maintenance mode; battery, background execution, UX                              | Partly  | The offline case is covered for "no internet" and "same local network"; it is not covered for Bluetooth or radio, which is what Briar is for.                                                                   |
| **Bitchat**             | The protocol does not yet achieve unlinkable presence                            | N/A     | There is no presence: nobody is "online" in CAPSULE.                                                                                                                                                            |
| **Nostr**               | Pseudonymous not anonymous; spam; key management; inconsistent deletion          | Yes     | There is no identity to follow in a capsule. Deletion is a capability, not a request to servers. A site does have a key, and that key is the name.                                                              |
| **Matrix**              | Servers replicate accounts, metadata and history; not anonymous                  | Yes     | A relay stores encrypted bytes, an expiry, and nothing else. No accounts, no history, no contact list.                                                                                                          |
| **Waku**                | A hard balance between privacy, bandwidth, availability and latency              | Partly  | The same balance, but explicit: size-class padding, `k` of `n`, delays, cover traffic. Every dial is documented with its cost.                                                                                  |
| **IPFS**                | Not private: PeerIDs, CIDs, providers and queries can be public                  | Yes     | There is no global CID and no provider table. A capsule id without its token is useless, and content never leaves the browser in the clear.                                                                     |
| **Hypercore / Pear**    | Peers see IPs; somebody has to stay online                                       | Yes     | Relays hold the content, so the author can turn the machine off. With `--mix`, the relay that stores it never sees the client's address.                                                                        |
| **Yggdrasil**           | Encryption is not anonymity                                                      | Yes     | Agreed, which is why encryption and anonymity are separate layers here and the interface says which one is on.                                                                                                  |
| **Reticulum**           | Small ecosystem, complicated onboarding                                          | Partly  | Onboarding is simpler (`npm install`, one command). The ecosystem is smaller still.                                                                                                                             |
| **Meshtastic**          | Needs hardware and has little bandwidth                                          | Partly  | An offline capsule covers the air-gapped case with no hardware at all. It does not cover radio: where there is no IP and nobody to carry a file, Meshtastic works and CAPSULE does not.                         |
| **Veilid**              | A framework: an application still has to be built                                | Yes     | CAPSULE is the application, CLI, web and extension, not a library waiting for somebody to build something on it.                                                                                                |
| **Iroh / libp2p**       | Toolkits, not networks with end users                                            | Yes     | Same argument. There are commands a person runs.                                                                                                                                                                |
| **Bitcoin / Lightning** | Traceability and custody complexity                                              | N/A     | There are no payments and no economy in CAPSULE.                                                                                                                                                                |

## What CAPSULE adds that was not on the map

Six things that are not "solving somebody else's limitation" but work no system
in the list does in this form:

**A site that cannot ask the network for anything.** The extension rebuilds
every page with everything it needs inside it and hands it to a frame with
`connect-src 'none'` and no scripts. A `.capsule` site cannot load a font, a
pixel or a script from another origin, even if it wants to. Tor Browser
protects a visitor with heuristics and settings; here it is a property of the
format. See [SITES.md](./SITES.md).

**A bridge a probe cannot recognise.** An unlisted relay that answers every
request without the key exactly like an unconfigured web server, including a
request with the right secret prefix but a bad, expired or replayed
authenticator. See [CENSORSHIP.md](./CENSORSHIP.md).

**k-of-n sharing across relays.** With erasure coding each relay holds one
shard and `k` are needed to rebuild. No relay holds enough to have anything,
not even encrypted.

**Size-class padding by default.** The relay sees a bucket, not a size. A 1.4
KiB site and a 60 KiB one occupy exactly the same.

**Manifests that are all the same length.** AES-GCM does not hide length, so
without this the encrypted manifest would measure the filename. Every manifest
is padded to a size class, and it is not an option: an anonymity feature some
people switch on splits everyone into those who did and those who did not.

**A network measurement the tool actually reports.** `capsule network` prints
what the live network can offer, and the CLI prints it again before every mixed
send. It also says plainly what it cannot measure, which is the next section.

## Anonymity: what the design does, and what only adoption can

The architecture is built so that anonymity improves as people join. Every mix
packet is the same 65,920 bytes whatever it carries; every hop holds it for a
random time drawn from an exponential distribution; every node emits cover
loops indistinguishable from real traffic; there are no accounts or
identifiers to partition users by; and since 1.3 every encrypted manifest is
padded to a size class, so two capsules are indistinguishable from each other
rather than differing by the length of a filename. Nothing in the design caps
how good it gets.

That last one is worth dwelling on, because it is the shape of all such work:
**manifest padding is unconditional.** An anonymity feature that some senders
switch on splits everyone into those who did and those who did not, and each
group is smaller than the whole. Uniformity only helps when it is not a choice.

**What the network is today is a different question, and it is the honest weak
point.** The set is small, so the protection is small. Four nodes under one
operator are not an anonymity network; they are a way for a relay not to see
your IP.

CAPSULE cannot even measure its own anonymity set. There are no accounts, no
sessions and no counters, that is the point of the project, so there is
nobody to count. `capsule network` reports the _ceiling_ instead: relays
reachable, apparent operators, mix nodes, mix operators. With one operator the
ceiling is one, whatever the traffic looks like, and the CLI prints that number
before every mixed send rather than implying a guarantee.

So the honest split is:

|                                   | Where it stands                                          |
| --------------------------------- | -------------------------------------------------------- |
| Does the design scale with users? | Yes, and that is what the table row claims               |
| Is the set large today?           | No. It is the smallest of any system here                |
| Can code fix that?                | No. It is adoption                                       |
| What helps?                       | Running a relay, in a jurisdiction the others are not in |

[MIXNET.md](./MIXNET.md) leads with this rather than burying it, and so does
the _Limits_ section of the showcase page.

## Work in progress

**A general-purpose TCP tunnel.** Tor, I2P, Lokinet and Yggdrasil carry any TCP
or IP connection; CAPSULE carries files and static sites. The capsule format
needs the content known in full up front, which a stream is not, so this is
not an extension of the existing format but a second one beside it. The design
is sketched in [ROADMAP.md](./ROADMAP.md) §16. It is not implemented, and every
table here says so.

## How to check each claim

| Claim                                                | Where it is tested                                           |
| ---------------------------------------------------- | ------------------------------------------------------------ |
| A relay cannot read a capsule                        | `tests/integration.test.ts`, `docs/PROTOCOL.md` §4           |
| The storing relay never sees the client with `--mix` | `tests/mixnet.test.ts` ("0 direct requests")                 |
| A relay can neither forge nor roll back a site       | `tests/sites.test.ts`, `packages/protocol/test/site.test.ts` |
| A `.capsule` page cannot reach the network           | `tests/viewer.test.ts`, `apps/extension/test/render.test.ts` |
| A probe cannot recognise a bridge                    | `tests/bridge.test.ts`                                       |
| A capsule works with no network at all               | `tests/offline.test.ts`                                      |
| A relay is found with no DNS and no uplink           | `tests/offline.test.ts`                                      |
| Padding hides the size                               | `tests/sites.test.ts`, `tests/offline.test.ts`               |
| Manifests do not leak the filename length            | `packages/protocol/test/protocol.test.ts`                    |
| `k` of `n` leaves one relay with nothing useful      | `tests/network.test.ts`                                      |
