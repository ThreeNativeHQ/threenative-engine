import {
  GPUParticles3D,
  type ICtx,
  Scene,
  type SceneFrame,
  getPlatform,
  isMobile,
  isTouchscreenAvailable,
} from "@threenative/core";
import type { SnowField } from "@threenative/core/world";
import {
  CollisionShape3D,
  type IPhysicsContext,
  RigidBody3D,
  attachSnowPhysics,
} from "@threenative/physics";
import type { Object3D, PerspectiveCamera } from "three";
import { SnowAudio } from "../audio.js";
import { type Command, commands } from "../commands.js";
import { Explorer, type IFootstep, STANCE } from "../entities/Explorer.js";
import { BOOT_AREA, bootPrint } from "../render/bootPrint.js";
import { OrbitFollow, setupCamera } from "../render/camera.js";
import { setupLighting } from "../render/lighting.js";
import { createLoadingScreen } from "../render/loading.js";
import { createMaterialLighting } from "../render/materialLighting.js";
import { createMaterials } from "../render/materials.js";
import { setupPost } from "../render/postprocessing.js";
import { createBall, createCrate, createLog } from "../render/props.js";
import { isWebGLFallbackRenderer, materialLightingEnabled } from "../render/quality.js";
import { createScenery } from "../render/scenery.js";
import { setupSky } from "../render/sky.js";
import { createSnowSurface } from "../render/snowSurface.js";
import { TouchControls } from "../render/touch-controls.js";
import { createWeather } from "../render/weather.js";
import { type CameraView, type GameState, PROBE_COLUMNS, PROBE_ROWS } from "../state.js";
import {
  EXPLORER_LAYER,
  FIELD_SIZE,
  SNOW_LAYER,
  WALK_LAYER,
  createSnowfield,
  walkSurface,
} from "../terrain.js";

export type GameCtx = ICtx<GameState, IPhysicsContext>;

const BALL_RADIUS = 0.25;
const BALL_MASS = 10;
/** Newton-seconds a push gives the ball: 2.4 m/s on a 10 kg ball, enough to carve on uphill. */
const KICK = 24;
const CRATE = { x: 0.5, y: 0.3, z: 0.4 } as const;
const LOG = { halfHeight: 0.35, radius: 0.14 } as const;
/** Where the explorer walks while auto-explore is on. */
const ROUTE: ReadonlyArray<readonly [number, number]> = [
  [0.5, -5],
  [-4, -8],
  [-7, -3],
  [-5, 4],
  [0, 7],
  [5, 3],
  [3, -2],
];
const VIEWS: readonly CameraView[] = ["follow", "surface", "overhead"];
/** Seconds between snowfall refills; recovery is rate-based, so this only sets the cadence. */
const REFILL_INTERVAL = 0.5;

/** One dynamic body that sits in the snow, with what a playtest needs to read back about it. */
function placeBody(
  ctx: GameCtx,
  snow: SnowField,
  body: RigidBody3D,
  at: { readonly x: number; readonly z: number },
  lift: number,
): void {
  const half = FIELD_SIZE / 2 - 1;
  const x = Math.max(-half, Math.min(half, at.x));
  const z = Math.max(-half, Math.min(half, at.z));
  const y = snow.heightAt(x, z) + lift;
  ctx.physics.simulation.setBodyTransform(body.body.id, { x, y, z });
  body.linearVelocity = { x: 0, y: 0, z: 0 };
}

export class Snow extends Scene<GameState, IPhysicsContext> {
  #materialLighting: ReturnType<typeof createMaterialLighting> | undefined;
  #post: ReturnType<typeof setupPost> | undefined;
  static override readonly initialState: GameState = {
    autoExplore: true,
    ballGap: 0,
    ballLoad: 0,
    ballSink: 0,
    blizzard: false,
    compaction: false,
    contacts: 0,
    depth: 0.28,
    fallSpeed: 0.55,
    hardness: 0.22,
    lastSink: 0,
    muted: true,
    paused: false,
    probe: [],
    recovery: 120,
    snowfall: 0.58,
    speed: 0,
    storm: 0,
    toast: "",
    toastId: 0,
    uiReady: false,
    view: "follow",
    wind: 0.4,
    windNow: 0.4,
  };

  override enter(ctx: GameCtx): SceneFrame<GameState, IPhysicsContext> {
    const initial = ctx.state.getState();
    const mobile = isMobile();
    const stormSky = setupSky(ctx.scene);
    const lights = setupLighting(
      ctx.scene,
      ctx.renderer.raw as Parameters<typeof setupLighting>[1],
    );
    const materialEnvironment = {
      web: getPlatform().runtime === "web",
      rendererKind: ctx.renderer.kind,
      webglFallback: isWebGLFallbackRenderer(ctx.renderer.raw),
      mobile: isMobile(),
      software: ctx.renderer.softwareAdapter !== undefined,
    };
    this.#post = setupPost(ctx.renderer, ctx.scene, ctx.camera, {
      onTierChanged: (tier) =>
        this.#materialLighting?.setEnabled(materialLightingEnabled(tier, materialEnvironment)),
      mobile,
      software: ctx.renderer.softwareAdapter !== undefined,
      gpuClass: ctx.renderer.gpuClass?.class,
    });
    const loading = createLoadingScreen(ctx);
    const camera = ctx.camera as PerspectiveCamera;
    setupCamera(camera);
    ctx.add(camera);
    const orbit = new OrbitFollow();
    const touchControls =
      mobile && isTouchscreenAvailable()
        ? ctx.entities.add("touch-controls", new TouchControls(camera))
        : undefined;

    const materials = createMaterials();
    const snow = createSnowfield(initial.depth, initial.hardness);
    const startDepth = snow.depth;
    const surface = createSnowSurface(snow);
    ctx.add(surface.mesh);
    ctx.add(surface.outskirts);
    const scenery = createScenery(materials, snow.depth);
    ctx.add(scenery.root);

    // Trees and rocks stop the explorer and the ball; the field's edge is a fence nobody sees.
    for (const obstacle of scenery.obstacles) {
      if (Math.abs(obstacle.x) > FIELD_SIZE / 2 + 2 || Math.abs(obstacle.z) > FIELD_SIZE / 2 + 2)
        continue;
      new RigidBody3D({
        physics: ctx.physics,
        position: { x: obstacle.x, y: obstacle.height / 2, z: obstacle.z },
        shape: CollisionShape3D.capsule(
          Math.max(0, obstacle.height / 2 - obstacle.radius),
          obstacle.radius,
        ),
        type: "fixed",
      });
    }
    const half = FIELD_SIZE / 2;
    for (const [x, z, width, depth] of [
      [0, -half - 0.5, FIELD_SIZE + 2, 1],
      [0, half + 0.5, FIELD_SIZE + 2, 1],
      [-half - 0.5, 0, 1, FIELD_SIZE + 2],
      [half + 0.5, 0, 1, FIELD_SIZE + 2],
    ] as const)
      new RigidBody3D({
        physics: ctx.physics,
        position: { x, y: 1, z },
        shape: CollisionShape3D.box(width, 6, depth),
        type: "fixed",
      });

    // The snow binding owns the surface collider and presses solved contacts into the field.
    const snowPhysics = attachSnowPhysics({
      collisionLayer: SNOW_LAYER,
      physics: ctx.physics,
      snow,
    });
    // The explorer walks on a coarse copy of the ground plus fresh snow; only it collides with it.
    const walk = (depth: number) => {
      const field = walkSurface(depth);
      return new RigidBody3D({
        collisionLayer: WALK_LAYER,
        collisionMask: EXPLORER_LAYER,
        physics: ctx.physics,
        position: { x: 0, y: 0, z: 0 },
        shape: CollisionShape3D.heightfield(field.rows, field.columns, field.toColliderHeights(), {
          x: FIELD_SIZE,
          y: 1,
          z: FIELD_SIZE,
        }),
        type: "fixed",
      });
    };
    let walkBody = walk(snow.depth);

    const ballObject = createBall(materials, BALL_RADIUS);
    ballObject.position.set(2.2, snow.heightAt(2.2, -2) + BALL_RADIUS + 0.05, -2);
    const ball = new RigidBody3D({
      mass: BALL_MASS,
      object: ballObject,
      physics: ctx.physics,
      shape: CollisionShape3D.sphere(BALL_RADIUS),
    });
    ctx.add(ballObject);
    const crateObject = createCrate(materials, CRATE);
    crateObject.position.set(-2.6, snow.heightAt(-2.6, -2.4) + CRATE.y / 2 + 0.05, -2.4);
    crateObject.rotation.y = 0.5;
    const crate = new RigidBody3D({
      mass: 25,
      object: crateObject,
      physics: ctx.physics,
      shape: CollisionShape3D.box(CRATE.x, CRATE.y, CRATE.z),
    });
    ctx.add(crateObject);
    const logObject = createLog(materials, LOG.halfHeight, LOG.radius);
    logObject.position.set(-1.6, snow.heightAt(-1.6, 2.8) + LOG.radius + 0.05, 2.8);
    logObject.rotation.set(Math.PI / 2, 0, 0.6);
    const log = new RigidBody3D({
      mass: 20,
      object: logObject,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(LOG.halfHeight, LOG.radius),
    });
    ctx.add(logObject);
    for (const body of [ball, crate, log]) snowPhysics.add(body);

    const weather = createWeather({
      flakes: mobile ? 6_000 : 16_000,
      particles: (options) => new GPUParticles3D(options),
    });
    ctx.add(weather.snowfall);
    for (const burst of weather.bursts) ctx.add(burst);
    const audio = new SnowAudio(camera, (name) => ctx.assets.audio(name));
    ctx.entities.add("audio", audio.bus);

    const recentSteps: IFootstep[] = [];
    let lastStep: IFootstep = {
      angle: Math.PI,
      penetration: 0,
      side: 1,
      speed: 0,
      x: 0,
      y: 0,
      z: 2,
    };
    const explorer = new Explorer(ctx.physics, snow, materials, { x: 0, z: 0 }, (step) => {
      if (step.penetration <= 0) return;
      lastStep = step;
      recentSteps.push(step);
      if (recentSteps.length > 8) recentSteps.shift();
      weather.burst(step, step.penetration);
      audio.footstep(step);
    });
    ctx.add(explorer.model.root);
    // A short arrival trail, so the snow's memory is the first thing on screen.
    for (let index = 0; index < 14; index += 1) {
      const z = 6.4 - index * 0.46;
      const x = 0.35 * Math.sin(z * 0.7) + (index % 2 ? -STANCE : STANCE);
      const angle = Math.PI + Math.cos(z * 0.7) * 0.2;
      const penetration = snow.stamp({
        area: BOOT_AREA,
        footprint: bootPrint,
        load: 80 * 9.81,
        rotation: angle,
        x,
        z,
      });
      lastStep = { angle, penetration, side: index % 2 ? -1 : 1, speed: 0, x, y: 0, z };
    }

    // ---- what a playtest reads back ----
    const telemetry = {
      airborneLoads: 0,
      dropped: false,
      kickedAt: undefined as { x: number; z: number } | undefined,
      path: [] as Array<{ x: number; z: number }>,
      turned: 0,
      /** Ground the ball's centre covered since the kick, step by step. */
      rolled: 0,
      /** Farthest the ball got from where it was kicked. */
      reach: 0,
      lastRotation: { w: 1, x: 0, y: 0, z: 0 },
      lastPosition: { x: 0, y: 0, z: 0 },
      lastClearance: 0,
    };
    // Read the solver's own pose: the drawn ball is synced from it later in the frame, and one
    // step stale is ten centimetres at the speed a dropped ball lands.
    const solvedBall = () =>
      ctx.physics.simulation.readBodyTransform?.(ball.body.id) ?? {
        position: ballObject.position,
        rotation: ballObject.quaternion,
      };
    const ballState = () => {
      const p = solvedBall().position;
      const inside = Math.abs(p.x) < half && Math.abs(p.z) < half;
      const ground = inside ? snow.heightAt(p.x, p.z) : 0;
      // Clearance is the closest the sphere's underside comes to the snow anywhere beneath it,
      // not just under its centre: a ball rolling over the lip of its crater is touching the rim
      // while its centre stands well above the crater floor.
      let clearance = Number.POSITIVE_INFINITY;
      for (const ring of [0, 0.5, 0.85]) {
        for (let step = 0; step < (ring === 0 ? 1 : 8); step += 1) {
          const angle = (step / 8) * Math.PI * 2;
          const x = clampToField(p.x + Math.cos(angle) * ring * BALL_RADIUS);
          const z = clampToField(p.z + Math.sin(angle) * ring * BALL_RADIUS);
          const underside = p.y - Math.sqrt(1 - ring * ring) * BALL_RADIUS;
          clearance = Math.min(clearance, underside - snow.heightAt(x, z));
        }
      }
      return {
        clearance,
        gap: p.y - BALL_RADIUS - ground,
        sink: inside ? snow.sample(p.x, p.z).indent : 0,
      };
    };
    ctx.entities.add("ball", {
      object: ballObject,
      debug: () => {
        const { clearance, gap, sink } = ballState();
        const kick = telemetry.kickedAt;
        const p = ballObject.position;
        const travelled = kick === undefined ? 0 : Math.hypot(p.x - kick.x, p.z - kick.z);
        // Every recorded point of the path since the kick must sit in pressed snow.
        let trackGaps = 0;
        for (const point of telemetry.path)
          if (snow.sample(point.x, point.z).indent < 0.004) trackGaps += 1;
        return {
          airborne: clearance > 0.05,
          clearance,
          airborneLoads: telemetry.airborneLoads,
          dropped: telemetry.dropped,
          gap,
          kicked: kick !== undefined,
          load: snowPhysics.loadOf(ball),
          position: [p.x, p.y, p.z],
          // Turn times radius over the distance actually covered: 1 is rolling without slipping.
          reach: telemetry.reach,
          rollRatio:
            telemetry.rolled > 0.05 ? (telemetry.turned * BALL_RADIUS) / telemetry.rolled : 0,
          settled: Math.abs(gap) <= 0.02 && sink > 0.02,
          sink,
          trackGaps,
          trackSamples: telemetry.path.length,
          travelled,
        };
      },
    });
    const pressedUnder = (object: Object3D) => {
      const p = object.position;
      return Math.abs(p.x) < half && Math.abs(p.z) < half ? snow.sample(p.x, p.z).indent : 0;
    };
    ctx.entities.add("crate", {
      object: crateObject,
      debug: () => ({ load: snowPhysics.loadOf(crate), sink: pressedUnder(crateObject) }),
    });
    ctx.entities.add("log", {
      object: logObject,
      debug: () => ({ load: snowPhysics.loadOf(log), sink: pressedUnder(logObject) }),
    });
    ctx.entities.add("player", explorer);
    // The first print of the arrival trail: nothing walks back over it unless steered there.
    const trailStart = { x: 0.35 * Math.sin(6.4 * 0.7) + STANCE, z: 6.4 };
    ctx.entities.add("snow", {
      debug: () => ({
        trailPressed: snow.sample(trailStart.x, trailStart.z).indent > 0.01,
        ...snowPhysics.observe(),
        activeCells: snow.activeCells,
        depth: snow.depth,
        memoryBytes: snow.memoryBytes,
        pendingRows: surface.pendingRows,
        renderError: surface.renderError(),
        steps: snow.steps,
      }),
    });
    ctx.entities.add("weather", { debug: () => ({ storm: weather.storm, wind: weather.wind }) });

    // The surface view frames the newest print far enough from the explorer to be seen past them.
    const surfaceTarget = () => {
      const print =
        [...recentSteps]
          .reverse()
          .find(
            (step) => Math.hypot(step.x - explorer.position.x, step.z - explorer.position.z) > 1.2,
          ) ?? lastStep;
      return {
        x: print.x,
        y: snow.heightAt(clampToField(print.x), clampToField(print.z)) + 0.12,
        z: print.z,
      };
    };
    // ---- verbs: one function per action, shared by keys and the HUD ----
    let toastId = 0;
    let toast = "";
    const say = (message: string) => {
      toast = message;
      toastId += 1;
    };
    let view = 0;
    // The scene owns this; state only mirrors it, so a key and the panel never race the bridge.
    let autoExplore = initial.autoExplore;
    let blizzard = initial.blizzard;
    const act = (command: Command): void => {
      const state = ctx.state.getState();
      if (command === "reset") {
        snow.reset();
        placeBody(ctx, snow, ball, { x: 2.2, z: -2 }, BALL_RADIUS + 0.02);
        placeBody(ctx, snow, crate, { x: -2.6, z: -2.4 }, CRATE.y / 2 + 0.02);
        placeBody(ctx, snow, log, { x: -1.6, z: 2.8 }, LOG.radius + 0.02);
        telemetry.kickedAt = undefined;
        telemetry.path.length = 0;
        lastStep = { ...lastStep, penetration: 0 };
        say("A fresh blanket of snow. All footprints cleared.");
      } else if (command === "drop") {
        const ahead = {
          x: explorer.position.x + Math.sin(explorer.heading) * 1.8,
          z: explorer.position.z + Math.cos(explorer.heading) * 1.8,
        };
        placeBody(ctx, snow, ball, ahead, 1.6);
        telemetry.dropped = true;
        telemetry.airborneLoads = 0;
        telemetry.kickedAt = undefined;
        telemetry.path.length = 0;
        say("Ball dropped. Watch it settle into the snow.");
      } else if (command === "kick") {
        const p = ballObject.position;
        let dx = p.x - explorer.position.x;
        let dz = p.z - explorer.position.z;
        const length = Math.hypot(dx, dz) || 1;
        dx /= length;
        dz /= length;
        // A kick lifts as well as pushes: a dropped ball can sit ten centimetres down in its own
        // crater, and a purely sideways shove only rolls it up the wall and back in.
        ball.applyImpulse({ x: dx * KICK, y: KICK * 0.4, z: dz * KICK });
        telemetry.kickedAt = { x: p.x, z: p.z };
        telemetry.path.length = 0;
        telemetry.turned = 0;
        telemetry.rolled = 0;
        telemetry.reach = 0;
        say("Ball pushed. It rolls through the powder and carves its own track.");
      } else if (command === "view") {
        view = (view + 1) % VIEWS.length;
        ctx.state.set({ view: VIEWS[view] });
        if (VIEWS[view] === "surface") {
          // Look back at the print from beyond it, so the explorer is never between.
          const print = surfaceTarget();
          orbit.yaw = Math.atan2(print.x - explorer.position.x, print.z - explorer.position.z);
        }
      } else if (command === "auto") {
        autoExplore = !autoExplore;
        say(autoExplore ? "Auto-explore on." : "You are in control. Hold Shift to run.");
      } else if (command === "blizzard") {
        blizzard = !blizzard;
        say(
          blizzard
            ? "Blizzard building — wind and visibility are changing."
            : "Returning to soft snowfall.",
        );
      } else if (command === "mute") {
        audio.setMuted(!audio.muted);
        ctx.state.set({ muted: audio.muted });
      }
    };

    let refill = 0;
    ctx.afterPhysics((dt) => {
      // Solve → (this) consume contacts once, deform, refill → collider installed before the next
      // step. The renderer collects what changed and draws it before the frame.
      surface.collect();
      refill += dt;
      if (refill >= REFILL_INTERVAL) {
        const state = ctx.state.getState();
        const deposition = ((2 + 18 * weather.storm) * state.snowfall * state.recovery) / 3_600_000;
        snow.recover(refill, deposition, weather.wind * weather.storm);
        refill = 0;
        surface.collect();
      }
      snowPhysics.step(dt);
      // Ball telemetry: a load while the ball was clearly above the snow for the whole step — at
      // its start and at its end — would be a contact nothing touched. A step that lands or
      // kicks off legitimately touches at one end of it.
      const clearance = ballState().clearance;
      if (Math.min(clearance, telemetry.lastClearance) > 0.05 && snowPhysics.loadOf(ball) > 0)
        telemetry.airborneLoads += 1;
      telemetry.lastClearance = clearance;
      const solved = solvedBall();
      const rotation = solved.rotation;
      const previous = telemetry.lastRotation;
      const dot = Math.min(
        1,
        Math.abs(
          previous.x * rotation.x +
            previous.y * rotation.y +
            previous.z * rotation.z +
            previous.w * rotation.w,
        ),
      );
      const p = solved.position;
      const moved = telemetry.lastPosition;
      if (telemetry.kickedAt !== undefined) {
        telemetry.turned += 2 * Math.acos(dot);
        telemetry.rolled += Math.hypot(p.x - moved.x, p.z - moved.z);
        telemetry.reach = Math.max(
          telemetry.reach,
          Math.hypot(p.x - telemetry.kickedAt.x, p.z - telemetry.kickedAt.z),
        );
        // Only where the ball is on the snow: a hop off the crater lip presses nothing beneath it.
        const last = telemetry.path[telemetry.path.length - 1];
        if (
          clearance <= 0.01 &&
          (last === undefined || Math.hypot(p.x - last.x, p.z - last.z) > 0.1)
        )
          telemetry.path.push({ x: p.x, z: p.z });
      }
      telemetry.lastRotation = { w: rotation.w, x: rotation.x, y: rotation.y, z: rotation.z };
      telemetry.lastPosition = { x: p.x, y: p.y, z: p.z };
    });
    ctx.beforeRender(() => surface.refresh());

    let waypoint = 0;
    let pointer: { x: number; y: number } | undefined;
    this.#materialLighting = ctx.entities.add(
      "material-lighting",
      createMaterialLighting(ctx.scene, ctx.camera, lights.sun, {
        ...materialEnvironment,
        enabled: materialLightingEnabled(this.#post.tier, materialEnvironment),
      }),
    );
    return (frameCtx, dt) => {
      loading.update();
      const input = frameCtx.input;
      for (const command of commands.splice(0)) act(command);
      for (const name of ["reset", "drop", "kick", "view", "auto", "blizzard", "mute"] as const)
        if (input.justPressed(name)) act(name);
      if (input.justPressed("compaction"))
        frameCtx.state.set({ compaction: !frameCtx.state.getState().compaction });

      const state = frameCtx.state.getState();
      if (state.depth !== snow.depth) {
        snow.setDepth(state.depth);
        walkBody.dispose();
        walkBody = walk(snow.depth);
        surface.outskirts.position.y = snow.depth - startDepth;
      }
      snow.hardness = state.hardness;
      surface.setCompactionView(state.compaction);

      // Steering: the stick or the keys take over from auto-explore.
      const stick = touchControls?.update(input.raw.pointers, frameCtx.viewport.size).move;
      const keys = input.vector("move");
      const sideways = keys.x + (stick?.x ?? 0);
      const forward = keys.y + (stick?.y ?? 0);
      if (autoExplore && Math.hypot(sideways, forward) > 0.1) {
        autoExplore = false;
        say(
          touchControls === undefined
            ? "You are in control. Hold Shift to run."
            : "You are in control.",
        );
      }
      let move: { x: number; z: number };
      if (autoExplore) {
        const [tx, tz] = ROUTE[waypoint] ?? [0, 0];
        const dx = tx - explorer.position.x;
        const dz = tz - explorer.position.z;
        const distance = Math.hypot(dx, dz);
        if (distance < 0.85) waypoint = (waypoint + 1) % ROUTE.length;
        move = { x: dx / Math.max(0.01, distance), z: dz / Math.max(0.01, distance) };
      } else {
        const yaw = orbit.yaw;
        move = {
          x: Math.cos(yaw) * sideways - Math.sin(yaw) * forward,
          z: -Math.sin(yaw) * sideways - Math.cos(yaw) * forward,
        };
      }
      explorer.update(dt, move, input.pressed("run"), state.hardness);

      weather.update(
        dt,
        explorer.position,
        frameCtx.viewport.size.height / (2 * Math.tan((camera.fov * Math.PI) / 360)),
        { ...state, blizzard },
      );
      lights.update(explorer.position, weather.storm);
      stormSky(weather.storm);
      surface.setStorm(weather.storm);
      audio.update(weather.wind, weather.storm);

      // Camera: drag to orbit (desktop), scroll or pinch to zoom.
      const raw = input.raw.pointer;
      if (touchControls === undefined && raw.down) {
        if (pointer !== undefined)
          orbit.drag(raw.position.x - pointer.x, raw.position.y - pointer.y);
        pointer = { x: raw.position.x, y: raw.position.y };
      } else pointer = undefined;
      orbit.zoom(input.axis("zoom") * 16);
      orbit.setView(state.view);
      const target =
        state.view === "surface"
          ? surfaceTarget()
          : {
              x: explorer.position.x,
              y: explorer.position.y + (state.view === "overhead" ? 0.25 : 0.8),
              z: explorer.position.z,
            };
      orbit.update(camera, target, (x, z) => snow.heightAt(clampToField(x), clampToField(z)), dt);

      const { gap, sink } = ballState();
      frameCtx.state.set({
        autoExplore,
        blizzard,
        ballGap: gap,
        ballLoad: snowPhysics.loadOf(ball),
        ballSink: sink,
        contacts: snow.steps,
        lastSink: lastStep.penetration,
        muted: audio.muted,
        probe: probeAround(snow, lastStep),
        speed: explorer.speed,
        storm: weather.storm,
        toast,
        toastId,
        windNow: weather.wind,
      });
    };
  }
  override exit(): void {
    this.#materialLighting?.dispose();
    this.#materialLighting = undefined;
    this.#post?.dispose();
    this.#post = undefined;
  }
}

function clampToField(value: number): number {
  const half = FIELD_SIZE / 2 - 1e-3;
  return Math.max(-half, Math.min(half, value));
}

/** The indentation under the last footprint, in the boot's own frame, for the HUD's probe. */
function probeAround(snow: SnowField, step: IFootstep): number[] {
  const values: number[] = [];
  const cos = Math.cos(step.angle);
  const sin = Math.sin(step.angle);
  for (let row = 0; row < PROBE_ROWS; row += 1) {
    for (let column = 0; column < PROBE_COLUMNS; column += 1) {
      const u = (column / (PROBE_COLUMNS - 1) - 0.5) * 0.56;
      const v = (0.5 - row / (PROBE_ROWS - 1)) * 0.75;
      const sample = snow.sample(step.x + u * cos + v * sin, step.z - u * sin + v * cos);
      values.push(Math.round((sample.indent - sample.bank) * 1000) / 1000);
    }
  }
  return values;
}
