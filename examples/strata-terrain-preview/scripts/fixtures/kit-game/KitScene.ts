import {
  type ICtx,
  type IFrameBudgetWindow,
  Scene,
  type VirtualShadowNode,
} from "@threenative/core";
import {
  CharacterBody3D,
  CollisionShape3D,
  type IPhysicsContext,
  RigidBody3D,
} from "@threenative/physics";
import {
  type InstancedMesh,
  Matrix4,
  type Mesh,
  Object3D,
  type PerspectiveCamera,
  PointLight,
  Vector3,
} from "three";
import { createLoadingScreen } from "../render/loading.js";
import { type GameState, initialState } from "../state.js";
import {
  COLLIDERS,
  type IKitWorld,
  KIT,
  addKit,
  forestStand,
  kitDaylight,
} from "../terrain/kit.js";

import { composition, proofClearTarget, proofFarTarget } from "../terrain/composition.js";

type Ctx = ICtx<GameState, IPhysicsContext>;
type Field = IKitWorld["field"];
type Extent = IKitWorld["extent"];

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
/** The kit daylight's sun (`sky.ts`). Its azimuth picks the side the edge camera stands on. */
const SUN_AZIMUTH = Math.atan2(0.56, 0.55);
const VIEW_NAMES =
  KIT === "Forest"
    ? ["ground", "edge", "overview", "lake"]
    : ["boulders", "edge", "ground", "overview"];
if (proofFarTarget) VIEW_NAMES.push("composition-far");
if (proofClearTarget) VIEW_NAMES.push("composition-clear");
type ViewName = string;

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

/** Same original package position in both arms; 90 m away with a clear elevated sightline. */
export function compositionFarView(target: readonly [number, number, number]): IView {
  const look = new Vector3(...target).add(new Vector3(0, 1, 0));
  return { at: look.clone().add(new Vector3(72, 54, 0)), look };
}

/** Same original clearing in both arms, framed from 30 m above and beside its terrain. */
export function compositionClearView(target: readonly [number, number], field: Field): IView {
  const [x, z] = target;
  const look = new Vector3(x, field.heightAt(x, z), z);
  return { at: look.clone().add(new Vector3(18, 24, 0)), look };
}

/** Where the scene stands, looks and drives, all read from the loaded world. */
interface IStand {
  readonly anchor: IProp;
  readonly spawn: IPoint;
  readonly groundY: number;
  readonly views: Readonly<Record<ViewName, IView>> & { readonly ground: IView };
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
  const boulder = KIT === "Coastal" ? COLLIDERS.fir : COLLIDERS.boulder;
  if (!boulder || !("sphere" in boulder))
    throw new Error(`${KIT} kit: the boulder has no collider in COLLIDERS.`);
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
  wet: (point: IPoint, margin: number) => boolean,
): boolean {
  const length = distance(anchor, spawn);
  for (let along = 0; along <= length - 1.5; along += 0.25) {
    const point = {
      x: spawn.x + ((anchor.x - spawn.x) * along) / length,
      z: spawn.z + ((anchor.z - spawn.z) * along) / length,
    };
    if (slopeAt(field, extent, point.x, point.z) > WALK_SLOPE) return false;
    if (wet(point, 1)) return false;
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
  wet: (point: IPoint, margin: number) => boolean,
): IPoint | undefined {
  let best: IPoint | undefined;
  let bestClear = RADIUS + 0.5;
  for (let step = 0; step < 24; step += 1) {
    const angle = (2 * Math.PI * step) / 24;
    const spawn = {
      x: anchor.x + SPAWN_RING * Math.cos(angle),
      z: anchor.z + SPAWN_RING * Math.sin(angle),
    };
    if (wet(spawn, KIT === "Tundra" ? 5 : 1)) continue;
    if (
      slopeAt(field, extent, spawn.x, spawn.z) > SPAWN_SLOPE ||
      !walkable(field, extent, props, anchor, spawn, wet)
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
function edgeFor(
  props: readonly IProp[],
  anchor: IProp,
  extent: Extent,
  wet: (point: IPoint, margin: number) => boolean,
): IPoint {
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
      if (wet(point, KIT === "Tundra" ? 5 : 1)) continue;
      const clear = Math.min(...props.map((prop) => distance(prop, point)));
      if (clear > bestClear) {
        bestClear = clear;
        best = point;
      }
    }
  if (best === undefined)
    throw new Error(`${KIT} kit: no edge camera point on the sun's side of the anchor.`);
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
  wet: (point: IPoint, margin: number) => boolean,
): IStand["views"] {
  const anchorGround = field.heightAt(anchor.x, anchor.z);
  const target = new Vector3(anchor.x, anchorGround + 0.9, anchor.z);
  const eyeGround = field.heightAt(spawn.x, spawn.z);
  const edge = edgeFor(props, anchor, extent, wet);
  // Beside the centre's side of the anchor, so the camera stays inside the world however the anchor lies.
  const overviewX = anchor.x + (anchor.x > centre.x ? -160 : 160);
  const overviewZ = anchor.z + (anchor.z > centre.z ? -160 : 160);
  // The boulder view stands 9 m behind the anchor, on the side away from the spawn. Beside the world's
  // edge that side may leave the world, so the camera takes the spawn's side instead.
  const sign = inside(extent, { x: anchor.x - away.x * 9, z: anchor.z - away.z * 9 }, 0) ? 1 : -1;
  const behind = { x: anchor.x - away.x * 9 * sign, z: anchor.z - away.z * 9 * sign };
  const boulderGround = groundAt(field, extent, behind.x, behind.z);
  if (boulderGround === undefined)
    throw new Error(`${KIT} kit: the boulder view has no ground inside the world.`);
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
function chooseStand(kit: IKitWorld, useEdits = Boolean(composition)): IStand {
  const arm = useEdits ? composition : null;
  if (forestStand) return forestViews();
  const wet = (point: IPoint, margin: number): boolean => {
    if (kit.seaLevel !== undefined) {
      const ground = groundAt(kit.field, kit.extent, point.x, point.z);
      return ground === undefined || ground < kit.seaLevel + margin;
    }
    return (kit.lakes ?? []).some(
      (lake) => distance(point, { x: lake.at[0], z: lake.at[1] }) < lake.radius + margin,
    );
  };
  const { field, extent } = kit;
  const props = readProps(kit.placements);
  const centre = { x: extent.minX + extent.sizeX / 2, z: extent.minZ + extent.sizeZ / 2 };
  // Every boulder may anchor the stand. The nearest one to the centre with a walkable spawn wins.
  const moved = arm ? kit.placementIds?.indexOf(arm.anchorId) : undefined;
  if (arm && (moved === undefined || moved < 0)) throw new Error("Alpine moved boulder is missing");
  const candidates = arm
    ? [props[moved as number] as IProp]
    : [...props].sort((a, b) => distance(a, centre) - distance(b, centre));
  for (const anchor of candidates) {
    if (wet(anchor, 3)) continue;
    const spawn = spawnFor(field, extent, props, anchor, wet);
    if (spawn === undefined) continue;
    const away = { x: (spawn.x - anchor.x) / SPAWN_RING, z: (spawn.z - anchor.z) / SPAWN_RING };
    return {
      anchor,
      spawn,
      groundY: field.heightAt(spawn.x, spawn.z),
      views: arm
        ? chooseStand({ ...kit, placements: new Float32Array(arm.referencePlacements) }, false)
            .views
        : viewsFor(field, props, extent, centre, anchor, spawn, away, wet),
    };
  }
  throw new Error(`${KIT} kit: no boulder in the world has a walkable spawn.`);
}

function forestViews(): IStand {
  const stand = forestStand;
  if (!stand) throw new Error("Forest kit: missing generated stand.");
  const TRUNK = new Vector3(stand.fir.x, stand.groundY + 6, stand.fir.z);
  /** From the fir towards the player's start; the open side of the stand. */
  const AWAY = new Vector3(stand.spawn.x - stand.fir.x, 0, stand.spawn.z - stand.fir.z).normalize();

  /** The recipe's lake centre, on the water's level: the lake view looks at it from above the terrain. */
  const LAKE = new Vector3(-70, 13.3, 25);
  /** The fixed views the scenario captures. */
  // Eye-height cameras inside a 4.5 m stand sit inside crowns, whose one-sided cards vanish from
  // behind; so the close view looks out of the clearing and the edge view stands back from the stand.
  const views = {
    ground: {
      at: new Vector3(stand.spawn.x, stand.groundY + EYE, stand.spawn.z),
      look: new Vector3(stand.spawn.x, stand.groundY + EYE, stand.spawn.z).addScaledVector(
        AWAY,
        20,
      ),
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
  };
  return {
    anchor: { ...stand.fir, y: stand.groundY, radius: 0.35 },
    spawn: stand.spawn,
    groundY: stand.groundY,
    views,
  };
}

function disposeKit(kit: IKitWorld): void {
  kit.world.dispose();
  kit.colliders.detach();
  kit.ground.dispose();
  kit.water?.dispose();
  kit.sea?.dispose();
}

export class KitScene extends Scene<GameState, IPhysicsContext> {
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
  #kit: IKitWorld | undefined;
  #stand: IStand | undefined;
  #released = false;
  #ready = false;
  #spawnReady = false;
  #visibleShadowFrame = -1;
  #daylight: ReturnType<typeof kitDaylight> | undefined;
  #promoted: Object3D | undefined;
  #promotedLight: PointLight | undefined;
  #fixedRigidBody: RigidBody3D | undefined;
  #error = "";
  #settle: ((error?: Error) => void) | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #loading: ReturnType<typeof createLoadingScreen> | undefined;

  /** The kit's world streams while the scene loads, so `ready` waits for the cells the spawn needs. */
  override async load(ctx: Ctx): Promise<void> {
    for (const view of VIEW_NAMES) viewWindows.set(view, { frameP95: [], gpuP50: [], gpuP95: [] });
    if (forestStand) {
      this.#stand = forestViews();
      ctx.camera.position.copy(this.#stand.views.ground.at);
      ctx.camera.lookAt(this.#stand.views.ground.look);
    }
    const deadlineAt = performance.now() + 120_000;
    let settled = false;
    const spawn = new Promise<void>((done, fail) => {
      this.#settle = (error) => {
        if (settled) return;
        settled = true;
        if (this.#timer !== undefined) clearTimeout(this.#timer);
        if (error === undefined) {
          if (!this.#released && !this.#error) this.#ready = true;
          done();
        } else fail(error);
      };
    });
    this.#timer = setTimeout(
      () => this.#fail(ctx, `${KIT} spawn admission exceeded 120000 ms`),
      120_000,
    );
    void spawn.catch((error: unknown) => {
      this.#fail(ctx, error instanceof Error ? error.message : String(error));
    });
    if (ctx.startup.phase !== "ready")
      ctx.startup.hold(`${KIT.toLowerCase()}-spawn`, spawn, 120_000);
    let kit: IKitWorld | undefined;
    // A holder rather than a `let`: the progress getter reads it, and the spawn is set once it is known.
    const loadingScene = this;
    const spawnView: { at?: Vector3 } = { at: this.#stand?.views.ground?.at };
    this.#loading = createLoadingScreen({
      ...ctx,
      startup: {
        get warmup() {
          return { status: loadingScene.#ready ? ("complete" as const) : ("incomplete" as const) };
        },
        get progress() {
          // The spawn is unknown until the world resolves, so the bar reads the startup alone until then.
          const region = spawnView.at && kit?.world.readinessAt(spawnView.at, 60);
          const required = (region?.requiredCells ?? 0) + (region?.requiredTerrainTiles ?? 0);
          const loaded = (region?.loadedCells ?? 0) + (region?.loadedTerrainTiles ?? 0);
          const visible = kit?.world.terrainReadinessInView(ctx.camera);
          return Math.min(
            0.99,
            (ctx.startup.progress +
              (required > 0 ? loaded / required : 0) +
              (visible && visible.required > 0 ? visible.loaded / visible.required : 0)) /
              3,
          );
        },
        whenReady: () => Promise.all([ctx.startup.whenReady(), spawn]).then(() => undefined),
      },
    });
    try {
      kit = await addKit(ctx, ctx.camera, undefined, () => !this.#released);
    } catch (error) {
      this.#fail(ctx, error instanceof Error ? error.message : String(error));
      return;
    }
    this.#kit = kit;
    if (this.#released) {
      disposeKit(kit);
      return;
    }
    let stand: IStand;
    try {
      stand = chooseStand(kit);
      if (proofFarTarget)
        stand = {
          ...stand,
          views: { ...stand.views, "composition-far": compositionFarView(proofFarTarget) },
        };
      if (proofClearTarget)
        stand = {
          ...stand,
          views: {
            ...stand.views,
            "composition-clear": compositionClearView(proofClearTarget, kit.field),
          },
        };
    } catch (error) {
      this.#fail(ctx, error instanceof Error ? error.message : String(error));
      return;
    }
    const arm = composition;
    if (arm) {
      const removed = kit.editReport.removed.find((item) => item.id === arm.promotedId);
      if (!removed) throw new Error("Alpine promoted placement was not removed");
      const asset = kit.manifest.assets[removed.asset];
      if (!asset) throw new Error("Alpine promoted asset is missing");
      const model = await ctx.assets.model<{ scene: Object3D }>(`terrain/alpine/${asset.glb}`);
      if (this.#released) return;
      const object = model.scene.clone(true);
      object.name = "game-promoted-boulder";
      object.position.set(
        arm.promotedAt[0],
        kit.field.heightAt(...arm.promotedAt),
        arm.promotedAt[1],
      );
      object.quaternion.fromArray(removed.quaternion);
      object.scale.setScalar(removed.scale);
      object.traverse((child) => {
        const mesh = child as Mesh;
        if (!mesh.isMesh) return;
        mesh.material = Array.isArray(mesh.material)
          ? mesh.material.map((material) => material.clone())
          : mesh.material.clone();
        mesh.castShadow = true;
        mesh.receiveShadow = true;
      });
      const light = new PointLight(0xff9b47, 90, 12, 2);
      light.position.set(0, 2, 1.5);
      object.add(light);
      this.#promoted = object;
      this.#promotedLight = light;
    }
    this.#stand = stand;
    spawnView.at = stand.views.ground.at;
    // Arm once, after the world is attached: the engine owns readiness, its prewarm owns the draw.
    const remaining = deadlineAt - performance.now();
    void (
      remaining > 0
        ? Promise.all([
            kit.world.whenSpawnReady(stand.views.ground.at, 60, remaining),
            kit.world.prewarmed,
          ])
        : Promise.reject(new Error(`${KIT} spawn admission exceeded 120000 ms`))
    ).then(
      () => {
        this.#spawnReady = true;
      },
      (error: unknown) => this.#fail(ctx, error instanceof Error ? error.message : String(error)),
    );
    const player = new Object3D();
    player.position.set(stand.spawn.x, stand.groundY + HALF_HEIGHT + RADIUS + 2.5, stand.spawn.z);
    this.#player = player;
    // The camera moves to the spawn before the world finishes streaming, so the cells it needs load first.
    ctx.camera.position.copy(stand.views.ground.at);
    ctx.camera.lookAt(stand.views.ground.look);
    ctx.state.set({
      propColliders: kit.colliders.active,
      worldReady: 0,
      ...(kit.water ? { waterLakes: kit.water.lakes, waterRivers: kit.water.rivers } : {}),
      ...(kit.sea ? { waterLakes: 1 } : {}),
    });
  }

  override enter(ctx: Ctx): void {
    this.#daylight = kitDaylight(ctx.camera);
    ctx.add(this.#daylight);
    if (!this.#kit || !this.#stand) {
      ctx.beforeRender(() => this.#loading?.update());
      return;
    }
    if (this.#promoted) {
      ctx.add(this.#promoted);
      this.#fixedRigidBody = new RigidBody3D({
        object: this.#promoted,
        physics: ctx.physics,
        type: "fixed",
        entity: "game-promoted-boulder",
        collisionLayer: 2,
        shape: CollisionShape3D.sphere(0.9 * this.#promoted.scale.x),
      });
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
      const kit = this.#kit;
      const stand = this.#stand;
      if (!kit || !stand) return;
      const region = kit.world.readinessAt(stand.views.ground.at, 60);
      if (!region) return;
      if (!this.#ready && this.#spawnReady) {
        const visible = kit.world.terrainReadinessInView(ctx.camera);
        const shadow = (this.#daylight?.sun.shadow.shadowNode as VirtualShadowNode | undefined)
          ?.stats;
        const stats = kit.world.stats();
        const dataReady =
          visible.loaded === visible.required &&
          stats.loadedCells === stats.residentCells &&
          stats.loadsInFlight === 0 &&
          stats.loadsQueued === 0 &&
          stats.admission.backlog === 0 &&
          stats.pendingPrewarm === 0;
        const pendingCpuDraws = dataReady ? kit.world.pendingCpuDrawsInView(ctx.camera) : -1;
        const complete = dataReady && pendingCpuDraws === 0;
        if (!complete) this.#visibleShadowFrame = -1;
        else if (shadow && shadow.frame > 0 && shadow.levels > 0) {
          // Observe a completed render after the visible terrain joined, including deferred shadow levels.
          if (this.#visibleShadowFrame < 0) this.#visibleShadowFrame = shadow.frame;
          else if (
            shadow.frame > this.#visibleShadowFrame &&
            shadow.held === 0 &&
            shadow.deferred === 0
          )
            this.#settle?.();
        }
      }
      ctx.state.set({
        spawnCellsLoaded: region.loadedCells,
        spawnCellsRequired: region.requiredCells,
        spawnTerrainLoaded: region.loadedTerrainTiles,
        spawnTerrainRequired: region.requiredTerrainTiles,
      });
      if (this.#released) return;
      ctx.state.set({
        worldReady: this.#ready ? 1 : 0,
        loadingError: this.#error,
      });
    });
  }

  #fail(ctx: Ctx, message: string): void {
    if (this.#released || this.#error || this.#ready) return;
    const error = message || `${KIT} spawn failed`;
    this.#error = error;
    this.#settle?.(new Error(error));
    ctx.state.set({ loadingError: error, worldReady: 0 });
  }

  override exit(): void {
    this.#released = true;
    this.#settle?.(new Error(`${KIT} spawn cancelled`));
    this.#loading?.finish();
    this.#body?.dispose();
    this.#fixedRigidBody?.dispose();
    this.#promoted?.traverse((child) => {
      const mesh = child as Mesh;
      if (mesh.isMesh) for (const material of [mesh.material].flat()) material.dispose();
    });
    this.#promoted?.removeFromParent();
    if (this.#kit) disposeKit(this.#kit);
  }

  override update(ctx: Ctx, dt: number): void {
    const body = this.#body;
    const player = this.#player;
    const stand = this.#stand;
    if (body === undefined || player === undefined || stand === undefined) return;
    if (!this.#ready || ctx.startup.phase !== "ready" || ctx.state.getState().loadingError) {
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
    this.#observeComposition(ctx);
    if (this.#frames % 60 === 0)
      ctx.state.set({
        [KIT === "Forest"
          ? "firInstancesDrawn"
          : KIT === "Coastal"
            ? "treeInstances"
            : "boulderInstances"]:
          KIT === "Forest" ? this.#firInstances(ctx) : (this.#kit?.world.stats().instances ?? -1),
        propColliders: this.#kit?.colliders.active ?? -1,
      });
    ctx.state.set({
      driveMetres: this.#driven,
      frames: this.#frames,
      viewFrameP95: this.#costs("frameP95"),
      viewGpuP50: this.#costs("gpuP50"),
      viewGpuP95: this.#costs("gpuP95"),
    });
  }

  #observeComposition(ctx: Ctx): void {
    const arm = composition;
    const kit = this.#kit;
    if (!arm || !kit) return;
    const ids = kit.placementIds ?? [];
    const moved = ids.indexOf(arm.anchorId) * 8;
    const added = ids.indexOf("game:alpine-added-boulder") * 8;
    const transform = arm.edits.overrides?.[arm.anchorId];
    const addition = arm.edits.add?.[0];
    const matches = (offset: number, edit: typeof transform): boolean =>
      offset >= 0 &&
      edit !== undefined &&
      Math.abs((kit.placements[offset] as number) - edit.position[0]) < 0.001 &&
      Math.abs((kit.placements[offset + 2] as number) - edit.position[2]) < 0.001 &&
      Math.abs(
        (kit.placements[offset + 1] as number) -
          kit.field.heightAt(edit.position[0], edit.position[2]),
      ) < 0.001 &&
      edit.quaternion.every(
        (value, i) => Math.abs((kit.placements[offset + 3 + i] as number) - value) < 0.001,
      ) &&
      Math.abs((kit.placements[offset + 7] as number) - edit.scale[0]) < 0.001;
    let uncleared = 0;
    for (let i = 0; i < ids.length; i += 1) {
      if (ids[i] === arm.anchorId || ids[i] === "game:alpine-added-boulder") continue;
      if (
        Math.hypot(
          (kit.placements[i * 8] as number) - arm.clear.center[0],
          (kit.placements[i * 8 + 2] as number) - arm.clear.center[1],
        ) <= arm.clear.radius
      )
        uncleared += 1;
    }
    const object = this.#promoted;
    const hit =
      object &&
      ctx.physics.directSpaceState.intersectRay({
        from: { x: object.position.x, y: object.position.y + 5, z: object.position.z },
        to: { x: object.position.x, y: object.position.y - 2, z: object.position.z },
        collisionMask: 2,
      });
    const removed =
      !ids.includes(arm.promotedId) &&
      kit.editReport.removed.some((item) => item.id === arm.promotedId);
    let ordinaryMeshes = 0;
    object?.traverse((node) => {
      if ((node as Mesh).isMesh && !(node as InstancedMesh).isInstancedMesh) ordinaryMeshes += 1;
    });
    let removedDrawn = false;
    const original = kit.editReport.removed.find((item) => item.id === arm.promotedId);
    if ((this.#view === "overview" || this.#view === "composition-far") && original) {
      const matrix = new Matrix4();
      const position = new Vector3();
      const originalPosition = new Vector3(...original.position);
      ctx.scene.traverse((node) => {
        const mesh = node as InstancedMesh;
        if (!mesh.isInstancedMesh || !mesh.visible) return;
        for (let i = 0; i < mesh.count; i += 1) {
          mesh.getMatrixAt(i, matrix);
          position.setFromMatrixPosition(matrix).applyMatrix4(mesh.matrixWorld);
          if (position.distanceTo(originalPosition) < 0.01) removedDrawn = true;
        }
      });
    }
    ctx.state.set({
      movedBoulder: Number(matches(moved, transform)),
      clearedCircle: Number(
        uncleared === 0 &&
          arm.clearedIds.length > 0 &&
          arm.clearedIds.every((id) => !ids.includes(id)),
      ),
      addedBoulder: Number(matches(added, addition)),
      promotedObject: Number(object?.parent === ctx.scene && ordinaryMeshes > 0),
      promotedLight: Number(
        this.#promotedLight?.parent === object && (this.#promotedLight?.intensity ?? 0) > 0,
      ),
      promotedCollider: Number(hit !== undefined && hit.body.id === this.#fixedRigidBody?.body.id),
      ...(this.#view === "overview" || this.#view === "composition-far"
        ? { removedFar: Number(removed && !removedDrawn) }
        : {}),
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
    if (this.#driveLeft <= 0)
      ctx.state.set({
        [KIT === "Forest"
          ? "closestToTrunk"
          : KIT === "Coastal"
            ? "closestToTree"
            : "closestToBoulder"]: this.#closest,
        driveDone: 1,
      });
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
