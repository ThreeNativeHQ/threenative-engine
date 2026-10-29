#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync } from "node:zlib";

const THREE_VERSION = "0.185.1";
const PIN_COMMIT = "2431a09f46f34c560bc8e44b33be0e567723d5b9";
const PATCH_NAME = `three@${THREE_VERSION}.patch`;
const UPGRADE_PATCH_NAME = `three@${THREE_VERSION}-prd269-upgrade.patch`;
const UPGRADE_JSON_VERSION = 2;
const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
const HEX40 = /^[a-f0-9]{40}$/u;

/** Apply the package-owned Three.js patch to the dependency resolved for the consumer. */
export async function applyThreePatch(options = {}) {
  const packageRoot =
    options.packageRoot ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const consumerRoot = path.resolve(
    options.consumerRoot ??
      process.env.INIT_CWD ??
      process.env.npm_config_local_prefix ??
      process.cwd(),
  );
  const threeRoot = options.threeRoot ?? resolveThreeRoot(consumerRoot, packageRoot);
  const manifestPath = path.join(threeRoot, "package.json");
  const manifest = await readJson(manifestPath, "Three.js package manifest");
  if (manifest.name !== "three" || manifest.version !== THREE_VERSION) {
    throw new Error(
      `TN_THREE_PATCH_VERSION: expected three@${THREE_VERSION}, found ${String(manifest.name)}@${String(manifest.version)} at ${manifestPath}.`,
    );
  }

  const patchPath = path.join(packageRoot, "patches", PATCH_NAME);
  const patch = parsePatch(await readFile(patchPath, "utf8"), patchPath);
  const upgradePath = path.join(packageRoot, "patches", UPGRADE_PATCH_NAME);
  const upgrade = existsSync(upgradePath)
    ? parseUpgrade(await readFile(upgradePath, "utf8"), upgradePath, patch)
    : { legacy: [] };
  const plans = await planPatch(threeRoot, patch, upgrade);
  // `planPatch` refuses any file it does not fully recognise, so every plan that is not already
  // `patched` is safe to write — including the files an older release of this patch already
  // touched, which is the state a project upgrading from the previous `latest` is in.
  if (plans.every((plan) => plan.status === "patched")) return "unchanged";

  for (const plan of plans)
    if (plan.status !== "patched") await writeFile(plan.file, plan.contents, "utf8");
  return "patched";
}

function resolveThreeRoot(consumerRoot, packageRoot) {
  const attempted = [];
  for (const root of [packageRoot, consumerRoot]) {
    try {
      const resolver = createRequire(path.join(root, "package.json"));
      const entry = resolver.resolve("three");
      const resolvedRoot = findPackageRoot(entry);
      if (!isWithinModuleSearchPath(resolvedRoot, root)) {
        throw new Error(`resolved outside local module paths: ${resolvedRoot}`);
      }
      return resolvedRoot;
    } catch (error) {
      attempted.push(`${root}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`TN_THREE_PATCH_MISSING: could not resolve three from ${attempted.join("; ")}.`);
}

function isWithinModuleSearchPath(candidate, root) {
  return moduleSearchPaths(root).some((searchPath) => isWithinRoot(candidate, searchPath));
}

function moduleSearchPaths(root) {
  const paths = [];
  let current = path.resolve(root);
  while (true) {
    if (path.basename(current) !== "node_modules") paths.push(path.join(current, "node_modules"));
    const parent = path.dirname(current);
    if (parent === current) return paths;
    current = parent;
  }
}

function isWithinRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function findPackageRoot(entry) {
  let current = path.dirname(entry);
  while (true) {
    if (existsSync(path.join(current, "package.json"))) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`TN_THREE_PATCH_MISSING: resolved three entry has no package.json: ${entry}.`);
}

async function readJson(file, description) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    throw new Error(
      `TN_THREE_PATCH_MISSING: could not read ${description} at ${file}: ${String(error)}.`,
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `TN_THREE_PATCH_INVALID: ${description} at ${file} is not valid JSON: ${String(error)}.`,
    );
  }
}

function parsePatch(text, patchPath) {
  const files = parsePatchFiles(text, patchPath);
  if (files.length === 0)
    throw new Error(`TN_THREE_PATCH_INVALID: no file patches in ${patchPath}.`);
  for (const file of files) {
    validatePatchFile(file, patchPath);
  }
  return files;
}

function parsePatchFiles(text, patchPath) {
  const files = [];
  let current;
  let hunk;
  for (const line of text.replaceAll("\r\n", "\n").split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (current !== undefined) files.push(finishPatchFile(current, patchPath));
      current = { hunks: [], oldPath: undefined, newPath: undefined };
      hunk = undefined;
      continue;
    }
    if (current === undefined) continue;
    hunk = parsePatchLine(line, current, hunk, patchPath);
  }
  if (current !== undefined) files.push(finishPatchFile(current, patchPath));
  return files;
}

function parsePatchLine(line, current, hunk, patchPath) {
  const blobs = /^index ([a-f0-9]{40})\.\.([a-f0-9]{40}) /u.exec(line);
  if (blobs !== null) {
    current.oldBlob = blobs[1];
    current.newBlob = blobs[2];
    return hunk;
  }
  if (line.startsWith("--- ")) {
    current.oldPath = patchPathFromHeader(line.slice(4), patchPath);
    return hunk;
  }
  if (line.startsWith("+++ ")) {
    current.newPath = patchPathFromHeader(line.slice(4), patchPath);
    return hunk;
  }
  const parsedHunk = parsePatchHunk(line);
  if (parsedHunk !== undefined) {
    current.hunks.push(parsedHunk);
    return parsedHunk;
  }
  if (line !== "\\ No newline at end of file" && hunk !== undefined && isPatchLine(line))
    hunk.lines.push(line);
  return hunk;
}

function finishPatchFile(file, patchPath) {
  if (file.oldPath === undefined || file.newPath === undefined || file.hunks.length === 0) {
    throw new Error(`TN_THREE_PATCH_INVALID: incomplete file patch in ${patchPath}.`);
  }
  if (file.oldPath !== file.newPath) {
    throw new Error(`TN_THREE_PATCH_INVALID: rename patches are not supported in ${patchPath}.`);
  }
  return file;
}

function parsePatchHunk(line) {
  const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
  if (header === null) return undefined;
  return {
    lines: [],
    newCount: Number(header[4] ?? 1),
    newStart: Number(header[3]),
    oldCount: Number(header[2] ?? 1),
    oldStart: Number(header[1]),
  };
}

function isPatchLine(line) {
  return line[0] === " " || line[0] === "+" || line[0] === "-";
}

function validatePatchFile(file, patchPath) {
  for (const candidate of file.hunks) {
    const oldCount = candidate.lines.filter((line) => line[0] === " " || line[0] === "-").length;
    const newCount = candidate.lines.filter((line) => line[0] === " " || line[0] === "+").length;
    if (oldCount !== candidate.oldCount || newCount !== candidate.newCount) {
      throw new Error(`TN_THREE_PATCH_INVALID: hunk line counts do not match in ${patchPath}.`);
    }
  }
}

function patchPathFromHeader(header, patchPath) {
  const value = header.trim().split(/\s+/u)[0];
  if (value === undefined || (!value.startsWith("a/") && !value.startsWith("b/"))) {
    throw new Error(`TN_THREE_PATCH_INVALID: unsupported file path in ${patchPath}.`);
  }
  const relative = value.slice(2);
  if (relative.length === 0 || relative.split("/").some((part) => part === ".." || part === "")) {
    throw new Error(`TN_THREE_PATCH_INVALID: unsafe file path '${value}' in ${patchPath}.`);
  }
  return relative;
}

function invalid(message, file, cause) {
  return new Error(
    `TN_THREE_PATCH_INVALID: ${message} in ${file}${cause === undefined ? "" : `: ${String(cause)}`}.`,
  );
}

function isSafeRelativePath(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

/**
 * The upgrade patch is either the current versioned JSON document or the legacy unified diff an
 * older release shipped. The JSON is detected by its opening brace; anything else stays the
 * legacy reader's input, byte for byte.
 */
function parseUpgrade(text, upgradePath, baseFiles) {
  if (!text.trimStart().startsWith("{")) return { legacy: parsePatch(text, upgradePath) };
  return { json: parseUpgradeJson(text, upgradePath, baseFiles), legacy: [] };
}

function parseUpgradeJson(text, upgradePath, baseFiles) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw invalid("upgrade patch is not valid JSON", upgradePath, error);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw invalid("upgrade patch JSON is not an object", upgradePath);
  }
  if (raw.version !== UPGRADE_JSON_VERSION) {
    throw invalid(`unsupported upgrade version ${String(raw.version)}`, upgradePath);
  }
  if (
    raw.pin === null ||
    typeof raw.pin !== "object" ||
    raw.pin.version !== THREE_VERSION ||
    raw.pin.commit !== PIN_COMMIT
  ) {
    throw invalid("upgrade pin must name the supported three version and commit", upgradePath);
  }

  const compatOldHashes = new Map();
  if (!Array.isArray(raw.acceptedLegacyCompatPairs) || raw.acceptedLegacyCompatPairs.length === 0) {
    throw invalid("acceptedLegacyCompatPairs must be a non-empty array", upgradePath);
  }
  const seenPairs = new Set();
  for (const pair of raw.acceptedLegacyCompatPairs) {
    if (pair === null || typeof pair !== "object") {
      throw invalid("acceptedLegacyCompatPairs has a non-object entry", upgradePath);
    }
    if (!isSafeRelativePath(pair.path))
      throw invalid(`unsafe compat path '${pair.path}'`, upgradePath);
    if (!HEX40.test(pair.oldHash ?? "") || !HEX40.test(pair.newHash ?? "")) {
      throw invalid(`invalid 40-hex compat hash for '${pair.path}'`, upgradePath);
    }
    const key = `${pair.path}\0${pair.oldHash}`;
    if (seenPairs.has(key)) throw invalid(`duplicate compat pair '${pair.path}'`, upgradePath);
    seenPairs.add(key);
    const hashes = compatOldHashes.get(pair.path) ?? new Set();
    hashes.add(pair.oldHash);
    compatOldHashes.set(pair.path, hashes);
  }

  const acceptedLegacyFinalHashes = validateHashMap(
    raw.acceptedLegacyFinalHashes,
    "acceptedLegacyFinalHashes",
    upgradePath,
  );
  const generatedFinalHashes = validateHashMap(
    raw.generatedFinalHashes,
    "generatedFinalHashes",
    upgradePath,
  );
  for (const pair of raw.acceptedLegacyCompatPairs) {
    if (pair.newHash !== acceptedLegacyFinalHashes[pair.path]) {
      throw invalid(
        `compat pair '${pair.path}' does not match its accepted final hash`,
        upgradePath,
      );
    }
  }

  if (typeof raw.bundleBrotliBase64 !== "string" || raw.bundleBrotliBase64.length === 0) {
    throw invalid("bundleBrotliBase64 must be a non-empty string", upgradePath);
  }
  if (
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(raw.bundleBrotliBase64) ||
    raw.bundleBrotliBase64.length % 4 !== 0
  ) {
    throw invalid("bundleBrotliBase64 is not valid base64", upgradePath);
  }
  let bundleBuffer;
  try {
    bundleBuffer = Buffer.from(raw.bundleBrotliBase64, "base64");
  } catch (error) {
    throw invalid("bundleBrotliBase64 is not valid base64", upgradePath, error);
  }
  let bundleText;
  try {
    bundleText = brotliDecompressSync(bundleBuffer, { maxOutputLength: MAX_BUNDLE_BYTES });
  } catch (error) {
    throw invalid("upgrade bundle is not a bounded Brotli payload", upgradePath, error);
  }
  let targetTexts;
  try {
    targetTexts = JSON.parse(bundleText.toString("utf8"));
  } catch (error) {
    throw invalid("upgrade bundle is not valid JSON", upgradePath, error);
  }
  if (targetTexts === null || typeof targetTexts !== "object" || Array.isArray(targetTexts)) {
    throw invalid("upgrade bundle is not a path-to-text object", upgradePath);
  }

  const baseByPath = new Map(baseFiles.map((file) => [file.oldPath, file]));
  for (const [rel, base] of baseByPath) {
    if (generatedFinalHashes[rel] !== base.newBlob) {
      throw invalid(`base patch target '${rel}' has no matching generated hash`, upgradePath);
    }
    if (acceptedLegacyFinalHashes[rel] === undefined) {
      throw invalid(`base patch target '${rel}' has no matching accepted final hash`, upgradePath);
    }
  }
  for (const rel of Object.keys(generatedFinalHashes)) {
    if (!baseByPath.has(rel)) {
      throw invalid(`generated hash '${rel}' is not in the base patch`, upgradePath);
    }
  }
  for (const rel of Object.keys(acceptedLegacyFinalHashes)) {
    if (!baseByPath.has(rel)) {
      throw invalid(`accepted final hash '${rel}' is not in the base patch`, upgradePath);
    }
  }
  for (const pair of raw.acceptedLegacyCompatPairs) {
    if (!baseByPath.has(pair.path)) {
      throw invalid(`compat pair '${pair.path}' is not in the base patch`, upgradePath);
    }
  }
  for (const [rel, contents] of Object.entries(targetTexts)) {
    if (!isSafeRelativePath(rel) || typeof contents !== "string") {
      throw invalid(`unsafe or invalid upgrade target '${rel}'`, upgradePath);
    }
    if (!baseByPath.has(rel)) {
      throw invalid(`upgrade target '${rel}' is not in the base patch`, upgradePath);
    }
    if (blobHash(contents) !== generatedFinalHashes[rel]) {
      throw invalid(`upgrade target '${rel}' does not match its generated hash`, upgradePath);
    }
  }
  for (const [rel] of baseByPath) {
    const needsTarget =
      compatOldHashes.has(rel) || generatedFinalHashes[rel] !== acceptedLegacyFinalHashes[rel];
    if (needsTarget && targetTexts[rel] === undefined) {
      throw invalid(`upgrade bundle is missing the target for '${rel}'`, upgradePath);
    }
    if (!needsTarget && targetTexts[rel] !== undefined) {
      throw invalid(`upgrade bundle has an unneeded target for '${rel}'`, upgradePath);
    }
  }

  return { acceptedLegacyFinalHashes, compatOldHashes, generatedFinalHashes, targetTexts };
}

function validateHashMap(map, name, upgradePath) {
  if (map === null || typeof map !== "object" || Array.isArray(map)) {
    throw invalid(`${name} must be a path-to-hash object`, upgradePath);
  }
  const keys = Object.keys(map);
  if (keys.length === 0) throw invalid(`${name} must be non-empty`, upgradePath);
  for (const rel of keys) {
    if (!isSafeRelativePath(rel)) throw invalid(`unsafe ${name} path '${rel}'`, upgradePath);
    if (!HEX40.test(map[rel]))
      throw invalid(`invalid 40-hex ${name} hash for '${rel}'`, upgradePath);
  }
  return map;
}

async function planPatch(threeRoot, files, upgrade) {
  const plans = [];
  for (const file of files) {
    const target = path.resolve(threeRoot, file.oldPath);
    if (path.relative(threeRoot, target).startsWith(`..${path.sep}`)) {
      throw new Error(
        `TN_THREE_PATCH_INVALID: patch escapes the Three.js package: ${file.oldPath}.`,
      );
    }
    const original = await readFile(target, "utf8");
    if (upgrade.json !== undefined) {
      plans.push(planJsonFile(original, file, upgrade.json, target));
      continue;
    }
    const recognised = upgradeKnownFile(original, file.oldPath, upgrade.legacy);
    const lines = recognised.replaceAll("\r\n", "\n").split("\n");
    const states = classifyFile(lines, file.hunks);
    const unknown = states.findIndex((state) => state === "unknown");
    if (unknown !== -1) {
      throw new Error(
        `TN_THREE_PATCH_PARTIAL: hunk ${String(unknown + 1)} of ${file.oldPath} matches neither the stock nor the patched text in ${target}; refusing to modify an installation this package does not recognise.`,
      );
    }
    const status = states.every((state) => state === "patched")
      ? "patched"
      : states.some((state) => state === "patched")
        ? "extended"
        : "stock";
    assertKnownExtension(status, recognised === original, file.oldPath, upgrade.legacy);
    if (status === "patched") {
      plans.push({
        contents: recognised,
        file: target,
        status: recognised === original ? status : "extended",
      });
      continue;
    }
    const contents = applyFile(lines, file.hunks, states, target).join("\n");
    if (file.newBlob !== undefined && blobHash(contents) !== file.newBlob) {
      throw invalid(
        "patched output does not match the base patch index blob",
        file.oldPath,
        target,
      );
    }
    plans.push({ contents, file: target, status });
  }
  return plans;
}

/**
 * Plan one file against the versioned JSON upgrade: an exact current target is idempotent, an
 * exact known predecessor (legacy compat hash or the previously shipped final hash) is replaced
 * wholesale by the bundle's current target, and an exact stock file takes the base patch hunks.
 * Anything else on a registered path is refused before any file is written.
 */
function planJsonFile(original, file, json, target) {
  const rel = file.oldPath;
  const normalized = original.replaceAll("\r\n", "\n");
  const hash = blobHash(normalized);
  if (hash === json.generatedFinalHashes[rel]) {
    return {
      contents: normalized,
      file: target,
      status: original === normalized ? "patched" : "extended",
    };
  }
  const legacy = json.compatOldHashes.get(rel);
  if (legacy?.has(hash) === true || hash === json.acceptedLegacyFinalHashes[rel]) {
    const contents = json.targetTexts[rel];
    if (contents === undefined) throw partialError(rel, undefined, target);
    return { contents, file: target, status: "extended" };
  }
  if (hash === file.oldBlob) {
    const lines = normalized.split("\n");
    const states = classifyFile(lines, file.hunks);
    const unknown = states.findIndex((state) => state === "unknown");
    if (unknown !== -1) throw partialError(rel, unknown, target);
    const applied = applyFile(lines, file.hunks, states, target).join("\n");
    if (blobHash(applied) !== file.newBlob) {
      throw invalid("patched output does not match the base patch index blob", rel, target);
    }
    return {
      contents: applied,
      file: target,
      status: applied === original ? "patched" : "extended",
    };
  }
  throw partialError(rel, undefined, target);
}

function partialError(rel, hunkNumber, target) {
  const where = hunkNumber === undefined ? "" : `hunk ${String(hunkNumber + 1)} of `;
  return new Error(
    `TN_THREE_PATCH_PARTIAL: ${where}${rel} matches neither a supported predecessor nor the current patch in ${target}; refusing to modify an installation this package does not recognise.`,
  );
}

/** Registered migration files must not fall through to permissive hunk-only upgrades. */
function assertKnownExtension(status, unchanged, file, upgrades) {
  if (
    status === "extended" &&
    unchanged &&
    upgrades.some((candidate) => candidate.oldPath === file)
  ) {
    throw new Error(
      `TN_THREE_PATCH_PARTIAL: ${file} is partly patched but does not match an exact supported predecessor; refusing an unrecognised installation.`,
    );
  }
}

/** Upgrade only exact known prior blobs; a custom edit never enters this migration. */
function upgradeKnownFile(original, file, upgrades, seen = new Set()) {
  const normalized = original.replaceAll("\r\n", "\n");
  const upgrade = upgrades.find(
    (candidate) => candidate.oldPath === file && candidate.oldBlob === blobHash(normalized),
  );
  if (upgrade === undefined) return original;
  if (seen.has(upgrade.oldBlob))
    throw new Error(`TN_THREE_PATCH_INVALID: cyclic known upgrade for ${file}.`);
  seen.add(upgrade.oldBlob);
  const lines = normalized.split("\n");
  const states = classifyFile(lines, upgrade.hunks);
  if (states.some((state) => state !== "stock"))
    throw new Error(`TN_THREE_PATCH_INVALID: known upgrade hunks do not match ${file}.`);
  const contents = applyFile(lines, upgrade.hunks, states, file).join("\n");
  if (blobHash(contents) !== upgrade.newBlob)
    throw new Error(`TN_THREE_PATCH_INVALID: known upgrade output does not match ${file}.`);
  return upgradeKnownFile(contents, file, upgrades, seen);
}

function blobHash(contents) {
  return createHash("sha1")
    .update(`blob ${Buffer.byteLength(contents)}\0`)
    .update(contents)
    .digest("hex");
}

/**
 * Every hunk's state in this file, in patch order: `"stock"`, `"patched"` or `"unknown"`.
 *
 * Per hunk rather than per file, because an upgrade lands on a file an *older release of this same
 * package's patch* already modified. The consumer declares the patch in its own manifest, so the
 * package manager applies it at install time — meaning a project scaffolded from the previous
 * `latest` carries the previous patch's text, and only this release's new hunks are still stock.
 * Both states are repairable by applying the stock remainder, and the old hunks are not re-derived
 * from a different patch: they are this patch's own hunks, already at their patched text.
 *
 * A hunk in neither state is a file this package does not recognise — hand-edited, or owned by a
 * different patch — and stays the refusal it always was.
 */
function classifyFile(lines, hunks) {
  const states = [];
  let offset = 0;
  for (const hunk of hunks) {
    const oldLines = hunkLines(hunk, "old");
    const newLines = hunkLines(hunk, "new");
    // A deletion's remaining context also occurs in stock; its full old text wins.
    if (
      !hunk.lines.some((line) => line[0] === "+") &&
      locate(lines, oldLines, hunk.oldStart - 1 + offset) !== undefined
    )
      states.push("stock");
    else if (locate(lines, newLines, hunk.newStart - 1) !== undefined) states.push("patched");
    else if (locate(lines, oldLines, hunk.oldStart - 1 + offset) !== undefined)
      states.push("stock");
    else states.push("unknown");
    offset += newLines.length - oldLines.length;
  }
  return states;
}

function hunkLines(hunk, side) {
  return hunk.lines
    .filter((line) =>
      side === "old" ? line[0] === " " || line[0] === "-" : line[0] === " " || line[0] === "+",
    )
    .map((line) => line.slice(1));
}

function applyFile(lines, hunks, states, file) {
  const result = [...lines];
  let offset = 0;
  for (const [number, hunk] of hunks.entries()) {
    const oldLines = hunkLines(hunk, "old");
    const newLines = hunkLines(hunk, "new");
    const index = locate(result, oldLines, hunk.oldStart - 1 + offset);
    if (states[number] === "stock") {
      if (index === undefined)
        throw new Error(`TN_THREE_PATCH_INVALID: stock hunk no longer matches ${file}.`);
      result.splice(index, oldLines.length, ...newLines);
    }
    // Already-patched hunks are left alone. Their line-count change is already in the file, so
    // the offset still moves to keep later stock hunks near their expected location.
    offset += newLines.length - oldLines.length;
  }
  return result;
}

function locate(lines, expected, preferred) {
  const candidates = [];
  for (let index = 0; index <= lines.length - expected.length; index += 1) {
    if (expected.every((line, offset) => lines[index + offset] === line)) candidates.push(index);
  }
  if (candidates.length === 0) return undefined;
  candidates.sort((left, right) => Math.abs(left - preferred) - Math.abs(right - preferred));
  if (
    candidates.length > 1 &&
    Math.abs(candidates[0] - preferred) === Math.abs(candidates[1] - preferred)
  ) {
    throw new Error(
      `TN_THREE_PATCH_INVALID: ambiguous hunk location near line ${String(preferred + 1)}.`,
    );
  }
  return candidates[0];
}

const entry = process.argv[1];
if (entry !== undefined && path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url))) {
  const result = await applyThreePatch();
  process.stdout.write(`threenative: Three.js velocity patch ${result}\n`);
}
