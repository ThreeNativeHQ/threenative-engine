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

// The split's modules, re-exported here so every importer of this file keeps its imports: the types
// and layout constants, the CPU reference, and the launch flags all answer from where they always
// did.
export type {
  BufferName,
  IAssetSlot,
  IGpuPlacement,
  IGpuSceneBufferFootprint,
  IGpuSceneBuffers,
  IKernelInput,
  IKernelResult,
  ILevelGroup,
  ILevelKey,
  IRegion,
  IValidationReadbacks,
  IValidationSnapshot,
  StorageType,
} from "./world-gpu-types.js";
export {
  DRAW_ARGS_BYTES,
  NO_LOCAL,
  PLACEMENT_ROWS,
  PLACEMENT_WORDS,
  SLOT_NONE,
  SOURCE_FLOOR,
  STORAGE_PLAIN,
  STORAGE_WORDS,
  TALLY_EVERY,
  VEC4_WORDS,
  VALIDATE_EVERY,
  addRange,
  argsWords,
  growBuffer,
  storageAttribute,
  storageElementBytes,
} from "./world-gpu-types.js";
export type { ILiveAsset, IShadowLevel } from "./world-gpu-reference.js";
export {
  COARSEST_SHADOW_LEVEL,
  cullAndSelect,
  cullAndSelectShadow,
  levelAtGates,
  liveKeyInstances,
} from "./world-gpu-reference.js";
export {
  BUNDLE_FLAG,
  GPU_SCENE_FLAG,
  GPU_SCENE_VALIDATE_FLAG,
  SHADOW_GPU_KEYS_FLAG,
  bundlesAsked,
  bundlesRequested,
  gpuSceneRequested,
  gpuSceneValidationRequested,
  lodFromFollowRequested,
  shadowGpuKeysRequested,
} from "./world-gpu-flags.js";

import { shadowGpuKeysRequested } from "./world-gpu-flags.js";
import { type IOcclusionReport, WorldGpuReadback } from "./world-gpu-readback.js";
import {
  COARSEST_SHADOW_LEVEL,
  type IShadowLevel,
  buildCullKernel,
  cullAndSelect,
  levelAtGates,
} from "./world-gpu-reference.js";
import { type IShadowBuffers, buildShadowKernel } from "./world-gpu-shadow.js";
import {
  type BufferName,
  type IAssetSlot,
  type IDeviceLike,
  type IGpuKernel,
  type IGpuPlacement,
  type IGpuSceneBufferFootprint,
  type IGpuSceneBuffers,
  type IKernelInput,
  type IKernelResult,
  type ILevelGroup,
  type ILevelKey,
  type IRegion,
  type IValidationReadbacks,
  type IValidationSnapshot,
  NO_LOCAL,
  PLACEMENT_ROWS,
  PLACEMENT_WORDS,
  SLOT_NONE,
  SOURCE_FLOOR,
  STORAGE_PLAIN,
  type StorageType,
  TALLY_EVERY,
  VALIDATE_EVERY,
  VEC4_WORDS,
  addRange,
  argsWords,
  frustumPlanes,
  growBuffer,
  storageAttribute,
} from "./world-gpu-types.js";
import { localClip, localPoint } from "./world-root-frame.js";

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
 * TypeScript, in `world-gpu-reference.ts`, and the TSL kernel below mirrors it line for line. The
 * tests run in node with no GPU, so the reference is what is proved against the CPU path; the
 * kernel is compiled in the browser. The types, layout constants and launch flags it shares with the
 * validation module live in `world-gpu-types.ts` and `world-gpu-flags.ts`, which is what keeps this
 * file and `world-gpu-validation.ts` from importing each other.
 */

export interface IWorldGpuFrameValidation extends IGpuSceneComparison {
  /** The caller's rendered-frame identity, never inferred from readback timing. */
  readonly frame: number;
  /** The dispatch whose buffers and snapshot this readback completed against. */
  readonly dispatch: number;
  readonly verdict: GpuSceneVerdict;
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
  readonly occlusion?: IOcclusionReport;
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

/**
 * The six planes of a camera's frustum, as the kernel reads them, into `out`.
 *
 * The kernel tests them against placements, which are in the root's local frame, so the planes are
 * taken in that frame too: a game that moves its world root culls the camera that is actually over
 * the ring rather than the one it would be if the ring were still at the origin. See `localClip`.
 */
function cameraPlanes(camera: Camera, out: Float32Array, root: Matrix4 | undefined): void {
  frustumPlanes(localClip(_proj, camera, root), out);
}

const _proj = new Matrix4();

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
  #shadowKernel: IGpuKernel | undefined;
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
  #kernel: IGpuKernel | undefined;
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
    this.#readback.configure(validate, tally || occlusion !== "off", occlusion);
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
    this.#readback.watch(renderer);
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
      // read back yet" are different facts, and a zero would merge them. See {@link WorldGpuReadback}.
      ...this.#readback.report(),
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
  /**
   * The LOD eye `WorldCells` grades its CPU path from (`updateLodEye`): the camera, pulled to within
   * the first gate of `follow`. Levels and `maxDistance` then read one eye on both paths (PRD-857).
   * Unset, the dispatch measures from the camera.
   */
  lodEye(x: number, y: number, z: number): void {
    this.#lodEye.set(x, y, z);
    this.#lodEyeSet = true;
  }

  readonly #lodEye = new Vector3();
  #lodEyeSet = false;

  /**
   * `root` is the world's own `matrixWorld`: the frame its placements are recorded in, which is the
   * frame the planes and the eye have to be taken in. A harness driving the scene on its own leaves
   * it out, and then the records are read in world space, as they were before the root could move.
   */
  dispatch(renderer: IRendererLike, camera: Camera, root?: Matrix4): void {
    if (this.#on === false) return;
    if (this.#buffers === undefined) return;
    cameraPlanes(camera, this.#planes, root);
    for (const [index, plane] of this.#planeVectors.entries()) {
      const at = index * 4;
      plane.set(
        this.#planes[at] as number,
        this.#planes[at + 1] as number,
        this.#planes[at + 2] as number,
        this.#planes[at + 3] as number,
      );
    }
    if (this.#lodEyeSet) this.#eye.value.copy(this.#lodEye);
    else localPoint(this.#eye.value.setFromMatrixPosition(camera.matrixWorld), root);
    // `(placements, slots, keys, keys)`: the last two are the same count, and the clear dispatch is
    // one thread per key.
    if (this.#readback.measuring) this.#readback.measure(renderer, camera);
    // Measurement may replace the pyramid buffer on first use or resize. Bind the new buffer in
    // this frame's cull, rather than dispatching a kernel captured before the replacement.
    const kernel = this.#kernel ?? this.#buildKernel();
    if (kernel === undefined) return;
    const keys = this.#regions.length;
    this.#counts.value.set(this.placements.length, this.#order.length, keys, keys);
    // One pass holds both kernels: storage writes reach the next dispatch, so clear precedes cull.
    renderer.compute([kernel.clear, kernel.cull]);
    this.#dispatched += 1;
    // The frame's sample, if one is due: a validation or the tally, on their own clocks. See
    // {@link WorldGpuReadback.sample}.
    this.#readback.setDispatched(this.#dispatched);
    this.#readback.sample(renderer);
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
    return this.#readback.validation;
  }

  /**
   * Read back the dispatch that just ran, once, and resolve only after both targets have settled.
   *
   * This is an opt-in diagnostic seam for a harness that must fence one rendered frame before it
   * advances the fixed-step clock. It does not change the periodic validation path or production
   * dispatches; a caller that asks twice for one dispatch is refused rather than silently counting
   * one frame twice. See {@link WorldGpuReadback.fence}.
   */
  validateCurrentDispatch(
    renderer: IRendererLike,
    frame: number,
  ): Promise<IWorldGpuFrameValidation> {
    return this.#readback.fence(renderer, frame);
  }

  /**
   * Where the independent per-mesh check gets the CPU path's own records, registered once by the
   * owner and asked only on a check's frame.
   *
   * The scene cannot answer this for itself: the records are the owner's, and the meshes whose
   * indirect offsets are the question are the owner's too. It is asked inside {@link #compare},
   * before the readback is issued, so the instances it compares are the ones the dispatch just read
   * rather than whatever the cells hold when the bytes land — the same snapshot rule the rest of the
   * check is built on, and the reason a walk that streams while a readback is in flight cannot make
   * the check compare two different worlds.
   */
  drawsFrom(provider: () => readonly IMeshDraw[]): void {
    this.#readback.drawsFrom(provider);
  }

  /**
   * The main meshes the owner has dressed against these buffers, and the main meshes it holds. It is
   * the owner's, not this class's: a scene that reports itself on over a ring it never dressed was
   * invisible from here, and `dressed=0/21094` is what a real run printed. See {@link announce}.
   */
  #census = { dressed: 0, meshes: 0 };

  /**
   * Every readback this scene takes, and the modes this launch asked for: the dispatch validation,
   * the GPU-selected tally and the measured occlusion pass. Asked through functions rather than
   * fields, so the answer is the one the moment the read needs it.
   */
  readonly #readback: WorldGpuReadback = new WorldGpuReadback({
    on: () => this.#on,
    placements: () => this.placements,
    regions: () => this.#regions,
    buffers: () => this.#buffers,
    planes: () => this.#planes,
    eye: () => this.#eye.value,
    live: () => this.#live,
    gates: () => this.gates(),
    footprint: () => this.footprint(),
    restructure: () => {
      this.#kernel = undefined;
      this.#version += 1;
    },
  });

  dispose(): void {
    this.#readback.dispose();
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
      // Six `vec4` rows per placement, so the count is the rows the kernels index by rather than
      // the placements: one placement record is 24 words either way, and the CPU's `Float32Array`
      // stays the GPU's buffer with no repacking.
      source: storageAttribute(StorageBufferAttribute, "vec4", SOURCE_FLOOR * PLACEMENT_ROWS),
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
    // A ring-sized floor, so the first few placements do not each pay a reallocation. The count is
    // `vec4` rows, the type the kernels bind the source buffer as: `PLACEMENT_ROWS` of them hold
    // one placement, and the buffer stays a whole number of placements because the floor and every
    // doubling of it are whole ones.
    return this.#growOf("source", Math.max(SOURCE_FLOOR, count) * PLACEMENT_ROWS);
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
   * Build the two dispatches the main pass submits — one key's count cleared, one placement selected
   * — and hold them: a capacity change is a new pipeline, and this is the only place one is compiled.
   */
  #buildKernel(): IGpuKernel | undefined {
    const buffers = this.#buffers;
    if (buffers === undefined) return undefined;
    const occlusion = this.#readback.occlusionBinding();
    const kernel = buildCullKernel({
      buffers,
      bias: this.#lodBias,
      counts: this.#counts,
      eye: this.#eye,
      planes: this.#planeUniforms,
      ...(occlusion === undefined ? {} : { occlusion }),
    });
    this.#kernel = kernel;
    return kernel;
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
   * The shadow twin of {@link #buildKernel}, for one level's numbers: the same clear and the same
   * per-placement selection, writing the twin records and runs.
   */
  #buildShadowKernel(): IGpuKernel | undefined {
    const buffers = this.#buffers;
    const shadow = this.#shadow;
    if (buffers === undefined || shadow === undefined) return undefined;
    const kernel = buildShadowKernel({
      base: this.#shadowBase,
      bias: this.#lodBias,
      buffers,
      counts: this.#counts,
      eye: this.#eye,
      gate: this.#shadowGate,
      measureOcclusion: this.#readback.measuring,
      planes: this.#shadowPlaneUniforms,
      shadow,
    });
    this.#shadowKernel = kernel;
    return kernel;
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
