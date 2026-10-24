import type { Data3DTexture, PerspectiveCamera, Vector3 } from "three";
import { uniform, vec3 } from "three/tsl";
import type { Node } from "three/webgpu";

export interface IGrid {
  readonly origin: Vector3;
  readonly cell: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
}

/**
 * The cache's read, registered when the bake finishes: a screen-space gather asks it what a ray that finds
 * nothing on screen would have returned (the tier below its own), with the pixel's world position and normal.
 */
export const giCache: {
  irradiance?: (position: Node<"vec3">, normal: Node<"vec3">) => Node<"vec3">;
  /**
   * The baked field at its final resolution, for tools and tests: per texel, six faces of RGB (E / pi), six
   * environment shares, and whether the texel's centre lies inside a solid (a read gives it no weight).
   */
  field?: {
    grid: IGrid;
    values: Float32Array;
    sky: Float32Array;
    solid: Uint8Array;
    /** Per texel and axis (x, y, z): where the wall on the link to the next texel starts, 0 to 255 of the way (0 when open). */
    walls: Uint8Array;
  };
  /** The texture the materials read, for the light-change update. */
  volumeTexture?: Data3DTexture;
  /**
   * Follows the lights that have a `source`: when one changed since the last call, rewrites the field and the texture and
   * returns true. The game's frame hook calls it every frame (`IRayContext.beforeRender`); a test calls it by hand.
   */
  refresh?: () => boolean;
} = {};

/**
 * The cache as the tier below a screen-space gather: a function of the pixel's view-space position and unit
 * normal, reading the cache through the camera's world matrix (refreshed every render). Undefined before the bake.
 */
export function cacheFallback(
  camera: PerspectiveCamera,
): ((position: Node<"vec3">, normal: Node<"vec3">) => Node<"vec3">) | undefined {
  const read = giCache.irradiance;
  if (read === undefined) return undefined;
  const live = (index: number) =>
    uniform(0).onRenderUpdate(() => camera.matrixWorld.elements[index] ?? 0);
  const column = (a: number) => vec3(live(a), live(a + 1), live(a + 2));
  const [right, up, back, at] = [column(0), column(4), column(8), column(12)];
  const toWorld = (v: Node<"vec3">) => right.mul(v.x).add(up.mul(v.y)).add(back.mul(v.z));
  return (position, normal) => read(toWorld(position).add(at), toWorld(normal).normalize());
}
