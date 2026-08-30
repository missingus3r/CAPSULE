/**
 * The part of the extension that makes `http://<name>.capsule/` reach anything
 * at all.
 *
 * There is no DNS for `.capsule` and there is deliberately never going to be:
 * a name is a key, and a lookup service that could answer for it is a lookup
 * service that could be leaned on. Instead the browser's own request pipeline
 * is intercepted before it resolves anything, and the navigation is turned
 * into a page inside the extension.
 *
 * The original address travels in the URL *fragment*, which is the same trick
 * capsule share links use: fragments are not sent to servers, and here there
 * is no server to send it to either way.
 */

import { CAPSULE_RULE_ID, redirectRule } from "./redirect.js";

async function installRedirect(): Promise<void> {
  const rule = redirectRule(chrome.runtime.getURL("viewer.html"));

  // Chrome refuses a filter whose compiled form is too large and then skips the
  // rule, which looks exactly like the extension not being installed. Asking
  // first turns that into something an operator can read.
  const supported = await chrome.declarativeNetRequest.isRegexSupported({
    regex: rule.condition.regexFilter as string,
  });
  if (!supported.isSupported) {
    console.error(
      `CAPSULE: Chrome refused the .capsule redirect filter (${supported.reason}). No .capsule address will open.`,
    );
    return;
  }

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [CAPSULE_RULE_ID],
      addRules: [rule],
    });
  } catch (error) {
    console.error("CAPSULE: could not install the .capsule redirect", error);
  }
}

// Also at the top level, not only in the two lifecycle events. A dynamic rule
// survives restarts, so those two are enough in the steady state — but between
// installing the extension and the first navigation there is a window where no
// rule exists, and a `.capsule` address in that window falls through to DNS and
// fails. Re-asserting the rule whenever this worker runs closes it.
void installRedirect();

chrome.runtime.onInstalled.addListener(() => {
  void installRedirect();
});
chrome.runtime.onStartup.addListener(() => {
  void installRedirect();
});

/**
 * `capsule <name>` in the address bar, because a browser will happily treat a
 * bare `something.capsule` as a search term. Typing the full
 * `http://<name>.capsule/` also works; this is the shorter road.
 */
chrome.omnibox.onInputEntered.addListener((text) => {
  const name = text
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//u, "");
  const target = chrome.runtime.getURL("viewer.html");
  void chrome.tabs.update({ url: `${target}#http://${name}` });
});

chrome.omnibox.onInputChanged.addListener((text, suggest) => {
  if (!text) return;
  suggest([
    {
      content: text,
      description: `Open <match>${text}</match> through CAPSULE`,
    },
  ]);
});
