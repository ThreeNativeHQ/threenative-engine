import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createProject } from "../packages/create-threenative/src/index.js";
import { packageLocalFramework } from "./visual-gate.js";

/**
 * The opt-in realistic ocean in the sailing kit, as a fresh consumer would adopt it (PRD-648).
 *
 * Adopting is the documented install plus four edits to `src/scenes/Sailing.ts`. The same
 * edits, reversed, remove it. Both directions fail closed: an edit that does not match exactly
 * once throws, so a changed template cannot be half-adopted.
 */
const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = path.resolve(here, "../packages/create-threenative/template-assets/realistic-ocean");
const SCENE = "src/scenes/Sailing.ts";

const EDITS: readonly (readonly [original: string, adopted: string])[] = [
  ["  createOcean,\n  createWaterMesh,\n  markReflected,", "  markReflected,"],
  [
    'import { setupSky } from "../render/sky.js";',
    'import { createRealisticMaps, createRealisticSea, createRealisticWaterMesh } from "../render/realisticSea.js";\nimport { SUN_DIRECTION, setupSky } from "../render/sky.js";',
  ],
  [
    "  #sea: ReturnType<typeof createWaterMesh> | undefined;",
    "  #sea: ReturnType<typeof createRealisticWaterMesh> | undefined;",
  ],
  [
    "    const ocean = ctx.add(createOcean());",
    "    const ocean = ctx.add(createRealisticSea());\n    const maps = ctx.add(createRealisticMaps(ocean));",
  ],
  [
    "    const sea = createWaterMesh(ocean, new WaterSurface3D(SEA_MIRROR), { software });",
    "    const sea = createRealisticWaterMesh(ocean, maps, new WaterSurface3D(SEA_MIRROR), { software });\n    sea.setSun(\n      [SUN_DIRECTION.x, SUN_DIRECTION.y, SUN_DIRECTION.z],\n      [sun.color.r * sun.intensity, sun.color.g * sun.intensity, sun.color.b * sun.intensity],\n    );",
  ],
];

function replaceOnce(source: string, from: string, to: string): string {
  const first = source.indexOf(from);
  if (first < 0 || source.indexOf(from, first + 1) >= 0)
    throw new Error(`TN_REALISTIC_CONSUMER_EDIT: expected exactly one match for:\n${from}`);
  return source.slice(0, first) + to + source.slice(first + from.length);
}

async function bundleFiles(directory = path.join(bundle, "src"), prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory())
      files.push(...(await bundleFiles(path.join(directory, entry.name), relative)));
    else files.push(relative);
  }
  return files.sort();
}

export async function adoptRealisticOcean(target: string): Promise<void> {
  const file = path.join(target, SCENE);
  let source = await readFile(file, "utf8");
  // Every edit is checked before the first file is copied, so a changed template is never
  // half-adopted.
  for (const [original, adopted] of EDITS) source = replaceOnce(source, original, adopted);
  await run(process.execPath, [path.join(bundle, "install.mjs"), target]);
  await writeFile(file, source);
}

export async function removeRealisticOcean(target: string): Promise<void> {
  const file = path.join(target, SCENE);
  let source = await readFile(file, "utf8");
  for (const [original, adopted] of [...EDITS].reverse())
    source = replaceOnce(source, adopted, original);
  await writeFile(file, source);
  for (const relative of await bundleFiles()) await rm(path.join(target, "src", relative));
}

const POSE_ANCHOR =
  "  camera.lookAt(target.x + forwardX * LEAD, target.y + AIM, target.z + forwardZ * LEAD);\n}";
const POSE_HOOK = `  camera.lookAt(target.x + forwardX * LEAD, target.y + AIM, target.z + forwardZ * LEAD);
  // Capture instrumentation (scripts/realistic-ocean-consumer.ts --capture-hook), identical on both
  // arms: a pose set before load, as \`yaw\` degrees from the sun's bearing, so a frame can be
  // repeated exactly. Never part of the scaffold or of the bundle.
  const pose = (globalThis as { __TN_OCEAN_POSE?: { x: number; y: number; z: number; yaw: number; pitch: number; fov?: number } }).__TN_OCEAN_POSE;
  if (pose !== undefined) {
    const sunYaw = Math.atan2(-SUN_DIRECTION.x, -SUN_DIRECTION.z);
    camera.position.set(pose.x, pose.y, pose.z);
    camera.rotation.order = "YXZ";
    camera.rotation.set((pose.pitch * Math.PI) / 180, sunYaw + (pose.yaw * Math.PI) / 180, 0);
    if (pose.fov !== undefined && camera.fov !== pose.fov) {
      camera.fov = pose.fov;
      camera.updateProjectionMatrix();
    }
  }
}`;

/**
 * The reference's conditions, for a like-for-like capture: web-ocean lights its sea with a sun
 * 2.6 degrees up and a warm hazy sky, the sailing kit with a photograph whose sun is 48 degrees
 * up, so their water cannot be compared as shipped. This swaps in a low-sun photograph
 * (`scripts/realistic-ocean-sky.py` makes it from a Poly Haven HDR and measures its sun) and
 * re-aims the sun, the fog and the key light at it. Capture instrumentation only, applied to both
 * arms alike.
 */
export const MATCHED_SKY = {
  /**
   * Poly Haven "Qwantani Sunset (Pure Sky)", CC0, 4k HDR, encoded at 0.25 (white = 4). Drawn at
   * a quarter of its radiance against its own sun at half: its hazy horizon is about 0.6 of the
   * sun's irradiance, web-ocean's sky about 0.1, and the water reflects that ratio.
   */
  range: 1,
  /** Lit at the sky as drawn: sky and sun are one photograph, as web-ocean's are one atmosphere. */
  fill: 1,
  /** Unit vector toward its sun, read off the file by the script: 6.1 degrees up. */
  sun: [0.8043, 0.1062, 0.5846] as const,
  /** Its horizon band away from the sun, times `range`. */
  skyLow: "0x918a83",
  /**
   * The sun: web-ocean's colour, measured off its frame 20 px from the disc (the photograph's own is
   * a deep orange), at the luminance the photograph's integrated irradiance has, times the half.
   */
  sunColor: "0xfff0dd",
  sunIntensity: 1.9,
  /** web-ocean's marine haze floor (1.1e-4 per metre) as FogExp2: the same 90% at a kilometre. */
  fogDensity: 0.00032,
  /** The same floor as the height term's sea-level density, per metre. */
  hazeDensity: 0.00011,
};

export async function matchReferenceScene(target: string, skyJpg: string): Promise<void> {
  const edit = async (relative: string, edits: readonly (readonly [string, string])[]) => {
    const file = path.join(target, relative);
    let source = await readFile(file, "utf8");
    for (const [from, to] of edits) source = replaceOnce(source, from, to);
    await writeFile(file, source);
  };
  const [x, y, z] = MATCHED_SKY.sun;
  await edit("src/render/sky.ts", [
    ["const SKY_RANGE = 2.5;", `const SKY_RANGE = ${MATCHED_SKY.range};`],
    ["const FILL_RANGE = 0.9;", `const FILL_RANGE = ${MATCHED_SKY.fill};`],
    [
      "const SUN_IN_PHOTO = new Vector3(0.555, 0.742, 0.38);",
      `const SUN_IN_PHOTO = new Vector3(${x}, ${y}, ${z});`,
    ],
    [
      "const EYE_LEVEL = { density: 0.003,",
      `const EYE_LEVEL = { density: ${MATCHED_SKY.fogDensity},`,
    ],
  ]);
  await edit("src/render/heightFog.ts", [
    ["  density: 0.0018,", `  density: ${MATCHED_SKY.hazeDensity},`],
  ]);
  await edit("src/render/palette.ts", [
    ["skyLow: 0xacb1c1,", `skyLow: ${MATCHED_SKY.skyLow},`],
    ["player: 0xffe6b8,", `player: ${MATCHED_SKY.sunColor},`],
  ]);
  await edit("src/render/lighting.ts", [
    [
      "new DirectionalLight(palette.player, 3.4);",
      `new DirectionalLight(palette.player, ${MATCHED_SKY.sunIntensity});`,
    ],
  ]);
  await cp(skyJpg, path.join(target, "assets/sky.jpg"));
}

/** Patch a consumer's camera so a capture script can pose it. Fails closed on a changed template. */
export async function addCapturePose(target: string): Promise<void> {
  const file = path.join(target, "src/render/camera.ts");
  let source = await readFile(file, "utf8");
  source = replaceOnce(source, POSE_ANCHOR, POSE_HOOK);
  source = replaceOnce(
    source,
    'import type { PerspectiveCamera } from "three";',
    'import type { PerspectiveCamera } from "three";\nimport { SUN_DIRECTION } from "./sky.js";',
  );
  await writeFile(file, source);
}

/** A digest of every file under `src/`, so removal can be proved against the scaffold. */
export async function digestSource(target: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else hash.update(`${path.relative(target, full)}\0`).update(await readFile(full));
    }
  };
  await walk(path.join(target, "src"));
  return hash.digest("hex");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf("--root");
  const root = path.resolve(rootIndex >= 0 ? (args[rootIndex + 1] as string) : "ocean-consumer");
  const matchIndex = args.indexOf("--match-reference");
  const matchSky = matchIndex >= 0 ? path.resolve(args[matchIndex + 1] as string) : undefined;
  if (args.includes("--patch-only")) {
    for (const arm of ["sailing-incumbent", "sailing-realistic"]) {
      await addCapturePose(path.join(root, arm));
      if (matchSky !== undefined) await matchReferenceScene(path.join(root, arm), matchSky);
    }
    return;
  }
  await mkdir(root, { recursive: true });
  const packageSources = await packageLocalFramework(root);
  const create = (target: string) =>
    createProject({ install: true, packageSources, target, template: "sailing" }, root);
  const incumbent = await create("sailing-incumbent");
  const scaffold = await digestSource(incumbent.target);
  const candidate = path.join(root, "sailing-realistic");
  await cp(incumbent.target, candidate, { recursive: true, verbatimSymlinks: true });
  await adoptRealisticOcean(candidate);
  const adopted = await digestSource(candidate);
  if (adopted === scaffold) throw new Error("TN_REALISTIC_CONSUMER: adoption changed nothing.");
  if (args.includes("--prove-remove")) {
    await removeRealisticOcean(candidate);
    const removed = await digestSource(candidate);
    if (removed !== scaffold)
      throw new Error("TN_REALISTIC_CONSUMER: removal did not restore the scaffold's source.");
    await adoptRealisticOcean(candidate);
    process.stdout.write("TN_REALISTIC_CONSUMER remove restores the scaffold byte for byte\n");
  }
  if (args.includes("--capture-hook")) {
    await addCapturePose(incumbent.target);
    await addCapturePose(candidate);
  }
  if (matchSky !== undefined) {
    await matchReferenceScene(incumbent.target, matchSky);
    await matchReferenceScene(candidate, matchSky);
  }
  process.stdout.write(
    `TN_REALISTIC_CONSUMER incumbent=${incumbent.target} realistic=${candidate}\n`,
  );
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
