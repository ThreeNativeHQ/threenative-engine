// Numbers the shape of the authored landform. A road is a bench cut into a hillside, not a
// causeway pinned to absolute heights. This prints the road-vs-ground step, its grade, the
// shoulder cross-slope, the building pad's step and the river bank slope, each read on its own
// operation's output. Run from the example root:
//   node scripts/measure-embankment.mjs
import { Terrain, sampleHeight, splinePoints } from "@threenative/terrain";
import { forest } from "./bake.mjs";

const layers = forest.layers;
const layer = (id) => layers.find((entry) => entry.id === id);
const final = forest.evaluate();
// The ground an operation paints onto: every layer before it.
const under = (id) =>
  Terrain.fromJSON({
    ...forest.toJSON(),
    layers: layers.slice(
      0,
      layers.findIndex((entry) => entry.id === id),
    ),
  }).evaluate();
const n = final.resolution;
const cell = final.size / (n - 1);
const world = (index) => (index / (n - 1)) * final.size - final.size / 2;

/** The dense centreline the evaluator paints, from the same spline sampler. */
function centreline(entry) {
  const p = entry.params;
  const source = (entry.type === "ramp" ? [p.from, p.to] : p.points).map(([x, y, z]) => [
    x,
    Number.isFinite(y) ? y : 0,
    z,
  ]);
  return splinePoints(
    source,
    Math.max(1, (p.width ?? 12) * 0.22),
    entry.type !== "ramp" && p.smooth !== false,
  );
}

/** Steepest cross-slope a corridor presents to a traveller, walked perpendicular to its centreline. */
function crossSlope(state, entry, to, compare) {
  const line = centreline(entry);
  const step = cell / 2;
  let steepest = 0;
  for (let k = 0; k < line.length; k += 2) {
    const next = line[Math.min(line.length - 1, k + 1)];
    const previous = line[Math.max(0, k - 1)];
    const dx = next[0] - previous[0];
    const dz = next[2] - previous[2];
    const length = Math.hypot(dx, dz) || 1;
    for (const side of [1, -1]) {
      let [x, z] = [line[k][0], line[k][2]];
      let y = sampleHeight(state, x, z);
      let was = compare ? sampleHeight(compare, x, z) : 0;
      for (let d = step; d <= to; d += step) {
        const nx = x + (-dz / length) * side * step;
        const nz = z + (dx / length) * side * step;
        const rise = Math.abs(sampleHeight(state, nx, nz) - y) / step;
        // With `compare`, only the steepness the operation adds over the ground it paints onto.
        steepest = Math.max(
          steepest,
          compare ? rise - Math.abs(sampleHeight(compare, nx, nz) - was) / step : rise,
        );
        x = nx;
        z = nz;
        y = sampleHeight(state, x, z);
        if (compare) was = sampleHeight(compare, x, z);
      }
    }
  }
  return (Math.atan(steepest) * 180) / Math.PI;
}

const road = layer("access-road");
const pad = layer("building-pad");
const river = layer("river");
// Each operation is measured on its own output: the river is applied last and severs the road,
// so a grade read on `final` would price a cliff the road operation never authored.
const underRoad = under("access-road");
const afterRoad = under("building-pad");
const afterPad = under("river");
const line = centreline(road);
const roadHalf = road.params.width / 2;

// Road top against the untouched ground 6 m to either side, and against the ground beneath it.
let step = 0;
let cut = 0;
let fill = 0;
let grade = 0;
for (let k = 0; k < line.length; k += 1) {
  const [x, , z] = line[k];
  const next = line[Math.min(line.length - 1, k + 1)];
  const previous = line[Math.max(0, k - 1)];
  const dx = next[0] - previous[0];
  const dz = next[2] - previous[2];
  const length = Math.hypot(dx, dz) || 1;
  const nx = -dz / length;
  const nz = dx / length;
  const top = sampleHeight(afterRoad, x, z);
  const under = top - sampleHeight(underRoad, x, z);
  cut = Math.max(cut, under);
  fill = Math.max(fill, -under);
  for (const side of [6, -6]) {
    step = Math.max(step, Math.abs(top - sampleHeight(underRoad, x + nx * side, z + nz * side)));
  }
  if (k > 0) {
    const [px, , pz] = line[k - 1];
    const run = Math.hypot(x - px, z - pz);
    if (run > 0.5)
      grade = Math.max(
        grade,
        Math.abs(sampleHeight(afterRoad, x, z) - sampleHeight(afterRoad, px, pz)) / run,
      );
  }
}

const padRadius = pad.params.radius ?? 30;
let padStep = 0;
for (let z = 0; z < n; z += 1)
  for (let x = 0; x < n; x += 1) {
    const i = z * n + x;
    if (Math.hypot(world(x) - pad.params.at[0], world(z) - pad.params.at[1]) > padRadius) continue;
    padStep = Math.max(padStep, Math.abs(afterPad.height[i] - afterRoad.height[i]));
  }

const riverHalf = river.params.width / 2;
const riverBank =
  riverHalf + (river.params.shoulder ?? riverHalf) + 1.5 * (river.params.depth ?? 4);
const roadBank = roadHalf + (road.params.shoulder ?? roadHalf) + 1.5 * Math.max(cut, fill);
const rows = [
  ["road step vs ground ±6 m", `${step.toFixed(2)} m`, "≤ 2.5 m"],
  ["road cut under the top", `${cut.toFixed(2)} m`, "≤ 2.5 m"],
  ["road fill under the top", `${fill.toFixed(2)} m`, "≤ 1.5 m"],
  ["road grade", `${(grade * 100).toFixed(1)} %`, "≤ 12 %"],
  ["road shoulder cross-slope", `${crossSlope(afterRoad, road, roadBank).toFixed(1)}°`, "≤ 35°"],
  ["building pad step vs ground", `${padStep.toFixed(2)} m`, "graded, no wall"],
  ["river bank cross-slope", `${crossSlope(final, river, riverBank).toFixed(1)}°`, "soft V"],
  [
    "river bank steepness it adds",
    `${crossSlope(final, river, riverBank, afterPad).toFixed(1)}°`,
    "the channel, not the hillside",
  ],
];
console.log("| measure | value | bound |");
console.log("| --- | --- | --- |");
for (const [name, value, bound] of rows) console.log(`| ${name} | ${value} | ${bound} |`);
