import { type BufferGeometry, type Layers, type Material, type Mesh, Object3D } from "three";

import { isEngineRenderHook } from "./engine-render-hook.js";
import type { Registry } from "./entities.js";
import { mergeByMaterial } from "./merge-parts.js";
import { isStreamedGeometry } from "./model-lod.js";
import { displacesVertices, hasMorphAttributes } from "./projection-plan.js";
import { unbilled } from "./startup-offscreen-bytes.js";

/**
 * Static meshes that share a material become one draw, with no call from the game.
 *
 * `mergeByMaterial` was an opt-in call, so every kit that forgot it drew one mesh per box: the
 * shooter town drew 375 times until a hand-written `collapseTown` merged it. The engine now makes
 * that choice where it can measure it. A mesh is merged when the scene has stopped changing for
 * {@link SETTLE_FRAMES} frames and the mesh did not move, hide or change material in them. The game
 * calls nothing and keeps its own objects.
 *
 * **Correctness is unconditional, the merge is opportunistic.** The sources leave the graph but stay
 * alive, and every one is checked each frame. When the game moves, hides, re-materials or re-adds a
 * source, or moves an ancestor of one, that source comes back at once and its triangles are zeroed
 * in the merged index, so nothing is rebuilt and nothing pops. A raycast against the merged mesh is
 * answered by the sources, so a hit still names the authored mesh with its own `userData`.
 *
 * Only appearance-neutral meshes qualify: opaque, single material, a plain `position`/`normal`/`uv`
 * geometry, no render hook, no skin, morph, instancing or vertex displacement. Everything else keeps
 * its draw. The merged mesh keeps the game's own material and shadow, layer and render-order flags.
 *
 * **The game never sees the merge.** A source is kept out of the draw without touching anything the game
 * reads or copies: the engine's own `__tnBatchHidden` flag, or on plain three a `layers` view that answers
 * the renderer's `test` with `false` and the game's `mask` with its own value. `visible` stays the game's,
 * so a game that saves and restores visibility (a warm-up that shows everything to compile it) or clones a
 * merged source gets back exactly what it authored. Hiding through `visible` let Midway's warm-up re-hide a
 * given-back control stick for good, and a clone inherit the hide.
 *
 * **Named overrides, both reported.** `userData.batch = "off"` on a mesh or any ancestor keeps that
 * subtree out. `autoBatch: false` in the game config switches the pass off.
 */

/** Marker printed when meshes merge or come back, and once when the pass is off. */
export const AUTO_BATCH_MARKER = "TN_AUTO_BATCH";

/**
 * Frames the scene must hold still before it merges. Any motion at all, however small, differs
 * bit for bit between two frames, so three are enough for anything that moves on its own, and the
 * pass finishes inside the startup cover, where one expensive frame is not a hitch the player sees.
 * A mesh that only moves on an event is the guard's job, not this window's.
 */
const SETTLE_FRAMES = 3;

/**
 * Milliseconds a frame may spend checking merged sources for changes, in the default `"spread"`
 * guard. A source costs a few microseconds to check on the native engine (every property read
 * crosses the bridge), so 8,000 sources checked every frame cost 20 to 40 ms; a slice per frame
 * bounds the cost and the report states how many frames a change can then go unseen.
 */
const GUARD_BUDGET_MS = 0.5;

/** Sources the native engine's guard compares per call, between two reads of the budget clock. */
const ENGINE_GUARD_CHUNK = 2048;

/**
 * The native engine's own guard (bindings_scene.cpp): it keeps each source's state as merged and
 * compares it in place, so a lap of 8,000 sources fits the budget the JS slice spent on 200.
 */
interface IEngineGuard {
  __tnGuardWatch(sources: readonly Mesh[], ancestors?: readonly Object3D[]): number;
  __tnGuardCheck(limit: number): ArrayLike<number>;
  /** PRD-828: the sources' ancestors, checked whole in the engine; absent on an older engine. */
  __tnGuardCheckAncestors?(): ArrayLike<number>;
}

function engineGuardOf(scene: Object3D): IEngineGuard | undefined {
  const host = scene as Object3D & Partial<IEngineGuard>;
  return typeof host.__tnGuardWatch === "function" && typeof host.__tnGuardCheck === "function"
    ? (host as Object3D & IEngineGuard)
    : undefined;
}

/**
 * Meshes under a game-held object that still count as that object's own parts. A held group above
 * this is the level container, not a live prop, and its contents stay eligible.
 */
const HELD_SUBTREE_MAX_MESHES = 256;

/** Frames the scene's shape must stay unchanged before the movement watch starts. */
const QUIET_FRAMES = 1;

/**
 * Vertices one merged mesh holds before a second starts, so no single first-draw upload is a stall
 * (the same bound world chunks use: 4 MiB of position, normal and uv).
 */
const MAX_GROUP_VERTICES = (4 * 1024 * 1024) / 32;

const SNAPSHOT_LENGTH = 32;

const ALLOWED_ATTRIBUTES = new Set(["position", "normal", "uv"]);

/**
 * The `autoBatch` object form of the game config.
 *
 * `guard: "spread"` (default) checks a time-bounded slice of the merged sources each frame, so a
 * change the game makes to one is seen within `guardStaleFrames` frames, which the report states.
 * `guard: "everyFrame"` checks every source every frame: exact, and it costs what the report says.
 */
export interface IAutoBatchConfig {
  readonly guard?: "spread" | "everyFrame";
}

export interface IAutoBatchOptions extends IAutoBatchConfig {
  /** `false` is the named override: nothing merges, and the pass says so once. Default true. */
  readonly enabled?: boolean;
  /** The game's entities: the objects they hold are live props and keep their own draw. */
  readonly entities?: Registry;
  /** Where marker lines go. Default `console.info`. */
  readonly report?: (line: string) => void;
  /** Test seam for the settle window. */
  readonly settleFrames?: number;
}

/** What the pass has done, cumulative except the two scan counts, which describe the last scan. */
export interface IAutoBatchCensus {
  readonly enabled: boolean;
  /** Source meshes now drawn through a merged mesh. */
  readonly meshes: number;
  /** Merged meshes drawn for them. */
  readonly draws: number;
  /** Meshes kept out by `userData.batch = "off"` in the last scan. */
  readonly optedOut: number;
  /** Meshes that moved or changed while the scene settled in the last scan. */
  readonly unsettled: number;
  /** Sources given back after the game changed them. */
  readonly restored: number;
  /** Merges the engine refused; the meshes stay as authored. */
  readonly refused: number;
  /** Meshes kept out because a game entity holds them, in the last scan. */
  readonly heldByEntities: number;
  /** Frames a change to one merged source can go unseen: 1 when every source is checked each frame. */
  readonly guardStaleFrames: number;
}

interface IGroup {
  readonly merged: Mesh;
  readonly sources: IRecord[];
  live: number;
}

interface IRecord {
  readonly mesh: Mesh;
  readonly parent: Object3D | null;
  readonly material: Material;
  readonly geometry: BufferGeometry;
  readonly stamp: Float64Array;
  readonly group: IGroup;
  /** The source's vertices in the merged position buffer: [vertexStart, vertexStart + vertexCount). */
  readonly vertexStart: number;
  readonly vertexCount: number;
  out: boolean;
}

interface IAncestor {
  readonly parent: Object3D | null;
  readonly stamp: Float64Array;
  readonly records: IRecord[];
}

type State = "idle" | "quiet" | "watching";

const scratch = new Float64Array(SNAPSHOT_LENGTH);

/** Sources still drawn through a merged mesh, mapped to the group that draws them. */
const sourceGroups = new WeakMap<Object3D, IGroup>();

/** True while the engine draws `object` through a merged mesh and keeps it hidden. */
export function isAutoBatchSource(object: Object3D): boolean {
  return sourceGroups.has(object);
}

/** What a ray test needs to answer for a hidden source from its merged mesh. */
export interface IAutoBatchPick {
  readonly merged: Mesh;
  /** The authored source that owns merged vertex `vertex`, or `undefined` once it has come back. */
  sourceAt(vertex: number): Mesh | undefined;
}

/**
 * The merged mesh that draws `source` in its place, or `undefined` when it is drawn on its own.
 *
 * A picker asks this so a ray tests one merged mesh's hierarchy instead of every source's own, and
 * still names the authored mesh it hit.
 */
export function autoBatchOf(source: Object3D): IAutoBatchPick | undefined {
  const group = sourceGroups.get(source);
  if (group === undefined) return undefined;
  return { merged: group.merged, sourceAt: (vertex) => sourceAtVertex(group, vertex) };
}

function sourceAtVertex(group: IGroup, vertex: number): Mesh | undefined {
  const { sources } = group;
  let low = 0;
  let high = sources.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((sources[middle] as IRecord).vertexStart <= vertex) low = middle;
    else high = middle - 1;
  }
  const record = sources[low];
  return record === undefined || record.out ? undefined : record.mesh;
}

/** Merged meshes this pass made: a ray test skips them, because the authored sources answer it. */
const mergedMeshes = new WeakSet<object>();

export function isAutoBatchMerged(object: object): boolean {
  return mergedMeshes.has(object);
}

/**
 * Adds to one costly step by name in `globalThis.__tnEngineCost`, the bag a playtest reads per frame
 * (three-native reports it as TN_ENGINE_COST), so a kit that brings back a per-frame cost fails its bound.
 */
function countEngineCost(name: string, count: number): void {
  if (count === 0) return;
  const host = globalThis as { __tnEngineCost?: Record<string, number> };
  host.__tnEngineCost ??= {};
  host.__tnEngineCost[name] = (host.__tnEngineCost[name] ?? 0) + count;
}

/** Frames of guard cost averaged into the one `guard` marker line. */
const GUARD_REPORT_FRAMES = 120;

/** Position, rotation, scale, visibility, shadow and layer flags, and the manual matrix if any. */
function writeStamp(object: Object3D, into: Float64Array): void {
  const { position, quaternion, scale } = object;
  into[0] = position.x;
  into[1] = position.y;
  into[2] = position.z;
  into[3] = quaternion.x;
  into[4] = quaternion.y;
  into[5] = quaternion.z;
  into[6] = quaternion.w;
  into[7] = scale.x;
  into[8] = scale.y;
  into[9] = scale.z;
  into[10] = object.visible ? 1 : 0;
  into[11] = object.castShadow ? 1 : 0;
  into[12] = object.receiveShadow ? 1 : 0;
  into[13] = object.renderOrder;
  into[14] = object.layers.mask;
  into[15] = object.matrixAutoUpdate ? 0 : 1;
  // Clear the matrix slots too: `stampMatches` reuses one buffer, and a tail left by the last
  // object with its own matrix made a still parent read as moved.
  if (object.matrixAutoUpdate) {
    into.fill(0, 16);
    return;
  }
  const elements = object.matrix.elements;
  for (let element = 0; element < 16; element += 1) into[16 + element] = elements[element] ?? 0;
}

function stampMatches(object: Object3D, stamp: Float64Array): boolean {
  writeStamp(object, scratch);
  for (let at = 0; at < SNAPSHOT_LENGTH; at += 1) if (scratch[at] !== stamp[at]) return false;
  return true;
}

/** Each plain-three source's own `Layers`, kept while a view stands in for it. */
const ownLayers = new WeakMap<Object3D, Layers>();

/** Nonzero while core draws the world; only then does a plain-three source's view fail the layer test. */
let drawingWorld = 0;

/**
 * Runs core's world draw. On plain three a merged source is out of the renderer's layer test only in
 * here, so a game's own raycast or `layers.test` still finds it, as it did before the merge.
 */
export function drawWorld<T>(draw: () => T): T {
  drawingWorld += 1;
  try {
    return draw();
  } finally {
    drawingWorld -= 1;
  }
}

/**
 * Takes a merged source out of the draw, or puts it back, leaving every property the game reads as it was.
 * The engine hides it natively; on plain three, the renderer and shadow passes ask `layers.test(camera)`,
 * and a view whose `test` fails inside {@link drawWorld} and whose `mask` reads and writes the source's own
 * `Layers` hides it from that draw alone. A clone copies `mask`, so it copies the game's layers, not the hide.
 */
function setBatchHidden(mesh: Mesh, hidden: boolean): void {
  const engine = mesh as Mesh & { __tnBatchHidden?: boolean };
  if ("__tnBatchHidden" in engine) {
    engine.__tnBatchHidden = hidden;
    return;
  }
  if (!hidden) {
    const own = ownLayers.get(mesh);
    if (own !== undefined) mesh.layers = own;
    ownLayers.delete(mesh);
    return;
  }
  if (ownLayers.has(mesh)) return;
  const own = mesh.layers;
  ownLayers.set(mesh, own);
  mesh.layers = Object.create(Object.getPrototypeOf(own) as object, {
    mask: {
      get: () => own.mask,
      set: (mask: number) => {
        own.mask = mask;
      },
    },
    test: { value: (layers: Layers) => drawingWorld === 0 && own.test(layers) },
  }) as Layers;
}

function isMesh(object: Object3D): object is Mesh {
  return (object as Mesh).isMesh === true;
}

/** Whether the mesh is an ordinary opaque single-material draw the renderer owes nothing special. */
function plainDraw(mesh: Mesh): boolean {
  const flags = mesh as Mesh & {
    isInstancedMesh?: boolean;
    isBatchedMesh?: boolean;
    isSkinnedMesh?: boolean;
    customDepthMaterial?: unknown;
    customDistanceMaterial?: unknown;
  };
  if (flags.isInstancedMesh === true || flags.isBatchedMesh === true) return false;
  if (flags.isSkinnedMesh === true || mesh.userData.autoBatch !== undefined) return false;
  if (flags.customDepthMaterial != null || flags.customDistanceMaterial != null) return false;
  const material = mesh.material as Material | Material[];
  if (Array.isArray(material) || material.transparent || displacesVertices(material)) return false;
  return [mesh.onBeforeRender, mesh.onAfterRender].every(
    (hook) =>
      hook === Object3D.prototype.onBeforeRender ||
      hook === Object3D.prototype.onAfterRender ||
      isEngineRenderHook(hook),
  );
}

/** Whether baking the geometry into a merged buffer keeps every channel the draw reads. */
function bakeable(geometry: BufferGeometry): boolean {
  if (geometry.getAttribute("position") === undefined || hasMorphAttributes(geometry)) return false;
  if ((geometry as { indirect?: unknown }).indirect != null) return false;
  const range = geometry.drawRange;
  if (range.start !== 0 || Number.isFinite(range.count)) return false;
  for (const name in geometry.attributes) if (!ALLOWED_ATTRIBUTES.has(name)) return false;
  return true;
}

/**
 * Whether merging this mesh leaves the frame looking the same. A streamed coarse model stays out:
 * its full file replaces the geometry in place, and a merged copy would keep the coarse vertices.
 */
function mergeable(mesh: Mesh): boolean {
  return (
    plainDraw(mesh) &&
    bakeable(mesh.geometry) &&
    !isStreamedGeometry(mesh.geometry) &&
    mesh.matrixWorld.determinant() > 0
  );
}

/** Meshes with equal keys can share a merged mesh without changing how any of them draws. */
function flagKey(mesh: Mesh): string {
  const { geometry } = mesh;
  const uv = geometry.getAttribute("uv") === undefined ? 0 : 1;
  const normal = geometry.getAttribute("normal") === undefined ? 0 : 1;
  return `${mesh.castShadow}|${mesh.receiveShadow}|${mesh.layers.mask}|${mesh.renderOrder}|${mesh.frustumCulled}|${uv}${normal}`;
}

function countMeshes(root: Object3D): number {
  let count = 0;
  root.traverse((object) => {
    if (isMesh(object)) count += 1;
  });
  return count;
}

/** Objects the game's entities hold in their public fields, up to three levels deep. */
function heldObjects(entities: Registry | undefined): Set<Object3D> {
  const held = new Set<Object3D>();
  if (entities === undefined) return held;
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number): void => {
    if (typeof value !== "object" || value === null || seen.has(value) || seen.size > 20_000)
      return;
    seen.add(value);
    if ((value as Object3D).isObject3D === true) {
      held.add(value as Object3D);
      return;
    }
    if (depth === 0) return;
    for (const key of Object.keys(value)) visit((value as Record<string, unknown>)[key], depth - 1);
  };
  entities.forEach((_name, entity) => visit(entity, 3));
  return held;
}

export class AutoBatch {
  readonly #scene: Object3D;
  readonly #enabled: boolean;
  readonly #report: (line: string) => void;
  readonly #settleFrames: number;
  /** Objects that must never merge again: a source the game changed, an ancestor it moved. */
  readonly #excluded = new WeakSet<Object3D>();
  #records: IRecord[] = [];
  readonly #ancestors = new Map<Object3D, IAncestor>();
  /** The ancestors in the order the engine's guard watches them, so its indices name them. */
  #watchedAncestors: Object3D[] = [];
  #watched = new Map<Mesh, Float64Array>();
  #state: State = "idle";
  #known = Number.NaN;
  #seen = 0;
  #frames = 0;
  #announcedOff = false;
  #meshes = 0;
  #draws = 0;
  #optedOut = 0;
  #unsettled = 0;
  #restored = 0;
  #refused = 0;
  #guardMs = 0;
  #guardFrames = 0;
  #held = 0;
  #cursor = 0;
  #staleFrames = 1;
  readonly #entities: Registry | undefined;
  readonly #everyFrame: boolean;
  readonly #engine: IEngineGuard | undefined;
  /** Adds and removes counted at the scene's top two levels; see {@link AutoBatch.#shape}. */
  #shapeChanges = 0;
  /** Top-level children whose own `childadded` and `childremoved` are counted. */
  readonly #levelOne = new Set<Object3D>();
  /** Children added to or removed from the scene since the last frame, to start or stop counting. */
  #arrived: Object3D[] = [];
  /**
   * The subtrees a scan walks: what was added at the top two levels since the last finished scan, plus what an
   * earlier scan could not merge yet (a hidden subtree, a mesh that moved while watched, a mesh with no partner).
   * A scan costs what arrived and what still waits, never the scene: ten thrown objects a second re-walked the
   * stress lab's 5,000 nodes after every add and every remove, 4.1 ms of a 9.8 ms frame.
   * ponytail: a mesh with no partner is walked by every scan; index those by material when a scene holds thousands.
   */
  #pending = new Set<Object3D>();
  /** What the scan in progress met and left for the next one: hidden subtrees. */
  #later = new Set<Object3D>();
  readonly #onTopChild = (event: { type: string; child: Object3D }): void => {
    this.#shapeChanges += 1;
    this.#arrived.push(event.child);
    if (event.type === "childadded") this.#pending.add(event.child);
  };
  readonly #onChild = (event: { type: string; child: Object3D }): void => {
    this.#shapeChanges += 1;
    if (event.type === "childadded") this.#pending.add(event.child);
  };

  constructor(scene: Object3D, options: IAutoBatchOptions = {}) {
    this.#scene = scene;
    this.#enabled = options.enabled !== false;
    this.#report = options.report ?? ((line) => console.info(line));
    this.#settleFrames = options.settleFrames ?? SETTLE_FRAMES;
    this.#entities = options.entities;
    this.#everyFrame = options.guard === "everyFrame";
    this.#engine = engineGuardOf(scene);
    if (!this.#enabled) return;
    scene.addEventListener("childadded", this.#onTopChild);
    scene.addEventListener("childremoved", this.#onTopChild);
    this.#arrived = [...scene.children];
    this.#pending = new Set(this.#arrived);
  }

  get census(): IAutoBatchCensus {
    return {
      enabled: this.#enabled,
      meshes: this.#meshes,
      draws: this.#draws,
      optedOut: this.#optedOut,
      unsettled: this.#unsettled,
      restored: this.#restored,
      refused: this.#refused,
      heldByEntities: this.#held,
      guardStaleFrames: this.#staleFrames,
    };
  }

  /** Once per frame, before the scene is walked for drawing. */
  update(): void {
    if (!this.#enabled) {
      if (!this.#announcedOff) {
        this.#announcedOff = true;
        this.#report(
          `${AUTO_BATCH_MARKER}:${JSON.stringify({ enabled: false, override: "autoBatch: false" })}`,
        );
      }
      return;
    }
    this.#verify();
    const shape = this.#shape();
    if (this.#state === "idle") {
      if (shape === this.#known) return;
      this.#state = "quiet";
      this.#seen = shape;
      this.#frames = 0;
      return;
    }
    if (shape !== this.#seen) {
      this.#state = "quiet";
      this.#seen = shape;
      this.#frames = 0;
      return;
    }
    this.#frames += 1;
    if (this.#state === "quiet" && this.#frames >= QUIET_FRAMES) {
      this.#watched = this.#snapshot();
      this.#state = "watching";
      this.#frames = 0;
      if (this.#watched.size < 2) {
        // Nothing here can share a draw: the pass is finished until the scene's shape changes.
        this.#finish(this.#watched);
        this.#known = shape;
        this.#state = "idle";
      }
    } else if (this.#state === "watching" && this.#frames >= this.#settleFrames) {
      this.#settle();
    }
  }

  /**
   * Merges now, without waiting for the scene to hold still. For the caller that knows nothing has
   * moved yet: the first warm-up runs before any frame, so the merged meshes are what it compiles.
   * Anything that does move later is given back by the guard.
   */
  settleNow(): void {
    if (!this.#enabled) return;
    const meshes = this.#snapshot();
    if (meshes.size >= 2) this.#merge([...meshes.keys()]);
    this.#finish(meshes);
    this.#watchEngine();
    this.#known = this.#shape();
    this.#state = "idle";
  }

  /** Gives every source back and forgets the scene; the game is leaving it. */
  reset(): void {
    for (const record of this.#records) if (!record.out) this.#giveBack(record);
    this.#records = [];
    this.#ancestors.clear();
    this.#watchEngine();
    this.#watched.clear();
    this.#state = "idle";
    this.#known = Number.NaN;
    // The next scene's content arrives through the events; what stays under the scene is scanned once more.
    this.#pending = new Set(this.#scene.children);
  }

  /**
   * Changes when something is added to or removed from the scene's top two levels. three's own graph
   * events count it, so a still frame reads no `children` list: on the native engine each read wraps
   * every child across the bridge, and polling the shooter town's shape cost 10 ms a frame.
   */
  #shape(): number {
    for (const child of this.#arrived.splice(0)) {
      const top = child.parent === this.#scene;
      if (top === this.#levelOne.has(child)) continue;
      if (top) {
        child.addEventListener("childadded", this.#onChild);
        child.addEventListener("childremoved", this.#onChild);
        this.#levelOne.add(child);
      } else {
        child.removeEventListener("childadded", this.#onChild);
        child.removeEventListener("childremoved", this.#onChild);
        this.#levelOne.delete(child);
      }
    }
    return this.#shapeChanges;
  }

  /**
   * Eligible meshes under the pending subtrees, with the world matrix they were drawn at. Runs only while
   * the scene settles, so its reads are no game's steady cost and the bridge census leaves them out.
   */
  #snapshot(): Map<Mesh, Float64Array> {
    return unbilled(() => {
      const found = new Map<Mesh, Float64Array>();
      this.#optedOut = 0;
      this.#held = 0;
      this.#later = new Set();
      const held = heldObjects(this.#entities);
      const visit = (mesh: Mesh): void => {
        found.set(mesh, Float64Array.from(mesh.matrixWorld.elements));
      };
      for (const root of [...this.#pending]) {
        const off = this.#hangs(root, held);
        if (off === "gone") this.#pending.delete(root);
        else if (off === "wait") this.#later.add(root);
        else {
          root.updateWorldMatrix(true, true);
          this.#visit(root, off, held, visit);
        }
      }
      return found;
    });
  }

  /**
   * How a pending subtree hangs under the scene. `gone`: it left the scene, or a pending ancestor walks it.
   * `wait`: an ancestor is hidden, held or an LOD, which the game can change. Else whether an ancestor opted it out.
   */
  #hangs(root: Object3D, held: ReadonlySet<Object3D>): boolean | "gone" | "wait" {
    let off = false;
    let wait = false;
    for (let node = root.parent; node !== this.#scene; node = node.parent) {
      if (node === null || this.#excluded.has(node) || this.#pending.has(node)) return "gone";
      wait ||= !node.visible || (node as { isLOD?: boolean }).isLOD === true || held.has(node);
      off ||= node.userData.batch === "off";
    }
    return wait ? "wait" : off;
  }

  /**
   * Ends a scan: the next one walks what this one left (`#later`) and each mesh it found that no merge took.
   * A mesh that moved can come to rest, and a mesh with no partner can get one.
   */
  #finish(found: ReadonlyMap<Mesh, Float64Array>): void {
    this.#pending = this.#later;
    this.#later = new Set();
    for (const mesh of found.keys()) if (!sourceGroups.has(mesh)) this.#pending.add(mesh);
  }

  #visit(
    child: Object3D,
    off: boolean,
    held: ReadonlySet<Object3D>,
    visit: (mesh: Mesh) => void,
  ): void {
    if (!child.visible) {
      // Hidden now; the game can show it, so the next scan asks again.
      this.#later.add(child);
      return;
    }
    if (this.#excluded.has(child) || (child as { isLOD?: boolean }).isLOD === true) return;
    if (held.has(child)) {
      const parts = countMeshes(child);
      if (parts <= HELD_SUBTREE_MAX_MESHES) {
        this.#held += parts;
        return;
      }
    }
    const skip = off || child.userData.batch === "off";
    // A source already drawn by a merge is not walked into a second one: its `visible` stays true.
    if (isMesh(child) && !sourceGroups.has(child) && mergeable(child)) {
      if (skip) this.#optedOut += 1;
      else visit(child);
    }
    for (const part of child.children) this.#visit(part, skip, held, visit);
  }

  #settle(): void {
    const before = this.#watched;
    const stable = new Map<Mesh, Float64Array>();
    const now = this.#snapshot();
    let moved = 0;
    for (const [mesh, matrix] of now) {
      const earlier = before.get(mesh);
      if (earlier !== undefined && matrix.every((value, at) => value === earlier[at]))
        stable.set(mesh, matrix);
      else if (earlier !== undefined) moved += 1;
    }
    this.#unsettled = moved;
    this.#watched = new Map();
    this.#merge([...stable.keys()]);
    this.#finish(now);
    this.#watchEngine();
    this.#known = this.#shape();
    this.#state = "idle";
  }

  #merge(meshes: Mesh[]): void {
    const kinds = new Map<string, Map<Material, Mesh[]>>();
    for (const mesh of meshes) {
      const key = flagKey(mesh);
      const byMaterial = kinds.get(key) ?? new Map<Material, Mesh[]>();
      kinds.set(key, byMaterial);
      const material = mesh.material as Material;
      const list = byMaterial.get(material);
      if (list === undefined) byMaterial.set(material, [mesh]);
      else list.push(mesh);
    }
    const before = this.#draws;
    for (const byMaterial of kinds.values()) {
      const members = new Set<Mesh>();
      for (const list of byMaterial.values())
        if (list.length > 1) for (const mesh of list) members.add(mesh);
      if (members.size > 0) this.#mergeKind(members);
    }
    if (this.#draws === before && this.#refused === 0) return;
    this.#report(`${AUTO_BATCH_MARKER}:${JSON.stringify({ event: "merged", ...this.census })}`);
  }

  #mergeKind(members: Set<Mesh>): void {
    const first = members.values().next().value as Mesh;
    const groups: Array<{ merged: Mesh; sources: readonly Mesh[] }> = [];
    try {
      mergeByMaterial(this.#scene, {
        label: "autobatch",
        maxGroupVertices: MAX_GROUP_VERTICES,
        skip: (mesh) => !members.has(mesh),
        onGroup: (merged, sources) => groups.push({ merged, sources }),
      });
    } catch (error) {
      // A merge the baker refuses leaves the meshes as authored; the engine says why and moves on.
      for (const mesh of members) this.#excluded.add(mesh);
      this.#refused += 1;
      this.#report(
        `${AUTO_BATCH_MARKER}:${JSON.stringify({ event: "refused", reason: String(error) })}`,
      );
      return;
    }
    for (const { merged, sources } of groups) this.#adopt(merged, sources, first);
  }

  #adopt(merged: Mesh, sources: readonly Mesh[], flags: Mesh): void {
    merged.castShadow = flags.castShadow;
    merged.receiveShadow = flags.receiveShadow;
    merged.renderOrder = flags.renderOrder;
    merged.frustumCulled = flags.frustumCulled;
    merged.layers.mask = flags.layers.mask;
    merged.name = "autobatch";
    merged.userData.autoBatch = sources.length;
    mergedMeshes.add(merged);
    const deindexed = merged.geometry.index === null;
    const group: IGroup = { merged, sources: [], live: sources.length };
    let vertexStart = 0;
    for (const mesh of sources) {
      const { geometry } = mesh;
      const positions = geometry.getAttribute("position").count;
      const vertexCount = deindexed ? (geometry.index?.count ?? positions) : positions;
      const record: IRecord = {
        mesh,
        parent: mesh.parent,
        material: mesh.material as Material,
        geometry,
        stamp: new Float64Array(SNAPSHOT_LENGTH),
        group,
        vertexStart,
        vertexCount,
        out: false,
      };
      vertexStart += vertexCount;
      // The source stays where the game put it, so rays, `userData` and world matrices keep working.
      // Only the renderer is told not to draw it; `visible` stays the game's.
      setBatchHidden(mesh, true);
      writeStamp(mesh, record.stamp);
      group.sources.push(record);
      sourceGroups.set(mesh, group);
      this.#records.push(record);
      for (let node = mesh.parent; node !== null && node !== this.#scene; node = node.parent) {
        let entry = this.#ancestors.get(node);
        if (entry === undefined) {
          entry = { parent: node.parent, stamp: new Float64Array(SNAPSHOT_LENGTH), records: [] };
          writeStamp(node, entry.stamp);
          this.#ancestors.set(node, entry);
        }
        entry.records.push(record);
      }
    }
    this.#scene.add(merged);
    this.#meshes += sources.length;
    this.#draws += 1;
  }

  #verify(): void {
    if (this.#records.length === 0) return;
    const started = performance.now();
    let given = this.#checkAncestors();
    given += this.#checkSources(started);
    this.#guardMs += performance.now() - started;
    this.#guardFrames += 1;
    if (this.#guardFrames === GUARD_REPORT_FRAMES) {
      this.#report(
        `${AUTO_BATCH_MARKER}:${JSON.stringify({ event: "guard", frames: GUARD_REPORT_FRAMES, avgMs: this.#guardMs / GUARD_REPORT_FRAMES, ...this.census })}`,
      );
    }
    if (given === 0) return;
    this.#records = this.#records.filter((record) => !record.out);
    this.#cursor = 0;
    this.#watchEngine();
    this.#report(
      `${AUTO_BATCH_MARKER}:${JSON.stringify({ event: "restored", given, ...this.census })}`,
    );
  }

  /** Every frame, because there are few ancestors and one moved parent changes thousands of sources. */
  #checkAncestors(): number {
    let given = 0;
    const engine = this.#engine;
    if (engine?.__tnGuardCheckAncestors !== undefined) {
      const changed = engine.__tnGuardCheckAncestors();
      for (let at = 0; at < changed.length; at += 1) {
        const node = this.#watchedAncestors[changed[at] as number];
        if (node !== undefined) given += this.#giveBackUnder(node);
      }
      return given;
    }
    for (const [node, entry] of this.#ancestors) {
      if (node.parent === entry.parent && stampMatches(node, entry.stamp)) continue;
      given += this.#giveBackUnder(node);
    }
    return given;
  }

  /** An ancestor moved: it never merges again, and every source under it goes back to the game. */
  #giveBackUnder(node: Object3D): number {
    const entry = this.#ancestors.get(node);
    if (entry === undefined) return 0;
    let given = 0;
    this.#excluded.add(node);
    this.#ancestors.delete(node);
    for (const record of entry.records) {
      if (record.out) continue;
      this.#giveBack(record);
      given += 1;
    }
    return given;
  }

  /**
   * Hands the engine's guard the sources as they are now. It runs in the same frame as each merge
   * and each give-back, so no game code runs between the state merged and the state watched.
   */
  #watchEngine(): void {
    if (this.#engine === undefined) return;
    this.#watchedAncestors = [...this.#ancestors.keys()];
    this.#engine.__tnGuardWatch(
      this.#records.map((record) => record.mesh),
      this.#watchedAncestors,
    );
  }

  /** A slice of the sources bounded by {@link GUARD_BUDGET_MS}, or all of them under `everyFrame`. */
  #checkSources(started: number): number {
    if (this.#engine !== undefined) return this.#checkInEngine(this.#engine, started);
    const records = this.#records;
    let given = 0;
    let checked = 0;
    while (checked < records.length) {
      const record = records[this.#cursor] as IRecord;
      this.#cursor = (this.#cursor + 1) % records.length;
      checked += 1;
      if (record.out) continue;
      const { mesh } = record;
      if (
        mesh.parent !== record.parent ||
        mesh.material !== record.material ||
        mesh.geometry !== record.geometry ||
        !stampMatches(mesh, record.stamp)
      ) {
        this.#giveBack(record);
        given += 1;
      }
      if (
        !this.#everyFrame &&
        (checked & 15) === 0 &&
        performance.now() - started > GUARD_BUDGET_MS
      )
        break;
    }
    this.#staleFrames = Math.ceil(records.length / Math.max(1, checked));
    countEngineCost("autoBatchJsSourceChecks", checked);
    return given;
  }

  /**
   * {@link #checkSources} on the engine, compared where the state lives. A whole lap fits the budget
   * there, but a frame need not pay for it: `spread` checks one lap per settle window, so a change is
   * seen within the frames the merge waited to call the mesh still, under the same budget.
   */
  #checkInEngine(engine: IEngineGuard, started: number): number {
    const records = this.#records;
    const lap = this.#everyFrame
      ? records.length
      : Math.ceil(records.length / Math.max(1, this.#settleFrames));
    let given = 0;
    let checked = 0;
    while (checked < lap) {
      const limit = this.#everyFrame ? lap : Math.min(ENGINE_GUARD_CHUNK, lap - checked);
      const changed = engine.__tnGuardCheck(limit);
      for (let at = 0; at < changed.length; at += 1) {
        const record = records[changed[at] as number];
        if (record === undefined || record.out) continue;
        this.#giveBack(record);
        given += 1;
      }
      checked += limit;
      if (!this.#everyFrame && performance.now() - started > GUARD_BUDGET_MS) break;
    }
    this.#staleFrames = Math.ceil(records.length / Math.max(1, checked));
    return given;
  }

  /** The game changed this source: draw it on its own again and collapse its triangles in the merge. */
  #giveBack(record: IRecord): void {
    if (record.out) return;
    record.out = true;
    sourceGroups.delete(record.mesh);
    this.#excluded.add(record.mesh);
    this.#restored += 1;
    this.#meshes -= 1;
    // Drawn on its own again, as the game now has it: a source the game hid stays hidden.
    setBatchHidden(record.mesh, false);
    const { group } = record;
    group.live -= 1;
    if (group.live > 0) this.#collapse(record);
    if (group.live > 0 || group.merged.parent === null) return;
    group.merged.removeFromParent();
    group.merged.geometry.dispose();
    this.#draws -= 1;
  }

  /**
   * Every vertex of the source goes to the origin, so its triangles have no area and draw nothing.
   * The index is left alone: a picker's hierarchy may have reordered it, but vertices stay put.
   * A group with no source left skips this, because its geometry is disposed in the same call and a
   * queued upload would name a buffer that no longer exists.
   */
  #collapse(record: IRecord): void {
    const position = record.group.merged.geometry.getAttribute("position");
    (position.array as Float32Array).fill(
      0,
      record.vertexStart * position.itemSize,
      (record.vertexStart + record.vertexCount) * position.itemSize,
    );
    position.needsUpdate = true;
  }
}
