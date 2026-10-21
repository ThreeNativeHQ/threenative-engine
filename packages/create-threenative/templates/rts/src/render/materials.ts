// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// The look, in one place: the grid the ground is measured against and the two node materials that
// tint it. `terrain.ts` builds the ground; everything that decides what the ground *is* lives here,
// so a rebalance is one file rather than a hunt through the scene.
import {
  type BufferGeometry,
  CircleGeometry,
  DataTexture,
  Float32BufferAttribute,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  SRGBColorSpace,
  Vector3,
} from "three";
import {
  color,
  float,
  length,
  mix,
  normalWorld,
  oneMinus,
  positionWorld,
  smoothstep,
  texture,
  uv,
} from "three/tsl";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { HALF, WORLD } from "../sim/terrain.js";
import { palette } from "./palette.js";

/**
 * How many metres one grid tile covers.
 *
 * Sixteen, not four, and the number is measured at the rig's own zoom rather than picked. The tile
 * holds four major lines and sixteen minor ones, so this is a 4 m grid with a 1 m line inside each
 * square: at a 30 m tactical zoom a major line lands every 48 px and the minor one every 12 px,
 * where the 1 m major grid this file started with put a crosshatch every 12 px on *both* axes and
 * the whole battlefield read as wireframe mesh rather than as ground. A metre is still a metre —
 * the minor line is what keeps the grid honest — but the ground now reads as ground.
 */
const TILE = 16;
const MAJOR_EVERY = 4;
const MINOR_EVERY = 16;

/**
 * One tile of grid: a heavy line every four metres, a faint one every metre, and nothing else.
 * White where there is no line, so the terrain material can tint the same tile light ground and
 * dark cliff — the grid is the look, the tint is the terrain's. The minor line darkens its tile by
 * less than a quarter, which is what "faint" has to mean when a metre is a dozen pixels wide.
 */
function gridTexture(size = 256): DataTexture {
  const LINE = 64; // The line darkens its tile to a quarter: a grid, not a stain.
  const heavy = Math.round((size / MAJOR_EVERY) * 0.045);
  const light = Math.max(2, Math.round(heavy / 3));
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const major = x % (size / MAJOR_EVERY) < heavy || y % (size / MAJOR_EVERY) < heavy;
      const minor = x % MINOR_EVERY < light || y % MINOR_EVERY < light;
      const weight = major ? 0.95 : minor ? 0.22 : 0;
      const value = Math.round(255 * (1 - weight) + LINE * weight);
      const index = (y * size + x) * 4;
      data[index] = value;
      data[index + 1] = value;
      data[index + 2] = value;
      data[index + 3] = 255;
    }
  }
  const grid = new DataTexture(data, size, size);
  grid.colorSpace = SRGBColorSpace;
  grid.wrapS = RepeatWrapping;
  grid.wrapT = RepeatWrapping;
  grid.generateMipmaps = true;
  grid.minFilter = LinearMipmapLinearFilter;
  grid.needsUpdate = true;
  return grid;
}

/**
 * Rewrites a geometry's UVs as world metres, projected along each face's dominant axis, so a tile
 * covers the same ground on a slope as on the flat. Call it after the geometry has been displaced
 * and its normals recomputed.
 */
export function worldMetreUVs<T extends BufferGeometry>(geometry: T): T {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const metres = new Float32Array(position.count * 2);
  const face = new Vector3();
  for (let index = 0; index < position.count; index += 1) {
    face.fromBufferAttribute(normal, index);
    const x = position.getX(index);
    const y = position.getY(index);
    const z = position.getZ(index);
    const ax = Math.abs(face.x);
    const ay = Math.abs(face.y);
    const az = Math.abs(face.z);
    const [u, v] = ay >= ax && ay >= az ? [x, z] : ax >= az ? [z, y] : [x, y];
    metres[index * 2] = u;
    metres[index * 2 + 1] = v;
  }
  geometry.setAttribute("uv", new Float32BufferAttribute(metres, 2));
  return geometry;
}

/**
 * The ground: minimal's metre grid, tilted to the terrain, with the fog of war sampled in the same
 * material rather than painted over it.
 *
 * An overlay plane is one more full-map draw, and it cannot be depth-tested against the very slope
 * it is drawn on without z-fighting it. One material, one texture, one draw — and the fog is lit
 * with the ground, so a shadow crossing unexplored ground darkens both together.
 */
export function createTerrainMaterial(fog: DataTexture): MeshStandardNodeMaterial {
  const grid = gridTexture();
  // `worldMetreUVs` writes metres; the tile is `TILE` of them.
  const tile = uv().div(TILE);
  // A slope is a cliff: the same grid, a long way darker, decided by the surface normal rather
  // than by a second painted texture, so it follows any height the simulation grows.
  const stone = mix(
    color(palette.cliff),
    color(palette.ground),
    smoothstep(0.55, 0.92, normalWorld.y),
  ).mul(texture(grid, tile).rgb);
  const material = new MeshStandardNodeMaterial({ metalness: 0, roughness: 0.9 });
  material.colorNode = mix(
    color(palette.unseen).mul(2.2),
    stone,
    texture(fog, positionWorld.xz.add(HALF).div(WORLD)).r,
  );
  return material;
}

/** The pools the simulation refuses to path across, faded at their own rim so they meet a bank. */
export function createWaterMaterial(): MeshStandardNodeMaterial {
  const water = new MeshStandardNodeMaterial({
    depthWrite: false,
    metalness: 0.1,
    roughness: 0.14,
    transparent: true,
  });
  water.colorNode = color(0x2b5f5c);
  water.opacityNode = float(0.88).mul(oneMinus(smoothstep(0.43, 0.5, length(uv().sub(0.5)))));
  return water;
}

/** The unit disc the water instances: a circle, already flat, already facing up. */
export function waterDisc(): BufferGeometry {
  return new CircleGeometry(1, 48).rotateX(-Math.PI / 2);
}
