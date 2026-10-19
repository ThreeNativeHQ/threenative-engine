import type { IGPUResources } from "./gpu-resources.js";
export interface ILifetimeSample {
  readonly frame: number;
  readonly gpu: IGPUResources;
  readonly memory: Readonly<Record<string, number>>;
  readonly bodies: number;
  readonly entities: readonly string[];
  readonly surfaces: readonly string[];
  readonly mainDraws: readonly number[];
  readonly shadowDraws: readonly number[];
}
export interface IOwnedLifetime {
  readonly actors: number;
  readonly attached: number;
  readonly listeners: number;
  readonly callbacks: number;
  readonly pendingActions: number;
  readonly disposedActions: number;
  readonly disposals: number;
  readonly poseChanged: boolean;
}
export interface ILifetimeGeneration {
  teleportAndPause(): void;
  resume(): void;
  dispose(): void;
  settled(): Promise<void>;
  ownership(): IOwnedLifetime;
}
export interface ILifetimePort {
  readonly signal: AbortSignal;
  readonly observerInstalledGPU: IGPUResources;
  capture(): Promise<ILifetimeSample>;
  create(generation: number): ILifetimeGeneration;
  record(row: object): void;
}

export const MEMORY_FIELDS = [
  "geometries",
  "attributes",
  "attributesSize",
  "indexAttributes",
  "indexAttributesSize",
  "storageAttributes",
  "storageAttributesSize",
  "indirectStorageAttributes",
  "indirectStorageAttributesSize",
  "uniformBuffers",
  "uniformBuffersSize",
  "readbackBuffers",
  "readbackBuffersSize",
  "textures",
  "texturesSize",
  "renderTargets",
] as const;

function require(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(`TN_ANIMAL_LIFECYCLE_${reason}`);
}
function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
function requireBaseline(sample: ILifetimeSample, baseline: ILifetimeSample) {
  require(sample.surfaces.length === 0 && sample.entities.length === 0, "LIVE_ANIMAL");
  require(sample.bodies === baseline.bodies, "BODY_LEAK");
  require(same(sample.gpu.bufferIds, baseline.gpu.bufferIds), "BUFFER_LEAK");
  require(same(sample.gpu.textureIds, baseline.gpu.textureIds), "TEXTURE_LEAK");
  require(sample.gpu.bufferBytes === baseline.gpu.bufferBytes, "BUFFER_BYTES_LEAK");
  for (const field of MEMORY_FIELDS)
    require(sample.memory[field] === baseline.memory[field], `MEMORY_LEAK: ${field}`);
}
function requireAllocated(sample: ILifetimeSample, baseline: ILifetimeSample) {
  require(sample.surfaces.length === 32 &&
    new Set(sample.surfaces).size === 32, "MISSING_SURFACES");
  require(sample.mainDraws.length === 32 &&
    sample.mainDraws.every((draws) => draws === 1), "VISIBLE_WOLF_CULLED");
  require(sample.shadowDraws.length === 32 &&
    sample.shadowDraws.every((draws) => draws >= 1), "MISSING_SHADOW");
  require(sample.entities.length === 32 &&
    new Set(sample.entities).size === 32, "MISSING_ENTITIES");
  require(sample.bodies === baseline.bodies + 32, "MISSING_BODIES");
  require(sample.memory.geometries ===
    (baseline.memory.geometries ?? -1) + 32, "MISSING_GEOMETRIES");
  require((sample.memory.textures ?? 0) >=
    (baseline.memory.textures ?? 0) + 32, "MISSING_POSE_TEXTURES");
  require(sample.gpu.buffers >= baseline.gpu.buffers + 32 * 7, "MISSING_GPU_BUFFERS");
  require(sample.gpu.textures >= baseline.gpu.textures + 32, "MISSING_GPU_TEXTURES");
  require(sample.gpu.bufferBytes > baseline.gpu.bufferBytes, "MISSING_GPU_BYTES");
  require(baseline.gpu.bufferIds.every((id) =>
    sample.gpu.bufferIds.includes(id),
  ), "SHARED_BUFFER_REPLACED");
  require(baseline.gpu.textureIds.every((id) =>
    sample.gpu.textureIds.includes(id),
  ), "SHARED_TEXTURE_REPLACED");
}

function requireGPU(gpu: IGPUResources) {
  require(gpu &&
    Array.isArray(gpu.bufferIds) &&
    Array.isArray(gpu.textureIds), "MISSING_GPU_CENSUS");
  for (const field of [
    "buffers",
    "textures",
    "bufferBytes",
    "createdBuffers",
    "destroyedBuffers",
    "createdTextures",
    "destroyedTextures",
  ] as const)
    require(Number.isSafeInteger(gpu[field]) && gpu[field] >= 0, `MISSING_GPU_COUNTER: ${field}`);
  const ids = [...gpu.bufferIds, ...gpu.textureIds];
  require(ids.every((id) => Number.isSafeInteger(id) && id > 0) &&
    new Set(ids).size === ids.length, "INVALID_GPU_IDENTITIES");
  require(gpu.buffers === gpu.bufferIds.length &&
    gpu.textures === gpu.textureIds.length, "CONTRADICTORY_GPU_CENSUS");
  require(gpu.createdBuffers - gpu.destroyedBuffers === gpu.buffers &&
    gpu.createdTextures - gpu.destroyedTextures === gpu.textures, "GPU_COUNTER_CONSERVATION");
}

/** Bounded real-frame delivery; a timed-out/missing observation never becomes a zero. */
async function bounded<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  milliseconds: number,
): Promise<T> {
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const result = await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Error("TN_ANIMAL_LIFECYCLE_ABORTED"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        timer = setTimeout(() => reject(new Error("TN_ANIMAL_LIFECYCLE_TIMEOUT")), milliseconds);
      }),
    ]);
    require(performance.now() - started <= milliseconds, "TIMEOUT");
    return result;
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
  }
}

export async function runAnimalLifetimes(port: ILifetimePort): Promise<number> {
  let lastFrame = -1;
  let current: ILifetimeGeneration | undefined;
  const capture = async () => {
    require(!port.signal.aborted, "ABORTED");
    const sample = await bounded(port.capture(), port.signal, 6000);
    require(sample &&
      Number.isSafeInteger(sample.frame) &&
      sample.frame > lastFrame, "MISSING_OR_REPEATED_FRAME");
    lastFrame = sample.frame;
    for (const field of MEMORY_FIELDS)
      require(Number.isSafeInteger(sample.memory?.[field]) &&
        (sample.memory[field] ?? -1) >= 0, `MISSING_MEMORY: ${field}`);
    require(Number.isSafeInteger(sample.bodies) && sample.bodies >= 0, "MISSING_BODY_COUNT");
    requireGPU(sample.gpu);
    return sample;
  };
  try {
    requireGPU(port.observerInstalledGPU);
    const firstReadyDraw = await capture();
    const baseline = await capture();
    requireBaseline(baseline, firstReadyDraw);
    requireBaseline(await capture(), baseline);
    port.record({
      sharedRenderer: true,
      observerInstalledGPU: port.observerInstalledGPU,
      firstReadyDraw,
      baseline,
    });
    let before = baseline;
    for (let cycle = 1; cycle <= 50; cycle++) {
      require(!port.signal.aborted, "ABORTED");
      current = port.create(cycle);
      const allocated = await capture();
      requireAllocated(allocated, baseline);
      current.teleportAndPause();
      const paused = await capture();
      requireAllocated(paused, baseline);
      require(!current.ownership().poseChanged, "PAUSED_POSE_ADVANCED");
      current.resume();
      const resumed = await capture();
      requireAllocated(resumed, baseline);
      require(current.ownership().poseChanged, "RESUMED_POSE_FROZEN");
      current.dispose();
      await bounded(current.settled(), port.signal, 3000);
      const after = await capture();
      requireBaseline(after, baseline);
      const owned = current.ownership();
      require(owned.actors === 0 && owned.attached === 0, "ACTOR_LEAK");
      require(owned.listeners === 0 && owned.callbacks === 0, "LISTENER_LEAK");
      require(owned.pendingActions === 0 && owned.disposedActions === 32, "ACTION_LEAK");
      require(owned.disposals === 32 * 3, "MISSING_DISPOSAL");
      port.record({ cycle, completed: true, before, allocated, paused, resumed, after, owned });
      before = after;
      current = undefined;
    }
    return 50;
  } catch (error) {
    try {
      current?.dispose();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `TN_ANIMAL_LIFECYCLE_FAILED: ${String(error)}; cleanup: ${String(cleanupError)}`,
      );
    }
    throw new Error(`TN_ANIMAL_LIFECYCLE_FAILED: ${String(error)}`, { cause: error });
  }
}
