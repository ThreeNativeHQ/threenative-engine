#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import zlib from "node:zlib";

const execFileAsync = promisify(execFile);
const PIN_VERSION = "0.185.1";
const PIN_COMMIT = "2431a09f46f34c560bc8e44b33be0e567723d5b9";
const ARCHIVE_URL = `https://codeload.github.com/mrdoob/three.js/tar.gz/${PIN_COMMIT}`;
const BASE_PATCH_NAME = `three@${PIN_VERSION}.patch`;
const UPGRADE_PATCH_NAME = `three@${PIN_VERSION}-prd269-upgrade.patch`;
const MAX_BUFFER = 64 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
const HEX40 = /^[a-f0-9]{40}$/u;
const HEX64 = /^[a-f0-9]{64}$/u;

const err = (message) => new Error(`TN_GENERATE_PATCH: ${message}`);

export function blobHash(contents) {
  return createHash("sha1")
    .update(`blob ${Buffer.byteLength(contents)}\0`)
    .update(contents)
    .digest("hex");
}

async function fileSha256(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function isSafeRelative(value, prefixes) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.startsWith("/") || value.includes("\\")) return false;
  if (value.split("/").some((part) => part === "" || part === "." || part === "..")) return false;
  return prefixes.some((prefix) => value.startsWith(`${prefix}/`));
}

function validateCompatPairs(pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) {
    throw err("pin.json frozenCompatPairs must be a non-empty array.");
  }
  const seen = new Set();
  for (const pair of pairs) {
    if (pair === null || typeof pair !== "object")
      throw err("pin.json has an invalid compat pair.");
    if (!isSafeRelative(pair.path, ["src", "build"]))
      throw err(`unsafe compat path '${pair.path}'.`);
    if (!HEX40.test(pair.oldHash ?? "") || !HEX40.test(pair.newHash ?? "")) {
      throw err(`invalid compat hash for ${pair.path}.`);
    }
    const key = `${pair.path}\0${pair.oldHash}`;
    if (seen.has(key)) throw err(`duplicate compat pair ${pair.path} ${pair.oldHash}.`);
    seen.add(key);
  }
}

function validateFinalHashes(finals) {
  if (finals === null || typeof finals !== "object" || Array.isArray(finals)) {
    throw err("pin.json baseFinalHashes must be an object.");
  }
  const paths = Object.keys(finals);
  if (paths.length === 0) throw err("pin.json baseFinalHashes must be non-empty.");
  for (const rel of paths) {
    if (!isSafeRelative(rel, ["src", "build"])) throw err(`unsafe final path '${rel}'.`);
    if (!HEX40.test(finals[rel])) throw err(`invalid final hash for ${rel}.`);
  }
}

export function validatePin(pin) {
  if (pin === null || typeof pin !== "object") throw err("pin.json must be an object.");
  if (pin.version !== PIN_VERSION || pin.commit !== PIN_COMMIT) {
    throw err(`unsupported pin ${pin.version} ${pin.commit}`);
  }
  for (const key of ["packageJsonSha256", "packageLockSha256", "archiveSha256"]) {
    if (!HEX64.test(pin[key] ?? "")) throw err(`pin.json has an invalid ${key}.`);
  }
  validateCompatPairs(pin.frozenCompatPairs);
  validateFinalHashes(pin.baseFinalHashes);
  return pin;
}

/** Every `diff --git`/`---`/`+++` path must be an identical, safe `src/` path. */
export function parseSourceDeltaPaths(sourceDelta) {
  const sections = sourceDelta
    .split(/^(?=diff --git )/mu)
    .filter((section) => section.trim().length > 0);
  if (sections.length === 0) throw err("source delta is empty.");
  const paths = [];
  for (const section of sections) {
    const header = /^diff --git a\/(\S+) b\/(\S+)/mu.exec(section);
    if (header === null) throw err("source delta section has no diff header.");
    const [, oldPath, newPath] = header;
    const oldHeader = /^--- a\/(\S+)/mu.exec(section);
    const newHeader = /^\+\+\+ b\/(\S+)/mu.exec(section);
    if (oldPath !== newPath)
      throw err(`source delta rename '${oldPath}' -> '${newPath}' is not allowed.`);
    if (oldHeader?.[1] !== oldPath || newHeader?.[1] !== newPath) {
      throw err(`source delta paths disagree for '${oldPath}'.`);
    }
    if (!isSafeRelative(oldPath, ["src"]))
      throw err(`source delta path must be a safe src/ path: '${oldPath}'.`);
    paths.push(oldPath);
  }
  return paths;
}

export async function generateThreePatch(options = {}) {
  const packageRoot =
    options.packageRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const pinPath = path.join(packageRoot, "three-patch", "pin.json");
  const sourceDeltaPath = path.join(packageRoot, "three-patch", "source-delta.patch");
  if (!existsSync(pinPath) || !existsSync(sourceDeltaPath)) {
    throw err("missing pin.json or source-delta.patch in three-patch directory.");
  }
  const pin = validatePin(JSON.parse(await readFile(pinPath, "utf8")));
  const sourceDelta = await readFile(sourceDeltaPath, "utf8");
  const approved = new Set(Object.keys(pin.baseFinalHashes));
  for (const rel of parseSourceDeltaPaths(sourceDelta)) {
    if (!approved.has(rel)) throw err(`source delta path '${rel}' is not a pinned target.`);
  }

  const scratch = await mkdtemp(path.join(os.tmpdir(), "tn-three-gen-"));
  try {
    const planner = options.planner ?? planFromUpstream;
    const { basePatch, upgradePatch } = await planner({
      archivePath: options.archive,
      pin,
      scratch,
      sourceDelta,
    });
    return await handleArtifacts({
      basePatch,
      upgradePatch,
      packageRoot,
      checkOnly: options.check ?? false,
    });
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
}

async function planFromUpstream({ archivePath, pin, scratch, sourceDelta }) {
  const archive = archivePath ?? path.join(scratch, "upstream.tar.gz");
  if (archivePath !== undefined && !existsSync(archivePath)) {
    throw err(`archive not found at ${archivePath}.`);
  }
  if (archivePath === undefined) await downloadArchive(ARCHIVE_URL, archive);
  if ((await fileSha256(archive)) !== pin.archiveSha256) {
    throw err("upstream archive sha256 does not match the pinned hash.");
  }

  const prefix = `three.js-${pin.commit}`;
  const members = [
    `${prefix}/src`,
    `${prefix}/build`,
    `${prefix}/utils/build`,
    `${prefix}/package.json`,
    `${prefix}/package-lock.json`,
  ];
  await execFileAsync("tar", ["-xzf", archive, "-C", scratch, "--", ...members], {
    maxBuffer: MAX_BUFFER,
  });
  const workDir = path.join(scratch, prefix);
  if ((await fileSha256(path.join(workDir, "package.json"))) !== pin.packageJsonSha256) {
    throw err("upstream package.json sha256 does not match the pin.");
  }
  if ((await fileSha256(path.join(workDir, "package-lock.json"))) !== pin.packageLockSha256) {
    throw err("upstream package-lock.json sha256 does not match the pin.");
  }

  const stockDir = path.join(scratch, "stock-snapshot");
  await cp(path.join(workDir, "src"), path.join(stockDir, "src"), { recursive: true });
  await cp(path.join(workDir, "build"), path.join(stockDir, "build"), { recursive: true });

  const deltaFile = path.join(scratch, "delta.patch");
  await writeFile(deltaFile, sourceDelta, "utf8");
  await execFileAsync("patch", ["-p1", "--batch", "--silent", "-i", deltaFile], { cwd: workDir });

  await execFileAsync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: workDir,
    maxBuffer: MAX_BUFFER,
  });
  await execFileAsync("npm", ["run", "build"], { cwd: workDir, maxBuffer: MAX_BUFFER });

  return assemblePatches({ patchedDir: workDir, pin, stockDir });
}

async function downloadArchive(url, dest) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok || response.body === null) {
    throw err(`could not fetch the upstream archive: HTTP ${response.status}.`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(dest));
}

/** Emit the base patch and the upgrade bundle for exactly the pinned target paths. */
export async function assemblePatches({ stockDir, patchedDir, pin }) {
  validatePin(pin);
  const sections = [];
  const targetTexts = {};
  const generatedFinalHashes = {};
  const migrationPaths = new Set(pin.frozenCompatPairs.map((pair) => pair.path));
  for (const rel of Object.keys(pin.baseFinalHashes).sort()) {
    const oldFile = path.join(stockDir, rel);
    const newFile = path.join(patchedDir, rel);
    if (!existsSync(oldFile) || !existsSync(newFile)) throw err(`missing scoped target ${rel}.`);
    const oldBytes = await readFile(oldFile);
    const newBytes = await readFile(newFile);
    generatedFinalHashes[rel] = blobHash(newBytes);
    // Carry the current target only where a consumer can hold a different copy of it: an older
    // compat state, or a target this build changed from the previously shipped one. An unchanged
    // target is recognised by hash and never needs its full text duplicated in the bundle.
    if (migrationPaths.has(rel) || generatedFinalHashes[rel] !== pin.baseFinalHashes[rel]) {
      targetTexts[rel] = newBytes.toString("utf8");
    }
    const diff = await diffScopedFile(oldFile, newFile, rel);
    if (diff.length > 0) sections.push(diff);
  }

  const targetJson = Buffer.from(JSON.stringify(targetTexts));
  if (targetJson.length > MAX_BUNDLE_BYTES) throw err("upgrade target JSON exceeds the 8MiB cap.");
  const bundle = zlib.brotliCompressSync(targetJson, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 6,
      [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
    },
  });
  if (bundle.length > MAX_BUNDLE_BYTES) throw err("upgrade brotli bundle exceeds the 8MiB cap.");

  const upgradeJson = {
    version: 2,
    generator: "scripts/generate-three-patch.mjs",
    pin: { commit: pin.commit, version: pin.version },
    acceptedLegacyCompatPairs: pin.frozenCompatPairs,
    acceptedLegacyFinalHashes: pin.baseFinalHashes,
    generatedFinalHashes,
    bundleBrotliBase64: bundle.toString("base64"),
  };
  return {
    basePatch: sections.join(""),
    upgradePatch: `${JSON.stringify(upgradeJson, null, 2)}\n`,
  };
}

async function diffScopedFile(oldFile, newFile, rel) {
  let raw = "";
  try {
    const result = await execFileAsync(
      "git",
      [
        "diff",
        "--no-index",
        "--no-color",
        "--no-ext-diff",
        "--unified=3",
        "--diff-algorithm=myers",
        "--",
        oldFile,
        newFile,
      ],
      { maxBuffer: MAX_BUFFER },
    );
    raw = result.stdout;
  } catch (error) {
    if (typeof error.stdout === "string" && error.stdout.length > 0) raw = error.stdout;
    else throw error;
  }
  if (raw.length === 0) return "";
  const oldBlob = blobHash(await readFile(oldFile));
  const newBlob = blobHash(await readFile(newFile));
  return raw
    .split("\n")
    .map((line) => {
      if (line.startsWith("diff --git ")) return `diff --git a/${rel} b/${rel}`;
      if (line.startsWith("index ")) return `index ${oldBlob}..${newBlob} 100644`;
      if (line.startsWith("--- ")) return `--- a/${rel}`;
      if (line.startsWith("+++ ")) return `+++ b/${rel}`;
      return line;
    })
    .join("\n");
}

async function handleArtifacts({ basePatch, upgradePatch, packageRoot, checkOnly }) {
  const baseDest = path.join(packageRoot, "patches", BASE_PATCH_NAME);
  const upgradeDest = path.join(packageRoot, "patches", UPGRADE_PATCH_NAME);
  if (checkOnly) {
    const currentBase = existsSync(baseDest) ? await readFile(baseDest, "utf8") : "";
    const currentUpgrade = existsSync(upgradeDest) ? await readFile(upgradeDest, "utf8") : "";
    if (currentBase !== basePatch || currentUpgrade !== upgradePatch) {
      throw err("check failed, generated patch drifts from the committed patch.");
    }
    return { status: "matched" };
  }
  await mkdir(path.dirname(baseDest), { recursive: true });
  await writeFile(baseDest, basePatch, "utf8");
  await writeFile(upgradeDest, upgradePatch, "utf8");
  return { status: "written" };
}

function parseCli(argv) {
  const options = { archive: undefined, check: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") options.check = true;
    else if (arg === "--archive") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw err("--archive requires a path.");
      options.archive = value;
      index += 1;
    } else throw err(`unknown argument '${arg}'.`);
  }
  return options;
}

const entry = process.argv[1];
if (entry !== undefined && path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url))) {
  const result = await generateThreePatch(parseCli(process.argv.slice(2)));
  process.stdout.write(`generate-three-patch: ${result.status}\n`);
}
