import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type IWorldPackage, validateWorldPackage } from "@threenative/core/world";
import { describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../../test-support/temp-dir.js";
import { TerrainEvaluator, decodeRAW16 } from "../src/index.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const starterAssets = join(packageRoot, "starter-assets");
it("forest recipe exposes soil and moss patches through its surface blend thresholds", () => {
  const kit = join(packageRoot, "starter", "forest");
  const { recipe } = JSON.parse(readFileSync(join(kit, "recipe.json"), "utf8"));
  for (const layer of recipe.layers) {
    const data = layer.params?.data;
    if (!data?.raw16) continue;
    data.values = Array.from(
      decodeRAW16(readFileSync(join(kit, data.raw16)), data).values,
      (value) => Math.round(value * 10) / 10,
    );
  }
  const state = new TerrainEvaluator({ cacheMB: 0 }).evaluate(recipe);
  const surface = JSON.parse(readFileSync(join(kit, "surface.json"), "utf8"));
  for (const [id, channel] of [
    ["dirt", 1],
    ["moss", 7],
  ] as const) {
    const layer = surface.layers.find((layer: { id: string }) => layer.id === id);
    const midpoint = (layer.lo + layer.hi) / 2;
    let visible = 0;
    for (let i = channel; i < state.splat.length; i += 8)
      if ((state.splat[i] ?? 0) >= midpoint) visible++;
    expect(visible / state.height.length, `${id} covers at least 5% at half blend`).toBeGreaterThan(
      0.05,
    );
  }
});
// Per-kit assertion differences: scatter asset/count, water identities, river point count and golden files.
const kits = [
  { name: "alpine", asset: "boulder", count: 90, water: "none", compareWater: false },
  { name: "desert", asset: "boulder", count: 140, water: "empty", compareWater: true },
  { name: "tundra", asset: "boulder", count: 70, water: "kettles", compareWater: true },
  { name: "coastal", asset: "fir", count: 80, water: "ocean", compareWater: true },
];
describe.each(kits)("$name starter kit", ({ name, asset, count, water, compareWater }) => {
  const kit = join(packageRoot, "starter", name);
  /** Copies the alpine kit into a temp directory whose node_modules resolves the workspace package. */
  function kitInTempDir(): string {
    const dir = makeTempDirSync(`terrain-${name}-kit-`);
    for (const name of ["bake.mjs", "recipe.json", "assets.json", "surface.json", "heightmap.r16"])
      copyFileSync(join(kit, name), join(dir, name));
    mkdirSync(join(dir, "node_modules", "@threenative"), { recursive: true });
    symlinkSync(packageRoot, join(dir, "node_modules", "@threenative", "terrain"), "dir");
    return dir;
  }

  function bake(out: string): void {
    execFileSync(process.execPath, ["bake.mjs", "--assets", starterAssets, "--out", out], {
      cwd: kitInTempDir(),
      stdio: "pipe",
    });
  }

  it("bakes a world package the engine's validator accepts", () => {
    const out = join(makeTempDirSync(`terrain-${name}-world-`), "world");
    bake(out);
    const manifest = JSON.parse(readFileSync(join(out, "world.json"), "utf8")) as IWorldPackage;
    const result = validateWorldPackage(manifest, {
      heightmapByteLength: readFileSync(join(out, manifest.terrain.heightmap)).byteLength,
      placementsByteLength: readFileSync(join(out, manifest.placements)).byteLength,
    });
    expect(result.errors).toEqual([]);
    expect(manifest.terrain.columns).toBe(257);
    expect(manifest.extent.sizeX).toBe(512);
    const placementIdsName = (manifest as IWorldPackage & { placementIds?: string }).placementIds;
    expect(placementIdsName).toBe("placement-ids.json");
    const placementIds = JSON.parse(
      readFileSync(join(out, placementIdsName as string), "utf8"),
    ) as string[];
    expect(placementIds).toHaveLength(count);
    expect(new Set(placementIds).size).toBe(count);
    console.log(
      `${name} placement sidecar ${String(readFileSync(join(out, placementIdsName as string)).byteLength)} B; placements.bin ${String(readFileSync(join(out, manifest.placements)).byteLength)} B`,
    );

    const perAsset: Record<string, number> = {};
    for (const cell of manifest.cells)
      for (const run of cell.runs) perAsset[run.asset] = (perAsset[run.asset] ?? 0) + run.count;
    expect(Object.keys(perAsset).sort()).toEqual([asset]);
    expect(perAsset[asset]).toBe(count);
    if (water !== "none") {
      const data = JSON.parse(readFileSync(join(out, "water.json"), "utf8")) as {
        lakes: { id: string; level: number }[];
        rivers: { id: string; points: unknown[] }[];
      };
      if (water === "empty") {
        expect(data.lakes).toEqual([]);
        expect(data.rivers).toEqual([]);
      } else if (water === "kettles") {
        expect(data.lakes.map((lake) => lake.id).sort()).toEqual(["far-kettle", "near-kettle"]);
        expect(data.rivers.map((river) => river.id).sort()).toEqual(["braid", "meltwater"]);
        expect(data.rivers.every((river) => river.points.length > 2)).toBe(true);
      } else {
        expect(data.lakes).toEqual([expect.objectContaining({ id: "ocean", level: 1.5 })]);
      }
    }
  });

  it("bakes the same bytes from the same recipe", () => {
    const first = join(makeTempDirSync(`terrain-${name}-a-`), "world");
    const second = join(makeTempDirSync(`terrain-${name}-b-`), "world");
    bake(first);
    bake(second);
    for (const name of [
      "world.json",
      "heightmap.u16",
      "placements.bin",
      "placement-ids.json",
      "splat.rgba",
      ...(compareWater ? ["water.json"] : []),
    ]) {
      expect(readFileSync(join(first, name)).equals(readFileSync(join(second, name))), name).toBe(
        true,
      );
    }
  });
});
