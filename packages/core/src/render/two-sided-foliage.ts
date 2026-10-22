import type { Color, Material } from "three";
import { materialEmissive, vec3 } from "three/tsl";
import type { Node } from "three/webgpu";

declare module "three" {
  // biome-ignore lint/style/useNamingConvention: a module augmentation keeps three's own class name.
  interface Material {
    /**
     * The colour a Two Sided Foliage leaf returns from light that reaches its other face (PRD-643). Unreal's
     * `SubsurfaceColor`. Read only where `twoSidedFoliage` is true: a material without it gets no back term.
     */
    subsurfaceColor?: Color;
  }
}

/**
 * The light a Two Sided Foliage leaf takes through its back face: `subsurfaceColor` times the irradiance
 * (E / pi, the unit of `irradianceNode`) that arrives along the opposite of the normal the viewer sees.
 * Unreal adds the same product to the diffuse indirect light at Epic and Cinematic gather quality
 * (UE 5.8.3: `Engine/Shaders/Private/DiffuseIndirectComposite.usf`, the `SHADINGMODELID_TWOSIDED_FOLIAGE` branch).
 * The game reads its own cache along `normal.negate()` and passes the result; this adds it to the material's
 * `emissiveNode`, which both engines evaluate, so the leaf keeps its colours and the engine owns none of them.
 * @situation add bounce light to the far face of a two sided foliage leaf
 * @constraint the material needs `twoSidedFoliage = true` and a `subsurfaceColor`, or nothing is added and false is returned; backIrradiance is a vec3 node in the unit of `irradianceNode`; call once per material
 * @example addFoliageBackLight(leaf, cache.irradianceAt(positionWorld, normalWorld.negate()));
 */
export function addFoliageBackLight(material: Material, backIrradiance: Node<"vec3">): boolean {
  const colour = material.subsurfaceColor;
  if (material.twoSidedFoliage !== true || colour === undefined) return false;
  const back = vec3(colour.r, colour.g, colour.b).mul(backIrradiance);
  const target = material as { emissiveNode?: Node<"vec3"> | null };
  target.emissiveNode = (target.emissiveNode ?? materialEmissive).add(back);
  return true;
}
