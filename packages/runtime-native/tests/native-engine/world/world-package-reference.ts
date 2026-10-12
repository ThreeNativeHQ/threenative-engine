/**
 * Records packages/core/src/world-package.ts as a C++ table the native validator is compared against
 * (PRD-521 phase 1). Every manifest is recorded as JSON TEXT, so both sides read the same bytes: the
 * generator parses its own text with JSON.parse and runs the real `validateWorldPackage`, and the
 * native test parses the same text with the engine's json.h. Errors keep their order, code, path and
 * message. `cellPlacements` cases record either the borrowed float32 view or the RangeError reason.
 *
 *   pnpm --workspace-root exec tsx packages/runtime-native/tests/native-engine/world/world-package-reference.ts
 *   ... -- --check   (fails when the committed table is not what the core module produces)
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  type IWorldRun,
  cellPlacements,
  validateWorldPackage,
} from "../../../../core/src/world-package.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "world_package_reference.inc");

const PLACEMENT_RECORDS = 200;
const PLACEMENTS_BYTE_LENGTH = PLACEMENT_RECORDS * 32;

/** C string literal: the fixtures are ASCII; escape backslash, quote, newline, carriage return, tab. */
const cstr = (s: string) =>
  `"${s
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"')
    .replace(/\n/gu, "\\n")
    .replace(/\r/gu, "\\r")
    .replace(/\t/gu, "\\t")}"`;

/** A double as C++ source; JSON's NaN and Infinity have no literal, and -0 must keep its sign. */
const cpp64 = (x: number): string => {
  if (Number.isNaN(x)) return "std::numeric_limits<double>::quiet_NaN()";
  if (x === Number.POSITIVE_INFINITY) return "std::numeric_limits<double>::infinity()";
  if (x === Number.NEGATIVE_INFINITY) return "-std::numeric_limits<double>::infinity()";
  if (Object.is(x, -0)) return "-0.0";
  return `${x}`;
};

/**
 * JSON text as JavaScript's JSON.stringify writes it, except that a non-finite number becomes an
 * overflowing literal (JSON has no Infinity, so the text `1e999` is how a fixture reaches it).
 */
function jsonText(value: unknown): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return value > 0 ? "1e999" : "-1e999";
    if (Object.is(value, -0)) return "-0";
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(jsonText).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => `${JSON.stringify(key)}:${jsonText(item)}`)
    .join(",")}}`;
}

function validPackage(): Record<string, unknown> {
  return {
    assets: {
      rock: {
        bounds: { max: [1, 2, 1], min: [-1, 0, -1] },
        glb: "assets/rock.glb",
      },
      tree: {
        bounds: { max: [3, 12, 3], min: [-3, 0, -3] },
        glb: "assets/tree.glb",
        lods: [
          { distance: 60, glb: "assets/tree_lod1.glb" },
          { distance: 140, glb: "assets/tree_lod2.glb" },
        ],
        maxDistance: 220,
      },
    },
    cellSize: 128,
    cells: [
      { chunks: ["chunks/0_3.glb"], runs: [{ asset: "tree", count: 120, offset: 0 }], x: 0, z: 3 },
      { runs: [{ asset: "rock", count: 10, offset: 120 }], x: 5, z: 5 },
      { chunks: ["chunks/1_1.glb"], runs: [{ asset: "tree", count: 5, offset: 0 }], x: 1, z: 1 },
      { chunks: [], runs: [], x: 15, z: 0 },
    ],
    extent: { minX: -1000, minZ: -1000, sizeX: 2000, sizeZ: 2000 },
    placements: "placements.bin",
    terrain: {
      columns: 1001,
      heightMax: 240,
      heightMin: -12.5,
      heightmap: "terrain/heightmap.u16",
      layers: { grass: "terrain/grass.png" },
      rows: 1001,
      spacing: 2,
    },
    version: 1,
  };
}

type Manifest = Record<string, unknown>;
const full = validPackage();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
/** A shallow copy without `key`; `delete` is banned, and `undefined` has no JSON text. */
const without = (value: Manifest, key: string): Manifest => {
  const copy: Manifest = {};
  for (const [name, item] of Object.entries(value)) if (name !== key) copy[name] = item;
  return copy;
};
const terrain = full.terrain as Manifest;
const extent = full.extent as Manifest;

const minimal: Manifest = {
  ...full,
  assets: { tree: { bounds: { max: [1, 1, 1], min: [-1, -1, -1] }, glb: "assets/tree.glb" } },
  cells: [{ runs: [{ asset: "tree", count: 1, offset: 0 }], x: 0, z: 0 }],
  terrain: {
    columns: terrain.columns,
    heightMax: terrain.heightMax,
    heightMin: terrain.heightMin,
    heightmap: terrain.heightmap,
    rows: terrain.rows,
    spacing: terrain.spacing,
  },
};

interface ICase {
  name: string;
  text: string;
  heightmapByteLength?: number;
  /** When set, the placements option; every case otherwise uses the 200-record buffer. */
  placementsByteLength?: number;
}

const cases: ICase[] = [];
const fromValue = (name: string, value: unknown, extra: Partial<ICase> = {}): void => {
  cases.push({ name, text: jsonText(value), ...extra });
};

// The fixtures packages/core/__tests__/world-package.spec.ts uses, plus every branch it does not.
fromValue("valid-full", full);
fromValue("valid-minimal", minimal);
fromValue("heightmap-byte-length-correct", full, { heightmapByteLength: 1001 * 1001 * 2 });
fromValue("heightmap-byte-length-wrong", full, { heightmapByteLength: 6410 });
fromValue("non-object-string", "not a package");
fromValue("non-object-null", null);
fromValue("non-object-array", []);
fromValue("non-object-number", 42);
fromValue("wrong-version", { ...clone(full), version: 2 });
fromValue("version-string", { ...clone(full), version: "1" });
fromValue("version-null", { ...clone(full), version: null });
fromValue("version-missing", without(full, "version"));
fromValue("unknown-asset", {
  ...clone(full),
  cells: [{ runs: [{ asset: "ghost", count: 1, offset: 0 }], x: 0, z: 0 }],
});
fromValue("unknown-asset-missing", {
  ...clone(full),
  cells: [{ runs: [{ count: 1, offset: 0 }], x: 0, z: 0 }],
});
fromValue("unknown-asset-null", {
  ...clone(full),
  cells: [{ runs: [{ asset: null, count: 1, offset: 0 }], x: 0, z: 0 }],
});
fromValue("unknown-asset-number", {
  ...clone(full),
  cells: [{ runs: [{ asset: 5, count: 1, offset: 0 }], x: 0, z: 0 }],
});
fromValue("run-past-buffer", {
  ...clone(full),
  cells: [{ runs: [{ asset: "tree", count: 2, offset: 199 }], x: 0, z: 0 }],
});
fromValue("negative-run-count", {
  ...clone(full),
  cells: [{ runs: [{ asset: "tree", count: -1, offset: 0 }], x: 0, z: 0 }],
});
fromValue("negative-run-offset", {
  ...clone(full),
  cells: [{ runs: [{ asset: "tree", count: 1, offset: -1 }], x: 0, z: 0 }],
});
fromValue("non-integer-run-offset", {
  ...clone(full),
  cells: [{ runs: [{ asset: "tree", count: 1, offset: 0.5 }], x: 0, z: 0 }],
});
fromValue("non-integer-run-count", {
  ...clone(full),
  cells: [{ runs: [{ asset: "tree", count: 1.5, offset: 0 }], x: 0, z: 0 }],
});
fromValue("run-offset-string", {
  ...clone(full),
  cells: [{ runs: [{ asset: "tree", count: 1, offset: "0" }], x: 0, z: 0 }],
});
fromValue("run-count-string", {
  ...clone(full),
  cells: [{ runs: [{ asset: "tree", offset: 0, count: "1" }], x: 0, z: 0 }],
});
fromValue("run-missing-offset", {
  ...clone(full),
  cells: [{ runs: [{ asset: "tree", count: 1 }], x: 0, z: 0 }],
});
fromValue("run-missing-count", {
  ...clone(full),
  cells: [{ runs: [{ asset: "tree", offset: 0 }], x: 0, z: 0 }],
});
fromValue("run-not-object", {
  ...clone(full),
  cells: [{ runs: [5], x: 0, z: 0 }],
});
fromValue("runs-missing", { ...clone(full), cells: [{ x: 0, z: 0 }] });
fromValue("runs-not-array", { ...clone(full), cells: [{ runs: {}, x: 0, z: 0 }] });
fromValue("cell-outside-extent", { ...clone(full), cells: [{ runs: [], x: 16, z: 0 }] });
fromValue("cell-negative", { ...clone(full), cells: [{ runs: [], x: -1, z: 0 }] });
fromValue("cell-non-integer", { ...clone(full), cells: [{ runs: [], x: 1.5, z: 0 }] });
fromValue("cell-not-object", { ...clone(full), cells: [5] });
fromValue("cells-not-array", { ...clone(full), cells: {} });
fromValue("cells-missing", without(full, "cells"));
fromValue("cell-chunks-not-array", {
  ...clone(full),
  cells: [{ chunks: "x", runs: [], x: 0, z: 0 }],
});
fromValue("cell-chunks-empty-string", {
  ...clone(full),
  cells: [{ chunks: [""], runs: [], x: 0, z: 0 }],
});
fromValue("cell-chunks-non-string", {
  ...clone(full),
  cells: [{ chunks: [5], runs: [], x: 0, z: 0 }],
});
fromValue("terrain-columns-mismatch", { ...clone(full), terrain: { ...terrain, columns: 1000 } });
fromValue("terrain-rows-mismatch", { ...clone(full), terrain: { ...terrain, rows: 3 } });
fromValue("terrain-columns-fractional", {
  ...clone(full),
  terrain: { ...terrain, spacing: 3, columns: 667, rows: 667 },
});
fromValue("terrain-missing", without(full, "terrain"));
fromValue("terrain-null", { ...clone(full), terrain: null });
fromValue("terrain-heightmap-empty", { ...clone(full), terrain: { ...terrain, heightmap: "" } });
fromValue("terrain-columns-zero", { ...clone(full), terrain: { ...terrain, columns: 0 } });
fromValue("terrain-rows-negative", { ...clone(full), terrain: { ...terrain, rows: -2 } });
fromValue("terrain-columns-non-integer", { ...clone(full), terrain: { ...terrain, columns: 2.5 } });
fromValue("terrain-spacing-zero", { ...clone(full), terrain: { ...terrain, spacing: 0 } });
fromValue("terrain-spacing-non-number", { ...clone(full), terrain: { ...terrain, spacing: "2" } });
fromValue("terrain-heightMin-non-finite", {
  ...clone(full),
  terrain: { ...terrain, heightMin: Number.POSITIVE_INFINITY },
});
fromValue("terrain-layers-not-object", { ...clone(full), terrain: { ...terrain, layers: "x" } });
fromValue("terrain-layers-empty-path", {
  ...clone(full),
  terrain: { ...terrain, layers: { grass: "" } },
});
fromValue("terrain-layers-non-string", {
  ...clone(full),
  terrain: { ...terrain, layers: { grass: 5 } },
});
fromValue("assets-missing", without(full, "assets"));
fromValue("asset-not-object", { ...clone(full), assets: { tree: 5 } });
fromValue("asset-glb-empty", {
  ...clone(full),
  assets: { tree: { bounds: { max: [1, 1, 1], min: [-1, -1, -1] }, glb: "" } },
});
fromValue("asset-bounds-missing", { ...clone(full), assets: { tree: { glb: "a.glb" } } });
fromValue("asset-bounds-min-length", {
  ...clone(full),
  assets: {
    tree: { bounds: { max: [1, 1, 1], min: [-1, 0] }, glb: "a.glb" },
  },
});
fromValue("asset-bounds-min-non-finite", {
  ...clone(full),
  assets: {
    tree: { bounds: { max: [1, 1, 1], min: [Number.POSITIVE_INFINITY, 0, 0] }, glb: "a.glb" },
  },
});
fromValue("asset-lods-not-array", {
  ...clone(full),
  assets: { tree: { bounds: { max: [1, 1, 1], min: [-1, -1, -1] }, glb: "a.glb", lods: {} } },
});
fromValue("asset-lods-entry-not-object", {
  ...clone(full),
  assets: { tree: { bounds: { max: [1, 1, 1], min: [-1, -1, -1] }, glb: "a.glb", lods: [5] } },
});
fromValue("asset-lods-glb-empty", {
  ...clone(full),
  assets: {
    tree: {
      bounds: { max: [1, 1, 1], min: [-1, -1, -1] },
      glb: "a.glb",
      lods: [{ distance: 1, glb: "" }],
    },
  },
});
fromValue("asset-lods-distance-string", {
  ...clone(full),
  assets: {
    tree: {
      bounds: { max: [1, 1, 1], min: [-1, -1, -1] },
      glb: "a.glb",
      lods: [{ distance: "1", glb: "b.glb" }],
    },
  },
});
fromValue("asset-maxDistance-string", {
  ...clone(full),
  assets: {
    tree: { bounds: { max: [1, 1, 1], min: [-1, -1, -1] }, glb: "a.glb", maxDistance: "220" },
  },
});
fromValue("placements-missing", without(full, "placements"));
fromValue("placements-empty", { ...clone(full), placements: "" });
fromValue("extent-missing", without(full, "extent"));
fromValue("extent-null", { ...clone(full), extent: null });
fromValue("extent-minX-string", { ...clone(full), extent: { ...extent, minX: "0" } });
fromValue("extent-sizeX-zero", { ...clone(full), extent: { ...extent, sizeX: 0 } });
fromValue("extent-sizeX-negative", { ...clone(full), extent: { ...extent, sizeX: -1 } });
fromValue("extent-sizeZ-non-finite", {
  ...clone(full),
  extent: { ...extent, sizeZ: Number.POSITIVE_INFINITY },
});
fromValue("wrong-typed-extent-field", {
  ...clone(full),
  extent: { minX: 0, minZ: 0, sizeX: "2000", sizeZ: 2000 },
});
fromValue("cellSize-zero", { ...clone(full), cellSize: 0 });
fromValue("cellSize-negative", { ...clone(full), cellSize: -128 });
fromValue("cellSize-string", { ...clone(full), cellSize: "128" });
fromValue("collect-every-error", {
  ...clone(full),
  cells: [{ runs: [{ asset: "ghost", count: 2, offset: 199 }], x: 16, z: 0 }],
  version: 9,
});
// A repeated key keeps its first position and its last value, as JSON.parse and json.h both do.
cases.push({
  name: "duplicate-version-key-last-wins",
  text: `{"version":2,"version":1,${jsonText(full).slice(1)}`,
});
cases.push({
  name: "duplicate-version-key-last-malformed",
  text: `{"version":1,"version":"x",${jsonText(full).slice(1)}`,
});
// Object.entries puts array-index keys first, ascending; "01" and 4294967295 are not indices.
cases.push({
  name: "integer-like-asset-ids-reorder",
  text: `{"version":1,"assets":{"b":{},"10":{},"01":{},"2":{},"4294967295":{},"4294967294":{}},"cells":[]}`,
});
cases.push({
  name: "integer-like-layer-names-reorder",
  text: `{"version":1,"terrain":{"layers":{"z":"","7":"","0":""}},"cells":[]}`,
});
// Nesting well inside json.h's kMaxDepth = 64, carrying keys the validator ignores.
fromValue("deep-nesting-valid", {
  ...clone(full),
  extra: { a: { b: { c: { d: { e: [1, 2, [3, { f: null }]] } } } } },
});

interface IRecordedError {
  code: string;
  path: string;
  message: string;
}

const recorded: { manifest: ICase; errors: IRecordedError[] }[] = cases.map((manifest) => {
  const value = JSON.parse(manifest.text) as unknown;
  const options: { placementsByteLength: number; heightmapByteLength?: number } = {
    placementsByteLength: manifest.placementsByteLength ?? PLACEMENTS_BYTE_LENGTH,
  };
  if (manifest.heightmapByteLength !== undefined)
    options.heightmapByteLength = manifest.heightmapByteLength;
  const { errors } = validateWorldPackage(value, options);
  return {
    manifest,
    errors: errors.map(({ code, path: errorPath, message }) => ({
      code,
      message,
      path: errorPath,
    })),
  };
});

/* ---- cellPlacements over a 10-record buffer whose floats are their index ---- */
const f32bits = (x: number) => new Uint32Array(new Float32Array([x]).buffer)[0] as number;
function filled(count: number): ArrayBuffer {
  const buffer = new ArrayBuffer(count * 32);
  const floats = new Float32Array(buffer);
  for (let index = 0; index < floats.length; index += 1) floats[index] = index;
  return buffer;
}
const placementRuns: { name: string; records: number; offset: number; count: number }[] = [
  { count: 3, name: "accepted-middle", offset: 2, records: 10 },
  { count: 8, name: "accepted-large", offset: 1, records: 10 },
  { count: 1, name: "accepted-exact-end", offset: 9, records: 10 },
  { count: 0, name: "accepted-empty", offset: 0, records: 10 },
  { count: 1, name: "accepted-negative-zero-offset", offset: -0, records: 10 },
  { count: 1, name: "refused-past-buffer", offset: 10, records: 10 },
  { count: 2, name: "refused-past-buffer-199", offset: 199, records: 200 },
  { count: 1, name: "refused-huge-offset", offset: 1e15, records: 10 },
  { count: 1, name: "refused-negative-offset", offset: -1, records: 10 },
  { count: -1, name: "refused-negative-count", offset: 0, records: 10 },
  { count: 1, name: "refused-non-integer-offset", offset: 0.5, records: 10 },
  { count: 1.5, name: "refused-non-integer-count", offset: 0, records: 10 },
  { count: 1, name: "refused-nan-offset", offset: Number.NaN, records: 10 },
  { count: Number.NaN, name: "refused-nan-count", offset: 0, records: 10 },
  { count: 1, name: "refused-infinite-offset", offset: Number.POSITIVE_INFINITY, records: 10 },
];
const placementCases = placementRuns.map(({ name, records, offset, count }) => {
  const buffer = filled(records);
  const bufferFloats = Array.from(new Float32Array(buffer));
  const run: IWorldRun = { asset: "tree", count, offset };
  let refused = false;
  let code = "";
  let values: number[] = [];
  try {
    const view = cellPlacements(buffer, run);
    values = Array.from(view);
  } catch (error) {
    refused = true;
    code = String(error).includes("past the")
      ? "TN_WORLD_PLACEMENT_BOUNDS"
      : "TN_WORLD_PLACEMENT_RANGE";
  }
  return {
    buffer,
    bufferFloats,
    code,
    count,
    name,
    offset,
    refused,
    values,
  };
});

const lines = [
  "// Generated by packages/runtime-native/tests/native-engine/world/world-package-reference.ts from",
  "// packages/core/src/world-package.ts. Do not edit: rerun the generator.",
  "// Manifests are JSON text; errors keep the reference order, code, path and message. Placement",
  "// values are float32 bit patterns.",
  "struct RefWorldError {",
  "    const char* code;",
  "    const char* path;",
  "    const char* message;",
  "};",
  "struct RefWorldManifest {",
  "    const char* text;",
  "    double placementsByteLength;",
  "    bool hasHeightmapByteLength;",
  "    double heightmapByteLength;",
  "    const RefWorldError* errors;",
  "    std::size_t errorCount;",
  "};",
];
for (const [i, { errors }] of recorded.entries()) {
  if (errors.length === 0) continue;
  lines.push(`static const RefWorldError kWorldErrors${i}[] = {`);
  for (const error of errors)
    lines.push(`    {${cstr(error.code)}, ${cstr(error.path)}, ${cstr(error.message)}},`);
  lines.push("};");
}
lines.push("static const RefWorldManifest kWorldManifests[] = {");
for (const [i, { manifest, errors }] of recorded.entries()) {
  const byteLength = manifest.placementsByteLength ?? PLACEMENTS_BYTE_LENGTH;
  const hasHeightmap = manifest.heightmapByteLength !== undefined;
  const heightmap = manifest.heightmapByteLength ?? 0;
  lines.push(
    `    {${cstr(manifest.text)}, ${cpp64(byteLength)}, ${hasHeightmap}, ${cpp64(heightmap)}, ${
      errors.length === 0 ? "nullptr" : `kWorldErrors${i}`
    }, ${errors.length}},`,
  );
}
lines.push("};", "");

lines.push(
  "struct RefPlacementCase {",
  "    const char* name;",
  "    const uint32_t* buffer;",
  "    std::size_t bufferFloats;",
  "    double offset;",
  "    double count;",
  "    bool refused;",
  "    const char* code;",
  "    const uint32_t* values;",
  "    std::size_t valueCount;",
  "};",
);
for (const [i, c] of placementCases.entries()) {
  lines.push(
    `static const uint32_t kPlacementBuffer${i}[] = {${c.bufferFloats.map((v) => `${f32bits(v)}u`).join(", ")}};`,
  );
  if (!c.refused && c.values.length > 0)
    lines.push(
      `static const uint32_t kPlacementValues${i}[] = {${c.values.map((v) => `${f32bits(v)}u`).join(", ")}};`,
    );
}
lines.push("static const RefPlacementCase kPlacements[] = {");
for (const [i, c] of placementCases.entries()) {
  const hasValues = !c.refused && c.values.length > 0;
  lines.push(
    `    {${cstr(c.name)}, kPlacementBuffer${i}, std::size(kPlacementBuffer${i}), ${cpp64(c.offset)}, ${cpp64(
      c.count,
    )}, ${c.refused}, ${cstr(c.code)}, ${hasValues ? `kPlacementValues${i}` : "nullptr"}, ${
      hasValues ? c.values.length : 0
    }},`,
  );
}
lines.push("};", "");

const text = lines.join("\n");
if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== text) {
    console.error(
      "TN_FIXTURE_STALE: world_package_reference.inc is not what world-package.ts produces",
    );
    process.exit(1);
  }
  console.log(`current: ${recorded.length} manifests, ${placementCases.length} placements`);
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${recorded.length} manifests, ${placementCases.length} placements`);
}
