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

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const REFERENCE = path.join(REPO_ROOT, "tools/unreal-reference");
const GI = path.join(REFERENCE, "gi");
const LOG = path.join(REFERENCE, "Saved/Logs/ThreeNativeReference.log");
/** PRD-631 noise floor: two Unreal runs agree within 1% (display p50). */
export const CONVERGENCE = 0.01;

type Vec3 = [number, number, number];
export interface ISceneMaterial {
  name: string;
  baseColor: Vec3;
  roughness: number;
  metallic: number;
  emissive: Vec3;
  emissiveStrength: number;
}
export interface ISceneJson {
  scene: string;
  resolution: [number, number];
  meshes: {
    name: string;
    class: string;
    position: Vec3;
    rotationYDeg: number;
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
  }[];
  exposure: { ev100: number; exposureScale: number } | null;
  poses: { name: string; position: Vec3; target: Vec3; hfovDeg: number }[];
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
      metallicFactor?: number;
      roughnessFactor?: number;
    };
    emissiveFactor?: number[];
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
interface IRegistry {
  resolution: [number, number];
  scenes: { name: string; owner: string; poses: string[] }[];
  variants: IVariant[];
}

function fail(code: string, message: string): never {
  throw new Error(`TN_UNREAL_LOOK_${code}: ${message}`);
}

export function registry(): IRegistry {
  return JSON.parse(readFileSync(path.join(GI, "scenes.json"), "utf8")) as IRegistry;
}

/** `gi` selects every registered scene, `gi:a,gi:b` the named ones. */
export function sceneNames(value: string, known: readonly string[]): string[] {
  const names = value === "gi" ? [...known] : value.split(",").map((s) => s.replace(/^gi:/, ""));
  for (const name of names)
    if (!known.includes(name)) fail("BAD_INPUT", `unknown GI scene ${name} (gi/scenes.json)`);
  if (!names.length) fail("BAD_INPUT", "--scene selects no scene");
  return names;
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
    const half = (actor.rotationYDeg * Math.PI) / 360;
    const q = node.rotation ?? [0, 0, 0, 1];
    const expected = [0, Math.sin(half), 0, Math.cos(half)];
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
    if (
      !near((pbr.baseColorFactor ?? [1, 1, 1, 1]).slice(0, 3), want.baseColor, 1e-3) ||
      Math.abs((pbr.roughnessFactor ?? 1) - want.roughness) > 1e-3 ||
      Math.abs((pbr.metallicFactor ?? 1) - want.metallic) > 1e-3 ||
      !near(
        material.emissiveFactor ?? [0, 0, 0],
        want.emissive.map((c) => c * want.emissiveStrength),
        1e-3,
      )
    )
      fail(
        "SCENE_EXPORT",
        `${actor.name}: material ${want.name} differs between scene.json and scene.glb`,
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
  }
  if (!scene.exposure || !Number.isFinite(scene.exposure.ev100))
    fail("SCENE_EXPORT", `${scene.scene}: no fixed EV100`);
  const colors = Object.values(scene.regions).map((c) => c.join(","));
  if (
    Object.keys(scene.regions).sort().join() !==
      scene.meshes
        .map((m) => m.name)
        .sort()
        .join() ||
    new Set(colors).size !== colors.length
  )
    fail("SCENE_EXPORT", `${scene.scene}: regions must name every mesh once, in distinct colours`);
}

export function readScene(name: string): { scene: ISceneJson; gltf: IGltf } {
  const dir = path.join(GI, name);
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
  const reg = registry();
  const scenes = sceneNames(
    flag(args, "--scene") ?? "gi",
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
    const content = path.join(REFERENCE, "Content/GI", name);
    if (args.includes("--rebuild") || !existsSync(content)) {
      await rm(content, { recursive: true, force: true });
      if ((await runUnreal("build", out, { TN_UE_SCENE: name })) !== 0) return 1;
      // The exported scene.json is committed: give it the repo's JSON format.
      // Relative: Biome skips an absolute path that runs through a .claude/ worktree.
      const file = path.relative(REPO_ROOT, path.join(GI, name, "scene.json"));
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
          const folder = path.join(out, name, folderName(variant.name, warmUp, run));
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
const UNREAL_VARIANT: Readonly<Record<string, string>> = { L1: "L1", L7: "L7-Epic", L9: "L9-Epic" };

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
  const unreal = path.join(root, "unreal", name);
  const tn = path.join(root, "threenative", name);
  const rows: IRow[] = [];
  for (const layer of layers) {
    const variant = UNREAL_VARIANT[layer] ?? fail("BAD_INPUT", `GI layer ${layer}`);
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

export function compareGi(args: readonly string[]): number {
  const layerFlag = flag(args, "--layer");
  if (layerFlag !== undefined) {
    const root = path.resolve(flag(args, "--captures") ?? path.join(REFERENCE, "captures"));
    const names = sceneNames(
      flag(args, "--scene") ?? "gi",
      registry().scenes.map((s) => s.name),
    );
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
  const reg = registry();
  const scenes = sceneNames(
    flag(args, "--scene") ?? "gi",
    reg.scenes.map((s) => s.name),
  );
  const root = path.resolve(flag(args, "--unreal") ?? path.join(REFERENCE, "captures", "unreal"));
  let failed = false;
  for (const name of scenes) {
    const { scene } = readScene(name);
    const base = path.join(root, name);
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
        path.join(GI, name, "reference-stats.json"),
        `${JSON.stringify({ generatedAt: new Date().toISOString(), scene: name, resolution: scene.resolution, cells: stats }, null, 2)}\n`,
      );
      console.log(`wrote gi/${name}/reference-stats.json cells=${Object.keys(stats).length}`);
    }
  }
  return failed ? 1 : 0;
}
