import type { IAssetLoader } from "@threenative/core";
import { Heightfield } from "@threenative/core/world";
import { createSegmentIndex } from "@threenative/terrain";
import {
  type BufferGeometry,
  ClampToEdgeWrapping,
  DataTexture,
  DataUtils,
  Float32BufferAttribute,
  HalfFloatType,
  LinearFilter,
  Mesh,
  MeshStandardMaterial,
  RGBAFormat,
  RepeatWrapping,
  type Texture,
} from "three";
import {
  abs,
  attribute,
  clamp,
  dot,
  float,
  max,
  mix,
  mx_fractal_noise_float,
  mx_noise_float,
  normalWorld,
  normalWorldGeometry,
  normalize,
  oneMinus,
  positionView,
  positionWorld,
  rotateUV,
  sign,
  sin,
  smoothstep,
  texture,
  transformNormalToView,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import type { Node } from "three/webgpu";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { GROUND_MAPS, GROUND_TILE, type LayerKey, ROCKFACE_MAPS } from "../world/terrainAssets.js";
import { alpineRockColor, alpineRockTap, desertRockColor } from "./biomes.js";
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
import { BIOMES, type IBiome, biomeWeights } from "./biomes.js";
import { createHorizonGeometry } from "./horizon.js";
import { loadSkyLight, skyIrradiance } from "./pack.js";
import {
  type IBakedLake,
  type IBakedRiver,
  REFLECTED_LAYER,
  surfaceHeights,
  waterlineRadius,
} from "./river.js";

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

/** The layers that cover ground, ordered so the heavier surface blends over the base one. */
const LAYERS: readonly LayerKey[] = ["dirt", "moss", "sand", "rock", "snow"];

interface ILayerMaps {
  diffuse: Texture;
  normal?: Texture;
}

/** Where the snow line sits, in metres, and the slope above which it cannot settle. */
const SNOW = { from: 145, to: 195, sheds: 0.22 };

/**
 * The beach band, in metres above the bake's own sea level.
 *
 * Wide, because this coast rises a few degrees: a 3 m band is a 30 m walk of beach here and stops
 * halfway up it. The bake paints sand below 6 m for the same reason.
 */
const SHORE = { beach: 7.5, wet: 1 };

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
/** How much of the vegetation's sky light the ground receives; the vegetation's own is 1.13. */
const GROUND_SKY_LIGHT = 0.6;
/** Multiplier that turns meadow turf into shaded needle litter under a stand. */
const FOREST_FLOOR = vec3(0.44, 0.38, 0.3);

/** Continuous stochastic warp: no hard cell boundaries in colour or normals. */
export function tiledUV(
  key: LayerKey,
  scale = 1,
  plane: Node<"vec2"> = positionWorld.xz,
): Node<"vec2"> {
  const base = plane.div(GROUND_TILE[key] * scale);
  const warp = vec2(
    mx_noise_float(positionWorld.mul(0.025)),
    mx_noise_float(positionWorld.mul(0.025).add(vec3(17, 0, 29))),
  );
  return rotateUV(base, float(scale === 1 ? 0.38 : -0.73), vec2(0)).add(warp.mul(0.35));
}

/** Shared floor sampling: two rotated scales, with continuous world-space blend weights. */
export function groundLayer(
  source: Texture,
  key: LayerKey,
  plane = positionWorld.xz,
): Node<"vec4"> {
  const patch = smoothstep(-0.35, 0.35, mx_noise_float(positionWorld.mul(0.025)));
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
): Node<"vec3"> {
  const distance = positionView.length();
  const broad = mx_fractal_noise_float(vec3(positionWorld.x, 0, positionWorld.z).mul(0.006), 2);
  const dry = smoothstep(-0.45, 0.45, broad.sub(hollow.mul(0.06)));
  const tufts = mx_noise_float(positionWorld.mul(0.75))
    .mul(0.22)
    .mul(oneMinus(smoothstep(45, 140, distance)))
    .add(1);
  const temperate = !biome || biome.world === "forest" || biome.world === "coastal";
  if (!temperate) {
    const tint = vec3(...biome.grassTint);
    if (biome.world !== "alpine") return sampled.mul(tint);
    const cover = vec3(0.075, 0.12, 0.028).mul(mix(0.91, 1.08, dry));
    return mix(sampled.mul(tint), cover, smoothstep(65, 180, distance).mul(0.85));
  }
  const field = mix(vec3(0.042, 0.072, 0.018), vec3(0.062, 0.102, 0.029), dry)
    .mul(tufts)
    .mul(mix(0.92, 1.08, smoothstep(0.6, -0.6, hollow)));
  return mix(sampled.mul(MEADOW), field, smoothstep(60, 220, distance).mul(0.55));
}

function rockLayer(
  source: Texture,
  plane: Node<"vec2">,
  biome?: IBiome,
  relief = false,
): Node<"vec4"> {
  const patch = smoothstep(-0.35, 0.35, mx_noise_float(positionWorld.mul(0.025)));
  const tap = (scale: number, angle: number, offset: Node<"vec2">) => {
    const sampled = texture(source, rotateUV(plane.div(scale), float(angle), vec2(0)).add(offset));
    if (!relief) return sampled;
    const tangent = rotateUV(sampled.xy.mul(2).sub(1), float(-angle), vec2(0));
    return vec4(tangent, sampled.z.mul(2).sub(1), 1);
  };
  return biome?.world === "alpine"
    ? alpineRockTap(source, plane, relief)
    : biome?.world === "desert"
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
  const other = biome && biome.world !== "forest" && biome.world !== "coastal";
  const tap = (plane: Node<"vec2">) =>
    other ? rockLayer(source, plane, biome).rgb : texture(source, tiledUV("rock", 1, plane)).rgb;
  return share.x
    .mul(tap(positionWorld.zy))
    .add(share.y.mul(tap(positionWorld.xz)))
    .add(share.z.mul(tap(positionWorld.xy)));
}

export function stoneColor(sampled: Node<"vec3">, biome?: IBiome): Node<"vec3"> {
  if (biome?.world === "alpine") return alpineRockColor(sampled);
  if (biome?.world === "desert") return desertRockColor(sampled);
  const other = biome && biome.world !== "forest" && biome.world !== "coastal";
  const grey = dot(sampled, vec3(0.2126, 0.7152, 0.0722));
  return mix(sampled, vec3(grey), other ? 0.25 : 0.35).mul(
    vec3(...(other ? biome.stoneTint : [0.44, 0.46, 0.42])),
  );
}

export function stoneRelief(
  source: Texture,
  biome?: IBiome,
  normal = normalWorldGeometry,
): Node<"vec3"> {
  if (!biome || biome.world === "forest" || biome.world === "coastal")
    return triplanarRelief(source, "rock", 1, normal).tilt;
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
  const wobble = mx_noise_float(positionWorld.mul(0.09)).mul(RIPPLE.wander);
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
  const field = (p: Node<"vec3">) => mx_fractal_noise_float(p.mul(2.6), 2, 2, 0.5);
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
export function createGroundMaterial(
  data: IBakedWorld,
  maps: Partial<Record<LayerKey, ILayerMaps>>,
  curvature: IGroundCurvature,
  biome?: IBiome,
): MeshStandardNodeMaterial {
  const material = new MeshStandardNodeMaterial({ metalness: 0, roughness: 0.94 });
  material.userData.biome = biome?.world ?? "forest";
  material.userData.erosion = data.erosion !== undefined;
  const held = new Set<Texture>([curvature.texture]);
  const layer = (key: LayerKey): ILayerMaps => {
    const found = maps[key];
    if (!found?.diffuse) throw new RangeError(`Ground layer '${key}' has no diffuse texture`);
    return found;
  };

  const otherBiome = biome !== undefined && biome.world !== "forest" && biome.world !== "coastal";
  const macro = mx_fractal_noise_float(vec3(positionWorld.x, 0, positionWorld.z).mul(0.014), 3);
  const mottling = mx_noise_float(vec3(positionWorld.x, 0, positionWorld.z).mul(0.045));

  // --- where each surface sits -------------------------------------------------------------
  const slope = normalWorldGeometry.y.abs().oneMinus();
  const breakUp = mx_fractal_noise_float(positionWorld.mul(0.05), 3);
  const steep = clamp(slope.add(breakUp.mul(0.05)), 0, 1);
  // +1 in a hollow, -1 on a rib. The two ends of the ground's own shape, which slope cannot tell
  // apart: a gully and a nose are both steep, and they are not the same surface.
  const outside = max(abs(positionWorld.x), abs(positionWorld.z));
  const hollow = curvature.node.mul(
    oneMinus(smoothstep(data.size / 2, data.size / 2 + 28, outside)),
  );
  // Material placement follows the actual landform, never the bake's brown blob palette.
  const drainage = smoothstep(0.12, 0.65, curvature.flow);
  const deposits = smoothstep(0.08, 0.6, curvature.deposits);
  const scour = drainage.mul(smoothstep(0.035, 0.18, slope));
  // The material's transport terms read the erosion bake through the curvature texture.
  const flow = curvature.flow;
  const sediment = deposits;
  const rib = smoothstep(-0.02, -0.45, hollow);
  const alpine = smoothstep(38, 66, positionWorld.y.add(breakUp.mul(5)));
  // No recorded sea level means an inland world, and an inland world has no beach.
  const sand =
    data.waterLevel === null
      ? float(0)
      : smoothstep(float(SHORE.beach), float(SHORE.wet), positionWorld.y).mul(
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
    const wander = mx_fractal_noise_float(positionWorld.mul(0.06), 3).mul(0.55).add(0.5);
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
      .mul(mix(0.65, 1, smoothstep(12, 70, positionWorld.y)))
      .mul(oneMinus(smoothstep(0.15, 0.8, hollow).mul(0.25))),
    snow: smoothstep(float(SNOW.from), float(SNOW.to), positionWorld.y).mul(
      smoothstep(SNOW.sheds, 0.06, steep),
    ),
  };

  if (biome) Object.assign(weights, biomeWeights(biome, steep, hollow, breakUp));
  // Needle litter and crown shade under the placed stands, as a multiplicative floor tint.
  let forestFloor: Node<"float"> = float(0);
  // Transport, slope and shelter choose the splat; noise only frays the material's edge.
  weights.rock = max(weights.rock, scour.mul(0.9)).mul(oneMinus(deposits.mul(0.22)));
  if (biome?.world === "alpine") weights.rock = max(weights.rock, smoothstep(0.08, 0.22, slope));
  weights.dirt = max(weights.dirt.mul(0.45), deposits.mul(0.85))
    .mul(oneMinus(smoothstep(0.22, 0.4, slope)))
    .mul(sand.oneMinus());
  if (biome?.world === "tundra") {
    weights.moss = hollow
      .max(0)
      .mul(oneMinus(drainage))
      .mul(smoothstep(0.12, 0.025, slope))
      .mul(oneMinus(weights.snow))
      .mul(0.7);
  }
  if (!otherBiome) {
    // Ordinary forest hills carry turf; reserve exposed soil for drainage banks.
    if (biome?.world === "forest" || biome === undefined)
      weights.dirt = drainage.mul(0.18).max(sediment.mul(0.5)).mul(sand.oneMinus());
    if (biome?.world === "forest" || biome === undefined) {
      // Needle litter lies under the trees that were actually placed (`paintCanopy`), frayed by noise
      // at its edge. The old sine-sum stand mask no longer matched the value-noise scatter, and its
      // 38 m fade left every stand standing on meadow turf from any height.
      const litter = smoothstep(0, 0.6, attribute<"float">("canopy", "float"))
        .mul(mix(0.72, 1, smoothstep(-0.5, 0.5, mx_noise_float(positionWorld.mul(2.2)))))
        .mul(oneMinus(smoothstep(300, 600, positionView.length())))
        .mul(0.85);
      weights.dirt = weights.dirt.max(litter.mul(0.25));
      forestFloor = litter;
    }
    // Coastal soil patches remain; the forest meadow keeps turf between distant blade clusters.
    if (biome?.world === "coastal") {
      const dry = smoothstep(0.14, 0.42, macro.add(mottling.mul(0.85)).sub(hollow.mul(0.12)));
      weights.dirt = max(weights.dirt, dry.mul(0.7)).mul(sand.oneMinus());
    }
    weights.moss = hollow
      .max(0)
      .mul(oneMinus(drainage))
      .mul(smoothstep(0.15, 0.025, slope))
      .mul(0.5);
  }

  // --- how each surface looks -------------------------------------------------------------
  // Apply observed deposition after biome placement so dry/snow-world rules cannot erase it.
  weights.dirt = weights.dirt.max(sediment.mul(0.5)).max(flow.mul(0.28)).mul(sand.oneMinus());
  // The layers that cover most of a meadow take a second, larger scale faded in with distance: one
  // tile under the player's feet, a coarser one near the horizon, and no single lattice for the eye
  // to find anywhere between.
  const far = smoothstep(float(10), float(70), positionView.length());
  const patch = smoothstep(-0.35, 0.35, mx_noise_float(positionWorld.mul(0.025)));
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
    held.add(diffuse);
    const flat = groundLayer(diffuse, key);
    if (biome?.world === "tundra" && (key === "grass" || key === "dirt" || key === "moss")) {
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
      const weathering = mx_fractal_noise_float(positionWorld.mul(vec3(0.005, 0.011, 0.005)), 2)
        .mul(0.18)
        .add(1);
      const large = triplanarAlbedo(diffuse, key, 16).rgb;
      const massif =
        biome?.world === "alpine"
          ? alpineRockColor(large)
          : biome?.world === "desert"
            ? desertRockColor(large)
            : large.mul(vec3(...(otherBiome ? biome.stoneTint : [0.44, 0.46, 0.42])));
      const distant = mix(
        vec3(...(otherBiome ? biome.distantStone : [0.16, 0.17, 0.155])),
        massif,
        0.65,
      ).mul(weathering);
      return vec4(
        mix(
          stone,
          distant,
          smoothstep(35, 220, positionView.length()).mul(
            biome?.world === "alpine" ? 0.28 : otherBiome ? 0.32 : 0.65,
          ),
        ),
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
              .sub(mx_noise_float(positionWorld.mul(0.05)).mul(0.5))
              .abs(),
          ),
        ).mul(smoothstep(-0.1, 0.15, mx_noise_float(positionWorld.mul(0.65))));
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
    held.add(source);
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

  const grassRelief = reliefOf("grass", 0.38);
  let albedo: Node<"vec4"> = vec4(groundTurf(albedoOf("grass").rgb, biome, hollow), 1);
  // Three scales of relief on the meadow, not two: a metre of detail normal under the player's feet,
  // the tile's own scale at reading distance, and a decimetre of grain so the ground nearest the eye
  // is not smooth between the blades. The finest is a noise field rather than a texture, because a
  // third sampler on the grass layer is a third of the budget for detail nobody can name.
  let normal = grassRelief.tilt
    .mul(weights.grass)
    .mul(biome?.world === "alpine" ? mix(1, 0.05, smoothstep(45, 130, positionView.length())) : 1)
    .add(microGrain().mul(oneMinus(smoothstep(12, 60, positionView.length()))));
  if (biome?.world === "desert")
    normal = normal.add(sandRipples(vec2(0.53, 0.85)).mul(weights.grass));
  // The crevice term follows the surface the eye is actually looking at, so it is blended by the
  // same weights as the colour rather than applied to every layer at once.
  let snowCover: Node<"float"> = float(0);
  for (const key of LAYERS) {
    const weight = weights[key];
    // A surface takes the ground over once it *is* most of the ground. Blending every layer by a
    // share of the running total instead leaves a beach a third sand, a third grass and a third
    // dirt, which is mud with a texture on it.
    const surface = albedoOf(key);
    const relief = reliefOf(key, key === "rock" ? 0.52 : key === "snow" ? 0.18 : 0.32);
    // No displacement maps in these starter sets: normal relief breaks the blend edge,
    // while slope, elevation and curvature determine which surface belongs here.
    const reliefHeight = relief.crevice.sub(0.8).mul(0.12).add(breakUp.mul(0.045));
    // The photograph's relief and metre-scale breakup cut pockets into the soil/rock boundary.
    const rockHeight = dot(surface.rgb, vec3(0.2126, 0.7152, 0.0722))
      .sub(0.1)
      .mul(0.7)
      .add(mx_noise_float(positionWorld.mul(0.65)).mul(0.16));
    const over =
      key === "snow" && otherBiome
        ? weight.mul(float(1).add(breakUp.mul(0.025))).clamp(0, 1)
        : key === "rock"
          ? smoothstep(0.34, 0.51, weight.add(rockHeight))
          : smoothstep(0.12, 0.82, weight.add(reliefHeight));
    if (key === "snow") snowCover = over;
    albedo = mix(albedo, surface, over);
    normal = mix(normal, relief.tilt, over);
  }
  // Concavity occludes sky bounce, leaving direct sunlight physically separate.
  material.aoNode = mix(float(1), float(0.88), smoothstep(0.2, 0.85, hollow));

  // 50–200 metre vegetation tones survive texture mipmapping in the overview.
  const dryness = otherBiome
    ? smoothstep(
        -0.18,
        0.22,
        mx_fractal_noise_float(positionWorld.mul(0.006), 3)
          .sub(hollow.mul(0.16))
          .add(alpine.mul(0.06)),
      )
    : max(deposits.mul(0.7), drainage.mul(smoothstep(0.015, 0.12, slope)).mul(0.4));
  const tone = otherBiome
    ? mix(vec3(0.92, 0.94, 0.91), vec3(1.08, 1.03, 0.95), dryness)
    : mix(vec3(0.9, 0.95, 0.84), vec3(1.03, 1.04, 0.95), dryness);
  const vegetation = oneMinus(max(max(weights.rock, weights.snow), weights.sand));
  const continuation = smoothstep(data.size / 2 + 60, data.size / 2 + 280, outside);
  const strata = mx_fractal_noise_float(positionWorld.mul(vec3(0.018, 0.035, 0.018)), 3);
  // Reuse the resident maps at massif scale: steep faces project onto their own axes.
  const forest = triplanarAlbedo(layer("grass").diffuse, "grass", 12)
    .rgb.mul(MEADOW)
    .mul(mix(0.5, 0.85, breakUp.add(0.5)));
  const crag = (
    biome?.world === "coastal"
      ? triplanarAlbedo(layer("rock").diffuse, "rock", 6)
      : mix(
          triplanarAlbedo(layer("rock").diffuse, "rock", 2.6),
          triplanarAlbedo(layer("rock").diffuse, "rock", 14),
          patch.mul(0.25).add(0.15),
        )
  ).rgb
    .mul(vec3(0.62, 0.66, 0.67))
    .mul(strata.mul(0.35).add(1));
  const treeline = smoothstep(110, 240, positionWorld.y.add(breakUp.mul(24)));
  const face = smoothstep(0.14, 0.3, steep.add(strata.mul(0.055)));
  const cap = smoothstep(225, 310, positionWorld.y.add(breakUp.mul(28))).mul(
    oneMinus(smoothstep(0.18, 0.42, steep)),
  );
  const snow = triplanarAlbedo(layer("snow").diffuse, "snow", 8).rgb;
  const mountain = mix(mix(forest, crag, max(treeline, face)), snow, cap);
  material.colorNode = mix(
    albedo.rgb.mul(mix(vec3(1), tone, vegetation)),
    otherBiome ? albedo.rgb : mountain,
    continuation,
  )
    .mul(mix(vec3(1), vec3(0.42, 0.46, 0.42), curvature.wetBank))
    .mul(mix(vec3(1), FOREST_FLOOR, forestFloor));
  material.roughnessNode = mix(
    mix(
      otherBiome ? 0.94 : mix(0.88, 0.98, dryness),
      float(0.91).sub(
        smoothstep(0.48, 0.68, mx_noise_float(positionWorld.mul(60)))
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
  const mountainTilt =
    rockNormal === undefined
      ? vec3(0)
      : triplanarRelief(rockNormal, "rock", 8).tilt.mul(face).mul(oneMinus(cap)).mul(0.32);
  // Distant alpine rock previously discarded all normal relief; snow weights stay unchanged.
  const distantTilt = biome?.world === "alpine" ? mountainTilt.mul(weights.rock) : mountainTilt;
  const tilt = biome?.world === "tundra" ? normal : mix(normal, distantTilt, continuation);
  // Detail is tangential; it must not rotate the whole hillside towards a fixed diagonal.
  const tangent = tilt.sub(normalWorldGeometry.mul(dot(normalWorldGeometry, tilt)));
  const crystals = microGrain()
    .mul(snowCover)
    .mul(oneMinus(smoothstep(4, 22, positionView.length())));
  material.normalNode = transformNormalToView(
    normalize(normalWorldGeometry.add(tangent).add(crystals)),
  );
  material.addEventListener("dispose", () => {
    for (const source of held) source.dispose();
  });
  return material;
}

/**
 * The baked heightfield, its geometry, and the lit ground material once the PBR maps arrive.
 *
 * `enter` is synchronous and the physics collider is built from this very mesh, so the mesh exists
 * immediately and draws with flat vertex colours until the textures settle. A map that never loads
 * keeps that fallback rather than failing the world: the terrain still has to collide on a host
 * with no asset server.
 */
export function createTerrain(
  data: IBakedWorld,
  assets?: IAssetLoader,
  biome?: IBiome,
): { field: Heightfield; mesh: Mesh } {
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
  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
  const mesh: Mesh = new Mesh(geometry, material);
  mesh.name = "authored-terrain";
  mesh.layers.enable(REFLECTED_LAYER);
  mesh.receiveShadow = true;
  mesh.castShadow =
    biome?.world === "alpine" || biome?.world === "desert" || biome?.world === "tundra";
  const horizonGeometry = createHorizonGeometry(data, biome?.horizon, field);
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
  mesh.userData.horizonSeamGap = horizonSeamGap;
  mesh.userData.horizonSeamSamples = (data.resolution - 1) * 4;
  horizonGeometry.setAttribute(
    "canopy",
    new Float32BufferAttribute(new Float32Array(edgePositions.count), 1),
  );
  const horizon: Mesh = new Mesh(horizonGeometry, material);
  horizon.name = "temperate-distant-ridges";
  horizon.layers.enable(REFLECTED_LAYER);
  horizon.receiveShadow = true;
  mesh.add(horizon);
  geometry.addEventListener("dispose", () => horizon.geometry.dispose());

  const curvature = buildCurvature(data, field);
  if (assets !== undefined)
    void loadGroundMaps(
      assets,
      biome?.world === "forest" || biome?.world === "coastal" || biome === undefined
        ? { ...(biome?.maps ?? GROUND_MAPS), rock: ROCKFACE_MAPS, dirt: BIOMES.alpine.maps.dirt }
        : biome.maps,
    )
      .then((maps) => createGroundMaterial(data, maps, curvature, biome))
      .then((ground) => {
        // Anything but the flat placeholder means the scene already moved on; a material nothing
        // draws holds GPU memory until its textures are released.
        if (mesh.material !== material) return ground.dispose();
        mesh.material = ground;
        horizon.material = ground;
        material.dispose();
        // The ground took no image-based light, so terrain in shadow fell to near-black while every
        // plant on it read the sky. It reads the same clamped sky the vegetation does.
        if (biome === undefined || biome.world === "forest" || biome.world === "coastal")
          void loadSkyLight(assets).then((sky) => {
            if (!sky || mesh.material !== ground || !ground.colorNode) return;
            // An envMap would be the ground's 17th sampler; the diffuse sky it carries is two colours.
            const { up, down } = skyIrradiance(sky);
            ground.emissiveNode = (ground.colorNode as Node<"vec3">)
              .mul(mix(vec3(...down), vec3(...up), normalWorld.y.mul(0.5).add(0.5)))
              .mul(GROUND_SKY_LIGHT);
            ground.needsUpdate = true;
          });
      })
      // A map that never arrives, or a set this material cannot bind, leaves the ground on its
      // baked vertex colours. It must still collide and still draw.
      .catch(() => undefined);
  return { field, mesh };
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
function buildCurvature(data: IBakedWorld, field: Heightfield): IGroundCurvature {
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
  // River stations indexed at their 13 m wet reach (`@threenative/terrain`), so a vertex tests only
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
  const resident = oneMinus(smoothstep(data.size / 2 - spacing * 2, data.size / 2, outside));
  return {
    node: sampled.r,
    texture: cooked,
    wetBank: sampled.g.mul(resident),
    flow: sampled.b.mul(resident),
    deposits: sampled.a.mul(resident),
  };
}

/**
 * Every starter map the ground binds, keyed by layer.
 *
 * Albedo is colour data and everything else is linear, so the loader is told which is each: a
 * normal map read as sRGB bends its own channels and the ground loses the relief it was cooked with.
 */
async function loadGroundMaps(
  assets: IAssetLoader,
  pathsByLayer = GROUND_MAPS,
): Promise<Partial<Record<LayerKey, ILayerMaps>>> {
  const layers = await Promise.all(
    Object.entries(pathsByLayer).map(async ([key, paths]) => {
      // A layer without its albedo has no place in the blend, so the set comes back without it.
      let diffuse = await get(assets, paths.diffuse, false);
      let chosen = paths;
      if (diffuse === undefined && paths.diffuse.startsWith("temperate/")) {
        chosen = GROUND_MAPS[key as LayerKey];
        diffuse = await get(assets, chosen.diffuse, false);
      }
      if (diffuse === undefined) return undefined;
      const maps: ILayerMaps = { diffuse };
      for (const [slot, path] of Object.entries(chosen)) {
        if (slot === "diffuse") continue;
        const found = await get(assets, path, true);
        if (found !== undefined) maps[slot as "normal"] = found;
      }
      return [key, maps] as const;
    }),
  );
  return Object.fromEntries(layers.filter((entry) => entry !== undefined));
}

async function get(
  assets: IAssetLoader,
  path: string,
  data: boolean,
): Promise<Texture | undefined> {
  return assets.texture(path, { anisotropy: 8, data, wrap: RepeatWrapping }).catch(() => undefined);
}
