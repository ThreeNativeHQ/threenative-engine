import {
  Scene,
  type SceneFrame,
  afterPhysics,
  getPlatform,
  isMobile,
  isTouchscreenAvailable,
  markStatic,
  mergeByMaterial,
} from "@threenative/core";
import { PLAYTEST_RUNNER_EXPECTED_GLOBAL } from "@threenative/core/playtest";
import { type IEnvironmentSample, sampleEnvironment } from "@threenative/core/render/environment";
import { CollisionShape3D, type IPhysicsContext, RigidBody3D } from "@threenative/physics";
import { type Mesh, type PerspectiveCamera, Vector2, Vector3 } from "three";
import { PLACES } from "../city/layout.js";
import type { IMannequin } from "../entities/Humanoid.js";
import { CAR_LAYER, type GameCtx, WORLD_LAYER } from "../entities/layers.js";
import { CityCamera } from "../render/camera.js";
import { buildCity, buildSkyline } from "../render/city.js";
import { cloudTextures, primeCloudTextures } from "../render/clouds.js";
import { setupLighting } from "../render/lighting.js";
import { createLoadingScreen } from "../render/loading.js";
import { createMaterialLighting } from "../render/materialLighting.js";
import { setupPost } from "../render/postprocessing.js";
import { isWebGLFallbackRenderer, materialLightingEnabled } from "../render/quality.js";
import { SUN_DIRECTION, setupSky } from "../render/sky.js";
import { TouchControls } from "../render/touch-controls.js";
import { type GameState, INITIAL_STATE } from "../state.js";
import { STATIONS, World } from "../systems/World.js";
import { CityStreamer } from "../systems/streaming.js";

/** Radar dots change slowly; publishing them every sixth tick keeps the HUD cheap. */
const RADAR_EVERY = 6;

/**
 * True only under the playtest runner (it sets this global before any game code runs). The
 * station keys answer only then; a player pressing them in a real build gets nothing.
 */
const UNDER_PLAYTEST =
  (globalThis as Record<string, unknown>)[PLAYTEST_RUNNER_EXPECTED_GLOBAL] === true;

export class Play extends Scene<GameState, IPhysicsContext> {
  static override readonly initialState: GameState = INITIAL_STATE;

  #model: IMannequin | undefined;
  #environmentSample: IEnvironmentSample | undefined;
  #materialLighting: ReturnType<typeof createMaterialLighting> | undefined;
  #post: ReturnType<typeof setupPost> | undefined;

  override async load(ctx: GameCtx): Promise<void> {
    // One rig for the whole city: Quaternius' Universal Animation Library combat mannequin (CC0) is
    // the player, every pedestrian and every officer, told apart by a material swap.
    this.#model = await ctx.assets.model<IMannequin>("mannequin-combat.glb");
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
    const model = this.#model;
    if (model === undefined)
      throw new Error("Play.enter ran before load() loaded mannequin-combat.glb.");
    ctx.state.set({ ...INITIAL_STATE });
    const showTouchControls = isMobile() && isTouchscreenAvailable();
    setupSky(ctx.scene, ctx.renderer.softwareAdapter !== undefined);
    const lighting = setupLighting(
      ctx.scene,
      ctx.renderer.raw as Parameters<typeof setupLighting>[1],
      isMobile(),
    );
    ctx.add(lighting.key.target);
    const materialEnvironment = {
      web: getPlatform().runtime === "web",
      rendererKind: ctx.renderer.kind,
      webglFallback: isWebGLFallbackRenderer(ctx.renderer.raw),
      mobile: isMobile(),
      software: ctx.renderer.softwareAdapter !== undefined,
    };
    this.#post = setupPost(ctx.renderer, ctx.scene, ctx.camera, {
      godraysLight: lighting.key,
      onTierChanged: (tier) =>
        this.#materialLighting?.setEnabled(materialLightingEnabled(tier, materialEnvironment)),
      mobile: isMobile(),
      software: ctx.renderer.softwareAdapter !== undefined,
      gpuClass: ctx.renderer.gpuClass?.class,
    });
    const camera = ctx.camera as PerspectiveCamera;
    const rig = new CityCamera(camera);
    const loading = createLoadingScreen(ctx);
    ctx.add(camera);
    const touchControls = showTouchControls
      ? ctx.entities.add("touch-controls", new TouchControls(camera))
      : undefined;

    // What stays built: the ground, the boundary, the lane paint and the markers. One box collider
    // per drawn solid, then the drawing merged to a mesh per material.
    const city = buildCity();
    for (const solid of city.solids)
      new RigidBody3D({
        collisionLayer: WORLD_LAYER,
        physics: ctx.physics,
        position: solid.center,
        shape: CollisionShape3D.box(solid.size.x, solid.size.y, solid.size.z),
        type: "fixed",
      });
    new RigidBody3D({
      collisionLayer: WORLD_LAYER,
      physics: ctx.physics,
      position: { x: 0, y: -0.5, z: 0 },
      shape: CollisionShape3D.box(600, 1, 600),
      type: "fixed",
    });
    const live = new Set<Mesh>([city.respraySign, city.dropoffPad, city.phoneMarker]);
    const merged = mergeByMaterial(city.root, { label: "city", skip: (mesh) => live.has(mesh) });
    for (const mesh of merged) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
    city.root.clear();
    city.root.add(...merged, ...live);
    ctx.add(city.root);
    markStatic(city.root);
    // The blocks stream by distance (`systems/streaming.ts`); the skyline draws the ones not built.
    const skyline = buildSkyline();
    if (skyline !== undefined) markStatic(ctx.add(skyline));
    const streamer = ctx.entities.add("city", new CityStreamer(ctx.physics));
    ctx.add(streamer.root);
    streamer.update(PLACES.playerSpawn, Number.POSITIVE_INFINITY);

    const world = new World(ctx, model, camera);
    // Walls and cars pull the lens in: a passing car never stands between the camera and the
    // player. A ray that starts inside the player's own car ignores it (hit_from_inside off).
    const probe = (from: Vector3, to: Vector3) =>
      ctx.physics.directSpaceState.intersectRay({
        collisionMask: WORLD_LAYER | CAR_LAYER,
        from,
        to,
      })?.distance;
    let hidden = false;
    ctx.entities.add("camera", { debug: () => ({ hidden, yaw: rig.yaw }) });
    const look = new Vector2();
    afterPhysics(ctx, (dt) => {
      for (const car of world.cars) car.afterStep(dt);
      const player = world.player;
      const driving = player.mode === "driving" && player.car !== undefined;
      const subject = player.where;
      const heading = driving ? (player.car?.yaw ?? 0) : player.figure.rotation.y + Math.PI;
      rig.update(dt, subject, heading, look, driving, player.car?.speed ?? 0, probe);
      hidden = probe(subject, camera.position) !== undefined;
      // The sun's shadow map follows the player across the city.
      lighting.key.target.position.copy(subject);
      lighting.key.position.copy(subject).addScaledVector(SUN_DIRECTION, 60);
      streamer.update(subject);
    });

    this.#materialLighting = ctx.entities.add(
      "material-lighting",
      createMaterialLighting(ctx.scene, ctx.camera, lighting.key, {
        ...materialEnvironment,
        enabled: materialLightingEnabled(this.#post.tier, materialEnvironment),
      }),
    );
    if (this.#environmentSample !== undefined) {
      const { measurement, source, intensity } = this.#environmentSample;
      this.#materialLighting.setEnvironmentMeasurement(
        measurement,
        source,
        intensity,
        this.#environmentSample,
      );
    }

    const move = new Vector2();
    const reticle = new Vector3();
    const aimAhead = new Vector3();
    let tick = 0;
    const patch: Partial<GameState> = {};
    return (frameCtx, dt) => {
      loading.update();
      if (frameCtx.input.justPressed("restart")) {
        void frameCtx.goto("play");
        return;
      }
      const input = frameCtx.input;
      if (UNDER_PLAYTEST)
        STATIONS.forEach((station, index) => {
          if (!input.justPressed(`station${index + 1}`)) return;
          world.stage(station);
          // Look the way the station faces the player, so a scenario's keys mean the same thing.
          const car = world.player.mode === "driving" ? world.player.car : undefined;
          rig.yaw = car?.yaw ?? world.player.figure.rotation.y + Math.PI;
        });
      const touch = touchControls?.update(input.raw.pointers, frameCtx.viewport.size);
      move.copy(input.vector("move"));
      if (touch !== undefined) move.add(touch.move).clampLength(0, 1);
      look.copy(input.vector("look"));
      const player = world.player;
      const driving = player.mode === "driving";
      world.update(
        dt,
        {
          aim: input.pressed("aim"),
          enterPressed: input.justPressed("enter") || touch?.jumpPressed === true,
          fire: !driving && input.pressed("fire"),
          firePressed: !driving && input.justPressed("fire"),
          handbrake: driving && input.pressed("handbrake"),
          move,
          sprint: input.pressed("sprint"),
          weaponPressed: input.justPressed("weapon"),
        },
        rig.yaw,
      );
      city.dropoffPad.visible = world.job.state === "deliver";
      city.phoneMarker.visible = world.job.state === "idle";
      city.respraySign.visible = world.wanted.stars > 0;

      const car = player.car;
      patch.phase = world.phase;
      patch.banner = world.banner;
      patch.prompt = world.prompt;
      patch.money = world.money;
      patch.health = Math.round(player.health);
      patch.stars = world.wanted.stars;
      patch.starsFlashing = world.wanted.flashing;
      patch.chaos = Math.round(world.wanted.chaos);
      patch.mode = player.mode;
      patch.weapon = player.weapon;
      patch.ammo = player.ammo;
      patch.clip = player.clip;
      patch.speedKmh =
        player.mode === "driving" && car !== undefined ? Math.round(Math.abs(car.speed) * 3.6) : 0;
      patch.carHealth =
        player.mode === "driving" && car !== undefined ? Math.round(car.health / 10) : 0;
      patch.job = world.job.state;
      patch.jobTime = Math.ceil(world.job.time);
      patch.jobsDone = world.job.done;
      patch.carjacks = world.counts.carjacks;
      patch.crimes = world.wanted.crimes;
      patch.evasions = world.counts.evasions;
      patch.resprays = world.counts.resprays;
      patch.wasted = world.counts.wasted;
      patch.busted = world.counts.busted;
      patch.pedsDown = world.counts.pedsDown;
      patch.pickups = world.counts.pickups;
      patch.copsOnFoot = world.people.filter((ped) => ped.cop && ped.alive).length;
      patch.policeCars = world.police.length;
      patch.trafficBlocked = world.traffic.filter((driver) => driver.blocked).length;
      patch.playerX = Math.round(player.where.x * 10) / 10;
      patch.playerZ = Math.round(player.where.z * 10) / 10;
      patch.cameraYaw = Math.round(rig.yaw * 100) / 100;
      // The reticle, on foot only: the locked target's chest, or where a free shot goes (the
      // muzzle's horizontal line, 20 m out), projected into the view.
      const aiming = player.aiming && player.mode === "foot" && world.phase === "playing";
      const target = aiming ? player.target : undefined;
      patch.aiming = aiming;
      patch.locked = target !== undefined;
      if (target !== undefined) reticle.copy(target.position).setY(target.position.y + 0.4);
      else player.muzzle(reticle).addScaledVector(player.facing(aimAhead), 20);
      reticle.project(camera);
      // Behind the lens or off screen: no ring rather than a mirrored one.
      const onScreen =
        aiming && reticle.z < 1 && Math.abs(reticle.x) <= 1 && Math.abs(reticle.y) <= 1;
      patch.reticleX = onScreen ? Math.round((reticle.x + 1) * 50) : -1;
      patch.reticleY = onScreen ? Math.round((1 - reticle.y) * 50) : -1;
      if (tick % RADAR_EVERY === 0) patch.blips = world.blips();
      // biome-ignore lint/performance/noDelete: an absent key leaves the published blips as they are.
      else delete patch.blips;
      tick += 1;
      frameCtx.state.set(patch);
    };
  }

  override exit(): void {
    this.#materialLighting?.dispose();
    this.#materialLighting = undefined;
    this.#post?.dispose();
    this.#post = undefined;
  }
}
