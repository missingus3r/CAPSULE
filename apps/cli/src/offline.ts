import { openAsBlob } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { discoverLanRelays } from "@capsule/lan";
import {
  openOfflineCapsuleFile,
  packOfflineCapsuleFile,
  type CapsuleAnonymityOptions,
} from "@capsule/sdk";
import type { Command } from "commander";
import { humanBytes } from "./options.js";

/**
 * `capsule offline` and `capsule lan` — the two commands that work when there
 * is no internet.
 *
 * `offline` removes the network entirely: a file is encrypted into one object
 * that travels on a memory stick or across an air gap. `lan` keeps a network
 * but removes everything outside the room: no DNS, no seed list, no relay
 * anybody published.
 */

export interface OfflineCommandContext {
  json: () => boolean;
}

export function registerOfflineCommands(
  program: Command,
  context: OfflineCommandContext,
): void {
  const offline = program
    .command("offline")
    .description("Make and open capsules with no network at all");

  offline
    .command("pack")
    .description("Encrypt a file into one object you can carry")
    .argument("<file>", "path to the file")
    .option("--out <path>", "where to write the capsule")
    .option(
      "--note <text>",
      "private note stored inside the encrypted manifest",
    )
    .option(
      "--with-key",
      "put the key inside the file so it opens on its own; anyone who finds the file can then read it",
    )
    .option("--anonymous", "pad the size, scrub metadata and hide the filename")
    .option("--pad", "pad to a size class")
    .option("--scrub", "remove embedded metadata before encrypting")
    .option("--hide-name", "replace the filename and mime type")
    .action(
      async (
        file: string,
        options: {
          out?: string;
          note?: string;
          withKey?: boolean;
          anonymous?: boolean;
          pad?: boolean;
          scrub?: boolean;
          hideName?: boolean;
        },
      ) => {
        const absolute = resolve(file);
        const info = await stat(absolute);
        if (!info.isFile()) throw new Error("The selected path is not a file");

        const anonymity: CapsuleAnonymityOptions = {
          padding: options.anonymous === true || options.pad === true,
          scrubMetadata: options.anonymous === true || options.scrub === true,
          hideFilename: options.anonymous === true || options.hideName === true,
        };

        const packed = await packOfflineCapsuleFile({
          data: await openAsBlob(absolute),
          filename: basename(absolute),
          anonymity,
          ...(options.note ? { note: options.note } : {}),
          ...(options.withKey ? { includeKey: true } : {}),
        });

        const output = resolve(options.out ?? `${absolute}.capsuleoff`);
        await writeFile(output, packed.bytes);

        if (context.json()) {
          process.stdout.write(
            `${JSON.stringify(
              {
                file: output,
                bytes: packed.bytes.byteLength,
                sealed: packed.sealed,
                capability: packed.capability ?? null,
                anonymity: packed.anonymity,
              },
              null,
              2,
            )}\n`,
          );
          return;
        }

        process.stdout.write(
          `Wrote ${output} (${humanBytes(packed.bytes.byteLength)})\n`,
        );
        if (packed.anonymity.removedMetadata.length > 0) {
          process.stdout.write(
            `Removed: ${packed.anonymity.removedMetadata.join(", ")}\n`,
          );
        }
        if (packed.anonymity.remainingMetadata.length > 0) {
          process.stderr.write(
            `Could not remove: ${packed.anonymity.remainingMetadata.join(", ")}\n`,
          );
        }
        if (packed.capability) {
          process.stdout.write(
            `\nThe file is sealed. It holds ciphertext and nothing that opens it.\nSend this key by a different route than the file:\n\n  ${packed.capability}\n\n`,
          );
        } else {
          process.stderr.write(
            "\nThe key is inside this file. Anyone who gets the file can read it.\n",
          );
        }
      },
    );

  offline
    .command("open")
    .description("Open a capsule that was carried rather than sent")
    .argument("<file>", "path to the .capsuleoff file")
    .option("--key <capability>", "the capsule-offline: key, for a sealed file")
    .option("--out <directory>", "where to write the result", ".")
    .action(async (file: string, options: { key?: string; out: string }) => {
      const bytes = new Uint8Array(await readFile(resolve(file)));
      const opened = await openOfflineCapsuleFile(bytes, options.key);

      const directory = resolve(options.out);
      await mkdir(directory, { recursive: true });
      const target = join(directory, basename(opened.metadata.filename));
      await writeFile(target, new Uint8Array(await opened.blob.arrayBuffer()));

      if (context.json()) {
        process.stdout.write(
          `${JSON.stringify({ file: target, metadata: opened.metadata }, null, 2)}\n`,
        );
        return;
      }
      process.stdout.write(
        `Saved ${humanBytes(opened.metadata.byteLength)} to ${target}\n`,
      );
      if (opened.metadata.note) {
        process.stdout.write(`Note: ${opened.metadata.note}\n`);
      }
    });

  program
    .command("lan")
    .description("Find relays on this network, with no internet and no DNS")
    .option("--wait <ms>", "how long to listen", "3000")
    .action(async (options: { wait: string }) => {
      const timeoutMs = Number(options.wait);
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        throw new Error("--wait must be a positive number of milliseconds");
      }
      const found = await discoverLanRelays({ timeoutMs });

      if (context.json()) {
        process.stdout.write(`${JSON.stringify(found, null, 2)}\n`);
        return;
      }
      if (found.length === 0) {
        process.stdout.write(
          "No relay answered on this network.\nA relay announces itself only when it is started with CAPSULE_LAN=true.\n",
        );
        return;
      }
      for (const relay of found) {
        const traits = [
          relay.sites ? "sites" : undefined,
          relay.mix ? "mix" : undefined,
        ].filter(Boolean);
        process.stdout.write(
          `${relay.url}  ${relay.relayId.slice(0, 12)}…  ${traits.join(", ") || "storage only"}\n`,
        );
      }
      process.stdout.write(
        `\nNothing here was authenticated: a beacon is an unsigned message from\nsomebody on this network. What protects the file is that it was already\nencrypted before it went anywhere.\n`,
      );
    });
}
