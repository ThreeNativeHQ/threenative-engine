import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type IWorldPackage,
  cellPlacements,
  validateWorldPackage,
} from "../../core/src/world-package.js";
import { editWorldPlacements } from "../src/core/placement-edits.js";
import type { IPlacementOverride } from "../src/core/types.js";
import { Terrain, applyPlacementOverrides, bakeWorldPackage } from "../src/index.js";

const ASSETS = {
  rock: { bounds: { min: [-1, 0, -1], max: [1, 2, 1] }, glb: "models/rock.glb" },
  tree: { bounds: { min: [-2, 0, -2], max: [2, 8, 2] }, glb: "models/tree.glb" },
} as const;

type TestManifest = IWorldPackage & { readonly placementIds?: string };

const HEIGHTMAP = {
  columns: 3,
  heightMax: 20,
  heightMin: 0,
  heightmap: "heightmap.u16",
  rows: 3,
  spacing: 10,
};

function proxy(scope: "cell" | "chunks") {
  return { error: 0.1, glb: "proxies/cell.glb", materialGroups: 1, scope, triangles: 1 } as const;
}

function fixture(withIds = true): {
  manifest: TestManifest;
  placements: ArrayBuffer;
  ids?: readonly string[];
} {
  const placements = new Float32Array([
    2, 1, 2, 0, 0, 0, 1, 1, 4, 1, 4, 0, 0, 0, 1, 1, 12, 2, 2, 0, 0, 0, 1, 1,
  ]);
  const ids = ["rock-a", "rock-b", "tree-a"];
  const manifest = {
    assets: ASSETS,
    cellSize: 10,
    cells: [
      {
        chunks: ["chunks/0.glb"],
        proxy: proxy("cell"),
        runs: [{ asset: "rock", count: 2, offset: 0 }],
        x: 0,
        z: 0,
      },
      {
        chunks: ["chunks/1.glb"],
        proxy: proxy("chunks"),
        runs: [{ asset: "tree", count: 1, offset: 2 }],
        x: 1,
        z: 0,
      },
      {
        chunks: ["chunks/empty.glb"],
        proxy: proxy("cell"),
        runs: [],
        x: 1,
        z: 1,
      },
    ],
    extent: { minX: 0, minZ: 0, sizeX: 20, sizeZ: 20 },
    ...(withIds ? { placementIds: "placement-ids.json" } : {}),
    placements: "placements.bin",
    terrain: HEIGHTMAP,
    version: 1,
  } as TestManifest;
  return { ids: withIds ? ids : undefined, manifest, placements: placements.buffer };
}

function heightAt(x: number, z: number): number {
  return x + z;
}

function records(data: {
  manifest: IWorldPackage;
  placements: ArrayBuffer;
  ids?: readonly string[];
}) {
  const result = new Map<string, number[]>();
  for (const cell of data.manifest.cells)
    for (const run of cell.runs) {
      const values = cellPlacements(data.placements, run);
      for (let i = 0; i < run.count; i += 1) {
        const index = run.offset + i;
        result.set(data.ids?.[index] ?? `record-${String(index)}`, [
          ...(values.subarray(i * 8, i * 8 + 8) as Float32Array),
        ]);
      }
    }
  return result;
}

function transform(position: readonly [number, number, number], grounding = false) {
  return {
    grounding,
    position,
    quaternion: [0, 0, 0, 1] as const,
    scale: [1, 1, 1] as const,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("editWorldPlacements", () => {
  it("applies assets, remove, clear, overrides and add in order while preserving cells and proxies", () => {
    const data = fixture();
    const edited = editWorldPlacements(
      data,
      {
        add: [{ ...transform([15, 0, 15], true), asset: "tree", id: "camp-tree" }],
        assets: { rock: { ...ASSETS.rock, glb: "models/rock-painted.glb" } },
        clear: [{ center: [3, 3], radius: 4 }],
        overrides: { "rock-a": transform([3, 3, 3]) },
        remove: ["tree-a"],
      },
      heightAt,
    );

    expect(edited.ids).toEqual(["rock-a", "camp-tree"]);
    expect(edited.manifest.assets.rock?.glb).toBe("models/rock-painted.glb");
    expect([...records(edited).keys()]).toEqual(["rock-a", "camp-tree"]);
    expect(records(edited).get("rock-a")?.slice(0, 3)).toEqual([3, 3, 3]);
    expect(records(edited).get("camp-tree")?.slice(0, 3)).toEqual([15, 30, 15]);
    expect(edited.removed).toEqual([
      { asset: "tree", id: "tree-a", position: [12, 2, 2], quaternion: [0, 0, 0, 1], scale: 1 },
    ]);

    const cells = new Map(edited.manifest.cells.map((cell) => [`${cell.x},${cell.z}`, cell]));
    expect(cells.get("0,0")?.chunks).toEqual(["chunks/0.glb"]);
    expect(cells.get("0,0")?.proxy).toBeUndefined();
    expect(cells.get("1,0")?.runs).toEqual([]);
    expect(cells.get("1,0")?.chunks).toEqual(["chunks/1.glb"]);
    expect(cells.get("1,0")?.proxy?.scope).toBe("chunks");
    expect(cells.get("1,1")?.chunks).toEqual(["chunks/empty.glb"]);
    expect(cells.get("1,1")?.proxy).toBeUndefined();
    expect(
      validateWorldPackage(edited.manifest, { placementsByteLength: edited.placements.byteLength })
        .ok,
    ).toBe(true);
  });

  it("warns once for unmatched IDs and rejects ID conflicts, duplicates and stale packages", () => {
    const data = fixture();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    editWorldPlacements(
      data,
      { overrides: { missing: transform([1, 1, 1]) }, remove: ["also-missing"] },
      heightAt,
    );
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0]?.[0]).toContain("missing");
    expect(warning.mock.calls[0]?.[0]).toContain("also-missing");

    expect(() =>
      editWorldPlacements(
        data,
        { overrides: { "rock-a": transform([1, 1, 1]) }, remove: ["rock-a"] },
        heightAt,
      ),
    ).toThrow(/both remove and overrides/);
    expect(() =>
      editWorldPlacements({ ...data, ids: ["rock-a", "rock-a", "tree-a"] }, {}, heightAt),
    ).toThrow(/unique/);
    expect(() => editWorldPlacements({ ...data, ids: ["rock-a"] }, {}, heightAt)).toThrow(/count/);
    expect(() => editWorldPlacements(fixture(false), { remove: ["rock-a"] }, heightAt)).toThrow(
      /re-bake once/,
    );
    expect(() =>
      editWorldPlacements(
        data,
        { add: [{ ...transform([5, 5, 5]), asset: "rock", id: "rock-a" }] },
        heightAt,
      ),
    ).toThrow(/already exists/);
    expect(() =>
      editWorldPlacements(
        data,
        {
          add: [
            { ...transform([5, 5, 5]), asset: "rock", id: "new" },
            { ...transform([6, 6, 6]), asset: "rock", id: "new" },
          ],
        },
        heightAt,
      ),
    ).toThrow(/duplicate/);
  });

  it("validates asset paths and lets clear, add and asset edits work without a sidecar", () => {
    const data = fixture(false);
    const edited = editWorldPlacements(
      data,
      {
        add: [{ ...transform([15, 0, 15]), asset: "boulder", id: "new-boulder" }],
        assets: {
          boulder: {
            bounds: { min: [-1, 0, -1], max: [1, 1, 1] },
            glb: "models/boulder.glb",
          } as const,
        },
        clear: [{ assets: ["rock"], center: [4, 4], radius: 0 }],
      },
      heightAt,
    );
    expect(edited.ids).toBeUndefined();
    expect(records(edited).size).toBe(3);
    expect(edited.manifest.assets.boulder?.glb).toBe("models/boulder.glb");
    expect(() =>
      editWorldPlacements(
        data,
        { assets: { rock: { ...ASSETS.rock, glb: "https://example.test/rock.glb" } } },
        heightAt,
      ),
    ).toThrow(/package-relative/);
    expect(() =>
      editWorldPlacements(
        data,
        { assets: { rock: { ...ASSETS.rock, glb: "../outside.glb" } } },
        heightAt,
      ),
    ).toThrow(/package-relative/);
  });

  it.each(["asset", "unknown"])("rejects clear field %s without changing input bytes", (key) => {
    const data = fixture();
    const before = new Uint8Array(data.placements).slice();
    const circle = { center: [7, 3] as const, radius: 6 };
    expect(editWorldPlacements(data, { clear: [circle] }, heightAt).ids).toEqual([]);
    expect(
      editWorldPlacements(data, { clear: [{ ...circle, assets: ["rock"] }] }, heightAt).ids,
    ).toEqual(["tree-a"]);

    expect(() =>
      editWorldPlacements(data, { clear: [{ ...circle, [key]: ["rock"] }] }, heightAt),
    ).toThrow(/clear\[0\].*unknown field/);
    expect(new Uint8Array(data.placements)).toEqual(before);
  });

  it("keeps rectangular legacy placements in their Z cells when clearing and adding", () => {
    const data = {
      manifest: {
        assets: ASSETS,
        cellSize: 4,
        cells: [{ x: 0, z: 1, runs: [{ asset: "rock", count: 1, offset: 0 }] }],
        extent: { minX: 0, minZ: 0, sizeX: 4, sizeZ: 8 },
        terrain: { ...HEIGHTMAP, columns: 2, rows: 3, spacing: 4 },
        placements: "placements.bin",
        version: 1,
      } as IWorldPackage,
      placements: new Float32Array([2, 1, 6, 0, 0, 0, 1, 1]).buffer,
    };
    const edited = editWorldPlacements(
      data,
      {
        clear: [{ center: [0, 0], radius: 0 }],
        add: [{ ...transform([3, 1, 8]), asset: "rock", id: "new-rock" }],
      },
      heightAt,
    );

    expect(edited.ids).toBeUndefined();
    expect(edited.manifest.cells).toEqual([
      { x: 0, z: 1, runs: [{ asset: "rock", count: 2, offset: 0 }] },
    ]);
    expect([...records(edited).values()].map((record) => record.slice(0, 3))).toEqual([
      [2, 1, 6],
      [3, 1, 8],
    ]);
  });

  it("defaults grounding on, honors grounding false, and validates the written record", () => {
    const data = fixture();
    const edited = editWorldPlacements(
      data,
      {
        add: [{ ...transform([15, 0, 15], true), asset: "tree", id: "grounded" }],
        overrides: {
          "rock-a": { position: [5, 9, 5], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
          "rock-b": { ...transform([5, 8, 5]), grounding: false },
        },
      },
      heightAt,
    );
    expect(records(edited).get("rock-a")?.slice(0, 3)).toEqual([5, 10, 5]);
    expect(records(edited).get("rock-b")?.slice(0, 3)).toEqual([5, 8, 5]);
    expect(records(edited).get("grounded")?.slice(0, 3)).toEqual([15, 30, 15]);
    expect(() =>
      editWorldPlacements(
        data,
        { overrides: { "rock-a": { ...transform([1, 1, 1]), scale: [1, 2, 1] } } },
        heightAt,
      ),
    ).toThrow(/uniform scale/);
    expect(() =>
      editWorldPlacements(data, { overrides: { "rock-a": transform([100, 1, 1]) } }, heightAt),
    ).toThrow(/extent/);
  });

  it("matches a rebake for grounding-false overrides within each cell and asset", () => {
    const terrain = new Terrain({ resolution: 17, seed: 73, size: 64 }).scatter({
      asset: "rock",
      count: 40,
      id: "rocks",
      minDistance: 3,
    });
    const state = terrain.evaluate();
    const assets = {
      rock: { bounds: { min: [-1, 0, -1], max: [1, 2, 1] }, glb: "models/rock.glb" },
    } as const;
    const baked = bakeWorldPackage(state, { assets });
    const manifest = baked.manifest as TestManifest;
    const ids = JSON.parse(
      new TextDecoder().decode(baked.files["placement-ids.json"] as Uint8Array),
    ) as string[];
    const overrides: Record<string, IPlacementOverride> = {};
    for (const [index, item] of state.instances.slice(0, 5).entries())
      overrides[item.id] = {
        grounding: false,
        position: [item.position[0], item.position[1] + index + 0.25, item.position[2]],
        quaternion: [0, 0, 0, 1],
        scale: [1, 1, 1],
      };
    const edited = editWorldPlacements(
      {
        ids,
        manifest,
        placements: (baked.files[manifest.placements] as Uint8Array).buffer as ArrayBuffer,
      },
      { overrides },
      () => 0,
    );
    const rebaked = bakeWorldPackage(applyPlacementOverrides(state, overrides), { assets });
    const editedFloats = new Float32Array(edited.placements);
    const rebakedBytes = rebaked.files[rebaked.manifest.placements] as Uint8Array;
    const rebakedFloats = new Float32Array(
      rebakedBytes.buffer,
      rebakedBytes.byteOffset,
      rebakedBytes.byteLength / Float32Array.BYTES_PER_ELEMENT,
    );
    expect(editedFloats.length).toBe(rebakedFloats.length);
    for (let index = 0; index < editedFloats.length; index += 1)
      expect(
        Math.abs((editedFloats[index] as number) - (rebakedFloats[index] as number)),
      ).toBeLessThanOrEqual(1e-5);
    expect(edited.manifest.cells).toEqual(rebaked.manifest.cells);
  });

  it("prints the edit time for 20,000 synthetic records", () => {
    const count = 20_000;
    const placements = new Float32Array(count * 8);
    const ids = Array.from({ length: count }, (_, index) => `record-${String(index)}`);
    for (let index = 0; index < count; index += 1) {
      const offset = index * 8;
      placements[offset] = (index % 1000) + 0.5;
      placements[offset + 1] = 1;
      placements[offset + 2] = Math.floor(index / 1000) + 0.5;
      placements[offset + 6] = 1;
      placements[offset + 7] = 1;
    }
    const manifest = {
      assets: { rock: ASSETS.rock },
      cellSize: 1000,
      cells: [{ runs: [{ asset: "rock", count, offset: 0 }], x: 0, z: 0 }],
      extent: { minX: 0, minZ: 0, sizeX: 1000, sizeZ: 1000 },
      placementIds: "placement-ids.json",
      placements: "placements.bin",
      terrain: { ...HEIGHTMAP, columns: 2, rows: 2, spacing: 1000 },
      version: 1,
    } as TestManifest;
    const started = performance.now();
    const edited = editWorldPlacements(
      { ids, manifest, placements: placements.buffer as ArrayBuffer },
      { overrides: { "record-10000": { ...transform([500.5, 1, 500.5]), grounding: false } } },
      () => 0,
    );
    const elapsed = performance.now() - started;
    console.log(`editWorldPlacements 20,000 records: ${elapsed.toFixed(2)} ms`);
    expect(edited.ids).toHaveLength(count);
  });
});
