import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import Arbor, { type IArborPart, type IArborPreset, type IArborTree } from "../vendor/arbor.js";
import ForestKit, {
  type IForestKitMesh,
  type IForestKitPreset,
} from "../vendor/forest-kit/index.js";

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
}

export interface IVegetationBake {
  readonly bounds: {
    readonly max: readonly [number, number, number];
    readonly min: readonly [number, number, number];
  };
  readonly lod: number;
  readonly path: string;
  readonly triangles: number;
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
 * @requires npm i -D @threenative/procedural-vegetation
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
function nearestPresets(id: string, count = 3): string[] {
  return [...Object.keys(Arbor.PRESETS), ...Object.keys(ForestKit.PRESETS)]
    .map((candidate) => ({
      candidate,
      score: candidate.includes(id) || id.includes(candidate) ? 0 : distance(id, candidate),
    }))
    .sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate))
    .slice(0, count)
    .map((entry) => entry.candidate);
}

function rgbaPng(width: number, height: number, bottomUp: Uint8Array): Uint8Array {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");
  const image = context.createImageData(width, height);
  // Arbor stores row 0 at the bottom; PNG row 0 is the top.
  for (let y = 0; y < height; y++)
    image.data.set(
      bottomUp.subarray((height - 1 - y) * width * 4, (height - y) * width * 4),
      y * width * 4,
    );
  context.putImageData(image, 0, 0);
  return canvas.encodeSync("png");
}

/** The preset with a game's form patch merged in: list rows merge by index, other keys replace. */
function withForm(
  id: string,
  source: IArborPreset,
  form: Readonly<Record<string, unknown>> | undefined,
): IArborPreset {
  if (form === undefined) return source;
  const base = source as unknown as Record<string, unknown>;
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
  return merged as unknown as IArborPreset;
}

/**
 * Arbor numbers its atlas cells from the bottom row up (it paints and stores its own card bottom-up),
 * while a game's `leafImage` numbers them from the top-left. Each leaf row's cells are flipped by row,
 * so cell 0 of a game's image is its top-left cell, as the option says.
 */
function topDownCells(source: IArborPreset): IArborPreset {
  const preset = source as unknown as {
    tex?: { grid: readonly [number, number] };
    leaves?: readonly { cells?: readonly number[] }[];
  };
  const [cols, rows] = preset.tex?.grid ?? [1, 1];
  const flip = (cell: number): number =>
    (rows - 1 - Math.floor(cell / cols)) * cols + (cell % cols);
  return {
    ...preset,
    leaves: preset.leaves?.map((row) =>
      row.cells === undefined ? row : { ...row, cells: row.cells.map(flip) },
    ),
  } as unknown as IArborPreset;
}

/** The leaf PNG (the game's image, else Arbor's drawn card) and the file-name tag of a game's patch. */
async function leafOf(
  source: IArborPreset,
  options: IBakeVegetationOptions,
): Promise<{ leaf: Uint8Array; tag: string }> {
  const image = options.leafImage === undefined ? undefined : await readFile(options.leafImage);
  if (image !== undefined && !image.subarray(0, 8).equals(PNG_SIGNATURE))
    throw new Error(`bakeVegetation: leafImage ${options.leafImage} is not a PNG`);
  const patched = options.form !== undefined || image !== undefined;
  const hash = createHash("sha256")
    .update(JSON.stringify(options.form ?? null))
    .update(image ?? "");
  const tag = patched ? `-f${hash.digest("hex").slice(0, 8)}` : "";
  if (image !== undefined) return { leaf: image, tag };
  const drawn = Arbor.leafTexture(source, { createCanvas });
  return { leaf: rgbaPng(drawn.width, drawn.height, drawn.data), tag };
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
  if (forest !== null && (options.form !== undefined || options.leafImage !== undefined))
    throw new Error(
      `bakeVegetation: form and leafImage patch an Arbor preset, and "${preset}" is a forest-kit ${forest.kind} with no leaf card to patch`,
    );
  if (!Number.isInteger(seed))
    throw new Error(`bakeVegetation: seed must be an integer, got ${seed}`);
  if (lods.length === 0 || lods.some((lod) => !Number.isInteger(lod) || lod < 0 || lod > MAX_LOD))
    throw new Error(
      `bakeVegetation: lods must be a non-empty list of integers 0 to ${MAX_LOD}, got [${lods}]`,
    );
  if (new Set(lods).size !== lods.length) throw new Error(`bakeVegetation: lods repeat: [${lods}]`);
  return { arbor, forest, lods, seed };
}

/**
 * Bake a procedural tree (Arbor) to GLBs, one per level of detail, ready for ctx.assets.model.
 * Each GLB carries the _WIND vertex attribute, COLOR_0 and TEXCOORD_0; the Arbor presets also embed
 * their bark and leaf textures with alpha-masked leaves, while forest-kit debris and cover shade
 * from COLOR_0 alone.
 * @situation generate a procedural tree, an oak, pine, spruce, palm or any forest species as a GLB
 * @situation procedural oak tree GLB with level of detail for a game forest
 * @situation tree GLB for Unity, Unreal or Godot, with wind weights in a _WIND attribute
 * @situation a fallen mossy log and leaf litter on the forest floor, with a stump, twigs and boulders
 * @situation reeds and cattails at a pond edge, or sedge tussocks, clover and seeding grass as cover
 * @constraint fails closed: an unknown preset throws naming the nearest ids, the seed must be an integer and each lod 0 to 2
 * @constraint the same preset, seed and lods write identical bytes; files are written atomically (temporary file, then rename)
 * @constraint bake-time only, so keep it a dev dependency; the game owns the look and the sway (a TSL render/wind.ts reading _WIND), because Arbor.three is not shipped
 * @constraint _WIND is vec4 (trunk sway, branch sway, flutter, phase): forest-kit sway is flutter in z, and debris writes all four zero
 * @constraint form and leafImage patch an Arbor preset only; a forest-kit debris or cover preset throws when given either
 * @requires npm i -D @threenative/procedural-vegetation
 * @example await bakeVegetation({ preset: "oak", seed: 7, lods: [0, 1], out: "assets/trees" });
 * @example await bakeVegetation({ preset: "log", seed: 3, out: "assets/debris" });
 */
export async function bakeVegetation(options: IBakeVegetationOptions): Promise<IVegetationBake[]> {
  const { preset, out } = options;
  const { arbor, forest, lods, seed } = resolveBake(preset, options);
  if (forest !== null) return bakeForestKit(preset, forest, { lods, out, seed });
  const formed = withForm(preset, arbor as IArborPreset, options.form);
  const source = options.leafImage === undefined ? formed : topDownCells(formed);
  const { leaf, tag } = await leafOf(source, options);
  const bark = source.noBark ? undefined : Arbor.barkTexture(source.bark);
  const textures = {
    ...(bark
      ? {
          bark: rgbaPng(bark.width, bark.height, bark.color),
          barkNormal: rgbaPng(bark.width, bark.height, bark.normal),
        }
      : {}),
    leaf,
  };
  await mkdir(out, { recursive: true });
  const baked: IVegetationBake[] = [];
  for (const lod of lods) {
    const tree = Arbor.generate(source, { seed, lod });
    const file = path.join(out, `${preset}-${seed}${tag}-lod${lod}.glb`);
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, Arbor.toGLB(tree, textures), { flag: "wx" });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
    baked.push({
      bounds: { max: tree.bounds.max, min: tree.bounds.min },
      lod,
      path: file,
      triangles: tree.triangles,
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
  options: { lod: number; seed: number },
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
  // Debris is opaque wood and stone on the bark primitive; cover is a thin strip that must show
  // from both sides and is alpha-masked like a leaf card, so it rides the foliage primitive.
  const onBark = preset.part === "bark";
  return {
    bark: onBark ? part : EMPTY_PART,
    bounds: { max, min },
    leaves: onBark ? EMPTY_PART : part,
    preset: { bark: "", id, name: preset.name },
    triangles: mesh.idx.length / 3,
  };
}

/** A forest-kit preset's GLBs: no bark or leaf atlas, all colour in COLOR_0. */
async function bakeForestKit(
  preset: string,
  source: IForestKitPreset,
  options: { lods: readonly number[]; out: string; seed: number },
): Promise<IVegetationBake[]> {
  await mkdir(options.out, { recursive: true });
  const baked: IVegetationBake[] = [];
  for (const lod of options.lods) {
    const tree = forestKitTree(preset, source, { lod, seed: options.seed });
    const file = path.join(options.out, `${preset}-${options.seed}-lod${lod}.glb`);
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, Arbor.toGLB(tree), { flag: "wx" });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
    baked.push({
      bounds: { max: tree.bounds.max, min: tree.bounds.min },
      lod,
      path: file,
      triangles: tree.triangles,
    });
  }
  return baked;
}
