// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// The island's ground: one terrain mesh whose vertex colours paint grass, worn grass, a sandy dirt
// path, beach sand and rock by height, slope and distance to the path, over a tiling detail map and
// a normal map baked here from seeded value noise, so close up the ground has grain and pits, not
// one flat colour. No image file: both maps are `DataTexture`s written in code.
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  type DataTexture,
  Mesh,
  MeshStandardMaterial,
  Vector2,
} from "three";
import { lit, paintedTexture, seeded } from "./materials.js";
import { C } from "./palette.js";

/** What the ground's paint reads from the level, in metres. */
export interface IGroundSite {
  /** The up component of the ground's normal: 1 flat, under 0.7 steeper than the hero can climb. */
  flatness(x: number, z: number): number;
  pathDistance(x: number, z: number): number;
  readonly seaLevel: number;
}

const SIZE = 128;
/** Metres one tile of the detail maps covers. */
const TILE = 3;

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

/** Grain (fine noise plus small dark pits) as a detail map, and the same height field as normals. */
function detailMaps(): { map: DataTexture; normalMap: DataTexture } {
  const octaves = [valueNoise(8, 11), valueNoise(24, 23), valueNoise(64, 37)];
  const height = (x: number, y: number): number => {
    const u = (((x % SIZE) + SIZE) % SIZE) / SIZE;
    const v = (((y % SIZE) + SIZE) % SIZE) / SIZE;
    const [a = 0, b = 0, c = 0] = octaves.map((noise) => noise(u, v));
    // Pits: where the finest octave dips, a small stone-shaped hollow.
    return 0.5 * a + 0.3 * b + 0.2 * c - 1.4 * Math.max(0, 0.22 - c);
  };
  // Albedo grain about ±12% round 0.9.
  const map = paintedTexture(
    SIZE,
    SIZE,
    (x, y) => {
      const value = 0.66 + 0.5 * height(x, y);
      return [value, value, value];
    },
    false,
  );
  const normalMap = paintedTexture(
    SIZE,
    SIZE,
    (x, y) => {
      const dx = (height(x + 1, y) - height(x - 1, y)) * 3;
      const dy = (height(x, y + 1) - height(x, y - 1)) * 3;
      const length = Math.hypot(dx, dy, 1);
      return [0.5 - (0.5 * dx) / length, 0.5 - (0.5 * dy) / length, 0.5 + 0.5 / length];
    },
    false,
  );
  return { map, normalMap };
}

const smooth = (from: number, to: number, value: number): number => {
  const t = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
};

/**
 * Paints a terrain geometry in world space (positions already translated to the world) and gives
 * it tiling UVs: grass with broad yellow-to-blue-green patches, darker worn grass beside the path,
 * the path's sandy dirt, beach sand near the water, and rock where the slope passes 40°.
 */
export function paintGround(geometry: BufferGeometry, site: IGroundSite): BufferGeometry {
  const position = geometry.attributes.position;
  const count = position?.count ?? 0;
  const colors = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);
  const grass = new Color(C.grass);
  const worn = new Color(C.grassDark);
  const dirt = new Color(C.path);
  const sand = new Color(C.sand);
  const rock = new Color(C.rock);
  const out = new Color();
  for (let i = 0; i < count; i += 1) {
    const x = position?.getX(i) ?? 0;
    const y = position?.getY(i) ?? 0;
    const z = position?.getZ(i) ?? 0;
    uvs[i * 2] = x / TILE;
    uvs[i * 2 + 1] = z / TILE;
    // Grass patches, as `patches()` in materials.ts paints the drum lawns.
    const value =
      1 + 0.12 * Math.sin(x * 0.31 + Math.sin(z * 0.23) * 2) * Math.cos(z * 0.27 - x * 0.09);
    const hue = 0.5 + 0.5 * Math.sin(x * 0.13 - z * 0.17 + 1.3);
    out.setRGB(
      grass.r * value * (1.12 - 0.3 * hue),
      grass.g * value,
      grass.b * value * (0.75 + 0.5 * hue),
    );
    const path = site.pathDistance(x, z);
    out.lerp(worn, 0.7 * (1 - smooth(1.2, 2.6, path)));
    out.lerp(dirt, 1 - smooth(0.9, 1.5, path));
    out.lerp(sand, 1 - smooth(site.seaLevel + 0.6, site.seaLevel + 1.4, y));
    out.lerp(rock, 1 - smooth(0.7, 0.8, site.flatness(x, z)));
    colors.set([out.r, out.g, out.b], i * 3);
  }
  geometry.setAttribute("color", new BufferAttribute(colors, 3));
  geometry.setAttribute("uv", new BufferAttribute(uvs, 2));
  return geometry;
}

/** The ground's one material: vertex-colour albedo under the grain map and its normals. */
export function groundMaterial(): MeshStandardMaterial {
  const { map, normalMap } = detailMaps();
  return new MeshStandardMaterial({
    color: 0xffffff,
    map,
    normalMap,
    normalScale: new Vector2(0.8, 0.8),
    roughness: 0.92,
    vertexColors: true,
  });
}

/**
 * Far hills round the sea, 170 to 330 m out: a low ring of green ridges the haze turns blue, so
 * the horizon has layers instead of one sea line. Scenery only, nothing reaches it.
 */
export function farHills(seaLevel: number): Mesh {
  const segments = 96;
  const rings = 5;
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
      positions.push(Math.cos(a) * radius, seaLevel - 1 + ridge * lift * 46, Math.sin(a) * radius);
      const c = near.clone().lerp(far, t * 0.6);
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
