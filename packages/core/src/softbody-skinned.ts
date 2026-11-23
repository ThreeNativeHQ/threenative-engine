/**
 * Skinned cloth for `SoftBody3D` (PRD-911): a cape, skirt or coat tail on an animated character.
 *
 * The solver follows Unreal Chaos Cloth's per-substep order (UE 5.8.3:
 * Engine/Source/Runtime/Experimental/Chaos/Private/Chaos/SoftsEvolution.cpp:428-640): kinematic
 * particles take the interpolated animation, free particles integrate, then stretch and bend
 * constraints, long-range tethers and body collisions run. It simulates in world space and gives the
 * cloth back only part of the reference bone's motion, as Unreal's velocity scales do
 * (ChaosClothConfig.h:413,446, default 0.75). A root jump past the teleport distance carries the cloth
 * with no velocity (SkeletalMeshComponent.cpp:471-473). Body capsules follow bones and are
 * interpolated per substep with thickness 1 cm and friction 0.8 (PBDSoftBodyCollisionConstraint.h:215-217).
 *
 * The algorithms borrow from two MIT projects, ported rather than copied:
 * three-simplecloth (c) 2026 bandinopla — the vertex-colour mask (1 follows the skin, 0 simulates) and
 * the world-space skinned pins; threejs-particle-fluids (c) Dominic Greenheck — the geodesic tether
 * build (Kim 2012 long-range attachments). See THIRD_PARTY_NOTICES.md.
 *
 * Every per-vertex table is a static storage buffer and every per-frame value is a uniform read at a
 * constant index, because the owned engine reads uniform arrays only at constant indices. Positions
 * never leave the GPU unless the game asks for readback.
 */
import {
  Box3,
  type BufferGeometry,
  Matrix4,
  type Object3D,
  Quaternion,
  type SkinnedMesh,
  Vector3,
  Vector4,
} from "three";
import {
  Fn,
  If,
  Loop,
  cross,
  exp,
  float,
  instanceIndex,
  instancedArray,
  length,
  max,
  min,
  mix,
  uniform,
  uniformArray,
  vec3,
} from "three/tsl";
import type { ComputeNode, Node, StorageBufferNode, UniformArrayNode } from "three/webgpu";
import { buildClothTopology } from "./softbody-topology.js";

/** A capsule that follows a bone: from `start` to `end`, both in the bone's local space. */
export interface ISoftBodyCapsule {
  readonly bone: Object3D;
  /** Bone-local start point; the bone origin by default. */
  readonly start?: Vector3;
  /** Bone-local end point. */
  readonly end: Vector3;
  /** World-space radius in metres. */
  readonly radius: number;
}

export type SoftBodyMaskSource = "color.r" | "color.g" | "color.b" | "color.a" | ArrayLike<number>;

/** Options for a `SoftBody3D` built on a `SkinnedMesh`. Every value is a named override. */
export interface ISkinnedSoftBody3DOptions {
  /**
   * Per-vertex cloth mask: 1 follows the skin (pinned), 0 simulates, values between blend. A vertex
   * colour channel or one number per source vertex. Default: "color.r" when the mesh has colours,
   * else the vertices skinned only to leaf bones simulate and the rest follow the skin.
   */
  readonly cloth?: SoftBodyMaskSource;
  /** Substeps per fixed step. Default 6. */
  readonly substeps?: number;
  /** Jacobi constraint iterations per substep, an even number from 2. Default 2. */
  readonly iterations?: number;
  /** Stretch constraint stiffness, 0..1. Default 1. */
  readonly stretchStiffness?: number;
  /** Bend constraint stiffness, 0..1. Default 0.25. */
  readonly bendStiffness?: number;
  /**
   * Global velocity damping per second. Default -ln(1 - 0.01) × 60 ≈ 0.603: Chaos Cloth's stock
   * DampingCoefficient 0.01 per step at its 60 Hz solver frequency
   * (UE 5.8.3: Engine/Plugins/ChaosCloth/Source/ChaosCloth/Public/ChaosCloth/ChaosClothConfig.h:289,
   * Engine/Source/Runtime/Experimental/Chaos/Private/Chaos/SoftsEvolution.cpp:60).
   */
  readonly damping?: number;
  /** World gravity, m/s². Default (0, -9.81, 0). */
  readonly gravity?: readonly [number, number, number];
  /** World wind velocity, m/s. Default (0, 0, 0). */
  readonly wind?: readonly [number, number, number];
  /**
   * Per-triangle aerodynamic drag coefficient, Chaos Cloth's model: each triangle feels
   * ¼ρ·2A·((Cd − Cl)(V·N)V + Cl|V|²N) with V the wind relative to the triangle. Default 0.035
   * (UE 5.8.3: Engine/Plugins/ChaosCloth/Source/ChaosCloth/Public/ChaosCloth/ChaosClothConfig.h:318,
   * Engine/Source/Runtime/Experimental/Chaos/Public/Chaos/VelocityField.h:228).
   */
  readonly drag?: number;
  /** Per-triangle aerodynamic lift coefficient. Default 0.035 (ChaosClothConfig.h:344). */
  readonly lift?: number;
  /** Air density, kg/m³. Default 1.225 (VelocityField.h:21). */
  readonly fluidDensity?: number;
  /** Cloth areal density, kg/m², which sets each particle's mass. Default 0.35 (ChaosClothConfig.h:120). */
  readonly density?: number;
  /** Share of the reference bone's linear motion the cloth feels as inertia. Unreal default 0.75. */
  readonly velocityScale?: number;
  /** Share of the reference bone's rotation the cloth feels as inertia. Unreal default 0.75. */
  readonly angularVelocityScale?: number;
  /** The bone whose motion `velocityScale` splits. Default: the skeleton's first bone. */
  readonly referenceBone?: Object3D;
  /** A reference-bone move longer than this in one step is a teleport. Default 3 m × height / 1.8 m. */
  readonly teleportDistance?: number;
  /** A reference-bone turn larger than this in one step (radians) is a teleport. Default π/2. */
  readonly teleportRotation?: number;
  /** Body capsules: "auto" measures them from the character's skin; false turns them off. */
  readonly bodyColliders?: "auto" | false | readonly ISoftBodyCapsule[];
  /** Collision thickness in metres. Unreal default 0.01. */
  readonly colliderThickness?: number;
  /** Collision friction. Unreal default 0.8. */
  readonly friction?: number;
  /** Long-range tethers from each free particle to its nearest pin. Default true. */
  readonly tethers?: boolean;
  /**
   * Tether slack as a fraction of the geodesic rest distance. Default 0: Chaos Cloth's stock
   * TetherScale 1 (UE 5.8.3: Engine/Plugins/ChaosCloth/Source/ChaosCloth/Public/ChaosCloth/ChaosClothConfig.h:211).
   */
  readonly tetherSlack?: number;
  /** Hide the source SkinnedMesh, which this node draws in its place. Default true. */
  readonly hideSource?: boolean;
  /** Fixed step in seconds. Default 1/60. */
  readonly timeStep?: number;
  /** Copy positions to the CPU every N steps; 0 (default) never reads back. */
  readonly readbackEveryFrames?: number;
}

function boneTable(mesh: SkinnedMesh): Float32Array {
  const table = mesh.skeleton.boneMatrices;
  if (table === null)
    throw new Error("SoftBody3D skinned cloth needs an initialised skeleton (boneMatrices).");
  return table;
}

const skinScratch = {
  sum: new Vector3(),
  base: new Vector3(),
  part: new Vector3(),
  bone: new Matrix4(),
};

/**
 * @internal A vertex's skinned world position: meshWorld · bindInverse · Σ wₖ boneWorldₖ · boneInverseₖ · bind · p.
 * three's `applyBoneTransform` math, written out because the owned engine's SkinnedMesh does not bind it.
 * It reads `skeleton.boneMatrices` (boneWorld · boneInverse), the one skinning table both engines expose;
 * call `skeleton.update()` first.
 */
export function skinnedWorldPosition(mesh: SkinnedMesh, vertex: number, out: Vector3): Vector3 {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute("position");
  const skinIndex = geometry.getAttribute("skinIndex");
  const skinWeight = geometry.getAttribute("skinWeight");
  const { sum, base, part, bone } = skinScratch;
  base.fromBufferAttribute(position, vertex).applyMatrix4(mesh.bindMatrix);
  sum.set(0, 0, 0);
  for (let k = 0; k < 4; k++) {
    const weight = skinWeight.getComponent(vertex, k);
    if (weight === 0) continue;
    const index = skinIndex.getComponent(vertex, k);
    bone.fromArray(boneTable(mesh), index * 16);
    sum.addScaledVector(part.copy(base).applyMatrix4(bone), weight);
  }
  return out.copy(sum).applyMatrix4(mesh.bindMatrixInverse).applyMatrix4(mesh.matrixWorld);
}

/** @internal Up to this many bones move the pinned vertices (unrolled at constant indices). */
export const MAX_PIN_BONES = 8;
/** Unreal's FPhysAssetCreateParams::MinBoneSize, 20 cm, in metres. */
const MIN_BONE_SIZE = 0.2;
/** @internal Up to this many body capsules (unrolled at constant indices). */
export const MAX_BODY_CAPSULES = 16;
/** @internal Jacobi over-relaxation over the stretch constraints. */
const RELAXATION = 1.8;

export type SoftBodyResetCause = "teleport" | "manual";

function check(name: string, value: number, min = 0, maxValue = Number.POSITIVE_INFINITY): number {
  if (!Number.isFinite(value) || value < min || value > maxValue)
    throw new Error(`SoftBody3D.${name} must be a finite number in [${min}, ${maxValue}].`);
  return value;
}

function vec(
  name: string,
  value: readonly [number, number, number] | undefined,
  fallback: Vector3,
) {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.length !== 3)
    throw new Error(`SoftBody3D.${name} must contain three numbers.`);
  return new Vector3(
    check(`${name}.x`, value[0], -1e9),
    check(`${name}.y`, value[1], -1e9),
    check(`${name}.z`, value[2], -1e9),
  );
}

/** @internal Per-source-vertex mask; 1 follows the skin. */
export function readClothMask(
  geometry: BufferGeometry,
  source: SoftBodyMaskSource | undefined,
  leafWeighted: (vertex: number) => boolean,
): { readonly mask: Float32Array; readonly chosen: string } {
  const count = geometry.getAttribute("position").count;
  const mask = new Float32Array(count);
  if (source !== undefined && typeof source !== "string") {
    if (source.length !== count)
      throw new Error(`SoftBody3D.cloth has ${source.length} values for ${count} vertices.`);
    for (let v = 0; v < count; v++) mask[v] = check("cloth[]", source[v] as number, 0, 1);
    return { mask, chosen: "array" };
  }
  const colour = geometry.getAttribute("color");
  if (source !== undefined || colour !== undefined) {
    const channel = source ?? "color.r";
    if (colour === undefined)
      throw new Error(`SoftBody3D.cloth is "${channel}" but the mesh has no color attribute.`);
    const lane = "rgba".indexOf(channel.slice(-1));
    if (lane >= colour.itemSize)
      throw new Error(
        `SoftBody3D.cloth is "${channel}" but the color attribute has ${colour.itemSize} lanes.`,
      );
    for (let v = 0; v < count; v++)
      mask[v] = Math.min(1, Math.max(0, colour.getComponent(v, lane)));
    return { mask, chosen: channel };
  }
  for (let v = 0; v < count; v++) mask[v] = leafWeighted(v) ? 0 : 1;
  return { mask, chosen: "leaf-bones" };
}

/** @internal Padded adjacency: stretch edges (rest > 0) and bend pairs across shared edges (rest < 0). */
export function buildClothAdjacency(
  unique: Float32Array,
  triangles: Uint32Array,
): {
  readonly neighbors: Float32Array;
  readonly counts: Uint32Array;
  readonly maxNeighbors: number;
  readonly edges: Map<number, number[]>;
} {
  const vertexCount = unique.length / 3;
  const lists: Array<Array<[number, number]>> = Array.from({ length: vertexCount }, () => []);
  const distance = (a: number, b: number) =>
    Math.hypot(
      (unique[a * 3] as number) - (unique[b * 3] as number),
      (unique[a * 3 + 1] as number) - (unique[b * 3 + 1] as number),
      (unique[a * 3 + 2] as number) - (unique[b * 3 + 2] as number),
    );
  const edges = new Map<number, number[]>();
  const opposite = new Map<number, number[]>();
  const key = (a: number, b: number) => (a < b ? a * vertexCount + b : b * vertexCount + a);
  for (let t = 0; t < triangles.length; t += 3)
    for (let e = 0; e < 3; e++) {
      const a = triangles[t + e] as number;
      const b = triangles[t + ((e + 1) % 3)] as number;
      const c = triangles[t + ((e + 2) % 3)] as number;
      if (a === b) continue;
      const k = key(a, b);
      if (!opposite.has(k)) {
        opposite.set(k, []);
        lists[a]?.push([b, distance(a, b)]);
        lists[b]?.push([a, distance(a, b)]);
        const list = edges.get(a) ?? [];
        list.push(b);
        edges.set(a, list);
        const back = edges.get(b) ?? [];
        back.push(a);
        edges.set(b, back);
      }
      opposite.get(k)?.push(c);
    }
  for (const corners of opposite.values()) {
    if (corners.length !== 2) continue;
    const [c, d] = corners as [number, number];
    if (c === d || lists[c]?.some(([n]) => n === d)) continue;
    lists[c]?.push([d, -distance(c, d)]);
    lists[d]?.push([c, -distance(c, d)]);
  }
  const maxNeighbors = Math.max(1, ...lists.map((list) => list.length));
  const neighbors = new Float32Array(vertexCount * maxNeighbors * 2);
  const counts = new Uint32Array(vertexCount);
  lists.forEach((list, v) => {
    counts[v] = list.length;
    list.forEach(([n, rest], slot) => {
      neighbors[(v * maxNeighbors + slot) * 2] = n;
      neighbors[(v * maxNeighbors + slot) * 2 + 1] = rest;
    });
  });
  return { neighbors, counts, maxNeighbors, edges };
}

/** @internal Nearest pin and geodesic distance per vertex (multi-source Dijkstra over edges). */
export function buildTethers(
  unique: Float32Array,
  edges: Map<number, number[]>,
  pinned: (vertex: number) => boolean,
): { readonly anchor: Int32Array; readonly distance: Float32Array } {
  const count = unique.length / 3;
  const anchor = new Int32Array(count).fill(-1);
  const distance = new Float32Array(count).fill(Number.POSITIVE_INFINITY);
  const done = new Uint8Array(count);
  for (let v = 0; v < count; v++)
    if (pinned(v)) {
      anchor[v] = v;
      distance[v] = 0;
    }
  // ponytail: O(V²) selection, fine for cloth of a few thousand vertices; a heap if capes grow.
  for (;;) {
    let best = -1;
    for (let v = 0; v < count; v++)
      if (
        !done[v] &&
        Number.isFinite(distance[v] as number) &&
        (best < 0 || (distance[v] as number) < (distance[best] as number))
      )
        best = v;
    if (best < 0) break;
    done[best] = 1;
    for (const n of edges.get(best) ?? []) {
      const step = Math.hypot(
        (unique[best * 3] as number) - (unique[n * 3] as number),
        (unique[best * 3 + 1] as number) - (unique[n * 3 + 1] as number),
        (unique[best * 3 + 2] as number) - (unique[n * 3 + 2] as number),
      );
      const through = (distance[best] as number) + step;
      if (through < (distance[n] as number)) {
        distance[n] = through;
        anchor[n] = anchor[best] as number;
      }
    }
  }
  return { anchor, distance };
}

/**
 * Measure body capsules from every other SkinnedMesh on the same skeleton: one per bone that carries
 * at least 24 skin vertices, longest-weighted first. Each radius stops `clearance` short of every point
 * in `clearOf` (the cloth's rest world positions). The skinned `SoftBody3D` calls it with its own rest
 * pose and collision thickness, so a probe that calls it the same way reads the solver's capsules.
 * @situation measure the body capsules a cape or skirt collides with
 * @situation check whether cloth is inside a skinned character's body
 */
export function measureBodyCapsules(
  source: SkinnedMesh,
  maxCapsules = MAX_BODY_CAPSULES,
  clearOf: ArrayLike<number> = [],
  clearance = 0,
): ISoftBodyCapsule[] {
  let top: Object3D = source;
  while (top.parent !== null) top = top.parent;
  const bones = new Set<Object3D>(source.skeleton.bones);
  const bodies: SkinnedMesh[] = [];
  top.traverse((object) => {
    const mesh = object as SkinnedMesh;
    if (mesh === source || mesh.isSkinnedMesh !== true) return;
    if (mesh.skeleton.bones.some((bone) => bones.has(bone))) bodies.push(mesh);
  });
  const byBone = new Map<Object3D, Vector3[]>();
  const point = new Vector3();
  for (const body of bodies) {
    body.updateWorldMatrix(true, false);
    body.skeleton.update();
    const skinIndex = body.geometry.getAttribute("skinIndex");
    const skinWeight = body.geometry.getAttribute("skinWeight");
    const count = body.geometry.getAttribute("position").count;
    for (let v = 0; v < count; v++) {
      let lane = 0;
      for (let k = 1; k < 4; k++)
        if (skinWeight.getComponent(v, k) > skinWeight.getComponent(v, lane)) lane = k;
      const bone = body.skeleton.bones[skinIndex.getComponent(v, lane)];
      if (bone === undefined) continue;
      skinnedWorldPosition(body, v, point);
      const list = byBone.get(bone) ?? [];
      list.push(point.clone());
      byBone.set(bone, list);
    }
  }
  // Unreal's physics-asset rule: walk the skeleton from the leaves up, and a bone whose skin (plus what
  // merged into it) spans less than MinBoneSize merges into its parent, so fingers and toes become part
  // of the hand and foot instead of taking capsule slots (UE 5.8.3:
  // Engine/Source/Developer/PhysicsUtilities/Private/PhysicsAssetUtils.cpp:321-345, size from
  // CalcBoneInfoLength :160-177, MinBoneSize 20 cm in PhysicsAssetUtils.h:46).
  const merged = new Map<Object3D, number>();
  const inverse = new Matrix4();
  for (let index = source.skeleton.bones.length - 1; index >= 0; index--) {
    const bone = source.skeleton.bones[index] as Object3D;
    const points = byBone.get(bone) ?? [];
    bone.updateWorldMatrix(true, false);
    inverse.copy(bone.matrixWorld).invert();
    const box = new Box3();
    for (const p of points) box.expandByPoint(point.copy(p).applyMatrix4(inverse));
    const size = (merged.get(bone) ?? 0) + (box.isEmpty() ? 0 : box.getSize(point).length() / 2);
    merged.set(bone, size);
    const parent = bone.parent;
    if (size >= MIN_BONE_SIZE || parent === null || !bones.has(parent)) continue;
    merged.set(parent, (merged.get(parent) ?? 0) + size);
    if (points.length > 0) byBone.set(parent, [...(byBone.get(parent) ?? []), ...points]);
    byBone.delete(bone);
  }
  const capsules: Array<ISoftBodyCapsule & { readonly weight: number }> = [];
  const a = new Vector3();
  const b = new Vector3();
  for (const [bone, points] of byBone) {
    if (!((merged.get(bone) ?? 0) >= MIN_BONE_SIZE) || points.length < 4) continue;
    bone.updateWorldMatrix(true, false);
    a.setFromMatrixPosition(bone.matrixWorld);
    const centroid = points
      .reduce((sum, p) => sum.add(p), new Vector3())
      .divideScalar(points.length);
    const toward = centroid.clone().sub(a);
    let end: Vector3 | undefined;
    let bestDot = 0.2;
    for (const child of bone.children) {
      if ((child as { isBone?: boolean }).isBone !== true) continue;
      const dir = child.getWorldPosition(new Vector3()).sub(a);
      const dot = dir.clone().normalize().dot(toward.clone().normalize());
      if (dir.lengthSq() > 1e-8 && dot > bestDot) {
        bestDot = dot;
        end = child.getWorldPosition(new Vector3());
      }
    }
    b.copy(end ?? a.clone().addScaledVector(toward, 2));
    const ab = b.clone().sub(a);
    const distances = points
      .map((p) => {
        const t =
          ab.lengthSq() > 1e-10
            ? Math.min(1, Math.max(0, p.clone().sub(a).dot(ab) / ab.lengthSq()))
            : 0;
        return p.distanceTo(a.clone().addScaledVector(ab, t));
      })
      .sort((x, y) => x - y);
    // The 40th percentile hugs the narrow side of a torso, where a cape lies, instead of the shoulders.
    let radius = distances[Math.floor(distances.length * 0.4)] as number;
    // A cloth that fits at rest stays at rest: no capsule may reach a rest cloth vertex, or collision and
    // the pins fight from the first step and the fight turns into velocity once the body moves.
    for (let v = 0; v + 2 < clearOf.length; v += 3) {
      point.set(clearOf[v] as number, clearOf[v + 1] as number, clearOf[v + 2] as number);
      const t =
        ab.lengthSq() > 1e-10
          ? Math.min(1, Math.max(0, point.clone().sub(a).dot(ab) / ab.lengthSq()))
          : 0;
      radius = Math.min(radius, point.distanceTo(a.clone().addScaledVector(ab, t)) - clearance);
    }
    if (!(radius > 1e-3)) continue;
    inverse.copy(bone.matrixWorld).invert();
    capsules.push({
      bone,
      start: new Vector3(),
      end: b.clone().applyMatrix4(inverse),
      radius,
      weight: points.length,
    });
  }
  return capsules
    .sort((x, y) => y.weight - x.weight)
    .slice(0, maxCapsules)
    .map(({ weight: _weight, ...capsule }) => capsule);
}

/** @internal Fraction of the reference motion carried rigidly: x' = pivot + t + R (x - pivot). */
export function frameCarry(
  prevPosition: Vector3,
  prevQuaternion: Quaternion,
  position: Vector3,
  quaternion: Quaternion,
  linearShare: number,
  angularShare: number,
  out: { readonly rotation: Quaternion; readonly translation: Vector3 },
): void {
  const delta = quaternion.clone().multiply(prevQuaternion.clone().invert());
  out.rotation.identity().slerp(delta, 1 - angularShare);
  out.translation
    .copy(position)
    .sub(prevPosition)
    .multiplyScalar(1 - linearShare);
}

function rotate(q: Node<"vec4">, v: Node<"vec3">): Node<"vec3"> {
  const u = q.xyz;
  const t = u.cross(v).mul(2);
  return v.add(t.mul(q.w)).add(u.cross(t));
}

export interface ISkinnedClothState {
  readonly positions: StorageBufferNode<"vec3">;
  readonly originalToUnique: StorageBufferNode<"uint">;
  readonly nodes: readonly ComputeNode[];
  readonly uniqueVertexCount: number;
  readonly springCount: number;
  readonly capsules: readonly ISoftBodyCapsule[];
  readonly maskSource: string;
  readonly teleportDistance: number;
  readonly substeps: number;
  readonly gravity: Vector3;
  readonly wind: Vector3;
  /** Uploads this step's bone, capsule and carry uniforms, then dispatches the carry and every substep. */
  step(dispatch: (node: ComputeNode) => void): void;
  requestReset(): void;
  readonly lastReset: SoftBodyResetCause | undefined;
  readonly resets: number;
}

/** @internal Build the skinned cloth solver for `SoftBody3D`. */
export function createSkinnedCloth(
  source: SkinnedMesh,
  options: ISkinnedSoftBody3DOptions,
): ISkinnedClothState {
  if (source.isSkinnedMesh !== true)
    throw new Error("SoftBody3D skinned cloth needs a SkinnedMesh.");
  const geometry = source.geometry;
  if (geometry.getIndex() === null)
    throw new Error("SoftBody3D skinned cloth needs an indexed geometry.");
  const skinIndex = geometry.getAttribute("skinIndex");
  const skinWeight = geometry.getAttribute("skinWeight");
  if (skinIndex === undefined || skinWeight === undefined)
    throw new Error("SoftBody3D skinned cloth needs skinIndex and skinWeight attributes.");
  const substeps = check("substeps", options.substeps ?? 6, 1, 32);
  const iterations = check("iterations", options.iterations ?? 2, 2, 16);
  if (iterations % 2 !== 0)
    throw new Error("SoftBody3D.iterations must be even: the passes ping-pong two buffers.");
  if (!Number.isInteger(substeps)) throw new Error("SoftBody3D.substeps must be an integer.");
  const stretchK = check("stretchStiffness", options.stretchStiffness ?? 1, 0, 1);
  const bendK = check("bendStiffness", options.bendStiffness ?? 0.25, 0, 1);
  const dampingValue = check("damping", options.damping ?? -Math.log(1 - 0.01) * 60);
  const dragValue = check("drag", options.drag ?? 0.035);
  const liftValue = check("lift", options.lift ?? 0.035);
  const fluidDensity = check("fluidDensity", options.fluidDensity ?? 1.225);
  const density = check("density", options.density ?? 0.35, 1e-6);
  const teleportRotation = check(
    "teleportRotation",
    options.teleportRotation ?? Math.PI / 2,
    0,
    Math.PI,
  );
  const linearShare = check("velocityScale", options.velocityScale ?? 0.75, 0, 1);
  const angularShare = check("angularVelocityScale", options.angularVelocityScale ?? 0.75, 0, 1);
  const thicknessValue = check("colliderThickness", options.colliderThickness ?? 0.01);
  const frictionValue = check("friction", options.friction ?? 0.8);
  const tetherSlack = check("tetherSlack", options.tetherSlack ?? 0);
  const timeStep = check("timeStep", options.timeStep ?? 1 / 60, 1e-4, 1);
  const gravity = vec("gravity", options.gravity, new Vector3(0, -9.81, 0));
  const wind = vec("wind", options.wind, new Vector3());
  const bones = source.skeleton.bones;
  const reference = options.referenceBone ?? bones[0];
  if (reference === undefined)
    throw new Error("SoftBody3D skinned cloth needs a skeleton with bones.");

  source.updateWorldMatrix(true, true);
  source.skeleton.update();
  // Leaf-bone rule for the auto mask: a vertex skinned only to bones without bone children simulates.
  const leaf = (vertex: number): boolean => {
    for (let k = 0; k < 4; k++) {
      if (skinWeight.getComponent(vertex, k) <= 0) continue;
      const bone = bones[skinIndex.getComponent(vertex, k)];
      if (bone?.children.some((child) => (child as { isBone?: boolean }).isBone === true))
        return false;
    }
    return true;
  };
  const { mask: sourceMask, chosen } = readClothMask(geometry, options.cloth, leaf);
  const topology = buildClothTopology(geometry, { pinned: [0] }); // welding only; the mask pins;
  const vertexCount = topology.positions.length / 3;
  const firstOriginal = new Int32Array(vertexCount).fill(-1);
  topology.originalToUnique.forEach((unique, original) => {
    if ((firstOriginal[unique] as number) < 0) firstOriginal[unique] = original;
  });

  // World rest positions in the current pose, and the raw positions skinning reads.
  const raw = new Float32Array(vertexCount * 4);
  const world = new Float32Array(vertexCount * 3);
  const mask = new Float32Array(vertexCount);
  const point = new Vector3();
  for (let v = 0; v < vertexCount; v++) {
    const original = firstOriginal[v] as number;
    point.fromBufferAttribute(geometry.getAttribute("position"), original);
    raw.set([point.x, point.y, point.z, 1], v * 4);
    skinnedWorldPosition(source, original, point);
    world.set([point.x, point.y, point.z], v * 3);
    mask[v] = sourceMask[original] as number;
  }
  const index = geometry.getIndex() as NonNullable<ReturnType<BufferGeometry["getIndex"]>>;
  const triangles = new Uint32Array(index.count);
  for (let i = 0; i < index.count; i++)
    triangles[i] = topology.originalToUnique[index.getX(i)] as number;
  const adjacency = buildClothAdjacency(world, triangles);
  const pinned = (v: number) => (mask[v] as number) >= 1;
  if (!mask.some((m) => m >= 1))
    throw new Error(
      "SoftBody3D skinned cloth has no vertex with mask 1; nothing holds it on the body.",
    );
  const tethers =
    options.tethers === false ? undefined : buildTethers(world, adjacency.edges, pinned);

  // Pin bones: every bone that moves a vertex with a mask above zero.
  const pinBones: Object3D[] = [];
  const slotOf = new Map<number, number>();
  const weights = new Float32Array(vertexCount * MAX_PIN_BONES);
  for (let v = 0; v < vertexCount; v++) {
    if ((mask[v] as number) <= 0) continue;
    const original = firstOriginal[v] as number;
    for (let k = 0; k < 4; k++) {
      const w = skinWeight.getComponent(original, k);
      if (w <= 0) continue;
      const boneIndex = skinIndex.getComponent(original, k);
      let slot = slotOf.get(boneIndex);
      if (slot === undefined) {
        slot = pinBones.length;
        if (slot >= MAX_PIN_BONES)
          throw new Error(
            `SoftBody3D skinned cloth pins follow more than ${MAX_PIN_BONES} bones; weight the pinned vertices to fewer bones.`,
          );
        slotOf.set(boneIndex, slot);
        pinBones.push(bones[boneIndex] as Object3D);
      }
      weights[v * MAX_PIN_BONES + slot] = (weights[v * MAX_PIN_BONES + slot] as number) + w;
    }
  }
  const pinBoneIndices = [...slotOf.keys()];

  // Body capsules.
  const capsules: readonly ISoftBodyCapsule[] =
    options.bodyColliders === false
      ? []
      : options.bodyColliders === undefined || options.bodyColliders === "auto"
        ? measureBodyCapsules(source, MAX_BODY_CAPSULES, world, thicknessValue)
        : options.bodyColliders;
  if (capsules.length > MAX_BODY_CAPSULES)
    throw new Error(
      `SoftBody3D.bodyColliders holds ${capsules.length}; at most ${MAX_BODY_CAPSULES}.`,
    );
  for (const capsule of capsules) check("bodyColliders[].radius", capsule.radius, 1e-4);

  // Height from the skeleton's vertical extent, for the auto teleport distance.
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const bone of bones) {
    const y = bone.getWorldPosition(point).y;
    low = Math.min(low, y);
    high = Math.max(high, y);
  }
  const height = Math.max(0.1, high - low);
  const teleportDistance = check(
    "teleportDistance",
    options.teleportDistance ?? (3 * height) / 1.8,
    1e-3,
  );

  // Rest pose relative to the reference bone, for reset().
  reference.updateWorldMatrix(true, false);
  const refPosition = new Vector3();
  const refQuaternion = new Quaternion();
  const refScale = new Vector3();
  reference.matrixWorld.decompose(refPosition, refQuaternion, refScale);
  const restRef = new Float32Array(vertexCount * 3);
  const inverseRef = refQuaternion.clone().invert();
  for (let v = 0; v < vertexCount; v++) {
    point
      .fromArray(world, v * 3)
      .sub(refPosition)
      .applyQuaternion(inverseRef);
    restRef.set([point.x, point.y, point.z], v * 3);
  }
  const info = new Float32Array(vertexCount * 4);
  for (let v = 0; v < vertexCount; v++) {
    const anchor = tethers?.anchor[v] ?? -1;
    const reach = tethers?.distance[v] ?? 0;
    info.set(
      [mask[v] as number, anchor, Number.isFinite(reach) ? reach * (1 + tetherSlack) : -1, 0],
      v * 4,
    );
  }
  const meta = new Uint32Array(vertexCount);
  meta.set(adjacency.counts);
  // Triangles around each vertex, and its mass from the cloth density over a third of their rest area.
  const around: number[][] = Array.from({ length: vertexCount }, () => []);
  const restArea = new Float32Array(vertexCount);
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    const [i0, i1, i2] = [triangles[t], triangles[t + 1], triangles[t + 2]] as [
      number,
      number,
      number,
    ];
    const origin = new Vector3().fromArray(world, i0 * 3);
    const e1 = new Vector3().fromArray(world, i1 * 3).sub(origin);
    const area = e1.cross(new Vector3().fromArray(world, i2 * 3).sub(origin)).length() / 2;
    for (const v of [i0, i1, i2]) {
      (around[v] as number[]).push(t);
      restArea[v] = (restArea[v] as number) + area / 3;
    }
  }
  const maxTriangles = Math.max(1, ...around.map((list) => list.length));
  const triangleData = new Float32Array(vertexCount * maxTriangles * 4);
  const inverseMass = new Float32Array(vertexCount);
  around.forEach((list, v) => {
    info[v * 4 + 3] = list.length;
    inverseMass[v] = (restArea[v] as number) > 0 ? 1 / (density * (restArea[v] as number)) : 0;
    list.forEach((t, k) =>
      triangleData.set(
        [triangles[t] as number, triangles[t + 1] as number, triangles[t + 2] as number, 0],
        (v * maxTriangles + k) * 4,
      ),
    );
  });
  const triangleBuffer = instancedArray(triangleData, "vec4");
  const inverseMassBuffer = instancedArray(inverseMass, "float");

  const x = instancedArray(new Float32Array(world), "vec3");
  const velocity = instancedArray(new Float32Array(vertexCount * 3), "vec3");
  const pA = instancedArray(new Float32Array(world), "vec3");
  const pB = instancedArray(new Float32Array(world), "vec3");
  const rawBuffer = instancedArray(raw, "vec4");
  const lowWeights = new Float32Array(vertexCount * 4);
  const highWeights = new Float32Array(vertexCount * 4);
  for (let v = 0; v < vertexCount; v++)
    for (let s = 0; s < 4; s++) {
      lowWeights[v * 4 + s] = weights[v * MAX_PIN_BONES + s] as number;
      highWeights[v * 4 + s] = weights[v * MAX_PIN_BONES + 4 + s] as number;
    }
  const weightsA = instancedArray(lowWeights, "vec4");
  const weightsB = instancedArray(highWeights, "vec4");
  const infoBuffer = instancedArray(info, "vec4");
  const restRefBuffer = instancedArray(restRef, "vec3");
  const neighborBuffer = instancedArray(adjacency.neighbors, "vec2");
  const countBuffer = instancedArray(meta, "uint");
  const originalToUnique = instancedArray(topology.originalToUnique, "uint");

  // Per-step uniforms. Bone rows: slot s, frame f (0 prev, 1 now), row r -> index (s * 2 + f) * 3 + r.
  const boneRows: UniformArrayNode<"vec4"> = uniformArray(
    Array.from({ length: Math.max(1, pinBones.length) * 6 }, () => new Vector4()),
    "vec4",
  );
  // Capsules: c * 4 + [prevA(r), prevB, nowA(r), nowB].
  const capsuleRows: UniformArrayNode<"vec4"> = uniformArray(
    Array.from({ length: Math.max(1, capsules.length) * 4 }, () => new Vector4()),
    "vec4",
  );
  // Carry: [rotation q, pivot, translation, flags(zeroVelocity, reset)], reset frame [q, position].
  const carry: UniformArrayNode<"vec4"> = uniformArray(
    Array.from({ length: 6 }, () => new Vector4()),
    "vec4",
  );
  const alpha = uniform(1);
  const alphaPrev = uniform(0);
  const h = uniform(timeStep / substeps);
  const forces: UniformArrayNode<"vec4"> = uniformArray([new Vector4(), new Vector4()], "vec4");
  const damping = uniform(dampingValue);
  const drag = uniform(dragValue);
  const lift = uniform(liftValue);
  const quarterRho = uniform(fluidDensity / 4);
  const stretch = uniform(stretchK);
  const bend = uniform(bendK);
  const thickness = uniform(thicknessValue);
  const friction = uniform(frictionValue);

  const pinCount = pinBones.length;
  const skin = (vertex: Node<"uint">, at: Node<"float">): Node<"vec3"> => {
    const p = rawBuffer.element(vertex);
    const wa = weightsA.element(vertex);
    const wb = weightsB.element(vertex);
    const sum = vec3(0).toVar();
    for (let s = 0; s < pinCount; s++) {
      const lane = (["x", "y", "z", "w"] as const)[s % 4] as "x" | "y" | "z" | "w";
      const w = (s < 4 ? wa : wb)[lane];
      const row = (r: number) =>
        mix(boneRows.element(s * 6 + r), boneRows.element(s * 6 + 3 + r), at);
      sum.addAssign(vec3(row(0).dot(p), row(1).dot(p), row(2).dot(p)).mul(w));
    }
    return sum;
  };

  const carryPass = Fn(() => {
    const flags = carry.element(3);
    const position = x.element(instanceIndex).toVar();
    const v = velocity.element(instanceIndex).toVar();
    If(flags.y.greaterThan(0.5), () => {
      position.assign(
        rotate(carry.element(4), restRefBuffer.element(instanceIndex)).add(carry.element(5).xyz),
      );
      v.assign(vec3(0));
    }).Else(() => {
      const pivot = carry.element(1).xyz;
      position.assign(
        pivot.add(carry.element(2).xyz).add(rotate(carry.element(0), position.sub(pivot))),
      );
      v.assign(rotate(carry.element(0), v).mul(float(1).sub(flags.x)));
    });
    x.element(instanceIndex).assign(position);
    velocity.element(instanceIndex).assign(v);
  })().compute(vertexCount);
  carryPass.setName("softbody.skinned.carry");

  const predictPass = Fn(() => {
    const m = infoBuffer.element(instanceIndex).x;
    const v = velocity.element(instanceIndex).toVar();
    // Chaos Cloth aerodynamics: every adjacent triangle pushes this particle with its whole force.
    const wind = forces.element(1).xyz;
    const aero = vec3(0).toVar();
    const triangleCount = infoBuffer.element(instanceIndex).w;
    Loop({ type: "uint", start: 0, end: maxTriangles }, ({ i }) => {
      If(float(i).lessThan(triangleCount), () => {
        const t = triangleBuffer.element(instanceIndex.mul(maxTriangles).add(i));
        const a0 = t.x.toUint();
        const a1 = t.y.toUint();
        const a2 = t.z.toUint();
        const x0 = x.element(a0);
        const normal = cross(x.element(a2).sub(x0), x.element(a1).sub(x0)).toVar();
        const doubleArea = length(normal);
        If(doubleArea.greaterThan(1e-12), () => {
          const n = normal.div(doubleArea);
          const surface = velocity
            .element(a0)
            .add(velocity.element(a1))
            .add(velocity.element(a2))
            .div(3);
          const flow = wind.sub(surface);
          const vn = flow.dot(n);
          const v2 = flow.dot(flow);
          // The flow can hit either side of the triangle, so the normal flips with it.
          const force = vn
            .greaterThanEqual(0)
            .select(
              flow.mul(drag.sub(lift).mul(vn)).add(n.mul(lift.mul(v2))),
              flow.mul(lift.sub(drag).mul(vn)).sub(n.mul(lift.mul(v2))),
            );
          aero.addAssign(force.mul(quarterRho.mul(doubleArea)));
        });
      });
    });
    v.addAssign(
      forces
        .element(0)
        .xyz.add(aero.mul(inverseMassBuffer.element(instanceIndex)))
        .mul(h),
    );
    v.mulAssign(exp(damping.mul(h).negate()));
    const p = x.element(instanceIndex).add(v.mul(h)).toVar();
    If(m.greaterThan(0), () => {
      p.assign(mix(p, skin(instanceIndex, alpha), min(m, 1)));
    });
    pA.element(instanceIndex).assign(p);
  })().compute(vertexCount);
  predictPass.setName("softbody.skinned.predict");

  const maxNeighbors = adjacency.maxNeighbors;
  const solve = (from: StorageBufferNode<"vec3">): Node<"vec3"> => {
    const p = from.element(instanceIndex).toVar();
    const wi = infoBuffer.element(instanceIndex).x.greaterThanEqual(1).select(0, 1);
    const delta = vec3(0).toVar();
    const stretchCount = float(0).toVar();
    const count = countBuffer.element(instanceIndex);
    Loop({ type: "uint", start: 0, end: maxNeighbors }, ({ i }) => {
      If(i.lessThan(count), () => {
        const entry = neighborBuffer.element(instanceIndex.mul(maxNeighbors).add(i));
        const n = entry.x.toUint();
        const wj = infoBuffer.element(n).x.greaterThanEqual(1).select(0, 1);
        const d = p.sub(from.element(n));
        const distance = length(d);
        const total = float(wi).add(wj);
        If(distance.greaterThan(1e-7).and(total.greaterThan(0)), () => {
          const k = entry.y.lessThan(0).select(bend, stretch);
          stretchCount.addAssign(entry.y.greaterThan(0).select(1, 0));
          const c = distance.sub(entry.y.abs());
          delta.subAssign(d.mul(c.div(distance)).mul(k).mul(float(wi).div(total)));
        });
      });
    });
    // Jacobi averaging over the stretch constraints with over-relaxation: stable at any valence,
    // and bend pairs (weighted by their own stiffness) do not dilute the stretch solve.
    return p.add(delta.mul(float(RELAXATION).div(max(stretchCount, 1))));
  };

  const iteratePass = Fn(() => {
    pB.element(instanceIndex).assign(solve(pA));
  })().compute(vertexCount);
  iteratePass.setName("softbody.skinned.iterate");
  const iterateBackPass = Fn(() => {
    pA.element(instanceIndex).assign(solve(pB));
  })().compute(vertexCount);
  iterateBackPass.setName("softbody.skinned.iterateBack");

  const finalizePass = Fn(() => {
    const data = infoBuffer.element(instanceIndex);
    const p = solve(pB).toVar();
    const previous = x.element(instanceIndex);
    If(data.y.greaterThanEqual(0).and(data.z.greaterThan(0)).and(data.x.lessThan(1)), () => {
      const anchor = skin(data.y.toUint(), alpha);
      const d = p.sub(anchor);
      const distance = length(d);
      If(distance.greaterThan(data.z), () => {
        p.assign(anchor.add(d.mul(data.z.div(distance))));
      });
    });
    for (let c = 0; c < capsules.length; c++) {
      const a = mix(capsuleRows.element(c * 4), capsuleRows.element(c * 4 + 2), alpha);
      const b = mix(capsuleRows.element(c * 4 + 1), capsuleRows.element(c * 4 + 3), alpha);
      const aBefore = mix(capsuleRows.element(c * 4), capsuleRows.element(c * 4 + 2), alphaPrev);
      const bBefore = mix(
        capsuleRows.element(c * 4 + 1),
        capsuleRows.element(c * 4 + 3),
        alphaPrev,
      );
      const ab = b.xyz.sub(a.xyz);
      const t = p
        .sub(a.xyz)
        .dot(ab)
        .div(max(ab.dot(ab), 1e-10))
        .clamp(0, 1);
      const closest = a.xyz.add(ab.mul(t));
      const normal = p.sub(closest);
      const distance = length(normal);
      const reach = a.w.add(thickness);
      If(distance.lessThan(reach).and(data.x.lessThan(1)), () => {
        const n = distance.greaterThan(1e-7).select(normal.div(distance), vec3(0, 1, 0));
        p.assign(closest.add(n.mul(reach)));
        // Friction against the surface's own motion this substep (PBD Coulomb).
        const surfaceMotion = closest.sub(aBefore.xyz.add(bBefore.xyz.sub(aBefore.xyz).mul(t)));
        const slide = p.sub(previous).sub(surfaceMotion);
        const tangent = slide.sub(n.mul(slide.dot(n)));
        const tangentLength = length(tangent);
        If(tangentLength.greaterThan(1e-7), () => {
          p.subAssign(tangent.mul(min(friction.mul(reach.sub(distance)).div(tangentLength), 1)));
        });
      });
    }
    If(data.x.greaterThanEqual(1), () => {
      p.assign(skin(instanceIndex, alpha));
    });
    velocity.element(instanceIndex).assign(p.sub(previous).div(h));
    x.element(instanceIndex).assign(p);
  })().compute(vertexCount);
  finalizePass.setName("softbody.skinned.finalize");

  // Per-step CPU state.
  const boneMatrix = new Matrix4();
  const carryMatrix = new Matrix4();
  const bind = source.bindMatrix;
  const bindInverse = source.bindMatrixInverse;
  const prevRefPosition = refPosition.clone();
  const prevRefQuaternion = refQuaternion.clone();
  const nowPosition = new Vector3();
  const nowQuaternion = new Quaternion();
  const carryOut = { rotation: new Quaternion(), translation: new Vector3() };
  const a = new Vector3();
  const b = new Vector3();
  let first = true;
  let resetPending = false;
  let lastReset: SoftBodyResetCause | undefined;
  let resets = 0;
  const writeBones = (frame: 0 | 1) => {
    // boneMatrices reads bone.matrixWorld, which the renderer refreshes only at draw time: bring each
    // pin bone up to this step's pose first, or the pins lag the capsules and the carry by one step.
    for (const boneIndex of pinBoneIndices)
      (bones[boneIndex] as Object3D).updateWorldMatrix(true, false);
    source.skeleton.update();
    const table = boneTable(source);
    pinBoneIndices.forEach((boneIndex, slot) => {
      // World = meshWorld · bindInverse · boneWorld · boneInverse · bind, applied to the raw position.
      boneMatrix
        .copy(source.matrixWorld)
        .multiply(bindInverse)
        .multiply(skinScratch.bone.fromArray(table, boneIndex * 16))
        .multiply(bind);
      const e = boneMatrix.elements;
      for (let r = 0; r < 3; r++)
        (boneRows.array[(slot * 2 + frame) * 3 + r] as Vector4).set(
          e[r] as number,
          e[4 + r] as number,
          e[8 + r] as number,
          e[12 + r] as number,
        );
    });
  };
  const writeCapsules = (frame: 0 | 1) => {
    capsules.forEach((capsule, c) => {
      capsule.bone.updateWorldMatrix(true, false);
      a.copy(capsule.start ?? point.set(0, 0, 0)).applyMatrix4(capsule.bone.matrixWorld);
      b.copy(capsule.end).applyMatrix4(capsule.bone.matrixWorld);
      (capsuleRows.array[c * 4 + frame * 2] as Vector4).set(a.x, a.y, a.z, capsule.radius);
      (capsuleRows.array[c * 4 + frame * 2 + 1] as Vector4).set(b.x, b.y, b.z, 0);
    });
  };

  const state: ISkinnedClothState = {
    positions: x,
    originalToUnique,
    nodes: [carryPass, predictPass, iteratePass, iterateBackPass, finalizePass],
    uniqueVertexCount: vertexCount,
    springCount: adjacency.counts.reduce((sum, n) => sum + n, 0) / 2,
    capsules,
    maskSource: chosen,
    teleportDistance,
    substeps,
    gravity,
    wind,
    get lastReset() {
      return lastReset;
    },
    get resets() {
      return resets;
    },
    requestReset() {
      resetPending = true;
    },
    step(dispatch) {
      // The previous frame's rows become this frame's start; the new pose is the end.
      for (let i = 0; i < pinBoneIndices.length; i++)
        for (let r = 0; r < 3; r++)
          (boneRows.array[i * 2 * 3 + r] as Vector4).copy(
            boneRows.array[(i * 2 + 1) * 3 + r] as Vector4,
          );
      for (let c = 0; c < capsules.length; c++) {
        (capsuleRows.array[c * 4] as Vector4).copy(capsuleRows.array[c * 4 + 2] as Vector4);
        (capsuleRows.array[c * 4 + 1] as Vector4).copy(capsuleRows.array[c * 4 + 3] as Vector4);
      }
      source.updateWorldMatrix(true, false);
      reference.updateWorldMatrix(true, false);
      writeBones(1);
      writeCapsules(1);
      reference.matrixWorld.decompose(nowPosition, nowQuaternion, refScale);
      if (first) {
        writeBones(0);
        writeCapsules(0);
        prevRefPosition.copy(nowPosition);
        prevRefQuaternion.copy(nowQuaternion);
        first = false;
      }
      const jump = nowPosition.distanceTo(prevRefPosition);
      const turn = nowQuaternion.angleTo(prevRefQuaternion);
      // A turn past teleportRotation in one step has no physical in-between, and interpolating the
      // pin matrices through it would collapse them toward the bone.
      const teleport = jump > teleportDistance || turn > teleportRotation;
      if (teleport) {
        lastReset = "teleport";
        resets++;
        console.info(
          `TN_SOFTBODY_RESET cause=teleport distance=${jump.toFixed(3)} turn=${turn.toFixed(3)} thresholds=${teleportDistance.toFixed(3)},${teleportRotation.toFixed(3)}`,
        );
        // A teleport has no in-between: the pins and capsules start this step where they end it.
        writeBones(0);
        writeCapsules(0);
      }
      frameCarry(
        prevRefPosition,
        prevRefQuaternion,
        nowPosition,
        nowQuaternion,
        teleport ? 0 : linearShare,
        teleport ? 0 : angularShare,
        carryOut,
      );
      const q = carryOut.rotation;
      // The previous pin and capsule poses ride the same carry as the particles, so the first substep
      // starts the pins where the carried cloth hangs from them. Uncarried, they trail it by the
      // carried share of the frame motion and the constraint snap turns that gap into velocity.
      carryMatrix
        .makeTranslation(prevRefPosition.x, prevRefPosition.y, prevRefPosition.z)
        .multiply(boneMatrix.makeTranslation(carryOut.translation))
        .multiply(boneMatrix.makeRotationFromQuaternion(q))
        .multiply(
          boneMatrix.makeTranslation(-prevRefPosition.x, -prevRefPosition.y, -prevRefPosition.z),
        );
      if (!teleport) {
        for (let i = 0; i < pinBoneIndices.length; i++) {
          const [r0, r1, r2] = [0, 1, 2].map((r) => boneRows.array[i * 6 + r] as Vector4) as [
            Vector4,
            Vector4,
            Vector4,
          ];
          boneMatrix
            .set(r0.x, r0.y, r0.z, r0.w, r1.x, r1.y, r1.z, r1.w, r2.x, r2.y, r2.z, r2.w, 0, 0, 0, 1)
            .premultiply(carryMatrix);
          const e = boneMatrix.elements;
          for (let r = 0; r < 3; r++)
            (boneRows.array[i * 6 + r] as Vector4).set(
              e[r] as number,
              e[4 + r] as number,
              e[8 + r] as number,
              e[12 + r] as number,
            );
        }
        for (let c = 0; c < capsules.length * 4; c += 4)
          for (const row of [c, c + 1]) {
            const v4 = capsuleRows.array[row] as Vector4;
            point.set(v4.x, v4.y, v4.z).applyMatrix4(carryMatrix);
            v4.set(point.x, point.y, point.z, v4.w);
          }
      }
      (carry.array[0] as Vector4).set(q.x, q.y, q.z, q.w);
      (carry.array[1] as Vector4).set(prevRefPosition.x, prevRefPosition.y, prevRefPosition.z, 0);
      (carry.array[2] as Vector4).set(
        carryOut.translation.x,
        carryOut.translation.y,
        carryOut.translation.z,
        0,
      );
      (carry.array[3] as Vector4).set(teleport ? 1 : 0, resetPending ? 1 : 0, 0, 0);
      (carry.array[4] as Vector4).set(
        nowQuaternion.x,
        nowQuaternion.y,
        nowQuaternion.z,
        nowQuaternion.w,
      );
      (carry.array[5] as Vector4).set(nowPosition.x, nowPosition.y, nowPosition.z, 0);
      if (resetPending) {
        lastReset = "manual";
        resets++;
        console.info("TN_SOFTBODY_RESET cause=manual");
        resetPending = false;
      }
      (forces.array[0] as Vector4).set(gravity.x, gravity.y, gravity.z, 0);
      (forces.array[1] as Vector4).set(wind.x, wind.y, wind.z, 0);
      prevRefPosition.copy(nowPosition);
      prevRefQuaternion.copy(nowQuaternion);
      dispatch(carryPass);
      // Each dispatch takes the uniform values set before it, so every substep interpolates its own pose.
      for (let s = 0; s < substeps; s++) {
        alphaPrev.value = s / substeps;
        alpha.value = (s + 1) / substeps;
        dispatch(predictPass);
        dispatch(iteratePass);
        for (let k = 2; k < iterations; k += 2) {
          dispatch(iterateBackPass);
          dispatch(iteratePass);
        }
        dispatch(finalizePass);
      }
    },
  };
  return state;
}
