# Run your own relay

**Status:** operational guide for CAPSULE 1.3
**Date:** 2026-08-30

There is no registration, no allow-list and nobody to ask. A CAPSULE relay is
any host that answers `/v1/info`. You start yours, point it at a relay you
already know, and from there they introduce themselves to each other.

## 1. What a relay is and is not

A relay stores ciphertext and hands it to whoever presents the right
capability. For a capsule sent as a link it **cannot** read the content, the
filename or the note: all of that travels encrypted and the key rides in a URL
fragment that browsers never send to a server.

What your relay does see, and therefore what you take on as an operator:

- IP addresses for the duration of each connection;
- the time and volume of each transfer;
- the size class of each capsule (the exact size only if the sender did not
  pad);
- how many times a capsule was read;
- **the full content of every `.capsule` site you hold**, because a site
  record carries the capability and the capability carries the key. That is
  what makes a name resolvable at any relay without a registry, and it means a
  site is public to you exactly as it is public to its readers.

So there are two different jobs in one process. Hosting capsules means holding
data you cannot inspect. Hosting sites means holding public pages you can read
and did not choose — including, if replication is on, pages that reached you
by gossip rather than by upload. Section 6 is about what you can do in each
case. Read [the threat model](./THREAT_MODEL.md), particularly the section on
abuse and illegal content, before exposing a relay to the internet.

## 2. Minimum start

```bash
git clone <this-repository> capsule && cd capsule
npm install
npm run build
CAPSULE_HOST=0.0.0.0 CAPSULE_STORAGE_DIR=/var/lib/capsule \
  node apps/relay/dist/main.js
```

With Docker:

```bash
cd infra
CAPSULE_PUBLIC_URL=https://relay.example.org docker compose up -d
```

On its first start the relay generates its Ed25519 identity and writes it to
`identity.json` in the data directory, with mode `0600`. That file **is** your
relay's identity: lose it and the network sees a new relay. Back up the data
directory, or at least that file.

The data directory also holds `capsules/`, one directory per capsule, and
`sites.json`, the `.capsule` records this relay serves. Both survive a restart.
Losing `sites.json` costs nothing permanent, publishers re-announce and peers
gossip, but until they do, the names it held resolve nowhere at this relay.

## 3. Joining the network

Two variables are enough:

```bash
# The address others can reach you at. Without it you can discover relays, but
# nobody can announce you: you are only a consumer of the directory.
CAPSULE_PUBLIC_URL=https://relay.example.org

# Relays you already know. One is enough.
CAPSULE_PEERS=https://a-relay-someone-told-you-about.example
```

Optional:

```bash
CAPSULE_RELAY_NAME="the neighbourhood club relay"  # label shown in the directory
CAPSULE_MAX_PEERS=200                              # cap on the local directory
CAPSULE_MAX_PEERS_PER_OPERATOR=4                   # cap per apparent domain
CAPSULE_PEER_SYNC_INTERVAL_MS=300000               # how often it greets its peers
CAPSULE_ANNOUNCE_POW_BITS=18                       # work demanded of an announcer
CAPSULE_ALLOW_PRIVATE_PEERS=false                  # true only on local networks
```

`CAPSULE_ANNOUNCE_POW_BITS` is what it costs a new relay to introduce itself:
each bit doubles the work. At 18 bits an honest relay spends a fraction of a
second per gossip round, and filling your directory with invented relays costs
that same fraction **for each one**. Raise it if you see junk announcements;
lower it to 0 only on a closed network.

`CAPSULE_ALLOW_PRIVATE_PEERS` is **not** a convenience: it is the switch that
lets an announced address point back into your own network. Leave it `false` on
any relay exposed to the internet.

On each gossip round the relay:

1. greets the configured peers and the ones it already knows;
2. sends them a signed announcement with its proof of work solved;
3. receives the list of relays they know;
4. probes each new address with `GET /v1/info` and keeps it only if that
   address answers with an identity consistent with what was announced.

No address is stored because of trust in whoever passed it along, **not even
when it arrives signed**: a signature proves who wrote the message, not who
controls the address inside it. That is why even a direct announcement is
verified by contacting the announced address before believing it.

The relay also refuses to connect to an address pointing into its own network:
it discards loopback, link-local, private ranges, CGNAT and reserved addresses,
including the ways they can be written in IPv6 (`[::ffff:7f00:1]` is
`127.0.0.1`), and it **resolves** names to reject the ones that point there. If
you run the relay on a machine that also hosts internal services, isolating it
on the network is still the prudent thing.

Verify from another machine:

```bash
curl https://relay.example.org/v1/info
node apps/cli/dist/index.js relays --seed https://relay.example.org
```

## 4. Capsules without expiry

They are **on** by default, and bounded: a relay nobody configured accepts them
up to **1 GiB in total** and **128 MiB per sender**. That bound is the point.
Storing files with no end date is a cost, and the default answer is a known
amount of disk rather than an open-ended promise or an option the apps offer
and the relay then refuses.

Raise the ceiling if you have the disk:

```bash
CAPSULE_MAX_PERSISTENT_BYTES=10737418240              # 10 GiB cap
CAPSULE_MAX_PERSISTENT_BYTES_PER_SENDER=1073741824    # 1 GiB per sender
```

Or refuse them outright, which is a legitimate policy and not a degraded relay:

```bash
CAPSULE_ALLOW_PERSISTENT_CAPSULES=false
```

The per-sender cap keeps the first person who arrives from taking all the
space. To tell senders apart without keeping a list of who they are, the relay
counts against a salted hash of the address, and the salt is discarded and
regenerated every window: when it rotates, the counters forget. That is
deliberate.

While it is on:

- the relay accepts `expiresInSeconds: null` and publishes that in
  `/v1/config`, so clients offer the option instead of trying and failing;
- periodic cleanup never touches those capsules;
- at the cap, the relay answers `507 insufficient_storage` to new capsules
  without expiry, without affecting the ones that have a TTL;
- the only way to remove them is the sender's owner capability, or you deleting
  the directory by hand.

Say it plainly in your service policy: it is not "permanent", it is "until
somebody deletes it or until this relay stops existing".

## 4b. Being a seed somebody pins

A seed is the relay a fresh install asks first, so it is the most valuable
address in the network to impersonate. If yours is going to be one, it has to
be handed out **pinned**, with the identifier a client can hold you to:

```bash
curl -s https://relay.example.org/v1/info | jq -r '.relayId'
# → the id; hand out the seed as:
#   https://relay.example.org#<relayId>
```

A client given that form sends a challenge and requires your relay to sign it.
Your relay answers on its own, with no configuration: the key it already has is
the one that signs. What this buys is precise: somebody who seizes the name,
the certificate or the host **cannot** stand in for you, because they cannot
produce the signature. What it does not buy is protection against you: a seed
that answers correctly still decides which relays a new install first hears
about, which is why more than one seed, run by more than one person, is worth
more than any check.

Handing out the bare origin instead is trust-on-first-use, which is fine for
somebody typing it in and wrong for anything that ships with the software.

## 4c. Seeing whether anything is happening

```
https://your-relay.example/realtime
```

A page with two numbers and their peaks: addresses that made a request in the
last five minutes, and relays in your directory. It is there so an operator can
tell a relay that is carrying traffic from one that is merely running, without
installing anything.

Read `addresses` as addresses. It is not a user count and cannot become one:
two devices are two, a household behind one router is one, and anybody using
the mix network is counted as the relay that forwarded for them. The page holds
nothing: the relay keeps a salted digest of the address for the length of the
window, which is the same value rate limiting already keeps, and the salt
rotates, so a digest cannot be followed from one window into the next.

## 5. Operational privacy

```bash
CAPSULE_IP_BLIND=true    # the default
```

With this the relay writes no addresses to its logs and rate limiting uses a
hash with a rotating salt instead of the IP. It reduces what you **retain**,
not what you observe: the operating system and the proxy still see the
connection.

Also:

- terminate TLS with HTTPS and never put a capability in a query string (the
  protocol already uses `Authorization`; keep it that way);
- configure your reverse proxy **not** to log IPs or the `Authorization`
  header;
- do not put third-party analytics in front of the relay;
- if you publish an onion service, the `.onion` works unchanged: it is just
  another HTTP URL to the protocol, and the CLI reaches it with `--tor`.

## 6. Limits and abuse

```bash
CAPSULE_MAX_CAPSULE_BYTES=104857600
CAPSULE_MAX_CHUNK_COUNT=10000
CAPSULE_MAX_TTL_SECONDS=604800
CAPSULE_RATE_LIMIT_MAX=300
CAPSULE_CREATE_RATE_LIMIT_MAX=30
```

For capsules you cannot moderate by content: you cannot see it. What you can
do is bound size, time and frequency, publish a policy and a contact route,
and refuse a specific `capsuleId` when you receive a well-founded complaint.
For sites you can also read what you hold, so "I could not know" is not
available to you the way it is for capsules.

Refusing is a file:

```json
// data/denylist.json
{
  "capsules": [{ "id": "<capsuleId>", "reason": "your note" }],
  "sites": [{ "name": "<name>.capsule", "reason": "your note" }]
}
```

```bash
CAPSULE_DENYLIST_FILE=./data/denylist.json   # the default, inside your data dir
CAPSULE_DENYLIST_RELOAD_MS=15000             # re-read while running; 0 = at startup only
```

Adding an entry does three things at once, and it needs all three to be worth
anything: the content is refused at the door, dropped from `sites.json` so
this relay stops gossiping the name, and removed from the disk. Without the
first, gossip hands the record straight back on the next round. Without the
third, you are still hosting it. A denied capsule then answers with the same
`404` as an identifier that was never here.

Two properties worth being explicit about, because they are the reason this is
a file and not an endpoint:

- **Nobody can add to your list but you.** No relay, no peer, no request. What
  you refuse says nothing about what anyone else serves, and content you drop
  stays reachable at every relay that kept it. This is an exit policy, not a
  blocklist.
- **It is not a substitute for a policy.** The tool decides nothing for you.
  Write down what you will act on and where complaints reach you before the
  first one arrives, not after.

What this replaces is worse: an operator whose only working answer to a
complaint is `systemctl stop` takes every other capsule on the machine down to
deal with one.

## 6b. Sites you did not upload

If `CAPSULE_SITES_ENABLED` is on, your relay gossips `.capsule` records. If
`CAPSULE_SITE_REPLICATION` is also on — it is by default — it fetches the
pages behind them too, and answers for them under the same identifiers the
publisher's record names.

```bash
CAPSULE_SITE_REPLICATION=true
CAPSULE_MAX_REPLICA_BYTES=268435456   # 256 MB of copies, total
CAPSULE_REPLICA_TTL_SECONDS=604800    # each copy is a week's lease, renewed while gossiped
```

This is what makes a `.capsule` name survive the loss of the machine it was
published to, and it is the only part of the design where you store something
nobody handed you. Copies are leases: each round renews the ones whose record
is still being gossiped and releases the rest, so superseded versions go and a
name the network stops carrying drains away. Private capsules are never
replicated — their keys never reach any relay — and neither are sharded ones.

Turn it off with `CAPSULE_SITE_REPLICATION=false` and your relay holds only
what was uploaded to it. Leave it on and the network stops depending on any
single host, which is the whole point of the thing. Either way, section 6 is
how you drop one you do not want.

## 7. Sharded capsules

If several relays in the network accept capsules, a sender can **split** one
instead of copying it: with `k` of `n`, each relay holds a shard that on its own
reconstructs nothing, and `k` separate operators are needed to read it.

For you as an operator that means two concrete things: you store about `1/k` of
each capsule instead of a whole copy, and if your disk is seized you do not
hold the complete ciphertext of anything. It needs no configuration: it is the
sender's decision, and your relay sees opaque shards exactly as it saw opaque
capsules.

## 8. Your relay is a mix node

By default, as well as storing capsules, your relay forwards packets for the
mix network. That is what lets the relay storing a capsule not see the address
of whoever uploaded it.

```bash
CAPSULE_MIX_ENABLED=true              # the default
CAPSULE_MIX_COVER_INTERVAL_MS=30000   # how often you emit a filler loop
CAPSULE_MIX_MAX_DELAY_MS=300000       # cap on the delay a sender may ask of you
CAPSULE_MIX_MAX_QUEUED=2048           # packets you may be holding
CAPSULE_MIX_RATE_LIMIT_MAX=12000      # mix traffic is not API traffic
```

What your node sees: the address of the previous hop and of the next one.
Nothing else. Not the content, not the length of the path, not its position in
it, and it cannot relate the packet that came in to the one that went out.

Two things worth knowing before leaving it on:

- **It costs bandwidth.** Every packet is 65,920 bytes and crosses several
  nodes. Cover traffic adds to that even when nobody is sending anything: that
  is its job. If it is expensive for you, raise
  `CAPSULE_MIX_COVER_INTERVAL_MS` before turning it off entirely, because a
  link with no cover tells anyone watching exactly when there is real traffic.
- **You may be somebody's provider.** If a client picks you for its mailbox you
  will see an address polling it periodically. You know that person uses the
  network; you do not know what they asked or of whom.

Read [MIXNET.md](./MIXNET.md) before announcing your node as part of an
anonymity network. With few operators it is not one, and overstating it is
worse than not having it.

## 9. Your relay stores `.capsule` names

A `.capsule` site is an ordinary capsule plus a **signed record** saying which
capsule is the current version of a name. Your relay stores those records and
passes them to other relays.

```bash
CAPSULE_SITES_ENABLED=true      # the default
CAPSULE_MAX_SITES=5000          # records before the oldest is dropped
CAPSULE_SITE_GOSSIP_LIMIT=200   # records you pull from a peer per round
```

### 9.1 What you see and what you do not

**You see** the name, the version number, the date and the title if the author
set one. Records are public by design: circulating is what they are for.

**You do not see** the content. The capability is inside the record and can be
used to download the capsule, but the capsule is encrypted end to end and your
relay does not have the key, unless you also choose to download and decrypt it
as any visitor would. Like any site, it is public; there is nothing special
about you being able to read it too.

**You cannot** forge or alter a record: the signature is verified against the
key inside the name and you do not have it. Nor can you roll a site back
without it being noticed: browsers remember the highest version they accepted.

### 9.2 The only thing you can do is stay silent

You can refuse to store records, or serve an old one. That is why clients ask
several relays and keep the highest version that verifies. A silent relay is
indistinguishable from a dead one, and suppressing an update requires every
relay the visitor asks to be silent.

### 9.3 If you would rather not take part

`CAPSULE_SITES_ENABLED=false` turns off the three endpoints and the record
gossip. Your relay keeps storing capsules and being a mix node. It is a
reasonable decision: hosting names is hosting published content, with whatever
that means in your jurisdiction. Section 6 above on abuse and illegal content
applies equally.

## 10. Running a bridge instead

A bridge is a relay that never announces itself and answers everyone without
the key like an ordinary web server. It exists for people whose access to the
public relays is blocked.

```bash
CAPSULE_BRIDGE=true
CAPSULE_BRIDGE_HOST=bridge.example.org   # what goes in the bridge line
CAPSULE_BRIDGE_DECOY=/srv/www/index.html # optional: what a probe sees instead
```

It prints a bridge line once, on standard output, for you to hand to people
directly. The full design, what a probe gets, and what it does not protect
against are in [CENSORSHIP.md](./CENSORSHIP.md).

Two things to get right: **use HTTPS** (without TLS none of it hides anything,
and the relay warns you), and **still set `CAPSULE_PEERS`**, because a bridge
that does not know the network is an island.

## 11. Announcing yourself on a local network

```bash
CAPSULE_LAN=true
```

The relay then announces itself over UDP multicast so a client with no
internet, no DNS and no seed list can still find it: see
[OFFLINE.md](./OFFLINE.md).

It is off by default and it should be: **a beacon tells everyone on the network
that this machine is running CAPSULE.** Turn it on when the local network is the
only network there is.

## 12. Checklist before announcing yourself

- [ ] Valid HTTPS and `CAPSULE_PUBLIC_URL` with the real origin.
- [ ] `identity.json` backed up and mode `0600`.
- [ ] Data volume with monitored free space.
- [ ] `CAPSULE_IP_BLIND=true` and a reverse proxy that does not log IPs.
- [ ] Size and TTL limits that match your disk.
- [ ] Capsules without expiry: the 1 GiB default is a decision even when you
      leave it alone. Raise it, lower it, or turn it off, but know which.
- [ ] An abuse policy and a contact route published, and a `denylist.json`
      path you know how to edit at 3am.
- [ ] Decided whether you carry sites published elsewhere
      (`CAPSULE_SITE_REPLICATION`, on by default) and with how much disk
      (`CAPSULE_MAX_REPLICA_BYTES`, 256 MB by default). Sites you carry are
      pages you can read and did not pick.
- [ ] `CAPSULE_ALLOW_PRIVATE_PEERS=false` (this is the anti-SSRF brake).
- [ ] `curl /v1/info` and `/v1/peers` answer from outside your network.
- [ ] Decided whether the mix node stays on, and with how much cover.
- [ ] Decided whether you host `.capsule` names (`CAPSULE_SITES_ENABLED`).
- [ ] If this is a bridge: HTTPS, a decoy worth looking at, and a plan for how
      the line reaches people.
