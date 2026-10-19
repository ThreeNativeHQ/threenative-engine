import { type BufferGeometry, Mesh, MeshBasicMaterial, Object3D, Vector3 } from "three";
import { describe, expect, it, vi } from "vitest";
import { TerrainTiles } from "../src/world-tiles.js";

const sampleHeight = (x: number, z: number): number =>
  Math.sin(x * 0.17) * 2 + Math.cos(z * 0.13) * 1.5 + Math.sin((x + z) * 0.07);

const BLOCK_PREFIX = "tn-terrain-block:";

function terrain(mergeTiles: boolean, overrides: Record<string, unknown> = {}): TerrainTiles {
  return new TerrainTiles({
    mergeTiles,
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

/** Every visible terrain level mesh and block mesh: the tiles the main pass would submit. */
function submittedMeshes(tiles: TerrainTiles): number {
  const levels = new Set<unknown>();
  for (const key of tiles.residentKeys) {
    const tile = tiles.getTile(key);
    if (tile === undefined) continue;
    for (const level of tile.lod.levels) levels.add(level.object);
  }
  let submitted = 0;
  tiles.traverseVisible((object) => {
    if (object instanceof Mesh && (object.name.startsWith(BLOCK_PREFIX) || levels.has(object)))
      submitted += 1;
  });
  return submitted;
}

function blockKey(mesh: Mesh): { lod: number; blockX: number; blockZ: number } {
  const key = mesh.name.slice(BLOCK_PREFIX.length);
  const [lod, cell] = key.split(":");
  const [blockX, blockZ] = (cell as string).split(",");
  return { lod: Number(lod), blockX: Number(blockX), blockZ: Number(blockZ) };
}

function levelWorldKeys(
  tiles: TerrainTiles,
  tileKey: string,
  levelIndex: number,
  offsetX: number,
  offsetZ: number,
): string[] {
  const tile = tiles.getTile(tileKey);
  if (tile === undefined) throw new Error(`Missing resident tile '${tileKey}'.`);
  const level = tile.lod.levels[levelIndex]?.object;
  if (!(level instanceof Mesh)) throw new Error(`Missing level ${String(levelIndex)}.`);
  const position = level.geometry.getAttribute("position");
  const keys: string[] = [];
  for (let vertex = 0; vertex < position.count; vertex += 1)
    keys.push(
      `${String(position.getX(vertex) + offsetX)},${String(position.getY(vertex))},${String(
        position.getZ(vertex) + offsetZ,
      )}`,
    );
  return keys;
}

function mergedWorldKeys(mesh: Mesh, offsetX: number, offsetZ: number): string[] {
  const position = mesh.geometry.getAttribute("position");
  const keys: string[] = [];
  for (let vertex = 0; vertex < position.count; vertex += 1)
    keys.push(
      `${String(position.getX(vertex) + offsetX)},${String(position.getY(vertex))},${String(
        position.getZ(vertex) + offsetZ,
      )}`,
    );
  return keys;
}

function sortedCounts(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function normalKeys(geometry: BufferGeometry, offsetX: number, offsetZ: number): string[] {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const keys: string[] = [];
  for (let vertex = 0; vertex < position.count; vertex += 1)
    keys.push(
      `${String(normal.getX(vertex))},${String(normal.getY(vertex))},${String(
        normal.getZ(vertex),
      )}|${String(position.getX(vertex) + offsetX)},${String(position.getY(vertex))},${String(
        position.getZ(vertex) + offsetZ,
      )}`,
    );
  return keys;
}

/** Every triangle as its three world positions, so a merge can be compared without vertex order. */
function triangleKeys(
  geometry: BufferGeometry,
  offsetX: number,
  offsetZ: number,
): Map<string, number> {
  const position = geometry.getAttribute("position");
  const index = geometry.getIndex();
  if (index === null) throw new Error("Expected an indexed terrain geometry.");
  const keys: string[] = [];
  for (let element = 0; element + 2 < index.count; element += 3) {
    const corners: string[] = [];
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = index.getX(element + corner);
      corners.push(
        `${String(position.getX(vertex) + offsetX)},${String(position.getY(vertex))},${String(
          position.getZ(vertex) + offsetZ,
        )}`,
      );
    }
    keys.push(corners.sort().join("|"));
  }
  return sortedCounts(keys);
}

function worldVertices(mesh: Mesh): Vector3[] {
  const position = mesh.geometry.getAttribute("position");
  const points: Vector3[] = [];
  for (let vertex = 0; vertex < position.count; vertex += 1)
    points.push(
      new Vector3(position.getX(vertex), position.getY(vertex), position.getZ(vertex)).applyMatrix4(
        mesh.matrixWorld,
      ),
    );
  return points;
}

function nearestDistance(point: Vector3, points: readonly Vector3[]): number {
  let nearest = Number.POSITIVE_INFINITY;
  for (const candidate of points) nearest = Math.min(nearest, point.distanceTo(candidate));
  return nearest;
}

function settled(tiles: TerrainTiles, follow: { x: number; z: number }): void {
  for (let frame = 0; frame < 12; frame += 1) tiles.follow(follow);
}

/**
 * A merged block must draw where its tiles draw: for every settled tile the block covers, each of its
 * level vertices has a merged vertex at the same world position. Read through `matrixWorld`, so a
 * translated terrain root or a block whose own mesh transform is wrong fails here too. The island
 * is followed away from the world origin because a block at (0, 0) merges into geometry that already
 * carries its own translation and hides a wrong block transform. (PRD-475.)
 */
function expectBlocksOnTheirTiles(tiles: TerrainTiles): void {
  tiles.updateMatrixWorld(true);
  const blocks = blockMeshes(tiles);
  expect(blocks.length).toBeGreaterThan(0);
  for (const block of blocks) {
    const merged = worldVertices(block);
    const { lod, blockX, blockZ } = blockKey(block);
    let members = 0;
    for (const key of tiles.residentKeys) {
      const tile = tiles.getTile(key);
      if (tile === undefined || tile.lodLevel !== lod) continue;
      if (Math.floor(tile.tileX / 4) !== blockX || Math.floor(tile.tileZ / 4) !== blockZ) continue;
      const level = tile.lod.levels[tile.lodLevel]?.object;
      if (!(level instanceof Mesh)) continue;
      members += 1;
      for (const point of worldVertices(level)) {
        const distance = nearestDistance(point, merged);
        expect(
          distance,
          `block '${block.name}' vertex is ${distance.toFixed(3)}m from the tile vertex at (${point.x.toFixed(
            3,
          )}, ${point.y.toFixed(3)}, ${point.z.toFixed(3)})`,
        ).toBeLessThan(1e-4);
      }
    }
    expect(members).toBeGreaterThan(0);
  }
}

describe("TerrainTiles merge", () => {
  it("merges by default and reads an opt-out from the environment, the query string and the global", () => {
    const previousEnv = process.env.TN_TERRAIN_MERGE;
    const previousSearch = (globalThis as { location?: Location }).location?.search;
    const previousGlobal = (globalThis as { __tnTerrainMerge?: unknown }).__tnTerrainMerge;
    try {
      for (const [env, search, global, expected] of [
        [undefined, "", undefined, true],
        ["1", "", undefined, true],
        ["0", "", undefined, false],
        ["false", "", undefined, false],
        [undefined, "?tnTerrainMerge=0", undefined, false],
        [undefined, "?tnTerrainMerge=1", undefined, true],
        [undefined, "", 0, false],
        [undefined, "", 1, true],
      ] as const) {
        if (env === undefined) Reflect.deleteProperty(process.env, "TN_TERRAIN_MERGE");
        else process.env.TN_TERRAIN_MERGE = env;
        Object.defineProperty(globalThis, "location", { configurable: true, value: { search } });
        Reflect.deleteProperty(globalThis, "__tnTerrainMerge");
        if (global !== undefined)
          (globalThis as { __tnTerrainMerge?: unknown }).__tnTerrainMerge = global;
        const tiles = new TerrainTiles({
          residentByteBudget: 64_000_000,
          residentTileBudget: 8,
          sampleHeight,
          streamRadius: 1,
          surface: new MeshBasicMaterial(),
          tileResolution: 33,
          tileSize: 16,
        });
        tiles.follow({ x: 16, z: 16 });
        expect(tiles.terrainTiles.blocks > 0).toBe(expected);
        tiles.dispose();
      }
    } finally {
      if (previousEnv === undefined) Reflect.deleteProperty(process.env, "TN_TERRAIN_MERGE");
      else process.env.TN_TERRAIN_MERGE = previousEnv;
      Object.defineProperty(globalThis, "location", {
        configurable: true,
        value: previousSearch === undefined ? undefined : { search: previousSearch },
      });
      Reflect.deleteProperty(globalThis, "__tnTerrainMerge");
      if (previousGlobal !== undefined)
        (globalThis as { __tnTerrainMerge?: unknown }).__tnTerrainMerge = previousGlobal;
    }
  });

  it("reports the tile census beside the lodTransitions stat, counting the meshes it submits", () => {
    for (const mergeTiles of [false, true]) {
      const tiles = terrain(mergeTiles);
      try {
        tiles.follow({ x: 16, z: 16 });
        const stat = tiles.debug().terrainTiles as {
          blending: number;
          blocks: number;
          draws: number;
          tiles: number;
        };
        expect(stat.draws).toBe(submittedMeshes(tiles));
        expect(stat.tiles).toBe(tiles.residentTileCount);
        expect(stat.blending).toBe(tiles.blendingTiles);
        expect(stat.blocks).toBe(mergeTiles ? 1 : 0);
      } finally {
        tiles.dispose();
      }
    }
  });

  it("draws a block away from the world origin where its tiles are", () => {
    const tiles = terrain(true);
    try {
      settled(tiles, { x: 48, z: 48 });
      expectBlocksOnTheirTiles(tiles);
    } finally {
      tiles.dispose();
    }
  });

  it("draws a block on its tiles under a translated terrain root", () => {
    const tiles = terrain(true);
    const root = new Object3D();
    root.position.set(120, 0, -80);
    root.add(tiles);
    try {
      settled(tiles, { x: 48, z: 48 });
      root.updateMatrixWorld(true);
      expectBlocksOnTheirTiles(tiles);
    } finally {
      root.remove(tiles);
      tiles.dispose();
    }
  });

  it("reports a merged block's bytes without charging them to the tiles they duplicate", () => {
    const walk = (mergeTiles: boolean): { blockBytes: number; tileBytes: number } => {
      const tiles = terrain(mergeTiles);
      try {
        tiles.follow({ x: 16, z: 16 });
        return {
          blockBytes: tiles.terrainTiles.blockBytes,
          tileBytes: tiles.residentBytes,
        };
      } finally {
        tiles.dispose();
      }
    };
    const merged = walk(true);
    const unmerged = walk(false);
    // A block holds a copy of level vertices its tiles already hold, so the copy is reported as its
    // own stat and never charged to admission: `residentBytes` is the nine tiles either way.
    expect(merged.blockBytes).toBeGreaterThan(0);
    expect(unmerged.blockBytes).toBe(0);
    expect(merged.tileBytes).toBe(unmerged.tileBytes);
  });

  it("admits the same ring with the merge on as with it off, at a budget sized for unmerged terrain", () => {
    const walk = [16, 24, 40, 56, 72, 88, 104, 120, 136, 152];
    const tiles = (mergeTiles: boolean, residentByteBudget = 64_000_000): TerrainTiles =>
      terrain(mergeTiles, { residentByteBudget, streamRadius: 4 });
    /** Resident bytes and the fewest tiles resident at any step: a ring only partly admitted
     * mid-walk is what losing terrain detail looks like from the game's side of the seam. */
    const walkRing = (mergeTiles: boolean, residentByteBudget?: number) => {
      const ring = tiles(mergeTiles, residentByteBudget);
      try {
        let minimumTiles = 0;
        let peakBytes = 0;
        for (const x of walk) {
          for (let frame = 0; frame < 6; frame += 1) ring.follow({ x, z: 16 });
          minimumTiles =
            minimumTiles === 0
              ? ring.residentTileCount
              : Math.min(minimumTiles, ring.residentTileCount);
          peakBytes = Math.max(peakBytes, ring.residentBytes);
        }
        return { minimumTiles, peakBytes };
      } finally {
        ring.dispose();
      }
    };
    // A budget sized for the unmerged walk must admit that same walk with the merge on: a block is a
    // derived copy of tiles that are already resident, so charging it evicts real terrain detail.
    const unmerged = walkRing(false);
    expect(walkRing(true, unmerged.peakBytes).minimumTiles).toBe(unmerged.minimumTiles);
  });

  it("appends the seam and LOD-pop measurements to the tile marker only when validation is on", () => {
    const marker = (validate: boolean): string => {
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      const tiles = terrain(false, { validate });
      try {
        tiles.follow({ x: 16, z: 16 });
        tiles.process();
        const line = info.mock.calls.map((call) => String(call[0]));
        info.mockRestore();
        const found = line.find((value) => value.startsWith("TN_TERRAIN_TILES"));
        if (found === undefined) throw new Error("The tile marker never printed.");
        return found;
      } finally {
        tiles.dispose();
      }
    };
    expect(marker(true)).toContain("maxSeamGap=");
    expect(marker(true)).toContain("maxLodPop=");
    expect(marker(true)).toContain("maxVisualSeamGap=");
    expect(marker(false)).not.toContain("maxSeamGap=");
  });

  it("leaves the draw structure untouched with the merge off", () => {
    const tiles = terrain(false);
    try {
      tiles.follow({ x: 16, z: 16 });
      expect(blockMeshes(tiles)).toHaveLength(0);
      expect(tiles.terrainTiles.blocks).toBe(0);
      expect(tiles.terrainTiles.draws).toBe(tiles.residentTileCount);
      expect(tiles.terrainTiles.tiles).toBe(tiles.residentTileCount);
      for (const key of tiles.residentKeys) {
        const tile = tiles.getTile(key);
        if (tile === undefined) throw new Error("Expected a resident tile.");
        expect(tile.lod.levels.some(({ object }) => object.visible)).toBe(true);
      }
    } finally {
      tiles.dispose();
    }
  });

  it("merges a settled same-LOD island into one draw whose positions equal the tiles' concatenation", () => {
    const tiles = terrain(true);
    try {
      tiles.follow({ x: 16, z: 16 });
      expect(tiles.terrainTiles.blocks).toBe(1);
      expect(tiles.terrainTiles.draws).toBe(1);
      expect(tiles.terrainTiles.tiles).toBe(9);
      const [block] = blockMeshes(tiles);
      if (block === undefined) throw new Error("Expected one merged block.");
      const { blockX, blockZ } = blockKey(block);
      const originX = blockX * 4 * 16;
      const originZ = blockZ * 4 * 16;
      const expected: string[] = [];
      const expectedNormals: string[] = [];
      const expectedTriangles = new Map<string, number>();
      for (const key of tiles.residentKeys) {
        const tile = tiles.getTile(key);
        if (tile === undefined) throw new Error(`Missing resident tile '${key}'.`);
        const offsetX = tile.tileX * 16 - originX;
        const offsetZ = tile.tileZ * 16 - originZ;
        expected.push(...levelWorldKeys(tiles, key, 0, offsetX, offsetZ));
        const level = tile.lod.levels[0]?.object;
        if (!(level instanceof Mesh)) throw new Error("Missing level 0.");
        expectedNormals.push(...normalKeys(level.geometry, offsetX, offsetZ));
        for (const [triangle, count] of triangleKeys(level.geometry, offsetX, offsetZ))
          expectedTriangles.set(triangle, (expectedTriangles.get(triangle) ?? 0) + count);
      }
      const expectedCounts = sortedCounts(expected);
      const actualCounts = sortedCounts(mergedWorldKeys(block, 0, 0));
      expect(actualCounts.size).toBe(expectedCounts.size);
      expect(actualCounts).toEqual(expectedCounts);
      // One visible mesh for the island, and every vertex carrying the normal and the triangles of
      // the tile it came from: the merge moved no vertex and dropped no triangle.
      expect(submittedMeshes(tiles)).toBe(1);
      expect(sortedCounts(normalKeys(block.geometry, 0, 0))).toEqual(sortedCounts(expectedNormals));
      expect(triangleKeys(block.geometry, 0, 0)).toEqual(expectedTriangles);
    } finally {
      tiles.dispose();
    }
  });

  it("rebuilds one dirty block per frame, so three dirty blocks take three frames", () => {
    const tiles = terrain(true);
    try {
      // Following (0, 0) splits the 3x3 ring across four block cells, so one follow leaves three
      // block-forming rebuilds dirty at once.
      tiles.follow({ x: 0, z: 0 });
      expect(tiles.terrainTiles.rebuilds).toBeLessThanOrEqual(1);
      let frames = 1;
      while (tiles.terrainTiles.rebuilds < 3 && frames < 8) {
        const before = tiles.terrainTiles.rebuilds;
        tiles.follow({ x: 0, z: 0 });
        expect(tiles.terrainTiles.rebuilds - before).toBeLessThanOrEqual(1);
        frames += 1;
      }
      expect(frames).toBeGreaterThanOrEqual(3);
      expect(tiles.terrainTiles.blocks).toBe(3);
      expect(tiles.terrainTiles.draws).toBe(4);
      // Nothing is left dirty, so a settled follow point builds nothing.
      const settled = tiles.terrainTiles.rebuilds;
      tiles.follow({ x: 0, z: 0 });
      expect(tiles.terrainTiles.rebuilds).toBe(settled);
    } finally {
      tiles.dispose();
    }
  });

  it("defers a rebuild the frame budget refuses to the next frame that allows it", () => {
    const tiles = terrain(true);
    try {
      tiles.follow({ x: 16, z: 16 });
      expect(tiles.terrainTiles.blocks).toBe(1);
      const rebuilds = tiles.terrainTiles.rebuilds;
      // The point moves 24 tiles away, so the ring and its blocks are all dirty again, and the frame
      // pays for nothing: the rebuild waits instead of being dropped.
      tiles.follow({ x: 400, z: 0 }, { admit: () => false });
      expect(tiles.terrainTiles.rebuilds).toBe(rebuilds);
      expect(tiles.deferredAdmissions).toBeGreaterThan(0);
      // Every frame that allows the work rebuilds one block, so the ring here converges.
      let frames = 0;
      while (frames < 12 && tiles.terrainTiles.rebuilds === rebuilds) {
        tiles.follow(
          { x: 400, z: 0 },
          {
            admit: (work) => {
              work();
              return true;
            },
          },
        );
        frames += 1;
      }
      expect(frames).toBeLessThan(12);
      expect(tiles.terrainTiles.rebuilds).toBe(rebuilds + 1);
      for (let frame = 0; frame < 12; frame += 1)
        tiles.follow(
          { x: 400, z: 0 },
          {
            admit: (work) => {
              work();
              return true;
            },
          },
        );
      // The stale block at the old point is gone and nothing is left dirty.
      const settled = tiles.terrainTiles.rebuilds;
      tiles.follow(
        { x: 400, z: 0 },
        {
          admit: (work) => {
            work();
            return true;
          },
        },
      );
      expect(tiles.terrainTiles.rebuilds).toBe(settled);
      expect(tiles.terrainTiles.draws).toBe(submittedMeshes(tiles));
    } finally {
      tiles.dispose();
    }
  });

  it("re-merges a blending tile's block on a later frame once its blend ends", () => {
    const tiles = terrain(true, { lodDistances: [8], lodFactors: [1, 2] });
    try {
      tiles.follow({ x: 16, z: 16 });
      tiles.follow({ x: 24.5, z: 16 });
      expect(tiles.blendingTiles).toBeGreaterThan(0);
      // The blend is three frames, and the block that will take the tile back is rebuilt on a frame
      // of its own, so the tile must not stay an individual mesh for good.
      for (let frame = 0; frame < 8 && tiles.blendingTiles > 0; frame += 1) {
        tiles.process();
        tiles.follow({ x: 24.5, z: 16 });
      }
      expect(tiles.blendingTiles).toBe(0);
      const merged = tiles.residentKeys.filter((key) => {
        const tile = tiles.getTile(key);
        if (tile === undefined) throw new Error(`Missing resident tile '${key}'.`);
        return !tile.lod.levels.some(({ object }) => object.visible);
      });
      expect(merged.length).toBeGreaterThan(0);
      expect(tiles.terrainTiles.draws).toBe(submittedMeshes(tiles));
    } finally {
      tiles.dispose();
    }
  });

  it("dissolves blocks and restores individual meshes when tiles stream out", () => {
    const tiles = terrain(true);
    try {
      tiles.follow({ x: 16, z: 16 });
      const [block] = blockMeshes(tiles);
      if (block === undefined) throw new Error("Expected a merged block.");
      const geometry = block.geometry;
      let disposed = false;
      const original = geometry.dispose.bind(geometry);
      geometry.dispose = () => {
        disposed = true;
        original();
      };
      expect(tiles.terrainTiles.blocks).toBe(1);
      tiles.follow({ x: 16 + 200, z: 16 + 200 });
      expect(blockMeshes(tiles)).not.toContain(block);
      expect(disposed).toBe(true);
    } finally {
      tiles.dispose();
    }
  });

  it("keeps a lone block member individual rather than copying its geometry", () => {
    const tiles = terrain(true);
    try {
      // One block per frame, so the ring is followed until every cell has been rebuilt.
      for (let frame = 0; frame < 8 && tiles.terrainTiles.rebuilds < 3; frame += 1)
        tiles.follow({ x: 0, z: 0 });
      // tileX -1..1 x tileZ -1..1 splits into three blocks of two or more tiles and one lone tile.
      expect(tiles.terrainTiles.blocks).toBe(3);
      expect(tiles.terrainTiles.tiles).toBe(9);
      expect(tiles.terrainTiles.draws).toBe(4);
    } finally {
      tiles.dispose();
    }
  });

  it("excludes a morphing tile from its block until the blend ends", () => {
    const options = { lodDistances: [8], lodFactors: [1, 2] };
    const tiles = terrain(true, options);
    try {
      tiles.follow({ x: 16, z: 16 });
      tiles.follow({ x: 24.5, z: 16 });
      expect(tiles.blendingTiles).toBeGreaterThan(0);
      for (const block of blockMeshes(tiles)) {
        const { lod, blockX, blockZ } = blockKey(block);
        let expectedVertices = 0;
        let members = 0;
        for (const key of tiles.residentKeys) {
          const tile = tiles.getTile(key);
          if (tile === undefined) continue;
          const transitioned = (tile as { lodTransition?: unknown }).lodTransition !== undefined;
          if (transitioned || tile.lodLevel !== lod) continue;
          if (Math.floor(tile.tileX / 4) !== blockX || Math.floor(tile.tileZ / 4) !== blockZ)
            continue;
          const level = tile.lod.levels[lod]?.object;
          if (!(level instanceof Mesh)) continue;
          expectedVertices += level.geometry.getAttribute("position").count;
          members += 1;
        }
        if (members >= 2)
          expect(block.geometry.getAttribute("position").count).toBe(expectedVertices);
      }
      // The morphing tile still draws through its own visible mesh, not through the block.
      let visibleIndividual = 0;
      for (const key of tiles.residentKeys) {
        const tile = tiles.getTile(key);
        if (tile === undefined) continue;
        if ((tile as { lodTransition?: unknown }).lodTransition === undefined) continue;
        expect(tile.lod.levels.some(({ object }) => object.visible)).toBe(true);
        visibleIndividual += 1;
      }
      expect(visibleIndividual).toBe(tiles.blendingTiles);
    } finally {
      tiles.dispose();
    }
  });

  it("measures the same seam gap with the merge on and off", () => {
    const walk = (mergeTiles: boolean): number => {
      const tiles = terrain(mergeTiles, { lodDistances: [8], lodFactors: [1, 2], validate: true });
      try {
        for (let frame = 0; frame < 12; frame += 1) {
          tiles.follow({ x: 16 + frame * 0.4, z: 16 });
          tiles.process();
        }
        const gap = tiles.maxSeamGap;
        if (gap === undefined) throw new Error("Expected a validated seam gap.");
        return gap;
      } finally {
        tiles.dispose();
      }
    };
    const unmerged = walk(false);
    const merged = walk(true);
    expect(merged).toBe(unmerged);
  });

  it("disposes every merged block geometry on release", () => {
    const tiles = terrain(true);
    try {
      tiles.follow({ x: 16, z: 16 });
      const geometries: BufferGeometry[] = blockMeshes(tiles).map((mesh) => mesh.geometry);
      expect(geometries.length).toBeGreaterThan(0);
      const disposed = geometries.map(() => false);
      geometries.forEach((geometry, index) => {
        const original = geometry.dispose.bind(geometry);
        geometry.dispose = () => {
          disposed[index] = true;
          original();
        };
      });
      tiles.dispose();
      expect(tiles.children).toHaveLength(0);
      expect(disposed.every((value) => value)).toBe(true);
    } finally {
      tiles.dispose();
    }
  });
});
