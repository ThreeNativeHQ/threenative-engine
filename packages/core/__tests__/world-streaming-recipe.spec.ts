import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MeshBasicMaterial, PerspectiveCamera } from "three";
import { describe, expect, it } from "vitest";
import { TerrainTiles } from "../src/world.js";

/**
 * PRD-461: the guide's view-distance recipe cannot drift. The numbers are read from the guide's own
 * table, checked against where each edge can be, and then handed to `TerrainTiles` so the code's
 * own validation runs on them too.
 */

const guide = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../docs/guides/world-streaming.md",
  ),
  "utf8",
);

interface IRecipe {
  readonly cellSize: number;
  readonly ring: number;
  readonly streamRadius: number;
  readonly colliderRadius: number;
  readonly lodDistances: readonly number[];
  readonly fogNear: number;
  readonly fogFar: number;
  readonly residentCells: number;
}

/** The right-hand column of the recipe table, by the setting named in its first column. */
function documented(): IRecipe {
  const header = /\| At `c` = (\d+) m/.exec(guide);
  if (header === null) throw new Error("The guide's recipe table has no `At c = … m` column.");
  const value = (setting: string): number[] => {
    const row = guide
      .split("\n")
      .find((line) => line.startsWith(`| ${setting} |`))
      ?.split("|");
    const cell = row?.[3]?.trim();
    if (cell === undefined || cell === "") throw new Error(`The recipe table has no ${setting}.`);
    return cell.split(",").map((part) => Number(part.trim()));
  };
  const one = (setting: string): number => value(setting)[0] as number;
  return {
    cellSize: Number(header[1]),
    colliderRadius: one("`terrain.colliderRadius`"),
    fogFar: one("fog `far`"),
    fogNear: one("fog `near`"),
    lodDistances: value("`terrain.lodDistances`"),
    residentCells: one("`budgets.residentCells`"),
    ring: one("`ring`"),
    streamRadius: one("`terrain.streamRadius`"),
  };
}

/** Throws with the first broken rule; the guide spells out why each one holds. */
function check(recipe: IRecipe): void {
  const { cellSize: c } = recipe;
  const rules: [boolean, string][] = [
    [recipe.fogFar <= recipe.ring * c, "fog far must be at most ring · c, where new props appear"],
    [recipe.streamRadius * c > recipe.fogFar, "the ground must end beyond fog far"],
    [recipe.streamRadius > recipe.ring, "terrain must outlive the props"],
    [recipe.colliderRadius <= recipe.ring, "colliders must stay inside the props' ring"],
    [recipe.fogNear < recipe.fogFar, "fog near must be less than fog far"],
    [recipe.lodDistances.every((d) => d >= recipe.fogNear), "a LOD switch must be in the haze"],
    [recipe.residentCells >= (2 * recipe.ring + 1) ** 2, "the cell budget must hold the ring"],
  ];
  for (const [holds, rule] of rules) if (!holds) throw new Error(rule);
  // The code's own clamps: integer radii, one strictly increasing threshold per transition.
  new TerrainTiles({
    colliderRadius: recipe.colliderRadius,
    lodDistances: recipe.lodDistances,
    residentByteBudget: 1,
    residentTileBudget: (2 * recipe.streamRadius + 1) ** 2,
    sampleHeight: () => 0,
    streamRadius: recipe.streamRadius,
    surface: new MeshBasicMaterial(),
    tileResolution: 9,
    tileSize: c,
  }).dispose();
}

describe("world-streaming view-distance recipe", () => {
  it("documents numbers that hide every edge behind the fog", () => {
    const recipe = documented();
    expect(recipe).toMatchObject({ cellSize: 128, ring: 2, streamRadius: 3, colliderRadius: 1 });
    expect(() => check(recipe)).not.toThrow();
  });

  it("keeps the documented arithmetic: every number follows from the cell size", () => {
    const recipe = documented();
    const c = recipe.cellSize;
    expect(recipe.streamRadius).toBe(recipe.ring + 1);
    expect(recipe.lodDistances).toEqual([2 * c, 4 * c]);
    expect(recipe.fogNear).toBe(c);
    expect(recipe.fogFar).toBe(recipe.ring * c);
    expect(recipe.residentCells).toBe((2 * recipe.ring + 1) ** 2);
  });

  it("keeps screen-error switches behind 180 m fog and the explicit distance floor at both raster sizes", () => {
    const switches: number[][] = [];
    for (const [width, height] of [
      [1280, 720],
      [2560, 1440],
    ] as const) {
      const tiles = new TerrainTiles({
        surface: new MeshBasicMaterial(),
        residentByteBudget: 2_000_000,
        residentTileBudget: 1,
        sampleHeight: (x) => Math.cos((Math.PI * x) / 128),
        streamRadius: 0,
        tileResolution: 9,
        tileSize: 1024,
        skirtDepth: 1,
        lodDistances: [180, 360],
      });
      const camera = new PerspectiveCamera(60, width / height, 0.1, 10000);
      const changed: number[] = [];
      let previous = 0;
      try {
        for (const x of [0, 179, 180, 359, 360, 480]) {
          camera.position.set(0, 0, 1800 + 4 * x);
          camera.lookAt(0, 0, 0);
          camera.updateMatrixWorld(true);
          tiles.follow({ x, z: 0 }, undefined, {
            camera,
            viewportHeight: height,
            maxPixelError: 1,
            hysteresis: 0.15,
          });
          const level = tiles.getTile("0:0")?.lodLevel;
          if (level === undefined) throw new Error("Expected the same resident recipe tile.");
          if (level !== previous) {
            expect(x).toBeGreaterThanOrEqual(180);
            expect(x).toBeGreaterThanOrEqual([0, 180, 360][level] as number);
            changed.push(x);
          }
          previous = level;
          for (let frame = 0; frame < 3; frame += 1) tiles.process();
        }
        expect(tiles.maxLodTransitionFrames).toBe(3);
        switches.push(changed);
      } finally {
        tiles.dispose();
      }
    }
    expect(switches).toEqual([[180, 360], [480]]);
  });

  it("control: fog far set against the ring corner (452 m) leaves the ring's side visible", () => {
    // The PRD's first draft: 420 m clears the 452 m corner, but a cell loads 256 m away.
    expect(() => check({ ...documented(), fogFar: 420 })).toThrow(/fog far/);
  });

  it("control: a collider radius past the ring is rejected", () => {
    expect(() => check({ ...documented(), colliderRadius: 3 })).toThrow(/colliders/);
  });

  it("control: decreasing LOD distances fail the code's own check", () => {
    expect(() => check({ ...documented(), lodDistances: [512, 256] })).toThrow(
      /strictly increasing/,
    );
  });
});
