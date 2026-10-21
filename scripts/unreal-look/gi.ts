/**
 * PRD-638 GI calibration scenes: the TypeScript half of tools/unreal-reference/gi/.
 *
 *   pnpm unreal-look:capture --engine unreal --scene gi | gi:cornell[,gi:<name>...]
 *     --check-cvars          first resolve every variant console variable in the editor
 *     --variants L7-Epic,ID  limit the variants (default: every variant in gi/scenes.json)
 *     --warm-up 90,180       render warm-up frames per run (default 90)
 *     --runs 2               repeat each run; run 2 lands in "<variant>#2" (the noise floor)
 *     --rebuild              author and export the scene again even if its level exists
 *   pnpm unreal-look:compare --scene gi:cornell --unreal-vs-unreal [--write-stats]
 *   pnpm unreal-look:compare --scene gi:cornell --layer L1[,L7]   ThreeNative against Unreal, per region
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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import {
  type IImage,
  type IRow,
  type IStats,
  type IThresholds,
  compareCells,
  decode,
  iou,
  masks,
  measure,
} from "./compare.js";
import { contactGap, linearLuminance, pairedPenumbra } from "./penumbra.js";

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
  alphaMode?: "MASK";
  alphaCutoff?: number;
  doubleSided?: boolean;
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
    /** A SpotLight (PRD-649 lamp-room): the point it looks at, and its cone angles in degrees. */
    target?: Vec3;
    innerConeDeg?: number;
    outerConeDeg?: number;
  }[];
  exposure: { ev100: number; exposureScale: number } | null;
  /** `sun`: a template-lit scene's poses run once per sun, named `<sun>-<pose>` (PRD-649). */
  poses: { name: string; position: Vec3; target: Vec3; hfovDeg: number; sun?: string }[];
  /** A template-lit scene: Unreal's default level, one level per sun. */
  template?: "default";
  suns?: { name: string; elevationDeg: number; azimuthDeg: number }[];
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
  layer: string;
  level?: string;
  cvars: Record<string, number>;
  expect: Record<string, number>;
  kinds: ("png" | "exr")[];
}
export interface IRegistry {
  resolution: [number, number];
  /** `scene`: a scene of another family this entry reuses, authored once (`gi:foliage`). */
  scenes: { name: string; owner: string; poses: string[]; scene?: string }[];
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
    if (maskedStateDiffers(want, material))
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
}

export function readScene(name: string): { scene: ISceneJson; gltf: IGltf } {
  const dir = sceneDir(name);
  for (const file of ["scene.json", "scene.glb"])
    if (!existsSync(path.join(dir, file))) fail("SCENE_EXPORT", `${name}: ${file} was not written`);
  return {
    scene: JSON.parse(readFileSync(path.join(dir, "scene.json"), "utf8")) as ISceneJson,
    gltf: readGlbJson(readFileSync(path.join(dir, "scene.glb"))),
  };
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

export function folderName(variant: string, warmUp: number, run: number): string {
  return `${variant}${warmUp === 90 ? "" : `@${warmUp}`}${run === 1 ? "" : `#${run}`}`;
}

type RunUnreal = (mode: string, out: string, env?: Record<string, string>) => Promise<number>;

export async function captureGi(args: readonly string[], runUnreal: RunUnreal): Promise<number> {
  const value = flag(args, "--scene") ?? "gi";
  const family = familyOf(value);
  const reg = registry(family);
  const scenes = sceneNames(
    value,
    reg.scenes.map((s) => s.name),
  );
  const only = flag(args, "--variants")?.split(",");
  const variants = reg.variants.filter((v) => !only || only.includes(v.name));
  if (only && variants.length !== only.length) fail("BAD_INPUT", `unknown variant in ${only}`);
  const warmUps = (flag(args, "--warm-up") ?? "90").split(",").map(Number);
  if (!warmUps.every((w) => Number.isInteger(w) && w > 0)) fail("BAD_INPUT", "--warm-up");
  const runs = Number(flag(args, "--runs") ?? 1);
  const out = path.resolve(flag(args, "--out") ?? path.join(REFERENCE, "captures", "unreal"));

  if (args.includes("--check-cvars")) {
    const extra = [
      ...new Set(variants.flatMap((v) => [...Object.keys(v.cvars), ...Object.keys(v.expect)])),
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
    if (args.includes("--rebuild") || !existsSync(content)) {
      await rm(content, { recursive: true, force: true });
      if ((await runUnreal("build", out, { TN_UE_SCENE: name })) !== 0) return 1;
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
    }
    const { scene, gltf } = readScene(name);
    validateSceneExport(scene, gltf);
    for (const variant of variants)
      for (const warmUp of variant.name === "ID" ? [90] : warmUps)
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

/** The Unreal variant each ThreeNative layer is judged against (capture-gi-threenative.ts). */
const UNREAL_VARIANT: Readonly<Record<string, string>> = {
  L1: "L1",
  L6: "L7-Low",
  L7: "L7-Epic",
  L9: "L9-Epic",
};

/**
 * ThreeNative against Unreal for one scene: region statistics of every (layer, pose), with the
 * Unreal ID frame as the mask and the IoU of the two ID frames per region. A row passes against
 * tools/unreal-reference/thresholds.json when that file exists (PRD-631); otherwise it reports.
 */
export function compareGiToUnreal(name: string, layers: readonly string[], root: string): IRow[] {
  const { scene } = readScene(name);
  const thresholdFile = path.join(REFERENCE, "thresholds.json");
  const thresholds = existsSync(thresholdFile)
    ? (JSON.parse(readFileSync(thresholdFile, "utf8")) as IThresholds)
    : undefined;
  const unreal = path.join(root, "unreal", sceneKey(name));
  const tn = path.join(root, "threenative", sceneKey(name));
  const rows: IRow[] = [];
  for (const layer of layers) {
    // A shadow scene names its Unreal variants after their layers (shadow/scenes.json).
    const variant = name.startsWith("shadow:")
      ? layer
      : (UNREAL_VARIANT[layer] ?? fail("BAD_INPUT", `GI layer ${layer}`));
    for (const pose of scene.poses) {
      const reference = masks(image(path.join(unreal, "ID", `${pose.name}.png`)), scene.regions);
      const own = masks(image(path.join(tn, "ID", `${pose.name}.png`)), scene.regions);
      const regions = Object.keys(reference.regions).filter(
        (r) => r !== "Sky" && reference.regions[r]?.some(Boolean),
      );
      const exr = path.join(unreal, variant, `${pose.name}.exr`);
      const cell = compareCells({
        layer,
        cell: `${name}/${pose.name}`,
        unreal: image(path.join(unreal, variant, `${pose.name}.png`)),
        threenative: image(path.join(tn, layer, `${pose.name}.png`)),
        masks: reference,
        regions,
        ...(existsSync(exr) ? { unrealExr: image(exr) } : {}),
        ...(thresholds ? { thresholds } : {}),
      });
      for (const row of cell) {
        const a = reference.regions[row.region];
        const b = own.regions[row.region];
        row.iou = a && b ? iou(a, b) : 0;
      }
      rows.push(...cell);
    }
  }
  return rows;
}

/** Cells whose lamp has a source radius: the edge is tens of pixels wide, so it reads at this scale (PRD-650). */
const WIDE_PENUMBRA: Record<string, number> = { "shadow:lamp-room/spot-soft": 2.5 };

/** Floor shadow-edge width, Unreal against ThreeNative, per pose of one scene and layer (PRD-649). */
export function penumbraRows(
  name: string,
  layer: string,
  root: string,
): { cell: string; matched: number; unreal: number; other: number; ratio: number }[] {
  const { scene } = readScene(name);
  const unreal = path.join(root, "unreal", sceneKey(name));
  const tn = path.join(root, "threenative", sceneKey(name));
  const variant = name.startsWith("shadow:") ? layer : (UNREAL_VARIANT[layer] ?? layer);
  const rows = [];
  for (const pose of scene.poses) {
    const floor = masks(image(path.join(unreal, "ID", `${pose.name}.png`)), scene.regions).regions
      .Floor;
    if (!floor) fail("EMPTY_MASK", `${name}: the scene has no Floor region`);
    const m = pairedPenumbra(
      image(path.join(unreal, variant, `${pose.name}.png`)),
      image(path.join(tn, layer, `${pose.name}.png`)),
      floor,
      WIDE_PENUMBRA[`${name}/${pose.name}`],
    );
    if (m) rows.push({ cell: `${name}/${pose.name}`, ...m });
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

export function compareGi(args: readonly string[]): number {
  const layerFlag = flag(args, "--layer");
  if (layerFlag !== undefined) {
    const root = path.resolve(flag(args, "--captures") ?? path.join(REFERENCE, "captures"));
    const value = flag(args, "--scene") ?? "gi";
    const names = sceneNames(
      value,
      registry(familyOf(value)).scenes.map((s) => s.name),
    );
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
    if (flag(args, "--metric") === "penumbra") {
      const show = (v: number) => Number(v.toPrecision(4));
      console.log(
        "| cell | matched edge rows | UE width px | TN width px | TN / UE |\n|---|---:|---:|---:|---:|",
      );
      for (const name of names)
        for (const layer of layerFlag.split(","))
          for (const r of penumbraRows(name, layer, root))
            console.log(
              `| ${r.cell} ${layer} | ${r.matched} | ${show(r.unreal)} | ${show(r.other)} | ${show(r.ratio)} |`,
            );
      return 0;
    }
    const rows = names.flatMap((name) => compareGiToUnreal(name, layerFlag.split(","), root));
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
      // Convergence: 90 against 180 warm-up frames. Noise floor: two runs at 180.
      const at90 = regionStats(path.join(base, "L7-Epic"), pose.name, regionMasks);
      const at180 = regionStats(path.join(base, "L7-Epic@180"), pose.name, regionMasks);
      const again = existsSync(path.join(base, "L7-Epic@180#2"))
        ? regionStats(path.join(base, "L7-Epic@180#2"), pose.name, regionMasks)
        : undefined;
      for (const [region, a] of Object.entries(at90)) {
        const b = at180[region] ?? fail("EMPTY_MASK", `${region} missing at 180 frames`);
        const change = relativeChange(a, b);
        const noise = again?.[region] ? relativeChange(b, again[region]) : null;
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
        `\n### ${name}: Lumen convergence, L7 Epic, 90 vs 180 warm-up frames (limit ${CONVERGENCE * 100}%)\n\n| scene | pose | region | EV50 @90 | EV50 @180 | change | run-to-run @180 | verdict |\n|---|---|---|---:|---:|---:|---:|---|\n${rows.join("\n")}\n\nnoise floor (largest run-to-run change at 180 frames): ${(noiseFloor * 100).toFixed(2)}%`,
      );
    }
    if (args.includes("--write-stats")) {
      if (!Object.keys(stats).length) fail("MISSING_CELL", `${name}: no captured variant`);
      writeFileSync(
        path.join(sceneDir(name), "reference-stats.json"),
        `${JSON.stringify({ generatedAt: new Date().toISOString(), scene: name, resolution: scene.resolution, cells: stats }, null, 2)}\n`,
      );
      console.log(`wrote gi/${name}/reference-stats.json cells=${Object.keys(stats).length}`);
    }
  }
  return failed ? 1 : 0;
}
