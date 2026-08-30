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

const RULE_ID = 1;
/** 56 base32 characters is exactly a 32-byte key, a checksum and a version. */
const NAME_PATTERN = "[a-z2-7]{56}\\.capsule";

async function installRedirect(): Promise<void> {
  const viewer = chrome.runtime.getURL("viewer.html");
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [RULE_ID],
    addRules: [
      {
        id: RULE_ID,
        priority: 1,
        action: {
          type: chrome.declarativeNetRequest.RuleActionType.REDIRECT,
          redirect: { regexSubstitution: `${viewer}#\\0` },
        },
        condition: {
          regexFilter: `^https?://${NAME_PATTERN}(:\\d+)?(/.*)?$`,
          resourceTypes: [chrome.declarativeNetRequest.ResourceType.MAIN_FRAME],
        },
      },
    ],
  });
}

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
