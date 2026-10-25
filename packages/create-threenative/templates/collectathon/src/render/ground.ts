// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// The island's ground: one terrain mesh whose vertex attributes say where grass, worn grass, the
// sandy dirt path, beach sand and rock lie, by height, slope and distance to the path. The textures
// and the blend are `groundMaterial` in surface.ts.
import { BufferAttribute, BufferGeometry, Color, Mesh } from "three";
import { lit, seeded } from "./materials.js";
import { C } from "./palette.js";

/** What the ground's paint reads from the level, in metres. */
export interface IGroundSite {
  /** The up component of the ground's normal: 1 flat, under 0.7 steeper than the hero can climb. */
  flatness(x: number, z: number): number;
  pathDistance(x: number, z: number): number;
  readonly seaLevel: number;
}

/** Metres one tile of the ground's normal map covers. */
const TILE = 2;

/** Tileable value noise: `cells` lattice cells per tile, from a fixed seed. */
export function valueNoise(cells: number, seed: number): (u: number, v: number) => number {
  const rng = seeded(seed);
  const lattice = Float32Array.from({ length: cells * cells }, rng);
  const at = (i: number, j: number): number =>
    lattice[(((j % cells) + cells) % cells) * cells + (((i % cells) + cells) % cells)] ?? 0;
  return (u, v) => {
    const x = u * cells;
    const y = v * cells;
    const i = Math.floor(x);
    const j = Math.floor(y);
    const fx = (x - i) * (x - i) * (3 - 2 * (x - i));
    const fy = (y - j) * (y - j) * (3 - 2 * (y - j));
    const top = at(i, j) + (at(i + 1, j) - at(i, j)) * fx;
    const bottom = at(i, j + 1) + (at(i + 1, j + 1) - at(i, j + 1)) * fx;
    return top + (bottom - top) * fy;
  };
}

const smooth = (from: number, to: number, value: number): number => {
  const t = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
};

/**
 * Writes what `groundMaterial` in surface.ts blends, per vertex of a terrain geometry in world
 * space (positions already translated to the world): `layer` is (sand, rock, worn grass) — the
 * path's sandy dirt and the beach, rock where the slope passes about 50° (a grassy hill keeps its turf), and trodden grass beside the
 * path — and `tint` the lawn's broad yellow-to-blue-green patches. `uv` tiles every 2 m for the
 * normal map. (`tint`, not `color`: a node reading an attribute named `color` fails to compile on
 * the Wasm engine.)
 */
export function paintGround(geometry: BufferGeometry, site: IGroundSite): BufferGeometry {
  const position = geometry.attributes.position;
  const count = position?.count ?? 0;
  const colors = new Float32Array(count * 3);
  const layers = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  for (let i = 0; i < count; i += 1) {
    const x = position?.getX(i) ?? 0;
    const y = position?.getY(i) ?? 0;
    const z = position?.getZ(i) ?? 0;
    uvs[i * 2] = x / TILE;
    uvs[i * 2 + 1] = z / TILE;
    // Grass patches, as `patches()` in materials.ts paints the drum lawns.
    const value =
      1 + 0.14 * Math.sin(x * 0.31 + Math.sin(z * 0.23) * 2) * Math.cos(z * 0.27 - x * 0.09);
    const hue = 0.5 + 0.5 * Math.sin(x * 0.13 - z * 0.17 + 1.3);
    colors.set([value * (1.1 - 0.25 * hue), value, value * (0.8 + 0.4 * hue)], i * 3);
    const path = site.pathDistance(x, z);
    const sand = Math.max(
      1 - smooth(0.8, 1.6, path),
      1 - smooth(site.seaLevel + 0.6, site.seaLevel + 1.4, y),
    );
    layers.set(
      [sand, 1 - smooth(0.55, 0.7, site.flatness(x, z)), 1 - smooth(1.2, 2.8, path)],
      i * 3,
    );
  }
  geometry.setAttribute("tint", new BufferAttribute(colors, 3));
  geometry.setAttribute("layer", new BufferAttribute(layers, 3));
  geometry.setAttribute("uv", new BufferAttribute(uvs, 2));
  return geometry;
}

/**
 * Far hills round the sea, 170 to 330 m out: a low ring of green ridges the haze turns blue, so
 * the horizon has layers instead of one sea line. Scenery only, nothing reaches it.
 */
export function farHills(seaLevel: number): Mesh {
  const segments = 240;
  const rings = 12;
  // Two scales of tiling noise round the ring: knolls and gullies on the slopes, so the sun models
  // them, and the colour drifts between meadow and wood instead of one flat green.
  const coarse = valueNoise(24, 41);
  const fine = valueNoise(96, 43);
  const positions: number[] = [];
  const colors: number[] = [];
  const near = new Color(C.canopyDeep);
  const far = new Color(C.grass);
  for (let r = 0; r <= rings; r += 1) {
    const t = r / rings;
    for (let s = 0; s <= segments; s += 1) {
      const a = (s / segments) * Math.PI * 2;
      const ridge = Math.max(
        0,
        Math.sin(a * 3 + 1.1) * 0.6 + Math.sin(a * 7 + 0.4) * 0.3 + Math.sin(a * 13) * 0.15 + 0.35,
      );
      const radius = 170 + t * 160;
      // Rise from the sea to the crest at 70% of the depth, then fall a little behind it.
      const lift = Math.sin(Math.min(1, t / 0.7) * Math.PI * 0.5) * (1 - Math.max(0, t - 0.7));
      const u = s / segments;
      const knoll = coarse(u, t * 0.25) * 0.6 + fine(u, t * 0.5) * 0.4;
      const height = ridge * lift * 46 * (0.7 + 0.6 * knoll) + lift * fine(u, t) * 5;
      positions.push(Math.cos(a) * radius, seaLevel - 1 + height, Math.sin(a) * radius);
      const c = near
        .clone()
        .lerp(far, t * 0.6 * coarse(u + 0.5, t * 0.3))
        .multiplyScalar(0.8 + 0.4 * fine(u + 0.25, t * 0.7));
      colors.push(c.r, c.g, c.b);
    }
  }
  const index: number[] = [];
  for (let r = 0; r < rings; r += 1) {
    for (let s = 0; s < segments; s += 1) {
      const a = r * (segments + 1) + s;
      const b = a + segments + 1;
      index.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute("color", new BufferAttribute(new Float32Array(colors), 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  const hills = new Mesh(geometry, lit(0xffffff, { roughness: 1, vertexColors: true }));
  hills.name = "far-hills";
  return hills;
}
