import type { BufferAttribute, Matrix4 } from "three";
import type {
  IndirectStorageBufferAttribute,
  ReadbackBuffer,
  StorageBufferAttribute,
  StorageInstancedBufferAttribute,
} from "three/webgpu";
import type { IKernelOcclusion } from "./render/depth-pyramid.js";

/**
 * The six frustum planes of `matrix` (projection times view) into `out` as `[nx, ny, nz, d]` rows,
 * the planes three's `Frustum.setFromProjectionMatrix` writes with its default (WebGL) near plane.
 * Read straight from the elements, not through a `Frustum`: the owned engine's facade has no
 * `planes` array (`planes.entries()` threw and stopped the render loop, PRD-857), and one
 * `elements` read replaces 24 bridged getters a frame.
 */
export function frustumPlanes(matrix: Matrix4, out: Float32Array): void {
  const m = matrix.elements;
  // [column, sign]: left, right, bottom, top, far, near; each plane is row 3 plus sign times row k.
  const rows = [0, -1, 0, 1, 1, 1, 1, -1, 2, -1, 2, 1] as const;
  for (let plane = 0; plane < 6; plane += 1) {
    const k = rows[plane * 2] as number;
    const sign = rows[plane * 2 + 1] as number;
    const x = (m[3] as number) + sign * (m[k] as number);
    const y = (m[7] as number) + sign * (m[4 + k] as number);
    const z = (m[11] as number) + sign * (m[8 + k] as number);
    const w = (m[15] as number) + sign * (m[12 + k] as number);
    const inverse = 1 / Math.hypot(x, y, z);
    const at = plane * 4;
    out[at] = x * inverse;
    out[at + 1] = y * inverse;
    out[at + 2] = z * inverse;
    out[at + 3] = w * inverse;
  }
}

/** `DrawIndexedIndirect`: indexCount, instanceCount, firstIndex, baseVertex, firstInstance. */
export const DRAW_ARGS_WORDS = 5;
/** `mat4` per key: the part's own offset inside the model, the same matrix the CPU composes. */
export const LOCAL_WORDS = 16;

/**
 * Everything the GPU scene's buffers, kernels and validation have in common: the layout constants,
 * the record of a resident placement, an asset's gate table, one key's region, what a dispatch reads
 * and what it produced.
 *
 * These live apart from {@link WorldGpuScene} because the validation module imports them and the
 * scene imports the validation module: with the types here, that pair is a chain of one direction
 * and the two files no longer import each other.
 */

/** Words one placement record holds: `mat4` + `centre` (xyz, radius) + `info` (asset slot, …; not `meta`, a reserved WGSL keyword). */
export const PLACEMENT_WORDS = 24;
/** The same record in bytes, which is the unit `BufferGeometry.setIndirect` takes its offset in. */
export const DRAW_ARGS_BYTES = DRAW_ARGS_WORDS * 4;

/**
 * How many words the args buffer holds for `keys` keys: one indirect record each, plus one word
 * each of measured-occlusion tally past the last record.
 *
 * The tally rides this buffer rather than a buffer of its own so a measured run reads the two out
 * of the one readback the GPU-selected tally already issues on its own clock — a second readback on
 * a second buffer is a second queue submission per window for eight bytes.
 */
export function argsWords(keys: number): number {
  return keys * DRAW_ARGS_WORDS + keys;
}
/** One `vec4` per key, per asset slot and per level gate. */
export const VEC4_WORDS = 4;
/** Slots a placement may name before the kernel is refused rather than read out of bounds. */
export const SLOT_NONE = -1;

/**
 * One element of every WGSL type this module declares a storage buffer as, in array words.
 *
 * A storage binding's minimum size is one element of its declared type: a `mat4` buffer is 64 bytes
 * whether it holds one matrix or a thousand, and a bound buffer under that is not a wrong picture but
 * a refused pipeline — every dispatch on it is invalid, silently, and only the device complains. So
 * the element count and the element size are not two independent numbers here: they are written down
 * together, once, and every buffer is allocated from this table and nowhere else.
 */
export const STORAGE_WORDS = {
  /**
   * `mat4` + `centre` (vec4) + `info` (vec4), so one placement is 96 bytes and one stride. Nothing
   * is allocated from this key any more: the kernels read one placement as {@link PLACEMENT_ROWS}
   * consecutive `vec4` rows, and the source buffer is allocated in those rows. The key stays as the
   * name of the record's whole stride.
   */
  // quality-allow: the object key names one placement's whole stride, so it keeps that spelling.
  // biome-ignore lint/style/useNamingConvention: the key names one placement's whole stride, spelled as its record.
  GpuPlacement: PLACEMENT_WORDS,
  /** `mat4`, one per key: the part's own offset inside the model, the same one the CPU composes. */
  mat4: LOCAL_WORDS,
  /** `DrawIndexedIndirect`'s five words; `uint` is one word, so the element count is the word count. */
  uint: 1,
  /** One `vec4` per key, per asset slot and per level gate. */
  vec4: VEC4_WORDS,
} as const;

/** A WGSL type the cull kernel declares a storage buffer as, and {@link STORAGE_WORDS}'s key. */
export type StorageType = keyof typeof STORAGE_WORDS;

/** Bytes one element of `type` occupies, which is what a storage binding of it must be at least. */
export function storageElementBytes(type: StorageType): number {
  return STORAGE_WORDS[type] * 4;
}

/**
 * One storage attribute holding `count` elements — at least one, because a zero-element binding is
 * a zero-byte buffer and zero bytes is under every declared type — of the WGSL `type` the kernel
 * binds it as.
 *
 * The class and the array class are parameters because three's three storage attributes differ only
 * in what the renderer does with them, and this module needs all three: a plain one, the instanced
 * buffer a dressed batch's `instanceMatrix` is, and the indirect records `BufferGeometry.setIndirect`
 * reads. Handing the item size in by hand is how `drawn` was allocated four words wide and bound as
 * a `mat4`: a one-element, 16-byte buffer against a 64-byte requirement, so the cull kernel never
 * ran on a real GPU at all. The size is not a free choice here, so it is not written at a call site.
 */
export function storageAttribute<A extends BufferAttribute>(
  ctor: new (count: Float32Array | Uint32Array, itemSize: number) => A,
  type: StorageType,
  count: number,
  array: Float32ArrayConstructor | Uint32ArrayConstructor = Float32Array,
): A {
  const words = STORAGE_WORDS[type];
  return new ctor(new array(Math.max(1, count) * words), words);
}
/** Dispatches between readbacks: a mapped buffer is a queue submission, so not every frame. */
export const VALIDATE_EVERY = 30;
/**
 * Dispatches between the tally's own readbacks, on the same budget as a validation.
 *
 * The tally reads the same indirect args buffer a validation reads, so it reuses that readback path
 * and the renderer's one staging buffer rather than adding a second copy: when validation is on its
 * landed bytes feed the tally, and when it is off this is the interval alone.
 */
export const TALLY_EVERY = 30;

/**
 * How many `vec4` rows one placement record is: the world matrix's four columns, then `centre`, then
 * `info`. The kernels read the source buffer as these rows rather than as one struct element, which
 * the owned engine refuses, and the 24 words are the same words either way.
 */
export const PLACEMENT_ROWS = PLACEMENT_WORDS / VEC4_WORDS;

/** One resident placement as the source buffer holds it. */
export interface IGpuPlacement {
  readonly matrix: Float32Array;
  /** X, Y, Z and the bounding-sphere radius; the frustum test reads the first three. */
  readonly centre: Float32Array;
  /** The asset slot in `0`; `SLOT_NONE` for a record whose cell has left the ring. */
  slot: number;
  /**
   * The placement's uniform scale, in `info.y`: the whole-asset impostor's terminal gate is the
   * base-sphere projected distance scaled by this, so a placement scaled ten times does not switch
   * to the atlas until it is ten times as far. `1` when a caller does not carry one.
   */
  scale?: number;
}

/** One asset's slots: its level gates and the keys each level's parts draw into. */
export interface IAssetSlot {
  /** Level switch distances, ascending, `0` first; the same numbers the CPU path crosses at. */
  readonly distances: readonly number[];
  /** `maxDistance` less its eighth, or `undefined` for an asset with no cull distance. */
  readonly cull: number | undefined;
  /** Per level: the first key its parts draw into and how many parts it has. */
  readonly levels: readonly { readonly firstKey: number; readonly parts: number }[];
  /**
   * Whether the last level is a whole-asset impostor: its gate is the base-sphere projected
   * distance, and the placement's own scale is applied to it at selection. The reference and the
   * kernel both read it, so an impostor terminal and an authored one cannot be crossed differently.
   */
  readonly impostor?: boolean;
  /** Derived LODs keep the last casting shape; authored LODs may opt out. Defaults to true. */
  readonly shadowFallback?: boolean;
}

/** One key's region of the shared drawn buffer, and the args record that counts it. */
export interface IRegion {
  /** Where this key's survivors are written. Moves only in a re-layout, which rewrites every record. */
  start: number;
  /** Instances this region holds. Grows only in a re-layout, which resizes the whole level. */
  capacity: number;
  readonly argsIndex: number;
  /** The part's own offset inside the model; drawn as `placement * local`, as the CPU does. */
  readonly local: Float32Array;
  /** The main key this region is, which is what the validation marker names a mismatch by. */
  readonly name?: string;
  /**
   * The dressed geometry's own index count, which the record's `indexCount` has to say for the draw
   * to name a triangle at all. The owner records it when it dresses the mesh — the scene does not
   * know what shape a key draws — and the validation holds the record against it.
   */
  indexCount: number;
  /**
   * This key has no shadow twin (its level is past the world's `castLevels`), so a shadow map drops
   * a placement the main pass draws here. The GPU twin reads the same fact as `keys.w`, which only a
   * minted twin sets.
   */
  readonly uncast?: boolean;
}

/**
 * One storage attribute widened by doubling until it holds `needed`, or itself when it already does.
 * The contents are carried over and marked as one upload range, which is what makes a regrow a copy
 * rather than a fresh zeroed buffer.
 */
export function growBuffer<A extends BufferAttribute>(
  current: A,
  needed: number,
  make: (count: number) => A,
): A {
  if (current.count >= needed) return current;
  let capacity = Math.max(1, current.count);
  while (capacity < needed) capacity *= 2;
  const grown = make(capacity);
  grown.array.set(current.array as Uint32Array);
  grown.addUpdateRange(0, current.array.length);
  return grown;
}

/** Adds an update range, extending the last one when the new range touches or overlaps it. */
export function addRange(
  attribute: {
    updateRanges: { start: number; count: number }[];
    addUpdateRange(start: number, count: number): void;
  },
  start: number,
  count: number,
): void {
  const last = attribute.updateRanges[attribute.updateRanges.length - 1];
  if (last === undefined || start > last.start + last.count || start + count < last.start) {
    attribute.addUpdateRange(start, count);
    return;
  }
  const newStart = Math.min(last.start, start);
  // Set the count first. It is measured from the old start.
  last.count = Math.max(last.start + last.count, start + count) - newStart;
  last.start = newStart;
}

/** One level's parts and the single capacity all of them are sized from. */
export interface ILevelGroup {
  capacity: number;
  /**
   * The key index the level's run starts at, claimed whole at its first key and never moved, so
   * `firstKey + part` names that part's own key however the parts were minted. The run is claimed
   * rather than appended to because keys are not minted in level order: a prewarm mints every level
   * and part of one asset before the next, a walk that arrives mid-prewarm mints whatever its cell
   * needs, and the keys minted in between are not this level's. A run built by appending is a run
   * with another asset's keys inside it, and a gate table that names it draws that asset's placements
   * through this level's parts and this level's placements through the other's — which is a forest
   * drawn with another tree's geometry, and a check that reproduces the same addressing reads it as
   * agreement.
   */
  firstKey: number;
  /** How many parts the level has, which is the width of the run the gate table names. */
  parts: number;
  /** Part index to the region that part draws into; laid out in this order. */
  readonly minted: Map<number, number>;
}

/**
 * Which of a level's parts a key is, so the parts of one level stay the contiguous run the kernel
 * and the gate table both address as `firstKey + part`. `undefined` mints a key of its own, which
 * is every key a caller that has no level to be a part of wants.
 */
export interface ILevelKey {
  /** The level this part belongs to — one group, however many parts it has. */
  readonly group: string;
  /** The part's own index in that level, which is the order the group is laid out in. */
  readonly part: number;
  /**
   * How many parts the level has altogether, so the run is claimed once and in full. The caller knows
   * it: the level is an array of parts, and every part of it will be asked for. A part outside the
   * run the level declared is refused rather than laid over another level's key.
   */
  readonly parts: number;
}

/** The offset a part that has not been minted yet draws with: none at all, and nowhere to draw. */
export const NO_LOCAL = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/** What the kernel reads, and the whole of what a dispatch touches. */
export interface IKernelInput {
  readonly placements: readonly IGpuPlacement[];
  readonly count: number;
  readonly camera: {
    readonly planes: Float32Array;
    readonly x: number;
    readonly y: number;
    readonly z: number;
  };
  readonly slots: readonly IAssetSlot[];
  readonly regions: readonly IRegion[];
  readonly regionCount: number;
  /**
   * The hierarchical-depth occlusion test, when a launch asked for one. Absent, the frustum is the
   * whole visibility rule; present, every placement the frustum kept is reprojected into the
   * pyramid's own frame and tested. See {@link IKernelOcclusion}.
   */
  readonly occlusion?: IKernelOcclusion;
}

/** What one dispatch produced: the compacted survivors and the per-key instance counts. */
export interface IKernelResult {
  /** `DRAW_ARGS_WORDS` per region, `1` the instance count; everything else is the CPU's. */
  readonly args: Uint32Array;
  readonly drawn: Float32Array;
  /** Instances drawn per region, which is what the args record's count must say. */
  readonly counts: Uint32Array;
  /**
   * What the pyramid test hid, and only when one ran: the instances and the triangles of every
   * placement it would have dropped. Absent is "no test ran", never "the test hid nothing" — a
   * measured run reads these while drawing every one of them.
   */
  readonly occluded?: { readonly instances: number; readonly triangles: number };
}

/**
 * One dispatch's own copy of everything its kernel read, taken while that dispatch runs, plus the
 * attribute the readback has to name.
 *
 * A streamed world changes its placement set, its gate table and its region layout between one frame
 * and the next, so a reference computed when a readback lands describes the frames that followed the
 * dispatch that produced the bytes — which is how a check that compared nothing came to report
 * `compared=0` over 21,147 resident placements. Copied at dispatch time, the reference is a pure
 * function of the snapshot and nothing that happens afterwards can change it.
 */
export interface IValidationSnapshot extends IKernelInput {
  /** The indirect records this dispatch wrote, which is what its readback must name. */
  readonly args: unknown;
  /** The shared matrix buffer this dispatch compacted into, which its other readback must name. */
  readonly drawn: unknown;
  /** Resident placements the scene held when this dispatch ran. */
  readonly placed: number;
}

export interface IValidationReadbacks {
  readonly args: ReadbackBuffer;
  readonly drawn: ReadbackBuffer;
}

/**
 * A TSL node this module pokes at through the swizzles and the `.element()` chain.
 *
 * Three's node types are precise about which swizzle a `vec4` answers and deliberately vague about
 * what a struct member or an atomic result resolves to, and the kernels are the one place in core
 * that has to read a struct member and an atomic's return value. The cast is confined here so the
 * kernels read as the plain shaders they are.
 */
// quality-allow: the kernel is a typed handle onto three's TSL nodes, which resolve to `any` in 0.185.
// biome-ignore lint/suspicious/noExplicitAny: three's TSL types refuse the swizzles this kernel reads.
export type Kernel = Record<string, any>;

/** `storage(...)` results reach the kernel through this, once. */
export function nodes(value: unknown): Kernel {
  return value as Kernel;
}

/** The pair a built pass submits: every key's count cleared, then every placement selected. */
export interface IGpuKernel {
  readonly cull: unknown;
  readonly clear: unknown;
}

export interface IGpuSceneBuffers {
  readonly args: IndirectStorageBufferAttribute;
  readonly drawn: StorageInstancedBufferAttribute;
  readonly gates: StorageBufferAttribute;
  readonly keys: StorageBufferAttribute;
  readonly levels: StorageBufferAttribute;
  readonly locals: StorageBufferAttribute;
  readonly source: StorageBufferAttribute;
}

/** One of the scene's own storage buffers, by the name it is allocated and grown under. */
export type BufferName = keyof IGpuSceneBuffers;

/**
 * The declared WGSL type of every buffer that is a plain `StorageBufferAttribute` in
 * {@link IGpuSceneBuffers}. `args` and `drawn` are absent because each needs a three class of its own,
 * so `#growOf` names those two literally; the other five share one.
 */
export const STORAGE_PLAIN: Record<Exclude<BufferName, "args" | "drawn">, StorageType> = {
  gates: "vec4",
  keys: "vec4",
  levels: "vec4",
  locals: "mat4",
  source: "vec4",
};

/** Resident placements the source buffer is sized to hold before the first reallocation. */
export const SOURCE_FLOOR = 16;

/** One storage buffer as the check reads it: the type the kernel declares and what was allocated. */
export interface IGpuSceneBufferFootprint {
  readonly type: StorageType;
  readonly count: number;
  /** `array.byteLength` — the size WebGPU compares against one element of `type`. */
  readonly bytes: number;
}

/** The slice of a `GPUDevice` the validation seam reads, so a test can stand in a fake. */
export interface IDeviceLike {
  onuncapturederror?: ((event: unknown) => void) | null;
}
