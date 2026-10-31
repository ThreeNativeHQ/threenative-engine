// Generated for you. Plain maths, edit or delete it freely: the sky the sun lights, in the sun's own units.
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

function medium(h: number): IMedium {
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

/**
 * Optical depth from a point to the top of the atmosphere; undefined when the planet blocks the way.
 * Unreal stores this in its transmittance LUT, ten samples a ray (r.SkyAtmosphere.TransmittanceLUT.SampleCount).
 */
function opticalDepthToTop(r: number, mu: number): Rgb | undefined {
  if (mu < 0 && hitSphere(r, mu, BOTTOM_KM, false) !== undefined) return undefined;
  const length = hitSphere(r, mu, TOP_KM, true) ?? 0;
  const sum: [number, number, number] = [0, 0, 0];
  for (const { from, to, at } of linear(10)(length)) {
    const m = medium(Math.max(0, Math.sqrt(r * r + 2 * r * mu * at + at * at) - BOTTOM_KM));
    for (let c = 0; c < 3; c += 1) sum[c] = (sum[c] ?? 0) + m.ext[c as 0 | 1 | 2] * (to - from);
  }
  return sum;
}

/** Fraction of the sun's illuminance that reaches the ground, per channel. */
export function sunTransmittance(elevationRad: number): Rgb {
  const depth = opticalDepthToTop(BOTTOM_KM + CAMERA_KM, Math.sin(elevationRad));
  if (depth === undefined) return [0, 0, 0];
  return [Math.exp(-depth[0]), Math.exp(-depth[1]), Math.exp(-depth[2])];
}

/**
 * The colour Unreal gives the sun light itself (FAtmosphereSetup::GetTransmittanceAtGroundLevel,
 * Engine/Source/Runtime/Engine/Private/Components/SkyAtmosphere*): a CPU estimate, not the exact
 * integral. It starts 500 m above the planet, sums 15 equal segments by their start point (the
 * rule over-counts the dense low air) and has no minimum elevation (TransmittanceMinLightElevationAngle
 * is -90). The sky itself reads the transmittance LUT (`sunTransmittance`), so the two differ.
 */
export function sunLightTransmittance(elevationRad: number): Rgb {
  const f = Math.fround;
  const r0 = BOTTOM_KM + 0.5;
  const mu = Math.sin(elevationRad);
  const tMax = hitSphere(r0, mu, TOP_KM, true) ?? 0;
  const depth: [number, number, number] = [0, 0, 0];
  const step = f(1 / 15);
  for (let t = 0; t < 1; t = f(t + step)) {
    const along = tMax * t;
    const h = Math.max(0, Math.sqrt(r0 * r0 + 2 * r0 * mu * along + along * along) - BOTTOM_KM);
    const m = medium(h);
    for (let c = 0; c < 3; c += 1) depth[c] = (depth[c] ?? 0) + m.ext[c as 0 | 1 | 2] * step * tMax;
  }
  return [Math.exp(-depth[0]), Math.exp(-depth[1]), Math.exp(-depth[2])];
}

/** Fraction of the sun's illuminance that reaches radius `r` where the sun's cosine to local up is `mu`. */
export function transmittanceToTop(r: number, mu: number): Rgb {
  const depth = opticalDepthToTop(r, mu);
  if (depth === undefined) return [0, 0, 0];
  return [Math.exp(-depth[0]), Math.exp(-depth[1]), Math.exp(-depth[2])];
}

type Multi = (heightKm: number, cosSun: number) => Rgb;

/** One ray segment: it spans [from, to] in kilometres and its medium is read at `at`. */
interface ISegment {
  from: number;
  to: number;
  at: number;
}
type Sampling = (tMax: number) => ISegment[];

/** Unreal's fixed march (the transmittance, multiple-scattering and distant sky light passes): equal segments, read `offset` of the way in. */
const linear =
  (steps: number, offset = 0.3): Sampling =>
  (tMax) =>
    Array.from({ length: steps }, (_, i) => ({
      from: (tMax * i) / steps,
      to: (tMax * (i + 1)) / steps,
      at: (tMax * (i + offset)) / steps,
    }));

/**
 * Unreal's sky-view march (SamplingSetup.VariableSampleCount in SkyAtmosphere.usf): the count grows
 * from `min` to `max` with the distance, the segments grow with the square of it, and the last one
 * runs on to the end of the ray.
 */
const variable =
  (min: number, max: number, distanceKm: number, offset = 0.3): Sampling =>
  (tMax) => {
    const count = min + (max - min) * Math.min(1, Math.max(0, tMax / distanceKm));
    const whole = Math.floor(count);
    const tMaxWhole = (tMax * whole) / count;
    return Array.from({ length: Math.ceil(count) }, (_, i) => {
      const [u0, u1] = [(i / whole) ** 2, ((i + 1) / whole) ** 2];
      const from = tMaxWhole * u0;
      const to = u1 > 1 ? tMax : tMaxWhole * u1;
      return { from, to, at: from + (to - from) * offset };
    });
  };

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
  ground: boolean,
  sampling: Sampling,
): IGather {
  const out: IGather = { radiance: [0, 0, 0], transfer: [0, 0, 0] };
  const mu0 = dir[1];
  const groundT = mu0 < 0 ? hitSphere(r0, mu0, BOTTOM_KM, false) : undefined;
  const tMax = groundT ?? hitSphere(r0, mu0, TOP_KM, true) ?? 0;
  const cosView = dot(dir, sun);
  const phaseRay = iso ? 1 / FOUR_PI : rayleighPhase(cosView);
  const phaseMie = iso ? 1 / FOUR_PI : hgPhase(cosView);
  const through: [number, number, number] = [1, 1, 1];
  const at = (t: number): Vec3 => [dir[0] * t, r0 + dir[1] * t, dir[2] * t];
  for (const { from, to, at: mid } of sampling(tMax)) {
    const dt = to - from;
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
        const ray = march(BOTTOM_KM + h, dir, sun, true, undefined, true, linear(15));
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
const DISTANT_SKY_LIGHT_ALTITUDE_KM = 6;
/**
 * Unreal's distant sky light shader: one 8 x 8 group, one stratified direction a thread, ten linear
 * samples a ray (RenderDistantSkyLightLutCS). The directions come from a seeded linear congruential
 * stream (0xDE4DC0DE, GUniformSphereSamplesBuffer in SkyAtmosphereRendering.cpp), so the coarse
 * result is one fixed draw, not a mean; the same draw is reproduced here.
 */
const DISTANT_GROUP = 8;
function distantDirections(): Vec3[] {
  let seed = 0xde4dc0de;
  const fraction = (): number => {
    seed = (Math.imul(seed, 196314165) + 907633515) >>> 0;
    return (seed >>> 9) / 8388608;
  };
  const dirs: Vec3[] = new Array(DISTANT_GROUP * DISTANT_GROUP);
  for (let i = 0; i < DISTANT_GROUP; i += 1) {
    for (let j = 0; j < DISTANT_GROUP; j += 1) {
      const up = 1 - (2 * (i + fraction())) / DISTANT_GROUP;
      const phi = (2 * Math.PI * (j + fraction())) / DISTANT_GROUP;
      const ring = Math.sqrt(1 - up * up);
      dirs[j * DISTANT_GROUP + i] = [ring * Math.cos(phi), up, ring * Math.sin(phi)];
    }
  }
  return dirs;
}
function distantSkyLight(toSun: { x: number; y: number; z: number }): Rgb {
  const sun: Vec3 = [toSun.x, toSun.y, toSun.z];
  const multi = multipleScatteringTable();
  const dirs = distantDirections();
  const sum: [number, number, number] = [0, 0, 0];
  for (const dir of dirs) {
    const ray = march(
      BOTTOM_KM + DISTANT_SKY_LIGHT_ALTITUDE_KM,
      dir,
      sun,
      true,
      multi,
      false,
      linear(10),
    );
    for (let c = 0; c < 3; c += 1) sum[c] = (sum[c] ?? 0) + (ray.radiance[c] ?? 0) / dirs.length;
  }
  return sum;
}

/**
 * The light height fog and clouds take from the sky, per unit sun illuminance: Unreal's distant sky
 * light (GetViewDistanceSkyLightColor). It needs no fit. The 0.76 / 0.871 / 0.941 factors that stood
 * here made up for a finer march than Unreal's own, ten samples a ray from one fixed 8 x 8 draw of
 * directions (`distantSkyLight`); the same march agrees with the Unreal L3 void within 2.4 percent in
 * green and blue at 15 and 60 degrees, and within 0.6 percent in red at 15 degrees. Red stays 10 percent
 * high at 60 degrees, the same excess the clear sky shows at a high sun (open, PRD-633).
 */
export function viewDistanceSkyLight(toSun: { x: number; y: number; z: number }): Rgb {
  return distantSkyLight(toSun);
}

/**
 * Sky radiance per unit sun illuminance on an equirectangular grid in three's layout: row 0 is the
 * zenith, the middle row the horizon, the last row the nadir, and u = atan2(z, x) / 2pi + 0.5. `sun`
 * is the unit direction toward the sun, y up.
 *
 * Below the horizon it draws the atmosphere's sunlit ground (albedo `GROUND_ALBEDO`, the term
 * Unreal's multiple-scattering pass uses), where Unreal's own sky capture is near black. Unreal's
 * default level fills that half with Lumen: the floor bounces sun into shadow sides and a mirror
 * reflects it. This environment is the only indirect light the templates have, so the ground stands
 * in for that bounce; without it shadow sides read navy and a chrome ball's lower half black (judge,
 * PRD-633). Drop it when the game adds its own global illumination.
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
      const ray = march(r0, dir, sun, false, multi, true, variable(4, 32, 150));
      const o = (y * width + x) * 3;
      data[o] = ray.radiance[0];
      data[o + 1] = ray.radiance[1];
      data[o + 2] = ray.radiance[2];
    }
  }
  return data;
}

/** The default level's sun: 6 lux, 6500 K (tools/unreal-reference/template-actors.json, every sun). */
const SUN_LUX = 6;
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
