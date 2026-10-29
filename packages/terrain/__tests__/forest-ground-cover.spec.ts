import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { type ITerrainState, TerrainEvaluator, decodeRAW16 } from "../src/index.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const kit = join(packageRoot, "starter", "forest");
const read = (name: string) => JSON.parse(readFileSync(join(kit, name), "utf8"));
const assets = read("assets.json") as Record<
  string,
  { near: string; maxDistance?: number; bounds: unknown }
>;
const surface = read("surface.json") as { layers: { id: string; lo: number }[] };

let state: ITerrainState;
beforeAll(() => {
  const { recipe } = read("recipe.json");
  for (const layer of recipe.layers) {
    const data = layer.params?.data;
    if (!data?.raw16) continue;
    data.values = Array.from(
      decodeRAW16(readFileSync(join(kit, data.raw16)), data).values,
      (value: number) => Math.round(value * 10) / 10,
    );
  }
  state = new TerrainEvaluator({ cacheMB: 0 }).evaluate(recipe);
});

const FERNS = ["fern-a", "fern-b"];
const STONES = ["stone-a", "stone-b"];

describe("forest ground cover", () => {
  it("cooks ferns and small stones with short draw distances", () => {
    for (const id of [...FERNS, ...STONES]) {
      const spec = assets[id];
      expect(spec, `${id} is in assets.json`).toBeDefined();
      expect(existsSync(join(packageRoot, "starter-assets", spec?.near ?? "missing")), id).toBe(
        true,
      );
    }
    for (const id of FERNS) expect(assets[id]?.maxDistance).toBeLessThanOrEqual(60);
    for (const id of STONES) expect(assets[id]?.maxDistance).toBeLessThanOrEqual(100);
  });

  it("places ground cover in the evaluated world", () => {
    const placed: Record<string, number> = {};
    for (const instance of state.instances)
      placed[instance.asset] = (placed[instance.asset] ?? 0) + 1;
    for (const id of FERNS) expect(placed[id] ?? 0, id).toBeGreaterThanOrEqual(2_000);
    for (const id of STONES) expect(placed[id] ?? 0, id).toBeGreaterThanOrEqual(300);
    expect(state.diagnostics.filter((line) => /fern|stone/u.test(line))).toEqual([]);
  });

  it("keeps the stony moss layer off flat ground, so flat ground reads grass or dirt", () => {
    const channel = 7; // MATERIAL_IDS.indexOf("moss")
    const lo = surface.layers.find((layer) => layer.id === "moss")?.lo ?? 0;
    const side = Math.round(Math.sqrt(state.height.length));
    const cell = state.size / (side - 1);
    let flat = 0;
    let mossy = 0;
    for (let z = 1; z < side - 1; z++)
      for (let x = 1; x < side - 1; x++) {
        const i = z * side + x;
        const gx = ((state.height[i + 1] ?? 0) - (state.height[i - 1] ?? 0)) / (2 * cell);
        const gz = ((state.height[i + side] ?? 0) - (state.height[i - side] ?? 0)) / (2 * cell);
        if (Math.atan(Math.hypot(gx, gz)) * (180 / Math.PI) >= 6) continue;
        flat++;
        if ((state.splat[i * 8 + channel] ?? 0) >= lo) mossy++;
      }
    expect(flat).toBeGreaterThan(10_000);
    expect(mossy / flat).toBeLessThan(0.05);
  });
});
