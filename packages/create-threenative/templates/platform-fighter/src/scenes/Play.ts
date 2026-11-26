import { Scene, type SceneFrame, getPlatform, isMobile } from "@threenative/core";
import { PLAYTEST_RUNNER_EXPECTED_GLOBAL } from "@threenative/core/playtest";
import { type IEnvironmentSample, sampleEnvironment } from "@threenative/core/render/environment";
import type { PerspectiveCamera } from "three";
import { type FighterView as View, FighterView } from "../entities/FighterView.js";
import type { GameCtx, IMannequin } from "../entities/Fighter.js";
import { emitPlaytestEvent } from "../playtest-events.js";
import { createFightCamera } from "../render/camera.js";
import { cloudTextures, primeCloudTextures } from "../render/clouds.js";
import { setupLighting } from "../render/lighting.js";
import { createLoadingScreen } from "../render/loading.js";
import { createMaterialLighting } from "../render/materialLighting.js";
import { setupPost } from "../render/postprocessing.js";
import { type QualityTier, isWebGLFallbackRenderer, materialLightingEnabled } from "../render/quality.js";
import { setupSky } from "../render/sky.js";
import { createStage } from "../render/stage.js";
import { cpuPad, newCpuMemory } from "../sim/cpu.js";
import { STEP, shieldScale } from "../sim/constants.js";
import { Match } from "../sim/match.js";
import type { FighterId, IFighter } from "../sim/types.js";
import type { FighterState, GameState } from "../state.js";
import { readPad } from "./pads.js";
import { STATIONS } from "./stations.js";

/** Frames the CPU stands still at the start of a match, so the player can take a breath. */
const CPU_WAKE = 150;
const MESSAGE_TIME = 1.4;

/**
 * Playtest-only keys answer only when a playtest runner launched the page (the runner sets this
 * global before any game code runs). A player pressing them in a real build gets nothing.
 */
const UNDER_PLAYTEST =
  (globalThis as Record<string, unknown>)[PLAYTEST_RUNNER_EXPECTED_GLOBAL] === true;

const round = (value: number, scale = 100): number => Math.round(value * scale) / scale;

function fighterState(f: IFighter, match: Match): FighterState {
  const stats = match.stats[f.id];
  return {
    ...stats,
    charge: f.attack?.charge ?? 0,
    fastFalling: f.fastFalling ? 1 : 0,
    grounded: f.floor === undefined ? 0 : 1,
    intangible: f.invuln > 0 ? 1 : 0,
    jumps: f.jumps,
    ledge: f.ledge,
    mode: f.mode,
    peakY: round(f.peakY),
    percent: round(f.percent, 10),
    phase: f.mode === "attack" ? (f.attack?.phase ?? "") : "",
    shield: round(f.shield, 10),
    shieldSize: round(shieldScale(f.shield)),
    stocks: f.stocks,
    vx: round(f.vx),
    vy: round(f.vy),
    weight: f.weight,
    x: round(f.x),
    y: round(f.y),
  };
}

export class Play extends Scene<GameState, undefined> {
  static override readonly initialState: GameState = (() => {
    const match = new Match();
    return {
      camera: { distance: 0, x: 0, y: 0 },
      cpu: fighterState(match.fighters.cpu, match),
      cpuDummy: 0,
      last: { damage: 0, hitstun: 0, knockback: 0, measuredHitstun: 0, percentAfter: 0, victim: "", weight: 0 },
      message: "",
      p1: fighterState(match.fighters.p1, match),
      paused: false,
      phase: "playing",
      time: 0,
      uiReady: false,
    };
  })();

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

      // The simulation waits for the first frames to compile, so nothing happens behind the curtain.
      if (frameCtx.startup.compileSettled) {
        match.step({
          cpu: cpuPad(match.fighters.cpu, match.fighters.p1, memory, frameCtx.random, match.frame),
          p1: readPad(frameCtx.input),
        });
        for (const event of match.events) {
          emitPlaytestEvent(event);
          if (event.name === "ko") say(event.entity === "p1" ? "KO" : "KO!");
        }
      }
      views.p1.sync(match.fighters.p1, dt);
      views.cpu.sync(match.fighters.cpu, dt);
      rig.follow(Object.values(match.fighters), dt);

      messageTimer = Math.max(0, messageTimer - dt);
      if (messageTimer === 0) message = "";
      frameCtx.state.set({
        camera: { distance: round(rig.state.distance), x: round(rig.state.x), y: round(rig.state.y) },
        cpu: fighterState(match.fighters.cpu, match),
        cpuDummy: memory.dummy ? 1 : 0,
        last: {
          ...match.last,
          damage: round(match.last.damage),
          knockback: round(match.last.knockback, 10),
          percentAfter: round(match.last.percentAfter, 10),
        },
        message,
        p1: fighterState(match.fighters.p1, match),
        phase: match.winner === undefined ? "playing" : match.winner === "p1" ? "won" : "lost",
        time: round(match.frame * STEP, 10),
      });
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
