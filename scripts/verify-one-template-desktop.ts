// Packed consumer gate: the default engine must build both targets and boot without a display.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as ts from "typescript";
import { createProject } from "../packages/create-threenative/src/index.js";
import { runAsync } from "./lib/exec.js";
import { packageLocalFramework } from "./visual-gate.js";
import { localPackageEntries } from "./workspace-packages.js";

function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}

/** Bytes of the package files behind a tree, with pnpm's symlinks resolved and counted once. */
export function packageBytes(root: string): number {
  const seen = new Set<string>();
  let total = 0;
  const visit = (current: string): void => {
    let real: string;
    try {
      real = realpathSync(current);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    const stat = statSync(real);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(real, { withFileTypes: true }))
        visit(path.join(real, entry.name));
      return;
    }
    if (stat.isFile()) total += stat.size;
  };
  visit(root);
  return total;
}

/** Total bytes under a directory. `du` is not on every lane this script's claims travel to. */
function treeBytes(root: string): number {
  return files(root).reduce((total, file) => total + statSync(file).size, 0);
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

/** A native run that also fails on an engine refusal the exit code does not carry. */
async function run(command: string, args: readonly string[], cwd: string): Promise<string> {
  const output = await runAsync(command, args, { cwd, stdio: "capture", timeoutMs: 900_000 });
  // `TN_ENGINE_CATALOG: off (native host bundle)` is the plugin's info line, not a refusal.
  if (/TN_ENGINE_(?!CATALOG: off)[A-Z_]+/u.test(output))
    throw new Error(
      `${command} ${args.join(" ")} reported an engine refusal:\n${output.slice(-4000)}`,
    );
  return output;
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
  // PRD-783: the install this consumer just ran downloads no native binary, and a glibc host must
  // not install the musl packages it can never load. Both are measured before the first desktop
  // build, so "nothing downloaded yet" is an observation rather than a promise.
  const installedRuntime = path.join(project, "node_modules", "@threenative/runtime-native");
  const prebuilt = path.join(installedRuntime, "prebuilt");
  const fetched = existsSync(prebuilt)
    ? files(prebuilt).filter((file) => statSync(file).size > 0)
    : [];
  if (fetched.length > 0)
    throw new Error(
      `TN_PACKED_PREBUILT_DOWNLOADED: the install fetched ${fetched.length} native file(s): ${fetched.slice(0, 3).join(", ")}`,
    );
  // The ceiling is about the framework's own payload, not the dev toolchain: Vite, Tailwind and
  // their platform bindings fill node_modules on their own and vary with every lock update, while
  // what PRD-783 promised is that no native binary of *ours* arrives. Measured on the installed
  // `@threenative` closure, with the toolchain size reported beside it.
  const frameworkBytes = packageBytes(path.join(project, "node_modules", "@threenative"));
  const installedBytes = treeBytes(path.join(project, "node_modules"));
  // Measured on the racing kit after dereferencing pnpm's links: 43 MiB. The ceiling's job is to
  // catch a native payload arriving by accident — the engine player is 118 MiB — so it sits at
  // twice the measurement and still well under one player.
  const ceiling = 88 * 1024 * 1024;
  if (frameworkBytes > ceiling)
    throw new Error(
      `TN_PACKED_INSTALL_TOO_LARGE: node_modules/@threenative is ${Math.round(frameworkBytes / 1024 / 1024)} MiB, over the ${ceiling / 1024 / 1024} MiB ceiling PRD-783 measured`,
    );
  console.info(
    `install fetched no native binary; node_modules/@threenative ${Math.round(frameworkBytes / 1024)} KiB of ${Math.round(installedBytes / 1024 / 1024)} MiB installed`,
  );
  await run("pnpm", ["build:desktop"], project);
  // The default engine's desktop build needs the engine player and nothing else: the legacy runtime
  // and its build helper belong to the `threejs` host and must not have been downloaded here.
  const player = path.join(
    prebuilt,
    `${process.platform}-${process.arch}`,
    `tn-native-engine-player-v8${process.platform === "win32" ? ".exe" : ""}`,
  );
  if (!existsSync(player) || statSync(player).size === 0)
    throw new Error(
      `TN_PACKED_ENGINE_PLAYER_MISSING: the first desktop build fetched no ${player}`,
    );
  for (const filename of [
    process.platform === "win32" ? "threenative-runtime.exe" : "threenative-runtime",
    process.platform === "win32" ? "mystral-tools.exe" : "mystral-tools",
  ]) {
    const legacy = path.join(prebuilt, `${process.platform}-${process.arch}`, filename);
    if (existsSync(legacy))
      throw new Error(`TN_PACKED_LEGACY_BINARY: the default-engine build downloaded ${legacy}`);
  }
  const manifest = JSON.parse(readFileSync(path.join(project, "package.json"), "utf8"));
  const name = manifest.name.replace(/^@[^/]+\//u, "");
  const artifact = path.join(project, "dist-native", name);
  for (const entry of [
    name,
    `tn-native-engine-player-v8${process.platform === "win32" ? ".exe" : ""}`,
    "game.js",
    "native/assets.tnpk",
  ])
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
