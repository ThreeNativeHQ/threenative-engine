// Generated for you: ordinary Three.js; ThreeNative does not read this file.
//
// This file wires two things together and decides nothing itself. `quality.ts`, in this folder,
// owns which stages run at which tier and records what each one measured. `WorldEnvironment`,
// also in this folder, builds them and prints `TN_WORLD_ENVIRONMENT` naming every stage as
// applied or refused **with a reason**, so a stage that silently no-op'd is never mistaken for
// one you turned off.
//
// To make the game cheaper or prettier everywhere, edit `quality.ts`. To force one tier for one
// run — a desktop that is dropping frames, a capture you want to compare — pass it:
// `setupPost(renderer, scene, camera, { tier: "low" })`. Overriding does not silence the report:
// `TN_QUALITY_TIER` names the tier that ran either way.
import type { Camera, DirectionalLight, Scene } from "three";
import { type QualityTier, qualityPreset, resolveQualityTier } from "./quality.js";
import type { OutputRenderer } from "./worldEnvironment.js";
import { WorldEnvironment } from "./worldEnvironment.js";

export function setupPost(
  renderer: OutputRenderer,
  scene: Scene,
  camera: Camera,
  environment: {
    godraysLight?: DirectionalLight;
    mobile?: boolean;
    /** The renderer named a software adapter; this game's answer is its `low` tier. */
    software?: boolean;
    /** The renderer's GPU family (`ctx.renderer.gpuClass?.class`); `quality.ts` maps it to a start tier. */
    gpuClass?: string;
    /** Forces a tier, ignoring `mobile`. An unknown name throws rather than falling back. */
    tier?: QualityTier;
    onTierChanged?: (tier: QualityTier) => void;
  } = {},
) {
  const tier = resolveQualityTier({
    mobile: environment.mobile,
    gpuClass: environment.gpuClass,
    software: environment.software,
    tier: environment.tier,
  });
  const source = environment.tier === undefined ? "platform" : "override";
  console.info(
    `TN_QUALITY_TIER ${tier} mobile=${environment.mobile === true} software=${
      environment.software === true
    } source=${source}`,
  );
  const world = new WorldEnvironment(qualityPreset(tier));
  const applied = world.apply(renderer, scene, camera, {
    godraysLight: environment.godraysLight,
  });
  environment.onTierChanged?.(tier);
  return { tier, dispose: () => applied.dispose?.() };
}
