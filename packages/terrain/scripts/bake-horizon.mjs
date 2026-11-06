// Bake a distant-backdrop heightfield from a landform preset, in the shape of the strata
// `horizon.json` entries: { size, resolution, heights } with heights in metres above the lowest point, row-major.
// Usage: pnpm --filter @threenative/terrain build && node packages/terrain/scripts/bake-horizon.mjs \
//   <kind> [--seed 7] [--size 5000] [--resolution 513] [--relief <metres>] [--out horizon.json]
import { writeFileSync } from "node:fs";
import { LANDFORMS, landform } from "../dist/index.js";

const [kind, ...rest] = process.argv.slice(2);
if (!kind || !(kind in LANDFORMS)) {
  console.error(`Pass a landform kind: ${Object.keys(LANDFORMS).join(", ")}`);
  process.exit(1);
}
const flag = (name, fallback) => {
  const at = rest.indexOf(`--${name}`);
  return at < 0 ? fallback : rest[at + 1];
};
const options = {
  seed: Number(flag("seed", 7)),
  size: Number(flag("size", 5000)),
  resolution: Number(flag("resolution", 513)),
};
if (flag("relief")) options.relief = Number(flag("relief"));
const state = landform(kind, options).evaluate();
// Lowest point at 0 m: the game places the backdrop with its own elevation offset.
const low = state.height.reduce((a, b) => Math.min(a, b));
const heights = Array.from(state.height, (h) => Math.round((h - low) * 10) / 10);
const out = flag("out", `${kind}-horizon.json`);
writeFileSync(out, JSON.stringify({ size: state.size, resolution: state.resolution, heights }));
console.log(
  `${out}: ${kind} seed ${options.seed}, ${state.resolution}x${state.resolution} over ${state.size} m`,
);
