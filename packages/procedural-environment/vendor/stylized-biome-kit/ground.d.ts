import type { Color, Group, Mesh, Object3D, ShaderMaterial, Vector3 } from "three";

/**
 * Build a gradient sky dome with the Stylized Biome Kit's WebGL shader.
 * @situation a procedural stylized gradient sky dome for an alpine, snow, or desert scene
 * @example scene.add(sky({ top: 0x3a8be8, horizon: 0xe2f1ff }));
 * @requires npm i @threenative/procedural-environment
 */
export function sky(options?: { top?: number; horizon?: number; radius?: number }): Mesh<
  import("three").SphereGeometry,
  ShaderMaterial
>;
/**
 * Build stylized heightfield geometry with a color callback and a second-color mask for path edges.
 * @situation make stylized heightfield terrain with vertex colors and a worn path
 * @example const meadow = terrain({ height: (x, z) => 1 + Math.sin(x) * Math.cos(z), color: (_x, _z, _y, _n, out) => out.set(0x55b93e) });
 * @requires npm i @threenative/procedural-environment
 */
export function terrain(options: {
  size?: number;
  segments?: number;
  focus?: number;
  height: (x: number, z: number) => number;
  color: (
    x: number,
    z: number,
    y: number,
    normal: Vector3,
    color: Color,
    blend: { tint: Color; mask: number },
  ) => void;
}): Mesh;
/**
 * Make instanced batches of a Stylized Biome Kit piece at explicit positions.
 * @situation instance a stylized biome tree or grass asset at many positions
 * @example scene.add(scatter(group, [{ x: 5, z: 8 }, { x: 9, z: 10, rot: 1 }]));
 * @requires npm i @threenative/procedural-environment
 */
export function scatter(
  source: Object3D,
  placements: {
    x: number;
    y?: number;
    z: number;
    rot?: number;
    tiltX?: number;
    tiltZ?: number;
    scale?: number | [number, number, number];
  }[],
): Group;
