import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import Arbor, { type IArborPreset } from "../vendor/arbor.js";

export interface IVegetationPreset {
  readonly id: string;
  readonly name: string;
  readonly latin?: string;
  /** `tree` or `cover` (grass, fern, flower, shrub). */
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

/**
 * List every Arbor preset: id, name, latin name and kind.
 * @situation list the oak, pine, spruce, palm and other tree species a bake can grow
 * @situation choose a tree species id for bakeVegetation or a terrain arbor: species
 * @constraint ids come from the vendored Arbor presets; trees are kind "tree", grass, ferns and flowers are kind "cover"
 * @requires npm i -D @threenative/procedural-vegetation
 * @example vegetationPresets().filter((p) => p.kind === "tree").map((p) => p.id);
 */
export function vegetationPresets(): IVegetationPreset[] {
  return Object.values(Arbor.PRESETS).map(({ id, name, latin, kind }) => ({
    id,
    name,
    ...(latin ? { latin } : {}),
    kind,
  }));
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
  return Object.keys(Arbor.PRESETS)
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

/**
 * Bake a procedural tree (Arbor) to GLBs, one per level of detail, ready for ctx.assets.model.
 * Each GLB carries the _WIND vertex attribute, COLOR_0, TEXCOORD_0, embedded bark and leaf textures and alpha-masked leaves.
 * @situation generate a procedural tree, an oak, pine, spruce, palm or any forest species as a GLB
 * @situation procedural oak tree GLB with level of detail for a game forest
 * @situation tree GLB for Unity, Unreal or Godot, with wind weights in a _WIND attribute
 * @constraint fails closed: an unknown preset throws naming the nearest ids, the seed must be an integer and each lod 0 to 2
 * @constraint the same preset, seed and lods write identical bytes; files are written atomically (temporary file, then rename)
 * @constraint bake-time only, so keep it a dev dependency; the game owns the look and the sway (a TSL render/wind.ts reading _WIND), because Arbor.three is not shipped
 * @requires npm i -D @threenative/procedural-vegetation
 * @example await bakeVegetation({ preset: "oak", seed: 7, lods: [0, 1], out: "assets/trees" });
 */
export async function bakeVegetation(options: IBakeVegetationOptions): Promise<IVegetationBake[]> {
  const { preset, out } = options;
  const seed = options.seed ?? 1;
  const lods = options.lods ?? [0];
  if (!Object.hasOwn(Arbor.PRESETS, preset))
    throw new Error(
      `bakeVegetation: unknown preset "${preset}". Nearest ids: ${nearestPresets(preset).join(", ")}. Call vegetationPresets() for the full list.`,
    );
  if (!Number.isInteger(seed))
    throw new Error(`bakeVegetation: seed must be an integer, got ${seed}`);
  if (lods.length === 0 || lods.some((lod) => !Number.isInteger(lod) || lod < 0 || lod > MAX_LOD))
    throw new Error(
      `bakeVegetation: lods must be a non-empty list of integers 0 to ${MAX_LOD}, got [${lods}]`,
    );
  if (new Set(lods).size !== lods.length) throw new Error(`bakeVegetation: lods repeat: [${lods}]`);
  const source = Arbor.PRESETS[preset] as IArborPreset;
  const bark = source.noBark ? undefined : Arbor.barkTexture(source.bark);
  const leaf = Arbor.leafTexture(preset, { createCanvas });
  const textures = {
    ...(bark
      ? {
          bark: rgbaPng(bark.width, bark.height, bark.color),
          barkNormal: rgbaPng(bark.width, bark.height, bark.normal),
        }
      : {}),
    leaf: rgbaPng(leaf.width, leaf.height, leaf.data),
  };
  await mkdir(out, { recursive: true });
  const baked: IVegetationBake[] = [];
  for (const lod of lods) {
    const tree = Arbor.generate(preset, { seed, lod });
    const file = path.join(out, `${preset}-${seed}-lod${lod}.glb`);
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
