import { describe, expect, it } from "vitest";
import { observeGPUResources } from "../../../examples/procedural-animals/src/gpu-resources.js";
import {
  type ILifetimePort,
  type ILifetimeSample,
  runAnimalLifetimes,
} from "../../../examples/procedural-animals/src/lifecycle-driver.js";

// Only GPU allocation/draw delivery is substituted. The portable driver and observer are real.
function fixture(fault = "") {
  const device = {
    createBuffer: (_descriptor: { size: number }) => ({ destroy() {} }),
    createTexture: (_descriptor: object) => ({ destroy() {} }),
  };
  const gpu = observeGPUResources(device);
  const observerInstalledGPU = gpu.snapshot();
  const shared = device.createBuffer({ size: 16 });
  const rows: object[] = [];
  const generations: number[] = [];
  const abort = new AbortController();
  let frame = 0;
  let active = false;
  let allocated = false;
  let disposed = false;
  let changed = false;
  let actionDisposed = false;
  let liveBuffers: ReturnType<typeof device.createBuffer>[] = [];
  let liveTextures: ReturnType<typeof device.createTexture>[] = [];
  const memory = () => ({
    geometries: active ? 34 : 2,
    attributes: active ? 198 : 6,
    attributesSize: active ? 4096 : 32,
    indexAttributes: active ? 34 : 2,
    indexAttributesSize: active ? 2048 : 16,
    storageAttributes: 0,
    storageAttributesSize: 0,
    indirectStorageAttributes: 0,
    indirectStorageAttributesSize: 0,
    uniformBuffers: active ? 35 : 3,
    uniformBuffersSize: active ? 4096 : 48,
    readbackBuffers: 0,
    readbackBuffersSize: 0,
    textures: active ? 34 : 2,
    texturesSize: active ? 8192 : 1024,
    renderTargets: 1,
  });
  const port: ILifetimePort = {
    signal: abort.signal,
    observerInstalledGPU,
    async capture() {
      if (fault === "missing-frame") return {} as ILifetimeSample;
      if (active && !allocated) {
        allocated = true;
        liveBuffers = Array.from({ length: 224 }, () => device.createBuffer({ size: 128 }));
        liveTextures = Array.from({ length: 32 }, () => device.createTexture({}));
      }
      const sample = {
        frame: ++frame,
        gpu: gpu.snapshot(),
        memory: memory(),
        bodies: active ? 34 : 2,
        entities: active
          ? Array.from({ length: 32 }, (_, i) => `wolf-${generations.length}-${i}`)
          : [],
        surfaces: active
          ? Array.from({ length: 32 }, (_, i) => `wolf-surface-${generations.length}-${i}`)
          : [],
        mainDraws: active ? (Array(32).fill(fault === "culled" ? 0 : 1) as number[]) : [],
        shadowDraws: active ? (Array(32).fill(1) as number[]) : [],
      };
      if (fault === "missing-gpu-counter")
        sample.gpu = { ...sample.gpu, createdBuffers: Number.NaN };
      if (fault === "invalid-gpu-id")
        sample.gpu = { ...sample.gpu, bufferIds: sample.gpu.bufferIds.map(() => Number.NaN) };
      if (fault === "counter-conservation") sample.gpu = { ...sample.gpu, destroyedBuffers: 1 };
      if (active && fault === "duplicate-gpu-id")
        sample.gpu = {
          ...sample.gpu,
          bufferIds: sample.gpu.bufferIds.map((id, i) =>
            i === 1 ? (sample.gpu.bufferIds[0] ?? id) : id,
          ),
        };
      if (active && fault === "overlapping-gpu-id")
        sample.gpu = {
          ...sample.gpu,
          textureIds: sample.gpu.textureIds.map((id, i) =>
            i === 0 ? (sample.gpu.bufferIds[0] ?? id) : id,
          ),
        };
      if (fault === "repeated-frame") sample.frame = 1;
      if (fault === "missing-memory") Reflect.deleteProperty(sample.memory, "uniformBuffers");
      return sample;
    },
    create(generation) {
      generations.push(generation);
      active = true;
      allocated = false;
      disposed = false;
      actionDisposed = false;
      changed = false;
      return {
        teleportAndPause() {
          if (fault === "teleport-and-cleanup") throw new Error("teleport original failure");
        },
        resume() {
          changed = fault !== "frozen-pose";
        },
        dispose() {
          if (disposed) return;
          disposed = true;
          active = false;
          if (fault !== "leaked-buffer") for (const resource of liveBuffers) resource.destroy();
          for (const resource of liveTextures) resource.destroy();
          actionDisposed = fault !== "unresolved-action";
          if (fault === "teleport-and-cleanup") throw new Error("cleanup additional failure");
        },
        async settled() {},
        ownership: () => ({
          actors: disposed ? 0 : 32,
          attached: disposed ? 0 : 64,
          listeners: fault === "leaked-listener" && disposed ? 1 : 0,
          callbacks: disposed ? 0 : 1,
          pendingActions: disposed && !actionDisposed ? 32 : 0,
          disposedActions: actionDisposed ? 32 : 0,
          disposals: disposed ? 96 : 0,
          poseChanged: changed,
        }),
      };
    },
    record: (row) => rows.push(row),
  };
  return {
    port,
    rows,
    generations,
    gpu,
    abort,
    cleanup: () => {
      shared.destroy();
      gpu.dispose();
    },
  };
}

describe("portable fifty-generation animal lifecycle driver", () => {
  it("observes all fifty distinct generations and each allocation/disposal boundary", async () => {
    const run = fixture();
    try {
      expect(await runAnimalLifetimes(run.port)).toBe(50);
      expect(run.generations).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
      expect(run.rows).toHaveLength(51);
      expect(run.rows.at(-1)).toMatchObject({ cycle: 50, completed: true });
    } finally {
      run.cleanup();
    }
  });
  it.each([
    "missing-frame",
    "repeated-frame",
    "missing-memory",
    "culled",
    "leaked-buffer",
    "leaked-listener",
    "unresolved-action",
    "frozen-pose",
    "missing-gpu-counter",
    "invalid-gpu-id",
    "duplicate-gpu-id",
    "overlapping-gpu-id",
    "counter-conservation",
  ])("rejects %s instead of completing a partial lifetime", async (fault) => {
    const run = fixture(fault);
    try {
      await expect(runAnimalLifetimes(run.port)).rejects.toThrow(/TN_ANIMAL_LIFECYCLE/);
      expect(run.generations.length).toBeLessThanOrEqual(1);
      expect(run.rows.some((row) => Reflect.get(row, "completed") === true)).toBe(false);
    } finally {
      run.cleanup();
    }
  });
  it("preserves teleport and cleanup failures without completing a cycle", async () => {
    const run = fixture("teleport-and-cleanup");
    try {
      let failure: unknown;
      try {
        await runAnimalLifetimes(run.port);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors.map(String)).toEqual([
        "Error: teleport original failure",
        "Error: cleanup additional failure",
      ]);
      expect(String(failure)).toContain("teleport original failure");
      expect(String(failure)).toContain("cleanup additional failure");
      expect(run.generations).toEqual([1]);
      expect(run.rows.some((row) => Reflect.get(row, "completed") === true)).toBe(false);
      expect(run.gpu.snapshot().textures).toBe(0);
    } finally {
      run.cleanup();
    }
  });
  it("does not spawn when its scene lifetime has already ended", async () => {
    const run = fixture();
    run.abort.abort();
    try {
      await expect(runAnimalLifetimes(run.port)).rejects.toThrow(/TN_ANIMAL_LIFECYCLE/);
      expect(run.generations).toHaveLength(0);
    } finally {
      run.cleanup();
    }
  });
});
