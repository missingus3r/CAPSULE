# Reaching CAPSULE when someone is blocking it

**Status:** implemented and working; no external audit
**Date:** 2026-08-30

## 1. The problem, stated honestly

Until version 1.3, blocking CAPSULE was trivial, and the reason is built into
its design: **the relay directory is public on purpose.** Ask any relay for
`/v1/peers`, walk the graph, and you have every address in the network. Designing
for discovery and designing against enumeration are the same design pointed in
opposite directions, and CAPSULE had only ever pointed it one way.

A censor has four cheap moves. In the order they actually get used:

1. **Enumerate and block.** Walk the gossip graph, add every address to a list.
2. **Probe.** For an address that looks suspicious, connect and ask it what it
   is. One HTTP request per address, run at national scale.
3. **Fingerprint.** Write one DPI rule matching something every CAPSULE
   connection carries, and block by traffic shape rather than by address.
4. **Take the list.** Get the addresses from wherever they are published.

Bridges answer the first three. **Nothing here answers the fourth**, and no
amount of code will: if the censor obtains a bridge line, they have the bridge.
That is a distribution problem, it is unsolved in Tor after fifteen years of
work, and it is unsolved here.

## 2. What a bridge is

A relay started with `CAPSULE_BRIDGE=true`. It differs from an ordinary relay
in three ways:

- **It never announces itself.** It still learns the network, it pulls peer
  lists so it can route, but it never posts an announcement, so it never
  appears in anybody's `/v1/peers`. A bridge in a peer list is not a bridge.
- **Everything real lives under a secret path prefix**, sixteen base32
  characters derived from its key. A scan for `/v1/info` finds nothing.
- **Every real request carries an authenticator.** Without a valid one, the
  bridge answers exactly like an unconfigured web server, whatever was asked.

The key travels in a **bridge line**, one token with no spaces, meant to be
handed from a person to a person:

```
capsule-bridge:1:MTI3LjAuMC4x:8791:0:ljdH-I5PGbij11GLYVXdYzc4KfpriyJLqkjNtwk_ulo
```

That is `capsule-bridge:<version>:<host>:<port>:<tls>:<key>`, with the host
base64url-encoded so an IPv6 address does not collide with the separator.

## 3. What a probe gets

This is the property that matters, so here it is exactly. Against a live
bridge:

```
GET /v1/info    → 404, an ordinary HTML "Not Found"
GET /v1/peers   → 404
GET /health     → 404
GET /           → 200, "It works!"
```

And with the secret prefix but no valid authenticator, or a malformed one, or
an expired one, or one replayed from traffic the censor recorded: the same 404. There is no error that distinguishes them, because an error message is an
answer, and the point is to have nothing to say.

The operator can point `CAPSULE_BRIDGE_DECOY` at a real HTML file, in which
case the bridge looks like whatever that file is. A bridge that serves a
plausible small site is better camouflage than one that serves the default
page, because the default page is itself a (weak) signal.

## 4. The authenticator

A **session cookie**, and the choice is deliberate on both counts.

Not a header of our own, because a custom header name is one string a censor
could write a single DPI rule for, matching every CAPSULE bridge in the world
at once. An opaque session cookie is the most ordinary thing on the web.

Not `Authorization`, because that header already carries the capsule's own
read, write and delete tokens. The bridge is a layer underneath what it
carries and must not disturb it.

The cookie's **name** is derived from the bridge key, chosen from a list of
ordinary session-cookie names, so two bridges do not even look alike. Its value
is `base64url(uint32be(seconds) ‖ nonce(16) ‖ HMAC-SHA-256(...))`, which reads
as an opaque session id.

The MAC covers the request's own method and path, so a cookie observed on one
request cannot be replayed onto another. Timestamps outside five minutes are
refused, and each nonce is remembered for that window, so recording one
request off the wire and sending it again is not a probe either.

## 5. Running one

```bash
CAPSULE_BRIDGE=true \
CAPSULE_BRIDGE_HOST=bridge.example.org \
CAPSULE_PUBLIC_URL=https://bridge.example.org \
CAPSULE_PEERS=https://a-relay-you-know.example \
node apps/relay/dist/main.js
```

It prints the bridge line once, to standard output rather than the log, because
it is meant to be copied by a person and not collected by anything.

Notes for an operator:

- **Use HTTPS.** Without TLS the traffic is recognisable on the wire and none
  of this hides anything. The relay warns when it starts without it.
- **`CAPSULE_PEERS` is still worth setting.** A bridge that knows the network
  can route to it; one that does not is an island.
- **Put it somewhere unremarkable.** A bridge on a host that also serves a real
  site is much better camouflage than one on an otherwise empty address.
- The key is written to `bridge-key` in the storage directory with mode `0600`,
  or supplied through `CAPSULE_BRIDGE_KEY`. Whoever holds it can use the bridge.

## 6. Using one

```bash
capsule --bridge "capsule-bridge:1:..." send ./report.pdf
capsule --bridge "capsule-bridge:1:..." receive "<share-url>"
capsule --bridge "capsule-bridge:1:..." site publish ./www --key site.capsulekey
```

The bridge wraps whatever is underneath it, so the layers stack the way you
would expect:

```bash
# Tor carries the connection; the bridge is what the connection reaches.
capsule --tor --bridge "capsule-bridge:1:..." send ./report.pdf
```

Everything that talks to a relay goes through one bridge-aware `fetch`, so
transfers, relay discovery, `.capsule` name resolution and record
announcements all work through a bridge without any of them knowing about it.

## 7. What this does not do

**It does not solve distribution.** Publishing a bridge line anywhere a censor
can read defeats the point entirely. The value of a bridge is exactly the value
of the channel it was shared over. Tor has BridgeDB, email autoresponders and
moat for this; CAPSULE has nothing, and a person handing another person a line
is the whole mechanism today.

**It does not defeat traffic analysis.** A censor who cannot tell _what_ a
connection is may still notice a connection with the size and timing pattern of
a file transfer. Size-class padding and, with `--mix`, uniform 65,920-byte
packets help; they are not a pluggable transport and do not claim to be.

**It does not hide the TLS handshake.** A censor fingerprinting TLS client
hellos sees Node's, not a browser's. This is real and it is not addressed.

**It shrinks your anonymity set.** Bridge users are a smaller and separately
identifiable population than direct users. This is the same cost Tor bridge
users pay, and it is a cost, not an oversight.

**A share link made directly on a bridge contains the bridge's address.**
Anyone you send that link to learns the bridge. When that matters, use
`--bridge` together with `--mix` so the capsule is stored on a public relay and
the bridge is only how you reached the network.

**A sustained probing campaign may still find a signal.** The rate limiter
answers a flood differently from an idle server. A single probe learns nothing;
ten thousand might.

## 8. The other road: something else underneath

CAPSULE has spoken SOCKS5 since 1.0, and that is not a lesser answer: it is
often the better one, because it borrows a decade of work this project has not
done:

```bash
# Tor, with its bridges and pluggable transports
capsule --tor send ./report.pdf

# obfs4proxy, snowflake, or anything else that speaks SOCKS5
capsule --proxy socks5h://127.0.0.1:9050 send ./report.pdf
```

If you are somewhere that Tor's obfuscated transports already work, use them.
CAPSULE bridges are for the case where you have an address nobody else knows
and want to keep it that way.

## 9. How to check any of this

| Claim                                          | Where it is tested     |
| ---------------------------------------------- | ---------------------- |
| A probe for the relay API gets an ordinary 404 | `tests/bridge.test.ts` |
| The prefix alone does not open the bridge      | `tests/bridge.test.ts` |
| A cookie for one path does not open another    | `tests/bridge.test.ts` |
| A replayed cookie is refused                   | `tests/bridge.test.ts` |
| A stale cookie is refused                      | `tests/bridge.test.ts` |
| A bridge never appears in a peer list          | `tests/bridge.test.ts` |
| A client with the line completes a transfer    | `tests/bridge.test.ts` |
