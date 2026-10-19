// Display-referred Rec.709 luminance, matching the reference-calibration procedure (no sRGB decode).
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { inspectCapture } from "../../../packages/runtime-native/conformance/metrics.mjs";

const [target, baseline] = process.argv.slice(2);
assert(target, "Pass a PNG or capture directory, optionally followed by its matching baseline");
const names = [
  "forest-start",
  "meadow-close",
  "overview",
  "river",
  "forest-walk",
  "coastal-ocean-early",
  "coastal-ocean",
  "coastal-horizon-sea",
  "coastal-sun-alt",
  "alpine-ridge",
  "alpine-overview",
  "desert-mesa",
  "desert-overview",
  "tundra-plain",
  "tundra-overview",
];
function measure(path) {
  const { png, width, height } = inspectCapture(readFileSync(path));
  const luminance = new Float64Array(width * height);
  let sum = 0;
  let squares = 0;
  let saturation = 0;
  for (let i = 0; i < luminance.length; i++) {
    const r = png.data[i * 4] / 255;
    const g = png.data[i * 4 + 1] / 255;
    const b = png.data[i * 4 + 2] / 255;
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    luminance[i] = y;
    sum += y;
    squares += y * y;
    const max = Math.max(r, g, b);
    saturation += max === 0 ? 0 : (max - Math.min(r, g, b)) / max;
  }
  luminance.sort();
  const mean = sum / luminance.length;
  const round = (value) => Math.round(value * 10000) / 10000;
  return {
    width,
    height,
    mean: round(mean),
    quantiles: [0.05, 0.25, 0.5, 0.75, 0.95].map(
      (q) => luminance[Math.floor(q * (luminance.length - 1))],
    ),
    saturation: round(saturation / luminance.length),
    contrast: round(Math.sqrt(squares / luminance.length - mean * mean)),
  };
}
const directory = resolve(target);
const files = statSync(directory).isDirectory()
  ? names.map((name) => `${name}.png`)
  : [basename(directory)];
if (statSync(directory).isDirectory()) {
  const present = readdirSync(directory);
  assert(
    files.every((name) => present.includes(name)),
    "Every shared-scenario view must be captured",
  );
}
for (const name of files) {
  const after = measure(files.length === 1 ? directory : join(directory, name));
  const before = baseline ? measure(join(resolve(baseline), name)) : undefined;
  const delta = before
    ? Math.max(...after.quantiles.map((q, i) => Math.abs(q - before.quantiles[i])))
    : undefined;
  if (before) {
    assert(
      after.width === before.width && after.height === before.height,
      `${name}: viewport changed`,
    );
    assert(delta <= 0.5, `${name}: normalized luminance quantile delta ${delta} exceeds 0.5`);
  }
  console.log(JSON.stringify({ view: name, before, after, maxQuantileDelta: delta }));
}
