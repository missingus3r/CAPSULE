/**
 * Just enough ZIP to read a site out of one.
 *
 * A library would do this, and would also be a third party inside the page
 * that handles a site's signing key. The format needed here is small: walk the
 * central directory, and inflate each entry with `DecompressionStream`, which
 * the browser already has. Nothing is invented — the parsing is the published
 * format, and the decompression is the platform's.
 *
 * What it deliberately does not support: ZIP64, encrypted entries and
 * compression methods other than stored and deflate. Each is refused by name
 * rather than producing a bundle with silently missing files.
 */

const EOCD_SIGNATURE = 0x0605_4b50;
const CENTRAL_SIGNATURE = 0x0201_4b50;
const LOCAL_SIGNATURE = 0x0403_4b50;
/** The comment at the end of an archive can be this long, and no longer. */
const MAX_COMMENT_BYTES = 0xffff;
const ZIP64_MARKER = 0xffff_ffff;

export interface ZipEntry {
  path: string;
  bytes: Uint8Array;
}

/**
 * Runs bytes through a transform and collects the result.
 *
 * The cast is to the DOM library rather than around a real mismatch:
 * `DecompressionStream` is declared with a looser chunk type than
 * `ReadableStream<Uint8Array>.pipeThrough` accepts, so the two do not line up
 * on paper while lining up exactly at runtime.
 */
async function bytesThrough(
  data: Uint8Array,
  transform: GenericTransformStream,
): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data.slice());
      controller.close();
    },
  });
  const piped = source.pipeThrough(
    transform as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
  );
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

function findEndOfCentralDirectory(view: DataView): number {
  const earliest = Math.max(0, view.byteLength - MAX_COMMENT_BYTES - 22);
  for (let at = view.byteLength - 22; at >= earliest; at -= 1) {
    if (view.getUint32(at, true) === EOCD_SIGNATURE) return at;
  }
  throw new Error("That file is not a zip archive");
}

async function inflate(
  data: Uint8Array,
  method: number,
  path: string,
): Promise<Uint8Array> {
  if (method === 0) return data;
  if (method !== 8) {
    throw new Error(
      `${path} uses an unsupported compression method (${method}). Zip the folder again with ordinary deflate.`,
    );
  }
  // `deflate-raw` rather than `deflate`: a zip entry carries the compressed
  // stream with no zlib header around it.
  return bytesThrough(data, new DecompressionStream("deflate-raw"));
}

/**
 * Reads every file in an archive, in central-directory order.
 *
 * Entries that are not files are skipped rather than refused: a directory
 * entry carries no bytes, and the junk a desktop adds to an archive is not
 * something the person zipping their site chose to include.
 */
export async function readZip(data: Uint8Array): Promise<ZipEntry[]> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  const count = view.getUint16(eocd + 10, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (directoryOffset === ZIP64_MARKER || count === 0xffff) {
    throw new Error(
      "ZIP64 archives are not supported. Publish a folder instead.",
    );
  }

  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let at = directoryOffset;

  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(at, true) !== CENTRAL_SIGNATURE) {
      throw new Error("This zip archive is damaged");
    }
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localOffset = view.getUint32(at + 42, true);
    const path = decoder.decode(data.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;

    // Bit 0 is the encryption flag. A password-protected entry would decode
    // into noise, which is worse than saying so.
    if ((flags & 0x1) !== 0) {
      throw new Error(`${path} is encrypted, so it cannot be published`);
    }
    if (compressedSize === ZIP64_MARKER || localOffset === ZIP64_MARKER) {
      throw new Error(
        "ZIP64 archives are not supported. Publish a folder instead.",
      );
    }
    if (path.endsWith("/")) continue;

    if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) {
      throw new Error("This zip archive is damaged");
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = data.subarray(start, start + compressedSize);
    entries.push({ path, bytes: await inflate(compressed, method, path) });
  }

  return entries;
}
