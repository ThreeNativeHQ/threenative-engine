import { MATERIAL_IDS } from "./masks.js";
import { world } from "./math.js";
import type {
  IBakeMeshOptions,
  IBakeTerrainOptions,
  IBakedMesh,
  IBakedTerrain,
  ITerrainState,
} from "./types.js";

const toLinear = (color: number) =>
  color <= 0.04045 ? color / 12.92 : ((color + 0.055) / 1.055) ** 2.4;

/**
 * Bakes the recovered indexed top surface and optional vertical skirts into caller-owned arrays.
 * @requires npm i @threenative/terrain
 * @situation bake an authored terrain into portable indexed mesh arrays
 * @constraint no material is chosen; vertex colours exist only with a caller-supplied palette
 * @example const mesh = bakeMesh(new Terrain({ resolution: 17 }).evaluate());
 * @override step, chunk bounds, skirtDepth and palette belong to the caller
 */
export function bakeMesh(
  state: ITerrainState,
  {
    step = 1,
    x = 0,
    z = 0,
    cells = state.resolution - 1,
    skirtDepth = 0,
    palette,
  }: IBakeMeshOptions = {},
): IBakedMesh {
  if (!Number.isFinite(skirtDepth) || skirtDepth < 0)
    throw new RangeError("skirtDepth must be finite and nonnegative");
  const n = state.resolution;
  if (!Number.isInteger(n) || n < 2 || !Number.isFinite(state.size) || state.size <= 0)
    throw new RangeError("Invalid heightfield extent");
  if (!Number.isInteger(step) || step < 1 || (step & (step - 1)) !== 0 || cells % step !== 0)
    throw new RangeError("step must be a power of two dividing chunk cells");
  if (
    ![x, z, cells].every(Number.isInteger) ||
    x < 0 ||
    z < 0 ||
    cells < 1 ||
    x + cells >= n ||
    z + cells >= n
  )
    throw new RangeError("Chunk outside heightfield");
  if (state.height.length !== n * n || !state.height.every(Number.isFinite))
    throw new RangeError("Invalid heightfield samples");
  if (
    palette &&
    (palette.length !== 8 ||
      Array.from(palette).some(
        (rgb) =>
          !Array.isArray(rgb) ||
          rgb.length !== 3 ||
          Array.from(rgb).some((value) => !Number.isFinite(value) || value < 0 || value > 1),
      ))
  )
    throw new RangeError("palette requires eight finite sRGB triples in 0..1");
  if (palette && (state.splat.length !== n * n * 8 || !state.splat.every(Number.isFinite)))
    throw new RangeError("Invalid splat samples");
  const side = cells / step + 1;
  const base = side * side;
  const ring: number[] = [];
  if (skirtDepth > 0) {
    for (let k = 0; k < side - 1; k++) ring.push(k);
    for (let k = 0; k < side - 1; k++) ring.push(k * side + side - 1);
    for (let k = side - 1; k > 0; k--) ring.push((side - 1) * side + k);
    for (let k = side - 1; k > 0; k--) ring.push(k * side);
  }
  const count = base + ring.length;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const indices = new Uint32Array((side - 1) ** 2 * 6 + ring.length * 6);
  const colors = palette ? new Float32Array(count * 3) : undefined;
  const cell = state.size / (n - 1);
  for (let zz = 0; zz < side; zz++)
    for (let xx = 0; xx < side; xx++) {
      const gx = x + xx * step;
      const gz = z + zz * step;
      const i = gz * n + gx;
      const j = zz * side + xx;
      const dx =
        ((state.height[gz * n + Math.min(n - 1, gx + 1)] as number) -
          (state.height[gz * n + Math.max(0, gx - 1)] as number)) /
        ((gx > 0 && gx < n - 1 ? 2 : 1) * cell);
      const dz =
        ((state.height[Math.min(n - 1, gz + 1) * n + gx] as number) -
          (state.height[Math.max(0, gz - 1) * n + gx] as number)) /
        ((gz > 0 && gz < n - 1 ? 2 : 1) * cell);
      const length = Math.hypot(dx, 1, dz);
      positions.set([world(state, gx), state.height[i] as number, world(state, gz)], j * 3);
      normals.set([-dx / length, 1 / length, -dz / length], j * 3);
      if (colors && palette)
        for (let k = 0; k < 3; k++) {
          let color = 0;
          for (let c = 0; c < 8; c++)
            color += toLinear(palette[c]?.[k] as number) * (state.splat[i * 8 + c] as number);
          colors[j * 3 + k] = color;
        }
      uvs.set([gx / (n - 1), 1 - gz / (n - 1)], j * 2);
    }
  let k = 0;
  for (let zz = 0; zz < side - 1; zz++)
    for (let xx = 0; xx < side - 1; xx++) {
      const a = zz * side + xx;
      const b = a + 1;
      const c = a + side;
      const d = c + 1;
      indices.set([a, c, b, b, c, d], k);
      k += 6;
    }
  for (let j = 0; j < ring.length; j++) {
    const top = ring[j] as number;
    const bottom = base + j;
    positions.set(positions.subarray(top * 3, top * 3 + 3), bottom * 3);
    positions[bottom * 3 + 1] = (positions[bottom * 3 + 1] as number) - skirtDepth;
    normals.set(normals.subarray(top * 3, top * 3 + 3), bottom * 3);
    colors?.set(colors.subarray(top * 3, top * 3 + 3), bottom * 3);
    uvs.set(uvs.subarray(top * 2, top * 2 + 2), bottom * 2);
    const next = (j + 1) % ring.length;
    indices.set([top, ring[next] as number, bottom, ring[next] as number, base + next, bottom], k);
    k += 6;
  }
  return {
    name: `terrain_${x}_${z}_step${step}`,
    positions,
    normals,
    colors,
    uvs,
    indices,
    side,
    topVertexCount: base,
    bounds: { x, z, cells, step },
    skirtDepth,
  };
}

/**
 * Bakes finite LOD chunks, the same collision samples and resolved placements.
 * @requires npm i @threenative/terrain
 * @situation prepare terrain arrays and collision before a game starts
 * @constraint collision origin is the southwest corner; engine Heightfield origin is its centre
 * @example const baked = bakeTerrain(new Terrain({ resolution: 129 }).evaluate(), { chunkCells: 64 });
 * @override chunkCells, lodSteps, skirtDepth and palette are explicit authoring choices
 */
export function bakeTerrain(
  state: ITerrainState,
  {
    chunkCells = Math.min(64, state.resolution - 1),
    lodSteps = [1, 2, 4],
    skirtDepth = 6,
    palette,
  }: IBakeTerrainOptions = {},
): IBakedTerrain {
  if (!Number.isInteger(chunkCells) || chunkCells < 1 || (state.resolution - 1) % chunkCells !== 0)
    throw new RangeError("chunkCells must divide resolution - 1");
  if (!lodSteps.length) throw new RangeError("lodSteps must not be empty");
  const lods = lodSteps.map((step) => {
    const chunks: IBakedMesh[] = [];
    for (let z = 0; z < state.resolution - 1; z += chunkCells)
      for (let x = 0; x < state.resolution - 1; x += chunkCells)
        chunks.push(bakeMesh(state, { x, z, cells: chunkCells, step, skirtDepth, palette }));
    return { step, chunks };
  });
  return {
    version: 1,
    size: state.size,
    resolution: state.resolution,
    lods,
    collision: {
      type: "heightfield",
      size: state.size,
      resolution: state.resolution,
      cellSize: state.size / (state.resolution - 1),
      origin: [-state.size / 2, 0, -state.size / 2],
      heights: state.height.slice(),
    },
    instances: structuredClone(state.instances),
    materialChannels: [...MATERIAL_IDS],
  };
}

/** Shared wire-array validation for geometry conversion and terrain-only export. */
export function validateBakedMesh(mesh: IBakedMesh): void {
  if (
    ![mesh.positions, mesh.normals, mesh.uvs, ...(mesh.colors ? [mesh.colors] : [])].every(
      (array) => array instanceof Float32Array,
    ) ||
    !(mesh.indices instanceof Uint32Array)
  )
    throw new TypeError("Baked mesh requires Float32 attributes and Uint32 indices");
  const count = mesh.positions.length / 3;
  if (
    !count ||
    !Number.isInteger(count) ||
    mesh.normals.length !== count * 3 ||
    mesh.uvs.length !== count * 2 ||
    (mesh.colors && mesh.colors.length !== count * 3) ||
    !mesh.indices.length ||
    mesh.indices.length % 3
  )
    throw new RangeError("Baked mesh attribute counts do not agree");
  for (const array of [
    mesh.positions,
    mesh.normals,
    mesh.uvs,
    ...(mesh.colors ? [mesh.colors] : []),
  ])
    if (!array.every(Number.isFinite)) throw new RangeError("Baked mesh attributes must be finite");
  if (mesh.indices.some((index) => index >= count))
    throw new RangeError("Baked mesh index outside vertex range");
}
