/**
 * Foliage that the cook can make cheaper without the game asking (PRD-458 §4, §5).
 *
 * Two passes live here because they are two halves of one argument. **Cutout conversion** turns a
 * `BLEND` material whose alpha comes only from a texture into `MASK` + `alphaCutoff`, which is what
 * makes it *eligible* for a discrete chain at all — `classifyPrimitive` declines every non-opaque
 * primitive, so a needle card exported as `BLEND` is a tree with no LOD. **Material merge** then
 * collapses the materials that only differed because the conversion had not run, or because each
 * one still held a private copy of an image the cook has since shared.
 *
 * Eligibility is deliberately narrow. Real translucency — transmission, volume, displacement, a
 * uniform alpha below 1, or a vertex-colour alpha fade — keeps `BLEND`, because a cutoff turns a
 * soft edge into a hard one and that is a look change, not an optimisation. A per-asset override
 * (`assets.lod.cutout`, and `cutout: false` inside `assets.lod.overrides[<path>]`) opts an asset
 * out of the conversion without touching the rest of the project.
 */

import type { Document, Material, Primitive, Texture } from "@gltf-transform/core";
import { materialStateOf } from "./content/census.js";
import { dedupeMaterials, materialSignature } from "./content/dedupe-materials.js";
import { decodeImageBytes } from "./passes/decode-image.js";

/** The alpha threshold a converted cutout samples at; `renderer.alphaAntialiasing` softens it. */
export const CUTOUT_ALPHA_CUTOFF = 0.5;

/** What the cook did to one model's foliage, for the build report and the manifest. */
export interface IFoliageCutoutSummary {
  /** Material names converted `BLEND` → `MASK`, in document order. */
  readonly converted: readonly string[];
  /** `BLEND` materials that kept their blending, and why by name — reported, never silent. */
  readonly kept: readonly { readonly name: string; readonly reason: CutoutSkipReason }[];
}

export type CutoutSkipReason =
  | "no-texture-alpha"
  | "uniform-transparency"
  | "vertex-colour-alpha"
  | "volume-or-transmission"
  | "no-cutout-texels";

const VOLUME_EXTENSIONS = ["transmission", "volume", "displacement"] as const;

/** True when a `BLEND` material's only alpha is its base-colour texture — a cut-out, not a fade. */
async function cutoutSkipReason(
  material: Material,
  primitives: readonly Primitive[],
): Promise<CutoutSkipReason | null> {
  // No texture means no texture alpha: a uniform fade cannot be cut out.
  const baseTexture = material.getBaseColorTexture();
  if (baseTexture === null) return "no-texture-alpha";
  if ((material.getBaseColorFactor()[3] ?? 1) < 1) return "uniform-transparency";
  for (const extension of material.listExtensions()) {
    const name = extension.extensionName.toLowerCase();
    if (VOLUME_EXTENSIONS.some((needle) => name.includes(needle))) return "volume-or-transmission";
  }
  // A VEC4 COLOR_0 is only a per-vertex alpha fade when its alpha actually varies below 1. Asset
  // packs export every vertex colour as RGBA with alpha 255, and a cutoff reproduces alpha 1
  // exactly, so a constant alpha is not a reason to refuse — measuring the data is (PRD-458 §4).
  if (primitives.some(vertexAlphaVaries)) return "vertex-colour-alpha";

  // A cutout must cut something: if no texel is below the cutoff threshold, keep BLEND (translucency, not cutout).
  const hasCutout = await textureHasCutoutTexels(baseTexture);
  if (hasCutout === false) return "no-cutout-texels";

  return null;
}

/**
 * Returns false only when the texture successfully decodes and has NO texel with alpha below CUTOUT_ALPHA_CUTOFF.
 * If decoding fails or format is unknown, returns true to preserve current behaviour.
 */
async function textureHasCutoutTexels(texture: Texture): Promise<boolean> {
  const imageBytes = texture.getImage();
  if (imageBytes === null || imageBytes.length === 0) return true;
  try {
    const decoded = await decodeImageBytes(
      Buffer.from(imageBytes),
      texture.getURI() || texture.getName() || "texture",
    );
    const { data } = decoded;
    const cutoffByte = CUTOUT_ALPHA_CUTOFF * 255;
    for (let i = 3; i < data.length; i += 4) {
      if ((data[i] as number) < cutoffByte) return true;
    }
    return false;
  } catch {
    return true;
  }
}

/** True when a `COLOR_0`'s alpha channel is a real per-vertex fade, not a constant opaque 1. */
function vertexAlphaVaries(primitive: Primitive): boolean {
  const color = primitive.getAttribute("COLOR_0");
  if (color === null || color.getElementSize() !== 4) return false;
  const element: number[] = [0, 0, 0, 0];
  for (let vertex = 0; vertex < color.getCount(); vertex += 1) {
    color.getElement(vertex, element);
    if ((element[3] as number) < 1) return true;
  }
  return false;
}

function usesMaterial(primitives: readonly Primitive[], material: Material): Primitive[] {
  return primitives.filter((primitive) => primitive.getMaterial() === material);
}

/**
 * Converts eligible `BLEND` foliage to alpha-tested, per model.
 *
 * Order matters: this runs before the LOD bake, because a primitive is only *eligible* once its
 * material is `MASK`. A `MASK` material with no base-colour texture is left alone — it was already
 * cut out by the author, and there is nothing to convert.
 */
export async function convertFoliageCutout(document: Document): Promise<IFoliageCutoutSummary> {
  const root = document.getRoot();
  const primitives = root.listMeshes().flatMap((mesh) => [...mesh.listPrimitives()]);
  const converted: string[] = [];
  const kept: { name: string; reason: CutoutSkipReason }[] = [];
  for (const material of root.listMaterials()) {
    if (material.getAlphaMode() !== "BLEND") continue;
    const name = material.getName();
    const reason = await cutoutSkipReason(material, usesMaterial(primitives, material));
    if (reason !== null) {
      kept.push({ name, reason });
      continue;
    }
    material.setAlphaMode("MASK").setAlphaCutoff(CUTOUT_ALPHA_CUTOFF);
    converted.push(name);
  }
  return { converted, kept };
}

/** What the cook's material merge collapsed, for the build report and the manifest. */
export interface IMaterialMergeSummary {
  /** Names repointed onto an identical twin, in the order they were found. */
  readonly merged: readonly string[];
  /** Materials in the document before and after; `distinct` is the count of signatures. */
  readonly materials: { readonly after: number; readonly before: number };
  readonly distinct: { readonly after: number; readonly before: number };
}

/**
 * Points every primitive at one material per identical group and drops the rest.
 *
 * The signature is the one the content census already takes — every texture slot, every uniform
 * and every draw flag, and deliberately *not* the name, because an imported pack names a material
 * per part and that is exactly what kept 213 singletons in the reference game. This runs after
 * `prune` (which drops unreferenced materials) and after the cutout conversion, so two materials
 * that only differed by `BLEND` vs `MASK` collapse here.
 */
export function mergeIdenticalMaterials(document: Document): IMaterialMergeSummary {
  const root = document.getRoot();
  const materials = root.listMaterials();
  const states = materials.map(materialStateOf);
  const before = dedupeMaterials(states).census;
  // Grouped by index, not by name: the signature ignores names on purpose, so two materials may
  // share one, and the merge needs the objects themselves.
  const groups = new Map<string, number[]>();
  states.forEach((state, index) => {
    const signature = materialSignature(state);
    const group = groups.get(signature);
    if (group === undefined) groups.set(signature, [index]);
    else group.push(index);
  });
  const merged: string[] = [];
  for (const group of groups.values()) {
    const [keeper, ...victims] = group;
    const keep = keeper === undefined ? undefined : materials[keeper];
    if (keep === undefined) continue;
    for (const index of victims) {
      const victim = materials[index];
      if (victim === undefined || victim === keep) continue;
      for (const mesh of root.listMeshes()) {
        for (const primitive of mesh.listPrimitives()) {
          if (primitive.getMaterial() === victim) primitive.setMaterial(keep);
        }
      }
      merged.push(victim.getName());
      victim.dispose();
    }
  }
  const after = root.listMaterials();
  return {
    distinct: {
      after: dedupeMaterials(after.map(materialStateOf)).census.buckets,
      before: before.buckets,
    },
    materials: { after: after.length, before: before.materials },
    merged,
  };
}
