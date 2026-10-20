// Harness overlay (PRD-631, L2 and L7): the world-space tier of indirect diffuse light.
//
// Unreal's global illumination gathers in tiers: screen probes trace what is on screen, and a
// world-space radiance cache of probes, traced against the scene, answers for what is not
// (Engine/Source/Runtime/Renderer/Private/Lumen/LumenScreenProbeGather.cpp and LumenRadianceCache.cpp).
// Its sky light is shadowed by the scene the same way, so a ceiling that stands over a floor gets
// none of the sky and a room with one open wall fills from that opening.
// This file is that cache for a fixed world, baked once at load from the game's own ray query:
//
//   - A 1 m grid of probes. Each shoots rays over the whole sphere and gathers, for the six axis
//     directions, the cosine-weighted radiance that arrives (an ambient cube, E / pi per face, the
//     radiance a white Lambert surface returns). A ray that misses sees the sky; one that hits a
//     surface sees what that surface returns: its albedo times the sun it receives, plus its own
//     emission, plus (from L7) the light the previous pass cached at that point.
//   - Each further bounce re-gathers the same rays with the previous grid at the hit points, so no
//     ray is traced twice (the hit list is kept).
//   - A material reads the grid through `irradianceNode`, which replaces the environment's diffuse
//     term. The environment stays the source of specular reflection.
//
// Ceiling, sky occlusion and bounce all fall out of one gather: rays below the horizon hit the
// floor and carry bounce (L7) or nothing (L2); the sky's dark lower half never leaks upward, which
// the PMREM roughness-1 blur does. A fixed-world bake: move a wall and bake again. Resolution is
// one metre, so contact-scale light is the screen-space tier's job.
import {
  Box3,
  type Color,
  Data3DTexture,
  type Intersection,
  LinearFilter,
  type Mesh,
  type MeshStandardMaterial,
  type Object3D,
  RGBAFormat,
  HalfFloatType,
  Vector3,
} from "three";
import { clamp, float, normalWorld, positionWorld, texture3D, vec3 } from "three/tsl";
import { MeshStandardNodeMaterial } from "three/webgpu";

/** What the bake needs of the game's context: the scene ray query (`ICtx.raycast`). */
export interface IRayContext {
  raycast(options: {
    origin: Vector3;
    direction: Vector3;
    far: number;
    targets?: Object3D;
  }): Intersection | undefined;
}

/** Sky radiance on three's equirectangular grid, in scene units: `data * scale` per channel. */
export interface ISkyRadiance {
  readonly data: Float32Array;
  readonly width: number;
  readonly height: number;
  readonly scale: readonly [number, number, number];
}

/** The sky `setupSky` baked, registered for the material pass. */
export const skyRadiance: { current?: ISkyRadiance } = {};

export interface IGiOptions {
  /** Passes that carry surface light back into the cache. 0 is the sky alone (Unreal L2 to L6). */
  readonly bounces: number;
  /** The sun: its colour (tint and air transmittance), intensity, and unit direction toward it. */
  readonly sun: { readonly color: Color; readonly intensity: number; readonly direction: Vector3 };
  /** Rays per probe over the sphere. */
  readonly rays?: number;
  /**
   * Unreal without global illumination (layers L2 to L6) shadows its movable sky light with the scene's
   * distance fields, up to the sky light's occlusion distance (1000 cm,
   * Engine/Source/Runtime/Engine/Private/Components/SkyLightComponent.cpp, OcclusionMaxDistance): the open
   * fraction of the surface's hemisphere scales the open sky's light, whatever the sky radiance in each
   * direction. Set, in metres, the cache does that and carries no surface light. Unset, it gathers radiance.
   */
  readonly skyShadowDistance?: number;
}

export interface IGiReport {
  readonly cell: number;
  readonly points: number;
  readonly rays: number;
  readonly shadowRays: number;
  readonly bounces: number;
  readonly milliseconds: number;
}

const CELL = 1;
const MAX_POINTS = 24000;
/** Where a probe's six faces sit in the grid arrays and the texture's z slices. */
const FACES: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
/** Surface shading is cached per half metre and per object: a floor is shaded once for a thousand rays. */
const SHADE_CELL = 0.5;

interface IGrid {
  readonly origin: Vector3;
  readonly cell: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
}

function gridOver(root: Object3D): IGrid {
  const bounds = new Box3().setFromObject(root);
  const size = bounds.getSize(new Vector3());
  const cell = Math.max(CELL, Math.cbrt((size.x * size.y * size.z) / MAX_POINTS));
  return {
    origin: new Vector3(bounds.min.x - cell, bounds.min.y, bounds.min.z - cell),
    cell,
    nx: Math.ceil(size.x / cell) + 2,
    ny: Math.ceil(size.y / cell) + 1,
    nz: Math.ceil(size.z / cell) + 2,
  };
}

/** Equal solid angle per ray over the whole sphere. */
function sphereRays(count: number): Vector3[] {
  const rays: Vector3[] = [];
  for (let k = 0; k < count; k += 1) {
    const y = 1 - ((k + 0.5) * 2) / count;
    const radius = Math.sqrt(1 - y * y);
    const phi = k * Math.PI * (3 - Math.sqrt(5));
    rays.push(new Vector3(Math.cos(phi) * radius, y, Math.sin(phi) * radius));
  }
  return rays;
}

/** Bilinear read of the baked sky in a direction, in scene radiance. */
function skyAt(sky: ISkyRadiance, d: Vector3, out: number[]): void {
  const u = (Math.atan2(d.z, d.x) / (2 * Math.PI) + 0.5) * sky.width - 0.5;
  const v = (Math.acos(Math.max(-1, Math.min(1, d.y))) / Math.PI) * sky.height - 0.5;
  const [x0, y0] = [Math.floor(u), Math.floor(v)];
  const [fx, fy] = [u - x0, v - y0];
  for (let c = 0; c < 3; c += 1) {
    const at = (x: number, y: number): number =>
      sky.data[
        (Math.min(sky.height - 1, Math.max(0, y)) * sky.width + ((x + sky.width) % sky.width)) * 3 + c
      ] ?? 0;
    const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
    const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
    out[c] = (top * (1 - fy) + bottom * fy) * (sky.scale[c] ?? 1);
  }
}

/** One ray's result, kept so each bounce reuses it. */
interface IHits {
  /** Per ray: 0 miss, 1 hit. */
  readonly hit: Uint8Array;
  /** Miss: the sky radiance. Hit: the surface's own radiance (sun and emission), before the cache. */
  readonly base: Float32Array;
  /** Hit: albedo, and the point and normal the cache is read at. */
  readonly albedo: Float32Array;
  readonly point: Float32Array;
  readonly normal: Float32Array;
  /** The sky radiance along the ray, hit or not, and the distance to the hit (far when open). */
  readonly sky: Float32Array;
  readonly distance: Float32Array;
}

/** The ambient-cube read of a grid at `point` for `normal`: E / pi, trilinear over the probes. */
function readGrid(grid: IGrid, values: Float32Array, point: Vector3, normal: Vector3, out: number[]): void {
  const [fx, fy, fz] = [
    Math.min(grid.nx - 1, Math.max(0, (point.x - grid.origin.x) / grid.cell - 0.5)),
    Math.min(grid.ny - 1, Math.max(0, (point.y - grid.origin.y) / grid.cell - 0.5)),
    Math.min(grid.nz - 1, Math.max(0, (point.z - grid.origin.z) / grid.cell - 0.5)),
  ];
  const [x0, y0, z0] = [Math.floor(fx), Math.floor(fy), Math.floor(fz)];
  const [x1, y1, z1] = [Math.min(grid.nx - 1, x0 + 1), Math.min(grid.ny - 1, y0 + 1), Math.min(grid.nz - 1, z0 + 1)];
  const [tx, ty, tz] = [fx - x0, fy - y0, fz - z0];
  const weights = [normal.x * normal.x, normal.y * normal.y, normal.z * normal.z];
  const faces = [normal.x < 0 ? 1 : 0, normal.y < 0 ? 3 : 2, normal.z < 0 ? 5 : 4];
  out[0] = out[1] = out[2] = 0;
  for (let corner = 0; corner < 8; corner += 1) {
    const [ix, iy, iz] = [corner & 1 ? x1 : x0, corner & 2 ? y1 : y0, corner & 4 ? z1 : z0];
    const w =
      (corner & 1 ? tx : 1 - tx) * (corner & 2 ? ty : 1 - ty) * (corner & 4 ? tz : 1 - tz);
    const probe = ix + grid.nx * (iy + grid.ny * iz);
    for (let a = 0; a < 3; a += 1)
      for (let c = 0; c < 3; c += 1)
        out[c] = (out[c] ?? 0) + w * (weights[a] ?? 0) * (values[(probe * 6 + (faces[a] ?? 0)) * 3 + c] ?? 0);
  }
}

/** A probe inside a solid sees only the back of it: it takes the mean of the valid probes around it (Lumen drops them from the blend). */
function dilateInvalid(grid: IGrid, values: Float32Array, backfaces: Uint16Array, rays: number): void {
  const invalid = (p: number): boolean => (backfaces[p] ?? 0) > rays * 0.25;
  const copy = values.slice();
  for (let p = 0; p < backfaces.length; p += 1) {
    if (!invalid(p)) continue;
    const [x, y, z] = [p % grid.nx, Math.floor(p / grid.nx) % grid.ny, Math.floor(p / (grid.nx * grid.ny))];
    const sum = new Float32Array(18);
    let count = 0;
    for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
      const [nx, ny, nz] = [x + dx, y + dy, z + dz];
      if (nx < 0 || ny < 0 || nz < 0 || nx >= grid.nx || ny >= grid.ny || nz >= grid.nz) continue;
      const q = nx + grid.nx * (ny + grid.ny * nz);
      if (invalid(q)) continue;
      for (let j = 0; j < 18; j += 1) sum[j] = (sum[j] ?? 0) + (copy[q * 18 + j] ?? 0);
      count += 1;
    }
    if (count > 0) for (let j = 0; j < 18; j += 1) values[p * 18 + j] = (sum[j] ?? 0) / count;
  }
}

const halfView = new DataView(new ArrayBuffer(4));
/** float32 to IEEE binary16 bits (round to nearest, subnormals flushed: irradiance is never that small). */
function toHalf(value: number): number {
  halfView.setFloat32(0, value);
  const bits = halfView.getUint32(0);
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  if (exponent <= 0) return sign;
  if (exponent >= 31) return sign | 0x7bff;
  return sign | (exponent << 10) | ((bits >>> 13) & 0x3ff);
}

function volume(values: Float32Array, grid: IGrid): Data3DTexture {
  const slices = grid.nz * 6;
  const texels = new Uint16Array(grid.nx * grid.ny * slices * 4);
  for (let probe = 0; probe < grid.nx * grid.ny * grid.nz; probe += 1) {
    const [x, y, z] = [
      probe % grid.nx,
      Math.floor(probe / grid.nx) % grid.ny,
      Math.floor(probe / (grid.nx * grid.ny)),
    ];
    for (let face = 0; face < 6; face += 1) {
      const o = (x + grid.nx * (y + grid.ny * (face * grid.nz + z))) * 4;
      for (let c = 0; c < 3; c += 1) texels[o + c] = toHalf(values[(probe * 6 + face) * 3 + c] ?? 0);
      texels[o + 3] = toHalf(1);
    }
  }
  // The engine's Data3DTexture constructor takes bytes or floats, so the half-float bits go in through
  // `image.data` once the type says what they are (the path three's own examples take too).
  const texture = new Data3DTexture(new Float32Array(texels.length), grid.nx, grid.ny, slices);
  texture.format = RGBAFormat;
  texture.type = HalfFloatType;
  (texture.image as unknown as { data: Uint16Array }).data = texels;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

/** The ambient-cube read as a TSL node over the surface's own world position and normal: E / pi. */
function irradianceNode(values: Float32Array, grid: IGrid) {
  const volumeNode = texture3D(volume(values, grid));
  const n = normalWorld.normalize();
  const at = positionWorld.add(n.mul(grid.cell * 0.75)).sub(grid.origin).div(grid.cell);
  // Texel units, clamped to the texel centres so no sub-volume reads past its own slices.
  const u = clamp(at.x, 0.5, grid.nx - 0.5).div(grid.nx);
  const v = clamp(at.y, 0.5, grid.ny - 0.5).div(grid.ny);
  const z = clamp(at.z, 0.5, grid.nz - 0.5);
  const face = (axis: 0 | 1 | 2) => {
    const component = axis === 0 ? n.x : axis === 1 ? n.y : n.z;
    const index = component.lessThan(0).select(float(axis * 2 + 1), float(axis * 2));
    const w = index.mul(grid.nz).add(z).div(grid.nz * 6);
    return volumeNode.sample(vec3(u, v, w)).rgb.mul(component.mul(component));
  };
  return face(0).add(face(1)).add(face(2));
}

/**
 * Bakes the cache for `root` and gives every standard material under it an `irradianceNode` that
 * reads it. Returns what it did, or undefined when there is no sky to gather (no OffscreenCanvas).
 */
export function installGi(ctx: IRayContext, root: Object3D, options: IGiOptions): IGiReport | undefined {
  const sky = skyRadiance.current;
  if (sky === undefined) return undefined;
  const started = performance.now();
  root.updateMatrixWorld(true);
  const grid = gridOver(root);
  const far = Math.hypot(grid.nx, grid.ny, grid.nz) * grid.cell;
  const rays = sphereRays(options.rays ?? 48);
  const probes = grid.nx * grid.ny * grid.nz;
  const total = probes * rays.length;
  const hits: IHits = {
    hit: new Uint8Array(total),
    base: new Float32Array(total * 3),
    albedo: new Float32Array(total * 3),
    point: new Float32Array(total * 3),
    normal: new Float32Array(total * 3),
    sky: new Float32Array(total * 3),
    distance: new Float32Array(total).fill(far),
  };
  const sunRadiance = [0, 1, 2].map(
    (c) => ([options.sun.color.r, options.sun.color.g, options.sun.color.b][c] ?? 0) * (options.sun.intensity / Math.PI),
  );
  const shaded = new Map<string, number[]>();
  /** Rays per probe that left through the back of a surface: a probe inside a wall sees only those. */
  const backfaces = new Uint16Array(grid.nx * grid.ny * grid.nz);
  let shadowRays = 0;
  const origin = new Vector3();
  const point = new Vector3();
  const normal = new Vector3();
  const colour = [0, 0, 0];

  /** What a surface point returns of the sun (albedo x sun x cos x visibility) plus its emission. */
  const surface = (hit: Intersection, albedo: number[], emissive: number[]): number[] => {
    const key = `${hit.object.id}|${Math.floor(point.x / SHADE_CELL)}|${Math.floor(point.y / SHADE_CELL)}|${Math.floor(point.z / SHADE_CELL)}|${Math.round(normal.x)}${Math.round(normal.y)}${Math.round(normal.z)}`;
    const cached = shaded.get(key);
    if (cached !== undefined) return cached;
    const cosine = Math.max(0, normal.dot(options.sun.direction));
    let visible = 0;
    if (cosine > 0) {
      shadowRays += 1;
      origin.copy(normal).multiplyScalar(0.02).add(point);
      visible = ctx.raycast({ origin, direction: options.sun.direction, far, targets: root }) === undefined ? 1 : 0;
    }
    const lit = [0, 1, 2].map(
      (c) => (albedo[c] ?? 0) * (sunRadiance[c] ?? 0) * cosine * visible + (emissive[c] ?? 0),
    );
    shaded.set(key, lit);
    return lit;
  };

  const materialData = new Map<number, { albedo: number[]; emissive: number[] }>();
  const dataOf = (object: Object3D): { albedo: number[]; emissive: number[] } => {
    const known = materialData.get(object.id);
    if (known !== undefined) return known;
    const m = (object as Mesh).material as MeshStandardMaterial;
    const k = 1 - (m.metalness ?? 0);
    const data = {
      albedo: [m.color.r * k, m.color.g * k, m.color.b * k],
      emissive: [0, 1, 2].map((c) => [m.emissive.r, m.emissive.g, m.emissive.b][c]! * (m.emissiveIntensity ?? 1)),
    };
    materialData.set(object.id, data);
    return data;
  };

  for (let probe = 0; probe < probes; probe += 1) {
    const [x, y, z] = [probe % grid.nx, Math.floor(probe / grid.nx) % grid.ny, Math.floor(probe / (grid.nx * grid.ny))];
    const centre = new Vector3(
      grid.origin.x + (x + 0.5) * grid.cell,
      grid.origin.y + (y + 0.5) * grid.cell,
      grid.origin.z + (z + 0.5) * grid.cell,
    );
    rays.forEach((direction, k) => {
      const i = probe * rays.length + k;
      const hit = ctx.raycast({ origin: centre, direction, far, targets: root });
      skyAt(sky, direction, colour);
      hits.sky.set(colour, i * 3);
      if (hit === undefined) {
        hits.base.set(colour, i * 3);
        return;
      }
      hits.hit[i] = 1;
      hits.distance[i] = hit.distance;
      point.copy(hit.point);
      normal.copy(hit.face?.normal ?? direction).transformDirection(hit.object.matrixWorld);
      if (normal.dot(direction) > 0) normal.negate();
      const { albedo, emissive } = dataOf(hit.object);
      hits.base.set(options.bounces > 0 ? surface(hit, albedo, emissive) : [0, 0, 0], i * 3);
      if (hit.face !== null && hit.face !== undefined && hit.face.normal.clone().transformDirection(hit.object.matrixWorld).dot(direction) > 0)
        backfaces[probe] = (backfaces[probe] ?? 0) + 1;
      hits.albedo.set(albedo, i * 3);
      hits.point.set([point.x, point.y, point.z], i * 3);
      hits.normal.set([normal.x, normal.y, normal.z], i * 3);
    });
  }

  // Sky only (L2 to L6): a hit returns nothing, except what a surface itself emits. Each bounce adds
  // the cache read at the hit point, times the albedo.
  const values = new Float32Array(probes * 6 * 3);
  const shadowing = options.skyShadowDistance !== undefined;
  const gather = (previous: Float32Array | undefined): void => {
    const cached = [0, 0, 0];
    for (let probe = 0; probe < probes; probe += 1) {
      const sum = new Float32Array(18);
      const open = new Float32Array(6);
      const weight = new Float32Array(6);
      for (let k = 0; k < rays.length; k += 1) {
        const i = probe * rays.length + k;
        const d = rays[k] as Vector3;
        if (shadowing) {
          const free = hits.hit[i] === 0 || (hits.distance[i] ?? 0) > (options.skyShadowDistance ?? 0);
          FACES.forEach((face, f) => {
            const w = Math.max(0, face[0] * d.x + face[1] * d.y + face[2] * d.z);
            weight[f] = (weight[f] ?? 0) + w;
            if (free) open[f] = (open[f] ?? 0) + w;
            for (let c = 0; c < 3; c += 1)
              sum[f * 3 + c] = (sum[f * 3 + c] ?? 0) + w * (hits.sky[i * 3 + c] ?? 0);
          });
          continue;
        }
        let [r, g, b] = [hits.base[i * 3] ?? 0, hits.base[i * 3 + 1] ?? 0, hits.base[i * 3 + 2] ?? 0];
        if (hits.hit[i] === 1 && previous !== undefined) {
          point.set(hits.point[i * 3] ?? 0, hits.point[i * 3 + 1] ?? 0, hits.point[i * 3 + 2] ?? 0);
          normal.set(hits.normal[i * 3] ?? 0, hits.normal[i * 3 + 1] ?? 0, hits.normal[i * 3 + 2] ?? 0);
          point.addScaledVector(normal, grid.cell * 0.75);
          readGrid(grid, previous, point, normal, cached);
          r += (hits.albedo[i * 3] ?? 0) * (cached[0] ?? 0);
          g += (hits.albedo[i * 3 + 1] ?? 0) * (cached[1] ?? 0);
          b += (hits.albedo[i * 3 + 2] ?? 0) * (cached[2] ?? 0);
        }
        FACES.forEach((face, f) => {
          const w = Math.max(0, face[0] * d.x + face[1] * d.y + face[2] * d.z);
          sum[f * 3] = (sum[f * 3] ?? 0) + w * r;
          sum[f * 3 + 1] = (sum[f * 3 + 1] ?? 0) + w * g;
          sum[f * 3 + 2] = (sum[f * 3 + 2] ?? 0) + w * b;
        });
      }
      // E / pi = (1 / pi) x sum(L cos dOmega) with dOmega = 4 pi / rays.
      for (let j = 0; j < 18; j += 1) {
        const visible = shadowing ? (open[Math.floor(j / 3)] ?? 0) / Math.max(1e-6, weight[Math.floor(j / 3)] ?? 0) : 1;
        values[probe * 18 + j] = (((sum[j] ?? 0) * 4) / rays.length) * visible;
      }
    }
  };
  gather(undefined);
  for (let pass = 1; pass < options.bounces; pass += 1) gather(values.slice());
  dilateInvalid(grid, values, backfaces, rays.length);

  const node = irradianceNode(values, grid);
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
    (material as unknown as { irradianceNode: unknown }).irradianceNode = node;
    mesh.material = material;
  });
  const report: IGiReport = {
    cell: grid.cell,
    points: probes,
    rays: total,
    shadowRays,
    bounces: options.bounces,
    milliseconds: Math.round(performance.now() - started),
  };
  console.info(`TN_GI_CACHE ${JSON.stringify(report)}`);
  return report;
}
