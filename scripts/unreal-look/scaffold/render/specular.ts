// Diagnosis only, harness side: `?specular=0` takes the specular off every surface, the way Unreal's own
// ShowFlag.Specular does, so its share of a direct-light row can be read on both engines.
//
// The flag zeroes the view's SpecularOverrideParameter (MoviePipelineUtils.cpp:207-210) and the base pass
// applies it to the G-buffer's F0 (BasePassPixelShader.usf:1280; Substrate's SanitizeF0 at
// Substrate/Substrate.ush:3438). That is not F0 alone: the slab then multiplies its F90 by the F0
// micro-occlusion weight (Substrate/SubstrateEvaluation.ush:488),
//
//   F90 *= F0RGBToMicroOcclusion(F0) = saturate(50 * F0)        (ShadingCommon.ush:158-167)
//
// which is 1 at 0.04 and 0 at 0, so the flag takes both halves of F_Schlick(F0, F90, VoH) and the whole lobe
// goes at every angle. A standard material keeps three's fixed 0.04 dielectric F0 with no flag to lower it, so
// the twin is physical and gives both the source's zero: F0 = min(((ior - 1) / (ior + 1))^2 * specularColor, 1)
// * specularIntensity is 0 at ior 1, and F90 = mix(specularIntensity, 1, metalness) is 0 at specularIntensity 0
// (packages/runtime-native/src/engine/shader/standard.cpp, setupSpecular).
//
// Round 7 read the flag as F0 only and kept F90 at 1; that ablation removes 0.04 * (1 - (1 - VoH)^5) of the
// lobe instead of all of it, which undercounts a grazing row by 5 to 9 times (PRD-646 round 8). `?specular=f0`
// is that reading, kept on its own name so round 7's recorded arms stay reproducible. `?specular=0` is the flag.
import { type Color, MeshPhysicalMaterial, type MeshStandardMaterial } from "three";
import { copyFields } from "./giCache.js";

/** What a surface keeps when its specular is off: every field copied, and F0 with F90 at zero. */
export function noSpecularTwin(
  source: MeshStandardMaterial,
  keepGrazingFresnel = false,
): MeshPhysicalMaterial {
  const twin = new MeshPhysicalMaterial();
  copyFields(source, twin as unknown as Record<string, unknown>);
  twin.ior = 1;
  // `?specular=f0` (round 7): F0 = 0 with F90 = 1 leaves F_Schlick = (1 - VoH)^5, a grazing lobe the flag does
  // not leave behind.
  twin.specularIntensity = keepGrazingFresnel ? 1 : 0;
  twin.specularColor.set(0xffffff);
  // Markers three does not declare, marked before the swap: the sunrise foliage model and its back-face colour.
  if (source.twoSidedFoliage === true) twin.twoSidedFoliage = true;
  const subsurface = source.subsurfaceColor as Color | undefined;
  if (subsurface !== undefined) twin.subsurfaceColor = subsurface;
  twin.needsUpdate = true;
  return twin;
}
