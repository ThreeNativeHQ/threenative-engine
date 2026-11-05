/**
 * Pins the four pure seams `PRD-797` moves out of `world-tiles.ts`: the two interpolations the pop
 * measurement reads, and the neighbour enumeration and bridge request the seam pass reads. They are
 * exported from their home module for this spec only; `world.ts` re-exports none of them, so the
 * package surface is unchanged.
 */
import { BufferAttribute, BufferGeometry, LOD, Mesh, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import {
  type ILevelGeometry,
  type IResidentTile,
  interpolatedLevelHeight,
  neighborBridgeRequest,
  neighborPairs,
  surfaceDeltaFromSamples,
} from "../src/world-tiles.js";
import { Heightfield } from "../src/world.js";

/** A flat field: every query height is 0 and every normal is +Y, so a level agreeing with it never restores. */
function flatField(): Heightfield {
  return new Heightfield({
    rows: 3,
    columns: 3,
    width: 10,
    depth: 10,
    origin: { x: 0, z: 0 },
    heights: new Float32Array(9),
  });
}

/** Level geometry with the given grid heights, a +Y normal and the flat edges its field has. */
function level(resolution: number, heights: readonly number[]): ILevelGeometry {
  const geometry = new BufferGeometry();
  const position = new Float32Array(resolution * resolution * 3);
  const normal = new Float32Array(resolution * resolution * 3);
  for (let index = 0; index < resolution * resolution; index += 1) {
    position[index * 3] = (index % resolution) / (resolution - 1);
    position[index * 3 + 1] = heights[index] ?? 0;
    position[index * 3 + 2] = Math.floor(index / resolution) / (resolution - 1);
    normal[index * 3 + 1] = 1;
  }
  geometry.setAttribute("position", new BufferAttribute(position, 3));
  geometry.setAttribute("normal", new BufferAttribute(normal, 3));
  const edge = (): Float32Array => new Float32Array(resolution);
  return {
    surfaceError: 0,
    edgeSamples: { east: edge(), north: edge(), south: edge(), west: edge() },
    geometry,
    mesh: new Mesh(geometry),
    resolution,
    skirtDepth: 0,
    skirtVertexCount: 0,
  };
}

function tile(tileX: number, tileZ: number, levels: readonly ILevelGeometry[]): IResidentTile {
  const field = flatField();
  // A level only counts as rendered while every level's mesh is hidden; `renderedLevel` then falls
  // to `levels[lodLevel]`, which is the level this fixture means.
  for (const value of levels) value.mesh.visible = false;
  return {
    bytes: 0,
    collider: undefined,
    field,
    key: `${tileX}:${tileZ}`,
    lod: new LOD(),
    lodLevel: levels.length - 1,
    maxLodLevel: levels.length - 1,
    object: new Mesh(new BufferGeometry()),
    origin: field.origin,
    sharedMorphEdges: 0,
    skirts: 0,
    skirtVertexCount: 0,
    tileX,
    tileZ,
    levels,
  };
}

const position = (value: ILevelGeometry): BufferAttribute =>
  value.geometry.getAttribute("position") as BufferAttribute;

describe("interpolatedLevelHeight", () => {
  const heights = [0, 10, 20, 30, 40, 50, 60, 70, 80];
  const grid = level(3, heights);

  it("reads a vertex exactly", () => {
    expect(interpolatedLevelHeight(grid, position(grid), 0.5, 0.5)).toBe(40);
    expect(interpolatedLevelHeight(grid, position(grid), 0, 0)).toBe(0);
    expect(interpolatedLevelHeight(grid, position(grid), 1, 1)).toBe(80);
  });

  it("blends across a column and across a row", () => {
    expect(interpolatedLevelHeight(grid, position(grid), 0.25, 0)).toBe(5);
    expect(interpolatedLevelHeight(grid, position(grid), 0, 0.75)).toBe(45);
    expect(interpolatedLevelHeight(grid, position(grid), 0.25, 0.25)).toBe(20);
  });

  it("clamps a sample outside the level to its edge", () => {
    expect(interpolatedLevelHeight(grid, position(grid), -1, 0)).toBe(0);
    expect(interpolatedLevelHeight(grid, position(grid), 2, 1)).toBe(80);
  });

  it("fails closed on a non-finite stored height", () => {
    const broken = level(3, [0, 10, 20, 30, Number.NaN, 50, 60, 70, 80]);
    expect(() => interpolatedLevelHeight(broken, position(broken), 0.25, 0.25)).toThrow(
      "TerrainTiles LOD geometry has an invalid height.",
    );
  });
});

describe("surfaceDeltaFromSamples", () => {
  it("is zero between a level and the same surface sampled coarser", () => {
    const coarse = level(3, [0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(surfaceDeltaFromSamples(new Float32Array(9), 3, coarse)).toBe(0);
  });

  it("returns the largest gap where the sample grid is wider than the level grid", () => {
    const coarse = level(3, [0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const samples = new Float32Array([0, 0, 0, 0, 4, 0, 0, 0, 0]);
    expect(surfaceDeltaFromSamples(samples, 3, coarse)).toBe(4);
  });

  it("probes the finer of the two grids, so a peak between coarse vertices is measured", () => {
    const coarse = level(3, [0, 0, 0, 0, 0, 0, 0, 0, 0]);
    // A 5x5 sample grid with one 6 m spike: a 3x3 probe would miss it, the finer grid does not.
    const samples = new Float32Array(25);
    samples[12] = 6;
    expect(surfaceDeltaFromSamples(samples, 5, coarse)).toBe(6);
  });
});

describe("neighborPairs", () => {
  const grid = (): Map<string, IResidentTile> => {
    const tiles = new Map<string, IResidentTile>();
    for (let z = 0; z < 3; z += 1)
      for (let x = 0; x < 3; x += 1) {
        const value = tile(x, z, [level(3, [])]);
        tiles.set(value.key, value);
      }
    return tiles;
  };

  it("enumerates each facing pair of a 3x3 grid exactly once", () => {
    const pairs = neighborPairs(grid()).map(([a, b]) => `${a.key}|${b.key}`);
    expect(pairs.sort()).toEqual(
      [
        "0:0|1:0",
        "1:0|2:0",
        "0:1|1:1",
        "1:1|2:1",
        "0:2|1:2",
        "1:2|2:2",
        "0:0|0:1",
        "1:0|1:1",
        "2:0|2:1",
        "0:1|0:2",
        "1:1|1:2",
        "2:1|2:2",
      ].sort(),
    );
  });

  it("leaves a lone tile unabridged and a gap unpaired", () => {
    const tiles = grid();
    tiles.delete("1:1");
    const pairs = neighborPairs(tiles).map(([a, b]) => `${a.key}|${b.key}`);
    expect(pairs).toHaveLength(8);
    expect(pairs.filter((pair) => pair.includes("1:1"))).toEqual([]);
    expect(neighborPairs(new Map())).toEqual([]);
  });
});

describe("neighborBridgeRequest", () => {
  it("asks for no bridge between two levels of the same resolution", () => {
    const pair = [tile(0, 0, [level(3, [])]), tile(1, 0, [level(3, [])])] as const;
    expect(neighborBridgeRequest(pair)).toBeUndefined();
  });

  it("bridges a coarse east edge to a fine west edge at the finer resolution", () => {
    const pair = [tile(0, 0, [level(3, [])]), tile(1, 0, [level(3, []), level(5, [])])] as const;
    const request = neighborBridgeRequest(pair);
    expect(request).toBeDefined();
    if (request === undefined) return;
    expect(request.keys).toEqual(["0:0", "1:0"]);
    expect(request.resolution).toBe(5);
    expect(request.coarse.side).toBe("east");
    expect(request.coarse.samples).toHaveLength(3);
    expect(request.fine.side).toBe("west");
    expect(request.fine.samples).toHaveLength(5);
  });

  it("keeps the pair's own order out of the key", () => {
    const a = tile(1, 0, [level(3, [])]);
    const b = tile(0, 0, [level(3, []), level(5, [])]);
    const request = neighborBridgeRequest([a, b]);
    expect(request?.keys).toEqual(["0:0", "1:0"]);
    // b is west of a, so the call reads a's west edge against b's east edge whichever way it is asked.
    expect(request?.coarse.side).toBe("west");
    expect(request?.fine.side).toBe("east");
  });
});

describe("the seam fixtures' own field", () => {
  it("is flat, so a level that agrees with it never restores an edge on the way to a request", () => {
    const value = tile(0, 0, [level(3, [])]);
    expect(value.field.heightAt(0, 0)).toBe(0);
    const normal = value.field.normalAt(0, 0, new Vector3()).toArray();
    expect(normal[0]).toBeCloseTo(0);
    expect(normal[1]).toBe(1);
    expect(normal[2]).toBeCloseTo(0);
  });
});
