import {
  type IAssetLoader,
  baseGeometryOf,
  lodChainOf,
  normaliseToMetres,
  thinCards,
} from "@threenative/core";
/** Game-owned Fab art. Optional, local-only; missing species keep their procedural fallback. */
import {
  type IMeshSection,
  bakedNoise,
  instanceRandom,
  meshSections,
  repairZeroNormals,
  sectionGeometry,
} from "@threenative/core/world";
import {
  Box3,
  BufferAttribute,
  type BufferGeometry,
  DataUtils,
  DoubleSide,
  EquirectangularReflectionMapping,
  FrontSide,
  type Group,
  type Material,
  type Mesh,
  type MeshStandardMaterial,
  RepeatWrapping,
  type Texture,
  Vector3,
} from "three";
import { HDRLoader } from "three/addons/loaders/HDRLoader.js";
import {
  attribute,
  cameraProjectionMatrix,
  cameraViewMatrix,
  dFdx,
  dFdy,
  dot,
  float,
  length,
  log2,
  max,
  mix,
  normalMap,
  normalViewGeometry,
  normalWorldGeometry,
  positionGeometry,
  positionLocal,
  positionView,
  positionWorld,
  sin,
  smoothstep,
  texture,
  time,
  uniform,
  uv,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { MeshPhysicalNodeMaterial, type Node } from "three/webgpu";
import { GROUND_MAPS, ROCKFACE_MAPS, WORLD_ROCKS } from "../world/terrainAssets.js";
import { biomeSpec } from "./biomeData.js";
import {
  BIOMES,
  type IBiome,
  type IWorldBiome,
  type WorldName,
  alpineRockAlbedo,
  alpineRockColor,
  alpineSnowCover,
  biomeWeights,
  desertRockColor,
  measureBiome,
} from "./biomes.js";
import {
  type IPropGround,
  createRockGround,
  lightNeedles,
  skyEnvironment,
} from "./propMaterials.js";
import type { IPropPart, PropRole } from "./props.js";

export interface IPackSpecies {
  readonly asset: string;
  readonly variant: number;
  readonly path: string;
  readonly metres: number;
  readonly level?: number;
}
/** Independent same-asset probes; omitted fields keep the current forest appearance. */
export interface ICanopyComparison {
  /** Forest crown normals; other worlds already retain their imported geometry normals. */
  readonly normals?: "radial" | "authored";
  readonly specular?: "disabled" | "standard";
}
/** Fail closed so a labelled comparison cannot silently capture the current appearance. */
export function canopyComparison(
  normals: string | null,
  specular: string | null,
): ICanopyComparison {
  if (normals !== null && normals !== "radial" && normals !== "authored")
    throw new Error(`Unsupported canopyNormals '${normals}'`);
  if (specular !== null && specular !== "disabled" && specular !== "standard")
    throw new Error(`Unsupported canopySpecular '${specular}'`);
  return { normals: normals ?? "authored", specular: specular ?? "disabled" };
}
const species: IPackSpecies[] = [];
for (let i = 0; i < 5; i++) {
  species.push({
    asset: "spruce",
    variant: i,
    path: `spruce/${i}`,
    metres: [12, 14, 13, 10, 11][i] ?? 12,
  });
  // Whole-card thinning keeps the authored trunk and caps surviving card area growth at 4x.
  species.push({
    asset: "spruce",
    variant: i,
    path: `spruce/${i}-far`,
    metres: [12, 14, 13, 10, 11][i] ?? 12,
    level: 1,
  });
}
for (const [asset, heights] of Object.entries({
  sapling: [1.1, 2.1, 3.0, 1.6],
  grass: [0.3, 0.55, 0.75, 0.45],
  /** The meadow's dense base layer (`meadowCover`): Open World Demo field grass and a low mat. */
  meadow: [0.42, 0.3],
  scrub: [0.085, 0.065, 0.018],
  poppy: [0.38, 0.5, 0.42, 0.4],
  bloom: [0.35, 0.5, 0.4, 0.45],
  fern: [0.7, 0.6, 0.85],
  bush: [0.9, 0.55],
  litter: [0.42, 0.55],
  boulder: [2.1, 5.2, 2.5],
  riverrock: [0.8],
  scree: [5.8],
  cliff: [18],
})) {
  heights.forEach((metres, variant) =>
    species.push({ asset, variant, metres, path: `${asset}/${variant}` }),
  );
}
/** The species drawn as stone: they stand on their lowest point and take a hull collider. */
export const STONE = new Set(["boulder", "riverrock", "scree", "cliff"]);
/** Meadow Flowers species: photographed petals kept, stems lifted, no foliage tint. */
const FLOWERS = new Set(["poppy", "bloom"]);
for (const one of WORLD_ROCKS) STONE.add(one.asset);
/** Needle-card triangles one far spruce draws past LOD_BANDS.far (its middle level draws 0.8-4.7k). */
const FAR_NEEDLE_TRIANGLES = 1500;

/**
 * Which licensed model each variant of a temperate understory layer draws.
 *
 * The table is the game's, not the bake's: a species is a line here and the variant index is what
 * the placement hash picks, so a wood grows four grass species, three ground-foliage mounds, three
 * ferns, four flower species and four understorey conifers (one draw per species) without any placement rule knowing a
 * filename. Every entry names a model out of a pack the canopy already cooks, so a layer costs a
 * mesh and no atlas.
 */
const TEMPERATE_PATHS: Record<string, readonly string[]> = {
  grass: ["fieldgrass/0", "field/0", "field/1", "field/2"],
  meadow: ["fieldgrass/0", "mat/0"],
  scrub: ["scrub/0", "scrub/1", "scrub/2"],
  fern: ["fern/0", "fern/1", "bracken/0"],
  poppy: ["poppy/0", "poppy/1", "poppy/2", "poppy/3"],
  bloom: ["bloom/0", "bloom/1", "bloom/2", "bloom/3"],
  bush: ["thicket/0", "thicket/1"],
  sapling: ["needle-spruce/0", "sapling/0", "sapling/1", "sprout/0"],
  litter: ["litter/0", "litter/1"],
};
// Per tree, not per draw slot: WorldCells repacks instances as the player walks.
const phase = instanceRandom().mul(6.2831);
const gust = sin(time.mul(0.1).add(phase));

/** What one imported section is, before any appearance decision: its art and its niche. */
interface ISurfaceContext {
  readonly source: MeshStandardMaterial;
  readonly asset: string;
  readonly world: WorldName;
  readonly look: IBiome;
  readonly biome?: IWorldBiome;
  readonly stone: boolean;
  readonly cutout: boolean;
  readonly canopy: boolean;
  readonly kite: boolean;
  readonly fieldGrass: boolean;
  readonly otherBiome: boolean;
}

/** Imported foliage draws as imported: its albedo, its normal map, its own cutoff, both faces. */
/**
 * Imported normal maps whose green channel is DirectX (Unreal) rather than glTF's OpenGL, measured
 * per material by a curl test on the staged maps (2026-10-08). Every other imported map is OpenGL.
 */
const DIRECTX_NORMALS =
  /^(branch|MI_LargePlainsBoulder002|MI_Large_VolcanicRock_002|ScotsPine_01_.*)$/u;

/**
 * GLTFLoader flips `normalScale.y` for a mesh without tangents, which none of the cooked meshes
 * carry; a rebuilt material that copies only `normalMap` loses that flip and lights every relief
 * from the mirrored side. Keep it, and undo it for the DirectX-authored maps.
 */
function copyNormalScale(material: MeshPhysicalNodeMaterial, source: MeshStandardMaterial): void {
  material.normalScale.copy(source.normalScale);
  if (DIRECTX_NORMALS.test(source.name)) material.normalScale.y *= -1;
}

function importedFoliage(
  material: MeshPhysicalNodeMaterial,
  source: MeshStandardMaterial,
  map: Texture,
): void {
  const sampled = texture(map, uv());
  map.anisotropy = 8;
  material.normalMap = source.normalMap;
  copyNormalScale(material, source);
  material.roughness = 0.92;
  // The Kite field grass is authored dark for Unreal's exposure (Wildwood lifts such packs ~3x); drawn raw
  // it read as a blue-black carpet.
  material.colorNode = sampled.rgb.mul(source.name === "open-world-demo" ? 3 : 1);
  material.alphaTest = source.alphaTest;
  material.alphaTestNode = float(source.alphaTest);
  material.opacityNode = sampled.a;
  material.side = DoubleSide;
  material.shadowSide = DoubleSide;
}

/**
 * Moss, snow and the upward-face mask a stone section wears over its own albedo.
 *
 * Alpine keeps the heightfield's upward-face mask across mesh seams; tundra uses its ground rule.
 */
function stoneSurface(
  material: MeshPhysicalNodeMaterial,
  context: ISurfaceContext,
  snowMap?: Texture,
): void {
  const { source, look } = context;
  if (look.stoneFrontFace) material.shadowSide = FrontSide;
  const growth = smoothstep(-0.15, 0.3, bakedNoise(positionWorld.mul(2.1)));
  const moss = normalWorldGeometry.y.max(0).mul(growth).mul(look.stoneMoss);
  material.colorNode = mix(material.colorNode as Node<"vec3">, vec3(...look.stoneMossTint), moss);
  if (!look.stoneSnow) return;
  const biome = context.biome;
  if (!biome) throw new RangeError("Stone snow requires measured terrain elevations");
  const snow = look.crestRock
    ? smoothstep(0.12, 0.82, alpineSnowCover(biome))
    : (biomeWeights(biome, float(1).sub(normalWorldGeometry.y), float(0), growth)
        .snow as Node<"float">);
  material.colorNode = mix(
    material.colorNode as Node<"vec3">,
    look.crestRock
      ? (snowMap ? texture(snowMap, positionWorld.xz.div(12)).rgb : vec3(0.82, 0.86, 0.9)).mul(
          vec3(...biome.snowTint),
        )
      : vec3(...look.stoneSnowTint),
    snow,
  );
  material.roughnessNode = mix(0.96, 0.82, snow);
  if (source.normalMap)
    material.normalNode = normalMap(texture(source.normalMap), vec2(mix(1, 0.2, snow)));
}

/** Needle pixels nearer the lens than this are cut, in metres. */
const CANOPY_NEAR = 1.2;
/** Bark is cut only at the lens: a limb sliced further out shows a hollow, sawn end. */
const BARK_NEAR = 0.4;
/** Radius of the sight line kept clear of tree pixels from the lens to the hero, in metres. */
const SIGHT_RADIUS = 1.2;

/**
 * The hero the orbit camera aims at, in world space. `game.ts` writes `aim` each frame and sets
 * `radius` to {@link SIGHT_RADIUS} while the player view is live, 0 for the fixed views.
 */
export const sightLine = { aim: uniform(new Vector3()), radius: uniform(0) };
/** `?riverbed=off` is the river A/B's before arm: the waterline rocks stay dry. */
export const RIVER_BED =
  new URLSearchParams(globalThis.location?.search ?? "").get("riverbed") !== "off";
export { SIGHT_RADIUS };

/**
 * The orbit camera swings through crowns: a branch a metre from the lens fills the screen, and a
 * stand between the lens and the hero hides the hero. Needles near the lens, and on the line from
 * the lens to the hero, are eroded, as a third-person camera fades the occluders of its character
 * (UE's CameraDepthFade into the opacity mask). The fade scales the needle alpha before the 4x MSAA
 * alpha-to-coverage test, so cards thin from their tips inward over a metre: a hard cut drew a
 * sharp circle, and slicing branches with it drew their hollow ends as rings round the hero.
 * Bark takes only a short cut at the lens (a sliced limb reads hollow); branches stay whole.
 * An orthographic view (P[3][3] = 1) is a shadow page or the impostor baker, so it keeps the tree.
 */
export function nearCameraFade(material: MeshPhysicalNodeMaterial, needles: boolean): void {
  const ortho = cameraProjectionMatrix.mul(vec4(0, 0, 0, 1)).w.greaterThan(0.5);
  if (!needles) {
    material.maskNode = ortho.or(length(positionView).greaterThanEqual(BARK_NEAR));
    return;
  }
  const aim = cameraViewMatrix.mul(vec4(sightLine.aim, 1)).xyz;
  const along = dot(positionView, aim).div(dot(aim, aim).max(1e-4));
  const off = length(positionView.sub(aim.mul(along.clamp(0, 1))));
  // 1 keeps the needle; radius 0 (a fixed view) keeps every needle off the line.
  const sight = smoothstep(0.8, 1.7, off.div(sightLine.radius.max(1e-3))).max(
    smoothstep(0.9, 1.05, along),
  );
  const lens = smoothstep(CANOPY_NEAR * 0.5, CANOPY_NEAR * 1.5, length(positionView));
  const keep = sight.min(lens).max(ortho.select(float(1), float(0)));
  material.opacityNode = ((material.opacityNode as Node<"float"> | null) ?? float(1)).mul(keep);
}

/** The coverage, interior depth and normal a cut-out section is drawn with. */
function cutoutSurface(
  material: MeshPhysicalNodeMaterial,
  context: ISurfaceContext,
  sampled: Node<"vec4">,
): void {
  const { source, asset, look, canopy, otherBiome } = context;
  // Shadow overrides and VirtualShadowNode classify cutouts by this scalar, not the node.
  material.alphaTest = source.alphaTest;
  // The scene pass is 4x MSAA: coverage from alpha smooths card edges that a hard test speckles.
  material.alphaToCoverage = true;
  material.side = DoubleSide;
  material.shadowSide = DoubleSide;
  if (canopy) {
    const inner = attribute<"float">("inner", "float");
    const shape = look.canopyLinearInner ? inner : inner.pow(2);
    material.colorNode = (material.colorNode as Node<"vec3">).mul(
      mix(look.canopyInnerShade, 1, shape),
    );
    material.aoNode = mix(look.canopyAmbientOcclusion[0], look.canopyAmbientOcclusion[1], shape);
    // The bent crown normal is the geometry's own (radial, from `addRadialCoverage`); the imported
    // normal map perturbs that same geometry normal. Installing the bare geometry normal as
    // `normalNode` replaced the normal node and discarded the map, so the crown shaded as one flat
    // card. The custom path only fills in where the art carries no map — an imported surface sets
    // `normalMap` and leaves the node to Three, which also applies the texture's own packing.
    if (look.crownGeometryNormals && !source.normalMap) material.normalNode = normalViewGeometry;
  } else if (FLOWERS.has(asset)) {
    // Keep the photographed red petals; lift only the nearly black stems/seed pods.
    const dark = smoothstep(0.045, 0.008, sampled.r.max(sampled.g).max(sampled.b));
    material.colorNode = mix(
      material.colorNode as Node<"vec3">,
      vec3(0.028, 0.055, 0.009),
      dark.mul(0.75),
    );
    material.emissiveNode = (material.colorNode as Node<"vec3">).mul(0.045);
  } else if (source.normalMap && !look.mats) {
    // Ground foliage keeps photographed relief around its bent, upward leaf normal.
    const relief = texture(source.normalMap, uv()).xy.mul(2).sub(1).mul(0.45);
    material.normalNode = vec3(relief.x, 1, relief.y)
      .normalize()
      .transformDirection(cameraViewMatrix);
  }
  const image = source.map?.image as { width?: number; height?: number } | undefined;
  const size = vec2(image?.width ?? 2048, image?.height ?? 2048);
  const mip = max(
    log2(max(length(dFdx(uv()).mul(size)), length(dFdy(uv()).mul(size))).max(1)),
    float(0),
  );
  // Low tundra mats must reject blurred photographic background in alpha mips.
  material.alphaTestNode =
    look.mats && !canopy
      ? float(0.5)
      : float(look.authoredAlphaTest ? source.alphaTest : 0.42).div(float(1).add(mip.mul(0.25)));
  material.opacityNode = sampled.a;
  material.maskShadowNode = sampled.a.greaterThan(material.alphaTestNode as Node<"float">);
  // Keep the authored scalar for cutout classification and impostor capture.
  material.userData.tnImpostorAlphaTest = source.alphaTest;
  if (canopy) {
    lightNeedles(material, material.aoNode as Node<"float">);
    if (!otherBiome) material.emissiveNode = (material.emissiveNode as Node<"vec3">).mul(0.18);
    if (look.canopyEmissiveScale !== null && material.emissiveNode)
      material.emissiveNode = (material.emissiveNode as Node<"vec3">).mul(look.canopyEmissiveScale);
  } else if (!FLOWERS.has(asset))
    material.emissiveNode = (material.colorNode as Node<"vec3">).mul(0.025);
}

/** Imported albedo graded per niche, then stone, cutout and coverage. */
function tintedFoliage(
  material: MeshPhysicalNodeMaterial,
  context: ISurfaceContext,
  snowMap?: Texture,
): void {
  const { source, asset, look, stone, cutout, canopy, kite, fieldGrass, otherBiome } = context;
  const map = source.map as Texture;
  map.anisotropy = 8;
  const sampled = texture(map, uv());
  // Cooked albedo is already sRGB (KTX2 DFD transfer=2); never apply a second decode or lift.
  const tint =
    cutout && canopy
      ? look.canopyTint
      : cutout && !FLOWERS.has(asset)
        ? look.bladeTint
        : FLOWERS.has(asset)
          ? ([1, 1, 0.85] as const)
          : canopy && source.name === "branch"
            ? ([0.45, 0.38, 0.25] as const)
            : ([1, 1, 1] as const);

  material.colorNode = sampled.rgb.mul(vec3(...tint));
  // The spruce atlas is photographed warm under Unreal's exposure: cool and darken it toward a
  // spruce green, and sink its orange cone texels to shadowed brown instead of lit specks.
  if (look.woodCanopy && canopy && cutout) {
    // The atlas is photographed olive-yellow (opaque mean RGB 90,81,21: almost no blue), which no
    // channel gain turns blue-green. Keep its luminance detail and give it a spruce hue.
    const needle = dot(sampled.rgb, vec3(0.2126, 0.7152, 0.0722));
    // One hue on every crown reads as one tree copied across the valley: each tree leans
    // blue-green or yellow-green and takes its own value from its instance hash, kept small so the
    // one-hue impostor past the far gate still matches. A crown is paler at its sunlit top and
    // darker in its skirt, which is geometry and so bakes into the impostor too.
    const lean = sin(phase.mul(1.7)).mul(0.5).add(0.5);
    const hue = mix(vec3(0.45, 0.81, 0.34), vec3(0.56, 0.86, 0.26), lean);
    const value = mix(0.9, 1.08, sin(phase.mul(2.9)).mul(0.5).add(0.5));
    const crownTop = mix(0.8, 1.14, smoothstep(1.5, 11, positionGeometry.y));
    material.colorNode = mix(
      needle.mul(hue).mul(value).mul(crownTop),
      vec3(0.05, 0.03, 0.015),
      smoothstep(0.02, 0.12, sampled.r.sub(sampled.g)),
    );
  }
  // Kite's pine atlas is half live needles and half dead: cells 4 and 5 and the bare lower-branch
  // card are rust brown, so every crown wears rust dots and every trunk wears a tan spiky burst.
  // Colour decides, not geometry — a texel warmer than its own green is dead wood. This is not
  // gated on the cutout: the bare lower branches are the one part of the pine drawn opaque, so a
  // cutout-only mask left the worst of the tan spikes standing.
  if (kite && canopy) {
    const dead = smoothstep(0.008, 0.075, sampled.r.sub(sampled.g));
    const damp = material.colorNode as Node<"vec3">;
    material.colorNode = mix(
      damp,
      damp.rgb.mul(vec3(0.3, 0.42, 0.27)),
      dead.mul(cutout ? 0.94 : 0.8),
    );
  }
  if (!otherBiome && canopy && !cutout && !kite)
    material.colorNode = sampled.rgb.mul(vec3(0.42, 0.27, 0.15));
  if (!otherBiome && asset === "litter") {
    // Needle litter is the spruce atlas photographed dry: pull it toward bark brown and lay it
    // flat, so the forest floor carries a dead layer instead of more green.
    const grain = dot(sampled.rgb, vec3(0.2126, 0.7152, 0.0722));
    material.colorNode = mix(sampled.rgb.mul(vec3(0.72, 0.5, 0.28)), sampled.rgb, 0.18).mul(
      grain.mul(6).clamp(0.45, 1.3),
    );
    material.aoNode = mix(0.28, 0.9, smoothstep(0.0, 0.14, positionGeometry.y).oneMinus());
  }
  if (!otherBiome && (asset === "grass" || asset === "meadow" || asset === "scrub")) {
    const tip = smoothstep(0.008, asset === "scrub" ? 0.065 : 0.34, positionGeometry.y);
    const dry = smoothstep(0.65, 0.92, sin(phase).mul(0.5).add(0.5));
    const dune = look.shoreGround ? smoothstep(7.5, 2.2, positionWorld.y) : float(0);
    const green = mix(vec3(0.32, 0.48, 0.18), vec3(0.84, 0.92, 0.46), tip);
    const straw = mix(vec3(0.4, 0.29, 0.12), vec3(1.18, 0.94, 0.48), tip);
    const grain = dot(sampled.rgb, vec3(0.2126, 0.7152, 0.0722));
    material.colorNode = mix(sampled.rgb.mul(green), straw.mul(grain), dry.max(dune));
    if (fieldGrass)
      material.colorNode = mix(vec3(0.06, 0.1, 0.025), vec3(0.2, 0.31, 0.065), tip).mul(
        grain.mul(24).clamp(0.4, 1.4),
      );
    material.aoNode = mix(fieldGrass ? 0.55 : 0.35, 0.95, tip);
  }
  if (otherBiome && stone) material.colorNode = sampled.rgb.mul(vec3(...look.stoneSectionTint));
  if (look.mesaRock && stone) material.colorNode = desertRockColor(sampled.rgb);
  if (look.crestRock && stone) material.colorNode = alpineRockColor(alpineRockAlbedo(map));
  if (otherBiome && cutout && !canopy)
    material.colorNode = sampled.rgb.mul(vec3(...look.cutoutTint));
  if (look.strawBlades && asset === "grass")
    material.colorNode = vec3(1.28, 0.94, 0.52).mul(dot(sampled.rgb, vec3(0.2126, 0.7152, 0.0722)));
  if (look.mats && cutout && !canopy) {
    const root = smoothstep(0.015, 0.14, positionGeometry.y);
    material.colorNode = mix(vec3(0.025, 0.035, 0.013), material.colorNode, root);
    material.aoNode = mix(0.15, 0.8, root);
  }
  if (stone) stoneSurface(material, context, snowMap);
  if (cutout) cutoutSurface(material, context, sampled);
}

/** The wind a non-stone section bends with, per instance, from the geometry's own `sway` weights. */
function applyWind(material: MeshPhysicalNodeMaterial, context: ISurfaceContext): void {
  if (context.stone) return;
  const bend = gust.mul(positionGeometry.y.max(0).pow(1.5)).mul(windStiffness(context.asset));
  const offset = vec3(
    positionLocal.x.add(bend),
    positionLocal.y,
    positionLocal.z.add(bend.mul(0.55)),
  );
  material.positionNode = offset;
  // Cached shadow pages cast the rest pose, so a page refresh redraws the same shadow (see propMaterials sway).
  material.castShadowPositionNode = positionLocal;
}

function windStiffness(asset: string): number {
  return asset === "spruce" ? 0.008 : 0.025;
}

/**
 * engine-override: the farthest applyWind moves a vertex of this section, its top bent by a full gust
 * along (1, 0, 0.55). The owned engine grows each instance's shadow box by it, so a virtual shadow page
 * draws only the trees that can reach it instead of the whole forest.
 */
function declareWindReach(
  material: MeshPhysicalNodeMaterial,
  asset: string,
  geometry: BufferGeometry,
): void {
  geometry.computeBoundingBox();
  const top = Math.max(0, geometry.boundingBox?.max.y ?? 0);
  const reach = top ** 1.5 * windStiffness(asset) * Math.hypot(1, 0.55);
  const swaying = material as MeshPhysicalNodeMaterial & { maxPositionOffset?: number };
  swaying.maxPositionOffset = Math.max(swaying.maxPositionOffset ?? 0, reach);
}

function surface(
  source: MeshStandardMaterial,
  asset: string,
  world: WorldName,
  snowMap?: Texture,
  skyLight?: Texture,
  comparison?: ICanopyComparison,
  biome?: IWorldBiome,
): MeshPhysicalNodeMaterial {
  const stone = STONE.has(asset);
  const cutout = !stone && source.alphaTest > 0;
  const canopy = asset === "spruce" || asset === "sapling";
  const kite = source.name.startsWith("ScotsPine");
  const fieldGrass = (asset === "grass" || asset === "meadow") && source.name === "open-world-demo";
  const look = BIOMES[world];
  const otherBiome = !look.lawnGround;
  const context: ISurfaceContext = {
    source,
    asset,
    world,
    look,
    biome,
    stone,
    cutout,
    canopy,
    kite,
    fieldGrass,
    otherBiome,
  };
  const material = new MeshPhysicalNodeMaterial({
    map: source.map,
    color: source.color,
    normalMap: source.normalMap,
    roughness: stone ? 0.96 : 1,
    specularIntensity: canopy
      ? comparison?.specular === "standard"
        ? 1
        : 0
      : look.mats && cutout
        ? 0
        : cutout
          ? 0.02
          : 0.3,
    metalness: 0,
  });
  copyNormalScale(material, source);
  if (!otherBiome && canopy && !cutout) material.normalMap = source.normalMap;
  // Forest needle crowns need their authored interior shading and filtered alpha coverage.
  // A plain imported PBR card erased canopy depth at the same geometry and camera.
  if (cutout && source.map && !(look.woodCanopy && canopy)) {
    importedFoliage(material, source, source.map);
    if (look.woodCanopy && (asset === "grass" || asset === "meadow")) {
      // One photograph per species reads as astroturf: each clump takes its own value about 1 and
      // a green-to-dry hue from its instance hash, and its root sinks into the soil's shade.
      const clump = sin(phase.mul(3.7)).mul(0.5).add(0.5);
      const shade = mix(vec3(0.62, 0.86, 0.5), vec3(0.98, 0.96, 0.52), clump.mul(clump));
      // Drifts metres across: a meadow is darker in its damp patches and paler on its dry ones.
      const drift = mix(0.78, 1.08, smoothstep(-0.4, 0.4, bakedNoise(positionWorld.mul(0.11))));
      // Part of a meadow has gone to seed: straw patches tens of metres across break the one green,
      // on a slower field than the drift so the two do not line up.
      const straw = smoothstep(
        0.2,
        0.6,
        bakedNoise(
          vec3(positionWorld.x, 0, positionWorld.z)
            .mul(0.027)
            .add(vec3(31, 0, 17)),
        ),
      );
      const seeded = mix(vec3(1, 1, 1), vec3(1.32, 1.08, 0.6), straw.mul(0.6));
      // A blade is dark where it leaves the thatch and brightest at its tip.
      // A tuft stands three times as tall as the field grass, so the same 0.32 m ramp left nearly
      // all of it at full value above a field that sits inside its own root shade: its ramp runs
      // the tuft's own height.
      const root = mix(0.34, 1, smoothstep(0.0, fieldGrass ? 0.32 : 0.8, positionGeometry.y));
      // The tall tufts are photographed far paler than the field grass they stand in: bring them
      // to the same sward so a tuft reads as taller grass, not as a lit paper cut-out.
      const sward = fieldGrass ? vec3(1, 1, 1) : vec3(0.5, 0.62, 0.4);
      material.colorNode = (material.colorNode as Node<"vec3">)
        .mul(shade)
        .mul(drift)
        .mul(root)
        .mul(sward)
        .mul(seeded);
      material.aoNode = mix(0.5, 1, smoothstep(0.0, 0.25, positionGeometry.y));
      // A blade card stands upright, so its own normal faces the horizon and half the cards face
      // away from the sun: those drew black beside sunlit ones. A meadow shades as the ground it
      // grows from, so every blade takes the up normal and the sun's shadow still falls across it.
      material.normalNode = vec3(0, 1, 0).transformDirection(cameraViewMatrix);
    }
    if (look.woodCanopy) {
      // Blades and fronds a cell thick pass the sun through; without it a meadow seen against the
      // sun is lit almost only by the sky. Same shadowed term as the needles, without their fill.
      // Roots and the gaps between blades stay dark; the upper blade carries the glow.
      lightNeedles(material, smoothstep(0.02, 0.4, positionGeometry.y), 0.6);
      material.emissiveNode = null;
    }
  } else if (source.map) tintedFoliage(material, context, snowMap);
  // River rock lies on the waterline, and wet stone is darker and glossier: water fills the pores
  // (albedo about halves) and films the surface (roughness falls). `?riverbed=off`: dry, as before.
  if (asset === "riverrock" && RIVER_BED && material.colorNode) {
    material.colorNode = (material.colorNode as Node<"vec3">).mul(0.45);
    material.roughness = 0.32;
  }
  applyWind(material, context);
  if (canopy) nearCameraFade(material, cutout);
  // Image-based sky light, as Wildwood lights the same Fab packs (Kloofendal at 1.8 × 0.629).
  // Without it a shaded needle card gets only the hemisphere fill and falls to one flat dark value.
  // Per material, not `scene.environment`: the ground is tuned to the fill alone and cannot opt out.
  if (skyLight && !stone) skyEnvironment(material, skyLight);
  // At full sky light a forest crown is ~85% lit by sky and emissive, so it shows no sun side.
  if (skyLight && look.woodCanopy && canopy) material.envMapIntensity = 0.35;
  return material;
}

/**
 * The photograph's sun disc (peak luminance ~72,559, 81° from the scene sun) gave the meadow 44% of
 * its light from a second, unshadowed key light. The scene's own sun is the key; the image keeps only
 * its sky, so every texel is capped at a luminance of 30.
 */
const SKY_LUMINANCE_CAP = 30;
function clampSkySun(sky: Texture): void {
  const image = sky.image as { data: Uint16Array | Float32Array; width: number; height: number };
  const data = image.data;
  const half = data instanceof Uint16Array;
  const read = (i: number) =>
    half ? DataUtils.fromHalfFloat(data[i] as number) : (data[i] as number);
  const write = (i: number, v: number) => {
    data[i] = half ? DataUtils.toHalfFloat(v) : v;
  };
  const channels = data.length / (image.width * image.height);
  for (let i = 0; i < data.length; i += channels) {
    const r = read(i);
    const g = read(i + 1);
    const b = read(i + 2);
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (luminance <= SKY_LUMINANCE_CAP) continue;
    const scale = SKY_LUMINANCE_CAP / luminance;
    write(i, r * scale);
    write(i + 1, g * scale);
    write(i + 2, b * scale);
  }
}

/**
 * The sky's diffuse light as two colours: the cosine-weighted mean radiance of the upper hemisphere
 * (what a level surface receives) and of the lower one (the bounce a surface facing down receives).
 * A rough surface shows little more of image-based light than this, and two colours cost no sampler.
 */
export function skyIrradiance(sky: Texture): {
  up: [number, number, number];
  down: [number, number, number];
} {
  const image = sky.image as { data: Uint16Array | Float32Array; width: number; height: number };
  const data = image.data;
  const half = data instanceof Uint16Array;
  const read = (i: number) =>
    half ? DataUtils.fromHalfFloat(data[i] as number) : (data[i] as number);
  const channels = data.length / (image.width * image.height);
  const up = [0, 0, 0];
  const down = [0, 0, 0];
  let upWeight = 0;
  let downWeight = 0;
  for (let row = 0; row < image.height; row += 2) {
    // Equirectangular rows run from the zenith (row 0) to the nadir.
    const theta = ((row + 0.5) / image.height) * Math.PI;
    const y = Math.cos(theta);
    const solid = Math.sin(theta);
    for (let column = 0; column < image.width; column += 2) {
      const i = (row * image.width + column) * channels;
      const weight = Math.abs(y) * solid;
      const target = y >= 0 ? up : down;
      target[0] = (target[0] ?? 0) + read(i) * weight;
      target[1] = (target[1] ?? 0) + read(i + 1) * weight;
      target[2] = (target[2] ?? 0) + read(i + 2) * weight;
      if (y >= 0) upWeight += weight;
      else downWeight += weight;
    }
  }
  const mean = (c: number[], w: number): [number, number, number] => [
    (c[0] ?? 0) / (w || 1),
    (c[1] ?? 0) / (w || 1),
    (c[2] ?? 0) / (w || 1),
  ];
  return { up: mean(up, upWeight), down: mean(down, downWeight) };
}

let skyLight: Promise<Texture | undefined> | undefined;
/** The CC0 sky photograph, loaded once; absent locally, vegetation keeps the fill alone. */
export function loadSkyLight(assets: IAssetLoader): Promise<Texture | undefined> {
  skyLight ??= assets
    .resolve("prepared/kloofendal_48d_2k.hdr")
    .then(async ([url]) => {
      if (!url) return undefined;
      const sky = await new HDRLoader().loadAsync(url);
      sky.mapping = EquirectangularReflectionMapping;
      clampSkySun(sky);
      return sky;
    })
    .catch(() => undefined);
  return skyLight;
}

/** Per-world reshape for one asset, applied on top of the shared whole-model scale. */
const WORLD_ASSET_SCALES: Record<string, Record<string, readonly [number, number, number]>> = {
  tundra: { grass: [1.35, 1, 1.35], bush: [0.18, 1, 0.18], scrub: [1.1, 2, 1.1] },
  coastal: { grass: [0.55, 1.35, 0.55] },
  forest: { poppy: [1, 1.4, 1] },
};
/** A reshape every world applies to one asset. */
const ASSET_SCALES: Record<string, readonly [number, number, number]> = {
  spruce: [1.12, 1, 1.12],
};

/** Every step is a diagonal scale, so the order the reshapes run in cannot change the result. */
function scaleGeometry(
  geometry: BufferGeometry,
  asset: string,
  world: WorldName,
  size: Vector3,
): void {
  const look = BIOMES[world];
  const worldScale = WORLD_ASSET_SCALES[world]?.[asset];
  if (worldScale) geometry.scale(worldScale[0], worldScale[1], worldScale[2]);
  const assetScale = ASSET_SCALES[asset];
  if (assetScale) geometry.scale(assetScale[0], assetScale[1], assetScale[2]);
  // Alpine peaks are pinned to a 24 m longest axis after their mountain reshape.
  if (look.pinnedCrags && asset === "mountain") {
    geometry.scale(0.65, 1.45, 1.8);
    const longest = Math.max(size.x * 0.65, size.y * 1.45, size.z * 1.8);
    geometry.scale(24 / longest, 24 / longest, 24 / longest);
  }
}

/** Radial coverage per height band: tips see sky, needles near the trunk do not. */
function addRadialCoverage(
  geometry: BufferGeometry,
  metres: number,
  world: WorldName,
  comparison?: ICanopyComparison,
): void {
  const positions = geometry.getAttribute("position");
  const radii = new Float32Array(16);
  const band = (i: number) =>
    Math.min(15, Math.max(0, Math.floor((positions.getY(i) / metres) * 16)));
  for (let i = 0; i < positions.count; i++)
    radii[band(i)] = Math.max(
      radii[band(i)] ?? 0,
      Math.hypot(positions.getX(i), positions.getZ(i)),
    );
  const inner = Float32Array.from({ length: positions.count }, (_, i) =>
    Math.min(
      1,
      Math.hypot(positions.getX(i), positions.getZ(i)) / Math.max(0.1, radii[band(i)] ?? 0),
    ),
  );
  geometry.setAttribute("inner", new BufferAttribute(inner, 1));
  if (!BIOMES[world].crownGeometryNormals || comparison?.normals !== "radial") return;
  // Keep synthetic crown normals as an explicit same-asset probe; the authored normals and normal
  // map preserve needle lighting by default. Only this owned clone changes, never the cached asset.
  const crownNormals = new Float32Array(positions.count * 3);
  const direction = new Vector3();
  for (let i = 0; i < positions.count; i++) {
    direction
      .set(positions.getX(i), Math.max(0.1, radii[band(i)] ?? 0) * 0.45, positions.getZ(i))
      .normalize();
    direction.toArray(crownNormals, i * 3);
  }
  geometry.setAttribute("normal", new BufferAttribute(crownNormals, 3));
}

/** One whole-model base and scale for all sections: scaling each part separately detached crowns. */
function prepareGeometry(
  mesh: Mesh,
  one: IPackSpecies,
  world: WorldName,
  stone: boolean,
  box: Box3,
  size: Vector3,
  section: IMeshSection,
): BufferGeometry {
  // `spruce_full_03_low` ships zero normals; the repair runs after the reshape so they fit it.
  const geometry = sectionGeometry(mesh, box, section, {
    centreXZ: stone && BIOMES[world].lawnGround,
  });
  scaleGeometry(geometry, one.asset, world, size);
  repairZeroNormals(geometry);
  return geometry;
}

/**
 * The species one world draws, read from its biome file: every cell row whose asset the file names,
 * then the rocks of the west-coast scans it names, then a mat plain's own small bush.
 *
 * The file says which species live in the biome; this pack says what art each one is drawn with.
 */
export function speciesFor(world: WorldName): IPackSpecies[] {
  const look = BIOMES[world];
  const held = new Set(biomeSpec(world).species);
  // A mat plain grows one small scrub, not the temperate thicket pair.
  const rows = look.scrubBush ? species.filter((one) => one.asset !== "bush") : species;
  const selected = rows
    .filter((one) => held.has(one.asset))
    // The temperate understorey is the licensed species set; every other world keeps its own.
    .map((one) => {
      const path = look.lawnGround ? TEMPERATE_PATHS[one.asset]?.[one.variant] : undefined;
      return path ? { ...one, path } : one;
    });
  selected.push(
    ...WORLD_ROCKS.filter((one) => held.has(one.asset)).map((one) => ({
      ...one,
      path: one.path.replace(/^temperate\//, "").replace(/\.glb$/, ""),
    })),
  );
  if (look.scrubBush && held.has("bush"))
    selected.push({ asset: "bush", variant: 0, path: "scrub/0", metres: 0.45 });
  return selected;
}

export interface IPackProps {
  readonly parts: Map<string, IPropPart[]>;
  readonly dispose: () => void;
}
export async function loadPack(
  assets?: IAssetLoader,
  world: WorldName = "forest",
  ground?: IPropGround,
  comparison?: ICanopyComparison,
  biome?: IWorldBiome,
): Promise<IPackProps> {
  const measured = biome ?? (ground ? measureBiome(BIOMES[world], ground.heights) : undefined);
  const look = BIOMES[world];
  if (!measured && look.stoneSnow)
    throw new RangeError("Stone snow requires measured terrain elevations");
  const parts = new Map<string, IPropPart[]>();
  const built: { geometry: BufferGeometry; material: Material }[] = [];
  const selected = speciesFor(world);
  const rockface =
    look.crestRock && assets
      ? await Promise.all(
          [ROCKFACE_MAPS.diffuse, ROCKFACE_MAPS.normal, GROUND_MAPS.snow.diffuse].map(
            (path, index) =>
              path
                ? assets
                    .texture(path, { data: index === 1, wrap: RepeatWrapping })
                    .catch(() => undefined)
                : undefined,
          ),
        )
      : [];
  const rockGround = await createRockGround(assets, ground, measured);
  const sky = assets ? await loadSkyLight(assets) : undefined;
  const loaded = await Promise.all(
    selected.map(async (one) => {
      if (!assets) return undefined;
      try {
        return await assets.model<{ scene?: Group }>(`temperate/${one.path}.glb`);
      } catch {
        return undefined;
      }
    }),
  );
  loaded.forEach((gltf, index) => {
    const one = selected[index];
    const root = gltf?.scene;
    if (!root || !one) return;
    normaliseToMetres(root, {
      metres: one.metres,
      axis: STONE.has(one.asset) ? "longest" : "height",
    });
    const box = new Box3().setFromObject(root); // engine-override: center baked geometry after unit normalization
    const size = box.getSize(new Vector3());
    const stone = STONE.has(one.asset);
    const entry = parts.get(`${one.asset}:${one.variant}`) ?? [];
    const horizon = new Map<IPropPart, BufferGeometry>();
    root.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh) return;
      for (const section of meshSections(mesh)) {
        if (!section.material) continue;
        let source = section.material as MeshStandardMaterial;
        if (look.crestRock && stone && rockface[0]) {
          source = source.clone();
          source.map = rockface[0];
          source.normalMap = rockface[1] ?? null;
        }
        // The reduced Kite GLB keeps UVs but carries no textures. Reuse the matching near surface;
        // skipping those parts kept all 3,200 trees at full detail, even in the aerial view.
        const role: PropRole = stone ? "stone" : source.alphaTest > 0 ? "pine" : "bark";
        const inherited =
          one.asset === "spruce" && one.level
            ? entry.find((part) => (part.level ?? 0) === 0 && part.role === role)?.material
            : undefined;
        if (!source.map && one.level && !(inherited instanceof MeshPhysicalNodeMaterial)) continue;
        const geometry = prepareGeometry(mesh, one, world, stone, box, size, section);
        if (source.alphaTest > 0 && (one.asset === "spruce" || one.asset === "sapling"))
          addRadialCoverage(geometry, one.metres, world, comparison);
        const material =
          inherited instanceof MeshPhysicalNodeMaterial
            ? inherited
            : surface(source, one.asset, world, rockface[2], sky, comparison, measured);
        if (stone) rockGround?.apply(material);
        else declareWindReach(material, one.asset, geometry);
        if (source !== section.material) source.dispose();
        built.push({ geometry, material });
        const part = { geometry, material, role, level: one.level ?? 0, variant: one.variant };
        entry.push(part);
        const rung =
          one.asset === "spruce" && one.level === 1 && source.alphaTest === 0 && !section.group
            ? lodChainOf(baseGeometryOf(mesh))?.levels.at(-1)?.index
            : undefined;
        if (rung) {
          const reduced = geometry.clone().setIndex(rung.clone());
          built.push({ geometry: reduced, material });
          horizon.set(part, reduced);
        }
      }
    });
    // Past LOD_BANDS.far the far spruce draws its cook's terminal rung (TN_discrete_lod) of the opaque
    // trunk and branch meshes, which stayed full detail at every distance: 7-17k of each tree's
    // 12-21k far triangles. Needle cards, which no simplifier can reduce, keep FAR_NEEDLE_TRIANGLES
    // of their cards at the same total area: in a stand, 8.7 M far card triangles cost 5 ms of GPU.
    if (horizon.size > 0)
      for (const part of entry.filter((candidate) => candidate.level === 1)) {
        let geometry = horizon.get(part) ?? part.geometry;
        if (part.role === "pine" && geometry.index) {
          // A multi-material section draws a range of a shared index: its own triangles set the share.
          const { start, count } = geometry.drawRange;
          const drawn = (Math.min(geometry.index.count, start + count) - start) / 3;
          geometry = thinCards(geometry, Math.min(1, FAR_NEEDLE_TRIANGLES / drawn));
          if (geometry !== part.geometry && part.material)
            built.push({ geometry, material: part.material });
        }
        entry.push({ ...part, geometry, level: 2 });
      }
    // The meadow mat reaches 220 m from the eye, where a mat is a few pixels: past LOD_BANDS.mid it
    // keeps a third of its blades and past far a tenth, each grown to hold the mat's area. UE grass
    // steps down its static mesh's own LODs the same way (UE 5.8.3:
    // Engine/Source/Runtime/Landscape/Classes/LandscapeGrassType.h:59-79, cull distances and MinLOD).
    // The field grass steps down the same way at its own nearer `LOD_STEPS`, where a tuft is still a
    // dozen pixels tall: it keeps half its blades, then a quarter.
    const thinned =
      one.asset === "meadow"
        ? ([
            [1, 0.35],
            [2, 0.12],
          ] as const)
        : one.asset === "grass"
          ? ([
              [1, 0.5],
              [2, 0.25],
            ] as const)
          : undefined;
    if (thinned)
      for (const part of entry.filter((candidate) => (candidate.level ?? 0) === 0))
        for (const [level, keep] of thinned) {
          if (!part.geometry.index || part.geometry.groups.length > 0 || !part.material) continue;
          const geometry = thinCards(part.geometry, keep);
          built.push({ geometry, material: part.material });
          entry.push({ ...part, geometry, level });
        }
    if (entry.some((part) => (part.level ?? 0) === 0))
      parts.set(`${one.asset}:${one.variant}`, entry);
  });
  return {
    parts,
    dispose: () => {
      rockGround?.dispose();
      for (const one of built) one.geometry.dispose();
      for (const material of new Set(built.map((one) => one.material))) material.dispose();
      parts.clear();
    },
  };
}
