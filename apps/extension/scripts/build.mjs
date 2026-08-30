import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, "dist");

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await build({
  entryPoints: [
    join(root, "src/background.ts"),
    join(root, "src/viewer.ts"),
    join(root, "src/options.ts"),
  ],
  outdir: out,
  bundle: true,
  format: "esm",
  target: "chrome137",
  platform: "browser",
  sourcemap: false,
  minify: false,
  legalComments: "none",
  // Nothing from Node may end up in a browser extension. Failing the build is
  // better than shipping a shim that quietly does nothing.
  external: [],
});

await cp(join(root, "public"), out, { recursive: true });

// A one-colour mark, generated rather than committed as a binary blob.
const icon = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAAX0lEQVR42u3QAQ0AAAgDoJvc6Fpg" +
    "Fw5JqWzLp1IAAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQIECBAgAABAgQI" +
    "ECBAgAABAgQIECBAgIA/YAA5awABb1kDSAAAAABJRU5ErkJggg==",
  "base64",
);
await writeFile(join(out, "icon128.png"), icon);

const manifest = JSON.parse(
  await readFile(join(root, "public/manifest.json"), "utf8"),
);
console.log(
  `CAPSULE extension ${manifest.version} built into ${out}\n` +
    "Load it with chrome://extensions → Developer mode → Load unpacked.",
);
