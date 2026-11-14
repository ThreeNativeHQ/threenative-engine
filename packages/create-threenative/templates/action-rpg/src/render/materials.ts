// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// The prototype look every engine ships a new project with, cut to a dungeon: a light metre grid
// underfoot, a dark one on everything structural, and one saturated blue for the chests you can
// open. It reads as "a real engine" only because `sky.ts` gives every surface an environment to
// reflect — roughness then decides how much sky a surface mirrors, so keep it varied between
// neighbours.
import {
  type BufferGeometry,
  DataTexture,
  Float32BufferAttribute,
  LinearMipmapLinearFilter,
  MathUtils,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  Vector2,
  Vector3,
} from "three";
import { palette } from "./palette.js";

/**
 * One metre of grid: a heavy line on the metre, faint lines every 25 cm, a faint per-texel grain so
 * large areas do not band. Built from bytes rather than a canvas so it runs the same in the browser
 * and in the native host.
 */
function gridTexture(base: number, line: number, size = 256): DataTexture {
  const data = new Uint8Array(size * size * 4);
  const minorEvery = size / 4;
  let seed = 7;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const major = x < 3 || y < 3;
      const minor = x % minorEvery < 1 || y % minorEvery < 1;
      const weight = major ? 0.92 : minor ? 0.22 : 0;
      seed = (seed * 16807) % 2147483647;
      const grain = 1 + (seed / 2147483647 - 0.5) * 0.04;
      const index = (y * size + x) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        const shift = 16 - channel * 8;
        const from = ((base >> shift) & 0xff) * grain;
        const to = (line >> shift) & 0xff;
        data[index + channel] = Math.min(255, Math.round(from * (1 - weight) + to * weight));
      }
      data[index + 3] = 255;
    }
  }
  const texture = new DataTexture(data, size, size);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.anisotropy = 16;
  texture.needsUpdate = true;
  return texture;
}

const _normal = new Vector3();

/**
 * A faint cast-concrete grain as a tangent-space normal map: two octaves of smoothed value noise,
 * tiling every metre like the grid. It is what stops a large flat face reading as an untextured
 * blockout under a low sun — the light breaks up across it instead of sliding off in one tone.
 * Bytes, not a file, so it costs nothing to ship and runs on every target.
 */
function grainNormalTexture(size = 128): DataTexture {
  const cells = [8, 32];
  const lattice = cells.map((count) => {
    const values = new Float32Array(count * count);
    let seed = count * 7919;
    for (let index = 0; index < values.length; index += 1) {
      seed = (seed * 16807) % 2147483647;
      values[index] = seed / 2147483647;
    }
    return { count, values };
  });
  const height = (x: number, y: number): number => {
    let total = 0;
    for (const [octave, { count, values }] of lattice.entries()) {
      const u = (x / size) * count;
      const v = (y / size) * count;
      const x0 = Math.floor(u);
      const y0 = Math.floor(v);
      const fx = u - x0;
      const fy = v - y0;
      const sx = MathUtils.smoothstep(fx, 0, 1);
      const sy = MathUtils.smoothstep(fy, 0, 1);
      const at = (i: number, j: number): number =>
        values[(((j % count) + count) % count) * count + (((i % count) + count) % count)] ?? 0;
      const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * sx;
      const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * sx;
      total += (top + (bottom - top) * sy) * (octave === 0 ? 1 : 0.5);
    }
    return total;
  };
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = height(x + 1, y) - height(x - 1, y);
      const dy = height(x, y + 1) - height(x, y - 1);
      _normal.set(-dx * 4, -dy * 4, 1).normalize();
      const index = (y * size + x) * 4;
      data[index] = Math.round((_normal.x * 0.5 + 0.5) * 255);
      data[index + 1] = Math.round((_normal.y * 0.5 + 0.5) * 255);
      data[index + 2] = Math.round((_normal.z * 0.5 + 0.5) * 255);
      data[index + 3] = 255;
    }
  }
  const texture = new DataTexture(data, size, size);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.needsUpdate = true;
  return texture;
}

const grain = grainNormalTexture();

/**
 * Rewrites a geometry's UVs as world metres, projected along each face's dominant axis, so one grid
 * tile is one metre on every face of every prop regardless of its size. Call it after the geometry
 * is translated into place (merged geometry included), before it is given to a mesh.
 */
export function worldGridUVs<T extends BufferGeometry>(geometry: T): T {
  const position = geometry.getAttribute("position");
  const normal = geometry.getAttribute("normal");
  const uv = new Float32Array(position.count * 2);
  for (let index = 0; index < position.count; index += 1) {
    _normal.fromBufferAttribute(normal, index);
    const x = position.getX(index);
    const y = position.getY(index);
    const z = position.getZ(index);
    const ax = Math.abs(_normal.x);
    const ay = Math.abs(_normal.y);
    const az = Math.abs(_normal.z);
    const [u, v] = ay >= ax && ay >= az ? [x, z] : ax >= az ? [z, y] : [x, y];
    uv[index * 2] = u;
    uv[index * 2 + 1] = v;
  }
  geometry.setAttribute("uv", new Float32BufferAttribute(uv, 2));
  return geometry;
}

/** Light grid: floors and the ground. */
export const floorMaterial = new MeshStandardMaterial({
  map: gridTexture(palette.floor, palette.gridLine),
  normalMap: grain,
  normalScale: new Vector2(0.18, 0.18),
  roughness: 0.62,
  metalness: 0,
});

/** Dark grid: walls, pillars, anything structural. */
export const structureMaterial = new MeshStandardMaterial({
  map: gridTexture(palette.structure, palette.gridLine),
  normalMap: grain,
  normalScale: new Vector2(0.18, 0.18),
  roughness: 0.7,
  metalness: 0,
});

/** The one saturated colour: things you can push, pick up or stand on. */
export const propMaterial = new MeshStandardMaterial({
  color: palette.accent,
  roughness: 0.45,
  metalness: 0,
});

/**
 * The hostiles. The combat mannequin ships a white shell, and at a top-down camera distance a
 * white figure and a white hero are the same silhouette — so every enemy wears this instead. It
 * replaces the material on the cloned rig, which is why the figure needs no second asset.
 */
export const hostileMaterial = new MeshStandardMaterial({
  color: 0xd0532a,
  roughness: 0.55,
  metalness: 0.1,
});

/** Torchlight: emissive on the flame, and the tint of the point light it hangs. */
export const flameMaterial = new MeshStandardMaterial({
  color: 0xffc27a,
  emissive: 0xffb066,
  emissiveIntensity: 2.4,
  roughness: 0.9,
});

/** Blade steel — the most metallic surface in the dungeon, so the swing catches the sun. */
export const bladeMaterial = new MeshStandardMaterial({
  color: 0xd8dde3,
  metalness: 0.75,
  roughness: 0.28,
});
