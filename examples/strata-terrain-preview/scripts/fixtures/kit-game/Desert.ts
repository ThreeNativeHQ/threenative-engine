// An ordinary game scene standing in the desert starter kit. The kit streams the world, textures its
// ground and gives the boulders their collision; this file owns the daylight, the camera, the player
// and every number the playtest reads. Nothing here imports the authoring package: the kit was copied
// into `src/terrain/desert/` and its bake is a build step. The spawn and the views are read from the
// loaded heightfield and placements, so the scene keeps no coordinate the recipe does not make.
import { type ICtx, type IFrameBudgetWindow, Scene } from "@threenative/core";
import { CharacterBody3D, CollisionShape3D, type IPhysicsContext } from "@threenative/physics";
import { Object3D, type PerspectiveCamera, Vector3 } from "three";
import { createLoadingScreen, createSpawnReadiness } from "../render/loading.js";
import { type GameState, initialState } from "../state.js";
import { desertDaylight } from "../terrain/desert/sky.js";
import { COLLIDERS, type IDesertWorld, addDesert } from "../terrain/desert/world.js";

type Ctx = ICtx<GameState, IPhysicsContext>;
type Field = IDesertWorld["field"];
type Extent = IDesertWorld["extent"];

/** A 1.8 m figure: 0.55 m of half-height plus the 0.35 m radius a boulder's clearance is read against. */
const HALF_HEIGHT = 0.55;
const RADIUS = 0.35;
const MOVE_SPEED = 3;
/** Long enough to cover the spawn ring and be stopped by the boulder it is aimed at. */
const DRIVE_SECONDS = 3;
const EYE = 1.7;
/** Metres from the anchor boulder's origin to the spawn: far enough to walk, near enough to measure. */
const SPAWN_RING = 5;
/** The steepest rise over run, per metre, that the spawn or the walk to the anchor may use. */
const SPAWN_SLOPE = 0.25;
const WALK_SLOPE = 0.35;
/** The desert daylight's sun (`sky.ts`). Its azimuth picks the side the edge camera stands on. */
const SUN_AZIMUTH = Math.atan2(0.56, 0.55);
const VIEW_NAMES = ["boulders", "edge", "ground", "overview"] as const;
type ViewName = (typeof VIEW_NAMES)[number];

interface IPoint {
  readonly x: number;
  readonly z: number;
}

/** One placed boulder, read from its record: where it stands and the radius its collider uses. */
interface IProp extends IPoint {
  readonly y: number;
  readonly radius: number;
}

interface IView {
  readonly at: Vector3;
  readonly look: Vector3;
}

/** Where the scene stands, looks and drives, all read from the loaded world. */
interface IStand {
  readonly anchor: IProp;
  readonly spawn: IPoint;
  readonly groundY: number;
  readonly views: Readonly<Record<ViewName, IView>>;
}

/** One view's closed frame-budget windows, read by {@link noteFrameBudget}. */
const viewWindows = new Map<string, { frameP95: number[]; gpuP50: number[]; gpuP95: number[] }>();
let currentView = "ground";

/** The engine's own frame meter, grouped by the view that was on screen. */
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

/** Every placed boulder. The kit's only asset is the boulder, so every record is one. */
function readProps(placements: Float32Array): IProp[] {
  const boulder = COLLIDERS.boulder;
  if (!boulder) throw new Error("Desert kit: the boulder has no collider in COLLIDERS.");
  const props: IProp[] = [];
  for (let index = 0; index + 8 <= placements.length; index += 8)
    props.push({
      x: placements[index] as number,
      y: placements[index + 1] as number,
      z: placements[index + 2] as number,
      radius: boulder.sphere * (placements[index + 7] as number),
    });
  return props;
}

function distance(a: IPoint, b: IPoint): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

function inside(extent: Extent, point: IPoint, margin: number): boolean {
  return (
    point.x > extent.minX + margin &&
    point.x < extent.minX + extent.sizeX - margin &&
    point.z > extent.minZ + margin &&
    point.z < extent.minZ + extent.sizeZ - margin
  );
}

/** The ground under a point, or undefined when the point lies outside the world's heightfield. */
function groundAt(field: Field, extent: Extent, x: number, z: number): number | undefined {
  return inside(extent, { x, z }, 0) ? field.heightAt(x, z) : undefined;
}

/** Rise over run at a point, from the heights half a metre either side on each axis. */
function slopeAt(field: Field, extent: Extent, x: number, z: number): number {
  const plusX = groundAt(field, extent, x + 0.5, z);
  const minusX = groundAt(field, extent, x - 0.5, z);
  const plusZ = groundAt(field, extent, x, z + 0.5);
  const minusZ = groundAt(field, extent, x, z - 0.5);
  // A slope that reaches past the world's edge is not walkable, so it reads as infinitely steep.
  if (plusX === undefined || minusX === undefined || plusZ === undefined || minusZ === undefined)
    return Number.POSITIVE_INFINITY;
  return Math.hypot(plusX - minusX, plusZ - minusZ);
}

/** The highest ground within `reach` metres of a point, sampled every 16 m inside the world. */
function highestNear(field: Field, extent: Extent, x: number, z: number, reach: number): number {
  let top = Number.NEGATIVE_INFINITY;
  for (let dx = -reach; dx <= reach; dx += 16)
    for (let dz = -reach; dz <= reach; dz += 16) {
      const ground = groundAt(field, extent, x + dx, z + dz);
      if (ground !== undefined) top = Math.max(top, ground);
    }
  return top;
}

/** Metres from a point to the nearest other boulder's surface. Infinite when there is no other. */
function clearance(props: readonly IProp[], point: IPoint, anchor: IProp): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const other of props)
    if (other !== anchor) nearest = Math.min(nearest, distance(other, point) - other.radius);
  return nearest;
}

/** The walk from the spawn to the anchor climbs gently and passes no other boulder. */
function walkable(
  field: Field,
  extent: Extent,
  props: readonly IProp[],
  anchor: IProp,
  spawn: IPoint,
): boolean {
  const length = distance(anchor, spawn);
  for (let along = 0; along <= length - 1.5; along += 0.25) {
    const point = {
      x: spawn.x + ((anchor.x - spawn.x) * along) / length,
      z: spawn.z + ((anchor.z - spawn.z) * along) / length,
    };
    if (slopeAt(field, extent, point.x, point.z) > WALK_SLOPE) return false;
    for (const other of props)
      if (other !== anchor && distance(other, point) < other.radius + RADIUS + 0.3) return false;
  }
  return true;
}

/** The clearest of 24 points a ring of metres from the anchor that is gentle, dry and walkable. */
function spawnFor(
  field: Field,
  extent: Extent,
  props: readonly IProp[],
  anchor: IProp,
): IPoint | undefined {
  let best: IPoint | undefined;
  let bestClear = RADIUS + 0.5;
  for (let step = 0; step < 24; step += 1) {
    const angle = (2 * Math.PI * step) / 24;
    const spawn = {
      x: anchor.x + SPAWN_RING * Math.cos(angle),
      z: anchor.z + SPAWN_RING * Math.sin(angle),
    };
    if (
      slopeAt(field, extent, spawn.x, spawn.z) > SPAWN_SLOPE ||
      !walkable(field, extent, props, anchor, spawn)
    )
      continue;
    const clear = clearance(props, spawn, anchor);
    if (clear > bestClear) {
      bestClear = clear;
      best = spawn;
    }
  }
  return best;
}

/** The clearest point 25 to 40 m from the anchor, on the sun's side and inside the world. */
function edgeFor(props: readonly IProp[], anchor: IProp, extent: Extent): IPoint {
  let best: IPoint | undefined;
  let bestClear = Number.NEGATIVE_INFINITY;
  for (let step = 0; step < 24; step += 1)
    for (const reach of [25, 30, 35, 40]) {
      const angle = (2 * Math.PI * step) / 24;
      const off = Math.abs(
        Math.atan2(Math.sin(angle - SUN_AZIMUTH), Math.cos(angle - SUN_AZIMUTH)),
      );
      if (off > Math.PI / 3) continue;
      const point = {
        x: anchor.x + reach * Math.cos(angle),
        z: anchor.z + reach * Math.sin(angle),
      };
      if (!inside(extent, point, 5)) continue;
      const clear = Math.min(...props.map((prop) => distance(prop, point)));
      if (clear > bestClear) {
        bestClear = clear;
        best = point;
      }
    }
  if (best === undefined)
    throw new Error("Desert kit: no edge camera point on the sun's side of the anchor.");
  return best;
}

/** The four fixed views, each placed from the anchor, the spawn and the terrain under them. */
function viewsFor(
  field: Field,
  props: readonly IProp[],
  extent: Extent,
  centre: IPoint,
  anchor: IProp,
  spawn: IPoint,
  away: IPoint,
): IStand["views"] {
  const anchorGround = field.heightAt(anchor.x, anchor.z);
  const target = new Vector3(anchor.x, anchorGround + 0.9, anchor.z);
  const eyeGround = field.heightAt(spawn.x, spawn.z);
  const edge = edgeFor(props, anchor, extent);
  // Beside the centre's side of the anchor, so the camera stays inside the world however the anchor lies.
  const overviewX = anchor.x + (anchor.x > centre.x ? -160 : 160);
  const overviewZ = anchor.z + (anchor.z > centre.z ? -160 : 160);
  // The boulder view stands 9 m behind the anchor, on the side away from the spawn. Beside the world's
  // edge that side may leave the world, so the camera takes the spawn's side instead.
  const sign = inside(extent, { x: anchor.x - away.x * 9, z: anchor.z - away.z * 9 }, 0) ? 1 : -1;
  const behind = { x: anchor.x - away.x * 9 * sign, z: anchor.z - away.z * 9 * sign };
  const boulderGround = groundAt(field, extent, behind.x, behind.z);
  if (boulderGround === undefined)
    throw new Error("Desert kit: the boulder view has no ground inside the world.");
  return {
    ground: {
      at: new Vector3(spawn.x, eyeGround + EYE, spawn.z),
      look: new Vector3(spawn.x + away.x * 20, eyeGround + EYE, spawn.z + away.z * 20),
    },
    edge: {
      at: new Vector3(edge.x, field.heightAt(edge.x, edge.z) + 6, edge.z),
      look: target,
    },
    overview: {
      at: new Vector3(
        overviewX,
        highestNear(field, extent, overviewX, overviewZ, 200) + 90,
        overviewZ,
      ),
      look: target,
    },
    boulders: {
      at: new Vector3(behind.x, boulderGround + 3.2, behind.z),
      look: new Vector3(anchor.x, anchorGround + 0.6, anchor.z),
    },
  };
}

/** The stand the scene is written around: the nearest boulder to the centre with a walkable spawn. */
function chooseStand(desert: IDesertWorld): IStand {
  const { field, extent } = desert;
  const props = readProps(desert.placements);
  const centre = { x: extent.minX + extent.sizeX / 2, z: extent.minZ + extent.sizeZ / 2 };
  // Every boulder may anchor the stand. The nearest one to the centre with a walkable spawn wins.
  const candidates = props.sort((a, b) => distance(a, centre) - distance(b, centre));
  for (const anchor of candidates) {
    const spawn = spawnFor(field, extent, props, anchor);
    if (spawn === undefined) continue;
    const away = { x: (spawn.x - anchor.x) / SPAWN_RING, z: (spawn.z - anchor.z) / SPAWN_RING };
    return {
      anchor,
      spawn,
      groundY: field.heightAt(spawn.x, spawn.z),
      views: viewsFor(field, props, extent, centre, anchor, spawn, away),
    };
  }
  throw new Error("Desert kit: no boulder in the world has a walkable spawn.");
}

function disposeDesert(desert: IDesertWorld): void {
  desert.world.dispose();
  desert.colliders.detach();
  desert.ground.dispose();
}

export class Desert extends Scene<GameState, IPhysicsContext> {
  static override readonly initialState: GameState = initialState;

  #player: Object3D | undefined;
  #body: CharacterBody3D | undefined;
  #camera: PerspectiveCamera | undefined;
  #view: ViewName = "ground";
  #frames = 0;
  #driveLeft = DRIVE_SECONDS;
  #driven = 0;
  #closest = Number.POSITIVE_INFINITY;
  #settled = false;
  #desert: IDesertWorld | undefined;
  #stand: IStand | undefined;
  #released = false;
  #admission: ReturnType<typeof createSpawnReadiness> | undefined;
  #loading: ReturnType<typeof createLoadingScreen> | undefined;

  /** The kit's world streams while the scene loads, so `ready` waits for the cells the spawn needs. */
  override async load(ctx: Ctx): Promise<void> {
    for (const view of VIEW_NAMES) viewWindows.set(view, { frameP95: [], gpuP50: [], gpuP95: [] });
    const admission = createSpawnReadiness("Desert spawn");
    this.#admission = admission;
    void admission.promise.catch((error: unknown) => {
      this.#fail(ctx, error instanceof Error ? error.message : String(error));
    });
    if (ctx.startup.phase !== "ready") ctx.startup.hold("desert-spawn", admission.promise, 120_000);
    let desert: IDesertWorld | undefined;
    // A holder rather than a `let`: the progress getter reads it, and the spawn is set once it is known.
    const spawnView: { at?: Vector3 } = {};
    this.#loading = createLoadingScreen({
      ...ctx,
      startup: {
        get progress() {
          // The spawn is unknown until the world resolves, so the bar reads the startup alone until then.
          const region = spawnView.at && desert?.world.readinessAt(spawnView.at, 60);
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
      desert = await addDesert(ctx, ctx.camera, undefined, () => !this.#released);
    } catch (error) {
      this.#fail(ctx, error instanceof Error ? error.message : String(error));
      return;
    }
    this.#desert = desert;
    if (this.#released) {
      disposeDesert(desert);
      return;
    }
    let stand: IStand;
    try {
      stand = chooseStand(desert);
    } catch (error) {
      this.#fail(ctx, error instanceof Error ? error.message : String(error));
      return;
    }
    this.#stand = stand;
    spawnView.at = stand.views.ground.at;
    const player = new Object3D();
    player.position.set(stand.spawn.x, stand.groundY + HALF_HEIGHT + RADIUS + 2.5, stand.spawn.z);
    this.#player = player;
    // The camera moves to the spawn before the world finishes streaming, so the cells it needs load first.
    ctx.camera.position.copy(stand.views.ground.at);
    ctx.camera.lookAt(stand.views.ground.look);
    ctx.state.set({ propColliders: desert.colliders.active, worldReady: 0 });
  }

  override enter(ctx: Ctx): void {
    ctx.add(desertDaylight(ctx.camera));
    if (!this.#desert || !this.#stand) {
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
    // The kit's sky box and the streamed cells both live far out. The far plane has to clear them.
    camera.far = 5000;
    camera.updateProjectionMatrix();
    this.#camera = camera;
    this.#viewNow(ctx);
    ctx.beforeRender(() => {
      this.#loading?.update();
      const desert = this.#desert;
      const stand = this.#stand;
      if (!desert || !stand) return;
      const region = desert.world.readinessAt(stand.views.ground.at, 60);
      if (!region) return;
      ctx.state.set({
        spawnCellsLoaded: region.loadedCells,
        spawnCellsRequired: region.requiredCells,
        spawnTerrainLoaded: region.loadedTerrainTiles,
        spawnTerrainRequired: region.requiredTerrainTiles,
      });
      if (this.#released) return;
      this.#admission?.observe(
        region.ready && desert.world.stats().pendingPrewarm === 0,
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
    if (this.#desert) disposeDesert(this.#desert);
  }

  override update(ctx: Ctx, dt: number): void {
    const body = this.#body;
    const player = this.#player;
    const stand = this.#stand;
    if (body === undefined || player === undefined || stand === undefined) return;
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

    const driving = this.#aim(body, player, stand);
    body.moveAndSlide(dt);
    if (driving) this.#measureDrive(ctx, player, stand, dt);
    if (body.grounded && this.#frames > 30) this.#measureGround(ctx, player, stand.groundY);

    for (const view of VIEW_NAMES) if (ctx.input.justPressed(view)) this.#setView(ctx, view);
    this.#placeCamera();
    if (this.#frames % 60 === 0)
      ctx.state.set({
        boulderInstances: this.#desert?.world.stats().instances ?? -1,
        propColliders: this.#desert?.colliders.active ?? -1,
      });
    ctx.state.set({
      driveMetres: this.#driven,
      frames: this.#frames,
      viewFrameP95: this.#costs("frameP95"),
      viewGpuP50: this.#costs("gpuP50"),
      viewGpuP95: this.#costs("gpuP95"),
    });
  }

  /** Aims the body at the anchor while the drive lasts. Returns whether the body is driving this frame. */
  #aim(body: CharacterBody3D, player: Object3D, stand: IStand): boolean {
    const towards = new Vector3(
      stand.anchor.x - player.position.x,
      0,
      stand.anchor.z - player.position.z,
    );
    const driving = this.#driveLeft > 0 && towards.length() > 0.001;
    if (!driving) {
      body.velocity.x = 0;
      body.velocity.z = 0;
      return false;
    }
    towards.normalize();
    body.velocity.x = towards.x * MOVE_SPEED;
    body.velocity.z = towards.z * MOVE_SPEED;
    return true;
  }

  /** Counts the drive down, and records how far the player went and how close it came to the anchor. */
  #measureDrive(ctx: Ctx, player: Object3D, stand: IStand, dt: number): void {
    this.#driveLeft -= dt;
    // The body writes its object back after the physics step, so distance is read from the spawn.
    this.#driven = Math.hypot(player.position.x - stand.spawn.x, player.position.z - stand.spawn.z);
    // The clearance the boulder's own collider leaves, sampled every frame it walked.
    this.#closest = Math.min(
      this.#closest,
      Math.hypot(player.position.x - stand.anchor.x, player.position.z - stand.anchor.z),
    );
    if (this.#driveLeft <= 0) ctx.state.set({ closestToBoulder: this.#closest, driveDone: 1 });
  }

  #setView(ctx: Ctx, view: ViewName): void {
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
    const view = this.#stand?.views[this.#view];
    if (view === undefined || this.#camera === undefined) return;
    this.#camera.position.copy(view.at);
    this.#camera.lookAt(view.look);
  }

  /** |foot − terrain|, from the collider the player is standing on. Measured once it has settled. */
  #measureGround(ctx: Ctx, player: Object3D, groundY: number): void {
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
        to: { ...at, y: groundY - 100 },
      });
      if (hit == null)
        throw new Error(`No terrain contact beside the player at ${player.position.toArray()}.`);
      sum += hit.position.y;
    }
    ctx.state.set({
      groundError: Math.abs(player.position.y - HALF_HEIGHT - RADIUS - sum / 4),
    });
  }

  #costs(key: "frameP95" | "gpuP50" | "gpuP95"): Record<string, number> {
    const costs: Record<string, number> = {};
    for (const [view, group] of viewWindows) costs[view] = median(group[key]);
    return costs;
  }
}
