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
import { type Camera, type DirectionalLight, FloatType, type Scene } from "three";
import { LUTCubeLoader } from "three/addons/loaders/LUTCubeLoader.js";
import {
  type IAdaptiveQualityOptions,
  type IQualityWindow,
  createAdaptiveQuality,
  formatQualityAdaptation,
} from "./adaptiveQuality.js";
import { type IGradeTable, filterableTable, gradeStages } from "./grade.js";
import { type QualityTier, gradePreset, qualityPreset } from "./quality.js";
import { type TemporalAAProvider, temporalAAStages } from "./temporalAAStage.js";
import type { FogMedium } from "./volumetricFog.js";
import { type OutputRenderer, WorldEnvironment } from "./worldEnvironment.js";

interface IPostController {
  readonly tier: QualityTier;
  debug(): Record<string, unknown>;
  observe(window: IQualityWindow): void;
  dispose(): void;
}

/**
 * This game's colour table, relative to the page so it resolves the same way served and packaged.
 * `public/grade.cube` is written by `tools/make-grade-lut.mjs`, and replacing it with a `.cube`
 * from any grading tool is the whole of "change the grade".
 */
const GRADE_TABLE_URL = "grade.cube";

let active: IPostController | undefined;
/**
 * The table, kept for the page's life. Every scene entry builds a controller, and a restart is an
 * entry: fetching the file again and rebuilding the chain around it compiled the whole graph
 * twice, and the world stayed black behind the HUD for both compiles.
 */
let cachedTable: IGradeTable | undefined;

/** The starter's game.ts connects its existing completed frame-window callback here. */
export function observeQualityWindow(window: IQualityWindow): void {
  active?.observe(window);
}

export function setupPost(
  renderer: OutputRenderer,
  scene: Scene,
  camera: Camera,
  environment: IAdaptiveQualityOptions & {
    godraysLight?: DirectionalLight;
    mobile?: boolean;
    /** The renderer named a software adapter; this game's answer is its `low` tier. */
    software?: boolean;
    /** The renderer's GPU family (`ctx.renderer.gpuClass?.class`); `quality.ts` maps it to a start tier. */
    gpuClass?: string;
    /** Forces a tier while keeping its costs observed. Unknown names throw. */
    tier?: QualityTier;
    /** Scene-owned material assignments follow the same resolved tier. */
    onTierChanged?: (tier: QualityTier) => void;
    /**
     * The bounded participating medium from `volumetricFog.ts`, built once per graph: a tier change
     * replaces the graph, and a fog controller owns one graph, so it is released and rebuilt here
     * rather than composed twice. Omit it and the chain starts from the beauty pass unchanged.
     */
    fog?: () => FogMedium | undefined;
  } = {},
): IPostController {
  const policy = createAdaptiveQuality(environment, environment);
  active?.dispose();
  let disposed = false;
  let disposeGraph: (() => void) | undefined;
  let medium: FogMedium | undefined;
  let table: IGradeTable | undefined = cachedTable;
  // The opt-in `traa` stage publishes its provider here once the chain has built it, so `debug()`
  // reports the live reconstruction state and a scene can reset history on a teleport.
  let temporal: TemporalAAProvider | undefined;
  let observation: Record<string, unknown> = {
    tier: policy.tier,
    source: policy.pinned ? "pinned" : "auto",
  };
  function apply(): void {
    // Replacement is serialized: no old graph or subscription remains alive beside the new one.
    disposeGraph?.();
    medium?.dispose();
    medium = environment.fog?.();
    const composed = medium;
    const settings = qualityPreset(policy.tier);
    const world = new WorldEnvironment({
      ...settings,
      // Two stages this game owns, not the chain's: `grade.ts` builds them, `WorldEnvironment`
      // orders and reports them, and `quality.ts` decides whether each tier runs them. The opt-in
      // `traa` stage is offered beside them and runs only when a tier names it.
      authoredStageNames: ["grade", "grain"],
      authoredStages: (stage) => [
        ...gradeStages(gradePreset(policy.tier), table),
        ...temporalAAStages(stage, {
          onProvider: (provider) => {
            temporal = provider;
          },
        }),
      ],
    });
    const applied = world.apply(renderer, scene, camera, {
      godraysLight: environment.godraysLight,
      // Ahead of exposure and every stage, which is the only place a participating medium can go.
      baseColour: composed === undefined ? undefined : (scenePass) => composed.compose(scenePass),
    });
    disposeGraph = applied.dispose;
    observation = { ...observation, stages: applied.stages, dropped: applied.dropped };
    environment.onTierChanged?.(policy.tier);
  }
  apply();
  // The table is a file, so on the first entry it lands after the chain that would read it. Until
  // then both stages are refused with a reason rather than grading nothing, and the chain is
  // rebuilt once it does. Later entries start with the table and never rebuild.
  // The loader parses `FloatType`, because the default 8-bit load *truncates* `value * 255` into a
  // `Uint8Array`. An identity table then reads low by up to 0.875 of a step, and the round trip
  // through the grade is never the frame the game drew. Parsed floats keep the file's own numbers.
  // `filterableTable` then uploads them as half floats. A float32 3D texture is not filterable
  // without the optional `float32-filterable` feature, so the lookup would sample the nearest of
  // the nine cells. The arithmetic in `__tests__/grade.spec.ts` runs on those half floats.
  const tableLoader = new LUTCubeLoader().setType(FloatType);
  if (table === undefined)
    void tableLoader.loadAsync(GRADE_TABLE_URL).then(
      (loaded) => {
        table = cachedTable = { size: loaded.size, texture: filterableTable(loaded.texture3D) };
        if (!disposed) apply();
      },
      (error: unknown) => {
        // A missing table is this game's file, not the harness's: name it and leave the frame
        // ungraded rather than reporting a stage as applied that never ran.
        console.error(
          `TN_GRADE_TABLE ${GRADE_TABLE_URL}: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );
  const source = environment.tier === undefined ? "platform" : "override";
  console.info(
    `TN_QUALITY_TIER ${policy.tier} mobile=${environment.mobile === true} software=${
      environment.software === true
    } source=${source}`,
  );
  const controller = {
    get tier(): QualityTier {
      return policy.tier;
    },
    debug: () => (temporal ? { ...observation, temporal: temporal.report() } : { ...observation }),
    observe(window: IQualityWindow): void {
      if (disposed) return;
      const decision = policy.observe(window);
      if (decision.changed) apply();
      observation = {
        stages: observation.stages,
        dropped: observation.dropped,
        ...decision,
        ...(Number.isInteger(window.window) ? { window: window.window } : {}),
      };
      console.info(formatQualityAdaptation(decision));
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      disposeGraph?.();
      disposeGraph = undefined;
      medium?.dispose();
      medium = undefined;
      // The table outlives any one chain and any one scene — a tier change or a restart builds a
      // graph around the same one — so no stage and no controller releases it.
      table = undefined;
      temporal = undefined;
      if (active === controller) active = undefined;
    },
  };
  active = controller;
  return controller;
}
