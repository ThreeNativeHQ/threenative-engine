import { type BufferAttribute, type BufferGeometry, Mesh, MeshBasicMaterial, Vector3 } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpanRecorder, setSpanRecorder } from "../src/profiling/Spans.js";
import {
  type ITerrainJob,
  type ITerrainJobResult,
  createTerrainJobRunner,
  runTerrainJob,
} from "../src/terrain-jobs.js";
import { TerrainTiles } from "../src/world-tiles.js";

const sampleHeight = (x: number, z: number): number =>
  Math.sin(x * 0.17) * 2 + Math.cos(z * 0.13) * 1.5 + Math.sin((x + z) * 0.07);

const BLOCK_PREFIX = "tn-terrain-block:";

/** Follows a point off the world origin, so a block's own transform cannot hide a wrong merge. */
const ISLAND = { x: 48, z: 48 };

/** Two level tiers, so the ring has neighbours to reconcile and a seam strip to build. */
const TWO_TIERS = { lodDistances: [8], lodFactors: [1, 2] };

function terrain(overrides: Record<string, unknown> = {}): TerrainTiles {
  return new TerrainTiles({
    mergeTiles: true,
    residentByteBudget: 64_000_000,
    residentTileBudget: 64,
    sampleHeight,
    streamRadius: 1,
    surface: new MeshBasicMaterial(),
    tileResolution: 33,
    tileSize: 16,
    ...overrides,
  } as ConstructorParameters<typeof TerrainTiles>[0]);
}

function blockMeshes(tiles: TerrainTiles): Mesh[] {
  return tiles.children.filter(
    (child): child is Mesh => child instanceof Mesh && child.name.startsWith(BLOCK_PREFIX),
  );
}

/** Every stitch bridge: the seam strips, in the order the passes wrote them. */
function bridgeMeshes(tiles: TerrainTiles): Mesh[] {
  const blocks = new Set(blockMeshes(tiles));
  return tiles.children.filter(
    (child): child is Mesh => child instanceof Mesh && !blocks.has(child),
  );
}

interface ITerrainStat {
  readonly blocks: number;
  readonly rebuilds: number;
}

function stat(tiles: TerrainTiles): ITerrainStat {
  return tiles.debug().terrainTiles as ITerrainStat;
}

/**
 * One geometry's bytes, as a renderer reads them.
 *
 * A float32 that differs by one ulp moves a triangle, so the comparison is the raw bytes and not a
 * tolerance: the worker path has to be the inline path, not a close copy of it.
 */
function bytes(geometry: BufferGeometry, name: string): Uint8Array {
  const array = geometry.getAttribute(name).array as Float32Array;
  return new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
}

function indexBytes(geometry: BufferGeometry): Uint8Array {
  const array = geometry.getIndex()?.array as Uint32Array | undefined;
  if (array === undefined) throw new Error("Expected an indexed terrain geometry.");
  return new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
}

/** `-1` when the two are the same length and the same bytes, else the first byte that differs. */
function firstDifference(left: Uint8Array, right: Uint8Array): number {
  const shared = Math.min(left.length, right.length);
  for (let at = 0; at < shared; at += 1) if (left[at] !== right[at]) return at;
  return left.length === right.length ? -1 : shared;
}

function expectSameGeometry(settled: BufferGeometry, inline: BufferGeometry, what: string): void {
  expect(firstDifference(bytes(settled, "position"), bytes(inline, "position")), what).toBe(-1);
  expect(firstDifference(bytes(settled, "normal"), bytes(inline, "normal")), what).toBe(-1);
  expect(firstDifference(indexBytes(settled), indexBytes(inline)), what).toBe(-1);
}

function expectSameSettling(settled: readonly BufferGeometry[], inline: readonly BufferGeometry[]) {
  expect(settled.length).toBe(inline.length);
  for (const [index, geometry] of settled.entries())
    expectSameGeometry(geometry, inline[index] as BufferGeometry, `geometry ${index}`);
}

function settledGeometry(tiles: TerrainTiles, pick: (mesh: Mesh) => boolean): BufferGeometry[] {
  return tiles.children
    .filter((child): child is Mesh => child instanceof Mesh && pick(child))
    .map((mesh) => mesh.geometry);
}

/**
 * A worker that answers only when the test tells it to.
 *
 * `postMessage` structured-clones what it is given, which is what a real transport does with a typed
 * array, and `answer` runs the worker body — `runTerrainJob`, the same function the inline path
 * calls — over that clone. So a result that survives this fake survived a real serialization.
 */
class FakeWorker {
  static readonly instances: FakeWorker[] = [];
  /** The native host's shim: a module worker is refused by name. */
  static readonly refused = class {
    constructor() {
      throw new Error("TN_NATIVE_WORKER_MODULE_UNSUPPORTED: module workers are not supported");
    }
  };

  readonly options: { type?: string } | undefined;
  readonly received: { id: number; job: ITerrainJob }[] = [];
  readonly url: unknown;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  terminated = false;
  /**
   * Answers with positions stamped `mark` instead of the merged ones: a result the main thread
   * could only have got by swapping what came back, because it never computed it itself.
   */
  mark = 0;

  constructor(url: unknown, options?: { type?: string }) {
    this.url = url;
    this.options = options;
    FakeWorker.instances.push(this);
  }

  static latest(): FakeWorker {
    const worker = FakeWorker.instances.at(-1);
    if (worker === undefined) throw new Error("No worker was spawned.");
    return worker;
  }

  postMessage(data: unknown): void {
    this.received.push(structuredClone(data) as { id: number; job: ITerrainJob });
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Answer everything still owed, the way a worker answers: off this thread and a tick later. */
  async answer(): Promise<void> {
    await this.answerAndSpan();
  }

  /**
   * Answer what is owed and report how long the main thread spent handling the replies: the swap,
   * without the job this fake has to run to produce them, which is the whole point of a worker.
   */
  async answerAndSpan(): Promise<number> {
    let span = 0;
    for (const request of this.received.splice(0)) {
      const result = this.answerWith(request.job);
      // Timed from the delivery, not from here: this fake has to run the job on this thread, and
      // that is the work a real worker would have done elsewhere.
      const started = performance.now();
      this.onmessage?.({ data: { id: request.id, result } });
      await Promise.resolve();
      span += performance.now() - started;
    }
    return span;
  }

  /** The reply: the job's own result, or a marked one when a case is asking who computed it. */
  answerWith(job: ITerrainJob): ITerrainJobResult {
    const result = runTerrainJob(job);
    if (this.mark === 0) return result;
    const stamped = result.kind === "merge" ? [result] : result.bridges;
    for (const part of stamped) part.positions.fill(this.mark);
    return result;
  }

  /** A worker that dies mid-job: every job it owes is run on this thread instead. */
  fail(): void {
    this.onerror?.(new Error("fake worker failed"));
  }

  jobOf(kind: ITerrainJob["kind"]): ITerrainJob {
    const request = this.received.find(({ job }) => job.kind === kind);
    if (request === undefined) throw new Error(`No ${kind} job was posted.`);
    return request.job;
  }

  has(kind: ITerrainJob["kind"]): boolean {
    return this.received.some(({ job }) => job.kind === kind);
  }
}

/** Streams to a settled ring, answering the worker after every frame the way a browser would. */
async function settleWith(tiles: TerrainTiles, frames = 12): Promise<void> {
  for (let frame = 0; frame < frames; frame += 1) {
    tiles.follow(ISLAND);
    await FakeWorker.latest().answer();
  }
}

/** The same walk with no worker at all, which is what node is. */
function settleInline(tiles: TerrainTiles, frames = 12): void {
  for (let frame = 0; frame < frames; frame += 1) tiles.follow(ISLAND);
}

/** What a ring settled without a worker looks like: its blocks and its bridges. */
function inlineSettlement(overrides: Record<string, unknown> = {}): {
  blocks: BufferGeometry[];
  bridges: BufferGeometry[];
} {
  const tiles = terrain(overrides);
  try {
    settleInline(tiles);
    const blocks = settledGeometry(tiles, (mesh) => mesh.name.startsWith(BLOCK_PREFIX));
    return {
      blocks,
      bridges: settledGeometry(tiles, (mesh) => !mesh.name.startsWith(BLOCK_PREFIX)),
    };
  } finally {
    tiles.dispose();
  }
}

/** The same ring settled by a worker, answered frame by frame. */
async function workerSettlement(overrides: Record<string, unknown> = {}): Promise<{
  blocks: BufferGeometry[];
  bridges: BufferGeometry[];
}> {
  const tiles = terrain(overrides);
  try {
    await settleWith(tiles);
    const blocks = settledGeometry(tiles, (mesh) => mesh.name.startsWith(BLOCK_PREFIX));
    return {
      blocks,
      bridges: settledGeometry(tiles, (mesh) => !mesh.name.startsWith(BLOCK_PREFIX)),
    };
  } finally {
    tiles.dispose();
  }
}

/** The middle sample, so one slow frame is not the number a PRD quotes. */
function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((left, right) => left - right);
  if (sorted.length === 0) throw new Error("No samples.");
  return sorted[Math.floor(sorted.length / 2)] as number;
}

interface IWalkSpans {
  readonly jobs: Record<ITerrainJob["kind"], number[]>;
  readonly swaps: Record<ITerrainJob["kind"], number[]>;
  readonly vertices: number;
}

/**
 * Walks a ring, timing each job where a worker would run it and the reply swap this thread does.
 *
 * A walk, so blocks keep changing membership: one rebuild is the cap a frame spends, and a frame
 * without a dirty block measures nothing and is not counted.
 */
async function walkAndSpan(tiles: TerrainTiles, frames: number): Promise<IWalkSpans> {
  const jobs: Record<ITerrainJob["kind"], number[]> = { merge: [], seam: [] };
  const swaps: Record<ITerrainJob["kind"], number[]> = { merge: [], seam: [] };
  let vertices = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    tiles.follow({ x: 16 + frame * 8, z: 16 + frame * 8 });
    const worker = FakeWorker.latest();
    const owed = worker.received.splice(0);
    if (owed.length === 0) {
      await worker.answerAndSpan();
      continue;
    }
    for (const { job } of owed) {
      if (job.kind === "merge")
        vertices = job.parts.reduce((total, part) => total + part.positions.length / 3, 0);
      const started = performance.now();
      runTerrainJob(job);
      jobs[job.kind].push(performance.now() - started);
    }
    // The replies are built before the clock starts: the fake has to run the job on this thread,
    // and that is the work a real worker would have done elsewhere.
    const replies = owed.map(({ id, job }) => ({ data: { id, result: worker.answerWith(job) } }));
    const started = performance.now();
    for (const reply of replies) worker.onmessage?.(reply);
    await Promise.resolve();
    const span = performance.now() - started;
    for (const { job } of owed) swaps[job.kind].push(span);
  }
  return { jobs, swaps, vertices };
}

/** One ring, walked and disposed: the fake's worker is whichever was spawned last. */
async function measureSpans(overrides: Record<string, unknown>, frames = 24): Promise<IWalkSpans> {
  const tiles = terrain(overrides);
  try {
    return await walkAndSpan(tiles, frames);
  } finally {
    tiles.dispose();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWorker.instances.length = 0;
});

describe("terrain jobs", () => {
  it("writes no merged geometry while the merge job that builds it is owed", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const tiles = terrain();
    try {
      tiles.follow(ISLAND);
      const worker = FakeWorker.latest();
      // The job carries the tile levels themselves: no merged buffer exists anywhere yet.
      const job = worker.jobOf("merge");
      if (job.kind !== "merge") throw new Error("Expected a merge job.");
      expect(job.parts.length).toBeGreaterThanOrEqual(2);
      for (const part of job.parts) expect(part.positions.length).toBeGreaterThan(0);
      expect(blockMeshes(tiles)).toHaveLength(0);
      expect(stat(tiles).blocks).toBe(0);
      expect(stat(tiles).rebuilds).toBe(0);
    } finally {
      tiles.dispose();
    }
  });

  it.each(["control", "held"])(
    "keeps stale merge geometry out after captured members are evicted (%s)",
    async (arm) => {
      vi.stubGlobal("Worker", FakeWorker);
      const tiles = terrain({ residentTileBudget: 9 });
      const worker = FakeWorker.latest();
      try {
        tiles.follow(ISLAND);
        const captured = worker.received.find(({ job }) => job.kind === "merge");
        if (captured === undefined || captured.job.kind !== "merge")
          throw new Error("Expected an initial captured merge.");
        const initialResidentKeys = [...tiles.residentKeys];
        const result = runTerrainJob(captured.job);
        const release = async (): Promise<void> => {
          worker.received.splice(worker.received.indexOf(captured), 1);
          worker.onmessage?.({ data: { id: captured.id, result } });
          await Promise.resolve();
        };
        const initialCensus = tiles.terrainTiles;
        if (arm === "control") await release();
        const destination = { x: ISLAND.x + 8 * 16, z: ISLAND.z };
        tiles.follow(destination);
        const currentResidentKeys = [...tiles.residentKeys];
        expect(currentResidentKeys.filter((key) => initialResidentKeys.includes(key))).toEqual([]);
        expect(tiles.blendingTiles).toBe(0);
        if (arm === "held") await release();
        const staleMesh = blockMeshes(tiles).find(
          (mesh) =>
            firstDifference(
              bytes(mesh.geometry, "position"),
              new Uint8Array(
                result.positions.buffer,
                result.positions.byteOffset,
                result.positions.byteLength,
              ),
            ) === -1,
        );
        const visibleCurrentKeys = currentResidentKeys.filter((key) =>
          tiles.getTile(key)?.lod.levels.some(({ object }) => object.visible),
        );
        const census = tiles.terrainTiles;
        console.info("PRD566 evicted merge membership", {
          arm,
          capturedParts: captured.job.parts.length,
          capturedVertices: result.positions.length / 3,
          initialResidentKeys,
          currentResidentKeys,
          visibleCurrentKeys,
          initialCensus,
          census,
          stalePayloadApplied: staleMesh !== undefined,
          staleMeshName: staleMesh?.name,
          residentTiles: tiles.residentTileCount,
          blendingTiles: tiles.blendingTiles,
        });
        expect(visibleCurrentKeys, "eligible current individual tiles remain visible").toEqual(
          currentResidentKeys,
        );
        expect.soft(staleMesh, "evicted merge payload cannot be resurrected").toBeUndefined();
        expect
          .soft(census.tiles, "settled uniform-ring membership matches resident membership")
          .toBe(tiles.residentTileCount);
        // The existing settled-ring scheduler also proves current valid work is eventually applied.
        for (let frame = 0; frame < 12; frame++) {
          tiles.follow(destination);
          await worker.answer();
        }
        console.info("PRD566 current replacement settled", { arm, census: tiles.terrainTiles });
        expect(tiles.terrainTiles.blocks).toBeGreaterThan(0);
        expect(tiles.terrainTiles.rebuilds).toBeGreaterThan(census.rebuilds);
        expect(tiles.terrainTiles.tiles).toBe(tiles.residentTileCount);
      } finally {
        tiles.dispose();
      }
    },
  );

  it.each(["position", "normal", "index"] as const)(
    "reconciles a merge superseded by its %s attribute identity or version",
    async (attribute) => {
      vi.stubGlobal("Worker", FakeWorker);
      const tiles = terrain();
      try {
        tiles.follow(ISLAND);
        const worker = FakeWorker.latest();
        const captured = worker.received.find(({ job }) => job.kind === "merge");
        if (captured === undefined || captured.job.kind !== "merge")
          throw new Error("Expected an initial captured merge.");
        const part = captured.job.parts[0];
        if (part === undefined) throw new Error("Expected a captured tile part.");
        const key = `${part.origin.x / tiles.tileSize}:${part.origin.z / tiles.tileSize}`;
        const mesh = tiles.getTile(key)?.lod.levels.find(({ object }) => object.visible)?.object;
        if (!(mesh instanceof Mesh)) throw new Error("Expected the captured resident mesh.");
        const buffer = (
          attribute === "index" ? mesh.geometry.getIndex() : mesh.geometry.getAttribute(attribute)
        ) as BufferAttribute | null;
        if (buffer === null) throw new Error("Expected a captured input attribute.");
        if (attribute === "position") mesh.geometry.setAttribute(attribute, buffer.clone());
        else buffer.needsUpdate = true;
        worker.received.splice(worker.received.indexOf(captured), 1);
        worker.onmessage?.({ data: { id: captured.id, result: runTerrainJob(captured.job) } });
        await Promise.resolve();
        expect(tiles.terrainTiles.blocks, "superseded input cannot create a block").toBe(0);
        expect(tiles.terrainTiles.rebuilds, "completed stale work still costs one rebuild").toBe(1);
        await settleWith(tiles);
        expect(tiles.terrainTiles.blocks).toBeGreaterThan(0);
        expect(tiles.terrainTiles.tiles).toBe(tiles.residentTileCount);
      } finally {
        tiles.dispose();
      }
    },
  );

  it("writes no bridge while the seam job that builds its strips is owed", () => {
    vi.stubGlobal("Worker", FakeWorker);
    const tiles = terrain(TWO_TIERS);
    try {
      tiles.follow(ISLAND);
      expect(FakeWorker.latest().has("seam")).toBe(true);
      expect(bridgeMeshes(tiles)).toHaveLength(0);
      expect(tiles.stitchedEdgeCount).toBe(0);
    } finally {
      tiles.dispose();
    }
  });

  it.each(["inline", "held-worker"])(
    "keeps full-vertex morph parity and valid seam reconciliation with %s replies",
    async (host) => {
      vi.stubGlobal("Worker", host === "held-worker" ? FakeWorker : undefined);
      const options = {
        mergeTiles: false,
        residentByteBudget: 2_000_000,
        residentTileBudget: 9,
        streamRadius: 1,
        tileResolution: 17,
        tileSize: 16,
        lodDistances: [8, 16],
      };
      const gpu = terrain({ ...options, validate: false });
      const gpuWorker = host === "held-worker" ? FakeWorker.latest() : undefined;
      const cpu = terrain({ ...options, validate: true });
      const cpuWorker = host === "held-worker" ? FakeWorker.latest() : undefined;
      const onUnhandled = vi.fn();
      process.on("unhandledRejection", onUnhandled);
      try {
        gpu.follow({ x: 0, z: 0 });
        cpu.follow({ x: 0, z: 0 });
        await gpuWorker?.answer();
        await cpuWorker?.answer();
        gpu.follow({ x: 12, z: 0 });
        cpu.follow({ x: 12, z: 0 });
        expect(gpu.getTile("0:-1")).toBeDefined();
        expect(cpu.getTile("0:-1")).toBeDefined();
        for (let frame = 1; frame <= 3; frame++) {
          gpu.process();
          cpu.process();
          const rendered = gpu
            .getTile("0:0")
            ?.lod.levels.find(({ object }) => object.visible)?.object;
          const reference = cpu
            .getTile("0:0")
            ?.lod.levels.find(({ object }) => object.visible)?.object;
          if (!(rendered instanceof Mesh) || !(reference instanceof Mesh))
            throw new Error("Expected matching visible transition meshes.");
          const position = reference.geometry.getAttribute("position");
          const normals = reference.geometry.getAttribute("normal");
          const actual = new Vector3();
          const expected = new Vector3();
          const normal = new Vector3();
          const delta = new Vector3();
          let maxPositionError = 0;
          let maxNormalError = 0;
          let edgeError = 0;
          let interiorError = 0;
          expect(rendered.geometry.getAttribute("position").count).toBe(position.count);
          for (let vertex = 0; vertex < position.count; vertex++) {
            rendered.getVertexPosition(vertex, actual);
            const error = actual.distanceTo(expected.fromBufferAttribute(position, vertex));
            maxPositionError = Math.max(maxPositionError, error);
            if (vertex === 1) edgeError = error;
            if (vertex === 4 * 17 + 5) interiorError = error;
            normal.fromBufferAttribute(rendered.geometry.getAttribute("normal"), vertex);
            for (const [target, weight] of (rendered.morphTargetInfluences ?? []).entries()) {
              const attribute = rendered.geometry.morphAttributes.normal?.[target];
              if (attribute !== undefined)
                normal.addScaledVector(delta.fromBufferAttribute(attribute, vertex), weight);
            }
            maxNormalError = Math.max(
              maxNormalError,
              normal
                .normalize()
                .distanceTo(expected.fromBufferAttribute(normals, vertex).normalize()),
            );
          }
          console.info("PRD566 held seam parity", {
            host,
            frame,
            edgeError,
            interiorError,
            maxPositionError,
            maxNormalError,
            gpuBaseEdgeY: rendered.geometry.getAttribute("position").getY(1),
            gpuMorphedEdgeY: rendered.getVertexPosition(1, actual).y,
            cpuEdgeY: position.getY(1),
            gpuEdgeMorphDeltas: rendered.geometry.morphAttributes.position?.map(
              (attribute: ReturnType<BufferGeometry["getAttribute"]>) => attribute.getY(1),
            ),
            influences: rendered.morphTargetInfluences,
            gpuPendingJobs: gpuWorker?.received.map(({ job }) => job.kind),
            cpuPendingJobs: cpuWorker?.received.map(({ job }) => job.kind),
            gpuDecisions: gpu.debug().lodDecisions,
            cpuDecisions: cpu.debug().lodDecisions,
          });
          expect
            .soft(maxPositionError, `${host} frame ${frame}: every position`)
            .toBeLessThan(0.001);
          expect.soft(maxNormalError, `${host} frame ${frame}: every normal`).toBeLessThan(0.001);
          if (frame === 2) {
            if (host === "held-worker") {
              expect(gpuWorker?.has("seam")).toBe(true);
              expect(cpuWorker?.has("seam")).toBe(true);
            }
            await expect(Promise.all([gpuWorker?.answer(), cpuWorker?.answer()])).resolves.toEqual([
              undefined,
              undefined,
            ]);
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect
              .soft(onUnhandled, "valid asynchronous seam reconciliation")
              .not.toHaveBeenCalled();
          }
        }
        if (host === "held-worker") {
          // The old topology reply was invalidated, and the current topology still owes reconciliation.
          expect(gpuWorker?.has("seam")).toBe(true);
          expect(cpuWorker?.has("seam")).toBe(true);
          await gpuWorker?.answer();
          await cpuWorker?.answer();
          // Completing frame three changed the rendered level after frame two's replacement request.
          expect(gpuWorker?.has("seam")).toBe(true);
          expect(cpuWorker?.has("seam")).toBe(true);
          await gpuWorker?.answer();
          await cpuWorker?.answer();
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(onUnhandled).not.toHaveBeenCalled();
          expect(gpuWorker?.has("seam")).toBe(false);
          expect(cpuWorker?.has("seam")).toBe(false);
        }
        expect(gpu.lodTransitions).toBeGreaterThan(0);
        expect(cpu.lodTransitions).toBe(gpu.lodTransitions);
        expect(() => cpu.process()).not.toThrow();
      } finally {
        process.off("unhandledRejection", onUnhandled);
        gpu.dispose();
        cpu.dispose();
      }
    },
  );

  it.each(["index", "count"])(
    "fails closed on malformed seam %s for the current topology",
    async (fault) => {
      vi.stubGlobal("Worker", FakeWorker);
      const tiles = terrain({ ...TWO_TIERS, mergeTiles: false, validate: true });
      const onUnhandled = vi.fn();
      process.on("unhandledRejection", onUnhandled);
      try {
        tiles.follow(ISLAND);
        const worker = FakeWorker.latest();
        const request = worker.received.splice(0).find(({ job }) => job.kind === "seam");
        if (request === undefined || request.job.kind !== "seam")
          throw new Error("Expected a current seam request.");
        const result = runTerrainJob(request.job);
        const bridge = result.bridges[0];
        if (bridge === undefined) throw new Error("Expected a bridge to corrupt.");
        bridge.indices[0] = bridge.positions.length;
        worker.onmessage?.({
          data: { id: request.id, result: fault === "count" ? { ...result, bridges: [] } : result },
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(onUnhandled).toHaveBeenCalledOnce();
        expect(onUnhandled.mock.calls[0]?.[0]).toEqual(
          new Error(
            fault === "count"
              ? "TerrainTiles seam job returned an invalid bridge count."
              : "TerrainTiles seam diagnostic bridge topology has invalid index data.",
          ),
        );
        expect(worker.has("seam")).toBe(false);
      } finally {
        process.off("unhandledRejection", onUnhandled);
        tiles.dispose();
      }
    },
  );

  it("settles the block bytes the inline path settles, from the worker's own result", async () => {
    const inline = inlineSettlement();
    expect(inline.blocks.length).toBeGreaterThan(0);

    vi.stubGlobal("Worker", FakeWorker);
    const settled = await workerSettlement();
    expect(settled.blocks.length).toBeGreaterThan(0);
    expectSameSettling(settled.blocks, inline.blocks);
  });

  it("settles the bridge bytes the inline path settles", async () => {
    const inline = inlineSettlement(TWO_TIERS);
    expect(inline.bridges.length).toBeGreaterThan(0);

    vi.stubGlobal("Worker", FakeWorker);
    const settled = await workerSettlement(TWO_TIERS);
    expectSameSettling(settled.bridges, inline.bridges);
  });

  // The spans, measured over a walk, and only the structural claim asserted: a node sample is not a
  // browser frame, so what this holds is which half of a block rebuild runs on this thread. The
  // numbers go to the PRD beside the box they belong to.
  it("reports the main-thread span of a block rebuild and a seam pass while the worker builds them", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    // Two rings, because one ring cannot do both jobs: a block merges only where a whole 4x4 tile
    // block shares one LOD tier, and a seam needs a LOD boundary inside the resident ring.
    const merged = await measureSpans({ lodDistances: [], lodFactors: [1], streamRadius: 2 });
    const seamed = await measureSpans(TWO_TIERS);
    expect(merged.jobs.merge.length).toBeGreaterThan(2);
    expect(seamed.jobs.seam.length).toBeGreaterThan(0);
    expect(merged.swaps.merge).toHaveLength(merged.jobs.merge.length);
    expect(seamed.swaps.seam).toHaveLength(seamed.jobs.seam.length);
    console.log(
      `TN_TERRAIN_JOBS rebuilds=${String(merged.jobs.merge.length)} vertices=${String(
        merged.vertices,
      )} mergeP50=${median(merged.jobs.merge).toFixed(2)}ms swapP50=${median(
        merged.swaps.merge,
      ).toFixed(2)}ms seamPasses=${String(seamed.jobs.seam.length)} seamP50=${median(
        seamed.jobs.seam,
      ).toFixed(2)}ms seamSwapP50=${median(seamed.swaps.seam).toFixed(2)}ms`,
    );
  });

  // The box's structural claim, without a clock: a reply the main thread did not compute is one it
  // could only have swapped in, so marking the worker's result marks the settled geometry too. If
  // any of the merge ran here, the correct bytes would win over the mark and this case fails.
  // The box's timing clause, on the frame-span table the browser report reads: the main-thread work
  // a block rebuild and a seam pass do is entered as the `terrainBlock`/`terrainSeam` spans. Inline
  // here, so the entry is deterministic and a node sample is not read as a browser frame.
  it("records the terrain block and seam spans on the frame-span table", () => {
    const recorder = new SpanRecorder();
    setSpanRecorder(recorder);
    try {
      // Two rings, because one ring cannot do both jobs: a block merges only where a whole 4x4 tile
      // block shares one LOD tier, and a seam needs a LOD boundary inside the resident ring.
      const merged = terrain({ lodDistances: [], lodFactors: [1], streamRadius: 2 });
      const seamed = terrain(TWO_TIERS);
      try {
        for (let frame = 0; frame < 16; frame += 1) {
          merged.follow(ISLAND);
          seamed.follow(ISLAND);
        }
        recorder.endFrame(1);
        const window = recorder.window();
        expect(window?.spans.terrainBlock?.frames).toBeGreaterThan(0);
        expect(window?.spans.terrainBlock?.perFrame).toBeGreaterThan(0);
        expect(window?.spans.terrainSeam?.frames).toBeGreaterThan(0);
        expect(window?.spans.terrainSeam?.perFrame).toBeGreaterThan(0);
      } finally {
        merged.dispose();
        seamed.dispose();
      }
    } finally {
      setSpanRecorder(undefined);
    }
  });

  it("swaps the returned attributes and computes nothing itself", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const tiles = terrain();
    try {
      tiles.follow(ISLAND);
      const worker = FakeWorker.latest();
      worker.mark = 1234.5;
      await worker.answer();
      const settled = blockMeshes(tiles);
      expect(settled.length).toBeGreaterThan(0);
      for (const mesh of settled) {
        const positions = mesh.geometry.getAttribute("position").array as Float32Array;
        expect(positions.length).toBeGreaterThan(0);
        expect(positions.every((value) => value === 1234.5)).toBe(true);
      }
    } finally {
      tiles.dispose();
    }
  });

  it("names the host it runs inline on, and reports none while a worker has the jobs", () => {
    const inline = createTerrainJobRunner();
    expect(inline.offThread).toBe(false);
    expect(inline.inlineReason).toBe("no Worker on this host");
    inline.dispose();

    // The native host: its shim has a `Worker` and refuses a module source by name.
    vi.stubGlobal("Worker", FakeWorker.refused);
    const native = createTerrainJobRunner();
    expect(native.offThread).toBe(false);
    expect(native.inlineReason).toContain("TN_NATIVE_WORKER_MODULE_UNSUPPORTED");
    native.dispose();

    vi.stubGlobal("Worker", FakeWorker);
    const offThread = createTerrainJobRunner();
    expect(offThread.offThread).toBe(true);
    expect(offThread.inlineReason).toBeUndefined();
    expect(String(FakeWorker.latest().url)).toContain("terrain-jobs-worker.js");
    expect(FakeWorker.latest().options).toEqual({ type: "module" });
    offThread.dispose();
    expect(FakeWorker.latest().terminated).toBe(true);
  });

  it("runs the same jobs inline, unchanged, where there is no Worker", () => {
    expect(typeof globalThis.Worker).toBe("undefined");
    const merged = terrain();
    const seamed = terrain(TWO_TIERS);
    try {
      // Inline resolves inside the call, so one frame is enough for a block: nothing is owed a reply.
      merged.follow(ISLAND);
      expect(stat(merged).blocks).toBeGreaterThan(0);
      expect(stat(merged).rebuilds).toBeGreaterThan(0);
      // A bridge waits for the LOD blend to land, which is frames of streaming, not a worker.
      settleInline(seamed);
      expect(bridgeMeshes(seamed).length).toBeGreaterThan(0);
      expect(seamed.stitchedEdgeCount).toBeGreaterThan(0);
    } finally {
      merged.dispose();
      seamed.dispose();
    }
  });

  it("runs the same jobs inline, unchanged, where a Worker refuses a module source", () => {
    const inline = inlineSettlement(TWO_TIERS);
    vi.stubGlobal("Worker", FakeWorker.refused);
    const tiles = terrain(TWO_TIERS);
    try {
      settleInline(tiles);
      expectSameSettling(
        settledGeometry(tiles, (mesh) => mesh.name.startsWith(BLOCK_PREFIX)),
        inline.blocks,
      );
      expectSameSettling(
        settledGeometry(tiles, (mesh) => !mesh.name.startsWith(BLOCK_PREFIX)),
        inline.bridges,
      );
    } finally {
      tiles.dispose();
    }
  });

  it("runs a dead worker's job on this thread, with the same result", async () => {
    const inline = inlineSettlement();
    vi.stubGlobal("Worker", FakeWorker);
    const tiles = terrain();
    try {
      tiles.follow(ISLAND);
      const worker = FakeWorker.latest();
      worker.fail();
      await Promise.resolve();
      await Promise.resolve();
      expect(worker.terminated).toBe(true);
      const settled = blockMeshes(tiles);
      expect(settled.length).toBeGreaterThan(0);
      expectSameGeometry(
        settled[0]?.geometry as BufferGeometry,
        inline.blocks[0] as BufferGeometry,
        "block",
      );
    } finally {
      tiles.dispose();
    }
  });
});
