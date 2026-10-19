// The Temperate water: the lake in the basin and the stream the bake carved down to it.
//
// Ported from Wildwood's `src/render/water.ts` (`createWater`), which is where the model below comes
// from — the wind-gated wave field, the graded slope gain, the Beer-Lambert body, the shore dissolve
// and the Snell's window. Wildwood's pond.ts dresses that same surface with rocks and reeds, so
// nothing of it is ported: what makes still water read as water is the model, not the dressing.
//
// Three things here are this game's rather than Wildwood's:
//
// - **The depth is baked, and it is real.** Neither basin nor bed moves, so every vertex carries the
//   metres of water standing on it, out of the same `heightAt` the terrain mesh and the collider
//   read. That is what puts the shoreline on the ground's own contour instead of on a drawn circle,
//   what makes the margin dissolve instead of ending on a triangle, and what keeps the shallows
//   legible at a grazing angle, where a screen-space depth read has nothing to say.
// - **The lake keeps a real planar mirror.** The basin is level, so unlike the stream it can have
//   one, and the mirror is what carries the far bank upside down — the one thing that makes still
//   water read as water. It draws layer 0 only, which is why the water sits on `WATER_LAYER`: a
//   water surface inside the mirrored pass samples a single-sampled depth target and fails WebGPU
//   validation, taking the frame down with it.
// - **The forest stream has no mirror.** It falls fifteen metres over its length, so a planar
//   reflection would be right at one bend and wrong everywhere else; the sky comes back by fresnel
//   over an analytic gradient. Tundra channels share the kettle ponds' existing mirrors, blended
//   by elevation, so the stream and pond meet without a reflection-colour seam.
//
// Nothing here decides a colour for the engine: `WaterSurface3D` measures metres and hands back the
// frame beneath the surface and the world mirrored in it, and every number under LOOK below is this
// game's. One rule worth carrying: **`new Color(hex)` already converts sRGB to linear**, because
// three enables `ColorManagement` by default — calling `convertSRGBToLinear()` on top of it darkens
// every palette colour by a factor between three and thirteen, and the shader then reads as "wants
// turning up" rather than as broken.
import { WaterSurface3D, WaveField } from "@threenative/core";
import type { Heightfield } from "@threenative/core/world";
import { BufferAttribute, BufferGeometry, Color, DoubleSide, Mesh } from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  attribute,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  clamp,
  color,
  dot,
  exp,
  float,
  max,
  min,
  mix,
  mx_noise_float,
  normalize,
  positionLocal,
  positionWorld,
  pow,
  smoothstep,
  step,
  uniform,
  vec2,
  vec3,
  vec4,
  viewportSharedTexture,
} from "three/tsl";
import type { Node } from "three/webgpu";
import { MeshBasicNodeMaterial } from "three/webgpu";
import { SUN, SUN_VECTOR } from "./sky.js";

/** One river as the bake records it: the smoothed spline and the width of its water. */
export interface IBakedRiver {
  readonly id: string;
  readonly points: readonly (readonly number[])[];
  readonly width: number;
}

/**
 * The layer water draws on, and the only one the lake's mirror leaves out.
 *
 * Water reads the frame's depth to know how deep it is, and inside the mirror pass that depth is the
 * mirror's own single-sampled target: drawing a water surface into the mirror fails WebGPU validation
 * and takes the frame down with it. Water in a lake's reflection is the lake itself anyway.
 */
export const WATER_LAYER = 1;
/** What the water mirror redraws: the ground and its distant ring, not every tree and blade again. */
export const REFLECTED_LAYER = 3;

/** The stream's shape. Its reach is also the lake's exclusion corridor; see `createLakes`. */
const RIVER = {
  /** Metres of water over the deepest point of the bed. The bank rises out of it on its own. */
  fill: 1.1,
  /** How far either side of the centreline the surface reaches; the terrain hides what is dry. */
  reach: 13,
  /**
   * Stations over which the fill tapers to nothing at each end of the path, so the surface meets the
   * ground it is over instead of stopping in a wall of water. See `surfaceHeights`.
   */
  taper: 9,
  /**
   * Vertices across the surface. The shore dissolve is a ramp in metres of depth, so the column
   * spacing is what decides how wide the wet margin reads: at thirteen the ramp fitted inside one
   * quad and the bank cut the surface like a blade.
   */
  across: 25,
  /** The wind patches on moving water: how big one is, how fast it crosses, and which way. */
  patch: { metres: 9, drift: 1.4, wind: [0.86, 0.51] as const },
  /**
   * The three ripple scales, as metres of feature size, how fast each drifts downstream in metres a
   * second, and how hard each bends the surface. Small ones only: the stream is read from two metres
   * away, where a broad ripple is a smear across the whole channel rather than a wave in it. The
   * finest is `fine`, and fades with distance like any ripple smaller than a pixel.
   */
  ripples: [
    { metres: 1.9, drift: 1.5, gain: 0.55, fine: false },
    { metres: 0.78, drift: 2.1, gain: 0.3, fine: false },
    { metres: 0.33, drift: 2.8, gain: 0.16, fine: true },
  ],
} as const;

/** The lake's shape, and how its mirror is taken. Every number here is this game's. */
const LAKE = {
  /** Mirror pixels as a share of the frame's, how often it redraws, and the layer mask it draws. */
  mirror: { resolutionScale: 1, refreshInterval: 2, layers: 1 << REFLECTED_LAYER },
  /** Rings and spokes in the disc the basin is meshed as. */
  rings: 44,
  spokes: 88,
  /** How far past the measured waterline the mesh reaches, so the real shore is inside it. */
  reach: 1.12,
  /** How the ring spacing grows outwards. Above 1 packs vertices into the near water. */
  packing: 1.7,
} as const;

/**
 * Extinction per metre, per channel, in the renderer's linear space.
 *
 * Red dies first and blue survives, which is why fresh water over a green bed reads teal. Roughly
 * two and a half times distilled water: this basin carries the meadow in it — leaf tannin, silt, grass
 * — and a lake you can see four metres into reads as a swimming pool. The Temperate basin is 1.3 m at
 * its deepest, so this is a grade across a hand's depth rather than a wall of colour.
 */
const EXTINCTION: readonly [number, number, number] = [1.6, 0.65, 0.42];

/** Metres of water past which the bed stops contributing. The basin bottoms out near 1.3 m. */
const OPAQUE_DEPTH = 1.2;

/** Deepest reading the baked attribute carries. Past the basin's own depth, so nothing saturates. */
const MAX_BAKED_DEPTH = 1.6;

/**
 * Peak ripple slope close to the camera, and far from it.
 *
 * The wave field's honest peak slope is about 5°, which is right for sheltered water and far too
 * small to see once it is the only thing bending a reflection. The physical argument for grading it
 * is that one distant pixel covers many ripples and shows their average: near water gets chop you can
 * see, water past seventy metres is a mirror.
 */
const SLOPE_GAIN_NEAR = 1.4;
const SLOPE_GAIN_FAR = 0.65;
const SLOPE_FADE_NEAR = 10;
const SLOPE_FADE_FAR = 72;

/** Where the short ripples start and finish fading, in metres from the camera. */
const DETAIL_NEAR = 12;
const DETAIL_FAR = 44;

/**
 * How much of the surface slope the reflection sees, as a share of what the glint sees.
 *
 * Two readings of one surface wanting two amounts of it: a glint is a peak-finder and wants every
 * steep facet, a reflection is an average over the pixel's footprint and shreds into oil-slick
 * crumple when fed the unfiltered slope.
 */
const REFLECT_SLOPE_SHARE = 0.55;

/** The wind patches: their size, their drift, and how calm the calm is (zero would read as ice). */
const PATCH_METRES = 21;
const PATCH_DRIFT = 0.7;
const PATCH_CALM = 0.45;

/**
 * How far a screen-space read may slide, in fractions of the frame, looking straight down and at a
 * grazing angle. Grazing fragments slide further, because that is what a longer path through a
 * tilted surface does. Beyond this the reflection stops being a reflection and becomes a smear of
 * whatever happened to be in those pixels.
 */
const REFRACTION_NEAR = 0.004;
const REFRACTION_FAR = 0.026;

/** How far the reflection smears, in fractions of the screen, at the near and far ends. */
const REFLECT_BLUR_NEAR = 0.0012;
const REFLECT_BLUR_FAR = 0.003;
/** How much narrower the smear is across the screen than down it. */
const REFLECT_BLUR_ASPECT = 0.5;

/** The floor under Schlick: still water seen straight down is not perfectly clear. */
const SKY_FLOOR = 0.045;

/** Where the ripple may start, in metres of depth. Water at the gravel is glass. */
const RIPPLE_DEPTH = 0.35;

/** The wet band at the margin, in metres of depth: the surface fades out across it. */
const SHORE_FADE = 0.42;

/** How far the mirrored bed smears under the surface, in fractions of the screen. */
const UNDER_BLUR = 0.004;

/** The cosine band the Snell's-window edge is blended over. Water's critical angle is 48.6°. */
const SNELL_INNER = 0.6;
const SNELL_OUTER = 0.79;

/** This game's water body: silt at the margin, cold green in the middle, moss in the sun path. */
const TINT = {
  silt: 0x789f98,
  shallow: 0.08,
  deep: 0x1f3833,
  deepGain: 0.26,
  /** Sunlight scattered back out of the shallows. */
  glow: 0x75a99b,
  /** Foam and white water. */
  foam: 0xe8efe8,
  /** The sky the stream reflects: the horizon haze, and the zenith above it. */
  skyHorizon: 0xd2e0ec,
  skyZenith: 0x86acd2,
  /**
   * What stands on both banks of a stream in spruce wood. A reflected ray leaving the surface at two
   * degrees does not reach the sky at all — it hits a trunk — and without this floor the stream is a
   * strip of chrome wherever the eye is low enough for the fresnel to close.
   */
  bank: 0x627660,
  bankGain: 0.8,
} as const;

/**
 * A linear-space vec3 node from a colour, so the shader math is in the renderer's space.
 *
 * The palette is authored in sRGB, which is what a person picks colours in; every number below is
 * multiplied and exponentiated, so it has to be linear or the absorption curve is applied to a
 * gamma-encoded quantity and the shallows come out chalky. `new Color(hex)` has already made that
 * conversion — see the file header.
 */
function linear(value: number | Color, gain = 1): Node<"vec3"> {
  const tint = typeof value === "number" ? new Color(value) : value;
  return vec3(tint.r * gain, tint.g * gain, tint.b * gain);
}

/**
 * The lake's ripple: eight waves, no two of them commensurate, under one slow domain warp.
 *
 * 11.3, 7.1, 4.7, 3.1, 1.9, 1.3, 0.79 and 0.53 metres. Ratios near, but never at, small whole numbers
 * is the whole point: wavelengths at 8/4/2/1 reline up every eight metres and draw visible corduroy.
 * The warp bends the domain the waves are measured in, so crests curve and wander instead of running
 * as a sum of straight lines. Amplitudes are tiny because this is sheltered water — they set the
 * *normal*, which is what the light reads.
 */
const RIPPLE = new WaveField({
  waves: [
    { amplitude: 0.021, direction: [0.94, 0.35], wavelength: 11.3, speed: 0.78 },
    { amplitude: 0.014, direction: [-0.42, 0.91], wavelength: 7.1, speed: 0.61, phase: 1.7 },
    { amplitude: 0.009, direction: [0.71, -0.7], wavelength: 4.7, speed: 0.52, phase: 2.4 },
    { amplitude: 0.006, direction: [-0.87, -0.49], wavelength: 3.1, speed: 0.44, phase: 0.8 },
    {
      amplitude: 0.0035,
      detail: true,
      direction: [0.29, 0.96],
      wavelength: 1.9,
      speed: 0.37,
      phase: 3.9,
    },
    {
      amplitude: 0.0022,
      detail: true,
      direction: [-0.66, 0.75],
      wavelength: 1.3,
      speed: 0.31,
      phase: 5.2,
    },
    {
      amplitude: 0.0013,
      detail: true,
      direction: [0.98, -0.19],
      wavelength: 0.79,
      speed: 0.26,
      phase: 1.1,
    },
    {
      amplitude: 0.0008,
      detail: true,
      direction: [-0.12, -0.99],
      wavelength: 0.53,
      speed: 0.21,
      phase: 4.4,
    },
  ],
  domainWarp: [
    { direction: [0.8, 0.6], displacement: [0.55, -0.38], wavelength: 23, speed: 0.13, phase: 0.6 },
  ],
});

export interface IRiverWater {
  readonly mesh: Mesh;
  /** Lake mirror sampling, shared with joining streams without another reflection pass. */
  readonly reflectionAt?: (offset: Node<"vec2">) => Node<"vec3">;
  /** The water's clock, in seconds; the scene advances it so the playtest's time is the water's. */
  advance(elapsed: number): void;
  dispose(): void;
}

/**
 * Everything a fragment of water is made of, whatever it is water in.
 *
 * One composite for both surfaces, so the stream and the lake cannot drift apart: they are the same
 * body of water with a different surface normal over them, and the difference a player can see
 * between a river and a lake is the ripple and the mirror, not the colour of what comes up through it.
 */
interface IWaterShading {
  /** World normal, already graded by distance, wind patch and depth. */
  readonly normal: Node<"vec3">;
  /** Baked metres of water standing on this vertex. */
  readonly depthM: Node<"float">;
  /** The frame beneath the surface, offset by the normal. */
  readonly bed: Node<"vec3">;
  /** The world mirrored in this surface: the mirror target for the lake, the sky for the stream. */
  readonly reflected: Node<"vec3">;
}

/** The composite: what comes up through the surface, what sits on it, and the sun's glint. */
function compositeWater(surface: IWaterShading): Node<"vec3"> {
  const { normal, depthM, bed, reflected } = surface;
  const view = normalize(cameraPosition.sub(positionWorld));
  const facing = clamp(dot(normal, view), float(0), float(1));
  // Schlick at water's 1.333 index: F0 is 0.02, which is why still water at your feet is nearly
  // clear and the same water at the far bank is a mirror.
  const fresnel = float(0.02).add(pow(float(1).sub(facing), 5).mul(0.98));

  // How far light travels through this water to reach the eye: straight down it is the baked depth,
  // at a grazing angle it is far further, which is the whole reason water is clear at your feet and
  // opaque at the far bank. The floor on `facing` keeps a horizon fragment asking for a kilometre.
  const path = min(depthM.div(max(facing, float(0.12))), float(MAX_BAKED_DEPTH * 1.6));
  const tint = exp(vec3(-EXTINCTION[0], -EXTINCTION[1], -EXTINCTION[2]).mul(path));

  // Caustics: the same analytic normal that bends the reflection focuses the sun onto the bed, so the
  // bright cells are where the surface happens to point at it, drifting with the ripple causing them.
  // Killed with depth, because a caustic is a shallow-water phenomenon and the bed at two metres is
  // in shade.
  const focus = pow(clamp(dot(normal, SUN_VECTOR), float(0), float(1)), 34);
  const caustic = focus.mul(1.7).mul(float(1).sub(smoothstep(float(0.15), float(1.9), depthM)));

  // What the water body itself scatters back: silt at the margin, the lake's own green in the middle.
  // The gains are small because these are radiances, not albedos: a fraction of what the bank returns.
  const shallowBody = linear(TINT.silt, TINT.shallow).mul(vec3(1.06, 1, 0.74));
  const deepBody = linear(TINT.deep, TINT.deepGain);
  const body = mix(shallowBody, deepBody, smoothstep(float(0.1), float(2.4), depthM));

  const submerged = bed
    .mul(tint)
    .mul(float(1).add(caustic))
    .add(body.mul(float(1).sub(tint)));

  // Subsurface scatter: the green-gold glow of shallow water with the sun behind it — light that went
  // in, bounced around in the silt and came back out rather than reflecting off the top.
  const towardSun = clamp(dot(view.negate(), SUN_VECTOR), float(0), float(1));
  const glow = pow(towardSun, 2.5)
    .mul(float(1).sub(smoothstep(float(0.2), float(1.8), depthM)))
    .mul(0.26);
  const underwater = submerged.add(
    linear(TINT.glow, 0.35)
      .mul(vec3(1.3, 1.15, 0.6))
      .mul(glow),
  );

  const skyWeight = min(float(SKY_FLOOR).add(fresnel.mul(float(1 - SKY_FLOOR))), float(1));
  const composited = mix(underwater, reflected, skyWeight);

  // Sun glint off the same analytic normal. A specular lobe on a non-repeating normal breaks into
  // separate sparks by itself, which is what a glitter path looks like from the bank.
  const halfway = normalize(view.add(SUN_VECTOR));
  const glint = pow(clamp(dot(normal, halfway), float(0), float(1)), 170);
  return composited.add(linear(SUN.colour, 0.75).mul(glint));
}

/**
 * How much ripple the wind is touching here, 0..1.
 *
 * Two octaves of gradient noise in world metres, drifting downwind and evolving slowly in place.
 * Noise rather than another wave sum, because a sum of sines used as a mask carries the corduroy the
 * waves themselves exist to avoid.
 */
function windPatch(
  here: Node<"vec2">,
  time: Node<"float">,
  metres: number,
  drift: number,
  wind: readonly [number, number],
): Node<"float"> {
  const uv = here.mul(1 / metres).sub(vec2(wind[0], wind[1]).mul(time.mul(drift / metres)));
  const coarse = mx_noise_float(vec3(uv.x, uv.y, time.mul(0.021)));
  const fine = mx_noise_float(
    vec3(uv.x.mul(2.7).add(11.3), uv.y.mul(2.7).sub(4.1), time.mul(0.048)),
  );
  return smoothstep(float(-0.12), float(0.34), coarse.add(fine.mul(0.34)));
}

/** The slope gain: near and far, damped in the calm patches and in the last hand's depth of water. */
function slopeGain(
  eyeDistance: Node<"float">,
  patch: Node<"float">,
  depthM: Node<"float">,
): Node<"float"> {
  return mix(
    float(SLOPE_GAIN_NEAR),
    float(SLOPE_GAIN_FAR),
    smoothstep(float(SLOPE_FADE_NEAR), float(SLOPE_FADE_FAR), eyeDistance),
  )
    .mul(mix(float(PATCH_CALM), float(1), patch))
    .mul(smoothstep(float(0), float(RIPPLE_DEPTH), depthM));
}

/** The shore: the surface dissolves into the wet margin instead of ending on a triangle. */
function shoreFade(depthM: Node<"float">): Node<"float"> {
  return smoothstep(float(0), float(SHORE_FADE), depthM);
}

/**
 * The stream's surface height along the path: a fill over the bed, never running uphill.
 *
 * The fill tapers to nothing at both ends of the recorded path. A stream's ends are where it comes
 * out of the hillside and where it goes into standing water, and a ribbon that stops at full depth
 * ends in a wall of water a metre high: the bake's last station sits two metres above the lake it
 * drains into, and the flat cap across the channel that leaves is the hard straight edge the bank
 * appears to be cut by. Tapered, the surface meets the ground it is over and the end dissolves.
 */
export function surfaceHeights(
  field: Heightfield,
  points: readonly (readonly number[])[],
): number[] {
  const last = points.length - 1;
  const raw = points.map(([x = 0, , z = 0], k) => {
    const fromEnd = Math.min(k, last - k) / RIVER.taper;
    return field.heightAt(x, z) + RIVER.fill * Math.max(0, Math.min(1, fromEnd));
  });
  // Downhill only, then a short moving average, then downhill again: the bed has erosion noise in
  // it and a surface that copies that noise steps up and down like a staircase.
  for (let k = 1; k < raw.length; k += 1) raw[k] = Math.min(raw[k] as number, raw[k - 1] as number);
  const smooth = raw.map((_, k) => {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, k - 3); j <= Math.min(raw.length - 1, k + 3); j += 1) {
      sum += raw[j] as number;
      n += 1;
    }
    return sum / n;
  });
  for (let k = 1; k < smooth.length; k += 1)
    smooth[k] = Math.min(smooth[k] as number, smooth[k - 1] as number);
  return smooth;
}

/**
 * A ribbon along one river: positions, the downstream heading at every vertex, and the metres of
 * water standing on it.
 *
 * The baked depth is the point. Taken off the ground under each vertex rather than read off the
 * screen, it puts the shoreline where the ground crosses the surface, the foam where the water is
 * thin, and the margin's dissolve over its last thirty centimetres — which is what a screen-space
 * thickness cannot do on a hillside crossing a flat plane, and reads as the bank cutting the ribbon
 * like a blade.
 */
function ribbon(
  field: Heightfield,
  river: IBakedRiver,
  positions: number[],
  flows: number[],
  depths: number[],
  indices: number[],
  limitToWidth: boolean,
): void {
  const { points } = river;
  const reach = limitToWidth ? river.width * 2.5 : RIVER.reach;
  const heights = limitToWidth
    ? points.map((point) => point[1] ?? 0)
    : surfaceHeights(field, points);
  const base = positions.length / 3;
  const columns = RIVER.across;
  const wet: number[] = [];
  for (let k = 0; k < points.length; k += 1) {
    const before = points[Math.max(0, k - 1)] as readonly number[];
    const after = points[Math.min(points.length - 1, k + 1)] as readonly number[];
    let dx = (after[0] ?? 0) - (before[0] ?? 0);
    let dz = (after[2] ?? 0) - (before[2] ?? 0);
    const length = Math.hypot(dx, dz) || 1;
    dx /= length;
    dz /= length;
    const [x = 0, , z = 0] = points[k] as readonly number[];
    const y = heights[k] as number;
    for (let c = 0; c < columns; c += 1) {
      const across = (c / (columns - 1) - 0.5) * 2 * reach;
      const vx = x - dz * across;
      const vz = z + dx * across;
      positions.push(vx, y, vz);
      flows.push(dx, dz);
      const depth = Math.min(
        MAX_BAKED_DEPTH,
        Math.max(0, y - field.heightAt(vx, vz)),
        limitToWidth ? Math.max(0, (reach - Math.abs(across)) * 0.2) : MAX_BAKED_DEPTH,
      );
      depths.push(depth);
      wet.push(depth > 0 ? 1 : 0);
    }
  }
  for (let k = 1; k < points.length; k += 1) {
    for (let c = 1; c < columns; c += 1) {
      const a = base + (k - 1) * columns + c - 1;
      const b = a + 1;
      const d = base + k * columns + c - 1;
      const e = d + 1;
      // Keeping the quads with a dry corner is what gives the alpha ramp below a strip of dry ground
      // to dissolve across; only a quad that is dry on both of its rows is dropped outright, which
      // takes the surface off the hillside rather than folding it back along the centreline.
      if (
        (wet[a - base - 1] ?? 0) +
          (wet[b - base] ?? 0) +
          (wet[d - base - 1] ?? 0) +
          (wet[e - base] ?? 0) ===
          0 &&
        (wet[a - base] ?? 0) +
          (wet[b - base] ?? 0) +
          (wet[d - base] ?? 0) +
          (wet[e - base] ?? 0) ===
          0
      )
        continue;
      // Wound so the face points up: along × across points down, so the pair is taken the other way.
      indices.push(a, b, d, b, e, d);
    }
  }
}

/** Draw every baked river as one surface, or nothing when the world has none. */
export function createRivers(
  rivers: readonly IBakedRiver[],
  field: Heightfield,
  limitToFootprint = false,
  lakeReflection?: (offset: Node<"vec2">) => Node<"vec3">,
): IRiverWater | undefined {
  if (rivers.length === 0) return undefined;
  const positions: number[] = [];
  const flows: number[] = [];
  const depths: number[] = [];
  const indices: number[] = [];
  const groups: { start: number; count: number }[] = [];
  for (const river of rivers) {
    const start = indices.length;
    ribbon(field, river, positions, flows, depths, indices, limitToFootprint);
    groups.push({ start, count: indices.length - start });
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute("flow", new BufferAttribute(new Float32Array(flows), 2));
  geometry.setAttribute("metres", new BufferAttribute(new Float32Array(depths), 1));
  geometry.setIndex(indices);
  for (const group of groups) geometry.addGroup(group.start, group.count, 0);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  const surface = new WaterSurface3D({ level: 0, maxThickness: MAX_BAKED_DEPTH * 2 });
  const time = uniform(0);
  const depthM = attribute<"float">("metres", "float");
  const heading = normalize(attribute<"vec2">("flow", "vec2"));
  const here = vec2(positionWorld.x, positionWorld.z);
  const along = dot(here, heading);
  const side = dot(here, vec2(heading.y.negate(), heading.x));
  const eyeDistance = here.sub(vec2(cameraPosition.x, cameraPosition.z)).length();
  const detail = float(1).sub(smoothstep(float(DETAIL_NEAR), float(DETAIL_FAR), eyeDistance));

  // Ripples are noise stretched along the current and slid downstream: streaks that move, which is
  // what tells a river from a pond at a glance. The height comes from the sum, and the normal from its
  // gradient by finite difference in the current's own frame, then rotated back into the world's.
  const height = (a: Node<"float">, b: Node<"float">): Node<"float"> => {
    let sum: Node<"float"> = float(0);
    for (const wave of RIVER.ripples) {
      const scale = 1 / wave.metres;
      const octave = mx_noise_float(
        vec3(a.mul(scale).sub(time.mul(wave.drift * scale)), b.mul(scale * 0.7), time.mul(0.09)),
      ).mul(wave.gain);
      sum = sum.add(wave.fine ? octave.mul(detail) : octave);
    }
    return sum;
  };
  const h0 = height(along, side);
  const delta = 0.18;
  const dAlong = height(along.add(delta), side).sub(h0).div(delta);
  const dSide = height(along, side.add(delta)).sub(h0).div(delta);
  const patch = windPatch(here, time, RIVER.patch.metres, RIVER.patch.drift, RIVER.patch.wind);
  const gain = slopeGain(eyeDistance, patch, depthM).mul(mix(0.12, 1, detail));
  const slant = (share: number): Node<"vec3"> => {
    const alongSlope = dAlong.mul(gain.mul(share)).negate();
    const sideSlope = dSide.mul(gain.mul(share)).negate();
    return vec3(
      heading.x.mul(alongSlope).sub(heading.y.mul(sideSlope)),
      float(1),
      heading.y.mul(alongSlope).add(heading.x.mul(sideSlope)),
    );
  };
  const normal = normalize(slant(1));
  const reflectNormal = normalize(slant(REFLECT_SLOPE_SHARE));

  // The normal's horizontal part is the screen offset, in fractions of the frame. Grazing fragments
  // slide further, because that is what a longer path through a tilted surface does — and the offset
  // is taken to zero at the margin, or the dry bank smears out across the water in front of it.
  const view = normalize(cameraPosition.sub(positionWorld));
  const facing = clamp(dot(normal, view), float(0), float(1));
  const slide = mix(float(REFRACTION_NEAR), float(REFRACTION_FAR), float(1).sub(facing));
  const offset = vec2(normal.x, normal.z)
    .mul(slide)
    .mul(smoothstep(float(0), float(0.4), depthM));
  const bed = surface.refractionAt(offset);

  // The forest stream falls fifteen metres. Its sky comes back by fresnel over
  // an analytic gradient, on a floor of the wood that stands on both banks — see `TINT.bank`.
  const bounced = view.negate().reflect(reflectNormal);
  const sky = mix(
    linear(TINT.bank, TINT.bankGain),
    mix(color(TINT.skyHorizon), color(TINT.skyZenith), clamp(bounced.y, float(0), float(1))),
    // A low reflected ray hits the wooded bank. Blend its average green radiance into sky
    // over a broad angle; a hard dark cutoff makes moving facets flicker as black blobs.
    smoothstep(float(0.08), float(0.5), bounced.y),
  );
  const reflected = lakeReflection ? lakeReflection(offset) : sky.mul(0.65);
  const shaded = compositeWater({ normal, depthM, bed, reflected });

  // White water where the current runs over a shallow bed, and a few streaks in the channel. Broken
  // rather than ruled: the shallows only whiten where the churn is high, so the edge reads as water
  // catching on the gravel in patches rather than a white line painted along the bank.
  const churn = mx_noise_float(
    vec3(along.mul(1.3).sub(time.mul(2.2)), side.mul(1.9), time.mul(0.5)),
  )
    .mul(0.5)
    .add(0.5);
  const shallows = float(1).sub(smoothstep(float(0.03), float(0.18).add(churn.mul(0.24)), depthM));
  const bank = shallows.mul(smoothstep(float(0.65), float(0.9), churn)).mul(0.12);
  const streak = smoothstep(float(0.78), float(0.92), h0.mul(0.5).add(0.5)).mul(0.035);
  const foam = max(bank, streak.mul(smoothstep(float(0), float(OPAQUE_DEPTH), depthM)));

  const material = new MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
  });
  // The composite already contains lit refraction, reflected sky and one sun glint, as on the lake.
  material.colorNode = mix(shaded, linear(TINT.foam, 0.65), foam);
  // The last hand's depth of water dissolves into the gravel instead of the bank cutting the surface
  // like a blade.
  material.opacityNode = shoreFade(depthM);

  const mesh = new Mesh(geometry, material);
  mesh.layers.set(WATER_LAYER);
  mesh.name = "river-surface";
  mesh.receiveShadow = true;
  return {
    mesh,
    advance(elapsed) {
      time.value = elapsed;
    },
    dispose() {
      surface.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
}

/** One lake as the bake records it: where its flood fill was seeded, how far it may reach, its level. */
export interface IBakedLake {
  readonly id: string;
  readonly at: readonly number[];
  readonly radius: number;
  readonly level: number;
}

/** The furthest the basin reaches on a bearing: where the drawn ground crosses the level. */
export function waterlineRadius(
  field: Heightfield,
  centre: readonly number[],
  level: number,
): number {
  const [cx = 0, cz = 0] = centre;
  if (field.heightAt(cx, cz) >= level) return 0;
  const bearings = 24;
  let furthest = 0;
  for (let index = 0; index < bearings; index += 1) {
    const angle = (index / bearings) * Math.PI * 2;
    const dx = Math.cos(angle);
    const dz = Math.sin(angle);
    let wet = 0;
    let dry = Math.min(
      (field.width / 2 - Math.sign(dx) * (cx - field.origin.x)) / Math.max(Math.abs(dx), 1e-6),
      (field.depth / 2 - Math.sign(dz) * (cz - field.origin.z)) / Math.max(Math.abs(dz), 1e-6),
    );
    const cell = Math.max(field.width / (field.columns - 1), field.depth / (field.rows - 1));
    // Stop at the first bank: binary-searching the whole ray can jump a dry ridge into another pond.
    for (let distance = cell; distance < dry; distance += cell) {
      if (field.heightAt(cx + dx * distance, cz + dz * distance) >= level) {
        dry = distance;
        break;
      }
      wet = distance;
    }
    // Eighteen halvings is under two centimetres at this scale, well inside the ground's own two-metre
    // sample spacing, so more of them would be measuring nothing.
    for (let halving = 0; halving < 18; halving += 1) {
      const mid = (wet + dry) / 2;
      if (field.heightAt(cx + dx * mid, cz + dz * mid) < level) wet = mid;
      else dry = mid;
    }
    furthest = Math.max(furthest, (wet + dry) / 2);
  }
  return furthest;
}

/**
 * Draw the baked lake as one surface: Wildwood's water, over this basin's own depth.
 *
 * The mesh is a disc whose rings pack towards the middle, because this basin is not round: it is a
 * compact bowl with one flooded arm running east a hundred metres, and a square grid big enough to
 * hold the arm would spend four hundred thousand vertices on dry hillside. Only cells with water in
 * at least one corner get triangles — that is what keeps the surface from showing as a sheet hovering
 * over the meadow, and what leaves the shoreline on the ground's own contour.
 */
export function createLakes(
  lakes: readonly IBakedLake[],
  field: Heightfield,
  limitToFootprint = false,
): IRiverWater | undefined {
  const lake = lakes[0];
  if (lake === undefined) return undefined;
  if (lakes.length > 1) {
    const ponds = lakes
      .map((one) => createLakes([one], field, true))
      .filter((one) => one !== undefined);
    if (ponds.length === 0) return undefined;
    const geometry = mergeGeometries(
      ponds.map((one) => one.mesh.geometry),
      true,
    );
    if (!geometry) {
      for (const pond of ponds) pond.dispose();
      throw new Error("Lake geometries have incompatible attributes");
    }
    const mesh = new Mesh(
      geometry,
      ponds.flatMap((one) => one.mesh.material),
    );
    const mirrors = ponds.map((pond) => {
      if (!pond.reflectionAt) throw new Error("A kettle pond has no mirror sampler");
      return {
        sample: pond.reflectionAt,
        level: pond.mesh.geometry.getAttribute("position").getY(0),
      };
    });
    mesh.layers.set(WATER_LAYER);
    mesh.name = "lake-surfaces";
    mesh.renderOrder = 2;
    return {
      mesh,
      reflectionAt(offset) {
        const weighted = mirrors.map((mirror) => ({
          ...mirror,
          weight: float(1).div(positionWorld.y.sub(mirror.level).abs().add(0.1)),
        }));
        const total = weighted.reduce<Node<"float">>(
          (sum, mirror) => sum.add(mirror.weight),
          float(0),
        );
        return weighted.reduce<Node<"vec3">>(
          (sum, mirror) => sum.add(mirror.sample(offset).mul(mirror.weight.div(total))),
          vec3(0),
        );
      },
      advance(elapsed) {
        for (const pond of ponds) pond.advance(elapsed);
      },
      dispose() {
        geometry.dispose();
        for (const pond of ponds) pond.dispose();
      },
    };
  }
  const [cx = 0, cz = 0] = lake.at;
  const measuredReach = waterlineRadius(field, lake.at, lake.level) * LAKE.reach;
  const reach = limitToFootprint ? Math.min(measuredReach, lake.radius) : measuredReach;
  if (reach <= 0) return undefined;

  const { rings, spokes } = LAKE;
  const vertexCount = rings * spokes + 1;
  const positions = new Float32Array(vertexCount * 3);
  const metreDepths = new Float32Array(vertexCount);
  const waveDepths = new Float32Array(vertexCount);

  const place = (index: number, radius: number, spoke: number): void => {
    const angle = (spoke / spokes) * Math.PI * 2;
    const x = Math.max(
      field.origin.x - field.width / 2,
      Math.min(field.origin.x + field.width / 2, cx + Math.cos(angle) * radius),
    );
    const z = Math.max(
      field.origin.z - field.depth / 2,
      Math.min(field.origin.z + field.depth / 2, cz + Math.sin(angle) * radius),
    );
    const depth = Math.min(MAX_BAKED_DEPTH, Math.max(0, lake.level - field.heightAt(x, z)));
    positions[index * 3] = x;
    positions[index * 3 + 1] = lake.level;
    positions[index * 3 + 2] = z;
    metreDepths[index] = depth;
    waveDepths[index] = Math.min(1, depth / OPAQUE_DEPTH);
  };
  place(0, 0, 0);
  for (let ring = 1; ring < rings; ring += 1) {
    const radius = reach * (ring / (rings - 1)) ** LAKE.packing;
    for (let spoke = 0; spoke < spokes; spoke += 1)
      place(1 + (ring - 1) * spokes + spoke, radius, spoke);
  }

  const indices: number[] = [];
  for (let spoke = 0; spoke < spokes; spoke += 1) {
    const first = 1 + spoke;
    const next = 1 + ((spoke + 1) % spokes);
    // Keeping the cells with a single wet corner is what gives the alpha ramp below a strip of dry
    // ground to fade out over, instead of ending abruptly on the waterline itself.
    if (
      (waveDepths[0] as number) + (waveDepths[first] as number) + (waveDepths[next] as number) >
      0
    )
      indices.push(0, first, next);
  }
  for (let ring = 2; ring < rings; ring += 1) {
    for (let spoke = 0; spoke < spokes; spoke += 1) {
      const next = (spoke + 1) % spokes;
      const inner = 1 + (ring - 2) * spokes + spoke;
      const innerNext = 1 + (ring - 2) * spokes + next;
      const outer = 1 + (ring - 1) * spokes + spoke;
      const outerNext = 1 + (ring - 1) * spokes + next;
      const wet =
        (waveDepths[inner] as number) +
        (waveDepths[innerNext] as number) +
        (waveDepths[outer] as number) +
        (waveDepths[outerNext] as number);
      if (wet <= 0) continue;
      indices.push(inner, outer, innerNext, innerNext, outer, outerNext);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute("waveDepth", new BufferAttribute(waveDepths, 1));
  geometry.setAttribute("metres", new BufferAttribute(metreDepths, 1));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const surface = new WaterSurface3D({
    level: lake.level,
    maxThickness: MAX_BAKED_DEPTH * 2,
    // Everything but water: the camera sees layer 0 and WATER_LAYER, the mirror only layer 0.
    reflection: { ...LAKE.mirror },
  });
  const time = uniform(0);
  const waveDepth = attribute<"float">("waveDepth", "float");
  const depthM = attribute<"float">("metres", "float");
  const here = vec2(positionWorld.x, positionWorld.z);
  const eyeDistance = here.sub(vec2(cameraPosition.x, cameraPosition.z)).length();

  const patch = windPatch(here, time, PATCH_METRES, PATCH_DRIFT, [0.62, -0.78]);
  // One evaluation of the field per fragment: no texture, no stripe term, no screen-space anything.
  // The short waves are gated by both distance and the wind patch, and the whole horizontal part is
  // graded by distance, because a far pixel covers many ripples and shows their average.
  const detailFade = float(1)
    .sub(smoothstep(float(DETAIL_NEAR), float(DETAIL_FAR), eyeDistance))
    .mul(patch);
  const raw = RIPPLE.normalNode({ fade: detailFade, point: here, time });
  const gain = slopeGain(eyeDistance, patch, depthM);
  const normal = normalize(vec3(raw.x.mul(gain), raw.y, raw.z.mul(gain)));
  // The same surface read with less of its slope, for the mirror alone; the glint and the caustics
  // keep the sharp one.
  const reflectGain = gain.mul(REFLECT_SLOPE_SHARE);
  const reflectNormal = normalize(vec3(raw.x.mul(reflectGain), raw.y, raw.z.mul(reflectGain)));

  // Vertices ride the four long waves only. The short ones are shorter than this grid's rings, so
  // displacing by them would alias into a stair pattern the normal above already draws for free.
  const material = new MeshBasicNodeMaterial({
    // Writing depth, which for a transparent surface wants a reason: the passes that read depth and
    // normals under every water pixel would otherwise find the lake bed at a grazing angle, where its
    // triangle rows are a few pixels apart and its depth derivative is enormous.
    depthWrite: true,
    // Both sides: the basin is shallow but the walker wades in, so the camera goes under this
    // surface and has to find something drawn there. See the Snell's window branch below.
    side: DoubleSide,
    transparent: true,
  });
  material.positionNode = vec3(
    positionLocal.x,
    positionLocal.y.add(RIPPLE.heightNode({ fade: float(0), time }).mul(waveDepth)),
    positionLocal.z,
  );

  const view = normalize(cameraPosition.sub(positionWorld));
  const facing = clamp(dot(normal, view), float(0), float(1));
  const slide = mix(float(REFRACTION_NEAR), float(REFRACTION_FAR), float(1).sub(facing));
  const offset = vec2(normal.x, normal.z)
    .mul(slide)
    .mul(smoothstep(float(0), float(0.4), depthM));
  const bed = surface.refractionAt(offset);
  // A vertical smear, because that is the shape a rippled reflection has: the surface tilts about a
  // horizontal axis far more often than it tilts toward you, so the smear is taller than it is wide
  // and it grows with distance. Five taps on that ellipse; the radius shrinks where the lake is
  // glass, so a calm patch takes the bank sharp and a ruffled one dissolves it.
  const blur = mix(
    float(REFLECT_BLUR_NEAR),
    float(REFLECT_BLUR_FAR),
    smoothstep(float(8), float(60), eyeDistance),
  ).mul(mix(float(0.25), float(1), patch));
  const tap = (dx: number, dy: number): Node<"vec3"> =>
    surface.reflectionAt(
      vec2(
        offset.x.add(blur.mul(float(dx * REFLECT_BLUR_ASPECT))),
        offset.y.add(blur.mul(float(dy))),
      ),
    ) as unknown as Node<"vec3">;
  const mirror = tap(0, 0)
    .mul(0.36)
    .add(tap(0, 1).mul(0.16))
    .add(tap(0, -1).mul(0.16))
    .add(tap(1.3, 0.5).mul(0.16))
    .add(tap(-1.3, -0.5).mul(0.16)) as Node<"vec3">;
  const shaded = compositeWater({ normal, depthM, bed, reflected: mirror });

  // ---- and what the surface is from underneath ----------------------------------------------
  //
  // Nothing about the composite above survives being looked at from below: the fresnel is measured
  // against a ray leaving the water, the refraction reads a bed that is behind the camera, and the
  // mirror aims at a bank the ray cannot reach. Seen from under, the surface is two things either
  // side of the critical angle: look up steeply and the whole sky refracts into a 97° cone, which is
  // the only thing down here that is not dark; look up shallowly and it is a *total* mirror of the
  // bed below. The ripple moves the boundary, which is why a real window has a ragged edge.
  //
  // This is the wading case, and the wading case is the one that matters: across the whole wadeable
  // margin the eye sits under the surface with the bed a metre or two beneath it, so the view the
  // player actually gets is a surface an arm's length overhead mirroring a bed they can almost touch —
  // and a constant colour cannot be that however well the constant is chosen. It photographs as a
  // flat slab with a razor edge against the bed.
  const upward = normalize(positionWorld.sub(cameraPosition));
  const throughSurface = clamp(dot(upward, normal), float(0), float(1));
  const window = smoothstep(float(SNELL_INNER), float(SNELL_OUTER), throughSurface);
  // The mirrored bed, aimed down at a plane rather than out at a ring. The plane is not estimated:
  // `depthM` is baked off the same `heightAt` the collider walks on, so the intersection is one divide.
  const mirrored = upward.reflect(normal);
  const dive = max(mirrored.y.negate(), float(0.06));
  const toBed = min(depthM.div(dive), float(90));
  const bedHit = positionWorld.add(mirrored.mul(toBed));
  const bedClip = cameraProjectionMatrix.mul(
    cameraViewMatrix.mul(vec4(bedHit.x, bedHit.y, bedHit.z, 1)),
  );
  const bedNdc = bedClip.xy.div(max(bedClip.w, float(0.0001)));
  // Clip space puts +1 at the top of the frame and `viewportSharedTexture` samples with 0 there, so
  // the y is negated: written the obvious way every mirrored read comes back about the middle of the
  // screen, which for a ceiling means it reads the sky instead of the bed.
  const bedUv = vec2(bedNdc.x.mul(0.5).add(0.5), bedNdc.y.mul(-0.5).add(0.5));
  const bedInFrame = smoothstep(float(0), float(0.02), bedUv.x)
    .mul(smoothstep(float(1), float(0.98), bedUv.x))
    .mul(smoothstep(float(0), float(0.02), bedUv.y))
    .mul(smoothstep(float(1), float(0.98), bedUv.y))
    .mul(step(float(0.001), bedClip.w));
  const underTap = (dx: number, dy: number): Node<"vec3"> =>
    viewportSharedTexture(
      vec2(
        clamp(bedUv.x.add(float(dx * UNDER_BLUR)), float(0.002), float(0.998)),
        clamp(bedUv.y.add(float(dy * UNDER_BLUR)), float(0.002), float(0.998)),
      ),
    ).rgb as unknown as Node<"vec3">;
  const mirroredBed = underTap(0, 0)
    .mul(0.5)
    .add(underTap(0.9, 0.5).mul(0.25))
    .add(underTap(-0.9, -0.5).mul(0.25)) as Node<"vec3">;
  // Both legs of that path are under water, so Beer-Lambert applies to the whole of it: down to the
  // bed and back to the eye. This is what turns the ceiling from a slab into something with depth in
  // it — bright where the water is thin, the water's own colour by the far side of the frame.
  const underPath = min(toBed.add(positionWorld.sub(cameraPosition).length()), float(40));
  const underTint = exp(vec3(-EXTINCTION[0], -EXTINCTION[1], -EXTINCTION[2]).mul(underPath));
  const ceiling = linear(TINT.deep, 0.35)
    .add(linear(TINT.silt, 0.22))
    .mul(mix(float(0.5), float(1.4), throughSurface));
  const mirrorBelow = mirroredBed
    .mul(bedInFrame)
    .mul(underTint)
    .add(ceiling.mul(float(1).sub(underTint.mul(bedInFrame))));
  // The sky as it arrives after a metre or two of water: the horizon band, drained of red the way
  // everything under water is.
  const skyThrough = mix(
    color(TINT.skyHorizon),
    color(TINT.skyZenith),
    clamp(upward.y, float(0), float(1)),
  )
    .mul(vec3(0.55, 0.92, 1))
    .mul(1.35);
  const sunDisc = pow(clamp(dot(upward, SUN_VECTOR), float(0), float(1)), 90)
    .mul(window)
    .mul(2.2);
  const below = mix(mirrorBelow, skyThrough, window).add(linear(SUN.colour, 0.65).mul(sunDisc));

  // Which of the two the camera is looking at, on its own height. Uniform across the draw, so both
  // sides costing a multiply is the whole price of not writing two materials. A ten-centimetre blend
  // rather than a step, because the walker crosses this line on foot and a hard flip is a one-frame
  // pop in the middle of walking into a lake.
  const eyeIsAbove = smoothstep(
    float(lake.level - 0.05),
    float(lake.level + 0.05),
    cameraPosition.y,
  );
  material.colorNode = mix(below, shaded, eyeIsAbove);
  // From underneath there is no shore to dissolve into and the ceiling is opaque.
  const opacity = mix(float(1), shoreFade(depthM), eyeIsAbove);
  material.opacityNode = opacity;
  if (limitToFootprint) {
    const edge = positionWorld.xz.sub(vec2(cx, cz)).length();
    material.opacityNode = opacity.mul(float(1).sub(smoothstep(reach * 0.82, reach, edge)));
  }

  const mesh = new Mesh(geometry, material);
  mesh.layers.set(WATER_LAYER);
  mesh.name = "lake-surface";
  // Drawn after the opaque valley, and after the scatter, so the shore blends over both.
  mesh.renderOrder = 2;
  return {
    mesh,
    reflectionAt: (offset) => surface.reflectionAt(offset) as unknown as Node<"vec3">,
    advance(elapsed) {
      time.value = elapsed;
    },
    dispose() {
      surface.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
}
