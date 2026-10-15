import {
  InstancedBufferGeometry,
  type Material,
  Matrix4,
  Mesh,
  type Object3D,
  type Skeleton,
  type SkinnedMesh,
} from "three";
import {
  Fn,
  If,
  attribute,
  instanceIndex,
  normalGeometry,
  normalLocal,
  positionGeometry,
  positionPrevious,
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

import { type PoseBasis, bakePoseTable, preparePoseBasis } from "./animation-pose-table.js";
import { SPANS, beginSpan, endSpan } from "./profiling/Spans.js";
import type { IAnimationPoseSample } from "./render-camera-cull.js";

const ANIMATION_RATE_SOURCES_KEY = "threenative.animationRateSources";
const ANIMATION_RATE_STATE_KEY = "threenative.animationRateState";

interface IAnimationRateStateLike {
  readonly evaluated: boolean;
  readonly evaluation: number;
  readonly pose?: WeakMap<Object3D, Float64Array>;
  readonly prepareDraw?: () => void;
  readonly readPose?: () => IAnimationPoseSample | undefined;
  readonly setPoseLookup?: (eligible: boolean) => void;
}

/** Internal renderer/device seam; absent limits decline lookup before any allocation. */
export interface IPoseLookupLimits {
  readonly maxStorageBufferBindingSize: number;
  readonly maxBufferSize: number;
  readonly maxStorageBuffersPerShaderStage: number;
}

interface ISharedPoseTable {
  readonly basis: PoseBasis;
  readonly step: number;
  readonly data: Float32Array;
  readonly segments: number;
  readonly attribute: StorageBufferAttribute;
  users: number;
}

const poseTables = new Set<ISharedPoseTable>();

function acquirePoseTable(
  basis: PoseBasis,
  step: number,
  maxBytes: number,
): ISharedPoseTable | undefined {
  for (const table of poseTables) {
    if (table.step === step && table.data.byteLength <= maxBytes && table.basis.compatible(basis)) {
      table.users += 1;
      return table;
    }
  }
  const baked = bakePoseTable(basis, step, maxBytes);
  if (baked === undefined) return undefined;
  const table = {
    ...baked,
    basis,
    step,
    users: 1,
    attribute: new StorageBufferAttribute(baked.data, 16),
  };
  poseTables.add(table);
  return table;
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
  readonly lookupLimits?: IPoseLookupLimits;
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
  readonly #writtenEvaluations = new WeakMap<Object3D, number>();
  readonly #writtenWorldMatrices = new WeakMap<Object3D, Matrix4>();
  #frame = 0;
  #dirty = false;
  #sourceVersion: number;
  readonly #lookupLimits: IPoseLookupLimits | undefined;
  #lookup:
    | {
        table: ISharedPoseTable;
        bases: Map<SkinnedMesh, PoseBasis>;
        coordinates: Float32Array;
        coordinateAttribute: StorageBufferAttribute;
        roots: Float32Array;
        rootAttribute: StorageBufferAttribute;
        writtenFrames: Float64Array;
      }
    | undefined;

  constructor(options: ISkinnedBatchOptions) {
    const { first, capacity, velocity } = options;
    const NodeClass = nodeClassOf(first.material as Material);
    if (NodeClass === undefined) throw new Error("SkinnedBatch requires a convertible material.");
    this.sourceMaterial = first.material as Material;
    this.#sourceVersion = this.sourceMaterial.version;
    this.bones = first.skeleton.bones.length;
    this.capacity = capacity;
    this.#lookupLimits = options.lookupLimits;
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

    const material = new NodeClass();
    this.#syncMaterial(material);

    this.mesh = new Mesh(geometry, material);
    this.#shader();
    this.mesh.matrixAutoUpdate = false;
    this.mesh.userData[ANIMATION_RATE_SOURCES_KEY] = this.instances;
    // The palette spans every rig; only the per-rig sources have meaningful bounds.
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = first.castShadow;
    this.mesh.receiveShadow = first.receiveShadow;
    this.mesh.layers.mask = first.layers.mask;
  }

  #shader(): void {
    const count = this.capacity * this.bones;
    const current = storage(this.#currentAttribute, "mat4", count).toReadOnly();
    const previous =
      this.#previousAttribute === undefined
        ? undefined
        : storage(this.#previousAttribute, "mat4", count).toReadOnly();
    const boneIndex = attribute<"uvec4">("skinIndex", "uvec4");
    const weight = attribute<"vec4">("skinWeight", "vec4");
    const base = instanceIndex.mul(uint(this.bones));
    const lookup = this.#lookup;
    const samples =
      lookup === undefined
        ? undefined
        : storage(lookup.table.attribute, "mat4", lookup.table.data.length / 16).toReadOnly();
    const coordinates =
      lookup === undefined
        ? undefined
        : storage(lookup.coordinateAttribute, "vec4", this.capacity).toReadOnly();
    const roots =
      lookup === undefined
        ? undefined
        : storage(lookup.rootAttribute, "mat4", lookup.roots.length / 16).toReadOnly();
    const boneMatrix = (palette: typeof current, bone: typeof boneIndex.x, history: boolean) =>
      Fn(() => {
        const matrix = palette.element(base.add(bone)).toVar();
        if (samples !== undefined && coordinates !== undefined && roots !== undefined) {
          const coordinate = coordinates.element(instanceIndex);
          const frame = history ? coordinate.z : coordinate.x;
          const alpha = history ? coordinate.w : coordinate.y;
          If(frame.greaterThanEqual(0), () => {
            const at = uint(frame).mul(uint(this.bones)).add(bone);
            const pose = samples
              .element(at)
              .mul(alpha.oneMinus())
              .add(samples.element(at.add(uint(this.bones))).mul(alpha));
            matrix.assign(
              roots
                .element(history ? instanceIndex.add(uint(this.capacity)) : instanceIndex)
                .mul(pose),
            );
          });
        }
        return matrix;
      })();
    const blend = (palette: typeof current, history = false) =>
      boneMatrix(palette, boneIndex.x, history)
        .mul(weight.x)
        .add(boneMatrix(palette, boneIndex.y, history).mul(weight.y))
        .add(boneMatrix(palette, boneIndex.z, history).mul(weight.z))
        .add(boneMatrix(palette, boneIndex.w, history).mul(weight.w));
    const hasTangent = this.mesh.geometry.getAttribute("tangent") !== undefined;
    const material = this.mesh.material;
    material.positionNode = Fn(() => {
      const matrix = blend(current);
      normalLocal.assign(matrix.mul(vec4(normalGeometry, 0)).xyz);
      if (hasTangent) tangentLocal.assign(matrix.mul(vec4(tangentGeometry.xyz, 0)).xyz);
      if (previous !== undefined)
        positionPrevious.assign(blend(previous, true).mul(vec4(positionGeometry, 1)).xyz);
      return matrix.mul(vec4(positionGeometry, 1)).xyz;
    })();
    material.needsUpdate = true;
  }

  /**
   * Starts one reconcile: the frame's history becomes last frame's pose. Called once per frame
   * before any rig writes, so every pass of the frame reads the same pair.
   */
  begin(): void {
    this.#frame += 1;
    this.#syncMaterial(this.mesh.material);
    if (this.sourceMaterial.version !== this.#sourceVersion) {
      this.#sourceVersion = this.sourceMaterial.version;
      this.mesh.material.needsUpdate = true;
    }
    if (this.#previous !== undefined) {
      this.#previous.set(this.#current);
      this.#dirty = true;
    }
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
    return slot;
  }

  /** Returns a rig's slot to the free list with a collapsed pose, so it draws nothing. */
  release(rig: Object3D): void {
    const slot = this.instances.get(rig);
    if (slot === undefined) return;
    this.instances.delete(rig);
    this.#lookup?.bases.delete(rig as SkinnedMesh);
    this.#slotRigs.delete(slot);
    this.#writtenEvaluations.delete(rig);
    this.#writtenWorldMatrices.delete(rig);
    animationRateStateOf(rig)?.setPoseLookup?.(true);
    this.hide(slot);
    this.free.push(slot);
  }

  /** This frame's world-space bone matrices, `capacity × bones` of them in slot order. */
  get palette(): Float32Array {
    return this.#display(false);
  }

  /** Last frame's palette, present only while a temporal stage asks for per-object history. */
  get history(): Float32Array | undefined {
    return this.#previous === undefined ? undefined : this.#display(true);
  }

  /** Adapter inspection only: materialize exactly the indexing and Float32 inputs the shader reads. */
  #display(history: boolean): Float32Array {
    const source = history ? (this.#previous as Float32Array) : this.#current;
    const lookup = this.#lookup;
    if (lookup === undefined) return source;
    const out = source.slice();
    const matrix = new Float32Array(16);
    for (let slot = 0; slot < this.capacity; slot += 1) {
      const frame = lookup.coordinates[slot * 4 + (history ? 2 : 0)] as number;
      if (frame < 0) continue;
      const alpha = lookup.coordinates[slot * 4 + (history ? 3 : 1)] as number;
      for (let bone = 0; bone < this.bones; bone += 1) {
        const at = (frame * this.bones + bone) * 16;
        for (let component = 0; component < 16; component += 1)
          matrix[component] =
            (lookup.table.data[at + component] as number) * (1 - alpha) +
            (lookup.table.data[at + this.bones * 16 + component] as number) * alpha;
        multiply(
          lookup.roots,
          (slot + (history ? this.capacity : 0)) * 16,
          matrix,
          0,
          out,
          (slot * this.bones + bone) * 16,
        );
      }
    }
    return out;
  }

  #retireLookup(): void {
    const lookup = this.#lookup;
    if (lookup === undefined || lookup.bases.size > 0) return;
    for (let slot = 0; slot < this.capacity; slot += 1)
      if (
        (lookup.coordinates[slot * 4] as number) >= 0 ||
        (this.#previous !== undefined && (lookup.coordinates[slot * 4 + 2] as number) >= 0)
      )
        return;
    lookup.coordinateAttribute.dispose();
    lookup.rootAttribute.dispose();
    lookup.table.users -= 1;
    if (lookup.table.users === 0) {
      poseTables.delete(lookup.table);
      lookup.table.attribute.dispose();
    }
    this.#lookup = undefined;
    this.#shader();
  }

  #writeLookup(
    slot: number,
    rig: SkinnedMesh,
    sample: IAnimationPoseSample,
    evaluation: number,
    basis: PoseBasis | undefined,
    pose?: WeakMap<Object3D, Float64Array>,
  ): boolean {
    const limits = this.#lookupLimits;
    const velocity = this.#previous !== undefined;
    const rootBytes = this.capacity * 64 * (velocity ? 2 : 1);
    if (
      Reflect.get(this.sourceMaterial, "isNodeMaterial") === true ||
      limits === undefined ||
      ![
        limits.maxStorageBufferBindingSize,
        limits.maxBufferSize,
        limits.maxStorageBuffersPerShaderStage,
      ].every((value) => Number.isSafeInteger(value) && value > 0) ||
      limits.maxStorageBuffersPerShaderStage < (velocity ? 5 : 4) ||
      rootBytes > Math.min(limits.maxStorageBufferBindingSize, limits.maxBufferSize) ||
      this.#current.byteLength > Math.min(limits.maxStorageBufferBindingSize, limits.maxBufferSize)
    )
      return false;
    if (basis === undefined || !basis.current() || !basis.observed(evaluation, pose)) return false;
    let lookup = this.#lookup;
    if (lookup === undefined) {
      const table = acquirePoseTable(
        basis,
        sample.step,
        Math.min(limits.maxStorageBufferBindingSize, limits.maxBufferSize),
      );
      if (table === undefined) return false;
      const coordinates = new Float32Array(this.capacity * 4);
      for (let at = 0; at < coordinates.length; at += 4) {
        coordinates[at] = -1;
        coordinates[at + 2] = -1;
      }
      const roots = new Float32Array(rootBytes / 4);
      lookup = {
        table,
        coordinates,
        roots,
        bases: new Map(),
        coordinateAttribute: new StorageBufferAttribute(coordinates, 4),
        rootAttribute: new StorageBufferAttribute(roots, 16),
        writtenFrames: new Float64Array(this.capacity),
      };
      this.#lookup = lookup;
      this.#shader();
    } else if (
      lookup.table.basis.clip !== sample.clip ||
      lookup.table.step !== sample.step ||
      !lookup.table.basis.compatible(basis)
    )
      return false;
    lookup.bases.set(rig, basis);
    lookup.writtenFrames[slot] = this.#frame;
    const position = Math.max(
      0,
      Math.min(lookup.table.segments, (sample.time / sample.clip.duration) * lookup.table.segments),
    );
    const frame = Math.min(lookup.table.segments - 1, Math.floor(position));
    lookup.coordinates[slot * 4] = frame;
    lookup.coordinates[slot * 4 + 1] = position - frame;
    sample.root.updateWorldMatrix(true, false);
    sample.root.matrixWorld.toArray(lookup.roots, slot * 16);
    this.#dirty = true;
    return true;
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
    if (this.#lookup !== undefined) {
      const rig = this.#slotRigs.get(slot);
      if (rig !== undefined) this.#lookup.bases.delete(rig as SkinnedMesh);
      this.#lookup.coordinates[slot * 4] = -1;
      this.#lookup.coordinates[slot * 4 + 2] = -1;
      this.#lookup.coordinateAttribute.needsUpdate = true;
      this.#retireLookup();
    }
    this.#dirty = true;
  }

  #invalidate(slot: number): void {
    const rig = this.#slotRigs.get(slot);
    if (rig === undefined) return;
    this.#writtenEvaluations.delete(rig);
    this.#writtenWorldMatrices.delete(rig);
  }

  /**
   * Writes one rig's world-space bone palette. Equals stock skinning's
   * `matrixWorld · bindMatrixInverse · boneMatrix · bindMatrix` per bone; in the default attached
   * bind mode `matrixWorld · bindMatrixInverse` is the identity and is skipped.
   */
  write(slot: number, rig: SkinnedMesh): void {
    beginSpan(SPANS.skinnedWrite);
    try {
      const lookup = this.#lookup;
      if (lookup !== undefined && lookup.writtenFrames[slot] !== this.#frame) {
        lookup.writtenFrames[slot] = this.#frame;
        if (this.#previous !== undefined) {
          lookup.coordinates[slot * 4 + 2] = lookup.coordinates[slot * 4] as number;
          lookup.coordinates[slot * 4 + 3] = lookup.coordinates[slot * 4 + 1] as number;
          lookup.roots.set(
            lookup.roots.subarray(slot * 16, (slot + 1) * 16),
            (slot + this.capacity) * 16,
          );
        }
        this.#retireLookup();
      }
      const state = animationRateStateOf(rig);
      if (typeof state?.prepareDraw === "function") state.prepareDraw();
      if (state?.readPose !== undefined) {
        let basis = this.#lookup?.bases.get(rig);
        const evaluation = state.evaluation;
        const sample = state.readPose();
        if (sample !== undefined) {
          basis ??= preparePoseBasis(sample.root, rig, sample.clip);
          if (this.#writeLookup(slot, rig, sample, state.evaluation, basis, state.pose)) {
            state.setPoseLookup?.(true);
            return;
          }
        }
        if (this.#lookup !== undefined) {
          this.#lookup.bases.delete(rig);
          this.#lookup.coordinates[slot * 4] = -1;
        }
        basis?.observed(evaluation, state.pose);
        state.setPoseLookup?.(false);
        basis?.restoreEdits(evaluation);
        basis?.root.updateMatrixWorld(true);
      }
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
        skeleton.update();
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
    } finally {
      const lookup = this.#lookup;
      if (lookup !== undefined) {
        if (this.#previous !== undefined && this.#fresh.includes(slot)) {
          lookup.coordinates[slot * 4 + 2] = lookup.coordinates[slot * 4] as number;
          lookup.coordinates[slot * 4 + 3] = lookup.coordinates[slot * 4 + 1] as number;
          lookup.roots.set(
            lookup.roots.subarray(slot * 16, (slot + 1) * 16),
            (slot + this.capacity) * 16,
          );
        }
        lookup.coordinateAttribute.needsUpdate = true;
        lookup.rootAttribute.needsUpdate = true;
      }
      endSpan(SPANS.skinnedWrite);
    }
  }

  /** Ends one reconcile: brand-new slots get history equal to their pose, then the palette uploads. */
  end(): void {
    const stride = this.bones * 16;
    if (this.#previous !== undefined) {
      for (const slot of this.#fresh)
        this.#previous.set(
          this.#current.subarray(slot * stride, (slot + 1) * stride),
          slot * stride,
        );
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
    for (const rig of this.instances.keys()) animationRateStateOf(rig)?.setPoseLookup?.(true);
    if (this.#lookup !== undefined) {
      this.#lookup.bases.clear();
      for (let at = 0; at < this.#lookup.coordinates.length; at += 4) {
        this.#lookup.coordinates[at] = -1;
        this.#lookup.coordinates[at + 2] = -1;
      }
      this.#retireLookup();
    }
    this.mesh.removeFromParent();
    this.#currentAttribute.dispose();
    this.#previousAttribute?.dispose();
    this.mesh.material.dispose();
    this.instances.clear();
    this.#slotRigs.clear();
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
