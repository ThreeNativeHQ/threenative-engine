import {
  Scene,
  type SceneFrame,
  afterPhysics,
  getPlatform,
  isMobile,
  isTouchscreenAvailable,
} from "@threenative/core";
import { PLAYTEST_RUNNER_EXPECTED_GLOBAL } from "@threenative/core/playtest";
import { type IEnvironmentSample, sampleEnvironment } from "@threenative/core/render/environment";
import {
  CollisionShape3D,
  type IPhysicsContext,
  RigidBody3D,
  buildStaticColliders,
} from "@threenative/physics";
import { type PerspectiveCamera, type Texture, Vector3 } from "three";
import { type ClearLine, GUARD_RANGE, type ITarget, NoiseBus } from "../ai/perception.js";
import { AlertDirector } from "../ai/phase.js";
import type { GameCtx, IMannequin } from "../entities/Fighter.js";
import {
  GUARD_LAYER,
  Guard,
  PLAYER_LAYER,
  PUMPS_TO_KNOCK_OUT,
  WORLD_LAYER,
} from "../entities/Guard.js";
import { PICKUP_REACH, Player } from "../entities/Player.js";
import { SecurityCamera } from "../entities/SecurityCamera.js";
import { CAMERAS, COMPOUND, DOOR, EXTRACTION, KEYCARD, PATROLS, SPAWN } from "../level.js";
import { emitPlaytestEvent } from "../playtest-events.js";
import { createInfiltrationCamera } from "../render/camera.js";
import { cloudTextures, primeCloudTextures } from "../render/clouds.js";
import { createCompound } from "../render/compound.js";
import { setupLighting } from "../render/lighting.js";
import { createLoadingScreen } from "../render/loading.js";
import { createMaterialLighting } from "../render/materialLighting.js";
import { setupPost } from "../render/postprocessing.js";
import {
  type QualityTier,
  isWebGLFallbackRenderer,
  materialLightingEnabled,
} from "../render/quality.js";
import { SKY_OPTIONS, setupSky } from "../render/sky.js";
import { TouchControls } from "../render/touch-controls.js";
import type { GameState, RadarContact } from "../state.js";

/** Radar reach, metres: contacts beyond it are not drawn. */
const RADAR_RANGE = 18;
/** The radar refreshes ten times a second, not every tick: it is a HUD, not a simulation. */
const RADAR_INTERVAL = 0.1;
/** How fast the radar's noise ring shrinks after a footstep or a knock, metres per second. */
const NOISE_FADE = 14;
/** How long a HUD message stays up, seconds. */
const MESSAGE_TIME = 2.5;
const DOOR_REACH = 2;

/**
 * Playtest stations: each key puts the player at a fixed test spot so one scenario proves one
 * mechanic in a few ticks instead of a scripted walk across the compound. Positions relative to a
 * guard follow that guard wherever its patrol has taken it. Delete them with the playtests.
 */
type Station = (guards: ReadonlyMap<string, Guard>) => { x: number; z: number; yaw: number };
const STATIONS: Readonly<Record<string, Station>> = {
  // One metre behind the courtyard guard, facing its back: a takedown.
  station1: (guards) => relativeTo(guards.get("courtyard"), Math.PI, 1),
  // Five metres in front of it, in its cone: being seen.
  station2: (guards) => relativeTo(guards.get("courtyard"), 0, 5),
  // Against the yard fence's west face, out of the courtyard guard's way: wall press and knock.
  station3: () => ({ x: 9.45, z: 8.2, yaw: -Math.PI / 2 }),
  // Beside the keycard table.
  station4: () => ({ x: KEYCARD.x + 1, z: KEYCARD.z + 0.6, yaw: -Math.PI / 2 }),
  // On the courtyard side of the locked door.
  station5: () => ({ x: DOOR.x, z: DOOR.z + 1.2, yaw: Math.PI }),
  // In the open by the records doorway, inside the west camera's sweep.
  station6: () => ({ x: -10, z: 1, yaw: 0 }),
};
const STATION_NAMES = Object.keys(STATIONS);
/**
 * Playtest-only keys answer only when a playtest runner launched the page (the runner sets this
 * global before any game code runs). A player pressing them in a real build gets nothing.
 */
const UNDER_PLAYTEST =
  (globalThis as Record<string, unknown>)[PLAYTEST_RUNNER_EXPECTED_GLOBAL] === true;

function relativeTo(
  guard: Guard | undefined,
  bearing: number,
  distance: number,
): { x: number; z: number; yaw: number } {
  if (guard === undefined) throw new Error("A playtest station names a guard that does not exist.");
  const angle = guard.yaw + bearing;
  const x = guard.mesh.position.x + Math.sin(angle) * distance;
  const z = guard.mesh.position.z + Math.cos(angle) * distance;
  return { x, z, yaw: Math.atan2(guard.mesh.position.x - x, guard.mesh.position.z - z) };
}

function round(value: number, scale = 100): number {
  return Math.round(value * scale) / scale;
}

export class Play extends Scene<GameState, IPhysicsContext> {
  static override readonly initialState: GameState = {
    paused: false,
    uiReady: false,
    phase: "playing",
    alertPhase: "infiltration",
    phaseTimer: 0,
    alerts: 0,
    health: 100,
    stance: "stand",
    running: 0,
    noise: 0,
    knocks: 0,
    suspicion: 0,
    takedowns: 0,
    chokePumps: 0,
    bodiesFound: 0,
    investigating: 0,
    cameraAlarms: 0,
    dragging: 0,
    keycard: 0,
    doorOpen: 0,
    radarJammed: 0,
    radar: [],
    prompt: "",
    message: "",
    playerX: SPAWN.x,
    playerZ: SPAWN.z,
    playerYaw: 0,
    missionTime: 0,
  };

  #mannequin: IMannequin | undefined;
  #sky: Texture | undefined;
  #post: ReturnType<typeof setupPost> | undefined;
  #environmentSample: IEnvironmentSample | undefined;
  #materialLighting: ReturnType<typeof createMaterialLighting> | undefined;

  override async load(ctx: GameCtx): Promise<void> {
    // One rig for everyone: the infiltrator and every guard are the combat mannequin (Quaternius'
    // Universal Animation Library, CC0), dressed apart by a material swap.
    [this.#mannequin, this.#sky] = await Promise.all([
      ctx.assets.model<IMannequin>("mannequin-combat.glb"),
      SKY_OPTIONS.sky === "photo" ? ctx.assets.texture("sky.jpg") : undefined,
    ]);
    primeCloudTextures(await ctx.assets.memo("clouds", () => cloudTextures()));
    setupSky(ctx.scene, this.#sky, ctx.renderer.softwareAdapter !== undefined);
    this.#environmentSample = await sampleEnvironment(ctx.renderer.raw, ctx.scene, {
      web: getPlatform().runtime === "web",
      rendererKind: ctx.renderer.kind,
      webglFallback: isWebGLFallbackRenderer(ctx.renderer.raw),
      mobile: isMobile(),
      software: ctx.renderer.softwareAdapter !== undefined,
    });
  }

  override enter(ctx: GameCtx): SceneFrame<GameState, IPhysicsContext> {
    const mannequin = this.#mannequin;
    if (mannequin === undefined)
      throw new Error("Play.enter ran before load() loaded mannequin-combat.glb.");
    const camera = ctx.camera as PerspectiveCamera;
    setupSky(ctx.scene, this.#sky, ctx.renderer.softwareAdapter !== undefined);
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
    const cameraRig = createInfiltrationCamera(camera);
    ctx.viewport.resize();
    const touchControls =
      isMobile() && isTouchscreenAvailable()
        ? ctx.entities.add("touch-controls", new TouchControls(camera))
        : undefined;

    // The compound: walls and crates collide, the floor and its shadow pools do not.
    const compound = createCompound();
    ctx.add(compound.dressing);
    ctx.add(compound.solid);
    ctx.add(compound.keycard);
    ctx.add(compound.door);
    const colliders = { collisionLayer: WORLD_LAYER, collisionMask: PLAYER_LAYER | GUARD_LAYER };
    buildStaticColliders(ctx, compound.solid, colliders);
    buildStaticColliders(ctx, compound.keycard, colliders);
    new RigidBody3D({
      ...colliders,
      physics: ctx.physics,
      position: { x: 0, y: -0.5, z: 0 },
      shape: CollisionShape3D.box(COMPOUND.halfWidth * 2, 1, COMPOUND.halfDepth * 2),
      type: "fixed",
    });
    let doorBody: RigidBody3D | undefined = new RigidBody3D({
      ...colliders,
      physics: ctx.physics,
      position: { x: DOOR.x, y: COMPOUND.wallHeight / 2, z: DOOR.z },
      shape: CollisionShape3D.box(DOOR.width, COMPOUND.wallHeight, 0.3),
      type: "fixed",
    });

    // A sight line is clear when the first world hit is beyond its end (or there is none).
    const clear: ClearLine = (from, to) => {
      const hit = ctx.physics.directSpaceState.intersectRay({
        collisionMask: WORLD_LAYER,
        from,
        to,
      });
      return hit === undefined || hit.distance >= from.distanceTo(to) - 0.05;
    };

    const player = new Player(ctx, mannequin, new Vector3(SPAWN.x, 0.9, SPAWN.z));
    ctx.entities.add("player", player);
    const director = new AlertDirector();
    const noises = new NoiseBus();
    const guards: Guard[] = [];
    const guardById = new Map<string, Guard>();
    for (const patrol of PATROLS) {
      const guard = new Guard(ctx, mannequin, patrol, {
        clear,
        hitPlayer: (damage) => {
          player.takeDamage(damage, director);
          emitPlaytestEvent({ amount: damage, entity: "player", name: "shot" });
        },
        random: ctx.random,
      });
      guards.push(guard);
      guardById.set(patrol.id, guard);
      ctx.entities.add(`guard.${patrol.id}`, guard);
    }
    const cameras = CAMERAS.map((spec) => ctx.entities.add(spec.id, new SecurityCamera(ctx, spec)));

    // What the guards and the camera look at: one object, refreshed each tick.
    const target: { -readonly [K in keyof ITarget]: ITarget[K] } = {
      position: player.mesh.position,
      running: false,
      stance: "stand",
    };
    let noiseShown = 0;
    cameraRig.snap(player.mesh.position);
    const peek = { x: 0, z: 0 };
    afterPhysics(ctx, (dt) => {
      // The peek runs along the wall, toward the end the player is edging to.
      peek.x = player.stance === "wall" ? -player.wallNormal.y * player.peek : 0;
      peek.z = player.stance === "wall" ? player.wallNormal.x * player.peek : 0;
      cameraRig.follow(player.mesh.position, peek, dt);
    });

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

    let hasKeycard = false;
    let doorOpen = false;
    let doorLift = 0;
    let message = "";
    let messageTimer = 0;
    let radarTimer = 0;
    let missionTime = 0;
    let cameraAlarms = 0;
    const say = (text: string): void => {
      message = text;
      messageTimer = MESSAGE_TIME;
    };
    const frame: Partial<GameState> = {};
    const radar: RadarContact[] = [];
    const contact = (
      kind: RadarContact["kind"],
      x: number,
      z: number,
      yaw: number,
      halfAngle: number,
      range: number,
      state: string,
    ): void => {
      const dx = x - player.mesh.position.x;
      const dz = z - player.mesh.position.z;
      if (Math.hypot(dx, dz) > RADAR_RANGE) return;
      radar.push({
        halfAngle: round(halfAngle),
        kind,
        range,
        state,
        x: round(x),
        yaw: round(yaw),
        z: round(z),
      });
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
        const station = STATIONS[name]?.(guardById);
        if (station === undefined) continue;
        player.mesh.position.set(station.x, player.mesh.position.y, station.z);
        player.body.teleport(player.mesh.position);
        player.figure.rotation.y = station.yaw;
        emitPlaytestEvent({ entity: "player", name });
      }

      // Interact: the keycard, then the door it opens. Measured before the player moves, so the
      // key opens the door rather than grabbing a body someone left beside it.
      const atKeycard =
        !hasKeycard &&
        Math.hypot(player.mesh.position.x - KEYCARD.x, player.mesh.position.z - KEYCARD.z) <=
          PICKUP_REACH + 0.6;
      const atDoor =
        !doorOpen &&
        Math.hypot(player.mesh.position.x - DOOR.x, player.mesh.position.z - DOOR.z) <= DOOR_REACH;
      player.objectiveNear = atKeycard || (atDoor && hasKeycard);

      const touch = touchControls?.update(frameCtx.input.raw.pointers, frameCtx.viewport.size);
      if (playing) {
        missionTime += dt;
        player.update(frameCtx, dt, guards, director, noises, touch);
      } else {
        player.freeze(dt);
        for (const guard of guards) guard.rest(dt);
      }
      if (playing && frameCtx.input.justPressed("interact") && player.dragging === undefined) {
        if (atKeycard) {
          hasKeycard = true;
          player.pickUp();
          const card = compound.keycard.getObjectByName("keycard-card");
          if (card !== undefined) card.visible = false;
          say("Keycard acquired");
          emitPlaytestEvent({ entity: "player", name: "keycard" });
        } else if (atDoor && hasKeycard) {
          doorOpen = true;
          doorBody?.dispose();
          doorBody = undefined;
          say("Door unlocked");
          emitPlaytestEvent({ entity: "player", name: "door-open" });
        } else if (atDoor) say("Locked. A keycard opens it.");
      }
      if (doorOpen && doorLift < 1) {
        doorLift = Math.min(1, doorLift + dt * 1.5);
        compound.door.position.y = COMPOUND.wallHeight / 2 + doorLift * (COMPOUND.wallHeight - 0.2);
      }

      // The guards and the camera see and hear; the director turns what they report into a phase.
      if (playing && frameCtx.startup.compileSettled) {
        target.running = player.running;
        target.stance = player.stance;
        for (const guard of guards)
          guard.update(frameCtx, dt, target, director, director.phase, noises, guards);
        for (const securityCamera of cameras) {
          if (securityCamera.update(dt, target, clear)) {
            cameraAlarms += 1;
            director.spotted(player.mesh.position.x, player.mesh.position.z);
            emitPlaytestEvent({ entity: securityCamera.id, name: "camera-alarm" });
          } else if (securityCamera.suspicion >= 1 && securityCamera.sight > 0)
            director.spotted(player.mesh.position.x, player.mesh.position.z);
        }
        let seen = false;
        for (const guard of guards)
          if (guard.conscious && guard.sight > 0 && guard.state === "alert") seen = true;
        for (const securityCamera of cameras)
          if (securityCamera.sight > 0 && securityCamera.suspicion >= 1) seen = true;
        director.update(dt, seen);
        for (const change of director.changes)
          emitPlaytestEvent({ entity: "director", name: change.to });
        director.changes.length = 0;
      }
      noises.clear();

      if (
        playing &&
        doorOpen &&
        Math.hypot(player.mesh.position.x - EXTRACTION.x, player.mesh.position.z - EXTRACTION.z) <=
          EXTRACTION.radius
      ) {
        frameCtx.state.set({ phase: "won" });
        say("Mission complete");
        emitPlaytestEvent({ entity: "player", name: "extracted" });
      }
      if (playing && player.dead) {
        frameCtx.state.set({ phase: "lost" });
        say("Mission failed");
      }

      messageTimer = Math.max(0, messageTimer - dt);
      if (messageTimer === 0) message = "";
      radarTimer -= dt;
      if (radarTimer <= 0) {
        radarTimer = RADAR_INTERVAL;
        radar.length = 0;
        for (const guard of guards)
          contact(
            "guard",
            guard.mesh.position.x,
            guard.mesh.position.z,
            guard.yaw,
            guard.conscious ? guard.halfAngle : 0,
            guard.conscious ? GUARD_RANGE : 0,
            guard.state,
          );
        for (const securityCamera of cameras)
          contact(
            "camera",
            securityCamera.eye.x,
            securityCamera.eye.z,
            securityCamera.yaw,
            securityCamera.halfAngle,
            securityCamera.range,
            securityCamera.suspicion >= 1 ? "alert" : "patrol",
          );
        frame.radar = radar.slice();
      }

      let suspicion = 0;
      let bodiesFound = 0;
      let investigating = 0;
      for (const guard of guards) {
        if (guard.conscious) suspicion = Math.max(suspicion, guard.suspicion);
        bodiesFound += guard.bodiesFound;
        if (guard.state === "suspicious" || guard.state === "investigate") investigating += 1;
      }
      for (const securityCamera of cameras)
        suspicion = Math.max(suspicion, securityCamera.suspicion);
      // A footstep or a knock lasts one tick in the world; on the radar its ring fades out.
      noiseShown = Math.max(player.noise, noiseShown - dt * NOISE_FADE);
      frame.investigating = investigating;
      frame.prompt = !playing
        ? "R  RESTART"
        : player.held !== undefined
          ? `F  CHOKE  ${player.pumps}/${PUMPS_TO_KNOCK_OUT}`
          : player.dragging !== undefined
            ? "RELEASE E  DROP BODY"
            : player.grabTarget(guards) !== undefined
              ? "F  GRAB"
              : atKeycard
                ? "E  TAKE KEYCARD"
                : atDoor && hasKeycard
                  ? "E  OPEN DOOR"
                  : player.canDrag(guards)
                    ? "HOLD E  DRAG BODY"
                    : atDoor
                      ? "LOCKED  KEYCARD"
                      : player.stance === "wall"
                        ? "Q  KNOCK"
                        : "";
      frame.alertPhase = director.phase;
      frame.phaseTimer = round(director.timer, 10);
      frame.alerts = director.alerts;
      frame.health = player.health;
      frame.stance = player.stance;
      frame.running = player.running ? 1 : 0;
      frame.noise = round(noiseShown);
      frame.knocks = player.knocks;
      frame.suspicion = round(suspicion);
      frame.takedowns = player.takedowns;
      frame.chokePumps = player.pumps;
      frame.bodiesFound = bodiesFound;
      frame.dragging = player.dragging === undefined ? 0 : 1;
      frame.keycard = hasKeycard ? 1 : 0;
      frame.doorOpen = doorOpen ? 1 : 0;
      frame.radarJammed = director.phase === "alert" || director.phase === "evasion" ? 1 : 0;
      frame.message = message;
      frame.playerX = round(player.mesh.position.x);
      frame.playerZ = round(player.mesh.position.z);
      frame.playerYaw = round(player.figure.rotation.y);
      frame.missionTime = round(missionTime, 10);
      frame.cameraAlarms = cameraAlarms;
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
