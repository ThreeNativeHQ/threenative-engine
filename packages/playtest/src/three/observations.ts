import type {
  IPlaytestEntityObservation,
  IPlaytestObservationSnapshot,
  IPlaytestRenderChainObservation,
  IPlaytestRuntimeDiagnosticsSample,
  IPlaytestSampleRequest,
  JsonValue,
  PlaytestClockMode,
} from "../protocol.js";
import { Box3, Frustum, Matrix4, Vector2, Vector3, type Camera, type Object3D, type OrthographicCamera, type PerspectiveCamera, type Scene } from "three";

import type { ThreePlaytestEntityRegistry } from "./entities.js";
import { observeSceneNodes } from "./scene-nodes.js";
import { observeSceneResources } from "./scene-observation.js";

export interface IThreeObservationInput {
  camera: Camera;
  clockMode: PlaytestClockMode;
  diagnostics?: () => JsonValue[];
  registry: ThreePlaytestEntityRegistry;
  renderer: IThreePlaytestRenderer;
  runtimeDiagnosticsSeries?: () => readonly IPlaytestRuntimeDiagnosticsSample[];
  resources?: () => Record<string, JsonValue>;
  renderChain?: () => IPlaytestRenderChainObservation | undefined;
  scene: Scene;
  gameplay?: () => IPlaytestObservationSnapshot["gameplay"];
  tick?: number;
}

export interface IThreePlaytestRenderer {
  getDrawingBufferSize(target: Vector2): Vector2;
  info?: {
    render?: {
      drawCalls?: unknown;
      calls?: unknown;
      triangles?: unknown;
    };
  };
}

/** Explicit empty entities and a single resource channel identify a wait poll, not a full witness. */
export function isResourceOnlySample(request: IPlaytestSampleRequest): boolean {
  return request.entities?.length === 0 && request.include?.length === 1 &&
    request.include[0] === "resources" && request.resources !== undefined &&
    request.geometry === undefined && request.sceneNodes === undefined;
}

function sampleClock(input: IThreeObservationInput): IPlaytestObservationSnapshot["clock"] {
  return {
    mode: input.clockMode,
    ...(input.tick === undefined ? { timeMs: performance.now() } : { tick: input.tick }),
    // Live observations carry wall time even when the producer also supplies its tick.
    ...(input.clockMode === "wall-clock" ? { timeMs: performance.now() } : {}),
  };
}

export function sampleThreeObservations(input: IThreeObservationInput, request: IPlaytestSampleRequest): IPlaytestObservationSnapshot {
  if (isResourceOnlySample(request)) {
    return { clock: sampleClock(input), ...(input.resources === undefined ? {} : { resources: input.resources() }) };
  }
  input.scene.updateMatrixWorld(true);
  input.camera.updateMatrixWorld(true);
  const rendererSize = input.renderer.getDrawingBufferSize(new Vector2());
  const entities = input.registry.select(request.entities).map(({ id, object }) =>
    observeEntity(id, object, input.camera, rendererSize.x, rendererSize.y));
  const renderPerformance = rendererPerformance(input.renderer);
  const renderChain = input.renderChain?.();
  return {
    clock: sampleClock(input),
    ...(input.diagnostics === undefined ? {} : { diagnostics: input.diagnostics() }),
    entities,
    ...(input.gameplay === undefined ? {} : { gameplay: input.gameplay() }),
    ...(renderPerformance === undefined ? {} : { performance: renderPerformance }),
    ...(renderChain === undefined ? {} : { renderChain }),
    // The series is a window of up to a thousand samples, so an unconditional copy made every
    // device sample payload grow past the protocol's byte ceiling once a paced run actually
    // rendered that many frames. Answer it only when the request asks, like every other field.
    ...(input.runtimeDiagnosticsSeries === undefined || request.include?.includes("runtimeDiagnosticsSeries") !== true
      ? {}
      : { runtimeDiagnosticsSeries: input.runtimeDiagnosticsSeries().map((sample) => ({ ...sample })) }),
    ...(input.resources === undefined ? {} : { resources: input.resources() }),
    scene: observeSceneResources(input.scene, input.camera),
    // Only walked when a scenario asks. The node walk reads geometry, materials and world
    // bounds per object, which is real work on a large scene, and no run should pay for it
    // when nothing is going to read it.
    ...(request.sceneNodes === undefined || request.sceneNodes.length === 0
      ? {}
      : { sceneNodes: observeSceneNodes(input.scene, input.camera, request.sceneNodes) }),
  };
}

function rendererPerformance(
  renderer: IThreePlaytestRenderer,
): IPlaytestObservationSnapshot["performance"] {
  const render = renderer.info?.render;
  const drawCalls = finiteNumber(render?.drawCalls) ? render.drawCalls : undefined;
  const triangles = finiteNumber(render?.triangles) ? render.triangles : undefined;
  if (drawCalls === undefined && triangles === undefined) return undefined;
  return {
    ...(drawCalls === undefined ? {} : { drawCalls }),
    ...(triangles === undefined ? {} : { triangles }),
  };
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function observeEntity(
  id: string,
  object: Object3D,
  camera: Camera,
  viewportWidth: number,
  viewportHeight: number,
): IPlaytestEntityObservation {
  const position = object.getWorldPosition(new Vector3());
  const bounds = projectedBounds(object, camera, viewportWidth, viewportHeight);
  return {
    ...(bounds === undefined ? {} : { bounds }),
    id,
    transform: {
      position: [position.x, position.y, position.z],
      rotation: [object.quaternion.x, object.quaternion.y, object.quaternion.z, object.quaternion.w],
      scale: [object.scale.x, object.scale.y, object.scale.z],
    },
    visible: object.visible && bounds !== undefined && bounds.width > 0 && bounds.height > 0,
  };
}

function projectedBounds(
  object: Object3D,
  camera: Camera,
  viewportWidth: number,
  viewportHeight: number,
): IPlaytestEntityObservation["bounds"] | undefined {
  const worldBounds = new Box3().setFromObject(object);
  if (worldBounds.isEmpty()) return undefined;
  const projection = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  if (!new Frustum().setFromProjectionMatrix(projection).intersectsBox(worldBounds)) return undefined;
  const { near } = camera as PerspectiveCamera | OrthographicCamera;
  // Clip the box to the near plane in view space before projecting it.
  // A corner behind the eye divides by a non-positive w and flips. Project only the corners in front
  // and the points where an edge crosses the near plane.
  const inFront = (point: Vector3): boolean => point.z <= -near;
  const viewCorner = (bits: number): Vector3 => new Vector3(
    bits & 4 ? worldBounds.max.x : worldBounds.min.x,
    bits & 2 ? worldBounds.max.y : worldBounds.min.y,
    bits & 1 ? worldBounds.max.z : worldBounds.min.z,
  ).applyMatrix4(camera.matrixWorldInverse);
  const clipped: Vector3[] = [];
  for (let bits = 0; bits < 8; bits += 1) {
    const corner = viewCorner(bits);
    if (inFront(corner)) clipped.push(corner);
    for (const bit of [1, 2, 4]) {
      if (bits & bit) continue;
      const other = viewCorner(bits | bit);
      if (inFront(corner) !== inFront(other)) {
        clipped.push(corner.clone().lerp(other, (-near - corner.z) / (other.z - corner.z)));
      }
    }
  }
  if (clipped.length === 0) return undefined;
  const points = clipped.map((point) => point.applyMatrix4(camera.projectionMatrix));
  const minX = Math.min(...points.map(({ x }) => x));
  const maxX = Math.max(...points.map(({ x }) => x));
  const minY = Math.min(...points.map(({ y }) => y));
  const maxY = Math.max(...points.map(({ y }) => y));
  return {
    height: Math.max(0, (maxY - minY) * 0.5 * viewportHeight),
    width: Math.max(0, (maxX - minX) * 0.5 * viewportWidth),
    x: (minX + 1) * 0.5 * viewportWidth,
    y: (1 - maxY) * 0.5 * viewportHeight,
  };
}
