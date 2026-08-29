import { describe, expect, it } from "vitest";
import {
  coarseMimeType,
  neutralFilename,
  scrubFileMetadata,
} from "../src/anonymize.js";

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function jpegSegment(marker: number, payload: Uint8Array): Uint8Array {
  const segment = new Uint8Array(payload.length + 4);
  segment[0] = 0xff;
  segment[1] = marker;
  segment[2] = (payload.length + 2) >> 8;
  segment[3] = (payload.length + 2) & 0xff;
  segment.set(payload, 4);
  return segment;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(data.length + 12);
  new DataView(chunk.buffer).setUint32(0, data.length);
  for (let index = 0; index < 4; index += 1) {
    chunk[4 + index] = type.charCodeAt(index);
  }
  chunk.set(data, 8);
  return chunk;
}

function isoBox(type: string, payload: Uint8Array): Uint8Array {
  const box = new Uint8Array(payload.length + 8);
  new DataView(box.buffer).setUint32(0, box.length);
  for (let index = 0; index < 4; index += 1) {
    box[4 + index] = type.charCodeAt(index);
  }
  box.set(payload, 8);
  return box;
}

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
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Builds a minimal store-only ZIP so the scrubber can be tested end to end. */
function buildZip(files: Array<{ name: string; content: string }>): Uint8Array {
  const locals: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;

  for (const file of files) {
    const name = text(file.name);
    const data = text(file.content);
    const crc = crc32(data);

    const header = new Uint8Array(30 + name.length);
    const headerView = new DataView(header.buffer);
    headerView.setUint32(0, 0x04034b50, true);
    headerView.setUint16(4, 20, true);
    headerView.setUint16(10, 0x1234, true); // A real timestamp to be erased.
    headerView.setUint16(12, 0x5678, true);
    headerView.setUint32(14, crc, true);
    headerView.setUint32(18, data.length, true);
    headerView.setUint32(22, data.length, true);
    headerView.setUint16(26, name.length, true);
    header.set(name, 30);

    const entry = new Uint8Array(46 + name.length);
    const entryView = new DataView(entry.buffer);
    entryView.setUint32(0, 0x02014b50, true);
    entryView.setUint16(4, 20, true);
    entryView.setUint16(6, 20, true);
    entryView.setUint16(12, 0x1234, true);
    entryView.setUint16(14, 0x5678, true);
    entryView.setUint32(16, crc, true);
    entryView.setUint32(20, data.length, true);
    entryView.setUint32(24, data.length, true);
    entryView.setUint16(28, name.length, true);
    entryView.setUint32(42, offset, true);
    entry.set(name, 46);

    locals.push(header, data);
    directory.push(entry);
    offset += header.length + data.length;
  }

  const directoryBytes = concat(directory);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, directoryBytes.length, true);
  endView.setUint32(16, offset, true);

  return concat([...locals, directoryBytes, end]);
}

/** Reads back a store-only ZIP so tests can assert on its contents. */
function readZip(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const files = new Map<string, string>();
  let offset = 0;
  while (
    offset + 30 <= bytes.length &&
    view.getUint32(offset, true) === 0x04034b50
  ) {
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const name = decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    const dataStart = offset + 30 + nameLength + extraLength;
    files.set(
      name,
      decode(bytes.subarray(dataStart, dataStart + compressedSize)),
    );
    offset = dataStart + compressedSize;
  }
  return files;
}

describe("image anonymisation", () => {
  it("removes EXIF and comments from a JPEG while keeping the image data", () => {
    const jpeg = concat([
      new Uint8Array([0xff, 0xd8]),
      jpegSegment(0xe0, text("JFIF structural")),
      jpegSegment(0xe1, text("Exif  GPS 34.9011 S, 56.1645 W")),
      jpegSegment(0xfe, text("Camera serial 0xDEADBEEF")),
      jpegSegment(0xdb, text("quantisation")),
      new Uint8Array([0xff, 0xda]),
      text("entropy coded image data"),
      new Uint8Array([0xff, 0xd9]),
    ]);

    const result = scrubFileMetadata(jpeg);
    const cleaned = decode(result.bytes);

    expect(result.supported).toBe(true);
    expect(result.removed.length).toBeGreaterThan(0);
    expect(cleaned).not.toContain("GPS 34.9011");
    expect(cleaned).not.toContain("Camera serial");
    expect(cleaned).toContain("JFIF");
    expect(cleaned).toContain("entropy coded image data");
  });

  it("removes PNG text chunks and keeps the image chunks", () => {
    const png = concat([
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      pngChunk("IHDR", text("header--")),
      pngChunk("tEXt", text("Author Ana Pereira")),
      pngChunk("eXIf", text("gps")),
      pngChunk("IDAT", text("pixels")),
      pngChunk("IEND", new Uint8Array(0)),
    ]);

    const result = scrubFileMetadata(png);
    const cleaned = decode(result.bytes);

    expect(result.removed).toContain("chunk tEXt");
    expect(result.removed).toContain("chunk eXIf");
    expect(cleaned).not.toContain("Ana Pereira");
    expect(cleaned).toContain("pixels");
  });

  it("removes GIF comments but keeps the animation loop extension", () => {
    const comment = concat([
      new Uint8Array([0x21, 0xfe, 13]),
      text("Hecho por Ana"),
      new Uint8Array([0x00]),
    ]);
    const loop = concat([
      new Uint8Array([0x21, 0xff, 11]),
      text("NETSCAPE2.0"),
      new Uint8Array([3, 1, 0, 0, 0x00]),
    ]);
    const image = new Uint8Array([
      0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x00, 0x02, 2, 0x44, 0x01, 0x00,
    ]);
    const gif = concat([
      text("GIF89a"),
      new Uint8Array([1, 0, 1, 0, 0x00, 0, 0]),
      comment,
      loop,
      image,
      new Uint8Array([0x3b]),
    ]);

    const result = scrubFileMetadata(gif);
    const cleaned = decode(result.bytes);

    expect(result.supported).toBe(true);
    expect(result.removed).toContain("comentario GIF");
    expect(cleaned).not.toContain("Hecho por Ana");
    expect(cleaned).toContain("NETSCAPE2.0");
  });
});

describe("video and container anonymisation", () => {
  it("blanks MP4 metadata boxes without moving any byte", () => {
    const udta = isoBox("udta", text("(c)xyz +34.9011-056.1645/ iPhone 15"));
    const mvhd = isoBox("mvhd", text("movie header stays"));
    const moov = isoBox("moov", concat([mvhd, udta]));
    const mp4 = concat([
      isoBox("ftyp", text("isom")),
      moov,
      isoBox("mdat", text("media samples")),
    ]);

    const result = scrubFileMetadata(mp4);
    const cleaned = decode(result.bytes);

    expect(result.supported).toBe(true);
    expect(result.removed.some((entry) => entry.includes("udta"))).toBe(true);
    // Byte-for-byte the same length: sample tables hold absolute offsets.
    expect(result.bytes.byteLength).toBe(mp4.byteLength);
    expect(cleaned).not.toContain("iPhone 15");
    expect(cleaned).not.toContain("+34.9011");
    expect(cleaned).toContain("movie header stays");
    expect(cleaned).toContain("media samples");
    expect(cleaned).toContain("free");
  });

  it("keeps the top-level meta box of a HEIC file, which holds the image", () => {
    const heic = concat([
      isoBox("ftyp", text("heic")),
      isoBox("meta", text("item structure of the picture")),
      isoBox("mdat", text("pixels")),
    ]);

    const result = scrubFileMetadata(heic);

    expect(result.bytes).toBe(heic);
    expect(result.remaining.length).toBeGreaterThan(0);
    expect(decode(result.bytes)).toContain("item structure of the picture");
  });

  it("empties Office document properties and normalises timestamps", () => {
    const zip = buildZip([
      { name: "[Content_Types].xml", content: "<Types/>" },
      {
        name: "docProps/core.xml",
        content:
          "<cp:coreProperties><dc:creator>Ana Pereira</dc:creator><cp:lastModifiedBy>Ana Pereira</cp:lastModifiedBy></cp:coreProperties>",
      },
      {
        name: "docProps/app.xml",
        content: "<Properties><Company>Estudio Jurídico</Company></Properties>",
      },
      {
        name: "word/document.xml",
        content: "<w:document>contenido</w:document>",
      },
    ]);

    const result = scrubFileMetadata(zip);
    const files = readZip(result.bytes);

    expect(result.supported).toBe(true);
    expect(result.removed.length).toBeGreaterThan(0);
    expect(files.get("word/document.xml")).toBe(
      "<w:document>contenido</w:document>",
    );
    expect(files.get("docProps/core.xml")).not.toContain("Ana Pereira");
    expect(files.get("docProps/app.xml")).not.toContain("Estudio Jurídico");
    // The parts are still present, so the relationships that point at them
    // remain valid and the document still opens.
    expect(files.has("docProps/core.xml")).toBe(true);
    expect(decode(result.bytes)).not.toContain("Ana Pereira");

    const view = new DataView(result.bytes.buffer, result.bytes.byteOffset);
    expect(view.getUint16(10, true)).toBe(0);
    expect(view.getUint16(12, true)).toBe(0x0021);
  });
});

describe("PDF anonymisation", () => {
  it("blanks XMP packets in place and reports what it cannot remove", () => {
    const pdf = concat([
      text("%PDF-1.7\n"),
      text('<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>'),
      text("<x:xmpmeta><dc:creator>Ana Pereira</dc:creator></x:xmpmeta>"),
      text('<?xpacket end="w"?>'),
      text("\n1 0 obj<</Info 2 0 R>>endobj\n%%EOF"),
    ]);

    const result = scrubFileMetadata(pdf);
    const cleaned = decode(result.bytes);

    expect(result.supported).toBe(true);
    expect(result.removed).toContain("paquete XMP");
    expect(cleaned).not.toContain("Ana Pereira");
    // Blanking preserves every byte offset, so the cross-reference table and
    // the object lengths in the file stay correct.
    expect(result.bytes.byteLength).toBe(pdf.byteLength);
    expect(result.remaining.join(" ")).toContain("/Info");
  });
});

describe("naming", () => {
  it("replaces identifying filenames with a neutral one", () => {
    expect(neutralFilename("image/jpeg")).toBe("capsule.jpg");
    expect(neutralFilename("video/quicktime")).toBe("capsule.mov");
    expect(neutralFilename("application/x-unknown")).toBe("capsule.bin");
    expect(coarseMimeType("image/png; charset=binary")).toBe("image/png");
    expect(coarseMimeType("application/x-unknown")).toBe(
      "application/octet-stream",
    );
  });

  it("reports formats it does not understand instead of pretending", () => {
    const bytes = text("not a known container at all");
    const result = scrubFileMetadata(bytes);
    expect(result.supported).toBe(false);
    expect(result.removed).toEqual([]);
    expect(result.bytes).toBe(bytes);
  });
});
