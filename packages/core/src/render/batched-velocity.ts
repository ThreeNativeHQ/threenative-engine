import { BatchedMesh, DataTexture, type Matrix4, type Texture } from "three";

const THREE_NATIVE_BATCHED_VELOCITY_PATCH = "threeNativeBatchedVelocityPatch";

interface IBatchedMeshVelocityState {
  _matricesTexture: Texture | null;
  _previousMatricesTexture?: Texture;
}

interface IBatchedMatrixImage {
  readonly data: Float32Array;
  readonly height: number;
  readonly width: number;
}

/**
 * Whether the installed Three.js build contains the BatchedMesh previous-position accessor.
 * Published core can be installed without this repository's pnpm root, so the projection must
 * keep material batches on the exact proxy lane when a consumer has not applied the patch.
 */
export function isBatchedMeshVelocityPatched(): boolean {
  return Reflect.get(BatchedMesh, THREE_NATIVE_BATCHED_VELOCITY_PATCH) === true;
}

function state(mesh: BatchedMesh): IBatchedMeshVelocityState {
  return mesh as BatchedMesh & IBatchedMeshVelocityState;
}

/**
 * Allocates the previous-matrix texture only for a batch whose material actually needs velocity.
 * The clone is deliberately separate from `_matricesTexture`: GPU uploads to the current frame
 * must not race the previous-frame sample in the velocity pass.
 */
export function ensureBatchedMeshVelocity(mesh: BatchedMesh): void {
  const current = state(mesh)._matricesTexture;
  if (current === null) throw new Error("BatchedMesh has no current matrix texture.");
  if (state(mesh)._previousMatricesTexture !== undefined) return;
  const image = matrixImage(current);
  const previous = new DataTexture(
    image.data.slice(),
    image.width,
    image.height,
    current.format as ConstructorParameters<typeof DataTexture>[3],
    current.type,
  );
  previous.minFilter = current.minFilter;
  previous.magFilter = current.magFilter;
  previous.wrapS = current.wrapS;
  previous.wrapT = current.wrapT;
  previous.flipY = current.flipY;
  previous.unpackAlignment = current.unpackAlignment;
  previous.colorSpace = current.colorSpace;
  previous.needsUpdate = true;
  state(mesh)._previousMatricesTexture = previous;
}

/**
 * Writes one sub-draw's previous value before updating its current matrix. A new slot receives
 * its current matrix as its previous value, producing zero velocity for its first visible frame.
 */
export function setBatchedMeshMatrixWithVelocity(
  mesh: BatchedMesh,
  instanceId: number,
  current: Matrix4,
  previous: Matrix4,
): void {
  setBatchedMeshPreviousMatrix(mesh, instanceId, previous);
  mesh.setMatrixAt(instanceId, current);
}

/**
 * Advances one sub-draw's previous value for the next velocity pass without rewriting its current
 * matrix. This is called for every live slot on every projected frame, including unchanged slots;
 * otherwise a slot that moved once would keep reporting that move forever.
 */
export function setBatchedMeshPreviousMatrix(
  mesh: BatchedMesh,
  instanceId: number,
  previous: Matrix4,
): void {
  ensureBatchedMeshVelocity(mesh);
  const previousTexture = state(mesh)._previousMatricesTexture as Texture;
  previous.toArray(matrixImage(previousTexture).data, instanceId * 16);
  previousTexture.needsUpdate = true;
}

/** Writes the complete per-sub-draw previous frame without touching the current matrix texture. */
export function setBatchedMeshPreviousMatrices(
  mesh: BatchedMesh,
  previous: ArrayLike<number>,
): void {
  ensureBatchedMeshVelocity(mesh);
  const previousTexture = state(mesh)._previousMatricesTexture as Texture;
  const image = matrixImage(previousTexture);
  if (previous.length !== image.data.length) {
    throw new Error(
      `BatchedMesh previous matrix length ${String(previous.length)} does not match ${String(image.data.length)}.`,
    );
  }
  image.data.set(previous);
  previousTexture.needsUpdate = true;
}

/** Releases the extra texture owned by the material-batching lane. */
export function disposeBatchedMeshVelocity(mesh: BatchedMesh): void {
  const previous = state(mesh)._previousMatricesTexture;
  previous?.dispose();
  state(mesh)._previousMatricesTexture = undefined;
}

/** Returns the previous texture for focused conformance tests and renderer adapters. */
export function readBatchedMeshPreviousMatrices(mesh: BatchedMesh): Texture | undefined {
  return state(mesh)._previousMatricesTexture;
}

function matrixImage(texture: Texture): IBatchedMatrixImage {
  const image = texture.image as Partial<IBatchedMatrixImage>;
  if (
    !(image.data instanceof Float32Array) ||
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height)
  ) {
    throw new Error("BatchedMesh matrix texture must contain a Float32Array image.");
  }
  return image as IBatchedMatrixImage;
}
