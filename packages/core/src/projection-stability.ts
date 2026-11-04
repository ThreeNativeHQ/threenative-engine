import type { BufferGeometry, Material, Object3D, Scene } from "three";

import {
  type IProjectionExactEntry,
  type IProjectionScanResult,
  displacesVertices,
  geometryVersionSum,
  hasMorphAttributes,
  hasRenderHook,
  isLight,
  isRenderable,
} from "./projection-plan.js";
import type { ProjectionExactReason } from "./renderProjection.js";

/**
 * The proof that a frame's classification is the one the last frame already derived.
 *
 * The scan is a pure function of the scene's **structure** and reads no world matrix: membership,
 * each renderable's geometry, material and batching flags, its own and inherited visibility, and
 * the lane predicates over that geometry and material. Every one of those can change at any time,
 * so a frame may only skip the scan after proving the inputs are identical — and "identical" is
 * checkable cheaply, because a changed input has to show up as a changed *value*.
 *
 * So this keeps what the last scan read, in the order the scan read it, and compares. The
 * comparison is deliberately dumber than the classification: it reads the same fields the
 * predicates read and compares them, where re-running the predicates would cost what the skip is
 * for. Each distinct material and geometry is compared once per frame rather than once per object
 * that shares it, because those values are per-material and per-geometry — that is what makes a
 * 4,096-mesh scene cost a handful of extra reads instead of four thousand.
 *
 * What a move is *not*: the matrices. An object that animates every frame is still the same object
 * in the same group, so its matrix moving is not a reason to classify it again — the mirror's apply
 * writes that matrix into the baked draw every frame regardless, which is where a move belongs.
 *
 * A skip is only ever a *skip of the classification*. Everything the renderer is handed — batch
 * slots, stand-ins, mirrored lights, retirement — is still rebuilt by the apply seam each frame, so
 * a wrong answer here costs a re-scan and never a wrong picture.
 */

/** One renderable's structure: every scan input a transform cannot change. */
interface IWatchedRenderable {
  geometry: BufferGeometry | undefined;
  material: Material | Material[] | undefined;
  customDepthMaterial: unknown;
  customDistanceMaterial: unknown;
  layersMask: number;
  renderOrder: number;
  /** The class flags, the render hook, the batching flags and own visibility, as one number. */
  kind: number;
  /** Whether the game wants this drawn, ancestors included. */
  visible: boolean;
}

/** One distinct material's lane predicates, compared once a frame however many objects share it. */
interface IWatchedMaterial {
  material: Material;
  lane: number;
}

/** One distinct geometry's lane predicates plus the version sum the material lane watches. */
interface IWatchedGeometry {
  geometry: BufferGeometry;
  lane: number;
  version: number;
}

const KIND_LIGHT = 1;
const KIND_LOD = 2;
const KIND_RENDERABLE = 4;
const KIND_SKINNED = 8;
const KIND_INSTANCED = 16;
const KIND_BATCHED_SOURCE = 32;
const KIND_HOOK = 64;
const KIND_CAST_SHADOW = 128;
const KIND_RECEIVE_SHADOW = 256;
const KIND_FRUSTUM_CULLED = 512;
const KIND_VISIBLE = 1_024;

const MATERIAL_MULTI = 1;
const MATERIAL_TRANSPARENT = 2;
const MATERIAL_DISPLACED = 4;

const GEOMETRY_NO_POSITION = 1;
const GEOMETRY_INDIRECT = 2;
const GEOMETRY_MORPH = 4;
const GEOMETRY_DRAW_RANGE = 8;

type ProjectionCandidate = Object3D & {
  isInstancedMesh?: boolean;
  isBatchedMesh?: boolean;
  isSkinnedMesh?: boolean;
  geometry?: BufferGeometry;
  material?: Material | Material[];
  customDepthMaterial?: unknown;
  customDistanceMaterial?: unknown;
  renderOrder?: number;
  castShadow?: boolean;
  receiveShadow?: boolean;
  frustumCulled?: boolean;
  layers: { mask: number };
};

function kindOf(object: Object3D): number {
  const candidate = object as ProjectionCandidate;
  let kind = 0;
  if (isLight(object)) kind |= KIND_LIGHT;
  if ((object as { isLOD?: boolean }).isLOD === true) kind |= KIND_LOD;
  if (isRenderable(object)) {
    kind |= KIND_RENDERABLE;
    if (candidate.isSkinnedMesh === true) kind |= KIND_SKINNED;
    if (candidate.isInstancedMesh === true) kind |= KIND_INSTANCED;
    if (candidate.isBatchedMesh === true) kind |= KIND_BATCHED_SOURCE;
    if (candidate.castShadow === true) kind |= KIND_CAST_SHADOW;
    if (candidate.receiveShadow === true) kind |= KIND_RECEIVE_SHADOW;
    if (candidate.frustumCulled === true) kind |= KIND_FRUSTUM_CULLED;
    if (object.visible) kind |= KIND_VISIBLE;
  }
  if (hasRenderHook(object)) kind |= KIND_HOOK;
  return kind;
}

function materialLane(material: Material | Material[] | undefined): number {
  if (material === undefined) return 0;
  if (Array.isArray(material)) return MATERIAL_MULTI;
  return (
    (material.transparent === true ? MATERIAL_TRANSPARENT : 0) |
    (displacesVertices(material) ? MATERIAL_DISPLACED : 0)
  );
}

function geometryLane(geometry: BufferGeometry | undefined): number {
  if (geometry === undefined) return 0;
  let lane = 0;
  if (geometry.attributes.position === undefined) lane |= GEOMETRY_NO_POSITION;
  if ((geometry as { indirect?: unknown }).indirect != null) lane |= GEOMETRY_INDIRECT;
  if (hasMorphAttributes(geometry)) lane |= GEOMETRY_MORPH;
  const range = geometry.drawRange;
  if (range !== undefined && (range.start !== 0 || Number.isFinite(range.count)))
    lane |= GEOMETRY_DRAW_RANGE;
  return lane;
}

/**
 * A host whose objects live outside the script engine can hash what the scan reads from them (the
 * walk order, visibility, and each mesh's geometry, material, flags, render order and layers) in
 * one call instead of one read per field per object. three has no such method.
 */
function hostStamp(source: Scene): number | undefined {
  const stamp = (source as { __tnStructureStamp?: () => number }).__tnStructureStamp;
  return typeof stamp === "function" ? stamp.call(source) : undefined;
}

export class ProjectionStability {
  /** Every node the last scan visited, in visit order: add, remove and reparent all move one. */
  readonly #nodes: Array<Object3D | undefined> = [];
  #nodeCount = 0;
  readonly #watched: Array<IWatchedRenderable | undefined> = [];
  #watchedCount = 0;
  /** The renderables behind `#watched`, same order, for the checks a host stamp cannot cover. */
  readonly #watchedObjects: Array<Object3D | undefined> = [];
  /** The host's structure stamp when the last scan was recorded; undefined where there is none. */
  #stamp: number | undefined;
  readonly #materials: IWatchedMaterial[] = [];
  readonly #geometries: IWatchedGeometry[] = [];
  readonly #materialSet = new Set<Material>();
  readonly #geometrySet = new Set<BufferGeometry>();
  readonly #stack: Array<Object3D | undefined> = [];
  /** Inherited visibility per stack slot, so a walk carries it down instead of walking back up. */
  readonly #stackVisible: boolean[] = [];
  readonly #exactObjects: Array<Object3D | undefined> = [];
  readonly #exactReasons: ProjectionExactReason[] = [];
  readonly #exact: Array<IProjectionExactEntry | undefined> = [];
  #exactCount = 0;

  /** Renderables the last scan classified, for a diagnostic. */
  get watchedCount(): number {
    return this.#watchedCount;
  }

  /** Distinct materials the last scan read — the list `holds` walks. It must describe the scene,
   * never the number of scans run, so a spec pins it. */
  get watchedMaterialCount(): number {
    return this.#materials.length;
  }

  /** Distinct geometries the last scan read. Same contract as {@link watchedMaterialCount}. */
  get watchedGeometryCount(): number {
    return this.#geometries.length;
  }

  /**
   * The exact lane the last scan classified, repooled for this frame's apply.
   *
   * The mirror clears the entries it is handed once it has applied them, so the objects and reasons
   * are held here and the pool is refilled per frame rather than handed over once.
   */
  exactLane(): { entries: readonly IProjectionExactEntry[]; count: number } {
    for (let index = 0; index < this.#exactCount; index += 1) {
      let entry = this.#exact[index];
      if (entry === undefined) {
        entry = { object: undefined, reason: "unsupportedGeometry" };
        this.#exact.push(entry);
      }
      entry.object = this.#exactObjects[index];
      entry.reason = this.#exactReasons[index] as ProjectionExactReason;
      this.#exact[index] = entry;
    }
    return { entries: this.#exact as readonly IProjectionExactEntry[], count: this.#exactCount };
  }

  /** Records the structure a scan just classified, so a later frame can prove it unchanged. */
  record(source: Scene, scan: IProjectionScanResult): void {
    this.#materialSet.clear();
    this.#geometrySet.clear();
    // The lists hold what *this* scan read, exactly like `#nodes` and `#watched`: without this every
    // re-record appends another copy of the scene's materials and geometries and `holds()` pays for
    // the log, not the scene.
    this.#materials.length = 0;
    this.#geometries.length = 0;
    const nodes = this.#nodes;
    const stack = this.#stack;
    const stackVisible = this.#stackVisible;
    let depth = 0;
    let visited = 0;
    let watched = 0;
    const roots = source.children;
    for (let index = roots.length - 1; index >= 0; index -= 1) {
      stack[depth] = roots[index] as Object3D;
      stackVisible[depth] = true;
      depth += 1;
    }
    while (depth > 0) {
      depth -= 1;
      const object = stack[depth] as Object3D;
      const visibleInWorld = stackVisible[depth] === true;
      stack[depth] = undefined;
      nodes[visited] = object;
      visited += 1;
      const kind = kindOf(object);
      if ((kind & KIND_RENDERABLE) !== 0) {
        const candidate = object as ProjectionCandidate;
        const geometry = candidate.geometry;
        const material = candidate.material;
        let watch = this.#watched[watched];
        if (watch === undefined) {
          watch = {
            geometry: undefined,
            material: undefined,
            customDepthMaterial: undefined,
            customDistanceMaterial: undefined,
            layersMask: 0,
            renderOrder: 0,
            kind: 0,
            visible: true,
          };
          this.#watched[watched] = watch;
        }
        this.#watchedObjects[watched] = object;
        watch.geometry = geometry;
        watch.material = material;
        watch.customDepthMaterial = candidate.customDepthMaterial;
        watch.customDistanceMaterial = candidate.customDistanceMaterial;
        watch.layersMask = candidate.layers.mask;
        watch.renderOrder = candidate.renderOrder ?? 0;
        watch.kind = kind;
        watch.visible = visibleInWorld;
        watched += 1;
        if (geometry !== undefined && !this.#geometrySet.has(geometry)) {
          this.#geometrySet.add(geometry);
          this.#geometries.push({
            geometry,
            lane: geometryLane(geometry),
            version: geometryVersionSum(geometry),
          });
        }
        if (
          material !== undefined &&
          !Array.isArray(material) &&
          !this.#materialSet.has(material)
        ) {
          this.#materialSet.add(material);
          this.#materials.push({ material, lane: materialLane(material) });
        }
      }
      if ((kind & (KIND_LIGHT | KIND_LOD)) !== 0) continue;
      const childVisible = visibleInWorld && object.visible;
      const children = object.children;
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack[depth] = children[index] as Object3D;
        stackVisible[depth] = childVisible;
        depth += 1;
      }
    }
    for (let index = depth; index < stack.length; index += 1) stack[index] = undefined;
    for (let index = watched; index < this.#watched.length; index += 1) {
      this.#watched[index] = undefined;
      this.#watchedObjects[index] = undefined;
    }
    this.#stamp = hostStamp(source);
    this.#nodeCount = visited;
    this.#watchedCount = watched;
    for (let index = 0; index < scan.exactLaneCount; index += 1) {
      const entry = scan.exactLane[index] as IProjectionExactEntry;
      this.#exactObjects[index] = entry.object;
      this.#exactReasons[index] = entry.reason;
    }
    this.#exactCount = scan.exactLaneCount;
  }

  /**
   * True when nothing the scan reads has changed since {@link record}.
   *
   * False is always the safe answer: it costs one scan, which is what this frame would have paid
   * anyway. True is a claim, and every input the classification reads is compared here.
   */
  holds(source: Scene): boolean {
    if (this.#nodeCount === 0) return false;
    for (let index = 0; index < this.#materials.length; index += 1) {
      const watched = this.#materials[index] as IWatchedMaterial;
      if (watched.lane !== materialLane(watched.material)) return false;
    }
    for (let index = 0; index < this.#geometries.length; index += 1) {
      const watched = this.#geometries[index] as IWatchedGeometry;
      if (watched.lane !== geometryLane(watched.geometry)) return false;
      if (watched.version !== geometryVersionSum(watched.geometry)) return false;
    }
    // A host that can hash everything the engine owns answers in one call. The walk below is for a
    // host that cannot, and for any mismatch, since only the walk says whether a mismatch matters.
    if (this.#stamp !== undefined && hostStamp(source) === this.#stamp && this.#scriptStateHolds())
      return true;
    const stack = this.#stack;
    const stackVisible = this.#stackVisible;
    const nodes = this.#nodes;
    let depth = 0;
    let visited = 0;
    let watched = 0;
    const roots = source.children;
    for (let index = roots.length - 1; index >= 0; index -= 1) {
      stack[depth] = roots[index] as Object3D;
      stackVisible[depth] = true;
      depth += 1;
    }
    while (depth > 0) {
      depth -= 1;
      const object = stack[depth] as Object3D;
      const visibleInWorld = stackVisible[depth] === true;
      stack[depth] = undefined;
      if (nodes[visited] !== object) return false;
      visited += 1;
      const kind = kindOf(object);
      if ((kind & KIND_RENDERABLE) === 0) {
        if ((kind & (KIND_LIGHT | KIND_LOD)) !== 0) continue;
        const childVisible = visibleInWorld && object.visible;
        const children = object.children;
        for (let index = children.length - 1; index >= 0; index -= 1) {
          stack[depth] = children[index] as Object3D;
          stackVisible[depth] = childVisible;
          depth += 1;
        }
        continue;
      }
      const watch = this.#watched[watched];
      if (watch === undefined) return false;
      const candidate = object as ProjectionCandidate;
      if (
        watch.geometry !== candidate.geometry ||
        watch.material !== candidate.material ||
        watch.customDepthMaterial !== candidate.customDepthMaterial ||
        watch.customDistanceMaterial !== candidate.customDistanceMaterial ||
        watch.layersMask !== candidate.layers.mask ||
        watch.renderOrder !== (candidate.renderOrder ?? 0) ||
        watch.kind !== kind ||
        watch.visible !== visibleInWorld
      )
        return false;
      watched += 1;
      if ((kind & (KIND_LIGHT | KIND_LOD)) !== 0) continue;
      const childVisible = visibleInWorld && object.visible;
      const children = object.children;
      for (let index = children.length - 1; index >= 0; index -= 1) {
        stack[depth] = children[index] as Object3D;
        stackVisible[depth] = childVisible;
        depth += 1;
      }
    }
    return visited === this.#nodeCount && watched === this.#watchedCount;
  }

  /** The scan inputs that live on the script object rather than in the engine: no stamp sees them. */
  #scriptStateHolds(): boolean {
    for (let index = 0; index < this.#watchedCount; index += 1) {
      const watch = this.#watched[index] as IWatchedRenderable;
      const candidate = this.#watchedObjects[index] as ProjectionCandidate;
      if (
        watch.customDepthMaterial !== candidate.customDepthMaterial ||
        watch.customDistanceMaterial !== candidate.customDistanceMaterial ||
        hasRenderHook(candidate) !== ((watch.kind & KIND_HOOK) !== 0)
      )
        return false;
    }
    return true;
  }

  /** Forgets the recorded structure, releasing the game objects it was holding. */
  clear(): void {
    for (let index = 0; index < this.#nodeCount; index += 1) this.#nodes[index] = undefined;
    for (let index = 0; index < this.#watchedCount; index += 1) {
      this.#watched[index] = undefined;
      this.#watchedObjects[index] = undefined;
    }
    this.#stamp = undefined;
    for (let index = 0; index < this.#exactCount; index += 1) {
      this.#exactObjects[index] = undefined;
      const entry = this.#exact[index];
      if (entry !== undefined) entry.object = undefined;
    }
    this.#nodeCount = 0;
    this.#watchedCount = 0;
    this.#exactCount = 0;
    this.#materials.length = 0;
    this.#geometries.length = 0;
    this.#materialSet.clear();
    this.#geometrySet.clear();
  }
}
