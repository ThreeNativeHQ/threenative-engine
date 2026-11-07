// One derivation of what this checkout ships, read from disk every time.
//
// A hand-typed kit or package list goes stale the moment a directory is added, and it fails
// quietly: `scripts/capability-recall.ts` skipped the `puzzle`, `rts` and `runner` kits for months
// because its list predated them. Every consumer reads this module instead, so shipping a kit or a
// package is one directory, not an edit in four scripts.
//
// Plain ESM on purpose: CI runs `node scripts/*.mjs` on Node 20, which cannot import `.ts`.
// `repo-inventory.d.mts` carries the types for the TypeScript callers.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function childDirectories(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));
}

function shipping(directory, marker) {
  return childDirectories(directory).filter((name) =>
    existsSync(path.join(directory, name, marker)),
  );
}

/**
 * Directory names under `packages/` that carry a manifest. Directory names, not package names:
 * every consumer here builds `packages/<directory>/…` paths or expressions.
 */
export function workspacePackageNames(root = REPO_ROOT) {
  return shipping(path.join(root, "packages"), "package.json");
}

/**
 * The same list read from the Git tree instead of the working tree.
 *
 * The CI scope job checks out `scripts/` and each `kit.json` only — 20 MB against 488 MB — so no
 * package manifest is on disk there and `workspacePackageNames` sees nothing. Names are trees, not
 * blobs, so `ls-tree` answers without fetching a byte.
 */
export function workspacePackageNamesFromTree(root = REPO_ROOT) {
  const listing = execFileSync(
    "git",
    ["-C", root, "ls-tree", "-r", "--name-only", "HEAD", "--", "packages"],
    {
      encoding: "utf8",
    },
  );
  return [
    ...new Set(
      listing
        .split("\n")
        .map((line) => /^packages\/([^/]+)\/package\.json$/u.exec(line)?.[1])
        .filter((name) => name !== undefined),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

/** Kit directory names. A directory is a kit when it ships `kit.json`, which is the lookup data. */
export function templateNames(root = REPO_ROOT) {
  return shipping(path.join(root, "packages", "create-threenative", "templates"), "kit.json");
}

/** Benchmark brief genres. A genre is a brief when it ships `brief.md`. */
export function briefGenres(root = REPO_ROOT) {
  return shipping(path.join(root, "docs", "benchmark", "genres"), "brief.md");
}

/** The Node floor this repository declares once, in its root `package.json` `engines.node`. */
export function nodeEngineRange(root = REPO_ROOT) {
  const manifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const range = manifest?.engines?.node;
  if (typeof range !== "string" || range.length === 0) {
    throw new Error("TN_REPO_INVENTORY: the root package.json declares no engines.node");
  }
  return range;
}

/** `nodeEngineRange` without its operator, the form an error message or a version check uses. */
export function minimumNodeVersion(root = REPO_ROOT) {
  const minimum = /(\d+(?:\.\d+)*)/u.exec(nodeEngineRange(root))?.[1];
  if (minimum === undefined) {
    throw new Error(`TN_REPO_INVENTORY: engines.node '${nodeEngineRange(root)}' names no version`);
  }
  return minimum;
}
