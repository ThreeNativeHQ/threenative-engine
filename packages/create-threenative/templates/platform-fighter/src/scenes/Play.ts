import { Scene, type SceneFrame, getPlatform, isMobile } from "@threenative/core";
import { PLAYTEST_RUNNER_EXPECTED_GLOBAL } from "@threenative/core/playtest";
import { type IEnvironmentSample, sampleEnvironment } from "@threenative/core/render/environment";
import type { PerspectiveCamera } from "three";
import type { GameCtx, IMannequin } from "../entities/Fighter.js";
import { FighterView, type FighterView as View } from "../entities/FighterView.js";
import { emitPlaytestEvent } from "../playtest-events.js";
import { createFightCamera } from "../render/camera.js";
import { cloudTextures, primeCloudTextures } from "../render/clouds.js";
import { setupLighting } from "../render/lighting.js";
import { createLoadingScreen } from "../render/loading.js";
import { createMaterialLighting } from "../render/materialLighting.js";
import { setupPost } from "../render/postprocessing.js";
import {
  type QualityTier,
  isWebGLFallbackRenderer,
  materialLightingEnabled,
} from "../render/quality.js";
import { setupSky } from "../render/sky.js";
import { createStage } from "../render/stage.js";
import { STEP } from "../sim/constants.js";
import { cpuPad, newCpuMemory } from "../sim/cpu.js";
import { Match } from "../sim/match.js";
import type { FighterId } from "../sim/types.js";
import type { GameState } from "../state.js";
import { readPad } from "./pads.js";
import { matchState, round } from "./snapshot.js";
import { STATIONS } from "./stations.js";

/** Frames the CPU stands still at the start of a match, so the player can take a breath. */
const CPU_WAKE = 300;
const MESSAGE_TIME = 1.4;

/**
 * Playtest-only keys answer only when a playtest runner launched the page (the runner sets this
 * global before any game code runs). A player pressing them in a real build gets nothing.
 */
const UNDER_PLAYTEST =
  (globalThis as Record<string, unknown>)[PLAYTEST_RUNNER_EXPECTED_GLOBAL] === true;

export class Play extends Scene<GameState, undefined> {
  static override readonly initialState: GameState = {
    ...matchState(new Match(), {
      camera: { distance: 0, x: 0, y: 0 },
      cpuDummy: false,
      message: "",
    }),
    paused: false,
    uiReady: false,
  };

  #mannequin: IMannequin | undefined;
  #post: ReturnType<typeof setupPost> | undefined;
  #environmentSample: IEnvironmentSample | undefined;
  #materialLighting: ReturnType<typeof createMaterialLighting> | undefined;

  override async load(ctx: GameCtx): Promise<void> {
    // One rig for everyone: both fighters are the combat mannequin (Quaternius' Universal
    // Animation Library, CC0), dressed apart by a material swap.
    this.#mannequin = await ctx.assets.model<IMannequin>("mannequin-combat.glb");
    primeCloudTextures(await ctx.assets.memo("clouds", () => cloudTextures()));
    setupSky(ctx.scene, ctx.renderer.softwareAdapter !== undefined);
    this.#environmentSample = await sampleEnvironment(ctx.renderer.raw, ctx.scene, {
      web: getPlatform().runtime === "web",
      rendererKind: ctx.renderer.kind,
      webglFallback: isWebGLFallbackRenderer(ctx.renderer.raw),
      mobile: isMobile(),
      software: ctx.renderer.softwareAdapter !== undefined,
    });
  }

  override enter(ctx: GameCtx): SceneFrame<GameState, undefined> {
    const mannequin = this.#mannequin;
    if (mannequin === undefined)
      throw new Error("Play.enter ran before load() loaded mannequin-combat.glb.");
    const camera = ctx.camera as PerspectiveCamera;
    setupSky(ctx.scene, ctx.renderer.softwareAdapter !== undefined);
    const lighting = setupLighting(
      ctx.scene,
      ctx.renderer.raw as Parameters<typeof setupLighting>[1],
      isMobile(),
    );
    const materialEnvironment = {
      web: getPlatform().runtime === "web",
      rendererKind: ctx.renderer.kind,
      webglFallback: isWebGLFallbackRenderer(ctx.renderer.raw),
      mobile: isMobile(),
      software: ctx.renderer.softwareAdapter !== undefined,
    };
    let materialTier: QualityTier = "low";
    this.#post = setupPost(ctx.renderer, ctx.scene, camera, {
      onTierChanged: (tier) => {
        materialTier = tier;
        this.#materialLighting?.setEnabled(materialLightingEnabled(tier, materialEnvironment));
      },
      godraysLight: lighting.key,
      mobile: isMobile(),
      software: ctx.renderer.softwareAdapter !== undefined,
      gpuClass: ctx.renderer.gpuClass?.class,
    });
    const loading = createLoadingScreen(ctx);
    ctx.add(camera);
    const rig = createFightCamera(camera);
    ctx.viewport.resize();
    ctx.add(createStage());

    const match = new Match();
    const memory = newCpuMemory(CPU_WAKE);
    const views: Record<FighterId, View> = {
      cpu: ctx.entities.add("cpu", new FighterView(ctx, mannequin, "cpu")),
      p1: ctx.entities.add("p1", new FighterView(ctx, mannequin, "p1")),
    };
    rig.follow(Object.values(match.fighters), STEP, true);

    this.#materialLighting = ctx.entities.add(
      "material-lighting",
      createMaterialLighting(ctx.scene, ctx.camera, lighting.key, {
        ...materialEnvironment,
        enabled: materialLightingEnabled(materialTier, materialEnvironment),
      }),
    );
    if (this.#environmentSample !== undefined) {
      const sample = this.#environmentSample;
      this.#materialLighting.setEnvironmentMeasurement(
        sample.measurement,
        sample.source,
        sample.intensity,
        sample,
      );
    }

    let message = "";
    let messageTimer = 0;
    const say = (text: string): void => {
      message = text;
      messageTimer = MESSAGE_TIME;
    };

    return (frameCtx, dt) => {
      loading.update();
      if (frameCtx.input.justPressed("restart")) {
        void frameCtx.goto("play");
        return;
      }
      if (UNDER_PLAYTEST)
        STATIONS.forEach((station, index) => {
          if (!frameCtx.input.justPressed(`station${index + 1}`)) return;
          station({ cpu: memory, match });
          emitPlaytestEvent({ entity: "stage", name: `station${index + 1}` });
        });

      match.step({
        cpu: cpuPad(match.fighters.cpu, match.fighters.p1, memory, frameCtx.random, match.frame),
        p1: readPad(frameCtx.input),
      });
      for (const event of match.events) {
        emitPlaytestEvent(event);
        if (event.name === "ko") say(event.entity === "p1" ? "KO" : "KO!");
      }
      views.p1.sync(match.fighters.p1, dt);
      views.cpu.sync(match.fighters.cpu, dt);
      rig.follow(Object.values(match.fighters), dt);

      messageTimer = Math.max(0, messageTimer - dt);
      if (messageTimer === 0) message = "";
      frameCtx.state.set(
        matchState(match, {
          camera: {
            distance: round(rig.state.distance),
            x: round(rig.state.x),
            y: round(rig.state.y),
          },
          cpuDummy: memory.dummy,
          message,
        }),
      );
    };
  }

  override exit(): void {
    this.#materialLighting?.dispose();
    this.#materialLighting = undefined;
    this.#post?.dispose();
    this.#post = undefined;
    this.#environmentSample = undefined;
  }
}
