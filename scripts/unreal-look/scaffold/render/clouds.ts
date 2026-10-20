// Model references (UE 5.8.3): Engine/Shaders/Private/VolumetricCloud.usf and
// VolumetricCloudCommon.ush (volume transport, dual HG, scattering octaves, aerial perspective);
// Engine/Source/Runtime/Engine/Private/Components/VolumetricCloudComponent.cpp (km defaults).
// Independent CPU implementation; material coverage/scale are inferred from the L9 reference PNGs.
import {
  BOTTOM_KM,
  CAMERA_KM,
  MIE_ABSORB,
  MIE_SCATTER,
  RAYLEIGH,
  type Rgb,
  sunTransmittance,
} from "./atmosphere.js";

const PLANET = BOTTOM_KM;
export const CLOUD_BOTTOM_KM = 5;
export const CLOUD_TOP_KM = 15;
const CAMERA = PLANET + CAMERA_KM;
export const EXTINCTION = 3; // per km; the inaccessible simple material's density is an approximation
const clamp = (v: number): number => Math.max(0, Math.min(1, v));
const smooth = (v: number): number => {
  const t = clamp(v);
  return t * t * (3 - 2 * t);
};

/** Seeded periodic value noise: a 32-cell lattice, smoothly interpolated on all three axes. */
export function cloudNoiseLattice(seed = 631): Float32Array {
  const lattice = new Float32Array(32 ** 3);
  let state = seed | 0;
  for (let i = 0; i < lattice.length; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) | 0;
    lattice[i] = (state >>> 0) / 4294967296;
  }
  return lattice;
}

export function cloudDensityField(seed = 631): (x: number, y: number, z: number) => number {
  const lattice = cloudNoiseLattice(seed);
  const at = (x: number, y: number, z: number): number =>
    lattice[((z & 31) * 32 + (y & 31)) * 32 + (x & 31)] ?? 0;
  const noise = (x: number, y: number, z: number): number => {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const iz = Math.floor(z);
    const u = smooth(x - ix);
    const v = smooth(y - iy);
    const w = smooth(z - iz);
    const a = at(ix, iy, iz) * (1 - u) + at(ix + 1, iy, iz) * u;
    const b = at(ix, iy + 1, iz) * (1 - u) + at(ix + 1, iy + 1, iz) * u;
    const c = at(ix, iy, iz + 1) * (1 - u) + at(ix + 1, iy, iz + 1) * u;
    const d = at(ix, iy + 1, iz + 1) * (1 - u) + at(ix + 1, iy + 1, iz + 1) * u;
    return (a * (1 - v) + b * v) * (1 - w) + (c * (1 - v) + d * v) * w;
  };
  return (x, y, z) => {
    const altitude = Math.hypot(x, y, z) - PLANET;
    if (altitude <= CLOUD_BOTTOM_KM || altitude >= CLOUD_TOP_KM) return 0;
    const h = (altitude - CLOUD_BOTTOM_KM) / (CLOUD_TOP_KM - CLOUD_BOTTOM_KM);
    const profile = smooth(h / 0.08) * (1 - smooth((h - 0.2) / 0.55));
    const broad = noise(x / 2, altitude / 3, z / 2);
    const detail = noise(x / 0.35, altitude / 0.7, z / 0.35);
    return clamp((broad - 0.47 - 0.18 * (1 - detail)) * 5) * profile;
  };
}

/** Beer–Lambert transmission for a nonnegative optical depth. */
export const cloudTransmittance = (depth: number): number => Math.exp(-Math.max(0, depth));
const hg = (cosine: number, g: number): number =>
  (1 - g * g) / (4 * Math.PI * (1 + g * g - 2 * g * cosine) ** 1.5);
const sphereExit = (r: number, mu: number, radius: number): number =>
  -r * mu + Math.sqrt(r * r * mu * mu + radius * radius - r * r);

/** Composite in place, in bakeSkyRadiance's radiance per unit sun illuminance; no DOM or GPU. */
export function bakeCloudRadiance(
  radiance: Float32Array,
  sun: { x: number; y: number; z: number },
  width: number,
  height: number,
  seed = 631,
): void {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    radiance.length !== width * height * 3 ||
    !Number.isFinite(seed) ||
    !(Math.abs(Math.hypot(sun.x, sun.y, sun.z) - 1) <= 0.001)
  ) {
    throw new Error(
      "Cloud bake requires matching positive dimensions, a finite seed and a unit sun",
    );
  }
  const density = cloudDensityField(seed);
  const sunlight = sunTransmittance(Math.asin(Math.max(-1, Math.min(1, sun.y))));
  const ambient = [0, 0, 0];
  let weights = 0;
  for (let y = 0; y < height / 2; y += 1) {
    const theta = ((y + 0.5) / height) * Math.PI;
    const weight = Math.sin(theta) * Math.max(0, Math.cos(theta));
    for (let x = 0; x < width; x += 1) {
      for (let c = 0; c < 3; c += 1)
        ambient[c] = (ambient[c] ?? 0) + (radiance[(y * width + x) * 3 + c] ?? 0) * weight;
      weights += weight;
    }
  }
  for (let c = 0; c < 3; c += 1) ambient[c] = (ambient[c] ?? 0) / Math.max(weights, 1e-9);
  for (let y = 0; y < height / 2; y += 1) {
    const elevation = Math.PI / 2 - ((y + 0.5) / height) * Math.PI;
    const dy = Math.sin(elevation);
    const horizontal = Math.cos(elevation);
    const entry = sphereExit(CAMERA, dy, PLANET + CLOUD_BOTTOM_KM);
    if (entry > 350) continue;
    const length = Math.min(50, sphereExit(CAMERA, dy, PLANET + CLOUD_TOP_KM) - entry);
    const dt = length / 32;
    // shortcut: integrate the clear-air column to layer entry, not per cloud sample; upgrade for airborne cameras.
    const airDepth = [0, 0, 0];
    for (let i = 0; i < 8; i += 1) {
      const t = (entry * (i + 0.5)) / 8;
      const h = Math.hypot(horizontal * t, CAMERA + dy * t) - PLANET;
      for (let c = 0; c < 3; c += 1)
        airDepth[c] =
          (airDepth[c] ?? 0) +
          (((RAYLEIGH[c as 0 | 1 | 2] ?? 0) * Math.exp(-h / 8) +
            (MIE_SCATTER + MIE_ABSORB) * Math.exp(-h / 1.2)) *
            entry) /
            8;
    }
    for (let x = 0; x < width; x += 1) {
      const azimuth = ((x + 0.5) / width - 0.5) * 2 * Math.PI;
      const dx = horizontal * Math.cos(azimuth);
      const dz = horizontal * Math.sin(azimuth);
      const cosine = dx * sun.x + dy * sun.y + dz * sun.z;
      const phase = 0.8 * hg(cosine, 0.65) + 0.2 * hg(cosine, -0.2);
      let through = 1;
      const light = [0, 0, 0];
      for (let i = 0; i < 32 && through > 0.005; i += 1) {
        const t = entry + (i + 0.5) * dt;
        const px = dx * t;
        const py = CAMERA + dy * t;
        const pz = dz * t;
        const extinction = density(px, py, pz) * EXTINCTION;
        if (extinction === 0) continue;
        const r = Math.hypot(px, py, pz);
        const shadowLength = Math.min(
          15,
          sphereExit(r, (px * sun.x + py * sun.y + pz * sun.z) / r, PLANET + CLOUD_TOP_KM),
        );
        let shadowDepth = 0;
        for (let j = 0; j < 6; j += 1) {
          const s = shadowLength * ((j + 0.5) / 6) ** 2;
          const ds = (shadowLength * (2 * j + 1)) / 36;
          shadowDepth += density(px + sun.x * s, py + sun.y * s, pz + sun.z * s) * EXTINCTION * ds;
        }
        const stepT = cloudTransmittance(extinction * dt);
        let direct = 0;
        let scatter = 1;
        let attenuation = 1;
        let anisotropy = 1;
        for (let octave = 0; octave < 3; octave += 1) {
          direct +=
            scatter *
            cloudTransmittance(shadowDepth * attenuation) *
            (1 / (4 * Math.PI) + (phase - 1 / (4 * Math.PI)) * anisotropy);
          scatter *= 0.5 ** (2 ** octave);
          attenuation *= 0.5 ** (2 ** octave);
          anisotropy *= 0.5 ** (2 ** octave);
        }
        const h = (r - PLANET - CLOUD_BOTTOM_KM) / (CLOUD_TOP_KM - CLOUD_BOTTOM_KM);
        for (let c = 0; c < 3; c += 1) {
          const source =
            direct * (sunlight[c as 0 | 1 | 2] ?? 0) + (ambient[c] ?? 0) * (0.5 + 0.5 * clamp(h));
          light[c] = (light[c] ?? 0) + through * (1 - stepT) * 0.98 * source;
        }
        through *= stepT;
      }
      for (let c = 0; c < 3; c += 1) {
        const at = (y * width + x) * 3 + c;
        const sky = radiance[at] ?? 0;
        radiance[at] =
          sky + Math.exp(-(airDepth[c] ?? 0)) * ((light[c] ?? 0) - sky * (1 - through));
      }
    }
  }
}
