// Diagnosis only, harness side: `?specular=0` takes the specular off every surface, so its share of a direct-light
// row can be read the way Unreal's own ShowFlag.Specular reads it. The two are the same switch: the flag zeroes the
// view's SpecularOverrideParameter (MoviePipelineUtils.cpp:207-210), and the base pass applies it to the G-buffer's
// F0 (BasePassPixelShader.usf:1280), so the direct and the indirect specular term both lose F0. A standard material
// keeps three's fixed 0.04 dielectric F0 with no flag to lower it, so the twin is physical and gives F0 the source's
// zero: `F0 = min(((ior - 1) / (ior + 1))^2 * specularColor, 1) * specularIntensity` is 0 at ior 1
// (Engine/Shader/standard.cpp, setupSpecular). F90 stays 1, as Unreal's `F_Schlick(F0, VoH)` keeps it with F0 = 0
// (`ComputeF90`, ShadingCommon.ush:174-177): zeroing both would take the grazing lobe the flag leaves in place.
// Unset in every judged capture.
import { type Color, MeshPhysicalMaterial, type MeshStandardMaterial } from "three";
import { copyFields } from "./giCache.js";

/** What a surface keeps when its specular is off: every field copied, and F0 at zero with F90 left at 1. */
export function noSpecularTwin(source: MeshStandardMaterial): MeshPhysicalMaterial {
  const twin = new MeshPhysicalMaterial();
  copyFields(source, twin as unknown as Record<string, unknown>);
  twin.ior = 1;
  twin.specularIntensity = 1;
  twin.specularColor.set(0xffffff);
  // Markers three does not declare, marked before the swap: the sunrise foliage model and its back-face colour.
  if (source.twoSidedFoliage === true) twin.twoSidedFoliage = true;
  const subsurface = source.subsurfaceColor as Color | undefined;
  if (subsurface !== undefined) twin.subsurfaceColor = subsurface;
  twin.needsUpdate = true;
  return twin;
}
