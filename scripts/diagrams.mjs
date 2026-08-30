/**
 * Generates the diagrams in docs/diagrams.
 *
 * Written as a generator rather than hand-cut SVG for one reason: orthogonal
 * connectors with rounded corners are easy to get subtly wrong by hand, and a
 * diagonal line or a corner that does not meet is exactly the thing that makes
 * a diagram look careless. Geometry comes from `elbow()`; everything else is
 * layout on a 4px grid.
 *
 * Design rules followed here come from the diagram-design skill:
 * at most nine nodes and twelve arrows per diagram, at most two accent
 * elements, orthogonal connectors only, arrows drawn before boxes so they slide
 * under them, no shadows, corner radius at most 10, and an accessible SVG
 * contract (`role="img"`, `aria-labelledby`, a `<title>` as the first child and
 * a `<desc>` after it).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, "docs/diagrams");

const T = {
  ground: "#f3efe6",
  paper: "#fffdf8",
  ink: "#18352f",
  muted: "#6b7772",
  accent: "#ef7959",
  line: "#d5cec0",
  lineStrong: "#b9b1a0",
};

// Single quotes inside the stacks: these end up in double-quoted XML
// attributes, and a double quote there ends the attribute early.
const SANS = "Geist, 'Segoe UI', system-ui, -apple-system, sans-serif";
const MONO = "'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace";
const SERIF = "'Instrument Serif', Georgia, 'Times New Roman', serif";

const R = 8;

function escapeText(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/**
 * Builds an orthogonal path through axis-aligned waypoints, rounding every
 * corner with a quarter arc. Each segment must be horizontal or vertical; a
 * diagonal is a bug, so it throws rather than drawing one.
 */
function elbow(points) {
  for (let index = 1; index < points.length; index += 1) {
    const [x0, y0] = points[index - 1];
    const [x1, y1] = points[index];
    if (x0 !== x1 && y0 !== y1) {
      throw new Error(`Diagonal segment between ${x0},${y0} and ${x1},${y1}`);
    }
  }

  let path = `M ${points[0][0]} ${points[0][1]}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const [px, py] = points[index - 1];
    const [cx, cy] = points[index];
    const [nx, ny] = points[index + 1];

    const inX = Math.sign(cx - px);
    const inY = Math.sign(cy - py);
    const outX = Math.sign(nx - cx);
    const outY = Math.sign(ny - cy);

    const radius = Math.min(
      R,
      Math.abs(cx - px) / 2 + Math.abs(cy - py) / 2,
      Math.abs(nx - cx) / 2 + Math.abs(ny - cy) / 2,
    );

    const beforeX = cx - inX * radius;
    const beforeY = cy - inY * radius;
    const afterX = cx + outX * radius;
    const afterY = cy + outY * radius;

    // Cross product of the incoming and outgoing directions decides which way
    // the quarter turn sweeps in SVG's y-down coordinate system.
    const sweep = inX * outY - inY * outX > 0 ? 1 : 0;
    path += ` L ${beforeX} ${beforeY} A ${radius} ${radius} 0 0 ${sweep} ${afterX} ${afterY}`;
  }
  const last = points[points.length - 1];
  path += ` L ${last[0]} ${last[1]}`;
  return path;
}

/** Set per diagram: marker ids have to be unique inside one HTML document. */
let markerScope = "d";

function arrow(
  points,
  { label, dashed = false, accent = false, labelAt } = {},
) {
  const stroke = accent ? T.accent : T.lineStrong;
  const marker = accent
    ? `url(#tip-accent-${markerScope})`
    : `url(#tip-${markerScope})`;
  let svg =
    `<path d="${elbow(points)}" fill="none" stroke="${stroke}" ` +
    `stroke-width="1.25"${dashed ? ' stroke-dasharray="4 3"' : ""} ` +
    `marker-end="${marker}" />`;
  if (label) {
    const [lx, ly] = labelAt ?? midpoint(points);
    // The label sits on a mask of the page ground so the connector reads as
    // passing behind it rather than through it.
    const width = label.length * 4.6 + 10;
    svg +=
      `<rect x="${lx - width / 2}" y="${ly - 7}" width="${width}" height="14" ` +
      `fill="${T.ground}" />` +
      `<text x="${lx}" y="${ly + 3}" text-anchor="middle" font-family="${MONO}" ` +
      `font-size="8" fill="${T.muted}" letter-spacing="0.06em">${escapeText(label)}</text>`;
  }
  return svg;
}

function midpoint(points) {
  const first = points[0];
  const last = points[points.length - 1];
  return [(first[0] + last[0]) / 2, (first[1] + last[1]) / 2];
}

function node({ x, y, w, h, eyebrow, name, sub, accent = false }) {
  const stroke = accent ? T.accent : T.line;
  let svg =
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="8" ` +
    `fill="${T.paper}" stroke="${stroke}" stroke-width="${accent ? 1.5 : 1}" />`;
  const cx = x + w / 2;
  let cursor = y + 20;
  if (eyebrow) {
    svg +=
      `<text x="${cx}" y="${cursor}" text-anchor="middle" font-family="${MONO}" ` +
      `font-size="7.5" fill="${accent ? T.accent : T.muted}" letter-spacing="0.18em">` +
      `${escapeText(eyebrow.toUpperCase())}</text>`;
    cursor += 16;
  }
  svg +=
    `<text x="${cx}" y="${cursor}" text-anchor="middle" font-family="${SANS}" ` +
    `font-size="12" font-weight="600" fill="${T.ink}">${escapeText(name)}</text>`;
  if (sub) {
    cursor += 14;
    svg +=
      `<text x="${cx}" y="${cursor}" text-anchor="middle" font-family="${MONO}" ` +
      `font-size="9" fill="${T.muted}">${escapeText(sub)}</text>`;
  }
  return svg;
}

function frame({
  id,
  width,
  height,
  title,
  desc,
  eyebrow,
  heading,
  body,
  legend,
}) {
  const legendStrip = legend
    ? `<line x1="32" y1="${height - 46}" x2="${width - 32}" y2="${height - 46}" stroke="${T.line}" stroke-width="1" />` +
      legend
        .map(
          (entry, index) =>
            `<text x="${32 + index * Math.floor((width - 64) / legend.length)}" y="${height - 26}" ` +
            `font-family="${MONO}" font-size="8.5" fill="${T.muted}" letter-spacing="0.05em">` +
            `${escapeText(entry)}</text>`,
        )
        .join("")
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="${id}-title ${id}-desc">
<title id="${id}-title">${escapeText(title)}</title>
<desc id="${id}-desc">${escapeText(desc)}</desc>
<defs>
<marker id="tip-${id}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
<path d="M 0 1 L 7 4 L 0 7 z" fill="${T.lineStrong}" />
</marker>
<marker id="tip-accent-${id}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
<path d="M 0 1 L 7 4 L 0 7 z" fill="${T.accent}" />
</marker>
</defs>
<rect width="${width}" height="${height}" fill="${T.ground}" />
<text x="32" y="40" font-family="${MONO}" font-size="8" fill="${T.accent}" letter-spacing="0.24em">${escapeText(eyebrow.toUpperCase())}</text>
<text x="32" y="72" font-family="${SERIF}" font-size="28" font-weight="400" fill="${T.ink}">${escapeText(heading)}</text>
${body}
${legendStrip}
</svg>
`;
}

// --- 1. How a capsule travels ------------------------------------------------

function capsuleFlow() {
  markerScope = "capsule-flow";
  const width = 920;
  const height = 340;
  const w = 132;
  const h = 56;
  const rowY = 196;
  const rowMid = rowY + h / 2;
  const xs = [44, 218, 392, 566, 740];

  const keyY = 128;
  const linkX = 392;

  const arrows = [
    arrow([
      [xs[0] + w, rowMid],
      [xs[1], rowMid],
    ]),
    arrow(
      [
        [xs[1] + w, rowMid],
        [xs[2], rowMid],
      ],
      { label: "ciphertext" },
    ),
    arrow(
      [
        [xs[2] + w, rowMid],
        [xs[3], rowMid],
      ],
      { label: "ciphertext" },
    ),
    arrow([
      [xs[3] + w, rowMid],
      [xs[4], rowMid],
    ]),
    arrow(
      [
        [xs[1] + w / 2, rowY],
        [xs[1] + w / 2, keyY + h / 2],
        [linkX, keyY + h / 2],
      ],
      { label: "key", accent: true, labelAt: [xs[1] + w / 2, 168] },
    ),
    arrow(
      [
        [linkX + w, keyY + h / 2],
        [xs[3] + w / 2, keyY + h / 2],
        [xs[3] + w / 2, rowY],
      ],
      { label: "key", accent: true, labelAt: [xs[3] + w / 2, 168] },
    ),
  ].join("");

  const nodes = [
    node({ x: xs[0], y: rowY, w, h, eyebrow: "sender", name: "Your file" }),
    node({
      x: xs[1],
      y: rowY,
      w,
      h,
      eyebrow: "in your browser",
      name: "Encrypted",
      sub: "AES-256-GCM",
    }),
    node({
      x: xs[2],
      y: rowY,
      w,
      h,
      eyebrow: "relay",
      name: "Stores bytes",
      sub: "cannot read",
    }),
    node({
      x: xs[3],
      y: rowY,
      w,
      h,
      eyebrow: "in their browser",
      name: "Decrypted",
    }),
    node({ x: xs[4], y: rowY, w, h, eyebrow: "receiver", name: "The file" }),
    node({
      x: linkX,
      y: keyY,
      w,
      h,
      eyebrow: "the link you send",
      name: "#fragment",
      sub: "never sent to a server",
      accent: true,
    }),
  ].join("");

  return frame({
    id: "capsule-flow",
    width,
    height,
    eyebrow: "capsule",
    heading: "The key goes around the relay, not through it",
    title: "How a capsule travels",
    desc:
      "A file is encrypted in the sender's browser. The ciphertext goes to a relay and on to the receiver. " +
      "The key travels separately, inside the fragment of the share link, which browsers never send to a server. " +
      "The relay therefore stores bytes it cannot read.",
    body: arrows + nodes,
    legend: [
      "Solid — ciphertext, over the network",
      "Coral — the key, out of band",
      "The relay never holds both",
    ],
  });
}

// --- 2. The mix network ------------------------------------------------------

function mixNetwork() {
  markerScope = "mix-network";
  const width = 920;
  const height = 360;
  const w = 128;
  const h = 56;
  const rowY = 152;
  const rowMid = rowY + h / 2;
  const xs = [44, 216, 388, 560, 732];
  const backY = 268;

  const arrows = [
    arrow([
      [xs[0] + w, rowMid],
      [xs[1], rowMid],
    ]),
    arrow([
      [xs[1] + w, rowMid],
      [xs[2], rowMid],
    ]),
    arrow([
      [xs[2] + w, rowMid],
      [xs[3], rowMid],
    ]),
    arrow([
      [xs[3] + w, rowMid],
      [xs[4], rowMid],
    ]),
    arrow(
      [
        [xs[4] + w / 2, rowY + h],
        [xs[4] + w / 2, backY],
        [xs[2] + w, backY],
      ],
      {
        label: "reply, by a path it cannot see",
        dashed: true,
        labelAt: [640, backY],
      },
    ),
    arrow(
      [
        [xs[2], backY],
        [xs[0] + w / 2, backY],
        [xs[0] + w / 2, rowY + h],
      ],
      { label: "you collect it", dashed: true, labelAt: [216, backY] },
    ),
  ].join("");

  const nodes = [
    node({
      x: xs[0],
      y: rowY,
      w,
      h,
      eyebrow: "you",
      name: "Your client",
      sub: "one layer per hop",
      accent: true,
    }),
    node({
      x: xs[1],
      y: rowY,
      w,
      h,
      eyebrow: "hop 1",
      name: "Sees your address",
      sub: "and nothing else",
    }),
    node({
      x: xs[2],
      y: rowY,
      w,
      h,
      eyebrow: "hop 2",
      name: "Sees two hops",
      sub: "neither end",
    }),
    node({
      x: xs[3],
      y: rowY,
      w,
      h,
      eyebrow: "hop 3",
      name: "Sees the relay",
      sub: "not you",
    }),
    node({
      x: xs[4],
      y: rowY,
      w,
      h,
      eyebrow: "destination",
      name: "Storage relay",
      sub: "no client address",
      accent: true,
    }),
    node({
      x: xs[2],
      y: backY - h / 2,
      w,
      h,
      eyebrow: "mailbox",
      name: "Holds the answer",
      sub: "you poll it",
    }),
  ].join("");

  return frame({
    id: "mix-network",
    width,
    height,
    eyebrow: "mix network",
    heading: "Every hop knows one step, and no hop knows two",
    title: "How a request travels through the mix network",
    desc:
      "A request is wrapped in a layer for each hop. The first hop sees the client's address, the middle hops " +
      "see only their neighbours, and the storage relay sees a request with no client attached. The reply comes " +
      "back along a second path the relay cannot see, into a mailbox the client polls.",
    body: arrows + nodes,
    legend: [
      "Coral — the two ends, which never meet",
      "Dashed — the reply, along a path the sender chose",
      "Each hop waits a random time before forwarding",
    ],
  });
}

// --- 3. A .capsule site ------------------------------------------------------

function capsuleSite() {
  markerScope = "capsule-site";
  const width = 920;
  const height = 400;
  const w = 148;
  const h = 60;
  const topY = 132;
  const bottomY = 268;
  const topMid = topY + h / 2;
  const bottomMid = bottomY + h / 2;
  const xs = [44, 252, 460, 668];

  const arrows = [
    arrow(
      [
        [xs[0] + w, topMid],
        [xs[1], topMid],
      ],
      { label: "pack" },
    ),
    arrow(
      [
        [xs[1] + w, topMid],
        [xs[2], topMid],
      ],
      { label: "encrypt" },
    ),
    arrow(
      [
        [xs[2] + w, topMid],
        [xs[3], topMid],
      ],
      { label: "sign", accent: true },
    ),
    arrow(
      [
        [xs[3] + w / 2, topY + h],
        [xs[3] + w / 2, bottomMid],
        [xs[2] + w, bottomMid],
      ],
      { label: "relays hand it out", labelAt: [xs[3] + w / 2, 226] },
    ),
    arrow(
      [
        [xs[2], bottomMid],
        [xs[1] + w, bottomMid],
      ],
      { label: "verify" },
    ),
    arrow(
      [
        [xs[1], bottomMid],
        [xs[0] + w, bottomMid],
      ],
      { label: "decrypt" },
    ),
  ].join("");

  const nodes = [
    node({
      x: xs[0],
      y: topY,
      w,
      h,
      eyebrow: "publisher",
      name: "A folder of files",
      sub: "index.html and friends",
    }),
    node({
      x: xs[1],
      y: topY,
      w,
      h,
      eyebrow: "bundle",
      name: "One capsule",
      sub: "padded to a size class",
    }),
    node({
      x: xs[2],
      y: topY,
      w,
      h,
      eyebrow: "relays",
      name: "Ciphertext only",
      sub: "mirrored, or sharded",
    }),
    node({
      x: xs[3],
      y: topY,
      w,
      h,
      eyebrow: "the name is the key",
      name: "Signed record",
      sub: "<key>.capsule",
      accent: true,
    }),
    node({
      x: xs[2],
      y: bottomY,
      w,
      h,
      eyebrow: "visitor asks",
      name: "Several relays",
      sub: "newest signed wins",
    }),
    node({
      x: xs[1],
      y: bottomY,
      w,
      h,
      eyebrow: "in the browser",
      name: "Checked, then read",
      sub: "no rollback accepted",
    }),
    node({
      x: xs[0],
      y: bottomY,
      w,
      h,
      eyebrow: "what you see",
      name: "Sandboxed page",
      sub: "cannot reach the web",
    }),
  ].join("");

  return frame({
    id: "capsule-site",
    width,
    height,
    eyebrow: "sites",
    heading: "A name nobody issues, a page nobody can rewrite",
    title: "How a .capsule site is published and read",
    desc:
      "Publishing packs a folder into one encrypted capsule, stores it on relays, and signs a record saying " +
      "which capsule is the current version of the name. The name itself is the public key, so the signature " +
      "can be checked without trusting anyone. A visitor asks several relays, keeps the newest record that " +
      "verifies, refuses an older one, and renders the page in a sandbox with no network access at all.",
    body: arrows + nodes,
    legend: [
      "Top — publishing, once per update",
      "Bottom — visiting, every time",
      "Coral — the only thing that has to be trusted: the key",
    ],
  });
}

await mkdir(out, { recursive: true });
const files = {
  "capsule-flow": capsuleFlow(),
  "mix-network": mixNetwork(),
  "capsule-site": capsuleSite(),
};
for (const [name, svg] of Object.entries(files)) {
  await writeFile(join(out, `${name}.svg`), svg, "utf8");
  console.log(`${name}.svg  ${svg.length} bytes`);
}

// The showcase page carries the same diagrams inline, so that a single file is
// the whole page. Injecting them here means the two can never drift apart.
const showcasePath = join(root, "docs/index.html");
let showcase = await readFile(showcasePath, "utf8");
let injected = 0;
for (const [name, svg] of Object.entries(files)) {
  const start = `<!-- diagram:${name}:start -->`;
  const end = `<!-- diagram:${name}:end -->`;
  const from = showcase.indexOf(start);
  const to = showcase.indexOf(end);
  if (from < 0 || to < 0) continue;
  // The XML declaration and the outer width/height are dropped: inline SVG
  // scales from its viewBox, and a fixed width would break the layout.
  const inline = svg.replace(/ width="\d+" height="\d+"/, "").trim();
  showcase =
    showcase.slice(0, from + start.length) +
    "\n" +
    inline +
    "\n" +
    showcase.slice(to);
  injected += 1;
}
await writeFile(showcasePath, showcase, "utf8");
console.log(`docs/index.html  ${injected} diagram(s) inlined`);
