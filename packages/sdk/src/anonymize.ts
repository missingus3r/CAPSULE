/**
 * Payload anonymisation.
 *
 * Encryption hides a file from the relay, but it does not hide the sender from
 * the receiver: cameras, phones, editors and office suites embed serial
 * numbers, GPS coordinates, author names, company names and timestamps inside
 * the file itself. These helpers remove those containers before the capsule is
 * encrypted, so the cleaned bytes are what actually gets stored and shared.
 *
 * This is format surgery, not magic. Three rules keep it honest:
 *
 * 1. Never corrupt a file to clean it. Where a container cannot be rewritten
 *    safely, the bytes are left alone and the caller is told.
 * 2. Report what was removed *and* what is still there, so an interface can
 *    say "we could not clean this" instead of implying success.
 * 3. Pixels, wording and structure are not touched: a watermark, a visible
 *    signature or a distinctive writing style survive all of this.
 */

export type ScrubFormat =
  "jpeg" | "png" | "webp" | "gif" | "iso-bmff" | "zip" | "pdf" | "unknown";

export interface ScrubResult {
  bytes: Uint8Array;
  /** Metadata containers that were removed. */
  removed: string[];
  /** Metadata detected but that this implementation cannot remove safely. */
  remaining: string[];
  /** False when the format is not understood and the bytes were left intact. */
  supported: boolean;
  format: ScrubFormat;
}

const textEncoder = new TextEncoder();

function startsWith(bytes: Uint8Array, prefix: number[], at = 0): boolean {
  if (bytes.length < at + prefix.length) return false;
  return prefix.every((value, index) => bytes[at + index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let value = "";
  for (let index = offset; index < offset + length; index += 1) {
    value += String.fromCharCode(bytes[index] ?? 0);
  }
  return value;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function unchanged(bytes: Uint8Array, format: ScrubFormat): ScrubResult {
  return { bytes, removed: [], remaining: [], supported: false, format };
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d];
const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];

function detectFormat(bytes: Uint8Array): ScrubFormat {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return "jpeg";
  if (startsWith(bytes, PNG_SIGNATURE)) return "png";
  if (startsWith(bytes, PDF_SIGNATURE)) return "pdf";
  if (startsWith(bytes, ZIP_SIGNATURE)) return "zip";
  if (
    bytes.length > 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 4) === "WEBP"
  ) {
    return "webp";
  }
  if (bytes.length > 6 && ascii(bytes, 0, 3) === "GIF") return "gif";
  if (bytes.length > 12 && ascii(bytes, 4, 4) === "ftyp") return "iso-bmff";
  return "unknown";
}

// --- JPEG -------------------------------------------------------------------

const JPEG_APP_MARKERS_KEPT = new Set([0xe0]); // APP0/JFIF is structural.

function scrubJpeg(bytes: Uint8Array): ScrubResult {
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  const removed = new Set<string>();
  let offset = 2;

  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) return unchanged(bytes, "jpeg");
    let markerOffset = offset;
    while (bytes[markerOffset] === 0xff) markerOffset += 1; // Fill bytes.
    const marker = bytes[markerOffset];
    if (marker === undefined) break;

    if (marker === 0xd9 || marker === 0xda) {
      // End of image, or start of scan: copy the remainder verbatim.
      parts.push(bytes.subarray(offset));
      offset = bytes.length;
      break;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      parts.push(bytes.subarray(offset, markerOffset + 1));
      offset = markerOffset + 1;
      continue;
    }

    const lengthOffset = markerOffset + 1;
    if (lengthOffset + 1 >= bytes.length) return unchanged(bytes, "jpeg");
    const length =
      ((bytes[lengthOffset] ?? 0) << 8) | (bytes[lengthOffset + 1] ?? 0);
    if (length < 2) return unchanged(bytes, "jpeg");
    const end = lengthOffset + length;
    if (end > bytes.length) return unchanged(bytes, "jpeg");

    const isApplicationSegment = marker >= 0xe0 && marker <= 0xef;
    const isComment = marker === 0xfe;
    if (
      (isApplicationSegment && !JPEG_APP_MARKERS_KEPT.has(marker)) ||
      isComment
    ) {
      removed.add(
        isComment
          ? "comentario JPEG"
          : `segmento APP${(marker - 0xe0).toString(16).toUpperCase()}`,
      );
    } else {
      parts.push(bytes.subarray(offset, end));
    }
    offset = end;
  }

  if (offset < bytes.length) parts.push(bytes.subarray(offset));
  return {
    bytes: removed.size > 0 ? concat(parts) : bytes,
    removed: [...removed],
    remaining: [],
    supported: true,
    format: "jpeg",
  };
}

// --- PNG --------------------------------------------------------------------

const PNG_METADATA_CHUNKS = new Set([
  "tEXt",
  "zTXt",
  "iTXt",
  "eXIf",
  "tIME",
  "dSIG",
]);

function scrubPng(bytes: Uint8Array): ScrubResult {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: Uint8Array[] = [bytes.subarray(0, 8)];
  const removed = new Set<string>();
  let offset = 8;

  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = ascii(bytes, offset + 4, 4);
    const end = offset + 12 + length;
    if (!Number.isSafeInteger(end) || end > bytes.length) {
      return unchanged(bytes, "png");
    }
    if (PNG_METADATA_CHUNKS.has(type)) removed.add(`chunk ${type}`);
    else parts.push(bytes.subarray(offset, end));
    offset = end;
    if (type === "IEND") break;
  }

  if (offset < bytes.length) parts.push(bytes.subarray(offset));
  return {
    bytes: removed.size > 0 ? concat(parts) : bytes,
    removed: [...removed],
    remaining: [],
    supported: true,
    format: "png",
  };
}

// --- WebP -------------------------------------------------------------------

function scrubWebp(bytes: Uint8Array): ScrubResult {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts: Uint8Array[] = [];
  const removed = new Set<string>();
  let offset = 12;

  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, 4);
    const length = view.getUint32(offset + 4, true);
    const padded = length + (length % 2);
    const end = offset + 8 + padded;
    if (!Number.isSafeInteger(end) || end > bytes.length) {
      return unchanged(bytes, "webp");
    }
    if (type === "EXIF" || type === "XMP ") {
      removed.add(`chunk ${type.trim()}`);
    } else if (type === "VP8X" && length >= 1) {
      // Clear the EXIF and XMP presence flags so decoders stay consistent.
      const chunk = bytes.slice(offset, end);
      chunk[8] = (chunk[8] ?? 0) & ~0b0000_1100;
      parts.push(chunk);
    } else {
      parts.push(bytes.subarray(offset, end));
    }
    offset = end;
  }

  if (removed.size === 0) {
    return {
      bytes,
      removed: [],
      remaining: [],
      supported: true,
      format: "webp",
    };
  }

  const body = concat(parts);
  const output = new Uint8Array(12 + body.byteLength);
  output.set(bytes.subarray(0, 12), 0);
  output.set(body, 12);
  new DataView(output.buffer).setUint32(4, output.byteLength - 8, true);
  return {
    bytes: output,
    removed: [...removed],
    remaining: [],
    supported: true,
    format: "webp",
  };
}

// --- GIF --------------------------------------------------------------------

function scrubGif(bytes: Uint8Array): ScrubResult {
  const removed = new Set<string>();
  const parts: Uint8Array[] = [];
  let offset = 6; // Header.
  if (bytes.length < 13) return unchanged(bytes, "gif");

  const flags = bytes[10] ?? 0;
  offset = 13;
  if (flags & 0x80) offset += 3 * 2 ** ((flags & 0x07) + 1);
  if (offset > bytes.length) return unchanged(bytes, "gif");
  parts.push(bytes.subarray(0, offset));

  const skipSubBlocks = (from: number): number => {
    let cursor = from;
    while (cursor < bytes.length) {
      const size = bytes[cursor] ?? 0;
      cursor += 1;
      if (size === 0) return cursor;
      cursor += size;
    }
    return -1;
  };

  while (offset < bytes.length) {
    const marker = bytes[offset];
    if (marker === 0x3b) {
      parts.push(bytes.subarray(offset));
      offset = bytes.length;
      break;
    }
    if (marker === 0x21) {
      const label = bytes[offset + 1];
      const blockEnd = skipSubBlocks(offset + 2);
      if (blockEnd === -1) return unchanged(bytes, "gif");
      const isComment = label === 0xfe;
      const isApplication = label === 0xff;
      // The NETSCAPE2.0 application extension carries the loop count, not
      // metadata, so animated images keep working.
      const isLoop =
        isApplication && ascii(bytes, offset + 3, 11) === "NETSCAPE2.0";
      if (isComment || (isApplication && !isLoop)) {
        removed.add(isComment ? "comentario GIF" : "extensión de aplicación");
      } else {
        parts.push(bytes.subarray(offset, blockEnd));
      }
      offset = blockEnd;
      continue;
    }
    if (marker === 0x2c) {
      if (offset + 10 > bytes.length) return unchanged(bytes, "gif");
      const localFlags = bytes[offset + 9] ?? 0;
      let cursor = offset + 10;
      if (localFlags & 0x80) cursor += 3 * 2 ** ((localFlags & 0x07) + 1);
      cursor += 1; // LZW minimum code size.
      const imageEnd = skipSubBlocks(cursor);
      if (imageEnd === -1) return unchanged(bytes, "gif");
      parts.push(bytes.subarray(offset, imageEnd));
      offset = imageEnd;
      continue;
    }
    return unchanged(bytes, "gif");
  }

  return {
    bytes: removed.size > 0 ? concat(parts) : bytes,
    removed: [...removed],
    remaining: [],
    supported: true,
    format: "gif",
  };
}

// --- ISO base media (MP4, MOV, HEIC, AVIF) ----------------------------------

/**
 * Metadata boxes are overwritten in place with `free` boxes of exactly the
 * same size rather than deleted. Sample tables (`stco`/`co64`) store absolute
 * file offsets, so removing bytes anywhere before the media data would break
 * playback; padding keeps every offset valid.
 */
function scrubIsoBmff(bytes: Uint8Array): ScrubResult {
  const output = bytes.slice();
  const view = new DataView(
    output.buffer,
    output.byteOffset,
    output.byteLength,
  );
  const removed = new Set<string>();
  const remaining = new Set<string>();
  let malformed = false;

  const blank = (start: number, end: number, label: string): void => {
    view.setUint32(start, end - start);
    output[start + 4] = 0x66; // f
    output[start + 5] = 0x72; // r
    output[start + 6] = 0x65; // e
    output[start + 7] = 0x65; // e
    output.fill(0, start + 8, end);
    removed.add(label);
  };

  const walk = (start: number, end: number, depth: number): void => {
    let offset = start;
    while (offset + 8 <= end) {
      let size = view.getUint32(offset);
      let headerBytes = 8;
      if (size === 1) {
        if (offset + 16 > end) {
          malformed = true;
          return;
        }
        const high = view.getUint32(offset + 8);
        const low = view.getUint32(offset + 12);
        size = high * 2 ** 32 + low;
        headerBytes = 16;
      } else if (size === 0) {
        size = end - offset;
      }
      if (size < headerBytes || offset + size > end) {
        malformed = true;
        return;
      }
      const type = ascii(output, offset + 4, 4);
      const boxEnd = offset + size;

      if (type === "udta") {
        blank(offset, boxEnd, "caja udta (autor, GPS, dispositivo)");
      } else if (type === "uuid") {
        blank(offset, boxEnd, "caja uuid (XMP)");
      } else if (type === "meta" && depth > 0) {
        // A `meta` box inside `moov` or a track holds tags. At the top level
        // of HEIC/AVIF it holds the image itself, so it is never touched.
        blank(offset, boxEnd, "caja meta");
      } else if (
        type === "moov" ||
        type === "trak" ||
        type === "mdia" ||
        type === "minf"
      ) {
        walk(offset + headerBytes, boxEnd, depth + 1);
      } else if (type === "meta" && depth === 0) {
        remaining.add("caja meta de nivel superior (estructura del archivo)");
      }

      offset = boxEnd;
    }
  };

  walk(0, output.byteLength, 0);
  if (malformed) return unchanged(bytes, "iso-bmff");

  return {
    bytes: removed.size > 0 ? output : bytes,
    removed: [...removed],
    remaining: [...remaining],
    supported: true,
    format: "iso-bmff",
  };
}

// --- ZIP containers (OOXML, ODF, EPUB) --------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc =
      (CRC_TABLE[(crc ^ (bytes[index] as number)) & 0xff] as number) ^
      (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const OOXML_CORE = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"/>`;
const OOXML_APP = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"/>`;
const OOXML_CUSTOM = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"/>`;
const ODF_META = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-meta xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" office:version="1.2"><office:meta/></office:document-meta>`;

/**
 * Metadata parts are replaced with a valid empty document rather than deleted,
 * so the relationships that reference them stay intact and the file still
 * opens.
 */
function zipReplacement(
  name: string,
): { content: string; label: string } | undefined {
  if (name === "docProps/core.xml") {
    return {
      content: OOXML_CORE,
      label: "propiedades del documento (autor, empresa, revisiones)",
    };
  }
  if (name === "docProps/app.xml") {
    return {
      content: OOXML_APP,
      label: "propiedades extendidas (programa, tiempo de edición)",
    };
  }
  if (name === "docProps/custom.xml") {
    return { content: OOXML_CUSTOM, label: "propiedades personalizadas" };
  }
  if (name === "meta.xml") {
    return { content: ODF_META, label: "metadatos ODF (autor, estadísticas)" };
  }
  return undefined;
}

interface ZipEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  internalAttributes: number;
  externalAttributes: number;
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const limit = Math.max(0, bytes.length - 0xffff - 22);
  for (let offset = bytes.length - 22; offset >= limit; offset -= 1) {
    if (
      bytes[offset] === 0x50 &&
      bytes[offset + 1] === 0x4b &&
      bytes[offset + 2] === 0x05 &&
      bytes[offset + 3] === 0x06
    ) {
      return offset;
    }
  }
  return -1;
}

function scrubZip(bytes: Uint8Array): ScrubResult {
  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd === -1) return unchanged(bytes, "zip");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const entryCount = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  if (
    entryCount === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff ||
    directoryOffset + directorySize > bytes.length
  ) {
    // Zip64 or a corrupt archive: rewriting it safely is out of scope.
    return unchanged(bytes, "zip");
  }

  const entries: ZipEntry[] = [];
  let cursor = directoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (
      cursor + 46 > bytes.length ||
      view.getUint32(cursor, true) !== 0x02014b50
    ) {
      return unchanged(bytes, "zip");
    }
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    entries.push({
      name: new TextDecoder().decode(
        bytes.subarray(cursor + 46, cursor + 46 + nameLength),
      ),
      method: view.getUint16(cursor + 10, true),
      crc: view.getUint32(cursor + 16, true),
      compressedSize: view.getUint32(cursor + 20, true),
      uncompressedSize: view.getUint32(cursor + 24, true),
      localOffset: view.getUint32(cursor + 42, true),
      internalAttributes: view.getUint16(cursor + 36, true),
      externalAttributes: view.getUint32(cursor + 38, true),
    });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  const removed = new Set<string>();
  const localParts: Uint8Array[] = [];
  const directoryParts: Uint8Array[] = [];
  let writeOffset = 0;

  for (const entry of entries) {
    const local = entry.localOffset;
    if (
      local + 30 > bytes.length ||
      view.getUint32(local, true) !== 0x04034b50
    ) {
      return unchanged(bytes, "zip");
    }
    const localNameLength = view.getUint16(local + 26, true);
    const localExtraLength = view.getUint16(local + 28, true);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    if (dataStart + entry.compressedSize > bytes.length) {
      return unchanged(bytes, "zip");
    }

    const replacement = zipReplacement(entry.name);
    let method = entry.method;
    let crc = entry.crc;
    let compressed: Uint8Array;
    let uncompressedSize = entry.uncompressedSize;

    if (replacement) {
      const content = textEncoder.encode(replacement.content);
      method = 0;
      crc = crc32(content);
      compressed = content;
      uncompressedSize = content.byteLength;
      removed.add(replacement.label);
    } else {
      compressed = bytes.subarray(dataStart, dataStart + entry.compressedSize);
    }

    const nameBytes = textEncoder.encode(entry.name);
    const header = new Uint8Array(30 + nameBytes.byteLength);
    const headerView = new DataView(header.buffer);
    headerView.setUint32(0, 0x04034b50, true);
    headerView.setUint16(4, 20, true); // Version needed.
    headerView.setUint16(6, 0, true); // No data descriptor, no encryption.
    headerView.setUint16(8, method, true);
    // A fixed 1980-01-01 timestamp: modification times are metadata too, and
    // dropping the extra field removes NTFS and Unix timestamps with it.
    headerView.setUint16(10, 0, true);
    headerView.setUint16(12, 0x0021, true);
    headerView.setUint32(14, crc, true);
    headerView.setUint32(18, compressed.byteLength, true);
    headerView.setUint32(22, uncompressedSize, true);
    headerView.setUint16(26, nameBytes.byteLength, true);
    headerView.setUint16(28, 0, true);
    header.set(nameBytes, 30);

    const directory = new Uint8Array(46 + nameBytes.byteLength);
    const directoryView = new DataView(directory.buffer);
    directoryView.setUint32(0, 0x02014b50, true);
    directoryView.setUint16(4, 20, true); // Version made by.
    directoryView.setUint16(6, 20, true); // Version needed.
    directoryView.setUint16(8, 0, true);
    directoryView.setUint16(10, method, true);
    directoryView.setUint16(12, 0, true);
    directoryView.setUint16(14, 0x0021, true);
    directoryView.setUint32(16, crc, true);
    directoryView.setUint32(20, compressed.byteLength, true);
    directoryView.setUint32(24, uncompressedSize, true);
    directoryView.setUint16(28, nameBytes.byteLength, true);
    directoryView.setUint16(30, 0, true);
    directoryView.setUint16(32, 0, true);
    directoryView.setUint16(34, 0, true);
    directoryView.setUint16(36, entry.internalAttributes, true);
    directoryView.setUint32(38, entry.externalAttributes, true);
    directoryView.setUint32(42, writeOffset, true);
    directory.set(nameBytes, 46);

    localParts.push(header, compressed);
    directoryParts.push(directory);
    writeOffset += header.byteLength + compressed.byteLength;
  }

  const directoryBytes = concat(directoryParts);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, directoryBytes.byteLength, true);
  endView.setUint32(16, writeOffset, true);

  return {
    bytes: concat([...localParts, directoryBytes, end]),
    removed: [
      ...removed,
      "marcas de tiempo y campos extra de cada archivo del contenedor",
    ],
    remaining: [],
    supported: true,
    format: "zip",
  };
}

// --- PDF --------------------------------------------------------------------

/**
 * XMP packets are designed to be rewritable in place: the standard requires
 * trailing padding precisely so a packet can be overwritten without moving any
 * other byte. That lets us blank them without touching the cross-reference
 * table, which is what makes editing a PDF risky.
 *
 * The `/Info` dictionary cannot be neutralised the same way — it may live
 * inside a compressed object stream — so its presence is reported instead of
 * being silently ignored.
 */
function scrubPdf(bytes: Uint8Array): ScrubResult {
  const output = bytes.slice();
  const removed = new Set<string>();
  const remaining = new Set<string>();

  const begin = textEncoder.encode("<?xpacket begin=");
  const end = textEncoder.encode("<?xpacket end=");
  const space = 0x20;

  const indexOf = (needle: Uint8Array, from: number): number => {
    outer: for (
      let start = from;
      start + needle.length <= output.length;
      start += 1
    ) {
      for (let index = 0; index < needle.length; index += 1) {
        if (output[start + index] !== needle[index]) continue outer;
      }
      return start;
    }
    return -1;
  };

  let cursor = 0;
  while (cursor < output.length) {
    const packetStart = indexOf(begin, cursor);
    if (packetStart === -1) break;
    const packetEnd = indexOf(end, packetStart);
    if (packetEnd === -1) break;
    // Blank up to the closing marker; the marker itself and its trailing
    // `?>` stay so the object length and the file structure are untouched.
    output.fill(space, packetStart, packetEnd);
    removed.add("paquete XMP");
    cursor = packetEnd + end.length;
  }

  if (indexOf(textEncoder.encode("/Info"), 0) !== -1) {
    remaining.add(
      "diccionario /Info (autor, programa, fechas): requiere una herramienta de PDF",
    );
  }

  return {
    bytes: removed.size > 0 ? output : bytes,
    removed: [...removed],
    remaining: [...remaining],
    // The format is understood, even when part of it cannot be cleaned here.
    supported: true,
    format: "pdf",
  };
}

// --- Entry points -----------------------------------------------------------

/** Removes embedded metadata containers from bytes when the format is known. */
export function scrubFileMetadata(bytes: Uint8Array): ScrubResult {
  switch (detectFormat(bytes)) {
    case "jpeg":
      return scrubJpeg(bytes);
    case "png":
      return scrubPng(bytes);
    case "webp":
      return scrubWebp(bytes);
    case "gif":
      return scrubGif(bytes);
    case "iso-bmff":
      return scrubIsoBmff(bytes);
    case "zip":
      return scrubZip(bytes);
    case "pdf":
      return scrubPdf(bytes);
    default:
      return unchanged(bytes, "unknown");
  }
}

/** Same as {@link scrubFileMetadata} but for the browser/Node `Blob` type. */
export async function scrubBlobMetadata(
  blob: Blob,
): Promise<{ blob: Blob } & Omit<ScrubResult, "bytes">> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const result = scrubFileMetadata(bytes);
  const { bytes: cleaned, ...rest } = result;
  return {
    blob:
      cleaned === bytes
        ? blob
        : new Blob([cleaned.slice().buffer], { type: blob.type }),
    ...rest,
  };
}

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/avif": "avif",
  "application/pdf": "pdf",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "audio/mpeg": "mp3",
  "text/plain": "txt",
  "application/zip": "zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
  "application/vnd.oasis.opendocument.text": "odt",
};

/**
 * Replaces a filename with a neutral one. Names leak surprisingly often:
 * `CV Ana Pereira 2026 - final (firmado).pdf` identifies a person before the
 * file is even opened.
 */
export function neutralFilename(mimeType: string, fallback = "bin"): string {
  const extension = EXTENSION_BY_MIME[mimeType.split(";")[0]?.trim() ?? ""];
  return `capsule.${extension ?? fallback}`;
}

/** Formats a mime type as a coarse family so the manifest reveals less. */
export function coarseMimeType(mimeType: string): string {
  const normalized = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  return normalized in EXTENSION_BY_MIME
    ? normalized
    : "application/octet-stream";
}
