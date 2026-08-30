import { siteContentType, type SiteFile } from "@capsule/protocol";
import type { GatheredSite } from "./sitefiles";

/**
 * A site to publish in one click, so the whole thing can be seen working
 * before anybody prepares a folder.
 *
 * It expires in an hour on purpose. Somebody trying the feature out should not
 * have to remember to clean up after themselves, and a network filling with
 * abandoned hello-worlds helps nobody. It also does not ask to be indexed:
 * an example is not a site anybody wants in a directory.
 *
 * The page is written to work under the rules a `.capsule` site actually runs
 * with — one stylesheet from the same bundle, no scripts, no external anything
 * — so what it demonstrates is the real thing rather than a page that happens
 * to survive them.
 */

export const EXAMPLE_TTL_SECONDS = 60 * 60;

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Hello from CAPSULE</title>
    <link rel="stylesheet" href="style.css" />
  </head>
  <body>
    <main>
      <p class="eyebrow">A .capsule site</p>
      <h1>Hello world.</h1>
      <p>
        This page has no DNS record, no certificate and no hosting bill. Its
        address is a public key, and the only thing that can replace what you
        are reading is whoever holds the matching private one.
      </p>
      <p>
        The relay that handed you these bytes cannot read them. It stored one
        encrypted blob and a signed note saying where to find it.
      </p>
      <p class="note">
        It expires an hour after it was published, and then the name resolves
        to nothing. That is the default for an example, not a limit of the
        network.
      </p>
    </main>
  </body>
</html>
`;

const STYLE = `:root{color-scheme:light dark}
*{box-sizing:border-box}
body{margin:0;padding:12vh 1.25rem 4rem;font:17px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif;background:#f3efe6;color:#18352f}
main{max-width:34rem;margin:0 auto}
.eyebrow{margin:0 0 .5rem;font-size:.74rem;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#c2543a}
h1{margin:0 0 1.25rem;font-size:clamp(2.2rem,7vw,3.2rem);letter-spacing:-.035em;line-height:1.05}
p{margin:0 0 1rem;color:#3d534d}
.note{margin-top:2rem;padding:1rem 1.15rem;border-left:3px solid #c2543a;background:#fffdf8;font-size:.94rem;color:#5a6b65}
@media(prefers-color-scheme:dark){body{background:#12201d;color:#e8efec}p{color:#b9c9c3}.note{background:#18302b}}
`;

/** Built fresh each time so nothing is shared between publishes. */
export function exampleSite(): GatheredSite {
  const encoder = new TextEncoder();
  const files: SiteFile[] = [
    {
      path: "index.html",
      type: siteContentType("index.html"),
      bytes: encoder.encode(PAGE),
    },
    {
      path: "style.css",
      type: siteContentType("style.css"),
      bytes: encoder.encode(STYLE),
    },
  ];
  return {
    files,
    totalBytes: files.reduce((sum, file) => sum + file.bytes.byteLength, 0),
    skipped: [],
  };
}
