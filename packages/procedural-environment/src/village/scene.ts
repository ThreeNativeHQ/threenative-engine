import { Color, Group, type Object3D } from "three";
import { CATALOG, build } from "../../vendor/stylized-biome-kit/catalog.js";
import { RNG, noise3 } from "../../vendor/stylized-biome-kit/core.js";
import { terrain } from "../../vendor/stylized-biome-kit/ground.js";
import type { IStylizedScene } from "../../vendor/stylized-biome-kit/scenes.js";
import { buildVillagePart } from "./catalog.js";
import { villageMesh } from "./kit.js";

export const villageScenes = { green: "Village green", town: "Walled town" } as const;

/** Kit pieces that frame a settlement in each theme: trees, shrubs and the far ridge. */
const NATURE = [
  {
    trees: ["round-tree", "pine", "pine-olive"],
    shrubs: ["bush", "flowers", "grass"],
    ridge: "mountain-alpine",
  },
  {
    trees: ["pine-snow", "frost-tree", "pine-snow"],
    shrubs: ["bush-snow", "grass-frost"],
    ridge: "mountain-snow",
  },
  {
    trees: ["palm", "saguaro", "twisted-tree"],
    shrubs: ["shrub", "grass-dry", "broadleaf"],
    ridge: "mountain-desert",
  },
] as const;

// The kit's own forest, snow and desert scene lighting (vendor/stylized-biome-kit/scenes.js).
const ENV: IStylizedScene["env"][] = [
  {
    skyTop: 0x2a7de6,
    horizon: 0xbfe4ff,
    fog: [0xbfe1ff, 70, 280],
    sun: { dir: [-0.6, 0.72, 0.42], color: 0xfff1d6, intensity: 3.1 },
    hemi: { sky: 0xcfe5ff, ground: 0x5d7fb0, intensity: 1.7 },
    shadow: 42,
  },
  {
    skyTop: 0x3a8be8,
    horizon: 0xe2f1ff,
    fog: [0xdcecff, 60, 260],
    sun: { dir: [0.55, 0.7, 0.45], color: 0xfff6ea, intensity: 2.7 },
    hemi: { sky: 0xdcecff, ground: 0x7d9fd8, intensity: 2.0 },
    shadow: 42,
  },
  {
    skyTop: 0x2488ea,
    horizon: 0xd9ecff,
    fog: [0xe6cfd0, 80, 300],
    sun: { dir: [-0.5, 0.74, 0.45], color: 0xffedd0, intensity: 3.2 },
    hemi: { sky: 0xd4e6ff, ground: 0xa97c92, intensity: 1.7 },
    shadow: 42,
  },
];

const road = (x: number, z: number) => Math.abs(x - Math.sin(z * 0.09) * 2.4);

interface IStage {
  /** Flat ground out to this radius, then rolling hills. */
  flat: number;
  /** Ground under streets and squares: 1 inside, falling to 0 over about a metre. */
  paved: (x: number, z: number) => number;
  /** Where trees and shrubs may not grow. */
  built: (x: number, z: number) => boolean;
}

function staging(seed: number, theme: number, o: IStage) {
  const rng = new RNG(seed);
  const group = new Group();
  const cache = new Map<string, Object3D>();
  const height = (x: number, z: number) =>
    Math.max(0, Math.hypot(x, z * 1.2) - o.flat) *
    0.12 *
    (1 + 0.6 * noise3(x * 0.04, 0, z * 0.04, 5));
  const clone = (key: string, make: () => Object3D) => {
    let source = cache.get(key);
    if (!source) {
      source = make();
      cache.set(key, source);
    }
    return source.clone();
  };
  const put = (object: Object3D, x: number, z: number, yaw = 0, scale = 1) => {
    object.position.set(x, height(x, z), z);
    object.rotation.y = yaw;
    object.scale.setScalar(scale);
    group.add(object);
  };
  const place = (id: string, x: number, z: number, yaw = 0) => {
    const variation = rng.int(1, 3);
    put(
      clone(`${id}:${variation}`, () => buildVillagePart(id, seed * 89 + variation, theme)),
      x,
      z,
      yaw,
    );
  };
  const kit = (id: string, x: number, z: number, scale = 1) => {
    const entry = CATALOG.find((asset) => asset.id === id);
    if (!entry) throw new Error(`Village scene needs kit piece "${id}"`);
    const variant = rng.int(0, entry.variants.length - 1);
    put(
      clone(`${id}:${variant}`, () => build(entry, variant)),
      x,
      z,
      rng.range(0, Math.PI * 2),
      scale,
    );
  };

  const palette = villageMesh(seed, theme).palette;
  const grass = new Color(palette.ground);
  const light = grass.clone().lerp(new Color(0xffffff), 0.22);
  group.add(
    terrain({
      size: 260,
      segments: 140,
      focus: 0.35,
      height,
      color: (x, z, _y, _n, out, blend) => {
        out.copy(grass).lerp(light, Math.max(0, noise3(x * 0.06, 0, z * 0.06, seed)));
        blend.tint.set(palette.path);
        blend.mask = o.paved(x, z);
      },
    }),
  );

  /** Trees in a ring from `r0` to `r1`, shrubs scattered inside `shrubs`, the ridge far behind. */
  const nature = (r0: number, r1: number, shrubs: number, count = 70) => {
    const kinds = NATURE[theme] ?? NATURE[0];
    for (let i = 0; i < count; i++) {
      const a = rng.range(0, Math.PI * 2);
      const r = rng.range(r0, r1);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r * 0.85 - 6;
      if (o.built(x, z) || road(x, z) < 5) continue;
      kit(kinds.trees[i % kinds.trees.length] ?? "pine", x, z, rng.range(0.8, 1.15));
    }
    for (let i = 0; i < count * 0.7; i++) {
      const x = rng.range(-shrubs, shrubs);
      const z = rng.range(-shrubs, shrubs);
      if (o.built(x, z) || road(x, z) < 3.5) continue;
      kit(kinds.shrubs[i % kinds.shrubs.length] ?? "bush", x, z, rng.range(0.8, 1.2));
    }
    for (let i = -2; i <= 2; i++)
      kit(kinds.ridge, i * 60 + rng.range(-8, 8), -150, rng.range(1.5, 2));
  };

  const env = ENV[theme] ?? ENV[0];
  if (!env) throw new Error("Village scene has no lighting");
  return { group, place, nature, env };
}

const fade = (distance: number) => 1 - Math.min(1, Math.max(0, distance / 1.2));
const lane = (x: number, z: number, from: number) => (z > from ? road(x, z) - 1.6 : 9);

function green(seed: number, theme: number): IStylizedScene {
  const stage = staging(seed, theme, {
    flat: 24,
    paved: (x, z) => fade(Math.min(Math.max(Math.abs(x), Math.abs(z)) - 7.2, lane(x, z, 4))),
    built: (x, z) =>
      Math.hypot(x, z) < 15 || (z > 4 && Math.abs(x) < 8) || (x > 4 && z > 8 && x < 20),
  });
  const { place } = stage;
  for (const x of [-4, 0, 4]) for (const z of [-4, 0, 4]) place("cobble-path", x, z);
  place("well", 0, 0);
  place("tavern", 0, -10.5);
  place("home", -10.5, -2, Math.PI / 2);
  place("townhouse", 10.5, -3, -Math.PI / 2);
  place("cottage", -10, 9, Math.PI / 2 + 0.25);
  place("forge", 10, 8, -Math.PI / 2);
  place("market-stall", -4.2, -4.6, 0.35);
  place("market-stall", 4.2, -4.6, -0.35);
  place("barn", -22, -15, 0.35);
  place("windmill", 19, -19, -0.55);
  place("watchtower", -24, 12, 0.6);
  for (const [x, z] of [
    [-6.6, 6.6],
    [6.6, 6.6],
    [-6.6, -6.6],
    [6.6, -6.6],
  ] as const)
    place("lamp-post", x, z, x > 0 ? Math.PI : 0);
  place("barrel", -2.6, -7.1);
  place("barrel", -3.3, -6.7);
  place("crate", 2.8, -7.2, 0.3);
  place("bench", 1.1, -6.6);
  place("cart", 6, -0.5, 0.7);
  place("trough", 6.9, 10.6, Math.PI / 2);
  place("woodpile", -13.6, -4.8, Math.PI / 2);
  place("planter", -7.7, 1.4, Math.PI / 2);
  place("laundry-line", -13.5, 13.4, 0.25);
  place("scarecrow", -16.5, -3.5, 0.6);
  place("pumpkins", -15, -1);
  place("pumpkins", -17.5, -6.2);
  place("signpost", 3.2, 10.5);
  place("haystack", -16, -10.5);
  place("haystack", -18.5, -8.6);
  place("sack", 3.6, -6.9, 0.8);
  for (let i = 0; i < 4; i++) place("picket-fence", -14.8, 3 + i * 4, Math.PI / 2);
  for (let i = 0; i < 5; i++) place("rail-fence", -28 + i * 4, -6, 0);
  for (let i = 0; i < 3; i++) place("garden-wall", 14.5 + i * 4, 3, 0);
  stage.nature(26, 62, 24);
  return { group: stage.group, view: { pos: [15, 13, 27], target: [0, 1.6, -4] }, env: stage.env };
}

/** Wall corners at (±WX, ±WZ); the gatehouse sits on the south wall where the road comes in. */
const WX = 18;
const WZ = 16;

function town(seed: number, theme: number): IStylizedScene {
  const inside = (x: number, z: number, pad = 0) =>
    Math.abs(x) < WX + pad && Math.abs(z) < WZ + pad;
  const stage = staging(seed, theme, {
    flat: 38,
    paved: (x, z) =>
      fade(Math.min(Math.max(Math.abs(x) - WX + 0.8, Math.abs(z) - WZ + 0.8), lane(x, z, WZ))),
    built: (x, z) =>
      inside(x, z, 4) ||
      (x < -22 && x > -42 && Math.abs(z) < 16) ||
      (x > 22 && x < 36 && z > -14 && z < 16),
  });
  const { place } = stage;
  // the wall circuit
  for (const x of [-14, -10, -6, 6, 10, 14]) place("city-wall", x, WZ, 0);
  place("gatehouse", 0, WZ, 0);
  for (let x = -14; x <= 14; x += 4) place("city-wall", x, -WZ, Math.PI);
  for (let z = -12; z <= 12; z += 4) {
    place("city-wall", WX, z, Math.PI / 2);
    place("city-wall", -WX, z, -Math.PI / 2);
  }
  for (const x of [-WX, WX])
    for (const z of [-WZ, WZ]) place("wall-tower", x, z, z > 0 ? 0 : Math.PI);
  // streets and the market square
  for (const x of [-4, 0, 4]) for (const z of [-8, -4, 0]) place("cobble-path", x, z);
  for (const z of [4, 8, 12]) place("cobble-path", 0, z);
  for (const x of [-12, -8, 8, 12]) place("cobble-path", x, -4);
  place("well", 0, -4);
  place("market-stall", -3.6, -7, 0.3);
  place("market-stall", 3.6, -7, -0.3);
  // buildings inside the walls
  place("tavern", 0, -12.4);
  place("townhouse", -11.5, -12.2);
  place("townhouse", 11.5, -12.2);
  place("inn", -10.2, 8.6, Math.PI / 2);
  place("shop", 9.8, 9, -Math.PI / 2);
  place("home", -12.2, 0.4, Math.PI / 2);
  place("forge", 12.3, 0.9, -Math.PI / 2);
  // street dressing
  for (const [x, z] of [
    [2.6, 6],
    [-2.6, 10.5],
    [2.6, 13.6],
    [-6.6, -1.6],
    [6.6, -1.6],
  ] as const)
    place("lamp-post", x, z, x > 0 ? Math.PI : 0);
  place("barrel", -5.9, 5.6);
  place("barrel", -5.7, 4.8);
  place("bench", -5.8, 12, Math.PI / 2);
  place("crate", 6.1, 12, 0.3);
  place("crate", 6.3, 5.9, -0.2);
  place("sack", 5.9, 6.9);
  place("cart", 4.4, 2.4, 0.4);
  place("trough", 14.6, 4.6, Math.PI / 2);
  place("planter", -6.2, -1.2, Math.PI / 2);
  place("signpost", 3, 21);
  // farms and the mill outside the walls
  place("barn", -32, -4, 0.4);
  place("haystack", -27, 6);
  place("haystack", -30.5, 8.4);
  place("scarecrow", -36, 9, 0.5);
  place("pumpkins", -27, -12);
  place("pumpkins", -30, -14);
  for (let i = 0; i < 4; i++) place("rail-fence", -38 + i * 4, 13, 0);
  place("windmill", 30, -6, -0.5);
  place("cottage", 28, 10, -Math.PI / 2 + 0.3);
  place("woodpile", 31.5, 13, 0.2);
  for (let i = 0; i < 3; i++) place("garden-wall", 24 + i * 4, 15.5, 0);
  stage.nature(44, 85, 40, 90);
  return {
    group: stage.group,
    view: { pos: [28, 30, 56], target: [0, 0, -2] },
    env: { ...stage.env, shadow: 62 },
  };
}

export function buildVillageScene(
  id: keyof typeof villageScenes,
  seed: number,
  theme: number,
): IStylizedScene {
  const scene = id === "town" ? town(seed, theme) : green(seed, theme);
  scene.group.name = `village-${id}`;
  return scene;
}
