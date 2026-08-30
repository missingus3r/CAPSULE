/**
 * The rule that turns `http://<name>.capsule/…` into a page of this extension.
 *
 * Kept apart from the service worker so it can be checked without a browser.
 * Getting this wrong fails in the least helpful way possible: the browser
 * quietly resolves the name in DNS, fails, and shows a generic "site can't be
 * reached" that says nothing about the extension.
 */

/** 56 base32 characters: a 32-byte key, a checksum and a version. */
export const CAPSULE_NAME_PATTERN = "[a-z2-7]{56}\\.capsule";

/** RE2, anchored. Anything not exactly a `.capsule` address must not match. */
export const CAPSULE_URL_FILTER = `^https?://${CAPSULE_NAME_PATTERN}(:\\d+)?(/.*)?$`;

export const CAPSULE_RULE_ID = 1;

/**
 * `\0` is the whole matched URL, which the anchored filter makes the whole
 * address. It travels in the fragment, so it is never sent anywhere — the same
 * reason a capsule's key lives there.
 */
export function redirectRule(
  viewerUrl: string,
): chrome.declarativeNetRequest.Rule {
  return {
    id: CAPSULE_RULE_ID,
    priority: 1,
    action: {
      type: chrome.declarativeNetRequest.RuleActionType.REDIRECT,
      redirect: { regexSubstitution: `${viewerUrl}#\\0` },
    },
    condition: {
      regexFilter: CAPSULE_URL_FILTER,
      resourceTypes: [chrome.declarativeNetRequest.ResourceType.MAIN_FRAME],
    },
  };
}
