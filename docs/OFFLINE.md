# Working with no internet

**Status:** implemented and working; no external audit
**Date:** 2026-08-30

Everything else in CAPSULE assumes there is a relay to reach. Sometimes there
is not: the uplink is cut, the network is hostile, or the file must not touch
one at all. There are two answers, and which one applies depends on how much
network is left.

| What is left                   | Use                | What it needs                 |
| ------------------------------ | ------------------ | ----------------------------- |
| Nothing at all                 | An offline capsule | A memory stick, or two hands  |
| A local network with no uplink | A LAN beacon       | Two machines on the same wifi |

## 1. An offline capsule

`capsule offline pack` encrypts a file into a single object that travels the
way anything travelled before networks: on a disk, in a pocket, across a room,
across an air gap.

```bash
capsule offline pack ./report.pdf --out report.capsuleoff --anonymous
```

It prints:

```
Wrote report.capsuleoff (224.5 KiB)

The file is sealed. It holds ciphertext and nothing that opens it.
Send this key by a different route than the file:

  capsule-offline:eyJrZXkiOiJjd2kyUktJNnNQbjJYTDlJZ0xNR1A2a2Vl...
```

And at the other end:

```bash
capsule offline open report.capsuleoff --key "capsule-offline:..." --out ./
```

### 1.1 Sealed by default

The default is **sealed**: the file holds ciphertext and nothing that opens it.
The key travels separately, exactly as the key in a share link travels
separately from the bytes on a relay. It is the same idea applied to a different
courier, and it means a lost memory stick is a lost memory stick rather than a
disclosure.

`--with-key` puts the key inside, so the file opens on its own. That is a
reasonable thing to want — sometimes the point is to hand somebody one object
and be done — and the tool says what it costs when you do it.

### 1.2 What it inherits

An offline capsule is the same encryption as everything else: AES-256-GCM per
chunk, the same nonce construction, the same associated data binding it to the
protocol version. `--anonymous` does what it does everywhere: pads to a size
class, strips embedded metadata, and replaces the filename with a neutral one.

So a 1 KB note and a 60 KB photograph produce files of the same size, and the
name of the file on the memory stick says nothing about what is inside.

### 1.3 What it does not have

**No expiry.** There is no relay running a clock, so an offline capsule says
`expiresAt: null` — which is the truthful answer, rather than a promise no
software will keep. It exists until the file is deleted.

**No deletion capability.** There is nobody to ask to delete it. Whoever holds
the file holds it.

**No replication.** One file, one copy, whatever you do with it.

## 2. A local network with no uplink

Two laptops on a phone hotspot in a building with the internet cut. There is a
network, but every way CAPSULE normally finds a relay assumes something outside
the room: DNS to resolve a name, a seed list somebody published, a peer that is
already reachable.

So a relay can shout on the local network, and a client can listen:

```bash
# On the machine running the relay
CAPSULE_LAN=true node apps/relay/dist/main.js

# On the other machine
capsule lan
```

```
http://192.168.1.10:8795  8dVqfWmzmOWN…  sites, mix
```

Then use it as an ordinary relay:

```bash
capsule send ./report.pdf --relay http://192.168.1.10:8795
```

No DNS, no bootstrap list, no server anywhere outside the room. This is UDP
multicast on `239.255.42.99:8799`, an administratively scoped group that is
never routed off the local network — the same mechanism a printer uses to
announce itself.

### 2.1 It is off by default, and it should be

**A beacon tells everyone on the network that this machine is running CAPSULE.**
On a café's wifi that is a disclosure, and it is exactly the kind of disclosure
the rest of this project spends its effort avoiding. It is worth turning on when
the local network is the only network there is, and not otherwise.

### 2.2 A beacon is not authenticated, and cannot be

Anybody on the network can send one. The point is to find a relay you have
never heard of, on a network with no infrastructure, so there is nothing to
check a signature against.

What protects the content is that the content was already encrypted before it
went anywhere. A hostile relay on the local network sees ciphertext, exactly as
a hostile relay on the internet does.

What a beacon _is_ prevented from doing is pointing a client somewhere strange:
it may only name a plain `http(s)` origin, with no path, no credentials, no
query and no other scheme. A beacon naming `file:///etc/passwd` is discarded
before anything looks at it.

## 3. What this is not

**It is not a mesh network.** Briar, Meshtastic, Bitchat and Reticulum work over
Bluetooth, LoRa and radio, with no IP at all, and they route between devices
that cannot see each other directly. CAPSULE does neither. On a local network it
needs IP; with no network it needs a person to carry a file.

That is a real difference and it is worth being clear about which problem you
have. If the question is "the internet is cut in this city and I need to reach
someone across it", CAPSULE is not the tool. If the question is "the internet is
cut and the person is in this building", or "this file must not touch a
network", it is.

**There is no store-and-forward.** An offline capsule does not opportunistically
sync when a network appears. It is a file; you move it.

## 4. Where the claims are tested

| Claim                                                   | Where                   |
| ------------------------------------------------------- | ----------------------- |
| A sealed file round-trips with its key                  | `tests/offline.test.ts` |
| A sealed file cannot be opened without it               | `tests/offline.test.ts` |
| Another capsule's key does not open it                  | `tests/offline.test.ts` |
| Padding hides the size, and the bytes come back exactly | `tests/offline.test.ts` |
| A truncated or altered file is refused                  | `tests/offline.test.ts` |
| A beacon is heard on the local network                  | `tests/offline.test.ts` |
| A beacon cannot point a client at a strange address     | `tests/offline.test.ts` |
