import {
  type Camera,
  type InstancedMesh,
  type Intersection,
  Matrix4,
  type Mesh,
  type Object3D,
  Quaternion,
  Vector2,
  Vector3,
} from "three";
import type { IPlacementOverride } from "../core/types.js";

type EditorRaycast = (options: {
  screen?: Vector2;
  origin?: Vector3;
  direction?: Vector3;
  targets: readonly Object3D[];
}) => Intersection | undefined;

/**
 * Convert viewport client coordinates once; the installed picker owns ray intersection.
 * @requires npm i -D @threenative/terrain
 * @situation pick a terrain-editor surface from viewport client coordinates
 * @constraint the caller supplies the raycast implementation and ordered targets
 * @example const hit = pickEditorSurface(ctx, [terrainMesh], event.clientX, event.clientY);
 */
export function pickEditorSurface(
  ctx: {
    renderer: { domElement: { getBoundingClientRect(): { left: number; top: number } } };
    raycast: EditorRaycast;
  },
  targets: readonly Object3D[],
  clientX: number,
  clientY: number,
) {
  const box = ctx.renderer.domElement.getBoundingClientRect();
  return ctx.raycast({
    screen: new Vector2(clientX - box.left, clientY - box.top),
    targets,
  });
}

/**
 * Query the rendered heightfield, including its triangulation rather than an interpolated bake.
 * @requires npm i -D @threenative/terrain
 * @situation query terrain-editor surface elevation at world X/Z coordinates
 * @constraint the supplied mesh and raycast determine the surface; missing intersections return undefined
 * @example const height = editorSurfaceHeight(ctx, terrainMesh, x, z);
 */
export function editorSurfaceHeight(
  ctx: { raycast: EditorRaycast },
  mesh: Mesh,
  x: number,
  z: number,
  originHeight?: number,
): number | undefined {
  let height = originHeight;
  if (height === undefined) {
    mesh.geometry.computeBoundingBox();
    const top = mesh.geometry.boundingBox?.max.y;
    if (top === undefined) return undefined;
    height = top + 1;
  }
  return ctx.raycast({
    origin: new Vector3(x, height, z),
    direction: new Vector3(0, -1, 0),
    targets: [mesh],
  })?.point.y;
}

/**
 * A foreground terrain hit occludes placements; matching uses the evaluated world position.
 * @requires npm i -D @threenative/terrain
 * @situation pick a placed instance in the terrain editor from viewport client coordinates
 * @constraint the caller supplies the raycast context, terrain mesh, instanced meshes and evaluated placements
 * @example const id = pickEditorPlacement(ctx, terrainMesh, meshes, placements, event.clientX, event.clientY);
 */
export function pickEditorPlacement(
  ctx: Parameters<typeof pickEditorSurface>[0],
  terrain: Mesh,
  meshes: readonly Object3D[],
  placements: Iterable<{ pose: Matrix4; placement: { id: string } }>,
  clientX: number,
  clientY: number,
): string | undefined {
  const hit = pickEditorSurface(ctx, [terrain, ...meshes], clientX, clientY);
  if (hit?.instanceId === undefined) return undefined;
  const matrix = new Matrix4();
  (hit.object as InstancedMesh).getMatrixAt(hit.instanceId, matrix);
  const position = new Vector3().setFromMatrixPosition(matrix.premultiply(hit.object.matrixWorld));
  return [...placements].find(
    (instance) =>
      new Vector3().setFromMatrixPosition(instance.pose).distanceToSquared(position) < 1e-6,
  )?.placement.id;
}

/**
 * Project an injected world point to client pixels in the caller's viewport.
 * @requires npm i -D @threenative/terrain
 * @situation convert a terrain-editor world point to viewport client pixels
 * @constraint the point is projected in place; pass a clone to keep the original
 * @example const [x, y] = editorPointToClient(point.clone(), camera, canvas.getBoundingClientRect());
 */
export function editorPointToClient(
  point: Vector3,
  camera: Camera,
  box: { width: number; height: number; left: number; top: number },
): [number, number] {
  point.project(camera);
  return [((point.x + 1) * box.width) / 2 + box.left, ((1 - point.y) * box.height) / 2 + box.top];
}

/**
 * Transform the caller's measured geometry centre into the evaluated placement's world space.
 * @requires npm i -D @threenative/terrain
 * @situation find the world-space centre of a placed terrain-editor instance
 * @constraint the point is multiplied in place; the pose needs finite position, quaternion and scale
 * @example const centre = editorPlacementCenter(localCentre.clone(), placement);
 */
export function editorPlacementCenter(point: Vector3, pose: IPlacementOverride): Vector3 {
  return point
    .multiply(new Vector3().fromArray(pose.scale))
    .applyQuaternion(new Quaternion().fromArray(pose.quaternion))
    .add(new Vector3().fromArray(pose.position));
}
