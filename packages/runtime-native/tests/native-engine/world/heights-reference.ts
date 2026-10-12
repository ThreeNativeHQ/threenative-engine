/**
 * Records `heightSamplerFromHeightmap`'s samples and a `Heightfield` update/query scenario as a C++
 * table the native test compares against bit for bit (PRD-521 phase 3). Every float is recorded as
 * its binary64 bit pattern, so the comparison is exact.
 *
 * The sampler case reads a deterministic 33x17 uint16 heightmap with non-unit spacing and a
 * negative heightMin, and samples ~200 points: inside, on vertices, on edges and outside (clamped).
 * The heightfield case replays updateHeights calls — valid, out-of-bounds, wrong-length and
 * non-finite — recording after each call whether it threw, the sample version and heightAt at 20
 * fixed points.
 *
 *   pnpm --workspace-root exec tsx packages/runtime-native/tests/native-engine/world/heights-reference.ts
 *   ... -- --check   (fails when the committed table is not what the core modules produce)
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { heightSamplerFromHeightmap } from "../../../../core/src/world-heightmap.js";
import { Heightfield, type IHeightfieldRegion } from "../../../../core/src/world.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "heights_reference.inc");

const f64 = (x: number) => {
  const words = new Uint32Array(new Float64Array([x]).buffer);
  return (BigInt(words[1] as number) << 32n) | BigInt(words[0] as number);
};
const hex64 = (bits: bigint) => `0x${bits.toString(16).padStart(16, "0")}ull`;
const bits = (x: number) => hex64(f64(x));
const u64array = (values: readonly number[]) => values.map((v) => `${v}ull`).join(", ");

/* ---- sampler: a deterministic 33x17 uint16 heightmap with non-unit spacing and negative min ---- */
const COLUMNS = 33;
const ROWS = 17;
const SPACING = 2.5;
const MIN_X = -16;
const MIN_Z = 32;
const HEIGHT_MIN = -40.25;
const HEIGHT_MAX = 180.5;

const data = Uint16Array.from({ length: COLUMNS * ROWS }, (_, i) => (i * 977 + 31) % 65_536);
const terrain = {
  columns: COLUMNS,
  heightMax: HEIGHT_MAX,
  heightMin: HEIGHT_MIN,
  heightmap: "terrain/heightmap.u16",
  rows: ROWS,
  spacing: SPACING,
};
const extent = {
  minX: MIN_X,
  minZ: MIN_Z,
  sizeX: (COLUMNS - 1) * SPACING,
  sizeZ: (ROWS - 1) * SPACING,
};
const sampleHeight = heightSamplerFromHeightmap(terrain, extent, data);

const maxX = MIN_X + (COLUMNS - 1) * SPACING;
const maxZ = MIN_Z + (ROWS - 1) * SPACING;
const midX = (MIN_X + maxX) / 2;
const midZ = (MIN_Z + maxZ) / 2;
const points: [number, number][] = [
  [MIN_X, MIN_Z],
  [maxX, maxZ],
  [MIN_X, maxZ],
  [maxX, MIN_Z],
  [MIN_X, midZ],
  [maxX, midZ],
  [midX, MIN_Z],
  [midX, maxZ],
  [MIN_X - 1000, MIN_Z - 1000],
  [maxX + 1000, maxZ + 1000],
  // The sampler has no guard: NaN reads as NaN, the infinities clamp to the edges.
  [Number.NaN, midZ],
  [midX, Number.NaN],
  [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
];
let seed = 0x51a7c3e1;
const random = () => {
  seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
  return seed / 2 ** 32;
};
while (points.length < 200)
  points.push([MIN_X + random() * (maxX - MIN_X), MIN_Z + random() * (maxZ - MIN_Z)]);
const expected = points.map(([x, z]) => sampleHeight(x, z));

/* ---- heightfield: a deterministic field and a sequence of updates ---- */
const FIELD_COLUMNS = 7;
const FIELD_ROWS = 5;
const FIELD_WIDTH = 12;
const FIELD_DEPTH = 8;
const FIELD_ORIGIN_X = -3;
const FIELD_ORIGIN_Z = 2;
const initial = Float32Array.from({ length: FIELD_ROWS * FIELD_COLUMNS }, (_, i) =>
  Math.fround(Math.cos(i * 0.6) * 4 + (i % 5) * 0.4 + 1),
);

const steps: { region: IHeightfieldRegion; threw: boolean; version: number; probes: bigint[] }[] =
  [];
const field = new Heightfield({
  columns: FIELD_COLUMNS,
  depth: FIELD_DEPTH,
  heights: initial,
  origin: { x: FIELD_ORIGIN_X, z: FIELD_ORIGIN_Z },
  rows: FIELD_ROWS,
  width: FIELD_WIDTH,
});

const probePoints: [number, number][] = [
  [-9, -2],
  [3, 6],
  [-9, 6],
  [3, -2],
  [0, 2],
  [-3, 2],
  [-7.5, 0],
  [-4.5, 4],
  [1.5, -1],
  [2.5, 5],
  [-6, 3],
  [-2, 1],
  [0.5, 4.5],
  [-8, 5.5],
  [-5, -1.5],
  [-1, 3.5],
  [2, -0.5],
  [-3.5, 2.5],
  [1, 1],
  [-6.5, 0.5],
];

function record(region: IHeightfieldRegion): void {
  let threw = false;
  try {
    field.updateHeights(region);
  } catch {
    threw = true;
  }
  steps.push({
    region,
    threw,
    version: field.version,
    probes: probePoints.map(([x, z]) => f64(field.heightAt(x, z))),
  });
}

record({
  column: 0,
  columns: 2,
  heights: new Float32Array([12.5, -3.25, 7.125, 0.5]),
  row: 0,
  rows: 2,
});
record({
  column: 0,
  columns: FIELD_COLUMNS,
  heights: Float32Array.from({ length: FIELD_COLUMNS * FIELD_ROWS }, (_, i) =>
    Math.fround(Math.sin(i * 0.9) * 10 + (i % FIELD_COLUMNS) * 0.5 - 2),
  ),
  row: 0,
  rows: FIELD_ROWS,
});
record({ column: 5, columns: 3, heights: new Float32Array([1, 2, 3]), row: 0, rows: 1 });
record({ column: 1, columns: 2, heights: new Float32Array([1, 2, 3]), row: 1, rows: 2 });
record({ column: 2, columns: 1, heights: new Float32Array([Number.NaN]), row: 0, rows: 1 });
record({
  column: 3,
  columns: 3,
  heights: Float32Array.from({ length: 9 }, (_, i) => Math.fround(3 + i * 0.25)),
  row: 2,
  rows: 3,
});

const lines = [
  "// Generated by packages/runtime-native/tests/native-engine/world/heights-reference.ts from",
  "// packages/core/src/world-heightmap.ts and packages/core/src/world.ts. Do not edit: rerun the",
  "// generator. Floats are binary64 bit patterns; counts are decimal integers.",
  "",
  `static const uint32_t kHeightSamplerColumns = ${COLUMNS}u;`,
  `static const uint32_t kHeightSamplerRows = ${ROWS}u;`,
  `static const uint64_t kHeightSamplerSpacing = ${bits(SPACING)};`,
  `static const uint64_t kHeightSamplerHeightMin = ${bits(HEIGHT_MIN)};`,
  `static const uint64_t kHeightSamplerHeightMax = ${bits(HEIGHT_MAX)};`,
  `static const uint64_t kHeightSamplerMinX = ${bits(MIN_X)};`,
  `static const uint64_t kHeightSamplerMinZ = ${bits(MIN_Z)};`,
  `static const uint32_t kHeightSamplerSamples = ${points.length}u;`,
  `static const uint64_t kHeightSamplerData[] = {${u64array(Array.from(data))}};`,
  `static const uint64_t kHeightSamplerPoints[] = {${points.map(([x, z]) => `${bits(x)}, ${bits(z)}`).join(", ")}};`,
  `static const uint64_t kHeightSamplerExpected[] = {${expected.map(bits).join(", ")}};`,
  "",
  `static const uint32_t kHeightFieldColumns = ${FIELD_COLUMNS}u;`,
  `static const uint32_t kHeightFieldRows = ${FIELD_ROWS}u;`,
  `static const uint64_t kHeightFieldWidth = ${bits(FIELD_WIDTH)};`,
  `static const uint64_t kHeightFieldDepth = ${bits(FIELD_DEPTH)};`,
  `static const uint64_t kHeightFieldOriginX = ${bits(FIELD_ORIGIN_X)};`,
  `static const uint64_t kHeightFieldOriginZ = ${bits(FIELD_ORIGIN_Z)};`,
  `static const uint32_t kHeightFieldInitialCount = ${initial.length}u;`,
  `static const uint32_t kHeightFieldProbeCount = ${probePoints.length}u;`,
  `static const uint64_t kHeightFieldInitial[] = {${Array.from(initial, (v) => bits(v)).join(", ")}};`,
  `static const uint64_t kHeightFieldPoints[] = {${probePoints.map(([x, z]) => `${bits(x)}, ${bits(z)}`).join(", ")}};`,
];
for (const [i, step] of steps.entries()) {
  const region = Array.from(step.region.heights);
  lines.push(
    `static const uint64_t kHeightFieldRegion${i}[] = {${region.map((v) => bits(v)).join(", ")}};`,
    `static const uint64_t kHeightFieldProbes${i}[] = {${step.probes.map(hex64).join(", ")}};`,
  );
}
lines.push("static const HeightFieldStep kHeightFieldSteps[] = {");
for (const [i, step] of steps.entries())
  lines.push(
    `    {${step.region.column}u, ${step.region.columns}u, ${step.region.row}u, ${step.region.rows}u, kHeightFieldRegion${i}, std::size(kHeightFieldRegion${i}), ${step.threw}, ${step.version}ull, kHeightFieldProbes${i}},`,
  );
lines.push("};", "");

const text = lines.join("\n");
if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== text) {
    console.error("TN_FIXTURE_STALE: heights_reference.inc is not what the core modules produce");
    process.exit(1);
  }
  console.log("current: heights_reference.inc");
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT}`);
}
