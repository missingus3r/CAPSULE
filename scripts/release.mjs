#!/usr/bin/env node
/**
 * Produces the artefacts a release needs to be verifiable by someone who does
 * not trust the machine that built it:
 *
 * - `SHA256SUMS`, so a downloaded file can be checked against the announcement;
 * - `sbom.cdx.json`, a CycloneDX bill of materials naming every dependency and
 *   the integrity hash the lockfile pinned it to.
 *
 * It deliberately does not sign anything. Signing needs a key that lives with
 * the maintainer, not in a repository, and a script that quietly signs with
 * whatever key it finds is worse than no signature at all. The command to run
 * is printed at the end.
 *
 * Run with: npm run release
 */

import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = join(root, "release");

const ARTEFACTS = [
  "apps/cli/dist",
  "apps/relay/dist",
  "apps/web/dist",
  "packages/protocol/dist",
  "packages/protocol/vectors",
  "packages/sdk/dist",
  "packages/mixnet/dist",
];

async function* walk(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile()) yield path;
  }
}

async function checksums() {
  const lines = [];
  for (const artefact of ARTEFACTS) {
    const directory = join(root, artefact);
    try {
      await stat(directory);
    } catch {
      throw new Error(`Missing build output: ${artefact}. Run npm run build.`);
    }
    for await (const path of walk(directory)) {
      const digest = createHash("sha256")
        .update(await readFile(path))
        .digest("hex");
      lines.push(`${digest}  ${relative(root, path).replaceAll("\\", "/")}`);
    }
  }
  lines.sort((left, right) => left.slice(66).localeCompare(right.slice(66)));
  return lines;
}

function integrityToHash(integrity) {
  if (typeof integrity !== "string") return undefined;
  const [algorithm, value] = integrity.split("-");
  const alg = { sha512: "SHA-512", sha256: "SHA-256", sha1: "SHA-1" }[
    algorithm
  ];
  if (!alg || !value) return undefined;
  return { alg, content: Buffer.from(value, "base64").toString("hex") };
}

async function buildSbom(version) {
  const lock = JSON.parse(
    await readFile(join(root, "package-lock.json"), "utf8"),
  );
  const components = [];
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (path === "" || !entry.version) continue;
    const name = entry.name ?? path.split("node_modules/").pop();
    if (!name) continue;
    const hash = integrityToHash(entry.integrity);
    components.push({
      type: "library",
      "bom-ref": `pkg:npm/${name}@${entry.version}`,
      name,
      version: entry.version,
      purl: `pkg:npm/${name}@${entry.version}`,
      scope: entry.dev ? "excluded" : "required",
      ...(entry.license
        ? { licenses: [{ license: { id: entry.license } }] }
        : {}),
      ...(hash ? { hashes: [hash] } : {}),
    });
  }
  components.sort((left, right) => left.purl.localeCompare(right.purl));

  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      // No timestamp: a reproducible build should produce an identical file.
      component: {
        type: "application",
        name: "capsule",
        version,
        description:
          "Private, temporary and resilient encrypted capsule transport.",
      },
      tools: [{ name: "capsule-release", version }],
    },
    components,
  };
}

const { version } = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
);

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

const sums = await checksums();
await writeFile(join(outputDirectory, "SHA256SUMS"), `${sums.join("\n")}\n`);

const sbom = await buildSbom(version);
await writeFile(
  join(outputDirectory, "sbom.cdx.json"),
  `${JSON.stringify(sbom, null, 2)}\n`,
);

console.log(`CAPSULE ${version}`);
console.log(`  release/SHA256SUMS   ${sums.length} files`);
console.log(`  release/sbom.cdx.json  ${sbom.components.length} components`);
console.log("");
console.log("Sign the checksums with your own key before publishing, e.g.:");
console.log("  minisign -Sm release/SHA256SUMS");
console.log("  gpg --armor --detach-sign release/SHA256SUMS");
console.log("");
console.log("Publish the signature and your public key next to the release,");
console.log("and never inside this repository.");
