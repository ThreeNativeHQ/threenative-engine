// The reach of the contact occlusion (PRD-635). Unreal's short-range AO searches a fixed distance on the screen,
// not in the world: the reach is twice the screen probe downsample factor, 2 x 16 = 32 px
// (UE 5.8.3: Engine/Source/Runtime/Renderer/Private/Lumen/LumenScreenProbeGather.cpp:2665), and each step lands at
// the squared step fraction of it (Engine/Shaders/Private/Lumen/LumenScreenSpaceBentNormal.usf:355-358).
// The owned engine's GTAO takes it as the `reachPx` uniform (post_effects.cpp), in pixels of the occlusion target.

/** Unreal's screen reach in pixels at the display height. */
export const UNREAL_AO_REACH_PX = 32;

// Diagnosis: the contact occlusion's knobs by URL name on a calibration scene, every layer (PRD-635); Reference.ts.in
// keeps its own table, because a --baseline scaffold has no aoReach.ts. ?gtaoR=M (metres)
// and ?gtaoS=N are the short names of gtaoRadius and gtaoScale; ?gtaoReachPx=N sets the screen reach (Unreal's is 32);
// ?gtaoIndirectOnly=0 lets the whole frame take the occlusion.
const GTAO_KNOBS: Record<string, string> = {
  gtaoR: "gtaoRadius",
  gtaoS: "gtaoScale",
  gtaoRadius: "gtaoRadius",
  gtaoReachPx: "gtaoReachPx",
  gtaoSamples: "gtaoSamples",
  gtaoScale: "gtaoScale",
  gtaoDistanceExponent: "gtaoDistanceExponent",
  gtaoDistanceFalloff: "gtaoDistanceFalloff",
  gtaoThickness: "gtaoThickness",
  gtaoDenoiseRadius: "gtaoDenoiseRadius",
  gtaoMultiBounceAlbedo: "gtaoMultiBounceAlbedo",
  gtaoIndirectOnly: "gtaoIndirectOnly",
};

/** The `WorldEnvironment` options that the page URL sets through the knobs above. */
export function gtaoUrlKnobs(params: URLSearchParams): Record<string, number | boolean> {
  return Object.fromEntries(
    Object.entries(GTAO_KNOBS)
      .filter(([name]) => params.get(name) !== null)
      .map(([name, option]) => [
        option,
        option === "gtaoIndirectOnly" ? params.get(name) !== "0" : Number(params.get(name)),
      ]),
  );
}
