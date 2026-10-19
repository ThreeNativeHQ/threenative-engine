// Generated for you. Ordinary Three.js, and this is the storm's shape: the 64³ RGBA volume the
// cloud shader samples three times per step. Appearance lives here and in `tools/tempest-clouds.frag`
// — change the seed or the octave weights and every cloud in the storm changes with them.
import {
  Data3DTexture,
  LinearFilter,
  NoColorSpace,
  RGBAFormat,
  RepeatWrapping,
  UnsignedByteType,
} from "three";

/** Voxels per side. 64³ of RGBA is 1 MiB, and the source used exactly this. */
export const NOISE_SIZE = 64;

/**
 * The source's generator seed, as `const r=rng(13291)` inside `noiseVolume`. Written here rather
 * than taken from a caller because the sequence is this volume's identity: a different generator
 * makes a different storm, and the engine's seeded RNG is an LCG, not this mulberry32.
 */
export const SEED = 13291;

/** `function rng(seed=1)` verbatim from the source, so a given seed draws the same stream it did. */
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface INoiseVolume {
  /** RGBA voxels, x fastest then y then z. One byte each. */
  readonly data: Uint8Array;
  readonly texture: Data3DTexture;
}

interface ILattice {
  readonly n: number;
  readonly values: Float32Array;
}

/**
 * The source's four octave lattices — 4³, 8³, 16³, 32³ — each one random float per voxel, all drawn
 * from the same stream in this order. The order is the contract: it is what makes a given seed
 * reproduce a given storm, so it is written out rather than mapped over a list.
 */
function fillLattices(random: () => number): [ILattice, ILattice, ILattice, ILattice] {
  const lattice = (n: number): ILattice => {
    const values = new Float32Array(n * n * n);
    for (let index = 0; index < values.length; index += 1) values[index] = random();
    return { n, values };
  };
  return [lattice(4), lattice(8), lattice(16), lattice(32)];
}

/**
 * Trilinear value noise on one lattice, in `[0, 1)³`. Indices wrap at every face, which is what
 * makes the volume tile, and the fractional part is smoothed by `f²(3 − 2f)` so the lattice edges
 * do not show as creases in the cloud.
 */
function sampleLattice(lattice: ILattice, x: number, y: number, z: number): number {
  const { n, values } = lattice;
  const sx = x * n;
  const sy = y * n;
  const sz = z * n;
  const ix = Math.floor(sx);
  const iy = Math.floor(sy);
  const iz = Math.floor(sz);
  // The index is in range by construction — every component is folded into `[0, n)` above — so the
  // cast is about the type checker, not about a value that might be missing.
  const at = (a: number, b: number, c: number): number =>
    values[((c % n) * n + (b % n)) * n + (a % n)] as number;
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  const blend = (fx: number, fy: number, fz: number): number => {
    const smooth = (f: number): number => f * f * (3 - 2 * f);
    const tx = smooth(fx);
    const ty = smooth(fy);
    const tz = smooth(fz);
    return lerp(
      lerp(
        lerp(at(ix, iy, iz), at(ix + 1, iy, iz), tx),
        lerp(at(ix, iy + 1, iz), at(ix + 1, iy + 1, iz), tx),
        ty,
      ),
      lerp(
        lerp(at(ix, iy, iz + 1), at(ix + 1, iy, iz + 1), tx),
        lerp(at(ix, iy + 1, iz + 1), at(ix + 1, iy + 1, iz + 1), tx),
        ty,
      ),
      tz,
    );
  };
  return blend(sx - ix, sy - iy, sz - iz);
}

/**
 * Builds the volume the cloud shader samples. The four channels carry four different octave
 * combinations, which is why the shader reads `broad` from red, its billow detail from blue and the
 * rest as it goes: one texture, four scales, and the shader picks which mix it wants.
 *
 * Fails closed. The channel weights are the shader's contract — red is the broad shape the coverage
 * threshold is measured against — so a volume of the wrong length is a bug to stop on rather than a
 * texture to upload and watch read as transparent.
 */
export function createNoiseVolume(): INoiseVolume {
  const random = mulberry32(SEED);
  const [coarseLattice, mediumLattice, fineLattice, finestLattice] = fillLattices(random);
  const data = new Uint8Array(NOISE_SIZE * NOISE_SIZE * NOISE_SIZE * 4);
  const byte = (value: number): number => {
    const scaled = Math.round(255 * value);
    if (!(scaled >= 0 && scaled <= 255)) {
      throw new Error(`TN_NOISE_CHANNEL: ${value} does not fit a byte`);
    }
    return scaled;
  };
  let cursor = 0;
  for (let z = 0; z < NOISE_SIZE; z += 1) {
    for (let y = 0; y < NOISE_SIZE; y += 1) {
      for (let x = 0; x < NOISE_SIZE; x += 1) {
        const px = x / NOISE_SIZE;
        const py = y / NOISE_SIZE;
        const pz = z / NOISE_SIZE;
        const coarse = sampleLattice(coarseLattice, px, py, pz);
        const medium = sampleLattice(mediumLattice, px, py, pz);
        const fine = sampleLattice(fineLattice, px, py, pz);
        const finest = sampleLattice(finestLattice, px, py, pz);
        data[cursor] = byte(coarse * 0.74 + medium * 0.19 + fine * 0.07);
        data[cursor + 1] = byte(medium);
        data[cursor + 2] = byte(fine * 0.75 + finest * 0.25);
        data[cursor + 3] = byte(finest);
        cursor += 4;
      }
    }
  }
  if (cursor !== data.length) {
    throw new Error(`TN_NOISE_LENGTH: wrote ${cursor} bytes into a ${data.length}-byte volume`);
  }

  const texture = new Data3DTexture(data, NOISE_SIZE, NOISE_SIZE, NOISE_SIZE);
  texture.format = RGBAFormat;
  texture.type = UnsignedByteType;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  // Every face repeats: the shader drifts through the volume forever, and a clamped edge would put
  // a hard plane across the sky where the drift ran out of volume.
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.wrapR = RepeatWrapping;
  texture.unpackAlignment = 1;
  // The shader mixes the sampled values into its own lighting rather than reading them as colour, so
  // there is no transfer function to undo.
  texture.colorSpace = NoColorSpace;
  texture.needsUpdate = true;
  return { data, texture };
}
