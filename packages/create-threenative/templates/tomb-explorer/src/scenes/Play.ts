import { Scene, type SceneFrame, getPlatform, isMobile } from "@threenative/core";
import { PLAYTEST_RUNNER_EXPECTED_GLOBAL } from "@threenative/core/playtest";
import { type IEnvironmentSample, sampleEnvironment } from "@threenative/core/render/environment";
import type { PerspectiveCamera } from "three";
import { Blade } from "../entities/Blade.js";
import { type GameCtx, Lara, type IMannequin } from "../entities/Lara.js";
import { RELIC, SPAWN, STATIONS } from "../level.js";
import { emitPlaytestEvent } from "../playtest-events.js";
import { createChaseCamera } from "../render/camera.js";
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
import { createRelic } from "../render/props.js";
import { setupSky } from "../render/sky.js";
import { createTemple, toWorld } from "../render/temple.js";
import { inPickupBox } from "../sim/pickup.js";
import type { GameState } from "../state.js";

/** How long a HUD message stays up, seconds. */
const MESSAGE_TIME = 2.5;

/**
 * Playtest-only keys answer only when a playtest runner launched the page (the runner sets this
 * global before any game code runs). A player pressing them in a real build gets nothing.
 */
const UNDER_PLAYTEST =
  (globalThis as Record<string, unknown>)[PLAYTEST_RUNNER_EXPECTED_GLOBAL] === true;
const STATION_NAMES = Object.keys(STATIONS);

/** What each short message says, by the note the body reports. */
const MESSAGES: Readonly<Record<string, string>> = {
  "land-hard": "Hard landing",
  blade: "Sliced",
  drowning: "Out of air",
  "no-room": "No room to climb here",
  relic: "Relic secured",
};

export class Play extends Scene<GameState> {
  static override readonly initialState: GameState = {
    paused: false,
    uiReady: false,
    phase: "playing",
    mode: "idle",
    health: 1000,
    air: 1800,
    playerX: Math.round(SPAWN.x),
    playerY: 11 * 256,
    playerZ: Math.round(SPAWN.z),
    turnRate: 0,
    lean: 0,
    landingSpeed: 0,
    fallDamage: 0,
    jumps: 0,
    grabs: 0,
    hangs: 0,
    climbs: 0,
    bladeHits: 0,
    relic: 0,
    cause: "",
    prompt: "",
    message: "",
    time: 0,
  };

  #mannequin: IMannequin | undefined;
  #post: ReturnType<typeof setupPost> | undefined;
  #environmentSample: IEnvironmentSample | undefined;
  #materialLighting: ReturnType<typeof createMaterialLighting> | undefined;

  override async load(ctx: GameCtx): Promise<void> {
    // One rig: the climber is the combat mannequin (Quaternius' Universal Animation Library, CC0).
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

  override enter(ctx: GameCtx): SceneFrame<GameState> {
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
    const cameraRig = createChaseCamera(camera);
    ctx.viewport.resize();

    const temple = createTemple();
    ctx.add(temple.group);
    const relic = createRelic();
    const [rx, ry, rz] = toWorld(RELIC.x, RELIC.y, RELIC.z);
    relic.group.position.set(rx, ry, rz);
    ctx.add(relic.group);

    const lara = new Lara(ctx, mannequin);
    ctx.entities.add("player", lara);
    const blade = ctx.entities.add("blade", new Blade(ctx));
    cameraRig.snap(lara.body.x, lara.body.y, lara.body.z, lara.body.yaw);

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
    let time = 0;
    const frame: Partial<GameState> = {};
    // One tick of the climber: the same note can arrive on several updates of one frame.
    const say = (text: string | undefined): void => {
      if (text === undefined) return;
      message = text;
      messageTimer = MESSAGE_TIME;
    };

    return (frameCtx, dt) => {
      loading.update();
      if (frameCtx.input.justPressed("restart")) {
        void frameCtx.goto("play");
        return;
      }
      const state = frameCtx.state.getState();
      const playing = state.phase === "playing";

      for (const name of UNDER_PLAYTEST ? STATION_NAMES : []) {
        if (!frameCtx.input.justPressed(name)) continue;
        const station = STATIONS[name];
        if (station === undefined) continue;
        lara.place(
          station.x,
          station.y,
          station.z,
          station.yaw,
          station.mode ?? "idle",
          station.air,
        );
        if (station.clock === true) lara.resetClock();
        emitPlaytestEvent({ entity: "player", name });
      }

      if (playing) time += dt;
      lara.update(frameCtx, dt, !playing);
      say(MESSAGES[lara.lastNote]);
      lara.lastNote = "";
      blade.update(lara.tick);
      relic.gem.rotation.y += dt * 1.6;
      relic.gem.visible = !lara.body.relic;
      cameraRig.follow(lara.body.x, lara.body.y, lara.body.z, lara.body.yaw, dt);

      if (playing && lara.body.state === "dead") frameCtx.state.set({ phase: "lost" });
      else if (playing && lara.body.relic && lara.body.state !== "pickup")
        frameCtx.state.set({ phase: "won" });
      messageTimer = Math.max(0, messageTimer - dt);
      if (messageTimer === 0) message = "";

      const { body } = lara;
      frame.mode = body.state;
      frame.health = Math.round(body.health);
      frame.air = Math.round(body.air);
      frame.playerX = Math.round(body.x);
      frame.playerY = Math.round(body.y);
      frame.playerZ = Math.round(body.z);
      frame.turnRate = body.turn;
      frame.lean = Math.round(body.lean);
      frame.landingSpeed = body.landingSpeed;
      frame.fallDamage = body.fallDamage;
      frame.jumps = lara.jumps;
      frame.grabs = lara.grabs;
      frame.hangs = lara.hangs;
      frame.climbs = lara.climbs;
      frame.bladeHits = lara.bladeHits;
      frame.relic = body.relic ? 1 : 0;
      frame.cause = body.cause;
      frame.prompt = promptFor(lara, playing);
      frame.message = message;
      frame.time = Math.round(time * 10) / 10;
      frameCtx.state.set(frame);
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

/** The hint under the picture: what the keys do right now. */
function promptFor(lara: Lara, playing: boolean): string {
  const { body } = lara;
  if (!playing) return "R  RESTART";
  switch (body.state) {
    case "hang":
    case "shimmy":
      return "LEFT RIGHT  SHIMMY    UP  CLIMB    RELEASE E  DROP";
    case "surface":
      return "UP  PADDLE    HOLD SPACE  DIVE";
    case "swim":
    case "glide":
    case "tread":
      return "SPACE  SWIM    ARROWS  STEER";
    case "idle":
      return inPickupBox(body) ? "HOLD E  TAKE THE RELIC" : "";
    default:
      return "";
  }
}
