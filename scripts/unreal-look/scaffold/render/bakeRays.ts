import type { Intersection, Material, Mesh, Object3D } from "three";
import { Vector2, Vector3 } from "three";
import type { IRayContext } from "./giCache.js";

/**
 * The bake's ray query: one bounding volume hierarchy over every triangle under `root`, in world space.
 *
 * `ctx.raycast` walks the scene graph and calls into the engine for every object on every ray; the GI bake
 * casts millions of rays, so that walk is most of its time on the Wasm engine. The geometry does not move during
 * a bake, so it is read once here and each ray runs on plain typed arrays. The answers match `ctx.raycast`:
 * the nearest triangle, culled by the material's `side` (read per ray, because `linkMasks` switches it), the
 * object, the face normal in the object's local space, the material slot and the UV (PRD-639: a texture is read where
 * the ray lands). The hit object is reused between rays.
 */
const LEAF = 4;
const PAD = 1e-4;

interface IBuilt {
  readonly rays: IRayContext;
  readonly triangles: number;
}

export function bakeRays(root: Object3D, fallback: IRayContext): IRayContext {
  return build(root)?.rays ?? fallback;
}

function build(root: Object3D): IBuilt | undefined {
  root.updateMatrixWorld(true);
  const meshes: Mesh[] = [];
  let unsupported = false;
  root.traverse((object) => {
    const mesh = object as Mesh & {
      isInstancedMesh?: boolean;
      isSkinnedMesh?: boolean;
      isBatchedMesh?: boolean;
    };
    if (!mesh.isMesh) return;
    // Deformed meshes keep the stock path: their rest positions are not where the ray should hit.
    if (
      mesh.isInstancedMesh === true ||
      mesh.isSkinnedMesh === true ||
      mesh.isBatchedMesh === true ||
      (mesh.morphTargetInfluences?.length ?? 0) > 0
    )
      unsupported = true;
    if (mesh.layers.isEnabled(0)) meshes.push(mesh);
  });
  if (unsupported) return undefined;

  let count = 0;
  for (const mesh of meshes) {
    const index = mesh.geometry.index;
    const position = mesh.geometry.attributes.position;
    if (position === undefined) continue;
    count += Math.floor((index?.count ?? position.count) / 3);
  }
  // Per triangle: three world-space corners, their UVs, the local face normal, the owner mesh and its material slot.
  const corners = new Float64Array(count * 9);
  const uvs = new Float32Array(count * 6);
  const normals = new Float32Array(count * 3);
  const owner = new Uint32Array(count);
  const slot = new Uint16Array(count);
  let filled = 0;
  meshes.forEach((mesh, meshIndex) => {
    const geometry = mesh.geometry;
    const position = geometry.attributes.position;
    if (position === undefined) return;
    const index = geometry.index;
    const m = mesh.matrixWorld.elements;
    // A mirroring matrix reverses the winding the ray test culls by: restore it.
    const mirrored =
      (m[0] ?? 0) * ((m[5] ?? 0) * (m[10] ?? 0) - (m[6] ?? 0) * (m[9] ?? 0)) -
        (m[4] ?? 0) * ((m[1] ?? 0) * (m[10] ?? 0) - (m[2] ?? 0) * (m[9] ?? 0)) +
        (m[8] ?? 0) * ((m[1] ?? 0) * (m[6] ?? 0) - (m[2] ?? 0) * (m[5] ?? 0)) <
      0;
    const groups = geometry.groups;
    const uv = geometry.attributes.uv;
    const local = [0, 0, 0, 0, 0, 0, 0, 0, 0];
    const triangles = Math.floor((index?.count ?? position.count) / 3);
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
  });

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
  const hit = {
    distance: 0,
    point: new Vector3(),
    face: { a: 0, b: 0, c: 0, normal: new Vector3(), materialIndex: 0 },
    uv: new Vector2(),
    object: undefined as unknown as Object3D,
  };
  const stack = new Int32Array(64);
  const rays: IRayContext = {
    raycast({ origin, direction, far }): Intersection | undefined {
      const [ox, oy, oz] = [origin.x, origin.y, origin.z];
      const [dx, dy, dz] = [direction.x, direction.y, direction.z];
      const [ix, iy, iz] = [1 / dx, 1 / dy, 1 / dz];
      let best = far;
      let found = -1;
      // The best hit's barycentric weights of its second and third corner, and whether a back-sided test swapped them.
      let [bestB, bestC, swapped] = [0, 0, false];
      stack[0] = 0;
      let top = 1;
      while (top > 0) {
        top -= 1;
        const node = stack[top] ?? 0;
        const b = node * 6;
        // Slab test against the node's box, limited to the best hit so far. A ray parallel to an axis only
        // has to start between that axis' planes (0 x infinity is NaN, so the division is skipped).
        let tmin = 0;
        let tmax = best;
        if (dx === 0) {
          if (ox < (bounds[b] ?? 0) || ox > (bounds[b + 3] ?? 0)) continue;
        } else {
          const t1 = ((bounds[b] ?? 0) - ox) * ix;
          const t2 = ((bounds[b + 3] ?? 0) - ox) * ix;
          tmin = Math.max(tmin, Math.min(t1, t2));
          tmax = Math.min(tmax, Math.max(t1, t2));
        }
        if (dy === 0) {
          if (oy < (bounds[b + 1] ?? 0) || oy > (bounds[b + 4] ?? 0)) continue;
        } else {
          const t1 = ((bounds[b + 1] ?? 0) - oy) * iy;
          const t2 = ((bounds[b + 4] ?? 0) - oy) * iy;
          tmin = Math.max(tmin, Math.min(t1, t2));
          tmax = Math.min(tmax, Math.max(t1, t2));
        }
        if (dz === 0) {
          if (oz < (bounds[b + 2] ?? 0) || oz > (bounds[b + 5] ?? 0)) continue;
        } else {
          const t1 = ((bounds[b + 2] ?? 0) - oz) * iz;
          const t2 = ((bounds[b + 5] ?? 0) - oz) * iz;
          tmin = Math.max(tmin, Math.min(t1, t2));
          tmax = Math.min(tmax, Math.max(t1, t2));
        }
        if (tmin > tmax) continue;
        const count = size[node] ?? 0;
        if (count === 0) {
          // Visit the near child first.
          const negative = ([dx, dy, dz][axisOf[node] ?? 0] ?? 0) < 0;
          const right = start[node] ?? 0;
          stack[top] = negative ? node + 1 : right;
          stack[top + 1] = negative ? right : node + 1;
          top += 2;
          continue;
        }
        for (let i = start[node] ?? 0; i < (start[node] ?? 0) + count; i += 1) {
          const t = order[i] ?? 0;
          const material = objects[owner[t] ?? 0]?.material as Material | Material[];
          const side = (Array.isArray(material) ? material[slot[t] ?? 0] : material)?.side ?? 0;
          const c = t * 9;
          // Three's Ray.intersectTriangle, culled by FrontSide (0), reversed for BackSide (1).
          let [ax, ay, az] = [corners[c] ?? 0, corners[c + 1] ?? 0, corners[c + 2] ?? 0];
          const [bx, by, bz] = [corners[c + 3] ?? 0, corners[c + 4] ?? 0, corners[c + 5] ?? 0];
          let [cx, cy, cz] = [corners[c + 6] ?? 0, corners[c + 7] ?? 0, corners[c + 8] ?? 0];
          if (side === 1) [ax, ay, az, cx, cy, cz] = [cx, cy, cz, ax, ay, az];
          const cull = side !== 2;
          const [e1x, e1y, e1z] = [bx - ax, by - ay, bz - az];
          const [e2x, e2y, e2z] = [cx - ax, cy - ay, cz - az];
          const [nx, ny, nz] = [
            e1y * e2z - e1z * e2y,
            e1z * e2x - e1x * e2z,
            e1x * e2y - e1y * e2x,
          ];
          let ddn = dx * nx + dy * ny + dz * nz;
          let sign: number;
          if (ddn > 0) {
            if (cull) continue;
            sign = 1;
          } else if (ddn < 0) {
            sign = -1;
            ddn = -ddn;
          } else continue;
          const [qx, qy, qz] = [ox - ax, oy - ay, oz - az];
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
      if (found < 0) return undefined;
      hit.distance = best;
      hit.point.set(ox + dx * best, oy + dy * best, oz + dz * best);
      hit.face.normal.set(
        normals[found * 3] ?? 0,
        normals[found * 3 + 1] ?? 0,
        normals[found * 3 + 2] ?? 0,
      );
      hit.object = objects[owner[found] ?? 0] as Object3D;
      hit.face.materialIndex = slot[found] ?? 0;
      // The test's point is a + b (b - a) + c (c - a); a BackSide test swapped its corners a and c, so the weight of
      // stored corner 0, 1 and 2 follows that swap.
      const rest = 1 - bestB - bestC;
      const [w0, w1, w2] = swapped ? [bestC, bestB, rest] : [rest, bestB, bestC];
      hit.uv.set(
        (uvs[found * 6] ?? 0) * w0 +
          (uvs[found * 6 + 2] ?? 0) * w1 +
          (uvs[found * 6 + 4] ?? 0) * w2,
        (uvs[found * 6 + 1] ?? 0) * w0 +
          (uvs[found * 6 + 3] ?? 0) * w1 +
          (uvs[found * 6 + 5] ?? 0) * w2,
      );
      return hit as unknown as Intersection;
    },
  };
  return { rays, triangles: count };
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
