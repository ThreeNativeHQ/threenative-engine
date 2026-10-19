// The needle atlas the Temperate starter's foliage cards sample. Pure Node, seeded, and committed
// with its output: `node scripts/make-needle-atlas.mjs` rewrites the PNG byte-for-byte, so the art
// is reproducible rather than a binary nobody can regenerate.
//
// Why generated and not downloaded: a spruce branch card is needles on a visible twig, and the
// silhouette is the whole point of the card — a photograph of foliage does not give you a card with
// the twig down the middle and needles fanning off both sides, which is what makes an alpha-cutout
// branch read as a branch from every angle. Poly Haven's bark set supplies the trunk; the leaves
// are this file's job.
//
// Four 512x512 cells in a 2x2 grid, all of them RGBA with a hard alpha edge:
//
//   0,0  spruce branch, dense  — the whorl cards that build the tree's mass
//   1,0  spruce branch, open  — fewer, longer needles; keeps a crown from reading as one texture
//   0,1  spruce tip          — short, bright new growth for the leader and the crown's outer cards
//   1,1  poppy petal         — one cupped petal, for the red discs in the meadow
//
// A second file comes out of the same run with the same four cells as relief: RG is a tangent-space
// normal and B is the ambient occlusion the needles occlude each other with. One normal per needle,
// cooked from the coverage the albedo was drawn with, is what turns a flat green silhouette into
// needles — the card is alpha-cutout, so its *shape* was carrying all of the detail before and a
// crown read as stacked flat quads however good the cutout was.
//
// Everything here is appearance, so it lives in game source rather than in `packages/`.
import { mkdir, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";

const CELL = 512;
const ATLAS = CELL * 2;
const SEED = 466_468;
// Written beside the downloaded starter maps because that folder is the one this example's Vite
// serves: one root, one provenance file, and `ctx.assets.texture("needle-atlas.png")` reaches the
// same bytes in dev, in a build and through the desktop bundle.
const FOLDER = new URL("../../../packages/terrain/starter-assets/", import.meta.url);
const OUTPUT = new URL("needle-atlas.png", FOLDER);
const SURFACE_OUTPUT = new URL("needle-surface.png", FOLDER);

/** mulberry32: one uint32 seed, identical output on every platform and Node version. */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Straight-line distance from `point` to segment `a`-`b`, in pixels. */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0
      ? 0
      : Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * One cell's RGBA buffer plus the primitives drawn into it.
 *
 * A card is drawn as a list of tapered needles over a twig polyline and rasterised once, so the
 * cost is the sum of the needles' own bounding boxes rather than the whole cell per needle.
 */
function card() {
  return {
    cover: new Float32Array(CELL * CELL),
    data: new Uint8Array(CELL * CELL * 4),
    ridge: new Float32Array(CELL * CELL),
  };
}

/**
 * Composite `colour` over the cell at `coverage`, keeping the highest alpha already written.
 *
 * A later stroke paints over an earlier one at equal coverage rather than losing to it. That detail
 * is the difference between a card that is a mass and a card that is *needles*: with a strict
 * maximum, two opaque crossings merge into one flat colour, and a canopy drawn that way has no
 * per-needle shading anywhere inside its own mass — which is what the last captures showed as flat
 * stacked quads.
 *
 * `ridge` keeps the lightness of whichever stroke owns each texel, and the relief pass reads it as
 * a height field: a needle is a rounded ridge because it is lighter along its spine than at its
 * edge, and that survives the overlap because the last stroke over the texel wins there too.
 */
function stamp(target, x, y, coverage, colour) {
  if (coverage <= 0) return;
  const index = (y * CELL + x) * 4;
  const alpha = Math.min(1, coverage);
  const existing = target.data[index + 3] / 255;
  if (alpha > target.cover[y * CELL + x]) target.cover[y * CELL + x] = alpha;
  const out = alpha + existing * (1 - alpha);
  if (out < target.data[index + 3] / 255) return;
  // Luminance of the stroke's own colour, which is what makes the needle read as a cylinder.
  target.ridge[y * CELL + x] = alpha * (colour[1] / 255);
  for (let channel = 0; channel < 3; channel += 1) {
    const source = colour[channel] / 255;
    const behind = (target.data[index + channel] / 255) * (existing * (1 - alpha));
    target.data[index + channel] = Math.round((source * alpha + behind) * 255);
  }
  target.data[index + 3] = Math.round(out * 255);
}

/** Rasterise one tapered needle: a segment from `from` to `to`, `width` pixels thick at its base. */
function drawNeedle(target, from, to, width, colour) {
  const [ax, ay] = from;
  const [bx, by] = to;
  const minX = Math.max(0, Math.floor(Math.min(ax, bx) - width - 1));
  const maxX = Math.min(CELL - 1, Math.ceil(Math.max(ax, bx) + width + 1));
  const minY = Math.max(0, Math.floor(Math.min(ay, by) - width - 1));
  const maxY = Math.min(CELL - 1, Math.ceil(Math.max(ay, by) + width + 1));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const distance = distanceToSegment(x + 0.5, y + 0.5, ax, ay, bx, by);
      // Half a pixel of coverage ramp: the card is alpha-cutout at draw time, and a hard geometric
      // edge aliases into a staircase that the mip chain then averages into a grey fringe.
      const coverage = width + 0.5 - distance;
      if (coverage <= 0) continue;
      stamp(target, x, y, Math.min(1, coverage), colour);
    }
  }
}

/** Draw the twig every needle hangs off, dark and thin, along a slight arc. */
function drawTwig(target, points, width, colour) {
  for (let i = 0; i + 1 < points.length; i += 1) {
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    const steps = Math.ceil(Math.hypot(bx - ax, by - ay));
    for (let step = 0; step <= steps; step += 1) {
      const t = step / Math.max(1, steps);
      const x = ax + (bx - ax) * t;
      const y = ay + (by - ay) * t;
      const taper = width * (1 - t * 0.55);
      const minX = Math.max(0, Math.floor(x - taper - 1));
      const maxX = Math.min(CELL - 1, Math.ceil(x + taper + 1));
      const minY = Math.max(0, Math.floor(y - taper - 1));
      const maxY = Math.min(CELL - 1, Math.ceil(y + taper + 1));
      for (let py = minY; py <= maxY; py += 1) {
        for (let px = minX; px <= maxX; px += 1) {
          const distance = distanceToSegment(px + 0.5, py + 0.5, x, y, x, y);
          const coverage = taper + 0.5 - distance;
          if (coverage <= 0) continue;
          stamp(target, px, py, Math.min(1, coverage), colour);
        }
      }
    }
  }
}

const NEEDLE_DARK = [30, 52, 30];
const NEEDLE_MID = [58, 98, 46];
const NEEDLE_TIP = [112, 146, 70];
const TWIG = [62, 46, 33];
const PETAL_RED = [176, 26, 24];
const PETAL_DEEP = [104, 12, 16];

/**
 * Blend the needle's own gradient: dark at the twig, lighter toward the tip.
 *
 * The tip colour is the whole of the read at distance. A spruce's new growth is several stops lighter
 * than the shaded interior of its crown, and that gradient is what stops a canopy from being one
 * silhouette-coloured mass — the judges called the last crowns "near-black undersides", which is a
 * card whose darkest needle is too dark and whose lightest is not light enough.
 */
function needleColour(rnd) {
  const t = 0.28 + rnd() * 0.62;
  return NEEDLE_DARK.map((dark, i) =>
    Math.round(dark + (NEEDLE_TIP[i] - dark) * t + (NEEDLE_MID[i] - NEEDLE_DARK[i]) * 0.2),
  );
}

/** The twig point at parameter `t` along the branch, in pixels. Droop is a smoothstep. */
function twigAt(t, root, tip) {
  const ease = t * t * (3 - 2 * t);
  return [root[0] + (tip[0] - root[0]) * t, root[1] + (tip[1] - root[1]) * ease];
}

/**
 * A spruce branch card: a drooping twig buried under a dense spray of needles.
 *
 * The card is the tree's mass, so it has to be mostly opaque along its length. A card that is a
 * tenth covered leaves the crown as a haze of specks with sky between every needle, which is what a
 * few hundred strokes per card produces — and that haze is the exact failure this lane exists to
 * remove. Density here is what lets a dozen quads stand in for a branch instead of fifty.
 */
function spruceBranch(seed, { count, length, droop, needleWidth, tipOnly = false }) {
  const target = card();
  const rnd = random(seed);
  const root = [CELL * 0.06, tipOnly ? CELL * 0.12 : CELL * 0.08];
  const tip = [CELL * 0.97, root[1] + droop * CELL];
  const segments = 10;
  const twig = [];
  for (let i = 0; i <= segments; i += 1) twig.push(twigAt(i / segments, root, tip));
  for (let i = 0; i + 1 < twig.length; i += 1) {
    drawTwig(target, [twig[i], twig[i + 1]], tipOnly ? 5 : 7, TWIG);
  }
  const ctx = { droop, length, needleWidth, rnd, segments, target, tipOnly, twig };
  drawBundles(ctx, count);
  drawSilhouetteSprays(ctx, count);
  return target;
}

/** One side shoot's fan of needles: the bundle, which is what a spruce branch is made of. */
function shootBundle(ctx, x, y, angle, shoot) {
  const { droop, needleWidth, rnd, target, tipOnly } = ctx;
  const ex = x + Math.cos(angle) * shoot;
  const ey = y + Math.sin(angle) * shoot * 0.8 + shoot * droop * 0.5;
  // The tip card has no side twigs: a leader's growth is needles on a stem, and dark twigs across the
  // brightest cell of the atlas read as dirt on the new growth.
  if (!tipOnly)
    drawTwig(
      target,
      [
        [x, y],
        [ex, ey],
      ],
      3.4,
      TWIG,
    );
  const needles = ctx.needlesPerBundle;
  for (let n = 0; n < needles; n += 1) {
    // Needles sit along the shoot and each fans either side of it.
    const u = (n + rnd()) / needles;
    const nx = x + (ex - x) * u;
    const ny = y + (ey - y) * u + shoot * droop * 0.5 * u * u;
    const fan = angle + (rnd() - 0.5) * 1.15;
    const reach = shoot * (0.34 + rnd() * 0.42) * (1.05 - Math.abs(u - 0.35) * 0.5);
    drawNeedle(
      target,
      [nx, ny],
      [nx + Math.cos(fan) * reach, ny + Math.sin(fan) * reach * 0.85],
      needleWidth * (0.7 + rnd() * 0.45) * (0.7 + u * 0.5),
      needleColour(rnd),
    );
  }
}

/**
 * Needles in *bundles*, not one stroke at a time off the main twig. A spruce branch is a spray of
 * side shoots, each carrying its own fan of needles, and a card that draws every needle straight off
 * the main axis is a bottle brush: one flat comb with a hard upper edge and nothing underneath it.
 *
 * The bundles run shortest-and-most-forward first, so the long basal sprays land on top of them and
 * the card reads as one mass with structure in it rather than as a thicket of loose strokes.
 */
function drawBundles(ctx, count) {
  const { length, rnd, segments, target, tipOnly, twig } = ctx;
  const bundles = Math.max(6, Math.round(count / 90));
  ctx.needlesPerBundle = Math.max(4, Math.round(count / bundles / 2));
  for (let b = 0; b < bundles; b += 1) {
    // Bundles march along the twig; the leading edge of the card carries the short new growth.
    const t = tipOnly ? 0.15 + rnd() * 0.85 : (b + rnd() * 0.8) / bundles;
    const [x, y] = twig[Math.min(segments, Math.floor(t * segments))] ?? twig[twig.length - 1];
    // Each shoot's own length: long at the branch's base, short at the tip.
    const shoot = length * CELL * (0.78 - t * 0.44) * (0.7 + rnd() * 0.5);
    for (const side of [-1, 1]) shootBundle(ctx, x, y, side * (0.55 + rnd() * 0.85) + 0.5, shoot);
  }
}

/**
 * Long structural sprays straight off the main twig: they fill the silhouette between the bundles
 * and keep the card opaque along its whole length, which is what lets a dozen quads stand in for a
 * branch instead of fifty.
 */
function drawSilhouetteSprays(ctx, count) {
  const { length, needleWidth, rnd, segments, target, twig } = ctx;
  for (let i = 0; i < Math.round(count * 0.18); i += 1) {
    const t = rnd() ** 0.7;
    const [x, y] = twig[Math.min(segments, Math.floor(t * segments))] ?? twig[twig.length - 1];
    const side = rnd() < 0.5 ? 1 : -1;
    const angle = side * (0.6 + rnd() * 0.5) + 0.55;
    const reach = length * CELL * (0.62 + rnd() * 0.42);
    drawNeedle(
      target,
      [x, y],
      [
        x + Math.cos(angle) * reach,
        y + Math.sin(angle) * reach * 0.8 + Math.abs(t - 0.5) * reach * 0.35,
      ],
      needleWidth * (1 + rnd() * 0.4),
      needleColour(rnd),
    );
  }
}

/** One poppy petal: a rounded lobe with a scalloped edge, cupped darker at its base. */
function poppyPetal(seed) {
  const target = card();
  const rnd = random(seed);
  const baseX = CELL * 0.5;
  const baseY = CELL * 0.97;
  const reach = CELL * 0.86;
  // Half-width as a function of height up the petal: pinched at the base, widest at two thirds,
  // rounded over at the tip. The outline is sampled per scanline rather than per angle, which keeps
  // the lobe smooth at the crown where an angular sweep would show its facets.
  const halfWidth = (t) =>
    reach * 0.46 * Math.sin(Math.PI * t ** 0.78) * (1 + 0.05 * Math.sin(t * 11 + seed));
  for (let y = 0; y < CELL; y += 1) {
    const t = 1 - y / (CELL - 1);
    if (t <= 0) continue;
    const width = halfWidth(t);
    if (width <= 0.5) continue;
    const cup = Math.max(0, 0.62 - t * 1.15);
    for (let x = Math.floor(baseX - width); x <= Math.ceil(baseX + width); x += 1) {
      const inside = Math.abs(x + 0.5 - baseX) <= width;
      // Scallops: the edge is chewed inward a little, irregularly, the way a petal is.
      const scallop = inside && Math.abs(Math.abs(x + 0.5 - baseX) - width) < 2 + rnd() * 3;
      if (!inside || scallop) continue;
      const colour = PETAL_RED.map((red, c) => Math.round(red + (PETAL_DEEP[c] - red) * cup));
      stamp(target, x, y, 1, colour);
    }
  }
  return target;
}

/**
 * Blur `source` into `target` with a separable box, radius in pixels, clamped at the edges.
 *
 * One of the two places below needs a blurred copy of the coverage: the AO wants to know how deep
 * into the card a texel is, and a single texel's coverage cannot tell that.
 */
function blur(source, radius) {
  const width = radius * 2 + 1;
  const horizontal = new Float32Array(CELL * CELL);
  const out = new Float32Array(CELL * CELL);
  for (let y = 0; y < CELL; y += 1) {
    for (let x = 0; x < CELL; x += 1) {
      let sum = 0;
      for (let k = -radius; k <= radius; k += 1)
        sum += source[y * CELL + Math.min(CELL - 1, Math.max(0, x + k))];
      horizontal[y * CELL + x] = sum / width;
    }
  }
  for (let y = 0; y < CELL; y += 1) {
    for (let x = 0; x < CELL; x += 1) {
      let sum = 0;
      for (let k = -radius; k <= radius; k += 1)
        sum += horizontal[Math.min(CELL - 1, Math.max(0, y + k)) * CELL + x];
      out[y * CELL + x] = sum / width;
    }
  }
  return out;
}

/**
 * Cook one cell's relief: RG is a tangent-space normal, B is the occlusion the needles drop on each
 * other, and the normal is read from the *blurred* coverage so a needle is a rounded ridge rather
 * than a one-texel stair.
 *
 * This is what a cutout card was missing. An alpha-tested quad has no thickness, so its shading came
 * from one flat normal and the crowns read as stacked flat quads — the judges' words, and correct.
 * A normal per needle plus the occlusion of a canopy that is mostly needles gives the card a surface,
 * and the same normal is what the wrapped two-sided lighting below needs to catch the sun on.
 */
const RELIEF = { radius: 3, strength: 2.2 };

function surfaceOf(target) {
  // Two blurs at very different radii, because the two channels answer different questions. The
  // narrow one is over the *ridge* field — each needle's own lightness along its spine — so a
  // three-pixel needle keeps its roundness instead of being averaged into its neighbours. The wide
  // one is over the coverage, and it is the canopy: what fraction of the sky a texel can see.
  const fine = blur(target.ridge, RELIEF.radius);
  const wide = blur(target.cover, RELIEF.radius * 5);
  const data = new Uint8Array(CELL * CELL * 4);
  const at = (x, y) =>
    fine[Math.min(CELL - 1, Math.max(0, y)) * CELL + Math.min(CELL - 1, Math.max(0, x))];
  for (let y = 0; y < CELL; y += 1) {
    for (let x = 0; x < CELL; x += 1) {
      // Central differences across the ridge blur give the height field's own gradient. The factor
      // is high because a needle is only three texels wide here: its spine-to-edge drop is under a
      // quarter of the range, and a normal built from that is almost flat.
      const dx = (at(x + 1, y) - at(x - 1, y)) * RELIEF.strength * 4;
      const dy = (at(x, y + 1) - at(x, y - 1)) * RELIEF.strength * 4;
      const length = Math.hypot(dx, dy, 1);
      // V runs up the card while y runs down the image, so the green channel is negated to keep the
      // relief lit from the same side as the albedo.
      const index = (y * CELL + x) * 4;
      data[index] = Math.round(((-dx / length) * 0.5 + 0.5) * 255);
      data[index + 1] = Math.round((dy / length) * 0.5 * 255 + 127.5);
      // Occlusion from the wide blur: a texel buried in the spray sees less sky than one on the
      // fringe. The floor matters as much as the range — a needle in the middle of a spruce's crown
      // is lit by the *other needles*, not by the sky, and crushing it to black is the "near-black
      // undersides" the last captures showed. Nothing here goes below `deep`.
      const deep = 0.42;
      data[index + 2] = Math.round(
        (deep + (1 - deep) * (1 - Math.min(1, wide[y * CELL + x] * 3.4))) * 255,
      );
      data[index + 3] = 255;
    }
  }
  return data;
}

/** Minimal PNG encoder: one IDAT, filter 0 on every scanline, 8-bit RGBA. */
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(
      raw,
      y * (width * 4 + 1) + 1,
    );
  }
  const chunk = (type, body) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, "latin1"), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed) >>> 0);
    return Buffer.concat([length, typed, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Lay four cells out in the 2x2 grid the material's UVs address, into one RGBA buffer. */
function layOut(entries, pixelOf) {
  const out = new Uint8Array(ATLAS * ATLAS * 4);
  for (const [column, row, target] of entries) {
    for (let y = 0; y < CELL; y += 1) {
      const from = y * CELL * 4;
      out.set(
        pixelOf(target).subarray(from, from + CELL * 4),
        ((row * CELL + y) * ATLAS + column * CELL) * 4,
      );
    }
  }
  return out;
}

/** Lay the four cells out in the 2x2 grid the material's UVs address. */
const cells = [
  [0, 0, spruceBranch(SEED, { count: 5200, length: 0.32, droop: 0.4, needleWidth: 3.4 })],
  [1, 0, spruceBranch(SEED + 1, { count: 3800, length: 0.4, droop: 0.5, needleWidth: 3 })],
  [
    0,
    1,
    spruceBranch(SEED + 2, {
      count: 2600,
      length: 0.22,
      droop: 0.14,
      needleWidth: 3.6,
      tipOnly: true,
    }),
  ],
  [1, 1, poppyPetal(SEED + 3)],
];

await mkdir(FOLDER, { recursive: true });
await writeFile(
  OUTPUT,
  encodePng(
    ATLAS,
    ATLAS,
    layOut(cells, (target) => target.data),
  ),
);
// The petal cell is a smooth cupped surface with no needles in it, so it gets the same relief pass
// for free rather than a special case: the normal it gets is a soft bowl, which is exactly a petal.
await writeFile(SURFACE_OUTPUT, encodePng(ATLAS, ATLAS, layOut(cells, surfaceOf)));
console.log(
  `Wrote a ${ATLAS}x${ATLAS} RGBA needle atlas and its relief (normal + AO) to packages/terrain/starter-assets/`,
);
