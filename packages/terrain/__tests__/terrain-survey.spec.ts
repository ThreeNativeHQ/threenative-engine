import { cp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { encodeHeightPNG } from "../src/core/io.js";
import { LANDFORMS, type LandformKind } from "../src/core/presets.js";
import { placeMassif } from "../src/core/massif.js";
import { terrainStats } from "../src/core/stats.js";
import { MASSIFS, SURVEYS, locationSurvey } from "../src/core/surveys.js";
import { Terrain } from "../src/core/terrain.js";
import { cookKit } from "../src/mcp/cook.js";
import { surveyHeights } from "../src/mcp/survey.js";
import { TERRAIN_TOOLS, parseGenerateInput, parseGenerateRequest } from "../src/mcp/tools.js";

/** The checked-in terrarium tiles, used as the whole tile cache these tests read. */
const FIXTURE_CACHE = new URL("./fixtures/terrarium/", import.meta.url).pathname;

const OFFLINE = () => {
  throw new Error("the survey tests never touch the network");
};

/** A game project the cook can run in: `@threenative/assets` linked, a config naming the assets. */
async function gameProject(): Promise<string> {
  const root = await realpath(await makeTempDir("tn-terrain-survey-"));
  await mkdir(join(root, "node_modules", "@threenative"), { recursive: true });
  await symlink(
    new URL("../../assets/", import.meta.url).pathname,
    join(root, "node_modules", "@threenative", "assets"),
  );
  await writeFile(
    join(root, "threenative.config.ts"),
    'export default { assets: { source: "assets" } };',
  );
  return root;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, initial) => {
  let n = initial;
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
const crc32 = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (const b of bytes) c = (crcTable[(c ^ b) & 255] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** A flat grayscale PNG at a chosen bit depth, to prove which files a heightmap refuses. */
function grayPng(width: number, height: number, bitDepth: 8 | 16): Uint8Array {
  const chunk = (type: string, content: Uint8Array) => {
    const bytes = new Uint8Array(content.length + 12);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, content.length);
    bytes.set(new TextEncoder().encode(type), 4);
    bytes.set(content, 8);
    view.setUint32(bytes.length - 4, crc32(bytes.subarray(4, bytes.length - 4)));
    return bytes;
  };
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header[8] = bitDepth;
  header[9] = 0;
  const raw = new Uint8Array((width * (bitDepth / 8) + 1) * height);
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", new Uint8Array(deflateSync(raw))),
      chunk("IEND", new Uint8Array()),
    ]),
  );
}

describe("the survey table", () => {
  it("names a real place and its data source for every landform", () => {
    for (const kind of Object.keys(LANDFORMS) as LandformKind[]) {
      const row = SURVEYS[kind];
      expect(row, kind).toBeDefined();
      expect(row.name.length, kind).toBeGreaterThan(3);
      expect(Math.abs(row.lat), kind).toBeLessThanOrEqual(90);
      expect(Math.abs(row.lon), kind).toBeLessThanOrEqual(180);
      // A ground footprint of a few kilometres, at the ~30 m/px zoom a real place reads at.
      expect(row.extentMeters, kind).toBeGreaterThanOrEqual(3_000);
      expect(row.extentMeters, kind).toBeLessThanOrEqual(8_000);
      expect(row.zoom, kind).toBeGreaterThanOrEqual(11);
      expect(row.zoom, kind).toBeLessThanOrEqual(13);
      expect(row.attribution, kind).toMatch(/U\.S\. Geological Survey|Copernicus|Land Information/);
      expect(row.attribution, kind).toContain("AWS Terrain Tiles");
    }
  });

  it("builds a survey row from a bare latitude and longitude", () => {
    const row = locationSurvey(45.9763, 7.6586);
    expect(row).toMatchObject({ lat: 45.9763, lon: 7.6586, zoom: 12, extentMeters: 6_000 });
    expect(row.name).toBe("45.9763, 7.6586");
    expect(row.attribution).toContain("SRTM");
    for (const lat of [-91, 91, Number.NaN]) expect(() => locationSurvey(lat, 0)).toThrow(/lat/);
    for (const lon of [-181, 181, Number.NaN]) expect(() => locationSurvey(0, lon)).toThrow(/lon/);
  });
});

describe("terrarium tiles", () => {
  beforeEach(() => {
    vi.stubEnv("TN_TERRAIN_TILE_CACHE", FIXTURE_CACHE);
    vi.stubGlobal("fetch", OFFLINE);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("decodes the cached Mount Fuji tile to its real elevations", async () => {
    const survey = await surveyHeights(SURVEYS.volcanic, 257);
    expect(survey.width).toBe(257);
    expect(survey.height).toBe(257);
    expect(survey.values).toHaveLength(257 * 257);
    // The checked-in tile (z12/3626/1617, SRTM), decoded and resampled to 257: the summit is 3 776 m,
    // so a 30 m source reads a little under it and no lower than the plain below the cone.
    expect(survey.min).toBeCloseTo(1_548, 0);
    expect(survey.max).toBeCloseTo(3_753, 0);
    // The summit is inside the frame, not a flat window of the plain.
    expect(Math.max(...survey.values) - Math.min(...survey.values)).toBeGreaterThan(2_000);
  });

  it("fails closed naming the tile when it is not cached and the network is down", async () => {
    const root = await gameProject();
    const out = join(root, "assets", "worlds", "world");
    vi.stubEnv("TN_TERRAIN_TILE_CACHE", join(root, "empty-cache"));
    await expect(
      cookKit({ kit: "forest", landform: "alpine", out, projectRoot: root }),
    ).rejects.toThrow(
      /elevation-tiles-prod\/terrarium\/12\/\d+\/\d+\.png[\s\S]*ground: "procedural"/,
    );
  }, 120_000);

  it("cooks a landform preset from the cached survey and names the data it used", async () => {
    const root = await gameProject();
    const out = join(root, "assets", "worlds", "world");
    const result = JSON.parse(
      await cookKit({ kit: "forest", landform: "volcanic", out, projectRoot: root }),
    );
    const row = SURVEYS.volcanic;
    expect(result.ground).toEqual({
      source: "survey",
      name: row.name,
      lat: row.lat,
      lon: row.lon,
      attribution: row.attribution,
    });
    // The survey is the ground layer, not a layer beside the preset's noise: the shape stamps that
    // would duplicate the real cone are gone, and the finishing passes still run on top.
    const recipe = JSON.parse(await readFile(join(root, result.recipeJson), "utf8"));
    const layers = recipe.layers as { id: string; type: string; params: Record<string, unknown> }[];
    expect(layers[0]).toMatchObject({ type: "heightmap" });
    expect((layers[0]?.params.data as { values: number[] }).values).toHaveLength(257 * 257);
    expect(layers.some((layer) => layer.type === "stamp")).toBe(false);
    expect(layers.some((layer) => layer.type === "erode")).toBe(true);
    expect(layers.some((layer) => layer.type === "noise")).toBe(false);
    // The kit's README carries the attribution the data source requires.
    const readme = await readFile(join(root, result.out, "README.md"), "utf8");
    expect(readme).toContain(row.attribution);
    expect(readme).toContain(row.name);
    expect(result.triangles).toBeGreaterThan(0);
  }, 120_000);

  it("cooks the preset's own noise when the request says procedural, without a fetch", async () => {
    const root = await gameProject();
    const out = join(root, "assets", "worlds", "world");
    const fetch = vi.fn(OFFLINE);
    vi.stubGlobal("fetch", fetch);
    const result = JSON.parse(
      await cookKit({
        kit: "forest",
        landform: "alpine",
        ground: "procedural",
        out,
        projectRoot: root,
      }),
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(result.ground).toEqual({ source: "procedural" });
    const recipe = JSON.parse(await readFile(join(root, result.recipeJson), "utf8"));
    expect(recipe.layers.some((layer: { type: string }) => layer.type === "heightmap")).toBe(false);
    expect(recipe.layers.some((layer: { type: string }) => layer.type === "noise")).toBe(true);
  }, 120_000);

  it("takes a 16-bit heightmap PNG as the ground", async () => {
    const root = await gameProject();
    const png = await encodeHeightPNG(
      new Terrain({ resolution: 65, size: 500, seed: 5 }).evaluate(),
    );
    await writeFile(join(root, "ground.png"), png);
    const fetch = vi.fn(OFFLINE);
    vi.stubGlobal("fetch", fetch);
    const out = join(root, "assets", "worlds", "world");
    const result = JSON.parse(
      await cookKit({
        kit: "forest",
        landform: "alpine",
        ground: { heightmap: "ground.png" },
        out,
        projectRoot: root,
      }),
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(result.ground).toEqual({ source: "heightmap", heightmap: "ground.png" });
    const recipe = JSON.parse(await readFile(join(root, result.recipeJson), "utf8"));
    const ground = (recipe.layers as { type: string; params: Record<string, unknown> }[])[0];
    expect(ground?.type).toBe("heightmap");
    expect(ground?.params.data).toMatchObject({ width: 65, height: 65 });
    expect(result.triangles).toBeGreaterThan(0);
  }, 120_000);

  it("refuses an 8-bit PNG and a PNG wider than 4 097 px, naming the field", async () => {
    const root = await gameProject();
    const heightmap = async (name: string, bytes: Uint8Array) => {
      await writeFile(join(root, name), bytes);
      return cookKit({
        kit: "forest",
        landform: "alpine",
        ground: { heightmap: name },
        out: join(root, "assets", "worlds", name.replace(/\W/g, "")),
        projectRoot: root,
      });
    };
    await expect(heightmap("eight.png", grayPng(64, 64, 8))).rejects.toThrow(
      /ground\.heightmap.*8-bit/,
    );
    await expect(heightmap("wide.png", grayPng(4098, 1, 16))).rejects.toThrow(
      /ground\.heightmap.*4097/,
    );
  }, 120_000);
});

describe("the ground argument", () => {
  it("takes the three ground sources and closes the field to them", () => {
    expect(parseGenerateInput({ kit: "forest", ground: "procedural" })).toEqual({
      kit: "forest",
      ground: "procedural",
    });
    expect(parseGenerateInput({ kit: "forest", ground: { heightmap: "hills.r16" } })).toEqual({
      kit: "forest",
      ground: { heightmap: "hills.r16" },
    });
    expect(
      parseGenerateInput({ kit: "forest", ground: { location: { lat: 46.5, lon: 8.5 } } }),
    ).toEqual({ kit: "forest", ground: { location: { lat: 46.5, lon: 8.5 } } });
    for (const ground of ["survey", 2, [], {}, { heightmap: "hills.tif" }, { location: {} }])
      expect(() => parseGenerateInput({ kit: "forest", ground })).toThrow(/ground/);
    expect(() =>
      parseGenerateInput({ kit: "forest", ground: { location: { lat: 91, lon: 0 } } }),
    ).toThrow(/lat/);
    expect(() =>
      parseGenerateInput({ kit: "forest", ground: { heightmap: "a.png", min: 1 } }),
    ).toThrow(/min/);
    expect(() => parseGenerateInput({ kit: "forest", moons: 1 })).toThrow(/unknown field 'moons'/);
  });

  it("names the argument, and the automatic pick as a default", () => {
    expect(parseGenerateRequest({ kit: "forest", ground: "procedural" }).decided.ground).toEqual({
      value: "procedural",
      source: "argument",
    });
    expect(
      parseGenerateRequest({ kit: "forest", ground: { location: { lat: 46.5, lon: 8.5 } } }).decided
        .ground,
    ).toEqual({ value: { location: { lat: 46.5, lon: 8.5 } }, source: "argument" });
    // A preset is grounded on its kind's survey; a starter keeps its own authored crop.
    expect(parseGenerateRequest({ kit: "forest", landform: "volcanic" }).decided.ground).toEqual({
      value: "survey",
      source: "default",
    });
    expect(parseGenerateRequest({ kit: "forest", request: "mountains" }).decided.ground).toEqual({
      value: "survey",
      source: "default",
    });
    expect(parseGenerateRequest({ kit: "forest" }).decided.ground).toEqual({
      value: "starter",
      source: "default",
    });
    // A word that names the biome's own authored landform leaves the starter's recipe in place, so
    // the record must not promise a survey the cook will not fetch: the alpine starter is already
    // a real DEM crop of the Alps' own front range.
    const own = parseGenerateRequest({ kit: "alpine", request: "alpine mountains" });
    expect(own.input).toEqual({ kit: "alpine" });
    expect(own.decided.ground).toEqual({ value: "starter", source: "default" });
  });

  it("declares the ground field in the tool schema", () => {
    const schema = TERRAIN_TOOLS[0].inputSchema as unknown as {
      properties: Record<string, { anyOf?: readonly unknown[] }>;
    };
    expect(schema.properties.ground?.anyOf).toHaveLength(3);
  });
});

// PRD-866: a mountain preset on a survey cooks a far ring with one real whole mountain past the
// square. The fixture holds the Rocky Mountain ground (z12), its ring (z10) and Longs Peak (z12).
describe("the far ring", () => {
  beforeEach(() => {
    vi.stubEnv("TN_TERRAIN_TILE_CACHE", FIXTURE_CACHE);
    vi.stubGlobal("fetch", OFFLINE);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  // PRD-866 Phase 1 gates on the cook's own massif data (Terrarium, one zoom finer than its row for a
  // 17 m relief map), on the flat host `massif.spec.ts` isolates a mountain with. Inside a real ring
  // the smooth survey around it dilutes curvature kurtosis, so that is where the gate is comparable.
  it("fetches a massif sharp enough for the Phase 1 gates", async () => {
    const row = MASSIFS.temperateMountains?.[0] as (typeof SURVEYS)["alpine"];
    const grid = await surveyHeights({ ...row, zoom: row.zoom + 1 }, 257);
    const tile = { id: "longs", size: row.extentMeters, resolution: 257, heights: grid.values };
    for (const seed of [1, 2, 3]) {
      const { terrain } = placeMassif(
        new Terrain({ size: 8000, resolution: 257, seed: 1 }).flatten({
          id: "flat",
          at: [0, 0],
          radius: 1e5,
          falloff: 0,
          height: 0,
        }),
        { seed, tile: [tile] },
      );
      const state = terrain.evaluate();
      const stats = terrainStats(state.height, state.resolution, state.size);
      expect(stats.relief).toBeGreaterThan(550);
      expect(stats.curvatureKurtosis).toBeGreaterThan(40);
    }
  });

  it("is decided by a mountain landform on a survey, and named off by the argument", () => {
    const decided = (args: Record<string, unknown>) => parseGenerateRequest(args).decided.backdrop;
    expect(decided({ kit: "forest", landform: "temperateMountains" })).toEqual({
      value: "massif",
      source: "default",
    });
    expect(decided({ kit: "forest", landform: "alpine", ground: "procedural" })).toEqual({
      value: "none",
      source: "default",
    });
    expect(decided({ kit: "forest", landform: "volcanic" })).toEqual({
      value: "none",
      source: "default",
    });
    expect(decided({ kit: "forest" })).toEqual({ value: "none", source: "default" });
    const off = parseGenerateRequest({ kit: "forest", landform: "alpine", backdrop: "none" });
    expect(off.decided.backdrop).toEqual({ value: "none", source: "argument" });
    expect(off.input.backdrop).toBe("none");
    expect(() => parseGenerateRequest({ kit: "forest", backdrop: "massif" })).toThrow(/backdrop/);
    // "Under mountains" names the range past the square: the forest keeps its own ground, cut from
    // its survey, and the massif comes from the word's range.
    const under = parseGenerateRequest({ request: "a spruce forest under mountains" });
    expect(under.input).toMatchObject({ landform: "temperateMountains", backdropRange: "alpine" });
    expect(under.decided.backdrop).toEqual({ value: "massif", source: "default" });
    expect(under.unused).toEqual(["spruce"]);
  });

  it("writes ring.json with the survey continued and a surveyed mountain past the square", async () => {
    const root = await gameProject();
    const out = join(root, "assets", "worlds", "world");
    const result = JSON.parse(
      await cookKit({
        kit: "forest",
        landform: "temperateMountains",
        seed: 4,
        out,
        projectRoot: root,
      }),
    );
    // The seed moves the crop across the same range: another real valley, not the row's own crop.
    expect(result.ground.lat).not.toBe(SURVEYS.temperateMountains.lat);
    expect(result.ground.name).toBe(SURVEYS.temperateMountains.name);
    expect(result.backdrop).toMatchObject({
      source: "massif",
      name: "Longs Peak and Mount Meeker, Rocky Mountain National Park, Colorado",
    });
    const ring = JSON.parse(await readFile(join(out, "ring.json"), "utf8")) as {
      size: number;
      resolution: number;
      heights: number[];
      massif: {
        at: [number, number];
        height: number;
        detail: { columns: number; rows: number; heights: number[] };
      };
    };
    expect(ring.size).toBe(512 * 10);
    expect(ring.heights).toHaveLength(ring.resolution ** 2);
    // The decision, plus the massif at its own spacing for a game's relief map.
    expect(ring.massif).toMatchObject(result.backdrop);
    expect(ring.massif.detail.heights).toHaveLength(
      ring.massif.detail.columns * ring.massif.detail.rows,
    );
    // The mountain stands outside the square, and its summit rises over the ring around it.
    expect(Math.max(Math.abs(ring.massif.at[0]), Math.abs(ring.massif.at[1]))).toBeGreaterThan(256);
    // Longs Peak in its own metres: 649 m above its perimeter, drawn at 0.85 to 1.15 of that.
    expect(ring.massif.height).toBeGreaterThan(450);
    const n = ring.resolution;
    const cell = ring.size / (n - 1);
    const at = (x: number, z: number) =>
      ring.heights[
        Math.round((z + ring.size / 2) / cell) * n + Math.round((x + ring.size / 2) / cell)
      ] as number;
    const centre = at(0, 0);
    expect(at(...ring.massif.at) - centre).toBeGreaterThan(ring.massif.height * 0.5);
    const readme = await readFile(join(out, "README.md"), "utf8");
    expect(readme).toContain("Longs Peak");
    // The same request cooks the same ring.
    const again = join(root, "assets", "worlds", "again");
    await cookKit({
      kit: "forest",
      landform: "temperateMountains",
      seed: 4,
      out: again,
      projectRoot: root,
    });
    expect(await readFile(join(again, "ring.json"), "utf8")).toBe(
      await readFile(join(out, "ring.json"), "utf8"),
    );
  }, 240_000);

  it("writes no ring under backdrop: none", async () => {
    const root = await gameProject();
    const out = join(root, "assets", "worlds", "world");
    const result = JSON.parse(
      await cookKit({
        kit: "forest",
        landform: "temperateMountains",
        backdrop: "none",
        out,
        projectRoot: root,
      }),
    );
    expect(result.backdrop).toEqual({ source: "none" });
    await expect(readFile(join(out, "ring.json"))).rejects.toThrow(/ENOENT/);
  }, 120_000);

  it("fails closed naming the massif tile when it is not cached and the network is down", async () => {
    const root = await gameProject();
    const cache = join(root, "cache");
    await cp(FIXTURE_CACHE, cache, { recursive: true });
    // Longs Peak's own tile; the ground and the ring are still cached.
    await rm(join(cache, "13", "1692", "3093.png"));
    vi.stubEnv("TN_TERRAIN_TILE_CACHE", cache);
    const out = join(root, "assets", "worlds", "world");
    await expect(
      cookKit({ kit: "forest", landform: "temperateMountains", out, projectRoot: root }),
    ).rejects.toThrow(/Longs Peak[\s\S]*terrarium\/13\/1692\/3093\.png[\s\S]*backdrop: "none"/);
  }, 120_000);
});
