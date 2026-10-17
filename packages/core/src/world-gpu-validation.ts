import type { IAssetSlot, IGpuPlacement, IRegion, IValidationSnapshot } from "./world-gpu-scene.js";

/** `DrawIndexedIndirect`: indexCount, instanceCount, firstIndex, baseVertex, firstInstance. */
export const DRAW_ARGS_WORDS = 5;

/** `mat4` per key: the part's own offset inside the model, the same matrix the CPU composes. */
export const LOCAL_WORDS = 16;

/** Keys a mismatch line names before the rest are counted and not printed. */
export const VALIDATE_REPORTED_KEYS = 10;

/** Keys a matrix or indirect-record line names, which carry more numbers than a count line does. */
export const MATRIX_REPORTED_KEYS = 5;

/** Meshes a `mesh=` line names, on the same budget as the record lines above. */
export const MESH_REPORTED_MESHES = 5;

/** Two matrices within this of each other are the same one written through a `mat4` product. */
export const MATRIX_TOLERANCE = 1e-3;

/** Characters of a cause a `cause=` line carries, so one message cannot own the report. */
export const CAUSE_CHARS = 160;

/** The one matrix `liveKeyInstances` composes into, reused per placement as the kernel's own is. */
export const LIVE_MATRIX = new Float32Array(LOCAL_WORDS);

/**
 * Whether two gate tables are the same one, so a level key minted after the table was written
 * rewrites it and a swap that arrives with nothing new does not. A level the world has not minted a
 * key for carries `parts: 0`, which is what the kernel's own loop then draws for it: nothing.
 */
export function sameGates(one: IAssetSlot, other: IAssetSlot): boolean {
  if (one.cull !== other.cull) return false;
  if ((one.impostor === true) !== (other.impostor === true)) return false;
  if (one.distances.length !== other.distances.length) return false;
  for (const [index, distance] of one.distances.entries())
    if (distance !== other.distances[index]) return false;
  if (one.levels.length !== other.levels.length) return false;
  for (const [index, level] of one.levels.entries()) {
    const gate = other.levels[index];
    if (gate === undefined || gate.firstKey !== level.firstKey || gate.parts !== level.parts)
      return false;
  }
  return true;
}

/** One word of an indirect readback, out of range being the zero a record that was never written holds. */
export function word(readback: Uint32Array, at: number): number {
  return (readback[at] ?? 0) as number;
}

/** The translation of the `mat4` at slot `at`, which is what a draw places and a line can name. */
export function xyz(matrices: Float32Array, at: number): string {
  const matrix = at * LOCAL_WORDS;
  if (matrix + LOCAL_WORDS > matrices.length) return "[]";
  return (
    `[${(matrices[matrix + 12] as number).toFixed(3)},` +
    `${(matrices[matrix + 13] as number).toFixed(3)},` +
    `${(matrices[matrix + 14] as number).toFixed(3)}]`
  );
}

/**
 * Whether two runs of `mat4` hold the same matrices, as a set and not as a sequence.
 *
 * The kernel appends through an atomic, so the order two dispatches fill a region's run in is the
 * order the device scheduled them in and is not the order the reference walked the placements. The
 * counts agree over a set that agrees; a set that does not is a run one slot out, a matrix that was
 * never written, or a `firstInstance` the draw reads from a different place — none of which a count
 * can see. Sorted by translation, because that is what orders a placement, and compared with a
 * tolerance, because a matrix written through a product of two floats is not bit-equal to either.
 */
export function sameMatrices(
  gpu: Float32Array,
  gpuStart: number,
  gpuCount: number,
  cpu: Float32Array,
  cpuStart: number,
  cpuCount: number,
  tolerance: number,
): boolean {
  const one = sorted(gpu, gpuStart, gpuCount);
  const other = sorted(cpu, cpuStart, cpuCount);
  if (one.length !== other.length) return false;
  for (const [index, matrix] of one.entries()) {
    const against = other[index] as Float32Array;
    for (let word = 0; word < LOCAL_WORDS; word += 1)
      if (Math.abs((matrix[word] as number) - (against[word] as number)) > tolerance) return false;
  }
  return true;
}

/**
 * Whether two part offsets are the same matrix word for word. A re-dress copies the part's `Matrix4`
 * into a fresh array, so a re-registration of the same key is the same `local` by value and not by
 * reference; comparing the bytes is what makes it a no-op.
 */
export function sameLocal(one: Float32Array, other: Float32Array): boolean {
  if (one.length !== other.length) return false;
  for (let word = 0; word < one.length; word += 1)
    if ((one[word] as number) !== (other[word] as number)) return false;
  return true;
}

/** One run of `mat4` as views, ordered by translation, and short reads truncated rather than read past. */
export function sorted(matrices: Float32Array, start: number, count: number): Float32Array[] {
  const out: Float32Array[] = [];
  for (let taken = 0; taken < count; taken += 1) {
    const at = (start + taken) * LOCAL_WORDS;
    if (at < 0 || at + LOCAL_WORDS > matrices.length) break;
    out.push(matrices.subarray(at, at + LOCAL_WORDS));
  }
  out.sort(
    (one, other) =>
      (one[12] as number) - (other[12] as number) || (one[14] as number) - (other[14] as number),
  );
  return out;
}

/** `out * into` at `at`, column-major, which is the element order both matrices are written in. */ export function compose(
  out: Float32Array,
  into: Float32Array,
  target: Float32Array,
  at: number,
): void {
  for (let column = 0; column < 4; column += 1)
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1)
        sum += (out[k * 4 + row] as number) * (into[column * 4 + k] as number);
      target[at + column * 4 + row] = sum;
    }
}

/**
 * One dressed main mesh's draw, as the owner's own live state says it, and nothing from this file's
 * tables.
 *
 * This is the check that cannot be wrong in the same way the kernel is. {@link cullAndSelect}
 * addresses a level's parts as `levels[gate.x + level].y + part`, and the gate table holds the
 * `firstKey` the scene itself reported through `levelKeys`, so a key/record/mesh mapping that is
 * wrong is reproduced on both sides of the comparison and reads as agreement: a real WebGPU walk
 * printed `ok` over a forest it was drawing with another tree's geometry. The three numbers here
 * come from the other side of the seam — the mesh's own `geometry.indirect` record, the mesh's own
 * name, and the instances the owner's own gates and the camera's own planes select for that name —
 * so the one question they can answer is the one that matters: does the record this mesh draws from
 * hold exactly the instances that mesh's key is owed.
 */
export interface IMeshDraw {
  /** The dressed mesh's own name, which is the main key: `asset:level:part`. */
  readonly name: string;
  /** `geometry.indirectOffset / DRAW_ARGS_BYTES` — the record the draw reads, not one the tables name. */
  readonly record: number;
  /**
   * Every instance the owner's live gates and the camera's planes select for this key, `mat4` after
   * `mat4`: the whole answer, and never the per-cell records this path's own refilter left behind.
   */
  readonly instances: Float32Array;
  /**
   * Whether the mesh's own geometry reads the args buffer the readback came from, at the record above:
   * `geometry.indirect === scene.args` and `geometry.indirectOffset === region.argsIndex *
   * DRAW_ARGS_BYTES`, answered by the owner from the actual mesh. A record offset can agree with the
   * live buffer while the mesh still points at an older buffer with the same numeric offset — the
   * args buffer is allocated independently of `drawn`, and a mint can replace it under a dressed mesh
   * — so an offset check alone reads `ok` over a mesh drawing a buffer nothing writes. A missing value
   * is not a pass: only `true` is bound.
   */
  readonly bound?: boolean;
}

/** What the independent per-mesh check found, in the shape the report folds in. */
export interface IMeshDrawComparison {
  /** Meshes whose own record was read back and held against the live-state instances. */
  readonly compared: number;
  readonly mismatched: number;
  readonly mismatches: readonly string[];
}

/**
 * Every dressed main mesh's own record, against the instances its own key is owed, as a set rather
 * than a sequence — the kernel appends through an atomic, so a device's order is not the CPU's.
 *
 * Equality, and not containment, because the reference is now the whole answer: the owner's gates
 * and the camera's planes over the scene's own placements, which is everything the dispatch reads.
 * Containment was the right relation when the other side was the CPU path's per-cell records, which
 * are the records a refilter left and go stale the moment the GPU scene bypasses it — a reference
 * that can be a superset cannot name a level selected at the wrong distance, and a far tree drawn
 * at its near level is what that looks like in the picture.
 */
export function compareMeshDraws(
  gpu: Uint32Array,
  drawn: Float32Array,
  draws: readonly IMeshDraw[],
  regions: readonly IRegion[],
): IMeshDrawComparison {
  const mismatches: string[] = [];
  let mismatched = 0;
  for (const draw of draws) {
    const record = draw.record * DRAW_ARGS_WORDS;
    const landed = word(gpu, record + 1);
    const first = word(gpu, record + 4);
    // A stale binding is a mismatch the counts and matrices cannot see: the mesh's own geometry
    // points at an args buffer the readback did not come from, so whatever this record holds is not
    // what that mesh draws. Only an explicit `true` is bound, so a caller that forgets the field
    // fails closed rather than reading as agreement.
    if (draw.bound !== true) {
      mismatched += 1;
      if (mismatches.length >= MESH_REPORTED_MESHES) continue;
      const owner = regions.find((region) => region.argsIndex === draw.record);
      mismatches.push(
        `mesh=${draw.name} record=${String(draw.record)} ` +
          `region=${owner?.name ?? "none"} indirect=stale count gpu=${String(landed)} ` +
          `live=${String(draw.instances.length / LOCAL_WORDS)}`,
      );
      continue;
    }
    if (
      sameMatrices(
        drawn,
        first,
        landed,
        draw.instances,
        0,
        draw.instances.length / LOCAL_WORDS,
        MATRIX_TOLERANCE,
      )
    )
      continue;
    mismatched += 1;
    if (mismatches.length >= MESH_REPORTED_MESHES) continue;
    // The region that owns the record the mesh read, which is the name that says whether the mesh
    // and the scene ever agreed on which record this key is.
    const owner = regions.find((region) => region.argsIndex === draw.record);
    mismatches.push(
      `mesh=${draw.name} record=${String(draw.record)} ` +
        `region=${owner?.name ?? "none"} count gpu=${String(landed)} ` +
        `live=${String(draw.instances.length / LOCAL_WORDS)} ` +
        `firstMatrix gpu=${xyz(drawn, first)} live=${xyz(draw.instances, 0)}`,
    );
  }
  return { compared: draws.length, mismatched, mismatches };
}

/** What one landed readback concluded, in the three words a log line can carry. */
export type GpuSceneVerdict = "ok" | "mismatch" | "error";

/** One landed readback's verdict, its one line, and the detail lines under it. */
export interface IGpuSceneValidation {
  readonly verdict: GpuSceneVerdict;
  readonly line: string;
  readonly lines: readonly string[];
}

/**
 * The memory numbers a validation line can carry, all of them optional.
 *
 * The first seven are three's `info.memory` fields (`WebGPURenderer`, 0.185); a backend that tracks
 * none of them reports none, which is why every field is optional and only finite numbers are
 * printed — an absent reading is not a zero. `footprintBytes` is the sum of this scene's own storage
 * buffer `footprint()` bytes, the one number here Three did not write.
 */
export type GpuSceneMemoryField =
  | "storageAttributes"
  | "storageAttributesSize"
  | "indirectStorageAttributes"
  | "indirectStorageAttributesSize"
  | "readbackBuffers"
  | "readbackBuffersSize"
  | "total"
  | "footprintBytes";

/** One validation's memory reading; a field is absent when the backend did not offer a finite one. */
export type GpuSceneMemory = Partial<Record<GpuSceneMemoryField, number>>;

export const MEMORY_FIELDS = [
  "storageAttributes",
  "storageAttributesSize",
  "indirectStorageAttributes",
  "indirectStorageAttributesSize",
  "readbackBuffers",
  "readbackBuffersSize",
  "total",
  "footprintBytes",
] as const satisfies readonly GpuSceneMemoryField[];

/**
 * The one placement nearest the camera (in XZ) a zero/zero comparison was handed, as the dispatch's
 * own snapshot held it. Every number is the snapshot's, never the live scene's: the camera's eye and
 * this placement's sphere, root translation, slot, slot cull, horizontal distance and the margin to
 * the nearest of the six frustum planes are what say whether the snapshot held no live source or
 * held one the camera, sphere, range or frustum rejected. A field is omitted, not printed as a fake
 * zero, when the snapshot has no finite number for it.
 */
export interface IValidationNearest {
  /** The bounding sphere: X, Y, Z and the radius. */
  readonly centre: readonly [number, number, number];
  readonly radius: number;
  /** The placement matrix's translation, which is what a draw places. */
  readonly root: readonly [number, number, number];
  /** The asset slot the placement names. */
  readonly slot: number;
  /** The slot's authored cull distance, or absent when it has none. */
  readonly cull?: number;
  /** `hypot(cx - eye.x, cz - eye.z)`, the distance the level and cull gates read. */
  readonly distance: number;
  /** The least `plane·centre + plane.constant + radius` over the six planes: negative is rejected. */
  readonly margin: number;
}

/**
 * Why a comparison that landed both counts at zero was handed nothing: the snapshot's own camera eye,
 * how many placements it held and how many of them were live, and the one live placement nearest the
 * camera in XZ. Taken from the snapshot, so nothing that streams while the bytes are in flight can
 * rewrite the answer. Attached only when `instancesGpu` and `instancesCpu` are both zero.
 */
export interface IValidationProbe {
  readonly eye: readonly [number, number, number];
  /** Placements the snapshot held, live and released. */
  readonly snapshot: number;
  /** Placements whose slot was not `SLOT_NONE`, the only ones the kernel considers. */
  readonly live: number;
  /** Absent when the snapshot held no live placement to name. */
  readonly nearest?: IValidationNearest;
}

/** What a landed readback is judged on, gathered from the scene before it is formatted. */
export interface IGpuSceneComparison {
  /** Keys whose GPU instance count was read back and held against the reference. */
  readonly compared: number;
  readonly instancesGpu: number;
  readonly instancesCpu: number;
  /** Up to {@link VALIDATE_REPORTED_KEYS} `name gpu=… cpu=…` lines; the count is the whole total. */
  readonly mismatches: readonly string[];
  readonly mismatched: number;
  /**
   * Keys whose drawn matrices, `firstInstance` or `indexCount` disagreed, and up to
   * {@link MATRIX_REPORTED_KEYS} of them by name. The counts above are what the dispatch promised;
   * these are what the draw reads, which is a different question and the one the picture answers.
   */
  readonly matricesMismatched: number;
  readonly matrixMismatches: readonly string[];
  /**
   * Dressed main meshes whose own record was read back and held against the CPU path's own records
   * for that mesh's key, and up to {@link MESH_REPORTED_MESHES} of them by name. This is the check
   * the reference above cannot make: a key/record/mesh mapping that is wrong is one both sides
   * reproduce, and a mesh drawing another asset's placements out of its own record is the picture
   * that proves it.
   */
  readonly meshMismatched: number;
  readonly meshMismatches: readonly string[];
  /** Resident placements the scene held when the readback was issued. */
  readonly placed: number;
  /** The device's last uncaptured error, or `""` for none since the last check reported one. */
  readonly deviceError: string;
  /** What stopped the check — a rejected readback, say. Non-empty is an `error` on its own. */
  readonly cause?: string;
  /**
   * What the device and this scene held when the check reported. Absent when neither offered a
   * finite number, and a field is omitted rather than printed as zero when its backend has none.
   */
  readonly memory?: GpuSceneMemory;
  /** The snapshot's own camera and nearest live placement, when both instance totals landed zero. */
  readonly probe?: IValidationProbe;
}

/**
 * The verdict and the lines one landed readback reports, as `TN_WORLD_GPU_SCENE_VALIDATE`.
 *
 * `ok` is a claim that the GPU drew what the reference draws, so it takes three things: every key's
 * count landing equal, every key's record and matrices landing where the reference put them, and
 * something to land. A dispatch the device refused leaves the args buffer holding what the clear
 * pass wrote, which compares equal to a scene with nothing in it — a real WebGPU run printed
 * `ok keys=0` 956 times while the cull pipeline was being refused for a binding 48 bytes short, which
 * is a check that reports success precisely when the kernel does nothing. So comparing nothing while
 * placements exist is an `error`, and a device that raised anything uncaptured is an `error`
 * whatever the counts say, because every count in a buffer the device has already invalidated is not
 * evidence of anything.
 *
 * The three mismatch families are counted apart and all are a `mismatch`: a key that drew the right
 * number of instances at the wrong place or through a record naming no triangle is the failure a
 * count cannot see, and a walk that printed `mismatched=0` over a forest it never drew is what that
 * reads like. The third is the one the two above cannot find at all: every key the reference names
 * and every record it reads is named by this same file, so a key/record/mesh mapping that is wrong is
 * one they both reproduce, and the dressed mesh's own record, against the CPU path's own records,
 * is the only pair of numbers here that were not written by the same hand.
 *
 * An `error` always names its cause on one `cause=` line: the checks that fail here fail silently
 * otherwise, and a line reading `error` with nothing after it is the report that hid a refused
 * pipeline in the first place.
 */
/** One `[x,y,z]` at three decimals, the precision `xyz` names a matrix translation with. */
export function triple(values: readonly [number, number, number]): string {
  return (
    `[${(values[0] as number).toFixed(3)},` +
    `${(values[1] as number).toFixed(3)},${(values[2] as number).toFixed(3)}]`
  );
}

/** The `key=value` fields a zero/zero comparison's probe adds after the memory fields. */
export function probeFields(probe: IValidationProbe): string[] {
  const out = [
    `eye=${triple(probe.eye)}`,
    `snapshot=${String(probe.snapshot)}`,
    `live=${String(probe.live)}`,
  ];
  const near = probe.nearest;
  if (near === undefined) return out;
  out.push(
    `nearSphere=${triple(near.centre)}`,
    `nearRadius=${near.radius.toFixed(3)}`,
    `nearRoot=${triple(near.root)}`,
    `nearSlot=${String(near.slot)}`,
  );
  if (near.cull !== undefined) out.push(`nearCull=${near.cull.toFixed(3)}`);
  out.push(`nearXZ=${near.distance.toFixed(3)}`, `nearMargin=${near.margin.toFixed(3)}`);
  return out;
}

/**
 * The snapshot's own camera and nearest live placement, for a comparison both of whose counts landed
 * zero. The scan only picks the nearest; the six-plane margin is computed for that one placement
 * alone, not for every placement the reference walked, and a field the snapshot has no finite number
 * for is omitted rather than printed as a fake zero.
 */
export function zeroComparisonProbe(snapshot: IValidationSnapshot): IValidationProbe {
  const eye: readonly [number, number, number] = [
    snapshot.camera.x,
    snapshot.camera.y,
    snapshot.camera.z,
  ];
  let live = 0;
  let nearest: IGpuPlacement | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const placement of snapshot.placements) {
    if (placement.slot < 0) continue;
    live += 1;
    const at = placement.centre;
    const distance = Math.hypot(
      (at[0] as number) - snapshot.camera.x,
      (at[2] as number) - snapshot.camera.z,
    );
    if (Number.isFinite(distance) && distance < nearestDistance) {
      nearestDistance = distance;
      nearest = placement;
    }
  }
  const probe: IValidationProbe = { eye, live, snapshot: snapshot.count };
  if (nearest === undefined) return probe;
  const at = nearest.centre;
  const radius = at[3] as number;
  const centre: readonly [number, number, number] = [
    at[0] as number,
    at[1] as number,
    at[2] as number,
  ];
  const root: readonly [number, number, number] = [
    nearest.matrix[12] as number,
    nearest.matrix[13] as number,
    nearest.matrix[14] as number,
  ];
  let margin = Number.POSITIVE_INFINITY;
  for (let plane = 0; plane < 6; plane += 1) {
    const offset = plane * 4;
    const signed =
      (snapshot.camera.planes[offset] as number) * (at[0] as number) +
      (snapshot.camera.planes[offset + 1] as number) * (at[1] as number) +
      (snapshot.camera.planes[offset + 2] as number) * (at[2] as number) +
      (snapshot.camera.planes[offset + 3] as number);
    margin = Math.min(margin, signed + radius);
  }
  const numbers = [...centre, ...root, radius, nearestDistance, margin];
  if (numbers.some((value) => !Number.isFinite(value))) return probe;
  const cull = snapshot.slots[nearest.slot]?.cull;
  return {
    ...probe,
    nearest: {
      centre,
      distance: nearestDistance,
      margin,
      radius,
      root,
      slot: nearest.slot,
      ...(cull === undefined ? {} : { cull }),
    },
  };
}

export function validationReport(input: IGpuSceneComparison): IGpuSceneValidation {
  const blind = input.compared === 0 && input.placed > 0;
  const cause =
    input.deviceError !== ""
      ? `device-error ${input.deviceError}`
      : (input.cause ?? (blind ? `compared-0-with-placed=${String(input.placed)}` : ""));
  const verdict: GpuSceneVerdict =
    cause !== ""
      ? "error"
      : input.mismatched > 0 || input.matricesMismatched > 0 || input.meshMismatched > 0
        ? "mismatch"
        : "ok";
  const memory: string[] = [];
  if (input.memory !== undefined)
    for (const name of MEMORY_FIELDS) {
      const value = input.memory[name];
      if (typeof value === "number" && Number.isFinite(value))
        memory.push(`${name}=${String(value)}`);
    }
  const details = [...memory, ...(input.probe === undefined ? [] : probeFields(input.probe))];
  const suffix = details.length === 0 ? "" : ` ${details.join(" ")}`;
  const line =
    `TN_WORLD_GPU_SCENE_VALIDATE ${verdict} compared=${String(input.compared)} ` +
    `instancesGpu=${String(input.instancesGpu)} instancesCpu=${String(input.instancesCpu)} ` +
    `mismatched=${String(input.mismatched)} matricesMismatched=${String(input.matricesMismatched)} ` +
    `meshMismatched=${String(input.meshMismatched)}${suffix}`;
  const lines: string[] = [...input.mismatches, ...input.matrixMismatches, ...input.meshMismatches];
  if (cause !== "") lines.push(`cause=${cause.slice(0, CAUSE_CHARS)}`);
  return { verdict, line, lines };
}
