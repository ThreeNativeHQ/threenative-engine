/**
 * PRD-638 GI calibration scenes: the TypeScript half of tools/unreal-reference/gi/.
 *
 *   pnpm unreal-look:capture --engine unreal --scene gi | gi:cornell[,gi:<name>...]
 *     --check-cvars          first resolve every variant console variable in the editor
 *     --variants L7-Epic,ID  limit the variants (default: every variant in gi/scenes.json)
 *     --warm-up 180,360      render warm-up frames per run (default 180: sunlit-room is still 1% dark at 90)
 *     --runs 2               repeat each run; run 2 lands in "<variant>#2" (the noise floor)
 *     --rebuild              author and export the scene again even if its level exists
 *     --motion pan|switch    render a motion run (scene.py "motion") instead of the poses: every frame as
 *                            <run>.NNNN.png and one converged still per listed frame, for the variants that
 *                            say motion (L7-Epic-motion, ID) into captures/unreal/<scene>/motion/<run>/<variant>/
 *   pnpm unreal-look:compare --scene gi:cornell --unreal-vs-unreal [--write-stats]
 *   pnpm unreal-look:compare --scene gi:cornell --layer L1[,L7]   ThreeNative against Unreal, per region
 *   pnpm unreal-look:compare --scene gi:cornell --layer L7-low,L7-medium,L7-high   each quality tier against its Unreal level (PRD-644)
 *   pnpm unreal-look:compare --scene gi:cornell --layer L7 --unreal-level 0|1|3    one capture against another level's frame
 *   pnpm unreal-look:compare --scene shadow:penumbra-lab --layer L5-Low --metric penumbra   shadow edge width, TN / Unreal (PRD-652)
 *   pnpm unreal-look:compare --scene gi:cornell --metric motion [--engine unreal|threenative] [--run pan|switch]   flicker, lag and ghosting (PRD-638)
 *   pnpm unreal-look:compare --scene gi:sunlit-room --layer L7 --metric blotch [--regions Wall_Left,Wall_Right]   soft blotches on a surface, TN / Unreal (PRD-641)
 *
 * PRD-649: `--scene shadow | shadow:<name>` runs the same pipeline on the shadow family, whose scenes
 * live in tools/unreal-reference/shadow/<name>/ with their own shadow/scenes.json. A `gi:` id keeps its
 * bare name everywhere; a `shadow:` id captures to captures/<engine>/shadow/<name>/.
 *
 * Capture authors and exports each scene once (scene.glb, scene.json), checks that the two
 * agree, then renders each variant in its own editor and reads the variant's GI settings back from
 * the editor log. Every check fails closed.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type IBlotchBands,
  blotchBands,
  blotchVerdict,
  displayLuma,
  isFlatRegion,
} from "./blotch.js";
import {
  type IImage,
  type IRow,
  type IStats,
  type IThresholdFile,
  type IThresholds,
  compareCells,
  decode,
  iou,
  layerThresholds,
  masks,
  measure,
  passes,
} from "./compare.js";
import { captureMotionRun, compareMotion } from "./motion-run.js";
import { type IMotionRun, validateMotion } from "./motion.js";
import { contactGap, linearLuminance, pairedPenumbra } from "./penumbra.js";
import {
  assetRoot,
  prepareUnrealAssets,
  readManifest,
  validateWildwoodScene,
  verifyAssets,
} from "./wildwood.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const REFERENCE = path.join(REPO_ROOT, "tools/unreal-reference");
const GI = path.join(REFERENCE, "gi");
/** Scene families on this pipeline: each has its own folder and scenes.json (PRD-649). */
const FAMILIES: Readonly<Record<string, string>> = {
  gi: GI,
  shadow: path.join(REFERENCE, "shadow"),
};
const LOG = path.join(REFERENCE, "Saved/Logs/ThreeNativeReference.log");
/** PRD-631 noise floor: two Unreal runs agree within 1% (display p50). */
export const CONVERGENCE = 0.01;

type Vec3 = [number, number, number];
export interface ISceneMaterial {
  name: string;
  baseColor: Vec3;
  /** The albedo texture the material binds (PRD-639): scene.glb carries it as `baseColorTexture`. */
  baseColorTexture?: string;
  roughness: number;
  metallic: number;
  emissive: Vec3;
  emissiveStrength: number;
  /** A masked, two-sided material with a base colour texture (PRD-651 leaf cards): all four or none. */
  texture?: string;
  alphaMode?: "MASK" | "BLEND";
  alphaCutoff?: number;
  doubleSided?: boolean;
  /** A translucent material (PRD-643 glass), `alphaMode` BLEND: the alpha of the glTF base colour factor. */
  opacity?: number;
  /** The parent material's translucency lighting mode, read from the level: Unreal's default is tlm_volumetric_non_directional. */
  translucencyLightingMode?: string;
}
/** Unreal's exponential height fog as the level reports it (PRD-643). Densities are Unreal's own numbers; distances are metres. */
export interface ISceneFog {
  position: Vec3;
  /** `FogDensity`: the extinction per metre is density / 10 (UE 5.8.3: Renderer/Private/SceneCore.cpp, per centimetre /1000). */
  density: number;
  /** `FogHeightFalloff`, per 1000 cm, base 2. */
  heightFalloff: number;
  inscatteringLuminance: Vec3;
  startDistanceM: number;
  maxOpacity: number;
  volumetric: boolean;
  volumetricScatteringDistribution: number;
  volumetricAlbedo: Vec3;
  volumetricExtinctionScale: number;
  volumetricDistanceM: number;
}
export interface ISceneJson {
  scene: string;
  resolution: [number, number];
  meshes: {
    name: string;
    class: string;
    position: Vec3;
    rotationYDeg: number;
    /**
     * A tilt about +X in degrees (PRD-649 ramps and leaf cards). With a rotationYDeg too, the tilt is
     * turned first, then the yaw about the vertical: R = Ry(rotationYDeg) * Rx(rotationXDeg).
     */
    rotationXDeg?: number;
    /** The region the mesh belongs to when it shares one with others (the leaf cards); default: its name. */
    region?: string;
    size: Vec3;
    material: ISceneMaterial;
  }[];
  lights: {
    name: string;
    class: string;
    position: Vec3;
    intensity: number;
    units: string;
    attenuationRadiusM: number;
    sourceRadiusM?: number;
    /** Unreal's `VolumetricScatteringIntensity` (default 1): how much the light scatters in volumetric fog (PRD-643). */
    volumetricScatteringIntensity?: number;
    /** A SpotLight (PRD-649 lamp-room): the point it looks at, and its cone angles in degrees. */
    target?: Vec3;
    innerConeDeg?: number;
    outerConeDeg?: number;
  }[];
  exposure: { ev100: number; exposureScale: number } | null;
  /** An exponential height fog the scene carries (PRD-643), `null` or absent when it has none. */
  fog?: ISceneFog | null;
  /** `sun`: a template-lit scene's poses run once per sun, named `<sun>-<pose>` (PRD-649). */
  poses: { name: string; position: Vec3; target: Vec3; hfovDeg: number; sun?: string }[];
  /** A template-lit scene: Unreal's default level, one level per sun. */
  template?: "default";
  suns?: { name: string; elevationDeg: number; azimuthDeg: number }[];
  /** PRD-638 motion runs, as authored in scene.py (`pan`, `switch`): a Level Sequence per run. */
  motion?: Record<string, IMotionRun>;
  regions: Record<string, Vec3>;
}
interface IGltf {
  nodes?: {
    name?: string;
    mesh?: number;
    children?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
  }[];
  meshes?: { primitives: { material?: number }[] }[];
  materials?: {
    name?: string;
    pbrMetallicRoughness?: {
      baseColorFactor?: number[];
      baseColorTexture?: { index: number };
      metallicFactor?: number;
      roughnessFactor?: number;
    };
    emissiveFactor?: number[];
    alphaMode?: string;
    alphaCutoff?: number;
    doubleSided?: boolean;
    /** KHR_materials_emissive_strength: the glTF exporter splits an emissive above 1 into factor and strength. */
    extensions?: { KHR_materials_emissive_strength?: { emissiveStrength?: number } };
  }[];
}
interface IVariant {
  name: string;
  /** The scenes that capture this variant by default; every scene when absent (wildwood's L6 to L8, PRD-651). */
  only?: string[];
  layer: string;
  level?: string;
  /** A motion run captures the variants that say so when --variants is not given. */
  motion?: boolean;
  /** Only a motion run captures it by default: it holds no pose frames. */
  motionOnly?: boolean;
  cvars: Record<string, number>;
  expect: Record<string, number>;
  kinds: ("png" | "exr")[];
}
export interface IRegistry {
  resolution: [number, number];
  /** `scene`: a scene of another family this entry reuses, authored once (`gi:foliage`). */
  /** `manifest`: the scene places real assets from this manifest.json instead of exporting a scene.glb (PRD-651). */
  scenes: { name: string; owner: string; poses: string[]; scene?: string; manifest?: string }[];
  variants: IVariant[];
}
interface ILayer {
  name: string;
  cvars: Record<string, number>;
}

function fail(code: string, message: string): never {
  throw new Error(`TN_UNREAL_LOOK_${code}: ${message}`);
}

/** The family a `--scene` value names: `gi`, `gi:a`, `shadow`, `shadow:a,shadow:b`. One per run. */
export function familyOf(value: string): string {
  const families = new Set(value.split(",").map((s) => s.split(":")[0] ?? ""));
  const [family] = [...families];
  if (families.size !== 1 || family === undefined || !(family in FAMILIES))
    fail("BAD_INPUT", `--scene ${value}: one family of ${Object.keys(FAMILIES).join(", ")}`);
  return family;
}

/** A scene id's folder: `cornell` (a GI scene) or `shadow:<name>`. */
export function sceneDir(id: string): string {
  const [family, name] = id.includes(":") ? id.split(":") : ["gi", id];
  return path.join(FAMILIES[family ?? ""] ?? fail("BAD_INPUT", `scene ${id}`), name ?? "");
}

/** A scene id's folder under captures/<engine>/: `cornell`, or `shadow/<name>`. */
export function sceneKey(id: string): string {
  return id.replace(/^gi:/, "").replace(":", "/");
}

export function registry(family = "gi"): IRegistry {
  const dir = FAMILIES[family] ?? fail("BAD_INPUT", `scene family ${family}`);
  const reg = JSON.parse(readFileSync(path.join(dir, "scenes.json"), "utf8")) as IRegistry;
  if (family === "shadow") {
    const layers = JSON.parse(readFileSync(path.join(REFERENCE, "layers.json"), "utf8")) as {
      layers: ILayer[];
    };
    validateShadowRegistry(reg, dir, layers.layers);
  }
  return reg;
}

/** A variant limited to scenes (`only`) names scenes the registry has. */
function checkVariantScenes(reg: IRegistry): void {
  for (const variant of reg.variants)
    for (const name of variant.only ?? [])
      if (!reg.scenes.some((scene) => scene.name === name))
        fail("BAD_INPUT", `variant ${variant.name} is limited to ${name}, which is not a scene`);
}

/**
 * PRD-649, fail closed: every shadow scene has the judge's criteria.md, and an L5 shadow cell renders
 * with GI and AO off, so neither can hide or add a shadow.
 */
export function validateShadowRegistry(
  reg: IRegistry,
  dir: string,
  layers: readonly ILayer[],
): void {
  for (const scene of reg.scenes)
    if (!existsSync(path.join(dir, scene.name, "criteria.md")))
      fail("BAD_INPUT", `shadow scene ${scene.name} has no criteria.md`);
  checkVariantScenes(reg);
  for (const variant of reg.variants.filter((v) => v.layer === "L5")) {
    const layer = layers.find((l) => l.name === "L5") ?? fail("BAD_INPUT", "layers.json has no L5");
    const cvars = { ...layer.cvars, ...variant.cvars };
    for (const name of ["r.DynamicGlobalIlluminationMethod", "r.AmbientOcclusionLevels"])
      if (cvars[name] !== 0)
        fail("BAD_INPUT", `shadow variant ${variant.name}: ${name} ${cvars[name]} must be 0 at L5`);
  }
}

/**
 * `gi` selects every registered GI scene, `gi:a,gi:b` the named ones; the same for `shadow`. A GI scene
 * keeps its bare name, a shadow scene comes back as `shadow:<name>`.
 */
export function sceneNames(value: string, known: readonly string[]): string[] {
  const family = familyOf(value);
  const names =
    value === family ? [...known] : value.split(",").map((s) => s.slice(family.length + 1));
  for (const name of names)
    if (!known.includes(name))
      fail(
        "BAD_INPUT",
        `unknown ${family === "gi" ? "GI" : family} scene ${name} (${family}/scenes.json)`,
      );
  if (!names.length) fail("BAD_INPUT", "--scene selects no scene");
  if (family === "gi") return names;
  // An entry that reuses a scene of another family resolves to that scene (`gi:foliage` -> `foliage`).
  const reused = new Map(registry(family).scenes.map((s) => [s.name, s.scene]));
  return names.map((name) => reused.get(name)?.replace(/^gi:/, "") ?? `${family}:${name}`);
}

/** The JSON chunk of a binary glTF. */
export function readGlbJson(bytes: Uint8Array): IGltf {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67)
    fail("SCENE_EXPORT", "scene.glb is not a binary glTF");
  const length = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a) fail("SCENE_EXPORT", "scene.glb has no JSON chunk");
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + length))) as IGltf;
}

const LIGHT_UNITS: Record<string, readonly string[]> = {
  PointLight: ["lumens", "candelas"],
  SpotLight: ["lumens", "candelas"],
  RectLight: ["lumens", "candelas", "nits"],
};

/** The quaternion [x, y, z, w] of Ry(turnDeg) * Rx(tiltDeg): turn the tilted mesh about the vertical. */
export function tiltThenTurn(tiltDeg: number, turnDeg: number): number[] {
  const [sx = 0, cx = 1] = [
    Math.sin((tiltDeg * Math.PI) / 360),
    Math.cos((tiltDeg * Math.PI) / 360),
  ];
  const [sy = 0, cy = 1] = [
    Math.sin((turnDeg * Math.PI) / 360),
    Math.cos((turnDeg * Math.PI) / 360),
  ];
  return [cy * sx, sy * cx, 0 - sy * sx, cy * cx];
}

/**
 * A masked, two-sided material (leaf cards) must arrive as glTF alphaMode MASK with its cutoff, both
 * sides and a base colour texture. Any other material must stay opaque.
 */
function maskedStateDiffers(
  want: ISceneMaterial,
  got: NonNullable<IGltf["materials"]>[number],
): boolean {
  const masked = want.alphaMode === "MASK";
  if ((got.alphaMode ?? "OPAQUE") !== (masked ? "MASK" : "OPAQUE")) return true;
  return (
    masked &&
    (Math.abs((got.alphaCutoff ?? 0.5) - (want.alphaCutoff ?? Number.NaN)) > 1e-3 ||
      (got.doubleSided ?? false) !== want.doubleSided ||
      got.pbrMetallicRoughness?.baseColorTexture === undefined ||
      want.texture === undefined)
  );
}

/**
 * A translucent material (PRD-643 glass) must arrive as glTF alphaMode BLEND whose base colour factor alpha is its
 * opacity. A material that is not translucent in scene.json must not arrive as BLEND.
 */
function translucentStateDiffers(
  want: ISceneMaterial,
  got: NonNullable<IGltf["materials"]>[number],
): boolean {
  const blend = want.alphaMode === "BLEND";
  if ((got.alphaMode === "BLEND") !== blend) return true;
  return (
    blend &&
    Math.abs((got.pbrMetallicRoughness?.baseColorFactor?.[3] ?? 1) - (want.opacity ?? Number.NaN)) >
      1e-3
  );
}

function near(a: readonly number[], b: readonly number[], tolerance: number): boolean {
  return (
    a.length === b.length && a.every((v, i) => Math.abs(v - (b[i] ?? Number.NaN)) <= tolerance)
  );
}

/**
 * scene.json is the authority for what glTF loses; scene.glb for geometry and materials. They must
 * describe the same actors, or a recreation (PRD-646) would light a scene Unreal never rendered.
 */
export function validateSceneExport(scene: ISceneJson, gltf: IGltf): void {
  const nodes = gltf.nodes ?? [];
  const byName = new Map(nodes.map((node, i) => [node.name, i]));
  const meshOf = (index: number): number | undefined => {
    const node = nodes[index];
    if (node === undefined) return undefined;
    if (node.mesh !== undefined) return node.mesh;
    for (const child of node.children ?? []) {
      const c = nodes[child];
      // A child with its own transform would move the mesh off the actor's place.
      if (c && (c.translation || c.rotation || c.scale) && c.mesh !== undefined)
        fail("SCENE_EXPORT", `${node.name}: mesh sits under a transformed child node`);
      const found = meshOf(child);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const exported = new Set<number>();
  for (const actor of scene.meshes) {
    const index = byName.get(actor.name);
    if (index === undefined)
      fail("SCENE_EXPORT", `${actor.name}: in scene.json, missing in scene.glb`);
    const node = nodes[index] ?? fail("SCENE_EXPORT", actor.name);
    if (!near(node.translation ?? [0, 0, 0], actor.position, 1e-3))
      fail("SCENE_EXPORT", `${actor.name}: position differs between scene.json and scene.glb`);
    // A tilt about +X (PRD-649's ramps), a turn about +Y, or both: the tilt first, then the turn.
    const q = node.rotation ?? [0, 0, 0, 1];
    const expected = tiltThenTurn(actor.rotationXDeg ?? 0, actor.rotationYDeg);
    if (
      !near(q, expected, 1e-3) &&
      !near(
        q.map((v) => -v),
        expected,
        1e-3,
      )
    )
      fail("SCENE_EXPORT", `${actor.name}: rotation differs between scene.json and scene.glb`);
    const mesh = meshOf(index);
    if (mesh === undefined) fail("SCENE_EXPORT", `${actor.name}: scene.glb node has no mesh`);
    exported.add(mesh);
    const materialIndex = gltf.meshes?.[mesh]?.primitives[0]?.material;
    const material = materialIndex === undefined ? undefined : gltf.materials?.[materialIndex];
    if (material === undefined)
      fail("SCENE_EXPORT", `${actor.name}: scene.glb mesh has no material`);
    // glTF defaults (2.0 spec, section 5.19) for factors the exporter leaves out.
    const pbr = material.pbrMetallicRoughness ?? {};
    const want = actor.material;
    // The albedo texture is checked both ways: a texture one file names and the other lacks is a different scene.
    // scene.json names it as `baseColorTexture` (PRD-639) or, on a masked material, as `texture` (PRD-651); the
    // masked-state check below holds a masked material to its texture.
    if (want.baseColorTexture !== undefined && pbr.baseColorTexture === undefined)
      fail(
        "SCENE_EXPORT",
        `${actor.name}: scene.json names the texture ${want.baseColorTexture}, scene.glb has none`,
      );
    if (
      want.baseColorTexture === undefined &&
      want.texture === undefined &&
      pbr.baseColorTexture !== undefined
    )
      fail(
        "SCENE_EXPORT",
        `${actor.name}: scene.glb textures the material, scene.json does not name a texture`,
      );
    if (
      !near((pbr.baseColorFactor ?? [1, 1, 1, 1]).slice(0, 3), want.baseColor, 1e-3) ||
      Math.abs((pbr.roughnessFactor ?? 1) - want.roughness) > 1e-3 ||
      Math.abs((pbr.metallicFactor ?? 1) - want.metallic) > 1e-3 ||
      !near(
        (material.emissiveFactor ?? [0, 0, 0]).map(
          (c) => c * (material.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1),
        ),
        want.emissive.map((c) => c * want.emissiveStrength),
        1e-3 * Math.max(1, want.emissiveStrength),
      )
    )
      fail(
        "SCENE_EXPORT",
        `${actor.name}: material ${want.name} differs between scene.json and scene.glb`,
      );
    if (translucentStateDiffers(want, material))
      fail(
        "SCENE_EXPORT",
        `${actor.name}: translucent state of material ${want.name} differs between scene.json and scene.glb`,
      );
    if (want.alphaMode !== "BLEND" && maskedStateDiffers(want, material))
      fail(
        "SCENE_EXPORT",
        `${actor.name}: masked state of material ${want.name} differs between scene.json and scene.glb`,
      );
  }
  nodes.forEach((node, i) => {
    if (node.mesh !== undefined && !exported.has(node.mesh))
      fail("SCENE_EXPORT", `${node.name ?? `node ${i}`}: in scene.glb, missing in scene.json`);
  });
  for (const light of scene.lights) {
    const units = LIGHT_UNITS[light.class];
    if (units === undefined)
      fail("SCENE_EXPORT", `${light.name}: unknown light class ${light.class}`);
    if (!units.includes(light.units))
      fail("SCENE_EXPORT", `${light.name}: intensity has no unit a ${light.class} takes`);
    if (!(light.intensity > 0) || !(light.attenuationRadiusM > 0))
      fail("SCENE_EXPORT", `${light.name}: intensity and attenuation radius must be positive`);
    if (
      light.class === "SpotLight" &&
      !(
        light.target &&
        (light.innerConeDeg ?? -1) >= 0 &&
        (light.outerConeDeg ?? 0) > (light.innerConeDeg ?? 0)
      )
    )
      fail(
        "SCENE_EXPORT",
        `${light.name}: a spot light needs a target and 0 <= inner < outer cone`,
      );
  }
  const fog = scene.fog;
  if (fog) {
    if (!(fog.density > 0) || !(fog.volumetricExtinctionScale > 0))
      fail("SCENE_EXPORT", `${scene.scene}: fog density and extinction scale must be positive`);
    if (!fog.volumetricAlbedo.every((c) => c >= 0 && c <= 1))
      fail("SCENE_EXPORT", `${scene.scene}: fog albedo must lie in 0 to 1`);
  }
  // A template-lit scene (PRD-649) keeps the default level's exposure, as the PRD-631 reference does.
  if (scene.template !== "default" && (!scene.exposure || !Number.isFinite(scene.exposure.ev100)))
    fail("SCENE_EXPORT", `${scene.scene}: no fixed EV100`);
  // A mesh is in the region it names (default: its own name). Cards share one: Leaves, Grass.
  const colors = Object.values(scene.regions).map((c) => c.join(","));
  const used = [...new Set(scene.meshes.map((m) => m.region ?? m.name))];
  if (
    Object.keys(scene.regions).sort().join() !== used.sort().join() ||
    new Set(colors).size !== colors.length
  )
    fail(
      "SCENE_EXPORT",
      `${scene.scene}: regions must be the regions of the meshes, each in its own colour`,
    );
  if (scene.motion) validateMotion(scene.motion, scene);
}

/**
 * A scene that places real assets from a manifest (PRD-651 wildwood) has no scene.glb: the files are
 * licensed Fab art that both engines read from the asset root, so none is committed.
 */
export function isManifestScene(name: string): boolean {
  return existsSync(path.join(sceneDir(name), "manifest.json"));
}

export function readScene(name: string): { scene: ISceneJson; gltf: IGltf } {
  const dir = sceneDir(name);
  const manifest = isManifestScene(name);
  for (const file of manifest ? ["scene.json"] : ["scene.json", "scene.glb"])
    if (!existsSync(path.join(dir, file))) fail("SCENE_EXPORT", `${name}: ${file} was not written`);
  return {
    scene: JSON.parse(readFileSync(path.join(dir, "scene.json"), "utf8")) as ISceneJson,
    gltf: manifest ? {} : readGlbJson(readFileSync(path.join(dir, "scene.glb"))),
  };
}

/** The exported scene against what it was authored from: scene.glb for a modelled scene, the manifest and files for wildwood. */
function validateScene(name: string, scene: ISceneJson, gltf: IGltf): void {
  if (!isManifestScene(name)) {
    validateSceneExport(scene, gltf);
    return;
  }
  const manifest = readManifest(sceneDir(name));
  validateWildwoodScene(
    scene as unknown as Parameters<typeof validateWildwoodScene>[0],
    manifest,
    verifyAssets(manifest, assetRoot()),
  );
}

/**
 * The values the job start commands printed: `r.Name = "1"` lines, once per job. Every job must
 * print every expected variable with its expected value.
 */
export function checkReadback(log: string, expect: Record<string, number>, jobs: number): string[] {
  const problems: string[] = [];
  for (const [name, value] of Object.entries(expect)) {
    const escaped = name.replace(/\./g, "\\.");
    const seen = [...log.matchAll(new RegExp(`${escaped} = "([^"]*)"`, "g"))].map((m) =>
      Number(m[1]),
    );
    if (seen.length < jobs) problems.push(`${name} printed ${seen.length}/${jobs} times`);
    const wrong = seen.filter((v) => v !== value);
    if (wrong.length) problems.push(`${name} = ${wrong.join(",")} (expected ${value})`);
  }
  return problems;
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

/** Warm-up frames of the reference capture: Lumen has converged by here (180 against 360 and 720 sit inside the noise floor). */
export const REFERENCE_WARM_UP = 180;

export function folderName(variant: string, warmUp: number, run: number): string {
  return `${variant}${warmUp === REFERENCE_WARM_UP ? "" : `@${warmUp}`}${run === 1 ? "" : `#${run}`}`;
}

type RunUnreal = (mode: string, out: string, env?: Record<string, string>) => Promise<number>;

/** Builds one scene's Unreal levels and writes its scene.json; the editor's exit code. */
async function buildScene(
  name: string,
  content: string,
  out: string,
  runUnreal: RunUnreal,
): Promise<number> {
  // A scene of real assets is verified and decoded for Unreal's importer before anything is removed (PRD-651).
  const assets = isManifestScene(name)
    ? await prepareUnrealAssets(
        sceneDir(name),
        process.env.TN_UNREAL_LOOK_WORK ??
          path.join(os.homedir(), ".cache/threenative/unreal-look"),
      )
    : {};
  await rm(content, { recursive: true, force: true });
  const code = await runUnreal("build", out, { TN_UE_SCENE: name, ...assets });
  if (code !== 0) return code;
  // A build whose Python failed exits 0 and leaves its Content: remove it, or the next run skips it.
  if (!existsSync(path.join(sceneDir(name), "scene.json"))) {
    await rm(content, { recursive: true, force: true });
    fail("SCENE_EXPORT", `${name}: the build wrote no scene.json (see the editor log)`);
  }
  // The exported scene.json is committed: give it the repo's JSON format.
  // Relative: Biome skips an absolute path that runs through a .claude/ worktree.
  const file = path.relative(REPO_ROOT, path.join(sceneDir(name), "scene.json"));
  spawnSync("pnpm", ["exec", "biome", "format", "--write", file], {
    cwd: REPO_ROOT,
    stdio: "ignore",
  });
  return 0;
}

export async function captureGi(args: readonly string[], runUnreal: RunUnreal): Promise<number> {
  const value = flag(args, "--scene") ?? "gi";
  const family = familyOf(value);
  const reg = registry(family);
  const scenes = sceneNames(
    value,
    reg.scenes.map((s) => s.name),
  );
  const only = flag(args, "--variants")?.split(",");
  const motion = flag(args, "--motion");
  // A motion run takes the variants that say `motion` and the `motionOnly` ones; a scene's `only` list still applies.
  const variantsOf = (scene: string) =>
    reg.variants.filter((v) =>
      only
        ? only.includes(v.name)
        : (motion !== undefined || !v.motionOnly) &&
          (!v.only || v.only.includes(scene.replace(/^.*:/, ""))),
    );
  if (only && reg.variants.filter((v) => only.includes(v.name)).length !== only.length)
    fail("BAD_INPUT", `unknown variant in ${only}`);
  const warmUps = (flag(args, "--warm-up") ?? String(REFERENCE_WARM_UP)).split(",").map(Number);
  if (!warmUps.every((w) => Number.isInteger(w) && w > 0)) fail("BAD_INPUT", "--warm-up");
  const runs = Number(flag(args, "--runs") ?? 1);
  const out = path.resolve(flag(args, "--out") ?? path.join(REFERENCE, "captures", "unreal"));

  if (args.includes("--check-cvars")) {
    const extra = [
      ...new Set(
        scenes
          .flatMap(variantsOf)
          .flatMap((v) => [...Object.keys(v.cvars), ...Object.keys(v.expect)]),
      ),
    ];
    if ((await runUnreal("check-cvars", out, { TN_UE_EXTRA_CVARS: extra.join(",") })) !== 0)
      return 1;
  }
  let cells = 0;
  for (const name of scenes) {
    const content = path.join(
      REFERENCE,
      "Content",
      family === "gi" ? "GI" : "Shadow",
      sceneKey(name).replace(/^shadow\//, ""),
    );
    // A level built before the motion runs existed has no sequence for them.
    const stale =
      motion !== undefined &&
      !existsSync(path.join(content, "Sequences", `Seq_motion_${motion}.uasset`));
    if (args.includes("--rebuild") || !existsSync(content) || stale)
      if ((await buildScene(name, content, out, runUnreal)) !== 0) return 1;
    const { scene, gltf } = readScene(name);
    validateScene(name, scene, gltf);
    if (motion !== undefined) {
      const chosen = only ? variantsOf(name) : variantsOf(name).filter((v) => v.motion);
      const input = { name, scene, variants: chosen, out, warmUps, runs, motion, log: LOG };
      const done = await captureMotionRun(input, runUnreal);
      if (done < 0) return 1;
      cells += done;
      continue;
    }
    for (const variant of variantsOf(name))
      for (const warmUp of variant.name === "ID" ? [REFERENCE_WARM_UP] : warmUps)
        for (let run = 1; run <= (variant.name === "ID" ? 1 : runs); run++) {
          const env = {
            TN_UE_SCENE: name,
            TN_UE_VARIANT: variant.name,
            TN_UE_WARMUP: String(warmUp),
            TN_UE_RUN: String(run),
          };
          if ((await runUnreal("capture", out, env)) !== 0) return 1;
          const jobs = scene.poses.length * variant.kinds.length;
          const problems = checkReadback(readFileSync(LOG, "utf8"), variant.expect, jobs);
          const folder = path.join(out, sceneKey(name), folderName(variant.name, warmUp, run));
          for (const pose of scene.poses)
            for (const kind of variant.kinds)
              if (!existsSync(path.join(folder, `${pose.name}.${kind}`)))
                problems.push(`missing ${pose.name}.${kind}`);
          if (problems.length)
            fail("GI_READBACK", `${name} ${variant.name}: ${problems.join("; ")}`);
          console.info(
            `TN_UNREAL_LOOK gi ${name} ${path.basename(folder)} cells=${jobs} readback ok`,
          );
          cells += jobs;
        }
  }
  console.info(`TN_UNREAL_LOOK gi cells=${cells} out=${out}`);
  return 0;
}

// --- compare -----------------------------------------------------------------------------
function image(file: string): IImage {
  if (!existsSync(file)) fail("MISSING_CELL", file);
  return decode(readFileSync(file), file.endsWith(".exr") ? "exr" : "png");
}

/** Per region of one pose: the PRD-631 statistics, with scene-linear EV from the EXR. */
export function regionStats(
  folder: string,
  pose: string,
  regionMasks: ReturnType<typeof masks>,
): Record<string, IStats> {
  const png = image(path.join(folder, `${pose}.png`));
  const exr = existsSync(path.join(folder, `${pose}.exr`))
    ? image(path.join(folder, `${pose}.exr`))
    : undefined;
  const stats: Record<string, IStats> = {};
  for (const [region, mask] of Object.entries(regionMasks.regions))
    if (region !== "Sky" && mask.some(Boolean)) stats[region] = measure(png, mask, exr);
  return stats;
}

/** Relative change of the scene-linear median: 2^|dEV50| - 1, so 0.01 is a 1% change. */
export function relativeChange(a: IStats, b: IStats): number {
  if (a.ev50 === null || b.ev50 === null) fail("BAD_INPUT", "region has no scene-linear EXR");
  return 2 ** Math.abs(b.ev50 - a.ev50) - 1;
}

/** The committed Unreal statistics of a scene (`--write-stats`): the stand-in for its captures when they are absent. */
function readStatsFile(name: string): { cells: Record<string, Record<string, IStats>> } {
  const file = path.join(sceneDir(name), "reference-stats.json");
  if (!existsSync(file))
    fail(
      "MISSING_CELL",
      `${name}: no Unreal captures and no ${file} (run capture, then compare --write-stats)`,
    );
  const data = JSON.parse(readFileSync(file, "utf8")) as { cells?: unknown };
  if (!data.cells || typeof data.cells !== "object" || !Object.keys(data.cells).length)
    fail("BAD_INPUT", `${file}: no cells`);
  return data as { cells: Record<string, Record<string, IStats>> };
}

/** The Unreal variant each ThreeNative layer is judged against (capture-gi-threenative.ts). */
const UNREAL_VARIANT: Readonly<Record<string, string>> = {
  L1: "L1",
  L6: "L7-Low",
  L7: "L7-Epic",
  // Reflections on, no post: the Unreal variant of the same layer (PRD-642).
  L8: "L8",
  // A quality tier names the Unreal level it follows (scaffold/render/quality.ts, PRD-644).
  "L7-low": "L7-Low",
  "L7-medium": "L7-Medium",
  "L7-high": "L7-Epic",
  L9: "L9-Epic",
};

/** The Unreal variant that shows one lighting term of a variant, by `GIVisualize` mode (PRD-646). */
const VISUALIZE_VARIANT: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  indirectDiffuse: { "L7-Epic": "L7-Epic-indirect" },
};

/** `sg.GlobalIlluminationQuality` of the GI variants a calibration scene is captured at in Unreal. */
const UNREAL_LEVEL_VARIANT: Readonly<Record<number, string>> = {
  0: "L7-Low",
  1: "L7-Medium",
  3: "L7-Epic",
};

/**
 * The Unreal variant a ThreeNative layer is judged against. `unrealLevel` (0 Low, 1 Medium, 3 Epic)
 * overrides the layer's own pair, to hold one capture against another level's frame.
 */
export function unrealVariant(layer: string, unrealLevel?: number, visualize?: string): string {
  const beauty =
    unrealLevel !== undefined
      ? (UNREAL_LEVEL_VARIANT[unrealLevel] ?? fail("BAD_INPUT", `unreal level ${unrealLevel}`))
      : (UNREAL_VARIANT[layer] ?? fail("BAD_INPUT", `GI layer ${layer}`));
  if (visualize === undefined) return beauty;
  // Unreal's diagnosis frames (PRD-646 AC-3): `r.Lumen.Visualize.IndirectDiffuse 1` at the Epic level only.
  const pair = VISUALIZE_VARIANT[visualize]?.[beauty];
  if (pair === undefined)
    fail(
      "BAD_INPUT",
      `no Unreal ${visualize} frame for ${beauty} (known: ${Object.keys(VISUALIZE_VARIANT).join(", ")})`,
    );
  return pair;
}

/** tools/unreal-reference/thresholds.json (PRD-631), or null when the file is absent. */
export function readThresholds(): IThresholdFile | null {
  const file = path.join(REFERENCE, "thresholds.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as IThresholdFile) : null;
}

/**
 * A row's verdict: it passes only when its layer sets a limit on the light (deltaE and dP50) and every limit holds.
 * A row with no such limit fails, it does not report: a layer missing from the file, or a file with only the edge limit,
 * would otherwise let any frame through.
 */
function verdict(row: IRow, limits: IThresholds | undefined): boolean {
  const lightLimited = limits?.deltaE !== undefined && limits.dP50 !== undefined;
  return lightLimited && passes(row, limits) === true;
}

/**
 * ThreeNative against Unreal for one scene: region statistics of every (layer, pose), with the
 * Unreal ID frame as the mask and the IoU of the two ID frames per region. A row is judged against the limits of its
 * layer in tools/unreal-reference/thresholds.json (PRD-631, `thresholdFile`) and fails when it has none. The shadow
 * scenes take the same path, so both families get per-layer limits.
 */
export function compareGiToUnreal(
  name: string,
  layers: readonly string[],
  root: string | { unreal: string; threenative: string },
  unrealLevel?: number,
  thresholdFile: IThresholdFile | null = readThresholds(),
  visualize?: string,
): IRow[] {
  const { scene } = readScene(name);
  // A string is a captures root (`unreal/` and `threenative/` inside it); the pair names each engine's own root.
  const roots =
    typeof root === "string"
      ? { unreal: path.join(root, "unreal"), threenative: path.join(root, "threenative") }
      : root;
  const unreal = path.join(roots.unreal, sceneKey(name));
  const tn = path.join(roots.threenative, sceneKey(name));
  // Without Unreal captures the committed statistics and ID frames stand in for them (PRD-638 AC-2).
  const offline = !existsSync(unreal);
  const cached = offline ? readStatsFile(name) : undefined;
  const rows: IRow[] = [];
  for (const layer of layers) {
    // A shadow scene names its Unreal variants after their layers (shadow/scenes.json).
    const variant = name.startsWith("shadow:")
      ? layer
      : unrealVariant(layer, unrealLevel, visualize);
    // A quality tier (`L7-high`, `L5-Low`) is judged by the limits of its ladder layer.
    const [ladder = layer] = layer.split("-");
    const limits = layerThresholds(thresholdFile, ladder);
    for (const pose of scene.poses) {
      const own = masks(image(path.join(tn, "ID", `${pose.name}.png`)), scene.regions);
      const reference = masks(
        image(
          offline
            ? path.join(sceneDir(name), "id", `${pose.name}.png`)
            : path.join(unreal, "ID", `${pose.name}.png`),
        ),
        scene.regions,
      );
      const statsCell = cached?.cells[`${variant}/${pose.name}`];
      const regions = Object.keys(reference.regions).filter(
        (r) =>
          r !== "Sky" &&
          reference.regions[r]?.some(Boolean) &&
          (statsCell === undefined || statsCell[r] !== undefined),
      );
      const exr = path.join(unreal, variant, `${pose.name}.exr`);
      const cell = compareCells({
        layer,
        cell: `${name}/${pose.name}`,
        ...(cached
          ? {
              reference:
                cached.cells[`${variant}/${pose.name}`] ??
                fail(
                  "MISSING_CELL",
                  `${name}: reference-stats.json has no ${variant}/${pose.name}`,
                ),
            }
          : { unreal: image(path.join(unreal, variant, `${pose.name}.png`)) }),
        threenative: image(path.join(tn, layer, `${pose.name}.png`)),
        masks: reference,
        regions,
        ...(!offline && existsSync(exr) ? { unrealExr: image(exr) } : {}),
        ...(limits ? { thresholds: limits } : {}),
      });
      for (const row of cell) {
        const a = reference.regions[row.region];
        const b = own.regions[row.region];
        row.iou = a && b ? iou(a, b) : 0;
        // The edge limit needs the IoU, which is measured here, so the verdict is read again with it.
        // A diagnosis term has no limits: its rows are reported, and the gap list reads them (PRD-646 AC-3).
        row.pass = visualize === undefined ? verdict(row, limits) : null;
      }
      rows.push(...cell);
    }
  }
  return rows;
}

/** Cells whose lamp has a source radius: the edge is tens of pixels wide, so it reads at this scale (PRD-650). */
const WIDE_PENUMBRA: Record<string, number> = { "shadow:lamp-room/spot-soft": 2.5 };

export interface IPenumbraRow {
  readonly layer: string;
  readonly cell: string;
  /** Floor rows where both frames hold a shadow edge. */
  readonly matched: number;
  readonly unrealPx: number;
  readonly threenativePx: number;
  /** ThreeNative edge width over Unreal's: PRD-634 holds it within 1.25. */
  readonly ratio: number;
}

/**
 * Shadow-edge width of a ThreeNative layer against its Unreal variant on the Floor region
 * (PRD-634, PRD-649, PRD-652): the metric `--metric penumbra` prints for a calibration scene. A wide
 * lamp edge reads at its own scale (`WIDE_PENUMBRA`). A cell with no edge in both frames has no row.
 */
export function penumbraRows(
  name: string,
  layers: readonly string[],
  root: string,
  unrealLevel?: number,
): IPenumbraRow[] {
  const { scene } = readScene(name);
  const unreal = path.join(root, "unreal", sceneKey(name));
  const tn = path.join(root, "threenative", sceneKey(name));
  const rows: IPenumbraRow[] = [];
  for (const layer of layers) {
    const variant = name.startsWith("shadow:") ? layer : unrealVariant(layer, unrealLevel);
    for (const pose of scene.poses) {
      const floor = masks(image(path.join(unreal, "ID", `${pose.name}.png`)), scene.regions).regions
        .Floor;
      if (floor === undefined) fail("BAD_INPUT", `${name} has no Floor region`);
      const frames = [path.join(unreal, variant), path.join(tn, layer)].map((folder) =>
        image(path.join(folder, `${pose.name}.png`)),
      );
      const [a, b] = frames as [IImage, IImage];
      if (a.width !== b.width || a.height !== b.height)
        fail("SIZE_MISMATCH", `${name}/${pose.name}: ${layer} and ${variant} differ in size`);
      const m = pairedPenumbra(a, b, floor, WIDE_PENUMBRA[`${name}/${pose.name}`]);
      if (m)
        rows.push({
          layer,
          cell: `${name}/${pose.name}`,
          matched: m.matched,
          unrealPx: m.unreal,
          threenativePx: m.other,
          ratio: m.ratio,
        });
    }
  }
  return rows;
}

/** Lit floor between each box and its own shadow, per pose and arm, in pixel rows (PRD-649). */
export function contactRows(
  name: string,
  layer: string,
  root: string,
): { cell: string; box: string; unreal: number | undefined; other: number | undefined }[] {
  const { scene } = readScene(name);
  const unreal = path.join(root, "unreal", sceneKey(name));
  const tn = path.join(root, "threenative", sceneKey(name));
  const variant = name.startsWith("shadow:") ? layer : (UNREAL_VARIANT[layer] ?? layer);
  const gap = (dir: string, shade: string, pose: string, box: string) => {
    // An arm that is not captured yet reads as no value, not as a failure.
    if (!existsSync(path.join(dir, shade, `${pose}.png`))) return undefined;
    const id = masks(image(path.join(dir, "ID", `${pose}.png`)), scene.regions);
    const caster = id.regions[box];
    const floor = id.regions.Floor;
    if (!caster || !floor || !caster.some(Boolean)) return undefined;
    const shaded = image(path.join(dir, shade, `${pose}.png`));
    return contactGap(
      linearLuminance(shaded.data, shaded.width * shaded.height),
      shaded.width,
      shaded.height,
      caster,
      floor,
    );
  };
  const rows = [];
  for (const pose of scene.poses)
    for (const box of Object.keys(scene.regions).filter((r) => r.startsWith("Box_"))) {
      const ue = gap(unreal, variant, pose.name, box);
      if (ue === undefined) continue;
      rows.push({
        cell: `${name}/${pose.name}`,
        box,
        unreal: ue,
        other: gap(tn, layer, pose.name, box),
      });
    }
  return rows;
}

export interface IBlotchRow {
  layer: string;
  cell: string;
  region: string;
  unreal: IBlotchBands;
  threenative: IBlotchBands;
  /** ThreeNative blotch over Unreal's. */
  ratio: number;
  pass: boolean;
}

/**
 * Soft blotches of every region of a ThreeNative layer against its Unreal variant (PRD-641): the metric
 * `--metric blotch` prints. Both arms read the same pixels, the region of the Unreal ID frame, so the
 * ratio is the comparison. The regions are `only`, or the walls and ceilings (`isFlatRegion`). A region
 * too small to measure in either arm has no row.
 */
export function blotchRows(
  name: string,
  layers: readonly string[],
  root: string,
  unrealLevel?: number,
  only?: readonly string[],
): IBlotchRow[] {
  const { scene } = readScene(name);
  const unreal = path.join(root, "unreal", sceneKey(name));
  const tn = path.join(root, "threenative", sceneKey(name));
  const rows: IBlotchRow[] = [];
  for (const layer of layers)
    for (const pose of scene.poses) {
      const id = masks(image(path.join(unreal, "ID", `${pose.name}.png`)), scene.regions);
      const [a, b] = [
        path.join(unreal, unrealVariant(layer, unrealLevel)),
        path.join(tn, layer),
      ].map((folder) => image(path.join(folder, `${pose.name}.png`))) as [IImage, IImage];
      if (a.width !== b.width || a.height !== b.height)
        fail(
          "SIZE_MISMATCH",
          `${name}/${pose.name}: ${layer} and its Unreal variant differ in size`,
        );
      const [lumaA, lumaB] = [displayLuma(a), displayLuma(b)];
      for (const [region, mask] of Object.entries(id.regions)) {
        if (only === undefined ? !isFlatRegion(region) : !only.includes(region)) continue;
        const u = blotchBands(lumaA, a.width, a.height, mask);
        const t = blotchBands(lumaB, b.width, b.height, mask);
        if (u && t)
          rows.push({
            layer,
            cell: `${name}/${pose.name}`,
            region,
            unreal: u,
            threenative: t,
            ...blotchVerdict(t, u),
          });
      }
    }
  return rows;
}

/** Prints the `--metric blotch` table and returns 1 when any region is blotchier than PRD-641 allows, or none was measured. */
function printBlotch(
  names: readonly string[],
  layers: readonly string[],
  root: string,
  unrealLevel: number | undefined,
  only: readonly string[] | undefined,
): number {
  const pct = (v: number) => `${(v * 100).toFixed(2)}%`;
  const rows = names.flatMap((name) => blotchRows(name, layers, root, unrealLevel, only));
  console.log(
    `| layer | cell | region | Unreal blotch | TN blotch | TN / Unreal | Unreal grain | TN grain | verdict |\n|---|---|---|---:|---:|---:|---:|---:|---|\n${rows
      .map(
        (r) =>
          `| ${r.layer} | ${r.cell} | ${r.region} | ${pct(r.unreal.blotch)} | ${pct(r.threenative.blotch)} | ${r.ratio.toFixed(2)} | ${pct(r.unreal.grain)} | ${pct(r.threenative.grain)} | ${r.pass ? "PASS" : "FAIL"} |`,
      )
      .join("\n")}`,
  );
  if (rows.length === 0)
    fail("BAD_INPUT", "no region is large enough to measure: an empty set proves nothing");
  return rows.some((r) => !r.pass) ? 1 : 0;
}

/** Prints the `--metric penumbra` table and returns 1 when any edge is wider than PRD-634 allows. */
function printPenumbra(
  names: readonly string[],
  layers: readonly string[],
  root: string,
  unrealLevel: number | undefined,
): number {
  const f2 = (v: number) => v.toFixed(2);
  const rows = names.flatMap((name) => penumbraRows(name, layers, root, unrealLevel));
  console.log(
    `| layer | cell | edges | Unreal px | TN px | TN / Unreal |\n|---|---|---:|---:|---:|---:|\n${rows
      .map(
        (r) =>
          `| ${r.layer} | ${r.cell} | ${r.matched} | ${f2(r.unrealPx)} | ${f2(r.threenativePx)} | ${f2(r.ratio)} |`,
      )
      .join("\n")}`,
  );
  return rows.some((r) => r.ratio > 1.25) ? 1 : 0;
}

export function compareGi(args: readonly string[]): number {
  if (flag(args, "--metric") === "motion") return compareMotion(args);
  const layerFlag = flag(args, "--layer");
  if (layerFlag !== undefined) {
    const root = path.resolve(flag(args, "--captures") ?? path.join(REFERENCE, "captures"));
    const value = flag(args, "--scene") ?? "gi";
    const names = sceneNames(
      value,
      registry(familyOf(value)).scenes.map((s) => s.name),
    );
    const levelFlag = flag(args, "--unreal-level");
    const unrealLevel = levelFlag === undefined ? undefined : Number(levelFlag);
    if (flag(args, "--metric") === "contact") {
      console.log("| cell | box | UE gap rows | TN gap rows |\n|---|---|---:|---:|");
      for (const name of names)
        for (const layer of layerFlag.split(","))
          for (const r of contactRows(name, layer, root))
            console.log(
              `| ${r.cell} ${layer} | ${r.box} | ${r.unreal ?? "—"} | ${r.other ?? "—"} |`,
            );
      return 0;
    }
    if (flag(args, "--metric") === "penumbra")
      return printPenumbra(names, layerFlag.split(","), root, unrealLevel);
    if (flag(args, "--metric") === "blotch")
      return printBlotch(
        names,
        layerFlag.split(","),
        root,
        unrealLevel,
        flag(args, "--regions")?.split(","),
      );
    const visualize = flag(args, "--visualize");
    const rows = names.flatMap((name) =>
      compareGiToUnreal(name, layerFlag.split(","), root, unrealLevel, undefined, visualize),
    );
    const f = (v: number | null, d = 3) => (v === null ? "—" : v.toFixed(d));
    console.log(
      `| layer | cell | region | Unreal p50 | TN p50 | dP50 | ΔE2000 | ID IoU | verdict |\n|---|---|---|---:|---:|---:|---:|---:|---|\n${rows
        .map(
          (r) =>
            `| ${r.layer} | ${r.cell} | ${r.region} | ${f(r.unreal?.p50 ?? null, 1)} | ${f(r.threenative?.p50 ?? null, 1)} | ${f(r.dP50)} | ${f(r.deltaE, 2)} | ${f(r.iou)} | ${r.pass === null ? "report" : r.pass ? "PASS" : "FAIL"} |`,
        )
        .join("\n")}`,
    );
    return rows.some((r) => r.pass === false) ? 1 : 0;
  }
  const value = flag(args, "--scene") ?? "gi";
  const reg = registry(familyOf(value));
  const scenes = sceneNames(
    value,
    reg.scenes.map((s) => s.name),
  );
  const root = path.resolve(flag(args, "--unreal") ?? path.join(REFERENCE, "captures", "unreal"));
  let failed = false;
  for (const name of scenes) {
    const { scene } = readScene(name);
    const base = path.join(root, sceneKey(name));
    const stats: Record<string, Record<string, IStats>> = {};
    const rows: string[] = [];
    let noiseFloor = 0;
    for (const pose of scene.poses) {
      const regionMasks = masks(image(path.join(base, "ID", `${pose.name}.png`)), scene.regions);
      for (const variant of reg.variants.filter((v) => v.name !== "ID")) {
        if (existsSync(path.join(base, variant.name, `${pose.name}.png`)))
          stats[`${variant.name}/${pose.name}`] = regionStats(
            path.join(base, variant.name),
            pose.name,
            regionMasks,
          );
      }
      if (!args.includes("--unreal-vs-unreal")) continue;
      // Convergence: the reference warm-up against twice as many frames. Noise floor: two runs at the reference warm-up.
      const longer = REFERENCE_WARM_UP * 2;
      const atReference = regionStats(path.join(base, "L7-Epic"), pose.name, regionMasks);
      const atLonger = regionStats(path.join(base, `L7-Epic@${longer}`), pose.name, regionMasks);
      const again = existsSync(path.join(base, "L7-Epic#2"))
        ? regionStats(path.join(base, "L7-Epic#2"), pose.name, regionMasks)
        : undefined;
      for (const [region, a] of Object.entries(atReference)) {
        const b = atLonger[region] ?? fail("EMPTY_MASK", `${region} missing at ${longer} frames`);
        const change = relativeChange(a, b);
        const noise = again?.[region] ? relativeChange(a, again[region]) : null;
        if (noise !== null) noiseFloor = Math.max(noiseFloor, noise);
        const pass = change < CONVERGENCE;
        failed ||= !pass;
        rows.push(
          `| ${name} | ${pose.name} | ${region} | ${a.ev50?.toFixed(3)} | ${b.ev50?.toFixed(3)} | ${(change * 100).toFixed(2)}% | ${noise === null ? "—" : `${(noise * 100).toFixed(2)}%`} | ${pass ? "PASS" : "FAIL"} |`,
        );
      }
    }
    if (rows.length) {
      console.log(
        `\n### ${name}: Lumen convergence, L7 Epic, ${REFERENCE_WARM_UP} vs ${REFERENCE_WARM_UP * 2} warm-up frames (limit ${CONVERGENCE * 100}%)\n\n| scene | pose | region | EV50 @${REFERENCE_WARM_UP} | EV50 @${REFERENCE_WARM_UP * 2} | change | run-to-run @${REFERENCE_WARM_UP} | verdict |\n|---|---|---|---:|---:|---:|---:|---|\n${rows.join("\n")}\n\nnoise floor (largest run-to-run change at ${REFERENCE_WARM_UP} frames): ${(noiseFloor * 100).toFixed(2)}%`,
      );
    }
    if (args.includes("--write-stats")) {
      if (!Object.keys(stats).length) fail("MISSING_CELL", `${name}: no captured variant`);
      // The ID frames are the region masks: a few kilobytes each, and what makes the offline compare exact.
      mkdirSync(path.join(sceneDir(name), "id"), { recursive: true });
      for (const pose of scene.poses)
        copyFileSync(
          path.join(base, "ID", `${pose.name}.png`),
          path.join(sceneDir(name), "id", `${pose.name}.png`),
        );
      writeFileSync(
        path.join(sceneDir(name), "reference-stats.json"),
        `${JSON.stringify({ generatedAt: new Date().toISOString(), scene: name, resolution: scene.resolution, cells: stats }, null, 2)}\n`,
      );
      console.log(`wrote gi/${name}/reference-stats.json cells=${Object.keys(stats).length}`);
    }
  }
  return failed ? 1 : 0;
}
