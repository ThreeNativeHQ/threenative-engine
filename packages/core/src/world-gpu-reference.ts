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
  mat4,
  max,
  storage,
  uint,
  vec3,
} from "three/tsl";
import { biasedLodDistance } from "./model-lod.js";
import { type DepthPyramid, type IKernelOcclusion, occludedBy } from "./render/depth-pyramid.js";
import type {
  IAssetSlot,
  IGpuKernel,
  IGpuPlacement,
  IGpuSceneBuffers,
  IKernelInput,
  IKernelResult,
  IRegion,
} from "./world-gpu-types.js";
import { PLACEMENT_ROWS, nodes } from "./world-gpu-types.js";
import { DRAW_ARGS_WORDS, LIVE_MATRIX, LOCAL_WORDS, compose } from "./world-gpu-validation.js";

/**
 * The per-instance cull and LOD selection, in plain TypeScript: the reference the TSL kernel mirrors
 * branch for branch, and the answer the CPU path is judged against.
 *
 * It runs in node with no GPU behind it, which is why it is what the tests prove. Nothing here
 * allocates a buffer or reads a device: given the placements, the camera's planes and an asset's
 * gate table, it returns the compacted survivors and the per-key counts one dispatch would produce.
 */

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
/** One representable step past a gate, which the kernel and the reference both floor an impostor with. */
export const GATE_STEP = 2 ** -22;

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

/**
 * What a built cull pass reads: the scene's buffers, the camera uniforms the dispatch wrote, and —
 * only when a launch asked to measure — the pyramid it reprojects into.
 *
 * The measurement is a binding rather than a mode string: `view()` is the uniform the kernel was
 * given last time, made on first use by the caller that owns the matrix, so a scene whose GPU pass
 * never measures asks the backend for no extra uniform.
 */
export interface ICullKernelInput {
  readonly buffers: IGpuSceneBuffers;
  /** The six frustum planes, as uniforms the dispatch wrote this frame. */
  readonly planes: readonly unknown[];
  /** `(placements, slots, keys, keys)`, written by the dispatch before it submits. */
  readonly counts: unknown;
  /** The eye the placement distance is measured from. */
  readonly eye: unknown;
  /** The adaptive LOD bias the gate compare is scaled by. */
  readonly bias: unknown;
  readonly occlusion?: {
    readonly pyramid: DepthPyramid;
    readonly cut: unknown;
    view(): unknown;
  };
}

/**
 * The two dispatches, mirroring {@link cullAndSelect} branch for branch: one thread per key
 * zeroes that key's instance count, one thread per resident placement appends its matrix to each
 * of its level's parts.
 */
export function buildCullKernel(input: ICullKernelInput): IGpuKernel {
  const { buffers } = input;
  const source = nodes(storage(buffers.source, "vec4", buffers.source.count));
  const drawn = nodes(storage(buffers.drawn, "mat4", buffers.drawn.count));
  const argsPlain = nodes(storage(buffers.args, "uint", buffers.args.count));
  const argsAtomic = nodes(storage(buffers.args, "uint", buffers.args.count).toAtomic());
  const keys = nodes(storage(buffers.keys, "vec4", buffers.keys.count));
  const locals = nodes(storage(buffers.locals, "mat4", buffers.locals.count));
  const gates = nodes(storage(buffers.gates, "vec4", buffers.gates.count));
  const levels = nodes(storage(buffers.levels, "vec4", buffers.levels.count));
  const counts = nodes(input.counts);
  const eye = nodes(input.eye);
  const bias = nodes(input.bias);
  const planes = input.planes.map((plane) => nodes(plane));
  // Measuring doubles the clear: the second thread per key zeroes that key's word of the
  // measured-occlusion tally, which is why the args buffer is sized for it (see `argsWords`).
  // A run that is not measuring never pays the second thread.
  const clearWidth = input.occlusion === undefined ? 1 : 2;
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
    // One placement is `PLACEMENT_ROWS` consecutive `vec4` rows: the world matrix's four columns,
    // then the sphere, then `info`. Read as rows rather than as a struct element, which the owned
    // engine refuses; the words are the ones `#writePlacement` wrote either way.
    const base = instanceIndex.mul(uint(PLACEMENT_ROWS));
    const matrix = mat4(
      source.element(base),
      source.element(base.add(uint(1))),
      source.element(base.add(uint(2))),
      source.element(base.add(uint(3))),
    );
    const centre = source.element(base.add(uint(4)));
    const info = source.element(base.add(uint(5)));
    const slot = info.x;
    If(slot.lessThan(0.0), () => Return());
    If(slot.greaterThanEqual(counts.y), () => Return());
    const radius = centre.w;
    for (const plane of planes) If(plane.dot(centre.xyz).lessThan(radius.negate()), () => Return());
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
    const scale = abs(info.y);
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
    const measure = input.occlusion;
    if (measure !== undefined && measure.pyramid.levels > 0) {
      hidden.assign(measure.pyramid.occluded(centre.xyz, radius, measure.view(), measure.cut));
    }
    Loop({ start: int(0), end: at.z, type: "int", condition: "<" }, ({ i }: { i: unknown }) => {
      const keyIndex = at.y.add(i as never);
      const key = keys.element(keyIndex);
      If(hidden.greaterThan(0.5), () => {
        atomicAdd(argsAtomic.element(counts.w.mul(DRAW_ARGS_WORDS).add(keyIndex)), int(1));
      });
      const taken = nodes(atomicAdd(argsAtomic.element(key.z.mul(DRAW_ARGS_WORDS).add(1)), int(1)));
      If(taken.toFloat().lessThan(key.y), () => {
        drawn.element(key.x.add(taken)).assign(matrix.mul(locals.element(keyIndex)));
      });
    });
  })().compute(
    // One thread per placement record, not per `vec4` row of the source buffer.
    Math.max(1, Math.ceil(buffers.source.count / PLACEMENT_ROWS)),
  );
  clear.setName("worldGpuSceneClear");
  cull.setName("worldGpuSceneCull");
  return { clear, cull };
}
