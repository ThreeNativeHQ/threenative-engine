import { type Intersection, type Mesh, type Object3D, Vector2, Vector3 } from "three";

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
