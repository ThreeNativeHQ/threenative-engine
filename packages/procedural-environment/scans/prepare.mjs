// Rebuilds the vendored Poly Haven scans: node scans/prepare.mjs (needs network once).
// Each scan is the upstream 1K JPG, resized to 512 px wide and tiled down to Arbor's 1:2 bark
// aspect (Arbor's bark v runs twice the u tile), then WebP: colour and detail q75, normals q80,
// the smallest qualities that still read the same (PRD-900 compression study). A "detail" scan is the luminance
// scaled to a linear mean of 0.5, so a forest-kit piece keeps its vertex palette (COLOR_0 x 2).
import { writeFile } from "node:fs/promises";
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

for (const id of BARK)
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

for (const id of DETAIL) {
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
