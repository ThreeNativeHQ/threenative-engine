/**
 * PRD-794 AC-1: one water store, probe by probe.
 *
 * The river, the lake and the sea all answer through `WaterBodies` (`src/world/water.ts` builds it
 * from the bake), so this spec pins what the one mechanism answers at fixed probes: the surface
 * height, the current vector and the footprint. Every pin below was recorded against the three
 * hand-written paths this store replaced, so a moved number is a regression.
 *
 * Every number comes from the committed bake under `src/world/`:
 *
 * - A river stands at its spline's own height, and reaches `width * 2.5` m either side.
 * - A lake stands level out to `waterlineRadius(...) * 1.12`, capped at the radius its file names.
 * - The sea plane sits at `waterLevel`, and its stretched geometry reaches `SEA_EXTENT` either side.
 */
import { readFileSync } from "node:fs";
import { Heightfield, type IWaterOcean } from "@threenative/core/world";
import { describe, expect, it } from "vitest";
import type { IBakedWorld } from "../src/render/ground/terrain.js";
import { SEA_EXTENT, createOcean, createWaterMesh } from "../src/render/water/ocean.js";
import { waterBodies, waterCurrentAt, waterSurfaceAt } from "../src/world/water.js";

/** One fixed probe: where it stands, the surface a swimmer rests on and the flow that carries them. */
interface IWaterProbe {
  readonly at: readonly [number, number];
  /** `undefined` where nothing is drawn. */
  readonly surface: number | undefined;
  readonly current: { x: number; z: number } | undefined;
}

const load = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../src/world/${name}`, import.meta.url), "utf8"));

const baked = load("baked.json") as Record<string, IBakedWorld>;
const forest = baked.forest as IBakedWorld;
const coastal = baked.coastal as IBakedWorld;
const tundra = load("tundra.json") as IBakedWorld;

function field(world: IBakedWorld): Heightfield {
  const square = Math.sqrt(world.heights.length);
  if (square !== world.resolution)
    throw new Error("the bake's heights do not match its resolution");
  return new Heightfield({
    columns: world.resolution,
    depth: world.size,
    heights: Float32Array.from(world.heights),
    origin: { x: 0, z: 0 },
    rows: world.resolution,
    width: world.size,
  });
}

/** What the one water store answers at each probe, in the probe's own shape. */
function answers(
  world: IBakedWorld,
  probes: readonly IWaterProbe[],
  sea?: IWaterOcean,
): IWaterProbe[] {
  const bodies = waterBodies(world.rivers ?? [], world.lakes ?? [], field(world), sea);
  return probes.map((probe) => ({
    at: probe.at,
    current: bodies.currentAt(...probe.at),
    surface: bodies.surfaceAt(...probe.at),
  }));
}

/**
 * The forest river `river` (5.32 m wide, so 13.3 m of reach) and the lake it runs into (-70, 25;
 * level 13.3 m; cap 105 m). The probes on the station at (-110, -175) walk across the ribbon to
 * the metre the water stops at; the lake probes include the river's last station, where the higher
 * lake surface wins and the river stops carrying the swimmer.
 */
const FOREST_RIVER: readonly IWaterProbe[] = [
  {
    at: [-120, -220],
    current: { x: 0.2064408711935989, z: 0.8760035197993371 },
    surface: 13.730976740569075,
  },
  {
    at: [-110, -175],
    current: { x: 0.016071794375532095, z: 0.899856487127559 },
    surface: 11.626775327408664,
  },
  {
    at: [-100, -95],
    current: { x: 0.5272509284188672, z: 0.7293877284966087 },
    surface: 12.8125147026022,
  },
  {
    at: [-96.8, -175],
    current: { x: 0.016071794375532095, z: 0.899856487127559 },
    surface: 11.626775327408664,
  },
  { at: [-96.6, -175], current: undefined, surface: undefined },
  {
    at: [-123.2, -175],
    current: { x: -0.022689304977469793, z: 0.8997139520089923 },
    surface: 11.621976738420525,
  },
  { at: [-123.4, -175], current: undefined, surface: undefined },
];

const FOREST_LAKE: readonly IWaterProbe[] = [
  { at: [-70, 25], current: { x: 0, z: 0 }, surface: 13.3 },
  { at: [30, 25], current: { x: 0, z: 0 }, surface: 13.3 },
  { at: [36, 25], current: undefined, surface: undefined },
  { at: [-70, -60], current: { x: 0, z: 0 }, surface: 13.3 },
];

/**
 * The tundra's two kettles: near at (65, 80), level 28.8 m, cap 34 m; far at (-65, -50), level 30 m,
 * cap 46 m. Both basins measure wider than their cap, so the cap is the footprint the probes walk
 * out to, and both stand still.
 */
const TUNDRA_LAKE: readonly IWaterProbe[] = [
  { at: [65, 50], current: { x: 0, z: 0 }, surface: 28.8 },
  { at: [65, 110], current: { x: 0, z: 0 }, surface: 28.8 },
  { at: [65, 114], current: { x: 0, z: 0 }, surface: 28.8 },
  { at: [65, 115], current: undefined, surface: undefined },
  { at: [-65, -30], current: { x: 0, z: 0 }, surface: 30 },
  { at: [-65, -4], current: { x: 0, z: 0 }, surface: 30 },
  { at: [-65, -3], current: undefined, surface: undefined },
];

/** The coastal sea: the bake's level is 1.5 m, and its plane reaches past the surveyed square. */
const SEA: readonly IWaterProbe[] = [
  { at: [250, 250], current: { x: 0, z: 0 }, surface: 1.5 },
  { at: [2000, -2000], current: { x: 0, z: 0 }, surface: 1.5 },
];

describe("the forest river", () => {
  it("stands at the spline's height across 13.3 m of reach, and carries the flow downstream", () => {
    expect(answers(forest, FOREST_RIVER)).toEqual(FOREST_RIVER);
  });

  it("floods the lake's cap over the river's last station, and stops carrying there", () => {
    expect(answers(forest, FOREST_LAKE)).toEqual(FOREST_LAKE);
  });
});

describe("the tundra lakes", () => {
  it("stand at their levels, still, out to the radius their file caps them at", () => {
    expect(answers(tundra, TUNDRA_LAKE)).toEqual(TUNDRA_LAKE);
  });
});

describe("the coastal ocean", () => {
  it("draws the sea at the bake's level, still, out to the stretched sea plane", () => {
    if (coastal.waterLevel === null) throw new Error("the coastal bake has no sea level");
    const sea: IWaterOcean = { extent: SEA_EXTENT, level: coastal.waterLevel };
    const bodies = waterBodies(coastal.rivers ?? [], coastal.lakes ?? [], field(coastal), sea);
    const mesh = createWaterMesh(createOcean(), coastal);
    mesh.geometry.computeBoundingBox();
    const box = mesh.geometry.boundingBox;
    if (box === null) throw new Error("the sea surface has no bounds");
    const covers = ([x, z]: readonly [number, number]): boolean =>
      x >= box.min.x && x <= box.max.x && z >= box.min.z && z <= box.max.z;
    for (const probe of SEA) {
      expect(covers(probe.at)).toBe(true);
      expect(probe.surface).toBe(mesh.position.y);
      expect(bodies.surfaceAt(...probe.at)).toBe(probe.surface);
      // The sea carries no flow, and the coastal bake has no river or lake to give it one.
      expect(bodies.currentAt(...probe.at)).toEqual(probe.current);
      expect(bodies.footprintAt(...probe.at)).toEqual({ kind: "ocean", level: sea.level });
    }
    expect([box.min.x, box.max.x, box.min.z, box.max.z]).toEqual([-4120, 4120, -4120, 4120]);
    expect(covers([4200, 0])).toBe(false);
    expect(SEA_EXTENT).toBe(4120);
    expect(bodies.footprintAt(SEA_EXTENT, -SEA_EXTENT)).toBeDefined();
    expect(bodies.footprintAt(4200, 0)).toBeUndefined();
    expect(coastal.waterLevel).toBe(1.5);
    expect(coastal.rivers ?? []).toEqual([]);
    expect(coastal.lakes ?? []).toEqual([]);
  });
});

describe("the swim queries", () => {
  it("answer the sea the coastal world draws, and dry water past its edge", () => {
    if (coastal.waterLevel === null) throw new Error("the coastal bake has no sea level");
    const sea: IWaterOcean = { extent: SEA_EXTENT, level: coastal.waterLevel };
    const rivers = coastal.rivers ?? [];
    const lakes = coastal.lakes ?? [];
    const surface = waterSurfaceAt(rivers, lakes, field(coastal), sea);
    const current = waterCurrentAt(rivers, lakes, field(coastal), sea);
    // The swimmer rests on the level the drawn plane stands at, over the ground it covers.
    for (const probe of SEA) expect(surface(...probe.at)).toBe(sea.level);
    // The sea carries no flow.
    expect(current(2000, -2000)).toEqual({ x: 0, z: 0 });
    // And stops at the drawn surface's edge, as the plane does.
    expect(surface(4200, 0)).toBeUndefined();
    expect(current(4200, 0)).toBeUndefined();
  });
});

describe("the footprint the store reports", () => {
  it("names the body that covers the point, and stops where the water stops", () => {
    const forestBodies = waterBodies(forest.rivers ?? [], forest.lakes ?? [], field(forest));
    expect(forestBodies.footprintAt(-120, -220)).toEqual({
      kind: "river",
      level: 13.730976740569075,
    });
    expect(forestBodies.footprintAt(-70, 25)).toEqual({ kind: "lake", level: 13.3 });
    // The river's last station: the higher lake surface wins, so the footprint is the lake's.
    expect(forestBodies.footprintAt(-70, -60)).toEqual({ kind: "lake", level: 13.3 });
    expect(forestBodies.footprintAt(-96.6, -175)).toBeUndefined();
    const tundraBodies = waterBodies(tundra.rivers ?? [], tundra.lakes ?? [], field(tundra));
    expect(tundraBodies.footprintAt(65, 110)).toEqual({ kind: "lake", level: 28.8 });
    expect(tundraBodies.footprintAt(65, 115)).toBeUndefined();
  });
});
