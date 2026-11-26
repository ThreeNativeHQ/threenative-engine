import { type ICtx, Scene, type SceneFrame, getPlatform, isMobile } from "@threenative/core";
import { PLAYTEST_RUNNER_EXPECTED_GLOBAL } from "@threenative/core/playtest";
import { type IEnvironmentSample, sampleEnvironment } from "@threenative/core/render/environment";
import type { IPhysicsContext } from "@threenative/physics";
import { MathUtils, type PerspectiveCamera, Vector3 } from "three";
import { emitPlaytestEvent } from "../playtest-events.js";
import {
  type ICraft,
  type IMannequin,
  createBeltCraft,
  createGliderCraft,
} from "../render/aircraft.js";
import { createChaseCamera } from "../render/camera.js";
import { cloudTextures, primeCloudTextures } from "../render/clouds.js";
import { setupLighting } from "../render/lighting.js";
import { createLoadingScreen } from "../render/loading.js";
import { createRings, createThermals, createWindSocks } from "../render/markers.js";
import { createMaterialLighting } from "../render/materialLighting.js";
import { setupPost } from "../render/postprocessing.js";
import {
  type QualityTier,
  isWebGLFallbackRenderer,
  materialLightingEnabled,
} from "../render/quality.js";
import { setupSky } from "../render/sky.js";
import { createWorld } from "../render/terrain.js";
import { Attempt } from "../sim/attempt.js";
import { GLIDER_RINGS, LAUNCH, PAD, type Vehicle, windAt } from "../sim/world.js";
import type { GameState } from "../state.js";
import { stationFor } from "./stations.js";

type GameCtx = ICtx<GameState, IPhysicsContext>;

/** How long a HUD message stays up, seconds. */
const MESSAGE_TIME = 2.2;
/** Test stations answer only when a playtest runner launched the page (it sets this global first). */
const UNDER_PLAYTEST =
  (globalThis as Record<string, unknown>)[PLAYTEST_RUNNER_EXPECTED_GLOBAL] === true;
const STATION_NAMES = [
  "station1",
  "station2",
  "station3",
  "station4",
  "station5",
  "station6",
  "station7",
  "station8",
];
/** A key is a bar pushed slowly, not a switch: a tap is a nudge and a hold builds up. Per second. */
const STICK_BUILD = 1.8;
const STICK_RETURN = 3.2;
const DEG = 180 / Math.PI;

const round = (value: number, scale = 100): number => Math.round(value * scale) / scale;
const clamp1 = (value: number): number => Math.min(1, Math.max(-1, value));

export class Play extends Scene<GameState, IPhysicsContext> {
  static override readonly initialState: GameState = {
    activeRing: 0,
    airLift: 0,
    airspeed: 0,
    altitude: 0,
    bankDeg: 0,
    burning: 0,
    climb: 0,
    crashReason: "",
    fuel: 1,
    landDistance: 0,
    landPoints: 0,
    landSink: 0,
    lever: 0,
    lowFuel: 0,
    message: "",
    onPad: 0,
    padDistance: 0,
    paused: false,
    phase: "flying",
    pitchDeg: 0,
    playerX: LAUNCH.x,
    playerY: 0,
    playerYaw: LAUNCH.heading,
    playerZ: LAUNCH.z,
    ringMarks: GLIDER_RINGS.map(() => "pending"),
    ringPoints: 0,
    ringsMissed: 0,
    ringsPassed: 0,
    ringsTotal: GLIDER_RINGS.length,
    stallWarning: 0,
    stalled: 0,
    stalls: 0,
    thermalTime: 0,
    time: 0,
    timeBonus: 0,
    total: 0,
    uiReady: false,
    vehicle: "glider",
    windSpeed: 0,
    windX: 0,
    windZ: 0,
  };

  #mannequin: IMannequin | undefined;
  #post: ReturnType<typeof setupPost> | undefined;
  #environmentSample: IEnvironmentSample | undefined;
  #materialLighting: ReturnType<typeof createMaterialLighting> | undefined;

  override async load(ctx: GameCtx): Promise<void> {
    // One rig for the pilot: the combat mannequin (Quaternius' Universal Animation Library, CC0).
    this.#mannequin = await ctx.assets.model<IMannequin>("mannequin-combat.glb");
    primeCloudTextures(await ctx.assets.memo("clouds", () => cloudTextures()));
    setupSky(ctx.scene, ctx.renderer.softwareAdapter !== undefined);
    this.#environmentSample = await sampleEnvironment(ctx.renderer.raw, ctx.scene, {
      mobile: isMobile(),
      rendererKind: ctx.renderer.kind,
      software: ctx.renderer.softwareAdapter !== undefined,
      web: getPlatform().runtime === "web",
      webglFallback: isWebGLFallbackRenderer(ctx.renderer.raw),
    });
  }

  override enter(ctx: GameCtx): SceneFrame<GameState, IPhysicsContext> {
    const mannequin = this.#mannequin;
    if (mannequin === undefined)
      throw new Error("Play.enter ran before load() loaded mannequin-combat.glb.");
    const vehicle: Vehicle = ctx.state.getState().vehicle;
    const camera = ctx.camera as PerspectiveCamera;
    setupSky(ctx.scene, ctx.renderer.softwareAdapter !== undefined);
    const lighting = setupLighting(
      ctx.scene,
      ctx.renderer.raw as Parameters<typeof setupLighting>[1],
      isMobile(),
    );
    const materialEnvironment = {
      mobile: isMobile(),
      rendererKind: ctx.renderer.kind,
      software: ctx.renderer.softwareAdapter !== undefined,
      web: getPlatform().runtime === "web",
      webglFallback: isWebGLFallbackRenderer(ctx.renderer.raw),
    };
    let materialTier: QualityTier = "low";
    this.#post = setupPost(ctx.renderer, ctx.scene, camera, {
      godraysLight: lighting.key,
      gpuClass: ctx.renderer.gpuClass?.class,
      mobile: isMobile(),
      onTierChanged: (tier) => {
        materialTier = tier;
        this.#materialLighting?.setEnabled(materialLightingEnabled(tier, materialEnvironment));
      },
      software: ctx.renderer.softwareAdapter !== undefined,
    });
    const loading = createLoadingScreen(ctx);
    ctx.add(camera);
    const cameraRig = createChaseCamera(camera);
    ctx.viewport.resize();

    const attempt = new Attempt(vehicle);
    const course = attempt.rings.rings;
    const world = createWorld();
    const rings = createRings(course);
    const thermals = createThermals();
    const socks = createWindSocks(LAUNCH);
    const craft: ICraft =
      vehicle === "glider" ? createGliderCraft(mannequin) : createBeltCraft(mannequin);
    ctx.add(world);
    ctx.add(rings.root);
    ctx.add(thermals.root);
    for (const sock of socks) ctx.add(sock.root);
    ctx.add(craft.root);
    ctx.entities.add("player", { mesh: craft.root });
    ctx.entities.add("wind-sock", { mesh: socks[1]?.root });
    thermals.root.children.forEach((thermal, index) => {
      ctx.entities.add(`thermal-${index + 1}`, { mesh: thermal });
    });
    for (const ring of rings.root.children) {
      if (ring.name.startsWith("ring-") && ring.name !== "ring-beacon")
        ctx.entities.add(ring.name, { mesh: ring });
    }

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

    const focus = new Vector3();
    const place = (): void => {
      const { pos } = attempt.craft;
      craft.root.position.set(pos.x, pos.y, pos.z);
      focus.set(pos.x, pos.y, pos.z);
    };
    place();
    cameraRig.snap(focus, attempt.heading);
    let message = "";
    let messageTimer = 0;
    const say = (text: string): void => {
      message = text;
      messageTimer = MESSAGE_TIME;
    };
    let stick = 0;
    let shownPitch = 0;
    let announced = 0;
    let announcedPhase = "flying";
    const frame: Partial<GameState> = {
      ringMarks: attempt.rings.marks.slice(),
      ringsTotal: course.length,
      vehicle,
    };
    rings.paint(attempt.rings.marks, attempt.rings.active);

    return (frameCtx, dt) => {
      loading.update();
      const input = frameCtx.input;
      if (input.justPressed("restart")) {
        void frameCtx.goto("play");
        return;
      }
      if (input.justPressed("vehicle")) {
        frameCtx.state.set({ vehicle: vehicle === "glider" ? "belt" : "glider" });
        void frameCtx.goto("play");
        return;
      }
      for (const name of UNDER_PLAYTEST ? STATION_NAMES : []) {
        if (!input.justPressed(name)) continue;
        const spot = stationFor(vehicle, name, course);
        if (spot === undefined) continue;
        if (vehicle === "glider") attempt.placeGlider(spot, spot.heading, spot.bank ?? 0);
        else attempt.placeBelt(spot, spot.heading, spot.fuel);
        emitPlaytestEvent({ entity: "player", name });
      }

      // The keys are a bar: a hold builds the deflection and a release lets it go.
      const move = input.vector("move");
      const target = clamp1(input.vector("pitch").y + move.y);
      const rate = target === 0 ? STICK_RETURN : STICK_BUILD;
      stick += MathUtils.clamp(target - stick, -rate * dt, rate * dt);
      const climb = (input.pressed("climb") ? 1 : 0) - (input.pressed("descend") ? 1 : 0);
      if (frameCtx.startup.compileSettled) {
        attempt.step(dt, { climb, pitch: stick, roll: clamp1(input.vector("bank").x + move.x) });
      }

      const { pos } = attempt.craft;
      const glider = attempt.glider;
      const belt = attempt.belt;
      place();
      if (glider !== undefined) {
        // Smoothed and capped under the vertical, so a stall's flip of the flight path reads as a drop.
        const wanted = MathUtils.clamp(glider.attitude, -1.4, 1.4);
        shownPitch += (wanted - shownPitch) * Math.min(1, dt * 9);
        craft.root.rotation.order = "YXZ";
        craft.root.rotation.set(-shownPitch, glider.heading, glider.bank);
      } else if (belt !== undefined) {
        craft.root.rotation.order = "YXZ";
        craft.root.rotation.set(belt.lean, belt.yaw, 0);
        if (craft.flame !== undefined) {
          craft.flame.visible = belt.burning;
          craft.flame.scale.y = 0.4 + belt.lever * 1.6;
        }
      }
      craft.pilot.update(dt);
      thermals.update(attempt.time);
      const wind = windAt(attempt.time);
      for (const sock of socks) sock.set(wind.x, wind.z);
      lighting.follow(pos.x, pos.y, pos.z);
      cameraRig.follow(focus, attempt.heading, dt);

      for (const event of attempt.rings.events) {
        rings.paint(attempt.rings.marks, attempt.rings.active);
        frame.ringMarks = attempt.rings.marks.slice();
        emitPlaytestEvent({
          entity: `ring-${event.index + 1}`,
          index: event.index + 1,
          name: `ring-${event.mark}`,
        });
        say(event.mark === "passed" ? `Ring ${event.index + 1}` : `Ring ${event.index + 1} missed`);
      }
      attempt.rings.events.length = 0;
      if (attempt.stalls > announced) {
        announced = attempt.stalls;
        say("Stall: nose down to fly again");
        emitPlaytestEvent({ entity: "player", name: "stall" });
      }
      if (attempt.phase !== announcedPhase) {
        announcedPhase = attempt.phase;
        const landing = attempt.touchdown;
        say(landing?.crashed === true ? `Crash: ${landing.reason}` : "Landed");
        rings.paint(attempt.rings.marks, attempt.rings.active);
        frame.ringMarks = attempt.rings.marks.slice();
        emitPlaytestEvent({ entity: "player", name: attempt.phase });
      }

      messageTimer = Math.max(0, messageTimer - dt);
      if (messageTimer === 0) message = "";
      const landing = attempt.touchdown;
      const groundSpeed = Math.hypot(attempt.craft.vel.x, attempt.craft.vel.z);
      frame.phase = attempt.phase;
      frame.time = round(attempt.time, 10);
      frame.airspeed = round(glider?.airspeed ?? groundSpeed, 10);
      frame.altitude = round(Math.max(0, attempt.clearance), 10);
      frame.climb = round(attempt.craft.vel.y, 10);
      frame.airLift = round(attempt.lift, 10);
      frame.thermalTime = round(attempt.thermalTime, 10);
      frame.pitchDeg = round((glider?.attitude ?? belt?.lean ?? 0) * DEG, 1);
      frame.bankDeg = round((glider?.bank ?? 0) * DEG, 1);
      frame.stalled = glider?.stalled === true ? 1 : 0;
      frame.stallWarning = attempt.stallWarning;
      frame.stalls = attempt.stalls;
      frame.windX = round(wind.x);
      frame.windZ = round(wind.z);
      frame.windSpeed = round(Math.hypot(wind.x, wind.z), 10);
      frame.fuel = round(belt?.fuel ?? 1);
      frame.lever = round(belt?.lever ?? 0);
      frame.burning = belt?.burning === true ? 1 : 0;
      frame.lowFuel = belt?.lowFuel === true ? 1 : 0;
      frame.ringsPassed = attempt.rings.passed;
      frame.ringsMissed = attempt.rings.marks.filter((mark) => mark === "missed").length;
      frame.activeRing = Math.min(attempt.rings.active, course.length);
      frame.padDistance = round(Math.hypot(pos.x - PAD.x, pos.z - PAD.z), 10);
      frame.landSink = round(landing?.sink ?? 0);
      frame.landDistance = round(landing?.distance ?? 0, 10);
      frame.landPoints = landing?.points ?? 0;
      frame.crashReason = landing?.reason ?? "";
      frame.onPad = landing?.onPad === true ? 1 : 0;
      frame.ringPoints = attempt.rings.passed * 100 + attempt.rings.bonus;
      frame.timeBonus =
        landing !== undefined && !landing.crashed && landing.onPad
          ? Math.max(0, Math.round(attempt.limits.parTime - attempt.time))
          : 0;
      frame.total = attempt.total;
      frame.message = message;
      frame.playerX = round(pos.x);
      frame.playerY = round(pos.y);
      frame.playerZ = round(pos.z);
      frame.playerYaw = round(attempt.heading);
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
