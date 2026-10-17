import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Vector3,
  WebGPUCoordinateSystem,
} from "three";
import { describe, expect, it, vi } from "vitest";
import { terrainHeight } from "../../../examples/abyss-framework/src/world/terrainSampler.js";
import { createAssetLoader } from "../src/assets.js";
import {
  DISCRETE_LOD_DEFAULT_ERROR_PIXELS,
  DISCRETE_LOD_DEFAULT_HYSTERESIS,
} from "../src/model-lod.js";
import { type IWorldTile, type IWorldTileCollider, TerrainTiles } from "../src/world-tiles.js";
import { summarizeWorldTopology } from "../src/world-topology.js";
import { Heightfield } from "../src/world.js";

const sampleHeight = (x: number, z: number): number =>
  Math.sin(x * 0.17) * 2 + Math.cos(z * 0.13) * 1.5 + Math.sin((x + z) * 0.07);

function loader(release: ReturnType<typeof vi.fn>) {
  return {
    audio: vi.fn(),
    model: vi.fn(),
    release,
    texture: vi.fn(),
  } as never;
}

function renderedHeight(tiles: TerrainTiles, key: string, index: number): number {
  const tile = tiles.getTile(key);
  if (tile === undefined) throw new Error(`Missing resident tile '${key}'.`);
  const level = tile.lod.levels[0]?.object;
  if (!(level instanceof Mesh)) throw new Error(`Missing rendered LOD for tile '${key}'.`);
  return level.geometry.getAttribute("position").getY(index);
}

interface IVisibleSurface {
  readonly heights: Float32Array;
  readonly resolution: number;
}

type Edge = "east" | "north" | "south" | "west";

function visibleSurface(tile: IWorldTile): IVisibleSurface {
  const level = tile.lod.levels.find(({ object }) => object.visible)?.object;
  if (!(level instanceof Mesh)) throw new Error(`Missing visible LOD for tile '${tile.key}'.`);
  const position = level.geometry.getAttribute("position");
  const resolution = Math.round(Math.sqrt(position.count + 4) - 2);
  if (resolution < 3 || resolution * resolution + resolution * 4 !== position.count)
    throw new Error(`Invalid visible LOD geometry for tile '${tile.key}'.`);
  const heights = new Float32Array(resolution * resolution);
  for (let index = 0; index < heights.length; index += 1) heights[index] = position.getY(index);
  return { heights, resolution };
}

function surfaceHeight(surface: IVisibleSurface, normalizedX: number, normalizedZ: number): number {
  const column = Math.max(0, Math.min(1, normalizedX)) * (surface.resolution - 1);
  const row = Math.max(0, Math.min(1, normalizedZ)) * (surface.resolution - 1);
  const column0 = Math.floor(column);
  const row0 = Math.floor(row);
  const column1 = Math.min(surface.resolution - 1, column0 + 1);
  const row1 = Math.min(surface.resolution - 1, row0 + 1);
  const columnMix = column - column0;
  const rowMix = row - row0;
  const upperLeft = surface.heights[row0 * surface.resolution + column0] as number;
  const upperRight = surface.heights[row0 * surface.resolution + column1] as number;
  const lowerLeft = surface.heights[row1 * surface.resolution + column0] as number;
  const lowerRight = surface.heights[row1 * surface.resolution + column1] as number;
  const upper = upperLeft + (upperRight - upperLeft) * columnMix;
  const lower = lowerLeft + (lowerRight - lowerLeft) * columnMix;
  return upper + (lower - upper) * rowMix;
}

function surfaceDelta(a: IVisibleSurface, b: IVisibleSurface): number {
  const samples = Math.max(a.resolution, b.resolution);
  let maximum = 0;
  for (let row = 0; row < samples; row += 1) {
    for (let column = 0; column < samples; column += 1) {
      const normalizedX = samples === 1 ? 0 : column / (samples - 1);
      const normalizedZ = samples === 1 ? 0 : row / (samples - 1);
      maximum = Math.max(
        maximum,
        Math.abs(
          surfaceHeight(a, normalizedX, normalizedZ) - surfaceHeight(b, normalizedX, normalizedZ),
        ),
      );
    }
  }
  return maximum;
}

function edgeHeight(surface: IVisibleSurface, side: Edge, normalized: number): number {
  if (side === "north") return surfaceHeight(surface, normalized, 0);
  if (side === "south") return surfaceHeight(surface, normalized, 1);
  if (side === "west") return surfaceHeight(surface, 0, normalized);
  return surfaceHeight(surface, 1, normalized);
}

function visibleSeamGap(a: IWorldTile, b: IWorldTile): number {
  const aSurface = visibleSurface(a);
  const bSurface = visibleSurface(b);
  const [aSide, bSide] =
    a.tileX < b.tileX
      ? (["east", "west"] as const)
      : a.tileX > b.tileX
        ? (["west", "east"] as const)
        : a.tileZ < b.tileZ
          ? (["south", "north"] as const)
          : (["north", "south"] as const);
  const samples = Math.max(aSurface.resolution, bSurface.resolution);
  let maximum = 0;
  for (let index = 0; index < samples; index += 1) {
    const normalized = samples === 1 ? 0 : index / (samples - 1);
    maximum = Math.max(
      maximum,
      Math.abs(edgeHeight(aSurface, aSide, normalized) - edgeHeight(bSurface, bSide, normalized)),
    );
  }
  return maximum;
}

function edgeSampleCoordinates(
  tile: IWorldTile,
  side: Edge,
  normalized: number,
): { column: number; row: number; x: number; z: number } {
  const field = tile.field;
  const minimumX = field.origin.x - field.width / 2;
  const minimumZ = field.origin.z - field.depth / 2;
  const x =
    side === "west"
      ? minimumX
      : side === "east"
        ? minimumX + field.width
        : minimumX + normalized * field.width;
  const z =
    side === "north"
      ? minimumZ
      : side === "south"
        ? minimumZ + field.depth
        : minimumZ + normalized * field.depth;
  return {
    column:
      side === "west"
        ? 0
        : side === "east"
          ? field.columns - 1
          : Math.round(normalized * (field.columns - 1)),
    row:
      side === "north"
        ? 0
        : side === "south"
          ? field.rows - 1
          : Math.round(normalized * (field.rows - 1)),
    x,
    z,
  };
}

function canonicalEdgeError(
  tile: IWorldTile,
  side: Edge,
  surface: IVisibleSurface,
  colliderHeights?: Float32Array,
): number {
  const field = tile.field;
  const normalizedCoordinate = (index: number): number =>
    surface.resolution === 1 ? 0 : index / (surface.resolution - 1);
  let maximum = 0;
  for (let index = 0; index < surface.resolution; index += 1) {
    const normalized = normalizedCoordinate(index);
    const { column, row, x, z } = edgeSampleCoordinates(tile, side, normalized);
    const rendered = edgeHeight(surface, side, normalized);
    const canonical = field.heightAt(x, z);
    const collider =
      colliderHeights === undefined
        ? 0
        : Math.abs(rendered - (colliderHeights[column * field.rows + row] as number));
    maximum = Math.max(maximum, Math.abs(rendered - canonical), collider);
  }
  return maximum;
}

/**
 * A validated ring's measurement, which is a number by construction: every `TerrainTiles` in this
 * file is built with `validate: true`, and a ring that stopped measuring would say so here rather
 * than let a `number | undefined` assertion pass silently.
 */
function measured(value: number | undefined): number {
  if (value === undefined)
    throw new Error("Expected a validated TerrainTiles to report the measurement.");
  return value;
}

describe("TerrainTiles", () => {
  it.each([false, true])(
    "reports JSON-safe terrain debug with validation %s without inventing diagnostics",
    (validate) => {
      const tiles = new TerrainTiles({
        surface: new MeshBasicMaterial(),
        residentByteBudget: 1_000_000,
        residentTileBudget: 1,
        sampleHeight,
        streamRadius: 0,
        tileResolution: 9,
        tileSize: 64,
        validate,
      });
      try {
        tiles.follow({ x: 0, z: 0 });
        const debug = tiles.debug();
        expect(debug).toEqual(JSON.parse(JSON.stringify(debug)));
        for (const key of ["maxSeamGap", "maxVisualSeamGap", "maxLodPop"]) {
          expect(Object.hasOwn(debug, key)).toBe(validate);
          if (validate) expect(Number.isFinite(debug[key])).toBe(true);
        }
      } finally {
        tiles.dispose();
      }
    },
  );

  it("counts retained topology storage against the hard byte cap", () => {
    expect(
      () =>
        new TerrainTiles({
          validate: true,
          surface: new MeshBasicMaterial(),
          residentByteBudget: 100_000,
          residentTileBudget: 1,
          sampleHeight,
          streamRadius: 0,
          tileResolution: 9,
          tileSize: 16,
          topologyObservation: {
            columns: 129,
            depth: 256,
            origin: { x: 0, z: 0 },
            rows: 129,
            width: 256,
          },
        }),
    ).toThrow(/residentByteBudget/u);
  });

  it("counts retained edge samples in each tile and its admission estimate", () => {
    const tiles = new TerrainTiles({
      validate: true,
      surface: new MeshBasicMaterial(),
      residentByteBudget: 9_000,
      residentTileBudget: 1,
      sampleHeight,
      streamRadius: 0,
      tileResolution: 9,
      tileSize: 16,
    });

    tiles.follow({ x: 0, z: 0 });

    const tile = tiles.getTile("0:0");
    if (tile === undefined) throw new Error("Expected the followed tile to remain resident.");
    expect(tile.bytes).toBe(8_672);
    expect(tiles.residentBytes).toBe(8_672);
    tiles.dispose();
  });

  it.each([
    [9, 51_080],
    [65, 1_869_960],
  ])(
    "charges every morph delta plus Three's packed CPU and GPU textures before admitting a %i grid",
    (tileResolution, bytes) => {
      const options = {
        surface: new MeshBasicMaterial(),
        sampleHeight,
        residentTileBudget: 1,
        streamRadius: 0,
        tileResolution,
        tileSize: 16,
        validate: false,
      };
      const tiles = new TerrainTiles({ ...options, residentByteBudget: bytes });
      tiles.follow({ x: 0, z: 0 });
      const tile = tiles.getTile("0:0");
      if (tile === undefined) throw new Error("Expected the admitted morph tile.");
      expect(tile.bytes).toBe(bytes);
      expect(tiles.residentBytes).toBe(bytes);
      expect(
        tile.lod.levels.map(({ object }) => {
          if (!(object instanceof Mesh)) throw new Error("Expected an LOD mesh.");
          return object.geometry.morphAttributes.position?.length ?? 0;
        }),
      ).toEqual([2, 1, 0]);
      const disposed = tile.lod.levels.map(({ object }) => {
        if (!(object instanceof Mesh)) throw new Error("Expected an LOD mesh.");
        return vi.spyOn(object.geometry, "dispose");
      });
      tiles.dispose();
      for (const dispose of disposed) expect(dispose).toHaveBeenCalledOnce();
      const tooSmall = new TerrainTiles({ ...options, residentByteBudget: bytes - 1 });
      try {
        expect(() => tooSmall.follow({ x: 0, z: 0 })).toThrow(/residentByteBudget/u);
        expect(tooSmall.residentTileCount).toBe(0);
      } finally {
        tooSmall.dispose();
        options.surface.dispose();
      }
    },
  );

  it("reserves enough morph storage for stock WebGL packing at an 8192 texture limit", () => {
    const options = {
      surface: new MeshBasicMaterial(),
      sampleHeight,
      residentTileBudget: 1,
      residentByteBudget: 2_000_000,
      streamRadius: 0,
      tileResolution: 65,
      tileSize: 64,
      lodFactors: [1, 2],
      lodDistances: [8],
    };
    const gpu = new TerrainTiles({ ...options, validate: false });
    const cpu = new TerrainTiles({ ...options, validate: true });
    try {
      gpu.follow({ x: 0, z: 0 });
      cpu.follow({ x: 0, z: 0 });
      const mesh = gpu.getTile("0:0")?.lod.levels[0]?.object;
      if (!(mesh instanceof Mesh)) throw new Error("Expected the finest LOD mesh.");
      const positions = mesh.geometry.morphAttributes.position?.[0];
      const normals = mesh.geometry.morphAttributes.normal?.[0];
      if (positions === undefined || normals === undefined)
        throw new Error("Expected both morph deltas.");
      // Stock WebGLMorphtargets packs 8,970 texels into two 8,192-texel RGBA32F rows.
      const textureBytes = 8192 * 2 * 4 * Float32Array.BYTES_PER_ELEMENT;
      expect(gpu.residentBytes - cpu.residentBytes).toBeGreaterThanOrEqual(
        positions.array.byteLength + normals.array.byteLength + textureBytes * 2,
      );
    } finally {
      gpu.dispose();
      cpu.dispose();
      options.surface.dispose();
    }
  });

  it.each([[[1]], [[1, 1]], [[1, 2, 2]], [[2, 1, 2]]])(
    "admits exactly the charged bytes for effective LOD factors %j",
    (lodFactors) => {
      const options = {
        surface: new MeshBasicMaterial(),
        sampleHeight: vi.fn(sampleHeight),
        residentTileBudget: 1,
        streamRadius: 0,
        tileResolution: 9,
        tileSize: 16,
        lodFactors,
        lodDistances: lodFactors.slice(1).map((_, index) => 8 * (index + 1)),
        validate: false,
      };
      const probe = new TerrainTiles({ ...options, residentByteBudget: 1_000_000 });
      probe.follow({ x: 0, z: 0 });
      const bytes = probe.residentBytes;
      if (lodFactors.length === 1) expect(bytes).toBe(5_904);
      const tile = probe.getTile("0:0");
      if (tile === undefined) throw new Error("Expected the probe tile.");
      expect(
        tile.lod.levels.map(({ object }) => {
          if (!(object instanceof Mesh)) throw new Error("Expected an LOD mesh.");
          return object.geometry.morphAttributes.position?.length ?? 0;
        }),
      ).toEqual(
        lodFactors.map(
          (factor) => lodFactors.filter((candidate) => candidate >= factor).length - 1,
        ),
      );
      probe.dispose();
      const fitted = new TerrainTiles({ ...options, residentByteBudget: bytes });
      const tooSmall = new TerrainTiles({ ...options, residentByteBudget: bytes - 1 });
      try {
        fitted.follow({ x: 0, z: 0 });
        expect(fitted.residentBytes).toBe(bytes);
        options.sampleHeight.mockClear();
        expect(() => tooSmall.follow({ x: 0, z: 0 })).toThrow(/residentByteBudget/u);
        expect(options.sampleHeight).not.toHaveBeenCalled();
      } finally {
        fitted.dispose();
        tooSmall.dispose();
        options.surface.dispose();
      }
    },
  );

  it("rejects a tile when retained edge samples make it exceed the byte cap", () => {
    const tiles = new TerrainTiles({
      validate: true,
      surface: new MeshBasicMaterial(),
      residentByteBudget: 8_400,
      residentTileBudget: 1,
      sampleHeight,
      streamRadius: 0,
      tileResolution: 9,
      tileSize: 16,
    });

    expect(() => tiles.follow({ x: 0, z: 0 })).toThrow(/residentByteBudget/u);
    tiles.dispose();
  });

  it("keeps resident render, query, normal, and collider data independent of topology coverage", () => {
    const worldPasses = {
      dispatchBudget: 4,
      erosion: {
        depositionRate: 1,
        erosionRate: 1,
        evaporation: 0,
        iterations: 4,
        rainfall: 1,
        sedimentCapacity: 10,
        timeStep: 1,
      },
      gpu: false,
    } as const;
    const topologyObservation = {
      columns: 17,
      depth: 16,
      origin: { x: 0, z: 0 },
      rows: 9,
      width: 32,
    } as const;
    const createTiles = (withObservation: boolean) => {
      const colliderHeights = new Map<string, Float32Array>();
      const tiles = new TerrainTiles({
        validate: true,
        createCollider: ({ field, key }) => {
          colliderHeights.set(key, field.toColliderHeights());
          return { dispose: () => undefined };
        },
        surface: new MeshBasicMaterial(),
        residentByteBudget: 200_000,
        residentTileBudget: 9,
        sampleHeight,
        streamRadius: 1,
        tileResolution: 9,
        tileSize: 16,
        ...(withObservation ? { topologyObservation } : {}),
        worldPasses,
      });
      tiles.follow({ x: 0, z: 0 });
      return { colliderHeights, tiles };
    };
    const withoutObservation = createTiles(false);
    const withObservation = createTiles(true);

    for (const [x, z] of [
      [-4, -4],
      [4, 4],
      [7.9, 0],
      [8.1, 0],
      [12, 0],
    ] as const) {
      expect(withObservation.tiles.heightAt(x, z)).toBeCloseTo(
        withoutObservation.tiles.heightAt(x, z),
        6,
      );
      const observedNormal = withObservation.tiles.normalAt(x, z);
      const expectedNormal = withoutObservation.tiles.normalAt(x, z);
      expect(observedNormal.x).toBeCloseTo(expectedNormal.x, 6);
      expect(observedNormal.y).toBeCloseTo(expectedNormal.y, 6);
      expect(observedNormal.z).toBeCloseTo(expectedNormal.z, 6);
    }

    expect(renderedHeight(withObservation.tiles, "0:0", 4 * 9 + 4)).toBeCloseTo(
      renderedHeight(withoutObservation.tiles, "0:0", 4 * 9 + 4),
      6,
    );
    for (const key of ["0:0", "1:0"]) {
      const observedCollider = withObservation.colliderHeights.get(key);
      const expectedCollider = withoutObservation.colliderHeights.get(key);
      expect(observedCollider).toBeDefined();
      expect(expectedCollider).toBeDefined();
      expect(observedCollider).toHaveLength(expectedCollider?.length ?? 0);
      for (let index = 0; index < (expectedCollider?.length ?? 0); index += 1)
        expect(observedCollider?.[index]).toBeCloseTo(expectedCollider?.[index] as number, 6);
    }
    expect(withObservation.tiles.debug()).toHaveProperty("topology");
    withObservation.tiles.dispose();
    withoutObservation.tiles.dispose();
  });

  it("keeps stitched rendered edges equal to the canonical query and collider source", () => {
    const colliderHeights = new Map<string, Float32Array>();
    const tiles = new TerrainTiles({
      validate: true,
      createCollider: ({ field, key }) => {
        colliderHeights.set(key, field.toColliderHeights());
        return { dispose: () => undefined };
      },
      residentByteBudget: 1_000_000,
      residentTileBudget: 9,
      sampleHeight: (x, z) => (Math.abs(x - 8) < 1e-6 ? Math.sin(z * (Math.PI / 2)) * 10 : 0),
      streamRadius: 1,
      surface: new MeshBasicMaterial(),
      tileResolution: 17,
      tileSize: 16,
      lodDistances: [8, 16],
    });

    try {
      tiles.follow({ x: 0, z: 0 });
      const a = tiles.getTile("0:0");
      const b = tiles.getTile("1:0");
      if (a === undefined || b === undefined) throw new Error("Expected adjacent resident tiles.");
      expect(Math.abs(a.lodLevel - b.lodLevel)).toBe(1);
      expect(tiles.maxSeamGap).toBeGreaterThan(0);

      const aSurface = visibleSurface(a);
      const bSurface = visibleSurface(b);
      expect(canonicalEdgeError(a, "east", aSurface, colliderHeights.get(a.key))).toBeLessThan(
        0.00001,
      );
      expect(canonicalEdgeError(b, "west", bSurface, colliderHeights.get(b.key))).toBeLessThan(
        0.00001,
      );
    } finally {
      tiles.dispose();
    }
  });

  it("restores canonical shared edges when mixed neighbors return to equal LOD", () => {
    const tiles = new TerrainTiles({
      validate: true,
      residentByteBudget: 1_000_000,
      residentTileBudget: 9,
      sampleHeight,
      streamRadius: 1,
      surface: new MeshBasicMaterial(),
      tileResolution: 17,
      tileSize: 16,
      lodDistances: [9, 18],
    });

    try {
      tiles.follow({ x: 0, z: 0 });
      tiles.follow({ x: 8, z: 0 });
      for (let frame = 0; frame < 3; frame += 1) tiles.process();

      const a = tiles.getTile("0:0");
      const b = tiles.getTile("1:0");
      if (a === undefined || b === undefined) throw new Error("Expected adjacent resident tiles.");
      expect(a.lodLevel).toBe(0);
      expect(b.lodLevel).toBe(0);
      expect(visibleSeamGap(a, b)).toBeLessThan(0.00001);
      expect(canonicalEdgeError(a, "east", visibleSurface(a))).toBeLessThan(0.00001);
      expect(canonicalEdgeError(b, "west", visibleSurface(b))).toBeLessThan(0.00001);
    } finally {
      tiles.dispose();
    }
  });

  it("updates only morph boundaries with reference bytes for all masks and reversals", () => {
    const options = {
      surface: new MeshBasicMaterial(),
      mergeTiles: false,
      validate: false,
      residentByteBudget: 2_000_000,
      residentTileBudget: 25,
      sampleHeight: (x: number, z: number) => sampleHeight(x, z) + deformation * Math.sin(x + z),
      streamRadius: 2,
      tileResolution: 9,
      tileSize: 16,
      lodDistances: [1000, 2000],
    };
    let deformation = 0;
    const sides = [
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
    ] as const;
    const denied = { admit: () => false };
    const probe = new TerrainTiles({ ...options, streamRadius: 0 });
    probe.follow({ x: 0, z: 0 });
    const tileBytes = probe.residentBytes;
    probe.dispose();
    for (let requested = 0; requested < 16; requested += 1) {
      const tiles = new TerrainTiles(options);
      let byteCap = tileBytes;
      // A changing public byte cap admits exactly the requested tile, with no pending construction.
      Object.defineProperty(tiles, "residentByteBudget", { get: () => byteCap });
      const residentKeys = new Set(["0:0"]);
      try {
        tiles.follow({ x: 0, z: 0 }, denied);
        const tile = tiles.getTile("0:0");
        if (tile === undefined) throw new Error("Expected the central tile.");
        const meshes = tile.lod.levels.map(({ object }) => {
          if (!(object instanceof Mesh)) throw new Error("Expected an LOD mesh.");
          return object;
        });
        const finest = meshes[0];
        if (finest === undefined) throw new Error("Expected the finest mesh.");
        const reads = ["position", "normal"].flatMap((name) => {
          const attribute = finest.geometry.getAttribute(name) as BufferAttribute;
          return (["getX", "getY", "getZ"] as const).map((method) => vi.spyOn(attribute, method));
        });
        const check = () => {
          const mask = sides.reduce(
            (value, [x, z], side) =>
              value | (tiles.getTile(`${x}:${z}`) === undefined ? 0 : 1 << side),
            0,
          );
          for (const [level, fine] of meshes.entries()) {
            const position = fine.geometry.getAttribute("position");
            const normal = fine.geometry.getAttribute("normal");
            const resolution = Math.round(Math.sqrt(position.count + 4) - 2);
            const last = resolution - 1;
            for (const [target, coarse] of meshes.slice(level + 1).entries()) {
              const coarsePosition = coarse.geometry.getAttribute("position");
              const coarseNormal = coarse.geometry.getAttribute("normal");
              const coarseLast = Math.round(Math.sqrt(coarsePosition.count + 4) - 2) - 1;
              const interpolate = (
                attribute: typeof position,
                component: number,
                row: number,
                column: number,
              ) => {
                const r = (row / last) * coarseLast;
                const c = (column / last) * coarseLast;
                const r0 = Math.floor(r);
                const c0 = Math.floor(c);
                const r1 = Math.min(coarseLast, r0 + 1);
                const c1 = Math.min(coarseLast, c0 + 1);
                const at = (y: number, x: number) =>
                  attribute.array[(y * (coarseLast + 1) + x) * 3 + component] as number;
                const upper = at(r0, c0) + (at(r0, c1) - at(r0, c0)) * (c - c0);
                const lower = at(r1, c0) + (at(r1, c1) - at(r1, c0)) * (c - c0);
                return upper + (lower - upper) * (r - r0);
              };
              const expectedPosition = new Float32Array(position.count * 3);
              const expectedNormal = new Float32Array(position.count * 3);
              for (let row = 0; row <= last; row += 1) {
                for (let column = 0; column <= last; column += 1) {
                  const index = row * resolution + column;
                  if (
                    (row === 0 && mask & 1) ||
                    (row === last && mask & 2) ||
                    (column === 0 && mask & 4) ||
                    (column === last && mask & 8)
                  )
                    continue;
                  expectedPosition[index * 3 + 1] =
                    interpolate(coarsePosition, 1, row, column) -
                    (position.array[index * 3 + 1] as number);
                  const n = new Vector3(
                    ...([0, 1, 2].map((component) =>
                      interpolate(coarseNormal, component, row, column),
                    ) as [number, number, number]),
                  ).normalize();
                  for (const [component, value] of [n.x, n.y, n.z].entries())
                    expectedNormal[index * 3 + component] =
                      value - (normal.array[index * 3 + component] as number);
                }
              }
              for (let side = 0; side < 4; side += 1) {
                for (let index = 0; index < resolution; index += 1) {
                  const top = [
                    index,
                    last * resolution + index,
                    index * resolution,
                    index * resolution + last,
                  ][side] as number;
                  expectedPosition[(resolution ** 2 + side * resolution + index) * 3 + 1] =
                    expectedPosition[top * 3 + 1] as number;
                }
              }
              const actualPosition = fine.geometry.morphAttributes.position?.[target];
              const actualNormal = fine.geometry.morphAttributes.normal?.[target];
              if (actualPosition === undefined || actualNormal === undefined)
                throw new Error("Missing morph targets.");
              expect(new Uint8Array(actualPosition.array.buffer)).toEqual(
                new Uint8Array(expectedPosition.buffer),
              );
              expect(new Uint8Array(actualNormal.array.buffer)).toEqual(
                new Uint8Array(expectedNormal.buffer),
              );
            }
          }
          return mask;
        };
        const follow = (x: number, z: number) => {
          for (const read of reads) read.mockClear();
          const previous = finest.geometry;
          const oldTargets = previous.morphAttributes.position?.slice();
          const oldNormals = previous.morphAttributes.normal?.slice();
          const influences = finest.morphTargetInfluences?.slice();
          const disposed = vi.spyOn(previous, "dispose");
          for (const key of residentKeys) {
            const [tx, tz] = key.split(":").map(Number) as [number, number];
            if (Math.abs(tx - x) > 2 || Math.abs(tz - z) > 2) residentKeys.delete(key);
          }
          residentKeys.add(`${x}:${z}`);
          byteCap = residentKeys.size * tileBytes;
          tiles.follow({ x: x * 16, z: z * 16 }, denied);
          check();
          if (finest.geometry !== previous) {
            expect(finest.geometry.morphAttributes.position?.[0]).not.toBe(oldTargets?.[0]);
            expect(finest.geometry.morphAttributes.normal?.[0]).not.toBe(oldNormals?.[0]);
            expect(previous.morphAttributes.position).toEqual(oldTargets);
            expect(finest.morphTargetInfluences).toEqual(influences);
            expect(disposed).toHaveBeenCalledOnce();
            const interiorReads = reads
              .flatMap((read) => read.mock.calls)
              .filter(
                ([index]) =>
                  index < 81 &&
                  index % 9 > 0 &&
                  index % 9 < 8 &&
                  Math.floor(index / 9) > 0 &&
                  Math.floor(index / 9) < 8,
              );
            expect(interiorReads).toHaveLength(0);
          }
        };
        check();
        for (const [side, [x, z]] of sides.entries()) if (requested & (1 << side)) follow(x, z);
        expect(check()).toBe(requested);
        for (const [side, [x, z]] of sides.entries()) {
          if (!(requested & (1 << side))) continue;
          follow(-x * 2, -z * 2);
          expect(check() & (1 << side)).toBe(0);
          follow(x, z);
          expect(check() & (1 << side)).toBe(1 << side);
        }
        for (const read of reads) read.mockRestore();
        const before = meshes.map((mesh) => ({
          position: mesh.geometry.getAttribute("position").array.slice(),
          normal: mesh.geometry.getAttribute("normal").array.slice(),
        }));
        const version = tile.field.version;
        tile.field.updateHeights({
          column: 4,
          row: 4,
          columns: 1,
          rows: 1,
          heights: new Float32Array([20]),
        });
        expect(tile.field.version).toBe(version + 1);
        expect(tile.field.heightAt(0, 0)).toBe(20);
        // GPU levels are construction-time copies; a field write alone does not refresh them.
        follow(-2, 0);
        follow(1, 0);
        expect(tiles.getTile("0:0")).toBe(tile);
        for (const [level, mesh] of meshes.entries()) {
          expect(mesh.geometry.getAttribute("position").array).toEqual(before[level]?.position);
          expect(mesh.geometry.getAttribute("normal").array).toEqual(before[level]?.normal);
        }
        const oldPosition = finest.geometry.morphAttributes.position?.[0]?.array.slice();
        const oldNormal = finest.geometry.morphAttributes.normal?.[0]?.array.slice();
        // Public LOD meshes publish buffer changes through Three's needsUpdate/version seam.
        for (const [level, mesh] of meshes.entries()) {
          const position = mesh.geometry.getAttribute("position") as BufferAttribute;
          const normal = mesh.geometry.getAttribute("normal") as BufferAttribute;
          const resolution = Math.round(Math.sqrt(position.count + 4) - 2);
          const center = Math.floor(resolution / 2) * (resolution + 1);
          position.setY(center, position.getY(center) + level + 1);
          normal.setXYZ(center, 0.2 * (level + 1), 0.8, 0.1);
          position.needsUpdate = true;
          normal.needsUpdate = true;
        }
        follow(-2, 0);
        expect(tiles.getTile("0:0")).toBe(tile);
        expect(finest.geometry.morphAttributes.position?.[0]?.array[40 * 3 + 1]).not.toBe(
          oldPosition?.[40 * 3 + 1],
        );
        expect(finest.geometry.morphAttributes.normal?.[0]?.array[40 * 3]).not.toBe(
          oldNormal?.[40 * 3],
        );
        follow(1, 0);
        expect(tiles.getTile("0:0")).toBe(tile);
        const coarsest = meshes.at(-1);
        if (coarsest === undefined) throw new Error("Expected a coarsest mesh.");
        // Replacement attributes start at version zero; identity must invalidate finer targets too.
        for (const name of ["position", "normal"]) {
          const attribute = (coarsest.geometry.getAttribute(name) as BufferAttribute).clone();
          attribute.setY(4, attribute.getY(4) + 2);
          coarsest.geometry.setAttribute(name, attribute);
        }
        follow(-2, 0);
        expect(tiles.getTile("0:0")).toBe(tile);
        follow(1, 0);
        const beforeRebuild = finest.geometry.morphAttributes.position?.[0]?.array.slice();
        deformation += 0.1;
        byteCap = tileBytes;
        tiles.follow({ x: 160, z: 160 }, denied);
        tiles.follow({ x: 0, z: 0 }, denied);
        const rebuiltTile = tiles.getTile("0:0");
        const rebuilt = rebuiltTile?.lod.levels[0]?.object;
        if (rebuiltTile === undefined || !(rebuilt instanceof Mesh))
          throw new Error("Expected the rebuilt tile.");
        expect(rebuilt.geometry.morphAttributes.position?.[0]?.array).not.toEqual(beforeRebuild);
        meshes.splice(
          0,
          meshes.length,
          ...rebuiltTile.lod.levels.map(({ object }) => object as Mesh),
        );
        expect(check()).toBe(0);
        byteCap = tileBytes * 2;
        tiles.follow({ x: 16, z: 0 }, denied);
        check();
      } finally {
        tiles.dispose();
      }
    }
  });

  it.each([1, 2, 9])(
    "renders GPU morphs with %i resident tiles without CPU attribute writes and matches the validating CPU blend",
    (residentTileBudget) => {
      const surface = new MeshBasicMaterial();
      const options = {
        surface,
        mergeTiles: false,
        residentByteBudget: 2_000_000,
        residentTileBudget,
        sampleHeight,
        streamRadius: residentTileBudget === 1 ? 0 : 1,
        tileResolution: 17,
        tileSize: 64,
        lodDistances: [8, 16],
      };
      const gpu = new TerrainTiles({ ...options, validate: false });
      const cpu = new TerrainTiles({ ...options, validate: true });
      try {
        gpu.follow({ x: 0, z: 0 });
        cpu.follow({ x: 0, z: 0 });
        const tile = gpu.getTile("0:0");
        if (tile === undefined) throw new Error("Expected the resident GPU tile.");
        const versions = tile.lod.levels.map(({ object }) => {
          if (!(object instanceof Mesh)) throw new Error("Expected an LOD mesh.");
          return [
            object.geometry.getAttribute("position").version,
            object.geometry.getAttribute("normal").version,
          ];
        });
        const finest = tile.lod.levels[0]?.object;
        if (!(finest instanceof Mesh)) throw new Error("Expected the finest LOD mesh.");
        const originalGeometry = finest.geometry;
        const originalPosition = originalGeometry.getAttribute("position");
        const originalNormal = originalGeometry.getAttribute("normal");
        const disposed = vi.spyOn(originalGeometry, "dispose");
        // Include skipped levels, refinement and an interrupted transition.
        for (const [x, frames] of [
          [9, 3],
          [0, 3],
          [20, 1],
          [0, 3],
        ] as const) {
          gpu.follow({ x, z: 0 });
          cpu.follow({ x, z: 0 });
          for (let frame = 0; frame <= frames; frame += 1) {
            if (frame > 0) {
              gpu.process();
              cpu.process();
            }
            const rendered = tile.lod.levels.find(({ object }) => object.visible)?.object;
            const reference = cpu
              .getTile("0:0")
              ?.lod.levels.find(({ object }) => object.visible)?.object;
            if (!(rendered instanceof Mesh) || !(reference instanceof Mesh))
              throw new Error("Expected matching visible meshes.");
            expect(rendered.material).toBe(surface);
            expect(rendered.geometry.morphTargetsRelative).toBe(true);
            for (
              let vertex = 0;
              vertex < rendered.geometry.getAttribute("position").count;
              vertex += 1
            ) {
              const actual = new Vector3();
              rendered.getVertexPosition(vertex, actual);
              const expected = new Vector3().fromBufferAttribute(
                reference.geometry.getAttribute("position"),
                vertex,
              );
              expect(actual.distanceTo(expected)).toBeLessThan(0.001);
              const normal = new Vector3().fromBufferAttribute(
                rendered.geometry.getAttribute("normal"),
                vertex,
              );
              for (const [target, weight] of (rendered.morphTargetInfluences ?? []).entries()) {
                const delta = rendered.geometry.morphAttributes.normal?.[target];
                if (delta !== undefined)
                  normal.addScaledVector(new Vector3().fromBufferAttribute(delta, vertex), weight);
              }
              normal.normalize();
              expect(
                normal.distanceTo(
                  new Vector3().fromBufferAttribute(
                    reference.geometry.getAttribute("normal"),
                    vertex,
                  ),
                ),
              ).toBeLessThan(0.001);
            }
            expect(
              tile.lod.levels.map(({ object }) => {
                if (!(object instanceof Mesh)) throw new Error("Expected an LOD mesh.");
                return [
                  object.geometry.getAttribute("position").version,
                  object.geometry.getAttribute("normal").version,
                ];
              }),
            ).toEqual(versions);
          }
        }
        expect(finest.geometry.getAttribute("position")).toBe(originalPosition);
        expect(finest.geometry.getAttribute("normal")).toBe(originalNormal);
        if (residentTileBudget === 2) expect(disposed).toHaveBeenCalledOnce();
        else expect(disposed).not.toHaveBeenCalled();
        expect(gpu.maxLodTransitionFrames).toBe(3);
        expect(gpu.blendingTiles).toBe(0);
      } finally {
        gpu.dispose();
        cpu.dispose();
        surface.dispose();
      }
    },
  );

  it("keeps the default distance floor, preserves no-view calls and reuses retained errors across residency", () => {
    const sampleHeight = vi.fn((x: number) => Math.cos((Math.PI * x) / 8));
    const tiles = new TerrainTiles({
      surface: new MeshBasicMaterial(),
      residentByteBudget: 4_000_000,
      residentTileBudget: 49,
      mergeTiles: false,
      sampleHeight,
      streamRadius: 3,
      tileResolution: 9,
      tileSize: 64,
      skirtDepth: 1,
    });
    const camera = new PerspectiveCamera(60, 1280 / 720, 0.1, 10_000);
    camera.position.set(0, 0, 4000);
    camera.lookAt(0, 0, 0);
    const view = { camera, viewportHeight: 720, maxPixelError: 1, hysteresis: 0.15 };
    try {
      tiles.follow({ x: 127, z: 0 }, undefined, view);
      expect(tiles.getTile("0:0")?.lodLevel).toBe(0);
      tiles.follow({ x: 129, z: 0 }, undefined, view);
      expect(tiles.getTile("0:0")?.lodLevel).toBe(1);
      const sampled = sampleHeight.mock.calls.length;
      const tileBytes = tiles.residentKeys.reduce(
        (sum, key) => sum + (tiles.getTile(key)?.bytes ?? 0),
        0,
      );
      for (let frame = 0; frame < 6; frame++) tiles.process();
      expect(sampleHeight).toHaveBeenCalledTimes(sampled);
      expect(tiles.residentBytes).toBeGreaterThanOrEqual(tileBytes);
      expect(tiles.residentBytes).toBeLessThanOrEqual(tiles.residentByteBudget);
      camera.position.z = 100;
      tiles.process();
      expect(tiles.getTile("0:0")?.lodLevel).toBe(0);
      tiles.follow({ x: 129, z: 0 });
      expect(tiles.getTile("0:0")?.lodLevel).toBe(1);
      tiles.follow({ x: 0, z: 0 }, undefined, view);
      expect(tiles.residentTileCount).toBe(49);
      expect(tiles.getTile("0:0")?.lodLevel).toBe(0);
      tiles.follow({ x: 640, z: 0 }, undefined, view);
      expect(tiles.getTile("0:0")).toBeUndefined();
      expect(tiles.residentTileCount).toBe(49);
      expect(tiles.residentBytes).toBeGreaterThanOrEqual(tileBytes);
      expect(tiles.residentBytes).toBeLessThanOrEqual(tiles.residentByteBudget);
    } finally {
      tiles.dispose();
    }
  });

  it("projects retained metre errors through the installed selector rather than treating metres as pixels", () => {
    const tiles = new TerrainTiles({
      surface: new MeshBasicMaterial(),
      sampleHeight: (x) => 0.01 * x * x,
      residentByteBudget: 20_000_000,
      residentTileBudget: 9,
      tileResolution: 65,
      tileSize: 64,
      streamRadius: 1,
      lodDistances: [48, 96],
      mergeTiles: false,
    });
    const camera = new OrthographicCamera(
      (-150 * 1280) / 720,
      (150 * 1280) / 720,
      150,
      -150,
      1,
      1000,
    );
    camera.position.set(64, 180, 180);
    camera.lookAt(64, 0, 0);
    const view = { camera, viewportHeight: 720, maxPixelError: 1, hysteresis: 0.15 };
    const decision = () =>
      (
        tiles.debug().lodDecisions as {
          key: string;
          lodLevel: number;
          targetLod: number;
          nextCoarser: { surfaceError: number; errorPixels: number };
        }[]
      ).find((tile) => tile.key === "0:0");
    try {
      tiles.follow({ x: 64, z: 0 }, undefined, view);
      expect(decision()).toMatchObject({ lodLevel: 1, targetLod: 1 });
      camera.zoom = 100;
      camera.updateProjectionMatrix();
      tiles.process(undefined, camera, undefined, view);
      expect(decision()).toMatchObject({ lodLevel: 0, targetLod: 0 });
      // A two-metre coarse cell interpolates x² at its one-metre midpoint:
      // 0.01 * ((0² + 2²)/2 - 1²) = 0.01 m; 720/300 * zoom = 240 px/m.
      expect(decision()?.nextCoarser.surfaceError).toBeCloseTo(0.01, 4);
      expect(decision()?.nextCoarser.errorPixels).toBeCloseTo(2.4, 2);
    } finally {
      tiles.dispose();
    }
  });

  it("reports actual resident LOD decisions and world-metre sampler error at the probe projection", () => {
    const sampled = vi.fn(terrainHeight);
    const tiles = new TerrainTiles({
      surface: new MeshBasicMaterial(),
      sampleHeight: sampled,
      residentByteBudget: 20_000_000,
      residentTileBudget: 9,
      tileResolution: 65,
      tileSize: 64,
      streamRadius: 1,
      lodDistances: [48, 96],
      mergeTiles: false,
    });
    const camera = new OrthographicCamera(
      -(150 * 1280) / 720,
      (150 * 1280) / 720,
      150,
      -150,
      1,
      1000,
    );
    camera.position.set(0, 180, 180);
    camera.lookAt(0, 0, 0);
    const view = {
      camera,
      viewportHeight: 720,
      maxPixelError: DISCRETE_LOD_DEFAULT_ERROR_PIXELS,
      hysteresis: DISCRETE_LOD_DEFAULT_HYSTERESIS,
    };
    try {
      tiles.follow({ x: 0, z: 0 }, undefined, view);
      const calls = sampled.mock.calls.length;
      const debug = tiles.debug();
      const decisions = debug.lodDecisions as {
        key: string;
        lodLevel: number;
        distance: number;
        distanceLod: number;
        maxLodLevel: number;
        targetLod: number;
        nextCoarser?: {
          lodLevel: number;
          surfaceError: number;
          errorPixels: number;
          degenerate: boolean;
        };
      }[];
      expect(decisions).toHaveLength(9);
      expect(debug.lodPolicy).toEqual({
        lodDistances: [48, 96],
        maxPixelError: 1,
        hysteresis: 0.15,
        coarsenBelowPixels: 0.85,
        viewportHeight: 720,
      });
      for (const decision of decisions) {
        const tile = tiles.getTile(decision.key);
        expect(tile).toBeDefined();
        expect(decision.lodLevel).toBe(tile?.lodLevel);
        expect(decision.distanceLod).toBe(
          decision.distance < 48 ? 0 : decision.distance < 96 ? 1 : 2,
        );
        expect(decision.targetLod).toBeLessThanOrEqual(
          Math.min(decision.distanceLod, decision.maxLodLevel),
        );
        const next = decision.nextCoarser;
        expect(next).toBeDefined();
        expect(next?.lodLevel).toBe(decision.lodLevel + 1);
        expect(next?.surfaceError).toBeGreaterThan(0);
        expect(next?.errorPixels).toBeCloseTo(((next?.surfaceError ?? 0) * 720) / 300, 10);
        expect(next?.degenerate).toBe(false);
      }
      const center = tiles.getTile("0:0");
      expect(center?.field.heightAt(-31, -30)).toBeCloseTo(terrainHeight(-31, -30), 5);
      expect(sampled).toHaveBeenCalledWith(-31, -30);
      expect(tiles.getTile("1:0")?.field.heightAt(33, -30)).toBeCloseTo(terrainHeight(33, -30), 5);
      expect(sampled).toHaveBeenCalledWith(33, -30);
      expect(sampled).toHaveBeenCalledTimes(calls); // Diagnostics use retained errors, never resample.
      tiles.follow({ x: 0, z: 0 });
      expect(tiles.debug().lodPolicy).toEqual({ lodDistances: [48, 96] });
      expect(
        (tiles.debug().lodDecisions as { nextCoarser?: { errorPixels?: number } }[])[0]
          ?.nextCoarser,
      ).not.toHaveProperty("errorPixels");
    } finally {
      tiles.dispose();
    }
  });

  it("owes a budgeted merge pass after a view-only LOD change", () => {
    const tiles = new TerrainTiles({
      surface: new MeshBasicMaterial(),
      residentByteBudget: 2_000_000,
      residentTileBudget: 25,
      sampleHeight: (x) => Math.cos((Math.PI * x) / 8),
      streamRadius: 2,
      tileResolution: 9,
      tileSize: 64,
      skirtDepth: 1,
    });
    const camera = new PerspectiveCamera(60, 1280 / 720, 0.1, 10_000);
    camera.position.set(0, 0, 4000);
    camera.lookAt(0, 0, 0);
    const view = { camera, viewportHeight: 720, maxPixelError: 1, hysteresis: 0.15 };
    try {
      for (let frame = 0; frame < 12; frame++) {
        tiles.follow({ x: 127, z: 0 }, undefined, view);
        tiles.process();
      }
      expect(tiles.deferredAdmissions).toBe(0);
      expect(tiles.getTile("1:0")?.lodLevel).toBe(0);
      expect(tiles.getTile("4:0")?.lodLevel).toBe(1);
      camera.position.z = 100;
      tiles.process();
      expect(tiles.deferredAdmissions).toBe(1);
      for (let frame = 0; frame < 12; frame++) {
        tiles.follow({ x: 127, z: 0 }, undefined, view);
        tiles.process();
      }
      expect(tiles.deferredAdmissions).toBe(0);
      expect(tiles.blendingTiles).toBe(0);
    } finally {
      tiles.dispose();
    }
  });

  it("holds a finer terrain level at 1440 raster rows and refreshes a settled view", () => {
    const tiles = new TerrainTiles({
      surface: new MeshBasicMaterial(),
      residentByteBudget: 2_000_000,
      residentTileBudget: 1,
      sampleHeight: (x) => Math.cos((Math.PI * x) / 4),
      streamRadius: 0,
      tileResolution: 17,
      tileSize: 64,
      skirtDepth: 1,
      lodDistances: [8, 16],
    });
    const camera = new PerspectiveCamera(60, 1280 / 720, 0.1, 5000);
    camera.position.set(0, 0, 2000);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
    const view = { camera, viewportHeight: 720, maxPixelError: 1, hysteresis: 0.15 };
    try {
      tiles.follow({ x: 7, z: 0 }, undefined, view);
      expect(tiles.getTile("0:0")?.lodLevel).toBe(0);
      tiles.follow({ x: 9, z: 0 }, undefined, view);
      expect(tiles.getTile("0:0")?.lodLevel).toBe(1);
      for (let frame = 0; frame < 3; frame += 1) tiles.process();
      const transitions = tiles.lodTransitions;
      tiles.process(undefined, undefined, undefined, { ...view, viewportHeight: 1440 });
      expect(tiles.getTile("0:0")?.lodLevel).toBe(0);
      expect(tiles.lodTransitions).toBe(transitions + 1);
      for (let frame = 0; frame < 3; frame += 1) tiles.process();
      camera.position.z = 4000;
      camera.updateMatrixWorld(true);
      tiles.process();
      expect(tiles.getTile("0:0")?.lodLevel).toBe(1);
      for (let frame = 0; frame < 3; frame += 1) tiles.process();
      expect(tiles.maxLodTransitionFrames).toBe(3);
      expect(tiles.blendingTiles).toBe(0);
    } finally {
      tiles.dispose();
    }
  });

  it("morphs one LOD surface within the measured pop bound for three frames", () => {
    const tiles = new TerrainTiles({
      validate: true,
      surface: new MeshBasicMaterial(),
      residentByteBudget: 200_000,
      residentTileBudget: 9,
      sampleHeight,
      streamRadius: 1,
      tileResolution: 17,
      tileSize: 16,
      lodDistances: [8, 16],
    });
    const renderer = {} as never;

    tiles.follow({ x: 0, z: 0 });
    tiles.follow({ x: 12, z: 0 });

    const tile = tiles.getTile("0:0");
    if (tile === undefined) throw new Error("Expected the followed tile to remain resident.");
    const fine = tile.lod.levels[0]?.object;
    if (!(fine instanceof Mesh)) throw new Error("Expected the finest LOD to be a mesh.");
    const position = fine.geometry.getAttribute("position");
    const trackedIndex = 4 * 17 + 5;
    const startHeight = position.getY(trackedIndex);
    const visible = (): number => tile.lod.children.filter((child) => child.visible).length;
    expect(visible()).toBe(1);
    tiles.process(renderer);
    expect(visible()).toBe(1);
    expect(position.getY(trackedIndex)).not.toBe(startHeight);
    tiles.process(renderer);
    expect(visible()).toBe(1);
    tiles.process(renderer);
    expect(visible()).toBe(1);
    expect(tiles.maxLodTransitionFrames).toBeGreaterThanOrEqual(3);
    expect(tiles.maxLodPop).toBeGreaterThan(0);
    expect(tiles.maxLodPop).toBeLessThanOrEqual(16);
    tiles.dispose();
  });

  it("measures the visible per-frame displacement instead of the complete LOD mismatch", () => {
    const tiles = new TerrainTiles({
      validate: true,
      surface: new MeshBasicMaterial(),
      residentByteBudget: 200_000,
      residentTileBudget: 2,
      // A 14.7 m error between the two levels, so the complete mismatch is three times the
      // per-frame step and a complete-mismatch reading would still land under the bound.
      sampleHeight: (x, z) => sampleHeight(x, z) * 350,
      streamRadius: 1,
      tileResolution: 17,
      tileSize: 16,
      lodDistances: [8, 16],
    });

    tiles.follow({ x: 0, z: 0 });
    tiles.follow({ x: 12, z: 0 });

    const tile = tiles.getTile("0:0");
    if (tile === undefined) throw new Error("Expected the transitioned tile to remain resident.");
    let previous = visibleSurface(tile);
    let observedMaximum = 0;
    for (let frame = 0; frame < 3; frame += 1) {
      tiles.process();
      const current = visibleSurface(tile);
      observedMaximum = Math.max(observedMaximum, surfaceDelta(previous, current));
      previous = current;
    }

    expect(observedMaximum).toBeGreaterThan(0);
    expect(tiles.maxLodPop).toBeCloseTo(observedMaximum, 5);
    expect(tiles.maxLodPop).toBeLessThanOrEqual(16);
    tiles.dispose();
  });

  it("records a visible snap when an active LOD transition is retargeted before the next render", () => {
    const tiles = new TerrainTiles({
      validate: true,
      surface: new MeshBasicMaterial(),
      residentByteBudget: 200_000,
      residentTileBudget: 1,
      // A 12.6 m error between the two levels, so the retarget snaps two thirds of it.
      sampleHeight: (x, z) => sampleHeight(x, z) * 300,
      streamRadius: 0,
      tileResolution: 17,
      tileSize: 16,
      lodDistances: [4, 8],
    });

    try {
      tiles.follow({ x: 0, z: 0 });
      tiles.follow({ x: 6, z: 0 });

      const tile = tiles.getTile("0:0");
      if (tile === undefined) throw new Error("Expected the transitioned tile to remain resident.");
      tiles.process();
      const beforeRetarget = visibleSurface(tile);

      tiles.follow({ x: 0, z: 0 });
      const afterRetarget = visibleSurface(tile);
      const retargetSnap = surfaceDelta(beforeRetarget, afterRetarget);
      expect(retargetSnap).toBeGreaterThan(0.00001);

      tiles.process();
      expect(tiles.maxLodPop).toBeGreaterThanOrEqual(retargetSnap - 0.00001);
    } finally {
      tiles.dispose();
    }
  });

  it("reports visible edge geometry on every frame of an LOD transition", () => {
    const tiles = new TerrainTiles({
      validate: true,
      surface: new MeshBasicMaterial(),
      residentByteBudget: 200_000,
      residentTileBudget: 2,
      sampleHeight,
      streamRadius: 1,
      tileResolution: 17,
      tileSize: 16,
      lodDistances: [8, 16],
    });

    tiles.follow({ x: 0, z: 0 });
    tiles.follow({ x: 12, z: 0 });

    expect(tiles.residentKeys).toEqual(["0:0", "1:0"]);
    const a = tiles.getTile("0:0");
    const b = tiles.getTile("1:0");
    if (a === undefined || b === undefined) throw new Error("Expected adjacent resident tiles.");
    let observedMaximum = visibleSeamGap(a, b);
    for (let frame = 0; frame < 3; frame += 1) {
      tiles.process();
      const current = visibleSeamGap(a, b);
      observedMaximum = Math.max(observedMaximum, current);
      expect(Number.isFinite(current)).toBe(true);
      expect(tiles.maxSeamGap).toBeGreaterThanOrEqual(observedMaximum);
    }
    tiles.dispose();
  });

  it("fails closed when a live seam edge contains a non-finite position", () => {
    const tiles = new TerrainTiles({
      validate: true,
      surface: new MeshBasicMaterial(),
      residentByteBudget: 200_000,
      residentTileBudget: 2,
      sampleHeight,
      streamRadius: 1,
      tileResolution: 17,
      tileSize: 16,
      lodDistances: [8, 16],
    });

    tiles.follow({ x: 0, z: 0 });
    tiles.follow({ x: 12, z: 0 });
    for (let frame = 0; frame < 3; frame += 1) tiles.process();

    const tile = tiles.getTile("0:0");
    if (tile === undefined) throw new Error("Expected the corrupted tile to remain resident.");
    const surface = tile.lod.levels.find(({ object }) => object.visible)?.object;
    if (!(surface instanceof Mesh)) throw new Error("Expected a visible surface mesh.");
    const position = surface.geometry.getAttribute("position");
    const resolution = Math.round(Math.sqrt(position.count + 4) - 2);
    for (let row = 0; row < resolution; row += 1)
      position.setY(row * resolution + resolution - 1, Number.NaN);
    // Written the way any writer that reaches the screen writes: a buffer change the renderer is
    // told about. A settled ring skips its seam pass until some rendered buffer's version moves.
    position.needsUpdate = true;

    try {
      expect(() => tiles.process()).toThrow(/seam diagnostic.*finite|invalid.*seam/u);
    } finally {
      tiles.dispose();
    }
  });

  it("reconciles a mixed-LOD surface edge before skirt coverage", () => {
    const tiles = new TerrainTiles({
      validate: true,
      surface: new MeshBasicMaterial(),
      residentByteBudget: 200_000,
      residentTileBudget: 2,
      sampleHeight,
      streamRadius: 1,
      tileResolution: 17,
      tileSize: 16,
      lodDistances: [8, 16],
    });

    tiles.follow({ x: 0, z: 0 });
    tiles.follow({ x: 12, z: 0 });
    for (let frame = 0; frame < 3; frame += 1) tiles.process();

    const a = tiles.getTile("0:0");
    const b = tiles.getTile("1:0");
    if (a === undefined || b === undefined) throw new Error("Expected adjacent resident tiles.");
    const aSurface = visibleSurface(a);
    const bSurface = visibleSurface(b);
    expect(aSurface.resolution).not.toBe(bSurface.resolution);
    expect(visibleSeamGap(a, b)).toBeGreaterThan(0);
    expect(tiles.stitchedEdgeCount).toBeGreaterThan(0);
    expect(tiles.maxVisualSeamGap).toBe(0);
    expect(a.lodLevel).toBeLessThanOrEqual(b.lodLevel + 1);
    expect(b.lodLevel).toBeLessThanOrEqual(a.lodLevel + 1);
    tiles.dispose();
  });

  it("measures the final rendered LOD frame after edge restoration", () => {
    const tiles = new TerrainTiles({
      validate: true,
      residentByteBudget: 200_000,
      residentTileBudget: 2,
      sampleHeight: (x, z) => (Math.abs(x - 8) < 1e-6 ? Math.sin(z * (Math.PI / 2)) * 10 : 0),
      streamRadius: 1,
      surface: new MeshBasicMaterial(),
      tileResolution: 17,
      tileSize: 16,
      lodDistances: [8, 16],
    });

    try {
      tiles.follow({ x: 8, z: 0 });
      tiles.follow({ x: 12, z: 0 });
      const tile = tiles.getTile("1:0");
      if (tile === undefined) throw new Error("Expected the transitioned tile to remain resident.");
      let previous = visibleSurface(tile);
      let observedMaximum = 0;
      for (let frame = 0; frame < 3; frame += 1) {
        tiles.process();
        const current = visibleSurface(tile);
        observedMaximum = Math.max(observedMaximum, surfaceDelta(previous, current));
        previous = current;
      }

      expect(observedMaximum).toBeLessThan(0.00001);
      expect(tiles.maxLodPop).toBeCloseTo(observedMaximum, 5);
    } finally {
      tiles.dispose();
    }
  });

  it("coordinates adjacent resident LOD targets instead of allowing a two-level jump", () => {
    const tiles = new TerrainTiles({
      validate: true,
      surface: new MeshBasicMaterial(),
      residentByteBudget: 1_000_000,
      residentTileBudget: 9,
      sampleHeight,
      streamRadius: 1,
      tileResolution: 17,
      tileSize: 16,
      lodDistances: [1, 2],
    });

    tiles.follow({ x: 0, z: 0 });

    const center = tiles.getTile("0:0");
    const east = tiles.getTile("1:0");
    if (center === undefined || east === undefined)
      throw new Error("Expected the center and east neighbor to remain resident.");
    expect(center.lodLevel).toBe(0);
    expect(east.lodLevel).toBe(1);
    expect(Math.abs(center.lodLevel - east.lodLevel)).toBeLessThanOrEqual(1);
    tiles.dispose();
  });

  it("retains the maximum seam diagnostics after a transient transition seam closes", () => {
    const skirtDepth = 0.000001;
    const tiles = new TerrainTiles({
      validate: true,
      residentByteBudget: 200_000,
      residentTileBudget: 2,
      sampleHeight: (x, z) => Math.sin(x * 0.2) * 10 + Math.cos(z * 0.11),
      skirtDepth,
      streamRadius: 1,
      surface: new MeshBasicMaterial(),
      tileResolution: 17,
      tileSize: 16,
      lodFactors: [1, 2],
      lodDistances: [4],
    });

    tiles.follow({ x: 2, z: 0 });
    tiles.follow({ x: 6, z: 0 });

    const a = tiles.getTile("0:0");
    const b = tiles.getTile("1:0");
    if (a === undefined || b === undefined) throw new Error("Expected adjacent resident tiles.");
    expect(tiles.maxSeamGap).toBeGreaterThan(0);
    expect(tiles.maxVisualSeamGap).toBeGreaterThan(0);
    const observedMaximum = measured(tiles.maxSeamGap);
    const observedVisualMaximum = measured(tiles.maxVisualSeamGap);
    for (let frame = 0; frame < 3; frame += 1) {
      tiles.process();
    }

    expect(observedMaximum).toBeGreaterThan(0);
    expect(observedVisualMaximum).toBeGreaterThan(0);
    expect(visibleSeamGap(a, b)).toBeCloseTo(0, 6);
    expect(measured(tiles.maxSeamGap)).toBeCloseTo(observedMaximum, 6);
    expect(measured(tiles.maxVisualSeamGap)).toBeCloseTo(observedVisualMaximum, 6);
    const maximumBeforeResidencyChange = measured(tiles.maxSeamGap);
    const visualMaximumBeforeResidencyChange = measured(tiles.maxVisualSeamGap);
    tiles.follow({ x: 32, z: 0 });
    expect(Number.isFinite(tiles.maxSeamGap)).toBe(true);
    expect(Number.isFinite(tiles.maxVisualSeamGap)).toBe(true);
    expect(measured(tiles.maxSeamGap)).toBeGreaterThanOrEqual(maximumBeforeResidencyChange);
    expect(measured(tiles.maxVisualSeamGap)).toBeGreaterThanOrEqual(
      visualMaximumBeforeResidencyChange,
    );
    tiles.dispose();
  });

  it("keeps a tile off a level whose height error exceeds the pop bound", () => {
    // The engine measures the error between the tile's own levels when they are built and
    // selects the coarsest level that fits the bound, so a game-authored cliff stays finer
    // instead of throwing a mid-frame error the game cannot act on.
    const tiles = new TerrainTiles({
      validate: true,
      surface: new MeshBasicMaterial(),
      residentByteBudget: 200_000,
      residentTileBudget: 9,
      sampleHeight: (x) => Math.sin(x * (Math.PI / 2)) * 100,
      streamRadius: 0,
      tileResolution: 17,
      tileSize: 16,
      lodDistances: [4, 8],
    });

    tiles.follow({ x: 0, z: 0 });
    expect(() => {
      tiles.follow({ x: 6, z: 0 });
      tiles.process();
    }).not.toThrow();
    expect(tiles.getTile("0:0")?.lodLevel).toBe(0);
    expect(tiles.maxLodPop).toBe(0);
    tiles.dispose();
  });

  it("walks a gorge cliff across LOD distances without throwing past the pop bound", () => {
    // A 2 km map at 128 m tiles and 2 m heightfield spacing, like the 1025x1025 Machinefall
    // field: a 40 m gorge wall with 20 m terraces on the bench above it, cut across the tile
    // the camera walks over. The tile beside it is rolling ground the engine can still coarsen.
    const gorge = (x: number, z: number): number => {
      const rolling = Math.sin(x * 0.25) * 8 + Math.cos(z * 0.2) * 6;
      return rolling + (x >= 4 && x < 40 ? 40 + Math.sin(z * 0.9) * 20 : 0);
    };
    const tiles = new TerrainTiles({
      validate: true,
      lodDistances: [32, 48],
      residentByteBudget: 4_000_000,
      residentTileBudget: 2,
      sampleHeight: gorge,
      streamRadius: 1,
      surface: new MeshBasicMaterial(),
      tileResolution: 65,
      tileSize: 128,
    });

    tiles.follow({ x: 0, z: 0 });
    for (const x of [40, 56]) {
      tiles.follow({ x, z: 0 });
      for (let frame = 0; frame < 3; frame += 1) tiles.process();
    }

    // The cliffed tile stays on the finest level its own height error allows, and the rolling
    // tile beside it still transitions, so the per-frame measurement keeps reporting motion.
    expect(tiles.getTile("0:0")?.lodLevel).toBe(0);
    expect(tiles.lodTransitions).toBeGreaterThan(0);
    expect(tiles.maxLodPop).toBeGreaterThan(0);
    expect(tiles.maxLodPop).toBeLessThanOrEqual(16);
    tiles.dispose();
  });

  it("keeps resident tile count and bytes under caps while evicting complete units", () => {
    const release = vi.fn(() => true);
    const disposed: string[] = [];
    const tiles = new TerrainTiles({
      validate: true,
      createCollider: ({ key }) => {
        const collider: IWorldTileCollider = {
          dispose: () => disposed.push(key),
        };
        return collider;
      },
      assetKey: (tileX, tileZ) => `test/terrain-${String(tileX)}-${String(tileZ)}.glb`,
      surface: new MeshBasicMaterial(),
      residentByteBudget: 200_000,
      residentTileBudget: 4,
      sampleHeight,
      streamRadius: 1,
      tileResolution: 9,
      tileSize: 16,
      assets: loader(release),
    });

    tiles.follow({ x: 0, z: 0 });
    tiles.follow({ x: 64, z: 0 });

    expect(tiles.residentTileCount).toBeLessThanOrEqual(4);
    expect(tiles.residentBytes).toBeLessThanOrEqual(200_000);
    expect(tiles.residentColliderKeys).toEqual(tiles.residentKeys);
    expect(tiles.peakResidentTileCount).toBeLessThanOrEqual(4);
    expect(tiles.peakResidentBytes).toBeLessThanOrEqual(200_000);
    expect(disposed.length).toBeGreaterThan(0);
    expect(release).toHaveBeenCalled();
    tiles.dispose();
  });

  it("gives only the tiles inside `colliderRadius` a body, and moves that set as follow moves", () => {
    // The whole point of a stream radius larger than a collider radius: 49 tiles of ground render
    // while 9 of them are solid, so a wide horizon does not cost a physics body per tile.
    const created: string[] = [];
    const disposed: string[] = [];
    const tiles = new TerrainTiles({
      validate: true,
      colliderRadius: 1,
      createCollider: ({ key }) => {
        created.push(key);
        const collider: IWorldTileCollider = { dispose: () => disposed.push(key) };
        return collider;
      },
      surface: new MeshBasicMaterial(),
      residentByteBudget: 4_000_000,
      residentTileBudget: 49,
      sampleHeight,
      streamRadius: 3,
      tileResolution: 9,
      tileSize: 16,
    });

    tiles.follow({ x: 0, z: 0 });
    expect(tiles.residentTileCount).toBe(49);
    expect(tiles.residentColliderKeys).toEqual([
      "-1:-1",
      "-1:0",
      "-1:1",
      "0:-1",
      "0:0",
      "0:1",
      "1:-1",
      "1:0",
      "1:1",
    ]);
    // A tile outside the radius never got a body to hand back.
    expect(created).not.toContain("2:2");

    tiles.follow({ x: 48, z: 0 });
    expect(tiles.residentColliderKeys).toEqual([
      "2:-1",
      "2:0",
      "2:1",
      "3:-1",
      "3:0",
      "3:1",
      "4:-1",
      "4:0",
      "4:1",
    ]);
    // The followed tile's own body is released as it leaves the radius, and the tile that arrived
    // gets one: the set follows the player instead of being fixed at load.
    expect(disposed).toContain("0:0");
    expect(created).toContain("3:0");
    expect(created).toContain("4:0");
    // The tile that lost its body still draws: physics left it, residency did not.
    expect(tiles.residentKeys).toContain("0:0");
    expect(tiles.residentTileCount).toBe(49);

    tiles.dispose();
    expect(disposed).toContain("4:0");
  });

  it("control: with no `colliderRadius`, every resident tile collides", () => {
    // The pre-PRD-461 behaviour, kept as the default: physics follows the render radius.
    const tiles = new TerrainTiles({
      createCollider: () => ({ dispose: () => undefined }),
      surface: new MeshBasicMaterial(),
      residentByteBudget: 4_000_000,
      residentTileBudget: 49,
      sampleHeight,
      streamRadius: 3,
      tileResolution: 9,
      tileSize: 16,
    });
    tiles.follow({ x: 0, z: 0 });
    expect(tiles.residentColliderKeys).toHaveLength(49);
    tiles.dispose();
  });

  it("leaves settled mixed-LOD seams alone instead of rewriting them every frame", () => {
    const tiles = new TerrainTiles({
      validate: true,
      surface: new MeshBasicMaterial(),
      residentByteBudget: 200_000,
      residentTileBudget: 9,
      sampleHeight,
      streamRadius: 1,
      tileResolution: 17,
      tileSize: 16,
      lodDistances: [8, 16],
    });
    tiles.follow({ x: 12, z: 0 });
    for (let frame = 0; frame < 4; frame += 1) {
      tiles.follow({ x: 12, z: 0 });
      tiles.process();
    }
    expect(tiles.lodLevelCount).toBeGreaterThanOrEqual(2);
    // A float64 height compared against its float32 copy never matched, so every call rewrote the
    // edges and recomputed whole-tile bounds: ~39 ms a frame on a 25-tile ring.
    const transitions = tiles.lodTransitions;
    const bounds = vi.spyOn(BufferGeometry.prototype, "computeBoundingSphere");
    for (let frame = 0; frame < 3; frame += 1) {
      tiles.follow({ x: 12, z: 0 });
      tiles.process();
    }
    // A still camera must not morph terrain: the neighbour rule used to flip coarse tiles each frame.
    expect(tiles.lodTransitions).toBe(transitions);
    expect(bounds).not.toHaveBeenCalled();
    bounds.mockRestore();
    tiles.dispose();
  });

  it("keeps a mixed-LOD neighbor seam covered by edge stitching and skirts", () => {
    const tiles = new TerrainTiles({
      validate: true,
      surface: new MeshBasicMaterial(),
      residentByteBudget: 200_000,
      residentTileBudget: 9,
      sampleHeight,
      streamRadius: 1,
      tileResolution: 17,
      tileSize: 16,
      lodDistances: [8, 16],
    });

    tiles.follow({ x: 0, z: 0 });
    expect(tiles.lodTransitions).toBe(0);
    tiles.follow({ x: 12, z: 0 });

    expect(tiles.lodLevelCount).toBeGreaterThanOrEqual(3);
    expect(tiles.lodTransitions).toBeGreaterThan(0);
    expect(tiles.maxSeamGap).toBeGreaterThan(0);
    expect(tiles.maxSeamGap).toBeLessThanOrEqual(tiles.skirtDepth);
    expect(tiles.skirtDepth).toBeGreaterThan(0);
    expect(tiles.residentKeys.some((key) => (tiles.getTile(key)?.skirtVertexCount ?? 0) > 0)).toBe(
      true,
    );
    tiles.dispose();
  });

  it("reports a visual seam when a recorded bridge is detached from the tile owner", () => {
    const tiles = new TerrainTiles({
      validate: true,
      surface: new MeshBasicMaterial(),
      residentByteBudget: 200_000,
      residentTileBudget: 2,
      sampleHeight,
      skirtDepth: 32,
      streamRadius: 1,
      tileResolution: 17,
      tileSize: 16,
      lodFactors: [1, 2],
      lodDistances: [4],
    });

    try {
      tiles.follow({ x: 2, z: 0 });
      const bridge = tiles.children.find((child): child is Mesh => child instanceof Mesh);
      if (bridge === undefined) throw new Error("Expected a mixed-LOD bridge mesh.");
      expect(tiles.stitchedEdgeCount).toBeGreaterThan(0);
      expect(tiles.maxVisualSeamGap).toBe(0);

      tiles.remove(bridge);
      const tile = tiles.getTile("0:0");
      if (tile === undefined) throw new Error("Expected the stitched tile to remain resident.");
      const surface = tile.lod.levels.find(({ object }) => object.visible)?.object;
      if (!(surface instanceof Mesh)) throw new Error("Expected a visible surface mesh.");
      const position = surface.geometry.getAttribute("position");
      const resolution = Math.round(Math.sqrt(position.count + 4) - 2);
      for (let row = 0; row < resolution; row += 1) {
        const index = row * resolution + resolution - 1;
        position.setY(index, position.getY(index) + 128);
      }
      position.needsUpdate = true;
      tiles.process();

      expect(tiles.maxVisualSeamGap).toBeGreaterThan(0);
    } finally {
      tiles.dispose();
    }
  });

  it("rejects an attached bridge translated away from its seam", () => {
    const tiles = new TerrainTiles({
      validate: true,
      surface: new MeshBasicMaterial(),
      residentByteBudget: 200_000,
      residentTileBudget: 2,
      sampleHeight,
      skirtDepth: 32,
      streamRadius: 1,
      tileResolution: 17,
      tileSize: 16,
      lodFactors: [1, 2],
      lodDistances: [4],
    });

    try {
      tiles.follow({ x: 2, z: 0 });
      const bridge = tiles.children.find((child): child is Mesh => child instanceof Mesh);
      if (bridge === undefined) throw new Error("Expected a mixed-LOD bridge mesh.");
      expect(tiles.stitchedEdgeCount).toBeGreaterThan(0);
      expect(tiles.maxVisualSeamGap).toBe(0);

      bridge.position.x += 128;

      expect(() => tiles.process()).toThrow(/bridge.*topology|bridge.*coordinate/u);
    } finally {
      tiles.dispose();
    }
  });

  it("rejects an attached bridge translated vertically away from its seam", () => {
    const tiles = new TerrainTiles({
      validate: true,
      surface: new MeshBasicMaterial(),
      residentByteBudget: 200_000,
      residentTileBudget: 2,
      sampleHeight,
      skirtDepth: 32,
      streamRadius: 1,
      tileResolution: 17,
      tileSize: 16,
      lodFactors: [1, 2],
      lodDistances: [4],
    });

    try {
      tiles.follow({ x: 2, z: 0 });
      const bridge = tiles.children.find((child): child is Mesh => child instanceof Mesh);
      if (bridge === undefined) throw new Error("Expected a mixed-LOD bridge mesh.");
      expect(tiles.stitchedEdgeCount).toBeGreaterThan(0);
      expect(tiles.maxVisualSeamGap).toBe(0);

      bridge.position.y += 128;

      expect(() => tiles.process()).toThrow(/bridge.*topology|bridge.*coordinate/u);
    } finally {
      tiles.dispose();
    }
  });

  it("rejects an attached bridge with an empty rendered draw range", () => {
    const tiles = new TerrainTiles({
      validate: true,
      surface: new MeshBasicMaterial(),
      residentByteBudget: 200_000,
      residentTileBudget: 2,
      sampleHeight,
      skirtDepth: 32,
      streamRadius: 1,
      tileResolution: 17,
      tileSize: 16,
      lodFactors: [1, 2],
      lodDistances: [4],
    });

    try {
      tiles.follow({ x: 2, z: 0 });
      const bridge = tiles.children.find((child): child is Mesh => child instanceof Mesh);
      if (bridge === undefined) throw new Error("Expected a mixed-LOD bridge mesh.");
      expect(tiles.stitchedEdgeCount).toBeGreaterThan(0);
      expect(tiles.maxVisualSeamGap).toBe(0);

      bridge.geometry.setDrawRange(0, 0);

      expect(() => tiles.process()).toThrow(/bridge.*topology/u);
    } finally {
      tiles.dispose();
    }
  });

  it("rejects an attached bridge whose rendered index buffer is all degenerate", () => {
    const tiles = new TerrainTiles({
      validate: true,
      surface: new MeshBasicMaterial(),
      residentByteBudget: 200_000,
      residentTileBudget: 2,
      sampleHeight,
      skirtDepth: 32,
      streamRadius: 1,
      tileResolution: 17,
      tileSize: 16,
      lodFactors: [1, 2],
      lodDistances: [4],
    });

    try {
      tiles.follow({ x: 2, z: 0 });
      const bridge = tiles.children.find((child): child is Mesh => child instanceof Mesh);
      if (bridge === undefined) throw new Error("Expected a mixed-LOD bridge mesh.");
      expect(tiles.stitchedEdgeCount).toBeGreaterThan(0);
      expect(tiles.maxVisualSeamGap).toBe(0);

      const index = bridge.geometry.getIndex();
      if (index === null) throw new Error("Expected the bridge to have an index buffer.");
      index.array.fill(0);
      index.needsUpdate = true;

      expect(() => tiles.process()).toThrow(/bridge.*topology/u);
    } finally {
      tiles.dispose();
    }
  });

  it("rejects an attached bridge whose rendered index buffer uses floating-point data", () => {
    const tiles = new TerrainTiles({
      validate: true,
      surface: new MeshBasicMaterial(),
      residentByteBudget: 200_000,
      residentTileBudget: 2,
      sampleHeight,
      skirtDepth: 32,
      streamRadius: 1,
      tileResolution: 17,
      tileSize: 16,
      lodFactors: [1, 2],
      lodDistances: [4],
    });

    try {
      tiles.follow({ x: 2, z: 0 });
      const bridge = tiles.children.find((child): child is Mesh => child instanceof Mesh);
      if (bridge === undefined) throw new Error("Expected a mixed-LOD bridge mesh.");
      expect(tiles.stitchedEdgeCount).toBeGreaterThan(0);
      expect(tiles.maxVisualSeamGap).toBe(0);

      const index = bridge.geometry.getIndex();
      if (index === null) throw new Error("Expected the bridge to have an index buffer.");
      bridge.geometry.setIndex(new BufferAttribute(new Float32Array(index.array), 1));

      expect(() => tiles.process()).toThrow(/bridge.*topology/u);
    } finally {
      tiles.dispose();
    }
  });

  it("keeps the manually selected LOD visible when a renderer inspects the LOD", () => {
    const tiles = new TerrainTiles({
      validate: true,
      surface: new MeshBasicMaterial(),
      residentByteBudget: 200_000,
      residentTileBudget: 9,
      sampleHeight,
      streamRadius: 1,
      tileResolution: 17,
      tileSize: 16,
      lodDistances: [8, 16],
    });

    tiles.follow({ x: 0, z: 0 });
    tiles.follow({ x: 12, z: 0 });

    const tile = tiles.getTile("0:0");
    if (tile === undefined) throw new Error("Expected the followed tile to remain resident.");
    for (let frame = 0; frame < 3; frame += 1) tiles.process();
    const visible = tile.lod.children.filter((child) => child.visible);
    expect(tile.lod.autoUpdate).toBe(false);
    expect(tile.lod.getCurrentLevel()).toBe(tile.lodLevel);
    expect(tiles.lodTransitions).toBeGreaterThan(0);
    expect(visible).toHaveLength(1);
    expect(visible[0]).toBe(tile.lod.levels[tile.lodLevel]?.object);
    expect(measured(tiles.maxVisualSeamGap)).toBeLessThanOrEqual(measured(tiles.maxSeamGap));
    tiles.dispose();
  });

  it("tags every tile level as terrain and as a shadow-neutral visibility swap", () => {
    const tiles = new TerrainTiles({
      residentByteBudget: 4_000_000,
      residentTileBudget: 1,
      sampleHeight,
      streamRadius: 0,
      surface: new MeshBasicMaterial(),
      tileResolution: 17,
      tileSize: 16,
    });

    tiles.follow({ x: 8, z: 8 });

    const key = tiles.residentKeys[0];
    const tile = key === undefined ? undefined : tiles.getTile(key);
    if (tile === undefined) throw new Error("Expected the followed tile to be resident.");
    expect(tile.lod.levels.length).toBeGreaterThan(0);
    for (const { object } of tile.lod.levels) {
      expect(object.userData.tnDrawSource).toBe("terrain");
      expect(object.userData.tnShadowSwap).toBe(true);
    }
    tiles.dispose();
  });

  it.each([false, true])(
    "keeps the real 20 MB probe ring resident through a 330 m walk (validate=%s)",
    (validate) => {
      const surface = new MeshBasicMaterial();
      const tiles = new TerrainTiles({
        validate,
        surface,
        sampleHeight: terrainHeight,
        residentByteBudget: 20_000_000,
        residentTileBudget: 9,
        tileResolution: 65,
        tileSize: 64,
        streamRadius: 1,
        lodDistances: [48, 96],
        topologyObservation: {
          columns: 1025,
          rows: 1025,
          width: 1024,
          depth: 1024,
          origin: { x: 0, z: 0 },
        },
        worldPasses: {
          dispatchBudget: 4,
          gpu: false,
          erosion: {
            depositionRate: 0.35,
            erosionRate: 0.22,
            evaporation: 0.04,
            iterations: 4,
            rainfall: 0.08,
            sedimentCapacity: 0.7,
            timeStep: 0.05,
          },
        },
      });
      const initial = tiles.debug();
      const camera = new OrthographicCamera(
        -(150 * 1280) / 720,
        (150 * 1280) / 720,
        150,
        -150,
        1,
        1000,
      );
      const view = {
        camera,
        viewportHeight: 720,
        maxPixelError: DISCRETE_LOD_DEFAULT_ERROR_PIXELS,
        hysteresis: DISCRETE_LOD_DEFAULT_HYSTERESIS,
      };
      const observations: { x: number; bytes: number; keys: readonly string[] }[] = [];
      try {
        for (let x = 0; x <= 330; x++) {
          camera.position.set(x, 180, 180);
          camera.lookAt(x, 0, 0);
          camera.updateMatrixWorld(true);
          expect(
            () => tiles.follow({ x, z: 0 }, undefined, view),
            `probe walk x=${x}`,
          ).not.toThrow();
          tiles.process(undefined, camera, undefined, view);
          observations.push({ x, bytes: tiles.residentBytes, keys: tiles.residentKeys });
        }
        expect(initial.peakResidentBytes).toBe(16_810_000);
        expect(initial.topologyBytes).toBe(0);
        for (const { x, bytes, keys } of observations) {
          const tileX = Math.floor((x + 32) / 64);
          const expected = [-1, 0, 1]
            .flatMap((dx) => [-1, 0, 1].map((z) => `${tileX + dx}:${z}`))
            .sort();
          expect(keys, `ring at x=${x}`).toEqual(expected);
          expect(bytes, `bytes at x=${x}`).toBeLessThanOrEqual(20_000_000);
        }
        expect(tiles.debug().peakResidentTiles).toBe(9);
        console.info("probe walk residency", {
          validate,
          initialBytes: observations[0]?.bytes,
          finalBytes: tiles.residentBytes,
          peakBytes: tiles.debug().peakResidentBytes,
        });
      } finally {
        tiles.dispose();
        surface.dispose();
      }
    },
    60_000,
  );

  it.each([
    { columns: 17, rows: 9, width: 32, depth: 16, passes: true },
    { columns: 17, rows: 9, width: 32, depth: 16, passes: false },
    { columns: 1025, rows: 1025, width: 1024, depth: 1024, passes: true },
    { columns: 1025, rows: 1025, width: 1024, depth: 1024, passes: false },
  ])(
    "caches unchanged topology diagnostics and releases sample buffers ($columns x $rows, passes=$passes)",
    ({ passes, ...grid }) => {
      const observation = { ...grid, origin: { x: 0, z: 0 } };
      const worldPasses = passes
        ? {
            dispatchBudget: 4,
            gpu: false,
            erosion: {
              depositionRate: 0.35,
              erosionRate: 0.22,
              evaporation: 0.04,
              iterations: 0,
              rainfall: 0.08,
              sedimentCapacity: 0.7,
              timeStep: 0.05,
            },
          }
        : undefined;
      const field = Heightfield.fromSampler({
        ...observation,
        sampleHeight,
        ...(worldPasses ? { worldPasses } : {}),
      });
      const heights = field.heights;
      const flow = field.flow;
      const raw = heights.length <= 10_000;
      const expected = {
        ...observation,
        ...(raw
          ? { heights: Array.from(heights), ...(flow ? { flow: Array.from(flow) } : {}) }
          : flow
            ? { metrics: summarizeWorldTopology({ ...grid, heights, flow }) }
            : {}),
      };
      const constructionBytes = field.memoryBytes;
      field.detach();
      const detach = vi.spyOn(Heightfield.prototype, "detach");
      const surface = new MeshBasicMaterial();
      const tiles = new TerrainTiles({
        sampleHeight,
        surface,
        residentByteBudget: 20_000_000,
        residentTileBudget: 9,
        tileSize: 16,
        tileResolution: grid.columns === 17 ? 9 : 17,
        topologyObservation: observation,
        ...(worldPasses ? { worldPasses } : {}),
      });
      try {
        expect(tiles.debug().topology).toEqual(expected);
        expect(detach).toHaveBeenCalledTimes(1);
        expect(tiles.debug().peakResidentBytes).toBe(constructionBytes);
        expect(tiles.debug().topologyBytes).toBe(raw ? heights.length * (passes ? 2 : 1) * 8 : 0);
        const mutated = tiles.debug().topology as {
          origin: { x: number };
          heights?: number[];
          flow?: number[];
          metrics?: { reliefFieldEdge: number };
        };
        mutated.origin.x = 999;
        if (mutated.heights) mutated.heights[0] = 999;
        if (mutated.flow) mutated.flow[0] = 999;
        if (mutated.metrics) mutated.metrics.reliefFieldEdge = 999;
        expect(tiles.debug().topology).toEqual(expected);
        tiles.dispose();
        expect(tiles.debug()).not.toHaveProperty("topology");
        expect(tiles.debug().topologyBytes).toBe(0);
        expect(tiles.residentBytes).toBe(0);
        expect(detach).toHaveBeenCalledTimes(1);
      } finally {
        tiles.dispose();
        surface.dispose();
        detach.mockRestore();
      }
    },
    60_000,
  );

  it("releases topology construction resources before propagating a byte-cap failure", () => {
    const detach = vi.spyOn(Heightfield.prototype, "detach");
    const surface = new MeshBasicMaterial();
    try {
      expect(
        () =>
          new TerrainTiles({
            sampleHeight,
            surface,
            residentByteBudget: 1_223,
            residentTileBudget: 1,
            tileSize: 16,
            tileResolution: 9,
            topologyObservation: {
              columns: 17,
              rows: 9,
              width: 32,
              depth: 16,
              origin: { x: 0, z: 0 },
            },
          }),
      ).toThrow(/cannot fit the topology observation/u);
      expect(detach).toHaveBeenCalledTimes(1);
    } finally {
      surface.dispose();
      detach.mockRestore();
    }
  });

  it("publishes the resident field and routed flow for topology evaluation", () => {
    const tiles = new TerrainTiles({
      validate: true,
      surface: new MeshBasicMaterial(),
      residentByteBudget: 200_000,
      residentTileBudget: 1,
      sampleHeight,
      streamRadius: 0,
      tileResolution: 9,
      tileSize: 128,
      topologyObservation: {
        columns: 65,
        depth: 1024,
        origin: { x: 0, z: 0 },
        rows: 65,
        width: 1024,
      },
      worldPasses: {
        dispatchBudget: 1,
        erosion: {
          depositionRate: 0.35,
          erosionRate: 0.22,
          evaporation: 0.04,
          iterations: 0,
          rainfall: 0.08,
          sedimentCapacity: 0.7,
          timeStep: 0.05,
        },
        gpu: false,
      },
    });

    tiles.follow({ x: 0, z: 0 });

    const topology = tiles.debug().topology as {
      columns: number;
      depth: number;
      flow: readonly number[];
      heights: readonly number[];
      rows: number;
      width: number;
    };
    expect(topology).toMatchObject({ columns: 65, depth: 1024, rows: 65, width: 1024 });
    expect(topology.heights).toHaveLength(4225);
    expect(topology.flow).toHaveLength(4225);
    expect(topology.flow.every(Number.isFinite)).toBe(true);
    tiles.dispose();
  });

  it("publishes a bounded metric summary for the rendered measurement grid", () => {
    const tiles = new TerrainTiles({
      validate: true,
      surface: new MeshBasicMaterial(),
      residentByteBudget: 20_000_000,
      residentTileBudget: 1,
      sampleHeight,
      tileResolution: 17,
      tileSize: 16,
      topologyObservation: {
        columns: 1025,
        depth: 1024,
        origin: { x: 0, z: 0 },
        rows: 1025,
        width: 1024,
      },
      worldPasses: {
        dispatchBudget: 1,
        erosion: {
          depositionRate: 0.35,
          erosionRate: 0.22,
          evaporation: 0.04,
          iterations: 0,
          rainfall: 0.08,
          sedimentCapacity: 0.7,
          timeStep: 0.05,
        },
        gpu: false,
      },
    });

    const topology = tiles.debug().topology as Record<string, unknown>;
    const metrics = topology.metrics as Record<string, unknown>;
    expect(topology).toMatchObject({ columns: 1025, depth: 1024, rows: 1025, width: 1024 });
    expect(topology).not.toHaveProperty("heights");
    expect(topology).not.toHaveProperty("flow");
    expect(Object.keys(metrics)).toHaveLength(8);
    expect(new TextEncoder().encode(JSON.stringify(tiles.debug())).byteLength).toBeLessThan(
      1_000_000,
    );
    tiles.dispose();
  }, 60_000);

  it("rejects a quality field whose sample grid does not match rendered tile geometry", () => {
    expect(
      () =>
        new TerrainTiles({
          validate: true,
          surface: new MeshBasicMaterial(),
          residentByteBudget: 200_000,
          residentTileBudget: 1,
          sampleHeight,
          tileResolution: 9,
          tileSize: 16,
          topologyObservation: {
            columns: 65,
            depth: 1024,
            origin: { x: 0, z: 0 },
            rows: 65,
            width: 1024,
          },
        }),
    ).toThrow(/columns.*513/u);
  });

  it("reports the actual edge discontinuity before skirt coverage", () => {
    let boundarySample = 0;
    const tiles = new TerrainTiles({
      validate: true,
      surface: new MeshBasicMaterial(),
      residentByteBudget: 200_000,
      residentTileBudget: 9,
      sampleHeight: (x, z) => {
        const base = Math.sin(x * 0.17) * 2 + Math.cos(z * 0.13) * 1.5;
        if (Math.abs(x - 8) > 1e-6) return base;
        boundarySample += 1;
        return base + (boundarySample % 2 === 0 ? 10 : 0);
      },
      skirtDepth: 16,
      streamRadius: 1,
      tileResolution: 9,
      tileSize: 16,
      lodFactors: [1],
      lodDistances: [],
    });

    tiles.follow({ x: 0, z: 0 });

    expect(tiles.maxSeamGap).toBeGreaterThan(1);
    expect(tiles.maxVisualSeamGap).toBe(0);
    for (const key of tiles.residentKeys) {
      const tile = tiles.getTile(key);
      if (tile === undefined) throw new Error(`Missing resident tile '${key}'.`);
      const skirtVertices = tile.lod.children.reduce((total, child) => {
        const position =
          child instanceof Object && "geometry" in child
            ? (
                child as { geometry?: { getAttribute(name: string): { count: number } } }
              ).geometry?.getAttribute("position")
            : undefined;
        return total + Math.max(0, (position?.count ?? 0) - 9 * 9);
      }, 0);
      expect(tile.skirtVertexCount).toBe(skirtVertices);
    }
    tiles.dispose();
  });

  it("releases a preloaded game asset without fabricating a tile model lookup", async () => {
    const model = vi.fn(async (url: string) => ({ url }));
    const assets = createAssetLoader({ model });
    const loadedKey = "terrain/fixture.glb";
    await assets.model(loadedKey);
    model.mockClear();
    const release = vi.spyOn(assets, "release");
    const tiles = new TerrainTiles({
      validate: true,
      assetKey: () => loadedKey,
      assets,
      residentByteBudget: 200_000,
      residentTileBudget: 1,
      sampleHeight,
      streamRadius: 0,
      tileResolution: 9,
      tileSize: 16,
      surface: new MeshBasicMaterial(),
    });

    tiles.follow({ x: 0, z: 0 });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    tiles.follow({ x: 16, z: 0 });

    expect(model).not.toHaveBeenCalled();
    const releasedCall = release.mock.calls.findIndex(
      ([kind, path]) => kind === "model" && path === loadedKey,
    );
    expect(releasedCall).toBeGreaterThanOrEqual(0);
    expect(release.mock.results[releasedCall]?.value).toBe(true);
    tiles.dispose();
  });

  it("fails closed when one tile cannot fit the byte cap", () => {
    const tiles = new TerrainTiles({
      validate: true,
      surface: new MeshBasicMaterial(),
      residentByteBudget: 1,
      residentTileBudget: 1,
      sampleHeight,
      tileResolution: 9,
      tileSize: 16,
    });
    expect(() => tiles.follow({ x: 0, z: 0 })).toThrow(/residentByteBudget/u);
  });

  it("validates constructor options and sizes before streaming", () => {
    const valid = {
      surface: new MeshBasicMaterial(),
      residentByteBudget: 200_000,
      residentTileBudget: 1,
      sampleHeight,
      tileResolution: 9,
      tileSize: 16,
    };
    expect(() => new TerrainTiles({ ...valid, tileSize: Number.NaN })).toThrow(/must be finite/u);
    expect(() => new TerrainTiles({ ...valid, tileSize: 0 })).toThrow(/greater than zero/u);
    expect(() => new TerrainTiles({ ...valid, tileResolution: 2.5 })).toThrow(
      /integer of at least 3/u,
    );
    expect(() => new TerrainTiles({ ...valid, lodFactors: [3] })).toThrow(/minus one must divide/u);
    expect(() => new TerrainTiles({ ...valid, lodFactors: [] })).toThrow(/must not be empty/u);
    expect(() => new TerrainTiles({ ...valid, lodFactors: [1, 2], lodDistances: [] })).toThrow(
      /one threshold per LOD transition/u,
    );
    expect(() => new TerrainTiles({ ...valid, lodDistances: [8, 8] })).toThrow(
      /strictly increasing/u,
    );
    expect(() => new TerrainTiles({ ...valid, surface: undefined as never })).toThrow(
      /surface is required/u,
    );
    expect(() => new TerrainTiles({ ...valid, sampleHeight: "nope" as never })).toThrow(
      /sampleHeight is required/u,
    );
    expect(() => new TerrainTiles({ ...valid, assetKey: "model.glb" })).toThrow(
      /requires an assets.release consumer/u,
    );
    expect(
      () =>
        new TerrainTiles({
          validate: true,
          ...valid,
          topologyObservation: {
            columns: 100,
            depth: 16,
            origin: { x: 0, z: 0 },
            rows: 9,
            width: 100,
          },
        }),
    ).toThrow(/whole number of rendered tiles/u);
    expect(
      () =>
        new TerrainTiles({
          validate: true,
          ...valid,
          topologyObservation: {
            columns: 17,
            depth: 16,
            origin: { x: 0, z: 0 },
            rows: 17,
            width: 32,
          },
        }),
    ).toThrow(/rows must match the rendered tile grid/u);
  });

  it("rejects an asset key that resolves to an empty string", () => {
    const tiles = new TerrainTiles({
      validate: true,
      assetKey: () => "  ",
      assets: loader(vi.fn()),
      surface: new MeshBasicMaterial(),
      residentByteBudget: 200_000,
      residentTileBudget: 1,
      sampleHeight,
      streamRadius: 0,
      tileResolution: 9,
      tileSize: 16,
    });

    expect(() => tiles.follow({ x: 0, z: 0 })).toThrow(/non-empty string/u);
    tiles.dispose();
  });

  it("exposes lifecycle state and guards every entry point after release", () => {
    const tiles = new TerrainTiles({
      validate: true,
      surface: new MeshBasicMaterial(),
      residentByteBudget: 200_000,
      residentTileBudget: 1,
      sampleHeight,
      streamRadius: 0,
      tileResolution: 9,
      tileSize: 16,
    });

    expect(tiles.released).toBe(false);
    expect(tiles.warmupNodes).toEqual([]);
    tiles.follow({ x: 0, z: 0 });
    expect(tiles.warmupNodes).toEqual([]);

    const tile = tiles.getTile("0:0");
    if (tile === undefined) throw new Error("Expected the followed tile to remain resident.");
    expect((tile.collider as { disposed?: boolean }).disposed).toBe(false);
    expect(tiles.sample("slope", 0, 0)).toBeCloseTo(1 - tiles.normalAt(0, 0).y, 10);

    tiles.attachRenderer({} as never);
    tiles.process();
    tiles.detach();

    expect(tiles.released).toBe(true);
    expect((tile.collider as { disposed?: boolean }).disposed).toBe(true);
    expect(() => tiles.follow({ x: 0, z: 0 })).toThrow(/after release/u);
    expect(() => tiles.attachRenderer({} as never)).toThrow(/after release/u);
    expect(() => tiles.process()).not.toThrow();
    expect(() => tiles.dispose()).not.toThrow();
  });

  it("samples delegated channels from the resident field", () => {
    const tiles = new TerrainTiles({
      validate: true,
      surface: new MeshBasicMaterial(),
      residentByteBudget: 200_000,
      residentTileBudget: 1,
      sampleHeight,
      streamRadius: 0,
      tileResolution: 9,
      tileSize: 16,
    });

    try {
      tiles.follow({ x: 0, z: 0 });
      expect(tiles.sample("height", 0, 0)).toBeCloseTo(tiles.heightAt(0, 0), 10);
      expect(() => tiles.heightAt(10_000, 0)).toThrow(/outside its resident region/u);
    } finally {
      tiles.dispose();
    }
  });

  it("rejects an LOD blend that reads a corrupted coarser level", () => {
    const tiles = new TerrainTiles({
      validate: true,
      surface: new MeshBasicMaterial(),
      residentByteBudget: 1_000_000,
      residentTileBudget: 9,
      sampleHeight,
      streamRadius: 1,
      tileResolution: 17,
      tileSize: 16,
      lodDistances: [8, 16],
    });

    try {
      tiles.follow({ x: 0, z: 0 });
      const tile = tiles.getTile("0:0");
      if (tile === undefined) throw new Error("Expected the followed tile to remain resident.");
      const coarse = tile.lod.levels[1]?.object;
      if (!(coarse instanceof Mesh)) throw new Error("Expected a coarse LOD mesh.");
      coarse.geometry.getAttribute("position").setY(0, Number.NaN);

      expect(() => tiles.follow({ x: 12, z: 0 })).toThrow(/invalid height/u);
    } finally {
      tiles.dispose();
    }
  });

  it("fails closed when a rendered edge cannot be placed in the world", () => {
    const tiles = new TerrainTiles({
      validate: true,
      surface: new MeshBasicMaterial(),
      residentByteBudget: 200_000,
      residentTileBudget: 2,
      sampleHeight,
      streamRadius: 1,
      tileResolution: 17,
      tileSize: 16,
      lodFactors: [1, 2],
      lodDistances: [4],
    });

    try {
      tiles.follow({ x: 2, z: 0 });
      expect(tiles.stitchedEdgeCount).toBeGreaterThan(0);
      const tile = tiles.getTile("0:0");
      if (tile === undefined) throw new Error("Expected the finer tile to remain resident.");
      const fine = tile.lod.levels[0]?.object;
      if (!(fine instanceof Mesh)) throw new Error("Expected a fine LOD mesh.");
      fine.position.x = Number.NaN;

      expect(() => tiles.process()).toThrow(/bridge world coordinates/u);
    } finally {
      tiles.dispose();
    }
  });

  it("rejects a bridge whose mesh was retargeted to foreign geometry", () => {
    const tiles = new TerrainTiles({
      validate: true,
      surface: new MeshBasicMaterial(),
      residentByteBudget: 200_000,
      residentTileBudget: 2,
      sampleHeight,
      streamRadius: 1,
      tileResolution: 17,
      tileSize: 16,
      lodFactors: [1, 2],
      lodDistances: [4],
    });

    try {
      tiles.follow({ x: 2, z: 0 });
      const bridge = tiles.children.find((child): child is Mesh => child instanceof Mesh);
      if (bridge === undefined) throw new Error("Expected a mixed-LOD bridge mesh.");
      bridge.geometry = new BufferGeometry();

      expect(() => tiles.process()).toThrow(/not attached to its mesh/u);
    } finally {
      tiles.dispose();
    }
  });

  it("rejects a bridge whose rendered index count no longer matches its strip", () => {
    const tiles = new TerrainTiles({
      validate: true,
      surface: new MeshBasicMaterial(),
      residentByteBudget: 200_000,
      residentTileBudget: 2,
      sampleHeight,
      streamRadius: 1,
      tileResolution: 17,
      tileSize: 16,
      lodFactors: [1, 2],
      lodDistances: [4],
    });

    try {
      tiles.follow({ x: 2, z: 0 });
      const bridge = tiles.children.find((child): child is Mesh => child instanceof Mesh);
      if (bridge === undefined) throw new Error("Expected a mixed-LOD bridge mesh.");
      bridge.geometry.setIndex(new BufferAttribute(new Uint32Array([0, 1, 2]), 1));

      expect(() => tiles.process()).toThrow(/invalid rendered triangle data/u);
    } finally {
      tiles.dispose();
    }
  });

  it("rejects a bridge whose rendered normals went missing", () => {
    const tiles = new TerrainTiles({
      validate: true,
      surface: new MeshBasicMaterial(),
      residentByteBudget: 200_000,
      residentTileBudget: 2,
      sampleHeight,
      streamRadius: 1,
      tileResolution: 17,
      tileSize: 16,
      lodFactors: [1, 2],
      lodDistances: [4],
    });

    try {
      tiles.follow({ x: 2, z: 0 });
      const bridge = tiles.children.find((child): child is Mesh => child instanceof Mesh);
      if (bridge === undefined) throw new Error("Expected a mixed-LOD bridge mesh.");
      bridge.geometry.deleteAttribute("normal");

      expect(() => tiles.process()).toThrow(/invalid rendered triangle data/u);
    } finally {
      tiles.dispose();
    }
  });

  it("rejects a bridge whose rendered positions went non-finite", () => {
    const tiles = new TerrainTiles({
      validate: true,
      surface: new MeshBasicMaterial(),
      residentByteBudget: 200_000,
      residentTileBudget: 2,
      sampleHeight,
      streamRadius: 1,
      tileResolution: 17,
      tileSize: 16,
      lodFactors: [1, 2],
      lodDistances: [4],
    });

    try {
      tiles.follow({ x: 2, z: 0 });
      const bridge = tiles.children.find((child): child is Mesh => child instanceof Mesh);
      if (bridge === undefined) throw new Error("Expected a mixed-LOD bridge mesh.");
      const position = bridge.geometry.getAttribute("position");
      position.setY(0, Number.NaN);
      // Written the way any writer that reaches the screen writes: a buffer change the renderer is
      // told about. A settled bridge skips its diagnostic until some rendered buffer's version moves.
      position.needsUpdate = true;

      expect(() => tiles.process()).toThrow(/bridge coordinates must be finite/u);
    } finally {
      tiles.dispose();
    }
  });

  it("rejects a bridge whose mesh moved its endpoints out of the world", () => {
    const tiles = new TerrainTiles({
      validate: true,
      surface: new MeshBasicMaterial(),
      residentByteBudget: 200_000,
      residentTileBudget: 2,
      sampleHeight,
      streamRadius: 1,
      tileResolution: 17,
      tileSize: 16,
      lodFactors: [1, 2],
      lodDistances: [4],
    });

    try {
      tiles.follow({ x: 2, z: 0 });
      const bridge = tiles.children.find((child): child is Mesh => child instanceof Mesh);
      if (bridge === undefined) throw new Error("Expected a mixed-LOD bridge mesh.");
      bridge.position.x = Number.NaN;

      expect(() => tiles.process()).toThrow(/bridge world coordinates/u);
    } finally {
      tiles.dispose();
    }
  });

  it("releases a half-built tile when its collider factory throws", () => {
    const tiles = new TerrainTiles({
      validate: true,
      createCollider: () => {
        throw new Error("collider-nope");
      },
      surface: new MeshBasicMaterial(),
      residentByteBudget: 200_000,
      residentTileBudget: 1,
      sampleHeight,
      streamRadius: 0,
      tileResolution: 9,
      tileSize: 16,
    });

    expect(() => tiles.follow({ x: 0, z: 0 })).toThrow("collider-nope");
    expect(tiles.residentTileCount).toBe(0);
    tiles.dispose();
  });

  it("fails closed when stitched neighbor geometry exceeds the byte cap", () => {
    const options = {
      surface: new MeshBasicMaterial(),
      residentTileBudget: 2,
      sampleHeight,
      streamRadius: 1,
      tileResolution: 17,
      tileSize: 16,
      lodDistances: [8, 16],
    };
    const probe = new TerrainTiles({ ...options, residentByteBudget: 1_000_000 });
    probe.follow({ x: 2, z: 0 });
    const fitted = probe.residentBytes;
    expect(probe.residentKeys).toEqual(["0:0", "1:0"]);
    probe.dispose();

    const tiles = new TerrainTiles({ ...options, residentByteBudget: fitted - 1 });
    try {
      expect(() => tiles.follow({ x: 2, z: 0 })).toThrow(/stitched neighbor geometry/u);
    } finally {
      tiles.dispose();
    }
  });

  it("reports a full topology description without retaining samples or flow", () => {
    const tiles = new TerrainTiles({
      validate: true,
      surface: new MeshBasicMaterial(),
      residentByteBudget: 20_000_000,
      residentTileBudget: 1,
      sampleHeight,
      tileResolution: 17,
      tileSize: 16,
      topologyObservation: {
        columns: 1025,
        depth: 1024,
        origin: { x: 0, z: 0 },
        rows: 1025,
        width: 1024,
      },
    });

    const topology = tiles.debug().topology as Record<string, unknown>;
    expect(topology).toMatchObject({ columns: 1025, depth: 1024, rows: 1025, width: 1024 });
    expect(topology).not.toHaveProperty("heights");
    expect(topology).not.toHaveProperty("flow");
    expect(topology).not.toHaveProperty("metrics");
    tiles.dispose();
  }, 60_000);

  // The tile build reads the field's own heights once and takes every level's normals by central
  // difference off that grid, so the two things worth proving are that the answer did not move and
  // that the reads did. A ramp is where the grid and `normalAt` must agree exactly, and a curving
  // height is where a stencil the grid invented instead of `normalAt`'s own would show: the coarser
  // levels sit every second and fourth field cell, so their normals only match if the ring kept
  // `normalAt`'s one-field-cell neighbours and its border clamp.
  it("derives every level's normals from one grid of the field's own heights", () => {
    const ramp = (x: number, z: number): number => 0.35 * x - 0.2 * z + 4;
    for (const [name, height] of [
      ["ramp", ramp],
      ["curve", sampleHeight],
    ] as const) {
      const heights = vi.spyOn(Heightfield.prototype, "heightAt");
      const tiles = new TerrainTiles({
        residentByteBudget: 4_000_000,
        residentTileBudget: 1,
        sampleHeight: height,
        streamRadius: 0,
        surface: new MeshBasicMaterial(),
        tileResolution: 17,
        tileSize: 16,
      });
      try {
        tiles.follow({ x: 8, z: 8 });
        // Counted here: the verification below asks the field for every `normalAt` itself.
        const reads = heights.mock.calls.length;
        const key = tiles.residentKeys[0];
        const tile = key === undefined ? undefined : tiles.getTile(key);
        if (tile === undefined) throw new Error("Expected the followed tile to be resident.");
        const expected = new Vector3();
        let worst = 0;
        let vertices = 0;
        for (const level of tile.lod.levels) {
          if (!(level.object instanceof Mesh)) throw new Error("Expected a level mesh.");
          const position = level.object.geometry.getAttribute("position");
          const normal = level.object.geometry.getAttribute("normal");
          const resolution = Math.round(Math.sqrt(position.count) - 2);
          for (let index = 0; index < resolution * resolution; index += 1) {
            const x = position.getX(index) + tile.field.origin.x;
            const z = position.getZ(index) + tile.field.origin.z;
            tile.field.normalAt(x, z, expected);
            worst = Math.max(
              worst,
              Math.abs(normal.getX(index) - expected.x),
              Math.abs(normal.getY(index) - expected.y),
              Math.abs(normal.getZ(index) - expected.z),
            );
            vertices += 1;
          }
        }
        expect(vertices).toBeGreaterThan(0);
        expect(worst, `${name} normals`).toBeLessThanOrEqual(1e-5);
        // 19 x 19 reads for the grid, where the per-vertex stencil asked 2,370.
        expect(reads, `${name} field reads`).toBeLessThanOrEqual(19 * 19);
      } finally {
        heights.mockRestore();
        tiles.dispose();
      }
    }
  });
});

it("measures missing visible terrain independently of pending offscreen tiles and updates camera matrices", () => {
  const tiles = new TerrainTiles({
    sampleHeight: () => 0,
    surface: new MeshBasicMaterial(),
    tileSize: 10,
    tileResolution: 3,
    lodFactors: [1],
    lodDistances: [],
    streamRadius: 1,
    residentTileBudget: 9,
    residentByteBudget: 1_000_000,
    mergeTiles: false,
  });
  const camera = new OrthographicCamera(-2, 2, 2, -2, 0.1, 30);
  camera.position.set(0, 10, 0);
  camera.lookAt(0, 0, 0);
  expect(tiles.readinessInView(camera, [0, 0])).toEqual({ required: 1, loaded: 0 });
  tiles.follow(
    { x: 0, z: 0 },
    {
      admit(work) {
        if (tiles.residentTileCount > 0) return false;
        work();
        return true;
      },
    },
  );
  expect(tiles.residentTileCount).toBe(1);
  expect(tiles.readinessInView(camera, [0, 0])).toEqual({ required: 1, loaded: 1 });
  camera.position.set(10, 10, 0);
  camera.lookAt(10, 0, 0);
  expect(tiles.readinessInView(camera, [0, 0])).toEqual({ required: 1, loaded: 0 });
  expect(() => tiles.readinessInView(camera, [1, 0])).toThrow(/bounds/u);
  expect(() => tiles.readinessInView(camera, [0, Number.NaN])).toThrow(/bounds/u);
  expect(() => tiles.readinessInView(camera, new Array(2) as [number, number])).toThrow(/bounds/u);
  tiles.position.x = 100;
  const parent = new Group();
  parent.position.x = 100;
  parent.add(camera);
  camera.position.set(0, 10, 0);
  camera.lookAt(100, 0, 0);
  camera.coordinateSystem = WebGPUCoordinateSystem;
  camera.updateProjectionMatrix();
  expect(tiles.readinessInView(camera, [0, 0])).toEqual({ required: 1, loaded: 1 });
  parent.position.x = 110;
  expect(tiles.readinessInView(camera, [0, 0])).toEqual({ required: 1, loaded: 0 });
  tiles.dispose();
});
