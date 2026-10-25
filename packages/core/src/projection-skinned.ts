import {
  InstancedBufferGeometry,
  type Material,
  Matrix4,
  Mesh,
  type Object3D,
  Skeleton,
  type SkinnedMesh,
} from "three";
import {
  Fn,
  If,
  attribute,
  cos,
  float,
  instanceIndex,
  mat4,
  normalGeometry,
  normalLocal,
  positionGeometry,
  positionPrevious,
  sin,
  storage,
  tangentGeometry,
  tangentLocal,
  uint,
  vec4,
} from "three/tsl";
import {
  MeshBasicNodeMaterial,
  MeshLambertNodeMaterial,
  MeshMatcapNodeMaterial,
  MeshNormalNodeMaterial,
  MeshPhongNodeMaterial,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
  MeshToonNodeMaterial,
  type NodeMaterial,
  StorageBufferAttribute,
} from "three/webgpu";

import { animationPacketTimeReaders } from "./animation-packet-state.js";
import {
  type IAnimationPosePacket,
  type IAnimationPoseVersion,
  evaluateAnimationPoseFallback,
  evaluateAnimationPosePacket,
  readAnimationPosePacket,
  readAnimationPosePacketTime,
  refreshAnimationPosePacket,
  skeletonUpdateIntact,
} from "./animation-pose-packet.js";
import { SPANS, beginSpan, endSpan } from "./profiling/Spans.js";
import { observeAnimationRates } from "./render-camera-cull.js";

const skeletonUpdate = Skeleton.prototype.update;
interface IRawDisplaySlot {
  current?: IAnimationPosePacket;
  previous?: IAnimationPosePacket;
  retired: boolean;
  writeFrame?: number;
  /** Evaluations that may reuse the captured packet before the next full source re-read. */
  trusted?: number;
  /** What the last full write saw, so a held tick can prove nothing moved with three comparisons. */
  hot?: { skeleton: Skeleton; world: Matrix4; evaluation: number };
  expectedCurrent?: Float32Array;
  expectedPrevious?: Float32Array;
}

/** Evaluations a captured RAW packet is reused before every source field is read again. */
const RAW_REVALIDATE_EVALUATIONS = 256;

const ANIMATION_RATE_STATE_KEY = "threenative.animationRateState";

interface IAnimationRateStateLike {
  readonly evaluated: boolean;
  readonly effectiveRate?: number;
  readonly evaluation: number;
  readonly gpuPoseEnabled?: boolean;
  gpuPose?: boolean;
  syncBones?: () => void;
}

/** Hands the pose back to the CPU: the player refreshes the bones to the current playhead first. */
function releaseGpuPose(state: IAnimationRateStateLike | undefined): void {
  if (state?.gpuPose !== true) return;
  state.gpuPose = false;
  state.syncBones?.();
}

/**
 * The skinned lane of the render projection: every rig that shares a geometry and material is one
 * instanced draw per pass instead of one draw per rig per pass.
 *
 * Three's WebGPU backend submits each `SkinnedMesh` as its own render object — its own bone
 * buffer, bind group and draw — in the main pass and again in every shadow pass. Here each rig is a
 * slot in one storage palette of world-space bone matrices, and one vertex shader indexes it by
 * `instanceIndex`. The CPU work per rig is what stock skinning already does: one `skeleton.update`
 * and one matrix product per bone, written straight into the palette the GPU reads.
 *
 * The world transform is folded into each palette matrix, so the draw's own model matrix is the
 * identity and a rig costs no instance-matrix buffer. That fold is exact for normals only when the
 * rig's world transform has uniform scale and no shear, which is why the mirror keeps any other
 * rig on its own draw. Hidden rigs and freed slots carry zero matrices: every triangle collapses
 * and is discarded before rasterisation, and the slot is recycled without rebuilding the draw.
 *
 * The authored `SkinnedMesh` stays in the game's scene, untouched, so raycasts, bounds and
 * animation keep targeting the game's own object. Only what the renderer is handed changes.
 */

type NodeMaterialClass = new () => NodeMaterial;

/** The same classic-to-node mapping three's `NodeLibrary.fromMaterial` applies at draw time. */
const NODE_CLASSES: ReadonlyMap<string, NodeMaterialClass> = new Map<string, NodeMaterialClass>([
  ["MeshBasicMaterial", MeshBasicNodeMaterial],
  ["MeshLambertMaterial", MeshLambertNodeMaterial],
  ["MeshMatcapMaterial", MeshMatcapNodeMaterial],
  ["MeshNormalMaterial", MeshNormalNodeMaterial],
  ["MeshPhongMaterial", MeshPhongNodeMaterial],
  ["MeshPhysicalMaterial", MeshPhysicalNodeMaterial],
  ["MeshStandardMaterial", MeshStandardNodeMaterial],
  ["MeshToonMaterial", MeshToonNodeMaterial],
]);

/**
 * Properties never copied from the game's material onto the draw's. `positionNode` is the lane's
 * own deformation; `_listeners` would hand the renderer's dispose hook for the game's material to
 * the draw's; `id`/`uuid` keep the draw a distinct material to every cache keyed on them; and
 * `version` is followed rather than copied, so the twin recompiles exactly when the game's does.
 */
const UNSYNCED = new Set(["positionNode", "_listeners", "id", "uuid", "version"]);

function nodeClassOf(material: Material): NodeMaterialClass | undefined {
  if (Reflect.get(material, "isNodeMaterial") === true) {
    return material.constructor as NodeMaterialClass;
  }
  return NODE_CLASSES.get(material.type);
}

/**
 * Why a material cannot draw through the lane's shader, or `undefined` when it can. A material that
 * already moves its own vertices would be overwritten by the palette deformation, so it keeps
 * three's own skinning path.
 */
export function skinnedMaterialBlocked(material: Material): boolean {
  return (
    nodeClassOf(material) === undefined ||
    Reflect.get(material, "positionNode") != null ||
    Reflect.get(material, "castShadowPositionNode") != null ||
    Reflect.get(material, "displacementMap") != null
  );
}

/**
 * Whether a per-instance colour may stand in for this material's base colour.
 *
 * Closed on purpose, and closed on the same table the skinned lane converts through: only a classic
 * material class three is known to turn into a node material whose diffuse colour *is*
 * `material.color` qualifies. A node material is refused outright — a custom graph decides for
 * itself what a colour means, and a shader three has never heard of cannot be asked what it would
 * do with a multiply. A material class this table does not name is refused for the same reason.
 */
export function tintableMaterial(material: Material): boolean {
  return Reflect.get(material, "isNodeMaterial") !== true && NODE_CLASSES.has(material.type);
}

/**
 * True when `elements` is a rotation times a positive uniform scale plus a translation — the only
 * world transform whose fold into the bone palette leaves normals exactly where stock skinning's
 * normal matrix puts them.
 */
export function isSimilarityTransform(elements: ArrayLike<number>): boolean {
  const x0 = elements[0] as number;
  const x1 = elements[1] as number;
  const x2 = elements[2] as number;
  const y0 = elements[4] as number;
  const y1 = elements[5] as number;
  const y2 = elements[6] as number;
  const z0 = elements[8] as number;
  const z1 = elements[9] as number;
  const z2 = elements[10] as number;
  const xx = x0 * x0 + x1 * x1 + x2 * x2;
  const yy = y0 * y0 + y1 * y1 + y2 * y2;
  const zz = z0 * z0 + z1 * z1 + z2 * z2;
  if (!(xx > 1e-16)) return false;
  const tolerance = xx * 1e-5;
  if (Math.abs(yy - xx) > tolerance || Math.abs(zz - xx) > tolerance) return false;
  if (Math.abs(x0 * y0 + x1 * y1 + x2 * y2) > tolerance) return false;
  if (Math.abs(x0 * z0 + x1 * z1 + x2 * z2) > tolerance) return false;
  if (Math.abs(y0 * z0 + y1 * z1 + y2 * z2) > tolerance) return false;
  // Positive determinant: a mirrored rig would draw inside-out under the source's face culling.
  const determinant =
    x0 * (y1 * z2 - y2 * z1) - y0 * (x1 * z2 - x2 * z1) + z0 * (x1 * y2 - x2 * y1);
  return determinant > 0 && elements[3] === 0 && elements[7] === 0 && elements[11] === 0;
}

/** out[o..o+16] = a[ao..ao+16] × b[bo..bo+16], column-major as three stores them. */
function multiply(
  a: ArrayLike<number>,
  ao: number,
  b: ArrayLike<number>,
  bo: number,
  out: Float32Array | Float64Array,
  o: number,
): void {
  const a00 = a[ao] as number;
  const a10 = a[ao + 1] as number;
  const a20 = a[ao + 2] as number;
  const a01 = a[ao + 4] as number;
  const a11 = a[ao + 5] as number;
  const a21 = a[ao + 6] as number;
  const a02 = a[ao + 8] as number;
  const a12 = a[ao + 9] as number;
  const a22 = a[ao + 10] as number;
  const a03 = a[ao + 12] as number;
  const a13 = a[ao + 13] as number;
  const a23 = a[ao + 14] as number;
  // Affine only: the bottom row of every matrix here is (0, 0, 0, 1), which three guarantees for
  // bone and world matrices built from position/quaternion/scale.
  for (let column = 0; column < 4; column += 1) {
    const b0 = b[bo + column * 4] as number;
    const b1 = b[bo + column * 4 + 1] as number;
    const b2 = b[bo + column * 4 + 2] as number;
    const b3 = b[bo + column * 4 + 3] as number;
    const at = o + column * 4;
    out[at] = a00 * b0 + a01 * b1 + a02 * b2 + a03 * b3;
    out[at + 1] = a10 * b0 + a11 * b1 + a12 * b2 + a13 * b3;
    out[at + 2] = a20 * b0 + a21 * b1 + a22 * b2 + a23 * b3;
    out[at + 3] = b3;
  }
}

function isIdentity(elements: ArrayLike<number>): boolean {
  for (let index = 0; index < 16; index += 1) {
    if (elements[index] !== (index % 5 === 0 ? 1 : 0)) return false;
  }
  return true;
}

export interface ISkinnedBatchOptions {
  readonly first: SkinnedMesh;
  readonly capacity: number;
  readonly velocity: boolean;
}

/** One skinned draw: a palette of `capacity × bones` world-space matrices and the shader reading it. */
export class SkinnedBatch {
  readonly mesh: Mesh<InstancedBufferGeometry, NodeMaterial>;
  /** The game's material; the draw's is a node twin re-synced from it every frame. */
  readonly sourceMaterial: Material;
  readonly bones: number;
  readonly capacity: number;
  readonly instances = new Map<Object3D, number>();
  readonly #slotRigs = new Map<number, Object3D>();
  readonly free: number[] = [];
  used = 0;
  readonly #current: Float32Array;
  readonly #previous: Float32Array | undefined;
  readonly #currentAttribute: StorageBufferAttribute;
  readonly #previousAttribute: StorageBufferAttribute | undefined;
  /** Slots whose history must equal their first pose rather than whatever a previous owner left. */
  readonly #fresh: number[] = [];
  readonly #bindScratch = new Float64Array(16);
  readonly #updated = new WeakMap<Skeleton, number>();
  // A RAW refresh substitutes for stock's first update. Materialize its CPU basis only
  // if a later same-frame stock write actually needs the shared skeleton cache.
  readonly #rawUpdates = new WeakMap<Skeleton, { frame: number; version: IAnimationPoseVersion }>();
  readonly #writtenEvaluations = new WeakMap<Object3D, number>();
  readonly #writtenWorldMatrices = new WeakMap<Object3D, Matrix4>();
  #frame = 0;
  #dirty = false;
  #sourceVersion: number;
  readonly #rawSlots = new Map<number, IRawDisplaySlot>();
  readonly #ownedSkeletons = new Map<number, Skeleton>();
  readonly #skeletonOwners = new Map<Skeleton, Set<number>>();
  #observed = false;
  #reconciling = false;
  #rawFrame = -1;
  #rawDirtyFrame = -1;
  #rawMeta = new Float32Array(0);
  #rawData = new Float32Array(0);
  #rawPrevious = new Float32Array(0);
  #rawRoots = new Float32Array(0);
  #rawPreviousRoots = new Float32Array(0);
  readonly #rawAttributes: StorageBufferAttribute[] = [];

  constructor(options: ISkinnedBatchOptions) {
    const { first, capacity, velocity } = options;
    const NodeClass = nodeClassOf(first.material as Material);
    if (NodeClass === undefined) throw new Error("SkinnedBatch requires a convertible material.");
    this.sourceMaterial = first.material as Material;
    this.#sourceVersion = this.sourceMaterial.version;
    this.bones = first.skeleton.bones.length;
    this.capacity = capacity;
    const floats = capacity * this.bones * 16;
    this.#current = new Float32Array(floats);
    this.#currentAttribute = new StorageBufferAttribute(this.#current, 16);
    if (velocity) {
      this.#previous = new Float32Array(floats);
      this.#previousAttribute = new StorageBufferAttribute(this.#previous, 16);
    }

    // The game's vertex buffers by reference, never copied: the draw uploads nothing the source
    // geometry has not already uploaded, and a game streaming into its attributes is followed.
    const source = first.geometry;
    const geometry = new InstancedBufferGeometry();
    for (const name in source.attributes) {
      if (Object.hasOwn(source.attributes, name))
        geometry.setAttribute(name, source.attributes[name] as never);
    }
    geometry.setIndex(source.index);
    for (const group of source.groups)
      geometry.addGroup(group.start, group.count, group.materialIndex);
    geometry.instanceCount = 0;

    const count = capacity * this.bones;
    const current = storage(this.#currentAttribute, "mat4", count).toReadOnly();
    const previous =
      this.#previousAttribute === undefined
        ? undefined
        : storage(this.#previousAttribute, "mat4", count).toReadOnly();
    const boneIndex = attribute<"uvec4">("skinIndex", "uvec4");
    const weight = attribute<"vec4">("skinWeight", "vec4");
    const base = instanceIndex.mul(uint(this.bones));
    const blend = (palette: typeof current) =>
      palette
        .element(base.add(boneIndex.x))
        .mul(weight.x)
        .add(palette.element(base.add(boneIndex.y)).mul(weight.y))
        .add(palette.element(base.add(boneIndex.z)).mul(weight.z))
        .add(palette.element(base.add(boneIndex.w)).mul(weight.w));
    // The admitted packet layout is fixed; every other rig retains the stock node.
    let rawMatrix: ((previousFrame: boolean) => ReturnType<typeof blend>) | undefined;
    let rawMeta: ReturnType<typeof storage<"vec4">> | undefined;
    if (this.bones === 12) {
      this.#rawMeta = new Float32Array(capacity * 4);
      this.#rawData = new Float32Array(capacity * 12 * 48);
      this.#rawPrevious = new Float32Array(this.#rawData.length);
      this.#rawRoots = new Float32Array(capacity * 32);
      this.#rawPreviousRoots = new Float32Array(this.#rawRoots.length);
      const input = (array: Float32Array, size: number) => {
        const a = new StorageBufferAttribute(array, size);
        this.#rawAttributes.push(a);
        return a;
      };
      const metadata = storage(input(this.#rawMeta, 4), "vec4", capacity).toReadOnly();
      rawMeta = metadata;
      const raw = storage(input(this.#rawData, 4), "vec4", capacity * 144).toReadOnly();
      const oldRaw = storage(input(this.#rawPrevious, 4), "vec4", capacity * 144).toReadOnly();
      const roots = storage(input(this.#rawRoots, 16), "mat4", capacity * 2).toReadOnly();
      const oldRoots = storage(
        input(this.#rawPreviousRoots, 16),
        "mat4",
        capacity * 2,
      ).toReadOnly();
      rawMatrix = (old) => {
        const data = old ? oldRaw : raw;
        const root = old ? oldRoots : roots;
        const time = old ? metadata.element(instanceIndex).w : metadata.element(instanceIndex).y;
        const start = instanceIndex.mul(uint(144));
        let world: ReturnType<typeof blend> = mat4();
        let blended: ReturnType<typeof blend> = mat4();
        for (let b = 0; b < 12; b++) {
          const offset = start.add(uint(b * 12));
          const at = (n: number) => data.element(offset.add(uint(n)));
          const position = at(8);
          const scale = at(9);
          const times = at(10);
          const values = at(11);
          const second = time.greaterThan(times.y);
          const t0 = second.select(times.y, times.x);
          const t1 = second.select(times.z, times.y);
          const v0 = second.select(values.y, values.x);
          const v1 = second.select(values.z, values.y);
          const z = v0.add(v1.sub(v0).mul(time.sub(t0).div(t1.sub(t0))));
          const c = cos(z);
          const sn = sin(z);
          const local =
            b === 0
              ? mat4(at(0), at(1), at(2), at(3))
              : mat4(
                  c.mul(scale.x),
                  sn.mul(scale.x),
                  0,
                  0,
                  sn.negate().mul(scale.y),
                  c.mul(scale.y),
                  0,
                  0,
                  0,
                  0,
                  scale.z,
                  0,
                  position.x,
                  position.y,
                  position.z,
                  1,
                );
          world = (
            b === 0 ? root.element(instanceIndex.mul(uint(2))).mul(local) : world.mul(local)
          ).toVar();
          const palette = world.mul(mat4(at(4), at(5), at(6), at(7)));
          const w = boneIndex.x
            .equal(uint(b))
            .select(weight.x, float(0))
            .add(boneIndex.y.equal(uint(b)).select(weight.y, float(0)))
            .add(boneIndex.z.equal(uint(b)).select(weight.z, float(0)))
            .add(boneIndex.w.equal(uint(b)).select(weight.w, float(0)));
          blended = b === 0 ? palette.mul(w) : blended.add(palette.mul(w));
        }
        return root
          .element(instanceIndex.mul(uint(2)))
          .mul(root.element(instanceIndex.mul(uint(2)).add(uint(1))))
          .mul(blended);
      };
    }
    const hasTangent = source.getAttribute("tangent") !== undefined;
    const material = new NodeClass();
    this.#syncMaterial(material);
    material.positionNode = Fn(() => {
      const matrix = mat4().toVar();
      if (rawMatrix && rawMeta) {
        const sample = rawMatrix;
        If(rawMeta.element(instanceIndex).x.greaterThan(0), () => {
          matrix.assign(sample(false));
        }).Else(() => {
          matrix.assign(blend(current));
        });
      } else matrix.assign(blend(current));
      normalLocal.assign(matrix.mul(vec4(normalGeometry, 0)).xyz);
      if (hasTangent) tangentLocal.assign(matrix.mul(vec4(tangentGeometry.xyz, 0)).xyz);
      if (previous !== undefined) {
        const oldMatrix = mat4().toVar();
        if (rawMatrix && rawMeta) {
          const sample = rawMatrix;
          If(rawMeta.element(instanceIndex).z.greaterThan(0), () => {
            oldMatrix.assign(sample(true));
          }).Else(() => {
            oldMatrix.assign(blend(previous));
          });
        } else oldMatrix.assign(blend(previous));
        positionPrevious.assign(oldMatrix.mul(vec4(positionGeometry, 1)).xyz);
      }
      return matrix.mul(vec4(positionGeometry, 1)).xyz;
    })();
    material.needsUpdate = true;

    this.mesh = new Mesh(geometry, material);
    this.mesh.matrixAutoUpdate = false;
    observeAnimationRates(this.mesh, this.instances);
    this.mesh.userData["threenative.animationPosePackets"] = () => ({
      capacity: this.capacity,
      bones: this.bones,
      instanceCount: this.mesh.geometry.instanceCount,
      previousEnabled: this.#previous !== undefined,
      slots: [...this.instances].map(([rig, slot]) => {
        const r = this.#rawSlots.get(slot);
        const m = slot * 4;
        return {
          slot,
          currentRaw: this.#rawMeta[m] === 1,
          previousRaw: this.#rawMeta[m + 2] === 1,
          currentTime: this.#rawMeta[m + 1] ?? 0,
          previousTime: this.#rawMeta[m + 3] ?? 0,
          retired: r?.retired === true,
          ...(this.#writtenEvaluations.has(rig)
            ? { currentEvaluation: this.#writtenEvaluations.get(rig) }
            : {}),
          ...(r?.previous ? { previousEvaluation: r.previous.version.evaluation } : {}),
        };
      }),
      storage: { meta: Array.from(this.#rawMeta) },
    });
    // The palette spans every rig; only the per-rig sources have meaningful bounds.
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = first.castShadow;
    this.mesh.receiveShadow = first.receiveShadow;
    this.mesh.layers.mask = first.layers.mask;
  }

  /**
   * Starts one reconcile: the frame's history becomes last frame's pose. Called once per frame
   * before any rig writes, so every pass of the frame reads the same pair.
   */
  begin(): void {
    this.#reconciling = false;
    this.#frame += 1;
    this.#syncMaterial(this.mesh.material);
    if (this.sourceMaterial.version !== this.#sourceVersion) {
      this.#sourceVersion = this.sourceMaterial.version;
      this.mesh.material.needsUpdate = true;
    }
    this.#checkObservedEdits();
    if (this.#previous !== undefined) {
      this.#previous.set(this.#current);
      this.#dirty = true;
      if (this.#observed)
        for (const [slot, display] of this.#rawSlots)
          display.expectedPrevious = this.#previous.slice(
            slot * this.bones * 16,
            (slot + 1) * this.bones * 16,
          );
    }
    this.#reconciling = true;
  }

  /** Copies the game's current material values onto the draw's twin, as three's own conversion does. */
  #syncMaterial(target: NodeMaterial): void {
    const from = this.sourceMaterial;
    for (const key in from) {
      if (!UNSYNCED.has(key)) Reflect.set(target, key, Reflect.get(from, key));
    }
  }

  /** Claims a slot for `rig`, or returns `undefined` when the batch is full. */
  claim(rig: Object3D): number | undefined {
    let slot = this.instances.get(rig);
    if (slot !== undefined) return slot;
    slot = this.free.pop();
    if (slot === undefined) {
      if (this.used >= this.capacity) return undefined;
      slot = this.used;
      this.used += 1;
    }
    this.instances.set(rig, slot);
    this.#slotRigs.set(slot, rig);
    this.#fresh.push(slot);
    this.#trackSkeleton(slot, rig);
    return slot;
  }

  /** Returns a rig's slot to the free list with a collapsed pose, so it draws nothing. */
  release(rig: Object3D): void {
    const slot = this.instances.get(rig);
    if (slot === undefined) return;
    this.#untrackSkeleton(slot);
    releaseGpuPose(animationRateStateOf(rig));
    this.instances.delete(rig);
    this.#slotRigs.delete(slot);
    this.#writtenEvaluations.delete(rig);
    this.#writtenWorldMatrices.delete(rig);
    this.hide(slot);
    this.#rawSlots.delete(slot);
    this.free.push(slot);
  }

  /** This frame's world-space bone matrices, `capacity × bones` of them in slot order. */
  get palette(): Float32Array {
    this.#observe();
    return this.#current;
  }

  /** Last frame's palette, present only while a temporal stage asks for per-object history. */
  get history(): Float32Array | undefined {
    if (this.#previous !== undefined) this.#observe();
    return this.#previous;
  }

  /** Marks a slot whose history must restart from its next pose. */
  restart(slot: number): void {
    this.#invalidate(slot);
    this.#fresh.push(slot);
  }

  /** Collapses one slot for this frame; a hidden rig keeps its slot. */
  hide(slot: number): void {
    this.#invalidate(slot);
    const stride = this.bones * 16;
    this.#current.fill(0, slot * stride, (slot + 1) * stride);
    this.#previous?.fill(0, slot * stride, (slot + 1) * stride);
    const display = this.#rawSlots.get(slot);
    if (display) {
      display.current = undefined;
      display.previous = undefined;
    }
    if (this.#rawMeta.length) {
      this.#rawMeta.fill(0, slot * 4, slot * 4 + 4);
      this.#markRawDirty();
    }
    this.#dirty = true;
  }

  #invalidate(slot: number): void {
    const rig = this.#slotRigs.get(slot);
    if (rig === undefined) return;
    this.#writtenEvaluations.delete(rig);
    this.#writtenWorldMatrices.delete(rig);
    const display = this.#rawSlots.get(slot);
    if (display) display.hot = undefined;
  }

  /**
   * A held tick of a trusted RAW rig: the pose, the skeleton and the world matrix are the ones the
   * last full write saw, so the only thing that moved is the playhead. Anything else, an observed
   * batch included, takes the full path.
   */
  #writeHeld(slot: number, rig: SkinnedMesh, state: IAnimationRateStateLike | undefined): boolean {
    const display = this.#rawSlots.get(slot);
    const hot = display?.hot;
    if (
      display === undefined ||
      hot === undefined ||
      display.current === undefined ||
      display.retired ||
      this.#observed ||
      (display.trusted ?? 0) <= 0
    )
      return false;
    if (
      state === undefined ||
      state.evaluated ||
      state.evaluation !== hot.evaluation ||
      (state.effectiveRate ?? 1) <= 1 ||
      rig.skeleton !== hot.skeleton ||
      !hot.world.equals(rig.matrixWorld) ||
      !skeletonUpdateIntact(hot.skeleton) ||
      (this.#skeletonOwners.get(hot.skeleton)?.size ?? 0) > 1 ||
      this.#fresh.includes(slot)
    )
      return false;
    const time = animationPacketTimeReaders.get(rig)?.();
    if (time === undefined) return false;
    this.#prepareRawFrame();
    display.writeFrame = this.#frame;
    this.#rawMeta[slot * 4] = 1;
    this.#rawMeta[slot * 4 + 1] = time;
    this.#markRawDirty();
    return true;
  }

  /** A packet at the playhead the meta row holds: held ticks move the meta, not the packet. */
  #timed(packet: IAnimationPosePacket, slot: number, previous: boolean): IAnimationPosePacket {
    const time = this.#rawMeta[slot * 4 + (previous ? 3 : 1)] as number;
    return time === packet.time ? packet : { ...packet, time };
  }

  /**
   * Writes one rig's world-space bone palette. Equals stock skinning's
   * `matrixWorld · bindMatrixInverse · boneMatrix · bindMatrix` per bone; in the default attached
   * bind mode `matrixWorld · bindMatrixInverse` is the identity and is skipped.
   */
  write(slot: number, rig: SkinnedMesh): void {
    beginSpan(SPANS.skinnedWrite);
    try {
      const state = animationRateStateOf(rig);
      // Attachments follow CPU bones, so their character must keep the same stock pose.
      const attached =
        (state?.effectiveRate ?? 1) > 1 &&
        this.bones === 12 &&
        rig.skeleton.bones.some((bone, index, bones) =>
          bone.children.some((child) => child !== bones[index + 1]),
        );
      if (!attached && this.#writeHeld(slot, rig, state)) return;
      this.#checkObservedEdits(slot);
      // Named rate1 and ordinary stock owners never pay the capture/query path.
      if (this.#rawMeta.length && ((state?.effectiveRate ?? 1) > 1 || this.#rawSlots.has(slot))) {
        this.#prepareRawFrame();
        this.#trackSkeleton(slot, rig, true);
        let display = this.#rawSlots.get(slot);
        if (!display) {
          display = { retired: false };
          this.#rawSlots.set(slot, display);
        }
        const held =
          state !== undefined &&
          !state.evaluated &&
          this.#writtenEvaluations.get(rig) === state.evaluation &&
          this.#writtenWorldMatrices.get(rig)?.equals(rig.matrixWorld);
        const skeleton: unknown = rig.skeleton;
        const update =
          skeleton instanceof Skeleton
            ? skeletonUpdateIntact(skeleton)
              ? skeletonUpdate
              : this.#method(skeleton, "update")
            : undefined;
        const shared =
          skeleton instanceof Skeleton && (this.#skeletonOwners.get(skeleton)?.size ?? 0) > 1;
        // First eligibility on a held tick must wait for a genuine stock refresh.
        if (held && !display.current && !display.retired && update === skeletonUpdate && !shared) {
          this.#writeStock(slot, rig, state);
          return;
        }
        const repeatedRefresh = !held && display.writeFrame === this.#frame;
        const packet =
          state?.gpuPoseEnabled === true &&
          !attached &&
          !repeatedRefresh &&
          !display.retired &&
          (state?.effectiveRate ?? 1) > 1 &&
          update === skeletonUpdate &&
          !shared
            ? display.current && held
              ? readAnimationPosePacketTime(rig, display.current.version)
              : display.current &&
                  (display.trusted ?? 0) > 0 &&
                  this.#writtenWorldMatrices.get(rig)?.equals(rig.matrixWorld) === true
                ? refreshAnimationPosePacket(rig, display.current.version)
                : readAnimationPosePacket(rig)
            : undefined;
        if (packet && state && !held) {
          const reused = display.current?.version.keys === packet.version.keys;
          display.trusted = reused ? (display.trusted ?? 0) - 1 : RAW_REVALIDATE_EVALUATIONS;
        }
        if (packet && state) {
          state.gpuPose = true;
          display.writeFrame = this.#frame;
          if (!held && skeleton instanceof Skeleton)
            this.#rawUpdates.set(skeleton, { frame: this.#frame, version: packet.version });
          const changed = display.current?.version.keys !== packet.version.keys;
          display.current = packet;
          this.#packRaw(slot, packet, false, changed);
          if (this.#fresh.includes(slot)) this.#packRaw(slot, packet, true);
          this.#writtenEvaluations.set(rig, state.evaluation);
          const world = this.#writtenWorldMatrices.get(rig) ?? new Matrix4();
          world.copy(rig.matrixWorld);
          this.#writtenWorldMatrices.set(rig, world);
          if (skeleton instanceof Skeleton) {
            const hot = display.hot;
            if (hot) {
              hot.skeleton = skeleton;
              hot.world = world;
              hot.evaluation = state.evaluation;
            } else display.hot = { skeleton, world, evaluation: state.evaluation };
          }
          this.#syncObserved(slot, display);
          return;
        }
        // The next player update sees the flag drop and refreshes the bones; this tick keeps stock's
        // held semantics, which an observed palette edit relies on.
        if (state) state.gpuPose = false;
        if (held && display.current)
          this.#current.set(
            evaluateAnimationPoseFallback(display.current.version),
            slot * this.bones * 16,
          );
        display.current = undefined;
        display.retired ||= (state?.effectiveRate ?? 1) > 1 || update !== skeletonUpdate || shared;
        this.#rawMeta[slot * 4] = 0;
        this.#rawMeta[slot * 4 + 1] = 0;
        this.#markRawDirty();
        this.#dirty = true;
      }
      this.#writeStock(slot, rig, state);
      const display = this.#rawSlots.get(slot);
      if (display) this.#syncObserved(slot, display);
    } finally {
      endSpan(SPANS.skinnedWrite);
    }
  }

  #method(object: object, key: string): unknown {
    for (let owner: object | null = object; owner !== null; owner = Object.getPrototypeOf(owner)) {
      const d = Object.getOwnPropertyDescriptor(owner, key);
      if (d) return Object.hasOwn(d, "value") ? d.value : undefined;
    }
    return undefined;
  }

  #prepareRawFrame(): void {
    if (this.#rawFrame === this.#frame) return;
    this.#rawFrame = this.#frame;
    for (const [slot, display] of this.#rawSlots) {
      if (display.current && display.previous?.version.keys !== display.current.version.keys) {
        this.#rawPrevious.set(this.#rawData.subarray(slot * 576, (slot + 1) * 576), slot * 576);
        this.#rawPreviousRoots.set(this.#rawRoots.subarray(slot * 32, (slot + 1) * 32), slot * 32);
      }
      display.previous = display.current;
      this.#rawMeta[slot * 4 + 2] = this.#rawMeta[slot * 4] as number;
      this.#rawMeta[slot * 4 + 3] = this.#rawMeta[slot * 4 + 1] as number;
    }
    this.#markRawDirty();
  }

  #markRawDirty(force = false): void {
    if (!force && this.#rawDirtyFrame === this.#frame) return;
    this.#rawDirtyFrame = this.#frame;
    for (const attribute of this.#rawAttributes) attribute.needsUpdate = true;
  }

  #packRaw(slot: number, packet: IAnimationPosePacket, old: boolean, changed = true): void {
    const data = old ? this.#rawPrevious : this.#rawData;
    const roots = old ? this.#rawPreviousRoots : this.#rawRoots;
    const meta = slot * 4 + (old ? 2 : 0);
    const v = packet.version;
    this.#rawMeta[meta] = 1;
    this.#rawMeta[meta + 1] = packet.time;
    if (changed) {
      roots.set(v.rootWorld, slot * 32);
      roots.set(v.bindInverse, slot * 32 + 16);
      for (let b = 0; b < 12; b++) {
        const at = (slot * 12 + b) * 48;
        const rest = v.rest[b];
        const key = v.keys[b];
        const inverse = v.bindInverses[b];
        if (!rest || !inverse) throw new Error("incomplete owned raw pose");
        data.set(rest.local, at);
        data.set(inverse, at + 16);
        data.set([...rest.position, b === 0 ? 0 : 1, ...rest.scale, 0], at + 32);
        data.set(key ? [...key.times, 0, ...key.values, 0] : [0, 1, 2, 0, 0, 0, 0, 0], at + 40);
      }
    }
    this.#markRawDirty();
  }

  #checkObservedEdits(only?: number): void {
    if (!this.#observed) return;
    for (const [slot, display] of this.#rawSlots) {
      if (only !== undefined && slot !== only) continue;
      if (this.#rawMeta[slot * 4] !== 1 && this.#rawMeta[slot * 4 + 2] !== 1) continue;
      const changed = (actual: Float32Array | undefined, expected: Float32Array | undefined) =>
        expected !== undefined &&
        actual !== undefined &&
        expected.some((v, i) => !Object.is(v, actual[slot * this.bones * 16 + i]));
      if (
        !changed(this.#current, display.expectedCurrent) &&
        !changed(this.#previous, display.expectedPrevious)
      )
        continue;
      display.current = undefined;
      display.previous = undefined;
      display.retired = true;
      display.expectedCurrent = undefined;
      display.expectedPrevious = undefined;
      this.#rawMeta.fill(0, slot * 4, slot * 4 + 4);
      this.#markRawDirty(true);
      this.#currentAttribute.needsUpdate = true;
      if (this.#previousAttribute) this.#previousAttribute.needsUpdate = true;
      this.#dirty = true;
    }
  }

  #syncObserved(slot: number, display: IRawDisplaySlot): void {
    if (!this.#observed) return;
    const offset = slot * this.bones * 16;
    if (display.current) {
      const matrix = evaluateAnimationPosePacket(this.#timed(display.current, slot, false));
      this.#current.set(matrix, offset);
      display.expectedCurrent = matrix;
    } else display.expectedCurrent = this.#current.slice(offset, offset + this.bones * 16);
    display.expectedPrevious = this.#previous?.slice(offset, offset + this.bones * 16);
    this.#dirty = true;
  }

  #observe(): void {
    this.#checkObservedEdits();
    if (this.#observed) return;
    this.#prepareRawFrame();
    for (const [slot, display] of this.#rawSlots) {
      const offset = slot * this.bones * 16;
      if (display.current)
        this.#current.set(
          evaluateAnimationPosePacket(this.#timed(display.current, slot, false)),
          offset,
        );
      const previous =
        display.previous ??
        (!this.#fresh.includes(slot) && this.#rawMeta[slot * 4 + 2] === 1
          ? display.current
          : undefined);
      if (previous && this.#previous)
        this.#previous.set(
          evaluateAnimationPosePacket(this.#timed(previous, slot, previous === display.previous)),
          offset,
        );
      display.expectedCurrent = this.#current.slice(offset, offset + this.bones * 16);
      display.expectedPrevious = this.#previous?.slice(offset, offset + this.bones * 16);
    }
    this.#observed = true;
    this.#currentAttribute.needsUpdate = true;
    if (this.#previousAttribute) this.#previousAttribute.needsUpdate = true;
    this.#dirty = true;
  }

  #untrackSkeleton(slot: number): void {
    const skeleton = this.#ownedSkeletons.get(slot);
    if (!skeleton) return;
    const owners = this.#skeletonOwners.get(skeleton);
    owners?.delete(slot);
    if (!owners?.size) this.#skeletonOwners.delete(skeleton);
    this.#ownedSkeletons.delete(slot);
  }

  #trackSkeleton(slot: number, rig: Object3D, charged = false): void {
    const skeleton = (rig as SkinnedMesh).skeleton as unknown;
    if (this.#ownedSkeletons.get(slot) === skeleton && !charged) return;
    if (this.#ownedSkeletons.get(slot) !== skeleton) this.#untrackSkeleton(slot);
    if (!(skeleton instanceof Skeleton)) return;
    this.#ownedSkeletons.set(slot, skeleton);
    let owners = this.#skeletonOwners.get(skeleton);
    if (!owners) {
      owners = new Set();
      this.#skeletonOwners.set(skeleton, owners);
    }
    owners.add(slot);
    if (owners.size < 2 || ![...owners].some((owner) => this.#rawSlots.get(owner)?.current)) return;
    // Between reconciles, retain the last published RAW pose until begin advances its history.
    if (!charged && !this.#reconciling) return;
    // Late sharing must also revoke an already-written RAW owner before this draw.
    if (!charged) beginSpan(SPANS.skinnedWrite);
    try {
      this.#prepareRawFrame();
      for (const owner of owners) {
        const display = this.#rawSlots.get(owner);
        if (!display) continue;
        if (display.current)
          this.#current.set(
            evaluateAnimationPoseFallback(display.current.version),
            owner * this.bones * 16,
          );
        display.current = undefined;
        display.retired = true;
        this.#syncObserved(owner, display);
        this.#rawMeta[owner * 4] = 0;
        this.#rawMeta[owner * 4 + 1] = 0;
        this.#dirty = true;
      }
      this.#markRawDirty();
    } finally {
      if (!charged) endSpan(SPANS.skinnedWrite);
    }
  }

  #writeStock(slot: number, rig: SkinnedMesh, state: IAnimationRateStateLike | undefined): void {
    const writtenWorld = this.#writtenWorldMatrices.get(rig);
    if (
      state !== undefined &&
      !state.evaluated &&
      this.#writtenEvaluations.get(rig) === state.evaluation &&
      writtenWorld?.equals(rig.matrixWorld)
    )
      return;
    const skeleton = rig.skeleton;
    if (this.#updated.get(skeleton) !== this.#frame) {
      const captured = this.#rawUpdates.get(skeleton);
      if (captured?.frame === this.#frame) {
        (skeleton.boneMatrices as Float32Array).set(
          evaluateAnimationPoseFallback(captured.version),
        );
        if (skeleton.boneTexture !== null) skeleton.boneTexture.needsUpdate = true;
      } else skeleton.update();
      this.#updated.set(skeleton, this.#frame);
    }
    const bones = skeleton.boneMatrices as Float32Array;
    const bind = rig.bindMatrix.elements;
    const bindIsIdentity = isIdentity(bind);
    const detached = rig.bindMode !== "attached";
    const prefix = this.#bindScratch;
    if (detached)
      multiply(rig.matrixWorld.elements, 0, rig.bindMatrixInverse.elements, 0, prefix, 0);
    const out = this.#current;
    const offset = slot * this.bones * 16;
    // The common case is one contiguous copy: `skeleton.update` has already written this rig's
    // bone matrices in palette order, and an identity bind matrix leaves them unchanged.
    if (bindIsIdentity) out.set(bones, offset);
    else {
      for (let bone = 0; bone < this.bones; bone += 1) {
        multiply(bones, bone * 16, bind, 0, out, offset + bone * 16);
      }
    }
    if (detached) {
      for (let bone = 0; bone < this.bones; bone += 1) {
        const at = offset + bone * 16;
        // In place is safe: `multiply` reads each right-hand column before writing it.
        multiply(prefix, 0, out, at, out, at);
      }
    }
    this.#dirty = true;
    if (state !== undefined) {
      this.#writtenEvaluations.set(rig, state.evaluation);
      const nextWorld = writtenWorld ?? new Matrix4();
      nextWorld.copy(rig.matrixWorld);
      this.#writtenWorldMatrices.set(rig, nextWorld);
    }
  }

  /** Ends one reconcile: brand-new slots get history equal to their pose, then the palette uploads. */
  end(): void {
    this.#reconciling = false;
    this.#checkObservedEdits();
    const stride = this.bones * 16;
    if (this.#previous !== undefined) {
      for (const slot of this.#fresh)
        this.#previous.set(
          this.#current.subarray(slot * stride, (slot + 1) * stride),
          slot * stride,
        );
    }
    if (this.#observed && this.#previous)
      for (const slot of this.#fresh) {
        const display = this.#rawSlots.get(slot);
        if (display)
          display.expectedPrevious = this.#previous.slice(slot * stride, (slot + 1) * stride);
      }
    this.#fresh.length = 0;
    this.mesh.geometry.instanceCount = this.used;
    if (!this.#dirty) return;
    this.#dirty = false;
    this.#currentAttribute.needsUpdate = true;
    if (this.#previousAttribute !== undefined) this.#previousAttribute.needsUpdate = true;
  }

  /**
   * Releases the palette buffers and the draw's material. The geometry is not disposed: its vertex
   * buffers are the game's own, and disposing it would free them under the source mesh.
   */
  dispose(): void {
    this.mesh.removeFromParent();
    for (const rig of this.#slotRigs.values()) releaseGpuPose(animationRateStateOf(rig));
    this.#currentAttribute.dispose();
    this.#previousAttribute?.dispose();
    for (const attribute of this.#rawAttributes) attribute.dispose();
    this.mesh.material.dispose();
    this.instances.clear();
    this.#slotRigs.clear();
    this.mesh.userData["threenative.animationPosePackets"] = undefined;
    this.#rawSlots.clear();
    this.#ownedSkeletons.clear();
    this.#skeletonOwners.clear();
  }
}

function animationRateStateOf(object: Object3D): IAnimationRateStateLike | undefined {
  for (let node: Object3D | null = object; node !== null; node = node.parent) {
    const value = node.userData[ANIMATION_RATE_STATE_KEY];
    if (
      typeof value === "object" &&
      value !== null &&
      typeof (value as IAnimationRateStateLike).evaluated === "boolean" &&
      typeof (value as IAnimationRateStateLike).evaluation === "number"
    )
      return value as IAnimationRateStateLike;
  }
  return undefined;
}
