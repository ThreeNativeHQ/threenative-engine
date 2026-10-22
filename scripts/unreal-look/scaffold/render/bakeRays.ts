import type { InstancedMesh, Intersection, Material, Mesh, Object3D } from "three";
import { Matrix4, Vector2, Vector3 } from "three";
import type { IRayContext } from "./giCache.js";

/**
 * The bake's ray query: one bounding volume hierarchy over every triangle under `root`, in world space.
 *
 * `ctx.raycast` walks the scene graph and calls into the engine for every object on every ray; the GI bake
 * casts millions of rays, so that walk is most of its time on the Wasm engine. The geometry does not move during
 * a bake, so it is read once here and each ray runs on plain typed arrays. The answers match `ctx.raycast`:
 * the nearest triangle, culled by the material's `side` (read once, when the query is built; `doubleSided` overrides it
 * for the link rays), the
 * object, the face normal in the object's local space, the material slot and the UV (PRD-639: a texture is read where
 * the ray lands). The hit object is reused between rays.
 */
const LEAF = 4;
const PAD = 1e-4;
/** An instanced mesh is expanded into world-space triangles: past this many, the bake keeps the stock query. */
const MAX_TRIANGLES = 4_000_000;

/** What `cast` found, in plain numbers: no vector object is made or read per ray. */
export interface IFlatHit {
  distance: number;
  /** The hit point in world space. */
  x: number;
  y: number;
  z: number;
  /** The face normal in the object's local space. */
  nx: number;
  ny: number;
  nz: number;
  u: number;
  v: number;
  /** The mesh that was hit, as an index into `objects`, and its material slot. */
  owner: number;
  slot: number;
}

/** The flat query, with a switch that makes every material double-sided for the rays that follow. */
export interface IFlatRays extends IRayContext {
  doubleSided: boolean;
  /** The meshes `result.owner` indexes. */
  readonly objects: readonly Object3D[];
  /**
   * The same query from plain numbers: true on a hit, which `result` then holds. On the owned engine each field of a vector
   * is a call into the engine, so `raycast` spends more on its arguments and its answer than on the ray.
   */
  cast(
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    far: number,
  ): boolean;
  readonly result: IFlatHit;
}

/** The flat query over `root`, or `undefined` for a scene it cannot flatten: the caller keeps `ctx.raycast`. */
export function bakeRays(root: Object3D): IFlatRays | undefined {
  return build(root);
}

/**
 * Per triangle, the edges from corner a to b and to c and their cross product, as the ray test needs them (the corner
 * order of a back-face-only material is the reverse and is worked out per ray).
 */
function triangleEdges(corners: Float64Array, count: number): Float64Array {
  const edges = new Float64Array(count * 9);
  for (let t = 0; t < count; t += 1) {
    const c = t * 9;
    const e1x = (corners[c + 3] ?? 0) - (corners[c] ?? 0);
    const e1y = (corners[c + 4] ?? 0) - (corners[c + 1] ?? 0);
    const e1z = (corners[c + 5] ?? 0) - (corners[c + 2] ?? 0);
    const e2x = (corners[c + 6] ?? 0) - (corners[c] ?? 0);
    const e2y = (corners[c + 7] ?? 0) - (corners[c + 1] ?? 0);
    const e2z = (corners[c + 8] ?? 0) - (corners[c + 2] ?? 0);
    edges[c] = e1x;
    edges[c + 1] = e1y;
    edges[c + 2] = e1z;
    edges[c + 3] = e2x;
    edges[c + 4] = e2y;
    edges[c + 5] = e2z;
    edges[c + 6] = e1y * e2z - e1z * e2y;
    edges[c + 7] = e1z * e2x - e1x * e2z;
    edges[c + 8] = e1x * e2y - e1y * e2x;
  }
  return edges;
}

/**
 * Writes instance `instance`'s world matrix (the mesh's times its own) into `world`, and returns the inverse transpose
 * of the instance's 3 x 3: its columns are the cross products of the other two columns over the determinant.
 */
function instanceFrame(
  mesh: InstancedMesh,
  instance: number,
  scratch: Matrix4,
  world: Float64Array,
): number[] {
  mesh.getMatrixAt(instance, scratch);
  const i = scratch.elements;
  const base = mesh.matrixWorld.elements;
  for (let c = 0; c < 4; c += 1)
    for (let r = 0; r < 4; r += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += (base[k * 4 + r] ?? 0) * (i[c * 4 + k] ?? 0);
      world[c * 4 + r] = sum;
    }
  const [a0, a1, a2] = [0, 4, 8].map((o) => [i[o] ?? 0, i[o + 1] ?? 0, i[o + 2] ?? 0]) as [
    number[],
    number[],
    number[],
  ];
  const cross = (u: number[], v: number[]) => [
    (u[1] ?? 0) * (v[2] ?? 0) - (u[2] ?? 0) * (v[1] ?? 0),
    (u[2] ?? 0) * (v[0] ?? 0) - (u[0] ?? 0) * (v[2] ?? 0),
    (u[0] ?? 0) * (v[1] ?? 0) - (u[1] ?? 0) * (v[0] ?? 0),
  ];
  const [c0, c1, c2] = [cross(a1, a2), cross(a2, a0), cross(a0, a1)] as [
    number[],
    number[],
    number[],
  ];
  const det =
    (a0[0] ?? 0) * (c0[0] ?? 0) + (a0[1] ?? 0) * (c0[1] ?? 0) + (a0[2] ?? 0) * (c0[2] ?? 0);
  return [...c0, ...c1, ...c2].map((v) => v / (det === 0 ? 1 : det));
}

function build(root: Object3D): IFlatRays | undefined {
  root.updateMatrixWorld(true);
  const meshes: Mesh[] = [];
  let unsupported: string | undefined;
  root.traverse((object) => {
    const mesh = object as Mesh & {
      isInstancedMesh?: boolean;
      isSkinnedMesh?: boolean;
      isBatchedMesh?: boolean;
    };
    if (!mesh.isMesh) return;
    // Deformed meshes keep the stock path: their rest positions are not where the ray should hit.
    if (
      mesh.isSkinnedMesh === true ||
      mesh.isBatchedMesh === true ||
      (mesh.morphTargetInfluences?.length ?? 0) > 0
    )
      unsupported ??= mesh.name || mesh.type;
    if (mesh.layers.isEnabled(0)) meshes.push(mesh);
  });
  if (unsupported !== undefined) {
    // The bake then casts through `ctx.raycast` and cannot be sliced: say so, it is 10 times slower.
    console.warn(
      `TN_GI_STOCK_RAYS the mesh '${unsupported}' is deformed: the bake runs in one call`,
    );
    return undefined;
  }

  // An instanced mesh counts once per instance: the hierarchy holds every copy in world space.
  const instancesOf = (mesh: Mesh): number => {
    const instanced = mesh as Partial<InstancedMesh>;
    return instanced.isInstancedMesh === true ? (instanced.count ?? 0) : 1;
  };
  let count = 0;
  for (const mesh of meshes) {
    const index = mesh.geometry.index;
    const position = mesh.geometry.attributes.position;
    if (position === undefined) continue;
    count += Math.floor((index?.count ?? position.count) / 3) * instancesOf(mesh);
  }
  if (count > MAX_TRIANGLES) {
    console.warn(`TN_GI_STOCK_RAYS ${count} triangles after instancing: the bake runs in one call`);
    return undefined;
  }
  // Per triangle: three world-space corners, their UVs, the local face normal, the owner mesh and its material slot.
  const corners = new Float64Array(count * 9);
  const uvs = new Float32Array(count * 6);
  const normals = new Float32Array(count * 3);
  const owner = new Uint32Array(count);
  const slot = new Uint16Array(count);
  let filled = 0;
  const scratch = new Matrix4();
  const world = new Float64Array(16);
  meshes.forEach((mesh, meshIndex) => {
    const geometry = mesh.geometry;
    const position = geometry.attributes.position;
    if (position === undefined) return;
    const index = geometry.index;
    const instanced = (mesh as Partial<InstancedMesh>).isInstancedMesh === true;
    const groups = geometry.groups;
    const uv = geometry.attributes.uv;
    const local = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const triangles = Math.floor((index?.count ?? position.count) / 3);
    for (let instance = 0, copies = instancesOf(mesh); instance < copies; instance += 1) {
      // The copy's world matrix is the mesh's times its own; its rotation also turns the local face normal, because
      // the shading reads that normal through the mesh's matrix alone (`hit.object` is the whole instanced mesh).
      const cofactor = instanced
        ? instanceFrame(mesh as InstancedMesh, instance, scratch, world)
        : undefined;
      const m = instanced ? world : mesh.matrixWorld.elements;
      // A mirroring matrix reverses the winding the ray test culls by: restore it.
      const mirrored =
        (m[0] ?? 0) * ((m[5] ?? 0) * (m[10] ?? 0) - (m[6] ?? 0) * (m[9] ?? 0)) -
          (m[4] ?? 0) * ((m[1] ?? 0) * (m[10] ?? 0) - (m[2] ?? 0) * (m[9] ?? 0)) +
          (m[8] ?? 0) * ((m[1] ?? 0) * (m[6] ?? 0) - (m[2] ?? 0) * (m[5] ?? 0)) <
        0;
      for (let t = 0; t < triangles; t += 1) {
        for (let k = 0; k < 3; k += 1) {
          const v = index === null ? t * 3 + k : index.getX(t * 3 + k);
          local[k * 3] = position.getX(v);
          local[k * 3 + 1] = position.getY(v);
          local[k * 3 + 2] = position.getZ(v);
          // Stored in the same corner order as the world positions, so a mirrored swap moves both.
          if (uv !== undefined) {
            const target = mirrored && k > 0 ? 3 - k : k;
            uvs[filled * 6 + target * 2] = uv.getX(v);
            uvs[filled * 6 + target * 2 + 1] = uv.getY(v);
          }
        }
        const [ax, ay, az, bx, by, bz, cx, cy, cz] = local as [
          number,
          number,
          number,
          number,
          number,
          number,
          number,
          number,
          number,
        ];
        // Three's Triangle.getNormal: (c - b) x (a - b), normalised.
        const [ux, uy, uz] = [cx - bx, cy - by, cz - bz];
        const [wx, wy, wz] = [ax - bx, ay - by, az - bz];
        let [nx, ny, nz] = [uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx];
        const length = Math.hypot(nx, ny, nz);
        if (length > 0) [nx, ny, nz] = [nx / length, ny / length, nz / length];
        if (cofactor !== undefined) {
          const [c0, c1, c2, c3, c4, c5, c6, c7, c8] = cofactor as [
            number,
            number,
            number,
            number,
            number,
            number,
            number,
            number,
            number,
          ];
          [nx, ny, nz] = [
            c0 * nx + c3 * ny + c6 * nz,
            c1 * nx + c4 * ny + c7 * nz,
            c2 * nx + c5 * ny + c8 * nz,
          ];
          const turned = Math.hypot(nx, ny, nz);
          if (turned > 0) [nx, ny, nz] = [nx / turned, ny / turned, nz / turned];
        }
        const o = filled * 9;
        for (let k = 0; k < 3; k += 1) {
          const [x, y, z] = [local[k * 3] ?? 0, local[k * 3 + 1] ?? 0, local[k * 3 + 2] ?? 0];
          // Swapping corners 1 and 2 restores the local winding under a mirror.
          const target = mirrored && k > 0 ? 3 - k : k;
          corners[o + target * 3] =
            (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0);
          corners[o + target * 3 + 1] =
            (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0);
          corners[o + target * 3 + 2] =
            (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z + (m[14] ?? 0);
        }
        normals[filled * 3] = nx;
        normals[filled * 3 + 1] = ny;
        normals[filled * 3 + 2] = nz;
        owner[filled] = meshIndex;
        let materialIndex = 0;
        if (Array.isArray(mesh.material)) {
          const first = t * 3;
          const group = groups.find((g) => first >= g.start && first < g.start + g.count);
          materialIndex = group?.materialIndex ?? 0;
        }
        slot[filled] = materialIndex;
        filled += 1;
      }
    }
  });

  const edges = triangleEdges(corners, count);

  // Median split on the widest centroid axis; nodes are flat arrays, children are node + 1 and `right`.
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i += 1) order[i] = i;
  const centroid = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1)
    for (let a = 0; a < 3; a += 1)
      centroid[i * 3 + a] =
        ((corners[i * 9 + a] ?? 0) +
          (corners[i * 9 + 3 + a] ?? 0) +
          (corners[i * 9 + 6 + a] ?? 0)) /
        3;
  // A median split leaves 2 to 4 triangles in a leaf, so at most `count` leaves and `2 x count` nodes.
  const maxNodes = Math.max(1, 2 * count);
  const bounds = new Float32Array(maxNodes * 6);
  /** Inner: `start` is the right child, `size` is 0. Leaf: `start` and `size` index `order`. */
  const start = new Int32Array(maxNodes);
  const size = new Int32Array(maxNodes);
  const axisOf = new Uint8Array(maxNodes);
  let nodes = 0;
  const split = (from: number, to: number): number => {
    const node = nodes;
    nodes += 1;
    const lo = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
    const hi = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
    const clo = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
    const chi = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (let i = from; i < to; i += 1) {
      const t = order[i] ?? 0;
      for (let k = 0; k < 3; k += 1)
        for (let a = 0; a < 3; a += 1) {
          const v = corners[t * 9 + k * 3 + a] ?? 0;
          if (v < (lo[a] ?? 0)) lo[a] = v;
          if (v > (hi[a] ?? 0)) hi[a] = v;
        }
      for (let a = 0; a < 3; a += 1) {
        const v = centroid[t * 3 + a] ?? 0;
        if (v < (clo[a] ?? 0)) clo[a] = v;
        if (v > (chi[a] ?? 0)) chi[a] = v;
      }
    }
    for (let a = 0; a < 3; a += 1) {
      // Padded, so rounding the box to float32 never shrinks it past a triangle.
      bounds[node * 6 + a] = (lo[a] ?? 0) - PAD;
      bounds[node * 6 + 3 + a] = (hi[a] ?? 0) + PAD;
    }
    const [sx, sy, sz] = [0, 1, 2].map((a) => (chi[a] ?? 0) - (clo[a] ?? 0)) as [
      number,
      number,
      number,
    ];
    const axis = sx >= sy && sx >= sz ? 0 : sy >= sz ? 1 : 2;
    if (to - from <= LEAF || Math.max(sx, sy, sz) <= 0) {
      start[node] = from;
      size[node] = to - from;
      return node;
    }
    const middle = (from + to) >> 1;
    select(order, centroid, axis, from, to - 1, middle);
    axisOf[node] = axis;
    split(from, middle);
    start[node] = split(middle, to);
    return node;
  };
  if (count > 0) split(0, count);

  const objects = meshes;
  // The sides the rays cull by are those of the materials the scene authored: the GI cache swaps a mesh's material for a
  // node twin after this is built, and a twin that lost its `side` must not change what a ray hits. They are read here,
  // once per mesh and slot: on the owned engine a material's `side` is a call into the engine, and reading it for each
  // candidate triangle of every ray took 8 of the 10 seconds of a bake of the sunlit room.
  const sides = meshes.map((mesh) => {
    const material = mesh.material as Material | Material[];
    return Array.isArray(material) ? material.map((m) => m?.side ?? 0) : (material?.side ?? 0);
  });
  const sideOfTriangle = new Uint8Array(count);
  for (let t = 0; t < count; t += 1) {
    const own = sides[owner[t] ?? 0] ?? 0;
    sideOfTriangle[t] = typeof own === "number" ? own : (own[slot[t] ?? 0] ?? 0);
  }
  const hit = {
    distance: 0,
    point: new Vector3(),
    face: { a: 0, b: 0, c: 0, normal: new Vector3(), materialIndex: 0 },
    uv: new Vector2(),
    object: undefined as unknown as Object3D,
  };
  const stack = new Int32Array(64);
  const result: IFlatHit = {
    distance: 0,
    x: 0,
    y: 0,
    z: 0,
    nx: 0,
    ny: 0,
    nz: 0,
    u: 0,
    v: 0,
    owner: 0,
    slot: 0,
  };
  // Plain scalars throughout: this runs a million times per bake, and a destructured array literal is an allocation.
  const cast = (
    ox: number,
    oy: number,
    oz: number,
    dx: number,
    dy: number,
    dz: number,
    far: number,
  ): boolean => {
    const ix = 1 / dx;
    const iy = 1 / dy;
    const iz = 1 / dz;
    const everySide = rays.doubleSided;
    let best = far;
    let found = -1;
    // The best hit's barycentric weights of its second and third corner, and whether a back-sided test swapped them.
    let bestB = 0;
    let bestC = 0;
    let swapped = false;
    stack[0] = 0;
    let top = 1;
    while (top > 0) {
      top -= 1;
      const node = stack[top] ?? 0;
      const b = node * 6;
      // Slab test against the node's box, limited to the best hit so far. The near plane of each axis is the one the ray
      // meets first (chosen by the sign of its direction, so no min / max per axis). A ray parallel to an axis only
      // has to start between that axis' planes (0 x infinity is NaN, so the division is skipped).
      let tmin = 0;
      let tmax = best;
      if (dx === 0) {
        if (ox < (bounds[b] ?? 0) || ox > (bounds[b + 3] ?? 0)) continue;
      } else {
        const near = (bounds[dx < 0 ? b + 3 : b] ?? 0) - ox;
        const far = (bounds[dx < 0 ? b : b + 3] ?? 0) - ox;
        const t1 = near * ix;
        const t2 = far * ix;
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
      }
      if (dy === 0) {
        if (oy < (bounds[b + 1] ?? 0) || oy > (bounds[b + 4] ?? 0)) continue;
      } else {
        const t1 = ((bounds[dy < 0 ? b + 4 : b + 1] ?? 0) - oy) * iy;
        const t2 = ((bounds[dy < 0 ? b + 1 : b + 4] ?? 0) - oy) * iy;
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
      }
      if (dz === 0) {
        if (oz < (bounds[b + 2] ?? 0) || oz > (bounds[b + 5] ?? 0)) continue;
      } else {
        const t1 = ((bounds[dz < 0 ? b + 5 : b + 2] ?? 0) - oz) * iz;
        const t2 = ((bounds[dz < 0 ? b + 2 : b + 5] ?? 0) - oz) * iz;
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
      }
      if (tmin > tmax) continue;
      const count = size[node] ?? 0;
      if (count === 0) {
        // Visit the near child first.
        const along = axisOf[node] ?? 0;
        const negative = (along === 0 ? dx : along === 1 ? dy : dz) < 0;
        const right = start[node] ?? 0;
        stack[top] = negative ? node + 1 : right;
        stack[top + 1] = negative ? right : node + 1;
        top += 2;
        continue;
      }
      const from = start[node] ?? 0;
      for (let i = from; i < from + count; i += 1) {
        const t = order[i] ?? 0;
        const side = everySide ? 2 : (sideOfTriangle[t] ?? 0);
        const c = t * 9;
        // Three's Ray.intersectTriangle, culled by FrontSide (0), reversed for BackSide (1).
        let ax = corners[c] ?? 0;
        let ay = corners[c + 1] ?? 0;
        let az = corners[c + 2] ?? 0;
        let e1x = edges[c] ?? 0;
        let e1y = edges[c + 1] ?? 0;
        let e1z = edges[c + 2] ?? 0;
        let e2x = edges[c + 3] ?? 0;
        let e2y = edges[c + 4] ?? 0;
        let e2z = edges[c + 5] ?? 0;
        let nx = edges[c + 6] ?? 0;
        let ny = edges[c + 7] ?? 0;
        let nz = edges[c + 8] ?? 0;
        if (side === 1) {
          // Corners a and c trade places.
          ax = corners[c + 6] ?? 0;
          ay = corners[c + 7] ?? 0;
          az = corners[c + 8] ?? 0;
          e1x = (corners[c + 3] ?? 0) - ax;
          e1y = (corners[c + 4] ?? 0) - ay;
          e1z = (corners[c + 5] ?? 0) - az;
          e2x = (corners[c] ?? 0) - ax;
          e2y = (corners[c + 1] ?? 0) - ay;
          e2z = (corners[c + 2] ?? 0) - az;
          nx = e1y * e2z - e1z * e2y;
          ny = e1z * e2x - e1x * e2z;
          nz = e1x * e2y - e1y * e2x;
        }
        let ddn = dx * nx + dy * ny + dz * nz;
        let sign: number;
        if (ddn > 0) {
          if (side !== 2) continue;
          sign = 1;
        } else if (ddn < 0) {
          sign = -1;
          ddn = -ddn;
        } else continue;
        const qx = ox - ax;
        const qy = oy - ay;
        const qz = oz - az;
        // diff x edge2, edge1 x diff.
        const ddqxe2 =
          sign *
          (dx * (qy * e2z - qz * e2y) + dy * (qz * e2x - qx * e2z) + dz * (qx * e2y - qy * e2x));
        if (ddqxe2 < 0) continue;
        const dde1xq =
          sign *
          (dx * (e1y * qz - e1z * qy) + dy * (e1z * qx - e1x * qz) + dz * (e1x * qy - e1y * qx));
        if (dde1xq < 0) continue;
        if (ddqxe2 + dde1xq > ddn) continue;
        const qdn = -sign * (qx * nx + qy * ny + qz * nz);
        if (qdn < 0) continue;
        const distance = qdn / ddn;
        if (distance > best || distance < 0) continue;
        best = distance;
        found = t;
        bestB = ddqxe2 / ddn;
        bestC = dde1xq / ddn;
        swapped = side === 1;
      }
    }
    if (found < 0) return false;
    result.distance = best;
    result.x = ox + dx * best;
    result.y = oy + dy * best;
    result.z = oz + dz * best;
    result.nx = normals[found * 3] ?? 0;
    result.ny = normals[found * 3 + 1] ?? 0;
    result.nz = normals[found * 3 + 2] ?? 0;
    result.owner = owner[found] ?? 0;
    result.slot = slot[found] ?? 0;
    // The test's point is a + b (b - a) + c (c - a); a BackSide test swapped its corners a and c, so the weight of
    // stored corner 0, 1 and 2 follows that swap.
    const rest = 1 - bestB - bestC;
    const w0 = swapped ? bestC : rest;
    const w2 = swapped ? rest : bestC;
    result.u =
      (uvs[found * 6] ?? 0) * w0 +
      (uvs[found * 6 + 2] ?? 0) * bestB +
      (uvs[found * 6 + 4] ?? 0) * w2;
    result.v =
      (uvs[found * 6 + 1] ?? 0) * w0 +
      (uvs[found * 6 + 3] ?? 0) * bestB +
      (uvs[found * 6 + 5] ?? 0) * w2;
    return true;
  };
  const rays: IFlatRays = {
    doubleSided: false,
    objects,
    result,
    cast,
    raycast({ origin, direction, far }): Intersection | undefined {
      if (!cast(origin.x, origin.y, origin.z, direction.x, direction.y, direction.z, far))
        return undefined;
      hit.distance = result.distance;
      hit.point.set(result.x, result.y, result.z);
      hit.face.normal.set(result.nx, result.ny, result.nz);
      hit.object = objects[result.owner] as Object3D;
      hit.face.materialIndex = result.slot;
      hit.uv.set(result.u, result.v);
      return hit as unknown as Intersection;
    },
  };
  return rays;
}

/** Quickselect: afterwards `order[k]` holds the k-th triangle by centroid along `axis` within [lo, hi]. */
function select(
  order: Uint32Array,
  centroid: Float32Array,
  axis: number,
  lo: number,
  hi: number,
  k: number,
): void {
  const key = (i: number): number => centroid[(order[i] ?? 0) * 3 + axis] ?? 0;
  let [left, right] = [lo, hi];
  while (left < right) {
    const pivot = key((left + right) >> 1);
    let [i, j] = [left, right];
    while (i <= j) {
      while (key(i) < pivot) i += 1;
      while (key(j) > pivot) j -= 1;
      if (i <= j) {
        const swap = order[i] ?? 0;
        order[i] = order[j] ?? 0;
        order[j] = swap;
        i += 1;
        j -= 1;
      }
    }
    if (k <= j) right = j;
    else if (k >= i) left = i;
    else return;
  }
}
