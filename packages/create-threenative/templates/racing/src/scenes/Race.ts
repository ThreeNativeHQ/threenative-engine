import {
  GPUParticles3D,
  Scene,
  type SceneFrame,
  afterPhysics,
  getPlatform,
  isMobile,
  isTouchscreenAvailable,
} from "@threenative/core";
import { type IEnvironmentSample, sampleEnvironment } from "@threenative/core/render/environment";
import type { IPhysicsContext } from "@threenative/physics";
import { MathUtils, type Object3D, type PerspectiveCamera, type Texture, Vector3 } from "three";
import { EngineAudio } from "../audio/engine.js";
import { type CarCtx, FEEL } from "../entities/CarBody.js";
import { RacingCar } from "../entities/RacingCar.js";
import { RIVALS, Rival } from "../entities/Rival.js";
import { Gauges } from "../gauges.js";
import { emitPlaytestEvent } from "../playtest-events.js";
import { BASE_FOV, cameraBank, chaseCamera, setupCamera } from "../render/camera.js";
import { cloudTextures, primeCloudTextures } from "../render/clouds.js";
import { BURSTS, EFFECTS } from "../render/effects.js";
import { setupLighting } from "../render/lighting.js";
import { createLoadingScreen } from "../render/loading.js";
import { createMaterialLighting } from "../render/materialLighting.js";
import { setupPost } from "../render/postprocessing.js";
import {
  type QualityTier,
  isWebGLFallbackRenderer,
  materialLightingEnabled,
} from "../render/quality.js";
import { EXHAUST } from "../render/shapes.js";
import { SkidMarks } from "../render/skids.js";
import { SKY_OPTIONS, SUN_DIRECTION, setupSky } from "../render/sky.js";
import { TouchControls } from "../render/touch-controls.js";
import { type GameState, type RaceStatus, resolveRaceStatus } from "../state.js";
import { Lap } from "../track/Lap.js";
import { type IRankedRacer, type IRankedRacerScratch, rankRacers } from "../track/Ranking.js";
import {
  TOTAL_LAPS,
  buildTrack,
  gridHeading,
  gridPosition,
  intersectRay,
  roadRayProbe,
  terrainHeight,
} from "../track/Track.js";
import { TrackSector } from "../track/TrackSector.js";
import { CIRCUIT, PLAYER_SLOT, gridSlot } from "../track/circuit.js";

export type GameCtx = CarCtx;

/** The player starts on the second grid slot, one ride height above the tarmac. */
const SPAWN = gridPosition(PLAYER_SLOT, new Vector3());
SPAWN.y = CIRCUIT.at(gridSlot(PLAYER_SLOT).distance, CIRCUIT.createSample()).point.y + 0.22;
/**
 * The race is three laps of 55-60 s, so a time limit under four minutes is a limit nobody reaches
 * and one that only fires on a car that has already been rescued four times.
 */
const TIME_LIMIT = 260;

function playerRanking(ranked: readonly IRankedRacer[]): IRankedRacer | undefined {
  for (let index = 0; index < ranked.length; index += 1) {
    const racer = ranked[index];
    if (racer?.id === "player") return racer;
  }
  return undefined;
}

const DEG = 180 / Math.PI;

/**
 * The shake meter: the worst tick-to-tick step of the camera's bank and of the body's lean, and
 * the worst second difference of the camera's yaw. A steady turn has a steady yaw rate, so its
 * second difference is near zero; a camera that twitches from tick to tick does not.
 */
function createShakeMeter() {
  let roll = 0;
  let yaw = 0;
  let yawRate = 0;
  let lean = 0;
  let samples = 0;
  const dir = new Vector3();
  const right = new Vector3();
  const meter = {
    cameraRollStep: 0,
    cameraYawJerk: 0,
    leanRollStep: 0,
    /** The body's roll and pitch this tick, in degrees: + rolls toward the right, + lifts the nose. */
    leanRoll: 0,
    leanPitch: 0,
    /** A camera cut is not a shake: the next two samples rebuild the history. */
    reset(): void {
      samples = 0;
    },
    sample(camera: PerspectiveCamera, body: Object3D): void {
      camera.getWorldDirection(dir);
      right.setFromMatrixColumn(camera.matrixWorld, 0);
      const nextYaw = Math.atan2(dir.z, dir.x);
      const rate = Math.atan2(Math.sin(nextYaw - yaw), Math.cos(nextYaw - yaw));
      const nextRoll = Math.asin(MathUtils.clamp(right.y, -1, 1));
      if (samples >= 2) {
        meter.cameraRollStep = Math.max(meter.cameraRollStep, Math.abs(nextRoll - roll) * DEG);
        meter.cameraYawJerk = Math.max(meter.cameraYawJerk, Math.abs(rate - yawRate) * DEG);
        meter.leanRollStep = Math.max(meter.leanRollStep, Math.abs(body.rotation.x - lean) * DEG);
      }
      samples += 1;
      roll = nextRoll;
      yaw = nextYaw;
      yawRate = rate;
      lean = body.rotation.x;
      meter.leanRoll = body.rotation.x * DEG;
      meter.leanPitch = body.rotation.z * DEG;
    },
  };
  return meter;
}

function quantize(value: number, scale: number): number {
  return Math.round(value * scale) / scale;
}

export class Race extends Scene<GameState, IPhysicsContext> {
  static override readonly initialState: GameState = {
    paused: false,
    uiReady: false,
    autopilot: false,
    boostActive: false,
    boostPeakSpeed: 0,
    boostUses: 0,
    drifting: false,
    driftAngle: 0,
    driftScore: 0,
    driftsBanked: 0,
    driftSpins: 0,
    nitro: 1,
    nitroActive: false,
    nitroDriftGain: 0,
    gear: 1,
    rpm: 0,
    driftLast: 0,
    driftPopup: 0,
    fov: BASE_FOV,
    fovPeak: BASE_FOV,
    engineRate: 0,
    completedLaps: 0,
    elapsed: 0,
    lastOnRoad: [SPAWN.x, SPAWN.y, SPAWN.z],
    place: 1,
    racers: RIVALS.length + 1,
    position: "P1",
    raceStatus: "RACING",
    rescueHeading: 0,
    // Before any rescue, both errors are the worst they could be: the car is facing the wrong way
    // and it is a whole lap from where it belongs. A sentinel of -1 satisfies an "at most 0.05 rad"
    // assertion before the game has done anything, which is how a bound stops being a bound.
    rescueHeadingError: Math.PI,
    rescuePositionError: Math.PI,
    rescues: 0,
    shortcutRejects: 0,
    speed: 0,
    speedAfterBoost: 0,
    sameDistanceRanking: "",
    topSpeed: 0,
    totalLaps: TOTAL_LAPS,
    trackProgress: 0,
    reverseRejects: 0,
  };

  #sky: Texture | undefined;

  /**
   * The sky photograph, **awaited** before the scene enters.
   *
   * It used to be fetched without waiting and swapped in when it decoded. On `engine: "threejs"`
   * that swap lands in the middle of a frame (WebGPU rendering yields between its awaits), next to
   * the shadow pass, which clears `scene.background` and puts it back. A swap after the first frame
   * was never drawn: the sky stayed the fallback colour on a fast GPU, and the engine-parity guard
   * scored the template 0.823 against the correct `threenative` frame, passing only when a slow
   * adapter let the photograph land before the first render. Applied before the first frame the
   * same texture draws, and parity scores 0.001.
   */
  #post: ReturnType<typeof setupPost> | undefined;
  #environmentSample: IEnvironmentSample | undefined;
  #materialLighting: ReturnType<typeof createMaterialLighting> | undefined;
  #lightingGeneration = 0;
  #audio: EngineAudio | undefined;

  override async load(ctx: GameCtx): Promise<void> {
    const generation = ++this.#lightingGeneration;
    // Only the photo-sky override reads the photograph; the atmosphere sky is computed.
    const texture = SKY_OPTIONS.sky === "photo" ? await ctx.assets.texture("sky.jpg") : undefined;
    if (generation !== this.#lightingGeneration) return;
    this.#sky = texture;
    const scene = ctx.scene;
    if (scene === undefined) return;
    // The cloud noise is the same every run of this build: generate it once, then read it back.
    primeCloudTextures(await ctx.assets.memo("clouds", () => cloudTextures()));
    setupSky(scene, texture, ctx.renderer.softwareAdapter !== undefined);
    // The measurement is not awaited: it reads the GPU back and must not hold the first frame.
    void this.#sampleSky(ctx, scene, generation);
  }

  async #sampleSky(
    ctx: GameCtx,
    scene: NonNullable<GameCtx["scene"]>,
    generation: number,
  ): Promise<void> {
    const controller = this.#materialLighting;
    const sample = await sampleEnvironment(ctx.renderer.raw, scene, {
      web: getPlatform().runtime === "web",
      rendererKind: ctx.renderer.kind,
      webglFallback: isWebGLFallbackRenderer(ctx.renderer.raw),
      mobile: isMobile(),
      software: ctx.renderer.softwareAdapter !== undefined,
    });
    if (generation !== this.#lightingGeneration || ctx.scene !== scene) return;
    this.#environmentSample = sample;
    // A cached sky may start sampling before enter creates the receiver controller.
    // A controller that already existed when sampling began must still be the same one.
    const currentController = this.#materialLighting;
    if (
      currentController !== undefined &&
      (controller === undefined || controller === currentController)
    )
      currentController.setEnvironmentMeasurement(
        sample.measurement,
        sample.source,
        sample.intensity,
        sample,
      );
  }

  override enter(ctx: GameCtx): SceneFrame<GameState, IPhysicsContext> {
    if (this.#sky === undefined && SKY_OPTIONS.sky === "photo")
      setupSky(ctx.scene, undefined, ctx.renderer.softwareAdapter !== undefined);
    const lighting = setupLighting(
      ctx.scene,
      ctx.renderer.raw as Parameters<typeof setupLighting>[1],
      isMobile(),
    );
    // isMobile() arrives as an argument because src/render/ imports no framework package: the
    // platform decision is made here, in portable game code, exactly like createRandom.
    const materialEnvironment = {
      web: getPlatform().runtime === "web",
      rendererKind: ctx.renderer.kind,
      webglFallback: isWebGLFallbackRenderer(ctx.renderer.raw),
      mobile: isMobile(),
      software: ctx.renderer.softwareAdapter !== undefined,
    };
    let materialTier: QualityTier = "low";
    this.#post = setupPost(ctx.renderer, ctx.scene, ctx.camera, {
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
    const camera = ctx.camera as PerspectiveCamera;
    setupCamera(camera);
    ctx.add(camera);
    const showTouchControls = isMobile() && isTouchscreenAvailable();
    const touchControls = showTouchControls
      ? ctx.entities.add("touch-controls", new TouchControls(camera))
      : undefined;
    const track = buildTrack(ctx);
    const car = new RacingCar(ctx, SPAWN, gridHeading(PLAYER_SLOT));
    // Display only, both of them: the rev counter's needle and the engine note it pitches. Neither
    // touches the chassis, so a wrong needle is a wrong gauge and never a wrong lap.
    const gauges = new Gauges();
    this.#audio = new EngineAudio(camera, (name) => ctx.assets.audio(name));
    // The field, each car on its own grid slot projected onto the circuit it drives. The pole car
    // is the entity `rival`, the car to beat; the others are `rival-2` to `rival-5`.
    const rivals = RIVALS.map((_, index) => new Rival(ctx, index));
    ctx.entities.add("player", car);
    for (const [index, rival] of rivals.entries())
      ctx.entities.add(index === 0 ? "rival" : `rival-${index + 1}`, rival);
    // The sun's aim as three reads it: the target's world matrix, which only a scene traversal refreshes.
    ctx.entities.add("sun", {
      get targetGap(): number {
        return new Vector3()
          .setFromMatrixPosition(lighting.key.target.matrixWorld)
          .distanceTo(car.body.position);
      },
    });

    // `travelDirection` is the car's **measured** velocity, not the heading it was asked for: a
    // car that is sliding through a corner is travelling somewhere other than where it points, and
    // a lap counted on the intent is a lap counted on a wish.
    const lap = new Lap(
      { body: car.body.body, forward: car.travelDirection },
      track.gates,
      TOTAL_LAPS,
      (completed) => emitPlaytestEvent({ entity: "player", lap: completed, name: "lap-completed" }),
    );
    const playerRankingInput = { id: "player", lap: lap.completed, position: car.body.position };
    const rivalRankingInputs = rivals.map((rival, index) => ({
      id: index === 0 ? "rival" : `rival-${index + 1}`,
      lap: rival.lap,
      position: rival.mesh.position,
    }));
    const rankingInputs = [playerRankingInput, ...rivalRankingInputs];
    const rankingBuffer: IRankedRacerScratch[] = [];
    const rankRace = () => {
      playerRankingInput.lap = lap.completed;
      // Indexed loop, not `.entries()`: this runs every frame and the runtime-cost gate holds the
      // scene to zero per-frame iterator allocations.
      for (let index = 0; index < rivalRankingInputs.length; index += 1) {
        const input = rivalRankingInputs[index];
        if (input !== undefined) input.lap = rivals[index]?.lap ?? 0;
      }
      return rankRacers(CIRCUIT, rankingInputs, undefined, rankingBuffer);
    };
    const initialRanked = rankRace();
    const initialPlayer = playerRanking(initialRanked);
    if (initialPlayer === undefined) throw new Error("Race ranking lost the player at spawn.");
    const fallbackProbe = roadRayProbe(track.roadMeshes);
    const sector = new TrackSector({
      route: CIRCUIT,
      intersectRay: intersectRay(ctx.physics, fallbackProbe),
      // The grass is drawn and never collided, so a car past the armco has nothing under it. This is
      // the height it should be standing on, and the rescue fires the tick the car is clearly below it.
      groundAt: terrainHeight,
      // A metre below the drawn ground is not a crest or a berm, it is a car with nothing under it.
      fallDepth: 1.2,
    });
    track.boostArea.on("bodyEntered", (body) => {
      if (body === car.body.body) {
        car.boost.activate();
        emitPlaytestEvent({ entity: "player", name: "boost-applied" });
      }
    });
    car.boost.update(0);
    let elapsed = 0;
    let status: RaceStatus = "RACING";
    let rescues = 0;
    // Before any rescue, both are the worst they can be: a car facing the wrong way, a whole lap
    // from where it belongs. A sentinel of -1 satisfies an "at most 0.05 rad" bound before the game
    // has done anything, which is how a bound stops being a bound.
    let rescueHeadingError = Math.PI;
    let rescuePositionError = Math.PI;
    let sameDistanceRanking = initialRanked[0]?.id === "rival" ? "lap-ahead" : "lap-behind";
    let place = initialPlayer.place;
    let positionLabel = `P${place}`;
    const lastOnRoad: [number, number, number] = [SPAWN.x, SPAWN.y, SPAWN.z];
    // A rescue or the autopilot's rejoin teleports the car, so the camera cuts to it instead of
    // flying across the circuit.
    let teleports = car.body.teleports;
    const observedPosition = SPAWN.clone();
    sector.update(SPAWN, car.forward, 0, 0);
    chaseCamera(camera, car.body.position, car.forward, 1, undefined);

    const advanceRace = (frameCtx: GameCtx, dt: number): void => {
      if (status !== "RACING") return;
      lap.observe(observedPosition, car.body.position);
      observedPosition.copy(car.body.position);
      car.update(
        frameCtx,
        dt,
        touchControls?.update(frameCtx.input.raw.pointers, frameCtx.viewport.size),
      );
      for (let index = 0; index < rivals.length; index += 1) rivals[index]?.update(dt);
      gauges.update(car.speed, dt);
      sector.update(car.body.position, car.forward, dt, car.speed, car.driving);
      if (sector.rescue(car)) {
        rescues += 1;
        rescuePositionError = quantize(
          car.body.position.distanceTo(sector.lastOnRoadPosition),
          10_000,
        );
        rescueHeadingError = quantize(car.forward.angleTo(sector.lastOnRoadHeading), 10_000);
        emitPlaytestEvent({ entity: "player", name: "rescued" });
      }
      if (elapsed >= TIME_LIMIT || rescues >= 4) status = "DNF";
    };

    const statePatch: Partial<GameState> = {};
    const shake = ctx.entities.add("camera-rig", createShakeMeter());

    // Effects: two pooled emitters and one instanced ring of skid marks, every look parameter in
    // `render/effects.ts` and `render/skids.ts`.
    const make = (name: keyof typeof EFFECTS): GPUParticles3D => {
      const emitter = ctx.add(new GPUParticles3D(EFFECTS[name]()));
      emitter.name = `effects-${name}`;
      return emitter;
    };
    const emitters = { nitro: make("nitro"), smoke: make("smoke") };
    const burstOrigin = { x: 0, y: 0, z: 0 };
    const burstShape = { x: 0, y: 0, z: 0 };
    const burst = (kind: keyof typeof BURSTS, at: Vector3): void => {
      const { count, emitter, shape } = BURSTS[kind];
      burstOrigin.x = at.x;
      burstOrigin.y = at.y;
      burstOrigin.z = at.z;
      burstShape.x = shape[0];
      burstShape.y = shape[1];
      burstShape.z = shape[2];
      emitters[emitter].emitParticle({ count, direction: burstShape, origin: burstOrigin });
    };
    const skids = new SkidMarks(ctx.scene);
    // What the effects did, for a scenario: ticks a tyre smoked, ticks the flame burned.
    const effects = ctx.entities.add("effects", {
      flameTicks: 0,
      skidMarks: 0,
      smokeTicks: 0,
    });
    const REAR_WHEELS = [2, 3] as const;
    const rearRadius = car.body.body.wheels[2]?.wheelRadius ?? 0.37;
    const contact = new Vector3();
    let effectTick = 0;
    const emitEffects = (): void => {
      effectTick += 1;
      if (car.skidding) {
        let smoked = false;
        for (const index of REAR_WHEELS) {
          const wheel = car.body.wheels[index];
          if (wheel === undefined || !car.body.body.wheelContact(index)) continue;
          wheel.getWorldPosition(contact);
          contact.y -= rearRadius;
          skids.lay(index === 2 ? "rear-a" : "rear-b", contact.x, contact.y, contact.z);
          // Alternate tyres, one burst a tick: a puff a tick a wheel is a wall, not smoke.
          if ((effectTick + index) % 2 === 0) {
            contact.y += 0.12;
            burst("smoke", contact);
            smoked = true;
          }
        }
        if (smoked) effects.smokeTicks += 1;
        effects.skidMarks = skids.laid;
      }
      if (car.nitro.engaged) {
        effects.flameTicks += 1;
        for (const side of [-1, 1]) {
          contact.set(EXHAUST.x - 0.5, EXHAUST.y, side * EXHAUST.z);
          car.body.lean.localToWorld(contact);
          burst("nitro", contact);
        }
      }
    };

    // The suspension and the camera both read the **solved** chassis, so they run in the
    // afterPhysics phase rather than in the scene frame: a wheel's spin angle and a car's velocity
    // are last step's numbers until the step after this one.
    //
    // The sun's shadow camera follows the car. It used to be a fixed 30 m box around the origin,
    // which on an 830 m circuit put every shadow on the grass and left the car's own shadow — the
    // speed cue a driver actually reads — somewhere else entirely.
    // The lens's own reading: the nitro kick is measured on the camera, not restated from a
    // constant, so a camera that stops widening fails the scenario that promises it does.
    let fov = BASE_FOV;
    let fovPeak = BASE_FOV;

    afterPhysics(ctx, (dt) => {
      car.body.settleVisuals(car.nitro.engaged, dt);
      for (let index = 0; index < rivals.length; index += 1) rivals[index]?.car.settleVisuals();
      if (status === "RACING") emitEffects();
      lighting.key.target.position.copy(car.body.position);
      lighting.key.position.copy(car.body.position).addScaledVector(SUN_DIRECTION, 90);
      const solved = car.body.body.linearVelocity;
      const cut = car.body.teleports !== teleports;
      teleports = car.body.teleports;
      chaseCamera(
        camera,
        car.body.position,
        car.travelDirection,
        cut ? 1 : dt,
        solved,
        car.boosting,
      );
      camera.rotateZ(cameraBank(car.lateralLoad, FEEL.lateral));
      fov = camera.fov;
      fovPeak = Math.max(fovPeak, fov);
      this.#audio?.update({
        running: status === "RACING",
        rpm: gauges.rpm,
        driftAngle: car.drift.angle,
        sliding: car.skidding,
        nitroActive: car.nitro.engaged,
      });
      if (cut) {
        ctx.resetInterpolation(camera);
        shake.reset();
      }
      shake.sample(camera, car.body.lean);
    });

    // Collect only after the loaded character and scene receivers are attached.
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

    return (frameCtx, dt) => {
      loading.update();
      if (frameCtx.input.justPressed("restart")) {
        frameCtx.state.set(Race.initialState);
        frameCtx.state.flush();
        void frameCtx.goto("race");
        return;
      }
      // The race clock stops with the race, so the outcome panel reads the finishing time.
      if (status === "RACING") elapsed += dt;
      advanceRace(frameCtx, dt);
      const ranked = rankRace();
      const player = playerRanking(ranked);
      if (player === undefined) throw new Error("Race ranking lost the player.");
      sameDistanceRanking = ranked[0]?.id === "player" ? "lap-behind" : "lap-ahead";
      status = resolveRaceStatus(status, lap.completed, TOTAL_LAPS, player.place);
      if (player.place !== place) {
        place = player.place;
        positionLabel = `P${place}`;
      }
      const previous = frameCtx.state.getState();
      const boostPeakSpeed = Math.max(previous.boostPeakSpeed, car.boosting ? car.speed : 0);
      lastOnRoad[0] = sector.lastOnRoadPosition.x;
      lastOnRoad[1] = sector.lastOnRoadPosition.y;
      lastOnRoad[2] = sector.lastOnRoadPosition.z;
      statePatch.autopilot = car.autopilotEngaged;
      statePatch.boostActive = car.boosting;
      statePatch.boostPeakSpeed = boostPeakSpeed;
      statePatch.boostUses = car.boost.uses + car.nitro.uses;
      statePatch.drifting = car.drift.drifting;
      statePatch.driftAngle = quantize(car.drift.angle, 1000);
      statePatch.driftScore = Math.round(car.drift.score);
      statePatch.driftsBanked = car.drift.banked;
      statePatch.driftSpins = car.drift.spins;
      statePatch.nitro = quantize(car.nitro.tank, 1000);
      statePatch.nitroActive = car.nitro.engaged;
      statePatch.nitroDriftGain = quantize(car.nitro.driftGain, 1000);
      statePatch.gear = gauges.gear;
      statePatch.rpm = quantize(gauges.rpm, 1000);
      statePatch.driftLast = Math.round(car.drift.lastBanked);
      statePatch.driftPopup = quantize(car.drift.popup, 100);
      statePatch.fov = quantize(fov, 100);
      statePatch.fovPeak = quantize(fovPeak, 100);
      statePatch.engineRate = quantize(this.#audio?.rate ?? 0, 1000);
      statePatch.completedLaps = lap.completed;
      statePatch.elapsed = elapsed;
      statePatch.lastOnRoad = lastOnRoad;
      statePatch.place = player.place;
      statePatch.position = positionLabel;
      statePatch.raceStatus = status;
      statePatch.rescueHeading = Math.atan2(sector.lastOnRoadHeading.z, sector.lastOnRoadHeading.x);
      statePatch.rescueHeadingError = rescueHeadingError;
      statePatch.rescuePositionError = rescuePositionError;
      statePatch.rescues = rescues;
      statePatch.shortcutRejects = lap.shortcutRejects;
      statePatch.speed = car.speed;
      statePatch.speedAfterBoost = car.speedAfterBoost();
      statePatch.sameDistanceRanking = sameDistanceRanking;
      statePatch.topSpeed = Math.max(previous.topSpeed, car.topSpeed);
      statePatch.trackProgress = player.routeProgress;
      statePatch.reverseRejects = lap.reverseRejects;
      frameCtx.state.set(statePatch);
    };
  }

  override exit(ctx: GameCtx): void {
    this.#audio?.dispose();
    this.#audio = undefined;
    this.#materialLighting?.dispose();
    this.#materialLighting = undefined;
    this.#post?.dispose();
    this.#post = undefined;
    this.#environmentSample = undefined;
    this.#lightingGeneration += 1;
    super.exit(ctx);
  }
}
