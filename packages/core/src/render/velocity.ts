import type { BatchedMesh, Matrix4, Object3D, RenderTarget, SkinnedMesh } from "three";
import { context, mrt, output, velocity } from "three/tsl";
import type { MRTNode, Node, TextureNode } from "three/webgpu";

import {
  disposeBatchedMeshVelocity,
  ensureBatchedMeshVelocity,
  setBatchedMeshPreviousMatrices,
} from "./batched-velocity.js";

/** The output name shared by the scene pass and temporal consumers. */
export const VELOCITY_OUTPUT_NAME = "velocity";

/**
 * The pass surface needed to add and read the shared screen-space output.
 *
 * Keeping this structural lets the same seam work with Three's `PassNode` and a native adapter
 * without making the game depend on either implementation.
 */
export interface IVelocityRenderPass {
  /** Physical attachments on Three passes; structural adapters may own them elsewhere. */
  readonly renderTarget?: Pick<RenderTarget, "textures" | "dispose">;
  getMRT(): MRTNode | null;
  getTextureNode(name?: string): Node;
  setMRT(value: MRTNode | null): unknown;
}

/** The symbol read by the patched Three.js instance accessor. */
export const VELOCITY_PREVIOUS_INSTANCE_MATRICES = Symbol.for(
  "threenative.velocity.previousInstanceMatrices",
);
/** The symbol read by the patched Three.js velocity accessor for rigid history. */
export const VELOCITY_PREVIOUS_WORLD_MATRIX = Symbol.for(
  "threenative.velocity.previousWorldMatrix",
);
/** The symbol read by the patched Three.js skinning accessor for bone history. */
export const VELOCITY_PREVIOUS_BONE_MATRICES = Symbol.for(
  "threenative.velocity.previousBoneMatrices",
);

const VELOCITY_PREVIOUS_BIND_MATRIX_INVERSE = Symbol.for(
  "threenative.velocity.previousBindMatrixInverse",
);

interface IInstanceMatrixSource {
  instanceMatrix?: { array: ArrayLike<number>; version?: number };
}

interface IBatchedMatrixSource {
  isBatchedMesh?: boolean;
  _matricesTexture?: { image?: { data?: ArrayLike<number> } } | null;
  _previousMatricesTexture?: unknown;
}

interface IVelocityObject {
  userData: Record<string, unknown>;
  [VELOCITY_PREVIOUS_INSTANCE_MATRICES]?: Float32Array;
  [VELOCITY_PREVIOUS_WORLD_MATRIX]?: Matrix4;
  [VELOCITY_PREVIOUS_BONE_MATRICES]?: Float32Array;
  [VELOCITY_PREVIOUS_BIND_MATRIX_INVERSE]?: Matrix4;
}

interface ITrackedSkeleton {
  boneMatrices: ArrayLike<number>;
  update(): unknown;
}

interface IOriginalVelocityFlag {
  readonly present: boolean;
  readonly value: unknown;
}

/**
 * Adds the velocity output to a scene pass without creating its texture until it is read.
 *
 * The existing outputs remain intact. A pass with no prior MRT receives the normal colour output
 * as well, so adding history does not remove the frame's visible colour.
 * @situation add a velocity target before a temporal stage consumes a scene pass
 * @constraint call only when a temporal stage is active
 */
export function ensureVelocityOutput(pass: IVelocityRenderPass): MRTNode {
  const current = pass.getMRT();
  if (current?.has(VELOCITY_OUTPUT_NAME)) return current;
  const added = mrt({ [VELOCITY_OUTPUT_NAME]: velocity });
  const next =
    current === null ? mrt({ output, [VELOCITY_OUTPUT_NAME]: velocity }) : current.merge(added);
  pass.setMRT(next);
  return next;
}

/**
 * Returns the velocity texture node after ensuring the pass writes it.
 * @situation read screen-space motion for a temporal stage
 */
export function velocityTexture(pass: IVelocityRenderPass): Node {
  ensureVelocityOutput(pass);
  const node = pass.getTextureNode(VELOCITY_OUTPUT_NAME);
  const target = pass.renderTarget;
  const texture = (node as TextureNode).value;
  // PassNode caches texture nodes after a chain detaches their physical attachment.
  if (target !== undefined && texture?.isTexture === true && !target.textures.includes(texture))
    target.textures.push(texture);
  return node;
}

/**
 * Gives a composed TSL graph the velocity source used by temporal nodes.
 * Plain game values are returned unchanged, which keeps the chain's diagnostic seam lightweight.
 * @situation hand the provisioned velocity source through a composed temporal graph
 */
export function withVelocityContext<T>(node: T, source: Node): T {
  if (!isNode(node)) return node;
  return context(node, { velocity: source }) as T;
}

/**
 * Captures instance matrices at the framework's pre-render boundary and enables previous data on
 * every renderable in the graph. The previous snapshot is never the array the game writes next.
 * @situation retain previous transforms for animated and instanced renderables
 * @constraint call `update()` after gameplay writes and `commit()` after the render
 */
export class VelocityTracker {
  readonly #originalFlags = new Map<Object3D, IOriginalVelocityFlag>();
  readonly #instanceSnapshots = new Map<Object3D, Float32Array>();
  readonly #worldSnapshots = new Map<Object3D, Matrix4>();
  readonly #bindInverseSnapshots = new Map<Object3D, Matrix4>();
  readonly #boneSnapshots = new Map<ITrackedSkeleton, Float32Array>();
  // The previous frame's buffers, written at the next commit. The snapshot scheduled for the frame
  // that just rendered stays untouched until `update` replaces it, and steady state allocates nothing.
  readonly #spareInstances = new Map<Object3D, Float32Array>();
  readonly #spareWorlds = new Map<Object3D, Matrix4>();
  readonly #spareBones = new Map<ITrackedSkeleton, Float32Array>();
  /** `instanceMatrix.version` at the last commit: an unchanged mesh's history already equals it. */
  readonly #instanceVersions = new Map<Object3D, number>();
  readonly #ownedBatchedMeshes = new Set<BatchedMesh>();
  readonly #active = new Set<Object3D>();
  #updatedRoot: Object3D | undefined;

  /** Schedule the committed snapshot that the current colour and velocity frame must read. */
  update(root: Object3D): void {
    this.#updatedRoot = root;
    root.updateMatrixWorld(true);
    const seen = new Set<Object3D>();
    const seenSkeletons = new Set<ITrackedSkeleton>();
    root.traverse((object) => {
      if (!isVelocityRenderable(object)) return;
      seen.add(object);
      this.enable(object);
      this.captureWorld(object);
      const skeleton = getSkeleton(object);
      if (skeleton !== undefined) {
        if (!seenSkeletons.has(skeleton)) {
          skeleton.update();
          seenSkeletons.add(skeleton);
        }
        this.captureBones(object, skeleton);
        (object as IVelocityObject)[VELOCITY_PREVIOUS_BIND_MATRIX_INVERSE] =
          this.#bindInverseSnapshots.get(object) ??
          (object as SkinnedMesh).bindMatrixInverse.clone();
      } else {
        Reflect.deleteProperty(object, VELOCITY_PREVIOUS_BONE_MATRICES);
        Reflect.deleteProperty(object, VELOCITY_PREVIOUS_BIND_MATRIX_INVERSE);
        this.#bindInverseSnapshots.delete(object);
      }
      this.captureInstance(object);
    });

    for (const object of this.#active) {
      if (seen.has(object)) continue;
      this.restore(object);
      this.#active.delete(object);
    }
    for (const skeleton of this.#boneSnapshots.keys()) {
      if (!seenSkeletons.has(skeleton)) {
        this.#boneSnapshots.delete(skeleton);
        this.#spareBones.delete(skeleton);
      }
    }
    for (const object of seen) this.#active.add(object);
  }

  /** Commit transforms after the renderer has consumed the scheduled velocity frame. */
  commit(root: Object3D): void {
    if (this.#updatedRoot !== root) return;
    root.updateMatrixWorld(true);
    const seen = new Set<Object3D>();
    const seenSkeletons = new Set<ITrackedSkeleton>();
    root.traverse((object) => {
      if (!this.#active.has(object) || !isVelocityRenderable(object)) return;
      seen.add(object);
      const spare = this.#spareWorlds.get(object);
      const scheduled = this.#worldSnapshots.get(object);
      if (scheduled) this.#spareWorlds.set(object, scheduled);
      this.#worldSnapshots.set(
        object,
        spare ? spare.copy(object.matrixWorld) : object.matrixWorld.clone(),
      );
      const skeleton = getSkeleton(object);
      if (skeleton !== undefined) {
        this.#bindInverseSnapshots.set(object, (object as SkinnedMesh).bindMatrixInverse.clone());
        if (!seenSkeletons.has(skeleton)) {
          skeleton.update();
          seenSkeletons.add(skeleton);
          rotate(this.#boneSnapshots, this.#spareBones, skeleton, skeleton.boneMatrices);
        }
      }
      this.commitInstance(object);
    });
    for (const object of this.#active) {
      if (seen.has(object)) continue;
      this.restore(object);
      this.#active.delete(object);
    }
  }

  /** Restore caller-owned flags and release all retained frame snapshots. */
  clear(): void {
    for (const object of this.#active) this.restore(object);
    this.#active.clear();
    this.#originalFlags.clear();
    this.#instanceSnapshots.clear();
    this.#worldSnapshots.clear();
    this.#bindInverseSnapshots.clear();
    this.#boneSnapshots.clear();
    this.#spareInstances.clear();
    this.#instanceVersions.clear();
    this.#spareWorlds.clear();
    this.#spareBones.clear();
    this.#updatedRoot = undefined;
  }

  private enable(object: Object3D): void {
    if (!this.#originalFlags.has(object)) {
      this.#originalFlags.set(object, {
        present: Object.hasOwn(object.userData, "useVelocity"),
        value: object.userData.useVelocity,
      });
    }
    object.userData.useVelocity = true;
  }

  private captureWorld(object: Object3D): void {
    const previous = this.#worldSnapshots.get(object);
    const scheduledPrevious = previous ?? object.matrixWorld.clone();
    (object as IVelocityObject)[VELOCITY_PREVIOUS_WORLD_MATRIX] = scheduledPrevious;
  }

  private captureBones(object: Object3D, skeleton: ITrackedSkeleton): void {
    const current = skeleton.boneMatrices;
    const previous = this.#boneSnapshots.get(skeleton);
    const scheduledPrevious = previous?.length === current.length ? previous : copyArray(current);
    (object as IVelocityObject)[VELOCITY_PREVIOUS_BONE_MATRICES] = scheduledPrevious;
  }

  private captureInstance(object: Object3D): void {
    const batch = getBatchedMesh(object);
    if (batch !== undefined) {
      this.captureBatch(object, batch);
      return;
    }
    if ((object as Object3D & { isInstancedMesh?: boolean }).isInstancedMesh !== true) return;
    const source = object as Object3D & IInstanceMatrixSource;
    const current = source.instanceMatrix?.array;
    if (current === undefined) return;

    const previous = this.#instanceSnapshots.get(object);
    const scheduledPrevious = previous?.length === current.length ? previous : copyArray(current);
    (object as IVelocityObject)[VELOCITY_PREVIOUS_INSTANCE_MATRICES] = scheduledPrevious;
  }

  private captureBatch(object: Object3D, batch: BatchedMesh): void {
    const current = batchedMatrixData(batch);
    if (current === undefined) return;
    if (!hasBatchedPreviousMatrices(batch)) {
      ensureBatchedMeshVelocity(batch);
      this.#ownedBatchedMeshes.add(batch);
    }

    const previous = this.#instanceSnapshots.get(object);
    const scheduledPrevious = previous?.length === current.length ? previous : copyArray(current);
    (object as IVelocityObject)[VELOCITY_PREVIOUS_INSTANCE_MATRICES] = scheduledPrevious;
    // A material-batching projection already owns and advances this texture per sub-draw. Direct
    // tracker users reach the branch above that creates it, so only those textures are written
    // here; two owners would race and erase the projection's source-to-slot history.
    if (this.#ownedBatchedMeshes.has(batch))
      setBatchedMeshPreviousMatrices(batch, scheduledPrevious);
  }

  private commitInstance(object: Object3D): void {
    const batch = getBatchedMesh(object);
    const matrices =
      batch === undefined ? (object as Object3D & IInstanceMatrixSource).instanceMatrix : undefined;
    const current = batch === undefined ? matrices?.array : batchedMatrixData(batch);
    if (current === undefined) return;
    // A static forest is nearly every instance: copying 218,809 unchanged matrices each frame was
    // the remaining per-frame cost. Same version means the scheduled history is already current.
    const version = matrices?.version;
    if (
      version !== undefined &&
      this.#instanceVersions.get(object) === version &&
      this.#instanceSnapshots.get(object)?.length === current.length
    )
      return;
    rotate(this.#instanceSnapshots, this.#spareInstances, object, current);
    if (version !== undefined) this.#instanceVersions.set(object, version);
    else this.#instanceVersions.delete(object);
  }

  private restore(object: Object3D): void {
    const typed = object as IVelocityObject;
    const original = this.#originalFlags.get(object);
    if (original === undefined || !original.present)
      Reflect.deleteProperty(typed.userData, "useVelocity");
    else typed.userData.useVelocity = original.value;
    const batch = getBatchedMesh(object);
    if (batch !== undefined && this.#ownedBatchedMeshes.delete(batch))
      disposeBatchedMeshVelocity(batch);
    Reflect.deleteProperty(typed, VELOCITY_PREVIOUS_INSTANCE_MATRICES);
    Reflect.deleteProperty(typed, VELOCITY_PREVIOUS_WORLD_MATRIX);
    Reflect.deleteProperty(typed, VELOCITY_PREVIOUS_BONE_MATRICES);
    Reflect.deleteProperty(typed, VELOCITY_PREVIOUS_BIND_MATRIX_INVERSE);
    this.#originalFlags.delete(object);
    this.#instanceSnapshots.delete(object);
    this.#worldSnapshots.delete(object);
    this.#spareInstances.delete(object);
    this.#instanceVersions.delete(object);
    this.#spareWorlds.delete(object);
    this.#bindInverseSnapshots.delete(object);
  }
}

/**
 * Reads the scheduled previous instance/sub-draw array for conformance tests and renderer adapters.
 * @situation inspect the previous instance frame at a renderer adapter boundary
 */
export function readVelocityPreviousMatrices(object: Object3D): Float32Array | undefined {
  return (object as IVelocityObject)[VELOCITY_PREVIOUS_INSTANCE_MATRICES];
}

/**
 * Reads the scheduled previous world matrix for conformance tests and renderer adapters.
 * @situation inspect the previous rigid transform at a renderer adapter boundary
 */
export function readVelocityPreviousWorldMatrix(object: Object3D): Matrix4 | undefined {
  return (object as IVelocityObject)[VELOCITY_PREVIOUS_WORLD_MATRIX];
}

/**
 * Reads the scheduled previous bone array for conformance tests and renderer adapters.
 * @situation inspect the previous skinned pose at a renderer adapter boundary
 */
export function readVelocityPreviousBoneMatrices(object: Object3D): Float32Array | undefined {
  return (object as IVelocityObject)[VELOCITY_PREVIOUS_BONE_MATRICES];
}

function isVelocityRenderable(object: Object3D): boolean {
  return (
    (object as { isMesh?: boolean }).isMesh === true ||
    (object as { isLine?: boolean }).isLine === true ||
    (object as { isPoints?: boolean }).isPoints === true ||
    (object as { isSprite?: boolean }).isSprite === true
  );
}

function getSkeleton(object: Object3D): ITrackedSkeleton | undefined {
  const candidate = object as Object3D & {
    isSkinnedMesh?: boolean;
    skeleton?: ITrackedSkeleton;
  };
  return candidate.isSkinnedMesh === true ? candidate.skeleton : undefined;
}

function getBatchedMesh(object: Object3D): BatchedMesh | undefined {
  return (object as IBatchedMatrixSource).isBatchedMesh === true
    ? (object as BatchedMesh)
    : undefined;
}

function batchedMatrixData(mesh: BatchedMesh): ArrayLike<number> | undefined {
  return (mesh as BatchedMesh & IBatchedMatrixSource)._matricesTexture?.image?.data;
}

function hasBatchedPreviousMatrices(mesh: BatchedMesh): boolean {
  return (mesh as BatchedMesh & IBatchedMatrixSource)._previousMatricesTexture !== undefined;
}

function isNode(value: unknown): value is Node {
  return (
    typeof value === "object" && value !== null && (value as { isNode?: boolean }).isNode === true
  );
}

function copyArray(source: ArrayLike<number>): Float32Array {
  const copy = new Float32Array(source.length);
  copy.set(source);
  return copy;
}

/**
 * The committed history, written into last frame's buffer when the length still matches. Three
 * copies the scheduled history into its own attribute at draw time, so reuse is safe; a fresh array
 * per instanced mesh per frame was ~14 MB of garbage a frame for 218,809 instances and produced
 * multi-second collector stalls.
 */
/** Commit into last frame's spare buffer and keep the scheduled one as the next spare. */
function rotate<K>(
  snapshots: Map<K, Float32Array>,
  spares: Map<K, Float32Array>,
  key: K,
  source: ArrayLike<number>,
): void {
  const scheduled = snapshots.get(key);
  const next = copyInto(spares.get(key), source);
  if (scheduled) spares.set(key, scheduled);
  snapshots.set(key, next);
}

function copyInto(target: Float32Array | undefined, source: ArrayLike<number>): Float32Array {
  if (target === undefined || target.length !== source.length) return copyArray(source);
  target.set(source);
  return target;
}
