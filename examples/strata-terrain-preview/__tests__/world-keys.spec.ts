import { readFileSync } from "node:fs";
import { Heightfield } from "@threenative/core/world";
import { describe, expect, it } from "vitest";
import { WORLD_SELECT } from "../src/game.js";
import { BIOME_SPECS } from "../src/render/biomeData.js";
import type { WorldName } from "../src/render/biomes.js";
import { SPAWN_CAMERA_OFFSET, SPAWN_POINTS } from "../src/render/worldData.js";

/**
 * What a world key does, pinned on today's code: which number picks which world, where the player
 * starts in it, and where the launch camera stands.
 *
 * The launch camera is the pose `game.ts` copies before the follow camera takes over: the player's
 * spawn, two metres above the ground under it, plus that world's camera offset. The follow camera
 * then places itself from the terrain collider, so that pose is the pin a world switch can break
 * without touching a single look value.
 */
const PINS: Readonly<
  Record<
    WorldName,
    {
      readonly camera: readonly [number, number, number];
      readonly ground: number;
      readonly key: string;
      readonly spawn: readonly [number, number];
    }
  >
> = {
  forest: {
    camera: [-192, 42.449971199035645, -123],
    ground: 16.449971199035645,
    key: "Digit1",
    spawn: [-220, -165],
  },
  coastal: {
    camera: [208, 23.34995937347412, 99],
    ground: 3.349959373474121,
    key: "Digit2",
    spawn: [180, 65],
  },
  alpine: {
    camera: [208, 41.999755859375, -148],
    ground: 15.999755859375,
    key: "Digit3",
    spawn: [180, -190],
  },
  desert: {
    camera: [208, 36.199771881103516, 202],
    ground: 10.199771881103516,
    key: "Digit4",
    spawn: [180, 160],
  },
  tundra: {
    camera: [208, 54.021677017211914, 202],
    ground: 28.021677017211914,
    key: "Digit5",
    spawn: [180, 160],
  },
};

interface IBake {
  readonly heights: number[];
  readonly resolution: number;
  readonly size: number;
}

const read = (name: string): IBake =>
  JSON.parse(readFileSync(new URL(`../src/world/${name}`, import.meta.url), "utf8")) as IBake;

/** The two worlds baked into one file read their own slice of it, as the game does. */
function bake(world: WorldName): IBake {
  if (world === "forest" || world === "coastal")
    return read("baked.json")[world] as unknown as IBake;
  return read(`${world}.json`);
}

const groundAt = (world: WorldName, x: number, z: number): number => {
  const data = bake(world);
  const field = new Heightfield({
    rows: data.resolution,
    columns: data.resolution,
    width: data.size,
    depth: data.size,
    origin: { x: 0, z: 0 },
    heights: Float32Array.from(data.heights),
  });
  return field.heightAt(x, z);
};

describe("world keys", () => {
  it("picks the five worlds in order with keys 1 to 5", () => {
    const worlds = Object.keys(WORLD_SELECT) as WorldName[];
    expect(worlds).toEqual(["forest", "coastal", "alpine", "desert", "tundra"]);
    for (const [index, world] of worlds.entries()) {
      expect(WORLD_SELECT[world].keys, world).toEqual([`Digit${index + 1}`]);
      expect(WORLD_SELECT[world].keys, world).toEqual([PINS[world].key]);
    }
    // A world with a pin and no key could never be reached, and the reverse is a key to nowhere.
    expect(worlds.sort()).toEqual(Object.keys(PINS).sort());
  });

  it("selects exactly the worlds a biome row describes", () => {
    // A sixth biome file without a selector key is a world no key reaches; a key with no row is a
    // key to nowhere. Both fail here rather than at the keyboard.
    expect(Object.keys(WORLD_SELECT).sort()).toEqual(Object.keys(BIOME_SPECS).sort());
  });

  it("starts and frames every world at the pinned point", () => {
    for (const world of Object.keys(PINS) as WorldName[]) {
      const pin = PINS[world];
      const [x, z] = pin.spawn;
      expect(SPAWN_POINTS[world], `${world} spawn`).toEqual(pin.spawn);
      expect(groundAt(world, x, z), `${world} ground under the spawn`).toBeCloseTo(pin.ground, 4);
      const [offsetX, offsetY, offsetZ] = SPAWN_CAMERA_OFFSET[world];
      const plane = pin.ground + 2;
      const camera = [x + offsetX, plane + offsetY, z + offsetZ];
      for (const [axis, expected] of pin.camera.entries()) {
        expect(camera[axis], `${world} launch camera ${"xyz"[axis]}`).toBeCloseTo(expected, 4);
      }
    }
  });
});
