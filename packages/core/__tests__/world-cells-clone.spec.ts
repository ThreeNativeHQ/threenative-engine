import { readFileSync } from "node:fs";
import { MeshBasicMaterial, Object3D, Scene } from "three";
import { clone as skeletonClone } from "three/addons/utils/SkeletonUtils.js";
import { describe, expect, it, vi } from "vitest";

import { TerrainTiles, WorldCells } from "../src/world.js";

describe("WorldCells clone", () => {
  it("clones with fresh streaming ownership and authored children", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const file = String(input).replace(/^.*\/world\//u, "");
      try {
        return new Response(readFileSync(new URL(`./fixtures/world-v1/${file}`, import.meta.url)));
      } catch {
        return new Response(null, { status: 404 });
      }
    });
    try {
      const source = await WorldCells.load({
        url: "/world/world.json",
        follow: new Object3D(),
        surface: new MeshBasicMaterial(),
        ring: 0,
        budgets: { bytes: 100000, instances: 10, residentCells: 1 },
      });
      const authored = new Object3D();
      source.add(authored);
      const copy = source.clone();
      expect(copy).toBeInstanceOf(WorldCells);
      expect(copy.stats().residentCells).toBe(0);
      expect(copy.prewarmed).not.toBe(source.prewarmed);
      expect(copy.children).toHaveLength(2);
      expect(copy.children[0]).toBeInstanceOf(TerrainTiles);
      expect(copy.children[0]).not.toBe(source.children[0]);
      expect(copy.children[1]).not.toBe(authored);
      const scene = new Scene().add(source);
      expect(scene.clone().children[0]).toBeInstanceOf(WorldCells);
      expect(skeletonClone(scene).children[0]).toBeInstanceOf(WorldCells);
      copy.dispose();
      expect(source.released).toBe(false);
      source.dispose();
    } finally {
      fetch.mockRestore();
    }
  });
});
