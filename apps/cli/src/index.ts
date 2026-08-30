#!/usr/bin/env node

import { createWriteStream, openAsBlob } from "node:fs";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import {
  DEFAULT_SEEDS,
  parseSeedRef,
  combineShares,
  decodeBridgeLine,
  bridgeOrigin,
  decodeOwnerCapability,
  isPublicRelayOrigin,
  decodeShare,
  decodeShareCapability,
  encodeOwnerCapability,
  encodeShare,
  splitSecret,
  unwrapWithPassphrase,
  wrapWithPassphrase,
} from "@capsule/protocol";
import {
  CapsuleRelayClient,
  createBridgeFetch,
  type RelayTransportFactory,
  deleteCapsule,
  discoverRelays,
  downloadCapsule,
  operatorHint,
  resumeUpload,
  selectRelays,
  uploadCapsule,
  type CapsuleAnonymityOptions,
  type FetchLike,
  type RelayInfo,
  type RelaySeed,
  type TransferProgress,
  type UploadTicket,
} from "@capsule/sdk";
import {
  MIX_CHUNK_SIZE,
  buildMixNetwork,
  describeStrength,
  type MixNetwork,
} from "@capsule/mixnet";
import { Command } from "commander";
import {
  collectRepeated,
  defaultRelayUrl,
  humanBytes,
  parseTtl,
} from "./options.js";
import { readPassphrase } from "./passphrase.js";
import { createProxiedFetch, parseProxyUrl } from "./proxy.js";
import { registerOfflineCommands } from "./offline.js";
import { registerSiteCommands } from "./site.js";
import { registerIndexerCommands } from "./indexer.js";

interface GlobalOptions {
  json?: boolean;
  bridge?: string;
  proxy?: string;
  tor?: boolean;
  retries?: string;
  mix?: boolean;
  mixProvider?: string;
  mixHops?: string;
  mixDelay?: string;
}

const TOR_DEFAULT_PROXY = "socks5h://127.0.0.1:9050";

const program = new Command();
program
  .name("capsule")
  .description("Send and receive private, temporary CAPSULE payloads")
  .version("1.3.0")
  .option("--json", "print machine-readable JSON")
  .option(
    "--proxy <url>",
    "route every relay request through a SOCKS5 proxy, e.g. socks5h://127.0.0.1:9050",
  )
  .option("--tor", `shorthand for --proxy ${TOR_DEFAULT_PROXY}`)
  .option(
    "--bridge <line>",
    "reach the network through an unlisted relay, using a capsule-bridge: line somebody gave you",
  )
  .option("--retries <count>", "retries per relay request", "3")
  .option(
    "--mix",
    "send through CAPSULE's own mix network instead of contacting the relay directly",
  )
  .option("--mix-provider <url>", "relay that holds the reply mailbox")
  .option("--mix-hops <count>", "hops per direction", "3")
  .option(
    "--mix-delay <ms>",
    "mean time each hop holds a packet; higher hides timing better and takes longer",
    "2000",
  );

/**
 * Builds the mix network from whatever the directory holds, and says out loud
 * how much protection that actually is. A network of three nodes is not a
 * secret to keep from the person relying on it.
 */
async function openMixNetwork(seeds: RelaySeed[]): Promise<MixNetwork> {
  const options = program.opts<GlobalOptions>();
  const fetchImpl = transport();
  const relays = await discoverRelays({
    seeds,
    ...discoveryScope(seeds),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const usable = relays.filter((relay) => relay.mixPublicKey);
  if (usable.length === 0) {
    throw new Error(
      "No relay in reach runs a mix node. Start one with CAPSULE_MIX_ENABLED=true, or drop --mix.",
    );
  }

  const hops = Number(options.mixHops ?? 3);
  const meanDelayMs = Number(options.mixDelay ?? 2000);
  if (!Number.isSafeInteger(hops) || hops < 1 || hops > 5) {
    throw new Error("--mix-hops must be between 1 and 5");
  }
  if (!Number.isFinite(meanDelayMs) || meanDelayMs < 0) {
    throw new Error("--mix-delay must be a non-negative number");
  }

  const network = buildMixNetwork({
    relays: usable,
    ...(options.mixProvider ? { providerUrl: options.mixProvider } : {}),
    pathLength: hops,
    meanDelayMs,
    timeoutMs: Math.max(120_000, meanDelayMs * hops * 8),
    ...(fetchImpl ? { fetchImpl } : {}),
  });

  if (!options.json) {
    process.stderr.write(`Mix network: ${describeStrength(network.strength)}
`);
    if (network.pathLength < hops) {
      process.stderr.write(
        `Only ${network.pathLength} hops are available, not the ${hops} requested.
`,
      );
    }
  }
  return network;
}

/**
 * The bridge line, if one was given. A bridge is an unlisted relay: it is not
 * in anybody's peer list and it answers everyone without the line like an
 * ordinary web server, which is what makes it usable where the public relays
 * are blocked.
 */
function bridge(): ReturnType<typeof decodeBridgeLine> | undefined {
  const line = program.opts<GlobalOptions>().bridge;
  return line ? decodeBridgeLine(line) : undefined;
}

/** Which transport a transfer should use. Only the mix network replaces it. */
function relayTransport(
  mixNetwork?: MixNetwork,
): { transport: RelayTransportFactory } | Record<string, never> {
  return mixNetwork ? { transport: mixNetwork.transportFor } : {};
}

/** Where a relay-less command should point when only a bridge is known. */
function defaultRelay(configured: string): string {
  const descriptor = bridge();
  return descriptor && configured.includes("localhost")
    ? bridgeOrigin(descriptor)
    : configured;
}

function transport(): FetchLike | undefined {
  const options = program.opts<GlobalOptions>();
  const proxyUrl =
    options.proxy ?? (options.tor ? TOR_DEFAULT_PROXY : undefined);
  const proxied = proxyUrl
    ? createProxiedFetch(parseProxyUrl(proxyUrl))
    : undefined;

  // The bridge wraps whatever is underneath it, so `--tor --bridge` stacks the
  // way you would expect: Tor carries the connection, the bridge is what the
  // connection reaches.
  const descriptor = bridge();
  if (!descriptor) return proxied;
  return createBridgeFetch(descriptor, proxied);
}

function retryPolicy(): { retry: { attempts: number } } {
  const attempts = Number(program.opts<GlobalOptions>().retries ?? 3);
  if (!Number.isSafeInteger(attempts) || attempts < 0) {
    throw new Error("--retries must be a non-negative integer");
  }
  return { retry: { attempts } };
}

function progressReporter(
  label: string,
  phases: TransferProgress["phase"][],
):
  { onProgress: (progress: TransferProgress) => void } | Record<string, never> {
  if (program.opts<GlobalOptions>().json) return {};
  const onProgress = (progress: TransferProgress): void => {
    if (!phases.includes(progress.phase)) return;
    const prefix = progress.phase === "complete" ? "Complete" : label;
    process.stderr.write(
      `\r${prefix}: ${humanBytes(progress.completedBytes)}/${humanBytes(progress.totalBytes)}   `,
    );
  };
  return { onProgress };
}

/**
 * Accepts `https://relay.example` or `https://relay.example#<relayId>`.
 *
 * The second form is the one that means anything: a pinned relay has to prove
 * it holds that identity by signing a challenge, so pointing a client at a
 * seized address fails instead of quietly succeeding. A bare origin is
 * trust-on-first-use, which is fine for one somebody typed and wrong for one
 * that ships with the software.
 */
function parseSeed(value: string): RelaySeed {
  const parsed = parseSeedRef(value);
  if (!parsed) throw new Error(`Invalid seed relay: ${value}`);
  return parsed.relayId
    ? { url: parsed.url, relayId: parsed.relayId }
    : parsed.url;
}

/**
 * What to ask when nobody said. The relay in the environment wins, then the
 * seeds that shipped, then a relay on this machine.
 */
function defaultSeeds(): string[] {
  const configured = process.env.CAPSULE_RELAY_URL?.trim();
  // Pinned when it is the seed that shipped: a bare origin here would be a
  // relay believed on the strength of its address alone.
  if (!configured && DEFAULT_SEEDS.length > 0) return [...DEFAULT_SEEDS];
  return [defaultRelayUrl()];
}

/**
 * Following a relay's peer list into loopback or a private network is only
 * reasonable when the operator is already working inside one — which is
 * exactly what a private seed says.
 */
function discoveryScope(seeds: RelaySeed[]): { allowPrivateRelays?: boolean } {
  const anyPrivate = seeds.some((seed) => {
    const url = typeof seed === "string" ? seed : seed.url;
    return !isPublicRelayOrigin(url);
  });
  return anyPrivate ? { allowPrivateRelays: true } : {};
}

async function readTicket(path: string): Promise<UploadTicket | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as UploadTicket).version === 1
    ) {
      return parsed as UploadTicket;
    }
    throw new Error(`${path} is not a CAPSULE resume ticket`);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

registerOfflineCommands(program, {
  json: () => program.opts<GlobalOptions>().json === true,
});

registerIndexerCommands(program, {
  json: () => program.opts<GlobalOptions>().json === true,
  transport,
  parseSeed,
  discoveryScope,
});

registerSiteCommands(program, {
  json: () => program.opts<GlobalOptions>().json === true,
  transport,
  retryPolicy,
  progressReporter,
  parseSeed,
  discoveryScope,
});

program
  .command("network")
  .description("Measure what the live network can actually offer")
  .option(
    "--seed <url>",
    "relay used to discover the network (repeatable)",
    collectRepeated,
    [] as string[],
  )
  .action(async (options: { seed: string[] }) => {
    const globalOptions = program.opts<GlobalOptions>();
    const fetchImpl = transport();
    const seeds = (options.seed.length > 0 ? options.seed : defaultSeeds()).map(
      parseSeed,
    );

    const relays = await discoverRelays({
      seeds,
      ...discoveryScope(seeds),
      ...(fetchImpl ? { fetchImpl } : {}),
    });
    const operators = new Set(relays.map((relay) => operatorHint(relay.url)));
    const mixes = relays.filter((relay) => relay.mixPublicKey);
    const mixOperators = new Set(mixes.map((relay) => operatorHint(relay.url)));

    if (globalOptions.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            relays: relays.length,
            operators: operators.size,
            mixNodes: mixes.length,
            mixOperators: mixOperators.size,
          },
          null,
          2,
        )}
`,
      );
      return;
    }

    process.stdout.write(`Relays reachable      ${relays.length}\n`);
    process.stdout.write(`Apparent operators    ${operators.size}\n`);
    process.stdout.write(`Mix nodes             ${mixes.length}\n`);
    process.stdout.write(`Mix operators         ${mixOperators.size}\n\n`);

    // The number people actually want is the anonymity set: how many senders a
    // message could have come from. CAPSULE cannot report it, and the reason is
    // the point of the project: there are no accounts, no sessions and no
    // counters, so there is nothing to count. What is measurable is the
    // network's capacity to provide anonymity, which is an upper bound on it.
    process.stdout.write(
      "This measures the network, not your anonymity set.\n\n" +
        "The anonymity set is how many people a message could have come from,\n" +
        "and CAPSULE cannot measure it: there are no accounts and no counters,\n" +
        "so there is nobody to count. What is above is the ceiling, not the\n" +
        "number. With few operators the ceiling is low whatever the traffic is.\n",
    );
    if (mixOperators.size < 3) {
      process.stderr.write(
        `\nWith ${mixOperators.size} mix operator(s), a path can be watched end to end by one party.\n`,
      );
    }
  });

program
  .command("send")
  .alias("create")
  .description("Encrypt and upload a file")
  .argument("<file>", "path to the file")
  .option(
    "--relay <url>",
    "relay base URL; defaults to the bridge when --bridge is given",
    defaultRelayUrl(),
  )
  .option(
    "--app <url>",
    "public application URL",
    process.env.CAPSULE_APP_URL ?? "http://localhost:5173/",
  )
  .option(
    "--ttl <duration>",
    "expiration such as 1h, 24h, 7d, or never for no expiry",
    "24h",
  )
  .option("--note <text>", "private note stored inside the encrypted manifest")
  .option(
    "--anonymous",
    "enable every anonymisation option: padding, metadata scrubbing, neutral filename and jitter",
  )
  .option(
    "--pad",
    "pad the capsule to a size class so the relay cannot read its exact size",
  )
  .option("--scrub", "remove embedded metadata from the file before encrypting")
  .option(
    "--hide-name",
    "replace the filename and mime type with neutral values",
  )
  .option(
    "--jitter <ms>",
    "upper bound of a random delay between chunk uploads",
  )
  .option(
    "--mirror <count>",
    "also store the capsule on this many relays discovered in the network",
  )
  .option(
    "--mirror-relay <url>",
    "store a copy on this specific relay (repeatable)",
    collectRepeated,
    [] as string[],
  )
  .option(
    "--shards <k>",
    "split the capsule so any k of the relays can rebuild it and fewer cannot",
  )
  .option(
    "--seed <url>",
    "relay used to discover the network, optionally url#relayId (repeatable)",
    collectRepeated,
    [] as string[],
  )
  .option(
    "--resume <path>",
    "store a resume ticket at this path, and continue from it if it exists",
  )
  .action(
    async (
      file: string,
      commandOptions: {
        relay: string;
        app: string;
        ttl: string;
        note?: string;
        anonymous?: boolean;
        pad?: boolean;
        scrub?: boolean;
        hideName?: boolean;
        jitter?: string;
        mirror?: string;
        mirrorRelay: string[];
        shards?: string;
        seed: string[];
        resume?: string;
      },
    ) => {
      commandOptions.relay = defaultRelay(commandOptions.relay);
      const absolutePath = resolve(file);
      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile())
        throw new Error("The selected path is not a file");
      const fileBlob = await openAsBlob(absolutePath);
      const globalOptions = program.opts<GlobalOptions>();
      const fetchImpl = transport();
      const ttlSeconds = parseTtl(commandOptions.ttl);

      const anonymity: CapsuleAnonymityOptions = {
        padding:
          commandOptions.anonymous === true || commandOptions.pad === true,
        scrubMetadata:
          commandOptions.anonymous === true || commandOptions.scrub === true,
        hideFilename:
          commandOptions.anonymous === true || commandOptions.hideName === true,
        jitterMs: commandOptions.jitter
          ? Number(commandOptions.jitter)
          : commandOptions.anonymous
            ? 750
            : 0,
      };
      if (
        !Number.isFinite(anonymity.jitterMs ?? 0) ||
        (anonymity.jitterMs ?? 0) < 0
      ) {
        throw new Error(
          "--jitter must be a non-negative number of milliseconds",
        );
      }

      const existingTicket = commandOptions.resume
        ? await readTicket(commandOptions.resume)
        : undefined;
      if (existingTicket) {
        if (!globalOptions.json) {
          process.stderr.write(
            `Continuing the upload described by ${commandOptions.resume}\n`,
          );
        }
        const finished = await resumeUpload(existingTicket, fileBlob, {
          appUrl: commandOptions.app,
          anonymity,
          ...(fetchImpl ? { fetchImpl } : {}),
          ...retryPolicy(),
          ...progressReporter("Uploading", ["uploading", "complete"]),
        });
        if (commandOptions.resume) {
          await rm(commandOptions.resume, { force: true });
        }
        printUpload(finished, anonymity, globalOptions.json === true);
        return;
      }

      const mirrorRelayUrls = [...commandOptions.mirrorRelay];
      const requestedMirrors = commandOptions.mirror
        ? Number(commandOptions.mirror)
        : 0;
      if (!Number.isSafeInteger(requestedMirrors) || requestedMirrors < 0) {
        throw new Error("--mirror must be a non-negative integer");
      }
      if (requestedMirrors > 0) {
        const seeds =
          commandOptions.seed.length > 0
            ? commandOptions.seed.map(parseSeed)
            : [commandOptions.relay];
        const network = await discoverRelays({
          seeds,
          ...discoveryScope(seeds),
          ...(fetchImpl ? { fetchImpl } : {}),
        });
        const chosen = selectRelays(network, {
          count: requestedMirrors,
          ciphertextBytes: fileStat.size + 1024 * 1024,
          chunkCount: Math.max(1, Math.ceil(fileStat.size / (1024 * 1024))),
          persistent: ttlSeconds === null,
          ...(ttlSeconds !== null ? { ttlSeconds } : {}),
          exclude: [commandOptions.relay, ...mirrorRelayUrls],
        });
        mirrorRelayUrls.push(...chosen.map((relay) => relay.url));
        if (!globalOptions.json && chosen.length < requestedMirrors) {
          process.stderr.write(
            `Only ${chosen.length} of ${requestedMirrors} mirrors were available in the network.\n`,
          );
        }
      }

      const dataShards = commandOptions.shards
        ? Number(commandOptions.shards)
        : undefined;
      if (dataShards !== undefined) {
        if (!Number.isSafeInteger(dataShards) || dataShards < 2) {
          throw new Error("--shards must be an integer of at least 2");
        }
        if (mirrorRelayUrls.length + 1 <= dataShards) {
          throw new Error(
            `Splitting into ${dataShards} needs more relays: add --mirror or --mirror-relay`,
          );
        }
      }

      const mixNetwork = globalOptions.mix
        ? await openMixNetwork(
            commandOptions.seed.length > 0
              ? commandOptions.seed.map(parseSeed)
              : [commandOptions.relay],
          )
        : undefined;

      const uploaded = await uploadCapsule({
        data: fileBlob,
        filename: basename(absolutePath),
        mimeType: "application/octet-stream",
        ...(commandOptions.note ? { note: commandOptions.note } : {}),
        ttlSeconds,
        relayUrl: commandOptions.relay,
        appUrl: commandOptions.app,
        anonymity,
        ...(mirrorRelayUrls.length > 0 ? { mirrorRelayUrls } : {}),
        ...(dataShards !== undefined
          ? { replication: { mode: "shards" as const, dataShards } }
          : {}),
        ...relayTransport(mixNetwork),
        // A chunk has to fit one packet, and every packet on the network is
        // the same size whatever it carries.
        ...(mixNetwork ? { chunkSize: MIX_CHUNK_SIZE } : {}),
        ...(fetchImpl ? { fetchImpl } : {}),
        ...retryPolicy(),
        ...(commandOptions.resume
          ? {
              onTicket: async (ticket: UploadTicket) => {
                await writeFile(
                  commandOptions.resume as string,
                  `${JSON.stringify(ticket, null, 2)}\n`,
                  { mode: 0o600 },
                );
              },
            }
          : {}),
        ...progressReporter("Uploading", ["uploading", "complete"]),
      });
      if (commandOptions.resume) {
        await rm(commandOptions.resume, { force: true });
      }
      printUpload(uploaded, anonymity, globalOptions.json === true);
    },
  );

function printUpload(
  uploaded: Awaited<ReturnType<typeof uploadCapsule>>,
  anonymity: CapsuleAnonymityOptions,
  asJson: boolean,
): void {
  const ownerCapability = encodeOwnerCapability(uploaded.ownerCapability);
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          shareUrl: uploaded.shareUrl,
          ownerCapability,
          expiresAt: uploaded.metadata.expiresAt,
          relays: uploaded.relayUrls,
          mirrorFailures: uploaded.mirrorFailures,
          anonymity: uploaded.anonymity,
          ...(uploaded.sharding ? { sharding: uploaded.sharding } : {}),
        },
        null,
        2,
      ),
    );
    return;
  }

  process.stderr.write("\n");
  console.log(`Share URL:\n${uploaded.shareUrl}\n`);
  console.log(`Deletion capability (keep private):\n${ownerCapability}\n`);
  console.log(
    `Expires: ${uploaded.metadata.expiresAt ?? "never (stored until you delete it)"}`,
  );
  console.log(`Stored on: ${uploaded.relayUrls.join(", ")}`);
  if (uploaded.sharding) {
    console.log(
      `Split ${uploaded.sharding.k} of ${uploaded.sharding.n}: no single relay holds enough to rebuild it`,
    );
  }
  for (const failure of uploaded.mirrorFailures) {
    console.log(`Mirror unavailable: ${failure.relayUrl} (${failure.reason})`);
  }
  const report = uploaded.anonymity;
  if (report.padded) {
    console.log(
      `Padding: ${humanBytes(report.paddingBytes)} added so the relay sees a size class, not the file size`,
    );
  }
  if (report.removedMetadata.length > 0) {
    console.log(`Metadata removed: ${report.removedMetadata.join(", ")}`);
  } else if (anonymity.scrubMetadata && !report.metadataScrubbed) {
    console.log(
      "Metadata scrubbing: this format is not supported yet; the file was sent unchanged.",
    );
  }
  for (const entry of report.remainingMetadata) {
    console.log(`Metadata still present: ${entry}`);
  }
  if (report.filenameHidden) {
    console.log(`Filename replaced with: ${uploaded.metadata.filename}`);
  }
}

program
  .command("receive")
  .aliases(["get", "download"])
  .description("Download and decrypt a capsule")
  .argument("<share-url>", "CAPSULE share URL or #capsule fragment")
  .option("--out <path>", "destination file or directory", ".")
  .option("--force", "overwrite an existing destination")
  .action(
    async (
      shareUrl: string,
      commandOptions: { out: string; force?: boolean },
    ) => {
      const capability = decodeShareCapability(extractFragment(shareUrl));
      const globalOptions = program.opts<GlobalOptions>();
      const fetchImpl = transport();
      const mixNetwork = globalOptions.mix
        ? await openMixNetwork([capability.relayUrl])
        : undefined;
      const downloaded = await downloadCapsule({
        capability,
        ...relayTransport(mixNetwork),
        ...(fetchImpl ? { fetchImpl } : {}),
        ...retryPolicy(),
        ...progressReporter("Receiving", ["decrypting", "complete"]),
      });
      if (!globalOptions.json) process.stderr.write("\n");

      const output = await resolveOutput(
        commandOptions.out,
        downloaded.metadata.filename,
      );
      if (!commandOptions.force && (await exists(output))) {
        throw new Error(
          `Destination already exists: ${output}. Pass --force to replace it.`,
        );
      }
      await mkdir(dirname(output), { recursive: true });
      await streamBlobToFile(downloaded.blob, output);

      if (globalOptions.json) {
        console.log(
          JSON.stringify(
            {
              output,
              metadata: downloaded.metadata,
              relays: downloaded.relayUrls,
            },
            null,
            2,
          ),
        );
      } else {
        console.log(
          `Saved ${humanBytes(downloaded.metadata.byteLength)} to ${output}`,
        );
        console.log(`Read from: ${downloaded.relayUrls.join(", ")}`);
        if (downloaded.metadata.note)
          console.log(`Private note: ${downloaded.metadata.note}`);
      }
    },
  );

program
  .command("delete")
  .description("Delete a capsule from every relay that stores it")
  .argument(
    "<owner-capability>",
    "private owner capability printed by capsule send",
  )
  .action(async (encodedCapability: string) => {
    const capability = decodeOwnerCapability(encodedCapability);
    const fetchImpl = transport();
    const mixNetwork = program.opts<GlobalOptions>().mix
      ? await openMixNetwork([capability.relayUrl])
      : undefined;
    const result = await deleteCapsule(capability, {
      ...relayTransport(mixNetwork),
      ...(fetchImpl ? { fetchImpl } : {}),
      ...retryPolicy(),
    });
    if (program.opts<GlobalOptions>().json) {
      console.log(
        JSON.stringify(
          { deleted: result.deleted, failed: result.failed },
          null,
          2,
        ),
      );
      return;
    }
    console.log(`Capsule deleted from: ${result.deleted.join(", ")}`);
    for (const failure of result.failed) {
      console.log(
        `Not confirmed by ${failure.relayUrl}: ${failure.reason}. The copy may still exist there.`,
      );
    }
  });

program
  .command("status")
  .description("Read relay status using a share URL")
  .argument("<share-url>", "CAPSULE share URL or #capsule fragment")
  .action(async (shareUrl: string) => {
    const capability = decodeShareCapability(extractFragment(shareUrl));
    const fetchImpl = transport();
    const client = new CapsuleRelayClient(capability.relayUrl, {
      ...(fetchImpl ? { fetchImpl } : {}),
      ...retryPolicy(),
    });
    const status = await client.status(
      capability.capsuleId,
      capability.readToken,
    );
    console.log(JSON.stringify(status, null, 2));
  });

program
  .command("relays")
  .description("Discover the relays reachable from a seed relay")
  .option(
    "--seed <url>",
    "relay used to bootstrap discovery, optionally url#relayId (repeatable)",
    collectRepeated,
    [] as string[],
  )
  .option("--max <count>", "maximum number of relays to list", "24")
  .action(async (commandOptions: { seed: string[]; max: string }) => {
    const seeds =
      commandOptions.seed.length > 0
        ? commandOptions.seed.map(parseSeed)
        : defaultSeeds();
    const maxRelays = Number(commandOptions.max);
    if (!Number.isSafeInteger(maxRelays) || maxRelays <= 0) {
      throw new Error("--max must be a positive integer");
    }
    const fetchImpl = transport();
    const relays = await discoverRelays({
      seeds,
      maxRelays,
      ...discoveryScope(seeds),
      ...(fetchImpl ? { fetchImpl } : {}),
    });

    if (program.opts<GlobalOptions>().json) {
      console.log(JSON.stringify({ relays }, null, 2));
      return;
    }
    if (relays.length === 0) {
      console.log(
        "No relay answered. Check the seed URL, or start your own with CAPSULE_PUBLIC_URL set.",
      );
      return;
    }
    console.log(`${relays.length} relay(s) reachable:\n`);
    for (const relay of relays) {
      console.log(describeRelay(relay));
    }
  });

program
  .command("protect")
  .description("Wrap a capability under a passphrase so it can be stored")
  .argument("<capability>", "share URL, fragment or owner capability")
  .option("--label <text>", "a label to tell recovery blobs apart")
  .option(
    "--passphrase <text>",
    "passphrase (leaves it in shell history; prefer the prompt or CAPSULE_PASSPHRASE)",
  )
  .action(
    async (
      capability: string,
      commandOptions: { label?: string; passphrase?: string },
    ) => {
      const passphrase = await readPassphrase(commandOptions.passphrase, {
        confirm: true,
      });
      const blob = await wrapWithPassphrase(capability.trim(), passphrase, {
        ...(commandOptions.label ? { label: commandOptions.label } : {}),
      });
      if (program.opts<GlobalOptions>().json) {
        console.log(JSON.stringify({ recovery: blob }, null, 2));
        return;
      }
      console.log(blob);
      console.log(
        "\nStore this anywhere you like. Without the passphrase it is useless; without it and without the original capability, so is the capsule.",
      );
    },
  );

program
  .command("reveal")
  .description("Unwrap a capability protected with capsule protect")
  .argument("<recovery-blob>", "the capsule-recovery: string")
  .option("--passphrase <text>", "passphrase (prefer the prompt)")
  .action(async (blob: string, commandOptions: { passphrase?: string }) => {
    const passphrase = await readPassphrase(commandOptions.passphrase);
    const capability = await unwrapWithPassphrase(blob.trim(), passphrase);
    if (program.opts<GlobalOptions>().json) {
      console.log(JSON.stringify({ capability }, null, 2));
      return;
    }
    console.log(capability);
  });

program
  .command("split")
  .description("Split a capability into shares, any k of which rebuild it")
  .argument("<capability>", "share URL, fragment or owner capability")
  .requiredOption("--threshold <k>", "shares needed to rebuild")
  .requiredOption("--shares <n>", "shares to produce")
  .action(
    async (
      capability: string,
      commandOptions: { threshold: string; shares: string },
    ) => {
      const threshold = Number(commandOptions.threshold);
      const shares = Number(commandOptions.shares);
      const encoded = splitSecret(
        new TextEncoder().encode(capability.trim()),
        threshold,
        shares,
      ).map(encodeShare);

      if (program.opts<GlobalOptions>().json) {
        console.log(JSON.stringify({ threshold, shares: encoded }, null, 2));
        return;
      }
      console.log(
        `${shares} shares, any ${threshold} of which rebuild the capability:\n`,
      );
      for (const [index, share] of encoded.entries()) {
        console.log(`${index + 1}. ${share}\n`);
      }
      console.log(
        `Give them to different people or devices. ${threshold - 1} of them together still reveal nothing.`,
      );
    },
  );

program
  .command("combine")
  .description("Rebuild a capability from its shares")
  .argument("<shares...>", "at least the threshold number of shares")
  .action(async (shares: string[]) => {
    const secret = combineShares(shares.map((share) => decodeShare(share)));
    const capability = new TextDecoder().decode(secret);
    if (program.opts<GlobalOptions>().json) {
      console.log(JSON.stringify({ capability }, null, 2));
      return;
    }
    console.log(capability);
  });

function describeRelay(relay: RelayInfo): string {
  const lines = [
    `${relay.nickname ?? "unnamed relay"}  ${relay.url}`,
    `  id ${relay.relayId.slice(0, 12)}…  peers ${relay.peerCount}  software ${relay.software ?? "unknown"}`,
    `  max capsule ${humanBytes(relay.limits.maxCapsuleBytes)}  max ttl ${Math.round(relay.maxTtlSeconds / 3600)}h  without expiry: ${relay.persistentCapsules ? "yes" : "no"}`,
  ];
  return `${lines.join("\n")}\n`;
}

function extractFragment(value: string): string {
  if (value.startsWith("#capsule=")) return value;
  if (value.startsWith("capsule=")) return `#${value}`;
  const url = new URL(value);
  if (!url.hash)
    throw new Error("The share URL does not contain a CAPSULE capability");
  return url.hash;
}

async function resolveOutput(
  outputOption: string,
  filename: string,
): Promise<string> {
  const output = resolve(outputOption);
  try {
    const outputStat = await stat(output);
    if (outputStat.isDirectory()) return resolve(output, basename(filename));
    return output;
  } catch {
    if (outputOption.endsWith("/") || outputOption.endsWith("\\")) {
      return resolve(output, basename(filename));
    }
    return outputOption === "." ? resolve(output, basename(filename)) : output;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function streamBlobToFile(blob: Blob, path: string): Promise<void> {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const output = createWriteStream(path, { flags: "w" });
    Readable.fromWeb(blob.stream() as never).pipe(output);
    output.on("finish", resolvePromise);
    output.on("error", rejectPromise);
  });
}

program.parseAsync().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (program.opts<GlobalOptions>().json) {
    console.error(JSON.stringify({ error: message }));
  } else {
    console.error(`CAPSULE error: ${message}`);
  }
  process.exitCode = 1;
});
