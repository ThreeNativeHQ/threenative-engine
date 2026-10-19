import { type ICtx, Scene, VirtualShadowNode } from "@threenative/core";
import { type IWorldCellsStats, WorldCells } from "@threenative/core/world";
import {
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  SphereGeometry,
} from "three";
import { bloom } from "three/addons/tsl/display/BloomNode.js";
import { pass } from "three/tsl";
import { ShadowPartialProbe } from "../probes/shadowPartial.js";
import { terrainMaterial } from "../render/terrain.js";
import { worldFog } from "../render/worldFog.js";

/**
 * PRD-448 Phase 4a: a deterministic fly-through of a committed `world-v1` package.
 *
 * The scene is the whole point the framework has to hold: the game names a package URL, a surface
 * and a follow target, and `WorldCells` streams the terrain, the instanced props and the hand-placed
 * chunks by cell as the camera crosses the 256 m fixture. The camera is the follow target and
 * travels one straight line at a fixed altitude while the scenario holds one input, so residency
 * rises and falls and the scenario can assert the stats the package promises.
 *
 * Nothing here decides how anything looks that belongs to the package: the terrain surface is this
 * example's own (`terrainMaterial`), the lights are the example's, and the props, colours and chunks
 * come from the GLBs the package names.
 *
 * Since PRD-452 the package is this example's own `assets/world/` source, compiled into
 * content-addressed output, and it is read through `ctx.assets` — the one loader with a renderer, so
 * `assets/world/assets/pine.glb`'s embedded 64x64 texture arrives as KTX2 rather than as a
 * `TN_ASSETS_KTX2_NO_RENDERER` failure. Nothing else about the flight changed.
 */

/** The fixture is 4x4 cells of 64 m starting at (-128, -128). */
const START_X = -160;
const END_X = 180;
/** Metres per second; a straight x-axis crossing reaches every column of the fixture. */
const SPEED = 64;
/** Above the fixture's measured maximum height (4.86 m), so the camera never enters the terrain. */
const ALTITUDE = 24;
const RING = 1;
/** The fixture's cell size; terrain tiles default to it. */
const CELL_SIZE = 64;
/**
 * `?world&viewDistance` runs PRD-461's recipe: props on ring 2, terrain to 3, bodies on the 3x3
 * around the camera, and fog that is opaque where a new cell can load. The default flight keeps the
 * ring-1 numbers the phase477 desktop and Android lanes measure.
 */
const VIEW_DISTANCE = /[?&]viewDistance\b/.test(globalThis.location?.search ?? "");
/**
 * `?world&shadowMovers` holds the camera still and spends the `fly` input on a sphere that casts,
 * which nothing hands to `trackCaster`: PRD-572's proof that the node finds a mover by measuring it.
 */
const SHADOW_MOVERS = /[?&]shadowMovers\b/.test(globalThis.location?.search ?? "");
/**
 * `?world&shadowPartial` holds the camera still and, once the world is idle, changes the scene in
 * three steps (a caster arrives, one leaves while another arrives, one leaves) and compares each
 * partial shadow redraw to a whole one: PRD-538's depth-equivalence proof, read off the GPU.
 */
// The native host has no query string and forwards only `TN_DEBUG_*` into `process.env`.
const SHADOW_PARTIAL =
  /[?&]shadowPartial\b/.test(
    globalThis.location?.search ?? globalThis.document?.location?.search ?? "",
  ) ||
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
    ?.TN_DEBUG_SHADOW_PARTIAL === "1";
/** Metres the sphere swings either side of its rest point, and radians per second of the swing. */
const BALL_SWING = 8;
const BALL_RATE = 2;
const BUDGETS = { bytes: 8_000_000, instances: 20_000, residentCells: 25 };

const initialState = {
  evictions: 0,
  failures: 0,
  instances: 0,
  loadsInFlight: 0,
  maxResidentCells: 0,
  residenceChanges: 0,
  residentCells: 0,
  shadowDeferrals: 0,
  shadowFrame: 0,
  shadowLevels: 0,
  shadowPartialDone: 0,
  shadowRendered: 0,
};

export type WorldState = typeof initialState & { stats?: IWorldCellsStats };
type WorldCtx = ICtx<WorldState>;

export class WorldProbe extends Scene<WorldState> {
  static override readonly initialState = initialState;

  #world: WorldCells | undefined;
  #elapsed = 0;
  #previousResident = -1;
  #maxResident = 0;
  #maxInstances = 0;
  #maxAdmissionSpentMs = 0;
  #cameraTarget: [number, number, number] = [START_X + 40, ALTITUDE - 14, 0];
  #residenceChanges = 0;
  #shadow: VirtualShadowNode | undefined;
  #ball: Mesh | undefined;
  #partial: ShadowPartialProbe | undefined;
  /** Tiles holding a body right now, as the game's own `createCollider` sees them. */
  readonly #bodies = new Map<string, { tileX: number; tileZ: number }>();

  override async load(ctx: WorldCtx): Promise<void> {
    this.#world = await WorldCells.load({
      assets: ctx.assets,
      budgets: BUDGETS,
      follow: ctx.camera,
      ring: VIEW_DISTANCE ? 2 : RING,
      surface: terrainMaterial(),
      terrain: VIEW_DISTANCE
        ? { colliderRadius: 1, streamRadius: 3, tileResolution: 65 }
        : { tileResolution: 65 },
      ...(VIEW_DISTANCE
        ? {
            // A counting body, not a physics one: it proves which tiles the engine asks to collide.
            createCollider: ({ key, tileX, tileZ }) => {
              this.#bodies.set(key, { tileX, tileZ });
              return { dispose: () => this.#bodies.delete(key) };
            },
          }
        : {}),
      // A logical path into this example's own `assets/world/` source, which both build targets
      // compile into content-addressed output plus `assets.manifest.json`.
      url: "world/world.json",
    });
  }

  override enter(ctx: WorldCtx): void {
    const world = this.#world;
    if (world === undefined) throw new Error("WorldProbe.enter ran before load() resolved.");
    ctx.add(world);
    if (VIEW_DISTANCE) worldFog(ctx.scene, CELL_SIZE, 2);
    else ctx.scene.background = new Color(0x0b1a2a);
    // Most props' GLBs carry no materials, so three's default standard material needs a light to be
    // visible. The look is this example's, exactly as a game's would be.
    const sky = new HemisphereLight(0xbfd8ff, 0x2a2f22, 2.2);
    const sun = new DirectionalLight(0xffffff, 2.6);
    sun.position.set(-80, 120, 60);
    // A sun that casts, so the streamed cells have a shadow to be culled into. The node is the
    // engine's own: this scene names no shadow mechanism, it just asks for one and reports what
    // the engine did with it.
    sun.castShadow = true;
    // The partial proof asks for no delay, so each step redraws on the next frame.
    this.#shadow = new VirtualShadowNode(sun, {
      clipExtents: [24, 96, 320],
      // Keep depth coordinates identical across caster changes so byte comparisons test redraws.
      ...(SHADOW_PARTIAL
        ? { depthRange: 400, followViewFocus: false, invalidationDelay: 0, lightDistance: 200 }
        : {}),
    });
    sun.shadow.shadowNode = this.#shadow;
    // The framework's renderer ships with the shadow map off, because most games never ask for
    // one. This one does, so it turns it on the way the engine's own `Daylight` rig does.
    const raw = ctx.renderer.raw as { shadowMap?: { enabled: boolean } } | undefined;
    if (raw?.shadowMap !== undefined) raw.shadowMap.enabled = true;
    ctx.add(sky);
    ctx.add(sun);
    if (SHADOW_MOVERS) {
      const ball = new Mesh(
        new SphereGeometry(1.5, 24, 16),
        new MeshStandardMaterial({ color: 0xd9a441 }),
      );
      ball.castShadow = true;
      // A material that never receives builds no shadow node, so the node would never run.
      ball.receiveShadow = true;
      ball.position.set(-30, 6, 0);
      this.#ball = ball;
      ctx.add(ball);
    }
    if (SHADOW_PARTIAL) {
      this.#partial = new ShadowPartialProbe({
        done: () => ctx.state.set({ shadowPartialDone: 1 }),
        ready: () => {
          const stats = this.#world?.stats();
          return stats !== undefined && stats.loadsInFlight === 0 && stats.pendingPrewarm === 0;
        },
        renderer: ctx.renderer.raw,
        scene: ctx.scene,
        shadow: this.#shadow,
      });
      void this.#partial.run();
    }
    ctx.entities.add("world", {
      debug: () => this.#debug(ctx),
      dispose: () => world.dispose(),
      object: world,
    });
    this.#update(ctx, 0);
  }

  override update(ctx: WorldCtx, dt: number): void {
    this.#update(ctx, dt);
  }

  override render(ctx: WorldCtx): void {
    // The shadow node's `updateBefore` runs inside the render pass, so this is the only hook where
    // its per-frame `deferred` counter is the frame that just happened rather than the one before.
    this.#sample(ctx);
  }

  #update(ctx: WorldCtx, dt: number): void {
    // Movement is gated on an input the scenario holds, not on the clock: the engine catches up
    // hundreds of fixed steps while first-use compilation settles, and a time-driven camera would
    // have crossed the whole fixture before the baseline observation.
    if (ctx.input.pressed("fly")) this.#elapsed += dt;
    if (SHADOW_PARTIAL) {
      const held = this.#partial?.cameraOffset;
      ctx.camera.position.set(-45, 14, 0);
      // The partial proof's own travel: a camera that moves while the scene holds its shape.
      if (held !== undefined) ctx.camera.position.add(held);
      this.#cameraTarget = [-30, 2, 0];
      ctx.camera.lookAt(...this.#cameraTarget);
      this.#sample(ctx);
      return;
    }
    if (this.#ball !== undefined) {
      // The camera holds still over the fixture and only the sphere answers the input.
      this.#ball.position.z = Math.sin(this.#elapsed * BALL_RATE) * BALL_SWING;
      ctx.camera.position.set(-45, 14, 0);
      this.#cameraTarget = [-30, 2, 0];
      ctx.camera.lookAt(...this.#cameraTarget);
      this.#sample(ctx);
      return;
    }
    const x = Math.min(START_X + this.#elapsed * SPEED, END_X);
    ctx.camera.position.set(x, ALTITUDE, 0);
    this.#cameraTarget = [x + 40, ALTITUDE - 14, 0];
    ctx.camera.lookAt(...this.#cameraTarget);
    this.#sample(ctx);
  }

  /** Sample the residency counters per step; the stats are read at observation time. */
  #sample(ctx: WorldCtx): void {
    const stats = this.#world?.stats();
    if (stats === undefined) return;
    // Preserve the engine's complete readings, including admission overshoot and GPU fallback reason.
    ctx.state.set({ stats });
    this.#maxInstances = Math.max(this.#maxInstances, stats.instances);
    this.#maxAdmissionSpentMs = Math.max(this.#maxAdmissionSpentMs, stats.admission.spentMs);
    if (stats.residentCells !== this.#previousResident) {
      this.#previousResident = stats.residentCells;
      this.#residenceChanges += 1;
    }
    this.#maxResident = Math.max(this.#maxResident, stats.residentCells);
    // Cumulative, because the per-frame counter reads zero on any frame the node had nothing to do.
    const shadow = this.#shadow?.stats;
    if (shadow === undefined) return;
    if (shadow.deferred > 0) this.#shadowDeferrals += 1;
    this.#shadowRenders += shadow.rendered;
    if (shadow.autoMovers > 0 && this.#rendersAtFirstMover < 0) {
      this.#rendersAtFirstMover = shadow.rendersTotal;
    }
    this.#peakAutoMovers = Math.max(this.#peakAutoMovers, shadow.autoMovers);
  }

  #shadowDeferrals = 0;
  #shadowRenders = 0;
  #peakAutoMovers = 0;
  #rendersAtFirstMover = -1;

  /** PRD-572: what the node measured about movers, read off its own stats. */
  #moverDebug(): Record<string, number> {
    const shadow = this.#shadow?.stats;
    return {
      shadowAutoMovers: shadow?.autoMovers ?? 0,
      shadowPeakAutoMovers: this.#peakAutoMovers,
      shadowAutoTransitions: shadow?.autoTransitions ?? 0,
      shadowAutoScanMs: shadow?.autoScanMs ?? 0,
      // Level renders since the node first measured a mover: a full redraw per moving frame would
      // be hundreds; one region redraw per transition is a handful.
      shadowRendersSinceMover:
        shadow === undefined || this.#rendersAtFirstMover < 0
          ? 0
          : shadow.rendersTotal - this.#rendersAtFirstMover,
      shadowMoverRenders: shadow?.moverRenders ?? 0,
    };
  }

  #debug(ctx: WorldCtx): Record<string, unknown> {
    const stats = this.#world?.stats();
    const shadow = this.#shadow?.stats;
    return {
      cameraPosition: ctx.camera.position.toArray(),
      cameraTarget: [...this.#cameraTarget],
      flyTimeMs: this.#elapsed * 1_000,
      // World-space transforms from the committed hand-placed chunks, not inferred screen depth.
      landmarks: [
        { id: "yard_crate_a", position: [-100, 1, 0] },
        { id: "yard_crate_b", position: [-30, 1, -20] },
      ],
      ...(stats === undefined
        ? {}
        : {
            admissionBacklog: stats.admission.backlog,
            admissionDeferred: stats.admission.deferred,
            admissionSpentMs: stats.admission.spentMs,
            // PRD-494: the main pass's draw record, so a native run can assert the default reached it.
            bundleChildren: stats.bundle.children,
            bundleOn: stats.bundle.on,
            gpuSceneOn: stats.gpuScene.on,
            gpuSceneReason: stats.gpuScene.reason,
            gpuSceneDispatches: stats.gpuScene.dispatches,
            loadsQueued: stats.loadsQueued,
            pendingPrewarm: stats.pendingPrewarm,
            maxAdmissionSpentMs: this.#maxAdmissionSpentMs,
            maxInstances: this.#maxInstances,
          }),
      evictions: stats?.evictions ?? 0,
      failures: stats?.failures ?? 0,
      instances: stats?.instances ?? 0,
      loadsInFlight: stats?.loadsInFlight ?? 0,
      maxResidentCells: this.#maxResident,
      residentTiles: stats?.residentTiles ?? 0,
      residentColliders: stats?.residentColliders ?? 0,
      bodies: this.#bodies.size,
      // Farthest body from the camera, in tiles, Chebyshev; a tile is centred on a multiple of its
      // size. Radius 1 keeps every body within 1.5 tiles of the camera.
      bodyReachTiles: Math.max(
        0,
        ...[...this.#bodies.values()].map(
          ({ tileX, tileZ }) =>
            Math.max(
              Math.abs(tileX * CELL_SIZE - ctx.camera.position.x),
              Math.abs(tileZ * CELL_SIZE - ctx.camera.position.z),
            ) / CELL_SIZE,
        ),
      ),
      residenceChanges: this.#residenceChanges,
      residentCells: stats?.residentCells ?? 0,
      shadowDeferrals: this.#shadowDeferrals,
      shadowFrame: shadow?.frame ?? 0,
      shadowLevels: shadow?.levels ?? 0,
      shadowRendered: this.#shadowRenders,
      ...this.#moverDebug(),
      ...this.#partial?.results,
    };
  }
}

export class WorldWarmUpProbe extends WorldProbe {
  #worldPass: ReturnType<typeof pass> | undefined;
  #outputInstallation: { dispose(): void } | undefined;

  override enter(ctx: WorldCtx): void {
    const worldPass = pass(ctx.scene, ctx.camera);
    const colour = worldPass.getTextureNode();
    const installation = ctx.renderer.setOutputNode(
      colour.add(bloom(colour, 0.9, 0.5, 0.25)),
      worldPass,
    );
    if (ctx.renderer.warmUpWorldPass === undefined)
      throw new Error("WorldWarmUpProbe requires renderer.warmUpWorldPass.");
    this.#worldPass = worldPass;
    if (installation !== undefined) this.#outputInstallation = installation;
    console.info("[WorldWarmUpProbe] installed world output pass");
    super.enter(ctx);
  }

  override exit(ctx: WorldCtx): void {
    super.exit(ctx);
    this.#outputInstallation?.dispose();
    this.#outputInstallation = undefined;
    const worldPass = this.#worldPass;
    this.#worldPass = undefined;
    ctx.renderer.clearOutputNode?.(worldPass);
    worldPass?.dispose();
  }
}
