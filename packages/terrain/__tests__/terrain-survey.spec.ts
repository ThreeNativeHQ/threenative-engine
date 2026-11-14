import { cp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { cookKit } from "../src/cook/cook.js";
import { encodeHeightPNG } from "../src/core/io.js";
import { terrainStats } from "../src/core/stats.js";
import { Terrain } from "../src/core/terrain.js";
import {
  flatShare,
  forestFloor,
  isForestFloor,
  massifBearing,
  woodedFoot,
} from "../src/ground/ground.js";
import { placeMassif } from "../src/ground/massif.js";
import { LANDFORMS, type LandformKind } from "../src/ground/presets.js";
import { surveyHeights } from "../src/ground/survey.js";
import { MASSIFS, SURVEYS, locationSurvey } from "../src/ground/surveys.js";
import { TERRAIN_TOOLS, parseGenerateInput, parseGenerateRequest } from "../src/mcp/tools.js";
import { ECOREGION_ROWS } from "../src/request/ecoregions.js";

/** The checked-in Mapterhorn tiles (512 px lossless WebP), used as the whole tile cache these tests read. */
const FIXTURE_CACHE = new URL("./fixtures/mapterhorn/", import.meta.url).pathname;

const OFFLINE = () => {
  throw new Error("the survey tests never touch the network");
};

/**
 * The service as the checked-in tiles model it: a tile that is not checked in answers 404, as a site
 * with no tile at a zoom does, so the survey steps to the next coarser zoom the way it does live.
 */
const NO_TILE = () => Promise.resolve(new Response(null, { status: 404 }));

/** A game project the cook can run in: `@threenative/assets` linked, a config naming the assets. */
async function gameProject(): Promise<string> {
  const root = await realpath(await makeTempDir("tn-terrain-survey-"));
  await mkdir(join(root, "node_modules", "@threenative"), { recursive: true });
  await symlink(
    new URL("../../assets/", import.meta.url).pathname,
    join(root, "node_modules", "@threenative", "assets"),
  );
  await symlink(
    new URL("../../procedural-vegetation/", import.meta.url).pathname,
    join(root, "node_modules", "@threenative", "procedural-vegetation"),
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
      // A ground footprint of a few kilometres.
      expect(row.extentMeters, kind).toBeGreaterThanOrEqual(3_000);
      expect(row.extentMeters, kind).toBeLessThanOrEqual(8_000);
      expect(row.attribution, kind).toMatch(/U\.S\. Geological Survey|Copernicus/);
      expect(row.attribution, kind).toContain("© Mapterhorn (https://mapterhorn.com/attribution)");
    }
  });

  it("builds a survey row from a bare latitude and longitude", () => {
    const row = locationSurvey(45.9763, 7.6586);
    expect(row).toMatchObject({ lat: 45.9763, lon: 7.6586, extentMeters: 6_000 });
    expect(row.name).toBe("45.9763, 7.6586");
    expect(row.attribution).toContain("Copernicus GLO-30");
    expect(row.attribution).toContain("© Mapterhorn");
    for (const lat of [-91, 91, Number.NaN]) expect(() => locationSurvey(lat, 0)).toThrow(/lat/);
    for (const lon of [-181, 181, Number.NaN]) expect(() => locationSurvey(0, lon)).toThrow(/lon/);
  });
});

// PRD-885: the survey reads Mapterhorn. Two real tiles are checked in: Étretat at zoom 17 (0.39 m/px,
// French lidar) and Sprague Lake at zoom 16, the finest zoom that site has (zoom 17 answers 404).
describe("mapterhorn tiles", () => {
  const etretat = { name: "Étretat", lat: 49.70760838, lon: 0.20187378, extentMeters: 90 };
  const sprague = { name: "Sprague Lake", lat: 40.31932591, lon: -105.60882568, extentMeters: 100 };
  const credit = { attribution: "test" };
  const notFound = () => Promise.resolve(new Response(null, { status: 404 }));
  beforeEach(() => {
    vi.stubEnv("TN_TERRAIN_TILE_CACHE", FIXTURE_CACHE);
    vi.stubGlobal("fetch", OFFLINE);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("decodes a zoom 17 tile to its real elevations and reports the zoom and metres per pixel", async () => {
    // 90 m over 129 samples is a 0.70 m cell, and zoom 16 is 0.77 m/px here, so the survey asks for zoom 17.
    const survey = await surveyHeights({ ...etretat, ...credit }, 129);
    expect(survey.zoom).toBe(17);
    expect(survey.metersPerPixel).toBeCloseTo(0.39, 2);
    // The footprint centre is the tile's centre pixel: 6.953125 m, read straight from the tile.
    expect(survey.values[64 * 129 + 64]).toBeCloseTo(6.953125, 3);
    expect(survey.min).toBeGreaterThan(-3.6);
    expect(survey.max).toBeLessThan(23.3);
    expect(survey.max - survey.min).toBeGreaterThan(3);
  });

  it("steps from zoom 17 to zoom 16 where the site has no zoom 17 tile", async () => {
    const fetched: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      fetched.push(url);
      return notFound();
    });
    const survey = await surveyHeights({ ...sprague, ...credit }, 129);
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched.every((url) => url.startsWith("https://tiles.mapterhorn.com/17/"))).toBe(true);
    expect(survey.zoom).toBe(16);
    expect(survey.metersPerPixel).toBeCloseTo(0.91, 2);
    expect(survey.values[64 * 129 + 64]).toBeCloseTo(2660.1875, 3);
    expect(survey.min).toBeGreaterThan(2642);
    expect(survey.max).toBeLessThan(2682);
  });

  it("fails closed naming the site when no zoom has a tile", async () => {
    vi.stubEnv("TN_TERRAIN_TILE_CACHE", join(await makeTempDir("tn-terrain-empty-"), "cache"));
    vi.stubGlobal("fetch", notFound);
    await expect(surveyHeights({ ...sprague, ...credit }, 129)).rejects.toThrow(
      /Sprague Lake[\s\S]*no Mapterhorn tile at any zoom/,
    );
  });

  it("fails closed naming the tile when a cached file is not a tile", async () => {
    const cache = await makeTempDir("tn-terrain-bad-");
    await mkdir(join(cache, "16", "13542"), { recursive: true });
    await writeFile(join(cache, "16", "13542", "24734.webp"), "not a webp");
    vi.stubEnv("TN_TERRAIN_TILE_CACHE", cache);
    vi.stubGlobal("fetch", notFound);
    await expect(surveyHeights({ ...sprague, ...credit }, 129)).rejects.toThrow(
      /tiles\.mapterhorn\.com\/16\/13542\/24734\.webp[\s\S]*decode/,
    );
  });
});

describe("mapterhorn ground", () => {
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
    // The checked-in tile (z12/3626/1617), decoded and resampled to 257: the summit is 3 776 m, so a
    // 15.6 m pixel reads a little under it and no lower than the plain below the cone.
    expect(survey.zoom).toBe(12);
    expect(survey.metersPerPixel).toBeCloseTo(15.58, 1);
    expect(survey.min).toBeCloseTo(1_535.5, 0);
    expect(survey.max).toBeCloseTo(3_769.6, 0);
    // The summit is inside the frame, not a flat window of the plain.
    expect(Math.max(...survey.values) - Math.min(...survey.values)).toBeGreaterThan(2_000);
  });

  it("fails closed naming the tile when it is not cached and the network is down", async () => {
    const root = await gameProject();
    const out = join(root, "assets", "worlds", "world");
    vi.stubEnv("TN_TERRAIN_TILE_CACHE", join(root, "empty-cache"));
    await expect(
      cookKit({ kit: "forest", landform: "alpine", out, projectRoot: root }),
    ).rejects.toThrow(/tiles\.mapterhorn\.com\/12\/\d+\/\d+\.webp[\s\S]*ground: "procedural"/);
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
      // The cook names the tiles it read: Mapterhorn at zoom 12, 15.58 m per pixel at Fuji's latitude.
      tiles: "mapterhorn",
      zoom: 12,
      metersPerPixel: 15.58,
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

// PRD-887: a region is a real place. Each row records the range of its own crop, and the floor the
// cook cuts from it is that row's survey, with the attribution its source requires.
describe("the ecoregion rows", () => {
  beforeEach(() => {
    vi.stubEnv("TN_TERRAIN_TILE_CACHE", FIXTURE_CACHE);
    vi.stubGlobal("fetch", NO_TILE);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each([
    ["european-broadleaf", 304.6, 483],
    ["boreal", 143.5, 324.8],
    ["mediterranean", 276.2, 436],
    ["pacific-northwest", 46, 205.4],
  ])("decodes %s's site to the range its row records", async (id, min, max) => {
    const row = ECOREGION_ROWS.find((entry) => entry.id === id);
    expect(row, id).toBeDefined();
    const survey = await surveyHeights((row as (typeof ECOREGION_ROWS)[number]).site, 257);
    expect(survey.min).toBeCloseTo(min, 0);
    expect(survey.max).toBeCloseTo(max, 0);
  });

  // The lidar these sites now read is finer than the AWS tiles the floor gate was tuned on. At the
  // world's own square, boreal's river reads as 8.5 % hydro-flattened water and the Pacific
  // Northwest valley as a 31 degree 90th-percentile slope, so both centres fail the gate until
  // PRD-885 Phase 3 retunes the gate or moves the site. The cook still takes the centre as the last spot.
  it("cuts every row's floor at the world's own square, and says which are forest floors", async () => {
    const floors: Record<string, boolean> = {};
    for (const row of ECOREGION_ROWS) {
      // The crop the cook cuts: the world's side at the finest zoom, inside the row's own extent.
      const crop = await surveyHeights({ ...row.site, extentMeters: 512 }, 257);
      const stats = terrainStats(crop.values, 257, 512);
      floors[row.id] = isForestFloor(
        crop.max - crop.min,
        stats.slopeP90,
        512,
        flatShare(crop.values, 257),
      );
    }
    expect(floors).toEqual({
      "european-broadleaf": true,
      boreal: false,
      mediterranean: true,
      "pacific-northwest": false,
    });
  });

  it("grounds a region on its row's own survey and names its source", async () => {
    for (const row of ECOREGION_ROWS) {
      const document = {
        config: { resolution: 257, size: 512 },
        layers: [{ id: "hills", type: "noise", params: { amplitude: 30, scale: 100 } }],
      };
      const floor = await forestFloor(
        structuredClone(document) as Parameters<typeof forestFloor>[0],
        row.site,
        undefined,
      );
      expect(floor.ground, row.id).toEqual({
        source: "survey",
        name: row.site.name,
        lat: row.site.lat,
        lon: row.site.lon,
        attribution: row.site.attribution,
        // Each site lands on its own zoom: the finest one that has a tile there, at most 15 for a 2 m grid.
        tiles: "mapterhorn",
        zoom: expect.any(Number),
        metersPerPixel: expect.any(Number),
      });
      expect((floor.ground as { zoom: number }).zoom, row.id).toBeLessThanOrEqual(15);
      // The attribution the data source requires rides with the cooked world.
      expect(floor.readme, row.id).toContain(row.site.attribution);
    }
  });
});

// PRD-866: a mountain preset on a survey cooks a far ring with one real whole mountain past the
// square. The fixture holds the Rocky Mountain ground (z12), its ring (z10) and Longs Peak (z12).
describe("the far ring", () => {
  beforeEach(() => {
    vi.stubEnv("TN_TERRAIN_TILE_CACHE", FIXTURE_CACHE);
    vi.stubGlobal("fetch", NO_TILE);
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
    const grid = await surveyHeights(row, 257);
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
    // "spruce" is a forest word, so nothing in the request went unread.
    expect(under.unused).toEqual([]);
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
    await rm(join(cache, "12", "846", "1547.webp"));
    vi.stubEnv("TN_TERRAIN_TILE_CACHE", cache);
    vi.stubGlobal("fetch", OFFLINE);
    const out = join(root, "assets", "worlds", "world");
    await expect(
      cookKit({ kit: "forest", landform: "temperateMountains", out, projectRoot: root }),
    ).rejects.toThrow(
      /Longs Peak[\s\S]*tiles\.mapterhorn\.com\/12\/846\/1547\.webp[\s\S]*backdrop: "none"/,
    );
  }, 120_000);
});

// PRD-866: "a huge spruce forest" is a 1024 m square; its surveyed valley spans 128 m at a 16 degree
// 90th-percentile slope, a forest floor at that size. The relief bar scales with the side.
describe("the forest floor gate", () => {
  it("scales its relief bar with the square and keeps the slope bar", () => {
    expect(isForestFloor(86, 24, 512)).toBe(true);
    expect(isForestFloor(128, 16, 512)).toBe(false);
    expect(isForestFloor(128, 16, 1024)).toBe(true);
    expect(isForestFloor(80, 19, 256)).toBe(true);
    expect(isForestFloor(40, 31, 1024)).toBe(false);
  });
});

// PRD-866: the massif was drawn from the whole circle, so a seed could put it behind the camera.
describe("the massif's bearing", () => {
  it("follows the direction the kit's spawn camera looks", () => {
    // The forest kit's camera sits up and north-east of the player and looks south-west.
    const [from, to] = massifBearing([28, 24, 42]);
    const look = (Math.atan2(-42, -28) * 180) / Math.PI;
    expect(from).toBeLessThan(look);
    expect(to).toBeGreaterThan(look);
    expect(to - from).toBeLessThanOrEqual(50);
    const centre = ((from + to) / 2) * (Math.PI / 180);
    expect(Math.cos(centre) * 28 + Math.sin(centre) * 42).toBeLessThan(0);
  });
});

// PRD-866: a massif facing the forest with its steep side left the forest no foot to climb.
describe("the massif's wooded foot", () => {
  const cone = (slope: number) => {
    const n = 81;
    const heights = Array.from({ length: n * n }, (_, i) =>
      Math.max(0, 1000 - slope * 20 * Math.hypot((i % n) - 40, Math.floor(i / n) - 40)),
    );
    return { columns: n, rows: n, spacing: 20, heights };
  };
  it("reads a gentle foot as wooded and a cliff as not", () => {
    expect(woodedFoot(cone(0.5), 1000)).toBeGreaterThan(0.95);
    expect(woodedFoot(cone(1.5), 1000)).toBeLessThan(0.05);
  });
});

// PRD-866: a hydro-flattened lake in the crop draws as a bare level lawn.
describe("the forest floor's flattened lakes", () => {
  it("measures a flat lake surface and rejects a floor that holds one", () => {
    const n = 65;
    const slope = Array.from({ length: n * n }, (_, i) => (i % n) * 0.3 + Math.floor(i / n) * 0.2);
    expect(flatShare(slope, n)).toBe(0);
    const lake = slope.map((h, i) =>
      Math.hypot((i % n) - 32, Math.floor(i / n) - 32) < 7 ? 5 : h,
    );
    const share = flatShare(lake, n);
    expect(share).toBeGreaterThan(0.02);
    expect(isForestFloor(40, 20, 512, share)).toBe(false);
    expect(isForestFloor(40, 20, 512, flatShare(slope, n))).toBe(true);
  });
});
