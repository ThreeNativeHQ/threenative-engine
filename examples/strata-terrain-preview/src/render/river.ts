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
//   reflection would be right at one bend and wrong everywhere else; the banks and the sky come back
//   by a reflected-ray march over the frame (`traceReflection`), over an analytic sky where the ray
//   leaves the screen. Tundra channels share the kettle ponds' existing mirrors, blended by
//   elevation, so the stream and pond meet without a reflection-colour seam.
//
// Nothing here decides a colour for the engine: `WaterSurface3D` measures metres and hands back the
// frame beneath the surface and the world mirrored in it, and every number under LOOK below is this
// game's. One rule worth carrying: **`new Color(hex)` already converts sRGB to linear**, because
// three enables `ColorManagement` by default — calling `convertSRGBToLinear()` on top of it darkens
// every palette colour by a factor between three and thirteen, and the shader then reads as "wants
// turning up" rather than as broken.
import { WaterSurface3D, WaveField } from "@threenative/core";
import {
  type Heightfield,
  lakeReach,
  lakeSurfaceGeometry,
  riverRibbonGeometry,
} from "@threenative/core/world";
import { BufferAttribute, BufferGeometry, Color, DoubleSide, Mesh } from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import {
  attribute,
  cameraFar,
  cameraNear,
  cameraPosition,
  cameraProjectionMatrix,
  cameraViewMatrix,
  clamp,
  color,
  dFdx,
  dFdy,
  dot,
  exp,
  float,
  linearDepth,
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
  viewportDepthTexture,
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

/**
 * Metres a second the forest stream flows. Unreal leaves it to the level's `WaterVelocityScalar`
 * spline curve, defaulting to 128 cm/s (UE 5.8.3:
 * Engine/Plugins/Experimental/Water/Source/Runtime/Public/WaterSplineMetadata.h:40), which is a
 * river at its steepest; a lowland forest stream this size runs slower, so 0.9 m/s. The surface
 * ripples advect at it and `waterCurrentAt` carries a swimmer with it, so what is drawn and what
 * pushes the player are the same flow.
 */
export const RIVER_FLOW_MPS = 0.9;

/** The stream's shape. The surface's geometry is core's `riverRibbonGeometry`, at the reach `WaterBodies` floods. */
const RIVER = {
  /** Metres of water over the deepest point of the bed. The bank rises out of it on its own. */
  fill: 1.1,
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
   * The ripple scales: feature size across the current in metres, how much longer each is along it,
   * the share of `RIVER_FLOW_MPS` it drifts downstream at, and the slope it adds. The shares average
   * one, so the surface moves at the flow the player is carried at, and their spread keeps the
   * scales sliding over each other instead of scrolling as one sheet. The old gains summed to slopes of one to
   * four, a 45-75 degree chop that read as crumpled plastic. Each scale fades out once one pixel
   * covers a fifth of it; see `footprint` in `createRivers`.
   */
  ripples: [
    { metres: 2.4, stretch: 1.7, flow: 0.8, slope: 0.09 },
    { metres: 0.85, stretch: 1.5, flow: 1, slope: 0.08 },
    { metres: 0.3, stretch: 1.3, flow: 1.2, slope: 0.06 },
  ],
} as const;

/**
 * The reflected-ray march: steps, the first step in metres, how much each step grows, and the edge
 * fade. Geometric steps resolve the bank a metre off and still reach the far shore. 14 steps reach
 * 0.45 * (1.3^14 - 1) / 0.3 = 58 m. Past that, a direction read takes over; see `traceReflection`.
 */
const TRACE = { steps: 14, first: 0.45, growth: 1.3 } as const;

/**
 * How far past a basin's measured waterline a lake's water reaches, so the real shore stands inside
 * it. The drawn surface and the swim footprint both size themselves at it.
 */
export const LAKE_REACH = 1.12;

/** The lake's shape, and how its mirror is taken. Every number here is this game's. */
const LAKE = {
  /**
   * Mirror pixels as a share of the frame's, how often it redraws, and the layer mask it draws. Half
   * the frame's pixels, as Unreal's planar reflection takes by default (UE 5.8.3:
   * Engine/Source/Runtime/Engine/Private/Components/SceneCaptureComponent.cpp:1136,
   * `ScreenPercentage = 50`): the mirror draws the full ground material, and at full size it cost a
   * third of the overview's ground time for a reflection the ripples scatter anyway.
   */
  mirror: { resolutionScale: 0.5, refreshInterval: 2, layers: 1 << REFLECTED_LAYER },
  /** Rings and spokes in the disc the basin is meshed as. */
  rings: 44,
  spokes: 88,
  /** How far past the measured waterline the mesh reaches, so the real shore is inside it. */
  reach: LAKE_REACH,
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

/** The analytic sky's gain, to sit at the drawn sky's radiance where the two meet at a frame edge. */
const SKY_GAIN = 0.65;

/**
 * Haze on a reflected far read: clear for the first metres, as the post's aerial perspective is
 * (`atmosphere.ts`, 150 m), then an exponential toward the horizon colour.
 */
const HAZE_CLEAR = 150;
const HAZE_METRES = 1600;

/**
 * GGX roughness of the capillary ripple below every drawn wave, and of a far lake whose waves the
 * pixel averages: Unreal's water material ships a roughness of 0.1 for that reason.
 */
const ROUGHNESS_NEAR = 0.04;
const ROUGHNESS_FAR = 0.13;
/** Peak glint per unit of sun irradiance: a facet can be bright, not a white spark that blooms. */
const GLINT_CAP = 3;

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
  /**
   * GGX roughness of the sun's lobe: a floor for the capillary ripple no normal draws, plus the
   * slope of every ripple too fine for the pixel. A far pixel averages many facets, so its glint
   * spreads into a glitter path instead of aliasing into separate white sparks.
   */
  readonly roughness: Node<"float">;
  /** What this water absorbs and scatters back. The lake's own when omitted. */
  readonly body?: IWaterBody;
}

/** A water body's colour: extinction per metre (linear RGB), and its scatter, shallow and deep. */
interface IWaterBody {
  readonly extinction: readonly [number, number, number];
  readonly shallow: number;
  readonly shallowGain: number;
  readonly deep: number;
  readonly deepGain: number;
}

const LAKE_BODY: IWaterBody = {
  extinction: EXTINCTION,
  shallow: TINT.silt,
  shallowGain: TINT.shallow,
  deep: TINT.deep,
  deepGain: TINT.deepGain,
};

/**
 * The forest stream's body: clear over the gravel, green-brown where it deepens. Leaf tannin takes
 * blue first and red second, so a metre of it reads olive rather than the lake's teal.
 */
const STREAM_BODY: IWaterBody = {
  extinction: [0.85, 0.55, 1.25],
  shallow: 0x9a9468,
  shallowGain: 0.07,
  deep: 0x34401f,
  deepGain: 0.3,
};

/** The composite: what comes up through the surface, what sits on it, and the sun's glint. */
function compositeWater(surface: IWaterShading): Node<"vec3"> {
  const { normal, depthM, bed, reflected, roughness } = surface;
  const water = surface.body ?? LAKE_BODY;
  const view = normalize(cameraPosition.sub(positionWorld));
  const facing = clamp(dot(normal, view), float(0), float(1));
  // Schlick at water's 1.333 index: F0 is 0.02, which is why still water at your feet is nearly
  // clear and the same water at the far bank is a mirror.
  const fresnel = float(0.02).add(pow(float(1).sub(facing), 5).mul(0.98));

  // How far light travels through this water to reach the eye: straight down it is the baked depth,
  // at a grazing angle it is far further, which is the whole reason water is clear at your feet and
  // opaque at the far bank. The floor on `facing` keeps a horizon fragment asking for a kilometre.
  const path = min(depthM.div(max(facing, float(0.12))), float(MAX_BAKED_DEPTH * 1.6));
  const tint = exp(
    vec3(-water.extinction[0], -water.extinction[1], -water.extinction[2]).mul(path),
  );

  // Caustics: the same analytic normal that bends the reflection focuses the sun onto the bed, so the
  // bright cells are where the surface happens to point at it, drifting with the ripple causing them.
  // Killed with depth, because a caustic is a shallow-water phenomenon and the bed at two metres is
  // in shade.
  const focus = pow(clamp(dot(normal, SUN_VECTOR), float(0), float(1)), 34);
  const caustic = focus.mul(1.7).mul(float(1).sub(smoothstep(float(0.15), float(1.9), depthM)));

  // What the water body itself scatters back: silt at the margin, the lake's own green in the middle.
  // The gains are small because these are radiances, not albedos: a fraction of what the bank returns.
  const shallowBody = linear(water.shallow, water.shallowGain).mul(vec3(1.06, 1, 0.74));
  const deepBody = linear(water.deep, water.deepGain);
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

  // The sun off the same normal, as GGX with Schlick's fresnel and the Kelemen visibility term: lit
  // by the sun's own irradiance, so its brightness agrees with the ground it shines on. The cap
  // keeps a single facet from blooming into a hard white spark.
  const halfway = normalize(view.add(SUN_VECTOR));
  const nh = clamp(dot(normal, halfway), float(0), float(1));
  const a2 = roughness.mul(roughness);
  const lobe = nh.mul(nh).mul(a2.sub(1)).add(1);
  const vh = clamp(dot(view, halfway), float(0.05), float(1));
  const sunFresnel = float(0.02).add(pow(float(1).sub(vh), 5).mul(0.98));
  const glint = a2
    .div(lobe.mul(lobe).mul(Math.PI))
    .mul(sunFresnel)
    .mul(clamp(dot(normal, SUN_VECTOR), float(0), float(1)))
    .div(vh.mul(vh).mul(4));
  return composited.add(linear(SUN.colour, SUN.intensity).mul(min(glint, float(GLINT_CAP))));
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

/** The analytic sky along a reflected ray, at the frame's radiance, for rays off the screen. */
function skyAlong(bounced: Node<"vec3">): Node<"vec3"> {
  return mix(
    color(TINT.skyHorizon),
    color(TINT.skyZenith),
    clamp(bounced.y, float(0), float(1)),
  ).mul(SKY_GAIN);
}

/**
 * The frame reflected along `direction` from this fragment, over `fallback` where the frame cannot
 * say: what a planar mirror cannot give a stream that falls along its length, and what the lake's
 * ground-only mirror leaves out, the spruces on the far bank.
 *
 * Unreal's single-layer water takes the scene's own screen-space reflections (UE 5.8.3:
 * Engine/Source/Runtime/Renderer/Private/SingleLayerWaterRendering.cpp:69), marched in 16 steps at
 * the default quality (Engine/Shaders/Private/SSRT/SSRTReflections.usf:203) and faded over the outer
 * fifth of the screen (Engine/Shaders/Private/SSRT/SSRTRayCast.ush:674-680). Here the steps grow in
 * metres instead (`TRACE`). Past the last step the ray's own direction is read off the screen: sky, a
 * mountain or a stand of trees far enough away that the parallax a march corrects is under a pixel.
 */
function traceReflection(direction: Node<"vec3">, fallback: Node<"vec3">): Node<"vec3"> {
  const span = cameraFar.sub(cameraNear);
  const sceneMetres = (uv: Node<"vec2">): Node<"float"> =>
    linearDepth(viewportDepthTexture(clamp(uv, vec2(0.001, 0.001), vec2(0.999, 0.999))))
      .mul(span)
      .add(cameraNear);
  const screen = (clip: Node<"vec4">): { ndc: Node<"vec2">; uv: Node<"vec2"> } => {
    const ndc = clip.xy.div(max(clip.w, float(0.0001)));
    // Clip space has +1 at the top and the frame samples with 0 there; see the mirrored bed below.
    return { ndc, uv: vec2(ndc.x.mul(0.5).add(0.5), ndc.y.mul(-0.5).add(0.5)) };
  };
  const inside = (ndc: Node<"vec2">): Node<"float"> =>
    step(max(ndc.x.abs(), ndc.y.abs()), float(1));
  const vignette = (ndc: Node<"vec2">): Node<"float"> => {
    const edge = clamp(ndc.abs().mul(5).sub(4), vec2(0, 0), vec2(1, 1));
    return clamp(float(1).sub(dot(edge, edge)), float(0), float(1));
  };

  let found: Node<"float"> = float(0);
  let hitUv: Node<"vec2"> = vec2(0.5, 0.5);
  let hitNdc: Node<"vec2"> = vec2(0, 0);
  let stride: number = TRACE.first;
  let reached = 0;
  for (let index = 0; index < TRACE.steps; index += 1) {
    reached += stride;
    const point = positionWorld.add(direction.mul(reached));
    const clip = cameraProjectionMatrix.mul(
      cameraViewMatrix.mul(vec4(point.x, point.y, point.z, 1)),
    );
    const { ndc, uv } = screen(clip);
    // `clip.w` is the point's metres in front of the eye, the same measure as the frame's depth.
    const behind = clip.w.sub(sceneMetres(uv));
    const hit = step(float(0), behind)
      .mul(step(behind, float(stride * 1.6 + 0.25)))
      .mul(inside(ndc))
      .mul(step(float(0.05), clip.w));
    const take = hit.mul(float(1).sub(found));
    hitUv = mix(hitUv, uv, take);
    hitNdc = mix(hitNdc, ndc, take);
    found = found.add(take);
    stride *= TRACE.growth;
  }
  const away = cameraProjectionMatrix.mul(
    cameraViewMatrix.mul(vec4(direction.x, direction.y, direction.z, 0)),
  );
  const far = screen(away);
  // A direction off the side of the frame reads its edge column (sky, the tree line) and fades out
  // half a frame further; only the top and bottom take Unreal's vignette, so no seam crosses the water.
  const farUv = vec2(clamp(far.uv.x, float(0.001), float(0.999)), far.uv.y);
  const farMetres = sceneMetres(farUv);
  const farWeight = step(float(0.02), away.w)
    .mul(step(far.ndc.y.abs(), float(1)))
    .mul(float(1).sub(smoothstep(float(1), float(1.5), far.ndc.x.abs())))
    .mul(step(float(reached), farMetres))
    .mul(vignette(vec2(0, far.ndc.y)));
  // The haze is a post pass over the frame's depth, so a far read comes back clear and the water's
  // own depth hazes it by the eye's leg only. The reflected leg is put back here, in the sky's
  // horizon colour; the sky itself (depth at the far plane) takes none.
  const hazed = float(1)
    .sub(exp(farMetres.sub(HAZE_CLEAR).max(0).div(-HAZE_METRES)))
    .mul(step(farMetres, cameraFar.mul(0.999)));
  const distant = mix(
    fallback,
    mix(
      viewportSharedTexture(farUv).rgb as unknown as Node<"vec3">,
      color(TINT.skyHorizon).mul(SKY_GAIN),
      hazed,
    ),
    farWeight,
  );
  return mix(
    distant,
    viewportSharedTexture(hitUv).rgb as unknown as Node<"vec3">,
    found.mul(vignette(hitNdc)),
  );
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

/**
 * Draw every baked river as one surface, or nothing when the world has none.
 *
 * A river stands on its bed's measured footprint: the baked spline's own heights across 2.5 widths,
 * which is where the player swims and where the bake's own shore is.
 */
export function createRivers(
  rivers: readonly IBakedRiver[],
  field: Heightfield,
  lakeReflection?: (offset: Node<"vec2">) => Node<"vec3">,
): IRiverWater | undefined {
  if (rivers.length === 0) return undefined;
  const geometry = riverRibbonGeometry(rivers, field, {
    columns: RIVER.across,
    maxDepth: MAX_BAKED_DEPTH,
  });

  const surface = new WaterSurface3D({ level: 0, maxThickness: MAX_BAKED_DEPTH * 2 });
  const time = uniform(0);
  const depthM = attribute<"float">("metres", "float");
  const heading = normalize(attribute<"vec2">("flow", "vec2"));
  const here = vec2(positionWorld.x, positionWorld.z);
  // Metres down the centreline and metres across it, baked per vertex. These were once
  // `dot(world xz, heading)`: 180 m from the origin, a 3 degree turn between two stations moved
  // that frame by 9 m, so one metre of water read 3-6 m of noise and the ripples fanned out from
  // the bends in radial streaks (stations 50-70 measured d(side)/ds = -1.4 to -5.9).
  const flowUv = attribute<"vec2">("flowUv", "vec2");
  const along = flowUv.x;
  const side = flowUv.y;
  // The long axis of the ellipse one pixel covers on the water, in metres. At a grazing angle it is
  // metres long even near the eye, and a ripple finer than that aliases into streaks: each scale
  // fades out between a pixel covering an eighth and nearly half of it, as a mip chain would.
  const footprint = max(dFdx(flowUv).length(), dFdy(flowUv).length());
  const octaves = RIVER.ripples.map((wave) => ({
    ...wave,
    weight: float(1).sub(
      smoothstep(float(wave.metres * 0.12), float(wave.metres * 0.45), footprint),
    ),
  }));

  // Ripples are noise drawn longer along the current and slid downstream at the river's own flow
  // speed, the same `RIVER_FLOW_MPS` the player is carried at, so the water they see moves with the
  // water that moves them. The height sums them in metres, and the normal is its gradient by finite
  // difference in the current's own frame, rotated back into the world's by the baked heading.
  const height = (a: Node<"float">, b: Node<"float">): Node<"float"> => {
    let sum: Node<"float"> = float(0);
    for (const wave of octaves) {
      const length = wave.metres * wave.stretch;
      const octave = mx_noise_float(
        vec3(
          a.sub(time.mul(RIVER_FLOW_MPS * wave.flow)).div(length),
          b.div(wave.metres),
          time.mul(0.11),
        ),
      );
      sum = sum.add(octave.mul(wave.weight.mul(wave.slope * wave.metres)));
    }
    return sum;
  };
  const h0 = height(along, side);
  const delta = 0.03;
  const dAlong = height(along.add(delta), side).sub(h0).div(delta);
  const dSide = height(along, side.add(delta)).sub(h0).div(delta);
  const patch = windPatch(here, time, RIVER.patch.metres, RIVER.patch.drift, RIVER.patch.wind);
  const gain = mix(float(PATCH_CALM), float(1), patch).mul(
    smoothstep(float(0), float(RIPPLE_DEPTH), depthM),
  );
  const alongSlope = dAlong.mul(gain).negate();
  const sideSlope = dSide.mul(gain).negate();
  const normal = normalize(
    vec3(
      heading.x.mul(alongSlope).sub(heading.y.mul(sideSlope)),
      float(1),
      heading.y.mul(alongSlope).add(heading.x.mul(sideSlope)),
    ),
  );

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

  // The stream falls along its length, so no one planar mirror fits it: the banks and the sky come
  // back by a reflected-ray march over the frame, with an analytic sky on a floor of the wood that
  // stands on both banks (`TINT.bank`) wherever the ray leaves the screen.
  const bounced = view.negate().reflect(normal);
  const sky = mix(
    linear(TINT.bank, TINT.bankGain * SKY_GAIN),
    skyAlong(bounced),
    // A low reflected ray hits the wooded bank. Blend its average green radiance into sky
    // over a broad angle; a hard dark cutoff makes moving facets flicker as black blobs.
    smoothstep(float(0.08), float(0.5), bounced.y),
  );
  const reflected = traceReflection(bounced, lakeReflection ? lakeReflection(offset) : sky);
  // The slope the faded scales would have drawn, as GGX roughness (alpha = sqrt(2) sigma).
  const unresolved = octaves.reduce<Node<"float">>(
    (sum, wave) =>
      sum.add(
        float(1)
          .sub(wave.weight)
          .mul(2 * wave.slope * wave.slope),
      ),
    float(ROUGHNESS_NEAR * ROUGHNESS_NEAR),
  );
  const shaded = compositeWater({
    normal,
    depthM,
    bed,
    reflected,
    roughness: unresolved.sqrt(),
    // A channel between kettle ponds takes the ponds' own water, so the two meet without a seam.
    body: lakeReflection ? LAKE_BODY : STREAM_BODY,
  });

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
  // The height as a share of its peak, so the streak threshold reads on the same -1..1 as the noise.
  const peak = RIVER.ripples.reduce((sum, wave) => sum + wave.slope * wave.metres, 0);
  const streak = smoothstep(float(0.78), float(0.92), h0.div(peak).mul(0.5).add(0.5)).mul(0.035);
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

/**
 * Draw the baked lake as one surface: Wildwood's water, over this basin's own depth.
 *
 * The mesh is a disc whose rings pack towards the middle, because this basin is not round: it is a
 * compact bowl with one flooded arm running east a hundred metres, and a square grid big enough to
 * hold the arm would spend four hundred thousand vertices on dry hillside. Only cells with water in
 * at least one corner get triangles — that is what keeps the surface from showing as a sheet hovering
 * over the meadow, and what leaves the shoreline on the ground's own contour.
 *
 * A lake stands inside its own footprint too: the waterline the bake measured, capped at the radius
 * the biome file names.
 */
export function createLakes(
  lakes: readonly IBakedLake[],
  field: Heightfield,
): IRiverWater | undefined {
  const lake = lakes[0];
  if (lake === undefined) return undefined;
  if (lakes.length > 1) {
    const ponds = lakes.map((one) => createLakes([one], field)).filter((one) => one !== undefined);
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
  const footprint = { ...lake, margin: LAKE.reach };
  // The material fades the rim out at the same reach the geometry stops at.
  const reach = lakeReach(field, footprint);
  const geometry = lakeSurfaceGeometry(footprint, field, {
    maxDepth: MAX_BAKED_DEPTH,
    packing: LAKE.packing,
    rings: LAKE.rings,
    spokes: LAKE.spokes,
  });
  if (geometry === undefined) return undefined;
  // The ripple's share of the depth, this game's look: full past OPAQUE_DEPTH, none on the shore.
  const metres = geometry.getAttribute("metres");
  const waveDepths = new Float32Array(metres.count);
  for (let index = 0; index < metres.count; index += 1)
    waveDepths[index] = Math.min(1, metres.getX(index) / OPAQUE_DEPTH);
  geometry.setAttribute("waveDepth", new BufferAttribute(waveDepths, 1));

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
    // One draw for both sides: the camera is on one side of a near-flat sheet at a time. three's
    // default draws a transparent double-sided material twice, flipping `side` between the draws,
    // and on the streamed ground that flip rebuilt this pipeline 58 times in one turn (PRD-790).
    forceSinglePass: true,
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
  // The mirror draws the ground only, and nothing where the sky is. The spruces on the far bank and
  // the sky come from the frame; a steep ray that leaves the screen finds the analytic sky, a low
  // one the mirrored ground.
  const bounced = normalize(cameraPosition.sub(positionWorld)).negate().reflect(reflectNormal);
  const reflected = traceReflection(
    bounced,
    mix(mirror, skyAlong(bounced), smoothstep(float(0.12), float(0.4), bounced.y)),
  );
  const shaded = compositeWater({
    normal,
    depthM,
    bed,
    reflected,
    roughness: mix(
      float(ROUGHNESS_NEAR),
      float(ROUGHNESS_FAR),
      smoothstep(float(DETAIL_NEAR), float(SLOPE_FADE_FAR * 2), eyeDistance),
    ).mul(mix(float(0.7), float(1), patch)),
  });

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
  // The surface fades out at the footprint it was drawn to, so its rim is not a cut edge.
  const edge = positionWorld.xz.sub(vec2(cx, cz)).length();
  material.opacityNode = opacity.mul(float(1).sub(smoothstep(reach * 0.82, reach, edge)));

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
