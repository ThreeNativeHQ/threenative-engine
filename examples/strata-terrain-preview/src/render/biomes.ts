import { measureBands } from "@threenative/terrain";
import { ACESFilmicToneMapping, AgXToneMapping, type Texture, type ToneMapping } from "three";
/** Game-owned biome choices; all five worlds share the same rendering and collision paths. */
import {
  abs,
  dot,
  float,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  mx_worley_noise_vec2,
  normalWorldGeometry,
  positionWorld,
  rotateUV,
  smoothstep,
  texture,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import type { Node } from "three/webgpu";
import {
  GROUND_MAPS,
  type IGroundMaps,
  type LayerKey,
  ROCKFACE_MAPS,
} from "../world/terrainAssets.js";
import type { WORLD_NAMES } from "./worldNames.js";

export type WorldName = (typeof WORLD_NAMES)[number];
type RGB = readonly [number, number, number];

/** Where a pinned vista camera looks, from the player it tracks. */
export interface IVistaAim {
  /** Metres along x and z from the player that the camera looks at. */
  readonly at: readonly [number, number];
  /** Metres above the player's feet, or null to look level with the world's own water. */
  readonly rise: number | null;
}

type HeightBand =
  | "alpine"
  | "rock"
  | "treeline"
  | "cap"
  | "desertRock"
  | "alpineRock"
  | "alpineHollow";
type HeightBands = Readonly<Record<HeightBand, readonly [number, number]>>;

export interface IBiome {
  readonly world: WorldName;
  readonly grassTint: RGB;
  readonly stoneTint: RGB;
  /** Prop-only tint; terrain rock keeps its own grading. */
  readonly propStoneTint?: RGB;
  readonly snowTint: RGB;
  readonly distantStone: RGB;
  readonly snowFractions: readonly [number, number, number];
  readonly heightFractions: HeightBands;
  readonly maps: Record<LayerKey, IGroundMaps>;
  readonly horizon: "mountain" | "alpine" | "mesa" | "plain";
  readonly sun: {
    readonly color: number;
    readonly intensity: number;
    readonly direction: RGB;
    readonly shadowRadius: number;
  };
  readonly sky: {
    turbidity: number;
    rayleigh: number;
    mieCoefficient: number;
    mieDirectionalG: number;
  };
  readonly fill: { readonly sky: number; readonly ground: number; readonly intensity: number };
  readonly haze: {
    readonly color: number;
    readonly density: number;
    readonly valleyDensity: number;
    readonly height: number;
    readonly sunScatter: number;
  };
  readonly atmosphere: {
    readonly rayleigh: RGB;
    readonly mie: number;
    readonly radiance: number;
    readonly distanceScale: number;
    readonly horizonFade: readonly [number, number];
    /**
     * Alpine air past the playable valley: exponential height fog (UE's two-term
     * `ExponentialHeightFog`) in place of the local haze tint, and `distanceScale` in place of the
     * valley's, blended in over `reach` metres so the valley keeps its clear air. A ridge above the
     * layers stays clear and a valley under them fills with mist. Each term is an extinction per
     * metre at `height` that falls by e every `scale` metres up; `start` is the clear foreground in
     * metres. Absent, the world keeps the distance-squared haze everywhere.
     */
    readonly heightFog?: {
      readonly reach: readonly [number, number];
      readonly distanceScale: number;
      readonly start: number;
      readonly terms: readonly {
        readonly density: number;
        readonly height: number;
        readonly scale: number;
      }[];
    };
    /**
     * Mist between the stands of a wood: a third exponential layer (same integral as `heightFog`,
     * UE 5.8.3: Engine/Shaders/Private/HeightFogCommon.ush:207-214) that starts `start` metres from
     * the eye and lies on the valley floor, so each stand behind the next is a little paler and the
     * low sun glows in the air. `maxOpacity` is UE's `FogMaxOpacity`: a far stand keeps its shape.
     * `color` is the mist in shade. Absent, the foreground air is clear.
     */
    readonly groundMist?: {
      readonly color: number;
      readonly start: number;
      readonly maxOpacity: number;
      readonly term: { readonly density: number; readonly height: number; readonly scale: number };
    };
  };
  readonly skyRadiance: number;
  readonly saturation: number;
  readonly skySaturation: number;
  readonly exposure: number;
  /** The tone curve this world was graded under. */
  readonly toneMapping: ToneMapping;
  /** The ground is graded from the bake's own photographed turf, not from measured layers. */
  readonly lawnGround: boolean;
  /** Bare bedded rock and dirt: the ground keeps its beds and carries no snow. */
  readonly mesaGround: boolean;
  /** Moss and lichen mats lie over the ground, from the polygon field. */
  readonly mossGround: boolean;
  /** Rock walls read the crest projection and hold snow in their own bands. */
  readonly crestRock: boolean;
  /** Metres a hollow lifts the snowline probe: a sheltered shelf keeps its snow. */
  readonly snowHollowLift: number;
  /** Steepness, 0..1, the snow starts to shed at. */
  readonly snowShedFrom: number;
  /** Snow comes from this look's own weight graph rather than from the crest snow cover. */
  readonly localSnow: boolean;
  /** The turf fades to a distant cover colour, and loses its relief, with distance. */
  readonly crestTurf: boolean;
  /** The meadow here is an olive field of blades, mixed into the lawn by the open ground. */
  readonly oliveMeadow: boolean;
  /** The rock carries bedded mesa bands: the desert's own projection and varnish. */
  readonly mesaRock: boolean;
  /** Loose sand on the ground ripples, and the ripples flatten where the sand is wet. */
  readonly sandRipples: boolean;
  /** The open meadow past the square's edge belongs to this look. */
  readonly openMeadow: boolean;
  /** The ground under a closed stand: needle litter, bare earth and its shade. */
  readonly woodedGround: boolean;
  /** A shore's ground: dry soil patches between the sand banks. */
  readonly shoreGround: boolean;
  /** The far backdrop keeps the survey's own look instead of the crest's spruce stands. */
  readonly surveyedBackdrop: boolean;
  /** The backdrop shades from this look's unfiltered survey collar. */
  readonly surveyCollar: boolean;
  /** The terrain mesh casts shadows: a massif casts onto its own valley. */
  readonly terrainCastsShadow: boolean;
  /** Metres the ground's own masks extend past the playable square; zero for no collar. */
  readonly groundCollarMeters: number;
  /** The collar carries the distant rock tilt; a mat plain keeps its resident normals. */
  readonly continuationTilt: boolean;
  /** How far a stone's albedo is pulled to grey. */
  readonly stoneGrey: number;
  /** How far distant stone fades to the massif's own tone. */
  readonly distantStoneShare: number;
  /**
   * Share of a stone's height the ground snap sinks it by once its footprint's four points have also
   * been snapped, so a boulder settles into a slope instead of hanging on one contact; null for a
   * stone snapped at its centre only.
   */
  readonly stoneSinkShare: number | null;
  /** How many prepared stone scans this look's props use; a second fills the pack's primitive slot. */
  readonly stoneScans: number;
  /** The tone a ground's distant stone fades to, where it differs from the stone's own. */
  readonly groundDistantStone?: RGB;
  /** A stone's base takes the ground's own contact band. */
  readonly stoneGroundBand: boolean;
  /** That contact band draws the crest rockface rather than the look's own rock. */
  readonly contactRockface: boolean;
  /** Stone draws its shadow from the sun-facing side, so an intersection shows no lit strip. */
  readonly stoneFrontFace: boolean;
  /** The look's stone is dry CC0 scans, without the meadow's moss. */
  readonly dryStones: boolean;
  /** The look's stone carries snow. */
  readonly stoneSnow: boolean;
  /** The tint this look gives a blade of ground cover. */
  readonly propGrassTint: RGB;
  /** How much moss a stone wears over its own albedo, 0..1. */
  readonly stoneMoss: number;
  /** The moss a stone wears, where it wears any. */
  readonly stoneMossTint: RGB;
  /** The flat snow a snowed stone mixes in where it is not crest-mapped. */
  readonly stoneSnowTint: RGB;
  /** The tint this look gives an imported crown. */
  readonly canopyTint: RGB;
  /** The tint this look gives an imported blade or frond. */
  readonly bladeTint: RGB;
  /**
   * The value of every blade, frond and mat against the crowns above them: a sward photographed in
   * midday sun draws brighter than the wood it grows in. Petals keep their photograph. Absent, 1.
   */
  readonly swardTint?: RGB;
  /**
   * Multiplies the open turf the sward grows from. A short blade covers a part of its ground, so a
   * turf several times brighter than the blade draws the blades as black hair on a yellow lawn
   * (measured 4.45 times in the forest's low sun). Absent, the turf keeps its photograph.
   */
  readonly turfTint?: RGB;
  /**
   * The sun's shadow is drawn to a window around the eye, and the far forest casts none, so a tree
   * past either draws fully sunlit beside crowns that stand in each other's shade. This is the mean
   * stand shade such a tree takes at a sun on the horizon (`standShaded`); it fades to none as the
   * sun climbs. Absent, those trees draw unshaded.
   */
  readonly standShade?: RGB;
  /**
   * The share of ambient and sky-image light a plant keeps where the baked canopy closes over it.
   * In the open it sees the whole sky; under a closed wood it sees a few gaps, and at the full value
   * a fern in deep shade glows lime beside ground that takes no sky image at all. Absent, 1.
   */
  readonly understoreySkyLight?: number;
  /** The tint this look gives an imported cutout in its own grading. */
  readonly cutoutTint: RGB;
  /** The tint this look gives an imported stone in its own grading. */
  readonly stoneSectionTint: RGB;
  /** Inner-crown shade, 0..1: how dark the middle of a crown draws. */
  readonly canopyInnerShade: number;
  /** A crown's inner shade runs linear from the geometry's own weight, not squared. */
  readonly canopyLinearInner: boolean;
  /** The crown's inner ambient occlusion: at the trunk, and at the needle tips. */
  readonly canopyAmbientOcclusion: readonly [number, number];
  /** The look's crowns and blades are shaded by its own needle path, not as imported PBR. */
  readonly woodCanopy: boolean;
  /** A crown's normal comes from its own geometry where the art carries no normal map. */
  readonly crownGeometryNormals: boolean;
  /** The look's crowns keep the authored alpha cutoff rather than a constant one. */
  readonly authoredAlphaTest: boolean;
  /** The scale a crown's own emissive takes, where this look lifts it less than the shared one. */
  readonly canopyEmissiveScale: number | null;
  /** The look's ground cover is a low mat: no photographic relief, a stricter cutoff, dark roots. */
  readonly mats: boolean;
  /** The look's mountains are pinned crags, 24 m on their longest axis. */
  readonly pinnedCrags: boolean;
  /** The look's bush is the small scrub model, not the temperate thicket. */
  readonly scrubBush: boolean;
  /** The look's blades go straw, and its dunes go straw with height. */
  readonly strawBlades: boolean;
  /** Metres the game's own sapling art stands at in this biome; null for the art's own height. */
  readonly saplingHeight: number | null;
  /** The look's river mirrors the ponds beside it, not only the sky. */
  readonly riverMirrorsPonds: boolean;
  /** The pinned camera a vista is framed from; null where the player's own camera follows them. */
  readonly vistaAim: IVistaAim | null;
  /** `?stage=` swaps this world for the staged forest kit: the forest is the world it is staged for. */
  readonly stageArm: boolean;
  readonly clouds: number;
  /** The shadow filter this look was judged with: the forest's own screen-space filter, else none. */
  readonly softShadowFilter: boolean;
  /** Virtual shadow map size, texels: finer where a distant ridge casts onto a valley. */
  readonly shadowMapSize: number;
  /** A single texel of normal bias, which ties a contact to the shadow resolution. */
  readonly tightShadowContacts: boolean;
  /** Per-level refresh step where a shadow page is crossed slowly, else null for the default. */
  readonly shadowRefreshStep: readonly [number, number] | null;
  /** Temporal anti-aliasing on this look's still passes. */
  readonly temporalAA: boolean;
  /** This look carries the water-proof diagnostic arm. */
  readonly waterProof: boolean;
}

const temperate: IBiome = {
  world: "forest",
  grassTint: [0.43, 0.76, 0.38],
  // The meadow's rock grading, which is the only reader of this look's ground tint: a lawn's stones
  // are graded by the ground, and its props carry `propStoneTint` instead. This is the tone the
  // lawn's stones were graded to before the split named it: `[0.48, 0.44, 0.39]` stood here and
  // never reached a pixel, because both readers gated `stoneTint` behind `otherBiome`.
  stoneTint: [0.44, 0.46, 0.42],
  snowTint: [1, 1, 1],
  distantStone: [0.115, 0.105, 0.088],
  // Snow and caps belong to the surveyed horizon, beyond the resident height range.
  snowFractions: [3.6, 4.8, 0.22],
  heightFractions: {
    alpine: [0.95, 1.65],
    rock: [0.35, 1.8],
    // The generated backdrop rises to 848 m over a 41 m walkable range. Spruce climbs to about
    // 260-400 m (its 70th-80th height percentile) and snow holds only on the peaks' gentle ground
    // above 570-690 m (93rd-97th). At 227-315 m the snow lay across every saddle as a white band.
    treeline: [6.5, 10],
    cap: [14, 17],
    desertRock: [0.18, 0.48],
    alpineRock: [0.06, 0.14],
    alpineHollow: [0.05, 0.12],
  },
  maps: GROUND_MAPS,
  horizon: "mountain",
  sun: { color: 0xffe3b5, intensity: 5.8, direction: [-180, 145, 80], shadowRadius: 1.7 },
  sky: { turbidity: 2, rayleigh: 3, mieCoefficient: 0.003, mieDirectionalG: 0.82 },
  fill: { sky: 0xa8c8e8, ground: 0x464937, intensity: 0.72 },
  haze: {
    color: 0x8ca8ba,
    density: 0.0011,
    valleyDensity: 0.000006,
    height: 120,
    sunScatter: 0.32,
  },
  atmosphere: {
    rayleigh: [0.005802, 0.013558, 0.0331],
    mie: 0.004,
    radiance: 1.4,
    distanceScale: 1.5,
    // The generated backdrop's rim stands at 2.36 km (`horizon.json`), up to 3.7 km from the vista
    // eye, so the fade only rounds off its corners; at [1800, 3300] it swapped the far ridges for sky.
    horizonFade: [3400, 4800],
    // UE 5.8.3 exponential height fog, two terms (Engine/Shaders/Private/HeightFogCommon.ush:207-214,
    // :309-311): a broad haze and a thin valley mist under the 71 m vista eye.
    heightFog: {
      // The lake (0.25-0.6 km from the vista eye) and the far stands (to 0.8 km) keep the valley's
      // air; the judge held them to BEFORE within 2/255. The massif starts at 1.1 km.
      reach: [900, 1300],
      // UE's `AerialPespectiveViewDistanceScale` (SkyAtmosphereComponent.cpp:131, default 1): the
      // 2.4 km backdrop takes the blue of a range twice as far away, as the goal frame does.
      distanceScale: 4,
      start: 150,
      terms: [
        { density: 0.0002, height: 0, scale: 200 },
        { density: 0.0015, height: 15, scale: 35 },
      ],
    },
  },
  skyRadiance: 0.27,
  saturation: 1,
  skySaturation: 1,
  // +0.45 EV with TRAA (opaque foliage no longer averages with soil and sky), then +0.68 EV once the
  // sky image lost its baked sun: that disc had been 44% of the meadow's light.
  exposure: 2 ** 0.87,
  toneMapping: ACESFilmicToneMapping,
  lawnGround: true,
  mesaGround: false,
  mossGround: false,
  crestRock: false,
  snowHollowLift: 5,
  snowShedFrom: 0.04,
  localSnow: false,
  crestTurf: false,
  oliveMeadow: false,
  mesaRock: false,
  sandRipples: false,
  openMeadow: false,
  woodedGround: false,
  shoreGround: false,
  surveyedBackdrop: false,
  surveyCollar: false,
  terrainCastsShadow: false,
  groundCollarMeters: 0,
  continuationTilt: true,
  stoneGrey: 0.35,
  distantStoneShare: 0.65,
  stoneSinkShare: 0.12,
  stoneScans: 1,
  stoneGroundBand: true,
  contactRockface: false,
  stoneFrontFace: false,
  dryStones: false,
  stoneSnow: false,
  propGrassTint: [0.86, 0.92, 0.6],
  stoneMoss: 0.38,
  stoneMossTint: [0.045, 0.078, 0.019],
  stoneSnowTint: [0.84, 0.87, 0.91],
  canopyTint: [0.6, 0.78, 0.34],
  bladeTint: [0.6, 0.78, 0.45],
  cutoutTint: [0.72, 0.8, 0.55],
  stoneSectionTint: [0.7, 0.78, 0.61],
  canopyInnerShade: 0.6,
  canopyLinearInner: false,
  canopyAmbientOcclusion: [0.35, 1],
  woodCanopy: false,
  crownGeometryNormals: false,
  authoredAlphaTest: false,
  canopyEmissiveScale: null,
  mats: false,
  pinnedCrags: false,
  scrubBush: false,
  strawBlades: false,
  saplingHeight: null,
  riverMirrorsPonds: false,
  vistaAim: null,
  stageArm: false,
  clouds: 0.76,
  // The deterministic filter avoids the forest's fine screen-space rotation hatching.
  softShadowFilter: true,
  shadowMapSize: 2048,
  tightShadowContacts: false,
  shadowRefreshStep: null,
  temporalAA: true,
  waterProof: false,
};

/** The wood itself: the temperate base with its stand rules on. The other four looks are not woods. */
const forest: IBiome = {
  ...temperate,
  oliveMeadow: true,
  openMeadow: true,
  woodedGround: true,
  surveyCollar: true,
  contactRockface: true,
  woodCanopy: true,
  crownGeometryNormals: true,
  authoredAlphaTest: true,
  stageArm: true,
  // The wood stands in a low warm sun, 20 degrees up: the owner's reference frame (2026-11-09) is a
  // spruce wood an hour before sunset, with deep shade inside the stands and warm patches on the
  // floor. Less sky fill keeps that shade deep. The other temperate worlds keep the midday sun.
  sun: { ...temperate.sun, color: 0xffb878, intensity: 8, direction: [180, 72, 80] },
  fill: { ...temperate.fill, intensity: 0.55 },
  // The ground plants sit a third darker and cooler, at the crowns' value (owner, 2026-11-09:
  // "ground vegetation still too brighty compared to the forest").
  swardTint: [0.64, 0.72, 0.66],
  // Brings the sunlit turf to about twice its blades' value and to their green.
  turfTint: [0.3, 0.44, 0.32],
  // Measured at the overview, 20 degree sun: square crowns over far crowns, linear, per channel.
  standShade: [0.13, 0.25, 0.51],
  // A fern under a closed crown keeps a third of the sky; the open meadow keeps all of it.
  understoreySkyLight: 0.3,
  // The meadow's own distant stone tone: a lawn fades to a paler rock than its props do.
  groundDistantStone: [0.16, 0.17, 0.155],
  // Clearer alpine air under the low evening sun (owner, 2026-11-09): at a distance scale of 4 and
  // 0.0002/m the massif washed to a flat lilac sheet; 2.5 and 0.00012/m keep its ridges apart and
  // its snow white, and the thin valley mist still lies against its foot.
  atmosphere: {
    ...temperate.atmosphere,
    heightFog: {
      reach: [900, 1300],
      distanceScale: 2.5,
      start: 150,
      terms: [
        { density: 0.00012, height: 0, scale: 200 },
        { density: 0.0015, height: 15, scale: 35 },
      ],
    },
    // Evening mist on the valley floor (the wood stands at 13-30 m): a stand 60 m off is about a
    // seventh mist, one 150 m off a third, and the layer thins by e every 15 m up, so a view from above the crowns stays clear.
    groundMist: {
      color: 0x6c8590,
      start: 10,
      maxOpacity: 0.36,
      term: { density: 0.0035, height: 14, scale: 15 },
    },
  },
};

export const BIOMES: Record<WorldName, IBiome> = {
  forest,
  coastal: {
    ...temperate,
    world: "coastal",
    snowFractions: [1.3, 1.75, 0.22],
    heightFractions: {
      ...temperate.heightFractions,
      alpine: [0.34, 0.6],
      rock: [0.12, 0.64],
      treeline: [1, 2.15],
      cap: [2, 2.8],
    },
    propStoneTint: [1, 1, 1],
    shoreGround: true,
    // The coast keeps its survey's look past the square; the forest's backdrop is alpine.
    surveyedBackdrop: true,
    // 80 m along the strand and 190 m out, level with the sea it is graded over.
    vistaAim: { at: [80, 190], rise: null },
    stoneGroundBand: false,
    stoneFrontFace: true,
    dryStones: true,
    canopyInnerShade: 0.48,
    canopyAmbientOcclusion: [0.26, 0.72],
    groundDistantStone: [0.16, 0.17, 0.155],
    sun: { ...temperate.sun, intensity: 5.2, direction: [-180, 150, -120] },
    fill: { ...temperate.fill, intensity: 0.66 },
    haze: { ...temperate.haze, density: 0.0008 },
    atmosphere: {
      rayleigh: [0.003, 0.008, 0.0331],
      mie: 0.006,
      radiance: 1.4,
      distanceScale: 2,
      horizonFade: [500, 1200],
    },
    exposure: 2 ** -0.38,
    saturation: 0.93,
    softShadowFilter: false,
    // Coastal stones showed a lit rim at their base; one fine texel of normal bias ties the contact
    // offset to the shadow resolution.
    tightShadowContacts: true,
    temporalAA: false,
    waterProof: true,
  },
  alpine: {
    ...temperate,
    world: "alpine",
    // ACES crushes the dark ridge rock in shadow to black; AgX keeps its detail.
    toneMapping: AgXToneMapping,
    lawnGround: false,
    crestRock: true,
    crestTurf: true,
    terrainCastsShadow: true,
    stoneSnow: true,
    stoneMoss: 0,
    stoneMossTint: [0.12, 0.13, 0.12],
    stoneSectionTint: [0.94, 0.98, 1.02],
    canopyInnerShade: 0.42,
    canopyLinearInner: true,
    canopyAmbientOcclusion: [0.12, 0.58],
    canopyTint: [0.3, 0.42, 0.32],
    bladeTint: [0.55, 0.82, 0.42],
    canopyEmissiveScale: 0.4,
    pinnedCrags: true,
    stoneGrey: 0.25,
    distantStoneShare: 0.28,
    // A crag's ground contact is its own base ring, measured: no footprint snap and no sink.
    stoneSinkShare: null,
    // 2 m of spruce art where the fallback pack stands in: a shoulder's tree is a young one.
    saplingHeight: 2,
    // 200 m back over the ridge and 170 m up it: the massif, from the shoulder.
    vistaAim: { at: [-200, 170], rise: 170 },
    // A dense snowpack sheds later than a thin one: a shelf's snow survives 0.12 steeper here.
    snowHollowLift: 14,
    snowShedFrom: 0.16,
    horizon: "alpine",
    grassTint: [0.43, 0.8, 0.35],
    stoneTint: [0.86, 0.88, 0.9],
    snowTint: [1.9, 1.93, 2],
    distantStone: [0.23, 0.225, 0.215],
    snowFractions: [0.6, 0.85, 0.39],
    heightFractions: {
      ...temperate.heightFractions,
      alpine: [0.06, 0.1],
      rock: [0.02, 0.11],
      treeline: [0.3, 0.55],
      cap: [0.82, 1],
    },
    maps: {
      ...GROUND_MAPS,
      snow: { ...GROUND_MAPS.snow, normal: "snow_02/snow_02_nor_gl_1k.jpg" },
      moss: { diffuse: GROUND_MAPS.moss.diffuse },
      dirt: {
        diffuse: "river_small_rocks/river_small_rocks_diff_512.jpg",
        normal: "river_small_rocks/river_small_rocks_nor_gl_512.jpg",
      },
      rock: ROCKFACE_MAPS,
    },
    sun: { color: 0xffe7c7, intensity: 5.2, direction: [180, 130, 140], shadowRadius: 1.5 },
    sky: { turbidity: 1.3, rayleigh: 2.1, mieCoefficient: 0.0018, mieDirectionalG: 0.8 },
    haze: {
      color: 0x9aafc3,
      density: 0.0005,
      valleyDensity: 0.000009,
      height: 105,
      sunScatter: 0.28,
    },
    atmosphere: {
      rayleigh: [0.003, 0.008, 0.0331],
      mie: 0.002,
      radiance: 1.6,
      distanceScale: 1,
      horizonFade: [1800, 3300],
    },
    skyRadiance: 0.24,
    saturation: 0.86,
    skySaturation: 0.9,
    fill: { sky: 0xb2c6de, ground: 0x656963, intensity: 0.85 },
    clouds: 0.34,
    softShadowFilter: false,
    shadowMapSize: 4096,
    shadowRefreshStep: [0.2, 0.125],
    temporalAA: false,
  },
  desert: {
    ...temperate,
    world: "desert",
    lawnGround: false,
    mesaGround: true,
    mesaRock: true,
    sandRipples: true,
    terrainCastsShadow: true,
    dryStones: true,
    stoneMoss: 0,
    stoneMossTint: [0.23, 0.16, 0.095],
    stoneSectionTint: [1.12, 0.8, 0.54],
    cutoutTint: [0.85, 0.64, 0.32],
    canopyInnerShade: 0.42,
    canopyLinearInner: true,
    canopyAmbientOcclusion: [0.12, 0.58],
    canopyTint: [0.3, 0.42, 0.32],
    bladeTint: [0.55, 0.82, 0.42],
    strawBlades: true,
    propGrassTint: [1.65, 0.92, 0.42],
    stoneGrey: 0.25,
    distantStoneShare: 0.32,
    // The shipped stones are two scans of the same bedded rock; the second fills the primitive slot.
    stoneScans: 2,
    stoneSinkShare: null,
    // 180 m back and 160 m along, 30 m above the player's feet: the mesa wall from the gravel fan.
    vistaAim: { at: [-180, -160], rise: 30 },
    propStoneTint: [1.08, 0.85, 0.64],
    horizon: "mesa",
    grassTint: [1, 1, 1],
    stoneTint: [1.16, 0.82, 0.55],
    distantStone: [0.31, 0.205, 0.12],
    snowFractions: [2, 3, 0.22],
    heightFractions: {
      ...temperate.heightFractions,
      alpine: [0.28, 0.49],
      rock: [0.08, 0.52],
      treeline: [0.8, 1.8],
      cap: [2, 2.8],
    },
    maps: {
      ...GROUND_MAPS,
      grass: { ...GROUND_MAPS.sand, normal: "sand_01/sand_01_nor_gl_1k.jpg" },
      dirt: {
        diffuse: "river_small_rocks/river_small_rocks_diff_512.jpg",
        normal: "river_small_rocks/river_small_rocks_nor_gl_512.jpg",
      },
      moss: {
        diffuse: "cliff_side/cliff_side_diff_1k.jpg",
        normal: "cliff_side/cliff_side_nor_gl_1k.jpg",
      },
      rock: {
        diffuse: "cliff_side/cliff_side_diff_1k.jpg",
        normal: "cliff_side/cliff_side_nor_gl_1k.jpg",
      },
    },
    sun: { color: 0xffe0ad, intensity: 6.2, direction: [160, 190, 85], shadowRadius: 1.1 },
    sky: { turbidity: 3.5, rayleigh: 1.4, mieCoefficient: 0.006, mieDirectionalG: 0.8 },
    fill: { sky: 0xc2d3db, ground: 0x9e7147, intensity: 0.32 },
    haze: {
      color: 0xd1b99b,
      density: 0.0011,
      valleyDensity: 0.000004,
      height: 90,
      sunScatter: 0.22,
    },
    atmosphere: {
      rayleigh: [0.003, 0.008, 0.0331],
      mie: 0.006,
      radiance: 1.35,
      distanceScale: 2.5,
      horizonFade: [500, 1100],
    },
    skyRadiance: 0.27,
    saturation: 0.94,
    exposure: 2 ** -0.52,
    clouds: 0.12,
    softShadowFilter: false,
    shadowMapSize: 4096,
    shadowRefreshStep: [0.2, 0.125],
    temporalAA: false,
  },
  tundra: {
    ...temperate,
    world: "tundra",
    toneMapping: AgXToneMapping,
    lawnGround: false,
    mossGround: true,
    localSnow: true,
    terrainCastsShadow: true,
    // The snow and mat masks read normals, so the collar is blended and the masks reach 40 m past
    // the square; a mat plain also keeps its resident normals instead of the distant tilt.
    groundCollarMeters: 40,
    continuationTilt: false,
    stoneGroundBand: false,
    stoneSnow: true,
    mats: true,
    scrubBush: true,
    // A dwarf birch: 1.4 m of art where the fallback pack stands in.
    saplingHeight: 1.4,
    stoneSinkShare: null,
    // The ponds sit in the same pan as the streams, so the streams mirror them.
    riverMirrorsPonds: true,
    cutoutTint: [0.64, 0.67, 0.42],
    canopyInnerShade: 0.42,
    canopyLinearInner: true,
    canopyAmbientOcclusion: [0.12, 0.58],
    canopyTint: [0.3, 0.42, 0.32],
    bladeTint: [0.55, 0.82, 0.42],
    propGrassTint: [1.1, 0.86, 0.55],
    stoneGrey: 0.25,
    distantStoneShare: 0.32,
    horizon: "plain",
    grassTint: [0.83, 0.88, 0.82],
    stoneTint: [0.7, 0.74, 0.77],
    snowTint: [1.45, 1.5, 1.58],
    distantStone: [0.18, 0.2, 0.21],
    snowFractions: [0.15, 0.45, 0.22],
    heightFractions: { ...temperate.heightFractions, alpine: [0.6, 1.2], rock: [0.06, 1.25] },
    maps: {
      ...GROUND_MAPS,
      snow: { ...GROUND_MAPS.snow, normal: "snow_02/snow_02_nor_gl_1k.jpg" },
      grass: {
        diffuse: "river_small_rocks/river_small_rocks_diff_512.jpg",
        normal: "river_small_rocks/river_small_rocks_nor_gl_512.jpg",
      },
      dirt: {
        diffuse: "river_small_rocks/river_small_rocks_diff_512.jpg",
      },
      moss: {
        diffuse: "lichen_rock/lichen_rock_diff_512.jpg",
        normal: "lichen_rock/lichen_rock_nor_gl_512.jpg",
      },
    },
    sun: { color: 0xe9efff, intensity: 2.2, direction: [-180, 65, -120], shadowRadius: 2.1 },
    sky: { turbidity: 4.2, rayleigh: 1.6, mieCoefficient: 0.002, mieDirectionalG: 0.78 },
    fill: { sky: 0xb9ccdf, ground: 0x555851, intensity: 1.05 },
    haze: {
      color: 0xb1c0c9,
      density: 0.00065,
      valleyDensity: 0.000012,
      height: 35,
      sunScatter: 0.18,
    },
    atmosphere: {
      rayleigh: [0.003, 0.008, 0.0331],
      mie: 0.003,
      radiance: 1.2,
      distanceScale: 1.5,
      horizonFade: [500, 1200],
    },
    skyRadiance: 0.13,
    saturation: 0.96,
    exposure: 2 ** -0.28,
    clouds: 0.9,
    softShadowFilter: false,
    temporalAA: false,
  },
};

export interface IWorldBiome extends IBiome {
  readonly elevationRange: readonly [number, number];
  readonly heightBands: HeightBands;
  readonly snowBand: readonly [number, number];
}

/** Resolve game-owned fractions once against this world's actual samples (`measureBands` owns the arithmetic). */
export function measureBiome(biome: IBiome, heights: readonly number[]): IWorldBiome {
  const measured = measureBands(
    [
      ...Object.entries(biome.heightFractions).map(([layer, [from, to]]) => ({ layer, from, to })),
      { layer: "snow", from: biome.snowFractions[0], to: biome.snowFractions[1] },
    ],
    heights,
  );
  return {
    ...biome,
    elevationRange: measured.elevationRange,
    heightBands: measured.bands as HeightBands,
    // The snow row above is always passed, so measureBands always returns its band.
    snowBand: measured.snowBand as readonly [number, number],
  };
}

/** A flat world has no elevation transition; never emit equal-edge smoothstep. */
export function elevationBand(
  biome: IWorldBiome,
  band: readonly [number, number],
  height: Node<"float"> = positionWorld.y,
): Node<"float"> {
  return biome.elevationRange[0] === biome.elevationRange[1]
    ? float(0)
    : smoothstep(band[0], band[1], height);
}

/** Local ground rules; slope keeps steep faces bare and noise breaks the snow's contour line. */
export function biomeWeights(
  biome: IWorldBiome,
  steep: Node<"float">,
  hollow: Node<"float">,
  breakup: Node<"float">,
): Partial<Record<LayerKey, Node<"float">>> {
  if (biome.lawnGround) return {};
  const drift = mx_fractal_noise_float(positionWorld.mul(0.033), 3);
  const stone = smoothstep(0.1, 0.29, steep.add(breakup.mul(0.04)));
  if (biome.mesaGround)
    return {
      dirt: smoothstep(0.14, 0.65, hollow).mul(0.7),
      moss: float(0),
      sand: float(0),
      rock: stone
        .max(elevationBand(biome, biome.heightBands.desertRock).mul(0.48))
        .mul(float(1).sub(smoothstep(0.12, 0.5, hollow).mul(0.35))),
      snow: float(0),
    };
  // Wind-scoured convex/exposed faces shed snow; sheltered shelves keep it.
  const exposure = normalWorldGeometry.x.mul(0.65).add(normalWorldGeometry.z.mul(0.4)).max(0);
  const retention = elevationBand(
    biome,
    biome.snowBand,
    positionWorld.y.add(hollow.max(0).mul(biome.snowHollowLift)),
  ).mul(
    float(1)
      .sub(smoothstep(biome.snowShedFrom, biome.snowFractions[2], steep))
      .mul(float(1).sub(exposure.mul(0.28))),
  );
  // A narrow retention threshold leaves wind-shaped shelves and sharp scour edges.
  const snow = smoothstep(0.36, 0.42, retention.add(hollow.max(0).mul(0.08)));
  const cells = mx_worley_noise_vec2(
    vec3(positionWorld.x, 0, positionWorld.z).mul(0.13).add(drift.mul(0.35)),
  );
  const polygon = smoothstep(0.025, 0.11, cells.y.sub(cells.x));
  const mats = smoothstep(
    0.47,
    0.77,
    float(0.52)
      .add(positionWorld.x.mul(0.343).add(positionWorld.z.mul(0.1566)).sin().mul(0.27))
      .add(positionWorld.z.mul(0.3741).sub(positionWorld.x.mul(0.1666)).add(1.3).sin().mul(0.24))
      .add(positionWorld.x.mul(0.6958).add(positionWorld.z.mul(0.5307)).sin().mul(0.12)),
  );
  return {
    dirt: biome.mossGround
      ? smoothstep(0.08, 0.5, hollow)
          .mul(0.28)
          .max(polygon.oneMinus().mul(0.3))
          .mul(mats.oneMinus())
      : smoothstep(0.08, 0.5, hollow).mul(0.55),
    moss: biome.mossGround
      ? mats
          .mul(smoothstep(-0.2, 0.22, drift).mul(0.85).add(0.15))
          .mul(snow.oneMinus())
          .mul(mix(0.72, 0.98, polygon))
      : float(0),
    rock: biome.crestRock
      ? stone
          .max(0.8)
          .max(elevationBand(biome, biome.heightBands.alpineRock).mul(0.58))
          .max(
            smoothstep(0.12, 0.5, hollow)
              .mul(elevationBand(biome, biome.heightBands.alpineHollow))
              .mul(0.45),
          )
          .mul(float(1).sub(smoothstep(0.08, 0.4, hollow).mul(0.4)))
      : stone,
    snow: biome.localSnow ? snow : alpineSnowCover(biome, hollow),
  };
}

/** One world-space RockFace003 projection on both the massif and its protruding ribs. */
export function alpineRockTap(source: Texture, plane: Node<"vec2">, relief = false): Node<"vec4"> {
  const tap = (scale: number, angle: number, offset: Node<"vec2">) => {
    const sampled = texture(source, rotateUV(plane.div(scale), float(angle), vec2(0)).add(offset));
    if (!relief) return sampled;
    const tangent = rotateUV(sampled.xy.mul(2).sub(1), float(-angle), vec2(0));
    return vec4(tangent, sampled.z.mul(2).sub(1), 1);
  };
  const patch = smoothstep(-0.35, 0.35, mx_noise_float(positionWorld.mul(0.025)));
  return mix(tap(8, 0.17, vec2(0)), tap(32, -0.21, vec2(0.37, 0.61)), patch.mul(0.3).add(0.2));
}

export function alpineRockAlbedo(source: Texture): Node<"vec3"> {
  const axis = abs(normalWorldGeometry).pow(4);
  const share = axis.div(axis.x.add(axis.y).add(axis.z));
  return share.x
    .mul(alpineRockTap(source, positionWorld.zy).rgb)
    .add(share.y.mul(alpineRockTap(source, positionWorld.xz).rgb))
    .add(share.z.mul(alpineRockTap(source, positionWorld.xy).rgb));
}

export function alpineRockColor(sample: Node<"vec3">): Node<"vec3"> {
  const grey = dot(sample, vec3(0.2126, 0.7152, 0.0722));
  return mix(sample, vec3(grey), 0.25).mul(vec3(...BIOMES.alpine.stoneTint));
}

/** Snow respects world elevation and upward faces, including tilted instanced scans. */
export function alpineSnowCover(
  biome: IWorldBiome,
  hollow: Node<"float"> = float(0),
): Node<"float"> {
  const exposure = normalWorldGeometry.x.mul(0.65).add(normalWorldGeometry.z.mul(0.4)).max(0);
  const retention = elevationBand(
    biome,
    biome.snowBand,
    positionWorld.y.add(hollow.max(0).mul(110)),
  )
    .mul(smoothstep(0.35, 0.72, normalWorldGeometry.y))
    .mul(float(1).sub(exposure.mul(0.28)))
    .mul(float(1).sub(hollow.min(0).negate().mul(0.65)));
  return smoothstep(0.36, 0.42, retention);
}

/** Thin sediment beds have varying thickness; varnish runs down, not around, a wall. */
export function desertRockColor(sample: Node<"vec3">): Node<"vec3"> {
  const grain = dot(sample, vec3(0.2126, 0.7152, 0.0722));
  const warp = mx_fractal_noise_float(positionWorld.mul(vec3(0.012, 0.003, 0.012)), 3).mul(5);
  const height = positionWorld.y.add(warp);
  const beds = mx_noise_float(vec3(0, height.mul(1.55), 0));
  const fine = height.mul(4.1).add(beds.mul(2.8)).sin().mul(0.05);
  const ledge = smoothstep(0.38, 0.62, mx_noise_float(vec3(0, height.mul(0.19), 0))).mul(0.18);
  const varnish = smoothstep(
    -0.18,
    0.28,
    mx_fractal_noise_float(positionWorld.mul(vec3(0.42, 0.004, 0.42)), 3),
  )
    .mul(normalWorldGeometry.y.abs().oneMinus())
    .mul(0.4);
  return vec3(1.52, 0.9, 0.5)
    .mul(grain)
    .mul(beds.mul(0.24).add(fine).add(1).sub(ledge))
    .mul(mix(vec3(1), vec3(0.55, 0.48, 0.42), varnish));
}
// TEMP-LOOK: remove before commit. ?look=<json> merges into the forest row, one level deep.
{
  const q = new URLSearchParams(globalThis.location?.search ?? "").get("look");
  const row = BIOMES.forest as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(q ? (JSON.parse(q) as Record<string, unknown>) : {}))
    if (value && typeof value === "object" && !Array.isArray(value))
      row[key] = { ...(row[key] as object), ...value };
    else row[key] = value;
}
