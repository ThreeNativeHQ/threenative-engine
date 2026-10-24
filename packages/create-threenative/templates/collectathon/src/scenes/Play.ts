import {
  GPUParticles3D,
  Scene,
  type SceneFrame,
  afterPhysics,
  isMobile,
  isTouchscreenAvailable,
} from "@threenative/core";
import {
  CollisionShape3D,
  type IPhysicsContext,
  RigidBody3D,
  buildStaticColliders,
} from "@threenative/physics";
import { type DataTexture, Euler, type PerspectiveCamera, Vector3 } from "three";
import { FOOT_OFFSET, type GameCtx, HERO_FEEL, Hero, WORLD_LAYER } from "../entities/Hero.js";
import { Pickup } from "../entities/Pickup.js";
import { Walker, type WalkerKind } from "../entities/Walker.js";
import { type ICourse, COURSE, buildCourse, makeRng } from "../level/Course.js";
import { emitPlaytestEvent } from "../playtest-events.js";
import { type WallProbe, createOrbitCamera } from "../render/camera.js";
import { BURSTS, EFFECTS } from "../render/effects.js";
import { setupLighting } from "../render/lighting.js";
import { createLoadingScreen } from "../render/loading.js";
import { setupPost } from "../render/postprocessing.js";
import { setupSky, skyTexture } from "../render/sky.js";
import { TouchControls } from "../render/touch-controls.js";
import type { GameState } from "../state.js";

export type { GameCtx };

const WEDGES = 8;
const JUMPS: ReadonlySet<string> = new Set([
  "single",
  "double",
  "triple",
  "backflip",
  "sideflip",
  "longJump",
]);
/** Run puffs start above this ground speed (m/s): a slow walk raises no dust. */
const DUST_SPEED = 5;
/** The hero's capsule radius plus a walker's, for a touch, and how far a ground pound reaches. */
const HIT = { touch: Walker.radius + 0.35, pound: 2.5, stompDrop: -1 } as const;

export class Play extends Scene<GameState, IPhysicsContext> {
  static override readonly initialState: GameState = {
    action: "idle",
    checkpoint: 0,
    coins: 0,
    defeated: 0,
    gemTotal: 8,
    gems: 0,
    grounded: false,
    landings: 0,
    paused: false,
    respawns: 0,
    seedTotal: 3,
    seeds: 0,
    toast: "",
    uiReady: false,
    wallHits: 0,
    wedges: WEDGES,
  };

  #sky: DataTexture | undefined;
  #fill: DataTexture | undefined;
  #course: ICourse | undefined;
  #hero: Hero | undefined;
  #pickups: Pickup[] = [];
  #walkers: Walker[] = [];
  #post: ReturnType<typeof setupPost> | undefined;

  /**
   * Everything a scenario can place is built and registered here: `setup.place` is applied after
   * `load()` and before `enter()`, so an entity that first appears in `enter()` cannot be placed.
   * `enter()` then re-reads every placed transform.
   */
  override load(ctx: GameCtx): void {
    this.#sky = skyTexture();
    this.#fill = skyTexture(0.5, 128);
    setupSky(ctx.scene, this.#sky, this.#fill);
    const course = buildCourse(makeRng(6402));
    this.#course = course;
    ctx.add(course.group);
    const hit = { normal: new Vector3(), position: new Vector3() };
    this.#hero = ctx.entities.add(
      "player",
      new Hero(ctx, course.spawn, (from, to) => {
        const found = ctx.physics.directSpaceState.intersectRay({
          collisionMask: WORLD_LAYER,
          from,
          to,
        });
        if (found === undefined) return undefined;
        hit.position.set(found.position.x, found.position.y, found.position.z);
        hit.normal.set(found.normal.x, found.normal.y, found.normal.z);
        return hit;
      }),
    );
    const add = (name: string, pickup: Pickup): void => {
      ctx.add(pickup.mesh);
      ctx.entities.add(name, pickup);
      this.#pickups.push(pickup);
    };
    course.coins.forEach((at, i) => add(`coin.${i}`, new Pickup("coin", at)));
    course.gems.forEach((at, i) => add(`gem.${i}`, new Pickup("gem", at)));
    for (const [name, at] of Object.entries(course.seeds))
      add(`seed.${name}`, new Pickup("seed", at, name));
    // Bumblets keep the `walker.<i>` names the scenarios place; the others are `hopper.<i>`, `thornback.<i>`.
    for (const [kind, homes] of Object.entries(course.walkers) as [
      WalkerKind,
      ICourse["walkers"][WalkerKind],
    ][]) {
      homes.forEach((at, i) => {
        const walker = new Walker(kind, at, i * 1.7);
        ctx.add(walker.mesh);
        ctx.entities.add(`${kind === "bumblet" ? "walker" : kind}.${i}`, walker);
        this.#walkers.push(walker);
      });
    }
  }

  override enter(ctx: GameCtx): SceneFrame<GameState, IPhysicsContext> {
    const course = this.#course;
    const hero = this.#hero;
    if (course === undefined || hero === undefined || this.#sky === undefined)
      throw new Error("Play.enter ran before load() built the course.");
    // `userData.solid` marks exactly the walkable meshes in `level/Course.ts`. The shaft's walls
    // reach 16 m, so the default 4.5 m reachable ceiling is raised to keep their tops solid.
    buildStaticColliders(ctx, course.group, {
      collisionLayer: WORLD_LAYER,
      predicate: (object) => object.userData.solid === true,
      reachableCeiling: 40,
    });
    // A kinematic body follows its mesh; the engine carries a character standing on it.
    new RigidBody3D({
      collisionLayer: WORLD_LAYER,
      object: course.platform,
      physics: ctx.physics,
      shape: CollisionShape3D.box(...COURSE.platform.size),
      type: "kinematic",
    });
    setupSky(ctx.scene, this.#sky, this.#fill);
    const lighting = setupLighting(
      ctx.scene,
      ctx.renderer.raw as Parameters<typeof setupLighting>[1],
      isMobile(),
    );
    this.#post = setupPost(ctx.renderer, ctx.scene, ctx.camera, {
      godraysLight: lighting.key,
      gpuClass: ctx.renderer.gpuClass?.class,
      mobile: isMobile(),
      software: ctx.renderer.softwareAdapter !== undefined,
    });
    const camera = ctx.camera as PerspectiveCamera;
    ctx.add(camera);
    const loading = createLoadingScreen(ctx);
    const touchControls =
      isMobile() && isTouchscreenAvailable()
        ? ctx.entities.add("touch-controls", new TouchControls(camera))
        : undefined;

    // A scenario may have moved the hero and turned it: read both back, then stand it there.
    const start = hero.mesh.position.clone();
    const startYaw = new Euler().setFromQuaternion(hero.mesh.quaternion, "YXZ").y;
    hero.teleport(start, startYaw);
    for (const pickup of this.#pickups) pickup.settle();
    for (const walker of this.#walkers) walker.settle();

    const along = new Vector3();
    const probe: WallProbe = (from, to) => {
      const length = along.subVectors(to, from).length();
      if (length < 1e-4) return undefined;
      return ctx.physics.directSpaceState.intersectRay({ collisionMask: WORLD_LAYER, from, to })
        ?.distance;
    };
    const orbit = createOrbitCamera(camera);
    orbit.snap(hero.mesh.position, hero.yaw, probe);
    // Whether the camera sees the hero: a ray from the lens to the hero's waist hits no wall.
    let rayClear = true;
    ctx.entities.add("camera-rig", {
      debug: () => ({ ...orbit.debug(), rayClear }),
    });
    afterPhysics(ctx, (dt) => {
      orbit.update(hero.mesh.position, hero.body.velocity, dt, probe);
      rayClear = probe(camera.position, hero.mesh.position) === undefined;
      lighting.follow(hero.mesh.position);
    });

    // Effects: four pooled emitters, every look parameter in `render/effects.ts`.
    const make = (name: keyof typeof EFFECTS): GPUParticles3D => {
      const emitter = ctx.add(new GPUParticles3D(EFFECTS[name]()));
      emitter.name = `effects-${name}`;
      return emitter;
    };
    const emitters = {
      dust: make("dust"),
      flash: make("flash"),
      pollen: make("pollen"),
      sparkle: make("sparkle"),
    };
    const fired: Record<string, number> = Object.fromEntries(
      Object.keys(BURSTS).map((kind) => [kind, 0]),
    );
    const burst = (kind: keyof typeof BURSTS, x: number, y: number, z: number): void => {
      const { count, emitter, shape } = BURSTS[kind];
      emitters[emitter].emitParticle({
        count,
        direction: { x: shape[0], y: shape[1], z: shape[2] },
        origin: { x, y, z },
      });
      fired[kind] = (fired[kind] ?? 0) + 1;
    };
    ctx.entities.add("effects", {
      debug: () => ({
        dust: emitters.dust.stats.spawned,
        fired: { ...fired },
        flash: emitters.flash.stats.spawned,
        pollen: emitters.pollen.stats.spawned,
        sparkle: emitters.sparkle.stats.spawned,
      }),
    });
    let previous = hero.action;
    let wasGrounded = hero.grounded;
    let dustClock = 0;
    let airTicks = 0;

    let coins = 0;
    let gems = 0;
    let seeds = 0;
    let defeated = 0;
    let wedges = WEDGES;
    let checkpoint = 0;
    let respawns = 0;
    let elapsed = 0;
    let toastUntil = 0;
    const toast = (text: string, seconds = 1.6): void => {
      ctx.state.set({ toast: text });
      toastUntil = elapsed + seconds;
    };
    const respawn = (): void => {
      const point = course.checkpoints[checkpoint] ?? course.spawn;
      hero.teleport(new Vector3(point.x, point.y + FOOT_OFFSET + 0.05, point.z), hero.yaw);
      respawns += 1;
      emitPlaytestEvent({ entity: "player", name: "respawned" });
    };
    const defeat = (walker: Walker, how: string): void => {
      const w = walker.mesh.position;
      burst("poof", w.x, w.y + 0.4, w.z);
      walker.kill();
      defeated += 1;
      emitPlaytestEvent({ entity: "player", name: how });
    };
    const statePatch: Partial<GameState> = {};

    return (frameCtx, dt) => {
      loading.update();
      elapsed += dt;
      course.platformAt(elapsed, course.platform.position);
      hero.update(
        frameCtx,
        dt,
        orbit.yaw,
        touchControls?.update(frameCtx.input.raw.pointers, frameCtx.viewport.size),
      );
      const at = hero.mesh.position;
      const feet = at.y - FOOT_OFFSET;
      const fx = -Math.sin(hero.yaw);
      const fz = -Math.cos(hero.yaw);
      const action = hero.action;
      if (action !== previous) {
        if (!wasGrounded && hero.grounded) {
          if (action === "poundLand") {
            burst("pound", at.x, feet + 0.05, at.z);
            burst("poundRing", at.x, feet + 0.1, at.z);
            burst("debris", at.x, feet + 0.1, at.z);
          } else burst("landing", at.x, feet + 0.05, at.z);
        } else if (wasGrounded && JUMPS.has(action)) burst("takeoff", at.x, feet + 0.05, at.z);
        if (action === "skid") burst("skid", at.x + fx * 0.3, feet + 0.05, at.z + fz * 0.3);
        // A wall kick faces away from the wall, so the contact is behind the hero.
        if (action === "wallKick")
          burst("wallKick", at.x - fx * 0.45, at.y + 0.2, at.z - fz * 0.45);
        if (action === "ledgeHang") burst("ledge", at.x + fx * 0.45, feet + 1.3, at.z + fz * 0.45);
        previous = action;
        airTicks = 0;
      }
      wasGrounded = hero.grounded;
      airTicks += 1;
      if (action === "run" && hero.speed > DUST_SPEED) {
        dustClock += dt * (hero.speed / 9.6);
        if (dustClock > 0.06) {
          dustClock = 0;
          burst("run", at.x - fx * 0.3, feet + 0.05, at.z - fz * 0.3);
        }
      }
      if (action === "triple" && airTicks % 2 === 0) burst("trail", at.x, at.y, at.z);
      if (action === "longJump") burst("streak", at.x, at.y, at.z);
      // Pollen drifts in round the hero, a few motes every 0.15 s, so the air is never empty.
      if (elapsed % 0.15 < dt) burst("pollen", at.x, feet + 0.4, at.z);

      this.#pickups.forEach((pickup, i) => {
        // A red gem glints every 1.4 s, staggered so the eight never flash together.
        const p = pickup.mesh.position;
        if (pickup.kind === "gem" && !pickup.taken && (elapsed + i * 0.37) % 1.4 < dt)
          burst("glint", p.x, p.y, p.z);
      });
      for (const pickup of this.#pickups) {
        pickup.update(dt, elapsed);
        if (pickup.taken || pickup.mesh.position.distanceToSquared(at) >= pickup.reach ** 2)
          continue;
        const p = pickup.mesh.position;
        burst(pickup.kind, p.x, p.y, p.z);
        pickup.take();
        emitPlaytestEvent({ entity: "player", name: "collected" });
        if (pickup.kind === "coin") {
          coins += 1;
          wedges = Math.min(WEDGES, wedges + 1);
        } else if (pickup.kind === "gem") {
          gems += 1;
          toast(`RED GEM ${gems}/8`);
          if (gems === 8) {
            seeds += 1;
            toast("SUNSEED!", 2.4);
          }
        } else {
          seeds += 1;
          toast("SUNSEED!", 2.4);
        }
      }

      for (const walker of this.#walkers) {
        walker.update(dt, elapsed, at);
        if (!walker.alive) continue;
        const w = walker.mesh.position;
        const reach = Math.hypot(w.x - at.x, w.z - at.z);
        const dy = feet - w.y;
        if (hero.action === "poundLand" && reach < HIT.pound && Math.abs(dy) < 1) {
          defeat(walker, "pounded");
          continue;
        }
        if (reach >= HIT.touch || dy <= -0.5 || dy >= Walker.height) continue;
        const stomp = hero.body.velocity.y < HIT.stompDrop && dy > Walker.height * 0.4;
        if (stomp && walker.stompable) {
          defeat(walker, "stomped");
          hero.bounce();
        } else if (hero.action === "dive" || hero.action === "diveSlide") {
          defeat(walker, "dived");
        } else if (hero.hurtTimer === 0) {
          wedges -= 1;
          hero.knockBack(w);
          // A stomp on a thornback lands on its spikes.
          if (stomp) emitPlaytestEvent({ entity: "player", name: "spiked" });
          emitPlaytestEvent({ entity: "player", name: "hurt" });
          toast(stomp ? "SPIKES!" : "OUCH!", 0.9);
        }
      }

      course.checkpoints.forEach((point, i) => {
        if (Math.hypot(point.x - at.x, point.z - at.z) < 3 && Math.abs(point.y - feet) < 2)
          checkpoint = i;
      });
      if (at.y < HERO_FEEL.killPlane) respawn();
      if (wedges <= 0) {
        wedges = WEDGES;
        respawn();
        toast("OUT OF WEDGES", 2.4);
      }
      if (toastUntil !== 0 && elapsed > toastUntil) {
        toastUntil = 0;
        frameCtx.state.set({ toast: "" });
      }

      statePatch.action = hero.action;
      statePatch.checkpoint = checkpoint;
      statePatch.coins = coins;
      statePatch.defeated = defeated;
      statePatch.gems = gems;
      statePatch.grounded = hero.grounded;
      statePatch.landings = hero.landings;
      statePatch.respawns = respawns;
      statePatch.seeds = seeds;
      statePatch.wallHits = hero.wallHits;
      statePatch.wedges = wedges;
      frameCtx.state.set(statePatch);
    };
  }

  override exit(ctx: GameCtx): void {
    this.#post?.dispose();
    this.#post = undefined;
    this.#pickups = [];
    this.#walkers = [];
    super.exit(ctx);
  }
}
