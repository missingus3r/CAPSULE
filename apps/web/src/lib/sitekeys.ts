import {
  loadSiteIdentity,
  type SiteIdentity,
  type SiteIdentityFile,
} from "@capsule/sdk";

/**
 * The names this browser can publish under.
 *
 * A site key **is** the name: whoever holds it decides what the name resolves
 * to, and losing it loses the name with no way to recover it. That shapes both
 * halves of what happens here.
 *
 * **The backup leaves immediately.** A new name downloads its `.capsulekey`
 * before anything else, because a key that exists only in a browser profile is
 * one cleared cache away from gone.
 *
 * **What stays behind cannot be read.** The stored handle is the `CryptoKey`
 * that `loadSiteIdentity` produces, which Web Crypto marks non-extractable and
 * usable only for signing. IndexedDB stores it by structured clone, keeping
 * that flag, so the key can sign the next version of a site and nothing — not
 * this page, not a script that reaches this origin — can read the bytes back
 * out. Publishing again is one click; what is at rest is not the key.
 */

const DATABASE = "capsule.sites";
const STORE = "identities";
const VERSION = 1;

export interface StoredSiteKey {
  name: string;
  publicKey: Uint8Array;
  /** Non-extractable, `["sign"]` only. */
  privateKey: CryptoKey;
  createdAt: string;
  /** Highest sequence this browser has published for the name. */
  sequence: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: "name" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("No storage"));
  });
}

async function transact<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(database.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error("Storage failed"));
    });
  } finally {
    database.close();
  }
}

/**
 * Names this browser holds a key for. An empty list is the normal state, not
 * an error: storage can be denied outright, and a publisher who only ever
 * imports a key file is not worse off for it.
 */
export async function listSiteKeys(): Promise<StoredSiteKey[]> {
  try {
    const stored = await transact<StoredSiteKey[]>(
      "readonly",
      (store) => store.getAll() as IDBRequest<StoredSiteKey[]>,
    );
    return stored.sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    );
  } catch {
    return [];
  }
}

/** Keeps a key for later. Failing to store is not failing to publish. */
export async function rememberSiteKey(
  identity: SiteIdentity,
  createdAt: string,
  sequence: number,
): Promise<void> {
  try {
    await transact("readwrite", (store) =>
      store.put({
        name: identity.name,
        publicKey: identity.publicKey,
        privateKey: identity.privateKey,
        createdAt,
        sequence,
      } satisfies StoredSiteKey),
    );
  } catch {
    // The publish already happened. The backup file is the thing that matters.
  }
}

export async function forgetSiteKey(name: string): Promise<void> {
  try {
    await transact("readwrite", (store) => store.delete(name));
  } catch {
    // Nothing stored is nothing to forget.
  }
}

/** Reads a `.capsulekey` file, verifying that the key matches the name in it. */
export async function importSiteKeyFile(file: File): Promise<{
  identity: SiteIdentity;
  createdAt: string;
}> {
  let parsed: SiteIdentityFile;
  try {
    parsed = JSON.parse(await file.text()) as SiteIdentityFile;
  } catch {
    throw new Error("That file is not a CAPSULE site key.");
  }
  // Re-derives the name from the key and refuses a file whose name does not
  // match it, so an edited file cannot make this browser publish elsewhere.
  const identity = await loadSiteIdentity(parsed);
  return { identity, createdAt: parsed.createdAt ?? new Date().toISOString() };
}

/**
 * Hands the key file to the person before it is needed.
 *
 * Deliberately not optional and deliberately first: by the time somebody
 * discovers they needed it, the name is already gone.
 */
export function downloadSiteKeyFile(file: SiteIdentityFile): void {
  const blob = new Blob([JSON.stringify(file, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${file.name.replace(/\.capsule$/u, "")}.capsulekey`;
  link.click();
  URL.revokeObjectURL(url);
}
