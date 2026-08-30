import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  isSafeSitePath,
  siteContentType,
  type SiteFile,
} from "@capsule/protocol";
import {
  announceSiteRecord,
  createSiteIdentity,
  discoverRelays,
  fetchSiteBundle,
  loadSiteIdentity,
  publishSite,
  resolveSite,
  selectRelays,
  type FetchLike,
  type RelaySeed,
  type SiteIdentity,
  type SiteIdentityFile,
  type TransferProgress,
} from "@capsule/sdk";
import type { Command } from "commander";
import { collectRepeated, humanBytes, parseTtl } from "./options.js";

/**
 * `capsule site` — publishing a website whose name is its own key.
 *
 * Everything here is a thin layer over what capsules already do. The site is
 * packed into one capsule; the name is an Ed25519 public key; the record tying
 * the two together is signed by that key and handed to relays. There is no
 * registrar, no certificate authority and nothing to renew.
 */

export interface SiteCommandContext {
  json: () => boolean;
  transport: () => FetchLike | undefined;
  retryPolicy: () => { retry: { attempts: number } };
  progressReporter: (
    label: string,
    phases: TransferProgress["phase"][],
  ) =>
    | { onProgress: (progress: TransferProgress) => void }
    | Record<string, never>;
  parseSeed: (value: string) => RelaySeed;
  discoveryScope: (seeds: RelaySeed[]) => { allowPrivateRelays?: boolean };
}

const MAX_SITE_FILES = 4096;
/** Files above this are refused with an explanation rather than a stack trace. */
const MAX_SITE_BYTES = 64 * 1024 * 1024;

async function collectFiles(root: string): Promise<SiteFile[]> {
  const files: SiteFile[] = [];
  let total = 0;

  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      // Symlinks are not followed: a site is what is inside the directory, and
      // a link pointing at ~/.ssh would otherwise be published to the world.
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        await walk(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      if (entry.name.startsWith(".")) continue;

      const path = relative(root, absolute).split(sep).join("/");
      if (!isSafeSitePath(path)) continue;
      if (files.length >= MAX_SITE_FILES) {
        throw new Error(`A site holds at most ${MAX_SITE_FILES} files`);
      }
      const bytes = new Uint8Array(await readFile(absolute));
      total += bytes.byteLength;
      if (total > MAX_SITE_BYTES) {
        throw new Error(
          `This site is larger than ${humanBytes(MAX_SITE_BYTES)}; publish a smaller one or raise the limit on your relay`,
        );
      }
      files.push({ path, type: siteContentType(path), bytes });
    }
  };

  await walk(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

async function readIdentity(path: string): Promise<SiteIdentity> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as SiteIdentityFile;
  return loadSiteIdentity(parsed);
}

/** Relays worth asking about a name: the one given, plus what it knows of. */
async function relayPool(
  context: SiteCommandContext,
  seeds: string[],
  fallback: string,
  limit = 12,
): Promise<string[]> {
  const parsed = (seeds.length > 0 ? seeds : [fallback]).map(context.parseSeed);
  const fetchImpl = context.transport();
  const relays = await discoverRelays({
    seeds: parsed,
    ...context.discoveryScope(parsed),
    ...(fetchImpl ? { fetchImpl } : {}),
  }).catch(() => []);
  const urls = [fallback, ...relays.map((relay) => relay.url)];
  return [...new Set(urls)].slice(0, limit);
}

/** Relays that can hold a copy of the bundle, chosen for operator diversity. */
async function mirrorPool(
  context: SiteCommandContext,
  seeds: string[],
  primary: string,
  count: number,
  bundleBytes: number,
  ttlSeconds: number | null,
): Promise<string[]> {
  if (count === 0) return [];
  const parsed = (seeds.length > 0 ? seeds : [primary]).map(context.parseSeed);
  const fetchImpl = context.transport();
  const relays = await discoverRelays({
    seeds: parsed,
    ...context.discoveryScope(parsed),
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  return selectRelays(relays, {
    count,
    ciphertextBytes: bundleBytes + 1024 * 1024,
    chunkCount: Math.max(1, Math.ceil(bundleBytes / (1024 * 1024))),
    persistent: ttlSeconds === null,
    ...(ttlSeconds !== null ? { ttlSeconds } : {}),
    exclude: [primary],
    preferDiverse: true,
  }).map((relay) => relay.url);
}

export function registerSiteCommands(
  program: Command,
  context: SiteCommandContext,
): void {
  const site = program
    .command("site")
    .description("Publish and read websites with a .capsule name");

  site
    .command("key")
    .description("Create a new .capsule name and write its key to a file")
    .option("--out <path>", "where to write the key file", "site.capsulekey")
    .action(async (options: { out: string }) => {
      const { file } = await createSiteIdentity();
      await writeFile(resolve(options.out), JSON.stringify(file, null, 2), {
        mode: 0o600,
      });
      if (context.json()) {
        process.stdout.write(
          `${JSON.stringify({ name: file.name, keyFile: resolve(options.out) }, null, 2)}\n`,
        );
        return;
      }
      process.stdout.write(`Name: ${file.name}\n`);
      process.stdout.write(`Key:  ${resolve(options.out)}\n\n`);
      process.stdout.write(
        "This file is the site. Anyone who copies it can replace your pages,\nand losing it loses the name for good: there is no recovery, because\nthere is nobody to ask.\n",
      );
    });

  site
    .command("publish")
    .description("Pack a directory into a capsule and announce it under a name")
    .argument("<directory>", "directory containing index.html")
    .requiredOption(
      "--key <path>",
      "site key file created by `capsule site key`",
    )
    .option(
      "--relay <url>",
      "relay that stores the site",
      process.env.CAPSULE_RELAY_URL ?? "http://localhost:8787",
    )
    .option(
      "--ttl <duration>",
      "how long the relay keeps the site, or never for no expiry",
      "30d",
    )
    .option("--title <text>", "short label shown while the site loads")
    .option("--sequence <n>", "version number; defaults to the next one")
    .option(
      "--announce <url>",
      "extra relay to announce the record to (repeatable)",
      collectRepeated,
      [] as string[],
    )
    .option(
      "--mirror <count>",
      "also store the site on this many relays from the network",
    )
    .option(
      "--seed <url>",
      "relay used to discover the network (repeatable)",
      collectRepeated,
      [] as string[],
    )
    .action(
      async (
        directory: string,
        options: {
          key: string;
          relay: string;
          ttl: string;
          title?: string;
          sequence?: string;
          announce: string[];
          mirror?: string;
          seed: string[];
        },
      ) => {
        const root = resolve(directory);
        const info = await stat(root);
        if (!info.isDirectory()) {
          throw new Error("A site is published from a directory");
        }
        const files = await collectFiles(root);
        if (!files.some((file) => file.path === "index.html")) {
          throw new Error(`${root} has no index.html at its root`);
        }

        const identity = await readIdentity(resolve(options.key));
        const fetchImpl = context.transport();
        const ttlSeconds = parseTtl(options.ttl);

        const mirrorCount = options.mirror ? Number(options.mirror) : 0;
        if (!Number.isSafeInteger(mirrorCount) || mirrorCount < 0) {
          throw new Error("--mirror must be a non-negative integer");
        }
        const bundleBytes = files.reduce(
          (total, file) => total + file.bytes.byteLength,
          0,
        );
        const pool = await relayPool(context, options.seed, options.relay);
        const mirrors = await mirrorPool(
          context,
          options.seed,
          options.relay,
          mirrorCount,
          bundleBytes,
          ttlSeconds,
        );

        // A name that has been published before must move forward, or relays
        // keep the old record and the update silently does nothing.
        let sequence = options.sequence ? Number(options.sequence) : undefined;
        if (sequence === undefined) {
          const existing = await resolveSite(identity.name, pool, {
            ...(fetchImpl ? { fetchImpl } : {}),
          }).catch(() => undefined);
          sequence = existing ? existing.record.sequence + 1 : 1;
        }
        if (!Number.isSafeInteger(sequence) || sequence < 0) {
          throw new Error("--sequence must be a non-negative integer");
        }

        const published = await publishSite({
          identity,
          files,
          relayUrl: options.relay,
          ttlSeconds,
          sequence,
          announceTo: [...new Set([...pool, ...options.announce])],
          ...(mirrors.length > 0 ? { mirrorRelayUrls: mirrors } : {}),
          ...(options.title ? { title: options.title } : {}),
          ...(fetchImpl ? { fetchImpl } : {}),
          ...context.retryPolicy(),
          ...context.progressReporter("Publishing", ["uploading", "complete"]),
        });

        if (context.json()) {
          process.stdout.write(
            `${JSON.stringify(
              {
                name: published.name,
                sequence: published.record.sequence,
                bundleBytes: published.bundleBytes,
                files: files.length,
                relayUrls: published.relayUrls,
                announcedTo: published.announcedTo,
                announceFailures: published.announceFailures,
              },
              null,
              2,
            )}\n`,
          );
          return;
        }

        process.stderr.write("\n");
        process.stdout.write(
          `Published ${files.length} files (${humanBytes(published.bundleBytes)})\n`,
        );
        process.stdout.write(`Name:     http://${published.name}/\n`);
        process.stdout.write(`Sequence: ${published.record.sequence}\n`);
        process.stdout.write(`Stored:   ${published.relayUrls.join(", ")}\n`);
        process.stdout.write(
          `Resolves: ${published.announcedTo.length} relay(s)\n`,
        );
        for (const failure of published.announceFailures) {
          process.stderr.write(
            `Could not announce to ${failure.relayUrl}: ${failure.reason}\n`,
          );
        }
        if (published.announcedTo.length === 0) {
          process.stderr.write(
            "No relay accepted the record, so nothing can resolve this name yet.\n",
          );
        }
        process.stdout.write(
          "\nInstall the CAPSULE browser extension to open that address.\n",
        );
      },
    );

  site
    .command("resolve")
    .description("Look up a .capsule name and show the record relays hold")
    .argument("<name>", "a .capsule name")
    .option(
      "--relay <url>",
      "relay to ask first",
      process.env.CAPSULE_RELAY_URL ?? "http://localhost:8787",
    )
    .option(
      "--seed <url>",
      "relay used to discover the network (repeatable)",
      collectRepeated,
      [] as string[],
    )
    .action(
      async (name: string, options: { relay: string; seed: string[] }) => {
        const fetchImpl = context.transport();
        const pool = await relayPool(context, options.seed, options.relay);
        const resolved = await resolveSite(name, pool, {
          ...(fetchImpl ? { fetchImpl } : {}),
        });
        if (!resolved) {
          throw new Error(
            `No relay in reach holds a record for ${name}. It may not exist, or the relays you asked have not heard of it yet.`,
          );
        }
        if (context.json()) {
          process.stdout.write(
            `${JSON.stringify({ record: resolved.record, seenAt: resolved.seenAt }, null, 2)}\n`,
          );
          return;
        }
        process.stdout.write(`Name:      ${resolved.record.name}\n`);
        if (resolved.record.title) {
          process.stdout.write(`Title:     ${resolved.record.title}\n`);
        }
        process.stdout.write(`Sequence:  ${resolved.record.sequence}\n`);
        process.stdout.write(`Published: ${resolved.record.publishedAt}\n`);
        process.stdout.write(`Stored on: ${resolved.capability.relayUrl}\n`);
        process.stdout.write(`Seen at:   ${resolved.seenAt.join(", ")}\n`);
      },
    );

  site
    .command("get")
    .description("Download a .capsule site and write it to a directory")
    .argument("<name>", "a .capsule name")
    .requiredOption("--out <directory>", "where to write the files")
    .option(
      "--relay <url>",
      "relay to ask first",
      process.env.CAPSULE_RELAY_URL ?? "http://localhost:8787",
    )
    .option(
      "--seed <url>",
      "relay used to discover the network (repeatable)",
      collectRepeated,
      [] as string[],
    )
    .action(
      async (
        name: string,
        options: { out: string; relay: string; seed: string[] },
      ) => {
        const fetchImpl = context.transport();
        const pool = await relayPool(context, options.seed, options.relay);
        const resolved = await resolveSite(name, pool, {
          ...(fetchImpl ? { fetchImpl } : {}),
        });
        if (!resolved) throw new Error(`Could not resolve ${name}`);

        const bundle = await fetchSiteBundle(resolved.capability, {
          ...(fetchImpl ? { fetchImpl } : {}),
          ...context.retryPolicy(),
          ...context.progressReporter("Downloading", [
            "downloading",
            "complete",
          ]),
        });

        const outputRoot = resolve(options.out);
        const { mkdir } = await import("node:fs/promises");
        for (const file of bundle.files) {
          const target = join(outputRoot, ...file.path.split("/"));
          // Paths were validated on unpack; this is the second check, because
          // writing to disk is where a traversal would actually cost something.
          if (!target.startsWith(outputRoot + sep)) {
            throw new Error(`Refusing to write outside ${outputRoot}`);
          }
          await mkdir(join(target, ".."), { recursive: true });
          await writeFile(target, file.bytes);
        }
        if (!context.json()) process.stderr.write("\n");
        process.stdout.write(
          `${bundle.files.length} files written to ${outputRoot}\n`,
        );
      },
    );

  site
    .command("announce")
    .description("Re-announce a record you already published to more relays")
    .argument("<name>", "a .capsule name")
    .option(
      "--relay <url>",
      "relay that already holds the record",
      process.env.CAPSULE_RELAY_URL ?? "http://localhost:8787",
    )
    .option(
      "--seed <url>",
      "relay used to discover the network (repeatable)",
      collectRepeated,
      [] as string[],
    )
    .action(
      async (name: string, options: { relay: string; seed: string[] }) => {
        const fetchImpl = context.transport();
        const pool = await relayPool(context, options.seed, options.relay, 24);
        const resolved = await resolveSite(name, pool, {
          ...(fetchImpl ? { fetchImpl } : {}),
        });
        if (!resolved) throw new Error(`Could not resolve ${name}`);
        const { announcedTo, failures } = await announceSiteRecord(
          resolved.record,
          pool,
          { ...(fetchImpl ? { fetchImpl } : {}) },
        );
        process.stdout.write(
          `Announced to ${announcedTo.length} relay(s); ${failures.length} refused.\n`,
        );
      },
    );
}
