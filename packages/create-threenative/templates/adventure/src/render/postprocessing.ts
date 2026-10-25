// Generated for you. This file wires two things together and decides nothing itself.
//
// `quality.ts`, in this folder, owns which overrides each tier adds to the engine's look.
// `WorldEnvironment` from the engine core builds the chain and prints `TN_RENDER_CHAIN` and
// `TN_WORLD_ENVIRONMENT`, naming every stage as applied or refused **with a reason**, so a stage
// that silently no-op'd is never mistaken for one you turned off.
//
// To force one tier for one run — a desktop that is dropping frames, a capture you want to
// compare — pass it: `setupPost(renderer, scene, camera, { tier: "low" })`. Overriding does not
// silence the report: `TN_QUALITY_TIER` names the tier that ran either way.
import { type OutputRenderer, WorldEnvironment } from "@threenative/core";
import type { Camera, DirectionalLight, Scene } from "three";
import { type QualityTier, qualityPreset, resolveQualityTier } from "./quality.js";

import { temporalDetailRequested, temporalDetailStage } from "./temporalDetailStage.js";

type ProfileGlobals = typeof globalThis & {
  __THREENATIVE_PROFILE__?: { hostedSoftware?: unknown };
};

export function setupPost(
  renderer: OutputRenderer,
  scene: Scene,
  camera: Camera,
  environment: {
    godraysLight?: DirectionalLight;
    mobile?: boolean;
    /** The renderer named a software adapter; this game's answer is its `low` tier. */
    software?: boolean;
    /** The renderer's GPU family (`ctx.renderer.gpuClass?.class`); it picks the start tier. */
    gpuClass?: string;
    /** Forces a tier, ignoring `mobile`. An unknown name throws rather than falling back. */
    tier?: QualityTier;
  } = {},
): { readonly tier: QualityTier; dispose(): void } {
  // The native production collector explicitly marks a software-only hosted smoke run; that run
  // takes the `low` look so its screenshot settles on a CPU adapter. An ordinary desktop is `high`.
  const hostedSoftware =
    (globalThis as ProfileGlobals).__THREENATIVE_PROFILE__?.hostedSoftware === true;
  const tier = resolveQualityTier({
    mobile: environment.mobile,
    gpuClass: environment.gpuClass,
    software: environment.software,
    tier: environment.tier ?? (hostedSoftware ? "low" : undefined),
  });
  const source =
    environment.tier !== undefined ? "override" : hostedSoftware ? "hosted-software" : "platform";
  console.info(
    `TN_QUALITY_TIER ${tier} mobile=${environment.mobile === true} software=${
      environment.software === true
    } source=${source}`,
  );
  const settings = qualityPreset(tier);
  const world = new WorldEnvironment({
    ...settings,
    authoredStageNames: [
      ...(settings.authoredStageNames ?? []),
      ...(temporalDetailRequested(renderer, settings) ? ["sharpen" as const] : []),
    ],
    authoredStages: () => [temporalDetailStage()],
  });
  const applied = world.apply(renderer, scene, camera, { godraysLight: environment.godraysLight });
  let disposed = false;
  return {
    tier,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      applied.dispose?.();
    },
  };
}
