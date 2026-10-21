import type { Object3D } from "three";
import { materialExamples, opacityIgnoredMaterials } from "./render-trap-audit.js";

/** Marker for the opacity convention turning transparency on for an authored opacity below 1. */
export const OPACITY_TRANSPARENT_MARKER = "TN_OPACITY_TRANSPARENT";

/**
 * Convention: authored opacity takes effect. three draws a material with opacity < 1 opaque unless
 * it is transparent or alpha-hashed, so this turns transparency on for each drawn one and returns
 * the warning line that says so, or undefined when nothing changed. The opacity stays the game's.
 * Override on the same material: `alphaHash: true`, or `opacity: 1` for an opaque surface.
 */
export function applyOpacityConvention(scene: Object3D): string | undefined {
  const materials = opacityIgnoredMaterials(scene);
  if (materials.size === 0) return undefined;
  for (const material of materials) {
    material.transparent = true;
    (material as { needsUpdate?: boolean }).needsUpdate = true;
  }
  return `${OPACITY_TRANSPARENT_MARKER}:${JSON.stringify({ materials: materials.size, examples: materialExamples(materials) })} opacity < 1 now draws transparent; set alphaHash: true or opacity: 1 on the material to override`;
}
