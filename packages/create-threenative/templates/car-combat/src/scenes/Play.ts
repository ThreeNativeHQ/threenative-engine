import {
  Scene,
  type SceneFrame,
  afterPhysics,
  getPlatform,
  isMobile,
  markStatic,
  mergeByMaterial,
} from "@threenative/core";
import { PLAYTEST_RUNNER_EXPECTED_GLOBAL } from "@threenative/core/playtest";
import { type IEnvironmentSample, sampleEnvironment } from "@threenative/core/render/environment";
import { CollisionShape3D, type IPhysicsContext, RigidBody3D } from "@threenative/physics";
import type { Mesh, PerspectiveCamera, Vector3 } from "three";
import { FLOOR } from "../arena/layout.js";
import { CAR_LAYER, type GameCtx, WORLD_LAYER } from "../entities/layers.js";
import { buildArena } from "../render/arena.js";
import { ChaseCamera } from "../render/camera.js";
import { cloudTextures, primeCloudTextures } from "../render/clouds.js";
import { setupLighting } from "../render/lighting.js";
import { createLoadingScreen } from "../render/loading.js";
import { createMaterialLighting } from "../render/materialLighting.js";
import { floorMaterial, laneMarkMaterial, roadMaterial } from "../render/materials.js";
import { setupPost } from "../render/postprocessing.js";
import { isWebGLFallbackRenderer, materialLightingEnabled } from "../render/quality.js";
import { SUN_DIRECTION, setupSky } from "../render/sky.js";
import { type GameState, INITIAL_STATE } from "../state.js";
import { STATIONS } from "../systems/stations.js";
import { World } from "../systems/World.js";

/**
 * True only under the playtest runner (it sets this global before any game code runs). The
 * station keys answer only then; a player pressing them in a real build gets nothing.
 */
const UNDER_PLAYTEST =
  (globalThis as Record<string, unknown>)[PLAYTEST_RUNNER_EXPECTED_GLOBAL] === true;

export class Play extends Scene<GameState, IPhysicsContext> {
  static override readonly initialState: GameState = INITIAL_STATE;

  #environmentSample: IEnvironmentSample | undefined;
  #materialLighting: ReturnType<typeof createMaterialLighting> | undefined;
  #post: ReturnType<typeof setupPost> | undefined;

  override async load(ctx: GameCtx): Promise<void> {
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
    ctx.state.set({ ...INITIAL_STATE });
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
    const rig = new ChaseCamera(camera);
    const loading = createLoadingScreen(ctx);
    ctx.add(camera);

    // What stays built: the floor, the road, the walls, the blocks. One box collider per drawn
    // solid, then the drawing merged to a mesh per material. The gate markers and pads stay live.
    const arena = buildArena();
    for (const solid of arena.solids)
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
      shape: CollisionShape3D.box(FLOOR.x * 2, 1, FLOOR.z * 2),
      type: "fixed",
    });
    const live = new Set<Mesh>([...arena.gateMarkers, ...arena.padMeshes]);
    const merged = mergeByMaterial(arena.root, { label: "arena", skip: (mesh) => live.has(mesh) });
    for (const mesh of merged) {
      // Road paint and the floor cast no shadow anyone sees.
      mesh.castShadow =
        mesh.material !== floorMaterial &&
        mesh.material !== laneMarkMaterial &&
        mesh.material !== roadMaterial &&
        mesh.castShadow;
      mesh.receiveShadow = true;
    }
    arena.root.clear();
    arena.root.add(...merged, ...live);
    ctx.add(arena.root);
    markStatic(arena.root);

    const world = new World(ctx);
    // Walls and cars pull the lens in: a passing car never stands between the camera and the player.
    const probe = (from: Vector3, to: Vector3) =>
      ctx.physics.directSpaceState.intersectRay({
        collisionMask: WORLD_LAYER | CAR_LAYER,
        from,
        to,
      })?.distance;
    ctx.entities.add("camera", { debug: () => ({ yaw: rig.yaw }) });
    rig.snap(world.player.yaw, world.player.position);
    afterPhysics(ctx, (dt) => {
      world.afterStep(dt);
      const player = world.player;
      rig.update(dt, player.position, player.yaw, player.speed, probe);
      // The sun's shadow map follows the player round the arena.
      lighting.key.target.position.copy(player.position);
      lighting.key.position.copy(player.position).addScaledVector(SUN_DIRECTION, 60);
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

    const patch: Partial<GameState> = {};
    return (frameCtx, dt) => {
      loading.update();
      const input = frameCtx.input;
      if (input.justPressed("restart")) {
        void frameCtx.goto("play");
        return;
      }
      if (UNDER_PLAYTEST)
        STATIONS.forEach((station, index) => {
          if (!input.justPressed(`station${index + 1}`)) return;
          station(world);
          rig.snap(world.player.yaw, world.player.position);
        });
      const move = input.vector("move");
      world.update(dt, {
        back: Math.max(0, -move.y),
        fwd: Math.max(0, move.y),
        handbrake: input.pressed("handbrake"),
        steer: move.x,
      });
      const { player, race } = world;
      const parts = player.damage.parts;
      const objectives = world.objectives();
      patch.phase = race.phase;
      patch.banner = race.banner;
      patch.winBy = race.winBy;
      patch.timeLeft = Math.ceil(race.timeLeft);
      patch.lap = Math.min(race.lap, INITIAL_STATE.laps);
      patch.nextGate = race.nextGate;
      patch.gatesPassed = race.gatesPassed;
      patch.bonusTotal = race.bonusTotal;
      patch.bonusFlash = world.bonusFlash;
      patch.speedKmh = Math.round(Math.abs(player.speed) * 3.6);
      patch.rpm = Math.round(player.drivetrain.rpm);
      patch.gear = player.drivetrain.gear;
      patch.slipping = player.slipping.rear || player.slipping.front;
      patch.traction = Math.round(player.tractionScale * 100);
      patch.engine = Math.round(parts.engine);
      patch.transmission = Math.round(parts.transmission);
      patch.driver = Math.round(parts.driver);
      patch.wheels = Math.round(Math.max(parts.wheel0, parts.wheel1, parts.wheel2, parts.wheel3));
      patch.brakes = Math.round(Math.max(parts.brake0, parts.brake1, parts.brake2, parts.brake3));
      patch.crushFront = Math.round(player.damage.crush.front * 100);
      patch.crushRear = Math.round(player.damage.crush.rear * 100);
      patch.crushLeft = Math.round(player.damage.crush.left * 100);
      patch.crushRight = Math.round(player.damage.crush.right * 100);
      patch.health = Math.round(player.damage.health * 100);
      patch.repairing = world.repairing;
      patch.rivalsWrecked = world.rivalsWrecked;
      patch.rivalsTotal = world.rivals.length;
      patch.pursuing = objectives.pursue;
      patch.rammed = world.rammed;
      patch.playerX = Math.round(player.position.x * 10) / 10;
      patch.playerZ = Math.round(player.position.z * 10) / 10;
      patch.cameraYaw = Math.round(rig.yaw * 100) / 100;
      patch.prompt = world.repairing ? "repairing" : player.wrecked ? "wrecked" : "";
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
