#!/usr/bin/env node

import { createWriteStream, openAsBlob } from "node:fs";
import { access, mkdir, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import {
  decodeOwnerCapability,
  decodeShareCapability,
  encodeOwnerCapability,
} from "@capsule/protocol";
import {
  CapsuleRelayClient,
  deleteCapsule,
  downloadCapsule,
  uploadCapsule,
} from "@capsule/sdk";
import { Command } from "commander";
import { humanBytes, parseTtl } from "./options.js";

interface GlobalOptions {
  json?: boolean;
}

const program = new Command();
program
  .name("capsule")
  .description("Send and receive private, temporary CAPSULE payloads")
  .version("0.1.0")
  .option("--json", "print machine-readable JSON");

program
  .command("send")
  .alias("create")
  .description("Encrypt and upload a file")
  .argument("<file>", "path to the file")
  .option(
    "--relay <url>",
    "relay base URL",
    process.env.CAPSULE_RELAY_URL ?? "http://localhost:8787",
  )
  .option(
    "--app <url>",
    "public application URL",
    process.env.CAPSULE_APP_URL ?? "http://localhost:5173/",
  )
  .option("--ttl <duration>", "expiration such as 1h, 24h or 7d", "24h")
  .option("--note <text>", "private note stored inside the encrypted manifest")
  .action(
    async (
      file: string,
      commandOptions: {
        relay: string;
        app: string;
        ttl: string;
        note?: string;
      },
    ) => {
      const absolutePath = resolve(file);
      const fileStat = await stat(absolutePath);
      if (!fileStat.isFile())
        throw new Error("The selected path is not a file");
      const fileBlob = await openAsBlob(absolutePath);
      const globalOptions = program.opts<GlobalOptions>();

      const uploaded = await uploadCapsule({
        data: fileBlob,
        filename: basename(absolutePath),
        mimeType: "application/octet-stream",
        ...(commandOptions.note ? { note: commandOptions.note } : {}),
        ttlSeconds: parseTtl(commandOptions.ttl),
        relayUrl: commandOptions.relay,
        appUrl: commandOptions.app,
        ...(globalOptions.json
          ? {}
          : {
              onProgress: (
                progress: import("@capsule/sdk").TransferProgress,
              ) => {
                if (
                  progress.phase === "uploading" ||
                  progress.phase === "complete"
                ) {
                  process.stderr.write(
                    `\r${progress.phase === "complete" ? "Complete" : "Uploading"}: ${humanBytes(progress.completedBytes)}/${humanBytes(progress.totalBytes)}   `,
                  );
                }
              },
            }),
      });
      if (!globalOptions.json) process.stderr.write("\n");
      const ownerCapability = encodeOwnerCapability(uploaded.ownerCapability);
      if (globalOptions.json) {
        console.log(
          JSON.stringify(
            {
              shareUrl: uploaded.shareUrl,
              ownerCapability,
              expiresAt: uploaded.metadata.expiresAt,
            },
            null,
            2,
          ),
        );
      } else {
        console.log(`Share URL:\n${uploaded.shareUrl}\n`);
        console.log(
          `Deletion capability (keep private):\n${ownerCapability}\n`,
        );
        console.log(`Expires: ${uploaded.metadata.expiresAt}`);
      }
    },
  );

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
      const downloaded = await downloadCapsule({
        capability,
        ...(globalOptions.json
          ? {}
          : {
              onProgress: (
                progress: import("@capsule/sdk").TransferProgress,
              ) => {
                if (
                  progress.phase === "decrypting" ||
                  progress.phase === "complete"
                ) {
                  process.stderr.write(
                    `\r${progress.phase === "complete" ? "Complete" : "Receiving"}: ${humanBytes(progress.completedBytes)}/${humanBytes(progress.totalBytes)}   `,
                  );
                }
              },
            }),
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
          JSON.stringify({ output, metadata: downloaded.metadata }, null, 2),
        );
      } else {
        console.log(
          `Saved ${humanBytes(downloaded.metadata.byteLength)} to ${output}`,
        );
        if (downloaded.metadata.note)
          console.log(`Private note: ${downloaded.metadata.note}`);
      }
    },
  );

program
  .command("delete")
  .description("Delete a capsule before it expires")
  .argument(
    "<owner-capability>",
    "private owner capability printed by capsule send",
  )
  .action(async (encodedCapability: string) => {
    const capability = decodeOwnerCapability(encodedCapability);
    await deleteCapsule(capability);
    if (program.opts<GlobalOptions>().json)
      console.log(JSON.stringify({ deleted: true }));
    else console.log("Capsule deleted.");
  });

program
  .command("status")
  .description("Read relay status using a share URL")
  .argument("<share-url>", "CAPSULE share URL or #capsule fragment")
  .action(async (shareUrl: string) => {
    const capability = decodeShareCapability(extractFragment(shareUrl));
    const status = await new CapsuleRelayClient(capability.relayUrl).status(
      capability.capsuleId,
      capability.readToken,
    );
    console.log(JSON.stringify(status, null, 2));
  });

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
