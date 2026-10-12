import {
  type IWorldPackage,
  type IWorldRun,
  cellPlacements,
  heightSamplerFromHeightmap,
  validateWorldPackage,
} from "@threenative/core/world";
import { type ITerrainState, Terrain, bakeWorldPackage } from "@threenative/terrain";
import { describe, expect, it } from "vitest";

/** One asset's two LODs and an authored bound; only the ids and the bound reach the manifest. */
const ASSETS = {
  fir: {
    bounds: { max: [3, 14, 3] as const, min: [-3, 0, -3] as const },
    glb: "models/fir.glb",
    lods: [{ distance: 45, glb: "models/fir-mid.glb" }],
    maxDistance: 400,
  },
};

/** A small seeded terrain with one scatter layer; the seed fixes every instance position. */
function state() {
  return new Terrain({ resolution: 33, seed: 73, size: 256 })
    .scatter({ id: "firs", asset: "fir", count: 40, minDistance: 3 })
    .evaluate();
}

function bake() {
  const world = state();
  const baked = bakeWorldPackage(world, { assets: ASSETS });
  const manifest = JSON.parse(JSON.stringify(baked.manifest)) as IWorldPackage;
  return { baked, manifest, world };
}

describe("world package writer", () => {
  it("produces a manifest the engine's validator accepts", () => {
    const { baked, manifest } = bake();
    const result = validateWorldPackage(manifest, {
      heightmapByteLength: (baked.files[manifest.terrain.heightmap] as Uint8Array).byteLength,
      placementsByteLength: (baked.files[manifest.placements] as Uint8Array).byteLength,
    });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(manifest.version).toBe(1);
    expect(manifest.extent).toEqual({ minX: -128, minZ: -128, sizeX: 256, sizeZ: 256 });
    expect(manifest.terrain.columns).toBe(33);
    expect(manifest.terrain.spacing).toBe(8);
    expect(manifest.terrain.layers?.splat).toBe("splat.rgba");
  });

  it("quantises the heightmap into the order the core sampler reads", () => {
    const { baked, manifest, world } = bake();
    const name = manifest.terrain.heightmap;
    const raw = baked.files[name];
    if (raw === undefined) throw new Error(`No ${name} in the baked files`);
    const sampleAt = heightSamplerFromHeightmap(
      manifest.terrain,
      manifest.extent,
      new Uint16Array(raw.buffer as ArrayBuffer, raw.byteOffset, raw.byteLength / 2),
    );
    const tolerance = ((manifest.terrain.heightMax - manifest.terrain.heightMin) / 65_535) * 2;
    expect(raw.byteLength).toBe(33 * 33 * 2);
    // Twenty grid vertices plus one interior point, each compared against its own source sample.
    for (let i = 0; i < 20; i += 1) {
      const column = (i * 7) % 33;
      const row = (i * 11) % 33;
      const x = -128 + column * 8;
      const z = -128 + row * 8;
      expect(Math.abs(sampleAt(x, z) - (world.height[row * 33 + column] as number))).toBeLessThan(
        tolerance,
      );
    }
  });

  it("packs every instance once, in contiguous runs, and round-trips its pose", () => {
    const { baked, manifest, world } = bake();
    const buffer = (baked.files[manifest.placements] as Uint8Array).buffer as ArrayBuffer;
    expect(world.instances.length).toBeGreaterThan(0);
    let counted = 0;
    const seen: number[] = [];
    const covered = new Set<number>();
    for (const cell of manifest.cells)
      for (const run of cell.runs) {
        counted += run.count;
        const records = cellPlacements(buffer, run as IWorldRun);
        expect(records.length).toBe(run.count * 8);
        for (let i = 0; i < run.count; i += 1) {
          covered.add(run.offset + i);
          const record = Array.from(records.subarray(i * 8, i * 8 + 8));
          expect(Math.abs(Math.hypot(...record.slice(3, 7)) - 1)).toBeLessThan(1e-5);
          expect(record[7]).toBeGreaterThan(0);
          seen.push(record[0] as number, record[1] as number, record[2] as number);
        }
      }
    // The reader trusts `offset`/`count` as a contiguous range, so two runs may not overlap.
    expect(covered.size).toBe(counted);
    expect(counted).toBe(world.instances.length);
    // The buffer is float32, so every pose comes back to float32 precision rather than bit-exact.
    const recorded = seen.sort((a, b) => a - b);
    const expected = world.instances
      .flatMap((item) => [...item.position] as number[])
      .sort((a, b) => a - b);
    expect(recorded).toHaveLength(expected.length);
    for (let i = 0; i < expected.length; i += 1)
      expect(recorded[i]).toBeCloseTo(expected[i] as number, 3);
  });

  it("splats the eight material weights into two RGBA8 planes the shader can read", () => {
    const { baked, manifest, world } = bake();
    const { size, planes, masks } = baked.splat;
    expect(size).toBe(33);
    expect(planes).toBe(2);
    expect(masks.dirt).toEqual([0, "g"]);
    expect(masks.moss).toEqual([1, "a"]);
    const bytes = baked.files[manifest.terrain.layers?.splat ?? ""] as Uint8Array;
    const planeBytes = size * size * 4;
    expect(bytes.byteLength).toBe(planeBytes * planes);
    // Plane row 0 is the far z edge, so it holds the last sample row of the state grid.
    const channel = 1;
    const last = (32 * 33 + 7) * 8 + channel;
    expect(bytes[Math.floor(channel / 4) * planeBytes + 7 * 4 + (channel % 4)]).toBe(
      Math.round(Math.min(1, Math.max(0, world.splat[last] as number)) * 255),
    );
  });

  it("fails closed on an asset the options do not name and on a non-uniform scale", () => {
    const world = state();
    const base = world.instances[0];
    if (base === undefined) throw new Error("Scatter fixture placed nothing");
    const unknown: ITerrainState = { ...world, instances: [{ ...base, asset: "fern" }] };
    expect(() => bakeWorldPackage(unknown, { assets: ASSETS })).toThrow(/fern/);
    const skewed: ITerrainState = {
      ...world,
      instances: [
        {
          ...base,
          transform: {
            grounding: true,
            position: [0, 0, 0],
            quaternion: [0, 0, 0, 1],
            scale: [1, 2, 1],
          },
        },
      ],
    };
    expect(() => bakeWorldPackage(skewed, { assets: ASSETS })).toThrow(/uniform scale/);
  });
});
