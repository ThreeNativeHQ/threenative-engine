import { readFileSync } from "node:fs";
import type { IPlacement } from "@threenative/terrain";
import { BoxGeometry, BufferAttribute, MeshBasicMaterial, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { BENCHMARK } from "../src/render/benchmark.js";
import { BIOMES, measureBiome } from "../src/render/biomes.js";
import {
  type HorizonSurroundings,
  createHorizonCollar,
  setHorizonSurroundings,
} from "../src/render/ground/horizon.js";
import type { IBakedWorld } from "../src/render/ground/terrain.js";
import {
  FAR_FOREST,
  FAR_FOREST_LAYER,
  collarSampler,
  farForestPlacements,
} from "../src/render/props/farForest.js";
import { streamProps } from "../src/render/props/propWorld.js";
import { variantFor } from "../src/render/props/props.js";

const read = (name: string) =>
  JSON.parse(readFileSync(new URL(`../src/world/${name}`, import.meta.url), "utf8"));

describe("far forest", () => {
  setHorizonSurroundings(read("horizon.json") as HorizonSurroundings);
  const data = (read("baked.json") as { forest: IBakedWorld }).forest;
  const collar = createHorizonCollar(data, "forest");
  const horizon = collar.geometry;
  const position = horizon.getAttribute("position");
  const sampler = collarSampler(collar);

  it("reads the drawn collar's own heights and nothing inside the square", () => {
    for (const vertex of [5000, 123_457, 300_001, 393_000]) {
      const height = sampler.at(position.getX(vertex), position.getZ(vertex));
      expect(height).toBeCloseTo(position.getY(vertex), 3);
    }
    expect(sampler.at(0, 0)).toBeNull();
  });

  it("plants the near band by default and documents both overrides", () => {
    // No location means no query: the default, `near` (owner, 2026-11-09: bare hills read as a bug).
    expect(FAR_FOREST).toBe(true);
    const documented = new Set(
      ["../src/render/props/farForest.ts", "../src/sceneProps.ts"].flatMap((name) =>
        [
          ...readFileSync(new URL(name, import.meta.url), "utf8").matchAll(/`\?farForest=(\w+)`/g),
        ].map(([, value]) => value),
      ),
    );
    expect([...documented].sort()).toEqual(expect.arrayContaining(["off", "on"]));
  });

  it("plants the valley and lower slopes, never cliffs, peaks, the square or the vista meadow", () => {
    const vista = BENCHMARK.forest.poses.vista;
    if (!vista) throw new Error("forest has no vista pose");
    const treeline = measureBiome(BIOMES.forest, data.heights).heightBands.treeline;
    horizon.setAttribute("canopy", new BufferAttribute(new Float32Array(position.count), 1));
    const trees = farForestPlacements({
      size: data.size,
      resolution: data.resolution,
      collar,
      treeline,
      world: "forest",
      rivers: data.rivers,
      lakes: data.lakes,
      clear: [[vista.at[0], vista.at[1], 55]],
    });
    expect(trees.length).toBeGreaterThan(20_000);
    expect(trees.length).toBeLessThan(120_000);
    let highest = 0;
    for (const tree of trees) {
      const [x, , z] = tree.position;
      expect(tree.layer).toBe(FAR_FOREST_LAYER);
      expect(Math.max(Math.abs(x), Math.abs(z))).toBeGreaterThan(data.size / 2);
      expect(Math.hypot(x - vista.at[0], z - vista.at[1])).toBeGreaterThanOrEqual(55);
      highest = Math.max(highest, sampler.at(x, z) ?? 0);
    }
    expect(highest).toBeLessThan(treeline[1] + 30);
    const canopy = horizon.getAttribute("canopy").array as Float32Array;
    expect(canopy.some((value) => value > 0)).toBe(true);
    console.log(`far forest: ${trees.length} trees, highest at ${highest.toFixed(0)} m`);
    // The loop above asserts over 106 000 trees one at a time, so the 5 s default is a machine-speed
    // limit rather than a claim about the rule; the count and the highest tree are the claim.
  }, 25_000);

  it("plants no tree under a cooked coast's sea", () => {
    const treeline = measureBiome(BIOMES.forest, data.heights).heightBands.treeline;
    const options = {
      size: data.size,
      resolution: data.resolution,
      collar,
      treeline,
      world: "forest" as const,
    };
    const dry = farForestPlacements(options);
    // A sea at the band's median ground height: half the collar it planted is now under water.
    const heights = dry
      .map((tree) => sampler.at(tree.position[0], tree.position[2]) ?? 0)
      .sort((a, b) => a - b);
    const seaLevel = heights[Math.floor(heights.length / 2)] as number;
    const coast = farForestPlacements({ ...options, seaLevel });
    expect(coast.length).toBeGreaterThan(0);
    expect(coast.length).toBeLessThan(dry.length * 0.6);
    for (const tree of coast)
      expect(sampler.at(tree.position[0], tree.position[2]) ?? 0).toBeGreaterThanOrEqual(
        seaLevel + 0.35,
      );
  }, 25_000);

  it("streams the far bucket with the licensed spruce's three-level chain", async () => {
    // The pack spruce steps at 80 and 150 m; a terminal gate inside 150 m fails package validation.
    const material = new MeshBasicMaterial();
    const placements: IPlacement[] = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({
      id: `temperate-spruce:far-${i}`,
      layer: FAR_FOREST_LAYER,
      asset: "spruce",
      position: [400 + i * 40, 0, -300],
      rotation: 0,
      scale: 1,
      normal: [0, 1, 0],
      alignToNormal: false,
    }));
    const parts = new Map(
      placements.map((placement) => [
        `spruce:${variantFor(placement, "spruce")}`,
        [0, 1, 2].map((level) => ({
          geometry: new BoxGeometry(1, 10, 1),
          material,
          role: "bark" as const,
          variant: 0,
          level,
        })),
      ]),
    );
    const streamed = await streamProps({
      placements,
      groundAt: () => ({ height: 0, offset: 0 }),
      parts,
      materials: { bark: material } as never,
      follow: { position: new Vector3(360, 70, 200) },
      size: data.size,
      horizonDistance: 5000,
      whileCurrent: () => true,
    });
    expect(streamed?.worlds.map((world) => world.name)).toEqual(["strata-props:far:false"]);
    streamed?.dispose();
  });
});
