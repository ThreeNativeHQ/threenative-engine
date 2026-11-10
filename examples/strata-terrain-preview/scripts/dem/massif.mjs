// Cut whole mountains, foot to foot, from the USGS 3DEP dynamic elevation service (public domain,
// 1 m lidar at every site below) into the int16 tiles `placeMassif` stands behind a world.
// Usage: node scripts/dem/massif.mjs [name ...]   (network; rewrites massif-<name>.bin/.json)
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { fromArrayBuffer } from "geotiff";
import proj4 from "proj4";

const SERVICE =
  "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage";
const SPACING = 4;
/** Each centre is chosen so the tile holds the whole mountain: its edge is valley floor or a col. */
const sites = {
  longs: {
    site: "Longs Peak and Mount Meeker from Chasm Lake to Glacier Gorge, Colorado",
    zone: 13,
    center: [448114, 4456231],
    size: 4400,
  },
  teton: {
    site: "Grand Teton and the Cathedral Group above Jackson Hole, Wyoming",
    zone: 12,
    center: [515911, 4843626],
    size: 3600,
  },
  maroon: {
    site: "Maroon Bells above Maroon and Crater Lakes, Colorado",
    zone: 13,
    center: [327934, 4326516],
    size: 3600,
  },
};

async function fetchWithRetry(url) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url);
    if (response.ok) return response;
    if (attempt >= 8) throw new Error(`TN_MASSIF_FETCH ${response.status} ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 3000 * (attempt + 1)));
  }
}

/** Fine 2 m pixels in `count` x `count` from the north-west corner `[west, north]`, in chunks. */
async function fine2m(zone, west, north, count) {
  const crs = 26900 + zone;
  const out = new Float64Array(count * count);
  const chunk = 1024;
  for (let row = 0; row < count; row += chunk)
    for (let column = 0; column < count; column += chunk) {
      const w = Math.min(chunk, count - column);
      const h = Math.min(chunk, count - row);
      const bbox = [
        west + column * 2,
        north - (row + h) * 2,
        west + (column + w) * 2,
        north - row * 2,
      ];
      const url = `${SERVICE}?bbox=${bbox.join(",")}&bboxSR=${crs}&imageSR=${crs}&size=${w},${h}&format=tiff&pixelType=F32&interpolation=RSP_BilinearInterpolation&noData=-9999&f=image`;
      const tiff = await fromArrayBuffer(await (await fetchWithRetry(url)).arrayBuffer());
      const image = await tiff.getImage();
      assert.equal(image.getWidth(), w);
      assert.equal(image.getHeight(), h);
      const [raster] = await image.readRasters();
      for (let z = 0; z < h; z++)
        for (let x = 0; x < w; x++) {
          const value = raster[z * w + x];
          assert(Number.isFinite(value) && value > -1000, `missing 3DEP sample at ${x},${z}`);
          out[(row + z) * count + column + x] = value;
        }
    }
  return out;
}

async function lidarTiles(bboxWGS84) {
  const url = new URL("https://tnmaccess.nationalmap.gov/api/v1/products");
  url.searchParams.set("datasets", "Digital Elevation Model (DEM) 1 meter");
  url.searchParams.set("bbox", bboxWGS84.map((v) => v.toFixed(5)).join(","));
  const { items } = await (await fetchWithRetry(url)).json();
  assert(items.length > 0, "every massif site must have 1 m lidar");
  return items.map((item) => item.title).sort();
}

for (const [name, site] of Object.entries(sites)) {
  if (process.argv.length > 2 && !process.argv.slice(2).includes(name)) continue;
  const resolution = site.size / SPACING + 1;
  const [east, north] = site.center;
  const half = site.size / 2;
  // Vertex j sits at east - half + 4j. The 2 m pixels either side of it start 2 m west of the first
  // vertex, so each vertex is the mean of a 2 x 2 block of 2 m pixels: a 4 m area filter, not a
  // point decimation that aliases ledges.
  const count = 2 * resolution;
  const fine = await fine2m(site.zone, east - half - 2, north + half + 2, count);
  const heights = new Float64Array(resolution * resolution);
  let min = Number.POSITIVE_INFINITY;
  for (let z = 0; z < resolution; z++)
    for (let x = 0; x < resolution; x++) {
      const at = (dz, dx) => fine[(2 * z + dz) * count + 2 * x + dx];
      const h = (at(0, 0) + at(0, 1) + at(1, 0) + at(1, 1)) / 4;
      heights[z * resolution + x] = h;
      min = Math.min(min, h);
    }
  const elevationOffset = Math.floor(min);
  const bytes = Buffer.alloc(resolution * resolution * 2);
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < heights.length; i++) {
    const quantized = Math.round((heights[i] - elevationOffset) * 10);
    assert(quantized >= 0 && quantized <= 32767, "decimetre tile exceeds int16 range");
    bytes.writeInt16LE(quantized, i * 2);
    max = Math.max(max, quantized / 10);
  }
  const crs = `+proj=utm +zone=${site.zone} +datum=NAD83 +units=m`;
  const bbox = [east - half, north - half, east + half, north + half];
  const corners = [
    [bbox[0], bbox[1]],
    [bbox[2], bbox[1]],
    [bbox[0], bbox[3]],
    [bbox[2], bbox[3]],
  ].map((point) => proj4(crs, "EPSG:4326", point));
  const bboxWGS84 = [
    Math.min(...corners.map((p) => p[0])),
    Math.min(...corners.map((p) => p[1])),
    Math.max(...corners.map((p) => p[0])),
    Math.max(...corners.map((p) => p[1])),
  ];
  const metadata = {
    site: site.site,
    size: site.size,
    resolution,
    spacing: SPACING,
    encoding: "int16-le-decimetres-relative-to-elevationOffset",
    rowOrder: "north-to-south (world +Z south), west-to-east (+X east)",
    crs: `EPSG:${26900 + site.zone}`,
    verticalCRS: "NAVD88 metres",
    center: site.center,
    bbox,
    bboxWGS84,
    elevationOffset,
    relativeElevationRange: [0, max],
    lidarTiles: await lidarTiles(bboxWGS84),
    downloadURL: SERVICE,
    accessed: new Date().toISOString().slice(0, 10),
    filter:
      "3DEP dynamic service resampled bilinearly to 2 m pixels, then a 2x2 box at each 4 m vertex; rounded to 0.1 m; no vertical exaggeration",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    citation:
      "U.S. Geological Survey, 3D Elevation Program (3DEP) dynamic elevation service, 1 meter lidar DEMs. Cropped, filtered, translated vertically and quantized by this example; not endorsed by USGS.",
    license: "U.S. Government public domain",
    licenseURL: "https://www.usgs.gov/3d-elevation-program",
  };
  await writeFile(new URL(`massif-${name}.bin`, import.meta.url), bytes);
  await writeFile(
    new URL(`massif-${name}.json`, import.meta.url),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  console.log(`${name}: ${resolution}^2 at ${SPACING} m, relief ${max} m, ${metadata.sha256}`);
}
