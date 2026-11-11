import { Mask, Terrain } from "@threenative/terrain";
import { describe, expect, it } from "vitest";

describe("public scatter candidate identity", () => {
  it("retains candidate coordinates, scale and yaw when earlier candidates are rejected", () => {
    const terrain = new Terrain({ size: 64, resolution: 17, seed: 73 }).scatter({
      id: "trees",
      asset: "pine",
      count: 80,
      minDistance: 0,
      avoidWater: false,
      scale: [0.5, 2],
    });
    const before = new Map(terrain.evaluate().instances.map((item) => [item.id, item]));
    terrain.update("trees", { mask: Mask.rectangle([16, 0], [32, 64], 0, 0) });
    const after = terrain.evaluate().instances.filter((item) => before.has(item.id));
    expect(after.length).toBeGreaterThan(10);
    for (const item of after) {
      const previous = before.get(item.id);
      expect(item.position).toEqual(previous?.position);
      expect(item.rotation).toBe(previous?.rotation);
      expect(item.scale).toBe(previous?.scale);
    }
  });

  it("gives a new seed different candidate identities and preserves keys on round trip", () => {
    const terrain = new Terrain({ size: 64, resolution: 17 }).scatter({
      id: "trees",
      asset: "pine",
      count: 20,
      seed: 10,
      minDistance: 0,
      avoidWater: false,
    });
    const previous = new Set(terrain.evaluate().instances.map((item) => item.id));
    terrain.update("trees", { params: { seed: 11 } });
    const next = terrain.evaluate().instances;
    expect(next.some((item) => previous.has(item.id))).toBe(false);
    expect(Terrain.fromJSON(terrain.toJSON()).evaluate().instances).toEqual(next);
    terrain.update("trees", { params: { count: 40 } });
    expect(terrain.evaluate().instances.slice(0, 20)).toEqual(next);
  });
});

describe("scatter under a sea", () => {
  it("plants nothing on ground below the ocean's level, flooded or not", () => {
    // Border under the sea, a dry ring, and an enclosed hollow under sea level the flood never reaches.
    const width = 17;
    const values = Array.from({ length: width * width }, (_, i) => {
      const r = Math.max(Math.abs((i % width) - 8), Math.abs(Math.floor(i / width) - 8));
      return r >= 7 ? -5 : r >= 3 ? 5 : -3;
    });
    const terrain = new Terrain({ size: 64, resolution: width, seed: 73 })
      .heightmap({ id: "ground", data: { width, height: width, values } })
      .water({ id: "sea", kind: "ocean", level: 0 })
      .scatter({ id: "trees", asset: "pine", count: 300, minDistance: 0 });
    const instances = terrain.evaluate().instances;
    expect(instances.length).toBeGreaterThan(20);
    for (const item of instances) expect(item.position[1]).toBeGreaterThanOrEqual(0.35);
  });
});
