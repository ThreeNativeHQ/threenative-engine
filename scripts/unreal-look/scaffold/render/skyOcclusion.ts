// Harness overlay (PRD-635): the sky light is occluded by what stands above a surface.
//
// The scene's environment lights every face by its normal alone, so a room under a ceiling gets the
// open sky's light. Unreal's sky light is shadowed by the scene (Lumen traces it; its screen-space
// pass cannot see a ceiling that is off screen). This bakes that visibility once, at load, into a
// small 3D grid and reads it back through `material.aoNode`, which the engine applies to indirect
// light only: the sun never sees it.
//
// What it stores, per grid point: how much of the open sky above the horizon stays visible through
// each of the six axis directions, an "ambient cube". Rays that point below the horizon are not
// counted, because the environment's own lower half already stands for the ground, so a wall in an
// open field keeps the light it had and a roofed room loses all of it. This is a fixed-world bake:
// move a wall and bake again.
import {
  Box3,
  Data3DTexture,
  LinearFilter,
  type Mesh,
  type MeshStandardMaterial,
  type Object3D,
  RGBAFormat,
  UnsignedByteType,
  Vector3,
} from "three";
import { clamp, dot, mix, normalWorld, positionWorld, step, texture3D, vec3 } from "three/tsl";
import { MeshStandardNodeMaterial } from "three/webgpu";

/** What the bake needs of the game's context: the scene ray query (`ICtx.raycast`). */
export interface ISkyRayContext {
  raycast(options: { origin: Vector3; direction: Vector3; far: number }): unknown;
}

/** Rays per grid point over the upper hemisphere, equal in solid angle. */
const RAYS = 48;
/** Smallest grid cell in metres; a room wall is read from the cell in front of it. */
const CELL = 1;
/** Most grid points, so a wide scene coarsens the cell instead of baking for minutes. */
const MAX_POINTS = 24000;
const AXES: readonly [number, number, number][] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [-1, 0, 0],
  [0, -1, 0],
  [0, 0, -1],
];

export interface ISkyOcclusionReport {
  readonly cell: number;
  readonly points: number;
  readonly rays: number;
  readonly milliseconds: number;
  /** Mean visibility of the six axis directions over all points, for the capture log. */
  readonly meanVisibility: number;
}

interface IGrid {
  readonly origin: Vector3;
  readonly extent: Vector3;
  readonly cell: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
}

/** A grid over `root` with one cell of margin on the sides and none below: a row under the floor bakes as fully blocked. */
function gridOver(root: Object3D): IGrid {
  const bounds = new Box3().setFromObject(root);
  const size = bounds.getSize(new Vector3());
  const cell = Math.max(CELL, Math.cbrt((size.x * size.y * size.z) / MAX_POINTS));
  const nx = Math.ceil(size.x / cell) + 2;
  const ny = Math.ceil(size.y / cell) + 1;
  const nz = Math.ceil(size.z / cell) + 2;
  const origin = new Vector3(bounds.min.x - cell, bounds.min.y, bounds.min.z - cell);
  return { origin, extent: new Vector3(nx, ny, nz).multiplyScalar(cell), cell, nx, ny, nz };
}

/** Fibonacci spiral over the upper hemisphere: equal solid angle per ray. */
function hemisphereRays(): Vector3[] {
  const rays: Vector3[] = [];
  for (let k = 0; k < RAYS; k += 1) {
    const y = (k + 0.5) / RAYS;
    const radius = Math.sqrt(1 - y * y);
    const phi = k * Math.PI * (3 - Math.sqrt(5));
    rays.push(new Vector3(Math.cos(phi) * radius, y, Math.sin(phi) * radius));
  }
  return rays;
}

/** The six ambient-cube visibilities at `point`: open weight over total weight, per axis face. */
function faceVisibility(
  ctx: ISkyRayContext,
  point: Vector3,
  rays: Vector3[],
  far: number,
): number[] {
  const weight = [0, 0, 0, 0, 0, 0];
  const open = [0, 0, 0, 0, 0, 0];
  for (const ray of rays) {
    const blocked = ctx.raycast({ origin: point, direction: ray, far }) !== undefined;
    AXES.forEach((axis, face) => {
      const w = Math.max(0, axis[0] * ray.x + axis[1] * ray.y + axis[2] * ray.z);
      weight[face] = (weight[face] ?? 0) + w;
      if (!blocked) open[face] = (open[face] ?? 0) + w;
    });
  }
  // A face with no upper-hemisphere ray (straight down) keeps the environment's own ground.
  return weight.map((w, face) => (w > 0 ? (open[face] ?? 0) / w : 1));
}

function volume(data: Uint8Array, grid: IGrid): Data3DTexture {
  const texture = new Data3DTexture(data, grid.nx, grid.ny, grid.nz);
  texture.format = RGBAFormat;
  texture.type = UnsignedByteType;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

/** The ambient-cube lookup: a float in 0..1, the visible share of the sky for the surface's own normal. */
function visibilityNode(positive: Uint8Array, negative: Uint8Array, grid: IGrid) {
  const above = texture3D(volume(positive, grid));
  const below = texture3D(volume(negative, grid));
  // One cell in front of the surface, so a thin wall's two faces read their own sides, clamped to the
  // texel centres so the blend never reaches past the outermost points.
  const margin = vec3(0.5 / grid.nx, 0.5 / grid.ny, 0.5 / grid.nz);
  const sample = clamp(
    positionWorld
      .add(normalWorld.mul(grid.cell * 0.75))
      .sub(grid.origin)
      .div(grid.extent),
    margin,
    vec3(1).sub(margin),
  );
  const faces = mix(below.sample(sample).rgb, above.sample(sample).rgb, step(vec3(0), normalWorld));
  return dot(normalWorld.mul(normalWorld), faces);
}

/**
 * Bakes the sky visibility of `root` and gives every standard material under it an `aoNode` that
 * reads it. Returns what it did.
 */
export function installSkyOcclusion(ctx: ISkyRayContext, root: Object3D): ISkyOcclusionReport {
  const started = performance.now();
  root.updateMatrixWorld(true);
  const grid = gridOver(root);
  const far = grid.extent.length();
  const rays = hemisphereRays();
  const count = grid.nx * grid.ny * grid.nz;
  const positive = new Uint8Array(count * 4);
  const negative = new Uint8Array(count * 4);
  const point = new Vector3();
  let visibleSum = 0;
  for (let index = 0; index < count; index += 1) {
    const x = index % grid.nx;
    const y = Math.floor(index / grid.nx) % grid.ny;
    const z = Math.floor(index / (grid.nx * grid.ny));
    point.set(
      grid.origin.x + (x + 0.5) * grid.cell,
      grid.origin.y + (y + 0.5) * grid.cell,
      grid.origin.z + (z + 0.5) * grid.cell,
    );
    faceVisibility(ctx, point, rays, far).forEach((value, face) => {
      visibleSum += value;
      (face < 3 ? positive : negative)[index * 4 + (face % 3)] = Math.round(value * 255);
    });
    positive[index * 4 + 3] = negative[index * 4 + 3] = 255;
  }

  const visibility = visibilityNode(positive, negative, grid);
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!(mesh as { isMesh?: boolean }).isMesh) return;
    const source = mesh.material as MeshStandardMaterial;
    const material = new MeshStandardNodeMaterial();
    material.color.copy(source.color);
    material.roughness = source.roughness;
    material.metalness = source.metalness;
    material.emissive.copy(source.emissive);
    material.emissiveIntensity = source.emissiveIntensity;
    material.side = source.side;
    material.aoNode = visibility;
    mesh.material = material;
  });
  const report = {
    cell: grid.cell,
    points: count,
    rays: count * RAYS,
    milliseconds: Math.round(performance.now() - started),
    meanVisibility: visibleSum / (count * 6),
  };
  console.info(`TN_SKY_OCCLUSION ${JSON.stringify(report)}`);
  return report;
}
