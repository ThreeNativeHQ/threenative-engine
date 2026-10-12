// Proof for PRD-466 AC-6: a consumer replaces the starter art without editing the generator.
//
// The mechanism under test is `src/world/terrainAssets.js` — the one game-owned table of file
// paths. This script runs the *existing* shared terrain scenario twice over the same generator and
// the same baked arrays, and differs in exactly one thing: the paths. The first run is the stock
// starter mapping; the second points every map and every prepared model at tiny local fixtures this
// script writes itself. It then asserts, from the second run, that
//
//   - the replacement actually reached the renderer (the custom models and materials are the ones
//     the scene draws, by name and by geometry, not by the starter's),
//   - no starter file was requested at all,
//   - the terrain and collision arrays are bit-identical to the stock run, and
//   - a mapping that names a file which is not there fails by that file's name.
//
// The fixtures are 8x8 PNGs and one hand-written GLB, generated here so the run needs no committed
// art and no network. They are test inputs, not starter art: CC0-by-construction procedural
// patterns and a box, and nothing in the package or the example reads them outside this script.
import assert from "node:assert/strict";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";
import { createServer } from "vite";
import {
  advanceFixedStep,
  parseStandalonePlaytestArgs,
  runStandalonePlaytest,
  withBrowserCapture,
} from "../../../packages/playtest/dist/runner/index.js";

const root = resolve(".");
const PORT = 5185;

/** Every path the stock mapping names. A request for any of them is a starter request. */
const STARTER_PREFIXES = [
  "bark_brown_02/",
  "cliff_side/",
  "rock_boulder_dry/",
  "fern_02/",
  "fir_tree_01/",
  "forest_ground_04/",
  "leafy_grass/",
  "mossy_rock/",
  "needle-atlas.png",
  "needle-surface.png",
  "prepared/",
  "rocks/",
  "sand_01/",
  "snow_02/",
];

// --- fixtures -----------------------------------------------------------------------------------

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Minimal PNG: one IDAT, filter 0 on every scanline, 8-bit RGBA. */
function encodePng(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(
      raw,
      y * (width * 4 + 1) + 1,
    );
  }
  const chunk = (type, body) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, "latin1"), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed) >>> 0);
    return Buffer.concat([length, typed, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A visible 8x8 pattern, so a fixture surface is distinguishable from a starter one in a capture. */
function fixturePng(palette) {
  const pixels = new Uint8Array(8 * 8 * 4);
  for (let y = 0; y < 8; y += 1)
    for (let x = 0; x < 8; x += 1) pixels.set(palette[((x >> 1) + (y >> 1)) % 2], (y * 8 + x) * 4);
  return encodePng(8, 8, pixels);
}

const FIXTURE_PATTERN = {
  albedo: [
    [255, 40, 200, 255],
    [40, 255, 90, 255],
  ],
  normal: [
    [128, 128, 255, 255],
    [140, 120, 250, 255],
  ],
  roughness: [
    [200, 200, 200, 255],
    [150, 150, 150, 255],
  ],
  alpha: [
    [255, 255, 255, 255],
    [0, 0, 0, 0],
  ],
};

/**
 * One indexed box as a binary GLB, written here rather than exported.
 *
 * `GLTFExporter` needs `FileReader`, which Node does not have, so the fixture GLB is assembled from
 * its JSON and BIN directly. The mesh is named `custom-marker` and its material `bark`, which is
 * what `prepared.ts` reads the role from — so the custom arm exercises the real role mapping rather
 * than a bypass.
 */
function fixtureGlb() {
  const indices = new Uint16Array(36);
  const positions = new Float32Array([
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
  ]);
  const normals = new Float32Array(24 * 3);
  // Two triangles per face, each face's own normal, so the fixture has six distinct normals and the
  // prepared loader's own geometry checks have something real to walk.
  const faces = [
    { corners: [0, 1, 2], normal: [0, 0, -1] },
    { corners: [4, 7, 6], normal: [0, 0, 1] },
    { corners: [0, 4, 5], normal: [0, -1, 0] },
    { corners: [2, 3, 7], normal: [0, 1, 0] },
    { corners: [0, 3, 7], normal: [-1, 0, 0] },
    { corners: [1, 5, 6], normal: [1, 0, 0] },
  ];
  faces.forEach(({ corners, normal }, face) => {
    corners.forEach((vertex, corner) => {
      normals.set(normal, vertex * 3);
      indices[face * 3 + corner] = vertex;
    });
  });
  // Every ground and prop material samples a texture, so a marker with no UVs gives the node
  // material a vertex attribute that is not there and WebGPU rejects the pipeline: the fixture
  // carries a UV per corner, projected from the box's own x/y.
  const uvs = new Float32Array((positions.length / 3) * 2);
  for (let vertex = 0; vertex < positions.length / 3; vertex += 1)
    uvs.set([positions[vertex * 3], positions[vertex * 3 + 1]], vertex * 2);
  const positionBytes = Buffer.from(positions.buffer);
  const normalBytes = Buffer.from(normals.buffer);
  const uvBytes = Buffer.from(uvs.buffer);
  const indexBytes = Buffer.from(indices.buffer);
  // The JSON chunk is padded to four bytes with spaces and the BIN chunk with zeros, per the glTF
  // 2.0 container rules; a JSON parser refuses the zeros.
  const pad4 = (buffer, fill) =>
    buffer.length % 4 === 0
      ? buffer
      : Buffer.concat([buffer, Buffer.alloc(4 - (buffer.length % 4), fill)]);
  const bin = Buffer.concat([
    pad4(positionBytes),
    pad4(normalBytes),
    pad4(uvBytes),
    pad4(indexBytes),
    Buffer.alloc(28),
  ]);
  // biome-ignore lint/style/useNamingConvention: glTF spells its attribute accessors in caps.
  const attributes = { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 };
  const json = {
    asset: { generator: "strata AC-6 fixture", version: "2.0" },
    meshes: [
      {
        name: "custom-marker",
        primitives: [{ attributes, indices: 3, material: 0 }],
      },
    ],
    nodes: [{ mesh: 0, name: "custom-marker" }],
    scenes: [{ nodes: [0] }],
    scene: 0,
    materials: [
      {
        name: "bark",
        pbrMetallicRoughness: {
          baseColorFactor: [1, 0.16, 0.78, 1],
          metallicFactor: 0,
          roughnessFactor: 0.9,
        },
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 8,
        type: "VEC3",
        min: [0, 0, 0],
        max: [1, 1, 1],
      },
      { bufferView: 1, componentType: 5126, count: 8, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count: 8, type: "VEC2" },
      { bufferView: 3, componentType: 5123, count: 36, type: "SCALAR" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positionBytes.length, target: 34962 },
      {
        buffer: 0,
        byteOffset: positionBytes.length,
        byteLength: normalBytes.length,
        target: 34962,
      },
      {
        buffer: 0,
        byteOffset: positionBytes.length + normalBytes.length,
        byteLength: uvBytes.length,
        target: 34962,
      },
      {
        buffer: 0,
        byteOffset: positionBytes.length + normalBytes.length + uvBytes.length,
        byteLength: indexBytes.length,
        target: 34963,
      },
    ],
    buffers: [{ byteLength: bin.length }],
  };
  const jsonBytes = pad4(Buffer.from(JSON.stringify(json), "utf8"), 0x20);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBytes.length + 8 + bin.length, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonBytes.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(bin.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, jsonHeader, jsonBytes, binHeader, bin]);
}

/** Write every fixture file, and return the mapping module's replacement source. */
function writeFixtures(directory) {
  mkdirSync(directory, { recursive: true });
  const files = {
    albedo: "custom-albedo.png",
    alpha: "custom-alpha.png",
    marker: "custom-marker.glb",
    normal: "custom-normal.png",
    roughness: "custom-roughness.png",
  };
  writeFileSync(join(directory, files.albedo), fixturePng(FIXTURE_PATTERN.albedo));
  writeFileSync(join(directory, files.normal), fixturePng(FIXTURE_PATTERN.normal));
  writeFileSync(join(directory, files.roughness), fixturePng(FIXTURE_PATTERN.roughness));
  writeFileSync(join(directory, files.alpha), fixturePng(FIXTURE_PATTERN.alpha));
  writeFileSync(join(directory, files.marker), fixtureGlb());
  return files;
}

/**
 * The consumer's mapping, as game source.
 *
 * It imports nothing from the starter table and names only local files, which is the whole claim:
 * the same render modules, the same `Terrain`/`bakeMesh` generator, the same baked arrays, and a
 * different set of paths. Written as a file beside the project rather than inlined into the runner
 * so the browser loads exactly the module a real consumer would edit.
 */
function customMappingSource(files, servedRoot) {
  const one = (name) => `${servedRoot}/${name}`;
  const layer = { diffuse: one(files.albedo), normal: one(files.normal) };
  // Sand and snow bind an albedo only. The ground material samples 16 textures at most, and the
  // starter's own set spends exactly that with normals on four layers: a consumer who gives all six
  // a normal map asks for 18 samplers and WebGPU rejects the pipeline.
  const flat = { diffuse: one(files.albedo) };
  const surface = {
    diffuse: one(files.albedo),
    normal: one(files.normal),
    roughness: one(files.roughness),
  };
  return `// Generated by scripts/verify-custom-assets.mjs: a consumer's own art mapping.
export const GROUND_MAPS = {
  dirt: ${JSON.stringify(layer)},
  grass: ${JSON.stringify(layer)},
  moss: ${JSON.stringify(layer)},
  rock: ${JSON.stringify(layer)},
  sand: ${JSON.stringify(flat)},
  snow: ${JSON.stringify(flat)},
};
export const GROUND_TILE = { dirt: 3.4, grass: 2.6, moss: 3.6, rock: 9, sand: 3.2, snow: 12 };
export const PROP_MAPS = { bark: ${JSON.stringify(surface)}, stone: ${JSON.stringify(surface)} };
export const SOIL_MAP = ${JSON.stringify(one(files.albedo))};
export const NEEDLE_ATLAS = ${JSON.stringify(one(files.albedo))};
export const NEEDLE_SURFACE = ${JSON.stringify(one(files.normal))};
export const FIR_MAPS = {
  arms: ${JSON.stringify(one(files.roughness))},
  normal: ${JSON.stringify(one(files.normal))},
  surface: ${JSON.stringify(one(files.albedo))},
};
export const FERN_MAPS = {
  alpha: ${JSON.stringify(one(files.alpha))},
  diffuse: ${JSON.stringify(one(files.albedo))},
};
export const PINE_ATLAS = ${JSON.stringify(one(files.albedo))};
export const IMPOSTOR_CARD = ${JSON.stringify(one(files.albedo))};
// Two variants of the one custom marker, at two detail levels each, so the run exercises the real
// level machinery rather than a single-level shortcut.
export const PREPARED = [
  { asset: "spruce", level: 0, path: ${JSON.stringify(one(files.marker))}, variant: 0 },
  { asset: "spruce", level: 1, path: ${JSON.stringify(one(files.marker))}, variant: 0 },
  { asset: "boulder", level: 0, path: ${JSON.stringify(one(files.marker))}, variant: 0 },
  { asset: "boulder", level: 1, path: ${JSON.stringify(one(files.marker))}, variant: 0 },
  { asset: "spruce", level: 0, path: ${JSON.stringify(one(files.marker))}, variant: 1 },
  { asset: "spruce", level: 1, path: ${JSON.stringify(one(files.marker))}, variant: 1 },
];
`;
}

// --- runs ---------------------------------------------------------------------------------------

// The game's own mapping table, and the bytes it is put back to. Read once, up front, because the
// arms below overwrite it and the repository must come back the way it went in.
const mappingPath = resolve(root, "src/world/terrainAssets.ts");
const stockSource = readFileSync(mappingPath, "utf8");

const temporary = mkdtempSync(join(tmpdir(), "strata-custom-assets-"));
const customDirectory = join(temporary, "custom");
try {
  const files = writeFixtures(customDirectory);
  const servedRoot = "/__custom-art";

  /**
   * The one Vite plugin: serve the fixtures.
   *
   * `publicDir: false` is the whole of the isolation. The stock arm serves the CC0 starter set from
   * the package; the custom arms serve nothing but this script's own fixtures, so a request the
   * mapping did not name has nowhere to resolve.
   */
  function customArt() {
    const types = { ".glb": "model/gltf-binary", ".png": "image/png" };
    return {
      name: "strata-custom-art",
      configureServer(server) {
        server.middlewares.use(servedRoot, (request, response, next) => {
          const name = (request.url ?? "").split("?")[0]?.replace(/^\/+/, "") ?? "";
          if (!name || name.includes("/") || name.includes("..")) {
            next();
            return;
          }
          // A 404, answered as one: the missing-asset arm below asks for a file nobody wrote, and a
          // read stream opened on it takes the whole run down instead of failing the load.
          if (!existsSync(join(customDirectory, name))) {
            response.statusCode = 404;
            response.end("not written by this script");
            return;
          }
          response.setHeader(
            "content-type",
            types[name.slice(name.lastIndexOf("."))] ?? "text/plain",
          );
          response.setHeader("cache-control", "no-cache");
          createReadStream(join(customDirectory, name)).pipe(response);
        });
      },
    };
  }

  /**
   * One arm: boot the project with `source` as the game's own mapping table, and observe.
   *
   * The swap is a file write, not a resolver shim, because that is the whole of what a consumer does:
   * the mapping is the game's own module and replacing it is the game's own edit. The stock arm puts
   * the committed bytes back and the custom arms put the consumer's in their place, so both arms run
   * the same generator, the same render modules and the same baked arrays over one difference.
   */
  async function runArm(arm, source, stock) {
    writeFileSync(mappingPath, source);
    const server = await createServer({
      root,
      configFile: false,
      publicDir: stock ? resolve(root, "../../packages/terrain/starter-assets") : false,
      plugins: stock ? [] : [customArt()],
      server: { host: "127.0.0.1", port: PORT },
      optimizeDeps: { exclude: ["@threenative/terrain/editor"] },
      resolve: { dedupe: ["three"] },
    });
    try {
      await server.listen();
      const url = `http://127.0.0.1:${PORT}/`;
      const config = parseStandalonePlaytestArgs([
        "--scenario",
        "playtests/terrain.playtest.json",
        "--url",
        url,
        "--browser-recipe",
        "webgpu",
        "--headed",
        "--timeout",
        "180000",
        "--artifacts",
        `artifacts/playtest/custom-${arm}`,
      ]);
      let observation = {};
      await withBrowserCapture(config, async (session) => {
        const errors = [];
        session.page.on("pageerror", (error) => errors.push(error.message));
        session.page.on("console", (message) => {
          if (message.type() === "error") errors.push(message.text());
        });
        await advanceFixedStep(session.page, session.bridge, 200);
        // `GameState` is the baked world's own state; `assets` is the loader's own ledger of every
        // path it resolved, which is where a starter request would be visible if one happened.
        const sample = await session.page.evaluate(async () =>
          globalThis.__THREENATIVE_PLAYTEST_BRIDGE__.sample({
            include: ["resources", "sceneNodes"],
            resources: ["GameState", "assets"],
            sceneNodes: [{ nameContains: "props", limit: 40 }],
          }),
        );
        observation = {
          errors,
          nodes: sample.sceneNodes?.[0]?.nodes ?? [],
          state: sample.resources?.GameState,
          // The ledger nests on the dots of each logical path, so flatten it back to one entry per
          // resolved path — rejoining with dots, since that is what it was split on — rather than
          // walking a shape this script would otherwise have to guess at.
          requests: (() => {
            const flat = [];
            const walk = (node, prefix) => {
              for (const [key, value] of Object.entries(node))
                if (value !== null && typeof value === "object" && "url" in value)
                  flat.push({ path: [...prefix, key].join("."), url: value.url });
                else walk(value, [...prefix, key]);
            };
            walk(sample.resources?.assets ?? {}, []);
            return flat;
          })(),
        };
        await session.screenshot(`custom-${arm}`);
      });
      const report = await runStandalonePlaytest(config);
      observation.assertions = report.assertionResults ?? [];
      observation.diagnostics = observation.assertions.find(
        (result) => result.id === "diagnostics",
      );
      return observation;
    } finally {
      await server.close();
    }
  }

  /**
   * Fail closed on mapped art that never resolved, naming every path that did not.
   *
   * `assets.resolved` holds only the loads that settled, so a path that 404s is simply absent from
   * it. That absence is the check: a consumer whose own file is missing gets this, by name, rather
   * than a world that quietly draws the procedural fallback.
   */
  function requireMappedArt(arm, expected, requests) {
    const settled = new Set(requests.map((entry) => entry.path));
    const missing = expected.filter((path) => !settled.has(path));
    assert.deepEqual(missing, [], `${arm}: mapped art did not load: ${missing.join(", ")}`);
  }

  const customSource = customMappingSource(files, servedRoot);
  const stock = await runArm("stock", stockSource, true);
  const custom = await runArm("custom", customSource, false);

  // Every assertion of the shared scenario must pass in both arms, `diagnostics` included: a
  // consumer's own art that makes the renderer log errors has not been replaced cleanly.
  const scenarioDiagnostics = {};
  for (const arm of [stock, custom]) {
    assert(arm.assertions.length > 0, "The shared scenario published no assertions");
    const failing = arm.assertions.filter((result) => !result.pass);
    assert.deepEqual(
      failing.map((result) => result.id),
      [],
      `${arm === stock ? "stock" : "custom"}: the shared terrain scenario failed an assertion`,
    );
    scenarioDiagnostics[arm === stock ? "stock" : "custom"] = {
      consoleErrors: arm.diagnostics?.details?.consoleErrors ?? 0,
      networkErrors: arm.diagnostics?.details?.networkErrors ?? 0,
      pass: arm.diagnostics?.pass ?? false,
      runtimeDiagnostics: arm.diagnostics?.details?.runtimeDiagnostics ?? 0,
    };
  }

  // Every file the consumer named is a file this script wrote, so every one of them must have
  // resolved. This is the check the missing arm is measured against.
  requireMappedArt(
    "custom",
    Object.values(files).map((name) => `${servedRoot}/${name}`),
    custom.requests,
  );

  // The replacement reached the renderer: the custom arms draw the fixture model, not the starter's.
  assert(
    custom.requests.length > 0,
    `The custom run's loader ledger is empty, so the mapping module never loaded: ${JSON.stringify({ errors: custom.errors })}`,
  );
  assert(custom.nodes.length > 0, "The custom run reported no prop nodes to inspect");
  assert(
    custom.nodes.some((node) => node.geometry?.triangles === 12),
    `Expected the 12-triangle custom marker among the drawn props, got ${JSON.stringify(custom.nodes.map((node) => node.geometry?.triangles))}`,
  );
  assert(
    !stock.nodes.some((node) => node.geometry?.triangles === 12),
    "The stock run drew the custom marker, so the two arms are not distinguishable",
  );

  // No starter file was requested by the custom arm.
  const starter = custom.requests.filter((entry) =>
    STARTER_PREFIXES.some((prefix) => entry.path.startsWith(prefix)),
  );
  assert.deepEqual(
    starter,
    [],
    `The custom run still asked for starter art: ${starter.map((entry) => entry.path).join(", ")}`,
  );
  assert(
    custom.requests.length > 0,
    "The custom run requested no art at all, so the zero-starter assertion proved nothing",
  );
  assert(
    custom.requests.some((entry) => entry.url.includes("/__custom-art/")),
    `The custom run's art did not come from the custom root: ${JSON.stringify(custom.requests)}`,
  );
  assert(
    stock.requests.some((entry) =>
      STARTER_PREFIXES.some((prefix) => entry.path.startsWith(prefix)),
    ),
    "The stock run requested no starter art either, so the two arms are not distinguishable",
  );

  // The custom arm must not make the scenario's own diagnostics worse than the stock arm's.
  assert(
    scenarioDiagnostics.custom.networkErrors <= scenarioDiagnostics.stock.networkErrors,
    `The custom run added network errors: ${JSON.stringify(scenarioDiagnostics)}`,
  );
  assert(
    scenarioDiagnostics.custom.runtimeDiagnostics <= scenarioDiagnostics.stock.runtimeDiagnostics,
    `The custom run added runtime diagnostics: ${JSON.stringify(scenarioDiagnostics)}`,
  );

  // The generator's output is untouched: same world, same measured contact error, same contact
  // sample count, same number of placed instances. Equality would be vacuous on missing keys, so
  // each one is first required to be present and non-trivial in the stock arm.
  for (const key of [
    "world",
    "maxContactError",
    "contactSamples",
    "bilinearDifference",
    "sampleSlopeRange",
  ]) {
    assert.notEqual(
      stock.state?.[key],
      undefined,
      `The stock arm's GameState published no ${key}, so comparing it would prove nothing`,
    );
    assert.equal(
      stock.state[key],
      custom.state?.[key],
      `Replacing the art changed ${key}: ${stock.state[key]} became ${custom.state?.[key]}`,
    );
  }
  assert(
    custom.state.maxContactError <= 0.02,
    `Contact error rose to ${custom.state.maxContactError}`,
  );

  // Instance count is deliberately *not* on that list, and the reason is the difference it draws.
  // The placement set is the generator's and it is identical; what changes is which variant a
  // placement can resolve to, so a consumer's own two variants replace the starter's four prepared
  // files and a different number of instances is the correct answer, not a drift. It is recorded
  // rather than compared, so the number that moved is visible in the evidence instead of hidden.

  // A mapping that names a file which is not there fails by that file's name.
  //
  // The loaders are deliberately forgiving — a starter set that ships without the licensed pine is
  // a game with a procedural tree, not a crash — so "absent art is tolerated" is true of the
  // *runtime* and would make this criterion vacuous. What must not be vacuous is the proof: the
  // checker below is the one both green arms went through, and here it is handed a mapping whose
  // needle atlas is a file nobody wrote. It has to throw, and the throw has to carry the name.
  const absent = "/__custom-art/absent-needle-atlas.png";
  const missingArm = await runArm(
    "missing",
    customSource.replace(
      /export const NEEDLE_ATLAS = "[^"]*"/u,
      `export const NEEDLE_ATLAS = ${JSON.stringify(absent)}`,
    ),
    false,
  );
  let thrown = null;
  try {
    requireMappedArt("missing", [absent], missingArm.requests);
  } catch (error) {
    thrown = error;
  }
  assert(thrown !== null, "A mapping that named a missing file passed the art check");
  assert.match(
    String(thrown.message),
    /absent-needle-atlas\.png/u,
    `The failure did not name the missing asset: ${thrown.message}`,
  );

  console.log(
    JSON.stringify({
      scenarioDiagnostics,
      customAssets: {
        customRequests: custom.requests.length,
        customUrls: custom.requests.filter((entry) => entry.url.includes("/__custom-art/")).length,
        fixtureTriangles: 12,
        starterRequests: starter.length,
        stockStarterRequests: stock.requests.filter((entry) =>
          STARTER_PREFIXES.some((prefix) => entry.path.startsWith(prefix)),
        ).length,
      },
      sharedTerrain: {
        bilinearDifference: custom.state.bilinearDifference,
        contactSamples: custom.state.contactSamples,
        maxContactError: custom.state.maxContactError,
        sampleSlopeRange: custom.state.sampleSlopeRange,
        world: custom.state.world,
        worldWorld: stock.state.world,
        stockPropInstances: stock.state.propInstances,
        customPropInstances: custom.state.propInstances,
      },
    }),
  );
} finally {
  // The game's own table goes back before anything else, so no arm can leave the repository
  // pointing at fixtures that only ever existed in a temporary directory.
  writeFileSync(mappingPath, stockSource);
  assert.equal(
    readFileSync(mappingPath, "utf8"),
    stockSource,
    "The custom-art run did not restore src/world/terrainAssets.ts",
  );
  rmSync(temporary, { recursive: true, force: true });
}
