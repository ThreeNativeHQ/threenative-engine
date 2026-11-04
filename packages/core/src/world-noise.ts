import {
  Data3DTexture,
  LinearFilter,
  NoColorSpace,
  RGBAFormat,
  RepeatWrapping,
  UnsignedByteType,
} from "three";
import { float, texture3D, vec3 } from "three/tsl";
import type { Node } from "three/webgpu";

/**
 * three's MaterialX Perlin (`mx_noise_float` on a vec3) evaluated per pixel costs about 400 ALU
 * operations a call. The Strata forest's ground made 44 calls a pixel: 10 ms of a 27 ms frame on an
 * RTX 2080, the foliage 4 ms more. Unreal's advice for its own Noise expression is the same as this
 * file: bake it into a texture and read that (UE 5.8.3: Engine/Source/Runtime/Engine/Classes/
 * Materials/MaterialExpressionNoise.h:58, "can be expensive to compute").
 *
 * The volume holds that exact noise: the same Bob Jenkins hash, the same twelve gradients, the same
 * quintic fade and 0.982 scale, with the integer lattice wrapped every {@link NOISE_PERIOD} cells so
 * the volume tiles. Inside the first period the baked value at a texel centre is three's value; the
 * texture filter interpolates between centres {@link NOISE_TEXELS} to a lattice cell apart. Each
 * channel is an independent field (the lattice is hashed at a different z offset).
 */
export const NOISE_PERIOD = 8;
/** Texels per lattice cell: a cell holds the fade's S-curve in eight linear steps. */
export const NOISE_TEXELS = 8;
const SIZE = NOISE_PERIOD * NOISE_TEXELS;

const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

/** `mx_hash_int(x, y, z)`: Bob Jenkins' lookup3 final mix over three ints, as uint32. */
export function mxHashInt3(x: number, y: number, z: number): number {
  const seed = (0xdeadbeef + (3 << 2) + 13) >>> 0;
  let a = (seed + x) >>> 0;
  let b = (seed + y) >>> 0;
  let c = (seed + z) >>> 0;
  c = ((c ^ b) - rotl(b, 14)) >>> 0;
  a = ((a ^ c) - rotl(c, 11)) >>> 0;
  b = ((b ^ a) - rotl(a, 25)) >>> 0;
  c = ((c ^ b) - rotl(b, 16)) >>> 0;
  a = ((a ^ c) - rotl(c, 4)) >>> 0;
  b = ((b ^ a) - rotl(a, 14)) >>> 0;
  c = ((c ^ b) - rotl(b, 24)) >>> 0;
  return c;
}

/** `mx_gradient_float(hash, x, y, z)`, linear in (x, y, z): returned as its gradient vector. */
function gradient(hash: number): [number, number, number] {
  const h = hash & 15;
  const at = (x: number, y: number, z: number): number => {
    const u = h < 8 ? x : y;
    const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
    return ((h & 1) !== 0 ? -u : u) + ((h & 2) !== 0 ? -v : v);
  };
  return [at(1, 0, 0), at(0, 1, 0), at(0, 0, 1)];
}

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/**
 * `mx_perlin_noise_float(p)` with the lattice wrapped every `period` cells and hashed at `zOffset`.
 * With an unwrapped lattice (`period` = 2^31) and `zOffset` 0 it is three's function.
 */
export function mxPerlin3(x: number, y: number, z: number, period = 2 ** 31, zOffset = 0): number {
  const X = Math.floor(x);
  const Y = Math.floor(y);
  const Z = Math.floor(z);
  const fx = x - X;
  const fy = y - Y;
  const fz = z - Z;
  const wrap = (i: number): number => ((i % period) + period) % period;
  const corner = (dx: number, dy: number, dz: number): number => {
    const [gx, gy, gz] = gradient(
      mxHashInt3(wrap(X + dx) | 0, wrap(Y + dy) | 0, (wrap(Z + dz) + zOffset) | 0),
    );
    return gx * (fx - dx) + gy * (fy - dy) + gz * (fz - dz);
  };
  const u = fade(fx);
  const v = fade(fy);
  const w = fade(fz);
  const lerp = (a: number, b: number, t: number): number => a * (1 - t) + b * t;
  const result = lerp(
    lerp(lerp(corner(0, 0, 0), corner(1, 0, 0), u), lerp(corner(0, 1, 0), corner(1, 1, 0), u), v),
    lerp(lerp(corner(0, 0, 1), corner(1, 0, 1), u), lerp(corner(0, 1, 1), corner(1, 1, 1), u), v),
    w,
  );
  return 0.982 * result;
}

/**
 * The baked RGBA volume, SIZE³ texels, x fastest. Texel i of an axis sits at lattice coordinate
 * (i + 0.5) / NOISE_TEXELS, the centre the linear filter returns unblended. Gradients are hashed once
 * per lattice corner, so the bake is eight dot products and a trilinear blend per texel and channel.
 */
export function bakeNoiseVolume(): Uint8Array {
  const corners = NOISE_PERIOD ** 3;
  const grads = new Float32Array(4 * corners * 3);
  for (let channel = 0; channel < 4; channel += 1)
    for (let z = 0; z < NOISE_PERIOD; z += 1)
      for (let y = 0; y < NOISE_PERIOD; y += 1)
        for (let x = 0; x < NOISE_PERIOD; x += 1) {
          const g = gradient(mxHashInt3(x, y, z + channel * 1031));
          grads.set(
            g,
            ((channel * NOISE_PERIOD + z) * NOISE_PERIOD + y) * NOISE_PERIOD * 3 + x * 3,
          );
        }
  const frac = new Float32Array(NOISE_TEXELS);
  const weight = new Float32Array(NOISE_TEXELS);
  for (let i = 0; i < NOISE_TEXELS; i += 1) {
    frac[i] = (i + 0.5) / NOISE_TEXELS;
    weight[i] = fade(frac[i] as number);
  }
  const data = new Uint8Array(SIZE ** 3 * 4);
  const P = NOISE_PERIOD;
  for (let tz = 0; tz < SIZE; tz += 1) {
    const Z = Math.floor(tz / NOISE_TEXELS);
    const fz = frac[tz % NOISE_TEXELS] as number;
    const w = weight[tz % NOISE_TEXELS] as number;
    for (let ty = 0; ty < SIZE; ty += 1) {
      const Y = Math.floor(ty / NOISE_TEXELS);
      const fy = frac[ty % NOISE_TEXELS] as number;
      const v = weight[ty % NOISE_TEXELS] as number;
      for (let tx = 0; tx < SIZE; tx += 1) {
        const X = Math.floor(tx / NOISE_TEXELS);
        const fx = frac[tx % NOISE_TEXELS] as number;
        const u = weight[tx % NOISE_TEXELS] as number;
        for (let channel = 0; channel < 4; channel += 1) {
          const base = channel * P;
          const z0 = (base + Z) * P;
          const z1 = (base + ((Z + 1) % P)) * P;
          const y0 = Y;
          const y1 = (Y + 1) % P;
          const x0 = X * 3;
          const x1 = ((X + 1) % P) * 3;
          const dot = (zy: number, xi: number, dx: number, dy: number, dz: number): number => {
            const at = zy * P * 3 + xi;
            return (
              (grads[at] as number) * (fx - dx) +
              (grads[at + 1] as number) * (fy - dy) +
              (grads[at + 2] as number) * (fz - dz)
            );
          };
          const c000 = dot(z0 + y0, x0, 0, 0, 0);
          const c100 = dot(z0 + y0, x1, 1, 0, 0);
          const c010 = dot(z0 + y1, x0, 0, 1, 0);
          const c110 = dot(z0 + y1, x1, 1, 1, 0);
          const c001 = dot(z1 + y0, x0, 0, 0, 1);
          const c101 = dot(z1 + y0, x1, 1, 0, 1);
          const c011 = dot(z1 + y1, x0, 0, 1, 1);
          const c111 = dot(z1 + y1, x1, 1, 1, 1);
          const x00 = c000 + (c100 - c000) * u;
          const x10 = c010 + (c110 - c010) * u;
          const x01 = c001 + (c101 - c001) * u;
          const x11 = c011 + (c111 - c011) * u;
          const n = 0.982 * ((x00 + (x10 - x00) * v) * (1 - w) + (x01 + (x11 - x01) * v) * w);
          data[((tz * SIZE + ty) * SIZE + tx) * 4 + channel] = Math.max(
            0,
            Math.min(255, Math.round((n * 0.5 + 0.5) * 255)),
          );
        }
      }
    }
  }
  return data;
}

let shared: Data3DTexture | undefined;

/**
 * The one volume every material shares: baked on first use, 1 MiB of RGBA8 (it stays in L2).
 *
 * @situation a material needs the raw baked noise texture to sample in its own TSL
 * @constraint baked once per page on the main thread (about 0.15 s); every channel is an independent field
 * @example const volume = noiseVolume();
 */
export function noiseVolume(): Data3DTexture {
  if (shared) return shared;
  const volume = new Data3DTexture(bakeNoiseVolume(), SIZE, SIZE, SIZE);
  volume.format = RGBAFormat;
  volume.type = UnsignedByteType;
  volume.minFilter = LinearFilter;
  volume.magFilter = LinearFilter;
  volume.wrapS = volume.wrapT = volume.wrapR = RepeatWrapping;
  volume.unpackAlignment = 1;
  volume.colorSpace = NoColorSpace;
  volume.needsUpdate = true;
  shared = volume;
  return volume;
}

type Scalar = Node<"float"> | number;

/**
 * Drop-in for `mx_noise_float(p, amplitude, pivot)` on a vec3 `p`: one filtered read of the baked
 * volume instead of the per-pixel Perlin. Only the 3D form: three's 2D Perlin is another function
 * (0.66 scale), so a vec2 caller keeps `mx_noise_float`. `channel` 1 to 3 are independent fields.
 *
 * @situation a terrain, foliage or water shader calls mx_noise_float per pixel and the frame is GPU bound
 * @situation open world ground material with procedural variation that must hold 60 FPS
 * @constraint the field tiles every NOISE_PERIOD units of p; at p = world metres x 2.6 that is a 3 m repeat
 * @constraint vec3 input only: three's 2D Perlin is another function
 * @override keep mx_noise_float where exact analytic noise matters more than the frame
 * @example const patch = smoothstep(-0.35, 0.35, bakedNoise(positionWorld.mul(0.025)));
 */
export function bakedNoise(
  p: Node<"vec3">,
  amplitude: Scalar = 1,
  pivot: Scalar = 0,
  channel: 0 | 1 | 2 | 3 = 0,
): Node<"float"> {
  const sampled = texture3D(noiseVolume(), vec3(p).div(NOISE_PERIOD));
  const lane = (["r", "g", "b", "a"] as const)[channel];
  return sampled[lane].mul(2).sub(1).mul(amplitude).add(pivot) as Node<"float">;
}

/**
 * Drop-in for `mx_fractal_noise_float(p, octaves, lacunarity, diminish, amplitude)`: one read an octave.
 *
 * @situation fractal or fbm noise in a material costs too much GPU time per pixel
 * @constraint octaves is a build-time number; each octave is one filtered volume read
 * @example const macro = bakedFractalNoise(vec3(positionWorld.x, 0, positionWorld.z).mul(0.014), 3);
 */
export function bakedFractalNoise(
  p: Node<"vec3">,
  octaves = 3,
  lacunarity = 2,
  diminish = 0.5,
  amplitude: Scalar = 1,
): Node<"float"> {
  let sum: Node<"float"> = float(0);
  let scale = 1;
  let weight = 1;
  for (let octave = 0; octave < octaves; octave += 1) {
    sum = sum.add(bakedNoise(scale === 1 ? p : p.mul(scale)).mul(weight));
    scale *= lacunarity;
    weight *= diminish;
  }
  return sum.mul(amplitude);
}
