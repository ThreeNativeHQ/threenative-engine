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
  min,
  storage,
  uint,
  vec3,
} from "three/tsl";
import type { IndirectStorageBufferAttribute, StorageInstancedBufferAttribute } from "three/webgpu";
import { GATE_STEP } from "./world-gpu-reference.js";
import type { IGpuKernel, IGpuSceneBuffers } from "./world-gpu-types.js";
import { PLACEMENT_ROWS, nodes } from "./world-gpu-types.js";
import { DRAW_ARGS_WORDS } from "./world-gpu-validation.js";

/**
 * The shadow twins: a record per key and a run per key at the layout the main pass already gave each
 * key, and the kernel that fills them for one level.
 *
 * The twins are a second copy of two numbers rather than a new key space — the shadow kernel reads
 * the same source, gate, level and key tables and writes at the same offsets into buffers of its
 * own. They are allocated only once a provider has registered, so a launch that never asked for
 * them pays nothing for this module.
 */

/**
 * The shadow twins' two buffers: a record per key and a run per key, at the layout the main pass
 * already gave each key. Allocated only once a provider has registered.
 */
export interface IShadowBuffers {
  readonly args: IndirectStorageBufferAttribute;
  readonly drawn: StorageInstancedBufferAttribute;
  /** Key name to the main key index it twins, so a missing twin is a missing draw, not a crash. */
  readonly keys: Map<string, number>;
  /** The same indices the other way, so a record write knows whether this key has a twin at all. */
  readonly held: Set<number>;
}

/**
 * What a built shadow pass reads: the scene's buffers, its own twins, the level's three numbers and
 * the main pass's eye and bias — a shadow map draws each placement at the level the main pass draws
 * it, as the cluster path does.
 */
export interface IShadowKernelInput {
  readonly buffers: IGpuSceneBuffers;
  readonly shadow: IShadowBuffers;
  /** The six planes of this map's own shadow camera, as uniforms the dispatch wrote. */
  readonly planes: readonly unknown[];
  /** `(placements, slots, keys, keys)`, written by the dispatch before it submits. */
  readonly counts: unknown;
  readonly eye: unknown;
  readonly bias: unknown;
  /** The level's texel gate in world metres. */
  readonly gate: unknown;
  /** The chain level this map draws at, floored over the placement's own. */
  readonly base: unknown;
  /** Whether a launch asked to measure occlusion, which is the one reason the clear is two threads. */
  readonly measureOcclusion: boolean;
}

/**
 * The shadow twin of {@link #buildKernel}: the same clear and the same per-placement selection,
 * reading the same source, gate, level and key tables and writing the twin records and runs.
 *
 * Two branches are the level's rather than the camera's — the planes it tests against and its
 * texel gate — and one is the level's base, which floors the main pass's own level at the shape the
 * cluster path hands it. A level whose key has no minted twin (`keys.w`) casts nothing.
 */
export function buildShadowKernel(input: IShadowKernelInput): IGpuKernel {
  const { buffers, shadow } = input;
  const source = nodes(storage(buffers.source, "vec4", buffers.source.count));
  const drawn = nodes(storage(shadow.drawn, "mat4", shadow.drawn.count));
  const argsPlain = nodes(storage(shadow.args, "uint", shadow.args.count));
  const argsAtomic = nodes(storage(shadow.args, "uint", shadow.args.count).toAtomic());
  const keys = nodes(storage(buffers.keys, "vec4", buffers.keys.count));
  const locals = nodes(storage(buffers.locals, "mat4", buffers.locals.count));
  const gates = nodes(storage(buffers.gates, "vec4", buffers.gates.count));
  const levels = nodes(storage(buffers.levels, "vec4", buffers.levels.count));
  const counts = nodes(input.counts);
  // The main pass's own eye and bias, which this frame's main dispatch set: a shadow map draws each
  // placement at the level the main pass draws it, as the cluster path does.
  const eye = nodes(input.eye);
  const bias = nodes(input.bias);
  const gate = nodes(input.gate);
  const base = nodes(input.base);
  const planes = input.planes.map((plane) => nodes(plane));
  // Measuring doubles the clear: the second thread per key zeroes that key's word of the
  // measured-occlusion tally, which is why the args buffer is sized for it (see `argsWords`).
  // A run that is not measuring never pays the second thread.
  const clearWidth = input.measureOcclusion ? 2 : 1;
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
    // then the sphere, then `info`. The main kernel reads the same rows; see `world-gpu-reference.ts`.
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
    // Sub-texel, the level's own gate rather than a camera's: a caster this map cannot resolve
    // casts no shadow a fragment could tell from ground cover.
    If(gate.greaterThan(0.0).and(radius.mul(2.0).lessThan(gate)), () => Return());
    const asset = gates.element(slot);
    const distance = length(vec3(centre.x.sub(eye.x), 0.0, centre.z.sub(eye.z)));
    If(asset.w.mod(2.0).greaterThan(0.5).and(distance.greaterThan(asset.z)), () => Return());
    // The main pass's own biased distance and level; see `shadowLevel`, which the reference runs.
    const lodDistance = nodes(distance).mul(bias as never);
    const level = int(0).toVar();
    const scale = abs(info.y);
    Loop({ start: int(1), end: asset.y, type: "int", condition: "<" }, ({ i }: { i: unknown }) => {
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
    });
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
      const taken = nodes(atomicAdd(argsAtomic.element(key.z.mul(DRAW_ARGS_WORDS).add(1)), int(1)));
      If(taken.toFloat().lessThan(key.y), () => {
        drawn.element(key.x.add(taken)).assign(matrix.mul(locals.element(keyIndex)));
      });
    });
  })().compute(
    // One thread per placement record, not per `vec4` row of the source buffer.
    Math.max(1, Math.ceil(buffers.source.count / PLACEMENT_ROWS)),
  );
  clear.setName("worldGpuSceneShadowClear");
  cull.setName("worldGpuSceneShadowCull");
  return { clear, cull };
}
