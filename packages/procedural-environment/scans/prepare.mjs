// Rebuilds the vendored Poly Haven scans: node scans/prepare.mjs (needs network once).
// Each scan is the upstream 1K JPG, resized to 512 px wide and tiled down to Arbor's 1:2 bark
// aspect (Arbor's bark v runs twice the u tile), then WebP: colour and detail q75, normals q80,
// the smallest qualities that still read the same (PRD-900 compression study). A "detail" scan is the luminance
// scaled to a linear mean of 0.5, so a forest-kit piece keeps its vertex palette (COLOR_0 x 2).
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";

const BARK = [
  "jolcham_oak_bark_01",
  "chinese_hackberry_bark",
  "knotted_pine_bark",
  "pine_bark",
  "metasequoia_bark",
  "japanese_cedar_bark",
  "tree_bark_03",
  "bark_willow_02",
  "japanese_camphor_bark",
  "bark_brown_01",
  "palm_bark",
  "sakura_bark",
];
const DETAIL = ["bark_brown_02", "rock_boulder_dry"];
const url = (id, map) =>
  `https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/${id}/${id}_${map}_1k.jpg`;
const here = new URL(".", import.meta.url).pathname;
// `node scans/prepare.mjs foliage` rebuilds only the foliage sprites below.
const barkToo = process.argv[2] !== "foliage";

async function get(id, map) {
  const res = await fetch(url(id, map));
  if (!res.ok) throw new Error(`${url(id, map)}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** 512 wide, repeated vertically until it is twice as tall as wide (a 1:2 scan is already). */
async function barkTile(jpg) {
  const { data, info } = await sharp(jpg)
    .resize(512)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rows = Math.round(1024 / info.height);
  const raw = Buffer.concat(Array.from({ length: rows }, () => data)).subarray(0, 512 * 1024 * 3);
  return sharp(raw, { raw: { width: 512, height: 1024, channels: 3 } });
}

for (const id of barkToo ? BARK : [])
  for (const [map, name] of [
    ["diff", "color"],
    ["nor_gl", "normal"],
  ])
    await writeFile(
      `${here}${id}-${name}.webp`,
      await (await barkTile(await get(id, map)))
        .webp({ quality: name === "normal" ? 80 : 75, effort: 6 })
        .toBuffer(),
    );

for (const id of barkToo ? DETAIL : []) {
  const { data } = await sharp(await get(id, "diff"))
    .resize(512)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const linear = (v) => (v / 255) ** 2.2;
  let mean = 0;
  for (const v of data) mean += linear(v);
  const k = 0.5 / (mean / data.length);
  const out = Buffer.from(
    data.map((v) => Math.round(255 * Math.min(1, linear(v) * k) ** (1 / 2.2))),
  );
  await writeFile(
    `${here}${id}-detail.webp`,
    await sharp(out, { raw: { width: 512, height: 512, channels: 1 } })
      .webp({ quality: 75, effort: 6 })
      .toBuffer(),
  );
  await writeFile(
    `${here}${id}-normal.webp`,
    await sharp(await get(id, "nor_gl"))
      .resize(512)
      .webp({ quality: 80, effort: 6 })
      .toBuffer(),
  );
}

// Foliage sprites: single leaves, blades, fronds and needle sprigs cut from CC0 alpha atlases
// (Poly Haven plant models first, ambientCG leaf sets where Poly Haven has no such leaf). Each cut is
// the largest alpha island inside a source rectangle (1K maps), turned so its base points down,
// fitted to one cell (centred, base on the bottom edge) and laid out in a strip. Colour under zero
// alpha is the leaf's mean colour (no dark fringe). WebP q75 with lossless alpha: a cutout stays exact.
const ph = (id, map) => ({
  diff: `https://dl.polyhaven.org/file/ph-assets/Models/png/1k/${id}/${id}_${map}diff_1k.png`,
  alpha: `https://dl.polyhaven.org/file/ph-assets/Models/png/1k/${id}/${id}_${map}alpha_1k.png`,
});
const acg = (id) => ({ zip: `https://ambientcg.com/get?file=${id}_1K-PNG.zip`, id });
// id: source, cell [w, h], turn (sharp rotate degrees), fill (a blade straightened into an opaque
// strip), cuts [x, y, w, h].
const FOLIAGE = {
  "shrub_01-leaves": {
    src: ph("shrub_01", ""),
    cell: [128, 192],
    cuts: [
      [450, 0, 251, 414],
      [694, 404, 254, 382],
      [206, 420, 278, 404],
    ],
  },
  "island_tree_01-leaves": {
    src: ph("island_tree_01", "leaves_"),
    cell: [96, 256],
    cuts: [
      [169, 21, 176, 380],
      [530, 51, 134, 320],
      [17, 21, 131, 502],
    ],
  },
  "shrub_02-leaves": {
    src: ph("shrub_02", ""),
    cell: [64, 256],
    cuts: [
      [533, 326, 160, 594],
      [686, 420, 126, 421],
      [843, 371, 121, 466],
    ],
  },
  "jacaranda_tree-leaves": {
    src: ph("jacaranda_tree", "leaves_"),
    cell: [144, 272],
    turn: 90,
    cuts: [
      [165, 25, 847, 458],
      [251, 604, 773, 414],
    ],
  },
  "grass_medium_02-blade": {
    src: ph("grass_medium_02", ""),
    cell: [48, 512],
    fill: true,
    cuts: [[896, 38, 107, 985]],
  },
  "fern_02-frond": {
    src: ph("fern_02", ""),
    cell: [96, 512],
    cuts: [
      [91, 114, 149, 857],
      [321, 25, 145, 757],
      [731, 112, 126, 805],
    ],
  },
  "pine_tree_01-sprig": {
    src: ph("pine_tree_01", "twig_"),
    cell: [176, 288],
    turn: 270,
    cuts: [[667, 350, 291, 180]],
  },
  "LeafSet016-leaves": {
    src: acg("LeafSet016"),
    cell: [128, 192],
    cuts: [
      [47, 35, 222, 433],
      [346, 48, 263, 389],
      [37, 573, 289, 394],
      [391, 585, 250, 372],
    ],
  },
  "LeafSet027-leaves": { src: acg("LeafSet027"), cell: [192, 224], cuts: [[400, 367, 227, 299]] },
  "LeafSet012-leaves": {
    src: acg("LeafSet012"),
    cell: [128, 224],
    turn: 270,
    cuts: [
      [97, 300, 317, 163],
      [575, 560, 395, 177],
    ],
  },
};

async function maps({ diff, alpha, zip, id }) {
  if (diff) return { diff: await fetchBytes(diff), alpha: await fetchBytes(alpha) };
  const dir = await mkdtemp(path.join(tmpdir(), "tn-acg-"));
  const file = path.join(dir, `${id}.zip`);
  await writeFile(file, await fetchBytes(zip));
  const member = (name) => execFileSync("unzip", ["-p", file, `${id}_1K-PNG_${name}.png`]);
  const out = { diff: member("Color"), alpha: member("Opacity") };
  await rm(dir, { recursive: true });
  return out;
}

async function fetchBytes(href) {
  const res = await fetch(href);
  if (!res.ok) throw new Error(`${href}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Labels the 4-connected island of alpha over half that holds texel s with id s; its size. */
function flood(a, w, label, s) {
  const stack = [s];
  label[s] = s;
  let size = 0;
  while (stack.length) {
    const p = stack.pop();
    size++;
    const px = p % w;
    for (const q of [px > 0 ? p - 1 : -1, px < w - 1 ? p + 1 : -1, p - w, p + w])
      if (q >= 0 && q < label.length && a[q] >= 128 && label[q] < 0) {
        label[q] = s;
        stack.push(q);
      }
  }
  return size;
}

/** Each texel's island id (alpha over half, 4-connected) and the id of the largest island. */
function largestIsland(a, w, h) {
  const label = new Int32Array(w * h).fill(-1);
  let best = -1;
  let bestSize = 0;
  for (let s = 0; s < w * h; s++) {
    if (a[s] < 128 || label[s] >= 0) continue;
    const size = flood(a, w, label, s);
    if (size > bestSize) [best, bestSize] = [s, size];
  }
  return { label, best };
}

/** Whether texel (px, py) lies within 2 texels of the island `id`. */
function nearIsland(label, w, h, px, py, id) {
  for (let dy = -2; dy <= 2; dy++)
    for (let dx = -2; dx <= 2; dx++) {
      const qx = px + dx;
      const qy = py + dy;
      if (qx >= 0 && qy >= 0 && qx < w && qy < h && label[qy * w + qx] === id) return true;
    }
  return false;
}

/** One cut as an RGBA cell: the rectangle's largest alpha island, turned, fitted, fringe-free. */
async function cutCell(src, [x, y, w, h], { cell: [cw, ch], turn = 0, fill = false }) {
  const rect = { left: x, top: y, width: w, height: h };
  const rgb = await sharp(src.diff).removeAlpha().extract(rect).raw().toBuffer();
  const a = await sharp(src.alpha).extractChannel(0).extract(rect).raw().toBuffer();
  const { label, best } = largestIsland(a, w, h);
  // Keep the island and its soft edge (2 px), drop every other island in the rectangle.
  const rgba = Buffer.alloc(w * h * 4);
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let n = 0;
  for (let p = 0; p < w * h; p++) {
    const alpha = nearIsland(label, w, h, p % w, (p / w) | 0, best) ? a[p] : 0;
    rgba[p * 4 + 3] = alpha;
    if (alpha > 128) {
      sr += rgb[p * 3];
      sg += rgb[p * 3 + 1];
      sb += rgb[p * 3 + 2];
      n++;
    }
  }
  for (let p = 0; p < w * h; p++) {
    const k = rgba[p * 4 + 3] / 255;
    rgba[p * 4] = Math.round(sr / n + (rgb[p * 3] - sr / n) * k);
    rgba[p * 4 + 1] = Math.round(sg / n + (rgb[p * 3 + 1] - sg / n) * k);
    rgba[p * 4 + 2] = Math.round(sb / n + (rgb[p * 3 + 2] - sb / n) * k);
  }
  if (fill) return straightened(rgba, w, h, cw, ch);
  const mean = { r: Math.round(sr / n), g: Math.round(sg / n), b: Math.round(sb / n), alpha: 0 };
  const turned = await sharp(rgba, { raw: { width: w, height: h, channels: 4 } })
    .rotate(turn)
    .trim({ background: { ...mean, alpha: 0 }, threshold: 1 })
    .png()
    .toBuffer();
  return sharp(turned)
    .resize(cw, ch, { fit: "contain", position: "bottom", background: mean })
    .ensureAlpha()
    .raw()
    .toBuffer();
}

/**
 * A blade straightened into an opaque cw x ch strip: each row's opaque span, from its first to its
 * last texel over half alpha, stretched across the strip. A curved or slanted blade becomes the
 * straight strip a blade card's own outline cuts.
 */
function straightened(rgba, w, h, cw, ch) {
  const rows = [];
  for (let y = 0; y < h; y++) {
    let x0 = -1;
    let x1 = -1;
    for (let x = 0; x < w; x++)
      if (rgba[(y * w + x) * 4 + 3] > 128) {
        if (x0 < 0) x0 = x;
        x1 = x;
      }
    if (x0 >= 0) rows.push([y, x0, x1]);
  }
  const out = Buffer.alloc(cw * ch * 4);
  for (let y = 0; y < ch; y++) {
    // The last 5 % at each end (a dry tip, a cut base) is left out.
    const at = Math.floor(rows.length * (0.05 + (0.9 * y) / ch));
    const [row, x0, x1] = rows[at];
    for (let x = 0; x < cw; x++) {
      const p = (row * w + Math.round(x0 + ((x + 0.5) / cw) * (x1 - x0))) * 4;
      rgba.copy(out, (y * cw + x) * 4, p, p + 3);
      out[(y * cw + x) * 4 + 3] = 255;
    }
  }
  return out;
}

for (const [id, spec] of Object.entries(FOLIAGE)) {
  const src = await maps(spec.src);
  const [cw, ch] = spec.cell;
  const cells = [];
  for (const cut of spec.cuts) cells.push(await cutCell(src, cut, spec));
  const strip = Buffer.alloc(cw * ch * 4 * cells.length);
  cells.forEach((cell, i) => {
    for (let row = 0; row < ch; row++)
      cell.copy(strip, (row * cw * cells.length + i * cw) * 4, row * cw * 4, (row + 1) * cw * 4);
  });
  await writeFile(
    `${here}${id}.webp`,
    await sharp(strip, { raw: { width: cw * cells.length, height: ch, channels: 4 } })
      .webp({ quality: 75, alphaQuality: 100, effort: 6 })
      .toBuffer(),
  );
}
