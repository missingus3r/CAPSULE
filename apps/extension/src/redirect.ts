/**
 * The rule that turns `http://<name>.capsule/…` into a page of this extension.
 *
 * Kept apart from the service worker so it can be checked without a browser.
 * Getting this wrong fails in the least helpful way possible: the browser
 * quietly resolves the name in DNS, fails, and shows a generic "site can't be
 * reached" that says nothing about the extension.
 */

/**
 * Deliberately loose about the label, and precise about the suffix.
 *
 * A real name is exactly 56 base32 characters, but `[a-z2-7]{56}` is not a
 * filter Chrome will accept: RE2 compiles a counted repetition into that many
 * copies of the branch, and 56 copies of a 32-way choice blows past the 2 KB
 * budget declarativeNetRequest allows per rule. The rule is then silently
 * skipped and every `.capsule` address falls through to DNS, which fails with a
 * generic error that says nothing about the extension.
 *
 * So the length check moves to where it costs nothing: `parseSiteName` in the
 * viewer already verifies the length, the alphabet and the checksum. Sending a
 * malformed name here is better than not sending it — the viewer explains what
 * is wrong with it, where a DNS failure would not.
 */
export const CAPSULE_NAME_PATTERN = "[a-z2-7]+\\.capsule";

/** RE2, anchored, so `\0` in the substitution is the whole address. */
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
