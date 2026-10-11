// An ordinary game scene standing in the forest starter kit. The kit streams the world, textures
// its ground and gives the firs and boulders their collision; this file owns the daylight, the
// camera, the player and every number the playtest reads. Nothing here imports the authoring
// package: the kit was copied into `src/terrain/forest/` and its bake is a build step.
import { type ICtx, type IFrameBudgetWindow, Scene } from "@threenative/core";
import { CharacterBody3D, CollisionShape3D, type IPhysicsContext } from "@threenative/physics";
import { type InstancedMesh, Object3D, type PerspectiveCamera, Vector3 } from "three";
import { createLoadingScreen, createSpawnReadiness } from "../render/loading.js";
import { type GameState, initialState } from "../state.js";
import { forestDaylight } from "../terrain/forest/sky.js";
import { stand } from "../terrain/forest/stand.js";
import { addForest } from "../terrain/forest/world.js";

type Ctx = ICtx<GameState, IPhysicsContext>;

/** A 1.8 m figure: 0.55 m of half-height plus the 0.35 m radius the fir's clearance is read against. */
const HALF_HEIGHT = 0.55;
const RADIUS = 0.35;
const MOVE_SPEED = 3;
/** Long enough to cover the four metres and be stopped by the trunk it is aimed at. */
const DRIVE_SECONDS = 3;
const EYE = 1.7;
/** The fir's middle, the point the two close views look at. */
const TRUNK = new Vector3(stand.fir.x, stand.groundY + 6, stand.fir.z);
/** From the fir towards the player's start; the open side of the stand. */
const AWAY = new Vector3(stand.spawn.x - stand.fir.x, 0, stand.spawn.z - stand.fir.z).normalize();

/** The recipe's lake centre, on the water's level: the lake view looks at it from above the terrain. */
const LAKE = new Vector3(-70, 13.3, 25);
/** The fixed views the scenario captures. */
// Eye-height cameras inside a 4.5 m stand sit inside crowns, whose one-sided cards vanish from
// behind; so the close view looks out of the clearing and the edge view stands back from the stand.
const VIEWS = {
  ground: {
    at: new Vector3(stand.spawn.x, stand.groundY + EYE, stand.spawn.z),
    look: new Vector3(stand.spawn.x, stand.groundY + EYE, stand.spawn.z).addScaledVector(AWAY, 20),
  },
  edge: {
    at: new Vector3(stand.edge.x, stand.groundY + 6, stand.edge.z),
    look: TRUNK,
  },
  overview: {
    at: new Vector3(stand.fir.x + 160, stand.groundY + 220, stand.fir.z + 160),
    look: TRUNK,
  },
  // Above the tallest ground (about 38 m) and back far enough to frame the whole basin and its shore.
  lake: {
    at: new Vector3(20, 84, 115),
    look: LAKE,
  },
} satisfies Readonly<Record<string, { at: Vector3; look: Vector3 }>>;
const VIEW_NAMES = Object.keys(VIEWS);

/** One view's closed frame-budget windows, read by {@link noteFrameBudget}. */
const viewWindows = new Map<string, { frameP95: number[]; gpuP50: number[]; gpuP95: number[] }>();
let currentView = "ground";

/**
 * The engine's own frame meter, grouped by the view that was on screen.
 *
 * `budget` alone cannot answer "what did this stand cost at the overview": a scenario switches
 * cameras faster than a window closes, so the one window the game holds belongs to whichever view
 * happened to be current. Each view keeps its own windows and the scene publishes the medians.
 */
export function noteFrameBudget(window: IFrameBudgetWindow): void {
  const group = viewWindows.get(currentView);
  // A window with no `gpu` resolved no timestamp: absent, not zero.
  if (group === undefined || window.gpu === undefined) return;
  group.gpuP50.push(window.gpu.p50);
  group.gpuP95.push(window.gpu.p95);
  group.frameP95.push(window.frame.p95);
}

/** The middle of a sample set, for a summary that one outlier cannot move. */
function median(values: readonly number[]): number {
  if (values.length === 0) return -1;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? -1;
}

export class Forest extends Scene<GameState, IPhysicsContext> {
  static override readonly initialState: GameState = initialState;

  #player: Object3D | undefined;
  #body: CharacterBody3D | undefined;
  #camera: PerspectiveCamera | undefined;
  #view = "ground";
  #frames = 0;
  #driveLeft = DRIVE_SECONDS;
  #driven = 0;
  #closest = Number.POSITIVE_INFINITY;
  #settled = false;
  #forest: Awaited<ReturnType<typeof addForest>> | undefined;
  #released = false;
  #admission: ReturnType<typeof createSpawnReadiness> | undefined;
  #loading: ReturnType<typeof createLoadingScreen> | undefined;

  /** The kit's world streams while the scene loads, so `ready` waits for real streamed cells. */
  override async load(ctx: Ctx): Promise<void> {
    for (const view of VIEW_NAMES) viewWindows.set(view, { frameP95: [], gpuP50: [], gpuP95: [] });
    const player = new Object3D();
    player.position.set(stand.spawn.x, stand.groundY + HALF_HEIGHT + RADIUS + 2.5, stand.spawn.z);
    // The world streams and picks detail around the camera, as a game whose camera follows its
    // player does; the capture views move the camera far from the player.
    this.#player = player;
    ctx.camera.position.copy(VIEWS.ground.at);
    ctx.camera.lookAt(VIEWS.ground.look);
    const admission = createSpawnReadiness("Forest spawn");
    this.#admission = admission;
    void admission.promise.catch((error: unknown) => {
      this.#fail(ctx, error instanceof Error ? error.message : String(error));
    });
    if (ctx.startup.phase !== "ready") ctx.startup.hold("forest-spawn", admission.promise, 120_000);
    let forest: Awaited<ReturnType<typeof addForest>> | undefined;
    this.#loading = createLoadingScreen({
      ...ctx,
      startup: {
        get progress() {
          const region = forest?.world.readinessAt(VIEWS.ground.at, 60);
          const required = (region?.requiredCells ?? 0) + (region?.requiredTerrainTiles ?? 0);
          const loaded = (region?.loadedCells ?? 0) + (region?.loadedTerrainTiles ?? 0);
          return Math.min(
            0.99,
            (ctx.startup.progress + (required > 0 ? loaded / required : 0)) / 2,
          );
        },
        whenReady: () =>
          Promise.all([ctx.startup.whenReady(), admission.promise]).then(() => undefined),
      },
    });
    try {
      forest = await addForest(ctx, ctx.camera, undefined, () => !this.#released);
    } catch (error) {
      this.#fail(ctx, error instanceof Error ? error.message : String(error));
      return;
    }
    if (this.#released) {
      forest.world.dispose();
      forest.colliders.detach();
      forest.ground.dispose();
      return;
    }
    this.#forest = forest;
    this.#player = player;
    ctx.state.set({
      propColliders: forest.colliders.active,
      waterLakes: forest.water.lakes,
      waterRivers: forest.water.rivers,
      worldReady: 0,
    });
  }

  override enter(ctx: Ctx): void {
    ctx.add(forestDaylight(ctx.camera));
    if (!this.#forest) {
      ctx.beforeRender(() => this.#loading?.update());
      return;
    }
    ctx.add(this.#player as Object3D);
    // The body joins the world once its object is in the scene, as the template player does.
    this.#body = new CharacterBody3D({
      object: this.#player as Object3D,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(HALF_HEIGHT, RADIUS),
    });
    const camera = ctx.camera as PerspectiveCamera;
    // The kit's sky box and the streamed cells both live far out; the far plane has to clear them.
    camera.far = 5000;
    camera.updateProjectionMatrix();
    this.#camera = camera;
    this.#viewNow(ctx);
    ctx.beforeRender(() => {
      this.#loading?.update();
      const region = this.#forest?.world.readinessAt(VIEWS.ground.at, 60);
      if (!region) return;
      ctx.state.set({
        spawnCellsLoaded: region.loadedCells,
        spawnCellsRequired: region.requiredCells,
        spawnTerrainLoaded: region.loadedTerrainTiles,
        spawnTerrainRequired: region.requiredTerrainTiles,
      });
      if (this.#released) return;
      this.#admission?.observe(
        region.ready && this.#forest?.world.stats().pendingPrewarm === 0,
        region.failures,
      );
      ctx.state.set({
        worldReady: this.#admission?.ready ? 1 : 0,
        loadingError: this.#admission?.error ?? "",
      });
    });
  }

  #fail(ctx: Ctx, message: string): void {
    if (this.#released || ctx.state.getState().loadingError) return;
    this.#admission?.fail(message);
    ctx.state.set({
      loadingError: this.#admission?.error ?? message,
      worldReady: this.#admission?.ready ? 1 : 0,
    });
  }

  override exit(): void {
    this.#released = true;
    this.#admission?.cancel();
    this.#loading?.finish();
    this.#body?.dispose();
    this.#forest?.world.dispose();
    this.#forest?.colliders.detach();
    this.#forest?.ground.dispose();
  }

  override update(ctx: Ctx, dt: number): void {
    const body = this.#body;
    const player = this.#player;
    if (body === undefined || player === undefined) return;
    if (
      !this.#admission?.ready ||
      ctx.startup.phase !== "ready" ||
      ctx.state.getState().loadingError
    ) {
      body.velocity.x = 0;
      body.velocity.z = 0;
      body.moveAndSlide(dt);
      return;
    }
    this.#frames += 1;

    const towards = new Vector3(
      stand.fir.x - player.position.x,
      0,
      stand.fir.z - player.position.z,
    );
    const distance = towards.length();
    const driving = this.#driveLeft > 0 && distance > 0.001;
    if (driving) {
      towards.normalize();
      body.velocity.x = towards.x * MOVE_SPEED;
      body.velocity.z = towards.z * MOVE_SPEED;
    } else {
      body.velocity.x = 0;
      body.velocity.z = 0;
    }
    body.moveAndSlide(dt);
    if (driving) {
      this.#driveLeft -= dt;
      // The body writes its object back after the physics step, so distance is read from the spawn.
      this.#driven = Math.hypot(
        player.position.x - stand.spawn.x,
        player.position.z - stand.spawn.z,
      );
      // The clearance the fir's own capsule leaves, sampled every frame it walked.
      this.#closest = Math.min(
        this.#closest,
        Math.hypot(player.position.x - stand.fir.x, player.position.z - stand.fir.z),
      );
      if (this.#driveLeft <= 0) ctx.state.set({ closestToTrunk: this.#closest, driveDone: 1 });
    }
    if (body.grounded && this.#frames > 30) this.#measureGround(ctx, player);

    for (const [action, view] of [
      ["ground", "ground"],
      ["edge", "edge"],
      ["overview", "overview"],
      ["lake", "lake"],
    ] as const)
      if (ctx.input.justPressed(action)) this.#setView(ctx, view);
    this.#placeCamera();
    if (this.#frames % 60 === 0) ctx.state.set({ firInstancesDrawn: this.#firInstances(ctx) });
    ctx.state.set({
      driveMetres: this.#driven,
      frames: this.#frames,
      viewFrameP95: this.#costs("frameP95"),
      viewGpuP50: this.#costs("gpuP50"),
      viewGpuP95: this.#costs("gpuP95"),
    });
  }

  #setView(ctx: Ctx, view: string): void {
    if (this.#view === view) return;
    this.#view = view;
    currentView = view;
    this.#placeCamera();
    ctx.state.set({ view });
  }

  #viewNow(ctx: Ctx): void {
    this.#view = "ground";
    currentView = "ground";
    this.#placeCamera();
    ctx.state.set({ view: "ground" });
  }

  /** Placed every frame: the engine reconciles the camera, so a pose written once is not a pose. */
  #placeCamera(): void {
    const view = (VIEWS as Readonly<Record<string, { at: Vector3; look: Vector3 }>>)[this.#view];
    if (view === undefined || this.#camera === undefined) return;
    this.#camera.position.copy(view.at);
    this.#camera.lookAt(view.look);
  }

  /** |foot − terrain|, from the collider the player is standing on. Measured once it has settled. */
  #measureGround(ctx: Ctx, player: Object3D): void {
    if (this.#settled) return;
    this.#settled = true;
    // A ray from above would hit the player's own capsule first, so the ground is read beside it:
    // four rays half a metre out, whose mean cancels any planar slope.
    let sum = 0;
    for (const [dx, dz] of [
      [0.5, 0],
      [-0.5, 0],
      [0, 0.5],
      [0, -0.5],
    ] as const) {
      const at = { x: player.position.x + dx, z: player.position.z + dz };
      const hit = ctx.physics.directSpaceState.intersectRay({
        from: { ...at, y: player.position.y + 50 },
        to: { ...at, y: stand.groundY - 100 },
      });
      if (hit == null)
        throw new Error(`No terrain contact beside the player at ${player.position.toArray()}.`);
      sum += hit.position.y;
    }
    ctx.state.set({
      groundError: Math.abs(player.position.y - HALF_HEIGHT - RADIUS - sum / 4),
    });
  }

  /** Instances the renderer draws in the fir batches, its own visibility and every ancestor's. */
  #firInstances(ctx: Ctx): number {
    let drawn = 0;
    ctx.scene.traverse((object) => {
      if (!(object as InstancedMesh).isInstancedMesh) return;
      const mesh = object as InstancedMesh;
      if (!mesh.name.includes("fir") || mesh.count < 1) return;
      for (let node: Object3D | null = object; node !== null; node = node.parent)
        if (node.visible === false) return;
      drawn += mesh.count;
    });
    return drawn;
  }

  #costs(key: "frameP95" | "gpuP50" | "gpuP95"): Record<string, number> {
    const costs: Record<string, number> = {};
    for (const [view, group] of viewWindows) costs[view] = median(group[key]);
    return costs;
  }
}
