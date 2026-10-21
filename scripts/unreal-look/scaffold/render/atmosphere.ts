// Harness overlay (PRD-632 / PRD-633): the sky the sun lights, in the sun's own units.
//
// Unreal's default level draws its sky from the Sky Atmosphere, lights the scene with a Sky Light
// that captures it, and tints the sun by the air the sun passes through. All three read ONE sun
// illuminance, so the sun-to-sky ratio is a consequence of the model and not a constant. This file
// ports that model: single scattering with Rayleigh and Mie phase functions, an ozone absorption
// layer, a ground bounce, and the isotropic multiple-scattering approximation (Hillaire, "A
// Scalable and Production Ready Sky and Atmosphere Rendering Technique", EGSR 2020, the paper the
// Unreal atmosphere implements). Coefficients are Unreal 5.8.3's defaults, read from
// Engine/Source/Runtime/Engine/Private/Components/SkyAtmosphereComponent.cpp:95-128 and checked
// against tools/unreal-reference/template-actors.json. The integration structure follows
// Engine/Shaders/Private/SkyAtmosphere.usf (IntegrateSingleScatteredLuminance and the multiple
// scattering pass) and the phase functions in ParticipatingMediaCommon.ush.
//
// Units: every radiance below is per unit sun illuminance (1.0 outside the atmosphere). Multiply
// by the sun's illuminance in the scene's light units (lighting.ts) to get scene radiance, so the
// sun and the sky can never disagree about exposure.
//
// Plain numbers and no `three` import: the same code runs under node for the unit check.
// ponytail: direct numerical integration at load (about a second at 256x128). A transmittance LUT,
// or core's `SkyCapture` once its sky-view LUT is physical, replaces the inner loops.

export type Rgb = readonly [number, number, number];
type Vec3 = readonly [number, number, number];

export const BOTTOM_KM = 6360;
export const TOP_KM = 6420;
export const RAYLEIGH: Rgb = [0.005802, 0.013558, 0.0331]; // per km at sea level
export const MIE_SCATTER = 0.003996;
export const MIE_ABSORB = 0.000444;
export const OZONE: Rgb = [0.00065, 0.001881, 0.000085];
export const MIE_G = 0.8;
export const GROUND_ALBEDO = 0.4; // 170/255 sRGB, linear
export const CAMERA_KM = 0.06; // the reference floor sits 60 m above the planet top
const FOUR_PI = 4 * Math.PI;

const rayleighPhase = (c: number): number => (3 / (16 * Math.PI)) * (1 + c * c);
const hgPhase = (c: number): number =>
  (1 - MIE_G * MIE_G) / (FOUR_PI * (1 + MIE_G * MIE_G - 2 * MIE_G * c) ** 1.5);

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

interface IMedium {
  ray: Rgb;
  mie: number;
  ext: Rgb;
}

export function medium(h: number): IMedium {
  const ray = Math.exp(-h / 8);
  const mie = Math.exp(-h / 1.2);
  const ozone = Math.max(0, Math.min(1, h < 25 ? h / 15 - 2 / 3 : -h / 15 + 8 / 3));
  const e = (i: 0 | 1 | 2): number =>
    RAYLEIGH[i] * ray + (MIE_SCATTER + MIE_ABSORB) * mie + OZONE[i] * ozone;
  return {
    ray: [RAYLEIGH[0] * ray, RAYLEIGH[1] * ray, RAYLEIGH[2] * ray],
    mie: MIE_SCATTER * mie,
    ext: [e(0), e(1), e(2)],
  };
}

/** Distance from a point at radius `r`, heading with cosine `mu` to the local up, to a sphere. */
function hitSphere(r: number, mu: number, radius: number, far: boolean): number | undefined {
  const b = r * mu;
  const disc = b * b - (r * r - radius * radius);
  if (disc < 0) return undefined;
  const t = far ? -b + Math.sqrt(disc) : -b - Math.sqrt(disc);
  return t >= 0 ? t : undefined;
}

const STEPS_LIGHT = 16;

/** Optical depth from a point to the top of the atmosphere; undefined when the planet blocks the way. */
function opticalDepthToTop(r: number, mu: number): Rgb | undefined {
  if (mu < 0 && hitSphere(r, mu, BOTTOM_KM, false) !== undefined) return undefined;
  const length = hitSphere(r, mu, TOP_KM, true) ?? 0;
  const sum: [number, number, number] = [0, 0, 0];
  let previous = 0;
  for (let i = 1; i <= STEPS_LIGHT; i += 1) {
    const t = (length * i * i) / (STEPS_LIGHT * STEPS_LIGHT); // quadratic: the dense air is first
    const mid = (previous + t) / 2;
    const m = medium(Math.max(0, Math.sqrt(r * r + 2 * r * mu * mid + mid * mid) - BOTTOM_KM));
    const dt = t - previous;
    for (let c = 0; c < 3; c += 1) sum[c] = (sum[c] ?? 0) + m.ext[c as 0 | 1 | 2] * dt;
    previous = t;
  }
  return sum;
}

/** Fraction of the sun's illuminance that reaches the ground, per channel. */
export function sunTransmittance(elevationRad: number): Rgb {
  const depth = opticalDepthToTop(BOTTOM_KM + CAMERA_KM, Math.sin(elevationRad));
  if (depth === undefined) return [0, 0, 0];
  return [Math.exp(-depth[0]), Math.exp(-depth[1]), Math.exp(-depth[2])];
}

/** Fraction of the sun's illuminance that reaches radius `r` where the sun's cosine to local up is `mu`. */
export function transmittanceToTop(r: number, mu: number): Rgb {
  const depth = opticalDepthToTop(r, mu);
  if (depth === undefined) return [0, 0, 0];
  return [Math.exp(-depth[0]), Math.exp(-depth[1]), Math.exp(-depth[2])];
}

type Multi = (heightKm: number, cosSun: number) => Rgb;

interface IGather {
  radiance: [number, number, number];
  /** Integral of the scattering coefficient along the ray, attenuated: the transfer factor. */
  transfer: [number, number, number];
}

/**
 * One view ray from (0, r0, 0) along `dir`, the planet at the origin and `sun` a unit vector.
 * `iso` swaps the phase functions for the isotropic one, as the multiple-scattering pass does.
 * `multi` adds the multiple-scattering luminance at each sample.
 */
function march(
  r0: number,
  dir: Vec3,
  sun: Vec3,
  iso: boolean,
  multi: Multi | undefined,
  ground = iso,
): IGather {
  const out: IGather = { radiance: [0, 0, 0], transfer: [0, 0, 0] };
  const mu0 = dir[1];
  const groundT = mu0 < 0 ? hitSphere(r0, mu0, BOTTOM_KM, false) : undefined;
  const tMax = groundT ?? hitSphere(r0, mu0, TOP_KM, true) ?? 0;
  const cosView = dot(dir, sun);
  const phaseRay = iso ? 1 / FOUR_PI : rayleighPhase(cosView);
  const phaseMie = iso ? 1 / FOUR_PI : hgPhase(cosView);
  const through: [number, number, number] = [1, 1, 1];
  const steps = 48;
  let previous = 0;
  const at = (t: number): Vec3 => [dir[0] * t, r0 + dir[1] * t, dir[2] * t];
  for (let i = 1; i <= steps; i += 1) {
    const t = (tMax * i * i) / (steps * steps);
    const mid = (previous + t) / 2;
    const dt = t - previous;
    const p = at(mid);
    const rr = Math.hypot(p[0], p[1], p[2]);
    const cosSun = dot(p, sun) / rr;
    const m = medium(Math.max(0, rr - BOTTOM_KM));
    const depth = opticalDepthToTop(rr, cosSun);
    const ms = multi?.(Math.max(0, rr - BOTTOM_KM), cosSun);
    for (let c = 0; c < 3; c += 1) {
      const k = c as 0 | 1 | 2;
      const e = m.ext[k];
      const scatter = m.ray[k] + m.mie;
      const stepT = Math.exp(-e * dt);
      let source = 0;
      if (depth !== undefined)
        source += Math.exp(-depth[k]) * (m.ray[k] * phaseRay + m.mie * phaseMie);
      if (ms !== undefined) source += ms[k] * scatter;
      const integral = e > 1e-12 ? (1 - stepT) / e : dt;
      out.radiance[c] = (out.radiance[c] ?? 0) + (through[c] ?? 1) * source * integral;
      out.transfer[c] = (out.transfer[c] ?? 0) + (through[c] ?? 1) * scatter * integral;
      through[c] = (through[c] ?? 1) * stepT;
    }
    previous = t;
  }
  // The sky pass draws no ground luminance (Unreal's sky render passes Ground = false), so the nadir
  // is only the in-scatter up to the planet, near black. The multiple-scattering pass does bounce
  // light off the ground (Ground = true), so `iso` keeps it.
  if (ground && groundT !== undefined) {
    const p = at(groundT);
    const rr = Math.hypot(p[0], p[1], p[2]);
    const cosSun = dot(p, sun) / rr;
    const depth = opticalDepthToTop(rr, cosSun);
    if (depth !== undefined && cosSun > 0)
      for (let c = 0; c < 3; c += 1)
        out.radiance[c] =
          (out.radiance[c] ?? 0) +
          (through[c] ?? 1) * Math.exp(-depth[c as 0 | 1 | 2]) * cosSun * (GROUND_ALBEDO / Math.PI);
  }
  return out;
}

/**
 * Multiple-scattering luminance per unit scattering coefficient, by altitude and the cosine
 * between the local up and the sun: Psi = L2 / (1 - f), the isotropic infinite-bounce sum.
 * Unreal gathers L2 and f from two rays only, straight up and straight down (the shipped "cheap"
 * approximation in RenderMultiScatteredLuminanceLutCS); the full sphere gather overestimated the
 * ground bounce against the Unreal frames by up to 1.6x, so this uses the same two rays.
 */
function multipleScatteringTable(): Multi {
  const nh = 12;
  const nc = 16;
  const dirs: Vec3[] = [
    [0, 1, 0],
    [0, -1, 0],
  ];
  const table: Rgb[] = [];
  for (let ih = 0; ih < nh; ih += 1) {
    const h = ((ih + 0.5) / nh) ** 2 * (TOP_KM - BOTTOM_KM);
    for (let ic = 0; ic < nc; ic += 1) {
      const cosSun = -1 + (2 * (ic + 0.5)) / nc;
      const sun: Vec3 = [Math.sqrt(1 - cosSun * cosSun), cosSun, 0];
      const sum = [0, 0, 0];
      const transfer = [0, 0, 0];
      for (const dir of dirs) {
        const ray = march(BOTTOM_KM + h, dir, sun, true, undefined);
        for (let c = 0; c < 3; c += 1) {
          sum[c] = (sum[c] ?? 0) + (ray.radiance[c] ?? 0);
          transfer[c] = (transfer[c] ?? 0) + (ray.transfer[c] ?? 0);
        }
      }
      table.push(
        [0, 1, 2].map((c) => {
          const l2 = (sum[c] ?? 0) / dirs.length;
          const f = Math.min(0.99, (transfer[c] ?? 0) / dirs.length);
          return l2 / (1 - f);
        }) as unknown as Rgb,
      );
    }
  }
  return (h, cosSun) => {
    const u = Math.min(
      nh - 1,
      Math.max(0, Math.sqrt(Math.max(0, h) / (TOP_KM - BOTTOM_KM)) * nh - 0.5),
    );
    const v = Math.min(nc - 1, Math.max(0, ((cosSun + 1) / 2) * nc - 0.5));
    const [u0, v0] = [Math.floor(u), Math.floor(v)];
    const [u1, v1] = [Math.min(nh - 1, u0 + 1), Math.min(nc - 1, v0 + 1)];
    const [fu, fv] = [u - u0, v - v0];
    const cell = (i: number, j: number): Rgb => table[i * nc + j] as Rgb;
    return [0, 1, 2].map((c) => {
      const k = c as 0 | 1 | 2;
      const a = cell(u0, v0)[k] * (1 - fv) + cell(u0, v1)[k] * fv;
      const b = cell(u1, v0)[k] * (1 - fv) + cell(u1, v1)[k] * fv;
      return a * (1 - fu) + b * fu;
    }) as unknown as Rgb;
  };
}

/**
 * Unreal's distant sky light: the mean radiance over the whole sphere seen from `altitudeKm`
 * (r.SkyAtmosphere.DistantSkyLightLUT.Altitude, 6 km), isotropic phase, no ground bounce, the
 * multiple-scattering term included (RenderDistantSkyLightLutCS in
 * Engine/Shaders/Private/SkyAtmosphere.usf). Height fog and volumetric clouds both light with it
 * (GetViewDistanceSkyLightColor). Per unit sun illuminance, like `bakeSkyRadiance`.
 */
export const DISTANT_SKY_LIGHT_ALTITUDE_KM = 6;
export function distantSkyLight(toSun: { x: number; y: number; z: number }): Rgb {
  const sun: Vec3 = [toSun.x, toSun.y, toSun.z];
  const multi = multipleScatteringTable();
  const count = 64;
  const sum: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < count; i += 1) {
    const y = 1 - (2 * (i + 0.5)) / count;
    const ring = Math.sqrt(1 - y * y);
    const phi = i * Math.PI * (3 - Math.sqrt(5));
    const dir: Vec3 = [Math.cos(phi) * ring, y, Math.sin(phi) * ring];
    const ray = march(BOTTOM_KM + DISTANT_SKY_LIGHT_ALTITUDE_KM, dir, sun, true, multi, false);
    for (let c = 0; c < 3; c += 1) sum[c] = (sum[c] ?? 0) + (ray.radiance[c] ?? 0) / count;
  }
  return sum;
}

/**
 * Measured, not derived: the fixed-exposure Unreal L3 void (height fog fogged to opaque, so it is
 * the fog's inscattering colour and nothing else) over `distantSkyLight`, per channel, through the
 * same tone curve (no gamut expansion, as a fresh Unreal frame has none). 0.739 / 0.871 / 0.954 at a 60
 * degree sun and 0.782 / 0.871 / 0.928 at 15, so one constant holds across the sun within 1.6 levels. The clear sky matches the Unreal L2 frame within a few levels
 * with no such factor, so the cause sits in how Unreal builds this one light. Cloud ambient and
 * fog both read it, as in Unreal (GetViewDistanceSkyLightColor).
 */
export const VIEW_DISTANCE_SKY_LIGHT_FIT: Rgb = [0.76, 0.871, 0.941];

/** The light height fog and clouds take from the sky, per unit sun illuminance. */
export function viewDistanceSkyLight(toSun: { x: number; y: number; z: number }): Rgb {
  const light = distantSkyLight(toSun);
  return [0, 1, 2].map(
    (c) => (light[c] ?? 0) * (VIEW_DISTANCE_SKY_LIGHT_FIT[c] ?? 1),
  ) as unknown as Rgb;
}

/**
 * Sky radiance per unit sun illuminance on an equirectangular grid in three's layout: row 0 is the
 * zenith, the middle row the horizon, the last row the nadir (dark: no ground luminance, as in Unreal's sky pass), and u = atan2(z, x) /
 * 2pi + 0.5. `sun` is the unit direction toward the sun, y up.
 */
export function bakeSkyRadiance(
  toSun: { x: number; y: number; z: number },
  width: number,
  height: number,
): Float32Array {
  const sun: Vec3 = [toSun.x, toSun.y, toSun.z];
  const multi = multipleScatteringTable();
  const data = new Float32Array(width * height * 3);
  const r0 = BOTTOM_KM + CAMERA_KM;
  for (let y = 0; y < height; y += 1) {
    const elevation = Math.PI / 2 - ((y + 0.5) / height) * Math.PI;
    for (let x = 0; x < width; x += 1) {
      // three's equirectangular lookup: u = atan2(z, x) / 2pi + 0.5.
      const azimuth = ((x + 0.5) / width - 0.5) * 2 * Math.PI;
      const dir: Vec3 = [
        Math.cos(azimuth) * Math.cos(elevation),
        Math.sin(elevation),
        Math.sin(azimuth) * Math.cos(elevation),
      ];
      const ray = march(r0, dir, sun, false, multi);
      const o = (y * width + x) * 3;
      data[o] = ray.radiance[0];
      data[o + 1] = ray.radiance[1];
      data[o + 2] = ray.radiance[2];
    }
  }
  return data;
}

/** The default level's sun: 6 lux, 6500 K (tools/unreal-reference/template-actors.json, every sun). */
export const SUN_LUX = 6;
export const SUN_KELVIN = 6500;

/**
 * The sun in three's light units. Unreal renders a lit diffuse surface as albedo x lux x cos(theta);
 * three's Lambert BRDF carries a 1/pi, so the same lux is pi times as large here. Measured on the
 * Unreal L1 cells (no atmosphere, scene-linear EXR): a 0.18 floor under the 60 degree sun reads
 * 0.874 luminance, within 7% of 0.18 x 6 x sin(60 deg) = 0.935 (the residual is checked on the
 * engine's own L1 capture).
 */
export const SUN_ILLUMINANCE = SUN_LUX * Math.PI;

/**
 * Emissive in the sun's units. Unreal shades a lit diffuse surface as albedo / pi x lux x cos(theta)
 * (Diffuse_Lambert, Engine/Shaders/Private/BRDF.ush:157, used at Engine/Shaders/Private/
 * ShadingModels.ush:260-262) and adds a material's emissive as it stands: the glTF importer only
 * multiplies texture, factor and strength (Engine/Plugins/Interchange/Runtime/Source/Import/Private/
 * Gltf/InterchangeGLTFMaterial.cpp:481-487). Emissive 5 therefore outshines a white surface under the
 * 6 lux sun by 5 / (6 / pi) = 2.6x. `SUN_ILLUMINANCE` carries a pi, so a white surface here reads 6;
 * the emissive takes the same pi to keep that ratio. Applied where the scene's materials load.
 */
export const EMISSIVE_UNITS = Math.PI;

/**
 * Sky radiance relative to the sun, as Unreal renders it. TEMPORARY, measured and not derived: with
 * the sun at 6 lux the model above is 1.3x too bright against the Unreal L2 frames, flat across
 * channels and across the 15 and 4 degree suns (1.30 / 1.30 / 1.35 at 19 degrees elevation), so
 * the sky is scaled by 1/1.3. The lens attenuation constant 0.78 (PostProcessEyeAdaptation.cpp,
 * r.EyeAdaptation.LensAttenuation) has the right size but the path that would apply it to the
 * atmosphere and not to the sun is not found in the source yet.
 */
export const SKY_TO_SUN = 0.78;

/**
 * Colour of a black-body-like light at `kelvin` as linear sRGB with unit luminance: the Planckian
 * locus fit in the CIE 1960 UCS plane (Krystek 1985) that Unreal uses for a light's temperature
 * (Engine/Source/Runtime/Core/Private/Math/Color.cpp, MakeFromColorTemperature), then XYZ to BT.709.
 */
export function temperatureColour(kelvin: number): Rgb {
  const t = Math.min(15000, Math.max(1000, kelvin));
  const u =
    (0.860117757 + 1.54118254e-4 * t + 1.28641212e-7 * t * t) /
    (1 + 8.42420235e-4 * t + 7.08145163e-7 * t * t);
  const v =
    (0.317398726 + 4.22806245e-5 * t + 4.20481691e-8 * t * t) /
    (1 - 2.89741816e-5 * t + 1.61456053e-7 * t * t);
  const d = 2 * u - 8 * v + 4;
  const x = (3 * u) / d;
  const y = (2 * v) / d;
  const [bx, bz] = [x / y, (1 - x - y) / y];
  return [
    Math.max(0, 3.2404542 * bx - 1.5371385 - 0.4985314 * bz),
    Math.max(0, -0.969266 * bx + 1.8760108 + 0.041556 * bz),
    Math.max(0, 0.0556434 * bx - 0.2040259 + 1.0572252 * bz),
  ];
}

/** The scene's sun light, registered by `setupLighting` so `setupSky` can tint it by the air. */
export const sunLight: {
  current?: { color: { setRGB(r: number, g: number, b: number): unknown } };
} = {};
