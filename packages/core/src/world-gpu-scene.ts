import {
  DRAW_ARGS_WORDS,
  LIVE_MATRIX,
  LOCAL_WORDS,
  MATRIX_REPORTED_KEYS,
  MATRIX_TOLERANCE,
  MEMORY_FIELDS,
  VALIDATE_REPORTED_KEYS,
  compareMeshDraws,
  compose,
  sameGates,
  sameLocal,
  sameMatrices,
  validationReport,
  word,
  xyz,
  zeroComparisonProbe,
} from "./world-gpu-validation.js";

import type {
  GpuSceneMemory,
  GpuSceneVerdict,
  IGpuSceneComparison,
  IGpuSceneValidation,
  IMeshDraw,
} from "./world-gpu-validation.js";

export type {
  IMeshDraw,
  IMeshDrawComparison,
  GpuSceneVerdict,
  IGpuSceneValidation,
  GpuSceneMemoryField,
  GpuSceneMemory,
  IValidationNearest,
  IValidationProbe,
  IGpuSceneComparison,
} from "./world-gpu-validation.js";

export { compareMeshDraws, validationReport } from "./world-gpu-validation.js";

import {
  type BufferAttribute,
  type Camera,
  type DepthTexture,
  Frustum,
  Matrix4,
  PerspectiveCamera,
  Vector3,
  Vector4,
} from "three";
import {
  Fn,
  If,
  Loop,
  Return,
  abs,
  atomicAdd,
  float,
  instanceIndex,
  int,
  length,
  max,
  min,
  storage,
  struct,
  uniform,
  vec3,
} from "three/tsl";
import {
  IndirectStorageBufferAttribute,
  ReadbackBuffer,
  StorageBufferAttribute,
  StorageInstancedBufferAttribute,
} from "three/webgpu";
import { biasedLodDistance } from "./model-lod.js";
import {
  DepthPyramid,
  type IKernelOcclusion,
  type OcclusionMode,
  occludedBy,
} from "./render/depth-pyramid.js";
import type { IRendererLike } from "./renderer.js";

/**
 * The GPU-driven main pass of a streamed world: one compute dispatch culls and LOD-selects every
 * resident placement, appends the survivors into a shared compacted matrix buffer, and each main
 * batch draws its own region of that buffer with the instance count living in a GPU-side
 * `DrawIndexedIndirect` record. The CPU keeps only the coarse per-key visibility.
 *
 * Everything the kernel needs is GPU data. The CPU writes the placement buffer when residency
 * changes and the indirect records when a key is minted, retired or regrown — a structural event —
 * and nothing at all per instance per frame.
 *
 * The per-instance logic exists twice on purpose: {@link cullAndSelect} is the reference, in plain
 * TypeScript, and the TSL kernel below mirrors it line for line. The tests run in node with no GPU,
 * so the reference is what is proved against the CPU path; the kernel is compiled in the browser.
 */

/** Words one placement record holds: `mat4` + `centre` (xyz, radius) + `info` (asset slot, …; not `meta`, a reserved WGSL keyword). */
const PLACEMENT_WORDS = 24;
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
function argsWords(keys: number): number {
  return keys * DRAW_ARGS_WORDS + keys;
}
/** One `vec4` per key, per asset slot and per level gate. */
const VEC4_WORDS = 4;
/** Slots a placement may name before the kernel is refused rather than read out of bounds. */
const SLOT_NONE = -1;

/**
 * One element of every WGSL type this module declares a storage buffer as, in array words.
 *
 * A storage binding's minimum size is one element of its declared type: a `mat4` buffer is 64 bytes
 * whether it holds one matrix or a thousand, and a bound buffer under that is not a wrong picture but
 * a refused pipeline — every dispatch on it is invalid, silently, and only the device complains. So
 * the element count and the element size are not two independent numbers here: they are written down
 * together, once, and every buffer is allocated from this table and nowhere else.
 */
const STORAGE_WORDS = {
  /** `mat4` + `centre` (vec4) + `info` (vec4), so one placement is 96 bytes and one stride. */
  // quality-allow: the object key is the WGSL type name the kernel reads, so it keeps that spelling.
  // biome-ignore lint/style/useNamingConvention: the key is the WGSL type, spelled as the kernel declares it.
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
function storageAttribute<A extends BufferAttribute>(
  ctor: new (count: Float32Array | Uint32Array, itemSize: number) => A,
  type: StorageType,
  count: number,
  array: Float32ArrayConstructor | Uint32ArrayConstructor = Float32Array,
): A {
  const words = STORAGE_WORDS[type];
  return new ctor(new array(Math.max(1, count) * words), words);
}
/** Dispatches between readbacks: a mapped buffer is a queue submission, so not every frame. */
const VALIDATE_EVERY = 30;
/**
 * Dispatches between the tally's own readbacks, on the same budget as a validation.
 *
 * The tally reads the same indirect args buffer a validation reads, so it reuses that readback path
 * and the renderer's one staging buffer rather than adding a second copy: when validation is on its
 * landed bytes feed the tally, and when it is off this is the interval alone.
 */
const TALLY_EVERY = 30;

/**
 * A `mat4` world matrix, the placement's bounding-sphere centre and radius, and the asset slot whose
 * gates pick its level. One stride, so the CPU's `Float32Array` is the GPU's storage buffer with no
 * repacking and no type punning: the radius and the slot are small and exactly representable.
 */
const PlacementStruct = struct({ matrix: "mat4", centre: "vec4", info: "vec4" }, "GpuPlacement");

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
function growBuffer<A extends BufferAttribute>(
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
interface ILevelGroup {
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
const NO_LOCAL = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

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

interface IValidationReadbacks {
  readonly args: ReadbackBuffer;
  readonly drawn: ReadbackBuffer;
}

/**
 * The level one placement draws with, from an asset's gate table and the placement's own scale.
 *
 * Every gate but a whole-asset impostor's terminal is an authored world-metre distance, compared
 * directly. The impostor's terminal gate is the base-sphere *projected* distance: the atlas is
 * built for the asset's own LOD0 size, so a placement scaled ten times reaches the atlas ten times
 * as far — its threshold is `base * |scale|`, floored by the last source gate it must stay strictly
 * beyond. The floor is nudged one representable step past that gate: sharing the gate's own switch
 * distance would let the terminal overwrite the last source level at every distance past it, so the
 * source level would never draw. Read by {@link cullAndSelect} and mirrored by the kernel and the
 * CPU path, so all three cross the same switch.
 */
export function levelAtGates(
  slot: Pick<IAssetSlot, "distances" | "impostor">,
  distance: number,
  scale: number,
): number {
  const last = slot.distances.length - 1;
  const magnitude = Number.isFinite(scale) ? Math.abs(scale) : 1;
  let level = 0;
  for (let index = 1; index < slot.distances.length; index += 1) {
    const gate = slot.distances[index] as number;
    const threshold =
      slot.impostor === true && index === last && last >= 1
        ? Math.max(strictlyAfterGate(slot.distances[last - 1] as number), gate * magnitude)
        : gate;
    if (distance > threshold) level = index;
  }
  return level;
}

/**
 * The last level at or below `level` that the scene can actually draw, which is where a placement
 * goes when the gates name one the prewarm has not minted keys for.
 *
 * `WorldCells#gatesOf` names every level of an asset from the moment it is adopted and fills in the
 * keys minted so far, so a chain that has widened holds `parts: 2,0,0,0` while the loading screen is
 * up. The CPU path draws `asset.levels[level]` whatever the gates name and always has a shape there;
 * a dispatch that took the named level would loop its zero keys and draw the placement nowhere, and
 * with the bias raised the placements past the last source gate are exactly the far ones — a forest
 * 80-300 m out standing in its own shadows, while the shadow halves, which take no bias and key
 * themselves, still draw. One level down is the finest shape the scene holds, which is the level the
 * prewarm is one frame from minting.
 */
function drawableLevel(slot: Pick<IAssetSlot, "levels">, level: number): number {
  for (let at = level; at > 0; at -= 1) if ((slot.levels[at]?.parts ?? 0) > 0) return at;
  return 0;
}

/**
 * The level a shadow map draws a placement at, or -1 when no level of its asset casts. A placement
 * whose main level casts nothing falls back only when its asset permits it: derived chains past
 * `castLevels` keep their shadow, drawn in the last shape that has a twin, rather than
 * leaving a hole in the map (PRD-541). The level is then floored at the map's base and clamped to
 * the last level that casts, so a coarse map draws the coarsest shape that has a twin. `base` past
 * the chain is clamped by the chain length first.
 */
function shadowLevel(
  slot: Pick<IAssetSlot, "levels" | "shadowFallback">,
  regions: readonly IRegion[],
  drawn: number,
  base: number,
): number {
  const casts = (at: number): boolean => {
    const gate = slot.levels[at];
    return gate !== undefined && gate.parts > 0 && regions[gate.firstKey]?.uncast !== true;
  };
  if (slot.shadowFallback === false && casts(drawn) === false) return -1;
  // At or below `drawn` any casting level qualifies, above it only up to the map's base, so the
  // last casting level in `[0, max(drawn, base)]` is both rules at once.
  const last = Math.max(drawn, Math.min(base, slot.levels.length - 1));
  let level = -1;
  for (let at = 0; at <= last; at += 1) if (casts(at)) level = at;
  return level;
}

/**
 * One representable Float32 step past a gate: `g * (1 + 2^-22)`, two f32 ULPs at `g`'s exponent.
 *
 * A floored terminal gate must start strictly after the source gate it is floored by and must stay
 * so once the threshold is stored and compared in f32, which a bare `g` does not: the terminal
 * shares `g`'s switch distance and the later gate wins every comparison, starving the source level.
 * A relative step, not a fixed metre margin, so the ordering holds at every authored scale.
 */
const GATE_STEP = 2 ** -22;

function strictlyAfterGate(gate: number): number {
  return gate + Math.abs(gate) * GATE_STEP;
}

/**
 * One shadow map's own three numbers, which is the whole of what a level render knows that the main
 * camera does not.
 *
 * They are the level's, never the camera's: a map's frustum is the light's window, its gate is the
 * texel size it can resolve, and its base is the chain level the cluster path hands it — `#probe`
 * swaps a coarse level's geometry for the coarsest shape, so a coarse map draws that shape whatever a
 * placement's own distance would have selected. The distance itself is the main pass's, from the
 * eye: a placement's shape and its cast come from the key the main pass draws it in.
 */
export interface IShadowLevel {
  /** The six frustum planes of this map's own shadow camera. */
  readonly planes: Float32Array;
  /** This map's texel gate in world metres: a placement narrower than it casts nothing here. */
  readonly gate: number;
  /**
   * The chain level this map draws at, floored over the placement's own. 0 is the placement's own
   * LOD by distance — what the finest map draws — and the coarsest index is what every level past
   * the first draws. A base whose keys are not minted draws nothing, which is why a caller settling
   * the prewarm first is the contract rather than a fallback.
   *
   * {@link COARSEST_SHADOW_LEVEL} is past every chain, and means the coarsest shape an asset has: a
   * map that coarsens its casters does not know how long each asset's chain is, and the floor is
   * clamped per asset, so one number asks every chain for its own coarsest level.
   */
  readonly base: number;
}

/**
 * A {@link IShadowLevel.base} past every chain: the map draws every asset's coarsest shape, whatever
 * distance selected it. Clamped to each asset's own last level, so an owner with no level count to
 * hand — `VirtualShadowNode`, which coarsens a coarse level's casters without knowing an asset —
 * can still ask.
 */
export const COARSEST_SHADOW_LEVEL = 1 << 20;

/**
 * The per-instance kernel, in plain TypeScript. The TSL kernel in {@link WorldGpuScene} is this
 * loop with the same branches, and the test proves this one against the CPU path.
 *
 * One placement, in the order the source buffer holds them: a released record and a record whose
 * asset is unknown are skipped, the bounding sphere is tested against the camera's six planes, the
 * XZ distance picks the level through the asset's own gates and culls a record beyond its cull
 * distance, and each part of that level takes the next free slot in its key's region and writes
 * `placement * part offset` there. A region that is full is a dropped instance, never a write past
 * the end of the buffer.
 */
export function cullAndSelect(input: IKernelInput): IKernelResult {
  return select(input, undefined);
}

/**
 * The same kernel with a shadow map's own four numbers in place of the camera's, and nothing else
 * changed: same regions, same keys, same `placement * part offset`, same capacity guard.
 *
 * The gate is applied to the placement's own diameter, where the cluster path applies it to the
 * whole mesh and drops the square with it — so on a uniform-size fixture the two sets are the same
 * set, and where a square mixes sizes this one is the finer of the two.
 */
export function cullAndSelectShadow(input: IKernelInput, level: IShadowLevel): IKernelResult {
  return select(input, level);
}

/**
 * The one loop both references share. `shadow` is what makes the second one a variant rather than a
 * fork: the main camera's planes, eye, no gate and no base are the degenerate case, so the two can
 * never disagree by having been edited apart.
 */
function select(input: IKernelInput, shadow: IShadowLevel | undefined): IKernelResult {
  const { placements, camera, regions, slots } = input;
  // A shadow map has no main camera to reproject into, so the test is the main pass's alone — a
  // caster the eye cannot see still casts.
  const occlusion = shadow === undefined ? input.occlusion : undefined;
  const planes = shadow?.planes ?? camera.planes;
  const metres = shadow?.gate ?? 0;
  const base = shadow?.base ?? 0;
  const counts = new Uint32Array(input.regionCount);
  const args = new Uint32Array(input.regionCount * DRAW_ARGS_WORDS);
  // The drawn buffer is the regions' own, so the reference allocates exactly what the GPU holds.
  const capacity = regions.reduce(
    (sum, region) => Math.max(sum, region.start + region.capacity),
    0,
  );
  const matrix = new Float32Array(capacity * LOCAL_WORDS);
  for (const region of regions) {
    args[region.argsIndex * DRAW_ARGS_WORDS + 4] = region.start;
  }
  let occludedInstances = 0;
  let occludedTriangles = 0;
  for (let index = 0; index < input.count; index += 1) {
    const placement = placements[index];
    if (placement === undefined || placement.slot < 0) continue;
    const slot = slots[placement.slot];
    if (slot === undefined) continue;
    const at = placement.centre;
    const radius = at[3] as number;
    let visible = true;
    for (let plane = 0; plane < 6; plane += 1) {
      const offset = plane * 4;
      const signed =
        (planes[offset] as number) * (at[0] as number) +
        (planes[offset + 1] as number) * (at[1] as number) +
        (planes[offset + 2] as number) * (at[2] as number) +
        (planes[offset + 3] as number);
      if (signed < -radius) {
        visible = false;
        break;
      }
    }
    if (visible === false) continue;
    // Sub-texel, exactly as `#probe` decides it for a mesh: a caster this map cannot resolve casts
    // no shadow a fragment could tell from ground cover.
    if (radius * 2 < metres) continue;
    const distance = Math.hypot((at[0] as number) - camera.x, (at[2] as number) - camera.z);
    if (slot.cull !== undefined && distance > slot.cull) continue;
    // Cull above is the authored distance; the level below is the biased one for the main pass — the
    // same multiplier the kernel's uniform carries, so the reference and the dispatch cross a switch
    // together. A shadow map takes the main pass's own level, from the eye: that is the key a
    // placement is drawn in, and the cluster path casts each key's placements from that key's mesh.
    const drawn = drawableLevel(
      slot,
      levelAtGates(slot, biasedLodDistance(distance), placement.scale ?? 1),
    );
    const level = shadow === undefined ? drawn : shadowLevel(slot, regions, drawn, base);
    if (level < 0) continue;
    const gate = slot.levels[level];
    if (gate === undefined) continue;
    const hidden =
      occlusion !== undefined && occludedBy(occlusion, at, radius) ? occlusion : undefined;
    for (let part = 0; part < gate.parts; part += 1) {
      const region = regions[gate.firstKey + part];
      if (region === undefined) continue;
      // Counted either way: a measured run draws what it hides, so the count is the only place the
      // answer can live.
      if (hidden !== undefined) {
        occludedInstances += 1;
        occludedTriangles += region.indexCount / 3;
        if (hidden.cull) continue;
      }
      const taken = counts[gate.firstKey + part] as number;
      if (taken >= region.capacity) continue;
      counts[gate.firstKey + part] = taken + 1;
      args[region.argsIndex * DRAW_ARGS_WORDS + 1] = taken + 1;
      compose(placement.matrix, region.local, matrix, (region.start + taken) * LOCAL_WORDS);
    }
  }
  return {
    args,
    counts,
    drawn: matrix,
    ...(occlusion === undefined
      ? {}
      : { occluded: { instances: occludedInstances, triangles: occludedTriangles } }),
  };
}

/**
 * One asset's gates as its owner last published them: the source representation and its
 * `asset.distances`/`cullDistance(definition.maxDistance)` snapshot at the completed swap boundary.
 *
 * Deliberately not an {@link IAssetSlot}. A slot is what this class wrote into its own table, and a
 * table written before the owner's model widened its chain is the exact thing the check exists to
 * catch — feeding it back in as the reference is the check agreeing with itself.
 */
export interface ILiveAsset {
  /** The asset id a main key is named `asset:level:part` with, which is the owner's own convention. */
  readonly id: string;
  /** Level switch distances, ascending, `0` first — the CPU publication snapshot. */
  readonly distances: readonly number[];
  /** `maxDistance` less its eighth, or `undefined`. */
  readonly cull: number | undefined;
  /** Index-aligned with `distances`; each level's parts, each part's own offset inside the model. */
  readonly locals: readonly (readonly Float32Array[])[];
  /** Whether the last level is a whole-asset impostor whose gate the placement's scale scales. */
  readonly impostor?: boolean;
}

/**
 * Every placement's own answer, from the owner's live gates, as the instances each main key must be
 * holding: the same six-plane sphere test, the same `cull`, the same ascending `distance > gate`
 * level test and the same `placement * part offset` composition {@link cullAndSelect} runs — over
 * gates this file did not write.
 *
 * This is the one reference in the module that is not a mirror of the kernel's inputs. `cullAndSelect`
 * reads the gate table out of the same class the kernel's buffer is written from, so a table holding
 * the wrong distances makes both agree; here the caller passes the owner's own `distances`, so a
 * table that was written before the chain widened, or before the last `maxDistance`, answers
 * differently from the picture the CPU path draws.
 */
export function liveKeyInstances(
  placements: readonly IGpuPlacement[],
  asset: (slot: number) => ILiveAsset | undefined,
  camera: {
    readonly planes: Float32Array;
    readonly x: number;
    readonly y: number;
    readonly z: number;
  },
): Map<string, Float32Array> {
  const words = new Map<string, number[]>();
  for (const placement of placements) {
    if (placement.slot < 0) continue;
    const held = asset(placement.slot);
    if (held === undefined) continue;
    const at = placement.centre;
    const radius = at[3] as number;
    let visible = true;
    for (let plane = 0; plane < 6; plane += 1) {
      const offset = plane * 4;
      const signed =
        (camera.planes[offset] as number) * (at[0] as number) +
        (camera.planes[offset + 1] as number) * (at[1] as number) +
        (camera.planes[offset + 2] as number) * (at[2] as number) +
        (camera.planes[offset + 3] as number);
      if (signed < -radius) {
        visible = false;
        break;
      }
    }
    if (visible === false) continue;
    const distance = Math.hypot((at[0] as number) - camera.x, (at[2] as number) - camera.z);
    if (held.cull !== undefined && distance > held.cull) continue;
    // The dispatch's own bias and the same gate rule: this reference is what the dressed mesh's
    // instances are checked against, so it must cross the impostor switch exactly as the kernel does.
    const level = levelAtGates(held, biasedLodDistance(distance), placement.scale ?? 1);
    const locals = held.locals[level];
    if (locals === undefined) continue;
    for (const [part, local] of locals.entries()) {
      const key = `${held.id}:${String(level)}:${String(part)}`;
      let run = words.get(key);
      if (run === undefined) {
        run = [];
        words.set(key, run);
      }
      compose(placement.matrix, local, LIVE_MATRIX, 0);
      for (const word of LIVE_MATRIX) run.push(word);
    }
  }
  return new Map([...words].map(([key, run]) => [key, Float32Array.from(run)]));
}

/** One completed manual frame check, identified by the caller's frame and this scene's dispatch. */
export interface IWorldGpuFrameValidation extends IGpuSceneComparison {
  /** The caller's rendered-frame identity, never inferred from readback timing. */
  readonly frame: number;
  /** The dispatch whose buffers and snapshot this readback completed against. */
  readonly dispatch: number;
  readonly verdict: GpuSceneVerdict;
}

/** The message an uncaptured WebGPU error event carries, flattened to one line. */
function uncapturedMessage(event: unknown): string {
  const error = (event as { error?: { message?: string; constructor?: { name?: string } } }).error;
  const kind = error?.constructor?.name ?? "GPUError";
  return `${kind}: ${(error?.message ?? "no message").replace(/\s+/gu, " ").trim()}`;
}

/**
 * What `TN_WORLD_GPU_SCENE` reports, and what `stats().gpuScene` carries.
 *
 * `dispatches`/`instances`/`keys` are the scene's own tables — the placements it holds and the keys
 * it is ready to draw. The optional `gpu*` trio is different in kind: it is a sample of what the GPU
 * actually selected in the **main** pass, read back from the same indirect args records the draw
 * uses (sum of `instanceCount`, and sum of `instanceCount x indexCount / 3`). Shadow passes are not
 * tallied, and a count three reports from `renderer.info.render.triangles` is an upper bound over a
 * mesh's CPU capacity, not a GPU-selected count — see {@link IFrameBudgetWindow.mainGpuTriangles}.
 */
export interface IWorldGpuSceneReport {
  readonly dispatches: number;
  readonly instances: number;
  readonly keys: number;
  readonly on: boolean;
  readonly reason: string;
  /** Instances the GPU selected in the main pass, from the last landed tally. */
  readonly gpuInstances?: number;
  /** Triangles the GPU selected in the main pass (`instanceCount x indexCount / 3`), from the tally. */
  readonly gpuTriangles?: number;
  /** Dispatches between the tally's bytes being issued and now; grows until the first lands. */
  readonly gpuTallyAgeFrames?: number;
  /**
   * What the pyramid occlusion test would cull, when a launch asked it to measure. Absent unless
   * `?tnOcclusion=measure` asked, `reason` names why it measured nothing (`no scene depth`), and the
   * counts and `occlusion.gpuTriangles` come from one landed dispatch, even if a later tally
   * was skipped for occlusion.
   */
  readonly occlusion?: {
    readonly mode: OcclusionMode;
    readonly reason: string;
    /** Pyramid levels and the dispatches that rebuild them each frame. */
    readonly levels: number;
    readonly buildDispatches: number;
    /** The last landed sample, and the mean over every sample that landed. */
    readonly instances: number;
    readonly triangles: number;
    readonly meanInstances: number;
    readonly meanTriangles: number;
    readonly samples: number;
    /** `triangles / gpuTriangles` of the same sample, which is what the go/no-go multiplies. */
    readonly share: number;
    readonly gpuTriangles: number;
    readonly ageFrames: number;
  };
}

/**
 * The shadow twins' two buffers: a record per key and a run per key, at the layout the main pass
 * already gave each key. Allocated only once a provider has registered — see
 * {@link WorldGpuScene.shadowKeysFrom}.
 */
interface IShadowBuffers {
  readonly args: IndirectStorageBufferAttribute;
  readonly drawn: StorageInstancedBufferAttribute;
  /** Key name to the main key index it twins, so a missing twin is a missing draw, not a crash. */
  readonly keys: Map<string, number>;
  /** The same indices the other way, so a record write knows whether this key has a twin at all. */
  readonly held: Set<number>;
}

interface IGpuSceneBuffers {
  readonly args: IndirectStorageBufferAttribute;
  readonly drawn: StorageInstancedBufferAttribute;
  readonly gates: StorageBufferAttribute;
  readonly keys: StorageBufferAttribute;
  readonly levels: StorageBufferAttribute;
  readonly locals: StorageBufferAttribute;
  readonly source: StorageBufferAttribute;
}

/** One of the scene's own storage buffers, by the name it is allocated and grown under. */
type BufferName = keyof IGpuSceneBuffers;

/**
 * The declared WGSL type of every buffer that is a plain `StorageBufferAttribute` in
 * {@link IGpuSceneBuffers}. `args` and `drawn` are absent because each needs a three class of its own,
 * so `#growOf` names those two literally; the other five share one.
 */
const STORAGE_PLAIN: Record<Exclude<BufferName, "args" | "drawn">, StorageType> = {
  gates: "vec4",
  keys: "vec4",
  levels: "vec4",
  locals: "mat4",
  source: "GpuPlacement",
};

/** Resident placements the source buffer is sized to hold before the first reallocation. */
const SOURCE_FLOOR = 16;

/** One storage buffer as the check reads it: the type the kernel declares and what was allocated. */
export interface IGpuSceneBufferFootprint {
  readonly type: StorageType;
  readonly count: number;
  /** `array.byteLength` — the size WebGPU compares against one element of `type`. */
  readonly bytes: number;
}

/** The slice of a `GPUDevice` the validation seam reads, so a test can stand in a fake. */
interface IDeviceLike {
  onuncapturederror?: ((event: unknown) => void) | null;
}

/**
 * Why the GPU scene is not on, when it is not.
 *
 * Three of the three: compute, storage buffers and indirect draws. WebGL has none of them, and a
 * native backend without them falls back to exactly the CPU path PRD-458 left behind — which is a
 * lost saving, never a wrong picture. `gpuScene: false` is the same answer for a game debugging it.
 */
export function gpuSceneUnsupported(renderer: IRendererLike): string {
  if (renderer.kind !== "webgpu") return `backend=${renderer.kind}`;
  const raw = renderer.raw as {
    backend?: { device?: IDeviceLike; hasFeature?: (name: string) => boolean };
  };
  const backend = raw?.backend;
  if (backend === undefined || typeof backend.hasFeature !== "function")
    return "backend=webgpu-without-hasFeature";
  if (backend.hasFeature("core-features-and-limits") !== true) return "feature=core";
  if (backend.hasFeature("indirect-first-instance") !== true)
    return "feature=indirect-first-instance";
  return "";
}

/** The six planes of a camera's frustum, as the kernel reads them, into `out`. */
function cameraPlanes(camera: Camera, out: Float32Array): void {
  _cullFrustum.setFromProjectionMatrix(
    _proj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
  for (const [index, plane] of _cullFrustum.planes.entries()) {
    const at = index * 4;
    out[at] = plane.normal.x;
    out[at + 1] = plane.normal.y;
    out[at + 2] = plane.normal.z;
    out[at + 3] = plane.constant;
  }
}

const _proj = new Matrix4();
const _cullFrustum = new Frustum();
const _eye = new Vector3();
const _view = new Matrix4();

/** Camera travel in one dispatch that the occlusion test reads as a cut rather than a turn. */
const OCCLUSION_CUT_METRES = 2;

/** Two projection matrices are unchanged when every element is within this. */
const VIEW_EPSILON = 1e-6;

/** Whether the projection changed; ordinary camera travel and turns are not cuts. */
function sameProjection(left: Matrix4, right: Matrix4): boolean {
  for (const [index, element] of right.elements.entries())
    if (Math.abs((left.elements[index] as number) - element) > VIEW_EPSILON) return false;
  return true;
}

/**
 * A TSL node this module pokes at through the swizzles and the `.element()` chain.
 *
 * Three's node types are precise about which swizzle a `vec4` answers and deliberately vague about
 * what a struct member or an atomic result resolves to, and the kernel is the one place in core
 * that has to read a struct member and an atomic's return value. The cast is confined here so the
 * kernel reads as the plain shader it is.
 */
// quality-allow: the kernel is a typed handle onto three's TSL nodes, which resolve to `any` in 0.185.
// biome-ignore lint/suspicious/noExplicitAny: three's TSL types refuse the swizzles this kernel reads.
type Kernel = Record<string, any>;

/** `storage(...)` results reach the kernel through this, once. */
function nodes(value: unknown): Kernel {
  return value as Kernel;
}

/** The launch flag. */
export const GPU_SCENE_FLAG = "TN_GPU_SCENE";

/**
 * Did this launch ask for `flag` to be **off**? The environment variable, the query string and the
 * global a test sets are the three ways one is asked, and `0` and `false` are the only answers that
 * count: an unset or empty variable is the same as no variable, and a saved URL that used to enable
 * a switch still says "off".
 */
function askedOff(flag: string, parameter: string, globalName: string): boolean {
  const host = globalThis as { process?: { env?: Record<string, unknown> } } & Record<
    string,
    unknown
  >;
  const fromEnv = host.process?.env?.[flag];
  if (fromEnv === "0" || fromEnv === "false") return true;
  const query = globalThis.location?.search;
  if (
    typeof query === "string" &&
    new RegExp(`[?&]${parameter}=(?:0|false)(?:&|$)`, "u").test(query)
  )
    return true;
  const set = host[globalName];
  return set === false || set === 0 || set === "0" || set === "false";
}

/**
 * Did this launch ask for `flag` to be **on**? The mirror of {@link askedOff}, for the switches that
 * are opt-in: the environment variable, the query string and the global a test sets, and only
 * `1` and `true` count. An unset or empty variable is the same as no variable, so an old URL that
 * never mentioned the switch stays off.
 */
function askedOn(flag: string, parameter: string, globalName: string): boolean {
  const host = globalThis as { process?: { env?: Record<string, unknown> } } & Record<
    string,
    unknown
  >;
  const fromEnv = host.process?.env?.[flag];
  if (fromEnv === "1" || fromEnv === "true") return true;
  const query = globalThis.location?.search;
  if (
    typeof query === "string" &&
    new RegExp(`[?&]${parameter}=(?:1|true)(?:&|$)`, "u").test(query)
  )
    return true;
  return host[globalName] === true || host[globalName] === 1 || host[globalName] === "1";
}

/**
 * Whether the GPU-driven main pass should run on this launch, on by default where the backend can.
 *
 * @situation debug a walk whose main pass culls and LOD-selects on the GPU
 * @constraint on unless a launch asks for the CPU path: `gpuScene: false`, `?tnGpuScene=0` or
 *   `TN_GPU_SCENE=0` turn it off, and a backend without compute, storage buffers and
 *   `drawIndexedIndirect` falls back on its own
 * @example WorldCells.load({ ...options, gpuScene: gpuSceneRequested() });
 *
 * Read the way `renderListValidationRequested` and `terrainValidationRequested` read their own: a
 * native launch sets the environment variable, a browser asks with the query string, and a test
 * sets the global. Measured on machinefall at 863f83258, so it flipped from opt-in to default.
 */
export function gpuSceneRequested(): boolean {
  return askedOff(GPU_SCENE_FLAG, "tnGpuScene", "__tnGpuScene") === false;
}

/** The launch flag. */
export const BUNDLE_FLAG = "TN_BUNDLES";

/**
 * What this launch asked for about world draw bundles: `on`, `off`, or `default` when it said
 * nothing.
 *
 * @situation tell a run that set the option itself apart from one that took the default
 * @example WorldCells.load({ ...options, bundles: bundlesAsked() !== "off" });
 *
 * Read the way {@link gpuSceneRequested} reads its own: a native launch sets the environment
 * variable, a browser asks with the query string, and a test sets the global.
 */
export function bundlesAsked(): "default" | "off" | "on" {
  if (askedOn(BUNDLE_FLAG, "tnBundles", "__tnBundles")) return "on";
  return askedOff(BUNDLE_FLAG, "tnBundles", "__tnBundles") ? "off" : "default";
}

/**
 * Whether world draw bundles should be recorded and replayed. On by default, and off unless a launch
 * asks for the CPU path.
 *
 * @situation debug a walk whose main batches are replayed from a recorded bundle
 * @constraint on unless a launch asks otherwise: `bundles: false`, `?tnBundles=0` or `TN_BUNDLES=0`
 *   turn it off. The default followed a measurement, not a preference — PRD-494 AC-2 took the walking
 *   `draw` span from a 6.0 ms p50 median to 0.6 ms against develop over 3 interleaved runs, on a
 *   picture a blind world gate called equal, so the answer that used to be "off, it gave no CPU
 *   p50/p95 gain" is now "on, it is 5 ms of the walking p95". `bundles: true`, `?tnBundles=1` or
 *   `TN_BUNDLES=1` still say so explicitly. See PRD-473 phase 2 and PRD-494 phase 2.
 * @example WorldCells.load({ ...options, bundles: bundlesRequested() });
 */
export function bundlesRequested(): boolean {
  return bundlesAsked() !== "off";
}

/** The validation flag. */
export const GPU_SCENE_VALIDATE_FLAG = "TN_GPU_SCENE_VALIDATE";

/**
 * Whether the GPU scene should hold every dispatch's indirect args against the CPU reference.
 *
 * @situation find the keys a real WebGPU dispatch draws fewer instances of than `cullAndSelect` does
 * @constraint off by default and never on a measured walk: a readback is a queue submission and a
 *   mapped buffer, so the mode exists to answer "which key" and not to be fast
 * @example WorldCells.load({ ...options, gpuScene: true, gpuSceneValidate: gpuSceneValidationRequested() });
 *
 * Read the way `gpuSceneRequested` reads its own: a native launch sets the environment variable, a
 * browser asks with `?tnGpuSceneValidate=1`, and a test sets the global.
 */
export function gpuSceneValidationRequested(): boolean {
  const host = globalThis as {
    process?: { env?: Record<string, unknown> };
    __tnGpuSceneValidate?: unknown;
  };
  const fromEnv = host.process?.env?.[GPU_SCENE_VALIDATE_FLAG];
  if (typeof fromEnv === "string" && fromEnv !== "" && fromEnv !== "0" && fromEnv !== "false")
    return true;
  const query = globalThis.location?.search;
  if (
    typeof query === "string" &&
    /[?&]tnGpuSceneValidate=(?!0(?:&|$))(?!false(?:&|$))[^&]/u.test(query)
  )
    return true;
  return host.__tnGpuSceneValidate === true || host.__tnGpuSceneValidate === "1";
}

/** The launch flag. */
export const SHADOW_GPU_KEYS_FLAG = "TN_SHADOW_GPU_KEYS";

/**
 * Whether a shadow level may select its own set of GPU-scene keys. Opt-in, and off by default.
 *
 * @situation debug a walk whose shadow maps draw GPU-scene keys instead of cluster meshes
 * @constraint off unless a launch asks for it: without a provider nothing is allocated and no
 *   dispatch is submitted, so the flag alone cannot change a frame — `shadowGpuKeys: true`,
 *   `?tnShadowGpuKeys=1` or `TN_SHADOW_GPU_KEYS=1` turns it on. See PRD-478 phase 2.
 * @example world.gpuScene.shadowKeysFrom(() => keyNames);
 *
 * Read the way {@link bundlesRequested} reads its own: a native launch sets the environment
 * variable, a browser asks with the query string, and a test sets the global.
 */
export function shadowGpuKeysRequested(): boolean {
  return askedOn(SHADOW_GPU_KEYS_FLAG, "tnShadowGpuKeys", "__tnShadowGpuKeys");
}

/**
 * The GPU scene, owned by one `WorldCells`.
 *
 * The buffers exist once, and a capacity change replaces the attribute and the kernel with it — a
 * structural event, on the same cadence as a key being minted. Between two of them the per-frame
 * cost is one dispatch and six plane writes.
 */
export class WorldGpuScene {
  /** Resident placements, in the source buffer's own order; index 0 is the buffer's first record. */
  readonly placements: IGpuPlacement[] = [];
  readonly #regions: IRegion[] = [];
  readonly #keysByName = new Map<string, number>();
  /**
   * The shadow twins, allocated only once a provider has registered: their own args records and
   * their own drawn runs, and the keys that hold them. A twin of a key is its own record and run in
   * these buffers, at the layout the key already has — the main pass cannot have them, because its
   * compute submits before its indirect draws and a shared record would be zeroed in between.
   */
  #shadow: IShadowBuffers | undefined;
  #shadowProvider: (() => Iterable<string>) | undefined;
  #shadowKernel: { readonly cull: unknown; readonly clear: unknown } | undefined;
  readonly #slotsByAsset = new Map<string, IAssetSlot>();
  /** One level's parts per `asset:level`, which is what keeps them the run the kernel addresses. */
  readonly #groups = new Map<string, ILevelGroup>();
  /** Slot order, so a slot index is a position the `gates` buffer and the reference agree on. */
  readonly #order: string[] = [];
  /** Source records whose cell has left the ring, handed back before the buffer grows. */
  readonly #free: number[] = [];
  #buffers: IGpuSceneBuffers | undefined;
  #dispatched = 0;
  #drawnCapacity = 0;
  #live = 0;
  #on = false;
  #reason = "not-attached";
  /** Set by the one report this class ever prints, so a frame cannot repeat the line. */
  #reported = false;
  /** Bumped by every buffer swap, so a mesh re-dressed once knows if it still points at live data. */
  #version = 0;
  /** The kernel, rebuilt whenever a capacity changed under it. */
  #kernel: { readonly cull: unknown; readonly clear: unknown } | undefined;
  #planes = new Float32Array(24);

  /**
   * Turn the GPU scene on if this backend can run it, and say why not when it cannot. One line,
   * once, and never silent. `validate` holds every dispatch's args against the CPU reference; see
   * {@link gpuSceneValidationRequested}.
   */
  enable(
    renderer: IRendererLike | undefined,
    wanted: boolean,
    validate = false,
    tally = false,
    occlusion: OcclusionMode = "off",
  ): boolean {
    this.#validate = validate;
    this.#tally = tally || occlusion !== "off";
    this.#occlusion = occlusion;
    if (this.#on) return true;
    if (this.#reported) return false;
    if (renderer === undefined) {
      this.#reason = "no-renderer";
      return false;
    }
    if (wanted === false) {
      this.#reason = "option-off";
      this.#report(renderer);
      return false;
    }
    const unsupported = gpuSceneUnsupported(renderer);
    if (unsupported !== "") {
      this.#reason = unsupported;
      this.#report(renderer);
      return false;
    }
    this.#on = true;
    this.#reason = "on";
    this.#watchDevice(renderer);
    // Not printed here: the owner's own line is the one that says how many of its meshes are
    // dressed, and that number is only known once it has dressed them — see {@link announce}.
    return true;
  }

  /**
   * The one line, printed once, with the owner's census of dressed main meshes.
   *
   * `enable` announces every answer but "on", because a scene that is off has nothing to count. This
   * is the answer that does: the owner dresses the keys a ring built before the scene came up is
   * already holding, and only then can `dressed=N/M` say whether the dispatch has anything to draw
   * into. A caller with no owner of its own announces without a census, which reads `0/0`.
   */
  announce(
    renderer: IRendererLike,
    census?: { readonly dressed: number; readonly meshes: number },
  ): void {
    if (census !== undefined) this.#census = { dressed: census.dressed, meshes: census.meshes };
    this.#report(renderer);
  }

  /**
   * Hold the device's uncaptured errors, so a check can read them instead of the console.
   *
   * Three already chains its own `onuncapturederror` onto the same device and prints the message,
   * which is the whole reason a refused pipeline reads as a healthy run: the evidence was on screen
   * as a console line nothing compared against the counts. This wraps that handler rather than
   * replacing it, so three's own reporting still fires, and the last message is folded into the next
   * `TN_WORLD_GPU_SCENE_VALIDATE` line. Nothing is cleared except by a check that has reported it,
   * so an error that arrives between two checks still lands on the one after.
   */
  #watchDevice(renderer: IRendererLike): void {
    const device = (renderer.raw as { backend?: { device?: IDeviceLike } })?.backend?.device;
    if (device === undefined || this.#watched) return;
    this.#watched = true;
    const previous = device.onuncapturederror;
    device.onuncapturederror = (event: unknown): void => {
      this.#deviceError = uncapturedMessage(event);
      if (typeof previous === "function") previous.call(device, event);
    };
  }

  get on(): boolean {
    return this.#on;
  }

  /**
   * Bumped by every structural change — a key minted, retired or regrown, any buffer grown — so the
   * main meshes know their `instanceMatrix` and `setIndirect` may be pointing at a buffer the scene
   * has since replaced. It only moves on a structural event, so a settled frame never re-dresses.
   */
  get version(): number {
    return this.#version;
  }

  /** The shared compacted matrix buffer every main batch's `instanceMatrix` is. */
  get drawn(): StorageInstancedBufferAttribute | undefined {
    return this.#buffers?.drawn;
  }

  /** The one indirect record buffer every main key's `setIndirect` points into. */
  get args(): IndirectStorageBufferAttribute | undefined {
    return this.#buffers?.args;
  }

  /** The twin of {@link drawn}, once a provider has registered: a shadow key's `instanceMatrix`. */
  get shadowDrawn(): StorageInstancedBufferAttribute | undefined {
    return this.#shadow?.drawn;
  }

  /** The twin of {@link args}, once a provider has registered: a shadow key's indirect record. */
  get shadowArgs(): IndirectStorageBufferAttribute | undefined {
    return this.#shadow?.args;
  }

  /**
   * Every storage buffer with the WGSL type the kernel binds it as, so the allocation can be held
   * against the declaration without reading a pipeline.
   *
   * WebGPU refuses a bind whose buffer is under one element of its declared type, and the refusal is
   * an uncaptured validation error: the dispatch is invalid, the counts stay whatever the clear pass
   * wrote, and nothing downstream of it is measurable. The check is here because a run proved the
   * other way that a validation line reading `ok` over a kernel that had never run is worth less than
   * no line at all.
   */
  footprint(): Record<string, IGpuSceneBufferFootprint> {
    const out: Record<string, IGpuSceneBufferFootprint> = {};
    if (this.#buffers === undefined) return out;
    for (const [name, type] of [
      ...Object.entries(STORAGE_PLAIN),
      ["args", "uint"],
      ["drawn", "mat4"],
    ] as [BufferName, StorageType][]) {
      const buffer = this.#buffers[name] as BufferAttribute;
      out[name] = { type, count: buffer.count, bytes: buffer.array.byteLength };
    }
    // The twins only exist once a provider has registered, so a launch that never asked for them
    // reads exactly the footprint it had before this class learned about shadows.
    if (this.#shadow !== undefined) {
      out.shadowArgs = {
        type: "uint",
        count: this.#shadow.args.count,
        bytes: this.#shadow.args.array.byteLength,
      };
      out.shadowDrawn = {
        type: "mat4",
        count: this.#shadow.drawn.count,
        bytes: this.#shadow.drawn.array.byteLength,
      };
    }
    return out;
  }

  report(): IWorldGpuSceneReport {
    return {
      dispatches: this.#dispatched,
      instances: this.#live,
      keys: this.#regions.length,
      on: this.#on,
      reason: this.#reason,
      // Absent until a sample lands, never zero: "the GPU selected nothing" and "nothing has been
      // read back yet" are different facts, and a zero would merge them.
      ...(this.#tallySample < 0
        ? {}
        : {
            gpuInstances: this.#tallyInstances,
            gpuTallyAgeFrames: this.#dispatched - this.#tallySample,
            gpuTriangles: this.#tallyTriangles,
          }),
      ...(this.#occlusion === "off"
        ? {}
        : {
            occlusion: {
              ageFrames: this.#occlusionSample < 0 ? 0 : this.#dispatched - this.#occlusionSample,
              buildDispatches: this.#pyramid.levels,
              instances: this.#occludedInstances,
              levels: this.#pyramid.levels,
              meanInstances:
                this.#occlusionSamples === 0
                  ? 0
                  : Math.round(this.#occlusionSumInstances / this.#occlusionSamples),
              meanTriangles:
                this.#occlusionSamples === 0
                  ? 0
                  : Math.round(this.#occlusionSumTriangles / this.#occlusionSamples),
              mode: this.#occlusion,
              reason: this.#occlusionReason,
              samples: this.#occlusionSamples,
              gpuTriangles: this.#occlusionTotalTriangles,
              share:
                this.#occlusionTotalTriangles === 0
                  ? 0
                  : this.#occludedTriangles / this.#occlusionTotalTriangles,
              triangles: this.#occludedTriangles,
            },
          }),
    };
  }

  /**
   * The main pass's one key per `asset:level:part`: give it a region of the drawn buffer and an args
   * record, or hand back the ones it already has.
   *
   * A region is assigned once and never moves its args record, because `firstInstance` is written
   * into that record on the CPU and read by the draw. A key that outgrew its region is regrown into
   * a larger one at the tail, which is the only structural change a walk makes — and a key that is
   * one of a level's parts is regrown with its siblings, because the kernel addresses a level's parts
   * as one contiguous run and a part that moved alone would break that run. See {@link levelKeys}.
   */
  key(name: string, local: Float32Array, capacity: number, level?: ILevelKey): number | undefined {
    if (level !== undefined) return this.#levelKey(name, local, capacity, level);
    const existing = this.#keysByName.get(name);
    if (existing !== undefined) {
      const region = this.#regions[existing] as IRegion;
      if (region.capacity >= capacity) return existing;
      // A regrow: the old region is abandoned, the new one is the tail, and the args record's
      // `firstInstance` moves with it. Structural, so a bundle version may be bumped for it.
      this.#keysByName.set(name, this.#regions.length);
      this.#regions.push({ ...region, name, start: this.#drawnCapacity, capacity });
      this.#drawnCapacity += capacity;
      const regrown = this.#regions.length - 1;
      this.#growOf("keys", regrown + 1);
      this.#growOf("locals", regrown + 1);
      this.#growOf("args", argsWords(regrown + 1));
      this.#growDrawn();
      this.#writeKey(this.#regions.length - 1);
      return this.#regions.length - 1;
    }
    this.#ensure();
    const index = this.#mintRegion(name, local, capacity);
    this.#keysByName.set(name, index);
    return index;
  }

  /**
   * One region at the tail of the key index space, with its own args record and its own drawn run,
   * and every buffer wide enough to name it.
   *
   * The key index, the args record and the drawn run all move together here. A part that takes a
   * claimed slot replaces the region already standing there rather than pushing a new one, so it
   * inherits the args record the slot was written against and no geometry's indirect offset moves.
   */
  #mintRegion(name: string, local: Float32Array, capacity: number): number {
    const index = this.#regions.length;
    this.#regions.push({
      argsIndex: index,
      capacity,
      indexCount: 0,
      local,
      name,
      start: this.#drawnCapacity,
    });
    this.#drawnCapacity += capacity;
    this.#growOf("keys", index + 1);
    this.#growOf("locals", index + 1);
    this.#growOf("args", argsWords(index + 1));
    this.#growDrawn();
    this.#writeKey(index);
    return index;
  }

  /**
   * One part of a level, in the level's own run: minted into the slot `firstKey + part` names, and
   * regrown with its siblings.
   *
   * The run is what makes `firstKey + part` mean the right key, so it is claimed whole at the level's
   * first key and read back through {@link levelKeys} rather than by the caller remembering which
   * index it saw first. A part of the level nothing has asked for yet holds its slot as a
   * capacity-zero region: the gate table names the whole run, the kernel reads a part's capacity
   * before it writes into it, and a part with no mesh draws nothing at its own index. Each part
   * keeps its own args record, so minting a later part re-lays no indirect offset and re-dresses no
   * mesh.
   */
  #levelKey(
    name: string,
    local: Float32Array,
    capacity: number,
    level: ILevelKey,
  ): number | undefined {
    if (this.#ensure() === undefined) return undefined;
    let held = this.#groups.get(level.group);
    if (held === undefined) {
      held = {
        capacity,
        firstKey: this.#regions.length,
        minted: new Map<number, number>(),
        parts: level.parts,
      };
      this.#groups.set(level.group, held);
      for (let part = 0; part < level.parts; part += 1)
        this.#mintRegion(`${level.group}:${String(part)}`, NO_LOCAL, 0);
    }
    // A part the level did not declare is refused rather than laid over the next level's key, which
    // is the one mistake this method exists to stop.
    if (level.part >= held.parts) return undefined;
    const index = held.firstKey + level.part;
    const opened = held.minted.has(level.part) === false;
    const grew = capacity > held.capacity;
    if (grew) held.capacity = capacity;
    // A part already laid out at this capacity keeps its run: registering it again is not a
    // structural change. Laying the level out again appended the whole group to the tail of the drawn
    // buffer every call, so a frame that only re-dressed the ring grew the buffer by the level, the
    // next frame's re-dress grew it by the level again, and the buffer doubled until the device
    // refused the allocation. Only opening a part or outgrowing the capacity moves the run.
    if (opened === false && grew === false) {
      const settled = this.#regions[index] as IRegion;
      this.#keysByName.set(name, index);
      // A fresh `Float32Array` of the same offset is the same offset: a re-dress copies the part's
      // matrix out each time, so comparing identity would re-upload the key table for nothing.
      if (settled.name !== name || sameLocal(settled.local, local) === false) {
        this.#regions[index] = { ...settled, local, name };
        this.#writeKey(index);
      }
      return index;
    }
    const slot = this.#regions[index] as IRegion;
    this.#keysByName.set(name, index);
    this.#regions[index] = {
      argsIndex: index,
      capacity: held.capacity,
      indexCount: slot.indexCount,
      local,
      name,
      start: slot.start,
    };
    held.minted.set(level.part, index);
    // A structural change re-packs every run from zero, so the buffer is bounded by the runs that
    // exist rather than by every run ever abandoned in a relocation. See {@link #relayout}.
    this.#drawnCapacity = this.#relayout();
    this.#growDrawn();
    // The live buffers, not the ones this method read: a regrow above may have replaced them.
    this.#writeAllKeys();
    return index;
  }

  /**
   * The keys one level's parts draw into, which is what the gate table needs and the kernel assumes.
   *
   * The run the level claimed, read back rather than measured off the parts that happen to be
   * minted: measuring it is what let another level's keys inside a run whose parts were minted apart.
   */
  levelKeys(group: string): { readonly firstKey: number; readonly parts: number } | undefined {
    const held = this.#groups.get(group);
    if (held === undefined || held.minted.size === 0) return undefined;
    return { firstKey: held.firstKey, parts: held.parts };
  }

  /**
   * Pack every region from the front of the drawn buffer, answering where it now ends.
   *
   * A level that opens a part or outgrows its capacity needs a new run, and appending only that level
   * at the tail left its old run behind: a walk that streamed for a while relocated the same levels
   * over and over, and the drawn buffer grew by every abandoned run until the device refused the
   * allocation. Packing every region from zero on a structural change keeps the buffer bounded by the
   * runs that exist — the sum of each level's own run, which is what a resident world holds.
   *
   * Non-grouped keys keep their order and their own capacity first; a level's parts follow together
   * in part order, which is the run the kernel addresses as `firstKey + part`. Unminted parts hold a
   * capacity-zero slot and take no room.
   */
  #relayout(): number {
    const grouped = new Set<number>();
    for (const held of this.#groups.values())
      for (let part = 0; part < held.parts; part += 1) grouped.add(held.firstKey + part);
    let start = 0;
    for (const [index, region] of this.#regions.entries()) {
      if (grouped.has(index)) continue;
      region.start = start;
      start += region.capacity;
    }
    for (const held of this.#groups.values()) {
      const ordered = [...held.minted.entries()].sort((one, other) => one[0] - other[0]);
      for (const [, index] of ordered) {
        const region = this.#regions[index] as IRegion;
        region.start = start;
        region.capacity = held.capacity;
        start += held.capacity;
      }
    }
    return start;
  }

  /**
   * Re-write every key's gate and args record, which a re-layout moved, against the live buffers —
   * a grow inside the layout may have replaced them, so the set the caller held is not the one a
   * draw and the kernel will read.
   */
  #writeAllKeys(): void {
    for (let index = 0; index < this.#regions.length; index += 1) this.#writeKey(index);
  }

  /** The region one key draws from, for the counters and the tests. */
  regionOf(name: string): IRegion | undefined {
    const index = this.#keysByName.get(name);
    return index === undefined ? undefined : this.#regions[index];
  }

  /**
   * The index count the dressed geometry draws with, recorded against the key the owner dressed.
   *
   * A `DrawIndexedIndirect` record names no triangles at all when its `indexCount` is zero, and the
   * scene cannot know what shape a key draws: the owner holds the geometry. So the owner says, and
   * the validation holds the record against what it said — a draw that is submitted, counted, and
   * draws nothing is the one failure a count cannot see.
   */
  indexCount(name: string, count: number): void {
    const index = this.#keysByName.get(name);
    if (index === undefined) return;
    (this.#regions[index] as IRegion).indexCount = count;
    // The record is what the GPU draws from: a count kept only for validation left every indirect
    // draw at `indexCount` 0, submitted and counted, drawing nothing.
    this.#writeKey(index);
  }

  /**
   * The gates one asset's levels are crossed at, registered the first time any of its keys is
   * minted. Distances and cull distance are the CPU path's own numbers, so the same placement
   * reaches the same level wherever the level is decided.
   */
  slot(asset: string, definition: IAssetSlot): number {
    const at = this.#order.indexOf(asset);
    if (at >= 0 && sameGates(this.#slotsByAsset.get(asset) as IAssetSlot, definition)) return at;
    if (this.#ensure() === undefined) return SLOT_NONE;
    this.#slotsByAsset.set(asset, definition);
    if (at < 0) this.#order.push(asset);
    this.#writeSlots();
    return at < 0 ? this.#order.length - 1 : at;
  }

  /** The gates a slot index names, which is what the kernel and the reference both read. */
  gates(): readonly IAssetSlot[] {
    return this.#order.map((asset) => this.#slotsByAsset.get(asset) as IAssetSlot);
  }

  /**
   * The asset id a slot index names, which is how the owner looks its own live gates up.
   *
   * The identity and nothing else: no distance, no cull, no level — the check that must not read
   * this class's tables gets its numbers from the owner and comes here only for the name of the
   * asset a placement belongs to, which the placement itself does not carry.
   */
  slotAsset(slot: number): string | undefined {
    return this.#order[slot];
  }

  /** The regions the keys own, in key order, which is what the kernel's `keys` buffer holds. */
  get regions(): readonly IRegion[] {
    return this.#regions;
  }

  /**
   * Take a source record for one placement, or `undefined` when the buffer is full. A record is
   * 24 words: the world matrix, the sphere and the asset slot, which is everything the kernel reads.
   */
  place(
    asset: number,
    matrix: Matrix4,
    x: number,
    y: number,
    z: number,
    radius: number,
    scale = 1,
  ): number {
    const reused = this.#free.pop();
    const index = reused ?? this.placements.length;
    if (reused === undefined && this.#reserve(index + 1) === false) return -1;
    let placement = this.placements[index];
    if (placement === undefined) {
      placement = {
        centre: new Float32Array(4),
        matrix: new Float32Array(LOCAL_WORDS),
        scale: 1,
        slot: SLOT_NONE,
      };
      this.placements[index] = placement;
    }
    placement.matrix.set(matrix.elements);
    placement.centre[0] = x;
    placement.centre[1] = y;
    placement.centre[2] = z;
    placement.centre[3] = radius;
    placement.slot = asset;
    placement.scale = Number.isFinite(scale) ? scale : 1;
    this.#live += 1;
    this.#writePlacement(index);
    return index;
  }

  /** Hand a source record back; the kernel skips a released one and the slot is reused. */
  release(index: number): void {
    const placement = this.placements[index];
    if (placement === undefined || placement.slot < 0) return;
    placement.slot = SLOT_NONE;
    this.#live -= 1;
    this.#free.push(index);
    this.#writePlacement(index);
  }

  /**
   * Sets the adaptive LOD bias the kernel scales camera distance by, `>= 1`. The shared CPU
   * `setLodBias` holds the same number; `WorldCells` writes both. A non-finite or below-1 value is
   * no reading and resets to 1, matching the CPU clamp.
   */
  setLodBias(bias: number): void {
    this.#lodBias.value = Number.isFinite(bias) && bias >= 1 ? bias : 1;
  }

  /**
   * Register who owns the shadow keys. Until something does, nothing is allocated and
   * {@link dispatchShadow} submits nothing.
   *
   * The provider is asked for the keys a shadow map draws at dispatch time rather than once here, so
   * a key minted after the registration is a twin of the same pass that first needs it. It names the
   * keys, not their contents: a twin is its main key's record and run in the twin buffers, at the
   * layout that key already holds.
   *
   * A launch without `?tnShadowGpuKeys=1` (or the environment variable, or the global) registers
   * nothing, so the flag alone cannot put a buffer on the device. See {@link shadowGpuKeysRequested}.
   */
  shadowKeysFrom(provider: () => Iterable<string>): void {
    if (shadowGpuKeysRequested() === false) return;
    this.#shadowProvider = provider;
  }

  /** Whether a provider has registered, which is the whole of what turns the shadow path on. */
  get shadowKeys(): boolean {
    return this.#shadowProvider !== undefined;
  }

  /**
   * Name one key's shadow twin now, rather than waiting for the dispatch that first needs it: the
   * mesh that draws it has to be dressed against a record that exists, and a record minted inside
   * the render it would draw in is one frame late for every key.
   *
   * The same {@link #mintShadowKeys} the dispatch runs, for one name — idempotent, and a no-op
   * without a registered provider, which is what keeps the flag from allocating anything on its own.
   */
  shadowKey(name: string): void {
    if (this.#shadowProvider === undefined) return;
    this.#mintShadowKeys([name]);
  }

  /** The region one key's shadow twin draws from, for the counters and the tests. */
  shadowRegionOf(name: string): IRegion | undefined {
    const index = this.#shadow?.keys.get(name);
    return index === undefined ? undefined : this.#regions[index];
  }

  /**
   * One shadow level's set: zero every twin's instance count, then cull and LOD-select every resident
   * placement against the map's own light frustum, the main pass's eye and level, its texel gate
   * and the chain level it draws at — into the twin buffers, which the main pass cannot be holding.
   *
   * The twin of the main kernel branch for branch, and reading the main pass's own gate table,
   * placements and key table: a shadow map draws the same shapes, only a different set of them.
   * A no-op without a registered provider, which is the only way this can be switched on.
   */
  dispatchShadow(renderer: IRendererLike, level: IShadowLevel): void {
    const provider = this.#shadowProvider;
    if (provider === undefined || this.#on === false || this.#buffers === undefined) return;
    // Minted here, so a twin is never older than the key it twins; the growth is a structural event
    // and the kernel below is rebuilt against the buffers that replaced the old ones.
    this.#mintShadowKeys(provider());
    const kernel = this.#shadowKernel ?? this.#buildShadowKernel();
    if (kernel === undefined) return;
    for (const [index, plane] of this.#shadowPlaneVectors.entries()) {
      const at = index * 4;
      plane.set(
        level.planes[at] as number,
        level.planes[at + 1] as number,
        level.planes[at + 2] as number,
        level.planes[at + 3] as number,
      );
    }
    this.#shadowGate.value = level.gate;
    this.#shadowBase.value = level.base;
    // `(placements, slots, keys, keys)`: the last two are the same count, and the clear dispatch is
    // one thread per key. The main pass writes the same uniform before its own pair.
    const keys = this.#regions.length;
    this.#counts.value.set(this.placements.length, this.#order.length, keys, keys);
    // One pass holds both kernels: storage writes reach the next dispatch, so clear precedes cull.
    renderer.compute([kernel.clear, kernel.cull]);
  }

  /**
   * One frame of the main pass: zero every key's instance count, then cull and LOD-select every
   * resident placement into the shared drawn buffer. Nothing else is written.
   */
  dispatch(renderer: IRendererLike, camera: Camera): void {
    if (this.#on === false) return;
    if (this.#buffers === undefined) return;
    cameraPlanes(camera, this.#planes);
    for (const [index, plane] of this.#planeVectors.entries()) {
      const at = index * 4;
      plane.set(
        this.#planes[at] as number,
        this.#planes[at + 1] as number,
        this.#planes[at + 2] as number,
        this.#planes[at + 3] as number,
      );
    }
    _eye.setFromMatrixPosition(camera.matrixWorld);
    this.#eye.value.copy(_eye);
    // `(placements, slots, keys, keys)`: the last two are the same count, and the clear dispatch is
    // one thread per key.
    if (this.#occlusion !== "off") this.#measureOcclusion(renderer, camera);
    // Measurement may replace the pyramid buffer on first use or resize. Bind the new buffer in
    // this frame's cull, rather than dispatching a kernel captured before the replacement.
    const kernel = this.#kernel ?? this.#buildKernel();
    if (kernel === undefined) return;
    const keys = this.#regions.length;
    this.#counts.value.set(this.placements.length, this.#order.length, keys, keys);
    // One pass holds both kernels: storage writes reach the next dispatch, so clear precedes cull.
    renderer.compute([kernel.clear, kernel.cull]);
    this.#dispatched += 1;
    if (
      this.#validate === true &&
      this.#manualOnly === false &&
      this.#validating === false &&
      this.#dispatched % VALIDATE_EVERY === 0
    )
      this.#compare(renderer);
    // A validation's own readback already holds the args, so it feeds the tally and this never adds
    // a second copy beside it. With validation off the tally reads on its own slower clock, and a
    // frame whose predecessor has not landed is skipped rather than queued.
    else if (
      this.#validate === false &&
      this.#tally === true &&
      (this.#occlusion === "off" || this.#occlusionCut.value === 0) &&
      this.#tallyPending === false &&
      (this.#tallyRequested < 0 || this.#dispatched - this.#tallyRequested >= TALLY_EVERY)
    )
      this.#tallyRead(renderer);
  }

  /**
   * One frame of `?tnOcclusion=measure`: rebuild the max-distance chain from the depth the previous
   * frame's scene pass left behind, and point the test at the camera that depth was rendered with.
   *
   * The depth is last frame's on purpose. This runs in `beforeRender`, before the frame's own scene
   * pass draws, so the texture still holds what the last one wrote — which is the only depth there
   * is, and the reason the test reprojects rather than sampling the current frame.
   *
   * With no scene-pass depth — no render chain installed, so nothing rendered into a target of its
   * own — the mode refuses and says so in `report().occlusion.reason` rather than reporting nothing
   * hidden and reading as a cull that found no work.
   */
  #measureOcclusion(renderer: IRendererLike, camera: Camera): void {
    this.#occlusionCut.value = 1;
    // The main pass returns on an orthographic camera before it gets here (that is a shadow level's
    // own), and a linear depth in metres is a perspective projection's to begin with.
    if (!(camera instanceof PerspectiveCamera)) {
      this.#previousDepth = undefined;
      this.#occlusionReason = "refused: not a perspective camera";
      return;
    }
    const raw = renderer.raw as { logarithmicDepthBuffer?: boolean; reversedDepthBuffer?: boolean };
    if (raw?.logarithmicDepthBuffer || raw?.reversedDepthBuffer || camera.reversedDepth) {
      this.#previousDepth = undefined;
      this.#occlusionReason = "refused: nonstandard depth";
      return;
    }
    const depth = renderer.scenePassDepth?.();
    const width = depth?.width ?? 0;
    const height = depth?.height ?? 0;
    if (depth === undefined || width < 2 || height < 2) {
      this.#previousDepth = undefined;
      this.#occlusionReason = "refused: no scene depth";
      return;
    }
    this.#occlusionReason = "";
    // A resized depth resizes the chain, and the chain's two buffers are what the cull kernel reads,
    // so a new chain is a new pipeline: structural, like every other grow in this class.
    const resized = this.#pyramid.resize(width, height);
    if (resized) {
      this.#kernel = undefined;
      this.#version += 1;
    }
    _view.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _eye.setFromMatrixPosition(camera.matrixWorld);
    // A cut skips the test for the frame: a teleport moved the camera further than a walk step, and
    // a projection change means the pyramid is a different camera's depth altogether.
    // ponytail: 2 m of camera travel in one dispatch is a cut. A game that teleports further per
    // step than that raises the bound; one that cuts under it gets a frame of frustum-only.
    const samples = depth.samples ?? 1;
    const previous = this.#previousDepth;
    const depthChanged =
      previous?.texture !== depth.texture ||
      previous.width !== width ||
      previous.height !== height ||
      previous.samples !== samples ||
      previous.version !== depth.texture.version;
    this.#occlusionCut.value =
      depthChanged ||
      resized ||
      !sameProjection(this.#previousProjection, camera.projectionMatrix) ||
      _eye.distanceTo(this.#previousEye) > OCCLUSION_CUT_METRES
        ? 1
        : 0;
    if (this.#occlusionCut.value !== 0)
      this.#occlusionReason =
        depthChanged || resized ? "skipped: depth changed" : "skipped: camera cut";
    this.#previousDepth = {
      texture: depth.texture,
      width,
      height,
      samples,
      version: depth.texture.version,
    };
    this.#previousProjection.copy(camera.projectionMatrix);
    // The chain first, then the camera the chain belongs to: last frame's, which is what the
    // previous frame's depth recorded.
    this.#pyramid.build(renderer, depth.texture, camera.near, camera.far, samples);
    this.#occlusionMatrix.copy(this.#previousView);
    this.#previousView.copy(_view);
    this.#previousEye.copy(_eye);
  }

  /**
   * What the last landed readback found, so a harness can read the answer without the log: the
   * verdict, how many keys it actually compared, how many disagreed on the count, how many on what
   * the draw reads, how many dressed meshes drew instances their own key never owned, and the lines.
   */
  get validation(): {
    readonly verdict: GpuSceneVerdict;
    readonly compared: number;
    readonly mismatched: number;
    readonly matricesMismatched: number;
    readonly meshMismatched: number;
    readonly lines: readonly string[];
  } {
    return {
      verdict: this.#verdict,
      compared: this.#compared,
      mismatched: this.#mismatches,
      matricesMismatched: this.#matrixMismatches,
      meshMismatched: this.#meshMismatches,
      lines: this.#lines,
    };
  }

  /**
   * Read back the dispatch that just ran, once, and resolve only after both targets have settled.
   *
   * This is an opt-in diagnostic seam for a harness that must fence one rendered frame before it
   * advances the fixed-step clock. It does not change the periodic validation path or production
   * dispatches; a caller that asks twice for one dispatch is refused rather than silently counting
   * one frame twice.
   */
  validateCurrentDispatch(
    renderer: IRendererLike,
    frame: number,
  ): Promise<IWorldGpuFrameValidation> {
    if (!Number.isInteger(frame) || frame < 0)
      return Promise.reject(
        new Error("World GPU frame validation needs a non-negative integer frame."),
      );
    if (this.#on === false)
      return Promise.reject(new Error("World GPU scene validation is unavailable."));
    if (this.#dispatched <= 0)
      return Promise.reject(new Error("World GPU frame validation needs a completed dispatch."));
    if (this.#validating)
      return Promise.reject(
        new Error("World GPU frame validation already has a pending readback."),
      );
    if (this.#manualDispatch === this.#dispatched)
      return Promise.reject(new Error("World GPU dispatch was already manually validated."));
    this.#manualOnly = true;
    this.#manualDispatch = this.#dispatched;
    return this.#compare(renderer, frame);
  }

  /**
   * Where the independent per-mesh check gets the CPU path's own records, registered once by the
   * owner and asked only on a check's frame.
   *
   * The scene cannot answer this for itself: the records are the owner's, and the meshes whose
   * indirect offsets are the question are the owner's too. It is asked inside {@link compare}, before
   * the readback is issued, so the instances it compares are the ones the dispatch just read rather
   * than whatever the cells hold when the bytes land — the same snapshot rule the rest of the check
   * is built on, and the reason a walk that streams while a readback is in flight cannot make the
   * check compare two different worlds.
   */
  drawsFrom(provider: () => readonly IMeshDraw[]): void {
    this.#draws = provider;
  }

  #draws: (() => readonly IMeshDraw[]) | undefined;
  #mismatches = 0;
  #matrixMismatches = 0;
  #meshMismatches = 0;
  #compared = 0;
  #verdict: GpuSceneVerdict = "ok";
  #lines: string[] = [];
  #validate = false;
  #validating = false;
  /** Manual frame fences replace periodic samples after the first completed fence. */
  #manualOnly = false;
  /** The last dispatch a manual frame fence consumed; periodic checks do not move this. */
  #manualDispatch = -1;
  /** Reused MAP_READ buffers keep validation from allocating two fresh GPU buffers on every check. */
  #validationReadbacks: IValidationReadbacks | undefined;
  /** Whether the owner asked for the GPU-selected main-pass tally; a validation turns it on too. */
  #tally = false;
  /** What a launch asked the pyramid occlusion test to do. `measure` never changes what is drawn. */
  #occlusion: OcclusionMode = "off";
  /** The max-distance chain, and the previous frame's camera the test reprojects into. */
  readonly #pyramid = new DepthPyramid();
  readonly #previousView = new Matrix4();
  readonly #previousProjection = new Matrix4();
  #previousDepth:
    | {
        texture: DepthTexture;
        width: number;
        height: number;
        samples: number;
        version: number;
      }
    | undefined;
  readonly #previousEye = new Vector3();
  /** The previous view the occlusion test reprojects into; its uniform is made by the first kernel
   * that reads it, so a world whose GPU scene never builds one asks the backend for no mat4 uniform. */
  readonly #occlusionMatrix = new Matrix4();
  #occlusionView: ReturnType<typeof uniform> | undefined;
  readonly #occlusionCut = uniform(1);
  /** Why the measure mode measured nothing, or `""` while it is measuring. */
  #occlusionReason = "";
  /** The last landed tally's occlusion counts, and the running mean over every sample. */
  #occludedInstances = 0;
  #occludedTriangles = 0;
  #occlusionTotalTriangles = 0;
  #occlusionSample = -1;
  #occlusionSamples = 0;
  #occlusionSumInstances = 0;
  #occlusionSumTriangles = 0;
  #tallyPending = false;
  /** Dispatch the in-flight tally readback was issued on, or `-1` when none is in flight. */
  #tallyRequested = -1;
  /** Dispatch whose GPU state the landed tally bytes hold, or `-1` before the first lands. */
  #tallySample = -1;
  #tallyInstances = 0;
  #tallyTriangles = 0;
  #watched = false;
  /**
   * The main meshes the owner has dressed against these buffers, and the main meshes it holds. It is
   * the owner's, not this class's: a scene that reports itself on over a ring it never dressed was
   * invisible from here, and `dressed=0/21094` is what a real run printed. See {@link announce}.
   */
  #census = { dressed: 0, meshes: 0 };
  /** The device's last uncaptured error, reported by the next check and then cleared. */
  #deviceError = "";

  /**
   * Ask for the indirect args back, once, and tally what the GPU selected into them.
   *
   * This is the certificate the frame budget could not have: `renderer.info.render.triangles` counts
   * a mesh's CPU window, which for an indirect draw is its capacity and therefore an upper bound,
   * while the args record holds the instance count the kernel actually wrote. The readback is the
   * same one a validation uses — the renderer's one staging buffer — on a slower clock, and a frame
   * whose predecessor is still in flight is skipped rather than queued.
   */
  #tallyRead(renderer: IRendererLike): void {
    const args = this.#buffers?.args;
    if (args === undefined) return;
    const issued = this.#dispatched;
    this.#tallyRequested = issued;
    this.#tallyPending = true;
    // Streaming may grow the args tail while this copy is in flight. Decode its own layout.
    const regions = this.#regions.map((region) => ({ argsIndex: region.argsIndex }));
    const occlusionReason = this.#occlusionReason;
    renderer
      .readback(args)
      .then((bytes) => this.#landTally(bytes, issued, regions, occlusionReason))
      .catch(() => {
        this.#tallyPending = false;
      });
  }

  /**
   * Sum the landed args records: `instanceCount` over every record, and `instanceCount x indexCount`
   * divided by three. A record the GPU never wrote reads as the zero it holds, which is correct —
   * a key that selected nothing draws nothing.
   */
  #landTally(
    bytes: ArrayBuffer,
    issued: number,
    regions: readonly Pick<IRegion, "argsIndex">[],
    occlusionReason: string,
  ): void {
    this.#tallyPending = false;
    const words = new Uint32Array(bytes);
    let instances = 0;
    let products = 0;
    for (const region of regions) {
      const record = region.argsIndex * DRAW_ARGS_WORDS;
      const count = word(words, record + 1);
      instances += count;
      products += count * word(words, record);
    }
    this.#tallyInstances = instances;
    this.#tallyTriangles = products / 3;
    this.#tallySample = issued;
    if (this.#occlusion !== "off") this.#landOcclusion(words, issued, regions, occlusionReason);
  }

  /**
   * What the measured cull hid, out of the same landed bytes as the drawn counts.
   *
   * The tail of the args buffer is one word per key of measured-occlusion instances, so a hidden
   * part's triangles are that word times its own `indexCount` — the same product the tally above
   * sums over the records, which is why both numbers can be divided into a share without a second
   * readback or a second clock.
   */
  #landOcclusion(
    words: Uint32Array,
    issued: number,
    regions: readonly Pick<IRegion, "argsIndex">[],
    sampleReason: string,
  ): void {
    let reason = sampleReason;
    const tail = regions.length * DRAW_ARGS_WORDS;
    if (reason === "" && words.length < tail + regions.length) reason = "skipped: short readback";
    if (
      reason === "" &&
      regions.some(
        (region, index) =>
          word(words, tail + index) > word(words, region.argsIndex * DRAW_ARGS_WORDS + 1),
      )
    )
      reason = "skipped: inconsistent readback";
    if (reason !== "") {
      this.#occlusionReason = reason;
      console.info(
        `TN_WORLD_GPU_SCENE_OCCLUSION mode=${this.#occlusion} dispatch=${String(issued)} skipped=1 reason=${reason}`,
      );
      return;
    }
    let instances = 0;
    let products = 0;
    for (const [index, region] of regions.entries()) {
      const count = word(words, regions.length * DRAW_ARGS_WORDS + index);
      instances += count;
      products += count * word(words, region.argsIndex * DRAW_ARGS_WORDS);
    }
    this.#occludedInstances = instances;
    this.#occludedTriangles = products / 3;
    this.#occlusionReason = "";
    this.#occlusionSample = issued;
    this.#occlusionTotalTriangles = this.#tallyTriangles;
    this.#occlusionSamples += 1;
    this.#occlusionSumInstances += instances;
    this.#occlusionSumTriangles += this.#occludedTriangles;
    const report = this.report().occlusion;
    if (report === undefined) return;
    const line =
      `TN_WORLD_GPU_SCENE_OCCLUSION mode=${report.mode} levels=${String(report.levels)} ` +
      `dispatch=${String(issued)} reason=${report.reason || "none"} ` +
      `wouldCullInstances=${String(report.instances)} wouldCullTriangles=${String(report.triangles)} ` +
      `gpuInstances=${String(this.#tallyInstances)} gpuTriangles=${String(this.#tallyTriangles)} ` +
      `share=${report.share.toFixed(4)}`;
    console.info(line);
  }

  /**
   * Read the indirect args and the compacted matrices back and hold both against the reference, over
   * the placements, camera and gate table the dispatch just read — copied at this moment, in this
   * turn, so a structural change landing while the bytes are in flight changes nothing about what
   * they are held against.
   *
   * The reference is {@link cullAndSelect} on the CPU, so this is the kernel measured against the
   * loop it mirrors — the only place the TSL itself is ever checked. It costs two queue submissions
   * and two mapped buffers every {@link VALIDATE_EVERY} dispatches, which is why it is a mode and
   * not a default: a game never pays for it and a walk is never measured with it on. One check is in
   * flight at a time, so every report answers a dispatch of its own.
   *
   * The counts alone are not the draw: a key can land every instance it owes into a record whose
   * `firstInstance` points at the wrong run, or whose `indexCount` names no triangle, or into a
   * region the mesh does not read — and a real WebGPU walk printed `ok` over 200 keys whose
   * `indexCount` was zero, with the forest it was supposed to draw missing from the picture and its
   * shadows still on the ground. So the matrices are read back too, and the same check that reads
   * them holds the record's two CPU-owned words against what the key's geometry and layout say.
   *
   * And the third check reads nothing this file wrote: the owner's own dressed meshes, each with the
   * indirect record its own geometry points at, against the instances the owner's own CPU path
   * composes for the key that mesh is named. Both families above can only confirm that the kernel
   * and the reference agree, which a wrong key-to-record mapping makes them agree on; only these two
   * were not written by the same hand. See {@link compareMeshDraws}.
   */
  #compare(renderer: IRendererLike, frame = -1): Promise<IWorldGpuFrameValidation> {
    const snapshot = this.#snapshot();
    if (snapshot.args === undefined || snapshot.drawn === undefined)
      return Promise.reject(new Error("World GPU frame validation has no dispatched buffers."));
    const reference = cullAndSelect(snapshot);
    // Taken now, with the snapshot, and not when the readback lands: see `drawsFrom`.
    const draws = this.#draws?.() ?? [];
    const issued = this.#dispatched;
    const readbacks = this.#readbacksFor(snapshot);
    this.#validating = true;
    const occlusionReason = this.#occlusionReason;
    const reads = [
      renderer.readback(snapshot.args, readbacks.args),
      renderer.readback(snapshot.drawn, readbacks.drawn),
    ] as const;
    const complete = Promise.all(reads)
      .then(([argsBytes, drawnBytes]) => {
        // The same landed args feed the tally, so a validation pays for it and this adds no copy.
        this.#landTally(argsBytes, issued, snapshot.regions, occlusionReason);
        const input = this.#against(
          snapshot,
          reference,
          new Uint32Array(argsBytes),
          new Float32Array(drawnBytes),
          draws,
        );
        const report = this.#publish(renderer, input);
        return { ...input, dispatch: issued, frame, verdict: report.verdict };
      })
      .catch((reason: unknown) => {
        // A readback that never lands is a check that never ran, and saying so is the whole point:
        // this line used to end the chain and leave the last verdict standing as if it were fresh.
        const input: IGpuSceneComparison = {
          cause: `readback-failed: ${String(reason instanceof Error ? reason.message : reason)}`,
          compared: 0,
          deviceError: this.#deviceError,
          instancesCpu: 0,
          instancesGpu: 0,
          matricesMismatched: 0,
          meshMismatched: 0,
          meshMismatches: [],
          mismatched: 0,
          mismatches: [],
          matrixMismatches: [],
          placed: snapshot.placed,
        };
        const report = this.#publish(renderer, input);
        return { ...input, dispatch: issued, frame, verdict: report.verdict };
      });
    // Promise.all reports the first failure, but its rejection does not mean the other GPU copy has
    // stopped. Release only after both copies settle, so a pending map cannot race a reused target.
    return complete.finally(async () => {
      await Promise.allSettled(reads);
      readbacks.args.release();
      readbacks.drawn.release();
      if (this.#validationReadbacks !== readbacks) {
        readbacks.args.dispose();
        readbacks.drawn.dispose();
      }
      this.#validating = false;
    });
  }

  #readbacksFor(snapshot: IValidationSnapshot): IValidationReadbacks {
    const argsBytes = Math.max(
      4,
      (snapshot.args as { array: { byteLength: number } }).array.byteLength,
    );
    const drawnBytes = Math.max(
      4,
      (snapshot.drawn as { array: { byteLength: number } }).array.byteLength,
    );
    const current = this.#validationReadbacks;
    if (
      current !== undefined &&
      current.args.maxByteLength >= argsBytes &&
      current.drawn.maxByteLength >= drawnBytes
    )
      return current;
    current?.args.dispose();
    current?.drawn.dispose();
    this.#validationReadbacks = {
      args: new ReadbackBuffer(argsBytes),
      drawn: new ReadbackBuffer(drawnBytes),
    };
    return this.#validationReadbacks;
  }

  /**
   * A copy of everything the dispatch that is running right now reads: the source records, the slot
   * and gate tables, the region and args layout, the frustum planes and the eye.
   *
   * One flat array holds the placement records and each copy is a view into it, so a twenty-thousand
   * placement walk costs one allocation rather than forty thousand. The gate and region tables are
   * copied shallowly, which is whole: an asset's gate definition is replaced rather than edited, and
   * a region is spread into a fresh object, so nothing reachable from a snapshot can move under it.
   */
  #snapshot(): IValidationSnapshot {
    const flat = new Float32Array(this.placements.length * PLACEMENT_WORDS);
    const placements = this.placements.map((placement, index) => {
      const at = index * PLACEMENT_WORDS;
      flat.set(placement.matrix, at);
      flat.set(placement.centre, at + LOCAL_WORDS);
      return {
        centre: flat.subarray(at + LOCAL_WORDS, at + LOCAL_WORDS + 4),
        matrix: flat.subarray(at, at + LOCAL_WORDS),
        scale: placement.scale,
        slot: placement.slot,
      };
    });
    return {
      args: this.#buffers?.args,
      camera: {
        planes: this.#planes.slice(),
        x: this.#eye.value.x,
        y: this.#eye.value.y,
        z: this.#eye.value.z,
      },
      count: placements.length,
      drawn: this.#buffers?.drawn,
      placed: this.#live,
      placements,
      regionCount: this.#regions.length,
      regions: this.#regions.map((region) => ({ ...region, local: region.local.slice() })),
      slots: this.gates().map((slot) => ({ ...slot })),
    };
  }

  /** One readback's bytes against its own dispatch's reference: the counts, then the draw, then the meshes. */
  #against(
    snapshot: IValidationSnapshot,
    reference: IKernelResult,
    gpu: Uint32Array,
    drawn: Float32Array,
    draws: readonly IMeshDraw[],
  ): IGpuSceneComparison {
    const mismatches: string[] = [];
    const matrixMismatches: string[] = [];
    let mismatched = 0;
    let matricesMismatched = 0;
    let instancesGpu = 0;
    let instancesCpu = 0;
    for (const [index, region] of snapshot.regions.entries()) {
      const record = region.argsIndex * DRAW_ARGS_WORDS;
      // A readback that landed short is a mismatch, not a hole in the report: `word` reads out of
      // range as the zero a record that was never written holds.
      const landed = word(gpu, record + 1);
      const expected = reference.counts[index] as number;
      instancesGpu += landed;
      instancesCpu += expected;
      if (landed !== expected) {
        mismatched += 1;
        if (mismatches.length < VALIDATE_REPORTED_KEYS)
          mismatches.push(
            `${region.name ?? `#${String(index)}`} gpu=${String(landed)} cpu=${String(expected)}`,
          );
      }
      const firstInstance = word(gpu, record + 4);
      const indexCount = word(gpu, record);
      const agrees =
        firstInstance === region.start &&
        indexCount === region.indexCount &&
        sameMatrices(
          drawn,
          firstInstance,
          landed,
          reference.drawn,
          region.start,
          expected,
          MATRIX_TOLERANCE,
        );
      if (agrees) continue;
      matricesMismatched += 1;
      if (matrixMismatches.length < MATRIX_REPORTED_KEYS)
        matrixMismatches.push(
          `${region.name ?? `#${String(index)}`} ` +
            `first gpu=${xyz(drawn, firstInstance)} cpu=${xyz(reference.drawn, region.start)} ` +
            `firstInstance gpu=${String(firstInstance)} expected=${String(region.start)} ` +
            `indexCount gpu=${String(indexCount)} expected=${String(region.indexCount)}`,
        );
    }
    // Off the snapshot's own regions: which key each mesh is, which record it reads and what it
    // should be holding are the owner's numbers, and the whole point is that nothing in this file
    // chose them.
    const meshes = compareMeshDraws(gpu, drawn, draws, snapshot.regions);
    // Both totals at zero is the case that never says why it saw nothing: name the snapshot's own
    // camera and nearest live placement, the two inputs a real static validation needs to tell a
    // missing source from a camera, sphere, range or frustum that rejected every one it held.
    const probe =
      instancesGpu === 0 && instancesCpu === 0 ? zeroComparisonProbe(snapshot) : undefined;
    return {
      compared: snapshot.regions.length,
      deviceError: this.#deviceError,
      instancesCpu,
      instancesGpu,
      matricesMismatched,
      meshMismatched: meshes.mismatched,
      meshMismatches: meshes.mismatches,
      mismatched,
      mismatches,
      matrixMismatches,
      placed: snapshot.placed,
      ...(probe === undefined ? {} : { probe }),
    };
  }

  /**
   * One verdict, stored for a harness to read and printed once, with its cause if it failed.
   *
   * The line also carries what the device and this scene held when the check reported, read here
   * rather than polled: `renderer.raw.info.memory` is Three's own tally and `footprint()` is this
   * scene's allocation, so a readback that leaks its staging buffer shows up as growing
   * `readbackBuffers`/`readbackBuffersSize` across reports instead of only as a later OOM. A backend
   * that tracks no memory field contributes none, and no field is ever printed as a fake zero.
   */
  #publish(renderer: IRendererLike, input: IGpuSceneComparison): IGpuSceneValidation {
    const source = (renderer.raw as { info?: { memory?: Partial<Record<string, unknown>> } })?.info
      ?.memory;
    let memory: GpuSceneMemory | undefined;
    // A backend Three keeps no memory tally for contributes nothing, footprint included: a scene
    // number printed next to absent device numbers reads as if the device had been measured.
    if (source !== undefined) {
      memory = {};
      for (const name of MEMORY_FIELDS) {
        const value = source[name];
        if (typeof value === "number" && Number.isFinite(value)) memory[name] = value;
      }
      const footprint = Object.values(this.footprint());
      if (footprint.length > 0)
        memory.footprintBytes = footprint.reduce((sum, buffer) => sum + buffer.bytes, 0);
    }
    const report = validationReport(
      Object.keys(memory ?? {}).length === 0 ? input : { ...input, memory },
    );
    this.#verdict = report.verdict;
    this.#compared = input.compared;
    this.#mismatches = input.mismatched;
    this.#matrixMismatches = input.matricesMismatched;
    this.#meshMismatches = input.meshMismatched;
    this.#lines = [...report.lines];
    // Reported, so cleared: an error is folded into exactly the check that saw it.
    this.#deviceError = "";
    const name =
      "log" in renderer ? (renderer.log as ((message: string) => void) | undefined) : undefined;
    const say = typeof name === "function" ? name : console.info.bind(console);
    say(report.line);
    for (const line of report.lines) say(`TN_WORLD_GPU_SCENE_VALIDATE ${line}`);
    return report;
  }

  dispose(): void {
    const readbacks = this.#validationReadbacks;
    this.#validationReadbacks = undefined;
    if (!this.#validating) {
      readbacks?.args.dispose();
      readbacks?.drawn.dispose();
    }
    this.#kernel = undefined;
    this.#shadowKernel = undefined;
    this.#shadow = undefined;
    this.#shadowProvider = undefined;
    this.#buffers = undefined;
    this.placements.length = 0;
    this.#regions.length = 0;
    this.#keysByName.clear();
    this.#slotsByAsset.clear();
    this.#groups.clear();
    this.#order.length = 0;
    this.#free.length = 0;
    this.#live = 0;
    this.#on = false;
    this.#tallyPending = false;
    this.#tallyRequested = -1;
    this.#tallySample = -1;
    this.#pyramid.dispose();
  }

  readonly #planeVectors = Array.from({ length: 6 }, () => new Vector4());
  #eye = uniform(new Vector3());
  #counts = uniform(new Vector4());
  /**
   * The adaptive LOD bias the kernel scales camera distance by before the gate compare. Set from
   * `WorldCells`' control loop through {@link setLodBias}; 1 is exactly as authored.
   */
  #lodBias = uniform(1);
  #planeUniforms = this.#planeVectors.map((plane) => uniform(plane));
  /**
   * The shadow kernel's own three, kept apart from the camera's: a level's planes are written here
   * and the main pass's own are never disturbed, so the two dispatches in one frame cannot read each
   * other's uniforms. Its gate and base are the level's own texel gate and chain level; its eye and
   * LOD bias are the main pass's, which this frame's main dispatch already set.
   */
  #shadowPlaneVectors = Array.from({ length: 6 }, () => new Vector4());
  #shadowGate = uniform(0);
  #shadowBase = uniform(0);
  #shadowPlaneUniforms = this.#shadowPlaneVectors.map((plane) => uniform(plane));

  #ensure(): IGpuSceneBuffers | undefined {
    if (this.#buffers !== undefined) return this.#buffers;
    this.#buffers = {
      args: storageAttribute(IndirectStorageBufferAttribute, "uint", DRAW_ARGS_WORDS, Uint32Array),
      // One whole `mat4` per instance, which is also what a dressed batch's `instanceMatrix` has to
      // be: this attribute is four words per instance, the kernel bound it as a `mat4`, and a
      // one-instance buffer of it was 16 bytes against a 64-byte minimum, so the device refused
      // every dispatch and the kernel never ran. See `storageAttribute`.
      drawn: storageAttribute(StorageInstancedBufferAttribute, "mat4", 1),
      gates: storageAttribute(StorageBufferAttribute, "vec4", 1),
      keys: storageAttribute(StorageBufferAttribute, "vec4", 1),
      levels: storageAttribute(StorageBufferAttribute, "vec4", 1),
      locals: storageAttribute(StorageBufferAttribute, "mat4", 1),
      source: storageAttribute(StorageBufferAttribute, "GpuPlacement", SOURCE_FLOOR),
    };
    this.#version += 1;
    return this.#buffers;
  }

  /**
   * Grow one of the scene's own storage buffers by doubling, or leave it when it already has room.
   *
   * `needed` is a count of elements of the type the kernel declares that buffer as, never a word
   * count and never a stride: the element size comes from {@link storageAttribute} and the count is
   * the only thing a caller may choose. Each of these is read by a built kernel or named by a
   * geometry's `setIndirect`, so a swap is structural — the kernel is a new pipeline and the main
   * meshes are re-dressed against the new attribute. That is why the buffers start at one and
   * double: a key or a placement arriving is the event, and a frame never reallocates.
   */
  #growOf(name: BufferName, needed: number): boolean {
    const buffers = this.#buffers;
    if (buffers === undefined) return false;
    const current = buffers[name] as BufferAttribute;
    // The allocation `#ensure` made, at the new count, so a regrow cannot land a different class or
    // a different element size than the pipeline the kernel was built against.
    const grown = growBuffer(current, needed, (capacity) =>
      name === "args"
        ? storageAttribute(IndirectStorageBufferAttribute, "uint", capacity, Uint32Array)
        : name === "drawn"
          ? storageAttribute(StorageInstancedBufferAttribute, "mat4", capacity)
          : storageAttribute(StorageBufferAttribute, STORAGE_PLAIN[name], capacity),
    );
    if (grown === current) return true;
    this.#buffers = { ...buffers, [name]: grown };
    // The attributes the kernel is built from changed, so the kernel is a new pipeline: a structural
    // event, and the only one this class pays a compile for. The shadow kernel reads the same
    // placements, keys, locals, gates and levels, so it is rebuilt with it.
    this.#kernel = undefined;
    this.#shadowKernel = undefined;
    this.#version += 1;
    return true;
  }

  #growDrawn(): void {
    this.#growOf("drawn", this.#drawnCapacity);
  }

  #reserve(count: number): boolean {
    // A ring-sized floor, so the first few placements do not each pay a reallocation.
    return this.#growOf("source", Math.max(SOURCE_FLOOR, count));
  }

  #writePlacement(index: number): void {
    const buffers = this.#buffers;
    const placement = this.placements[index];
    if (buffers === undefined || placement === undefined) return;
    const at = index * PLACEMENT_WORDS;
    const array = buffers.source.array as Float32Array;
    array.set(placement.matrix, at);
    array[at + 16] = placement.centre[0] as number;
    array[at + 17] = placement.centre[1] as number;
    array[at + 18] = placement.centre[2] as number;
    array[at + 19] = placement.centre[3] as number;
    array[at + 20] = placement.slot;
    // `info.y` is the placement's uniform scale, read by the kernel's impostor gate. The remaining
    // `info` words stay whatever they were, which is zero.
    array[at + 21] = placement.scale ?? 1;
    addRange(buffers.source, at, PLACEMENT_WORDS);
    buffers.source.needsUpdate = true;
  }

  #writeKey(index: number): void {
    // Read the live set, not the one the caller held: growing a buffer replaces the attribute, and
    // the record being written is the one the draw and the kernel will read.
    const buffers = this.#buffers;
    const region = this.#regions[index];
    if (buffers === undefined || region === undefined) return;
    const at = index * VEC4_WORDS;
    const keys = buffers.keys.array as Float32Array;
    keys[at] = region.start;
    keys[at + 1] = region.capacity;
    keys[at + 2] = region.argsIndex;
    addRange(buffers.keys, at, VEC4_WORDS);
    buffers.keys.needsUpdate = true;
    (buffers.locals.array as Float32Array).set(region.local, index * LOCAL_WORDS);
    addRange(buffers.locals, index * LOCAL_WORDS, LOCAL_WORDS);
    buffers.locals.needsUpdate = true;
    const args = buffers.args.array as Uint32Array;
    const record = region.argsIndex * DRAW_ARGS_WORDS;
    args[record] = region.indexCount;
    args[record + 1] = 0;
    args[record + 2] = 0;
    args[record + 3] = 0;
    args[record + 4] = region.start;
    buffers.args.needsUpdate = true;
    this.#writeShadowKey(index);
  }

  /**
   * Write the whole gate table, which only changes when an asset's levels are adopted.
   *
   * Sized before it is written, not after: the table holds one `vec4` per asset and per level, and
   * a write past the end of a `Float32Array` is a silent no-op. Growing afterwards and copying the
   * short array over the long one kept the first element and dropped the rest, which is a gate table
   * that reads as every asset having no levels and no cull distance.
   */
  #writeSlots(): void {
    if (this.#buffers === undefined) return;
    let levels = 0;
    for (const asset of this.#order)
      levels += (this.#slotsByAsset.get(asset) as IAssetSlot).levels.length;
    this.#growOf("gates", Math.max(1, this.#order.length));
    this.#growOf("levels", Math.max(1, levels));
    const live = this.#buffers;
    if (live === undefined) return;
    const gates = live.gates.array as Float32Array;
    const levelTable = live.levels.array as Float32Array;
    let level = 0;
    for (const [slot, asset] of this.#order.entries()) {
      const definition = this.#slotsByAsset.get(asset) as IAssetSlot;
      const first = level;
      for (const [index, gate] of definition.levels.entries()) {
        const at = level * VEC4_WORDS;
        levelTable[at] = definition.distances[index] ?? 0;
        levelTable[at + 1] = gate.firstKey;
        levelTable[at + 2] = gate.parts;
        // `w` marks the whole-asset impostor's terminal gate: its stored distance is the base-sphere
        // projected one, and the kernel multiplies it by the placement's own scale. See `levelAtGates`.
        levelTable[at + 3] =
          definition.impostor === true && index === definition.levels.length - 1 ? 1 : 0;
        level += 1;
      }
      const at = slot * VEC4_WORDS;
      gates[at] = first;
      gates[at + 1] = definition.levels.length;
      gates[at + 2] = definition.cull ?? 0;
      // Bit 0: authored cull distance; bit 1: authored LODs must not fall back to a casting shape.
      gates[at + 3] =
        (definition.cull === undefined ? 0 : 1) + (definition.shadowFallback === false ? 2 : 0);
    }
    live.gates.needsUpdate = true;
    live.levels.needsUpdate = true;
  }

  /**
   * The two dispatches, mirroring {@link cullAndSelect} branch for branch: one thread per key
   * zeroes that key's instance count, one thread per resident placement appends its matrix to each
   * of its level's parts.
   */
  #buildKernel(): { readonly cull: unknown; readonly clear: unknown } | undefined {
    const buffers = this.#buffers;
    if (buffers === undefined) return undefined;
    const source = nodes(storage(buffers.source, PlacementStruct, buffers.source.count));
    const drawn = nodes(storage(buffers.drawn, "mat4", buffers.drawn.count));
    const argsPlain = nodes(storage(buffers.args, "uint", buffers.args.count));
    const argsAtomic = nodes(storage(buffers.args, "uint", buffers.args.count).toAtomic());
    const keys = nodes(storage(buffers.keys, "vec4", buffers.keys.count));
    const locals = nodes(storage(buffers.locals, "mat4", buffers.locals.count));
    const gates = nodes(storage(buffers.gates, "vec4", buffers.gates.count));
    const levels = nodes(storage(buffers.levels, "vec4", buffers.levels.count));
    const counts = nodes(this.#counts);
    const eye = nodes(this.#eye);
    const bias = nodes(this.#lodBias);
    const planes = this.#planeUniforms.map((plane) => nodes(plane));
    // Measuring doubles the clear: the second thread per key zeroes that key's word of the
    // measured-occlusion tally, which is why the args buffer is sized for it (see `argsWords`).
    // A run that is not measuring never pays the second thread.
    const clearWidth = this.#occlusion === "off" ? 1 : 2;
    const clear = Fn(() => {
      If(instanceIndex.greaterThanEqual(counts.w.mul(clearWidth)), () => Return());
      If(instanceIndex.lessThan(counts.w), () => {
        const key = keys.element(instanceIndex);
        argsPlain.element(key.z.mul(DRAW_ARGS_WORDS).add(1)).assign(int(0));
      });
      If(instanceIndex.greaterThanEqual(counts.w), () => {
        argsPlain
          .element(
            nodes(counts.w.mul(DRAW_ARGS_WORDS)).add(
              nodes(float(instanceIndex).sub(counts.w).floor()),
            ),
          )
          .assign(int(0));
      });
    })().compute(Math.max(1, buffers.keys.count * clearWidth));
    const cull = Fn(() => {
      If(instanceIndex.greaterThanEqual(counts.x), () => Return());
      const placement = source.element(instanceIndex);
      const centre = placement.get("centre");
      const matrix = placement.get("matrix");
      const slot = placement.get("info").x;
      If(slot.lessThan(0.0), () => Return());
      If(slot.greaterThanEqual(counts.y), () => Return());
      const radius = centre.w;
      for (const plane of planes)
        If(plane.dot(centre.xyz).lessThan(radius.negate()), () => Return());
      const gate = gates.element(slot);
      const distance = length(vec3(centre.x.sub(eye.x), 0.0, centre.z.sub(eye.z)));
      If(gate.w.mod(2.0).greaterThan(0.5).and(distance.greaterThan(gate.z)), () => Return());
      // Cull above is the authored distance; the level below is the same distance scaled by the
      // adaptive bias, mirroring `cullAndSelect` and the CPU `model-lod` path.
      const lodDistance = nodes(distance).mul(bias as never);
      // The level, by the same ascending test the CPU runs: the last gate the placement is past.
      // The loop is bounded by `gate.y` rather than unrolled, because a baked chain can carry more
      // levels than any fixed count, and a level the loop stopped short of is a placement drawn at
      // the wrong shape by however many levels it missed.
      const level = int(0).toVar();
      // The placement's own uniform scale, written into `info.y`; the whole-asset impostor's terminal
      // gate is the base projected distance and is scaled by it. A mirrored placement's scale is
      // negative, and the extent it reaches is the same, so the kernel takes the magnitude exactly as
      // `levelAtGates` does; `info.y` is already finite-sanitised when the record is written.
      const scale = abs(placement.get("info").y);
      Loop({ start: int(1), end: gate.y, type: "int", condition: "<" }, ({ i }: { i: unknown }) => {
        const candidate = levels.element(gate.x.add(i as never));
        const threshold = nodes(candidate.x).toVar();
        // Only the terminal level carries this mark: its stored distance is the base-sphere projected
        // one, so its real threshold is `max(strictly after last source gate, base * |scale|)`. The
        // source floor is the previous level's own authored gate, unscaled and nudged one f32 step,
        // so a small scale cannot starve the last source level by sharing its switch distance.
        If(candidate.w.greaterThan(0.5), () => {
          const previous = levels.element(gate.x.add(i as never).sub(1)).x;
          const floor = previous.add(abs(previous).mul(GATE_STEP));
          threshold.assign(max(floor, candidate.x.mul(scale)));
        });
        // A level the prewarm has minted no key for is not taken: the gate table names every level of
        // an asset from the moment it is adopted, and the draw loop below would run this level's
        // zero keys, so the placement would be selected and drawn nowhere while the CPU path drew it
        // and its shadow halves drew under it. The last level that has keys keeps it. See
        // `drawableLevel`, which the reference mirrors.
        If(lodDistance.greaterThan(threshold), () => {
          If(candidate.z.greaterThan(0.5), () => {
            level.assign(i as never);
          });
        });
      });
      const at = levels.element(gate.x.add(level));
      // The pyramid test, once per placement: a placement the frustum and the gates kept, reprojected
      // into the previous frame's pyramid. Measured only, so the write below happens either way and
      // the indirect counts are develop's.
      const hidden = float(0).toVar();
      if (this.#occlusion !== "off" && this.#pyramid.levels > 0) {
        this.#occlusionView ??= uniform(this.#occlusionMatrix);
        hidden.assign(
          this.#pyramid.occluded(centre.xyz, radius, this.#occlusionView, this.#occlusionCut),
        );
      }
      Loop({ start: int(0), end: at.z, type: "int", condition: "<" }, ({ i }: { i: unknown }) => {
        const keyIndex = at.y.add(i as never);
        const key = keys.element(keyIndex);
        If(hidden.greaterThan(0.5), () => {
          atomicAdd(argsAtomic.element(counts.w.mul(DRAW_ARGS_WORDS).add(keyIndex)), int(1));
        });
        const taken = nodes(
          atomicAdd(argsAtomic.element(key.z.mul(DRAW_ARGS_WORDS).add(1)), int(1)),
        );
        If(taken.toFloat().lessThan(key.y), () => {
          drawn.element(key.x.add(taken)).assign(matrix.mul(locals.element(keyIndex)));
        });
      });
    })().compute(Math.max(1, buffers.source.count));
    clear.setName("worldGpuSceneClear");
    cull.setName("worldGpuSceneCull");
    this.#kernel = { clear, cull };
    return this.#kernel;
  }

  /**
   * Allocate the twins once, on the first dispatch that asks, and widen them for every key the
   * provider names that has no twin yet.
   *
   * The buffers hold a record and a run per key at the layout the main pass already gave it, so a
   * twin is a second copy of two numbers rather than a new key space: the shadow kernel reads the
   * same `keys` table and writes at the same offsets into buffers of its own. That is the whole of
   * the cost — the main drawn capacity again, at 64 bytes an instance slot, plus 20 bytes of record
   * per key — and it is paid only when a provider has registered.
   */
  #mintShadowKeys(names: Iterable<string>): void {
    let shadow = this.#shadow;
    if (shadow === undefined) {
      const args = storageAttribute(IndirectStorageBufferAttribute, "uint", DRAW_ARGS_WORDS);
      const drawn = storageAttribute(StorageInstancedBufferAttribute, "mat4", 1);
      shadow = { args, drawn, held: new Set(), keys: new Map() };
      this.#shadow = shadow;
      this.#version += 1;
    }
    for (const name of names) {
      const index = this.#keysByName.get(name);
      // A name with no main key has nothing to twin; that is the owner's to fix, not this method's.
      if (index === undefined || shadow.keys.has(name)) continue;
      shadow.keys.set(name, index);
      shadow.held.add(index);
      this.#writeShadowKey(index);
    }
    // Widened to the main extent whether or not a key opened: the twin clear dispatch is one thread
    // per key, so a narrower twin args buffer would have it read a record that is not there.
    this.#growShadow(shadow, this.#regions.length * DRAW_ARGS_WORDS, this.#drawnCapacity);
  }

  /**
   * Widen the twins to the main buffers' own extent, by doubling as `#growOf` does. A shadow twin is
   * a structural event exactly when its main key is one — a new pipeline, and a version bump, so a
   * mesh dressed against the old attributes is re-dressed.
   */
  #growShadow(shadow: IShadowBuffers, words: number, slots: number): void {
    if (shadow.args.count >= words && shadow.drawn.count >= slots) return;
    this.#shadow = {
      args: growBuffer(shadow.args, words, (count) =>
        storageAttribute(IndirectStorageBufferAttribute, "uint", count, Uint32Array),
      ),
      drawn: growBuffer(shadow.drawn, slots, (count) =>
        storageAttribute(StorageInstancedBufferAttribute, "mat4", count),
      ),
      held: shadow.held,
      keys: shadow.keys,
    };
    // The attributes the twin kernel is built from changed, so it is a new pipeline: a structural
    // event, like every other grow in this class.
    this.#shadowKernel = undefined;
    this.#version += 1;
    // Records written while the twin was narrower than the key table went nowhere; the copy above
    // carried every word that was in range, and this puts the rest back.
    for (const index of shadow.held) this.#writeShadowKey(index);
  }

  /**
   * One twin's record, which is its main record's geometry and run with the count left at zero. A key
   * with no twin writes nothing, and a regrow that moved the main run moves this one with it —
   * `#writeKey` is the only writer of a main record, and it calls this.
   */
  #writeShadowKey(index: number): void {
    const shadow = this.#shadow;
    const region = this.#regions[index];
    if (shadow === undefined || region === undefined || shadow.held.has(index) === false) return;
    const args = shadow.args.array as Uint32Array;
    const record = region.argsIndex * DRAW_ARGS_WORDS;
    args[record] = region.indexCount;
    args[record + 1] = 0;
    args[record + 2] = 0;
    args[record + 3] = 0;
    args[record + 4] = region.start;
    shadow.args.needsUpdate = true;
    // The twin's mark on the main key record, which the shadow kernel reads to know a level casts.
    const buffers = this.#buffers;
    if (buffers === undefined) return;
    (buffers.keys.array as Float32Array)[index * VEC4_WORDS + 3] = 1;
    addRange(buffers.keys, index * VEC4_WORDS, VEC4_WORDS);
    buffers.keys.needsUpdate = true;
  }

  /**
   * The shadow twin of {@link #buildKernel}: the same clear and the same per-placement selection,
   * reading the same source, gate, level and key tables and writing the twin records and runs.
   *
   * Two branches are the level's rather than the camera's — the planes it tests against and its
   * texel gate — and one is the level's base, which floors the main pass's own level at the shape the
   * cluster path hands it. A level whose key has no minted twin (`keys.w`) casts nothing.
   */
  #buildShadowKernel(): { readonly cull: unknown; readonly clear: unknown } | undefined {
    const buffers = this.#buffers;
    const shadow = this.#shadow;
    if (buffers === undefined || shadow === undefined) return undefined;
    const source = nodes(storage(buffers.source, PlacementStruct, buffers.source.count));
    const drawn = nodes(storage(shadow.drawn, "mat4", shadow.drawn.count));
    const argsPlain = nodes(storage(shadow.args, "uint", shadow.args.count));
    const argsAtomic = nodes(storage(shadow.args, "uint", shadow.args.count).toAtomic());
    const keys = nodes(storage(buffers.keys, "vec4", buffers.keys.count));
    const locals = nodes(storage(buffers.locals, "mat4", buffers.locals.count));
    const gates = nodes(storage(buffers.gates, "vec4", buffers.gates.count));
    const levels = nodes(storage(buffers.levels, "vec4", buffers.levels.count));
    const counts = nodes(this.#counts);
    // The main pass's own eye and bias, which this frame's main dispatch set: a shadow map draws each
    // placement at the level the main pass draws it, as the cluster path does.
    const eye = nodes(this.#eye);
    const bias = nodes(this.#lodBias);
    const gate = nodes(this.#shadowGate);
    const base = nodes(this.#shadowBase);
    const planes = this.#shadowPlaneUniforms.map((plane) => nodes(plane));
    // Measuring doubles the clear: the second thread per key zeroes that key's word of the
    // measured-occlusion tally, which is why the args buffer is sized for it (see `argsWords`).
    // A run that is not measuring never pays the second thread.
    const clearWidth = this.#occlusion === "off" ? 1 : 2;
    const clear = Fn(() => {
      If(instanceIndex.greaterThanEqual(counts.w.mul(clearWidth)), () => Return());
      If(instanceIndex.lessThan(counts.w), () => {
        const key = keys.element(instanceIndex);
        argsPlain.element(key.z.mul(DRAW_ARGS_WORDS).add(1)).assign(int(0));
      });
      If(instanceIndex.greaterThanEqual(counts.w), () => {
        argsPlain
          .element(
            nodes(counts.w.mul(DRAW_ARGS_WORDS)).add(
              nodes(float(instanceIndex).sub(counts.w).floor()),
            ),
          )
          .assign(int(0));
      });
    })().compute(Math.max(1, buffers.keys.count * clearWidth));
    const cull = Fn(() => {
      If(instanceIndex.greaterThanEqual(counts.x), () => Return());
      const placement = source.element(instanceIndex);
      const centre = placement.get("centre");
      const matrix = placement.get("matrix");
      const slot = placement.get("info").x;
      If(slot.lessThan(0.0), () => Return());
      If(slot.greaterThanEqual(counts.y), () => Return());
      const radius = centre.w;
      for (const plane of planes)
        If(plane.dot(centre.xyz).lessThan(radius.negate()), () => Return());
      // Sub-texel, the level's own gate rather than a camera's: a caster this map cannot resolve
      // casts no shadow a fragment could tell from ground cover.
      If(gate.greaterThan(0.0).and(radius.mul(2.0).lessThan(gate)), () => Return());
      const asset = gates.element(slot);
      const distance = length(vec3(centre.x.sub(eye.x), 0.0, centre.z.sub(eye.z)));
      If(asset.w.mod(2.0).greaterThan(0.5).and(distance.greaterThan(asset.z)), () => Return());
      // The main pass's own biased distance and level; see `shadowLevel`, which the reference runs.
      const lodDistance = nodes(distance).mul(bias as never);
      const level = int(0).toVar();
      const scale = abs(placement.get("info").y);
      Loop(
        { start: int(1), end: asset.y, type: "int", condition: "<" },
        ({ i }: { i: unknown }) => {
          const candidate = levels.element(asset.x.add(i as never));
          const threshold = nodes(candidate.x).toVar();
          If(candidate.w.greaterThan(0.5), () => {
            const previous = levels.element(asset.x.add(i as never).sub(1)).x;
            const floor = previous.add(abs(previous).mul(GATE_STEP));
            threshold.assign(max(floor, candidate.x.mul(scale)));
          });
          // A level the prewarm has minted no key for is not taken, as in the main kernel: see
          // `drawableLevel`, which the reference mirrors.
          If(lodDistance.greaterThan(threshold), () => {
            If(candidate.z.greaterThan(0.5), () => {
              level.assign(i as never);
            });
          });
        },
      );
      // A level casts when its first key has a minted twin (`keys.w`). The shape is the last
      // casting level in `[0, max(level, base)]`: a placement whose own level casts nothing casts
      // with the coarsest one below it that does, and the map's base floors it, clamped to the last
      // level that casts, so a coarse map never asks for a twin that was not minted. None: no cast.
      const castsAt = (index: unknown): unknown => {
        const entry = levels.element(asset.x.add(index as never));
        return nodes(entry.z.greaterThan(0.5)).and(keys.element(entry.y).w.greaterThan(0.5));
      };
      // Authored LODs past castLevels cast nothing, matching WorldCells#castLevelOf.
      If(asset.w.greaterThan(1.5).and(nodes(castsAt(level)).not()), () => Return());
      const shape = int(-1).toVar();
      Loop(
        {
          start: int(0),
          end: nodes(
            max(level as never, int(min(base as never, asset.y.sub(1.0) as never)) as never),
          ).add(1),
          type: "int",
          condition: "<",
        },
        ({ i }: { i: unknown }) => {
          If(castsAt(i) as never, () => {
            shape.assign(i as never);
          });
        },
      );
      If(shape.lessThan(0), () => Return());
      const at = levels.element(asset.x.add(shape));
      Loop({ start: int(0), end: at.z, type: "int", condition: "<" }, ({ i }: { i: unknown }) => {
        const keyIndex = at.y.add(i as never);
        const key = keys.element(keyIndex);
        const taken = nodes(
          atomicAdd(argsAtomic.element(key.z.mul(DRAW_ARGS_WORDS).add(1)), int(1)),
        );
        If(taken.toFloat().lessThan(key.y), () => {
          drawn.element(key.x.add(taken)).assign(matrix.mul(locals.element(keyIndex)));
        });
      });
    })().compute(Math.max(1, buffers.source.count));
    clear.setName("worldGpuSceneShadowClear");
    cull.setName("worldGpuSceneShadowCull");
    this.#shadowKernel = { clear, cull };
    return this.#shadowKernel;
  }

  #report(renderer: IRendererLike): void {
    this.#reported = true;
    const report = this.report();
    const name =
      "log" in renderer ? (renderer.log as ((message: string) => void) | undefined) : undefined;
    // The GPU-selected counts ride the line only once a tally has landed. `instances` above is what
    // the scene holds; `gpuInstances` is what the GPU drew, main pass only.
    const tally =
      report.gpuTriangles === undefined
        ? ""
        : ` gpuInstances=${String(report.gpuInstances)} gpuTriangles=${String(report.gpuTriangles)}`;
    const line =
      `TN_WORLD_GPU_SCENE ${report.on ? "on" : "off"} reason=${report.reason || "none"} ` +
      `instances=${String(report.instances)} keys=${String(report.keys)} ` +
      `dressed=${String(this.#census.dressed)}/${String(this.#census.meshes)}${tally}`;
    if (typeof name === "function") name(line);
    else console.info(line);
  }
}
