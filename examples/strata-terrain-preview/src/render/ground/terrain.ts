import type { IAssetLoader } from "@threenative/core";
import {
  Heightfield,
  type HeightfieldCollar,
  bakedFractalNoise,
  bakedNoise,
  loadTerrainSplat,
} from "@threenative/core/world";
import { waterlineRadius } from "@threenative/core/world";
import { createSegmentIndex } from "@threenative/terrain";
import {
  ClampToEdgeWrapping,
  DataTexture,
  DataUtils,
  Float32BufferAttribute,
  HalfFloatType,
  LinearFilter,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  RGBAFormat,
  RepeatWrapping,
  type Texture,
  type Vector2,
  Vector3,
} from "three";
import {
  abs,
  attribute,
  clamp,
  dot,
  float,
  fract,
  fwidth,
  max,
  min,
  mix,
  mx_noise_float,
  normalWorld,
  normalWorldGeometry,
  normalize,
  oneMinus,
  positionView,
  positionWorld,
  rotateUV,
  sign,
  smoothstep,
  texture,
  transformNormalToView,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import type { Node, UniformNode } from "three/webgpu";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { GROUND_TILE, type LayerKey, ROCKFACE_MAPS } from "../../world/terrainAssets.js";
import { alpineRockColor, alpineRockTap, desertRockColor } from "../biomes.js";
// The ground's look, and every number in it, lives in this game: which surface covers which
// height and slope, how many metres one texture tile spans, and how the blend edges break. The
// evaluator in `packages/terrain` produces heights and eight material channels; none of that is a
// picture, and this file is the only place that decides what one looks like.
//
// Layer weights are read from the baked heightfield where it is drawn — its own world height, its
// own geometric normal, and the palette the bake painted — so a cliff is rock because it is steep,
// a beach is sand because it sits near the sea level the bake recorded, and snow settles only on
// the high flat ground. Nothing here resamples the terrain or adds a mask texture that could
// disagree with the geometry.
//
// Texture budget: six albedos + four normals + curvature + two shadow levels × two = 15/16.
import {
  BIOMES,
  type IBiome,
  type IWorldBiome,
  biomeWeights,
  elevationBand,
  measureBiome,
} from "../biomes.js";
import { LOOK } from "../lookKnobs.js";
import { loadSkyLight, skyIrradiance } from "../props/pack.js";
import { SUN_VECTOR } from "../sky/sky.js";
import {
  type IBakedLake,
  type IBakedRiver,
  REFLECTED_LAYER,
  surfaceHeights,
} from "../water/river.js";
import {
  COLLAR_UNDER_TILE,
  TILE_INSIDE_SQUARE,
  type IPackedMassif,
  STREAM_TILE,
  collarColors,
  collarMorph,
  createHorizonCollar,
  horizonSurroundings,
} from "./horizon.js";

export interface IBakedWorld {
  size: number;
  resolution: number;
  heights: number[];
  colors: number[];
  erosion?: { flow: number[]; sediment: number[]; deposition: number[]; talus: number[] };
  waterLevel: number | null;
  lakes?: readonly IBakedLake[];
  rivers?: readonly IBakedRiver[];
}

/** One transport mask shared by the terrain splat and rock placement. */
export function depositAtIndex(data: Pick<IBakedWorld, "erosion">, vertex: number): number {
  const sediment = data.erosion?.sediment[vertex] ?? 0;
  const hydraulic = (data.erosion?.deposition[vertex] ?? 0) / (1 + Math.sqrt(sediment));
  return Math.min(1, hydraulic * 0.25 + (data.erosion?.talus[vertex] ?? 0) * 0.3);
}

/**
 * The ground's own curvature, sampled from a height texture, as the material's curvature term.
 *
 * This is the one signal the ground material cannot get any other way, and it is what separates a
 * hillside with hollows in it from a hillside with a colour painted on it. The heightfield's own
 * samples give a Laplacian: positive where the ground is concave (a hollow, a gully, the crease
 * where two slopes meet), negative on a nose or a rib. Both the moss and the rock below read it, so
 * moss grows in the crease at the bottom of a slope and rock shows on the rib at the top, which is
 * where each actually grows — rather than both keysing off slope alone and covering a whole face.
 *
 * Built once in `createTerrain` from the same heights the geometry and the collider were built from,
 * so it cannot disagree with either.
 */
export interface IGroundCurvature {
  /** +1 in a hollow, -1 on a rib, ~0 on flat ground. */
  readonly node: Node<"float">;
  readonly texture: DataTexture;
  readonly wetBank: Node<"float">;
  readonly flow: Node<"float">;
  readonly deposits: Node<"float">;
}

interface ILayerMaps {
  diffuse: Texture;
  normal?: Texture;
}

/** Props draw at render order 0 and the water at 2: the ground draws between them. */
const GROUND_RENDER_ORDER = 1;
/**
 * The beach band, in metres above the bake's own sea level.
 *
 * Wide, because this coast rises a few degrees: a 3 m band is a 30 m walk of beach here and stops
 * halfway up it. The bake paints sand below 6 m for the same reason.
 */
const SHORE = { beach: 6, wet: -0.5 };

/**
 * The wet band, and what it does to the sand.
 *
 * Sand that the sea has just left is darker and more saturated than the sand above it, because the
 * water is still in the pores and the grains are closer together for it. The band is a metre and a half
 * of height above the bake's own sea level and it feathers: a hard line at the high-water mark is
 * exactly the "straight-edged white shape" the foam work removed from the water.
 *
 * It is also the reason the beach reads as a *beach* rather than as a tan field, and it is a colour
 * the sand layer cannot supply on its own because it is a fact about the water's last reach, not about
 * the sand.
 */
const WET_SAND = {
  /** Height above sea level over which the band fades out, in metres. */
  band: 2.8,
  /** How much darker and how much more saturated the wet sand is. */
  darken: vec3(0.38, 0.4, 0.42),
  /** The grain the band adds: wet sand is smooth and packed, so the ripples flatten in it. */
  calm: 0.45,
} as const;

/**
 * What makes the ground grass rather than the dry autumn meadow the CC0 set photographs.
 *
 * Leafy Grass is a real meadow in October: brown thatch with green sprigs. A temperate starter
 * wants June, so this trades red for green on that one layer and leaves the texture's own detail,
 * its normal map and every other surface alone.
 */
const MEADOW = vec3(0.47, 0.72, 0.4);
/** A spruce forest's meadow: dark olive, not lawn green (Project Nature's spruce forest frames). */
const FOREST_MEADOW = vec3(0.4, 0.58, 0.27);
/** How much of the vegetation's sky light the ground receives; the vegetation's own is 1.13. */
const GROUND_SKY_LIGHT = 0.6;
/** Multiplier that turns meadow turf into shaded needle litter under a stand. */
const FOREST_FLOOR = vec3(0.4, 0.4, 0.27);
/**
 * Bare earth between the stands, on top of the litter tint: a spruce floor's humus reads L* 29-37 at
 * the walk pose (PRD-855), and the litter tint alone left it at 53, brighter than the turf beside it.
 */
const BARE_SOIL = vec3(0.4, 0.38, 0.37);
/**
 * Albedo of the backdrop's closed spruce cover, crowns and the shade between them averaged: the hue of
 * the playable forest's own crowns in the overview (linear 0.74 : 1 : 0.28), a little bluer, so the
 * far slopes and the near stands read as one forest.
 */
const BACKDROP_SPRUCE = vec3(0.019, 0.028, 0.013);
/** Albedo of the meadow gaps in the backdrop's cover: dull olive turf, not lawn. */
const BACKDROP_CLEARING = vec3(0.042, 0.052, 0.022);
/**
 * The surveyed surroundings carry no stands (the bake plants only the playable square), so past the
 * square's edge the forest hillside is an open sunlit meadow: lawn turf, no needle-soil patches, and
 * the vista's ground cover (`meadowCover`). `?meadow=off` is the named override: the old olive turf
 * with bare patches and no cover there.
 */
export const OPEN_MEADOW =
  new URLSearchParams(globalThis.location?.search ?? "").get("meadow") !== "off";

/** Continuous stochastic warp: no hard cell boundaries in colour or normals. */
export function tiledUV(
  key: LayerKey,
  scale = 1,
  plane: Node<"vec2"> = positionWorld.xz,
): Node<"vec2"> {
  const base = plane.div(GROUND_TILE[key] * scale);
  const warp = vec2(
    bakedNoise(positionWorld.mul(0.025)),
    bakedNoise(positionWorld.mul(0.025).add(vec3(17, 0, 29))),
  );
  return rotateUV(base, float(scale === 1 ? 0.38 : -0.73), vec2(0)).add(warp.mul(0.35));
}

/** Shared floor sampling: two rotated scales, with continuous world-space blend weights. */
export function groundLayer(
  source: Texture,
  key: LayerKey,
  plane = positionWorld.xz,
): Node<"vec4"> {
  const patch = smoothstep(-0.35, 0.35, bakedNoise(positionWorld.mul(0.025)));
  const far = smoothstep(10, 70, positionView.length());
  const mid = mix(
    texture(source, tiledUV(key, 1, plane)),
    texture(source, tiledUV(key, 2.35, plane)),
    mix(patch.mul(0.65), patch.mul(0.5).add(0.25), far),
  );
  const near = mix(
    mid,
    texture(source, tiledUV(key, 0.23, plane)),
    oneMinus(smoothstep(5, 24, positionView.length())).mul(0.2),
  );
  return mix(
    near,
    texture(source, tiledUV(key, 18, plane)),
    smoothstep(100, 380, positionView.length()).mul(0.72),
  );
}

/** Turf colour shared by the landscape and soil banked against a rock. */
export function groundTurf(
  sampled: Node<"vec3">,
  biome?: IBiome,
  hollow: Node<"float"> = float(0),
  /** 0..1: how far a forest fragment is into open meadow, which takes the lawn turf instead. */
  open: Node<"float"> = float(0),
): Node<"vec3"> {
  const distance = positionView.length();
  const broad = bakedFractalNoise(vec3(positionWorld.x, 0, positionWorld.z).mul(0.006), 2);
  const dry = smoothstep(-0.45, 0.45, broad.sub(hollow.mul(0.06)));
  const tufts = bakedNoise(positionWorld.mul(0.75))
    .mul(0.22)
    .mul(oneMinus(smoothstep(45, 140, distance)))
    .add(1);
  const temperate = !biome || biome.lawnGround;
  if (!temperate) {
    const tint = vec3(...biome.grassTint);
    if (!biome.crestTurf) return sampled.mul(tint);
    const cover = vec3(0.075, 0.12, 0.028).mul(mix(0.91, 1.08, dry));
    return mix(sampled.mul(tint), cover, smoothstep(65, 180, distance).mul(0.85));
  }
  const olive = biome?.oliveMeadow ?? false;
  const lawn = mix(vec3(0.042, 0.072, 0.018), vec3(0.062, 0.102, 0.029), dry);
  const field = (
    olive ? mix(mix(vec3(0.045, 0.062, 0.022), vec3(0.06, 0.082, 0.03), dry), lawn, open) : lawn
  )
    .mul(tufts)
    .mul(mix(0.92, 1.08, smoothstep(0.6, -0.6, hollow)));
  // Open meadow: sward patches metres across, sunlit and deep, so a slope past the grass draw reach
  // still reads as grass rather than one flat tone.
  const sward = mix(
    0.5,
    0.95,
    smoothstep(
      -0.45,
      0.45,
      bakedFractalNoise(vec3(positionWorld.x, 0, positionWorld.z).mul(0.09), 2),
    ),
  );
  const turf = mix(
    sampled.mul(olive ? mix(FOREST_MEADOW, MEADOW, open) : MEADOW),
    field,
    // Open meadow: the photograph's thatch (albedo 0.15) only carries detail under a dark lawn.
    smoothstep(60, 220, distance)
      .mul(0.55)
      .max(open.mul(0.6)),
  ).mul(mix(float(1), sward, open));
  return turf;
}

function rockLayer(
  source: Texture,
  plane: Node<"vec2">,
  biome?: IBiome,
  relief = false,
): Node<"vec4"> {
  const patch = smoothstep(-0.35, 0.35, bakedNoise(positionWorld.mul(0.025)));
  const tap = (scale: number, angle: number, offset: Node<"vec2">) => {
    const sampled = texture(source, rotateUV(plane.div(scale), float(angle), vec2(0)).add(offset));
    if (!relief) return sampled;
    const tangent = rotateUV(sampled.xy.mul(2).sub(1), float(-angle), vec2(0));
    return vec4(tangent, sampled.z.mul(2).sub(1), 1);
  };
  return biome?.crestRock
    ? alpineRockTap(source, plane, relief)
    : biome?.mesaRock
      ? mix(
          tap(11, 0.035, vec2(mx_noise_float(positionWorld.xz.mul(0.009)).mul(0.9), 0)),
          tap(27, -0.045, vec2(0.37, 0.61)),
          patch.mul(0.5).add(0.25),
        )
      : mix(tap(6.7, 0.57, vec2(0)), tap(11.3, -0.83, vec2(0.37, 0.61)), patch);
}

/** The bedrock projection shared by the landscape and a rock's contact band. */
export function stoneAlbedo(
  source: Texture,
  biome?: IBiome,
  normal = normalWorldGeometry,
): Node<"vec3"> {
  const axis = abs(normal).pow(4);
  const share = axis.div(axis.x.add(axis.y).add(axis.z));
  const other = biome !== undefined && !biome.lawnGround;
  const tap = (plane: Node<"vec2">) =>
    other ? rockLayer(source, plane, biome).rgb : texture(source, tiledUV("rock", 1, plane)).rgb;
  return share.x
    .mul(tap(positionWorld.zy))
    .add(share.y.mul(tap(positionWorld.xz)))
    .add(share.z.mul(tap(positionWorld.xy)));
}

export function stoneColor(sampled: Node<"vec3">, biome?: IBiome): Node<"vec3"> {
  const look = biome ?? BIOMES.forest;
  if (look.crestRock) return alpineRockColor(sampled);
  if (look.mesaRock) return desertRockColor(sampled);
  const grey = dot(sampled, vec3(0.2126, 0.7152, 0.0722));
  return mix(sampled, vec3(grey), look.stoneGrey).mul(vec3(...look.stoneTint));
}

export function stoneRelief(
  source: Texture,
  biome?: IBiome,
  normal = normalWorldGeometry,
): Node<"vec3"> {
  if (!biome || biome.lawnGround) return triplanarRelief(source, "rock", 1, normal).tilt;
  const axis = abs(normal).pow(4);
  const share = axis.div(axis.x.add(axis.y).add(axis.z));
  const x = rockLayer(source, positionWorld.zy, biome, true);
  const y = rockLayer(source, positionWorld.xz, biome, true);
  const z = rockLayer(source, positionWorld.xy, biome, true);
  return share.x
    .mul(vec3(0, x.y, x.x.mul(sign(normal.x))))
    .add(share.y.mul(vec3(y.x, 0, y.y)))
    .add(share.z.mul(vec3(z.x.mul(sign(normal.z)), z.y, 0)));
}

/**
 * One normal map's two answers on the ground plane: the tilt it asks for, and how much of its own
 * up-facing it kept.
 *
 * Only the two tangential channels go into the tilt. The surface direction is already the
 * heightfield's own normal, and folding a second "out of the surface" term in here would cancel the
 * relief this map exists to add. On the ground plane the map's red runs along +x and its green
 * along +z. The third channel is not thrown away: it is the crevice term below.
 */
interface IRelief {
  /** How much this texel faces up, 0..1. A crevice is a texel that does not. */
  readonly crevice: Node<"float">;
  readonly tilt: Node<"vec3">;
}

function planarRelief(source: Texture, uv: Node<"vec2">, strength: number, angle = 0.38): IRelief {
  const sample = texture(source, uv);
  const tangent = rotateUV(sample.xy.mul(2).sub(1), float(-angle), vec2(0));
  return {
    crevice: sample.z,
    tilt: vec3(tangent.x, 0, tangent.y).mul(strength),
  };
}

/**
 * The same relief projected on all three axes — this is what keeps a cliff from smearing.
 *
 * Each projection owns a different pair of world axes, so one map tilts the surface along a
 * different direction per axis and the three are recombined by the surface's own blend weights. The
 * crevice term is the one projection, because a crease is a crease whichever way the cliff faces.
 *
 * `roughnessScale` widens the sample spacing on the wall projections. A cliff nine metres of strata
 * across reads a nine-metre map at a one-metre scale as an unreadable fine band along its own
 * tangential direction, which is what a wall projection always does without this.
 */
function triplanarRelief(
  source: Texture,
  key: LayerKey,
  roughnessScale = 1,
  normal = normalWorldGeometry,
): IRelief {
  const tap = (plane: Node<"vec2">) => {
    const sampled = texture(source, tiledUV(key, roughnessScale, plane));
    const tangent = rotateUV(
      sampled.xy.mul(2).sub(1),
      float(roughnessScale === 1 ? -0.38 : 0.73),
      vec2(0),
    );
    return vec3(tangent, sampled.z.mul(2).sub(1));
  };
  const x = tap(positionWorld.zy);
  const y = tap(positionWorld.xz);
  const z = tap(positionWorld.xy);
  const axis = abs(normal).pow(4);
  const weight = axis.div(axis.x.add(axis.y).add(axis.z));
  return {
    crevice: float(1),
    tilt: weight.x
      .mul(vec3(0, x.y, x.x.mul(sign(normal.x))))
      .add(weight.y.mul(vec3(y.x, 0, y.y)))
      .add(weight.z.mul(vec3(z.x.mul(sign(normal.z)), z.y, 0))),
  };
}

/**
 * How steep a face has to be before a layer stops being projected onto the ground plane.
 *
 * A planar projection is exact on flat ground and wrong everywhere else, and it is *very* wrong on a
 * slope: the map is stretched along the slope's own direction by the reciprocal of the cosine, so a
 * thirty-degree hillside turns a 2.6 m grass tile into a five-metre smear. Thirty-five degrees is
 * where that smear stops being invisible — below it the slope is gentle enough that the detail still
 * reads, above it the triplanar takes over.
 */
// Slope is 1 − cos(angle): 0.18 is 35°, not the sine of 35°.
const TRIPLANAR_SLOPE = 0.18;

/** Wind ripples share one world-space phase; changing normals must not bend the phase. */
const RIPPLE = {
  /** Crests per metre across the fall line. Real ripples are 5-20 cm apart; these read at 25 cm. */
  frequency: 4,
  /** How far the crests tilt the surface, and how much their spacing wanders. */
  strength: 0.065,
  wander: 1.4,
} as const;

function sandRipples(direction?: Node<"vec2">): Node<"vec3"> {
  // A coherent wind direction avoids radial stripes where a beach normal changes.
  const fall = direction ?? vec2(0.83, 0.56);
  const downhill = fall.length().max(float(0.0001));
  const across = vec2(fall.x.div(downhill), fall.y.div(downhill));
  // Distance across the wind, in metres; slow noise breaks a perfect comb.
  const phase = positionWorld.x
    .mul(across.x)
    .add(positionWorld.z.mul(across.y))
    .mul(RIPPLE.frequency * Math.PI * 2);
  const wobble = bakedNoise(positionWorld.mul(0.09)).mul(RIPPLE.wander);
  const crest = phase.add(wobble).sin();
  // Subtle relief disappears before the crests become smaller than a pixel.
  return vec3(across.x, 0, across.y)
    .mul(crest)
    .mul(RIPPLE.strength)
    .mul(oneMinus(smoothstep(8, 35, positionView.length())));
}

/**
 * One albedo map projected on all three axes, recombined by the surface's own normal.
 *
 * This is the same idea as {@link triplanarRelief} on the colour side, and it is what a hillside
 * needs: a planar projection stretches the map by the reciprocal of the cosine of the slope, so the
 * further off flat the ground gets the more the detail smears along the fall line. Sampling the three
 * world-axis planes and blending by `|n|` costs two extra taps and buys a hillside with detail on it
 * at every angle.
 *
 * The wall projections sample at a coarser spacing than the floor one, because a vertical face has no
 * floor projection to fall back on and at full density a nine-metre tile turns into fine stripes down
 * its own length.
 */
function triplanarAlbedo(source: Texture, key: LayerKey, scale = 1): Node<"vec4"> {
  const axis = abs(normalWorldGeometry).pow(4);
  const weight = axis.div(axis.x.add(axis.y).add(axis.z));
  const x = texture(source, tiledUV(key, scale, positionWorld.zy));
  const y = texture(source, tiledUV(key, scale));
  const z = texture(source, tiledUV(key, scale, positionWorld.xy));
  return weight.x.mul(x).add(weight.y.mul(y)).add(weight.z.mul(z)) as Node<"vec4">;
}

/**
 * A third of a metre of ground grain, as a tilt in world space.
 *
 * The last scale of detail on the ground is not a texture: it is the difference between a surface
 * that is *smooth* and one that is *smooth at a hundred metres*. One fractal noise field, differenced
 * into a gradient, gives it for the price of four instructions and no sampler at all — and the ground
 * material is already at eleven sampled textures, so a twelfth map is not available however much this
 * detail wants it.
 *
 * It is deliberately faint. This is a third of a metre of clumping between the blades, not the blades
 * themselves, and the capture that showed a speckled meadow is what happens when it is not: a normal
 * perturbation this high-frequency reads as static underfoot and as noise at any distance, and it
 * costs the eye the thing it was added for.
 */
function microGrain(): Node<"vec3"> {
  const field = (p: Node<"vec3">) => bakedFractalNoise(p.mul(2.6), 2, 2, 0.5);
  const here = field(positionWorld);
  const step = float(0.22);
  const dx = here.sub(field(positionWorld.add(vec3(step, 0, 0))));
  const dz = here.sub(field(positionWorld.add(vec3(0, 0, step))));
  return vec3(dx, 0, dz).div(step).mul(0.06);
}

/** Crown radius in metres per unit of placement scale, for the trees that drop needle litter. */
const CANOPY_CROWN: Readonly<Record<string, number>> = { spruce: 7, sapling: 2.5 };

/**
 * Paint each placed tree's crown into the terrain's `canopy` vertex attribute, so the ground under a
 * stand reads as forest floor rather than meadow turf. Vertices are row-major Z then X, centred at
 * zero, at the heightfield's own spacing.
 */
export function paintCanopy(
  mesh: Mesh,
  data: Pick<IBakedWorld, "size" | "resolution">,
  placements: readonly {
    readonly asset: string;
    readonly position: readonly number[];
    readonly scale: number;
  }[],
): void {
  const cover = mesh.geometry.getAttribute("canopy");
  if (!(cover instanceof Float32BufferAttribute) || data.resolution < 2) return;
  const values = cover.array as Float32Array;
  const spacing = data.size / (data.resolution - 1);
  const half = data.size / 2;
  for (const placement of placements) {
    const crown = CANOPY_CROWN[placement.asset];
    if (crown === undefined) continue;
    const radius = Math.max(spacing, crown * placement.scale);
    const x = placement.position[0] ?? 0;
    const z = placement.position[2] ?? 0;
    const fromColumn = Math.max(0, Math.ceil((x - radius + half) / spacing));
    const toColumn = Math.min(data.resolution - 1, Math.floor((x + radius + half) / spacing));
    const fromRow = Math.max(0, Math.ceil((z - radius + half) / spacing));
    const toRow = Math.min(data.resolution - 1, Math.floor((z + radius + half) / spacing));
    for (let row = fromRow; row <= toRow; row++)
      for (let column = fromColumn; column <= toColumn; column++) {
        const dx = column * spacing - half - x;
        const dz = row * spacing - half - z;
        const reach = 1 - (dx * dx + dz * dz) / (radius * radius);
        if (reach <= 0) continue;
        const index = row * data.resolution + column;
        values[index] = Math.max(values[index] as number, reach);
      }
  }
  cover.needsUpdate = true;
}

/**
 * The ground material: one lit surface whose colour is a blend of six PBR layers, blended in weight
 * order outwards from the base surface.
 */
export async function createGroundMaterial(
  data: IBakedWorld,
  assets: IAssetLoader,
  curvature: IGroundCurvature,
  biome?: IBiome,
  /**
   * A streamed tile carries no painted `canopy` or baked `sky`: it lies past the trees and keeps the
   * whole sky, exactly as the collar's own attributes say.
   */
  streamed = false,
): Promise<MeshStandardNodeMaterial> {
  const canopyCover = (): Node<"float"> =>
    streamed ? float(0) : attribute<"float">("canopy", "float");
  const skyShare = (): Node<"float"> => (streamed ? float(1) : attribute<"float">("sky", "float"));
  const measured =
    biome && "heightBands" in biome
      ? (biome as IWorldBiome)
      : measureBiome(biome ?? BIOMES.forest, data.heights);
  const look = biome ?? BIOMES.forest;
  const maps: Partial<Record<LayerKey, ILayerMaps>> = {};
  const material = new MeshStandardNodeMaterial({ metalness: 0, roughness: 0.94 });
  material.userData.biome = look.world;
  material.userData.erosion = data.erosion !== undefined;
  const held = new Set<Texture>([curvature.texture]);
  // The forest's alpine backdrop shades from the unfiltered survey (owner, 2026-11-04: "mountain
  // tops textures and heightmaps suck"); the sixteenth binding, so only this world takes it.
  const collar = look.surveyCollar ? buildCollarRelief(look.world) : undefined;
  if (collar) held.add(collar.texture);
  const layer = (key: LayerKey): ILayerMaps => {
    const found = maps[key];
    if (!found?.diffuse) throw new RangeError(`Ground layer '${key}' has no diffuse texture`);
    return found;
  };

  const otherBiome = biome !== undefined && !biome.lawnGround;
  const macro = bakedFractalNoise(vec3(positionWorld.x, 0, positionWorld.z).mul(0.014), 3);
  const mottling = bakedNoise(vec3(positionWorld.x, 0, positionWorld.z).mul(0.045));

  // --- where each surface sits -------------------------------------------------------------
  const slope = normalWorldGeometry.y.abs().oneMinus();
  const breakUp = bakedFractalNoise(positionWorld.mul(0.05), 3);
  const steep = clamp(slope.add(breakUp.mul(0.05)), 0, 1);
  // +1 in a hollow, -1 on a rib. The two ends of the ground's own shape, which slope cannot tell
  // apart: a gully and a nose are both steep, and they are not the same surface.
  const outside = max(abs(positionWorld.x), abs(positionWorld.z));
  const hollow = curvature.node.mul(
    oneMinus(smoothstep(data.size / 2, data.size / 2 + 28, outside)),
  );
  // Forest only: the open meadow past the square's edge (`OPEN_MEADOW`), eased in over 40 m.
  const open =
    OPEN_MEADOW && look.openMeadow
      ? smoothstep(data.size / 2, data.size / 2 + 40, outside)
      : float(0);
  // Material placement follows the actual landform, never the bake's brown blob palette.
  const drainage = smoothstep(0.12, 0.65, curvature.flow);
  const deposits = smoothstep(0.08, 0.6, curvature.deposits);
  const scour = drainage.mul(smoothstep(0.035, 0.18, slope));
  // The material's transport terms read the erosion bake through the curvature texture.
  const flow = curvature.flow;
  const sediment = deposits;
  const rib = smoothstep(-0.02, -0.45, hollow);
  const alpine = elevationBand(
    measured,
    measured.heightBands.alpine,
    positionWorld.y.add(breakUp.mul(5)),
  );
  // No recorded sea level means an inland world, and an inland world has no beach.
  const sand =
    data.waterLevel === null
      ? float(0)
      : smoothstep(float(SHORE.beach), float(SHORE.wet), positionWorld.y.sub(data.waterLevel)).mul(
          smoothstep(0.34, 0.1, steep),
        );
  /**
   * How wet the sand under this fragment is, 0..1: one at the sea surface, gone `WET_SAND.band`
   * metres above it.
   *
   * The band is broken by the same slow noise the litter uses so the high-water mark is a ragged edge
   * rather than a contour line — the same reason the foam's outer edge wanders in `ocean.ts`.
   */
  const wetness = (): Node<"float"> => {
    if (data.waterLevel === null) return float(0);
    const above = positionWorld.y.sub(float(data.waterLevel));
    const wander = bakedFractalNoise(positionWorld.mul(0.06), 3).mul(0.55).add(0.5);
    return float(1).sub(
      smoothstep(float(0), float(otherBiome ? 1.6 : WET_SAND.band), above.div(wander)),
    );
  };
  const weights: Record<LayerKey, Node<"float">> = {
    // The bake painted its beach in the same red-over-green as its dirt, so the height rule above
    // has to be the one that speaks for the shore; painted dirt steps aside where it does.
    dirt: max(
      drainage.mul(0.18).max(sediment.mul(0.5)),
      smoothstep(0.025, 0.18, steep)
        .mul(smoothstep(-0.12, 0.32, breakUp))
        .mul(0.48),
    ).mul(sand.oneMinus()),
    grass: float(1),
    moss: drainage.mul(smoothstep(0.02, 0.14, steep)).mul(0.24),
    sand,
    // Rock shows where the ground is steep *and* convex — the nose of a rib, the face of a scarp. On a
    // concave slope the ground is covered by what has fallen into it, which is the moss above, so the
    // steepness term is scaled down in a hollow rather than replaced: bare rock still shows at a
    // scarp's foot where the ground is steep and the debris has not arrived yet.
    // Soil holds on ordinary hills; only scarps expose bedrock (34–48 degrees).
    rock: smoothstep(0.17, 0.33, steep.add(rib.mul(0.04)).add(breakUp.mul(0.025)))
      .mul(mix(0.65, 1, elevationBand(measured, measured.heightBands.rock)))
      .mul(oneMinus(smoothstep(0.15, 0.8, hollow).mul(0.25))),
    snow: elevationBand(measured, measured.snowBand).mul(
      smoothstep(measured.snowFractions[2], 0.06, steep),
    ),
  };

  Object.assign(weights, biomeWeights(measured, steep, hollow, breakUp));
  // Needle litter and crown shade under the placed stands, as a multiplicative floor tint.
  let forestFloor: Node<"float"> = float(0);
  let bareSoil: Node<"float"> = float(0);
  // Transport, slope and shelter choose the splat; noise only frays the material's edge.
  weights.rock = max(weights.rock, scour.mul(0.9)).mul(oneMinus(deposits.mul(0.22)));
  if (look.crestRock) weights.rock = max(weights.rock, smoothstep(0.08, 0.22, slope));
  weights.dirt = max(weights.dirt.mul(0.45), deposits.mul(0.85))
    .mul(oneMinus(smoothstep(0.22, 0.4, slope)))
    .mul(sand.oneMinus());
  if (look.mossGround) {
    weights.moss = hollow
      .max(0)
      .mul(oneMinus(drainage))
      .mul(smoothstep(0.12, 0.025, slope))
      .mul(oneMinus(weights.snow))
      .mul(0.7);
  }
  if (!otherBiome) {
    // Ordinary forest hills carry turf; reserve exposed soil for drainage banks.
    if (look.woodedGround)
      weights.dirt = drainage.mul(0.18).max(sediment.mul(0.5)).mul(sand.oneMinus());
    if (look.woodedGround) {
      // Needle litter lies under the trees that were actually placed (`paintCanopy`), frayed by noise
      // at its edge. The old sine-sum stand mask no longer matched the value-noise scatter, and its
      // 38 m fade left every stand standing on meadow turf from any height.
      const litter = smoothstep(0, 0.6, canopyCover())
        .mul(mix(0.72, 1, smoothstep(-0.5, 0.5, bakedNoise(positionWorld.mul(2.2)))))
        .mul(oneMinus(smoothstep(300, 600, positionView.length())))
        .mul(0.85);
      weights.dirt = weights.dirt.max(litter.mul(0.25));
      forestFloor = litter;
      // The bare patches are the wood's own: a ground drawn with no look keeps its litter only.
      if (biome?.woodedGround) {
        // Bare earth breaks the meadow in broad patches, as on a real spruce slope: broad noise
        // picks them, finer noise frays their edge, a hollow keeps its turf. They fade out by 350 m
        // so a far slope does not print the noise as camouflage.
        const bare = smoothstep(
          0.16,
          0.5,
          macro.add(mottling.mul(0.85)).sub(hollow.max(0).mul(0.2)),
        )
          .mul(oneMinus(smoothstep(150, 350, positionView.length())))
          .mul(oneMinus(open));
        weights.dirt = weights.dirt.max(bare.mul(0.8));
        // The soil takes the litter's warm needle tint in full, not the dirt photograph's grey gravel.
        forestFloor = forestFloor.max(bare);
        bareSoil = bare;
      }
    }
    // Coastal soil patches remain; the forest meadow keeps turf between distant blade clusters.
    if (look.shoreGround) {
      const dry = smoothstep(0.14, 0.42, macro.add(mottling.mul(0.85)).sub(hollow.mul(0.12)));
      weights.dirt = max(weights.dirt, dry.mul(0.7)).mul(sand.oneMinus());
    }
    weights.moss = hollow
      .max(0)
      .mul(oneMinus(drainage))
      .mul(smoothstep(0.15, 0.025, slope))
      .mul(0.5);
    if (biome?.woodedGround) {
      // A spruce floor is moss and needles, not turf and not bare sand: under the placed crowns and
      // on the wood's bare patches the moss layer grows in broad cushions, frayed by a finer noise,
      // and the needle soil shows between them. In the low sun the old floor drew as pale sand.
      const cushions = smoothstep(
        -0.25,
        0.3,
        bakedNoise(vec3(positionWorld.x, 0, positionWorld.z).mul(0.35)).add(mottling.mul(0.5)),
      );
      weights.moss = weights.moss.max(forestFloor.mul(cushions).mul(0.85));
    }
  }

  // --- how each surface looks -------------------------------------------------------------
  // Apply observed deposition after biome placement so dry/snow-world rules cannot erase it.
  weights.dirt = weights.dirt.max(sediment.mul(0.5)).max(flow.mul(0.28)).mul(sand.oneMinus());
  // The layers that cover most of a meadow take a second, larger scale faded in with distance: one
  // tile under the player's feet, a coarser one near the horizon, and no single lattice for the eye
  // to find anywhere between.
  const far = smoothstep(float(10), float(70), positionView.length());
  const patch = smoothstep(-0.35, 0.35, bakedNoise(positionWorld.mul(0.025)));
  const tileBlend = mix(patch.mul(0.65), patch.mul(0.5).add(0.25), far);
  // How much of a layer is projected onto the ground plane and how much onto the walls. Zero on the
  // meadow, one on a cliff, and eased across the thirty-five degrees where a planar projection stops
  // being an approximation and becomes a smear.
  const planarShare = float(1).sub(
    smoothstep(float(TRIPLANAR_SLOPE * 0.55), float(TRIPLANAR_SLOPE * 1.6), steep),
  );

  /**
   * One layer's albedo: the ground plane near the camera, the walls on a slope, and a coarser tile
   * faded in with distance so the horizon is not a field of half-resolved texels.
   *
   * The two planar scales are what the last captures' "flat green tint" was not: a single scale at
   * 2.6 m is a dozen pixels wide from fifty metres away, and the middle distance goes to a wash. The
   * two are blended rather than switched so the crossover has no seam to find.
   */

  const albedoOf = (key: LayerKey): Node<"vec4"> => {
    const { diffuse } = layer(key);
    const flat = groundLayer(diffuse, key);
    if (look.mossGround && (key === "grass" || key === "dirt" || key === "moss")) {
      // The same rotated two-scale floor and walls continue across the resident edge.
      const axis = abs(normalWorldGeometry).pow(4);
      const share = axis.div(axis.x.add(axis.y).add(axis.z));
      const tap = (plane: Node<"vec2">) => groundLayer(diffuse, key, plane);
      const sampled = share.x
        .mul(tap(positionWorld.zy))
        .add(share.y.mul(flat))
        .add(share.z.mul(tap(positionWorld.xy))) as Node<"vec4">;
      return key === "dirt"
        ? vec4(sampled.rgb.mul(vec3(0.7, 0.58, 0.42)), sampled.a)
        : key === "moss"
          ? vec4(sampled.rgb.mul(vec3(1.08, 1.07, 0.65)), sampled.a)
          : sampled;
    }
    const walls =
      key === "rock" ? vec4(stoneAlbedo(diffuse, biome), 1) : triplanarAlbedo(diffuse, key);
    const blended = key === "rock" ? walls : mix(walls, flat, planarShare);
    if (key === "snow" && biome) return vec4(blended.rgb.mul(vec3(...biome.snowTint)), blended.a);
    // The wet band, applied to the sand only. It belongs here rather than in the layer blend below
    // because it is a *height* fact about the water's last reach, not a weight another surface has.
    if (key === "rock") {
      const stone = stoneColor(blended.rgb, biome);
      // Resolved stone underfoot; broad weathering once the photograph's repeats become visible.
      const weathering = bakedFractalNoise(positionWorld.mul(vec3(0.005, 0.011, 0.005)), 2)
        .mul(0.18)
        .add(1);
      const large = triplanarAlbedo(diffuse, key, 16).rgb;
      const massif = look.crestRock
        ? alpineRockColor(large)
        : look.mesaRock
          ? desertRockColor(large)
          : large.mul(vec3(...look.stoneTint));
      const distant = mix(
        vec3(...(look.groundDistantStone ?? look.distantStone)),
        massif,
        0.65,
      ).mul(weathering);
      return vec4(
        mix(stone, distant, smoothstep(35, 220, positionView.length()).mul(look.distantStoneShare)),
        blended.a,
      );
    }
    if (key !== "sand" || data.waterLevel === null) return blended;
    const wet = wetness();
    const wrack = otherBiome
      ? float(0)
      : oneMinus(
          smoothstep(
            0.07,
            0.21,
            positionWorld.y
              .sub(2.1)
              .sub(bakedNoise(positionWorld.mul(0.05)).mul(0.5))
              .abs(),
          ),
        )
          .mul(smoothstep(-0.1, 0.15, bakedNoise(positionWorld.mul(0.65))))
          // Subpixel wrack fragments read as brown loops from the overview.
          .mul(oneMinus(smoothstep(60, 120, positionView.length())));
    const sandColor = otherBiome
      ? blended.rgb
      : mix(blended.rgb, vec3(dot(blended.rgb, vec3(0.2126, 0.7152, 0.0722))), 0.55).mul(
          vec3(1.95, 1.82, 1.55),
        );
    return vec4(
      sandColor
        .mul(mix(vec3(1), vec3(0.45, 0.37, 0.24), wrack))
        .mul(mix(float(1), otherBiome ? vec3(0.52, 0.5, 0.55) : WET_SAND.darken, wet)),
      blended.a,
    );
  };

  // The relief takes the same scales as the colour, or the ground keeps its detail underfoot and goes
  // flat past twenty metres.
  const reliefOf = (key: LayerKey, strength: number): IRelief => {
    const source = layer(key).normal;
    if (source === undefined)
      return {
        crevice: float(1),
        tilt: key === "sand" ? sandRipples() : key === "snow" ? microGrain().mul(0.4) : vec3(0),
      };
    if (key === "rock") {
      const walls = { crevice: float(1), tilt: stoneRelief(source, biome) };
      return {
        crevice: walls.crevice,
        tilt: mix(
          walls.tilt.mul(strength),
          triplanarRelief(source, key, 12).tilt.mul(strength * 0.45),
          smoothstep(80, 320, positionView.length()),
        ),
      };
    }
    const near = planarRelief(source, tiledUV(key), strength);
    const coarse = planarRelief(source, tiledUV(key, 2.35), strength * 0.6, -0.73);
    const flat: IRelief = {
      crevice: mix(near.crevice, coarse.crevice, tileBlend),
      tilt: mix(near.tilt, coarse.tilt, tileBlend)
        .add(
          planarRelief(source, tiledUV(key, 0.18), strength * 0.42, -0.73).tilt.mul(
            oneMinus(smoothstep(6, 28, positionView.length())),
          ),
        )
        .mul(mix(1, 0.35, smoothstep(60, 240, positionView.length()))),
    };
    // Rock's strata are metres across, so its wall projection samples at its own tile size; grass and
    // dirt sample at theirs, which is why a cliff's grass fringe keeps the same grain as the meadow.
    const walls = triplanarRelief(source, key);
    const blended: IRelief = {
      crevice: mix(walls.crevice, flat.crevice, planarShare),
      tilt: mix(walls.tilt.mul(strength), flat.tilt, planarShare),
    };
    // Sand has no normal map at all, so its relief is entirely the ripple field below — and the
    // ripples flatten in the wet band, because wet sand is packed and the sea has ironed them out.
    return key === "sand"
      ? {
          ...blended,
          tilt: blended.tilt.add(sandRipples().mul(float(1).sub(wetness().mul(WET_SAND.calm)))),
        }
      : blended;
  };

  let snowCover: Node<"float"> = float(0);
  const samples: Partial<Record<LayerKey, { surface: Node<"vec4">; relief: IRelief }>> = {};
  material.addEventListener("dispose", () => {
    for (const source of held) source.dispose();
  });
  try {
    // Owner-local crags remain optional; the package always carries the portable CC0 fallback.
    const rockPaths = otherBiome ? biome.maps.rock : ROCKFACE_MAPS;
    if (rockPaths.diffuse.startsWith("temperate/")) {
      const diffuse = await get(assets, rockPaths.diffuse, false);
      if (diffuse) {
        held.add(diffuse);
        const normal = rockPaths.normal ? await get(assets, rockPaths.normal, true) : undefined;
        if (normal) held.add(normal);
        maps.rock = { diffuse, normal };
      }
    }
    return (await loadTerrainSplat({
      assets,
      url: `world/${biome?.world ?? "forest"}.world.json`,
      layerSample: ({ layer: descriptor, diffuse, normal: normalMap }) => {
        const key = descriptor.id as LayerKey;
        maps[key] ??= { diffuse, normal: normalMap };
        const surface = albedoOf(key);
        const relief = reliefOf(
          key,
          key === "grass" ? 0.38 : key === "rock" ? 0.52 : key === "snow" ? 0.18 : 0.32,
        );
        samples[key] = { surface, relief };
        if (key !== "grass") return { color: surface.rgb, normal: relief.tilt };
        let normal = relief.tilt
          .mul(weights.grass)
          .mul(look.crestTurf ? mix(1, 0.05, smoothstep(45, 130, positionView.length())) : 1)
          .add(microGrain().mul(oneMinus(smoothstep(12, 60, positionView.length()))));
        if (look.sandRipples) normal = normal.add(sandRipples(vec2(0.53, 0.85)).mul(weights.grass));
        const turf = groundTurf(surface.rgb, biome, hollow, open);
        // Open turf in the wood takes the row's `turfTint`; under the crowns the needle litter
        // (`FOREST_FLOOR`) already owns the tone, so the tint fades out with the canopy.
        return {
          color: look.woodedGround
            ? turf.mul(mix(LOOK.turf, vec3(1), smoothstep(0, 0.6, canopyCover())))
            : turf,
          normal,
        };
      },
      // Geometry, transport and curvature choose placement; the packaged masks remain authored data.
      layerWeight: (_masked, { layer: descriptor }) => {
        const key = descriptor.id as LayerKey;
        const weight = weights[key];
        const sample = samples[key];
        if (!sample) throw new RangeError(`Ground layer '${key}' was not sampled`);
        const { surface, relief } = sample;
        // No displacement maps in these starter sets: normal relief breaks the blend edge,
        // while slope, elevation and curvature determine which surface belongs here.
        const reliefHeight = relief.crevice.sub(0.8).mul(0.12).add(breakUp.mul(0.045));
        // The photograph's relief and metre-scale breakup cut pockets into the soil/rock boundary.
        const rockHeight = dot(surface.rgb, vec3(0.2126, 0.7152, 0.0722))
          .sub(0.1)
          .mul(0.7)
          .add(bakedNoise(positionWorld.mul(0.65)).mul(0.16));
        const over =
          key === "snow" && otherBiome
            ? weight.mul(float(1).add(breakUp.mul(0.025))).clamp(0, 1)
            : key === "rock"
              ? smoothstep(0.34, 0.51, weight.add(rockHeight))
              : smoothstep(0.12, 0.82, weight.add(reliefHeight));
        if (key === "snow") snowCover = over;
        return over;
      },
      materialFactory: ({ color, normal }) => {
        const albedo = vec4(color, 1);
        // Concavity occludes sky bounce, leaving direct sunlight physically separate; the
        // horizon the surrounding relief makes (`skyVisibility`) shades valleys and gorges too.
        material.aoNode = mix(float(1), float(0.88), smoothstep(0.2, 0.85, hollow)).mul(skyShare());

        // 50–200 metre vegetation tones survive texture mipmapping in the overview.
        const dryness = otherBiome
          ? smoothstep(
              -0.18,
              0.22,
              bakedFractalNoise(positionWorld.mul(0.006), 3)
                .sub(hollow.mul(0.16))
                .add(alpine.mul(0.06)),
            )
          : max(deposits.mul(0.7), drainage.mul(smoothstep(0.015, 0.12, slope)).mul(0.4));
        const tone = otherBiome
          ? mix(vec3(0.92, 0.94, 0.91), vec3(1.08, 1.03, 0.95), dryness)
          : mix(vec3(0.9, 0.95, 0.84), vec3(1.03, 1.04, 0.95), dryness);
        const vegetation = oneMinus(max(max(weights.rock, weights.snow), weights.sand));
        // Past the square the forest's hills are its wooded lower slopes: seen from 150 m and more
        // they take the backdrop's spruce cover from 40 m inside the edge, while the meadow under the
        // player's feet keeps the playable ground's own turf.
        const continuation =
          !otherBiome && !look.surveyedBackdrop
            ? max(
                smoothstep(data.size / 2 + 60, data.size / 2 + 280, outside),
                smoothstep(data.size / 2 - 40, data.size / 2 + 20, outside).mul(
                  smoothstep(150, 350, positionView.length()),
                ),
              )
            : smoothstep(data.size / 2 + 60, data.size / 2 + 280, outside);
        const strata = bakedFractalNoise(positionWorld.mul(vec3(0.018, 0.035, 0.018)), 3);
        // The forest's backdrop is alpine (owner goal 2026-11-04); the coast keeps its survey's look.
        const crestBackdrop = !look.surveyedBackdrop;
        // Where the collar mesh blends to its prefiltered field (300 m past the edge and on), its
        // shading reads the unfiltered survey instead; the vista's near meadow keeps the mesh.
        const reliefWeight = collar
          ? smoothstep(data.size / 2 + 300, data.size / 2 + 600, outside)
          : float(0);
        const surveyedNormal = collar
          ? normalize(mix(normalWorldGeometry, collar.normal, reliefWeight))
          : normalWorldGeometry;
        const crestSteep = collar
          ? clamp(oneMinus(surveyedNormal.y.abs()).add(breakUp.mul(0.05)), 0, 1)
          : steep;
        // Talus at the feet of cliff bands: the same rock, finer and paler.
        const scree = collar ? collar.scree.mul(reliefWeight) : float(0);
        // Bedding: strata on the steep rock, each a cliff under a ledge, as the goal frame's faces
        // break into bands (owner, 2026-11-04). Real beds dip about 20 degrees, thin and thicken, and
        // break along the strike; level, evenly spaced, unbroken rings read as artificial contour
        // lines (owner, 2026-11-07). The phase is antialiased by its own screen derivative, so a band
        // thinner than a pixel greys out instead of crawling. No noise feeds back into its own domain:
        // that warp curled the beds into marbled swirls (owner, 2026-11-09); beds bend only gently.
        const dipped = positionWorld.y
          .add(positionWorld.x.mul(0.3))
          .sub(positionWorld.z.mul(0.18))
          .add(bakedFractalNoise(positionWorld.mul(0.004), 2).mul(20));
        const bedding = dipped.div(34);
        const phase = fract(bedding);
        const blur = fwidth(bedding).min(0.25);
        const ledge = smoothstep(float(0.8).sub(blur), float(0.88).add(blur), phase).mul(
          oneMinus(smoothstep(float(0.95).sub(blur), float(1).add(blur), phase)),
        );
        const wall = smoothstep(float(0.08).sub(blur), float(0.2).add(blur), phase).mul(
          oneMinus(smoothstep(float(0.66).sub(blur), float(0.8).add(blur), phase)),
        );
        // A bed runs a few hundred metres along the face and pinches out under scree and couloirs.
        const runs = smoothstep(
          -0.05,
          0.3,
          bakedFractalNoise(positionWorld.mul(vec3(0.006, 0.03, 0.006)), 2),
        );
        // Not every face is bedded: kilometre patches carry bands, the rest stays massive rock.
        const bedded = collar
          ? smoothstep(-0.15, 0.25, bakedFractalNoise(positionWorld.mul(0.0018), 2))
              .mul(runs)
              .mul(reliefWeight)
          : float(0);
        // Crag ribs that the prefiltered 10 m backdrop mesh cannot carry: 35 m across and 90 m down
        // the fall line, as couloirs and buttresses run. Their gradient tilts the normal and their
        // creases darken the rock, so cliff bands read at two kilometres.
        // The forest's massif (the only lawn world with a crest backdrop) takes three scales instead:
        // 350, 120 and 41 m across, each 2.3 times longer down the fall line, as a 110 m relief whose
        // every octave tilts the face by the same angle, so spurs and couloirs catch the low sun at
        // every range.
        const massif = !otherBiome && crestBackdrop;
        const facetAt = (x: number, y: number, z: number) =>
          massif
            ? bakedFractalNoise(
                positionWorld.add(vec3(x, y, z)).mul(vec3(1 / 350, 1 / 800, 1 / 350)),
                3,
                2.9,
                0.33,
              )
            : bakedFractalNoise(positionWorld.add(vec3(x, y, z)).mul(vec3(0.028, 0.011, 0.028)), 2);
        const facet = facetAt(0, 0, 0);
        const facetTilt = vec3(
          facet.sub(facetAt(6, 0, 0)),
          facet.sub(facetAt(0, 6, 0)),
          facet.sub(facetAt(0, 0, 6)),
        ).mul(massif ? 110 / 6 : 1.4);
        // Reuse the resident maps at massif scale: steep faces project onto their own axes.
        const turf = triplanarAlbedo(layer("grass").diffuse, "grass", 12).rgb;
        // The forest's lower slopes are a closed spruce cover drawn by material alone: 11 m crowns
        // with dark gaps, denser and sparser stands, darker in the hollows, opened by kilometre meadow clearings.
        // Past 1 km a crown is a few pixels: its contrast fades, so the cover does not scale over.
        // One baked read repeats every 8 noise units (88 m at this scale) and drew a checker under the
        // fog; a second read on a lattice turned 37 degrees and 1.53 times finer breaks the period.
        const crownField = bakedNoise(positionWorld.div(11))
          .add(
            bakedNoise(
              vec3(
                positionWorld.x.mul(0.8).add(positionWorld.z.mul(0.6)),
                positionWorld.y,
                positionWorld.z.mul(0.8).sub(positionWorld.x.mul(0.6)),
              ).div(7.2),
              1,
              0,
              2,
            ),
          )
          .mul(0.7);
        const crowns = mix(
          smoothstep(-0.3, 0.35, crownField),
          float(0.55),
          smoothstep(400, 1200, positionView.length()).mul(0.8),
        );
        const clumps = bakedFractalNoise(positionWorld.div(160), 2);
        const clearings = smoothstep(
          0.28,
          0.5,
          bakedFractalNoise(positionWorld.mul(0.008), 2).sub(crestSteep.mul(0.4)),
        );
        const cover = mix(
          BACKDROP_SPRUCE.mul(mix(0.4, 1.3, crowns))
            .mul(clumps.mul(0.15).add(1))
            .mul(
              mix(float(1), float(0.7), collar ? smoothstep(0.1, 0.5, collar.hollow) : float(0)),
            ),
          BACKDROP_CLEARING.mul(mix(0.85, 1.1, crowns)),
          clearings,
        );
        // The coast's surveyed backdrop is an open lawn.
        const forest = crestBackdrop
          ? cover
          : turf.mul(MEADOW).mul(mix(0.5, 0.85, breakUp.add(0.5)));
        // The massif reads at 1-3 km: the rock map tiles at 60 m and 220 m, blended by kilometre
        // noise, so no face repeats or smears at that range. Unwarped: the ground's 40 m UV warp
        // swirled a tile this large into marble. The scan is a red-brown boulder; under blue air it
        // read magenta, so the massif takes its luminance only.
        const rockAxis = abs(normalWorldGeometry).pow(4);
        const rockShare = rockAxis.div(rockAxis.x.add(rockAxis.y).add(rockAxis.z));
        const massifTap = (source: Texture, size: number, offset: number): Node<"vec3"> =>
          rockShare.x
            .mul(texture(source, positionWorld.zy.div(size).add(offset)).rgb)
            .add(rockShare.y.mul(texture(source, positionWorld.xz.div(size).add(offset)).rgb))
            .add(rockShare.z.mul(texture(source, positionWorld.xy.div(size).add(offset)).rgb));
        const massifRock = mix(
          massifTap(layer("rock").diffuse, 60, 0),
          massifTap(layer("rock").diffuse, 220, 0.37),
          smoothstep(-0.3, 0.3, bakedNoise(positionWorld.mul(0.0021))),
        );
        const crag = (
          look.surveyedBackdrop
            ? triplanarAlbedo(layer("rock").diffuse, "rock", 6).rgb
            : // At half its contrast the scan's boulder seams stop drawing a crack net over the faces.
              vec3(
                dot(massifRock, vec3(0.2126, 0.7152, 0.0722))
                  .sub(0.07)
                  .mul(0.5)
                  .add(0.07),
              )
                .mul(vec3(0.93, 0.99, 1.04))
                .mul(LOOK.rock)
        )
          .mul(crestBackdrop ? vec3(0.62) : vec3(0.62, 0.66, 0.67))
          .mul(strata.mul(crestBackdrop ? 0.15 : 0.35).add(1))
          .mul(crestBackdrop ? mix(0.6, 1.15, smoothstep(-0.4, 0.4, facet)) : float(1))
          // Kilometre-scale warm and cool rock, so whole faces do not read one flat grey.
          .mul(
            crestBackdrop
              ? mix(
                  vec3(0.95, 0.98, 1.03),
                  vec3(1.05, 1.02, 0.97),
                  smoothstep(-0.3, 0.3, bakedFractalNoise(positionWorld.mul(0.0025), 2)),
                )
              : vec3(1),
          );
        // Runoff and lichen stain steep rock in streaks down the fall line, metres wide and tens long.
        const streaks = smoothstep(
          -0.35,
          0.35,
          bakedFractalNoise(positionWorld.mul(vec3(0.045, 0.006, 0.045)), 3),
        );
        const talus = triplanarAlbedo(layer("rock").diffuse, "rock", 1.2).rgb;
        const rubble = (
          crestBackdrop
            ? vec3(dot(talus, vec3(0.2126, 0.7152, 0.0722))).mul(vec3(0.66, 0.67, 0.69))
            : talus.mul(vec3(0.66, 0.65, 0.62))
        ).mul(mix(0.85, 1.1, bakedNoise(positionWorld.mul(0.08)).add(0.5)));
        // A ragged treeline: spurs of forest climb 90 m higher or stop 90 m lower along the slope.
        const treeline = elevationBand(
          measured,
          measured.heightBands.treeline,
          positionWorld.y
            .add(breakUp.mul(24))
            .add(crestBackdrop ? bakedFractalNoise(positionWorld.mul(0.006), 2).mul(90) : float(0)),
        );
        // Rock from about 31 degrees. The wood's spruce stands to 36-46 degrees (its far-forest slope
        // row), so its cover holds to there: at 31 a surveyed massif's wooded flanks drew bare rock.
        const face = look.woodedGround
          ? smoothstep(0.19, 0.31, crestSteep.add(strata.mul(0.055)))
          : smoothstep(0.14, 0.3, crestSteep.add(strata.mul(0.055)));
        const bands = bedded.mul(face);
        const snowline = elevationBand(
          measured,
          measured.heightBands.cap,
          positionWorld.y.add(breakUp.mul(28)),
        );
        // Snow fields, not ledge lines (owner, 2026-11-09): full cover above the snowline on faces
        // that point up, tongues 160 m further down the gullies, broken patches 150 m under the
        // line, and none on wall rock. The facets lift or drop each field's edge, so its rim follows
        // the ribs instead of a contour.
        const gully = collar ? smoothstep(0.05, 0.4, collar.hollow).mul(reliefWeight) : float(0);
        const lying = oneMinus(
          smoothstep(0.3, 0.48, crestSteep.sub(facet.mul(0.25)).sub(gully.mul(0.1))),
        );
        const fields = elevationBand(
          measured,
          measured.heightBands.cap,
          positionWorld.y.add(breakUp.mul(28)).add(gully.mul(160)),
        ).mul(oneMinus(smoothstep(-0.25, -0.45, bakedFractalNoise(positionWorld.mul(0.006), 2))));
        const patches = smoothstep(
          measured.heightBands.cap[0] - 150,
          measured.heightBands.cap[0] - 20,
          positionWorld.y.add(breakUp.mul(28)),
        ).mul(
          smoothstep(
            0.12,
            0.3,
            bakedFractalNoise(positionWorld.mul(0.011), 2).add(gully.mul(0.35)).add(facet.mul(0.2)),
          ),
        );
        const cap = crestBackdrop
          ? fields.max(patches).mul(lying)
          : snowline.mul(oneMinus(smoothstep(0.18, 0.42, steep)));
        // The massif's snow is unwarped too: the ground's UV warp at a 96 m tile swirled it.
        const snow = crestBackdrop
          ? massifTap(layer("snow").diffuse, 60, 0.21)
          : triplanarAlbedo(layer("snow").diffuse, "snow", 8).rgb;
        // Each band is a darker wall under a paler ledge.
        const banded = crag
          .mul(mix(float(1), mix(float(1.08), float(0.8), wall), bands))
          .mul(mix(float(1), mix(float(0.78), float(1.04), streaks), face));
        const mountain = mix(
          mix(forest, mix(banded, rubble, scree), max(max(treeline, face), scree)),
          snow,
          cap,
        );
        material.colorNode = mix(
          albedo.rgb.mul(mix(vec3(1), tone, vegetation)),
          otherBiome ? albedo.rgb : mountain,
          continuation,
        )
          .mul(mix(vec3(1), vec3(0.42, 0.46, 0.42), curvature.wetBank))
          .mul(mix(vec3(1), FOREST_FLOOR, forestFloor))
          .mul(mix(vec3(1), BARE_SOIL, bareSoil));
        material.roughnessNode = mix(
          mix(
            otherBiome ? 0.94 : mix(0.88, 0.98, dryness),
            float(0.91).sub(
              smoothstep(0.48, 0.68, bakedNoise(positionWorld.mul(60)))
                .mul(oneMinus(smoothstep(3, 14, positionView.length())))
                .mul(0.5),
            ),
            snowCover,
          ),
          0.48,
          curvature.wetBank,
        );
        if (!otherBiome) {
          material.roughnessNode = mix(
            material.roughnessNode as Node<"float">,
            0.52,
            sand.mul(wetness()),
          );
          // A little albedo-coloured bounce keeps unlit rock faces legible without changing the sky rig.
          material.emissiveNode = (material.colorNode as Node<"vec3">).mul(
            weights.rock.max(continuation).mul(0.08),
          );
        }
        // Distant faces resolve broad rock strata, rather than subpixel meadow normals.
        const rockNormal = layer("rock").normal;
        // The forest's massif takes its relief from the facets alone: the rock normal map reads
        // through the ground's UV warp, which at a 30 m tile drew curled lines over every face.
        const mountainTilt = (
          rockNormal === undefined || massif
            ? vec3(0)
            : triplanarRelief(rockNormal, "rock", 8).tilt.mul(face).mul(oneMinus(cap)).mul(0.32)
        ).add(
          crestBackdrop
            ? facetTilt.mul(mix(0.35, 1, max(treeline, face))).mul(oneMinus(cap.mul(0.6)))
            : vec3(0),
        );
        // Distant alpine rock previously discarded all normal relief; snow weights stay unchanged.
        const distantTilt = look.crestRock ? mountainTilt.mul(weights.rock) : mountainTilt;
        const tilt = look.continuationTilt ? mix(normal, distantTilt, continuation) : normal;
        // Detail is tangential; it must not rotate the whole hillside towards a fixed diagonal.
        const outward = normalize(
          vec3(surveyedNormal.x, 0, surveyedNormal.z).add(vec3(0.0001, 0, 0)),
        );
        const bandTilt = vec3(0, 1, 0)
          .sub(surveyedNormal)
          .mul(ledge.mul(0.7))
          .add(outward.sub(surveyedNormal).mul(wall.mul(0.35)))
          .mul(bands);
        const detail = tilt
          .add(bandTilt)
          .sub(surveyedNormal.mul(dot(surveyedNormal, tilt.add(bandTilt))));
        // A bump cannot light a face its own slope turns from the sun: the face's relief would
        // self-shadow it. Without this the low sun lit the massif's shaded walls in soft, cloud-like
        // wisps wherever the relief tilted toward it (owner, 2026-11-09). In shade the relief still
        // turns the face to more or less sky.
        const tangent = massif
          ? detail.sub(
              SUN_VECTOR.mul(
                max(dot(detail, SUN_VECTOR), 0)
                  .mul(oneMinus(smoothstep(-0.05, 0.25, dot(surveyedNormal, SUN_VECTOR))))
                  .mul(continuation),
              ),
            )
          : detail;
        const crystals = microGrain()
          .mul(snowCover)
          .mul(oneMinus(smoothstep(4, 22, positionView.length())));
        material.normalNode = transformNormalToView(
          normalize(surveyedNormal.add(tangent).add(crystals)),
        );
        return material;
      },
    })) as MeshStandardNodeMaterial;
  } catch (error) {
    material.dispose();
    throw error;
  }
}

/**
 * The baked heightfield, its geometry, and the lit ground material once the PBR maps arrive.
 *
 * `enter` is synchronous and the physics collider is built from this very mesh, so the mesh exists
 * immediately and draws with flat vertex colours until the textures settle. A map that never loads
 * keeps that fallback rather than failing the world: the terrain still has to collide on a host
 * with no asset server.
 */
/**
 * The square around the player that streamed tiles draw (PRD-790): centre and half-width in metres.
 * The collar draws everywhere outside it, and the tiles draw only inside it and past the playable
 * square, so each point of ground is drawn once.
 */
export interface ITerrainStream {
  readonly centre: UniformNode<"vec2", Vector2>;
  readonly half: UniformNode<"float", number>;
  /** Receives the tiles' own ground material once the square's ground is in place. */
  readonly tiles: (material: MeshStandardNodeMaterial) => void;
}

export function createTerrain(
  data: IBakedWorld,
  assets?: IAssetLoader,
  biome?: IBiome,
  /** The baked `skyVisibility` per vertex; without it the ground keeps the whole sky. */
  sky?: Float32Array,
  stream?: ITerrainStream,
): { collar: HeightfieldCollar; field: Heightfield; mesh: Mesh } {
  const field = new Heightfield({
    rows: data.resolution,
    columns: data.resolution,
    width: data.size,
    depth: data.size,
    origin: { x: 0, z: 0 },
    heights: new Float32Array(data.heights),
  });
  const geometry = field.toGeometry();
  if (data.colors.length !== geometry.getAttribute("position").count * 3)
    throw new RangeError("Baked terrain colours do not match the heightfield");
  geometry.setAttribute("color", new Float32BufferAttribute(data.colors, 3));
  // Crown cover per vertex, painted from the scattered trees by `paintCanopy`; zero until then.
  geometry.setAttribute(
    "canopy",
    new Float32BufferAttribute(new Float32Array(geometry.getAttribute("position").count), 1),
  );
  // The share of the sky each vertex sees past the relief around it, for the ground's ambient term.
  const vertices = geometry.getAttribute("position").count;
  if (sky && sky.length !== vertices)
    throw new RangeError(`Baked sky visibility has ${sky.length} values for ${vertices} vertices`);
  geometry.setAttribute(
    "sky",
    new Float32BufferAttribute(sky ?? new Float32Array(vertices).fill(1), 1),
  );
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
  const mesh: Mesh = new Mesh(geometry, material);
  mesh.name = "authored-terrain";
  // The ground is under everything and its material is the frame's dearest: drawn in sort order it
  // shaded every pixel a crown or a blade then covered. After the props, the depth test rejects those
  // first (forest player pose, RTX 2080, 913x881: 13.6 ms of GPU with the ground in sort order, 8.9 ms
  // after the props). The water keeps its place after the ground at render order 2.
  mesh.renderOrder = GROUND_RENDER_ORDER;
  mesh.layers.enable(REFLECTED_LAYER);
  mesh.receiveShadow = true;
  mesh.castShadow = biome?.terrainCastsShadow ?? false;
  // The world is the biome row's: a sixth biome brings its own surveys and its own collar without
  // touching this file. Only a view with no biome (the editor) reads the water level: an authored
  // ocean takes the coastal survey, as it did before the biome rows.
  const collar = createHorizonCollar(
    data,
    biome?.world ?? (data.waterLevel !== null ? "coastal" : "forest"),
  );
  const horizonGeometry = collar.geometry;
  horizonGeometry.setAttribute("color", new Float32BufferAttribute(collarColors(collar, data), 3));
  horizonGeometry.computeVertexNormals();
  const edgePositions = horizonGeometry.getAttribute("position");
  const edgeNormals = horizonGeometry.getAttribute("normal");
  const groundNormals = geometry.getAttribute("normal");
  let horizonSeamGap = 0;
  for (let vertex = 0; vertex < (data.resolution - 1) * 4; vertex++) {
    const column = Math.round(
      (edgePositions.getX(vertex) / data.size + 0.5) * (data.resolution - 1),
    );
    const row = Math.round((edgePositions.getZ(vertex) / data.size + 0.5) * (data.resolution - 1));
    const edge = row * data.resolution + column;
    horizonSeamGap = Math.max(
      horizonSeamGap,
      Math.abs(edgePositions.getY(vertex) - (data.heights[edge] as number)),
    );
    edgeNormals.setXYZ(
      vertex,
      groundNormals.getX(edge),
      groundNormals.getY(edge),
      groundNormals.getZ(edge),
    );
  }
  // The snow and mat masks read normals: blend the collar too, rather than only its boundary
  // vertices, and reach as far past the square as those masks do.
  const collarBand = biome?.groundCollarMeters ?? 0;
  if (collarBand > 0) {
    const perimeter = (data.resolution - 1) * 4;
    const normal = new Vector3();
    const boundary = new Vector3();
    for (let vertex = perimeter; vertex < edgePositions.count; vertex++) {
      const distance =
        Math.max(Math.abs(edgePositions.getX(vertex)), Math.abs(edgePositions.getZ(vertex))) -
        data.size / 2;
      if (distance >= collarBand) break;
      normal
        .fromBufferAttribute(edgeNormals, vertex)
        .lerp(
          boundary.fromBufferAttribute(edgeNormals, vertex % perimeter),
          1 - MathUtils.smoothstep(distance, 0, collarBand),
        )
        .normalize();
      edgeNormals.setXYZ(vertex, normal.x, normal.y, normal.z);
    }
  }
  mesh.userData.horizonSeamGap = horizonSeamGap;
  mesh.userData.horizonSeamSamples = (data.resolution - 1) * 4;
  horizonGeometry.setAttribute(
    "canopy",
    new Float32BufferAttribute(new Float32Array(edgePositions.count), 1),
  );
  // The ground material reads `sky` too; the collar lies past the baked square and keeps the sky.
  horizonGeometry.setAttribute(
    "sky",
    new Float32BufferAttribute(new Float32Array(edgePositions.count).fill(1), 1),
  );
  const horizon: Mesh = new Mesh(horizonGeometry, material);
  horizon.name = "temperate-distant-ridges";
  horizon.renderOrder = GROUND_RENDER_ORDER;
  horizon.layers.enable(REFLECTED_LAYER);
  horizon.receiveShadow = true;
  // Scenery beyond the collider: no ray stands on it, and a picking tree over its 1.5M triangles
  // cost the first ground contact 1.1 s, which landed on the first rendered frame.
  horizon.raycast = () => undefined;
  mesh.add(horizon);
  geometry.addEventListener("dispose", () => horizon.geometry.dispose());

  const curvature = buildCurvature(data, field, biome);
  let disposed = false;
  geometry.addEventListener("dispose", () => {
    disposed = true;
  });
  if (assets !== undefined)
    void Promise.all([
      createGroundMaterial(data, assets, curvature, biome),
      stream ? createGroundMaterial(data, assets, curvature, biome, true) : undefined,
    ])
      .then(([ground, tile]) => {
        // Anything but the flat placeholder means the scene already moved on; a material nothing
        // draws holds GPU memory until its textures are released.
        if (disposed || mesh.material !== material) {
          tile?.dispose();
          return ground.dispose();
        }
        mesh.material = ground;
        horizon.material = ground;
        material.dispose();
        const surfaces = [ground];
        if (stream && tile) {
          // Chebyshev distance from the streamed square's centre, against its half-width.
          const fromCentre = max(
            abs(positionWorld.x.sub(stream.centre.x)),
            abs(positionWorld.z.sub(stream.centre.y)),
          );
          const far = ground.clone();
          // The collar draws under the block's edge too: the depth test picks the nearer surface there.
          far.maskNode = fromCentre.greaterThanEqual(stream.half.sub(COLLAR_UNDER_TILE));
          horizon.material = far;
          // The outermost streamed tile slides onto the collar's drawn height (PRD-790 box 2).
          tile.positionNode = collarMorph(collar, stream, STREAM_TILE);
          tile.maskNode = fromCentre
            .lessThan(stream.half)
            // The skirt each tile hangs on the square's edge draws too, under the square's cracks.
            .and(
              max(abs(positionWorld.x), abs(positionWorld.z)).greaterThan(
                data.size / 2 - TILE_INSIDE_SQUARE,
              ),
            );
          surfaces.push(far, tile);
          geometry.addEventListener("dispose", () => far.dispose());
          stream.tiles(tile);
        }
        // The ground took no image-based light, so terrain in shadow fell to near-black while every
        // plant on it read the sky. It reads the same clamped sky the vegetation does.
        if (biome === undefined || biome.lawnGround)
          void loadSkyLight(assets).then((sky) => {
            if (!sky || mesh.material !== ground || !ground.colorNode) return;
            // An envMap would be the ground's 17th sampler; the diffuse sky it carries is two colours.
            const { up, down } = skyIrradiance(sky);
            for (const surface of surfaces) {
              surface.emissiveNode = (surface.colorNode as Node<"vec3">)
                .mul(mix(vec3(...down), vec3(...up), normalWorld.y.mul(0.5).add(0.5)))
                .mul(GROUND_SKY_LIGHT);
              surface.needsUpdate = true;
            }
          });
      })
      // A map that never arrives, or a set this material cannot bind, leaves the ground on its
      // baked vertex colours. It must still collide and still draw, and the console says why.
      .catch((error) =>
        console.warn(`TN_GROUND_MAP_MISSING ${error instanceof Error ? error.message : error}`),
      );
  return { collar, field, mesh };
}

/**
 * Cook the heightfield's own curvature into a texture the ground material can read.
 *
 * A five-point Laplacian over the baked samples, evaluated once on the CPU and stored as half floats:
 * `h(-1) + h(+1) + h(-w) + h(+w) - 4h(0)`, which is positive in a hollow and negative on a rib. The
 * divisor is the sample spacing squared, so the number is in 1/m and does not change meaning when the
 * world's resolution does, and the gain is chosen so a valley a few metres deep reads near +1.
 *
 * Half float rather than byte because the range matters: a byte would quantise the sign of a
 * near-flat field into blocks, and the sign is the whole of the answer.
 *
 * One curvature binding plus six albedos, four normals and four shadow maps is fifteen.
 */
function buildCurvature(data: IBakedWorld, field: Heightfield, biome?: IBiome): IGroundCurvature {
  const resolution = data.resolution;
  const heights = data.heights;
  const spacing = data.size / (resolution - 1);
  const at = (row: number, column: number): number =>
    heights[
      Math.min(resolution - 1, Math.max(0, row)) * resolution +
        Math.min(resolution - 1, Math.max(0, column))
    ] as number;
  const lakes = (data.lakes ?? []).map((lake) => ({
    ...lake,
    reach: waterlineRadius(field, lake.at, lake.level),
  }));
  const rivers = (data.rivers ?? []).flatMap((river) => {
    const levels = surfaceHeights(field, river.points);
    return river.points.map(([x = 0, , z = 0], index) => ({
      x,
      z,
      level: levels[index] as number,
    }));
  });
  // River stations indexed at their 13 m wet margin. It is this ground shader's own number: the drawn
  // ribbon sizes itself from `WATER_RIBBON_REACH` in river.ts. A vertex tests only
  // the stations that can reach it rather than every station of every river.
  const RIVER_REACH = 13;
  const stations = createSegmentIndex(
    rivers.map((station) => ({
      a: [station.x, station.z] as const,
      b: [station.x, station.z] as const,
      reach: RIVER_REACH,
      data: station,
    })),
    RIVER_REACH,
  );
  // Both channels share one sampler: measured concavity and the water's actual wet margin.
  const transport = data.erosion;
  if (transport) {
    for (const key of ["flow", "sediment", "deposition", "talus"] as const) {
      const values = transport[key];
      if (
        !Array.isArray(values) ||
        values.length !== heights.length ||
        !values.every((value) => Number.isFinite(value) && value >= 0)
      )
        throw new RangeError(`Baked erosion '${key}' does not match the canonical heightfield`);
    }
  }
  const sortedFlow = [...(transport?.flow ?? [])].sort((a, b) => a - b);
  const medianFlow = sortedFlow[Math.floor(sortedFlow.length * 0.5)] ?? 0;
  const channelFlow = sortedFlow[Math.floor(sortedFlow.length * 0.98)] ?? 1;
  const pixels = new Uint16Array(resolution * resolution * 4);
  for (let row = 0; row < resolution; row += 1) {
    for (let column = 0; column < resolution; column += 1) {
      const laplacian =
        at(row, column - 4) +
        at(row, column + 4) +
        at(row - 4, column) +
        at(row + 4, column) -
        4 * at(row, column);
      // An eight-metre neighbourhood picks out channels and hollows, suppressing tiny baked bumps.
      const vertex = row * resolution + column;
      const index = vertex * 4;
      pixels[index] = DataUtils.toHalfFloat(
        Math.max(-1, Math.min(1, (laplacian / (spacing * spacing * 16)) * 36)),
      );
      const x = column * spacing - data.size / 2;
      const z = row * spacing - data.size / 2;
      const height = at(row, column);
      const margin = (level: number): number =>
        Math.max(0, Math.min(1, (level + 1.1 - height) / 1.1));
      let wet = 0;
      for (const lake of lakes) {
        const distance = Math.hypot(x - (lake.at[0] ?? 0), z - (lake.at[1] ?? 0));
        if (distance <= lake.reach + 3) wet = Math.max(wet, margin(lake.level));
      }
      for (const station of stations.nearby(x, z)) {
        if (Math.hypot(x - station.x, z - station.z) <= RIVER_REACH)
          wet = Math.max(wet, margin(station.level));
      }
      pixels[index + 1] = DataUtils.toHalfFloat(wet);
      pixels[index + 2] = DataUtils.toHalfFloat(
        Math.max(
          0,
          Math.min(
            1,
            ((transport?.flow[vertex] ?? 0) - medianFlow) / Math.max(1, channelFlow - medianFlow),
          ),
        ),
      );
      // Thermal deposits are actual cliff-foot transport. Hydraulic fines collect where water
      // carries a load and slows; normalise by carried load to avoid painting every rain visit.
      pixels[index + 3] = DataUtils.toHalfFloat(depositAtIndex(data, vertex));
    }
  }
  const cooked = new DataTexture(pixels, resolution, resolution, RGBAFormat, HalfFloatType);
  cooked.minFilter = LinearFilter;
  cooked.magFilter = LinearFilter;
  cooked.wrapS = ClampToEdgeWrapping;
  cooked.wrapT = ClampToEdgeWrapping;
  cooked.needsUpdate = true;
  const uv = vec2(
    positionWorld.x.div(float(data.size)).add(0.5),
    positionWorld.z.div(float(data.size)).add(0.5),
  );
  const sampled = texture(cooked, uv);
  // A clamped wet boundary texel must not become a stripe across the continuation mesh.
  const outside = max(abs(positionWorld.x), abs(positionWorld.z));
  const collar = biome?.groundCollarMeters ?? 0;
  const resident = oneMinus(
    smoothstep(data.size / 2 - Math.max(collar, spacing * 2), data.size / 2 + collar, outside),
  );
  return {
    node: sampled.r,
    texture: cooked,
    wetBank: sampled.g.mul(resident),
    flow: sampled.b.mul(resident),
    deposits: sampled.a.mul(resident),
  };
}

/** The collar's own relief at the survey's 9.8 m cells, for the pixels its prefiltered mesh smooths. */
export interface ICollarRelief {
  readonly texture: DataTexture;
  /** World normal of the unfiltered surroundings. */
  readonly normal: Node<"vec3">;
  /** +1 in a gully or hollow, -1 on a rib. */
  readonly hollow: Node<"float">;
  /** 1 on talus at the foot of a cliff band. */
  readonly scree: Node<"float">;
}

/**
 * Per-pixel relief for the collar, as UE shades a landscape from its normal map rather than the LOD
 * mesh (UE 5.8.3: Engine/Shaders/Private/LandscapeVertexFactory.ush:391-401). Past about 300 m the
 * collar draws a prefiltered field on a 14-18 m ring grid, so its cliffs, gullies and ledges exist
 * only in this texture. Half float like the curvature: the normal lanes are signed.
 */
export function buildCollarRelief(name: string): ICollarRelief | undefined {
  const source = horizonSurroundings(name);
  if (source === undefined) return undefined;
  const n = source.resolution;
  const massif = source.massif && decodeMassif(source.massif);
  // One atlas, one binding (the ground already samples sixteen): the collar's cells on the left,
  // a placed massif's own 4 m cells on the right, each read through its own clamped UV.
  const width = n + (massif?.columns ?? 0);
  const height = Math.max(n, massif?.rows ?? 0);
  const pixels = new Uint16Array(width * height * 4);
  writeRelief(pixels, width, 0, n, n, source.size / (n - 1), source.heights);
  if (massif)
    writeRelief(pixels, width, n, massif.columns, massif.rows, massif.spacing, massif.heights);
  const cooked = new DataTexture(pixels, width, height, RGBAFormat, HalfFloatType);
  cooked.minFilter = LinearFilter;
  cooked.magFilter = LinearFilter;
  cooked.wrapS = ClampToEdgeWrapping;
  cooked.wrapT = ClampToEdgeWrapping;
  cooked.needsUpdate = true;
  // Grid points sit on texel centres: column c of the collar is at (c + 0.5) / width.
  const collarUv = vec2(positionWorld.x, positionWorld.z)
    .div(source.size)
    .add(0.5)
    .mul(n - 1)
    .clamp(0, n - 1)
    .add(0.5)
    .div(vec2(width, height));
  let sampled: Node<"vec4"> = texture(cooked, collarUv);
  if (massif) {
    const cell = vec2(positionWorld.x, positionWorld.z)
      .sub(vec2(massif.origin[0], massif.origin[1]))
      .div(massif.spacing);
    const last = vec2(massif.columns - 1, massif.rows - 1);
    const inner = min(min(cell.x, cell.y), min(last.x.sub(cell.x), last.y.sub(cell.y)));
    const fine = texture(
      cooked,
      cell
        .clamp(vec2(0, 0), last)
        .add(vec2(n + 0.5, 0.5))
        .div(vec2(width, height)),
    );
    sampled = mix(sampled, fine, smoothstep(0, 3, inner));
  }
  return {
    texture: cooked,
    normal: vec3(
      sampled.r,
      float(1).sub(sampled.r.mul(sampled.r)).sub(sampled.g.mul(sampled.g)).max(0).sqrt(),
      sampled.g,
    ),
    hollow: sampled.b,
    scree: sampled.a,
  };
}

/** A massif's heights from `horizon.json`: int16 decimetres above `offset`, base64. */
function decodeMassif(packed: IPackedMassif) {
  const bytes = Uint8Array.from(atob(packed.heights), (c) => c.charCodeAt(0));
  const raw = new Int16Array(bytes.buffer, 0, packed.columns * packed.rows);
  return { ...packed, heights: Float32Array.from(raw, (dm) => packed.offset + dm / 10) };
}

/**
 * Normal, hollow and talus texels for a `columns` x `rows` height grid at `cell` metres, written
 * into the atlas from column `x0`. The talus and hollow reach are in metres, so a 4 m grid reads
 * the same landforms as the 9.8 m collar, only sharper.
 */
function writeRelief(
  pixels: Uint16Array,
  width: number,
  x0: number,
  columns: number,
  rows: number,
  cell: number,
  heights: ArrayLike<number>,
): void {
  const at = (row: number, column: number): number =>
    heights[
      Math.min(rows - 1, Math.max(0, row)) * columns + Math.min(columns - 1, Math.max(0, column))
    ] as number;
  const slopes = new Float32Array(columns * rows);
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++)
      slopes[row * columns + column] = Math.atan(
        Math.hypot(
          (at(row, column + 1) - at(row, column - 1)) / (2 * cell),
          (at(row + 1, column) - at(row - 1, column)) / (2 * cell),
        ),
      );
  const slopeAt = (row: number, column: number): number =>
    slopes[
      Math.min(rows - 1, Math.max(0, row)) * columns + Math.min(columns - 1, Math.max(0, column))
    ] as number;
  const degrees = Math.PI / 180;
  const band = (edge0: number, edge1: number, value: number): number => {
    const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
  };
  // The 9.8 m collar measured a hollow across 2 cells and talus within 3 cells; keep those metres.
  const span = Math.max(2, Math.round(19.6 / cell));
  const step = Math.max(1, Math.round(9.8 / cell));
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++) {
      const height = at(row, column);
      const dx = (at(row, column + 1) - at(row, column - 1)) / (2 * cell);
      const dz = (at(row + 1, column) - at(row - 1, column)) / (2 * cell);
      const length = Math.hypot(dx, 1, dz);
      // A gully 5 m deep across 20 m reads near +1.
      const laplacian =
        (at(row, column - span) +
          at(row, column + span) +
          at(row - span, column) +
          at(row + span, column) -
          4 * height) /
        (span * cell) ** 2;
      // Talus lies at 25-40 degrees under a face steeper than about 45 degrees within 30 m uphill.
      let cliffAbove = 0;
      for (let dr = -3; dr <= 3; dr++)
        for (let dc = -3; dc <= 3; dc++)
          if (at(row + dr * step, column + dc * step) > height + 8)
            cliffAbove = Math.max(
              cliffAbove,
              band(42 * degrees, 50 * degrees, slopeAt(row + dr * step, column + dc * step)),
            );
      const slope = slopes[row * columns + column] as number;
      const talus =
        band(22 * degrees, 28 * degrees, slope) * (1 - band(38 * degrees, 44 * degrees, slope));
      const texel = (row * width + x0 + column) * 4;
      pixels[texel] = DataUtils.toHalfFloat(-dx / length);
      pixels[texel + 1] = DataUtils.toHalfFloat(-dz / length);
      pixels[texel + 2] = DataUtils.toHalfFloat(Math.max(-1, Math.min(1, laplacian * 20)));
      pixels[texel + 3] = DataUtils.toHalfFloat(talus * cliffAbove);
    }
}

async function get(
  assets: IAssetLoader,
  path: string,
  data: boolean,
): Promise<Texture | undefined> {
  // A clone without the licensed `local-assets/` draws the baked vertex colours; the warning names
  // the file, so a white ground on a machine that should have the art is one console line away.
  return assets.texture(path, { anisotropy: 8, data, wrap: RepeatWrapping }).catch((error) => {
    console.warn(
      `TN_GROUND_MAP_MISSING ${path}: ${error instanceof Error ? error.message : error}`,
    );
    return undefined;
  });
}
