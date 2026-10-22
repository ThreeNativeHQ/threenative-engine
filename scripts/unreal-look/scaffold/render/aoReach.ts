// The reach of the contact occlusion (PRD-635). Unreal's short-range AO searches a fixed distance on the screen,
// not in the world: the reach is twice the screen probe downsample factor, 2 x 16 = 32 px
// (UE 5.8.3: Engine/Source/Runtime/Renderer/Private/Lumen/LumenScreenProbeGather.cpp:2665), and each step lands at
// the squared step fraction of it (Engine/Shaders/Private/Lumen/LumenScreenSpaceBentNormal.usf:355-358).
// The owned engine's GTAO takes it as the `reachPx` uniform (post_effects.cpp), in pixels of the occlusion target.

/** Unreal's screen reach in pixels at the display height. */
export const UNREAL_AO_REACH_PX = 32;
