import { Mesh, MeshBasicMaterial, type Object3D } from "three";
import { describe, expect, it, vi } from "vitest";
import * as terrainJobs from "../src/terrain-jobs.js";
import { type ITerrainJob, type ITerrainMergeJob, runTerrainJob } from "../src/terrain-jobs.js";
import { TerrainTiles } from "../src/world-tiles.js";

const sampleHeight = (x: number, z: number): number =>
  Math.sin(x * 0.17) * 2 + Math.cos(z * 0.13) * 1.5 + Math.sin((x + z) * 0.07);

const TILE_SIZE = 16;
const FRAMES = 240;
const BLOCK_PREFIX = "tn-terrain-block:";

/**
 * A module worker that answers only when the test says so, which is what the real one does while its
 * single job is out. `spawnTerrainWorker` reads the global `Worker` when a ring is constructed, so
 * stubbing it is all it takes to hold a merge open — no option and no seam in the class.
 */
class HeldWorker {
  static latest: HeldWorker | undefined;
  onerror: (() => void) | undefined;
  onmessage: ((event: { data: unknown }) => void) | undefined;
  readonly held: { id: number; job: ITerrainMergeJob }[] = [];
  readonly merges: string[] = [];

  constructor(
    readonly url: string | URL,
    readonly options?: { type?: string },
  ) {
    HeldWorker.latest = this;
  }

  postMessage(message: { id: number; job: ITerrainJob }): void {
    this.held.push(message as { id: number; job: ITerrainMergeJob });
    // Seam jobs ride the same worker; only a merge names a block.
    if (message.job.kind === "merge") this.merges.push(originOf(message.job));
  }

  terminate(): void {
    this.held.length = 0;
  }

  /** Answer every held request in the order it was sent, the way the worker queue answers. */
  flush(): void {
    for (const request of this.held.splice(0))
      this.onmessage?.({ data: { id: request.id, result: runTerrainJob(request.job) } });
  }
}

/** A merge's block, read off its job: the block origin is what names it. */
function originOf(job: ITerrainMergeJob): string {
  return `${String(job.blockOrigin.x)},${String(job.blockOrigin.z)}`;
}

function terrain(overrides: Record<string, unknown> = {}): TerrainTiles {
  return new TerrainTiles({
    mergeTiles: true,
    residentByteBudget: 64_000_000,
    residentTileBudget: 256,
    sampleHeight,
    lodDistances: [TILE_SIZE * 3, TILE_SIZE * 7],
    streamRadius: 4,
    surface: new MeshBasicMaterial(),
    tileResolution: 33,
    tileSize: TILE_SIZE,
    ...overrides,
  } as ConstructorParameters<typeof TerrainTiles>[0]);
}

/** One frame of a map walk's churn: stream, re-level, blend, then release the merges the frame sent. */
async function frame(
  tiles: TerrainTiles,
  worker: HeldWorker | undefined,
  at: number,
): Promise<void> {
  const travelled = at * 0.75;
  tiles.follow({ x: travelled, z: at < FRAMES / 2 ? 0 : travelled - (FRAMES / 2) * 0.75 });
  tiles.process();
  worker?.flush();
  // A held worker answers in a microtask, so the walk has to yield before the swap it schedules runs.
  await Promise.resolve();
}

/** How many blocks have two merges out at the same time, which no block may ever have. */
function concurrentDuplicates(worker: HeldWorker): number {
  const open = worker.held
    .map(({ job }) => job)
    .filter((job) => job.kind === "merge")
    .map(originOf);
  return open.length - new Set(open).size;
}

/** A settled block's positions, so two hosts can be compared on the geometry that reached the GPU. */
function readPositions(block: Object3D | undefined): number[] {
  if (!(block instanceof Mesh)) return [];
  return [...(block.geometry.getAttribute("position").array as Float32Array)];
}

function census(tiles: TerrainTiles): {
  blocks: number;
  positions: number[];
  rebuilds: number;
  tiles: number;
} {
  const block = tiles.children.find((child) => child.name.startsWith(BLOCK_PREFIX));
  return {
    blocks: tiles.terrainTiles.blocks,
    positions: readPositions(block),
    rebuilds: tiles.terrainTiles.rebuilds,
    tiles: tiles.terrainTiles.tiles,
  };
}

describe("TerrainTiles merged-block merge in flight", () => {
  it("rebuilds with new membership after tiles leave and join during a held merge", async () => {
    vi.stubGlobal("Worker", HeldWorker);
    const tiles = terrain({ lodDistances: [], lodFactors: [1], streamRadius: 1 });
    try {
      const worker = HeldWorker.latest;
      if (worker === undefined) throw new Error("No terrain worker was spawned.");
      tiles.follow({ x: TILE_SIZE, z: TILE_SIZE });
      const initial = worker.held.find(({ job }) => job.kind === "merge");
      if (initial === undefined) throw new Error("Expected a held merge.");
      expect(initial.job.parts.some(({ origin }) => origin.x === 0)).toBe(true);

      // The ring stays in block (0, 0), but its x=0 column leaves and its x=3 column joins.
      tiles.follow({ x: TILE_SIZE * 2, z: TILE_SIZE });
      expect(worker.merges).toHaveLength(1);
      expect(tiles.getTile("0:1")).toBeUndefined();
      expect(tiles.getTile("3:1")).toBeDefined();
      worker.flush();
      await Promise.resolve();
      tiles.follow({ x: TILE_SIZE * 2, z: TILE_SIZE });
      expect(worker.merges).toEqual(["0,0", "0,0"]);
      const retry = worker.held.find(({ job }) => job.kind === "merge");
      if (retry === undefined) throw new Error("Expected a replacement merge.");
      expect(retry.job.parts).toHaveLength(9);
      expect(retry.job.parts.some(({ origin }) => origin.x === 0)).toBe(false);
      expect(retry.job.parts.filter(({ origin }) => origin.x === TILE_SIZE * 3)).toHaveLength(3);
      const expected = [...runTerrainJob(retry.job).positions];
      worker.flush();
      await Promise.resolve();
      expect(census(tiles).positions).toEqual(expected);
      expect(census(tiles).tiles).toBe(9);
      expect(census(tiles).rebuilds).toBe(2);
    } finally {
      tiles.dispose();
      vi.unstubAllGlobals();
    }
  });

  it("dispatches a block again after its held merge rejects", async () => {
    const runner = terrainJobs.createTerrainJobRunner();
    let rejectMerge: ((reason: Error) => void) | undefined;
    const merge = vi.spyOn(runner, "merge").mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectMerge = reject;
        }),
    );
    const createRunner = vi
      .spyOn(terrainJobs, "createTerrainJobRunner")
      .mockReturnValueOnce(runner);
    const tiles = terrain({ lodDistances: [], lodFactors: [1], streamRadius: 1 });
    try {
      tiles.follow({ x: TILE_SIZE, z: TILE_SIZE });
      tiles.follow({ x: TILE_SIZE * 2, z: TILE_SIZE });
      expect(merge).toHaveBeenCalledTimes(1);
      if (rejectMerge === undefined) throw new Error("Expected a held merge.");
      rejectMerge(new Error("Merge failed."));
      await Promise.resolve();
      tiles.follow({ x: TILE_SIZE * 2, z: TILE_SIZE });
      expect(merge).toHaveBeenCalledTimes(2);
      expect(tiles.terrainTiles.blocks).toBe(1);
      expect(tiles.terrainTiles.tiles).toBe(9);
    } finally {
      tiles.dispose();
      merge.mockRestore();
      createRunner.mockRestore();
    }
  });

  it("never has two merges of the same block out at once", async () => {
    vi.stubGlobal("Worker", HeldWorker);
    try {
      const tiles = terrain();
      const worker = HeldWorker.latest;
      if (worker === undefined) throw new Error("No terrain worker was spawned.");
      let duplicated = 0;
      // Every third frame answers, so a merge stays out long enough for its own block to be dirtied
      // again while it waits — the burst the ring's one-rebuild-a-frame cap is meant to absorb.
      for (let at = 0; at < FRAMES; at += 1) {
        await frame(tiles, at % 3 === 2 ? worker : undefined, at);
        duplicated += concurrentDuplicates(worker);
      }
      worker.flush();
      await Promise.resolve();
      expect(worker.merges.length).toBeGreaterThan(0);
      expect(duplicated).toBe(0);
      expect(census(tiles).blocks).toBeGreaterThan(0);
      tiles.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("merges a block again once the merge it was waiting on lands", async () => {
    vi.stubGlobal("Worker", HeldWorker);
    try {
      const tiles = terrain();
      const worker = HeldWorker.latest;
      if (worker === undefined) throw new Error("No terrain worker was spawned.");
      let duplicated = 0;
      for (let at = 0; at < FRAMES; at += 1) {
        await frame(tiles, at % 3 === 2 ? worker : undefined, at);
        duplicated += concurrentDuplicates(worker);
      }
      worker.flush();
      await Promise.resolve();
      // Waiting is not skipping: a block touched while its merge was out runs again, so every merge
      // the walk sent is answered and the ring settles with the blocks its geometry describes.
      expect(duplicated).toBe(0);
      expect(worker.merges.length).toBeGreaterThan(new Set(worker.merges).size);
      const settled = census(tiles);
      expect(settled.rebuilds).toBe(worker.merges.length);
      expect(settled.blocks).toBeGreaterThan(0);
      expect(settled.tiles).toBe(tiles.residentTileCount);
      tiles.dispose();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("settles on the same block geometry and the same record as an inline run", async () => {
    const inline = async (): Promise<ReturnType<typeof census>> => {
      const tiles = terrain();
      try {
        for (let at = 0; at < FRAMES; at += 1) await frame(tiles, undefined, at);
        return census(tiles);
      } finally {
        tiles.dispose();
      }
    };
    const held = async (): Promise<ReturnType<typeof census>> => {
      vi.stubGlobal("Worker", HeldWorker);
      try {
        const tiles = terrain();
        const worker = HeldWorker.latest;
        if (worker === undefined) throw new Error("No terrain worker was spawned.");
        try {
          for (let at = 0; at < FRAMES; at += 1) await frame(tiles, worker, at);
          return census(tiles);
        } finally {
          tiles.dispose();
        }
      } finally {
        vi.unstubAllGlobals();
      }
    };
    const a = await inline();
    const b = await held();
    expect(b.positions).toEqual(a.positions);
    expect(b.tiles).toBe(a.tiles);
    expect(b.blocks).toBe(a.blocks);
  });
});
