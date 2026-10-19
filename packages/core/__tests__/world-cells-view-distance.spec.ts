import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BoxGeometry, Group, Mesh, MeshBasicMaterial } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type IWorldPackage, WorldCells } from "../src/world.js";

/**
 * PRD-461: terrain reaches further than the props, and physics covers less than either.
 *
 * The committed fixture is 4x4 cells, too small for a ring-2 square, so this re-grids its 256 m
 * heightmap into 8x8 empty cells of 32 m. Residency counts cells, not placements, and the terrain
 * tiles default to the cell size, so the counts below are the recipe's own: 25 cells, 49 tiles and
 * 9 bodies around a follow point in the middle of the grid.
 */

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "world-v1");
const source = JSON.parse(readFileSync(path.join(fixture, "world.json"), "utf8")) as IWorldPackage;
const CELL_SIZE = 32;
const cells = Array.from({ length: 64 }, (_, index) => ({
  runs: [],
  x: index % 8,
  z: Math.floor(index / 8),
}));
const manifest = { ...source, cellSize: CELL_SIZE, cells };

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      const buffer = url.endsWith("world.json")
        ? Buffer.from(JSON.stringify(manifest))
        : url.endsWith("placements.bin")
          ? readFileSync(path.join(fixture, "placements.bin"))
          : url.endsWith("heightmap.u16")
            ? readFileSync(path.join(fixture, "terrain", "heightmap.u16"))
            : undefined;
      return {
        ok: buffer !== undefined,
        status: buffer === undefined ? 404 : 200,
        headers: new Headers(),
        arrayBuffer: async () =>
          buffer === undefined
            ? new ArrayBuffer(0)
            : (buffer.buffer.slice(
                buffer.byteOffset,
                buffer.byteOffset + buffer.byteLength,
              ) as ArrayBuffer),
        json: async () => JSON.parse(buffer?.toString("utf8") ?? "{}"),
      };
    }),
  );
}

async function world(terrain: { streamRadius?: number; colliderRadius?: number }) {
  stubFetch();
  // The middle of cell (4, 4), so the ring-2 and terrain-3 squares both fit inside the 8x8 grid.
  const follow = {
    position: {
      x: source.extent.minX + 4.5 * CELL_SIZE,
      z: source.extent.minZ + 4.5 * CELL_SIZE,
    },
  };
  const live = new Set<string>();
  const cellsWorld = await WorldCells.load({
    // Unbounded admission, so one update reaches the steady state these counts describe.
    admissionBudgetMs: Number.POSITIVE_INFINITY,
    freshMeshesPerUpdate: Number.MAX_SAFE_INTEGER,
    budgets: { bytes: 1_000_000_000, instances: 1_000_000, residentCells: 64 },
    createCollider: ({ key }) => {
      live.add(key);
      return { dispose: () => live.delete(key) };
    },
    follow,
    loadModel: async () => new Group().add(new Mesh(new BoxGeometry(), new MeshBasicMaterial())),
    ring: 2,
    surface: new MeshBasicMaterial(),
    terrain: { tileResolution: 9, ...terrain },
    url: "/world/world.json",
  });
  cellsWorld.update();
  return { follow, live, world: cellsWorld };
}

describe("WorldCells view distance", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("streams terrain to its own radius: 25 cells, 49 tiles and 9 bodies for the recipe", async () => {
    const { live, world: cellsWorld } = await world({ colliderRadius: 1, streamRadius: 3 });
    const stats = cellsWorld.stats();
    expect(stats.residentCells).toBe(25);
    expect(stats.residentTiles).toBe(49);
    expect(stats.residentColliders).toBe(9);
    expect(live.size).toBe(9);
    cellsWorld.dispose();
    expect(live.size).toBe(0);
  });

  it("control: the ring-derived terrain radius gives the props' 25 tiles, every one collidered", async () => {
    const { world: cellsWorld } = await world({});
    const stats = cellsWorld.stats();
    expect(stats.residentCells).toBe(25);
    expect(stats.residentTiles).not.toBe(49);
    expect(stats.residentTiles).toBe(25);
    expect(stats.residentColliders).toBe(25);
    cellsWorld.dispose();
  });

  it("moves the bodies with the follow point while the terrain keeps drawing", async () => {
    const { follow, live, world: cellsWorld } = await world({ colliderRadius: 1, streamRadius: 3 });
    follow.position.x += CELL_SIZE;
    cellsWorld.update();
    const stats = cellsWorld.stats();
    expect(stats.residentColliders).toBe(9);
    expect(live.size).toBe(9);
    // The column the follow point left is still drawn, but it no longer has a body.
    expect(stats.residentTiles).toBeGreaterThanOrEqual(49);
    cellsWorld.dispose();
  });
});
