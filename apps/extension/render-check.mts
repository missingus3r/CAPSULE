import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { JSDOM } from "jsdom";
import {
  packSite,
  unpackSite,
  siteContentType,
  type SiteFile,
} from "@capsule/protocol";
import { renderSitePage } from "./src/render.js";

const root = "C:/Users/Br1/Desktop/CAPSULE/examples/site";
const files: SiteFile[] = [];
const walk = async (dir: string) => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(abs);
      continue;
    }
    const path = relative(root, abs).split(sep).join("/");
    files.push({
      path,
      type: siteContentType(path),
      bytes: new Uint8Array(await readFile(abs)),
    });
  }
};
await walk(root);
const bundle = unpackSite(
  packSite(files.sort((a, b) => a.path.localeCompare(b.path))),
);
const parse = (html: string) => new JSDOM(html).window.document;

for (const path of ["index.html", "proof.html"]) {
  const page = renderSitePage({
    bundle,
    path,
    name: "demo.capsule",
    viewerUrl: "chrome-extension://x/viewer.html",
    parse,
  });
  console.log(`\n=== ${path} ===`);
  console.log("blocked externals:", page.blockedExternals);
  console.log("external links:   ", page.externalLinks);
  console.log("has <script>:     ", /<script/i.test(page.html));
  console.log(
    "script sentence:  ",
    /did not run/.test(page.html) ? "intact" : "MISSING",
  );
  console.log("css present:      ", /data:text\/css|<style/i.test(page.html));
  console.log("svg inlined:      ", /data:image\/svg/i.test(page.html));
  console.log(
    "csp:              ",
    (page.html.match(/content="([^"]*connect-src[^"]*)"/) ?? [])[1],
  );
}
