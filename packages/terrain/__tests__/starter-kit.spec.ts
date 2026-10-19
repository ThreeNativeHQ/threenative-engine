import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type IWorldPackage, validateWorldPackage } from "@threenative/core/world";
import { describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../../test-support/temp-dir.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const kit = join(packageRoot, "starter", "forest");
const starterAssets = join(packageRoot, "starter-assets");

interface ITable {
  readonly base: { id: string };
  readonly layers: readonly { id: string }[];
  readonly splat: { masks: Record<string, [number, string]> };
  readonly textures: string;
}

/** The lake and river the bake writes beside the world, for the game to draw. */
interface IKitWater {
  readonly lakes: readonly { id: string; at: number[]; radius: number; level: number }[];
  readonly rivers: readonly { id: string; width: number; points: number[][] }[];
}

/** Copies the kit into a temp directory whose node_modules resolves the workspace package. */
function kitInTempDir(): string {
  const dir = makeTempDirSync("terrain-starter-kit-");
  for (const name of ["bake.mjs", "recipe.json", "assets.json", "surface.json"])
    copyFileSync(join(kit, name), join(dir, name));
  mkdirSync(join(dir, "node_modules", "@threenative"), { recursive: true });
  symlinkSync(packageRoot, join(dir, "node_modules", "@threenative", "terrain"), "dir");
  return dir;
}

function bake(out: string): { files: Map<string, string>; total: number } {
  const dir = kitInTempDir();
  execFileSync(process.execPath, ["bake.mjs", "--assets", starterAssets, "--out", out], {
    cwd: dir,
    stdio: "pipe",
  });
  const files = new Map<string, string>();
  let total = 0;
  for (const path of readdirSync(out, { recursive: true })) {
    const name = String(path);
    const full = join(out, name);
    if (!statSync(full).isFile()) continue;
    const bytes = readFileSync(full);
    total += bytes.byteLength;
    files.set(name, createHash("sha256").update(bytes).digest("hex"));
  }
  return { files, total };
}

describe("forest starter kit", () => {
  it("bakes a world package the engine's validator accepts, deterministically", () => {
    const out = join(makeTempDirSync("terrain-starter-world-"), "world");
    const { files, total } = bake(out);
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
    expect(perAsset.fir).toBeGreaterThanOrEqual(2000);
    expect(perAsset.boulder).toBe(320);
    expect(Object.keys(perAsset).sort()).toEqual(["boulder", "fir", "fir-c"]);
    expect(total).toBeLessThanOrEqual(25 * 1024 * 1024);

    // One recipe and seed, one package: a second bake is byte-identical.
    const second = bake(join(makeTempDirSync("terrain-starter-world-"), "world"));
    expect([...second.files].sort()).toEqual([...files].sort());
  });

  it("writes every model and texture its manifest and table name", () => {
    const out = join(makeTempDirSync("terrain-starter-world-"), "world");
    bake(out);
    const manifest = JSON.parse(readFileSync(join(out, "world.json"), "utf8")) as IWorldPackage;
    const tablePath = manifest.terrain.layers?.table;
    if (tablePath === undefined) throw new Error("The manifest names no terrain table");
    const table = JSON.parse(readFileSync(join(out, tablePath), "utf8")) as ITable;

    const named = [
      manifest.terrain.heightmap,
      manifest.placements,
      ...(manifest.terrain.layers === undefined ? [] : Object.values(manifest.terrain.layers)),
      ...Object.values(manifest.assets).flatMap((asset) => [
        asset.glb,
        ...(asset.lods ?? []).map((lod) => lod.glb),
      ]),
    ];
    for (const layer of [table.base, ...table.layers]) {
      expect(Object.keys(table.splat.masks)).toContain(layer.id);
      named.push(`${table.textures}/${layer.id}_diff.jpg`, `${table.textures}/${layer.id}_nrm.jpg`);
    }
    named.push("sky.hdr");
    for (const name of named) {
      // Local by construction: a package-relative path, never a scheme or a root.
      expect(name, `${name} is not package-relative`).not.toMatch(/^(\/|[a-z][a-z0-9+.-]*:)/iu);
      const path = join(out, name);
      expect(() => readFileSync(path), `${name} is missing from the baked package`).not.toThrow();
    }
    // Every model carries its own images: a GLB's JSON chunk names no external uri.
    for (const name of named.filter((file) => file.endsWith(".glb"))) {
      const glb = readFileSync(join(out, name));
      const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString("utf8")) as {
        images?: { uri?: string }[];
        buffers?: { uri?: string }[];
      };
      const uris = [...(json.images ?? []), ...(json.buffers ?? [])].flatMap((entry) =>
        entry.uri === undefined ? [] : [entry.uri],
      );
      expect(uris, `${name} references files outside itself`).toEqual([]);
    }
  });

  it("bakes the lake and river the game draws, at the generator's own level and course", () => {
    const out = join(makeTempDirSync("terrain-starter-water-"), "world");
    bake(out);
    const water = JSON.parse(readFileSync(join(out, "water.json"), "utf8")) as IKitWater;
    expect(water.lakes).toEqual([{ id: "lake", at: [-70, 25], radius: 105, level: 13.3 }]);
    expect(water.rivers).toHaveLength(1);
    expect(water.rivers[0]?.points.length).toBeGreaterThan(10);
    expect(water.rivers[0]?.width).toBeGreaterThan(0);
  });

  it("ships the kit and its shared starter assets in the package", () => {
    const packed = JSON.parse(
      execFileSync("npm", ["pack", "--dry-run", "--json"], {
        cwd: packageRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    ) as { files: { path: string; size: number }[] }[];
    const packedFiles = packed[0]?.files ?? [];
    const files = new Map(packedFiles.map((file) => [file.path, file.size]));
    for (const path of [
      "starter/forest/recipe.json",
      "starter/forest/assets.json",
      "starter/forest/surface.json",
      "starter/forest/bake.mjs",
      "starter/forest/world.ts",
      "starter/forest/water.ts",
      "starter/forest/sky.ts",
      "starter/alpine/recipe.json",
      "starter/alpine/assets.json",
      "starter/alpine/surface.json",
      "starter/alpine/bake.mjs",
      "starter/alpine/world.ts",
      "starter/alpine/sky.ts",
      "starter/desert/recipe.json",
      "starter/desert/assets.json",
      "starter/desert/surface.json",
      "starter/desert/bake.mjs",
      "starter/desert/world.ts",
      "starter/desert/sky.ts",
      "starter/tundra/recipe.json",
      "starter/tundra/assets.json",
      "starter/tundra/surface.json",
      "starter/tundra/bake.mjs",
      "starter/tundra/world.ts",
      "starter/tundra/sky.ts",
      "starter/tundra/water.ts",
      "starter/coastal/recipe.json",
      "starter/coastal/assets.json",
      "starter/coastal/surface.json",
      "starter/coastal/bake.mjs",
      "starter/coastal/world.ts",
      "starter/coastal/sky.ts",
      "starter/coastal/sea.ts",
      "starter-assets/fir_tree_01/fir-b-lod2.glb",
    ])
      expect(files.has(path), `packed tarball is missing ${path}`).toBe(true);
    const kitBytes = packedFiles
      .filter(
        (file) =>
          file.path.startsWith("starter/forest/") || file.path.startsWith("starter-assets/"),
      )
      .reduce((total, file) => total + file.size, 0);
    // The 25 MiB budget is per baked world (asserted above); this only catches package bloat.
    expect(kitBytes).toBeLessThanOrEqual(40 * 1024 * 1024);
  });
});
