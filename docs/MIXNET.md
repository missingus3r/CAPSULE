# CAPSULE's mix network

**Status:** implemented and working; no external audit
**Date:** 2026-08-30
**Scope:** relays as mix nodes; the CLI, the web app and the extension as clients

## 1. First, because it changes everything else

**A network's anonymity comes, above all, from the size of the set you are
hiding in.** If ten people use a network, an observer who knows a message came
out of it has already narrowed the problem to ten. No cryptography fixes that:
it is not a property of the code, it is a property of how many people use it
and how many separate operators run the nodes.

Tor has millions of users and thousands of relays spread across jurisdictions.
This network starts with you. That is why the CLI tells you, every single time
you use it, how many nodes and how many apparent operators there are:

```
Mix network: 4 mixes across 1 apparent operators, 3 hops each way.
Enough to keep the storing relay from seeing you, and not enough for anything more.
```

That sentence is not decorative modesty. With four nodes under one operator,
what you gain is concrete and bounded: **the relay that stores your capsule does
not see your address.** Nothing more. If those four nodes are run by one person,
that person sees both ends.

Everything that follows describes how the part it _does_ do is built.

## 2. Why this is not simply Tor

Tor is designed for browsing: a person waiting for a web page will not tolerate
an extra second. That constraint defines its architecture and also its
best-known, least-fixable weakness: **because packets leave as fast as they
arrive, anyone watching both ends can pair them up by timing.** That is
end-to-end traffic correlation, and for a low-latency system it has no
solution.

Transferring a file has no such constraint. A file can take minutes. That
enables defences Tor cannot use:

|                                  | Tor                                  | This network                                               |
| -------------------------------- | ------------------------------------ | ---------------------------------------------------------- |
| Latency                          | Milliseconds                         | Seconds to minutes, by design                              |
| Real mixing (delays, reordering) | Cannot                               | Yes: each hop holds the packet a random time               |
| Packet size                      | 514 B cells over a continuous stream | One size, always, end to end                               |
| Cover traffic                    | Limited                              | Every node emits loops indistinguishable from real traffic |
| Exit nodes                       | Sees plaintext traffic without TLS   | **None**: the destination is the relay itself              |
| Directory                        | Signing directory authorities        | Peer gossip, no authority                                  |
| Anonymity set                    | Millions                             | Whatever you have                                          |
| Censorship resistance            | Bridges, pluggable transports        | Bridges since 1.3; no pluggable transports                 |
| Independent analysis             | 20 years                             | None                                                       |

The last two rows are why **this does not replace Tor**, and why the CLI lets
you use both at once:

```bash
capsule --tor --mix send file.pdf --relay https://relay.example
```

Tor hides from your internet provider that you are using CAPSULE. The mix
network hides from the relays who you are. Those are different problems, solved
in different layers.

## 3. How it works

### 3.1 The packet

Every packet is a Sphinx packet (Danezis and Goldberg, 2009) of **65,920 bytes,
always**, whatever it carries. A capsule chunk, a control operation and a
filler loop are the same size and look the same.

The exact format is in [PROTOCOL.md](./PROTOCOL.md) §16. Three properties
matter:

- **The header is blinded at every hop.** Each node derives a secret from its
  private key and the packet's ephemeral point, peels one routing block, and
  transforms the point for the next. The packet leaving a node looks nothing
  like the one that arrived.
- **Filler covers what was peeled.** The consumed block is replaced with
  pseudorandom bytes the sender computed in advance, so the header never
  shrinks and a node cannot tell how far it is from the origin or how much is
  left.
- **The body is a wide-block cipher.** Flipping one bit anywhere randomises all
  64 KiB. That defeats tagging: a node cannot mark a packet to recognise it
  later, because the mark destroys the content and the destination rejects it.

### 3.2 The path

A send uses **two different paths**, chosen fresh for every request:

```
client → mix A → mix B → relay that stores the capsule
                                 ↓ (reply block)
provider mailbox ← mix D ← mix C
```

The destination relay **is the last hop**; there is no exit node. This is a
real difference from onion routing for the web: no party ever sees the request
in the clear without also being the party it was addressed to. The relay learns
which capsule operation was requested, which it would learn anyway, and does
not learn from whom.

The reply travels via a **single-use reply block** the client builds and hands
to the relay inside the request. The relay can answer and cannot know where the
answer goes: it only knows which first hop to give it to.

### 3.3 The delays

Each hop holds the packet for a time drawn from an exponential distribution the
sender chooses. That is what breaks timing correlation: how many packets a node
is holding at any moment does not depend on when they arrived, so pairing
arrivals with departures by time stops working.

The cost is real and it is paid in seconds:

| Mean per hop  | 3 hops, round trip | 200 KB measured |
| ------------- | ------------------ | --------------- |
| 0 ms          | immediate          | ~1 s            |
| 200 ms        | ~1.2 s per request | ~10 s           |
| 2 s (default) | ~12 s per request  | ~90 s           |
| 30 s          | ~3 min per request | ~25 min         |

A node caps what a sender may ask of it (`CAPSULE_MIX_MAX_DELAY_MS`), so nobody
can freeze its queue.

### 3.4 The mailbox

A client behind NAT cannot receive connections, so the last hop of the reply
leaves it in a **mailbox** on a relay the client picks as its provider, and the
client polls it.

This has a consequence worth stating plainly: **your provider knows you exist.**
It sees an address polling a mailbox. It does not see what you asked or of
whom, but it knows somebody is using the network from there. That is inherent
to a client that cannot be dialled; it is not an oversight. Pick a provider you
are comfortable with, or put Tor underneath.

### 3.5 The cover traffic

Every node sends packets to itself along random paths, at intervals. They end
at a hop that discards them. To anyone watching a link between two nodes, they
are identical to real packets.

Without this, a link that carries only real traffic tells an observer exactly
when there is real traffic. With it, it tells them nothing.

## 4. Using it

### 4.1 As a client

```bash
# Send through the network, with the defaults (3 hops, 2 s per hop)
capsule --mix send report.pdf --relay https://relay.example

# Slower and harder to correlate
capsule --mix --mix-hops 4 --mix-delay 15000 send report.pdf

# Receive through the network
capsule --mix receive "<link>"

# Delete through the network
capsule --mix delete "<owner capability>"

# Choose the mailbox provider yourself
capsule --mix --mix-provider https://relay-you-trust.example send report.pdf

# With Tor underneath: the ISP does not see CAPSULE, the relays do not see you
capsule --tor --mix send report.pdf
```

The CLI always prints the real size of the network before sending. If it says
`single-node`, you are getting no anonymity of any kind, and it says so.

### 4.2 As a node operator

A relay is a mix node by default. There is nothing to install beyond the relay:

```bash
CAPSULE_MIX_ENABLED=true              # the default
CAPSULE_MIX_COVER_INTERVAL_MS=30000   # how often it emits a loop
CAPSULE_MIX_MAX_DELAY_MS=300000       # cap on the delay a sender may ask for
CAPSULE_MIX_MAX_QUEUED=2048           # packets it may be holding
CAPSULE_MIX_MAILBOX_TTL_MS=3600000    # how long an unclaimed reply is kept
CAPSULE_MIX_RATE_LIMIT_MAX=12000      # mix traffic is not API traffic
```

What your node sees, and therefore what you take on:

- the address of the previous hop and of the next one, and nothing else;
- that a packet passed through, not where it came from or where it went;
- if you are the destination: the capsule operation, the same as in a direct
  request;
- if you are a provider: that somebody polls a mailbox from an address.

What your node **cannot** see: the contents of a packet not addressed to it,
the length of the path, its own position in the path, or the relationship
between the packet that came in and the one that went out.

## 5. What this network does not do

In order of what matters most.

**It does not protect you when the anonymity set is small.** Said above and
first for a reason. Four nodes under one operator are not an anonymity network;
they are a way for a relay not to see your IP.

**It does not resist a global passive observer.** Somebody who sees every link
can, with enough traffic and time, do statistical flow analysis. Delays and
padding make that much more expensive; they do not prevent it. Such an
adversary is outside the model.

**It does not resist an active n−1 attack.** An adversary who controls the
nodes around yours and can suppress everyone else's traffic can isolate your
packet. Cover loops and random path selection make this expensive; it is not
solved, and it is an open problem in the literature.

**It does not resist Sybil on its own.** Proof of work on announcements and the
cap per apparent operator make inventing nodes expensive. A resourced adversary
can still stand up many. A large directory is not evidence of independence:
look at who operates the relays, not how many there are.

**It does not hide that you are using CAPSULE.** Your internet provider sees
connections to a relay. That is what Tor underneath, or a bridge, is for: see
[CENSORSHIP.md](./CENSORSHIP.md).

**It needs relays, and most readers have too few.** Every client can use the
network now, the CLI, the web app and the extension, but a path needs relays
the client can reach, and the extension will only use ones the visitor has
already allowed. With fewer than two it asks directly and says so. That is not
a bug to fix in code: it is the same adoption problem as §1, arriving where a
reader can see it.

The packet layer itself is no longer the obstacle. It used to be built on
`node:crypto`, which meant it could not run in a page at all; it is built on
the audited `@noble` implementations now, produces byte-identical packets, and
`test/interop.test.ts` pins that so an older relay and a newer one keep
understanding each other.

**It has no formal analysis and no audit.** The constructions are published and
used as specified, but _this_ composition has not been reviewed by anyone
outside. The tests verify concrete properties, indistinguishability between
hops, tagging resistance, replay rejection, and that is not the same thing as
a cryptographic review.

## 6. How to tell whether it is helping you

Three questions, in order:

1. **Who are you hiding from?** If it is the relay storing the file, this
   network helps today. If it is your internet provider, you need Tor. If it is
   somebody who sees the whole network, this is not enough and probably nothing
   you can install is.
2. **How many separate operators are there?** Not how many nodes: how many
   distinct people or organisations. With one, the path is decorative.
   `capsule network` prints this.
3. **Can you wait?** If you need the file to arrive now, lower the delays and
   accept that the mixing stops mixing. The honesty here is the same:
   `--mix-delay 0` is a three-hop proxy, not a mix network.

## 7. References

- George Danezis, Ian Goldberg. _Sphinx: A Compact and Provably Secure Mix
  Format._ IEEE S&P, 2009.
- Ania Piotrowska et al. _The Loopix Anonymity System._ USENIX Security, 2017.
  The exponential delays, the cover loops and the provider/mailbox model come
  from here.
- Ross Anderson, Eli Biham. _Two Practical and Provably Secure Block Ciphers:
  BEAR and LION._ FSE, 1996. The wide-block cipher used for the body.
- Roger Dingledine, Nick Mathewson, Paul Syverson. _Tor: The Second-Generation
  Onion Router._ USENIX Security, 2004. Worth reading above all for the section
  on what Tor deliberately does **not** solve, which is where half of this
  design comes from.
