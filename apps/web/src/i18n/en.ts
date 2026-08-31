/**
 * The source of truth for every string the web client shows, and for the
 * shape the other languages have to match.
 *
 * Two rules held while writing these, because a privacy tool with chatty
 * copy asks to be skimmed:
 *
 * - a line earns its place by telling somebody something they would otherwise
 *   get wrong. "Private by design" tells nobody anything;
 * - the ones that stay say what happens, not how it feels about it.
 */

export const en = {
  "lang.name": "English",
  "lang.switch": "Language",

  "app.title": "CAPSULE",
  "app.documentTitle": "CAPSULE",
  "app.tagline": "No account. Encrypted on your device.",

  "mode.choose": "Choose an action",
  "mode.send": "Send",
  "mode.receive": "Receive",
  "mode.capsuleDetected": "Capsule detected",

  "send.title": "Send a file",
  "send.sub": "It is encrypted here, before anything is uploaded.",

  "send.step1.label": "What to send",
  "send.step1.hint": "One file per capsule",
  "drop.choose": "Choose a file",
  "drop.dragging": "Drop it here",
  "drop.hint": "or drag it here",
  "drop.remove": "Remove file",
  "drop.replace": "Change",
  "send.step2.label": "When it expires",
  "send.step3.label": "Note",
  "send.step3.hint": "Optional, encrypted with the file",
  "send.step3.placeholder": "For example: the photos from the weekend",
  "send.step4.label": "What to hide",
  "send.step4.hint": "Optional, each option has a cost",

  "expiry.group": "Capsule expiry",
  "expiry.hour": "One hour",
  "expiry.hour.short": "1 h",
  "expiry.day": "One day",
  "expiry.day.short": "24 h",
  "expiry.week": "Seven days",
  "expiry.week.short": "7 days",
  "expiry.never": "No expiry",
  "expiry.never.short": "No limit",
  "expiry.unavailable": "Not available on this relay",
  "expiry.neverWarning":
    "The relay keeps it until you delete it with your deletion key. Lose that key and it stays.",

  "anon.title": "Anonymous mode",
  "anon.detail":
    "Removes the file's own metadata, replaces its name, pads the size to a category and spaces out the upload. Sends somewhat more data and takes longer.",

  "mix.title": "Mix routing",
  "mix.detail":
    "The request travels through several relays, each holding it a random moment, so the relay storing the capsule never learns who asked. Costs minutes rather than seconds.",
  "mix.unavailable":
    "No relay in reach forwards for others. Start one with CAPSULE_MIX_ENABLED=true.",
  "mix.verdict.single-node":
    "{mixes} mix across {operators} apparent operator, {hops} hops each way. This is not anonymity: with one node, that node sees both ends.",
  "mix.verdict.minimal":
    "{mixes} mixes across {operators} apparent operators, {hops} hops each way. Enough to keep the storing relay from seeing you, and not enough for anything more.",
  "mix.verdict.small":
    "{mixes} mixes across {operators} apparent operators, {hops} hops each way. A curious relay learns little; anyone who can watch several of them learns a lot.",
  "mix.verdict.usable":
    "{mixes} mixes across {operators} apparent operators, {hops} hops each way. Still far short of a large network: judge it by who runs these relays, not by the count.",

  "mirror.title": "Copies on other relays",
  "mirror.detail":
    "If one relay goes down or blocks you, the capsule is still on another. Every copy is one more operator that sees the size and the time.",
  "mirror.count": "Number of copies",
  "mirror.one": "Just one",
  "mirror.split":
    "Split instead of copy: no relay holds the whole capsule and any two can open it.",

  "progress.encrypting": "Encrypting on this device",
  "progress.uploading": "Uploading encrypted data",
  "progress.keepOpen": "Keep this window open",

  "action.encrypt": "Encrypt and create link",
  "action.preparing": "Preparing…",
  "action.originalUntouched": "The original file is unchanged and stays here.",
  "action.createAnother": "Create another capsule",

  "sendError.title": "The capsule did not go out",

  "success.eyebrow": "The capsule is ready",
  "success.title": "Share this link",

  "summary.storedOn": "Stored on {count} relay: {hosts}",
  "summary.storedOn.plural": "Stored on {count} relays: {hosts}",
  "summary.padded":
    "Size padded with {bytes} so the relay sees a category, not the real size",
  "summary.scrubbed": "Metadata removed from the file: {items}",
  "summary.notScrubbed":
    "This format's metadata cannot be cleaned yet: the file was sent as it was",
  "summary.sharded": "Split {k} of {n}: no relay holds enough to rebuild it",
  "summary.remaining": "Could not be removed: {item}",
  "summary.mirrorFailed": "Could not copy to {host}",

  "share.label": "Private link",
  "share.copy": "Copy",
  "share.copied": "Copied",
  "share.containsKey":
    "This link carries the key. Send it only to whoever should open it.",
  "share.qrAlt": "QR code for the private link",
  "share.qrScan": "Scan to open",

  "owner.title": "Keep your deletion key",
  "owner.detail":
    "It is not the link you share. It deletes the capsule before it expires.",
  "owner.inputLabel": "Private deletion key",
  "owner.warning":
    "Do not share it. CAPSULE cannot recover it for you: if you will need it later, protect it with a password below.",

  "recovery.title": "Protect it with a password",
  "recovery.detail":
    "Encrypts the deletion key with a password of yours, here. The result can be written down anywhere: without the password it is useless. The relay takes no part in it.",
  "recovery.placeholder": "A password you will remember",
  "recovery.protect": "Protect",
  "recovery.protecting": "Protecting…",
  "recovery.label": "Protected deletion key",

  "receive.title": "Receive a file",
  "receive.sub": "It is opened here, on your device.",
  "receive.opening": "Opening the capsule",
  "receive.openingDetail":
    "The encrypted data is downloaded and opened on this device.",
  "receive.downloading": "Downloading",
  "receive.verifying": "Verifying and decrypting",
  "receive.keyNotSent": "The key is never sent to the relay",
  "receive.readyEyebrow": "Opened and verified",
  "receive.readyTitle": "Ready to save",
  "receive.save": "Save {filename}",
  "receive.close": "Close this capsule",
  "receive.emptyTitle": "Paste a link or a .capsule address",
  "receive.errorTitle": "Let us check the link",
  "receive.emptyDetail":
    "Opening the full link starts the download on its own. You can also paste it here.",
  "receive.linkLabel": "A capsule link, or a .capsule address",
  "receive.open": "Open",
  "receive.hashExplainer":
    "The part starting with {fragment} carries the key. The browser does not send it to the relay when it asks for the page.",

  "metadata.note": "Note",
  "metadata.expires": "Expires",
  "metadata.noExpiry": "No expiry",
  "metadata.noExpiryDetail": "Only your deletion key removes it",

  "privacy.eyebrow": "Privacy",
  "privacy.title": "The file leaves closed. The key travels in the link.",
  "privacy.steps": "How it works",
  "privacy.step1.title": "Encrypted here",
  "privacy.step1.detail": "On your device, before the upload.",
  "privacy.step2.title": "The relay stores noise",
  "privacy.step2.detail": "It receives encrypted data, not the file.",
  "privacy.step3.title": "The link opens it",
  "privacy.step3.detail": "Anyone holding it can download and decrypt.",
  "privacy.details.summary": "What can still be seen",
  "privacy.details.body":
    "The relay sees your IP address at the moment you connect, though it does not keep it. Anonymous mode removes the file's metadata, hides the name and pads the size to a category, but it does not hide your address. Mix routing does: the request travels through several relays and the one storing the capsule never learns who asked. Neither hides that you use CAPSULE at all: the CLI has {flag} for that. Encryption does not protect an infected device, nor stop whoever receives the file from keeping a copy.",

  "mode.publish": "Publish",
  "conn.checking": "Looking for a relay…",
  "conn.offline": "Not connected to any relay",
  "conn.offlineDetail":
    "Nothing can be sent or opened until one answers. Tried {host}. It may be down, or refusing the address this page was opened from.",
  "conn.one": "Connected to 1 relay",
  "conn.oneDetail":
    "Sending and receiving work. Mix routing has nothing to route through: one relay sees both ends. Reaching {host}.",
  "conn.many": "Connected to {count} relays",
  "conn.manyDetail": "Sending, receiving and mix routing are all available.",

  "mode.search": "Search",
  "mode.searchNeedsExtension":
    "Opens a .capsule address, which needs the CAPSULE extension installed.",
  "mode.searchNeedsExtensionShort": "needs the extension",
  "publish.example": "Publish a Hello world instead",
  "publish.exampleNote":
    "The example publishes for one hour and does not ask to be indexed, so trying this leaves nothing behind.",

  "publish.title": "Publish a site",
  "publish.sub":
    "A folder becomes an address nobody issued and nobody can take back.",
  "publish.step1.label": "The site",
  "publish.step1.hint":
    "A folder with an index.html at the top, or a zip of one. It is packed and encrypted here, before anything leaves.",
  "publish.pickFolder": "Choose a folder",
  "publish.pickZip": "Choose a .zip",
  "publish.gathered": "{files} files, {size}, ready to pack.",
  "publish.skipped": "{count} left out as system files.",
  "publish.step2.label": "The name",
  "publish.step2.hint":
    "A new name, or one this browser already holds the key for.",
  "publish.newName": "A new name",
  "publish.importKey": "Import a .capsulekey file",
  "publish.step3.label": "How it is listed",
  "publish.step3.hint": "All optional, and all public once published.",
  "publish.titlePlaceholder": "Title, shown in the browser tab",
  "publish.listed": "Allow indexes to list this site",
  "publish.listedDetail":
    "Writes an opt-in into the site itself. Nothing indexes CAPSULE yet; when something does, it must treat a site that says nothing as one that said no.",
  "publish.descriptionPlaceholder": "One line for a search result",
  "publish.keyWarning":
    "The key file downloads before publishing. It is the name: lose it and nobody, including us, can give it back.",
  "publish.keyReused":
    "Signed with the key this browser holds for that name. It can sign and cannot be read back out.",
  "publish.go": "Pack, encrypt and publish",
  "publish.working": "Publishing",
  "publish.workingDetail":
    "Packing the bundle, encrypting it, and signing the record that points at it.",
  "publish.done": "Published",
  "publish.doneDetail": "Version {version}, announced to {relays} relay(s).",
  "publish.address": "The address",
  "publish.copy": "Copy",
  "publish.copied": "Copied",
  "publish.keptKey":
    "This browser kept a signing handle for the name, so the next version is one click. The backup file is still the only way to publish from anywhere else.",
  "publish.again": "Publish another",
  "publish.error.missingKey":
    "This browser no longer holds that key. Import the .capsulekey file.",

  "extension.eyebrow": "Get the extension",
  "extension.title": "Reading a .capsule site",
  "extension.body":
    "A .capsule address resolves nowhere in DNS, so a browser needs the extension to open one. It rebuilds every page before showing it, and the result cannot make a single network request.",
  "extension.cta": "How to install it",
  "extension.note":
    "There is no store listing. You build it from the repository and load it unpacked, which is also why you can read what you are running.",

  "network.eyebrow": "The network",
  "network.title": "Anyone can run a relay",
  "network.body":
    "No registration and no permission: you start one, point it at a relay you already know, and they introduce each other. This app uses {host} and discovers the rest from there.",
  "network.empty": "No relay has answered yet.",
  "network.persistent": "no expiry",
  "network.temporary": "temporary only",
  "network.peers": "{count} peers",

  "footer.noTracking": "No analytics and no third-party trackers.",

  "size.unknown": "Unknown size",
  "mime.pdf": "PDF document",
  "mime.jpeg": "JPEG image",
  "mime.png": "PNG image",
  "mime.gif": "GIF image",
  "mime.webp": "WebP image",
  "mime.mp4": "MP4 video",
  "mime.zip": "ZIP archive",
  "mime.plain": "Plain text",
  "mime.generic": "File",

  "error.badLink":
    "Paste a full CAPSULE link. The part starting with #capsule= carries the key.",
  "error.expired": "This capsule has expired and is no longer available.",
  "error.notFound":
    "We could not find this capsule. It may have expired or been withdrawn.",
  "error.tooLarge": "The file or the expiry is above this relay's limit.",
  "error.authentication":
    "The link is incomplete or the file could not be verified. Ask for a new link.",
  "error.network":
    "We could not reach the relay. If it is running, this is usually the relay refusing the address this page was opened from: localhost and 127.0.0.1 are different origins. Open it at the address the relay expects, or set CAPSULE_CORS_ORIGIN.",
  "error.uploadGeneric":
    "We could not prepare the capsule. The file is still on your device; you can try again.",
  "error.downloadGeneric":
    "We could not open the capsule. Try again or ask for a new link.",
  "error.passphraseShort": "Use at least 8 characters.",
  "error.protectFailed": "The key could not be protected. Try again.",
} as const;

export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;
