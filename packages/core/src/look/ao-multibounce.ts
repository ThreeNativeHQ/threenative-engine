// Multi-bounce on the contact occlusion (PRD-635). Light that an occluder blocks bounces off other pale surfaces, so a
// pale surface loses less to its own occlusion than a dark one. Unreal passes the short-range AO through the
// Jimenez et al. 2016 fit ("Practical Realtime Strategies for Accurate Indirect Occlusion") per colour channel, with
// the albedo capped at 0.5 (UE 5.8.3: Engine/Shaders/Private/DiffuseIndirectComposite.usf:195,
// Engine/Shaders/Private/DeferredShadingCommon.ush:1364 and
// Engine/Source/Runtime/Renderer/Private/Lumen/LumenScreenSpaceBentNormal.cpp:56).

/** The albedo cap, `r.Lumen.ScreenProbeGather.ShortRangeAO.MaxMultibounceAlbedo`. 0 leaves the occlusion as it is. */
export const UNREAL_AO_MULTIBOUNCE_ALBEDO = 0.5;

/** The fit's coefficients as `[slope, offset]` of the albedo, for the cubic's three terms. */
export const AO_MULTIBOUNCE_FIT = {
  a: [2.0404, -0.3324],
  b: [-4.7951, 0.6417],
  c: [2.7552, 0.6903],
} as const;

/** The occlusion one colour channel keeps after multi-bounce, for the albedo of that channel. */
export function aoMultiBounce(
  albedo: number,
  occlusion: number,
  cap = UNREAL_AO_MULTIBOUNCE_ALBEDO,
): number {
  const base = Math.min(albedo, cap);
  const [a, b, c] = [AO_MULTIBOUNCE_FIT.a, AO_MULTIBOUNCE_FIT.b, AO_MULTIBOUNCE_FIT.c].map(
    ([slope, offset]) => slope * base + offset,
  ) as [number, number, number];
  return Math.max(occlusion, ((occlusion * a + b) * occlusion + c) * occlusion);
}
