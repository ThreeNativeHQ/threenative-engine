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
    "    const sea = createRealisticWaterMesh(ocean, maps, new WaterSurface3D(SEA_MIRROR), { software });\n    sea.setSun([SUN_DIRECTION.x, SUN_DIRECTION.y, SUN_DIRECTION.z]);",
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
  await run(process.execPath, [path.join(bundle, "install.mjs"), target]);
  const file = path.join(target, SCENE);
  let source = await readFile(file, "utf8");
  for (const [original, adopted] of EDITS) source = replaceOnce(source, original, adopted);
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
