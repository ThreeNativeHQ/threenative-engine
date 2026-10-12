import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type IWorldPackage, validateWorldPackage } from "@threenative/core/world";
import { describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../../test-support/temp-dir.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const kit = join(packageRoot, "starter", "alpine");
const starterAssets = join(packageRoot, "starter-assets");

/** Copies the alpine kit into a temp directory whose node_modules resolves the workspace package. */
function kitInTempDir(): string {
  const dir = makeTempDirSync("terrain-alpine-kit-");
  for (const name of ["bake.mjs", "recipe.json", "assets.json", "surface.json"])
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

describe("alpine starter kit", () => {
  it("bakes a world package the engine's validator accepts", () => {
    const out = join(makeTempDirSync("terrain-alpine-world-"), "world");
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
    expect(Object.keys(perAsset).sort()).toEqual(["boulder"]);
    expect(perAsset.boulder).toBe(90);
  });

  it("bakes the same bytes from the same recipe", () => {
    const first = join(makeTempDirSync("terrain-alpine-a-"), "world");
    const second = join(makeTempDirSync("terrain-alpine-b-"), "world");
    bake(first);
    bake(second);
    for (const name of ["world.json", "heightmap.u16", "placements.bin", "splat.rgba"]) {
      expect(readFileSync(join(first, name)).equals(readFileSync(join(second, name))), name).toBe(
        true,
      );
    }
  });
});
