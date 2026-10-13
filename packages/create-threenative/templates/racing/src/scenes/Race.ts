import {
  type ICtx,
  Scene,
  type SceneFrame,
  afterPhysics,
  getPlatform,
  isMobile,
  isTouchscreenAvailable,
} from "@threenative/core";
import type { IPhysicsContext } from "@threenative/physics";
import { type PerspectiveCamera, type Texture, Vector3 } from "three";
import { type CarCtx, FEEL } from "../entities/CarBody.js";
import { RacingCar } from "../entities/RacingCar.js";
import { Rival } from "../entities/Rival.js";
import { emitPlaytestEvent } from "../playtest-events.js";
import { cameraBank, chaseCamera, setupCamera } from "../render/camera.js";
import { type IEnvironmentSample, sampleEnvironment } from "../render/environmentSampling.js";
import { setupLighting } from "../render/lighting.js";
import { createLoadingScreen } from "../render/loading.js";
import { createMaterialLighting } from "../render/materialLighting.js";
import { setupPost } from "../render/postprocessing.js";
import {
  type QualityTier,
  isWebGLFallbackRenderer,
  materialLightingEnabled,
} from "../render/quality.js";
import { SUN_DIRECTION, setupSky } from "../render/sky.js";
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
} from "../track/Track.js";
import { TrackSector } from "../track/TrackSector.js";
import { CIRCUIT, GRID_DISTANCE } from "../track/circuit.js";

export type GameCtx = CarCtx;

/** The player starts on the second grid slot, one ride height above the tarmac. */
const SPAWN = gridPosition("player", new Vector3());
SPAWN.y = CIRCUIT.at(GRID_DISTANCE.player, CIRCUIT.createSample()).point.y + 0.22;
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
    completedLaps: 0,
    elapsed: 0,
    lastOnRoad: [SPAWN.x, SPAWN.y, SPAWN.z],
    place: 1,
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
   * The sky photograph, fetched but **not awaited**.
   *
   * `await`ing it here held the scene's first frame for the length of a texture decode, and the
   * playtest bridge describes the scene before the runtime enters it: `survives` failed
   * `TN_PLAYTEST_CAPABILITY_MISSING` on `runtime.components` because there was no `player` entity
   * yet to describe. The scene now enters on the fallback colour and the photograph is swapped in
   * the moment it decodes, which is also what a player sees — a sky that arrives rather than a
   * black screen that waits.
   */
  #post: ReturnType<typeof setupPost> | undefined;
  #environmentSample: IEnvironmentSample | undefined;
  #materialLighting: ReturnType<typeof createMaterialLighting> | undefined;
  #lightingGeneration = 0;

  override load(ctx: GameCtx): void {
    const generation = ++this.#lightingGeneration;
    void ctx.assets.texture("sky.jpg").then(async (texture) => {
      if (generation !== this.#lightingGeneration) return;
      this.#sky = texture;
      const scene = ctx.scene;
      if (scene === undefined) return;
      setupSky(scene, texture);
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
    });
  }

  override enter(ctx: GameCtx): SceneFrame<GameState, IPhysicsContext> {
    if (this.#sky === undefined) setupSky(ctx.scene, undefined);
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
    const car = new RacingCar(ctx, SPAWN, gridHeading("player"));
    // The rival's own grid slot, projected onto the circuit it drives: on pole, four metres up the
    // road and 4.4 m to the other side, facing the same way. It used to be placed a whole lap
    // ahead and then copied onto the player's position, so the two cars were the same point in
    // space and the player drove through a rival that had no body.
    const rival = new Rival(ctx, GRID_DISTANCE.rival);
    ctx.entities.add("player", car);
    ctx.entities.add("rival", rival);

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
    const rivalRankingInput = { id: "rival", lap: rival.lap, position: rival.mesh.position };
    const rankingInputs = [playerRankingInput, rivalRankingInput];
    const rankingBuffer: IRankedRacerScratch[] = [];
    const rankRace = () => {
      playerRankingInput.lap = lap.completed;
      rivalRankingInput.lap = rival.lap;
      return rankRacers(CIRCUIT, rankingInputs, undefined, rankingBuffer);
    };
    const initialRanked = rankRace();
    const initialPlayer = playerRanking(initialRanked);
    if (initialPlayer === undefined) throw new Error("Race ranking lost the player at spawn.");
    const fallbackProbe = roadRayProbe(track.roadMeshes);
    const sector = new TrackSector({
      route: CIRCUIT,
      intersectRay: intersectRay(ctx.physics, fallbackProbe),
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
      rival.update(dt);
      sector.update(car.body.position, car.forward, dt, car.speed);
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

    // The suspension and the camera both read the **solved** chassis, so they run in the
    // afterPhysics phase rather than in the scene frame: a wheel's spin angle and a car's velocity
    // are last step's numbers until the step after this one.
    //
    // The sun's shadow camera follows the car. It used to be a fixed 30 m box around the origin,
    // which on an 830 m circuit put every shadow on the grass and left the car's own shadow — the
    // speed cue a driver actually reads — somewhere else entirely.
    afterPhysics(ctx, (dt) => {
      car.body.settleVisuals();
      rival.car.settleVisuals();
      lighting.key.target.position.copy(car.body.position);
      lighting.key.position.copy(car.body.position).addScaledVector(SUN_DIRECTION, 90);
      const solved = car.body.body.linearVelocity;
      chaseCamera(camera, car.body.position, car.travelDirection, dt, solved);
      camera.rotateZ(cameraBank(car.lateralLoad, FEEL.lateral));
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
      elapsed += dt;
      advanceRace(frameCtx, dt);
      const ranked = rankRace();
      const player = playerRanking(ranked);
      if (player === undefined) throw new Error("Race ranking lost the player.");
      sameDistanceRanking = ranked[0]?.id === "rival" ? "lap-ahead" : "lap-behind";
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
      statePatch.boostUses = car.boost.uses;
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
    this.#materialLighting?.dispose();
    this.#materialLighting = undefined;
    this.#post?.dispose();
    this.#post = undefined;
    this.#environmentSample = undefined;
    this.#lightingGeneration += 1;
    super.exit(ctx);
  }
}
