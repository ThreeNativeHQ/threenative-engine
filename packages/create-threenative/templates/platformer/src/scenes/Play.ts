import {
  InstancedBatch,
  Scene,
  type SceneFrame,
  afterPhysics,
  getPlatform,
  isMobile,
  isTouchscreenAvailable,
  mergeByMaterial,
} from "@threenative/core";
import { type IPhysicsContext, buildStaticColliders } from "@threenative/physics";
import {
  type Group,
  Mesh,
  type Object3D,
  type PerspectiveCamera,
  SphereGeometry,
  type Texture,
  Vector3,
} from "three";
import { FOX_FEEL, Fox, type GameCtx } from "../entities/Fox.js";
import { Pickup } from "../entities/Pickup.js";
import { Walker, type WalkerKind } from "../entities/Walker.js";
import { Checkpoints } from "../level/Checkpoints.js";
import { STAGE_SPAWN, buildStage, makeRng } from "../level/Stage.js";
import { emitPlaytestEvent } from "../playtest-events.js";
import { type LensObstruction, followCamera, setupCamera } from "../render/camera.js";
import { type IEnvironmentSample, sampleEnvironment } from "../render/environmentSampling.js";
import { setupLighting } from "../render/lighting.js";
import { createLoadingScreen } from "../render/loading.js";
import { createMaterialLighting } from "../render/materialLighting.js";
import { flat } from "../render/materials.js";
import { C } from "../render/palette.js";
import { burst, coinArc } from "../render/pickups.js";
import { setupPost } from "../render/postprocessing.js";
import {
  type QualityTier,
  isWebGLFallbackRenderer,
  materialLightingEnabled,
} from "../render/quality.js";
import { cloudLobes, setupSky, skyFloor, skyTexture } from "../render/sky.js";
import { skyEnvironment } from "../render/skyEnvironment.js";
import { TouchControls } from "../render/touch-controls.js";
import type { GameState } from "../state.js";

export type { GameCtx };

/** Where the five gems sit along the route, and how many there are to find. */
const GEMS: readonly (readonly [number, number, number])[] = [
  [16, 1.5, -1.5],
  [37.5, 3, 0],
  [50.5, 6.6, -1.4],
  [66, 4.5, 2.2],
  [90, 4.5, -2],
];

/** Three big stars, well above the ground, so they are a target and not litter. */
const STARS: readonly (readonly [number, number, number])[] = [
  [24, 6, 2.6],
  [55, 9, 1],
  [94.5, 5, 0],
];

/**
 * The five walkers on the route: kind, x, y, z, and the two x values they turn around at.
 * Built in `load()` so a scenario can place one, and frozen on placement so the stomp lands on
 * the same target every run.
 */
const WALKERS: readonly (readonly [WalkerKind, number, number, number, number, number, number])[] =
  [
    ["snail", 22, 0, 2.4, 18, 28, 1.2],
    ["mushroom", 37, 1.5, 0, 34.8, 40.2, 2.4],
    ["mushroom", 63, 3, -1.5, 60, 68, 2.6],
    ["mushroom", 71, 3, 1.8, 67, 73.5, 2.2],
    ["snail", 87, 3, 2.6, 83.5, 92, 1.1],
  ];

/** The stomp window: falling onto a walker from above, in metres. */
const STOMP = { drop: -1, rise: 0.45, below: -1.1, above: 1.5, near: 0.95 } as const;

export class Play extends Scene<GameState, IPhysicsContext> {
  static override readonly initialState: GameState = {
    checkpoint: 0,
    coins: 0,
    coyoteJumps: 0,
    dashes: 0,
    defeated: 0,
    finished: false,
    gemTotal: GEMS.length,
    gems: 0,
    hearts: 3,
    jumps: 0,
    paused: false,
    peakRise: 0,
    playerX: -5,
    grounded: false,
    respawns: 0,
    stars: 0,
    time: 0,
    toast: "",
    topSpeed: 0,
    uiReady: false,
  };

  #sky: Texture | undefined;
  #skyEnvironment: Texture | undefined;
  #walkers: Walker[] = [];
  #fox: Fox | undefined;

  /**
   * The sky gradient and the walkers are both built here, and the walkers are registered here
   * too — a scenario's `setup.place` is applied between `load()` and `enter()`, so an entity that
   * only appears in `enter()` cannot be placed. That is what makes a stomp reproducible: the
   * walker is where the scenario put it, not where boot time left it.
   */
  #post: ReturnType<typeof setupPost> | undefined;
  #environmentSample: IEnvironmentSample | undefined;
  #materialLighting: ReturnType<typeof createMaterialLighting> | undefined;

  override async load(ctx: GameCtx): Promise<void> {
    // Registered before the first `await`, because that is the whole window a scenario's
    // `setup.place` has to find them in: the bridge applies setup between `load()` starting and
    // `enter()` running, and anything after an await is too late. The fox too, so a scenario can
    // start it anywhere on the route (`setup.spawn` or `setup.place` on `player`).
    this.#fox = ctx.entities.add("player", new Fox(ctx, STAGE_SPAWN.clone()));
    for (const [kind, x, y, z, from, to, speed] of WALKERS) {
      const walker = new Walker(kind, x, { from, speed, to, y, z });
      ctx.add(walker.mesh);
      ctx.entities.add(`walker.${this.#walkers.length}`, walker);
      this.#walkers.push(walker);
    }
    this.#sky = skyTexture();
    this.#skyEnvironment = skyEnvironment();
    setupSky(ctx.scene, this.#sky, this.#skyEnvironment);
    this.#environmentSample = await sampleEnvironment(ctx.renderer.raw, ctx.scene, {
      web: getPlatform().runtime === "web",
      rendererKind: ctx.renderer.kind,
      webglFallback: isWebGLFallbackRenderer(ctx.renderer.raw),
      mobile: isMobile(),
      software: ctx.renderer.softwareAdapter !== undefined,
    });
  }

  override enter(ctx: GameCtx): SceneFrame<GameState, IPhysicsContext> {
    const stage = buildStage(makeRng(90210));
    // The whole route goes in as one root, and the predicate is the game's: `userData.solid` is
    // set on exactly the walkable meshes in `level/Stage.ts`, so the engine builds a fixed trimesh
    // body for those and leaves several thousand decorative meshes out of collision entirely.
    ctx.add(stage.group);
    buildStaticColliders(ctx, stage.group, {
      predicate: (object) => object.userData.solid === true,
    });
    collapseStage(stage.group);
    if (this.#sky === undefined || this.#skyEnvironment === undefined)
      throw new Error("Play.enter ran before load() created the sky texture.");
    setupSky(ctx.scene, this.#sky, this.#skyEnvironment);
    ctx.scene.add(skyFloor());
    const lighting = setupLighting(
      ctx.scene,
      ctx.renderer.raw as Parameters<typeof setupLighting>[1],
      isMobile(),
    );
    // isMobile() arrives as an argument because src/render/ imports no framework package: the
    // platform decision is made here, in portable game code.
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
    const camera = ctx.camera as PerspectiveCamera;
    setupCamera(camera);
    const loading = createLoadingScreen(ctx);
    ctx.add(camera);
    const touchControls =
      isMobile() && isTouchscreenAvailable()
        ? ctx.entities.add("touch-controls", new TouchControls(camera))
        : undefined;
    // 130 cloud lobes as one draw. The layout is `src/render/sky.js`'s; the batching is the
    // scene's, because the render layer is ordinary Three.js and never reaches into the framework.
    const clouds = new InstancedBatch({
      geometry: new SphereGeometry(1, 8, 6),
      material: flat(C.cloud, { fog: false }),
    });
    for (const lobe of cloudLobes(makeRng(4242))) clouds.place(lobe);
    clouds.build({ name: "clouds", parent: ctx.scene });

    // ------------------------------------------------------------------ actors
    const fox = this.#fox;
    if (fox === undefined) throw new Error("Play.enter ran before load() created the fox.");
    const checkpoints = new Checkpoints(stage.checkpoints, 3);
    const pickups: Pickup[] = [];
    const effects: ((dt: number) => boolean)[] = [];
    const spawnBurst = (position: Vector3, color: number, count: number): void => {
      effects.push(burst(ctx.scene, position, color, count));
    };
    const addPickup = (kind: "coin" | "gem" | "star", x: number, y: number, z = 0): Pickup => {
      const pickup = new Pickup(kind, x, y, z);
      ctx.add(pickup.mesh);
      pickups.push(pickup);
      return pickup;
    };

    // The coin lines are the route's teaching: one along the floor, one arced over every jump.
    // The opening nine weave, but inside the reach a straight run actually collects: a coin the
    // player can see and cannot take is worse than no coin at all.
    for (let i = 0; i < 9; i += 1) addPickup("coin", -5 + i * 1.6, 1.25, Math.sin(i * 0.9) * 0.6);
    for (let i = 0; i < 8; i += 1) addPickup("coin", 12 + i * 2, 1.25, i % 2 ? 1.6 : -1.4);
    for (const point of coinArc([30, 1.3, 0], [34, 2.8, 0], 6, 1.6))
      addPickup("coin", point.x, point.y, point.z);
    for (const point of coinArc([41, 3, 0], [45.5, 4.4, 1.2], 4, 1.2))
      addPickup("coin", point.x, point.y, point.z);
    for (const [x, y, z] of [
      [45.5, 4.6, 1.2],
      [48, 5.6, 0],
      [50.5, 6.2, -1.4],
      [52.8, 7, 0],
      [55, 7.6, 1],
    ] as const)
      addPickup("coin", x, y, z);
    for (let i = 0; i < 10; i += 1)
      addPickup("coin", 60 + i * 1.4, 4.25, -0.4 + Math.sin(i * 0.7) * 1.8);
    for (let i = 0; i < 6; i += 1)
      addPickup("coin", 75 + i * 1.3, 4.4 + Math.sin(i * 0.8) * 0.5, 0);
    for (let i = 0; i < 5; i += 1) addPickup("coin", 84 + i * 1.5, 4.25, i % 2 ? 1.5 : -1.5);
    for (const [x, y, z] of GEMS) addPickup("gem", x, y, z);
    for (const [x, y, z] of STARS) addPickup("star", x, y, z);

    const walkers = this.#walkers;

    // ------------------------------------------------------------------- state
    let coins = 0;
    let gems = 0;
    let stars = 0;
    let defeated = 0;
    let elapsed = 0;
    // The world's clock: the run clock (`elapsed`, the HUD's time) stops at the flag, but the
    // flag's sway, the walkers' hop, the pickups' spin, the blink and the toasts keep running.
    let clock = 0;
    let toastUntil = 0;
    let finished = false;
    const state = ctx.state.getState();
    // Where load() or a scenario's setup left the fox; a `goto` keeps the run's last x.
    const spawn = fox.mesh.position.clone();
    if (Number.isFinite(state.playerX) && state.playerX !== Play.initialState.playerX)
      spawn.x = state.playerX;
    fox.teleport(spawn);
    const toast = (text: string, seconds = 1.6): void => {
      ctx.state.set({ toast: text });
      toastUntil = clock + seconds;
    };
    const statePatch: Partial<GameState> = {};

    // The camera and the sun both read the solved body, so they run in `afterPhysics` where the
    // physics step has already moved it and this frame has not drawn yet.
    const lensObstruction: LensObstruction = (origin, direction, far) =>
      ctx.raycast({ direction, far, origin, targets: stage.group })?.distance;
    afterPhysics(ctx, (dt) => {
      followCamera(camera, fox.mesh.position, fox.body.velocity.x, dt, lensObstruction);
      lighting.follow(fox.mesh.position);
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
      fox.update(
        frameCtx,
        dt,
        touchControls?.update(frameCtx.input.raw.pointers, frameCtx.viewport.size),
      );
      checkpoints.update(dt);
      fox.setVisible(checkpoints.blinks(clock));
      for (const walker of walkers) walker.update(dt, clock);

      for (const pickup of pickups) {
        pickup.update(dt, clock);
        if (pickup.taken) continue;
        if (pickup.mesh.position.distanceToSquared(fox.centre) >= pickup.reach ** 2) continue;
        pickup.take();
        spawnBurst(pickup.mesh.position, pickup.burstColor, pickup.kind === "coin" ? 8 : 16);
        emitPlaytestEvent({ entity: "player", name: "collected" });
        if (pickup.kind === "coin") coins += 1;
        else if (pickup.kind === "gem") {
          gems += 1;
          toast(`GEM ${gems}/${GEMS.length}`);
        } else {
          stars += 1;
          toast("STAR!", 2.4);
        }
      }

      for (const walker of walkers) {
        if (!walker.alive) continue;
        const dx = Math.abs(walker.mesh.position.x - fox.mesh.position.x);
        const dz = Math.abs(walker.mesh.position.z - fox.mesh.position.z);
        const dy = fox.mesh.position.y - walker.y;
        if (dx >= STOMP.near || dz >= STOMP.near || dy >= STOMP.above || dy <= STOMP.below)
          continue;
        if (fox.body.velocity.y < STOMP.drop && dy > STOMP.rise) {
          walker.kill();
          fox.bounce();
          defeated += 1;
          spawnBurst(
            new Vector3(walker.mesh.position.x, walker.y + 0.6, walker.mesh.position.z),
            walker.burstColor,
            14,
          );
          emitPlaytestEvent({ entity: "player", name: "stomped" });
          toast("NICE!", 0.9);
        } else if (checkpoints.hurt(fox, walker.mesh.position.x)) toast("OUCH!");
      }

      checkpoints.pass(fox.mesh.position);
      if (fox.mesh.position.y < FOX_FEEL.killPlane) {
        checkpoints.respawn(fox);
        emitPlaytestEvent({ entity: "player", name: "respawned" });
      }
      if (checkpoints.hearts <= 0) {
        checkpoints.restore();
        checkpoints.respawn(fox);
        toast("OUT OF HEARTS", 2.4);
      }
      if (!finished && fox.mesh.position.x > stage.goalX - 0.8) {
        finished = true;
        emitPlaytestEvent({ entity: "game", name: "won" });
        toast("LEVEL CLEAR!", 6);
      }
      if (!finished) elapsed += dt;
      clock += dt;
      if (toastUntil !== 0 && clock > toastUntil) {
        toastUntil = 0;
        frameCtx.state.set({ toast: "" });
      }
      stage.update(dt, clock);
      for (let i = effects.length - 1; i >= 0; i -= 1) {
        const effect = effects[i];
        if (effect?.(dt) === true) effects.splice(i, 1);
      }

      const previous = frameCtx.state.getState();
      statePatch.checkpoint = checkpoints.currentIndex;
      statePatch.coins = coins;
      statePatch.coyoteJumps = fox.coyoteJumps;
      statePatch.dashes = fox.dashes;
      statePatch.defeated = defeated;
      statePatch.finished = finished;
      statePatch.gems = gems;
      statePatch.hearts = checkpoints.hearts;
      statePatch.jumps = fox.jumps;
      statePatch.peakRise = Math.max(previous.peakRise, fox.mesh.position.y - fox.groundY - 0.74);
      statePatch.playerX = fox.mesh.position.x;
      statePatch.grounded = fox.body.grounded;
      statePatch.respawns = checkpoints.respawns;
      statePatch.stars = stars;
      statePatch.time = elapsed;
      statePatch.topSpeed = Math.max(
        previous.topSpeed,
        Math.hypot(fox.body.velocity.x, fox.body.velocity.z),
      );
      frameCtx.state.set(statePatch);
    };
  }

  override exit(ctx: GameCtx): void {
    this.#materialLighting?.dispose();
    this.#materialLighting = undefined;
    this.#post?.dispose();
    this.#post = undefined;
    this.#environmentSample = undefined;
    super.exit(ctx);
  }
}

/**
 * Two thousand small meshes is two thousand draw calls, and the route is authored out of
 * primitives, which is exactly the shape `mergeByMaterial` exists for: the static scenery is baked
 * into one mesh per material, with the transforms already in the vertices.
 *
 * Three kinds of mesh stay out. The walkable ones, because `buildStaticColliders` needs them as
 * trimesh sources and a baked buffer is no longer the surface the player stands on. The ones under
 * a `userData.moving` subtree, because baking a transform that changes next frame freezes it. And
 * the `userData.faceted` polyhedra, which carry no uv and would leave their bucket with
 * mismatched attributes.
 */
function collapseStage(root: Group): void {
  const keep = (object: Object3D): boolean => {
    for (let node = object; node !== root; node = node.parent as Object3D) {
      if (node === undefined || node.userData.moving === true) return true;
    }
    return object.userData.solid === true || object.userData.faceted === true;
  };
  const sources = new Set<Mesh>();
  root.traverse((object) => {
    if (object instanceof Mesh && !keep(object)) sources.add(object);
  });
  if (sources.size === 0) return;
  const merged = mergeByMaterial(root, { label: "stage", skip: (mesh) => !sources.has(mesh) });
  for (const mesh of merged) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
  }
  for (const source of sources) source.removeFromParent();
  console.info(
    `TN_STAGE_COLLAPSE:${JSON.stringify({ merged: merged.length, from: sources.size })}`,
  );
}
