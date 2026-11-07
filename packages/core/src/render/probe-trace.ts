// PRD-603: a probe refresh that traces the packed scene instead of drawing it six times.
//
// Unreal's radiance cache traces each probe against a scene proxy and reads the lit surface at the hit;
// it never draws the scene again for a probe (UE 5.8.3: Engine/Shaders/Private/Lumen/LumenSoftwareRayTracing.ush:670-700).
// Here the proxy is the GPUSceneBVH snapshot and the lit surface is a flat material table: albedo times the
// sun through one shadow ray, plus emission, plus the previous generation of the field at the hit (the bounce).
// A miss returns the game's sky radiance. One kernel traces every ray of the selected probes, a second projects
// each probe's rays onto the L2 basis the atlas already stores, so sampling does not change.
//
// The traversal is stackless (a threaded BVH: each node carries the node to visit after it), because the owned
// engine's TSL has loops and storage buffers but no local arrays, and refuses the upstream WGSL ray query.
import { Color, type Material, type Texture, Vector3 } from "three";
import {
  Break,
  Fn,
  If,
  Loop,
  Return,
  abs,
  clamp,
  cross,
  dot,
  float,
  floor,
  instanceIndex,
  int,
  max,
  min,
  normalize,
  pow,
  select,
  sqrt,
  storage,
  uniform,
  vec3,
  vec4,
} from "three/tsl";
import { StorageBufferAttribute } from "three/webgpu";
import type { Node } from "three/webgpu";

/** The CPU snapshot a GPUSceneBVH packs, in BVH leaf order, that the probe trace reads. */
export interface IProbeTraceScene {
  /** three-mesh-bvh serialized root: 8 words per node. */
  readonly nodes: Uint32Array;
  /** World positions, 4 floats per vertex. */
  readonly positions: Float32Array;
  /** Leaf-ordered triangle corners, 3 per triangle. */
  readonly indices: Uint32Array;
  /** Leaf-ordered material slot per triangle, an index into `materials`. */
  readonly triangleMaterials: Uint32Array;
  readonly materials: readonly Material[];
}

/** The sun and sky the game already holds for its daylight; the volume owns no light. */
export interface IProbeTraceLighting {
  /** World direction toward the sun (the light's position minus its target). */
  readonly direction: Vector3;
  readonly color: Color;
  readonly intensity: number;
  /** Radiance of a ray that leaves the scene. Black for an interior with no sky. */
  readonly sky: Color;
  /**
   * Point lights, at most the count the kernels were built for. Intensity is the irradiance on a surface 1 m
   * from the light that faces it, in the same units as the sun; `distance` closes the attenuation window
   * (three's `getDistanceAttenuation`), 0 for none. A change to a point light needs `requestBake`.
   */
  readonly points?: readonly IProbeTracePoint[];
}

export interface IProbeTracePoint {
  readonly position: Vector3;
  readonly color: Color;
  readonly intensity: number;
  readonly distance?: number;
}

/** What a scene BVH snapshot becomes on the GPU: a threaded node table, triangles and the material table. */
export interface IThreadedScene {
  /** Two vec4 per node: bounds min, bounds max. */
  readonly bounds: Float32Array;
  /** One ivec4 per node: next node after this one, leaf triangle offset, leaf triangle count, 1 for a leaf. */
  readonly links: Int32Array;
  /** Three vec4 per triangle: the corners, and the first corner's w holds the material slot. */
  readonly triangles: Float32Array;
  /** Two vec4 per material: albedo, emitted radiance. */
  readonly materials: Float32Array;
  readonly nodeCount: number;
  /** Materials whose texture or node graph the flat table cannot read. */
  readonly ignoredTextureMaterials: number;
}

const NODE_WORDS = 8;
const LEAF_FLAG = 0xffff0000;
const COUNT_MASK = 0xffff;

/**
 * Thread a three-mesh-bvh node buffer: every node gets the node a depth-first walk visits next when it
 * skips this node's subtree (its "miss" link). A walk that follows the left child on a box hit and the miss
 * link otherwise visits every node it must with no stack. `nodeCount` ends the walk.
 */
export function threadBvh(nodes: Uint32Array): {
  bounds: Float32Array;
  links: Int32Array;
  nodeCount: number;
} {
  const nodeCount = nodes.length / NODE_WORDS;
  if (!Number.isInteger(nodeCount) || nodeCount < 1)
    throw new Error("threadBvh needs whole 8-word nodes.");
  const floats = new Float32Array(nodes.buffer, nodes.byteOffset, nodes.length);
  const bounds = new Float32Array(nodeCount * 8);
  const links = new Int32Array(nodeCount * 4);
  const stack: number[] = [0, nodeCount];
  while (stack.length > 0) {
    const miss = stack.pop() as number;
    const node = stack.pop() as number;
    const word = node * NODE_WORDS;
    bounds.set(floats.subarray(word, word + 3), node * 8);
    bounds.set(floats.subarray(word + 3, word + 6), node * 8 + 4);
    const info = nodes[word + 7] ?? 0;
    links[node * 4] = miss;
    if ((info & LEAF_FLAG) !== 0) {
      links[node * 4 + 1] = nodes[word + 6] ?? 0;
      links[node * 4 + 2] = info & COUNT_MASK;
      links[node * 4 + 3] = 1;
      continue;
    }
    const right = node + (nodes[word + 6] ?? 0);
    if (right <= node || right >= nodeCount)
      throw new Error(`threadBvh: node ${node} has no valid right child.`);
    stack.push(right, miss, node + 1, right);
  }
  return { bounds, links, nodeCount };
}

/** The radiance a flat material returns: albedo for the lit model, emission, and whether a texture was dropped. */
export function flatMaterial(material: Material): {
  albedo: Color;
  emission: Color;
  ignored: boolean;
} {
  const fields = material as Material & {
    color?: Color;
    emissive?: Color;
    emissiveIntensity?: number;
    map?: Texture | null;
    emissiveMap?: Texture | null;
    colorNode?: unknown;
    emissiveNode?: unknown;
  };
  const color = fields.color?.clone() ?? new Color(0.5, 0.5, 0.5);
  const ignored =
    (fields.map ?? null) !== null ||
    (fields.emissiveMap ?? null) !== null ||
    (fields.colorNode ?? null) !== null ||
    (fields.emissiveNode ?? null) !== null;
  // An unlit material shows its colour whatever lights the scene, exactly as a cube capture records it.
  // A node-coloured unlit surface shows computed light (often this very field), not light of its own.
  const unlit = fields as { isMeshBasicMaterial?: boolean; isMeshBasicNodeMaterial?: boolean };
  if (unlit.isMeshBasicMaterial === true || unlit.isMeshBasicNodeMaterial === true) {
    const emission = (fields.colorNode ?? null) === null ? color : new Color(0, 0, 0);
    return { albedo: new Color(0, 0, 0), emission, ignored };
  }
  const emission = (fields.emissive?.clone() ?? new Color(0, 0, 0)).multiplyScalar(
    fields.emissiveIntensity ?? 1,
  );
  return { albedo: color, emission, ignored };
}

/**
 * Write the flat material table into `target` (2 vec4 a material) and count the materials it could not read.
 * Returns whether any value changed, so a lamp switched on in game code restarts the refresh by itself.
 */
export function writeMaterialTable(
  materials: readonly Material[],
  target: Float32Array,
): { changed: boolean; ignored: number } {
  let changed = false;
  let ignored = 0;
  materials.forEach((material, slot) => {
    const flat = flatMaterial(material);
    if (flat.ignored) ignored += 1;
    const values = [
      flat.albedo.r,
      flat.albedo.g,
      flat.albedo.b,
      // The side a ray can hit, three's own numbers: 0 front, 1 back, 2 double. The capture never draws the other side.
      material.side,
      flat.emission.r,
      flat.emission.g,
      flat.emission.b,
      0,
    ];
    values.forEach((value, offset) => {
      // The table is Float32: compare the value as stored, or a colour float32 cannot hold reads changed forever.
      if (target[slot * 8 + offset] === Math.fround(value)) return;
      target[slot * 8 + offset] = value;
      changed = true;
    });
  });
  return { changed, ignored };
}

/** Lay a BVH snapshot out for the trace kernel. */
export function threadScene(scene: IProbeTraceScene): IThreadedScene {
  const { bounds, links, nodeCount } = threadBvh(scene.nodes);
  const triangleCount = scene.indices.length / 3;
  const triangles = new Float32Array(Math.max(1, triangleCount) * 12);
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = scene.indices[triangle * 3 + corner] ?? 0;
      triangles.set(
        scene.positions.subarray(vertex * 4, vertex * 4 + 3),
        triangle * 12 + corner * 4,
      );
    }
    triangles[triangle * 12 + 3] = scene.triangleMaterials[triangle] ?? 0;
  }
  const materials = new Float32Array(Math.max(1, scene.materials.length) * 8);
  const ignoredTextureMaterials = writeMaterialTable(scene.materials, materials).ignored;
  return { bounds, links, materials, nodeCount, triangles, ignoredTextureMaterials };
}

/** Rays per probe on a spherical Fibonacci set: even coverage, fixed order, so a refresh is deterministic. */
export function probeRayDirections(count: number): Float32Array {
  const directions = new Float32Array(count * 4);
  for (let ray = 0; ray < count; ray += 1) {
    const y = 1 - (2 * (ray + 0.5)) / count;
    const radius = Math.sqrt(Math.max(0, 1 - y * y));
    const phi = ray * 2.399963229728653;
    directions.set([radius * Math.cos(phi), y, radius * Math.sin(phi), 0], ray * 4);
  }
  return directions;
}

type V3 = Node<"vec3">;
// quality-allow: the kernel is arithmetic over TSL nodes, which three types per swizzle and refuses on storage elements.
// biome-ignore lint/suspicious/noExplicitAny: three's TSL types refuse the swizzles the trace kernel reads.
type AnyNode = any;

interface IStorageSet {
  readonly bounds: AnyNode;
  readonly links: AnyNode;
  readonly triangles: AnyNode;
  readonly materials: AnyNode;
}

const RAY_EPSILON = 1e-4;
/**
 * A probe is rejected when more than this share of its rays first meet a surface from behind: it sits inside a solid,
 * or outside the walls looking at their backs. Unreal's GPU Lightmass rejects an irradiance cache record at the same
 * share (UE 5.8.3: Engine/Plugins/Experimental/GPULightmass/Shaders/Private/IrradianceCachingCommon.ush:8,
 * LightmapPathTracing.usf:449-455). The share rides in the `w` of a probe's first coefficient.
 */
export const BACKFACE_REJECTION_SHARE = 1 / 64;
const SURFACE_OFFSET = 1e-3;
const INV_PI = 1 / Math.PI;

/**
 * Closest (or, with `anyHit`, first) hit along a ray through the threaded BVH. Builds graph nodes inline. With `back`
 * (a float variable), it also keeps the nearest surface the ray skipped because it arrived on the side that is not drawn.
 */
function traceRay(
  buffers: IStorageSet,
  nodeCount: AnyNode,
  origin: AnyNode,
  direction: AnyNode,
  far: number | AnyNode,
  anyHit: boolean,
  back?: AnyNode,
): { t: AnyNode; triangle: AnyNode } {
  const best = float(far).toVar();
  const hitTriangle = int(-1).toVar();
  const safe = (component: AnyNode) =>
    select(abs(component).lessThan(1e-8), float(1e8), float(1).div(component));
  const inverse = vec3(safe(direction.x), safe(direction.y), safe(direction.z)).toVar();
  const node = int(0).toVar();
  Loop(
    { start: int(0), end: nodeCount.mul(int(2)).add(int(1)), type: "int", condition: "<" },
    () => {
      If(node.greaterThanEqual(nodeCount), () => Break());
      const low = buffers.bounds.element(node.mul(int(2))).xyz;
      const high = buffers.bounds.element(node.mul(int(2)).add(int(1))).xyz;
      const t0 = low.sub(origin).mul(inverse);
      const t1 = high.sub(origin).mul(inverse);
      const near = max(max(min(t0.x, t1.x), min(t0.y, t1.y)), min(t0.z, t1.z));
      const exit = min(min(max(t0.x, t1.x), max(t0.y, t1.y)), max(t0.z, t1.z));
      const boxHit = exit.greaterThanEqual(max(near, 0)).and(near.lessThan(best));
      // The links are float storage read as ints: the owned engine's `ivec4` storage reads back wrong (a node never reads as a leaf).
      const rawLink = buffers.links.element(node);
      const link = { w: int(rawLink.w), x: int(rawLink.x), y: int(rawLink.y), z: int(rawLink.z) };
      If(boxHit.and(link.w.equal(1)), () => {
        Loop(
          { start: int(0), end: link.z, type: "int", condition: "<" },
          ({ i }: { i: AnyNode }) => {
            const triangle = link.y.add(i);
            const a = buffers.triangles.element(triangle.mul(int(3))).xyz;
            const edge1 = buffers.triangles.element(triangle.mul(int(3)).add(int(1))).xyz.sub(a);
            const edge2 = buffers.triangles.element(triangle.mul(int(3)).add(int(2))).xyz.sub(a);
            const p = cross(direction, edge2);
            const det = dot(edge1, p);
            const inverseDet = select(abs(det).greaterThan(1e-12), float(1).div(det), float(0));
            const s = origin.sub(a);
            const u = dot(s, p).mul(inverseDet);
            const q = cross(s, edge1);
            const v = dot(direction, q).mul(inverseDet);
            const t = dot(edge2, q).mul(inverseDet);
            // A one-sided surface is not there for a ray that arrives behind it, as a cube capture would not draw it.
            const side = buffers.materials.element(
              int(buffers.triangles.element(triangle.mul(int(3))).w).mul(int(2)),
            ).w;
            const behind = dot(cross(edge1, edge2), direction).greaterThan(0);
            const culled = side
              .lessThan(0.5)
              .and(behind)
              .or(side.greaterThan(0.5).and(side.lessThan(1.5)).and(behind.not()));
            const crossed = abs(det)
              .greaterThan(1e-12)
              .and(u.greaterThanEqual(0))
              .and(v.greaterThanEqual(0))
              .and(u.add(v).lessThanEqual(1))
              .and(t.greaterThan(RAY_EPSILON))
              .and(t.lessThan(best))
              .toVar();
            If(culled.not().and(crossed), () => {
              best.assign(t);
              hitTriangle.assign(triangle);
            });
            if (back !== undefined)
              If(culled.and(crossed).and(t.lessThan(back)), () => back.assign(t));
          },
        );
        node.assign(link.x);
        if (anyHit) If(hitTriangle.greaterThanEqual(0), () => Break());
      })
        .ElseIf(boxHit, () => {
          node.assign(node.add(int(1)));
        })
        .Else(() => {
          node.assign(link.x);
        });
    },
  );
  return { t: best, triangle: hitTriangle };
}

/** L2 irradiance for a normal from nine RGB coefficients: the same constants `ProbeVolume.sampleNode` uses. */
function shIrradiance(coefficient: (index: number) => V3, n: V3): V3 {
  return coefficient(0)
    .mul(0.886227)
    .add(coefficient(1).mul(n.y).mul(1.023328))
    .add(coefficient(2).mul(n.z).mul(1.023328))
    .add(coefficient(3).mul(n.x).mul(1.023328))
    .add(coefficient(4).mul(n.x.mul(n.y)).mul(0.858086))
    .add(coefficient(5).mul(n.y.mul(n.z)).mul(0.858086))
    .add(coefficient(6).mul(n.z.mul(n.z).mul(0.743125).sub(0.247708)))
    .add(coefficient(7).mul(n.x.mul(n.z)).mul(0.858086))
    .add(
      coefficient(8)
        .mul(n.x.mul(n.x).sub(n.y.mul(n.y)))
        .mul(0.429043),
    )
    .max(0) as V3;
}

/**
 * The octahedral cell of a unit direction in an R x R map: the sphere folded onto a square through the z axis, the layout
 * Unreal's radiance cache stores per probe (UE 5.8.3: Engine/Shaders/Private/Lumen/LumenRadianceCacheCommon.ush,
 * GetProbeTexelCoordFromDirection, and UnitVectorToOctahedron in Engine/Shaders/Private/OctahedralCommon.ush).
 * Returns `row * R + column`.
 */
export function octahedralCell(x: number, y: number, z: number, resolution: number): number {
  const l1 = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
  let u = x / l1;
  let v = y / l1;
  if (z < 0) {
    const fu = (1 - Math.abs(v)) * (u >= 0 ? 1 : -1);
    v = (1 - Math.abs(u)) * (v >= 0 ? 1 : -1);
    u = fu;
  }
  const column = Math.min(resolution - 1, Math.floor((u * 0.5 + 0.5) * resolution));
  const row = Math.min(resolution - 1, Math.floor((v * 0.5 + 0.5) * resolution));
  return row * resolution + column;
}

/** The unit direction at the centre of an octahedral cell (the inverse fold of `octahedralCell`). */
function octahedralCellCentre(cell: number, resolution: number): [number, number, number] {
  let u = (((cell % resolution) + 0.5) / resolution) * 2 - 1;
  let v = ((Math.floor(cell / resolution) + 0.5) / resolution) * 2 - 1;
  const z = 1 - Math.abs(u) - Math.abs(v);
  if (z < 0) {
    const fu = (1 - Math.abs(v)) * (u >= 0 ? 1 : -1);
    v = (1 - Math.abs(u)) * (v >= 0 ? 1 : -1);
    u = fu;
  }
  const length = Math.hypot(u, v, z) || 1;
  return [u / length, v / length, z / length];
}

/**
 * Which rays fill each octahedral cell: `rays` lists ray indices cell by cell (one per vec4, in x) and `ranges` holds each
 * cell's first entry and count (x, y). A cell no ray lands in takes the ray nearest its centre, so a map from few rays
 * has no hole.
 */
export function octahedralRayTable(
  directions: Float32Array,
  count: number,
  resolution: number,
): { readonly rays: Float32Array; readonly ranges: Float32Array } {
  const cells = resolution * resolution;
  const members: number[][] = Array.from({ length: cells }, () => []);
  for (let ray = 0; ray < count; ray += 1) {
    const cell = octahedralCell(
      directions[ray * 4] ?? 0,
      directions[ray * 4 + 1] ?? 0,
      directions[ray * 4 + 2] ?? 0,
      resolution,
    );
    members[cell]?.push(ray);
  }
  members.forEach((list, cell) => {
    if (list.length > 0) return;
    const [cx, cy, cz] = octahedralCellCentre(cell, resolution);
    let best = 0;
    let bestDot = Number.NEGATIVE_INFINITY;
    for (let ray = 0; ray < count; ray += 1) {
      const d =
        cx * (directions[ray * 4] ?? 0) +
        cy * (directions[ray * 4 + 1] ?? 0) +
        cz * (directions[ray * 4 + 2] ?? 0);
      if (d > bestDot) [best, bestDot] = [ray, d];
    }
    list.push(best);
  });
  const total = members.reduce((sum, list) => sum + list.length, 0);
  const rays = new Float32Array(total * 4);
  const ranges = new Float32Array(cells * 4);
  let next = 0;
  members.forEach((list, cell) => {
    ranges[cell * 4] = next;
    ranges[cell * 4 + 1] = list.length;
    for (const ray of list) {
      rays[next * 4] = ray;
      next += 1;
    }
  });
  return { rays, ranges };
}

/** The per-volume inputs of the kernels. */
export interface IProbeTraceGrid {
  readonly min: Vector3;
  readonly size: Vector3;
  readonly resolution: Vector3;
  readonly probeCount: number;
}

/** Everything one volume dispatches: two kernels, their buffers and the uniforms the CPU updates per frame. */
export interface IProbeTraceKernels {
  readonly trace: AnyNode;
  readonly project: AnyNode;
  /** probeCount * 9 vec4: the field the volume reads back into its atlas. */
  readonly coefficients: StorageBufferAttribute;
  /** The flat material table, rewritten when a material changes. */
  readonly materials: StorageBufferAttribute;
  /** The probe indices one dispatch refreshes. */
  readonly probeList: StorageBufferAttribute;
  readonly batchSize: { value: number };
  readonly sunDirection: { value: Vector3 };
  readonly sunRadiance: { value: Vector3 };
  readonly sky: { value: Vector3 };
  /** One uniform set per point light the kernels were built for. */
  readonly points: readonly {
    position: { value: Vector3 };
    radiance: { value: Vector3 };
    distance: { value: number };
  }[];
  /** 1 once a previous generation exists to bounce from. */
  readonly bounce: { value: number };
  readonly raysPerProbe: number;
  readonly maxBatch: number;
  /**
   * Cells per side of each probe's octahedral radiance map, 0 for none. The map holds the mean radiance of the rays in
   * each cell (`probeCount * R * R` vec4, probe-major), written by `octahedral` after `project`.
   */
  readonly octahedralResolution: number;
  readonly octahedral?: AnyNode;
  readonly radianceMap?: StorageBufferAttribute;
  dispose(): void;
}

/** Build the trace and projection kernels for one volume over one threaded scene. */
export function createProbeTraceKernels(
  scene: IThreadedScene,
  grid: IProbeTraceGrid,
  raysPerProbe: number,
  maxBatch: number,
  pointCount = 0,
  octahedralResolution = 0,
): IProbeTraceKernels {
  const attributes: StorageBufferAttribute[] = [];
  const buffer = (array: Float32Array | Int32Array, itemSize: number) => {
    const attribute = new StorageBufferAttribute(array as never, itemSize);
    attributes.push(attribute);
    return attribute;
  };
  const read = (array: Float32Array | Int32Array, type: "vec4" | "ivec4" | "int"): AnyNode => {
    const itemSize = type === "int" ? 1 : 4;
    return storage(buffer(array, itemSize), type, array.length / itemSize).toReadOnly();
  };
  const materialNode = read(scene.materials, "vec4");
  const buffers: IStorageSet = {
    bounds: read(scene.bounds, "vec4"),
    // Node and triangle indices below 2^24 are exact in a float.
    links: read(Float32Array.from(scene.links), "vec4"),
    materials: materialNode,
    triangles: read(scene.triangles, "vec4"),
  };
  const directions = read(probeRayDirections(raysPerProbe), "vec4");
  // Float storage read as ints: the owned engine's integer storage reads back zero, which sends every ray to probe 0.
  // One probe index per vec4 (x), like every other table here.
  const probeList = buffer(new Float32Array(maxBatch * 4), 4);
  const floatProbes = storage(probeList, "vec4", maxBatch).toReadOnly() as AnyNode;
  const probes = { element: (slot: AnyNode) => int(floatProbes.element(slot).x) };
  const radiance = buffer(new Float32Array(maxBatch * raysPerProbe * 4), 4);
  const radianceNode = storage(radiance, "vec4", maxBatch * raysPerProbe) as AnyNode;
  const coefficients = buffer(new Float32Array(grid.probeCount * 9 * 4), 4);
  const coefficientNode = storage(coefficients, "vec4", grid.probeCount * 9) as AnyNode;

  const nodeCount = uniform(scene.nodeCount, "int") as AnyNode;
  const batchSize = uniform(0, "int");
  const sunDirection = uniform(new Vector3(0, 1, 0));
  const sunRadiance = uniform(new Vector3());
  const sky = uniform(new Vector3());
  const points = Array.from({ length: pointCount }, () => ({
    distance: uniform(0),
    position: uniform(new Vector3()),
    radiance: uniform(new Vector3()),
  }));
  const bounce = uniform(0);
  const nx = grid.resolution.x;
  const ny = grid.resolution.y;
  const nz = grid.resolution.z;
  const spacing = new Vector3(
    grid.size.x / (nx - 1),
    grid.size.y / (ny - 1),
    grid.size.z / (nz - 1),
  );
  const volumeMin = vec3(grid.min.x, grid.min.y, grid.min.z);
  const far = 4 * Math.max(grid.size.x, grid.size.y, grid.size.z, 1) + 1e4;

  /**
   * Trilinear L2 irradiance of the previous generation at a world point. A rejected probe (inside a solid, or outside
   * the walls) takes no weight, so a surface between the room and the outside does not bounce the outside's light.
   */
  const previousIrradiance = (point: AnyNode, normal: AnyNode): V3 => {
    const local = clamp(
      point.sub(volumeMin).div(vec3(spacing.x, spacing.y, spacing.z)),
      vec3(0),
      vec3(nx - 1, ny - 1, nz - 1),
    );
    const base = min(floor(local), vec3(nx - 2, ny - 2, nz - 2)).toVar();
    const fraction = local.sub(base);
    let sum: AnyNode = vec3(0);
    let total: AnyNode = float(0);
    for (let corner = 0; corner < 8; corner += 1) {
      const dx = corner & 1;
      const dy = (corner >> 1) & 1;
      const dz = (corner >> 2) & 1;
      const probe = int(base.x.add(dx))
        .add(int(base.y.add(dy)).mul(int(nx)))
        .add(int(base.z.add(dz)).mul(int(nx * ny)));
      const open = select(
        coefficientNode.element(probe.mul(int(9))).w.greaterThan(BACKFACE_REJECTION_SHARE),
        float(0),
        float(1),
      );
      const weight = (dx ? fraction.x : float(1).sub(fraction.x))
        .mul(dy ? fraction.y : float(1).sub(fraction.y))
        .mul(dz ? fraction.z : float(1).sub(fraction.z))
        .mul(open);
      const coefficient = (index: number) =>
        coefficientNode.element(probe.mul(int(9)).add(int(index))).xyz as V3;
      sum = sum.add(shIrradiance(coefficient, normal).mul(weight));
      total = total.add(weight);
    }
    return sum.div(max(total, 1e-4)) as V3;
  };

  const trace = Fn(() => {
    const slot = int(instanceIndex).div(int(raysPerProbe));
    const ray = int(instanceIndex).sub(slot.mul(int(raysPerProbe)));
    If(slot.greaterThanEqual(batchSize), () => Return());
    const probe = probes.element(slot);
    const ix = probe.mod(int(nx));
    const iy = probe.div(int(nx)).mod(int(ny));
    const iz = probe.div(int(nx * ny));
    const origin = volumeMin
      .add(vec3(float(ix), float(iy), float(iz)).mul(vec3(spacing.x, spacing.y, spacing.z)))
      .toVar();
    const direction = directions.element(ray).xyz.toVar();
    const back = float(far).toVar();
    const hit = traceRay(buffers, nodeCount, origin, direction, far, false, back);
    const result = vec3(sky).toVar();
    If(hit.triangle.greaterThanEqual(0), () => {
      const a = buffers.triangles.element(hit.triangle.mul(int(3)));
      const b = buffers.triangles.element(hit.triangle.mul(int(3)).add(int(1))).xyz;
      const c = buffers.triangles.element(hit.triangle.mul(int(3)).add(int(2))).xyz;
      const facing = normalize(cross(b.sub(a.xyz), c.sub(a.xyz))).toVar();
      // Two-sided: the side the ray arrived from is the side that returns light.
      If(dot(facing, direction).greaterThan(0), () => facing.assign(facing.negate()));
      const material = int(a.w);
      const albedo = buffers.materials.element(material.mul(int(2))).xyz;
      const emission = buffers.materials.element(material.mul(int(2)).add(int(1))).xyz;
      const point = origin.add(direction.mul(hit.t)).add(facing.mul(SURFACE_OFFSET)).toVar();
      const cosine = max(dot(facing, sunDirection), 0).toVar();
      const visible = float(0).toVar();
      If(cosine.greaterThan(0).and(dot(sunRadiance, vec3(1)).greaterThan(0)), () => {
        const shadow = traceRay(buffers, nodeCount, point, sunDirection, far, true);
        visible.assign(select(shadow.triangle.lessThan(0), float(1), float(0)));
      });
      const direct = vec3(sunRadiance).mul(cosine.mul(visible)).toVar();
      for (const light of points) {
        const toLight = light.position.sub(point);
        const squared = max(dot(toLight, toLight), 0.0001);
        const length = sqrt(squared);
        const toward = toLight.div(length);
        const facingLight = max(dot(facing, toward), 0);
        If(facingLight.greaterThan(0), () => {
          const shadow = traceRay(buffers, nodeCount, point, toward, length.sub(0.02), true);
          If(shadow.triangle.lessThan(0), () => {
            const window = select(
              light.distance.greaterThan(0),
              pow(clamp(float(1).sub(pow(length.div(light.distance), 4)), 0, 1), 2),
              float(1),
            );
            direct.addAssign(light.radiance.mul(facingLight.mul(window).div(squared)));
          });
        });
      }
      const irradiance = direct.add(previousIrradiance(point, facing).mul(bounce));
      result.assign(emission.add(albedo.mul(irradiance).mul(INV_PI)));
    });
    // w: the hit distance (`far` on a miss), negative when the ray first met a surface from behind (the probe's rejection
    // share, `BACKFACE_REJECTION_SHARE`). The octahedral map keeps the distance as its depth, as Unreal's radiance cache
    // keeps a depth atlas beside its radiance (UE 5.8.3: Engine/Shaders/Private/Lumen/LumenRadianceCacheInterpolation.ush:215).
    const distance = select(hit.triangle.greaterThanEqual(0), max(hit.t, 0.0001), float(far));
    radianceNode
      .element(instanceIndex)
      .assign(vec4(result, select(back.lessThan(hit.t), distance.negate(), distance)));
  })().compute(maxBatch * raysPerProbe);

  const project = Fn(() => {
    const slot = int(instanceIndex);
    If(slot.greaterThanEqual(batchSize), () => Return());
    const probe = probes.element(slot);
    const sums = Array.from({ length: 9 }, () => vec3(0).toVar());
    const backfaces = float(0).toVar();
    const add = (index: number, value: AnyNode) => (sums[index] as AnyNode).addAssign(value);
    Loop(
      { start: int(0), end: int(raysPerProbe), type: "int", condition: "<" },
      ({ i }: { i: AnyNode }) => {
        const sample = radianceNode.element(slot.mul(int(raysPerProbe)).add(i));
        const value = sample.xyz;
        backfaces.addAssign(select(sample.w.lessThan(0), float(1), float(0)));
        const d = directions.element(i);
        add(0, value.mul(0.282095));
        add(1, value.mul(d.y.mul(0.488603)));
        add(2, value.mul(d.z.mul(0.488603)));
        add(3, value.mul(d.x.mul(0.488603)));
        add(4, value.mul(d.x.mul(d.y).mul(1.092548)));
        add(5, value.mul(d.y.mul(d.z).mul(1.092548)));
        add(6, value.mul(d.z.mul(d.z).mul(3).sub(1).mul(0.315392)));
        add(7, value.mul(d.x.mul(d.z).mul(1.092548)));
        add(8, value.mul(d.x.mul(d.x).sub(d.y.mul(d.y)).mul(0.546274)));
      },
    );
    const norm = (4 * Math.PI) / raysPerProbe;
    sums.forEach((sum, index) => {
      coefficientNode
        .element(probe.mul(int(9)).add(int(index)))
        .assign(vec4((sum as AnyNode).mul(norm), index === 0 ? backfaces.div(raysPerProbe) : 0));
    });
  })().compute(maxBatch);

  // Each probe's octahedral radiance map: one work item per (probe, cell) averages the rays the table puts in that cell.
  const cells = octahedralResolution * octahedralResolution;
  let octahedral: AnyNode | undefined;
  let radianceMap: StorageBufferAttribute | undefined;
  if (cells > 0) {
    const table = octahedralRayTable(
      probeRayDirections(raysPerProbe),
      raysPerProbe,
      octahedralResolution,
    );
    const cellRays = read(table.rays, "vec4");
    const cellRanges = read(table.ranges, "vec4");
    radianceMap = buffer(new Float32Array(grid.probeCount * cells * 4), 4);
    const mapNode = storage(radianceMap, "vec4", grid.probeCount * cells) as AnyNode;
    octahedral = Fn(() => {
      const slot = int(instanceIndex).div(int(cells));
      const cell = int(instanceIndex).sub(slot.mul(int(cells)));
      If(slot.greaterThanEqual(batchSize), () => Return());
      const probe = probes.element(slot);
      const range = cellRanges.element(cell);
      const first = int(range.x);
      const count = int(range.y);
      const sum = vec3(0).toVar();
      const depth = float(0).toVar();
      Loop({ start: int(0), end: count, type: "int", condition: "<" }, ({ i }: { i: AnyNode }) => {
        const ray = int(cellRays.element(first.add(i)).x);
        const sample = radianceNode.element(slot.mul(int(raysPerProbe)).add(ray));
        sum.addAssign(sample.xyz);
        depth.addAssign(abs(sample.w));
      });
      // w: the cell's mean hit distance, the depth `ProbeVolume`'s visibility test reads.
      mapNode
        .element(probe.mul(int(cells)).add(cell))
        .assign(vec4(sum.div(float(count)), depth.div(float(count))));
    })().compute(maxBatch * cells);
  }

  return {
    batchSize,
    bounce,
    coefficients,
    dispose: () => {
      for (const attribute of attributes) (attribute as { dispose?: () => void }).dispose?.();
    },
    materials: materialNode.value as StorageBufferAttribute,
    maxBatch,
    octahedralResolution: cells > 0 ? octahedralResolution : 0,
    ...(octahedral === undefined ? {} : { octahedral }),
    ...(radianceMap === undefined ? {} : { radianceMap }),
    probeList,
    project,
    points,
    raysPerProbe,
    sky,
    sunDirection,
    sunRadiance,
    trace,
  };
}

/**
 * Replace each rejected probe's 27 coefficients (9 SH x RGB) with the mean of its open face neighbours, in rings
 * outward, so a reader that interpolates across a wall never mixes in the light a probe saw from inside it or from
 * behind it. A rejected probe with no open probe anywhere keeps its own value. Returns the number rejected.
 */
export function fillRejectedProbes(
  coefficients: Float32Array,
  shares: Float32Array,
  resolution: { readonly x: number; readonly y: number; readonly z: number },
  /** Other per-probe arrays to fill the same way (an octahedral radiance map), each with its floats per probe. */
  alongside: readonly { readonly data: Float32Array; readonly stride: number }[] = [],
): number {
  const { x: nx, y: ny, z: nz } = resolution;
  const open = Uint8Array.from(shares, (share) => (share > BACKFACE_REJECTION_SHARE ? 0 : 1));
  const rejected = open.length - open.reduce((sum, value) => sum + value, 0);
  let filled = [0];
  while (filled.length > 0) {
    filled = [];
    for (let probe = 0; probe < open.length; probe += 1) {
      const neighbours = open[probe] === 1 ? [] : openNeighbours(probe, open, nx, ny, nz);
      if (neighbours.length === 0) continue;
      meanInto(coefficients, probe, neighbours, 27);
      for (const { data, stride } of alongside) meanInto(data, probe, neighbours, stride);
      filled.push(probe);
    }
    for (const probe of filled) open[probe] = 1;
  }
  return rejected;
}

/** One probe's `stride` floats (27 SH coefficients, or a radiance map) become the mean of its neighbours'. */
function meanInto(
  coefficients: Float32Array,
  probe: number,
  neighbours: readonly number[],
  stride: number,
): void {
  for (let k = 0; k < stride; k += 1) {
    let sum = 0;
    for (const n of neighbours) sum += coefficients[n * stride + k] ?? 0;
    coefficients[probe * stride + k] = sum / neighbours.length;
  }
}

/** The open face neighbours of a probe in an nx x ny x nz grid. */
function openNeighbours(
  probe: number,
  open: Uint8Array,
  nx: number,
  ny: number,
  nz: number,
): number[] {
  const ix = probe % nx;
  const iy = Math.floor(probe / nx) % ny;
  const iz = Math.floor(probe / (nx * ny));
  return [
    ix > 0 ? probe - 1 : -1,
    ix < nx - 1 ? probe + 1 : -1,
    iy > 0 ? probe - nx : -1,
    iy < ny - 1 ? probe + nx : -1,
    iz > 0 ? probe - nx * ny : -1,
    iz < nz - 1 ? probe + nx * ny : -1,
  ].filter((n) => n >= 0 && open[n] === 1);
}

/** A lighting step: where the sun points and how bright the sun and the sky are, at one moment. */
export interface ILightingKey {
  readonly direction: Vector3;
  readonly sun: number;
  readonly sky: number;
}

/** PRD-603 Phase 3: a step is more than one degree of sun direction, or a 4x change of the brightest channel. */
const LIGHTING_STEP_RADIANS = Math.PI / 180;
const LIGHTING_STEP_RATIO = 4;

export function lightingKey(lighting: IProbeTraceLighting): ILightingKey {
  const peak = (color: Color, scale: number) => Math.max(color.r, color.g, color.b) * scale;
  return {
    direction: lighting.direction.clone().normalize(),
    sky: peak(lighting.sky, 1),
    sun: peak(lighting.color, lighting.intensity),
  };
}

const ratioStepped = (from: number, to: number): boolean => {
  if (from === to) return false;
  if (from <= 0 || to <= 0) return true;
  const ratio = to / from;
  return ratio > LIGHTING_STEP_RATIO || ratio < 1 / LIGHTING_STEP_RATIO;
};

/**
 * True when `to` differs from `from` by more than the field may serve as a small drift. The direction counts only while
 * the sun lights the scene: an unlit sun has none, and three's `angleTo` reads a zero vector as 90 degrees, so a scene
 * with no sun would restart its bake every frame.
 */
export function lightingStepped(from: ILightingKey, to: ILightingKey): boolean {
  return (
    (from.sun > 0 && to.sun > 0 && from.direction.angleTo(to.direction) > LIGHTING_STEP_RADIANS) ||
    ratioStepped(from.sun, to.sun) ||
    ratioStepped(from.sky, to.sky)
  );
}

/** Pack the lighting inputs into the kernel uniforms. */
export function applyTraceLighting(
  kernels: IProbeTraceKernels,
  lighting: IProbeTraceLighting,
): void {
  // `set`, not `copy`: the owned engine's uniform vectors take a component write.
  const { x, y, z } = lighting.direction.clone().normalize();
  kernels.sunDirection.value.set(x, y, z);
  kernels.sunRadiance.value
    .set(lighting.color.r, lighting.color.g, lighting.color.b)
    .multiplyScalar(lighting.intensity);
  kernels.sky.value.set(lighting.sky.r, lighting.sky.g, lighting.sky.b);
  kernels.points.forEach((light, index) => {
    const source = lighting.points?.[index];
    light.radiance.value.set(0, 0, 0);
    if (source === undefined) return;
    light.position.value.set(source.position.x, source.position.y, source.position.z);
    light.radiance.value
      .set(source.color.r, source.color.g, source.color.b)
      .multiplyScalar(source.intensity);
    light.distance.value = source.distance ?? 0;
  });
}
