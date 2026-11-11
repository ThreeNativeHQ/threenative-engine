// The admission of the contact occlusion (PRD-635, PRD-617). Unreal's short-range AO darkens the light that
// arrives from around a surface and leaves the sun alone (UE 5.8.3:
// Engine/Shaders/Private/PostProcessAmbientOcclusion.usf composites the term on indirect light). The reach form
// of the stage has no world radius, so it cannot fall back to three's world-radius GTAO, which means it must
// know the indirect share of the frame. The owned engine writes it to its `indirectDiffuse` target; upstream three
// with no baked world cache has none: the stage would multiply
// the sun as well, and the `engine: "threejs"` arm, which drops the stage outright (`TN_AO_REACH_UNSUPPORTED`
// in `world-environment.ts`), would not show the same picture. Fail closed and name what is missing, rather
// than shipping one engine a contact shadow the other cannot draw.

/** What the stage needs to know about the request and the frame it would run on. */
export interface IAoAdmission {
  /** No authored `gtaoRadius`: the frame asks for Unreal's screen reach instead of a world radius. */
  readonly reach: boolean;
  /** The game asked for the indirect-only composite, which is the default. */
  readonly indirectOnly: boolean;
  /** The frame can tell its indirect share apart: the owned engine's `indirectDiffuse` target, or a baked world cache. */
  readonly hasIndirect: boolean;
}

/** Why the contact occlusion cannot run on this frame, or `undefined` when it can. */
export function aoRefusal(request: IAoAdmission): string | undefined {
  if (!request.reach || !request.indirectOnly || request.hasIndirect) return undefined;
  return "TN_AO_INDIRECT_UNSUPPORTED: the screen-reach occlusion darkens indirect light only, and this frame cannot tell its indirect share apart (upstream three, no baked world cache); set gtaoIndirectOnly false to darken the whole frame, run the owned engine, or let the scene bake a cache (finalGatherMethod)";
}
