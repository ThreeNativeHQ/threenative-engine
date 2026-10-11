import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type IWorldPackage, validateWorldPackage } from "@threenative/core/world";
import { describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../../test-support/temp-dir.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const starterAssets = join(packageRoot, "starter-assets");
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
      "splat.rgba",
      ...(compareWater ? ["water.json"] : []),
    ]) {
      expect(readFileSync(join(first, name)).equals(readFileSync(join(second, name))), name).toBe(
        true,
      );
    }
  });
});
