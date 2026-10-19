// Packed consumer gate: the default engine must build both targets and boot without a display.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "typescript";
import { createProject } from "../packages/create-threenative/src/index.js";
import { packageLocalFramework } from "./visual-gate.js";
import { localPackageEntries } from "./workspace-packages.js";

function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}

/** Check literal relative imports without executing platform-specific scripts. */
export function assertPackedImportClosure(root: string, required: readonly string[]): void {
  for (const entry of required) {
    if (!existsSync(path.join(root, entry))) throw new Error(`TN_PACKED_SCRIPT_MISSING: ${entry}`);
  }
  const scriptDirectory = existsSync(path.join(root, "scripts"))
    ? "scripts"
    : existsSync(path.join(root, "dist"))
      ? "dist"
      : ".";
  const sources = files(path.join(root, scriptDirectory)).filter((file) =>
    /\.(?:mjs|cjs|js)$/u.test(file),
  );
  if (sources.length === 0) throw new Error(`TN_PACKED_SCRIPTS_EMPTY: ${root}`);
  const visited = new Set<string>();
  for (const file of sources) {
    if (visited.has(file)) continue;
    visited.add(file);
    const imports = ts.preProcessFile(readFileSync(file, "utf8"), true, true).importedFiles;
    for (const { fileName: specifier } of imports) {
      if (!specifier.startsWith(".")) continue;
      const target = path.resolve(path.dirname(file), specifier);
      if (
        !target.startsWith(`${root}${path.sep}`) ||
        !existsSync(target) ||
        !statSync(target).isFile()
      )
        throw new Error(`TN_PACKED_IMPORT_MISSING: ${path.relative(root, file)} -> ${specifier}`);
      if (/\.(?:mjs|cjs|js)$/u.test(target)) sources.push(target);
    }
  }
}

export function assertUnpinnedEngine(config: string): void {
  const source = ts.createSourceFile("threenative.config.ts", config, ts.ScriptTarget.Latest);
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAssignment(node) &&
      node.name.getText(source).replace(/["']/gu, "") === "engine"
    )
      throw new Error("TN_PACKED_ENGINE_PINNED: consumer must exercise the default engine");
    ts.forEachChild(node, visit);
  };
  visit(source);
}

async function run(command: string, args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 900_000);
    for (const stream of [child.stdout, child.stderr])
      stream?.on("data", (chunk) => {
        output += String(chunk);
        process.stdout.write(chunk);
      });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || /TN_ENGINE_[A-Z_]+/u.test(output))
        reject(new Error(`${command} ${args.join(" ")} failed (${code}):\n${output.slice(-4000)}`));
      else resolve(output);
    });
  });
}

export async function checkArchives(
  archives: string,
  root: string,
): Promise<Record<string, string>> {
  const sources: Record<string, string> = {};
  const entries = readdirSync(archives);
  for (const [name, prefix] of localPackageEntries()) {
    const matches = entries.filter((file) => file.startsWith(prefix) && file.endsWith(".tgz"));
    if (matches.length !== 1)
      throw new Error(`TN_PACKED_COHORT_MISSING: ${name}: ${matches.length} archives`);
    sources[name] = path.resolve(archives, matches[0] as string);
  }
  const packedFiles: Record<string, readonly string[]> = {
    "@threenative/runtime-native": [
      "scripts/bundle-native-engine.mjs",
      "scripts/package-engine-desktop.mjs",
    ],
    "create-threenative": ["dist/index.js", "dist/threenative.js"],
  };
  for (const [name, required] of Object.entries(packedFiles)) {
    const extracted = path.join(root, name.replaceAll("/", "-"));
    await mkdir(extracted, { recursive: true });
    await run("tar", ["-xzf", sources[name] as string, "-C", extracted], root);
    // Templates contain user source and intentionally unresolved scaffold placeholders.
    const packageRoot = path.join(extracted, "package");
    assertPackedImportClosure(packageRoot, required);
    console.info(`${name}: packed script import closure passed`);
  }
  return sources;
}

export async function verifyInstalledConsumer(project: string): Promise<void> {
  assertUnpinnedEngine(readFileSync(path.join(project, "threenative.config.ts"), "utf8"));
  for (const [name] of localPackageEntries()) {
    const installed = path.join(project, "node_modules", name);
    const resolved = realpathSync(installed);
    if (!resolved.startsWith(`${realpathSync(project)}${path.sep}`))
      throw new Error(`TN_PACKED_WORKSPACE_LINK: ${name} -> ${resolved}`);
  }
  // Ask the installed config resolver, through its public Vite plugin, rather than assuming its default.
  const cli = await import(
    pathToFileURL(path.join(project, "node_modules/create-threenative/dist/index.js")).href
  );
  const brand = cli.createWebBrandPlugin();
  await brand.configResolved({ root: project });
  if (brand.resolveId("three") !== "\0threenative:web-engine")
    throw new Error("TN_PACKED_ENGINE_NOT_NATIVE: installed scaffold resolved to legacy");
  console.info("installed scaffold resolved engine=threenative (no engine pin)");
  await run("pnpm", ["build:desktop"], project);
  const manifest = JSON.parse(readFileSync(path.join(project, "package.json"), "utf8"));
  const name = manifest.name.replace(/^@[^/]+\//u, "");
  const artifact = path.join(project, "dist-native", name);
  for (const entry of [name, "tn-native-engine-player-v8", "game.js", "native/assets.tnpk"])
    if (!existsSync(path.join(artifact, entry)) || statSync(path.join(artifact, entry)).size === 0)
      throw new Error(`TN_PACKED_DESKTOP_ARTIFACT_MISSING: ${entry}`);
  await run("pnpm", ["build:web"], project);
  const output = files(path.join(project, "dist"));
  if (
    !output.some(
      (file) => /tn-native-engine-web[^/]*\.wasm$/u.test(file) && statSync(file).size > 8,
    ) ||
    !output.some(
      (file) =>
        /\.(?:mjs|js)$/u.test(file) && readFileSync(file, "utf8").includes("tn-native-engine-web"),
    )
  )
    throw new Error("TN_PACKED_WASM_MISSING: web output lacks the Wasm engine and its loader");
  const boot = await run(
    path.join(artifact, "tn-native-engine-player-v8"),
    [path.join(artifact, "game.js"), "--check-game"],
    artifact,
  );
  if (!boot.includes("TN_PLAYER_V8_GAME_CHECK: engine=native gameRuntime=v8 startup=passed"))
    throw new Error("TN_PACKED_BOOT_MISSING: native startup marker absent");
  console.info(`${project}: packed native desktop build, headless boot and Wasm web build passed`);
}

async function main(): Promise<void> {
  const template = process.argv[2];
  if (!template || template.startsWith("--"))
    throw new Error(
      "usage: verify-one-template-desktop.ts <template> [--archives <directory>] [--project <installed-project>] [--closure-only]",
    );
  const option = (flag: string): string | undefined => {
    const index = process.argv.indexOf(flag);
    if (index === -1) return undefined;
    const value = process.argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a path`);
    return path.resolve(value);
  };
  const root = await mkdtemp(path.join(os.tmpdir(), `threenative-${template}-desktop-`));
  console.info(`consumer gate root: ${root}`);
  const archives = option("--archives");
  const packed = archives === undefined ? await packageLocalFramework(root) : undefined;
  const sources = await checkArchives(
    archives ?? path.dirname(Object.values(packed ?? {})[0] as string),
    root,
  );
  if (process.argv.includes("--closure-only")) return;
  let project = option("--project");
  if (project === undefined) {
    project = path.join(root, template);
    await createProject(
      { install: true, packageSources: sources, target: project, template },
      root,
      path.join(root, "create-threenative", "package", "templates"),
    );
  }
  await verifyInstalledConsumer(project);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
