// Cooks a starter kit's real ground from Mapterhorn tiles (`surveyHeights`, the request cook's own
// survey): the 512 m playable square into `starter/<kit>/heightmap.r16` and its recipe row, and the
// 5 km far ring into `starter-assets/survey/<kit>-horizon.{bin,json}`, both on one datum so the
// ring stands on the square's edge. Run from packages/terrain:
//   npx tsx scripts/cook-kit-survey.ts <kit> <lat> <lon> "<site name>" "<attribution>"
// Probe candidate sites first (writes nothing): relief, walkable share and tile zoom per site:
//   npx tsx scripts/cook-kit-survey.ts --probe '[["name", lat, lon], ...]'
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { surveyHeights } from "../src/ground/survey.js";

if (process.argv[2] === "--probe") {
  const sites = JSON.parse(process.argv[3] ?? "[]") as [string, number, number][];
  if (sites.length === 0)
    throw new Error(`Usage: cook-kit-survey.ts --probe '[["name", lat, lon]]'`);
  for (const [name, lat, lon] of sites) {
    const n = 129;
    const cell = 512 / (n - 1);
    const square = await surveyHeights({ name, lat, lon, extentMeters: 512, attribution: "" }, n);
    const ring = await surveyHeights({ name, lat, lon, extentMeters: 5000, attribution: "" }, n);
    const v = square.values;
    let walkable = 0;
    for (let y = 1; y < n - 1; y++)
      for (let x = 1; x < n - 1; x++) {
        const dx = ((v[y * n + x + 1] ?? 0) - (v[y * n + x - 1] ?? 0)) / (2 * cell);
        const dz = ((v[(y + 1) * n + x] ?? 0) - (v[(y - 1) * n + x] ?? 0)) / (2 * cell);
        if (Math.atan(Math.hypot(dx, dz)) < (25 * Math.PI) / 180) walkable++;
      }
    console.log(
      `${name}: square ${square.min.toFixed(0)}..${square.max.toFixed(0)} m, walkable(<25°) ${((100 * walkable) / (n - 2) ** 2).toFixed(0)}%, ring ${ring.min.toFixed(0)}..${ring.max.toFixed(0)} m, zoom ${square.zoom}/${ring.zoom}`,
    );
  }
  process.exit(0);
}
const [kit, latText, lonText, site, attribution] = process.argv.slice(2);
if (!kit || !latText || !lonText || !site || !attribution)
  throw new Error('Usage: cook-kit-survey.ts <kit> <lat> <lon> "<site>" "<attribution>"');
const lat = Number(latText);
const lon = Number(lonText);
if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new TypeError("lat/lon must be numbers");
const root = join(import.meta.dirname, "..");

const square = await surveyHeights({ name: site, lat, lon, extentMeters: 512, attribution }, 257);
const ring = await surveyHeights({ name: site, lat, lon, extentMeters: 5000, attribution }, 513);
// The square's lowest point stands 1 m above the datum, as the USGS kits' squares do.
const datum = Math.floor(square.min) - 1;
const min = Math.round((square.min - datum) * 10) / 10;

const r16 = Buffer.alloc(square.values.length * 2);
square.values.forEach((value, i) => {
  const raw = Math.round((value - datum - min) * 10);
  if (raw < 0 || raw > 65535) throw new RangeError(`square sample ${value} m leaves the r16 range`);
  r16.writeUInt16LE(raw, i * 2);
});
await writeFile(join(root, "starter", kit, "heightmap.r16"), r16);

const ringBytes = Buffer.alloc(ring.values.length * 2);
ring.values.forEach((value, i) => {
  const dm = Math.round((value - datum) * 10);
  if (dm < -32768 || dm > 32767) throw new RangeError(`ring sample ${value} m leaves int16 dm`);
  ringBytes.writeInt16LE(dm, i * 2);
});
const meta = {
  site,
  size: 5000,
  resolution: 513,
  spacing: 5000 / 512,
  encoding: "int16-le-decimetres-relative-to-elevationOffset",
  rowOrder: "north-to-south (world +Z south), west-to-east (+X east)",
  center: [lat, lon],
  elevationOffset: datum,
  relativeElevationRange: [
    Math.round((ring.min - datum) * 10) / 10,
    Math.round((ring.max - datum) * 10) / 10,
  ],
  tileZoom: ring.zoom,
  metersPerPixel: Math.round(ring.metersPerPixel * 1000) / 1000,
  squareTileZoom: square.zoom,
  citation: attribution,
  license: "Open data; each source's licence is listed at https://mapterhorn.com/attribution.",
  licenseURL: "https://mapterhorn.com/attribution",
  sha256: createHash("sha256").update(ringBytes).digest("hex"),
};
const survey = join(root, "starter-assets", "survey", `${kit}-horizon`);
await writeFile(`${survey}.bin`, ringBytes);
await writeFile(`${survey}.json`, `${JSON.stringify(meta, null, 2)}\n`);

const recipePath = join(root, "starter", kit, "recipe.json");
const recipe = JSON.parse(await readFile(recipePath, "utf8"));
const layer = recipe.recipe.layers.find((one: { type: string }) => one.type === "heightmap");
layer.params.data = { ...layer.params.data, min, max: Math.round((min + 6553.5) * 10) / 10 };
if (recipe.world?.farRing) recipe.world.farRing.datum = datum;
await writeFile(recipePath, `${JSON.stringify(recipe, null, 2)}\n`);
// The repository's formatter owns JSON layout; the survey's sha256 covers the .bin, not the .json.
execFileSync("npx", ["biome", "format", "--write", `${survey}.json`, recipePath], {
  stdio: "ignore",
});
console.log(
  `${kit}: square ${square.min.toFixed(1)}..${square.max.toFixed(1)} m (zoom ${square.zoom}), ring ${ring.min.toFixed(1)}..${ring.max.toFixed(1)} m (zoom ${ring.zoom}), datum ${datum} m`,
);
