// Rebuilds the Toybox kit textures: node scans/toybox.mjs <dir of meta/muse-image PNGs>.
// Sources (credits.json "toybox"): Poly Haven CC0 scans restyled by meta/muse-image to the kit's
// toy-realism look, plus three generated backdrops. Each texture becomes a 512 px tileable
// "detail" map (luminance scaled to a linear mean of 0.5, so the vertex palette keeps the colour)
// and a normal map derived from that luminance. Backdrops are 2048 x 1024 sky panoramas.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const src = process.argv[2];
if (!src)
  throw new Error(
    "usage: node scans/toybox.mjs <dir with rock.png soil.png planks.png metal.png garden.png frost.png sand.png>",
  );
const here = new URL(".", import.meta.url).pathname;
const N = 512;

/** Cross-fade a half-offset copy into a border band so the tile wraps without a seam. */
function tileable(px) {
  const out = new Float32Array(px.length);
  const band = N * 0.18;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const edge = Math.min(x, y, N - 1 - x, N - 1 - y);
      const w = Math.min(1, edge / band);
      const shifted = px[((y + N / 2) % N) * N + ((x + N / 2) % N)];
      out[y * N + x] = px[y * N + x] * w + shifted * (1 - w);
    }
  return out;
}

for (const id of ["rock", "soil", "planks", "metal"]) {
  const { data } = await sharp(path.join(src, `${id}.png`))
    .resize(N, N)
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const linear = tileable(Float32Array.from(data, (v) => (v / 255) ** 2.2));
  let mean = 0;
  for (const v of linear) mean += v;
  const k = 0.5 / (mean / linear.length);
  const detail = Buffer.from(linear.map((v) => Math.round(255 * Math.min(1, v * k) ** (1 / 2.2))));
  await writeFile(
    `${here}toybox_${id}-detail.webp`,
    await sharp(detail, { raw: { width: N, height: N, channels: 1 } })
      .webp({ quality: 78, effort: 6 })
      .toBuffer(),
  );
  // Height from luminance, central differences with wrap, OpenGL green-up normals.
  const h = (x, y) => linear[((y + N) % N) * N + ((x + N) % N)];
  const strength = id === "metal" ? 3 : 6;
  const normal = Buffer.alloc(N * N * 3);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const dx = (h(x + 1, y) - h(x - 1, y)) * strength;
      const dy = (h(x, y - 1) - h(x, y + 1)) * strength;
      const l = Math.hypot(dx, dy, 1);
      normal.set(
        [(-dx / l) * 127.5 + 127.5, (-dy / l) * 127.5 + 127.5, (1 / l) * 127.5 + 127.5],
        (y * N + x) * 3,
      );
    }
  await writeFile(
    `${here}toybox_${id}-normal.webp`,
    await sharp(normal, { raw: { width: N, height: N, channels: 3 } })
      .webp({ quality: 80, effort: 6 })
      .toBuffer(),
  );
}

// Backdrops: a square plate (sky above, horizon at the middle, cloud below) becomes a 2:1
// equirectangular panorama. The plate and its mirror sit side by side, so it wraps without a
// seam; a blur keeps it out of focus; rows next to each pole blend to their mean, so the poles
// do not pinch.
const P = 1024;
for (const id of ["garden", "frost", "sand"]) {
  const plate = await sharp(path.join(src, `${id}.png`))
    .resize(P, P)
    .removeAlpha()
    .blur(2.5)
    .raw()
    .toBuffer();
  const pano = Buffer.alloc(P * 2 * P * 3);
  for (let y = 0; y < P; y++) {
    const mean = [0, 0, 0];
    for (let x = 0; x < P; x++)
      for (let c = 0; c < 3; c++) mean[c] += plate[(y * P + x) * 3 + c] / P;
    const t = Math.max(0, 1 - Math.min(y, P - 1 - y) / (P * 0.16));
    const pole = t * t * (3 - 2 * t);
    for (let x = 0; x < P; x++)
      for (let c = 0; c < 3; c++) {
        const v = plate[(y * P + x) * 3 + c] * (1 - pole) + mean[c] * pole;
        pano[(y * 2 * P + x) * 3 + c] = v;
        pano[(y * 2 * P + 2 * P - 1 - x) * 3 + c] = v;
      }
  }
  await writeFile(
    `${here}toybox_backdrop-${id}.webp`,
    await sharp(pano, { raw: { width: P * 2, height: P, channels: 3 } })
      .webp({ quality: 80, effort: 6 })
      .toBuffer(),
  );
}
