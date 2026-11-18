import { measureBands } from "@threenative/terrain";
import { ACESFilmicToneMapping, type Texture, type ToneMapping } from "three";
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
import { GROUND_MAPS, type IGroundMaps, type LayerKey } from "../world/terrainAssets.js";
import type { WORLD_NAMES } from "./worldNames.js";
import { WORLD } from "./worldNames.js";

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
  /**
   * Metres the fractions scale by, when they are heights above the floor rather than shares of this
   * ground's own walkable range: a treeline does not climb because a cooked square is hillier.
   */
  readonly bandSpan?: number;
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
  readonly clouds: number;
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
  world: "desert",
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
  clouds: 0.76,
  shadowMapSize: 2048,
  tightShadowContacts: false,
  shadowRefreshStep: null,
  temporalAA: true,
  waterProof: false,
};

/**
 * Valley of the Gods, Utah: red sand flats and bedded sandstone buttes under a clear, dry, high sun.
 * The look is the preview's graded mesa desert (`mesaGround`, `mesaRock`, `sandRipples`): bedded rock
 * with desert varnish on the steep faces, sand on the flats, gravel pavement between, and no snow.
 */
const desert: IBiome = {
  ...temperate,
  lawnGround: false,
  mesaGround: true,
  mesaRock: true,
  sandRipples: true,
  // The coarse square mesh shadowed the finer streamed ground under it in hard dark polygons (a
  // dune drew a black trapezoid at the walk's end), so the ground casts none, as in every kit.
  terrainCastsShadow: false,
  dryStones: true,
  stoneMoss: 0,
  stoneMossTint: [0.23, 0.16, 0.095],
  stoneSectionTint: [1.12, 0.8, 0.54],
  cutoutTint: [0.85, 0.64, 0.32],
  canopyInnerShade: 0.42,
  canopyLinearInner: true,
  canopyAmbientOcclusion: [0.12, 0.58],
  // Juniper, sage and blackbrush are grey-green, not the temperate wood's green.
  canopyTint: [0.62, 0.68, 0.56],
  bladeTint: [0.86, 0.8, 0.6],
  propGrassTint: [1.25, 1.02, 0.7],
  stoneGrey: 0.25,
  distantStoneShare: 0.32,
  stoneScans: 2,
  stoneSinkShare: null,
  // The Outcrop bakes carry their own red-brown (`bake-rocks.mjs`), so the props add no tint.
  propStoneTint: [0.62, 0.62, 0.7],
  horizon: "mesa",
  // The aerial sand scan is grey-tan (linear 0.28, 0.24, 0.20); this is the reference's iron-red
  // dune sand (0.25, 0.075, 0.028).
  grassTint: [0.88, 0.32, 0.145],
  stoneTint: [1.16, 0.82, 0.55],
  distantStone: [0.31, 0.205, 0.12],
  // No snow: the bands sit far above the survey's 270 m of relief.
  snowFractions: [20, 30, 0.22],
  heightFractions: {
    ...temperate.heightFractions,
    alpine: [0.28, 0.49],
    rock: [0.08, 0.52],
    treeline: [0.8, 1.8],
    cap: [20, 28],
  },
  maps: GROUND_MAPS,
  // Late afternoon: the sun 23 degrees up, so each ripple, stone and ledge shades its far side
  // and a shadow runs two and a half times the height of what casts it, as in the reference.
  sun: { color: 0xffdfb4, intensity: 6.4, direction: [140, 76, 110], shadowRadius: 1.1 },
  // Dust in the air: the sky pales and warms towards the horizon and the sun wears a wide halo.
  sky: { turbidity: 4.6, rayleigh: 1.9, mieCoefficient: 0.009, mieDirectionalG: 0.86 },
  // Bounce light off red sand is warm; the clear sky above is a deep, dry blue.
  fill: { sky: 0xa9c4de, ground: 0xa06a46, intensity: 0.36 },
  // Wind-lifted dust, not water: a warm veil that thickens fast with distance and lies in the
  // low ground, and glows where the eye looks towards the sun.
  haze: {
    color: 0xd8b48e,
    density: 0.0032,
    valleyDensity: 0.00006,
    height: 80,
    sunScatter: 0.6,
  },
  atmosphere: {
    rayleigh: [0.005802, 0.013558, 0.0331],
    mie: 0.003,
    radiance: 1.35,
    // Dusty air: a butte 1 km off goes pale, the far escarpment melts into the sky.
    distanceScale: 2.4,
    horizonFade: [3400, 4800],
  },
  skyRadiance: 0.27,
  saturation: 1.04,
  // The temperate exposure less half a stop: red sand under a high sun reflects more than a meadow.
  exposure: 2 ** 0.4,
  clouds: 0.2,
  shadowMapSize: 4096,
  shadowRefreshStep: [0.2, 0.125],
  temporalAA: true,
};

export const BIOMES: Record<WorldName, IBiome> = {
  [WORLD]: desert,
};

export interface IWorldBiome extends IBiome {
  readonly elevationRange: readonly [number, number];
  readonly heightBands: HeightBands;
  readonly snowBand: readonly [number, number];
}

/** Resolve game-owned fractions once against this world's actual samples (`measureBands` owns the arithmetic). */
export function measureBiome(biome: IBiome, heights: readonly number[]): IWorldBiome {
  const rows = [
    ...Object.entries(biome.heightFractions).map(([layer, [from, to]]) => ({ layer, from, to })),
    { layer: "snow", from: biome.snowFractions[0], to: biome.snowFractions[1] },
  ];
  // The ground's own range, measured (and validated) whatever span the bands scale by.
  const ground = measureBands(rows, heights);
  const floor = ground.elevationRange[0];
  const measured =
    biome.bandSpan === undefined ? ground : measureBands(rows, [floor, floor + biome.bandSpan]);
  return {
    ...biome,
    elevationRange: ground.elevationRange,
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
      // Gravel pavement in the washes and in patches tens of metres across on the flats.
      dirt: smoothstep(0.14, 0.65, hollow)
        .mul(0.7)
        .max(smoothstep(0.18, 0.42, mx_fractal_noise_float(positionWorld.mul(0.021), 3)).mul(0.62)),
      moss: float(0),
      sand: float(0),
      // Slickrock: the rock edge is ragged, not a contour of the slope.
      rock: smoothstep(0.08, 0.3, steep.add(breakup.mul(0.12)))
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
  return mix(sample, vec3(grey), 0.25).mul(vec3(0.86, 0.88, 0.9));
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
  // Red-brown sandstone with a few paler beds, the tone of the Outcrop rock that stands on it.
  const cream = smoothstep(0.15, 0.45, mx_noise_float(vec3(0, height.mul(0.33), 0)));
  return mix(vec3(1.0, 0.42, 0.25), vec3(1.0, 0.62, 0.4), cream.mul(0.3))
    .mul(grain)
    .mul(beds.mul(0.24).add(fine).add(1).sub(ledge))
    .mul(mix(vec3(1), vec3(0.55, 0.48, 0.42), varnish));
}
