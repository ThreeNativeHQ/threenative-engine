import { Scene, type SceneFrame, afterPhysics, getPlatform, isMobile } from "@threenative/core";
import { type IEnvironmentSample, sampleEnvironment } from "@threenative/core/render/environment";
import {
  CollisionShape3D,
  type IPhysicsContext,
  RigidBody3D,
  buildStaticColliders,
} from "@threenative/physics";
import { MathUtils, type PerspectiveCamera, Vector3 } from "three";
import type { GameCtx, IMannequin } from "../entities/Fighter.js";
import { Grenade, type IWorldCast, blastDamage } from "../entities/Grenade.js";
import { Player } from "../entities/Player.js";
import { PLAYER_LAYER, SOLDIER_LAYER, Soldier, WORLD_LAYER } from "../entities/Soldier.js";
import { ARENA, POSTS } from "../level.js";
import { emitPlaytestEvent } from "../playtest-events.js";
import { createArena } from "../render/arena.js";
import { cloudTextures, primeCloudTextures } from "../render/clouds.js";
import { setupLighting } from "../render/lighting.js";
import { createLoadingScreen } from "../render/loading.js";
import { createMaterialLighting } from "../render/materialLighting.js";
import { setupPost } from "../render/postprocessing.js";
import { createTracer } from "../render/props.js";
import {
  type QualityTier,
  isWebGLFallbackRenderer,
  materialLightingEnabled,
} from "../render/quality.js";
import { setupSky } from "../render/sky.js";
import { createViewmodel } from "../render/viewmodel.js";
import { RIFLE } from "../rules/weapon.js";
import type { GameState } from "../state.js";
import { STATIONS, STATION_NAMES, UNDER_PLAYTEST } from "../stations.js";

/** How long a HUD message stays up, seconds. */
const MESSAGE_TIME = 2.5;
/** Seconds the player's own tracer and the hit marker stay on screen. */
const TRACER_TIME = 0.05;
const MARKER_TIME = 0.2;
/** A playtest damage key: one hit big enough to empty the shield and spill into health. */
const TEST_HIT = 130;

function round(value: number, scale = 100): number {
  return Math.round(value * scale) / scale;
}

export class Play extends Scene<GameState, IPhysicsContext> {
  static override readonly initialState: GameState = {
    paused: false,
    uiReady: false,
    phase: "playing",
    stance: "stand",
    eyeHeight: 1.52,
    speed: 0,
    sprinting: 0,
    sprintBudget: 4,
    aiming: 0,
    fov: RIFLE.hipFov,
    spread: 0,
    spreadPoints: 0,
    kickPitch: 0,
    ammo: RIFLE.magazine,
    reserve: RIFLE.reserve,
    reloading: 0,
    grenades: 3,
    fuse: 0,
    shield: 100,
    health: 100,
    shieldStun: 0,
    shots: 0,
    hits: 0,
    kills: 0,
    hitsTaken: 0,
    blockedShots: 0,
    marker: 0,
    lastAccuracy: 0,
    enemiesLeft: POSTS.length,
    message: "",
    time: 0,
  };

  #mannequin: IMannequin | undefined;
  #post: ReturnType<typeof setupPost> | undefined;
  #environmentSample: IEnvironmentSample | undefined;
  #materialLighting: ReturnType<typeof createMaterialLighting> | undefined;

  override async load(ctx: GameCtx): Promise<void> {
    // One rig for everyone: every soldier is the combat mannequin (Quaternius' Universal
    // Animation Library, CC0). The player is a pair of hands and a rifle, so it needs no rig.
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

  override enter(ctx: GameCtx): SceneFrame<GameState, IPhysicsContext> {
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
    camera.fov = RIFLE.hipFov;
    camera.near = 0.02;
    camera.far = 240;
    camera.updateProjectionMatrix();
    ctx.add(camera);
    ctx.viewport.resize();
    const viewmodel = createViewmodel(camera);

    // The yard: walls and cover collide, the floor does not draw a collider of its own.
    const arena = createArena();
    ctx.add(arena.dressing);
    ctx.add(arena.solid);
    const colliders = { collisionLayer: WORLD_LAYER, collisionMask: PLAYER_LAYER | SOLDIER_LAYER };
    buildStaticColliders(ctx, arena.solid, colliders);
    new RigidBody3D({
      ...colliders,
      physics: ctx.physics,
      position: { x: 0, y: -0.5, z: 0 },
      shape: CollisionShape3D.box(ARENA.halfWidth * 2, 1, ARENA.halfDepth * 2),
      type: "fixed",
    });

    // The first wall or cover on a line, as a distance, or undefined when the line is clear.
    const worldHit = (from: Vector3, to: Vector3): number | undefined => {
      const hit = ctx.physics.directSpaceState.intersectRay({
        collisionMask: WORLD_LAYER,
        from,
        to,
      });
      return hit === undefined || hit.distance >= from.distanceTo(to) - 0.05
        ? undefined
        : hit.distance;
    };
    const cast: IWorldCast = (from, to) => {
      const hit = ctx.physics.directSpaceState.intersectRay({
        collisionMask: WORLD_LAYER,
        from,
        to,
      });
      return hit === undefined
        ? undefined
        : {
            normal: new Vector3(hit.normal.x, hit.normal.y, hit.normal.z),
            point: new Vector3(hit.position.x, hit.position.y, hit.position.z),
          };
    };

    const player = new Player(ctx);
    ctx.entities.add("player", player);
    afterPhysics(ctx, () => player.syncCamera(camera));
    player.syncCamera(camera);
    let duel: string | undefined;
    let lastAccuracy = 0;
    const soldiers: Soldier[] = [];
    for (const post of POSTS) {
      const soldier = new Soldier(ctx, mannequin, post, {
        hitPlayer: (damage) => {
          player.hurt(damage);
          emitPlaytestEvent({ amount: damage, entity: "player", name: "shot" });
        },
        aimed: (accuracy) => {
          lastAccuracy = accuracy;
        },
        random: ctx.random,
        worldHit,
      });
      soldiers.push(soldier);
      ctx.entities.add(`soldier.${post.id}`, soldier);
    }

    const tracer = createTracer();
    ctx.add(tracer.line);
    let tracerTimer = 0;
    let marker = 0;
    let kills = 0;
    let hits = 0;
    let message = "";
    let messageTimer = 0;
    let time = 0;
    let grenade: Grenade | undefined;
    const say = (text: string): void => {
      message = text;
      messageTimer = MESSAGE_TIME;
    };

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

    // The player's round: the nearest of the first wall and each soldier's body along the ray.
    const shoot = (origin: Vector3, direction: Vector3): void => {
      const end = origin.clone().addScaledVector(direction, RIFLE.range);
      const wall = worldHit(origin, end) ?? RIFLE.range;
      let nearest: { soldier: Soldier; distance: number; head: boolean } | undefined;
      for (const soldier of soldiers) {
        const strike = soldier.hitTest(origin, direction, wall);
        if (strike !== undefined && (nearest === undefined || strike.distance < nearest.distance))
          nearest = { soldier, ...strike };
      }
      const reach = nearest?.distance ?? wall;
      const muzzle = origin.clone().addScaledVector(direction, 0.7);
      muzzle.y -= 0.12;
      const point = origin.clone().addScaledVector(direction, reach);
      tracer.aim(muzzle.x, muzzle.y, muzzle.z, point.x, point.y, point.z);
      tracerTimer = TRACER_TIME;
      emitPlaytestEvent({ entity: "player", name: "fire" });
      if (nearest === undefined) return;
      hits += 1;
      marker = MARKER_TIME;
      const damage = RIFLE.damage * (nearest.head ? RIFLE.headMultiplier : 1);
      if (nearest.soldier.damage(damage)) {
        kills += 1;
        emitPlaytestEvent({ entity: nearest.soldier.id, name: "kill" });
      }
    };

    const blast = (at: Vector3): void => {
      const centre = at.clone();
      centre.y += 0.3;
      emitPlaytestEvent({ entity: "grenade", name: "grenade-blast" });
      for (const soldier of soldiers) {
        if (!soldier.alive) continue;
        const chest = new Vector3(soldier.mesh.position.x, 1.2, soldier.mesh.position.z);
        const amount =
          worldHit(centre, chest) === undefined ? blastDamage(centre.distanceTo(chest)) : 0;
        if (amount > 0 && soldier.damage(amount)) {
          kills += 1;
          emitPlaytestEvent({ entity: soldier.id, name: "kill" });
        }
      }
      // The blast hurts the thrower too: stand clear.
      const toPlayer = player.chest;
      const amount =
        worldHit(centre, toPlayer) === undefined ? blastDamage(centre.distanceTo(toPlayer)) : 0;
      if (amount > 0) player.hurt(amount);
    };

    const frame: Partial<GameState> = {};
    const direction = new Vector3();
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
        player.place(station.x, station.z, station.yaw);
        player.pitch = station.pitch ?? 0;
        duel = station.duel;
        for (const soldier of soldiers) soldier.loseTarget();
        emitPlaytestEvent({ entity: "player", name });
      }
      if (UNDER_PLAYTEST && frameCtx.input.justPressed("hurt")) {
        player.hurt(TEST_HIT);
        emitPlaytestEvent({ entity: "player", name: "hurt" });
      }

      // Any press on the surface buys the pointer, which is what makes the mouse steer.
      const pointer = frameCtx.input.raw.pointer;
      if (pointer.down && !pointer.captured) frameCtx.input.captureMouse();

      if (playing) {
        time += dt;
        player.update(frameCtx, dt);
        if (frameCtx.input.pressed("fire")) {
          const round = player.fire(frameCtx.random);
          if (round !== undefined) shoot(round.origin, round.direction);
        }
        if (frameCtx.input.justPressed("grenade") && player.tryThrow()) {
          const origin = player.eye.clone();
          grenade = new Grenade(origin, player.throwDirection(direction), player.velocity);
          ctx.add(grenade.mesh);
          emitPlaytestEvent({ entity: "grenade", name: "grenade-thrown" });
        }
      } else player.update(frameCtx, 0);

      if (grenade !== undefined) {
        if (grenade.step(dt, cast)) {
          blast(grenade.position);
          grenade.dispose();
          grenade = undefined;
        }
      }

      const target = {
        chest: player.chest,
        eye: player.eye,
        stance: player.stance,
        velocity: player.velocity,
      };
      for (const soldier of soldiers) {
        if (!playing) soldier.rest(dt);
        else soldier.update(frameCtx, dt, target, duel !== undefined && duel !== soldier.id);
      }

      const left = soldiers.filter((soldier) => soldier.alive).length;
      if (playing && left === 0) {
        frameCtx.state.set({ phase: "won" });
        say("Yard cleared");
      }
      if (playing && player.dead) {
        frameCtx.state.set({ phase: "lost" });
        say("Down");
      }

      tracerTimer = Math.max(0, tracerTimer - dt);
      tracer.line.visible = tracerTimer > 0;
      marker = Math.max(0, marker - dt);
      messageTimer = Math.max(0, messageTimer - dt);
      if (messageTimer === 0) message = "";
      viewmodel.update({
        ads: player.ads,
        kick: player.kick.pitch,
        reload: player.reload > 0 ? 1 - player.reload / RIFLE.reloadSeconds : 0,
        sprinting: player.sprint.active,
      });

      frame.stance = player.stance;
      frame.eyeHeight = round(player.eyeHeight, 1000);
      frame.speed = round(player.speed, 1000);
      frame.sprinting = player.sprint.active ? 1 : 0;
      frame.sprintBudget = round(player.sprint.seconds);
      frame.aiming = player.ads > 0.5 ? 1 : 0;
      frame.fov = round(MathUtils.lerp(RIFLE.hipFov, RIFLE.adsFov, player.ads), 10);
      frame.spread = round(player.spread, 1000);
      frame.spreadPoints = round(player.spreadPoints, 10);
      frame.kickPitch = round(player.kick.pitch, 1000);
      frame.ammo = player.ammo;
      frame.reserve = player.reserve;
      frame.reloading = player.reload > 0 ? 1 : 0;
      frame.grenades = player.grenades;
      frame.fuse = grenade === undefined ? 0 : round(grenade.fuse);
      frame.shield = round(player.vitals.shield, 10);
      frame.health = round(player.vitals.health, 10);
      frame.shieldStun = player.vitals.stunTicks;
      frame.shots = player.shots;
      frame.hits = hits;
      frame.kills = kills;
      frame.hitsTaken = player.hitsTaken;
      frame.blockedShots = soldiers.reduce((sum, soldier) => sum + soldier.blocked, 0);
      frame.lastAccuracy = round(lastAccuracy, 1000);
      frame.marker = marker > 0 ? 1 : 0;
      frame.enemiesLeft = left;
      frame.message = message;
      frame.time = round(time, 10);
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
