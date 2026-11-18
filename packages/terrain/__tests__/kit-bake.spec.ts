import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
// The streamed kit: `bakeKit` with a `look` writes the bundle the forest scene loads, not `world.json`.
// Each kit names its own placement floor: a wood places tens of thousands, a desert's open flats a
// few thousand plus the debris its scene adds at load (`render/ground/debris.ts`).
describe.each([
  ["alpine", 50_000],
  ["coastal", 50_000],
  ["desert", 5_000],
  ["tundra", 50_000],
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

// Trail Ridge keeps the legacy kit's meltwater: two kettle ponds and the two streams between them.
describe("tundra streamed water", () => {
  it("bakes both kettle ponds and both streams", () => {
    const root = makeTempDirSync("terrain-tundra-water-");
    execFileSync(
      process.execPath,
      ["bake.mjs", "--assets", starterAssets, "--out", join(root, "world")],
      { cwd: join(packageRoot, "starter", "tundra"), stdio: "pipe" },
    );
    const baked = JSON.parse(readFileSync(join(root, "world", "world", "tundra.json"), "utf8")) as {
      lakes: { id: string }[];
      rivers: { points: unknown[] }[];
    };
    expect(baked.lakes.map((lake) => lake.id).sort()).toEqual(["far-kettle", "near-kettle"]);
    expect(baked.rivers).toHaveLength(2);
    expect(baked.rivers.every((river) => river.points.length > 2)).toBe(true);
  });
});
