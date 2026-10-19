// Rebuild committed crops from the downloaded, public-domain USGS GeoTIFFs.
// Usage: node scripts/dem/crop.mjs /tmp/strata-dem
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fromFile } from "geotiff";
import proj4 from "proj4";

const input = process.argv[2];
assert(input, "Pass the directory containing the downloaded detail and surrounding GeoTIFFs");
const sites = {
  alpine: {
    site: "Longs Peak — Diamond / Chasm Lake headwall, Colorado",
    center: [447870, 4456250],
    zone: 13,
    elevationOffset: 3690,
    tile: "USGS_1M_13_x44y446_CO_DRCOG_2020_B20",
    project: "CO_DRCOG_2020_B20",
    file: "alpine.tif",
    acquisitionDate: {
      begin: "2020-05-26",
      end: "2021-03-13",
      basis: "USGS project metadata temporal extent",
    },
    horizonTile: "USGS_13_n41w106_20221118",
  },
  desert: {
    site: "Setting Hen Butte — Valley of the Gods, Utah",
    center: [605770, 4125630],
    zone: 12,
    elevationOffset: 1420,
    tile: "USGS_1M_12_x60y413_UT_WestEast_B22",
    project: "UT_WestEast_B22",
    file: "desert-2022.tif",
    acquisitionDate: {
      begin: "2022-06-04",
      end: "2023-10-04",
      basis: "USGS project metadata temporal extent",
    },
    horizonTile: "USGS_13_n38w110_20241031",
  },
  forest: {
    site: "Sprague Lake / Glacier Creek conifer valley, Rocky Mountain National Park, Colorado",
    center: [448720, 4463470],
    zone: 13,
    elevationOffset: 2635,
    tile: "USGS_1M_13_x44y447_CO_DRCOG_2020_B20",
    project: "CO_DRCOG_2020_B20",
    file: "forest.tif",
    acquisitionDate: {
      begin: "2020-05-26",
      end: "2021-03-13",
      basis: "USGS project metadata temporal extent",
    },
    horizonTile: "USGS_13_n41w106_20221118",
  },
  coastal: {
    site: "Sand Beach / Great Head granite cove, Acadia National Park, Maine",
    center: [565026, 4908894],
    zone: 19,
    elevationOffset: 0,
    tile: "USGS_1M_19_x56y491_ME_MidCoast_2021_B21",
    project: "ME_MidCoast_2021_B21",
    file: "coastal.tif",
    acquisitionDate: {
      begin: "2021-05-09",
      end: "2022-05-11",
      basis: "USGS project metadata temporal extent",
    },
    horizonTile: "USGS_13_n45w069_20260521",
  },
  tundra: {
    site: "Trail Ridge alpine tundra, Rocky Mountain National Park, Colorado",
    center: [432798, 4475400],
    zone: 13,
    elevationOffset: 3420,
    tile: "USGS_1M_13_x43y448_CO_NorthwestCO_2020_D20",
    project: "CO_NorthwestCO_2020_D20",
    file: "tundra.tif",
    acquisitionDate: {
      begin: "2020-06-20",
      end: "2021-08-28",
      basis: "USGS project metadata temporal extent",
    },
    horizonTile: "USGS_13_n41w106_20221118",
  },
};
for (const [world, site] of Object.entries(sites)) {
  if (process.argv.length > 3 && !process.argv.slice(3).includes(world)) continue;
  const crs = `+proj=utm +zone=${site.zone} +datum=NAD83 +units=m`;
  const productUrl = `https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/1m/Projects/${site.project}/TIFF/${site.tile}.tif`;
  const horizonUrl = `https://prd-tnm.s3.amazonaws.com/StagedProducts/Elevation/13/TIFF/historical/${site.horizonTile.split("_")[2]}/${site.horizonTile}.tif`;
  for (const horizon of [false, true]) {
    const size = horizon ? 5000 : 512;
    const resolution = horizon ? 513 : 257;
    const half = size / 2;
    const [east, north] = site.center;
    const bbox = [east - half, north - half, east + half, north + half];
    const tiff = await fromFile(`${input}/${horizon ? `${world}-horizon-current.tif` : site.file}`);
    try {
      const image = await tiff.getImage();
      const [ox, oy] = image.getOrigin();
      const [sx, sy] = image.getResolution();
      const sourceCRS = horizon ? "EPSG:4269" : `EPSG:${26900 + site.zone}`;
      if (horizon) assert.equal(image.getGeoKeys().GeographicTypeGeoKey, 4269);
      else {
        assert.equal(image.getGeoKeys().ProjectedCSTypeGeoKey, 26900 + site.zone);
        assert(Math.abs(sx - 1) < 1e-6 && Math.abs(sy + 1) < 1e-6, "The detail source must be 1 m");
      }
      const coords = (x, z) => {
        const point = [
          east + (x / (resolution - 1) - 0.5) * size,
          north - (z / (resolution - 1) - 0.5) * size,
        ];
        const [px, py] = horizon ? proj4(crs, "+proj=longlat +datum=NAD83", point) : point;
        return [(px - ox) / sx - 0.5, (py - oy) / sy - 0.5];
      };
      // Include the bilinear support, and refuse missing or out-of-tile observations.
      const corners = [
        [0, 0],
        [resolution - 1, 0],
        [0, resolution - 1],
        [resolution - 1, resolution - 1],
      ].map(([x, z]) => coords(x, z));
      const window = [
        Math.floor(Math.min(...corners.map((p) => p[0]))),
        Math.floor(Math.min(...corners.map((p) => p[1]))),
        Math.ceil(Math.max(...corners.map((p) => p[0]))) + 1,
        Math.ceil(Math.max(...corners.map((p) => p[1]))) + 1,
      ];
      assert(
        window[0] >= 0 &&
          window[1] >= 0 &&
          window[2] <= image.getWidth() &&
          window[3] <= image.getHeight(),
        "Crop must be contained in the selected tile",
      );
      const [raster] = await image.readRasters({ window });
      const width = window[2] - window[0];
      const nodata = image.getGDALNoData();
      const tap = (x, z) => {
        const h = raster[z * width + x];
        assert(
          Number.isFinite(h) && h !== nodata,
          `${world}: missing DEM observation at ${x},${z}`,
        );
        return h;
      };
      const bytes = Buffer.alloc(resolution ** 2 * 2);
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (let z = 0; z < resolution; z++)
        for (let x = 0; x < resolution; x++) {
          const [px, pz] = coords(x, z);
          const ix = Math.floor(px) - window[0];
          const iz = Math.floor(pz) - window[1];
          const a = tap(ix, iz);
          const b = tap(ix + 1, iz);
          const c = tap(ix, iz + 1);
          const d = tap(ix + 1, iz + 1);
          // At integer UTM vertices the four 1 m pixel centres straddle the vertex exactly:
          // their mean is a 2 m box/area filter, not nearest-neighbour point decimation.
          if (!horizon)
            assert(
              Math.abs(px - Math.floor(px) - 0.5) < 1e-3 &&
                Math.abs(pz - Math.floor(pz) - 0.5) < 1e-3,
              "Detail vertices must align with the 2×2 area filter",
            );
          const u = px - Math.floor(px);
          const v = pz - Math.floor(pz);
          const h = horizon
            ? (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v
            : (a + b + c + d) / 4;
          const quantized = Math.round((h - site.elevationOffset) * 10);
          assert(quantized >= -32768 && quantized <= 32767, "Decimetre crop exceeds int16 range");
          bytes.writeInt16LE(quantized, (z * resolution + x) * 2);
          min = Math.min(min, quantized / 10);
          max = Math.max(max, quantized / 10);
        }
      const name = `${world}${horizon ? "-horizon" : ""}`;
      const metadata = {
        site: site.site,
        size,
        resolution,
        spacing: size / (resolution - 1),
        encoding: "int16-le-decimetres-relative-to-elevationOffset",
        rowOrder: "north-to-south (world +Z south), west-to-east (+X east)",
        crs: `EPSG:${26900 + site.zone}`,
        verticalCRS: "NAVD88 metres",
        sourceCRS,
        center: site.center,
        bbox,
        bboxWGS84: (() => {
          const corners = [
            [bbox[0], bbox[1]],
            [bbox[2], bbox[1]],
            [bbox[0], bbox[3]],
            [bbox[2], bbox[3]],
          ].map((point) => proj4(crs, "EPSG:4326", point));
          return [
            Math.min(...corners.map((p) => p[0])),
            Math.min(...corners.map((p) => p[1])),
            Math.max(...corners.map((p) => p[0])),
            Math.max(...corners.map((p) => p[1])),
          ];
        })(),
        elevationOffset: site.elevationOffset,
        relativeElevationRange: [min, max],
        tileIds: [horizon ? site.horizonTile : site.tile],
        acquisitionDate: horizon ? null : site.acquisitionDate,
        acquisitionDateNote: horizon
          ? "Multi-source seamless DEM: no single acquisition date; publication date is the tile ID suffix."
          : "Project temporal extent, not a claim that every crop pixel was flown on one day.",
        downloadURL: horizon ? horizonUrl : productUrl,
        metadataURL: horizon
          ? null
          : productUrl.replace("/TIFF/", "/metadata/").replace(".tif", ".xml"),
        accessed: "2026-10-03",
        filter: horizon
          ? "NAD83 geographic to UTM; bilinear reconstruction at 9.765625 m"
          : "2×2 1 m area/box filter at each 2 m vertex; rounded to 0.1 m; no vertical exaggeration",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        citation:
          "U.S. Geological Survey, 3D Elevation Program (3DEP), The National Map, 1 meter and 1/3 arc-second Digital Elevation Models, accessed October 3, 2026. Cropped, filtered, translated vertically and quantized by this example; not endorsed by USGS.",
        license: "U.S. Government public domain",
        licenseURL:
          "https://data.usgs.gov/datacatalog/data/USGS:77ae0551-c61e-4979-aedd-d797abdcde0e",
      };
      await writeFile(new URL(`${name}.bin`, import.meta.url), bytes);
      await writeFile(
        new URL(`${name}.json`, import.meta.url),
        `${JSON.stringify(metadata, null, 2)}\n`,
      );
      assert.equal(
        (await readFile(new URL(`${name}.bin`, import.meta.url))).length,
        resolution ** 2 * 2,
      );
      console.log(`${name}: ${bytes.length} bytes, ${min}…${max} m relative, no nodata`);
    } finally {
      await tiff.close();
    }
  }
}
