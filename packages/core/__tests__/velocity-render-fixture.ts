import {
  type BatchedMesh,
  type BufferGeometry,
  type Camera,
  type InstancedMesh,
  Matrix4,
  type Mesh,
  type Object3D,
  type SkinnedMesh,
  Vector3,
} from "three";
import { batch, instance, skinning } from "three/tsl";
import type { Node } from "three/webgpu";
import { VelocityNode, WGSLNodeBuilder } from "three/webgpu";

import type { IRenderChainRenderer } from "../src/render/chain.js";
import {
  readVelocityPreviousBoneMatrices,
  readVelocityPreviousMatrices,
  readVelocityPreviousWorldMatrix,
} from "../src/render/velocity.js";
import type { IVelocityRenderPass } from "../src/render/velocity.js";

const VELOCITY_EPSILON = 1e-6;

export interface IVelocityShaderObjects {
  readonly rigid: Mesh;
  readonly character: SkinnedMesh;
  readonly crowd: InstancedMesh;
  readonly batch: BatchedMesh;
  readonly staticMesh: Mesh;
  readonly movingInstanceId: number;
  readonly movingBatchInstanceId: number;
}

export interface IVelocityShaderState {
  readonly rigid: Mesh;
  readonly rigidPreviousWorld: Matrix4;
  readonly character: SkinnedMesh;
  readonly characterPreviousBones: Float32Array;
  readonly crowd: InstancedMesh;
  readonly crowdPreviousMatrices: Float32Array;
  readonly batch: BatchedMesh;
  readonly batchPreviousMatrices: Float32Array;
  readonly staticMesh: Mesh;
  readonly staticPreviousWorld: Matrix4;
  readonly movingInstanceId: number;
  readonly movingBatchInstanceId: number;
}

export interface IVelocityFootprint {
  readonly coveredPixels: number;
  readonly movingPixels: number;
}

export interface IRenderedVelocityFrame {
  readonly frame: number;
  readonly width: number;
  readonly height: number;
  /** The color attachment written by the velocity MRT, in NDC delta units. */
  readonly pixels: Float32Array;
  /** Current and previous depth-tested coverage approximations for the temporal stage stub. */
  readonly currentCoverage: Uint8Array;
  readonly previousCoverage: Uint8Array;
  readonly footprints: ReadonlyMap<string, IVelocityFootprint>;
}

interface IFootprintAccumulator {
  readonly covered: Set<number>;
  readonly moving: Set<number>;
}

interface IProjectedPoint {
  readonly ndcX: number;
  readonly ndcY: number;
  readonly screenX: number;
  readonly screenY: number;
}

interface IFrameAccumulator {
  readonly pixels: Float32Array;
  readonly currentCoverage: Uint8Array;
  readonly previousCoverage: Uint8Array;
  readonly footprints: Map<string, IFootprintAccumulator>;
}

interface IInspectableVelocityBuilder {
  buildUpdateNodes(): void;
  flowStagesNode(node: Node, output: string): unknown;
  nodes: Set<{
    readonly constructor: { readonly name: string };
    readonly isBufferNode?: boolean;
    readonly value?: unknown;
    update(frame: unknown): unknown;
  }>;
  setShaderStage(stage: "vertex"): void;
}

/**
 * Builds the same patched Three.js vertex update nodes used by the WebGPU velocity shader and
 * returns the buffers that shader reads. The renderer below only rasterizes those outputs because
 * this package's unit environment has no GPU; it never invents a pixel region or motion value.
 */
export function prepareVelocityShaderState(
  camera: Camera,
  objects: IVelocityShaderObjects,
): IVelocityShaderState {
  const rigidNode = new VelocityNode();
  rigidNode.setProjectionMatrix(camera.projectionMatrix);
  rigidNode.update({ frameId: 2, camera, object: objects.rigid } as never);

  const instanceBuilder = buildVelocityUpdateNodes(
    objects.crowd,
    (instance as unknown as (matrices: typeof objects.crowd.instanceMatrix) => Node)(
      objects.crowd.instanceMatrix,
    ),
  );
  runObjectUpdate(instanceBuilder, objects.crowd);
  const crowdPreviousMatrices = previousBuffer(instanceBuilder, objects.crowd.instanceMatrix.array);

  const skinBuilder = buildVelocityUpdateNodes(
    objects.character,
    skinning(objects.character) as unknown as Node,
  );
  runObjectUpdate(skinBuilder, objects.character);
  const characterPreviousBones = previousBuffer(
    skinBuilder,
    objects.character.skeleton.boneMatrices as Float32Array,
  );

  const batchBuilder = buildVelocityUpdateNodes(
    objects.batch,
    (batch as unknown as (object: BatchedMesh) => Node)(objects.batch),
  );
  const previousTexture = readBatchTexture(objects.batch, "_previousMatricesTexture");
  if (![...batchBuilder.nodes].some((node) => readNodeValue(node) === previousTexture)) {
    throw new Error("velocity fixture batch shader did not read the previous matrix texture");
  }

  const rigidPreviousWorld = previousModelWorldMatrix(rigidNode);
  const staticPreviousWorld = readVelocityPreviousWorldMatrix(objects.staticMesh);
  const scheduledBones = readVelocityPreviousBoneMatrices(objects.character);
  const scheduledMatrices = readVelocityPreviousMatrices(objects.crowd);
  const scheduledBatchMatrices = readVelocityPreviousMatrices(objects.batch);
  if (
    rigidPreviousWorld === undefined ||
    staticPreviousWorld === undefined ||
    scheduledBones === undefined ||
    scheduledMatrices === undefined ||
    scheduledBatchMatrices === undefined
  ) {
    throw new Error("velocity tracker did not provision all shader history inputs");
  }

  return {
    rigid: objects.rigid,
    rigidPreviousWorld: rigidPreviousWorld.clone(),
    character: objects.character,
    characterPreviousBones: characterPreviousBones.slice(),
    crowd: objects.crowd,
    crowdPreviousMatrices: crowdPreviousMatrices.slice(),
    batch: objects.batch,
    batchPreviousMatrices: readTextureData(previousTexture).slice(),
    staticMesh: objects.staticMesh,
    staticPreviousWorld: staticPreviousWorld.clone(),
    movingInstanceId: objects.movingInstanceId,
    movingBatchInstanceId: objects.movingBatchInstanceId,
  };
}

function previousModelWorldMatrix(node: VelocityNode): Matrix4 {
  return (
    node as unknown as {
      previousModelWorldMatrix: { value: Matrix4 };
    }
  ).previousModelWorldMatrix.value;
}

/** A deterministic WebGPU renderer stand-in: it executes the production route, then rasterizes triangles. */
export class SoftwareVelocityRenderer implements IRenderChainRenderer {
  readonly kind = "webgpu" as const;
  readonly raw = {};
  velocityEnabled = false;
  outputNode: unknown;
  #readonlyPass: IVelocityRenderPass;
  #width: number;
  #height: number;
  #frame = 0;
  #shaderState: IVelocityShaderState | undefined;
  #lastFrame: IRenderedVelocityFrame | undefined;
  #lastResult: { frame: number; rejectionMask: Uint8Array } | undefined;

  constructor(pass: IVelocityRenderPass, width: number, height: number) {
    this.#readonlyPass = pass;
    this.#width = width;
    this.#height = height;
  }

  setOutputNode(node: unknown): void {
    this.outputNode = node;
  }

  clearOutputNode(): void {
    this.outputNode = undefined;
  }

  setRenderChainVelocityEnabled(enabled: boolean): void {
    this.velocityEnabled = enabled;
  }

  setShaderState(state: IVelocityShaderState): void {
    this.#shaderState = state;
  }

  render(camera: Camera): IRenderedVelocityFrame {
    const state = this.#shaderState;
    if (state === undefined) throw new Error("velocity renderer has no compiled shader state");
    camera.updateMatrixWorld(true);
    const velocityOutputActive =
      this.velocityEnabled &&
      this.outputNode !== undefined &&
      this.#readonlyPass.getMRT()?.has("velocity") === true;
    const frame = rasterizeVelocityFrame(
      camera,
      state,
      this.#width,
      this.#height,
      velocityOutputActive,
      ++this.#frame,
    );
    this.#lastFrame = frame;
    this.#lastResult = {
      frame: frame.frame,
      rejectionMask: temporalRejectionMask(frame, velocityOutputActive),
    };
    return frame;
  }

  readVelocityResult(): { frame: number; rejectionMask: Uint8Array } | undefined {
    return this.#lastResult;
  }

  get lastFrame(): IRenderedVelocityFrame | undefined {
    return this.#lastFrame;
  }
}

function buildVelocityUpdateNodes(object: Object3D, node: Node): IInspectableVelocityBuilder {
  const renderer = {
    backend: { capabilities: { getUniformBufferLimit: () => 65_536 } },
    getDrawIndex: () => null,
    getMRT: () => new Set(["velocity"]),
    hasFeature: () => false,
  } as never;
  const builder = new WGSLNodeBuilder(object, renderer) as unknown as IInspectableVelocityBuilder;
  builder.setShaderStage("vertex");
  builder.flowStagesNode(node, "void");
  builder.buildUpdateNodes();
  return builder;
}

function runObjectUpdate(builder: IInspectableVelocityBuilder, object: Object3D): void {
  const event =
    [...builder.nodes].find((node) => Reflect.get(node, "eventType") === "beforeObject") ??
    [...builder.nodes].find(isObjectEvent);
  if (event === undefined) throw new Error("velocity fixture did not build an object update");
  event.update({ frameId: 2, object });
}

/**
 * The object event, named rather than first-found.
 *
 * The patched Three syncs the attribute-path instance matrix on a *frame* event before the previous
 * matrix is copied on the object event, so the first `EventNode` in the set is no longer the one
 * that carries the snapshot — firing it leaves the previous matrices holding the current ones.
 */
export function isObjectEvent(node: {
  readonly constructor: { readonly name: string };
  readonly eventType?: string;
}): boolean {
  return node.constructor.name === "EventNode" && node.eventType === "object";
}

/**
 * The history array the shader reads, wherever the patched Three keeps it: the uniform path holds
 * it directly as a `BufferNode`'s value, the attribute path the patch forces holds it as the
 * `InstancedInterleavedBuffer` a `BufferAttributeNode` wraps. Either way it is the buffer that is
 * not the current one.
 */
export function previousBuffer(
  builder: IInspectableVelocityBuilder,
  current: ArrayLike<number>,
): Float32Array {
  const buffer = [...builder.nodes]
    .map((node) => historyArray(node))
    .find((array) => array !== undefined && array !== current);
  if (buffer === undefined) throw new Error("velocity fixture did not build history");
  return buffer;
}

function historyArray(node: { readonly isBufferNode?: boolean; readonly value?: unknown }):
  | Float32Array
  | undefined {
  if (node.isBufferNode !== true) return undefined;
  if (node.value instanceof Float32Array) return node.value;
  const array = (node.value as { readonly array?: unknown } | undefined)?.array;
  return array instanceof Float32Array ? array : undefined;
}

function readBatchTexture(
  batchMesh: BatchedMesh,
  property: "_matricesTexture" | "_previousMatricesTexture",
): { image: { data: Float32Array } } {
  const texture = (
    batchMesh as unknown as {
      _matricesTexture: { image: { data: Float32Array } };
      _previousMatricesTexture: { image: { data: Float32Array } };
    }
  )[property];
  if (texture === undefined) throw new Error(`batch texture '${property}' is missing`);
  return texture;
}

function readTextureData(texture: { image: { data: Float32Array } }): Float32Array {
  return texture.image.data;
}

function readNodeValue(node: { readonly value?: unknown }): unknown {
  return node.value;
}

function rasterizeVelocityFrame(
  camera: Camera,
  state: IVelocityShaderState,
  width: number,
  height: number,
  velocityOutputActive: boolean,
  frame: number,
): IRenderedVelocityFrame {
  const accumulator: IFrameAccumulator = {
    pixels: new Float32Array(width * height * 2),
    currentCoverage: new Uint8Array(width * height),
    previousCoverage: new Uint8Array(width * height),
    footprints: new Map(),
  };

  rasterizeMesh(
    "static",
    state.staticMesh,
    state.staticMesh.matrixWorld,
    state.staticPreviousWorld,
    undefined,
    undefined,
    camera,
    width,
    height,
    accumulator,
    velocityOutputActive,
  );
  rasterizeMesh(
    "rigid",
    state.rigid,
    state.rigid.matrixWorld,
    state.rigidPreviousWorld,
    undefined,
    undefined,
    camera,
    width,
    height,
    accumulator,
    velocityOutputActive,
  );
  rasterizeMesh(
    "skinned",
    state.character,
    state.character.matrixWorld,
    state.character.matrixWorld,
    state.character.skeleton.boneMatrices as Float32Array,
    state.characterPreviousBones,
    camera,
    width,
    height,
    accumulator,
    velocityOutputActive,
  );
  rasterizeInstances(
    state.crowd,
    state.crowdPreviousMatrices,
    state.movingInstanceId,
    camera,
    width,
    height,
    accumulator,
    velocityOutputActive,
  );
  rasterizeBatch(
    state.batch,
    state.batchPreviousMatrices,
    state.movingBatchInstanceId,
    camera,
    width,
    height,
    accumulator,
    velocityOutputActive,
  );

  const footprints = new Map<string, IVelocityFootprint>();
  for (const [name, footprint] of accumulator.footprints)
    footprints.set(name, {
      coveredPixels: footprint.covered.size,
      movingPixels: footprint.moving.size,
    });
  return {
    frame,
    width,
    height,
    pixels: accumulator.pixels,
    currentCoverage: accumulator.currentCoverage,
    previousCoverage: accumulator.previousCoverage,
    footprints,
  };
}

function rasterizeMesh(
  name: string,
  mesh: Mesh,
  currentWorld: Matrix4,
  previousWorld: Matrix4,
  currentBones: ArrayLike<number> | undefined,
  previousBones: ArrayLike<number> | undefined,
  camera: Camera,
  width: number,
  height: number,
  accumulator: IFrameAccumulator,
  velocityOutputActive: boolean,
): void {
  const geometry = mesh.geometry;
  const currentVertices = (vertex: number): Vector3 =>
    currentBones === undefined
      ? readPosition(geometry, vertex).applyMatrix4(currentWorld)
      : skinPosition(mesh as SkinnedMesh, vertex, currentBones).applyMatrix4(currentWorld);
  const previousVertices = (vertex: number): Vector3 =>
    previousBones === undefined
      ? readPosition(geometry, vertex).applyMatrix4(previousWorld)
      : skinPosition(mesh as SkinnedMesh, vertex, previousBones).applyMatrix4(previousWorld);
  rasterizeGeometry(
    name,
    geometry,
    0,
    geometry.index?.count ?? geometry.getAttribute("position").count,
    currentVertices,
    previousVertices,
    camera,
    width,
    height,
    accumulator,
    velocityOutputActive,
  );
}

function rasterizeInstances(
  mesh: InstancedMesh,
  previousMatrices: Float32Array,
  movingInstanceId: number,
  camera: Camera,
  width: number,
  height: number,
  accumulator: IFrameAccumulator,
  velocityOutputActive: boolean,
): void {
  const geometry = mesh.geometry;
  const currentInstance = new Matrix4();
  const previousInstance = new Matrix4();
  const currentWorld = new Matrix4();
  const previousWorld = new Matrix4();
  for (let instanceId = 0; instanceId < mesh.count; instanceId += 1) {
    mesh.getMatrixAt(instanceId, currentInstance);
    currentWorld.copy(mesh.matrixWorld).multiply(currentInstance);
    previousInstance.fromArray(previousMatrices, instanceId * 16);
    previousWorld.copy(mesh.matrixWorld).multiply(previousInstance);
    rasterizeGeometry(
      instanceId === movingInstanceId ? "instanced-moving" : "instanced-static",
      geometry,
      0,
      geometry.index?.count ?? geometry.getAttribute("position").count,
      (vertex) => readPosition(geometry, vertex).applyMatrix4(currentWorld),
      (vertex) => readPosition(geometry, vertex).applyMatrix4(previousWorld),
      camera,
      width,
      height,
      accumulator,
      velocityOutputActive,
    );
  }
}

function rasterizeBatch(
  mesh: BatchedMesh,
  previousMatrices: Float32Array,
  movingInstanceId: number,
  camera: Camera,
  width: number,
  height: number,
  accumulator: IFrameAccumulator,
  velocityOutputActive: boolean,
): void {
  const geometry = mesh.geometry;
  const currentInstance = new Matrix4();
  const previousInstance = new Matrix4();
  const currentWorld = new Matrix4();
  const previousWorld = new Matrix4();
  for (let instanceId = 0; instanceId < mesh.instanceCount; instanceId += 1) {
    const geometryId = mesh.getGeometryIdAt(instanceId);
    const range = mesh.getGeometryRangeAt(geometryId);
    if (range === null) continue;
    currentInstance.fromArray(
      readTextureData(readBatchTexture(mesh, "_matricesTexture")),
      instanceId * 16,
    );
    previousInstance.fromArray(previousMatrices, instanceId * 16);
    currentWorld.copy(mesh.matrixWorld).multiply(currentInstance);
    previousWorld.copy(mesh.matrixWorld).multiply(previousInstance);
    rasterizeGeometry(
      instanceId === movingInstanceId ? "batched-moving" : "batched-static",
      geometry,
      range.indexStart,
      range.indexCount,
      (vertex) => readPosition(geometry, vertex).applyMatrix4(currentWorld),
      (vertex) => readPosition(geometry, vertex).applyMatrix4(previousWorld),
      camera,
      width,
      height,
      accumulator,
      velocityOutputActive,
    );
  }
}

function rasterizeGeometry(
  name: string,
  geometry: BufferGeometry,
  indexStart: number,
  indexCount: number,
  currentVertex: (vertex: number) => Vector3,
  previousVertex: (vertex: number) => Vector3,
  camera: Camera,
  width: number,
  height: number,
  accumulator: IFrameAccumulator,
  velocityOutputActive: boolean,
): void {
  const index = geometry.index;
  const footprint = accumulator.footprints.get(name) ?? { covered: new Set(), moving: new Set() };
  accumulator.footprints.set(name, footprint);
  const triangleCount = Math.floor(indexCount / 3);
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const offset = indexStart + triangle * 3;
    const a = index === null ? offset : index.getX(offset);
    const b = index === null ? offset + 1 : index.getX(offset + 1);
    const c = index === null ? offset + 2 : index.getX(offset + 2);
    const current: [IProjectedPoint, IProjectedPoint, IProjectedPoint] = [
      project(currentVertex(a), camera, width, height),
      project(currentVertex(b), camera, width, height),
      project(currentVertex(c), camera, width, height),
    ];
    const previous: [IProjectedPoint, IProjectedPoint, IProjectedPoint] = [
      project(previousVertex(a), camera, width, height),
      project(previousVertex(b), camera, width, height),
      project(previousVertex(c), camera, width, height),
    ];
    rasterizePreviousTriangle(previous, accumulator.previousCoverage, width, height);
    rasterizeCurrentTriangle(
      current,
      previous,
      footprint,
      accumulator.currentCoverage,
      accumulator.pixels,
      width,
      height,
      velocityOutputActive,
    );
  }
}

function rasterizePreviousTriangle(
  triangle: readonly [IProjectedPoint, IProjectedPoint, IProjectedPoint],
  coverage: Uint8Array,
  width: number,
  height: number,
): void {
  rasterizeTriangle(triangle, width, height, (pixel) => {
    coverage[pixel] = 1;
  });
}

function rasterizeCurrentTriangle(
  current: readonly [IProjectedPoint, IProjectedPoint, IProjectedPoint],
  previous: readonly [IProjectedPoint, IProjectedPoint, IProjectedPoint],
  footprint: IFootprintAccumulator,
  coverage: Uint8Array,
  pixels: Float32Array,
  width: number,
  height: number,
  velocityOutputActive: boolean,
): void {
  rasterizeTriangle(current, width, height, (pixel, weights) => {
    coverage[pixel] = 1;
    footprint.covered.add(pixel);
    if (!velocityOutputActive) return;
    const currentX = weighted(current[0]?.ndcX, current[1]?.ndcX, current[2]?.ndcX, weights);
    const currentY = weighted(current[0]?.ndcY, current[1]?.ndcY, current[2]?.ndcY, weights);
    const previousX = weighted(previous[0]?.ndcX, previous[1]?.ndcX, previous[2]?.ndcX, weights);
    const previousY = weighted(previous[0]?.ndcY, previous[1]?.ndcY, previous[2]?.ndcY, weights);
    const deltaX = currentX - previousX;
    const deltaY = currentY - previousY;
    if (Math.hypot(deltaX, deltaY) <= VELOCITY_EPSILON) return;
    footprint.moving.add(pixel);
    pixels[pixel * 2] = deltaX;
    pixels[pixel * 2 + 1] = deltaY;
  });
}

function rasterizeTriangle(
  triangle: readonly [IProjectedPoint, IProjectedPoint, IProjectedPoint],
  width: number,
  height: number,
  write: (pixel: number, weights: readonly [number, number, number]) => void,
): void {
  const first = triangle[0];
  const second = triangle[1];
  const third = triangle[2];
  if (first === undefined || second === undefined || third === undefined) return;
  const area = edge(
    first.screenX,
    first.screenY,
    second.screenX,
    second.screenY,
    third.screenX,
    third.screenY,
  );
  if (Math.abs(area) <= VELOCITY_EPSILON) return;
  const minX = Math.max(0, Math.floor(Math.min(first.screenX, second.screenX, third.screenX)));
  const maxX = Math.min(
    width - 1,
    Math.ceil(Math.max(first.screenX, second.screenX, third.screenX)),
  );
  const minY = Math.max(0, Math.floor(Math.min(first.screenY, second.screenY, third.screenY)));
  const maxY = Math.min(
    height - 1,
    Math.ceil(Math.max(first.screenY, second.screenY, third.screenY)),
  );
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const pointX = x + 0.5;
      const pointY = y + 0.5;
      const firstWeight =
        edge(second.screenX, second.screenY, third.screenX, third.screenY, pointX, pointY) / area;
      const secondWeight =
        edge(third.screenX, third.screenY, first.screenX, first.screenY, pointX, pointY) / area;
      const thirdWeight = 1 - firstWeight - secondWeight;
      if (firstWeight < -0.001 || secondWeight < -0.001 || thirdWeight < -0.001) continue;
      write(y * width + x, [firstWeight, secondWeight, thirdWeight]);
    }
  }
}

function edge(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (cx - ax) * (by - ay) - (cy - ay) * (bx - ax);
}

function weighted(
  first: number | undefined,
  second: number | undefined,
  third: number | undefined,
  weights: readonly [number, number, number],
): number {
  return (
    (first ?? 0) * (weights[0] ?? 0) +
    (second ?? 0) * (weights[1] ?? 0) +
    (third ?? 0) * (weights[2] ?? 0)
  );
}

function project(point: Vector3, camera: Camera, width: number, height: number): IProjectedPoint {
  const ndc = point.project(camera);
  return {
    ndcX: ndc.x,
    ndcY: ndc.y,
    screenX: (ndc.x * 0.5 + 0.5) * (width - 1),
    screenY: (1 - (ndc.y * 0.5 + 0.5)) * (height - 1),
  };
}

function readPosition(geometry: BufferGeometry, vertex: number): Vector3 {
  const position = geometry.getAttribute("position");
  return new Vector3(position.getX(vertex), position.getY(vertex), position.getZ(vertex));
}

function skinPosition(mesh: SkinnedMesh, vertex: number, bones: ArrayLike<number>): Vector3 {
  const geometry = mesh.geometry;
  const position = readPosition(geometry, vertex).applyMatrix4(mesh.bindMatrix);
  const indices = geometry.getAttribute("skinIndex");
  const weights = geometry.getAttribute("skinWeight");
  const result = new Vector3();
  for (let channel = 0; channel < 4; channel += 1) {
    const weight = weights.getComponent(vertex, channel);
    if (weight === 0) continue;
    const boneIndex = indices.getComponent(vertex, channel);
    result.add(
      position
        .clone()
        .applyMatrix4(new Matrix4().fromArray(bones, boneIndex * 16))
        .multiplyScalar(weight),
    );
  }
  return result.applyMatrix4(mesh.bindMatrixInverse);
}

function temporalRejectionMask(
  frame: IRenderedVelocityFrame,
  velocityOutputActive: boolean,
): Uint8Array {
  const values: number[] = [];
  for (let pixel = 0; pixel < frame.currentCoverage.length; pixel += 1) {
    if (frame.currentCoverage[pixel] === 0) continue;
    const x = pixel % frame.width;
    const y = Math.floor(pixel / frame.width);
    let previousX = x;
    let previousY = y;
    if (velocityOutputActive) {
      const deltaX = frame.pixels[pixel * 2] ?? 0;
      const deltaY = frame.pixels[pixel * 2 + 1] ?? 0;
      previousX = x - deltaX * 0.5 * frame.width;
      previousY = y + deltaY * 0.5 * frame.height;
    }
    values.push(
      hasPreviousCoverage(frame.previousCoverage, frame.width, frame.height, previousX, previousY)
        ? 0
        : 1,
    );
  }
  return Uint8Array.from(values);
}

function hasPreviousCoverage(
  coverage: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
): boolean {
  const centerX = Math.round(x);
  const centerY = Math.round(y);
  for (let offsetY = -2; offsetY <= 2; offsetY += 1) {
    for (let offsetX = -2; offsetX <= 2; offsetX += 1) {
      const sampleX = centerX + offsetX;
      const sampleY = centerY + offsetY;
      if (sampleX < 0 || sampleX >= width || sampleY < 0 || sampleY >= height) continue;
      if (coverage[sampleY * width + sampleX] === 1) return true;
    }
  }
  return false;
}
