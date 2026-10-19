/** Game-owned Fab art. Optional, local-only; missing species keep their procedural fallback. */
import { type IAssetLoader, baseGeometryOf, normaliseToMetres } from "@threenative/core";
import {
  Box3,
  BufferAttribute,
  type BufferGeometry,
  DataUtils,
  DoubleSide,
  EquirectangularReflectionMapping,
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
  cameraViewMatrix,
  dFdx,
  dFdy,
  dot,
  float,
  instanceIndex,
  length,
  log2,
  max,
  mix,
  mx_noise_float,
  normalMap,
  normalViewGeometry,
  normalWorldGeometry,
  positionGeometry,
  positionLocal,
  positionWorld,
  sin,
  smoothstep,
  texture,
  time,
  uv,
  vec2,
  vec3,
} from "three/tsl";
import { MeshPhysicalNodeMaterial, type Node } from "three/webgpu";
import { GROUND_MAPS, ROCKFACE_MAPS, WORLD_ROCKS } from "../world/terrainAssets.js";
import {
  BIOMES,
  type WorldName,
  alpineRockAlbedo,
  alpineRockColor,
  alpineSnowCover,
  biomeWeights,
  desertRockColor,
} from "./biomes.js";
import {
  type IPropGround,
  createRockGround,
  lightNeedles,
  skyEnvironment,
} from "./propMaterials.js";
import type { IPropPart, PropRole } from "./props.js";

interface IPackSpecies {
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
  // Reduced full-tree geometry preserves the adult silhouette and its trunk at distance.
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
  scrub: [0.085, 0.065, 0.018],
  poppy: [0.38, 0.5, 0.42, 0.4],
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
const STONE = new Set(["boulder", "riverrock", "scree", "cliff"]);
for (const one of WORLD_ROCKS) STONE.add(one.asset);

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
  scrub: ["scrub/0", "scrub/1", "scrub/2"],
  fern: ["fern/0", "fern/1", "bracken/0"],
  poppy: ["poppy/0", "poppy/1", "poppy/2", "poppy/3"],
  bush: ["thicket/0", "thicket/1"],
  sapling: ["needle-spruce/0", "sapling/0", "sapling/1", "sprout/0"],
  litter: ["litter/0", "litter/1"],
};
const phase = float(instanceIndex).mul(12.9898).sin().mul(43758.545).fract().mul(6.2831);
const gust = sin(time.mul(0.1).add(phase));

/** What one imported section is, before any appearance decision: its art and its niche. */
interface ISurfaceContext {
  readonly source: MeshStandardMaterial;
  readonly asset: string;
  readonly world: WorldName;
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
  const { source, world } = context;
  const growth = smoothstep(-0.15, 0.3, mx_noise_float(positionWorld.mul(2.1)));
  const moss = normalWorldGeometry.y
    .max(0)
    .mul(growth)
    .mul(world === "alpine" || world === "desert" ? 0 : 0.38);
  material.colorNode = mix(
    material.colorNode as Node<"vec3">,
    world === "desert"
      ? vec3(0.23, 0.16, 0.095)
      : world === "alpine"
        ? vec3(0.12, 0.13, 0.12)
        : vec3(0.045, 0.078, 0.019),
    moss,
  );
  if (world !== "alpine" && world !== "tundra") return;
  const snow =
    world === "alpine"
      ? smoothstep(0.12, 0.82, alpineSnowCover())
      : (biomeWeights(BIOMES[world], float(1).sub(normalWorldGeometry.y), float(0), growth)
          .snow as Node<"float">);
  material.colorNode = mix(
    material.colorNode as Node<"vec3">,
    world === "alpine"
      ? (snowMap ? texture(snowMap, positionWorld.xz.div(12)).rgb : vec3(0.82, 0.86, 0.9)).mul(
          vec3(...BIOMES.alpine.snowTint),
        )
      : vec3(0.84, 0.87, 0.91),
    snow,
  );
  material.roughnessNode = mix(0.96, 0.82, snow);
  if (source.normalMap)
    material.normalNode = normalMap(texture(source.normalMap), vec2(mix(1, 0.2, snow)));
}

/** The coverage, interior depth and normal a cut-out section is drawn with. */
function cutoutSurface(
  material: MeshPhysicalNodeMaterial,
  context: ISurfaceContext,
  sampled: Node<"vec4">,
): void {
  const { source, asset, world, canopy, otherBiome } = context;
  // Shadow overrides and VirtualShadowNode classify cutouts by this scalar, not the node.
  material.alphaTest = source.alphaTest;
  // The scene pass is 4x MSAA: coverage from alpha smooths card edges that a hard test speckles.
  material.alphaToCoverage = true;
  material.side = DoubleSide;
  material.shadowSide = DoubleSide;
  if (canopy) {
    const inner = attribute<"float">("inner", "float");
    material.colorNode = (material.colorNode as Node<"vec3">).mul(
      mix(
        otherBiome ? 0.42 : world === "forest" ? 0.6 : 0.48,
        1,
        otherBiome ? inner : inner.pow(2),
      ),
    );
    material.aoNode = otherBiome
      ? mix(0.12, 0.58, inner)
      : world === "forest"
        ? mix(0.35, 1, inner)
        : mix(0.26, 0.72, inner.pow(2));
    // The bent crown normal is the geometry's own (radial, from `addRadialCoverage`); the imported
    // normal map perturbs that same geometry normal. Installing the bare geometry normal as
    // `normalNode` replaced the normal node and discarded the map, so the crown shaded as one flat
    // card. The custom path only fills in where the art carries no map — an imported surface sets
    // `normalMap` and leaves the node to Three, which also applies the texture's own packing.
    if (world === "forest" && !source.normalMap) material.normalNode = normalViewGeometry;
  } else if (asset === "poppy") {
    // Keep the photographed red petals; lift only the nearly black stems/seed pods.
    const dark = smoothstep(0.045, 0.008, sampled.r.max(sampled.g).max(sampled.b));
    material.colorNode = mix(
      material.colorNode as Node<"vec3">,
      vec3(0.028, 0.055, 0.009),
      dark.mul(0.75),
    );
    material.emissiveNode = (material.colorNode as Node<"vec3">).mul(0.045);
  } else if (source.normalMap && world !== "tundra") {
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
    world === "tundra" && !canopy
      ? float(0.5)
      : float(world === "forest" ? source.alphaTest : 0.42).div(float(1).add(mip.mul(0.25)));
  material.opacityNode = sampled.a;
  if (canopy) {
    lightNeedles(material, material.aoNode as Node<"float">);
    if (!otherBiome) material.emissiveNode = (material.emissiveNode as Node<"vec3">).mul(0.18);
    if (world === "alpine" && material.emissiveNode)
      material.emissiveNode = (material.emissiveNode as Node<"vec3">).mul(0.4);
  } else if (asset !== "poppy")
    material.emissiveNode = (material.colorNode as Node<"vec3">).mul(0.025);
}

/** Imported albedo graded per niche, then stone, cutout and coverage. */
function tintedFoliage(
  material: MeshPhysicalNodeMaterial,
  context: ISurfaceContext,
  snowMap?: Texture,
): void {
  const { source, asset, world, stone, cutout, canopy, kite, fieldGrass, otherBiome } = context;
  const map = source.map as Texture;
  map.anisotropy = 8;
  const sampled = texture(map, uv());
  // Cooked albedo is already sRGB (KTX2 DFD transfer=2); never apply a second decode or lift.
  const tint =
    cutout && canopy
      ? otherBiome
        ? ([0.3, 0.42, 0.32] as const)
        : ([0.6, 0.78, 0.34] as const)
      : cutout && asset !== "poppy"
        ? otherBiome
          ? ([0.55, 0.82, 0.42] as const)
          : ([0.6, 0.78, 0.45] as const)
        : asset === "poppy"
          ? ([1, 1, 0.85] as const)
          : canopy && source.name === "branch"
            ? ([0.45, 0.38, 0.25] as const)
            : ([1, 1, 1] as const);

  material.colorNode = sampled.rgb.mul(vec3(...tint));
  // The spruce atlas is photographed warm under Unreal's exposure: cool and darken it toward a
  // spruce green, and sink its orange cone texels to shadowed brown instead of lit specks.
  if (world === "forest" && canopy && cutout) {
    // The atlas is photographed olive-yellow (opaque mean RGB 90,81,21: almost no blue), which no
    // channel gain turns blue-green. Keep its luminance detail and give it a spruce hue.
    const needle = dot(sampled.rgb, vec3(0.2126, 0.7152, 0.0722));
    material.colorNode = mix(
      needle.mul(vec3(0.42, 0.85, 0.45)),
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
  if (!otherBiome && (asset === "grass" || asset === "scrub")) {
    const tip = smoothstep(0.008, asset === "grass" ? 0.34 : 0.065, positionGeometry.y);
    const dry = smoothstep(0.65, 0.92, sin(phase).mul(0.5).add(0.5));
    const dune = world === "coastal" ? smoothstep(7.5, 2.2, positionWorld.y) : float(0);
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
  if (otherBiome && stone)
    material.colorNode = sampled.rgb.mul(
      world === "desert"
        ? vec3(1.12, 0.8, 0.54)
        : world === "alpine"
          ? vec3(0.94, 0.98, 1.02)
          : vec3(0.7, 0.78, 0.61),
    );
  if (world === "desert" && stone) material.colorNode = desertRockColor(sampled.rgb);
  if (world === "alpine" && stone) material.colorNode = alpineRockColor(alpineRockAlbedo(map));
  if (otherBiome && cutout && !canopy)
    material.colorNode = sampled.rgb.mul(
      world === "desert"
        ? vec3(0.85, 0.64, 0.32)
        : world === "tundra"
          ? vec3(0.64, 0.67, 0.42)
          : vec3(0.72, 0.8, 0.55),
    );
  if (world === "desert" && asset === "grass")
    material.colorNode = vec3(1.28, 0.94, 0.52).mul(dot(sampled.rgb, vec3(0.2126, 0.7152, 0.0722)));
  if (world === "tundra" && cutout && !canopy) {
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
  const bend = gust
    .mul(positionGeometry.y.max(0).pow(1.5))
    .mul(context.asset === "spruce" ? 0.008 : 0.025);
  const offset = vec3(
    positionLocal.x.add(bend),
    positionLocal.y,
    positionLocal.z.add(bend.mul(0.55)),
  );
  material.positionNode = offset;
  material.castShadowPositionNode = offset;
}

function surface(
  source: MeshStandardMaterial,
  asset: string,
  world: WorldName,
  snowMap?: Texture,
  skyLight?: Texture,
  comparison?: ICanopyComparison,
): MeshPhysicalNodeMaterial {
  const stone = STONE.has(asset);
  const cutout = !stone && source.alphaTest > 0;
  const canopy = asset === "spruce" || asset === "sapling";
  const kite = source.name.startsWith("ScotsPine");
  const fieldGrass = asset === "grass" && source.name === "open-world-demo";
  const otherBiome = world !== "forest" && world !== "coastal";
  const context: ISurfaceContext = {
    source,
    asset,
    world,
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
      : world === "tundra" && cutout
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
  if (cutout && source.map && !(world === "forest" && canopy)) {
    importedFoliage(material, source, source.map);
    if (world === "forest") {
      // Blades and fronds a cell thick pass the sun through; without it a meadow seen against the
      // sun is lit almost only by the sky. Same shadowed term as the needles, without their fill.
      // Roots and the gaps between blades stay dark; the upper blade carries the glow.
      lightNeedles(material, smoothstep(0.02, 0.4, positionGeometry.y), 0.6);
      material.emissiveNode = null;
    }
  } else if (source.map) tintedFoliage(material, context, snowMap);
  applyWind(material, context);
  // Image-based sky light, as Wildwood lights the same Fab packs (Kloofendal at 1.8 × 0.629).
  // Without it a shaded needle card gets only the hemisphere fill and falls to one flat dark value.
  // Per material, not `scene.environment`: the ground is tuned to the fill alone and cannot opt out.
  if (skyLight && !stone) skyEnvironment(material, skyLight);
  // At full sky light a forest crown is ~85% lit by sky and emissive, so it shows no sun side.
  if (skyLight && world === "forest" && canopy) material.envMapIntensity = 0.35;
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

/** A mesh's material sections: one per group for a material array, otherwise the whole mesh. */
function meshSections(
  mesh: Mesh,
): { material: Material; group?: { start: number; count: number } }[] {
  const materials = mesh.material;
  return Array.isArray(materials)
    ? mesh.geometry.groups.map((group) => ({
        material: materials[group.materialIndex ?? 0] as Material,
        group,
      }))
    : [{ material: materials }];
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
  const worldScale = WORLD_ASSET_SCALES[world]?.[asset];
  if (worldScale) geometry.scale(worldScale[0], worldScale[1], worldScale[2]);
  const assetScale = ASSET_SCALES[asset];
  if (assetScale) geometry.scale(assetScale[0], assetScale[1], assetScale[2]);
  // Alpine peaks are pinned to a 24 m longest axis after their mountain reshape.
  if (world === "alpine" && asset === "mountain") {
    geometry.scale(0.65, 1.45, 1.8);
    const longest = Math.max(size.x * 0.65, size.y * 1.45, size.z * 1.8);
    geometry.scale(24 / longest, 24 / longest, 24 / longest);
  }
}

/** `spruce_full_03_low` ships zero normals; repair the optional art, including existing cooks. */
function repairNormals(geometry: BufferGeometry): void {
  const normals = geometry.getAttribute("normal");
  let valid = normals !== undefined;
  for (let i = 0; valid && normals && i < normals.count; i++) {
    const length = Math.hypot(normals.getX(i), normals.getY(i), normals.getZ(i));
    valid = Number.isFinite(length) && length >= 0.01;
  }
  if (!valid) geometry.computeVertexNormals();
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
  if (world !== "forest" || comparison?.normals !== "radial") return;
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
  group?: { start: number; count: number },
): BufferGeometry {
  const geometry = baseGeometryOf(mesh).clone().applyMatrix4(mesh.matrixWorld);
  if (group) {
    const start = Math.max(group.start, geometry.drawRange.start);
    const end = Math.min(
      group.start + group.count,
      geometry.drawRange.start + geometry.drawRange.count,
    );
    geometry.clearGroups();
    geometry.setDrawRange(start, Math.max(0, end - start));
  }
  const centre = box.getCenter(new Vector3());
  const centredStone = stone && (world === "forest" || world === "coastal");
  geometry.translate(centredStone ? -centre.x : 0, -box.min.y, centredStone ? -centre.z : 0);
  scaleGeometry(geometry, one.asset, world, size);
  repairNormals(geometry);
  return geometry;
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
): Promise<IPackProps> {
  const parts = new Map<string, IPropPart[]>();
  const built: { geometry: BufferGeometry; material: Material }[] = [];
  const selected = species
    .filter(
      (one) =>
        world === "forest" ||
        world === "coastal" ||
        (world === "alpine" &&
          ["spruce", "sapling", "grass", "scrub", "boulder", "scree", "riverrock"].includes(
            one.asset,
          )) ||
        (world === "tundra" &&
          ["scrub", "sapling", "boulder", "scree", "riverrock"].includes(one.asset)) ||
        (world === "desert" &&
          ["grass", "scrub", "boulder", "scree", "riverrock"].includes(one.asset)),
    )
    // The temperate understorey is the licensed species set; every other world keeps its own.
    .map((one) => {
      const path = TEMPERATE_PATHS[one.asset]?.[one.variant];
      return path && (world === "forest" || world === "coastal") ? { ...one, path } : one;
    });
  if (world === "forest" || world === "coastal") {
    selected.push(
      ...WORLD_ROCKS.filter((one) => one.asset === "mountain").map((one) => ({
        ...one,
        path: one.path.replace(/^temperate\//, "").replace(/\.glb$/, ""),
      })),
    );
  }
  if (world === "tundra")
    selected.push({ asset: "bush", variant: 0, path: "scrub/0", metres: 0.45 });
  if (world === "alpine" || world === "desert")
    selected.push(
      ...WORLD_ROCKS.filter((one) =>
        world === "alpine" ? one.asset === "mountain" : one.asset !== "mountain",
      ).map((one) => ({
        ...one,
        path: one.path.replace(/^temperate\//, "").replace(/\.glb$/, ""),
      })),
    );
  const rockface =
    world === "alpine" && assets
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
  const rockGround = await createRockGround(assets, ground, BIOMES[world]);
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
    root.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh) return;
      for (const section of meshSections(mesh)) {
        if (!section.material) continue;
        let source = section.material as MeshStandardMaterial;
        if (world === "alpine" && stone && rockface[0]) {
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
        const geometry = prepareGeometry(mesh, one, world, stone, box, size, section.group);
        if (source.alphaTest > 0 && (one.asset === "spruce" || one.asset === "sapling"))
          addRadialCoverage(geometry, one.metres, world, comparison);
        const material =
          inherited instanceof MeshPhysicalNodeMaterial
            ? inherited
            : surface(source, one.asset, world, rockface[2], sky, comparison);
        if (stone) rockGround?.apply(material);
        if (source !== section.material) source.dispose();
        built.push({ geometry, material });
        entry.push({ geometry, material, role, level: one.level ?? 0, variant: one.variant });
      }
    });
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
