#!/bin/sh
# Pack/install matched browser dependencies, or validate existing build provenance without rebuilding.
# install.sh <game-dir> [--no-pack|--verify] [desktop-player-dir]
set -eu
GAME=${1:?usage: install.sh <game-dir> [--no-pack|--verify] [desktop-player-dir]}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
PACKS=${MIDWAY_PACKS:-${XDG_CACHE_HOME:-$HOME/.cache}/midway-packs}
node --input-type=module - "$GAME" "${2:-}" "$REPO" "$PACKS" "${3:-}" "${4:-}" <<'JS'
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync, statSync, existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
const [game, mode, repo, packs, desktop, peer] = process.argv.slice(2);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
// Same sorted relative-path/file-hash algorithm as create-threenative's buildReport.hashArtifact.
function hash(target) {
  if (!statSync(target).isDirectory()) return sha(readFileSync(target));
  const files = [];
  const visit = (dir, prefix = "") => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const name = prefix + entry.name;
      if (name === "midway-provenance.json") continue;
      if (entry.isDirectory()) visit(path.join(dir, entry.name), `${name}/`);
      else if (entry.isFile()) files.push(`${name} ${sha(readFileSync(path.join(dir, entry.name)))}`);
      else throw new Error(`provenance cannot hash symlink ${name}`);
    }
  };
  visit(target);
  return sha(files.join("\n"));
}
function verify(dir) {
  const report = JSON.parse(readFileSync(path.join(dir, "midway-provenance.json"), "utf8"));
  if (report.buildProtocol !== "midway-clean-build-v1") throw new Error(`missing genuine build provenance: ${dir}; rebuild and repack`);
  if (typeof report.engineCommit !== "string" || !/^[a-f0-9]{40}$/.test(report.engineCommit) || !report.artifacts || typeof report.artifacts !== "object" || Array.isArray(report.artifacts) || !Object.keys(report.artifacts).length)
    throw new Error(`missing/malformed provenance: ${dir}`);
  for (const [file, digest] of Object.entries(report.artifacts)) {
    if (!file || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest) || path.isAbsolute(file) || file.split(/[\\/]/).includes("..") || hash(path.join(dir, file)) !== digest)
      throw new Error(`stale provenance: ${dir}/${file}`);
  }
  if (report.directorySha256 !== undefined && (typeof report.directorySha256 !== "string" || !/^[a-f0-9]{64}$/.test(report.directorySha256) || hash(dir) !== report.directorySha256)) throw new Error(`stale directory provenance: ${dir}`);
  return report.engineCommit;
}
if (mode === "--verify" || mode === "--verify-web") {
  const commit = verify(game);
  if (!desktop) throw new Error("desktop provenance required: set MIDWAY_PLAYER_DIR");
  if (verify(desktop) !== commit) throw new Error("engine commit mismatch between browser packages and desktop bundle");
  if (peer && verify(peer) !== commit) throw new Error("engine commit mismatch between browser arms");
  if (mode === "--verify-web") {
    const report = JSON.parse(readFileSync(path.join(game, "dist.build-report.json"), "utf8"));
    if (report.schemaVersion !== 1 || report.target !== "web" || report.artifact?.kind !== "directory" || !/^[a-f0-9]{64}$/.test(report.artifact?.sha256) || report.artifact.sha256 !== hash(path.join(game, "dist")))
      throw new Error("missing/malformed/stale production build provenance");
    console.log(`buildMode=production engineCommit=${commit} artifactSha256=${report.artifact.sha256}`);
  } else console.log(commit);
} else {
  if (mode && mode !== "--no-pack") throw new Error(`unknown install mode ${mode}`);
  mkdirSync(packs, { recursive: true });
  const names = { core: "@threenative/core", physics: "@threenative/physics", ui: "@threenative/ui", assets: "@threenative/assets", playtest: "@threenative/playtest", "runtime-native": "@threenative/runtime-native", "create-threenative": "create-threenative", three: "three" };
  const run = (args, cwd) => execFileSync("pnpm", args, { cwd, stdio: "inherit", env: { ...process.env, CI: "1" } });
  if (mode !== "--no-pack") {
    const git = (args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    const sourceCommit = () => {
      if (realpathSync(git(["rev-parse", "--show-toplevel"])) !== realpathSync(repo)
        || JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8")).name !== "threenative"
        || git(["status", "--porcelain", "--untracked-files=normal", "--", "packages", "scripts", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ":(exclude,glob)packages/**/__tests__/**", ":(exclude,glob)packages/runtime-native/tests/**", ":(exclude,glob)scripts/__tests__/**"]))
        throw new Error("build provenance requires a clean owning engine checkout; preserve unrelated edits and prepare from a clean revision");
      return git(["rev-parse", "HEAD"]);
    };
    const commit = sourceCommit();
    // A packing-time HEAD cannot attest existing dist or player bytes. Rebuild before stamping.
    rmSync(path.join(packs, "midway-provenance.json"), { force: true });
    run(["build"], repo);
    const native = path.join(repo, "packages/runtime-native");
    execFileSync(process.execPath, [path.join(native, "scripts/build-native-ui-overlay.mjs")], { cwd: repo, stdio: "inherit" });
    for (const [dir, target] of [["wasm", "tn-native-engine-web"], ["tn-engine-ui", "tn-native-engine-player-v8"]]) {
      const source = /^CMAKE_HOME_DIRECTORY:INTERNAL=(.+)$/m.exec(readFileSync(path.join(native, "build", dir, "CMakeCache.txt"), "utf8"))?.[1];
      if (!source || realpathSync(source) !== realpathSync(native)) throw new Error(`build provenance: ${dir} was configured from another source checkout`);
      execFileSync("cmake", ["--build", path.join(native, "build", dir), "--target", target], { cwd: repo, stdio: "inherit" });
    }
    if (sourceCommit() !== commit) throw new Error("engine source changed during build; no provenance published");
    const playerSha256 = hash(path.join(native, "build/tn-engine-ui/tn-native-engine-player-v8"));
    for (const file of readdirSync(packs).filter((f) => f.endsWith(".tgz"))) rmSync(path.join(packs, file));
    const require = createRequire(path.join(repo, "packages/core/package.json"));
    for (const key of Object.keys(names)) {
      if (key === "three") run(["pack", "--pack-destination", packs], path.dirname(path.dirname(require.resolve("three"))));
      else run(["--filter", `./packages/${key}`, "pack", "--pack-destination", packs], repo);
    }
    const artifacts = Object.fromEntries(readdirSync(packs).filter((f) => f.endsWith(".tgz")).map((f) => [f, hash(path.join(packs, f))]));
    if (sourceCommit() !== commit) throw new Error("engine source changed during packing; no provenance published");
    writeFileSync(path.join(packs, "midway-provenance.json"), JSON.stringify({ buildProtocol: "midway-clean-build-v1", engineCommit: commit, playerSha256, artifacts }));
  }
  const engineCommit = verify(packs);
  const packed = JSON.parse(readFileSync(path.join(packs, "midway-provenance.json"), "utf8"));
  if (readdirSync(packs).filter((f) => f.endsWith(".tgz")).some((f) => !Object.hasOwn(packed.artifacts, f))) throw new Error("tarball missing from package provenance");
  const files = readdirSync(packs);
  const pkg = JSON.parse(readFileSync(path.join(game, "package.json"), "utf8"));
  for (const [key, name] of Object.entries(names)) {
    const prefix = name.startsWith("@") ? `threenative-${key}-` : `${key}-`;
    const found = files.filter((f) => f.startsWith(prefix) && f.endsWith(".tgz"));
    if (found.length !== 1) throw new Error(`expected one tarball for ${name}, found ${found}`);
    const spec = `file:${path.join(packs, found[0])}`;
    for (const field of ["dependencies", "devDependencies"]) if (pkg[field]?.[name]) pkg[field][name] = spec;
    pkg.pnpm ??= {};
    pkg.pnpm.overrides ??= {};
    pkg.pnpm.overrides[name] = spec;
  }
  writeFileSync(path.join(game, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  run(["install", "--no-frozen-lockfile"], game);
  const artifacts = {};
  for (const file of ["package.json", "pnpm-lock.yaml", ...Object.values(names).map((n) => `node_modules/${n}`)]) {
    const target = path.join(game, file);
    if (existsSync(target)) artifacts[file] = hash(realpathSync(target));
    else if (file === "package.json" || file === "pnpm-lock.yaml" || pkg.dependencies?.[file.replace("node_modules/", "")] || pkg.devDependencies?.[file.replace("node_modules/", "")]) throw new Error(`installed provenance missing ${file}`);
  }
  writeFileSync(path.join(game, "midway-provenance.json"), JSON.stringify({ buildProtocol: packed.buildProtocol, engineCommit, artifacts }));
  rmSync(path.join(game, "node_modules/.vite"), { recursive: true, force: true });
  console.log(`Midway installed engineCommit=${engineCommit}`);
}
JS
