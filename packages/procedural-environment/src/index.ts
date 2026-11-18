import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import type { BufferGeometry } from "three";
import Arbor, { type IArborPart, type IArborPreset, type IArborTree } from "../vendor/arbor.js";
import ForestKit, {
  type IForestKitMesh,
  type IForestKitPreset,
} from "../vendor/forest-kit/index.js";
import Outcrop from "../vendor/outcrop.js";
import { BIOMES, type IEnvironmentBiome } from "./biomes.js";
import { type IBakeCityOptions, buildCity, cityModules } from "./city.js";
import { type IScan, barkScan, coverScan, detailScan, foliageHook } from "./scans.js";
import { leafNormal, rgbaWebp, webpImages } from "./webp.js";

export type { IEnvironmentBiome } from "./biomes.js";
export type { IBakeCityOptions } from "./city.js";

export interface IVegetationPreset {
  readonly id: string;
  readonly name: string;
  readonly latin?: string;
  /** `tree`, `cover` (grass, fern, flower, shrub) or `debris` (log, twig, litter, stone). */
  readonly kind: string;
}

export interface IBakeVegetationOptions {
  /** Directory the GLBs are written to; created when missing. */
  readonly out: string;
  /** A preset id from `vegetationPresets()`. */
  readonly preset: string;
  /** An integer. The same preset and seed always write the same bytes. Default 1. */
  readonly seed?: number;
  /** Levels of detail to write, each 0 (full) to 2 (far). Default `[0]`. */
  readonly lods?: readonly number[];
  /**
   * A patch over the preset, so a game changes a species' form and leaf card with no package edit:
   * `levels`, `leaves` and `tex.cells` merge row by row into the preset's own rows, and any other key
   * replaces the preset's value. Each key must name a field the preset has. The file names carry a
   * hash of the patch, so a formed bake never overwrites the stock one.
   */
  readonly form?: Readonly<Record<string, unknown>>;
  /**
   * A PNG the leaves draw instead of Arbor's drawn card, as an atlas laid out on the preset's
   * `tex.grid` (cell 0 top-left, row by row); `form` picks the grid and each leaf row's `cells`.
   * The file names carry a hash of its bytes.
   */
  readonly leafImage?: string;
  /**
   * The longest side of Arbor's drawn leaf card, in pixels; Arbor draws 1024. A far level is drawn
   * at a few pixels on screen, so a 1024 px card is bytes the frame never shows. A game's own
   * `leafImage` is always used as given, and the two together throw.
   */
  readonly leafSize?: number;
  /**
   * A PNG painted on the bark instead of Arbor's drawn one, for a species whose trunk is the whole
   * silhouette (`saguaro`): the drawn bark is a flat pinstripe, and no photograph of a ribbed
   * column is in the preset. The file names carry a hash of its bytes.
   */
  readonly barkImage?: string;
  /**
   * The bark's relief as a glTF tangent-space normal PNG, drawn against `barkImage`.
   *
   * Arbor's own bark normal belongs to its drawn bark and is dropped when `barkImage` replaces it,
   * so without this the trunk keeps a smooth surface and a ribbed column loses its ribs. Throws
   * without `barkImage`, because a relief with no albedo to show is a caller's mistake.
   */
  readonly barkNormalImage?: string;
  /**
   * `"scans"` (the default) wraps bark and forest-kit wood and stone in a Poly Haven CC0 scan, and
   * draws leaves, blades, fronds and needles from CC0 leaf scans, where one fits (the bake's `scan`
   * and `leafScan` name them); `"generated"` keeps the generator's own texture, byte for byte, as the
   * raw Arbor and forest-kit pages draw it.
   */
  readonly textures?: "scans" | "generated";
}

export interface IEnvironmentBake {
  readonly bounds: {
    readonly max: readonly [number, number, number];
    readonly min: readonly [number, number, number];
  };
  readonly lod: number;
  readonly path: string;
  readonly triangles: number;
  /** The Poly Haven scan the bark or wood wears, absent when the texture is generated. */
  readonly scan?: string;
  /**
   * The scanned foliage sprites the leaves, blades or fronds wear (`+` between several), absent when
   * the leaf card is Arbor's drawing or a game's leafImage.
   */
  readonly leafScan?: string;
  /**
   * A rock's material inputs: Outcrop's ROCK_TEXTURES profile, metres per repeat, and the two lossless WebPs
   * its triplanar material samples (detail: rgb albedo multiplier, a roughness; normal: rgb
   * tangent normal, a height). The GLB's `_ROCK`, `_COVER` and `_WET` attributes are the rest.
   */
  readonly rock?: {
    readonly texture: string;
    readonly tile: number;
    readonly detail: string;
    readonly normal: string;
  };
}

const MAX_LOD = 2;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * List every preset a bake can grow: id, name, latin name and kind.
 * Trees and cover come from Arbor; the `debris` rows (log, stump, twig, branch, leaflitter, rock)
 * and the extra cover rows (reeds, tussock, seedgrass, clover, dock, plume) come from forest-kit.
 * @situation list the oak, pine, spruce, palm and other tree species a bake can grow
 * @situation choose a tree species id for bakeVegetation or a terrain arbor: species
 * @situation what deadwood, leaf litter, boulders, reeds and tussocks can I bake for a forest floor
 * @constraint ids come from the vendored Arbor and forest-kit presets; trees are kind "tree", grass, ferns and flowers are kind "cover", deadwood, litter and stone are kind "debris"
 * @requires npm i -D @threenative/procedural-environment
 * @example vegetationPresets().filter((p) => p.kind === "debris").map((p) => p.id);
 */
export function vegetationPresets(): IVegetationPreset[] {
  return [
    ...Object.values(Arbor.PRESETS).map(({ id, name, latin, kind }) => ({
      id,
      name,
      ...(latin ? { latin } : {}),
      kind,
    })),
    ...Object.entries(ForestKit.PRESETS).map(([id, preset]) => ({
      id,
      name: preset.name,
      kind: preset.kind,
    })),
  ];
}

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(
        (row[j] as number) + 1,
        (next[j - 1] as number) + 1,
        (row[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    row = next;
  }
  return row[b.length] as number;
}

/** The ids closest to `id`, for an error message. */
function nearestPresets(
  id: string,
  count = 3,
  candidates = [...Object.keys(Arbor.PRESETS), ...Object.keys(ForestKit.PRESETS)],
): string[] {
  return candidates
    .map((candidate) => ({
      candidate,
      score: candidate.includes(id) || id.includes(candidate) ? 0 : distance(id, candidate),
    }))
    .sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate))
    .slice(0, count)
    .map((entry) => entry.candidate);
}

/** The preset with a game's form patch merged in: list rows merge by index, other keys replace. */
function withForm(
  id: string,
  source: IArborPreset,
  form: Readonly<Record<string, unknown>> | undefined,
): IArborPreset {
  if (form === undefined) return source;
  const base: Record<string, unknown> = source;
  const rows = (key: string, own: unknown, patch: unknown): unknown[] => {
    const list = (own ?? []) as Record<string, unknown>[];
    if (!Array.isArray(patch))
      throw new Error(`bakeVegetation: form.${key} must be a list of rows`);
    if (patch.length > list.length)
      throw new Error(
        `bakeVegetation: form.${key} has ${patch.length} rows; ${id} has ${list.length}`,
      );
    return list.map((row, i) => ({ ...row, ...((patch[i] as object | undefined) ?? {}) }));
  };
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(form)) {
    if (!Object.hasOwn(base, key))
      throw new Error(
        `bakeVegetation: form key "${key}" is not a field of ${id}: ${Object.keys(base).join(", ")}`,
      );
    if (key === "levels" || key === "leaves") merged[key] = rows(key, base[key], value);
    else if (key === "tex") {
      const own = base.tex as { cells?: unknown[] };
      const patch = value as { cells?: unknown };
      merged.tex = {
        ...own,
        ...patch,
        ...(patch.cells === undefined ? {} : { cells: rows("tex.cells", own.cells, patch.cells) }),
      };
    } else merged[key] = value;
  }
  return merged as IArborPreset;
}

/**
 * Arbor numbers its atlas cells from the bottom row up (it paints and stores its own card bottom-up),
 * while a game's `leafImage` numbers them from the top-left. Each leaf row's cells are flipped by row,
 * so cell 0 of a game's image is its top-left cell, as the option says.
 */
function topDownCells(source: IArborPreset): IArborPreset {
  const [cols, rows] = source.tex?.grid ?? [1, 1];
  const flip = (cell: number): number =>
    (rows - 1 - Math.floor(cell / cols)) * cols + (cell % cols);
  return {
    ...source,
    leaves: source.leaves?.map((row) =>
      row.cells === undefined ? row : { ...row, cells: row.cells.map(flip) },
    ),
  };
}

/** A game's PNG, read once, or the throw that names the option and the file that is not one. */
async function imageOf(
  file: string,
  option: "leafImage" | "barkImage" | "barkNormalImage",
): Promise<Uint8Array> {
  const image = await readFile(file);
  if (!image.subarray(0, 8).equals(PNG_SIGNATURE))
    throw new Error(`bakeVegetation: ${option} ${file} is not a PNG`);
  return image;
}

/**
 * The leaf image (the game's PNG, else Arbor's card as WebP with a normal map cooked from its own
 * leaves and veins, else none for a leafless preset such as `saguaro`) and the scans its leaves
 * were drawn from.
 *
 * `size` only ever shrinks Arbor's own card. A game's atlas is used as the game drew it, because a
 * cell index and a pixel grid only agree at the size the game authored.
 */
async function leafOf(
  source: IArborPreset,
  image: Uint8Array | undefined,
  size: number | undefined,
  scans: boolean,
): Promise<{ leaf?: Uint8Array; leafNormal?: Uint8Array; leafScan?: string }> {
  if (image !== undefined) return { leaf: image };
  if (!source.leaves?.length) return {};
  const scanned = scans ? await foliageHook(source) : undefined;
  const drawn = Arbor.leafTexture(source, {
    createCanvas,
    ...(scanned ? { hook: scanned.hook } : {}),
  });
  const { width, height, data } = drawn;
  const longest = Math.max(width, height);
  const outWidth =
    size === undefined || longest <= size ? width : Math.round((width * size) / longest);
  const leafScan = [...(scanned?.used ?? [])].sort().join("+");
  return {
    ...(leafScan ? { leafScan } : {}),
    leaf: await rgbaWebp(width, height, data, false, outWidth),
    // Half resolution: a normal cooked from a blurred height loses nothing visible at 512 px, and
    // it was the largest map a tree carried (PRD-900 compression study).
    leafNormal: await rgbaWebp(
      width,
      height,
      leafNormal(width, height, data),
      false,
      outWidth >> 1,
    ),
  };
}

/**
 * The bark images: a game's photographed albedo and relief, else a Poly Haven scan, else Arbor's
 * drawn pair as WebP.
 *
 * Arbor's normal is drawn against its own bark, so a game's albedo drops it: keeping it would shade
 * a photographed surface with grooves that are not in the picture.
 */
async function barkOf(
  source: IArborPreset,
  albedo: Uint8Array | undefined,
  normal: Uint8Array | undefined,
  scans: boolean,
): Promise<{ bark?: Uint8Array; barkNormal?: Uint8Array; scan?: string }> {
  if (albedo !== undefined)
    return normal === undefined ? { bark: albedo } : { bark: albedo, barkNormal: normal };
  if (source.noBark) return {};
  const scan = scans ? await barkScan(source.bark) : undefined;
  if (scan) return { bark: scan.color, barkNormal: scan.normal, scan: scan.id };
  const drawn = Arbor.barkTexture(source.bark);
  return {
    bark: await rgbaWebp(drawn.width, drawn.height, drawn.color),
    barkNormal: await rgbaWebp(drawn.width, drawn.height, drawn.normal),
  };
}

/**
 * The preset's source and the validated seed and lods, or the throw that names what is wrong.
 * forest-kit presets carry no leaf card, so a form patch or a leaf image on one is the mistake.
 */
function resolveBake(
  preset: string,
  options: IBakeVegetationOptions,
): {
  arbor: IArborPreset | null;
  forest: IForestKitPreset | null;
  lods: readonly number[];
  seed: number;
} {
  const seed = options.seed ?? 1;
  const lods = options.lods ?? [0];
  const arbor = Object.hasOwn(Arbor.PRESETS, preset)
    ? (Arbor.PRESETS[preset] as IArborPreset)
    : null;
  const forest =
    arbor === null && Object.hasOwn(ForestKit.PRESETS, preset)
      ? (ForestKit.PRESETS[preset] as IForestKitPreset)
      : null;
  if (arbor === null && forest === null)
    throw new Error(
      `bakeVegetation: unknown preset "${preset}". Nearest ids: ${nearestPresets(preset).join(", ")}. Call vegetationPresets() for the full list.`,
    );
  if (
    forest !== null &&
    (options.form !== undefined ||
      options.leafImage !== undefined ||
      options.barkImage !== undefined ||
      options.barkNormalImage !== undefined)
  )
    throw new Error(
      `bakeVegetation: form, leafImage and the bark images patch an Arbor preset, and "${preset}" is a forest-kit ${forest.kind} with no bark or leaf card to patch`,
    );
  if (options.leafSize !== undefined) {
    if (!Number.isInteger(options.leafSize) || options.leafSize < 16)
      throw new Error(
        `bakeVegetation: leafSize must be an integer of at least 16 pixels, got ${options.leafSize}`,
      );
    if (options.leafImage !== undefined)
      throw new Error(
        `bakeVegetation: leafSize ${options.leafSize} cannot resize leafImage ${options.leafImage}; a game's atlas is used as drawn`,
      );
  }
  if (options.barkNormalImage !== undefined && options.barkImage === undefined)
    throw new Error(
      `bakeVegetation: barkNormalImage ${options.barkNormalImage} has no barkImage to shade; pass the albedo it was drawn for`,
    );
  checkSeedAndLods("bakeVegetation", seed, lods);
  return { arbor, forest, lods, seed };
}

function checkSeedAndLods(caller: string, seed: number, lods: readonly number[]): void {
  if (!Number.isInteger(seed)) throw new Error(`${caller}: seed must be an integer, got ${seed}`);
  if (lods.length === 0 || lods.some((lod) => !Number.isInteger(lod) || lod < 0 || lod > MAX_LOD))
    throw new Error(
      `${caller}: lods must be a non-empty list of integers 0 to ${MAX_LOD}, got [${lods}]`,
    );
  if (new Set(lods).size !== lods.length) throw new Error(`${caller}: lods repeat: [${lods}]`);
}

/** Writes to a temporary name, then renames, so a reader never sees half a file. */
async function writeAtomic(file: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Bake a procedural tree (Arbor) to GLBs, one per level of detail, ready for ctx.assets.model.
 * Each GLB carries the _WIND vertex attribute, COLOR_0 and TEXCOORD_0 and embeds WebP textures:
 * Arbor trees and cover wear a CC0 bark scan and alpha-masked leaves, blades, fronds and needles
 * painted from CC0 leaf scans; forest-kit wood and stone wear a grey CC0 detail scan, and forest-kit
 * cover and leaf litter a grey CC0 blade or leaf scan, each over the kit's COLOR_0 palette.
 * @situation generate a procedural tree, an oak, pine, spruce, palm or any forest species as a GLB
 * @situation procedural oak tree GLB with level of detail for a game forest
 * @situation tree GLB for Unity, Unreal or Godot, with wind weights in a _WIND attribute
 * @situation a fallen mossy log and leaf litter on the forest floor, with a stump, twigs and boulders
 * @situation reeds and cattails at a pond edge, or sedge tussocks, clover and seeding grass as cover
 * @alias trees
 * @alias palm trees
 * @alias street trees along a road
 * @alias bushes and shrubs
 * @alias grass, flowers and ferns as ground cover
 * @alias dead trees, fallen logs and stumps
 * @alias low poly tree with level of detail
 * @alias realistic textured tree model
 * @alias foliage and vegetation models
 * @alias pine, oak or spruce forest trees
 * @alias grass tufts and clumps
 * @constraint fails closed: an unknown preset throws naming the nearest ids, the seed must be an integer and each lod 0 to 2
 * @constraint the same preset, seed and lods write identical bytes; files are written atomically (temporary file, then rename)
 * @constraint bake-time only, so keep it a dev dependency; the game owns the look and the sway (a TSL render/wind.ts reading _WIND), because Arbor.three is not shipped
 * @constraint _WIND is vec4 (trunk sway, branch sway, flutter, phase): forest-kit sway is flutter in z, and debris writes all four zero
 * @constraint textures default to "scans" (the bake's `scan` and `leafScan` name them); nine presets with no fitting CC0 leaf scan (ginkgo, palms, banana, joshua, flowers, elephantear) keep Arbor's drawn leaf card; textures: "generated" keeps every generator texture byte for byte
 * @constraint form, leafImage, barkImage and barkNormalImage patch an Arbor preset only; a forest-kit debris or cover preset throws when given any
 * @requires npm i -D @threenative/procedural-environment
 * @example await bakeVegetation({ preset: "oak", seed: 7, lods: [0, 1], out: "assets/trees" });
 * @example await bakeVegetation({ preset: "log", seed: 3, out: "assets/debris" });
 */
export async function bakeVegetation(options: IBakeVegetationOptions): Promise<IEnvironmentBake[]> {
  const { preset, out } = options;
  const { arbor, forest, lods, seed } = resolveBake(preset, options);
  const scans = options.textures !== "generated";
  if (forest !== null) {
    const [scan, cover] = scans ? [await detailScan(preset), await coverScan(preset)] : [];
    return bakeForestKit(preset, forest, { cover, lods, out, scan, seed });
  }
  const formed = withForm(preset, arbor as IArborPreset, options.form);
  const source = options.leafImage === undefined ? formed : topDownCells(formed);
  const images = {
    bark:
      options.barkImage === undefined ? undefined : await imageOf(options.barkImage, "barkImage"),
    barkNormal:
      options.barkNormalImage === undefined
        ? undefined
        : await imageOf(options.barkNormalImage, "barkNormalImage"),
    leaf:
      options.leafImage === undefined ? undefined : await imageOf(options.leafImage, "leafImage"),
  };
  // A game's own art must never overwrite the stock bake of the same preset and seed, so every
  // image and the form patch carry into the file name.
  const patch = createHash("sha256")
    .update(JSON.stringify(options.form ?? null))
    .update(`leaf${options.leafSize ?? 0}`);
  for (const image of [images.leaf, images.bark, images.barkNormal])
    if (image !== undefined) patch.update(image);
  const tag =
    options.form === undefined &&
    options.leafSize === undefined &&
    Object.values(images).every((image) => image === undefined)
      ? ""
      : `-f${patch.digest("hex").slice(0, 8)}`;
  const {
    leaf,
    leafNormal: leafRelief,
    leafScan,
  } = await leafOf(source, images.leaf, options.leafSize, scans);
  const { scan, ...barkImages } = await barkOf(source, images.bark, images.barkNormal, scans);
  const textures = {
    ...barkImages,
    ...(leaf ? { leaf } : {}),
    ...(leafRelief ? { leafNormal: leafRelief } : {}),
  };
  const named = { ...(scan ? { scan } : {}), ...(leafScan ? { leafScan } : {}) };
  await mkdir(out, { recursive: true });
  const baked: IEnvironmentBake[] = [];
  for (const lod of lods) {
    const tree = Arbor.generate(source, { seed, lod });
    const file = path.join(out, `${preset}-${seed}${tag}-lod${lod}.glb`);
    await writeAtomic(file, Arbor.toGLB(tree, textures));
    baked.push({
      bounds: { max: tree.bounds.max, min: tree.bounds.min },
      lod,
      path: file,
      triangles: tree.triangles,
      ...named,
    });
  }
  return baked;
}

const EMPTY_PART: IArborPart = {
  color: new Float32Array(0),
  index: new Uint32Array(0),
  normal: new Float32Array(0),
  position: new Float32Array(0),
  uv: new Float32Array(0),
  wind: new Float32Array(0),
};

/**
 * A GeoBuilder's arrays as Arbor's part. forest-kit's float sway is how far the vertex moves under a
 * unit wind, which is Arbor's `_WIND.z` leaf flutter; its w phase stays 0 and the ground debris
 * generators leave all four zero.
 */
function toPart(mesh: IForestKitMesh): IArborPart {
  const wind = new Float32Array(mesh.wind.length * 4);
  for (let i = 0; i < mesh.wind.length; i++) wind[i * 4 + 2] = mesh.wind[i] as number;
  return {
    color: new Float32Array(mesh.col),
    index: new Uint32Array(mesh.idx),
    normal: new Float32Array(mesh.nor),
    position: new Float32Array(mesh.pos),
    uv: new Float32Array(mesh.uv),
    wind,
  };
}

/** One forest-kit generator in Arbor's tree shape, so both bakes go through one GLB writer. */
function forestKitTree(
  id: string,
  preset: IForestKitPreset,
  options: { lod: number; seed: number; onBark: boolean },
): IArborTree {
  const mesh = preset.generate(options);
  if (mesh.idx.length === 0)
    throw new Error(`bakeVegetation: "${id}" baked no triangles at lod ${options.lod}`);
  const part = toPart(mesh);
  const min: [number, number, number] = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  ];
  const max: [number, number, number] = [
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  for (let i = 0; i < part.position.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const value = part.position[i + k] as number;
      if (value < (min[k] as number)) min[k] = value;
      if (value > (max[k] as number)) max[k] = value;
    }
  const { onBark } = options;
  return {
    bark: onBark ? part : EMPTY_PART,
    bounds: { max, min },
    leaves: onBark ? EMPTY_PART : part,
    preset: { bark: "", id, name: preset.name },
    triangles: mesh.idx.length / 3,
  };
}

/**
 * A forest-kit preset's GLBs: COLOR_0 times Arbor's untextured factor, or, with a grey scan, that
 * product doubled in COLOR_0 times the scan's multiplier (mean 0.5) plus its normal map, so the
 * palette stays the kit's. Debris wears a
 * wood or stone `scan` on the opaque bark primitive; cover and leaf litter wear a blade or leaf
 * `cover` scan on the double-sided, alpha-masked foliage primitive, so a leaf keeps its cutout.
 */
async function bakeForestKit(
  preset: string,
  source: IForestKitPreset,
  options: {
    lods: readonly number[];
    out: string;
    scan: IScan | undefined;
    cover: IScan | undefined;
    seed: number;
  },
): Promise<IEnvironmentBake[]> {
  const grey = options.scan ?? options.cover;
  const onBark = source.part === "bark" && options.cover === undefined;
  const textures =
    grey === undefined
      ? {}
      : onBark
        ? { bark: grey.color, barkNormal: grey.normal }
        : { leaf: grey.color, leafNormal: grey.normal };
  const named = grey === undefined ? {} : { [onBark ? "scan" : "leafScan"]: grey.id };
  // Arbor's toGLB multiplies an untextured part by this factor; a textured part gets none, so it
  // moves into COLOR_0 and the scanned bake keeps the generated look.
  const look = source.part === "bark" ? [0.35, 0.28, 0.22] : [0.25, 0.4, 0.12];
  await mkdir(options.out, { recursive: true });
  const baked: IEnvironmentBake[] = [];
  for (const lod of options.lods) {
    const tree = forestKitTree(preset, source, { lod, onBark, seed: options.seed });
    const file = path.join(options.out, `${preset}-${options.seed}-lod${lod}.glb`);
    const part = onBark ? tree.bark : tree.leaves;
    if (grey)
      part.color.set(part.color.map((v, i) => Math.min(1, v * 2 * (look[i % 3] as number))));
    await writeAtomic(file, Arbor.toGLB(tree, textures));
    baked.push({
      bounds: { max: tree.bounds.max, min: tree.bounds.min },
      lod,
      path: file,
      triangles: tree.triangles,
      ...named,
    });
  }
  return baked;
}

/** What an element is: a tree, ground cover, floor debris, a rock form or an Apex city module. */
export type EnvironmentKind = "tree" | "cover" | "debris" | "rock" | "city";

export interface IEnvironmentElement {
  readonly id: string;
  readonly name: string;
  readonly latin?: string;
  readonly kind: EnvironmentKind;
  /** Biome ids from `environmentBiomes()` this element belongs in. */
  readonly biomes: readonly string[];
  /** A city module's Apex category: Roads, Buildings, Street Props, Vehicles, Race Kit ... */
  readonly category?: string;
  /** The call that bakes it, ready to paste; a rock's names the filter's biome, else its first. */
  readonly bake: string;
}

export interface IEnvironmentFilter {
  /** A biome id or one of its words ("jungle" finds tropical). */
  readonly biome?: string;
  readonly kind?: EnvironmentKind;
  /** Words that must all appear in the id, name, latin name, kind or biomes ("pine", "red rock"). */
  readonly search?: string;
}

const KINDS: readonly EnvironmentKind[] = ["tree", "cover", "debris", "rock", "city"];

/**
 * Every biome: its id, name, the request words that mean it, the rock surface its rocks wear and
 * the element ids that belong there.
 * @situation which biomes can I bake nature for: forest, desert, jungle, tundra, coast, volcano
 * @situation what trees, plants, debris and rocks belong in a desert or an alpine biome
 * @constraint ids match the Strata terrain kits where they overlap (forest, coastal, alpine, desert, tundra)
 * @requires npm i -D @threenative/procedural-environment
 * @example environmentBiomes().map((biome) => biome.id);
 */
export function environmentBiomes(): IEnvironmentBiome[] {
  return BIOMES.map((biome) => ({ ...biome }));
}

/** A biome id, or the biome one of its words names; throws naming the nearest ids. */
function biomeOf(caller: string, word: string): IEnvironmentBiome {
  const key = word.toLowerCase();
  const hit =
    BIOMES.find((biome) => biome.id === key) ?? BIOMES.find((biome) => biome.words.includes(key));
  if (hit !== undefined) return hit;
  const ids = BIOMES.map((biome) => biome.id);
  throw new Error(
    `${caller}: unknown biome "${word}". Nearest ids: ${nearestPresets(key, 3, ids).join(", ")}. Biomes: ${ids.join(", ")}.`,
  );
}

/**
 * Find the nature elements to bake, by biome, kind or words: trees, ground cover, forest-floor
 * debris and rock forms (boulders, cliffs, sea stacks, mesas, arches, mountains), each with the
 * exact bake call.
 * @situation what can I bake for a desert, a jungle, a coast, a tundra or a volcanic island
 * @situation list the rocks, cliffs and mountains for a biome, or every plant that grows there
 * @situation find a tree or plant by name or latin name, such as pine, palm, cactus or fern
 * @alias nature props for a level
 * @alias jungle and tropical plants
 * @alias desert cactus
 * @alias vegetation for a biome
 * @constraint fails closed: an unknown biome or kind throws naming the nearest ids
 * @constraint biome takes an id or one of its words, so "jungle" finds tropical and "swamp" finds wetland
 * @requires npm i -D @threenative/procedural-environment
 * @example environmentElements({ biome: "desert", kind: "rock" }).map((element) => element.bake);
 * @example environmentElements({ search: "palm" });
 */
export function environmentElements(filter: IEnvironmentFilter = {}): IEnvironmentElement[] {
  const biome =
    filter.biome === undefined ? undefined : biomeOf("environmentElements", filter.biome);
  if (filter.kind !== undefined && !KINDS.includes(filter.kind))
    throw new Error(
      `environmentElements: unknown kind "${filter.kind}". Kinds: ${KINDS.join(", ")}.`,
    );
  const words = (filter.search ?? "").toLowerCase().split(/\s+/u).filter(Boolean);
  const biomesOf = (id: string): string[] =>
    BIOMES.filter((row) => row.elements.includes(id)).map((row) => row.id);
  const plants = vegetationPresets().map((preset) => ({
    ...preset,
    kind: preset.kind as EnvironmentKind,
    biomes: biomesOf(preset.id),
    bake: `bakeVegetation({ preset: "${preset.id}", seed: 1, out: "assets/environment" })`,
  }));
  const rocks = Object.entries(Outcrop.FORMS).map(([id, form]) => {
    const biomes = biomesOf(id);
    const at = biome?.id ?? biomes[0] ?? "hills";
    return {
      id,
      name: form.label,
      kind: "rock" as const,
      biomes,
      bake: `bakeRock({ form: "${id}", biome: "${at}", seed: 1, out: "assets/environment" })`,
    };
  });
  const city = cityModules().map(({ id, name, category }) => ({
    id,
    name,
    kind: "city" as const,
    biomes: [] as string[],
    category,
    bake: `bakeCity({ module: "${id}", out: "assets/environment" })`,
  }));
  return [...plants, ...rocks, ...city].filter((element) => {
    if (biome !== undefined && !element.biomes.includes(biome.id)) return false;
    if (filter.kind !== undefined && element.kind !== filter.kind) return false;
    const text = [
      element.id,
      element.name,
      "latin" in element ? element.latin : "",
      "category" in element ? element.category : "",
      element.kind,
      ...element.biomes.flatMap((id) => [
        id,
        ...(BIOMES.find((row) => row.id === id)?.words ?? []),
      ]),
    ]
      .join(" ")
      .toLowerCase();
    return words.every((word) => text.includes(word));
  });
}

export interface IBakeRockOptions {
  /** Directory the GLBs are written to; created when missing. */
  readonly out: string;
  /** A rock form: `environmentElements({ kind: "rock" })` lists boulder, slab, cliff, arch, mountain and the rest. */
  readonly form: string;
  /** A biome id or word from `environmentBiomes()`; sets the rock's weathering and colour. Default "hills". */
  readonly biome?: string;
  /** An integer. The same options always write the same bytes. Default 1. */
  readonly seed?: number;
  /** Levels of detail, each 0 (full) to 2 (far); level n keeps `detail` x 1, 0.5, 0.2. Default `[0]`. */
  readonly lods?: readonly number[];
  /** Mesh density of level 0, 0 to 1: about 1 500 triangles at 0, 70 000 at 1. Default 0.3. */
  readonly detail?: number;
  /** Width, height, depth in metres; default the form's own (a boulder is 2.4 x 1.8 x 2.1 m). */
  readonly size?: readonly [number, number, number];
  /** Shape overrides 0 to 1 over the biome's: roughness, chipping, strata, layers, tilt, fracture, columnar, weathering. */
  readonly traits?: Readonly<Record<string, number>>;
  /** Colour and cover overrides over the biome's: rockA, rockB, accent, moss, snow, sand, lichen, tide and their colours. */
  readonly surface?: Readonly<Record<string, string | number>>;
  /**
   * A tileable form's (cliff) module along +X: module n sits n widths over and meets n - 1 and
   * n + 1 without a seam, as Outcrop's `tile()` lays them. Place it at x = n x width. Default 0.
   */
  readonly module?: number;
  /**
   * Where the module stands in its run, in metres. A tileable form (`cliff`) joins its neighbour
   * only when both share the seed and stand one width apart: module n takes `[n * width, 0, 0]`.
   */
  readonly offset?: readonly [number, number, number];
}

const ROCK_LOD_DETAIL = [1, 0.5, 0.2];

/** glTF name, three name and components of every attribute a rock GLB keeps. */
const ROCK_ATTRIBUTES = [
  ["POSITION", "position", "VEC3"],
  ["NORMAL", "normal", "VEC3"],
  ["COLOR_0", "color", "VEC3"],
  ["_ROCK", "aRock", "VEC3"],
  ["_COVER", "aCover", "VEC4"],
  ["_WET", "aWet", "SCALAR"],
] as const;

/**
 * A rock as binary glTF with every input of Outcrop's triplanar material: COLOR_0 (rock and cover
 * blended, for a plain viewer) and `_ROCK` (bare rock rgb), `_COVER` (cover rgb and amount) and
 * `_WET` (1 below the tide line). Outcrop's own exportGLB keeps only COLOR_0, which loses the look.
 */
function rockGlb(geometry: BufferGeometry, extras: Record<string, unknown>): Uint8Array {
  const accessors: Record<string, unknown>[] = [];
  const views: Record<string, unknown>[] = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const attributes: Record<string, number> = {};
  for (const [gltf, name, type] of ROCK_ATTRIBUTES) {
    const attribute = geometry.getAttribute(name);
    if (attribute === undefined) throw new Error(`bakeRock: the rock has no ${name} attribute`);
    const array = new Float32Array(attribute.array);
    const bytes = new Uint8Array(array.buffer);
    views.push({ buffer: 0, byteOffset: offset, byteLength: bytes.byteLength, target: 34962 });
    chunks.push(bytes);
    offset += bytes.byteLength;
    const bounds: Record<string, number[]> = {};
    if (gltf === "POSITION" && geometry.boundingBox) {
      bounds.min = geometry.boundingBox.min.toArray();
      bounds.max = geometry.boundingBox.max.toArray();
    }
    accessors.push({
      bufferView: views.length - 1,
      componentType: 5126,
      count: attribute.count,
      type,
      ...bounds,
    });
    attributes[gltf] = accessors.length - 1;
  }
  const primitive: Record<string, unknown> = { attributes, material: 0 };
  if (geometry.index) {
    const index = new Uint32Array(geometry.index.array);
    views.push({ buffer: 0, byteOffset: offset, byteLength: index.byteLength, target: 34963 });
    chunks.push(new Uint8Array(index.buffer));
    offset += index.byteLength;
    accessors.push({
      bufferView: views.length - 1,
      componentType: 5125,
      count: index.length,
      type: "SCALAR",
    });
    primitive.indices = accessors.length - 1;
  }
  const json = new TextEncoder().encode(
    JSON.stringify({
      asset: { version: "2.0", generator: "rockgen.js via @threenative/procedural-environment" },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, name: "rock" }],
      meshes: [{ name: "rock", primitives: [primitive] }],
      materials: [
        {
          name: "rock",
          extras,
          pbrMetallicRoughness: { metallicFactor: 0, roughnessFactor: 0.94 },
        },
      ],
      accessors,
      bufferViews: views,
      buffers: [{ byteLength: offset }],
    }),
  );
  const jsonLength = Math.ceil(json.length / 4) * 4;
  const out = new Uint8Array(28 + jsonLength + offset);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, out.length, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + jsonLength);
  out.set(json, 20);
  view.setUint32(20 + jsonLength, offset, true);
  view.setUint32(24 + jsonLength, 0x004e4942, true);
  let at = 28 + jsonLength;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** Each key of `patch` must be a key of `known`; throws listing the known keys. */
function checkKeys(name: string, patch: object | undefined, known: object): void {
  for (const key of Object.keys(patch ?? {}))
    if (!Object.hasOwn(known, key))
      throw new Error(
        `bakeRock: ${name} key "${key}" is unknown: ${Object.keys(known).join(", ")}`,
      );
}

/**
 * Outcrop's own detail and normal maps for this rock's texture profile and its tile, written once
 * per profile beside the GLBs. `materialFor` is the generator's own choice, so nothing is re-derived.
 */
async function rockMaps(
  generator: InstanceType<typeof Outcrop.RockGenerator>,
  geometry: BufferGeometry,
  out: string,
): Promise<NonNullable<IEnvironmentBake["rock"]>> {
  const recipe = geometry.userData.recipe as { surface: { texture: string } };
  const { uniforms } = generator.materialFor(recipe).userData;
  const texture = recipe.surface.texture;
  const write = async (
    map: { image: { data: Uint8Array; width: number; height: number } },
    kind: string,
  ) => {
    const file = path.join(out, `rock-${texture}-${kind}.webp`);
    await writeAtomic(
      file,
      await rgbaWebp(map.image.width, map.image.height, map.image.data, true),
    );
    return file;
  };
  return {
    texture,
    tile: 1 / uniforms.uTile.value,
    detail: await write(uniforms.tRockDetail.value, "detail"),
    normal: await write(uniforms.tRockNormal.value, "normal"),
  };
}

/** The throw that names what is wrong with a bakeRock call's form, detail, size, module or keys. */
function checkRockOptions(options: IBakeRockOptions, detail: number, module: number): void {
  const { form, size, traits, surface } = options;
  if (!Object.hasOwn(Outcrop.FORMS, form)) {
    const forms = Object.keys(Outcrop.FORMS);
    throw new Error(
      `bakeRock: unknown form "${form}". Nearest ids: ${nearestPresets(form, 3, forms).join(", ")}. Forms: ${forms.join(", ")}.`,
    );
  }
  if (!(detail >= 0 && detail <= 1))
    throw new Error(`bakeRock: detail must be 0 to 1, got ${detail}`);
  if (size !== undefined && (size.length !== 3 || !size.every((v) => Number.isFinite(v) && v > 0)))
    throw new Error(`bakeRock: size must be three positive metres [w, h, d], got [${size}]`);
  if (
    options.offset !== undefined &&
    (options.offset.length !== 3 || !options.offset.every((v) => Number.isFinite(v)))
  )
    throw new Error(`bakeRock: offset must be three metres [x, y, z], got [${options.offset}]`);
  if (module !== 0 && !(Number.isInteger(module) && Outcrop.FORMS[form]?.tileable))
    throw new Error(
      `bakeRock: module must be an integer on a tileable form (${Object.keys(Outcrop.FORMS)
        .filter((id) => Outcrop.FORMS[id]?.tileable)
        .join(", ")}), got ${module} on "${form}"`,
    );
  checkKeys("traits", traits, Outcrop.DEFAULT_TRAITS);
  checkKeys("surface", surface, Outcrop.DEFAULT_SURFACE);
}

/**
 * Bake a procedural rock (Outcrop) to GLBs, one per level of detail: a boulder, slab, spire,
 * hoodoo, sea stack, mesa, arch, tileable cliff module or a mountain, weathered and coloured for
 * its biome (moss in a forest, snow in the tundra, sand in the desert, algae below the tide line).
 * @situation generate a procedural rock, boulder or cliff as a GLB for a game level
 * @situation desert mesa, hoodoo or sandstone arch; coastal sea stack; alpine spire; volcanic basalt columns
 * @situation a procedural mountain mesh for the horizon, with snow at altitude
 * @alias rocks and boulders
 * @alias cliffs and mountains
 * @constraint fails closed: an unknown form or biome throws naming the nearest ids, as do unknown traits or surface keys, a non-integer seed, a lod outside 0 to 2 and a detail outside 0 to 1
 * @constraint the same options write identical bytes; files are written atomically (temporary file, then rename)
 * @constraint each GLB carries POSITION, NORMAL and COLOR_0 (linear RGB, rock and cover already blended) on one `rock` material; units are metres, +Y up, the rock rests on y = 0
 * @constraint a `cliff` module shows a cut face at each end: bake a run with one seed and `offset: [n * width, 0, 0]`, stand the modules one width apart and bury the two ends of the run
 * @constraint bake-time only, so keep it a dev dependency; the game owns the material and can re-material by the glTF material name `rock`
 * @requires npm i -D @threenative/procedural-environment
 * @example await bakeRock({ form: "cliff", biome: "coastal", seed: 7, lods: [0, 1], out: "assets/rocks" });
 * @example await bakeRock({ form: "boulder", biome: "forest", traits: { weathering: 0.8 }, out: "assets/rocks" });
 * @example for (const n of [0, 1, 2]) await bakeRock({ form: "cliff", biome: "desert", seed: 7, offset: [n * 10, 0, 0], out: "assets/rocks" }); // three modules of one wall
 */
export async function bakeRock(options: IBakeRockOptions): Promise<IEnvironmentBake[]> {
  const { form, out, size, traits, surface } = options;
  const module = options.module ?? 0;
  const seed = options.seed ?? 1;
  const lods = options.lods ?? [0];
  const detail = options.detail ?? 0.3;
  checkRockOptions(options, detail, module);
  const biome = biomeOf("bakeRock", options.biome ?? "hills");
  checkSeedAndLods("bakeRock", seed, lods);
  // A module is a placement along the run: `module` computes the offset, and an explicit one wins.
  const offset: readonly [number, number, number] | undefined =
    options.offset ??
    (module ? [module * (size ?? Outcrop.FORMS[form]?.size ?? [0])[0], 0, 0] : undefined);
  const patched = options.detail !== undefined || size || traits || surface || offset;
  const tag = patched
    ? `-f${createHash("sha256")
        .update(
          JSON.stringify([
            detail,
            size ?? null,
            traits ?? null,
            surface ?? null,
            ...(offset ? [offset] : []),
          ]),
        )
        .digest("hex")
        .slice(0, 8)}`
    : "";
  const generator = new Outcrop.RockGenerator();
  await mkdir(out, { recursive: true });
  const baked: IEnvironmentBake[] = [];
  for (const lod of lods) {
    const geometry = generator.geometry({
      form,
      biome: biome.rock,
      seed,
      detail: detail * (ROCK_LOD_DETAIL[lod] as number),
      ...(size ? { size } : {}),
      ...(traits ? { traits } : {}),
      ...(surface ? { surface } : {}),
      ...(offset ? { offset } : {}),
    });
    const file = path.join(out, `${form}-${biome.id}-${seed}${tag}-lod${lod}.glb`);
    const box = geometry.boundingBox;
    if (box === null) throw new Error(`bakeRock: "${form}" baked no bounds at lod ${lod}`);
    const rock = await rockMaps(generator, geometry, out);
    await writeAtomic(file, rockGlb(geometry, { rockTexture: rock.texture, tile: rock.tile }));
    baked.push({
      rock,
      bounds: { max: [box.max.x, box.max.y, box.max.z], min: [box.min.x, box.min.y, box.min.z] },
      lod,
      path: file,
      triangles: (geometry.index?.count ?? geometry.attributes.position?.count ?? 0) / 3,
    });
  }
  return baked;
}

/**
 * Bake an Apex City Kit module to one GLB: a road tile, a building, a street prop, a vehicle, a race
 * kit piece, a block or lot, a sidewalk, transit, a public space, a utility or a decal. The page's
 * own generator and GLTFExporter run headless, so the GLB carries its merged meshes, its materials
 * and textures (Poly Haven CC0 PBR maps and the canvas-drawn signs, liveries and markings) and its
 * road sockets in the root node's extras.
 * @situation generate a modular city street, intersection, roundabout or highway tile as a GLB
 * @situation a procedural building, storefront, office tower, apartment block, house or warehouse for a city level
 * @situation street props for a city: traffic signal, streetlight, bus shelter, hydrant, bench, mailbox, dumpster
 * @situation a race track kit: starting grid, timing gantry, barriers, tire wall, kerbs, pit lane; or a car, van, kart or formula car
 * @alias city kit
 * @alias modular road tiles
 * @alias low poly city buildings
 * @alias cars and vehicles
 * @constraint fails closed: an unknown module throws naming the nearest ids; seed is an integer 0 to 4294967295, detail 0 to 2, wet 0 to 100, floors an integer 2 to 12, text at most 24 characters, dressing a boolean
 * @constraint the same options write identical bytes on one Node major and machine (fonts draw the sign text); files are written atomically (temporary file, then rename)
 * @constraint units are metres, +Y up; stock roads fit a 24 m grid, and custom straights and bends export updated socket positions, directions, widths and lane centres in the root node's extras
 * @constraint roadWidth and markings apply to straight and curve; roadLength applies to straight; bendAngle, bendRadius and bendSide apply to curve; roadSurface applies to socketed road modules
 * @constraint bake-time only, so keep it a dev dependency; textures are capped at 1024 px like the page's export
 * @requires npm i -D @threenative/procedural-environment
 * @example await bakeCity({ module: "cross", out: "assets/city" });
 * @example await bakeCity({ module: "curve", bendAngle: 55, bendRadius: 24, bendSide: "left", roadWidth: 12, sidewalk: false, curb: false, out: "assets/city" });
 * @example await bakeCity({ module: "apartments", seed: 7, floors: 8, out: "assets/city" });
 */
export async function bakeCity(options: IBakeCityOptions): Promise<IEnvironmentBake[]> {
  const ids = cityModules().map((module) => module.id);
  if (!ids.includes(options.module))
    throw new Error(
      `bakeCity: unknown module "${options.module}". Nearest ids: ${nearestPresets(options.module, 3, ids).join(", ")}. Call environmentElements({ kind: "city" }) for all ${ids.length}.`,
    );
  const city = await buildCity(options);
  await mkdir(options.out, { recursive: true });
  const file = path.join(options.out, city.file);
  await writeAtomic(file, await webpImages(city.glb));
  return [{ bounds: city.bounds, lod: 0, path: file, triangles: city.triangles }];
}
