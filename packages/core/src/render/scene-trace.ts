import {
  Box3,
  type BufferAttribute,
  type BufferGeometry,
  DataTexture,
  FloatType,
  FrontSide,
  type InterleavedBufferAttribute,
  type Material,
  Matrix3,
  type Mesh,
  NearestFilter,
  type Object3D,
  RGBAFormat,
  Vector3,
} from "three";

/**
 * The scene's static triangles, packed for a ray to walk on the GPU and, as the same walk, on the CPU.
 *
 * Why this exists beside `GPUSceneBVH`: that class hands three-mesh-bvh's WGSL ray query to the game, and
 * the owned engine refuses that query by name (`three-native/src/addons/mesh-bvh-webgpu.ts`). This pack
 * uses nothing but float textures and the TSL every engine runs, so one traversal serves the browser, the
 * Wasm engine and the desktop player.
 *
 * Layout, RGBA32F, `TRACE_TEXTURE_WIDTH` texels per row, no filtering:
 *   nodes      two texels per node, depth first (the left child is the next node):
 *                (low.xyz, skip)   skip: the node after this subtree, or -1 at the end of the walk
 *                (high.xyz, leaf)  leaf: -1 for an inner node, else `first * 16 + count`
 *   triangles  six texels per triangle, in leaf order:
 *                (a.xyz, material)  (b.xyz, side)  (c.xyz, 0)  then the three vertex normals
 *                side: 0 front faces only, 1 back faces only, 2 both, from the material's `side`
 *   materials  two texels per material, in first-seen order:
 *                (colour.rgb, roughness)  (emissive.rgb x intensity, metalness)
 * Indices ride in the fourth channel as floats, exact below 2^24 (a scene under 2^20 triangles).
 */
export const TRACE_TEXTURE_WIDTH = 2048;
export const NODE_TEXELS = 2;
export const TRIANGLE_TEXELS = 6;
export const MATERIAL_TEXELS = 2;
/** Triangles per leaf, at most; the leaf word keeps the count below 16. */
export const TRACE_LEAF_SIZE = 4;
const MAX_TRIANGLES = (1 << 20) - 1;
const SIDE_FRONT = 0;
const SIDE_BACK = 1;
const SIDE_BOTH = 2;
/** Three's `BackSide`. */
const BACK_SIDE = 1;
const EPSILON = 1e-9;

export interface ITraceSceneOptions {
  /** Which meshes join the pack. Default: every mesh under a visible parent chain. */
  readonly include?: (mesh: Mesh) => boolean;
}

export interface ITraceSceneReport {
  readonly triangles: number;
  readonly nodes: number;
  readonly materials: number;
  /** Meshes left out because their triangles move (instanced, skinned, batched, morphing). */
  readonly skippedMoving: number;
  readonly milliseconds: number;
}

export interface ITraceHit {
  readonly distance: number;
  /** The triangle's index in leaf order. */
  readonly triangle: number;
  /** An index into `ITraceScene.materials`. */
  readonly material: number;
  readonly position: Vector3;
  /** The interpolated vertex normal, flipped to face the ray. */
  readonly normal: Vector3;
  /** False when the ray reached the back of the surface. */
  readonly front: boolean;
}

export interface ITraceScene {
  readonly report: ITraceSceneReport;
  readonly bounds: Box3;
  /** The material of every id, for what the table cannot hold (a map, a node). */
  readonly materials: readonly Material[];
  readonly nodes: DataTexture;
  readonly triangles: DataTexture;
  readonly materialTable: DataTexture;
  readonly nodeData: Float32Array;
  readonly triangleData: Float32Array;
  readonly materialData: Float32Array;
  dispose(): void;
}

interface IFlatTriangles {
  /** Per triangle, three corners of three. */
  readonly corners: Float64Array;
  /** Per triangle, three vertex normals of three. */
  readonly normals: Float32Array;
  readonly materialIds: Uint16Array;
  readonly sides: Uint8Array;
  readonly count: number;
}

function dataTexture(data: Float32Array, texels: number): DataTexture {
  const height = Math.max(1, Math.ceil(texels / TRACE_TEXTURE_WIDTH));
  const padded = new Float32Array(TRACE_TEXTURE_WIDTH * height * 4);
  padded.set(data);
  const result = new DataTexture(padded, TRACE_TEXTURE_WIDTH, height, RGBAFormat, FloatType);
  result.minFilter = NearestFilter;
  result.magFilter = NearestFilter;
  result.generateMipmaps = false;
  result.needsUpdate = true;
  return result;
}

const sideOf = (material: Material): number =>
  material.side === FrontSide ? SIDE_FRONT : material.side === BACK_SIDE ? SIDE_BACK : SIDE_BOTH;

/**
 * A reader of component `c` of vertex `v`. Plain float data reads the attribute's own typed array, once per mesh:
 * on the owned engine a method call per component crosses into the engine, and a scene has millions of them.
 */
function reader(
  attribute: BufferAttribute | InterleavedBufferAttribute,
): (vertex: number, component: number) => number {
  const raw = attribute as unknown as {
    array?: ArrayLike<number>;
    itemSize: number;
    isInterleavedBufferAttribute?: boolean;
    normalized?: boolean;
  };
  const array = raw.array;
  if (raw.isInterleavedBufferAttribute !== true && raw.normalized !== true && array !== undefined) {
    const stride = raw.itemSize;
    return (vertex, component) => array[vertex * stride + component] ?? 0;
  }
  return (vertex, component) =>
    component === 0
      ? attribute.getX(vertex)
      : component === 1
        ? attribute.getY(vertex)
        : attribute.getZ(vertex);
}

/** Every static mesh's triangles in world space, with vertex normals, material id and facing. */
function flatten(
  root: Object3D,
  include: (mesh: Mesh) => boolean,
  materials: Material[],
): { flat: IFlatTriangles; skippedMoving: number } {
  root.updateMatrixWorld(true);
  const meshes: Mesh[] = [];
  let skippedMoving = 0;
  root.traverseVisible((object) => {
    const mesh = object as Mesh & Record<string, unknown>;
    if (mesh.isMesh !== true || mesh.geometry === undefined || !include(mesh)) return;
    const morphs = (mesh.morphTargetInfluences as unknown[] | undefined)?.length ?? 0;
    if (
      mesh.isInstancedMesh === true ||
      mesh.isSkinnedMesh === true ||
      mesh.isBatchedMesh === true ||
      morphs > 0
    ) {
      skippedMoving += 1;
      return;
    }
    meshes.push(mesh);
  });
  let count = 0;
  for (const mesh of meshes) {
    const geometry: BufferGeometry = mesh.geometry;
    const position = geometry.attributes.position;
    if (position !== undefined) count += Math.floor((geometry.index?.count ?? position.count) / 3);
  }
  if (count > MAX_TRIANGLES)
    throw new RangeError(
      `TN_TRACE_SCENE_TOO_LARGE: ${count} triangles; the pack holds at most ${MAX_TRIANGLES}`,
    );
  const corners = new Float64Array(count * 9);
  const normals = new Float32Array(count * 9);
  const materialIds = new Uint16Array(count);
  const sides = new Uint8Array(count);
  const ids = new Map<Material, number>();
  const matrix3 = new Matrix3();
  let filled = 0;
  for (const mesh of meshes) {
    const geometry = mesh.geometry;
    const position = geometry.attributes.position;
    if (position === undefined) continue;
    const vertexNormal = geometry.attributes.normal;
    const index = geometry.index;
    const indexArray = index === null ? undefined : (index.array as ArrayLike<number>);
    const readPosition = reader(position);
    const readNormal = vertexNormal === undefined ? undefined : reader(vertexNormal);
    // Elements of the world matrix and of its normal matrix, read once: 4 x 4 column-major and 3 x 3 column-major.
    const m = [...mesh.matrixWorld.elements];
    const n = [...matrix3.getNormalMatrix(mesh.matrixWorld).elements];
    // A mirroring transform reverses the winding, so the face a ray calls front swaps with it.
    const mirrored = mesh.matrixWorld.determinant() < 0;
    const triangles = Math.floor((index?.count ?? position.count) / 3);
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (let t = 0; t < triangles; t += 1) {
      let slot = 0;
      if (Array.isArray(mesh.material)) {
        const first = t * 3;
        slot =
          geometry.groups.find((g) => first >= g.start && first < g.start + g.count)
            ?.materialIndex ?? 0;
      }
      const material = list[slot] ?? list[0];
      if (material === undefined) continue;
      let id = ids.get(material);
      if (id === undefined) {
        id = materials.length;
        ids.set(material, id);
        materials.push(material);
      }
      for (let k = 0; k < 3; k += 1) {
        const vertex = indexArray === undefined ? t * 3 + k : (indexArray[t * 3 + k] ?? 0);
        const target = filled * 9 + (mirrored && k > 0 ? 3 - k : k) * 3;
        const x = readPosition(vertex, 0);
        const y = readPosition(vertex, 1);
        const z = readPosition(vertex, 2);
        corners[target] = (m[0] ?? 0) * x + (m[4] ?? 0) * y + (m[8] ?? 0) * z + (m[12] ?? 0);
        corners[target + 1] = (m[1] ?? 0) * x + (m[5] ?? 0) * y + (m[9] ?? 0) * z + (m[13] ?? 0);
        corners[target + 2] = (m[2] ?? 0) * x + (m[6] ?? 0) * y + (m[10] ?? 0) * z + (m[14] ?? 0);
        const nx = readNormal === undefined ? 0 : readNormal(vertex, 0);
        const ny = readNormal === undefined ? 1 : readNormal(vertex, 1);
        const nz = readNormal === undefined ? 0 : readNormal(vertex, 2);
        const wx = (n[0] ?? 0) * nx + (n[3] ?? 0) * ny + (n[6] ?? 0) * nz;
        const wy = (n[1] ?? 0) * nx + (n[4] ?? 0) * ny + (n[7] ?? 0) * nz;
        const wz = (n[2] ?? 0) * nx + (n[5] ?? 0) * ny + (n[8] ?? 0) * nz;
        const length = Math.hypot(wx, wy, wz) || 1;
        normals[target] = wx / length;
        normals[target + 1] = wy / length;
        normals[target + 2] = wz / length;
      }
      materialIds[filled] = id;
      sides[filled] = sideOf(material);
      filled += 1;
    }
  }
  return {
    flat: { corners, normals, materialIds, sides, count: filled },
    skippedMoving,
  };
}

interface IBuilt {
  /** Leaf-order triangle ids. */
  readonly order: Uint32Array;
  /** Per node: low (3), skip, high (3), leaf. */
  readonly nodes: Float32Array;
  readonly nodeCount: number;
}

/**
 * Median split on the longest axis of the centroids, `TRACE_LEAF_SIZE` triangles a leaf.
 * ponytail: a sort per node (O(n log^2 n)); a binned SAH when scenes pass a few hundred thousand triangles.
 */
function build(flat: IFlatTriangles): IBuilt {
  const { corners, count } = flat;
  const low = new Float32Array(count * 3);
  const high = new Float32Array(count * 3);
  const centroid = new Float32Array(count * 3);
  for (let t = 0; t < count; t += 1)
    for (let a = 0; a < 3; a += 1) {
      const x = corners[t * 9 + a] ?? 0;
      const y = corners[t * 9 + 3 + a] ?? 0;
      const z = corners[t * 9 + 6 + a] ?? 0;
      low[t * 3 + a] = Math.min(x, y, z);
      high[t * 3 + a] = Math.max(x, y, z);
      centroid[t * 3 + a] = (x + y + z) / 3;
    }
  const order = new Uint32Array(count);
  for (let t = 0; t < count; t += 1) order[t] = t;
  const words: number[] = [];
  const visit = (start: number, end: number): void => {
    const slot = words.length / 8;
    const lo = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
    const hi = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
    const centre = [...lo];
    const centreHigh = [...hi];
    for (let i = start; i < end; i += 1) {
      const t = order[i] ?? 0;
      for (let a = 0; a < 3; a += 1) {
        lo[a] = Math.min(lo[a] ?? 0, low[t * 3 + a] ?? 0);
        hi[a] = Math.max(hi[a] ?? 0, high[t * 3 + a] ?? 0);
        centre[a] = Math.min(centre[a] ?? 0, centroid[t * 3 + a] ?? 0);
        centreHigh[a] = Math.max(centreHigh[a] ?? 0, centroid[t * 3 + a] ?? 0);
      }
    }
    words.push(lo[0] ?? 0, lo[1] ?? 0, lo[2] ?? 0, -1, hi[0] ?? 0, hi[1] ?? 0, hi[2] ?? 0, -1);
    if (end - start <= TRACE_LEAF_SIZE) {
      words[slot * 8 + 7] = start * 16 + (end - start);
    } else {
      const span = centreHigh.map((v, a) => v - (centre[a] ?? 0));
      const axis =
        (span[0] ?? 0) >= (span[1] ?? 0) && (span[0] ?? 0) >= (span[2] ?? 0)
          ? 0
          : (span[1] ?? 0) >= (span[2] ?? 0)
            ? 1
            : 2;
      const sorted = Array.from(order.subarray(start, end)).sort(
        (p, q) => (centroid[p * 3 + axis] ?? 0) - (centroid[q * 3 + axis] ?? 0),
      );
      order.set(sorted, start);
      const middle = (start + end) >> 1;
      visit(start, middle);
      visit(middle, end);
    }
    // Depth first: the next node outside this subtree is the one numbered next.
    words[slot * 8 + 3] = words.length / 8;
  };
  if (count > 0) visit(0, count);
  const nodeCount = words.length / 8;
  for (let n = 0; n < nodeCount; n += 1)
    if ((words[n * 8 + 3] ?? 0) >= nodeCount) words[n * 8 + 3] = -1;
  return { order, nodes: new Float32Array(words), nodeCount };
}

/**
 * Packs the static triangles under `root` (world space, now) into the textures a trace reads.
 * The scene must not move afterwards: build again after a transform or geometry change.
 */
export function packTraceScene(root: Object3D, options: ITraceSceneOptions = {}): ITraceScene {
  const started = globalThis.performance?.now() ?? Date.now();
  const materials: Material[] = [];
  const { flat, skippedMoving } = flatten(root, options.include ?? (() => true), materials);
  const built = build(flat);
  const triangleData = new Float32Array(flat.count * TRIANGLE_TEXELS * 4);
  const bounds = new Box3();
  for (let slot = 0; slot < flat.count; slot += 1) {
    const t = built.order[slot] ?? 0;
    const o = slot * TRIANGLE_TEXELS * 4;
    for (let k = 0; k < 3; k += 1) {
      for (let a = 0; a < 3; a += 1) {
        triangleData[o + k * 4 + a] = flat.corners[t * 9 + k * 3 + a] ?? 0;
        triangleData[o + (3 + k) * 4 + a] = flat.normals[t * 9 + k * 3 + a] ?? 0;
      }
      bounds.expandByPoint(
        new Vector3(
          flat.corners[t * 9 + k * 3] ?? 0,
          flat.corners[t * 9 + k * 3 + 1] ?? 0,
          flat.corners[t * 9 + k * 3 + 2] ?? 0,
        ),
      );
    }
    triangleData[o + 3] = flat.materialIds[t] ?? 0;
    triangleData[o + 7] = flat.sides[t] ?? SIDE_BOTH;
  }
  const materialData = new Float32Array(Math.max(1, materials.length) * MATERIAL_TEXELS * 4);
  materials.forEach((material, id) => {
    const colour = (material as unknown as { color?: { r: number; g: number; b: number } }).color;
    const emissive = (material as unknown as { emissive?: { r: number; g: number; b: number } })
      .emissive;
    const number = (key: string, fallback: number): number => {
      const value = (material as unknown as Record<string, unknown>)[key];
      return typeof value === "number" ? value : fallback;
    };
    const o = id * MATERIAL_TEXELS * 4;
    materialData.set([colour?.r ?? 1, colour?.g ?? 1, colour?.b ?? 1, number("roughness", 1)], o);
    const glow = number("emissiveIntensity", 1);
    materialData.set(
      [
        (emissive?.r ?? 0) * glow,
        (emissive?.g ?? 0) * glow,
        (emissive?.b ?? 0) * glow,
        number("metalness", 0),
      ],
      o + 4,
    );
  });
  const nodeTexture = dataTexture(built.nodes, built.nodeCount * NODE_TEXELS);
  const triangleTexture = dataTexture(triangleData, flat.count * TRIANGLE_TEXELS);
  const materialTexture = dataTexture(materialData, materials.length * MATERIAL_TEXELS);
  return {
    report: {
      triangles: flat.count,
      nodes: built.nodeCount,
      materials: materials.length,
      skippedMoving,
      milliseconds: Math.round((globalThis.performance?.now() ?? Date.now()) - started),
    },
    bounds,
    materials,
    nodes: nodeTexture,
    triangles: triangleTexture,
    materialTable: materialTexture,
    nodeData: built.nodes,
    triangleData,
    materialData,
    dispose(): void {
      nodeTexture.dispose();
      triangleTexture.dispose();
      materialTexture.dispose();
    },
  };
}

/**
 * The walk the GPU kernel makes, in plain TypeScript: the reference the spec holds the pack to, and what a
 * game may call to ask one question of the same data. Nearest hit within `far`, or undefined.
 */
export function traceScene(
  scene: Pick<ITraceScene, "nodeData" | "triangleData" | "report">,
  origin: Vector3,
  direction: Vector3,
  far = Number.POSITIVE_INFINITY,
  anyHit = false,
): ITraceHit | undefined {
  const { nodeData: nodes, triangleData: tri } = scene;
  const dir = [direction.x, direction.y, direction.z].map((v) =>
    Math.abs(v) < EPSILON ? (v < 0 ? -EPSILON : EPSILON) : v,
  ) as [number, number, number];
  const inv = dir.map((v) => 1 / v) as [number, number, number];
  const o = [origin.x, origin.y, origin.z] as const;
  let best = far;
  let bestTriangle = -1;
  let bestU = 0;
  let bestV = 0;
  let bestFront = true;
  let node = scene.report.nodes > 0 ? 0 : -1;
  while (node >= 0) {
    const n = node * 8;
    let tMin = 0;
    let tMax = best;
    for (let a = 0; a < 3; a += 1) {
      const t0 = ((nodes[n + a] ?? 0) - (o[a] ?? 0)) * (inv[a] ?? 0);
      const t1 = ((nodes[n + 4 + a] ?? 0) - (o[a] ?? 0)) * (inv[a] ?? 0);
      tMin = Math.max(tMin, Math.min(t0, t1));
      tMax = Math.min(tMax, Math.max(t0, t1));
    }
    if (tMax < tMin) {
      node = nodes[n + 3] ?? -1;
      continue;
    }
    const leaf = nodes[n + 7] ?? -1;
    if (leaf < 0) {
      node += 1;
      continue;
    }
    const first = Math.floor(leaf / 16);
    const count = leaf - first * 16;
    for (let i = first; i < first + count; i += 1) {
      const b = i * TRIANGLE_TEXELS * 4;
      const ax = tri[b] ?? 0;
      const ay = tri[b + 1] ?? 0;
      const az = tri[b + 2] ?? 0;
      const e1 = [(tri[b + 4] ?? 0) - ax, (tri[b + 5] ?? 0) - ay, (tri[b + 6] ?? 0) - az];
      const e2 = [(tri[b + 8] ?? 0) - ax, (tri[b + 9] ?? 0) - ay, (tri[b + 10] ?? 0) - az];
      // Moller-Trumbore. det > 0 is a hit on the front face (the ray opposes e1 x e2).
      const p = [
        dir[1] * (e2[2] ?? 0) - dir[2] * (e2[1] ?? 0),
        dir[2] * (e2[0] ?? 0) - dir[0] * (e2[2] ?? 0),
        dir[0] * (e2[1] ?? 0) - dir[1] * (e2[0] ?? 0),
      ];
      const det =
        (e1[0] ?? 0) * (p[0] ?? 0) + (e1[1] ?? 0) * (p[1] ?? 0) + (e1[2] ?? 0) * (p[2] ?? 0);
      const side = tri[b + 7] ?? SIDE_BOTH;
      const facing =
        side === SIDE_BOTH
          ? Math.abs(det) > EPSILON
          : side === SIDE_FRONT
            ? det > EPSILON
            : det < -EPSILON;
      if (!facing) continue;
      const s = [o[0] - ax, o[1] - ay, o[2] - az];
      const u =
        ((s[0] ?? 0) * (p[0] ?? 0) + (s[1] ?? 0) * (p[1] ?? 0) + (s[2] ?? 0) * (p[2] ?? 0)) / det;
      if (u < 0 || u > 1) continue;
      const q = [
        (s[1] ?? 0) * (e1[2] ?? 0) - (s[2] ?? 0) * (e1[1] ?? 0),
        (s[2] ?? 0) * (e1[0] ?? 0) - (s[0] ?? 0) * (e1[2] ?? 0),
        (s[0] ?? 0) * (e1[1] ?? 0) - (s[1] ?? 0) * (e1[0] ?? 0),
      ];
      const v = (dir[0] * (q[0] ?? 0) + dir[1] * (q[1] ?? 0) + dir[2] * (q[2] ?? 0)) / det;
      if (v < 0 || u + v > 1) continue;
      const t =
        ((e2[0] ?? 0) * (q[0] ?? 0) + (e2[1] ?? 0) * (q[1] ?? 0) + (e2[2] ?? 0) * (q[2] ?? 0)) /
        det;
      if (t > EPSILON && t < best) {
        best = t;
        bestTriangle = i;
        bestU = u;
        bestV = v;
        bestFront = det > 0;
        if (anyHit) node = -2;
      }
    }
    node = node === -2 ? -1 : (nodes[n + 3] ?? -1);
  }
  if (bestTriangle < 0) return undefined;
  const b = bestTriangle * TRIANGLE_TEXELS * 4;
  const w = 1 - bestU - bestV;
  const normal = new Vector3();
  for (let a = 0; a < 3; a += 1)
    normal.setComponent(
      a,
      w * (tri[b + 12 + a] ?? 0) + bestU * (tri[b + 16 + a] ?? 0) + bestV * (tri[b + 20 + a] ?? 0),
    );
  normal.normalize();
  if (normal.x * direction.x + normal.y * direction.y + normal.z * direction.z > 0) normal.negate();
  return {
    distance: best,
    triangle: bestTriangle,
    material: tri[b + 3] ?? 0,
    position: new Vector3(
      origin.x + dir[0] * best,
      origin.y + dir[1] * best,
      origin.z + dir[2] * best,
    ),
    normal,
    front: bestFront,
  };
}
