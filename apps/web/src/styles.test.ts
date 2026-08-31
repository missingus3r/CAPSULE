import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every class the markup names has to exist in the stylesheet.
 *
 * This is here because the failure it catches is invisible in review and loud
 * in the browser: a component asking for `.ghost` when the sheet defines
 * `.secondary-action` compiles, typechecks, renders, and puts an unstyled
 * button on the page. TypeScript has nothing to say about a string, and no
 * other test opens a browser, so nothing else notices.
 *
 * Only literal `className="…"` is checked. A class assembled in an expression
 * is usually a conditional over names used elsewhere anyway, and reading those
 * would mean flagging every ternary branch that is not a class at all.
 */

const ROOT = dirname(fileURLToPath(import.meta.url));

/** Containers that carry no rule of their own, and do not need one. */
const LAYOUT_ONLY = new Set(["success-view"]);

function sourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(path));
    else if (entry.name.endsWith(".tsx") && !entry.name.includes(".test.")) {
      found.push(path);
    }
  }
  return found;
}

describe("the stylesheet and the markup agree", () => {
  it("defines every class the components ask for", () => {
    const css = readFileSync(join(ROOT, "styles.css"), "utf8");
    const defined = new Set(
      [...css.matchAll(/\.([a-zA-Z][\w-]*)/gu)].map((match) => match[1]),
    );

    const missing: string[] = [];
    for (const file of sourceFiles(ROOT)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/className="([^"]+)"/gu)) {
        for (const name of (match[1] ?? "").split(/\s+/)) {
          if (!name || LAYOUT_ONLY.has(name) || defined.has(name)) continue;
          missing.push(`.${name} in ${file.split(/[\\/]/).pop()}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});
