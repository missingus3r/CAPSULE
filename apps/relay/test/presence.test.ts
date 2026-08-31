import { describe, expect, it } from "vitest";
import { PresenceCounter } from "../src/presence.js";

/**
 * What the counter must and must not do.
 *
 * It exists to answer "is anything happening here", and the tests that matter
 * are the ones about forgetting: a count that only grows is a log of who was
 * here, which is the thing this project spends its effort not keeping.
 */

describe("counting who is here", () => {
  it("counts an address once however often it asks", () => {
    const counter = new PresenceCounter();
    counter.see("a");
    counter.see("a");
    counter.see("b");
    expect(counter.snapshot(0).clients).toBe(2);
  });

  it("forgets an address that has gone quiet", () => {
    let now = 1_000;
    const counter = new PresenceCounter(60_000, () => now);
    counter.see("a");
    counter.see("b");
    expect(counter.snapshot(0).clients).toBe(2);

    now += 61_000;
    counter.see("b");
    // `a` fell out of the window; nothing about it is kept, including the fact
    // that it was ever there.
    expect(counter.snapshot(0).clients).toBe(1);
  });

  it("keeps the peak after the count falls", () => {
    let now = 0;
    const counter = new PresenceCounter(60_000, () => now);
    counter.see("a");
    counter.see("b");
    counter.see("c");
    expect(counter.snapshot(0)).toMatchObject({ clients: 3, clientsPeak: 3 });

    now += 61_000;
    const later = counter.snapshot(0);
    expect(later.clients).toBe(0);
    expect(later.clientsPeak).toBe(3);
  });

  it("tracks the relay peak from what it is told", () => {
    const counter = new PresenceCounter();
    expect(counter.snapshot(4)).toMatchObject({ relays: 4, relaysPeak: 4 });
    expect(counter.snapshot(2)).toMatchObject({ relays: 2, relaysPeak: 4 });
  });

  it("ignores an empty key rather than counting a phantom", () => {
    const counter = new PresenceCounter();
    counter.see("");
    expect(counter.snapshot(0).clients).toBe(0);
  });

  it("does not grow without bound when traffic stops", () => {
    let now = 0;
    const counter = new PresenceCounter(1_000, () => now);
    for (let index = 0; index < 500; index += 1) {
      counter.see(`key-${index}`);
      now += 10;
    }
    now += 2_000;
    // Everything aged out, so the map is empty rather than holding five
    // hundred digests for the life of the process.
    expect(counter.snapshot(0).clients).toBe(0);
  });
});

describe("the page it is drawn on", () => {
  it("carries a dictionary that parses, with the same keys in each language", async () => {
    // The page is one string with no build step, so a stray comma or a key
    // missing from one language is a blank label in a browser and nothing at
    // all anywhere else.
    const { REALTIME_PAGE } = await import("../src/realtime-page.js");
    const match = /var S = (\{[\s\S]*?\});\n/u.exec(REALTIME_PAGE);
    expect(match, "the dictionary is where the script expects it").toBeTruthy();

    const dictionary = JSON.parse(match?.[1] ?? "") as Record<
      string,
      Record<string, string>
    >;
    const languages = Object.keys(dictionary);
    expect(languages).toEqual(["en", "es", "pt"]);

    const reference = Object.keys(dictionary.en ?? {}).sort();
    expect(reference.length).toBeGreaterThan(5);
    for (const language of languages) {
      expect(
        Object.keys(dictionary[language] ?? {}).sort(),
        `${language} is missing a key`,
      ).toEqual(reference);
    }
  });

  it("asks the relay for its numbers and nothing else", async () => {
    const { REALTIME_PAGE } = await import("../src/realtime-page.js");
    // A page that reached anywhere else would be sending a reader's presence
    // to somebody other than the relay they were already talking to.
    const urls = [...REALTIME_PAGE.matchAll(/fetch\("([^"]+)"/gu)].map(
      (m) => m[1],
    );
    expect(urls).toEqual(["/v1/realtime"]);
    expect(REALTIME_PAGE).not.toMatch(/https?:\/\//u);
  });
});
