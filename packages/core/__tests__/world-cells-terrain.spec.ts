import { BoxGeometry, Group, Mesh, MeshBasicMaterial, type Object3D } from "three";
import { describe, expect, it, vi } from "vitest";
import { Terrain, bakeWorldPackage } from "../../../packages/terrain/src/index.js";
import type { IAssetLoader } from "../src/assets.js";
import { type IWorldPackage, WorldCells } from "../src/world.js";

/** Single asset declaration for the test terrain */
const ASSETS = {
  fir: {
    bounds: { max: [3, 14, 3] as const, min: [-3, 0, -3] as const },
    glb: "models/fir.glb",
    lods: [{ distance: 50, glb: "models/fir-mid.glb" }],
    maxDistance: 300,
  },
};

function makeModel(): Object3D {
  const group = new Group();
  group.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));
  return group;
}

function cacheLoader(): IAssetLoader {
  return {
    audio: () => Promise.reject(new Error("unused")),
    clear: () => {},
    model: (<T>() =>
      Promise.resolve({ scene: makeModel() } as unknown as T)) as IAssetLoader["model"],
    progress: { pending: [], requested: 0, requestedBytes: 0, settled: 0, settledBytes: 0 },
    release: () => true,
    resolve: (p) => Promise.resolve([p]),
    resolved: new Map(),
    texture: () => Promise.reject(new Error("unused")),
  };
}

describe("WorldCells baked terrain package integration", () => {
  it("loads a real baked 3x3-cell package and verifies resident cells and instances during walk", async () => {
    let world: WorldCells | undefined;
    try {
      // 192m extent with cellSize 64 -> exactly 3x3 cells (extent -96 to 96)
      const terrain = new Terrain({ resolution: 65, seed: 123, size: 192 })
        .scatter({ id: "firs", asset: "fir", count: 90, minDistance: 2 })
        .evaluate();

      const baked = bakeWorldPackage(terrain, { assets: ASSETS, cellSize: 64 });
      const manifest = baked.manifest as IWorldPackage;

      expect(manifest.cells).toHaveLength(9);
      const expectedCells = new Map<string, number>();
      for (const cell of manifest.cells) {
        const count = cell.runs.reduce((acc, run) => acc + run.count, 0);
        expectedCells.set(`${cell.x}:${cell.z}`, count);
      }

      // Verify every cell has placements
      expect(expectedCells.size).toBe(9);
      const totalInstances = Array.from(expectedCells.values()).reduce((a, b) => a + b, 0);
      expect(totalInstances).toBe(terrain.instances.length);

      const files = baked.files;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: unknown) => {
          const raw = String(url);
          const filename = raw.replace(/^\//u, "").replace(/^world\//u, "");
          if (filename.endsWith("world.json")) {
            return {
              ok: true,
              json: async () => manifest,
              arrayBuffer: async () => new TextEncoder().encode(JSON.stringify(manifest)).buffer,
            };
          }
          const data = files[filename];
          if (data) {
            const buffer = (data as Uint8Array).buffer.slice(
              (data as Uint8Array).byteOffset,
              (data as Uint8Array).byteOffset + (data as Uint8Array).byteLength,
            );
            return {
              ok: true,
              arrayBuffer: async () => buffer,
              json: async () => JSON.parse(new TextDecoder().decode(buffer)),
            };
          }
          return { ok: false, status: 404 };
        }),
      );

      const follow = { position: { x: -64, z: -64 } };
      world = await WorldCells.load({
        url: "world/world.json",
        assets: cacheLoader(),
        follow,
        surface: new MeshBasicMaterial(),
        budgets: { bytes: 1_000_000_000, instances: 1_000_000, residentCells: 64 },
        ring: 0,
        lodHysteresis: 0,
        gpuScene: false,
        impostors: false,
        admissionBudgetMs: 10_000,
        freshMeshesPerUpdate: 100,
      });

      const drainWorld = async (activeWorld: WorldCells) => {
        for (let pass = 0; pass < 200; pass += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          activeWorld.update();
          const stats = activeWorld.stats();
          if (stats.admission.backlog === 0 && stats.loadsInFlight === 0) return;
        }
        throw new Error("Timed out waiting for WorldCells to settle drain within bounds");
      };

      // Walk across cells from (0, 0) to (2, 2)
      // Chebyshev distance > ring + 1 (0 + 1 = 1) evicts leaving cells.
      // From (0, 0):
      //   At (0, 0): resident [0:0]
      //   Move to (1, 1): distance from (0, 0) is max(1, 1) = 1 <= 1 (kept by hysteresis) -> [0:0, 1:1]
      //   Move to (2, 2): distance from (0, 0) is max(2, 2) = 2 > 1 -> (0, 0) evicted; distance from (1, 1) is 1 <= 1 -> [1:1, 2:2]
      const waypoints: Array<{ x: number; z: number; expectedKeys: string[] }> = [
        { x: -64, z: -64, expectedKeys: ["0:0"] },
        { x: 0, z: 0, expectedKeys: ["0:0", "1:1"] },
        { x: 64, z: 64, expectedKeys: ["1:1", "2:2"] },
      ];

      for (const { x, z, expectedKeys } of waypoints) {
        follow.position.x = x;
        follow.position.z = z;
        await drainWorld(world);

        const stats = world.stats();
        expect(new Set(stats.residentKeys)).toEqual(new Set(expectedKeys));
        expect(stats.residentCells).toBe(expectedKeys.length);
        const expectedInstanceCount = expectedKeys.reduce(
          (sum, k) => sum + (expectedCells.get(k) ?? 0),
          0,
        );
        expect(stats.instances).toBe(expectedInstanceCount);
      }
    } finally {
      world?.dispose();
      vi.unstubAllGlobals();
    }
  });
});
