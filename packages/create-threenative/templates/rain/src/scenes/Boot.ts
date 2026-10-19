// Generated for you. The one scene: a coast you can walk, and an atmosphere you can reshape.
import { type ICtx, Scene, type SceneFrame, alwaysRender, isMobile } from "@threenative/core";
import { type PerspectiveCamera, Vector3 } from "three";
import { STORM_AUDIO_ENTITY, createStormAudio } from "../audio/storm.js";
import { createCameraRig, setupCamera } from "../render/camera.js";
import { type IStormLightning, createStormLightning } from "../render/lightning.js";
import { createLoadingScreen } from "../render/loading.js";
import { type IStormPost, setupPost } from "../render/postprocessing.js";
import { type IStormRain, createStormRain } from "../render/rain.js";
import { createWeatherWorld } from "../render/world.js";
import {
  AUTO_STRIKE_CLOUD,
  type GameState,
  MAX_STEP,
  type SimStatus,
  WEATHER_KEYS,
  type Weather,
  easeWeather,
  flashAt,
  intentPatch,
  thunderDelay,
} from "../state.js";

export type WeatherCtx = ICtx<GameState>;

/** Seconds of weather the clock starts on, so the first frame is not the start of the storm. */
const START_TIME = 28;
/** The storm, this far in, is not waiting for the first automatic strike. */
const FIRST_STRIKE_DELAY = 9;
const STRIKE_MIN_GAP = 8;
const STRIKE_SPREAD = 16;
/** Below this gap the atmosphere is where it was aimed, and the status can say so. */
const SETTLED = 0.004;
/** Where a strike lands, in the game's own coordinates: out to sea, ahead of the coast. */
const STRIKE_SITE = { maxX: 49, minX: -45, nearZ: -250, spread: 220 } as const;

const STORM: Weather = {
  cloud: 0.76,
  exposure: 1.12,
  fog: 0.4,
  rain: 0.76,
  wet: 1,
  wind: 0.55,
};

export class Coast extends Scene<GameState> {
  // Kept on the instance because `enter` builds them and `exit` is the only hook that runs when the
  // scene goes away: a dropped handle is a shader chain and a geometry that never come back.
  #rain: IStormRain | undefined;
  #post: IStormPost | undefined;
  #lightning: IStormLightning | undefined;
  #measureClouds: (() => GameState["cloudPass"]) | undefined;
  #curtainLifted: (() => boolean) | undefined;

  static override readonly initialState: GameState = {
    audioEnabled: false,
    autoLightning: true,
    cameraReset: false,
    cinematic: false,
    cloudPass: { height: 0, steps: 0, width: 0 },
    droplets: true,
    dropCount: 0,
    elapsed: START_TIME,
    flash: 0,
    fps: 0,
    frame: 0,
    frozen: false,
    heading: 0,
    helpOpen: false,
    muted: false,
    paused: false,
    lastStrike: { at: -1, delay: 0, metres: 0 },
    loading: { progress: 0, ready: false },
    pendingThunderAt: -1,
    position: { x: 0, y: 0, z: 0 },
    preset: "storm",
    quality: "balanced",
    safe: false,
    status: "steady",
    stepRequest: 0,
    strikeRequested: false,
    strikes: 0,
    target: { ...STORM },
    uiHidden: false,
    uiReady: false,
    weather: { ...STORM },
  };

  override load(ctx: WeatherCtx): void {
    // Pick the study's actual cloud/reflection tier before its first render and before runner
    // setup. The post chain's low tier alone does not change these authored passes.
    const softwareRendering = ctx.renderer.softwareAdapter !== undefined;
    ctx.state.set({
      softwareRendering,
      ...(softwareRendering && ctx.state.getState().qualityExplicit !== true
        ? { quality: "performance" as const }
        : {}),
    });
    ctx.state.flush();
  }

  override enter(ctx: WeatherCtx): SceneFrame<GameState> {
    const camera = ctx.camera as PerspectiveCamera;
    setupCamera(camera);
    const rig = createCameraRig(camera);
    // The study's player is the fly camera, so that is the subject a playtest moves and measures.
    ctx.entities.add("player", camera);
    const loading = createLoadingScreen(ctx);
    // The storm's noise volume is the same 64³ every run whatever the player does: it is seeded
    // inside the render layer, because the sequence that fills it is the storm's appearance.
    const world = createWeatherWorld(ctx.scene, camera);
    // The world is one screen-sized quad at the origin, so the camera's own frustum would cull it
    // the moment it looked along the coast. Marking it is how a game says "this is always drawn".
    alwaysRender(world.quad);
    // The rain is one instanced draw whose drops are projected by its own vertex stage, so its
    // bounds say nothing about where they land and the same marker keeps it drawn at any heading.
    const rain = createStormRain(ctx.scene, camera);
    alwaysRender(rain.mesh);
    // The bolt is drawn after the coast and depth-tested against it, so a strike behind the
    // headland is hidden by it. Its quads are projected by its own vertex stage, like the rain.
    const lightning = createStormLightning(ctx.scene, camera);
    alwaysRender(lightning.mesh);
    // Retained, not called and dropped: `update` is where the post pass learns this frame's time,
    // exposure, rain and droplet toggle, and `uRes` is zero until it has run once.
    const post = setupPost(ctx.renderer, ctx.scene, camera, {
      mobile: isMobile(),
      software: ctx.renderer.softwareAdapter !== undefined,
      gpuClass: ctx.renderer.gpuClass?.class,
    });
    this.#rain = rain;
    this.#post = post;
    this.#lightning = lightning;
    this.#measureClouds = world.clouds;
    // `loading.ts` lifts its cover by making the canvas layer transparent again; that is the frame
    // the world is on screen, so it is the frame the interface may appear on.
    this.#curtainLifted = () => !ctx.canvasLayer.opaque;
    // Registered, so the engine's registry disposes it with the game and `game.ts` can reach it by
    // name for the two holds that arrive outside a frame (the pause intent and tab visibility).
    const audio = ctx.entities.add(STORM_AUDIO_ENTITY, createStormAudio(ctx));

    let weather: Weather = { ...STORM };
    let elapsed = START_TIME;
    let frame = 0;
    let nextStrikeAt = START_TIME + FIRST_STRIKE_DELAY;
    let strikeAt = -100;
    let pendingThunderAt = -1;
    let cinematic = false;
    let safe = false;
    let strikes = 0;
    let lastStrike = { at: -1, delay: 0, metres: 0 };
    // Where the bolt lands, and where it entered the cloud deck. The deck point is what the clouds
    // glow around and what the coast is lit from; the ground point is what the thunder crosses.
    // Out at sea, so a flash that lands before the first strike still lights open water.
    const site = new Vector3(0, 0, -400);
    const strikePoint = new Vector3(0, 180, -400);

    /**
     * A strike is queued on the same clock as everything else, so the flash, the thunder and the
     * distance it crossed cannot disagree with each other. Gated on the photosensitivity switch
     * at the one door every path comes through, manual key and automatic alike.
     */
    const strike = (): void => {
      if (safe) return;
      strikeAt = elapsed - 0.025;
      site.set(
        STRIKE_SITE.minX + ctx.random() * (STRIKE_SITE.maxX - STRIKE_SITE.minX),
        0,
        STRIKE_SITE.nearZ - ctx.random() * STRIKE_SITE.spread,
      );
      strikePoint.copy(lightning.strike(site, ctx.random));
      const metres = rig.position.distanceTo(site);
      const delay = thunderDelay(metres);
      pendingThunderAt = elapsed + delay;
      nextStrikeAt = elapsed + STRIKE_MIN_GAP + ctx.random() * STRIKE_SPREAD;
      strikes += 1;
      lastStrike = { at: elapsed, delay, metres };
      // The thunder is queued on the same clock the flash is drawn against, by the same distance
      // the delay came from, so what is heard cannot disagree with what was seen.
      audio.queueStrike({ at: pendingThunderAt, metres });
    };

    /**
     * The keyboard shortcuts, through the same validated door the panel's controls use, so a key
     * and a click cannot disagree about what photosensitivity mode or sound means.
     */
    const readKeys = (frameCtx: WeatherCtx): void => {
      const input = frameCtx.input;
      const ui = frameCtx.state.getState();
      let patch: Partial<GameState> = {};
      if (input.justPressed("safe"))
        patch = { ...patch, ...intentPatch("setSafe", !ui.safe, ui.target) };
      if (input.justPressed("hideUi")) patch.uiHidden = !ui.uiHidden;
      if (input.justPressed("sound")) {
        const on = ui.audioEnabled && !ui.muted;
        patch.audioEnabled = true;
        patch.muted = on;
      }
      if (input.justPressed("pause")) {
        patch.paused = !ui.paused;
        audio.setSilenced(patch.paused);
      }
      if (Object.keys(patch).length > 0) frameCtx.state.set(patch);
    };

    /** Read the intent the UI sent between frames, before anything is derived from it. */
    const readIntent = (frameCtx: WeatherCtx): GameState => {
      readKeys(frameCtx);
      const ui = frameCtx.state.getState();
      // Both resets come through the same door, and each one is a fresh request: the flag is
      // consumed and cleared below, never latched, so a second reset still lands.
      const reset = ui.cameraReset || frameCtx.input.justPressed("resetCamera");
      if (reset) {
        rig.reset();
        cinematic = false;
      } else {
        // Any real input hands the camera back: the orbit is a mode, not a cage.
        cinematic = ui.cinematic && !rig.manual;
      }
      safe = ui.safe;
      if (ui.strikeRequested || frameCtx.input.justPressed("strike")) strike();
      return ui;
    };

    const advance = (ui: GameState, step: number): void => {
      // A held simulation still draws, as the study's did: the look follows the panel at once
      // instead of easing on a clock that is not running, and nothing else moves.
      if (ui.paused || ui.frozen) weather = { ...ui.target };
      if (step <= 0) return;
      elapsed += step;
      weather = easeWeather(weather, ui.target, step);
      // The study's own gate: past its time, the first frame with real cloud cover strikes.
      if (ui.autoLightning && elapsed > nextStrikeAt && weather.cloud > AUTO_STRIKE_CLOUD) strike();
    };

    return (frameCtx, dt) => {
      const ui = readIntent(frameCtx);
      // Pause holds the simulation the way the study's did — the frame is still drawn, so a drag
      // still looks around — and `frozen` is the automation's stopped clock, which only an explicit
      // `step` moves on. A step never runs while paused, exactly as the study's `step(dt)`.
      const wall = ui.paused || ui.frozen ? 0 : Math.min(dt, MAX_STEP);
      const step = wall + (ui.paused ? 0 : ui.stepRequest);
      advance(ui, step);

      const flash = safe ? 0 : flashAt(elapsed - strikeAt);
      if (pendingThunderAt >= 0 && elapsed >= pendingThunderAt) pendingThunderAt = -1;

      rig.update(wall, elapsed, frameCtx.input, cinematic);
      // The rig only learns it is being driven once it has run, so the published flag is settled
      // after it: a hand on the camera ends the orbit on the same frame it happened.
      if (rig.manual) cinematic = false;
      // Both passes read the weather this frame has just eased towards, not the target the UI
      // asked for, so a drop and a lens bead are lit by the same air the coast is drawn with.
      rain.update({ elapsed, flash, weather, quality: ui.quality });
      lightning.update(flash);
      post.update({
        elapsed,
        exposure: weather.exposure,
        rain: weather.rain,
        droplets: ui.droplets,
      });
      world.update({
        elapsed,
        flash,
        quality: ui.quality,
        strike: strikePoint,
        weather,
      });
      loading.update();
      frame += 1;

      // Both request flags are consumed here, so the next request is a new one.
      frameCtx.state.set({
        cameraReset: false,
        cinematic,
        cloudPass: { ...frameCtx.state.getState().cloudPass, steps: world.clouds().steps },
        dropCount: rain.instanceCount,
        elapsed,
        flash,
        fps: frameCtx.fps,
        frame,
        heading: rig.heading,
        lastStrike,
        pendingThunderAt,
        position: { x: rig.position.x, y: rig.position.y, z: rig.position.z },
        safe,
        stepRequest: 0,
        strikeRequested: false,
        strikes,
        status: statusOf(ui.paused, flash, weather, ui.target),
        weather,
      });
      frameCtx.state.flush();
      // Last, so the mix is written from the frame that just ran rather than the one before it:
      // `getState` already carries the patch above. The pause hold itself is an intent in
      // `game.ts`, so the sound stops on the press rather than a frame later.
      audio.update(frameCtx.state.getState());
    };
  }

  /**
   * The launch and the cloud target, published from the render hook rather than the simulation
   * frame: a frame is drawn whether or not the clock moved (a paused or tick-driven run draws
   * without simulating), the loading curtain must lift on the frame that shows the storm, and the
   * cloud target is only resized by the render itself. "Ready" is the canvas loading screen in
   * `src/render/loading.ts` having lifted, so the interface and the world appear together.
   */
  override render(ctx: WeatherCtx): void {
    const progress = ctx.startup.progress;
    // The interface's curtain lifts with the engine's own loading screen, on the same frame.
    const ready = this.#curtainLifted?.() ?? false;
    const current = ctx.state.getState();
    // Read after the frame was drawn, so it is the target the cloud pass really rendered into.
    const clouds = this.#measureClouds?.() ?? current.cloudPass;
    // Steps are the frame's own (set by the tier this frame simulated); the size is the render's.
    const same =
      current.loading.ready === ready &&
      current.loading.progress === progress &&
      current.cloudPass.width === clouds.width &&
      current.cloudPass.height === clouds.height;
    if (same) return;
    ctx.state.set({
      cloudPass: { ...current.cloudPass, height: clouds.height, width: clouds.width },
      loading: { progress, ready },
    });
    ctx.state.flush();
  }

  /** The scene is leaving: both passes were built here, so both are released here. */
  override exit(): void {
    this.#rain?.dispose();
    this.#post?.dispose();
    this.#lightning?.dispose();
    this.#rain = undefined;
    this.#post = undefined;
    this.#lightning = undefined;
  }
}

/** Derived from the frame that just ran, so the label cannot describe a frame that is over. */
function statusOf(paused: boolean, flash: number, weather: Weather, target: Weather): SimStatus {
  if (paused) return "paused";
  if (flash > 0.003) return "flashing";
  return settled(weather, target) ? "steady" : "settling";
}

function settled(current: Weather, target: Weather): boolean {
  return WEATHER_KEYS.every((key) => Math.abs(current[key] - target[key]) < SETTLED);
}
