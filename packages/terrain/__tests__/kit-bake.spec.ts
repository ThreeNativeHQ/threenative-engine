import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type IWorldPackage, validateWorldPackage } from "@threenative/core/world";
import { describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../../test-support/temp-dir.js";
import { TerrainEvaluator, decodeRAW16 } from "../src/index.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const starterAssets = join(packageRoot, "starter-assets");
// The forest recipe paints dirt; its moss is the ground shader's own, so no splat channel holds it.
it("forest recipe exposes soil patches through its surface blend thresholds", () => {
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
  for (const [id, channel] of [["dirt", 1]] as const) {
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
// No alpine, coastal or desert row: since 2026-11-16 those kits bake the streamed world (PRD-892 Phase 2) and
// their `bake.mjs` reads its own TypeScript look through `tsx`, which a bare temp copy cannot resolve.
// The streamed describe below proves that bake instead.
const kits = [
  { name: "tundra", asset: "boulder", count: 70, water: "kettles", compareWater: true },
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

// The streamed kit: `bakeKit` with a `look` writes the bundle the forest scene loads, not `world.json`.
// Each kit names its own placement floor: a wood places tens of thousands, a desert's open flats a
// few thousand plus the debris its scene adds at load (`render/ground/debris.ts`).
describe.each([
  ["alpine", 50_000],
  ["coastal", 50_000],
  ["desert", 5_000],
] as const)("%s streamed kit", (name, floor) => {
  const kit = join(packageRoot, "starter", name);

  /**
   * Runs the kit's own bake where its look modules and `tsx` resolve (the kit's folder) and returns
   * the folder it writes the world into: `--out <root>` puts the world in `<root>/world/`.
   */
  function bakeStreamed(): string {
    const root = makeTempDirSync(`terrain-${name}-streamed-`);
    execFileSync(
      process.execPath,
      ["bake.mjs", "--assets", starterAssets, "--out", join(root, "world")],
      { cwd: kit, stdio: "pipe" },
    );
    return join(root, "world", "world");
  }

  const FILES = [
    `${name}.json`,
    `${name}.world.json`,
    `${name}.layers.json`,
    `${name}.splat.rgba8`,
    `${name}.canopy.bin`,
    `${name}.sky.bin`,
    `${name}.props.json`,
  ];

  it("writes the streamed bundle its scene loads", () => {
    const out = bakeStreamed();
    for (const name of FILES) expect(statSync(join(out, name)).size, name).toBeGreaterThan(0);

    const baked = JSON.parse(readFileSync(join(out, `${name}.json`), "utf8")) as {
      resolution: number;
      heights: number[];
      colors: number[];
    };
    expect(baked.heights).toHaveLength(baked.resolution ** 2);
    expect(baked.colors).toHaveLength(baked.resolution ** 2 * 3);

    const props = JSON.parse(readFileSync(join(out, `${name}.props.json`), "utf8")) as {
      cellSize: number;
      buckets: { bucket: string; kind: string; placements: string; ids: string }[];
    };
    expect(props.buckets.length).toBeGreaterThan(0);
    let placements = 0;
    for (const bucket of props.buckets) {
      expect(["local", "horizon"]).toContain(bucket.kind);
      expect(statSync(join(out, bucket.placements)).size % 32).toBe(0);
      placements += statSync(join(out, bucket.placements)).size / 32;
      expect(JSON.parse(readFileSync(join(out, bucket.ids), "utf8")).length).toBeGreaterThan(0);
    }
    expect(placements).toBeGreaterThan(floor);
  });

  it("bakes the same bytes from the same recipe", () => {
    const first = bakeStreamed();
    const second = bakeStreamed();
    for (const name of FILES)
      expect(readFileSync(join(first, name)).equals(readFileSync(join(second, name))), name).toBe(
        true,
      );
  });
});

// The coast stands at real sea level (NAVD88 0 m, Sand Beach, Acadia) and the survey's flattened
// lagoon behind the beach is a lake with a bed under it, so the scene draws both.
describe("coastal streamed water", () => {
  it("bakes the sea at 0 m and the lagoon as a lake over a lowered bed", () => {
    const root = makeTempDirSync("terrain-coastal-water-");
    execFileSync(
      process.execPath,
      ["bake.mjs", "--assets", starterAssets, "--out", join(root, "world")],
      { cwd: join(packageRoot, "starter", "coastal"), stdio: "pipe" },
    );
    const baked = JSON.parse(
      readFileSync(join(root, "world", "world", "coastal.json"), "utf8"),
    ) as {
      size: number;
      resolution: number;
      heights: number[];
      waterLevel: number | null;
      lakes: { id: string; at: [number, number]; level: number }[];
    };
    expect(baked.waterLevel).toBe(0);
    expect(baked.lakes.map((lake) => lake.id)).toEqual(["lagoon"]);
    const lagoon = baked.lakes[0] as { at: [number, number]; level: number };
    const cell = baked.size / (baked.resolution - 1);
    const col = Math.round((lagoon.at[0] + baked.size / 2) / cell);
    const row = Math.round((lagoon.at[1] + baked.size / 2) / cell);
    const bed = baked.heights[row * baked.resolution + col] as number;
    // Above the sea, so the ocean plane never shows through it, and under the lagoon's surface.
    expect(bed).toBeGreaterThan(0);
    expect(bed).toBeLessThan(lagoon.level - 0.5);
  });
});
