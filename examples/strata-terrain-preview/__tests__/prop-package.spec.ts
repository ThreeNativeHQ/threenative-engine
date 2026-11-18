/**
 * PRD-792 Phase 2, box "Example compiler and rules deleted": the numbers the game's own compile
 * put on screen, held to the baked package that replaced it.
 *
 * The harness is the game's own path as a fresh clone runs it: the prop package the bake wrote,
 * read through `loadPropPackage`, posed by `streamProps` on the ground the drawn terrain answers
 * (`Heightfield.surfaceAt` inside the square, with `heightAt` supplying the authored offset), with
 * the procedural prop variants `buildPropVariants()` builds when no licensed pack is installed.
 * It records, per world:
 *
 *   - the placement count per species,
 *   - the sum of the drawn positions (x, y, z, each rounded to a millimetre),
 *   - the placement count per streamed bucket.
 *
 * The table is byte for byte the one the deleted compile was held to: equal numbers mean every prop
 * keeps its species, its spot to a millimetre and its bucket. It was re-measured once, for
 * PRD-892's shared stack (alpine, desert and tundra) and the coast's shore stones (coastal); the
 * forest's numbers are the ones the deleted compile produced.
 */
import { readFileSync } from "node:fs";
import { Heightfield } from "@threenative/core/world";
import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import type { IBakedWorld } from "../src/render/ground/terrain.js";
import { streamProps } from "../src/render/props/propWorld.js";
import {
  type PropGroundQuery,
  buildPropVariants,
  flatPropMaterials,
} from "../src/render/props/props.js";
import { readBakedPropPackage } from "./bakedPropPackage.js";

const WORLDS = ["forest", "coastal", "alpine", "desert", "tundra"] as const;
type WorldName = (typeof WORLDS)[number];
/** The two worlds that share `baked.json`; the other three have their own module-sized file. */
const DRAWN = new Set<string>(["forest", "coastal"]);

/** One sum of drawn positions, rounded to the millimetre the record itself is authored at. */
const millimetres = (value: number): number => Math.round(value * 1000) / 1000;

interface ISpeciesPin {
  readonly count: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

interface IWorldPin {
  readonly placements: number;
  readonly species: Readonly<Record<string, ISpeciesPin>>;
  readonly buckets: Readonly<Record<string, number>>;
}

const read = (path: string): string =>
  readFileSync(new URL(`../src/world/${path}`, import.meta.url), "utf8");

function worldOf(world: WorldName): IBakedWorld {
  const baked = JSON.parse(read("baked.json")) as Record<string, IBakedWorld>;
  const data = DRAWN.has(world) ? baked[world] : (JSON.parse(read(`${world}.json`)) as IBakedWorld);
  if (!data) throw new Error(`${world}: no baked terrain`);
  return data;
}

/** The drawn ground the game answers, on the heightfield a fresh clone draws. */
function groundOn(field: Heightfield, size: number): PropGroundQuery {
  const half = size / 2;
  return (placement, [x, , z]) => ({
    height: Math.abs(x) <= half && Math.abs(z) <= half ? field.surfaceAt(x, z) : null,
    offset: placement.position[1] - field.heightAt(placement.position[0], placement.position[2]),
  });
}

/** Measure one world through the baked package: the numbers the deleted compile pinned. */
async function measure(world: WorldName): Promise<IWorldPin> {
  const data = worldOf(world);
  const pkg = await readBakedPropPackage(new URL("../src/world/", import.meta.url), world);
  const field = new Heightfield({
    columns: data.resolution,
    depth: data.size,
    heights: new Float32Array(data.heights),
    origin: { x: 0, z: 0 },
    rows: data.resolution,
    width: data.size,
  });
  const materials = flatPropMaterials();
  const streamed = await streamProps({
    package: pkg,
    follow: { position: new Vector3() },
    groundAt: groundOn(field, data.size),
    horizonDistance: 5000,
    materials,
    parts: buildPropVariants(),
    size: data.size,
    whileCurrent: () => true,
  });
  if (!streamed) throw new Error(`${world}: the load was cancelled`);
  try {
    const sums = new Map<string, ISpeciesPin>();
    const position = new Vector3();
    for (const instance of streamed.byId.values()) {
      const asset = instance.placement.asset;
      const row = sums.get(asset) ?? { count: 0, x: 0, y: 0, z: 0 };
      position.setFromMatrixPosition(instance.pose);
      sums.set(asset, {
        count: row.count + 1,
        x: row.x + position.x,
        y: row.y + position.y,
        z: row.z + position.z,
      });
    }
    const buckets = Object.fromEntries(
      pkg.buckets.map((bucket) => [bucket.bucket, bucket.ids.length]),
    );
    expect(streamed.worlds.map((entry) => entry.name).sort()).toEqual(
      Object.keys(buckets)
        .map((bucket) => `strata-props:${bucket}`)
        .sort(),
    );
    return {
      buckets: Object.fromEntries(Object.entries(buckets).sort(([a], [b]) => a.localeCompare(b))),
      placements: Object.values(buckets).reduce((sum, count) => sum + count, 0),
      species: Object.fromEntries(
        [...sums]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([asset, row]) => [
            asset,
            {
              count: row.count,
              x: millimetres(row.x),
              y: millimetres(row.y),
              z: millimetres(row.z),
            },
          ]),
      ),
    };
  } finally {
    streamed.dispose();
    materials.dispose();
  }
}

/** The picture of every world, measured on the compile this box deleted (`8d118a9bb`). */
const GOLDEN: Readonly<Record<WorldName, IWorldPin>> = {
  forest: {
    buckets: { "horizon:true": 5648, "local:false": 420758, "local:true": 5543 },
    placements: 431949,
    species: {
      boulder: { count: 112, x: 1516.067, y: 2139.572, z: 8450.214 },
      bush: { count: 4260, x: 25916.641, y: 63600.403, z: 60233.161 },
      deadfall: { count: 846, x: 25821.36, y: 13428.405, z: 8774.001 },
      fern: { count: 30055, x: 551062.574, y: 484463.21, z: 1595374.939 },
      grass: { count: 259588, x: 6131295.664, y: 3428950.856, z: -5809487.928 },
      litter: { count: 37602, x: 991258.286, y: 585849.163, z: 700350.279 },
      mountain: { count: 7, x: -486.17, y: 159.127, z: 1109.642 },
      pebble: { count: 1638, x: -174227.954, y: 18847.816, z: -221424.512 },
      poppy: { count: 4082, x: 219622.254, y: 39420.941, z: -304859.172 },
      riverrock: { count: 318, x: -34376.854, y: 4042.729, z: -45401.142 },
      sapling: { count: 9524, x: 120378.225, y: 140690.153, z: 27456.404 },
      scrub: { count: 78269, x: 1823716.128, y: 1034398.312, z: -1749543.624 },
      spruce: { count: 5648, x: 86094.012, y: 84444.896, z: 18309.547 },
    },
  },
  coastal: {
    buckets: { "horizon:true": 3200, "local:false": 218053, "local:true": 1761 },
    placements: 223014,
    species: {
      boulder: { count: 256, x: -12816.993, y: 6874.608, z: -3797.703 },
      bush: { count: 1298, x: -88142.013, y: 39173.522, z: -20844.604 },
      fern: { count: 7584, x: -520105.795, y: 226447.443, z: -122560.718 },
      grass: { count: 154549, x: 931292.232, y: 2768297.52, z: 3745775.44 },
      litter: { count: 2304, x: -84540.865, y: 56292.314, z: -60782.805 },
      mountain: { count: 60, x: 716.67, y: 829.065, z: -1178.71 },
      poppy: { count: 1856, x: 49591.745, y: 24377.571, z: 100783.89 },
      riverrock: { count: 147, x: 18084.761, y: 611.855, z: -985.658 },
      sapling: { count: 5549, x: -367919.529, y: 172142.434, z: -87177.815 },
      scrub: { count: 46211, x: 237944.791, y: 830869.3, z: 1124792.03 },
      spruce: { count: 3200, x: -210069.927, y: 96944.195, z: -56852.432 },
    },
  },
  alpine: {
    buckets: { "horizon:true": 382, "local:false": 74705, "local:true": 3740 },
    placements: 78827,
    species: {
      boulder: { count: 492, x: 9324.267, y: 154541.21, z: -1906.757 },
      bush: { count: 2422, x: 177005.787, y: 538021.459, z: -140017.853 },
      cliff: { count: 29, x: 1878.973, y: 9699.736, z: 691.18 },
      deadfall: { count: 231, x: 13573.829, y: 46326.913, z: -17482.054 },
      fern: { count: 5592, x: 515237.453, y: 945194.39, z: -443741.425 },
      grass: { count: 40492, x: 3342305.752, y: 7904776.413, z: -3373959.288 },
      litter: { count: 13348, x: 924409.766, y: 2636765.586, z: -969290.381 },
      mountain: { count: 566, x: -16645.671, y: 233472.34, z: 15572.709 },
      poppy: { count: 2348, x: 322773.74, y: 236425.156, z: -302503.379 },
      sapling: { count: 698, x: 129001.506, y: 15434.388, z: -125903.768 },
      scrub: { count: 12227, x: 1030331.966, y: 2348235.595, z: -1030006.876 },
      spruce: { count: 382, x: 70334.378, y: 8502.677, z: -68866.336 },
    },
  },
  desert: {
    buckets: { "local:false": 7629, "local:true": 662 },
    placements: 8291,
    species: {
      boulder: { count: 248, x: 4107.557, y: 12089.119, z: 4959.736 },
      bush: { count: 27, x: 2127.013, y: 639.87, z: 768.274 },
      grass: { count: 6559, x: 192863.725, y: 161593.7, z: 53050.165 },
      reveal: { count: 158, x: 1600.085, y: 8290.076, z: 2593.697 },
      sapling: { count: 161, x: -2151.688, y: 4055.906, z: 1162.725 },
      scrub: { count: 909, x: 31888.416, y: 22631.27, z: 741.856 },
      volcanic: { count: 229, x: 1643.452, y: 11916.493, z: 2744.983 },
    },
  },
  tundra: {
    buckets: { "local:false": 74715, "local:true": 3957 },
    placements: 78672,
    species: {
      boulder: { count: 2098, x: -24665.443, y: 72184.003, z: 20546.474 },
      bush: { count: 1247, x: 41489.406, y: 41126.256, z: 36452.228 },
      grass: { count: 61160, x: 1669795.256, y: 2037150.266, z: 2043429.591 },
      riverrock: { count: 612, x: 1418.608, y: 17794.069, z: 17302.698 },
      sapling: { count: 140, x: 2361.955, y: 4503.194, z: 4052.771 },
      scrub: { count: 13415, x: 372584.211, y: 447093.368, z: 484807.419 },
    },
  },
};

describe("the baked prop package", () => {
  it("puts every prop where the game's own compile put it: species, spot and bucket", async () => {
    const measured: Record<string, IWorldPin> = {};
    for (const world of WORLDS) measured[world] = await measure(world);
    expect(measured).toEqual(GOLDEN);
  }, 600_000);
});
