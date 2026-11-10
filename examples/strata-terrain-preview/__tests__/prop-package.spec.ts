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
 * keeps its species, its spot to a millimetre and its bucket.
 */
import { readFileSync } from "node:fs";
import { Heightfield } from "@threenative/core/world";
import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { streamProps } from "../src/render/propWorld.js";
import { type PropGroundQuery, buildPropVariants, flatPropMaterials } from "../src/render/props.js";
import type { IBakedWorld } from "../src/render/terrain.js";
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
    placements: 431958,
    buckets: {
      "horizon:true": 5649,
      "local:false": 420762,
      "local:true": 5547,
    },
    species: {
      boulder: { count: 115, x: 856.58, y: 2192.15, z: 7957.531 },
      bush: { count: 4261, x: 25698.9, y: 63617.3, z: 60067.611 },
      deadfall: { count: 846, x: 25821.36, y: 13428.405, z: 8774.001 },
      fern: { count: 30055, x: 551062.574, y: 484463.21, z: 1595374.939 },
      grass: { count: 259588, x: 6131295.664, y: 3428950.856, z: -5809487.928 },
      litter: { count: 37602, x: 991258.286, y: 585849.163, z: 700350.279 },
      mountain: { count: 7, x: -486.17, y: 159.127, z: 1109.642 },
      pebble: { count: 1638, x: -174227.954, y: 18847.816, z: -221424.512 },
      poppy: { count: 4082, x: 219622.254, y: 39420.941, z: -304859.172 },
      riverrock: { count: 318, x: -34376.854, y: 4042.729, z: -45401.142 },
      sapling: { count: 9528, x: 119493.05, y: 140754.167, z: 26790.6 },
      scrub: { count: 78269, x: 1823716.128, y: 1034398.312, z: -1749543.624 },
      spruce: { count: 5649, x: 85870.645, y: 84460.393, z: 18144.631 },
    },
  },
  coastal: {
    placements: 144192,
    buckets: {
      "horizon:true": 3200,
      "local:false": 139287,
      "local:true": 1705,
    },
    species: {
      boulder: { count: 235, x: -11647.513, y: 6294.29, z: -3213.757 },
      bush: { count: 1225, x: -95186.366, y: 38893.044, z: -17966.056 },
      fern: { count: 7466, x: -562782.305, y: 231811.614, z: -96325.087 },
      grass: { count: 95231, x: -1710645.477, y: 2213909.404, z: -748631.887 },
      litter: { count: 2097, x: -102353.588, y: 55735.077, z: -50139.13 },
      mountain: { count: 75, x: 2787.134, y: 976.3, z: -3652.819 },
      poppy: { count: 440, x: -12308.425, y: 9836.909, z: -2287.661 },
      riverrock: { count: 170, x: 21397.476, y: 764.38, z: -2941.734 },
      sapling: { count: 5536, x: -400937.724, y: 176810.448, z: -75675.525 },
      scrub: { count: 28517, x: -530936.478, y: 663622.667, z: -210143.761 },
      spruce: { count: 3200, x: -230403.81, y: 99952.996, z: -47077.414 },
    },
  },
  alpine: {
    placements: 3598,
    buckets: {
      "local:true": 3598,
    },
    species: {
      boulder: { count: 1082, x: 15469.86, y: 341380.178, z: -21751.522 },
      mountain: { count: 231, x: -2046.926, y: 87350.94, z: 1355.524 },
      scree: { count: 2285, x: 84389.842, y: 606905.11, z: -51301.608 },
    },
  },
  desert: {
    placements: 3554,
    buckets: {
      "local:false": 2899,
      "local:true": 655,
    },
    species: {
      boulder: { count: 248, x: 3711.365, y: 11876.037, z: 4825.502 },
      grass: { count: 2506, x: 134447.302, y: 56642.803, z: 53726.062 },
      reveal: { count: 170, x: 2834.529, y: 7991.44, z: 4860.708 },
      scrub: { count: 393, x: 25501.005, y: 8728.323, z: 11765.392 },
      volcanic: { count: 237, x: 3181.89, y: 12147.806, z: 6603.861 },
    },
  },
  tundra: {
    placements: 40459,
    buckets: {
      "local:false": 37225,
      "local:true": 3234,
    },
    species: {
      boulder: { count: 2028, x: -27083.489, y: 69635.938, z: 9805.011 },
      bush: { count: 594, x: 26772.235, y: 19253.181, z: 24156.513 },
      grass: { count: 30490, x: 1494682.385, y: 999384.219, z: 1625718.106 },
      riverrock: { count: 612, x: 1478.68, y: 17797.25, z: 17228.411 },
      sapling: { count: 55, x: 142.766, y: 1706.777, z: 1107.647 },
      scrub: { count: 6680, x: 337177.558, y: 218660.357, z: 364619.267 },
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
