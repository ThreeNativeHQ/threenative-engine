import { readFile } from "node:fs/promises";
import { createCanvas } from "@napi-rs/canvas";
import sharp from "sharp";
import type { IArborLeafHook, IArborPreset } from "../vendor/arbor.js";
import { leafNormal, rgbaWebp } from "./webp.js";

/**
 * Poly Haven CC0 scans (scans/credits.json) that replace a generated texture by default. Bark scans
 * are tiled to Arbor's 1:2 bark aspect; a detail scan is a grey multiplier with a linear mean of 0.5,
 * so a forest-kit piece keeps its own palette in COLOR_0 (times twice Arbor's untextured factor) and gains the scan's relief.
 * A bark profile missing here (birch, aspen, bamboo, banana, cactus, flower stems, shrub twigs) has no
 * fitting scan and keeps its generated texture; leaves and cover are the foliage sprites below.
 */
const BARK: Readonly<Record<string, string>> = {
  acacia: "japanese_camphor_bark",
  araucaria: "knotted_pine_bark",
  baobab: "chinese_hackberry_bark",
  beech: "chinese_hackberry_bark",
  cedar: "japanese_cedar_bark",
  cherry: "sakura_bark",
  cypress: "japanese_cedar_bark",
  fir: "metasequoia_bark",
  ginkgo: "bark_brown_01",
  ipe: "bark_brown_01",
  jacaranda: "japanese_camphor_bark",
  joshua: "palm_bark",
  kapok: "chinese_hackberry_bark",
  mossy: "tree_bark_03",
  oak: "jolcham_oak_bark_01",
  olive: "bark_willow_02",
  palm: "palm_bark",
  smoothgray: "chinese_hackberry_bark",
  spruce: "knotted_pine_bark",
};
const DETAIL: Readonly<Record<string, string>> = {
  branch: "bark_brown_02",
  log: "bark_brown_02",
  rock: "rock_boulder_dry",
  stump: "bark_brown_02",
  twig: "bark_brown_02",
};

export interface IScan {
  readonly id: string;
  readonly color: Uint8Array;
  readonly normal: Uint8Array;
}

async function load(id: string, color: "color" | "detail"): Promise<IScan> {
  const dir = new URL("../scans/", import.meta.url);
  const [colorBytes, normal] = await Promise.all([
    readFile(new URL(`${id}-${color}.webp`, dir)),
    readFile(new URL(`${id}-normal.webp`, dir)),
  ]);
  return { color: colorBytes, id, normal };
}

/** The bark scan for an Arbor bark profile, or undefined when none fits. */
export function barkScan(profile: string): Promise<IScan> | undefined {
  const id = BARK[profile];
  return id === undefined ? undefined : load(id, "color");
}

/** The detail scan for a forest-kit preset, or undefined when none fits. */
export function detailScan(preset: string): Promise<IScan> | undefined {
  const id = DETAIL[preset];
  return id === undefined ? undefined : load(id, "detail");
}

/**
 * Foliage sprites (scans/prepare.mjs): single scanned leaves, blades, fronds and needle sprigs, each
 * a strip of equal cells with the base on the bottom edge. Arbor still lays out every card (its
 * sprig, frond and needle painters, blossoms included); a leaf or a cell is drawn from a sprite
 * instead, tinted to the species palette, so a red maple stays red. Shapes with no fitting scan
 * (ginkgo, palm fronds, yucca, flower heads, arrowhead leaves) keep Arbor's drawing.
 */
const SPRITE_CELL: Readonly<Record<string, readonly [number, number]>> = {
  "shrub_01-leaves": [128, 192],
  "island_tree_01-leaves": [96, 256],
  "shrub_02-leaves": [64, 256],
  "jacaranda_tree-leaves": [144, 272],
  "grass_medium_02-blade": [48, 512],
  "fern_02-frond": [96, 512],
  "pine_tree_01-sprig": [176, 288],
  "LeafSet016-leaves": [128, 192],
  "LeafSet027-leaves": [192, 224],
  "LeafSet012-leaves": [128, 224],
};
/** Arbor leaf shape (a sprig or spike leaf) to its sprite. */
const LEAF: Readonly<Record<string, string>> = {
  bipinnate: "jacaranda_tree-leaves",
  birch: "shrub_01-leaves",
  elliptic: "island_tree_01-leaves",
  jmaple: "LeafSet027-leaves",
  lance: "shrub_02-leaves",
  maple: "LeafSet027-leaves",
  oak: "LeafSet016-leaves",
  ovate: "shrub_01-leaves",
  round: "shrub_01-leaves",
};
/** Arbor cell type to the sprite that fills the whole cell. */
const CELL: Readonly<Record<string, string>> = {
  blade: "grass_medium_02-blade",
  fern: "fern_02-frond",
  spray: "pine_tree_01-sprig",
};
/** forest-kit cover and leaf litter to the sprite its grey detail is cooked from. */
const COVER: Readonly<Record<string, string>> = {
  clover: "shrub_01-leaves",
  dock: "shrub_01-leaves",
  leaflitter: "LeafSet012-leaves",
  plume: "grass_medium_02-blade",
  reeds: "grass_medium_02-blade",
  seedgrass: "grass_medium_02-blade",
  tussock: "grass_medium_02-blade",
};

interface ISprite {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  /** One cell per variant: top-down RGBA, and its linear colour with the mean of its opaque texels. */
  readonly cells: readonly { rgba: Uint8Array; linear: Float32Array; mean: readonly number[] }[];
}

const LINEAR = Array.from({ length: 256 }, (_, v) => (v / 255) ** 2.2);
const toByte = (linear: number) => Math.round(255 * Math.min(1, linear) ** (1 / 2.2));

async function loadSprite(id: string): Promise<ISprite> {
  const [width, height] = SPRITE_CELL[id] as readonly [number, number];
  const { data, info } = await sharp(
    await readFile(new URL(`../scans/${id}.webp`, import.meta.url)),
  )
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const cells = Array.from({ length: info.width / width }, (_, c) => {
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++)
      rgba.set(
        data.subarray((y * info.width + c * width) * 4, (y * info.width + (c + 1) * width) * 4),
        y * width * 4,
      );
    const linear = new Float32Array(width * height * 3);
    const sum = [0, 0, 0];
    let opaque = 0;
    for (let p = 0; p < width * height; p++) {
      for (let k = 0; k < 3; k++) linear[p * 3 + k] = LINEAR[rgba[p * 4 + k] as number] as number;
      if ((rgba[p * 4 + 3] as number) > 128) {
        for (let k = 0; k < 3; k++) sum[k] = (sum[k] as number) + (linear[p * 3 + k] as number);
        opaque++;
      }
    }
    return { linear, mean: sum.map((v) => Math.max(1e-4, v / Math.max(1, opaque))), rgba };
  });
  return { cells, height, id, width };
}

type Rgb = readonly [number, number, number];
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/**
 * One sprite cell on a canvas, each texel scaled in linear light so the cell's mean becomes the
 * colour `at(v)` gives (v 0 at the base, 1 at the tip); its own light and shade stay the scan's.
 */
function tinted(sprite: ISprite, cell: number, at: (v: number) => Rgb): unknown {
  const { width, height } = sprite;
  const { rgba, linear, mean } = sprite.cells[cell] as ISprite["cells"][number];
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const image = ctx.createImageData(width, height);
  for (let y = 0; y < height; y++) {
    const want = at(1 - y / (height - 1));
    const k = want.map(
      (c, i) => (LINEAR[Math.round(Math.min(1, c) * 255)] as number) / (mean[i] as number),
    );
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      for (let i = 0; i < 3; i++)
        image.data[p * 4 + i] = toByte((linear[p * 3 + i] as number) * (k[i] as number));
      image.data[p * 4 + 3] = rgba[p * 4 + 3] as number;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * Draws `image` upright in Arbor's painting space, whose y runs up the card: its bottom edge on
 * y0, its top on y0 + height.
 */
function upright(
  ctx: ICanvasContext,
  image: unknown,
  x: number,
  y0: number,
  width: number,
  height: number,
): void {
  ctx.save();
  ctx.imageSmoothingQuality = "high";
  ctx.scale(1, -1);
  ctx.drawImage(image, x, -y0 - height, width, height);
  ctx.restore();
}

interface ICanvasContext {
  imageSmoothingQuality: string;
  save(): void;
  restore(): void;
  scale(x: number, y: number): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;
  drawImage(image: unknown, x: number, y: number, w: number, h: number): void;
}

/**
 * The Arbor hook that draws a preset's leaves and cells from scanned sprites, and the sprite ids it
 * drew (`used`, filled while the atlas paints); undefined when no cell of the preset has a scan.
 */
export async function foliageHook(
  preset: IArborPreset,
): Promise<{ hook: IArborLeafHook; used: Set<string> } | undefined> {
  const ids = new Set<string>();
  for (const cell of preset.tex?.cells ?? []) {
    const id =
      cell.type === "sprig"
        ? LEAF[cell.leaf as string]
        : cell.type === "spike"
          ? LEAF.lance
          : CELL[cell.type as string];
    if (id !== undefined) ids.add(id);
  }
  if (ids.size === 0) return undefined;
  const sprites = new Map(
    await Promise.all([...ids].map(async (id) => [id, await loadSprite(id)] as const)),
  );
  const used = new Set<string>();
  const hook: IArborLeafHook = {
    leaf(ctx, S, R, x, y, angle, length) {
      const sprite = sprites.get(LEAF[S.leaf as string] ?? "");
      if (sprite === undefined) return false;
      const k = R.range(0.9, 1.1);
      const colour = mix(S.colA as Rgb, S.colB as Rgb, R()).map((c) => c * k) as unknown as Rgb;
      const cell = Math.floor(R() * sprite.cells.length);
      const c = ctx as ICanvasContext;
      c.save();
      c.translate(x, y);
      c.rotate(angle);
      // Arbor's length is the blade; the scan carries its own petiole, about a tenth more.
      const tall = length * 1.1;
      const wide = (tall * sprite.width) / sprite.height;
      upright(
        c,
        tinted(sprite, cell, () => colour),
        -wide / 2,
        0,
        wide,
        tall,
      );
      c.restore();
      used.add(sprite.id);
      return true;
    },
    cell(ctx, S, R, aspect) {
      const sprite = sprites.get(CELL[S.type as string] ?? "");
      if (sprite === undefined) return false;
      const cell = Math.floor(R() * sprite.cells.length);
      const [a, b] = [S.colA as Rgb, S.colB as Rgb];
      const c = ctx as ICanvasContext;
      if (S.type === "blade") {
        // A blade card is the blade's own outline, so the strip fills the cell base to tip.
        upright(
          c,
          tinted(sprite, cell, (v) => mix(a, b, v)),
          0,
          0,
          1,
          aspect,
        );
      } else {
        const mid = mix(a, b, 0.5);
        // A frond or needle sprig is stretched up to 1.6 times its width (at most the cell's), so
        // the card fills about as much of its cell as Arbor's own frond or sprig.
        const tall = aspect * 0.98;
        const wide = Math.min(0.98, (1.6 * tall * sprite.width) / sprite.height);
        upright(
          c,
          tinted(sprite, cell, () => mid),
          0.5 - wide / 2,
          0,
          wide,
          tall,
        );
      }
      used.add(sprite.id);
      return true;
    },
  };
  return { hook, used };
}

/**
 * The grey detail a forest-kit cover or leaf-litter preset wears, cooked from its sprite's first
 * cell: luminance scaled to a linear mean of 0.5 (the preset's COLOR_0 takes twice Arbor's untextured
 * factor, so the kit's palette stays), a leaf keeps its cutout and a blade is opaque (its strip is the outline), and a
 * normal map at half resolution cooked from it. Undefined when no sprite fits.
 */
export async function coverScan(preset: string): Promise<IScan | undefined> {
  const id = COVER[preset];
  if (id === undefined) return undefined;
  const sprite = await loadSprite(id);
  const { width, height } = sprite;
  const { rgba, linear, mean } = sprite.cells[0] as ISprite["cells"][number];
  const luma = (p: number) =>
    0.2126 * (linear[p * 3] as number) +
    0.7152 * (linear[p * 3 + 1] as number) +
    0.0722 * (linear[p * 3 + 2] as number);
  const k =
    0.5 /
    (0.2126 * (mean[0] as number) + 0.7152 * (mean[1] as number) + 0.0722 * (mean[2] as number));
  const blade = id.endsWith("-blade");
  // Bottom-up rows, as rgbaWebp and leafNormal take them.
  const grey = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const o = ((height - 1 - y) * width + x) * 4;
      grey.fill(toByte(luma(p) * k), o, o + 3);
      grey[o + 3] = blade ? 255 : (rgba[p * 4 + 3] as number);
    }
  return {
    color: await rgbaWebp(width, height, grey),
    id,
    normal: await rgbaWebp(width, height, leafNormal(width, height, grey), false, width >> 1),
  };
}
