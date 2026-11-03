/**
 * The repository Actions cache is 10 GiB for every lane together, and a full board spends more than
 * that: on 2026-11-03 the 56 live entries measured 10.2 GiB (`gh api …/actions/caches`), and the
 * develop warm run 41575174097 restored no compiler cache at all — "Cache not found for input keys:
 * native-ccache-ci-test-native-…" — while that lane's own 20 MB entry had just been evicted. GitHub
 * evicts by last access, so the cheapest victim is the small hot key every run needs.
 *
 * So the janitor keeps the total under a stated budget, and bounds the one family that saves a new
 * entry per run: the 3.2 GB resumable V8 source state, which exists to be resumed, never to be kept.
 * A hot key that every run reads is never the entry this deletes.
 *
 * Usage:
 *   node scripts/ci-cache-prune.mjs <caches.jsonl>   # ids to delete, one per line; summary on stderr
 *
 * The input is the JSONL `gh api "repos/<repo>/actions/caches?per_page=100" --paginate --jq
 * '.actions_caches[]'` prints.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MiB = 1024 * 1024;

/** Target for the whole repository, under the 10 GiB GitHub evicts at, so a new save fits. */
export const CACHE_BUDGET_BYTES = 9216 * MiB;

/**
 * Families that save a new entry per run. Each holds at most its share, oldest first out; every
 * other family is left alone unless the repository total is over budget.
 */
export const FAMILY_SHARES = Object.freeze({
  // The resumable Ninja state: 3.2 GB, one entry per (os, arch, recipe) is all a resume can use.
  "android-v8-source-": 3584 * MiB,
});

/**
 * Keys a run reads on every board and that cost little: the compiler cache (20 MB), the pnpm store,
 * the Playwright browsers, the workspace bundles the shared action restores, and the V8 payload the
 * release asset falls back to. Evicting one of these costs a whole job; a stale build tree, a cargo
 * registry or a wgpu pipeline cache costs one rebuild.
 */
export const HOT_PREFIXES = Object.freeze([
  "node-cache-",
  "native-ccache-",
  "playwright-",
  "workspace-dist-",
  "android-v8-payload-",
  // The prefixes are read from the workflows, not guessed: `native-rust-cache/action.yml`
  // `prefix=cargo-v1-…`, `pipeline-cache.yml` `wgpu-cache-…` and `pipeline-cache-host-deps-…`.
  "cargo-v1-",
  "wgpu-cache-",
  "pipeline-cache-host-deps-",
]);

function prefixOf(key, prefixes) {
  return prefixes.find((prefix) => key.startsWith(prefix)) ?? "";
}

function familyOf(entry, families) {
  const prefix = prefixOf(entry.key, families);
  if (prefix === "") return "";
  // A bounded family's key ends in `-<run id>-<attempt>`, so the recipe is everything before it.
  const recipe = entry.key.slice(prefix.length).replace(/-\d+-\d+$/u, "");
  // Caches are ref-scoped: two pull requests never read each other's entries, so a newer state on
  // one ref must not delete another ref's — the family name carries the ref for that reason.
  return `${prefix}${entry.ref ?? ""}|${recipe}`;
}

function bytesOf(entry) {
  const size = Number(entry.size_in_bytes);
  return Number.isFinite(size) && size > 0 ? size : 0;
}

function readEntries(caches) {
  return caches
    .filter((entry) => Number.isInteger(entry.id) && typeof entry.key === "string")
    .map((entry) => ({
      id: entry.id,
      key: entry.key,
      ref: entry.ref,
      bytes: bytesOf(entry),
      accessed: Date.parse(entry.last_accessed_at ?? entry.created_at ?? 0) || 0,
    }))
    .sort((left, right) => left.accessed - right.accessed);
}

/** One entry per bounded family, per recipe and ref: the newest is the state a resume can read. */
function boundFamilies(entries, familyShares, doomed) {
  const boundaries = Object.keys(familyShares);
  const families = new Map();
  for (const entry of entries) {
    const family = familyOf(entry, boundaries);
    if (family === "") continue;
    if (!families.has(family)) families.set(family, []);
    families.get(family).push(entry);
  }
  for (const [family, members] of families) {
    const share = familyShares[prefixOf(family, boundaries)];
    let held = members.reduce((sum, entry) => sum + entry.bytes, 0);
    // Oldest first, but never the newest member.
    for (const entry of members.slice(0, -1)) {
      if (held <= share) break;
      doomed.add(entry.id);
      held -= entry.bytes;
    }
  }
}

/** Then the repository total, least recently accessed first, and never a hot key. */
function fitBudget(entries, budgetBytes, hotPrefixes, doomed) {
  let total = entries.reduce((sum, entry) => (doomed.has(entry.id) ? sum : sum + entry.bytes), 0);
  for (const entry of entries) {
    if (total <= budgetBytes) break;
    if (doomed.has(entry.id) || prefixOf(entry.key, hotPrefixes) !== "") continue;
    doomed.add(entry.id);
    total -= entry.bytes;
  }
  return total;
}

/**
 * Which entries a janitor run deletes, and what the total becomes. Pure: the caller deletes them.
 */
export function planCachePrune({
  caches,
  budgetBytes = CACHE_BUDGET_BYTES,
  familyShares = FAMILY_SHARES,
  hotPrefixes = HOT_PREFIXES,
}) {
  const entries = readEntries(caches);
  const doomed = new Set();
  boundFamilies(entries, familyShares, doomed);
  const totalAfter = fitBudget(entries, budgetBytes, hotPrefixes, doomed);
  return {
    deleteIds: entries.filter((entry) => doomed.has(entry.id)).map((entry) => entry.id),
    totalBefore: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    totalAfter,
    budgetBytes,
    overBudget: totalAfter > budgetBytes,
  };
}

/** JSONL (what `gh api --paginate --jq '.actions_caches[]'` prints) or one JSON document. */
export function parseCaches(text) {
  const trimmed = text.trim();
  if (trimmed === "") return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
    return Array.isArray(parsed.actions_caches) ? parsed.actions_caches : [parsed];
  } catch {
    return trimmed.split("\n").map((line) => JSON.parse(line));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: node scripts/ci-cache-prune.mjs <caches.jsonl>");
    process.exit(2);
  }
  const plan = planCachePrune({ caches: parseCaches(readFileSync(file, "utf8")) });
  const GiB = 1024 * MiB;
  const over = plan.overBudget ? "; STILL OVER BUDGET with only hot keys left" : "";
  // "planned for deletion": the caller deletes them, and an entry that expired between the two
  // steps makes a count printed here a lie.
  console.error(
    `cache ${(plan.totalBefore / GiB).toFixed(2)} GiB -> ${(plan.totalAfter / GiB).toFixed(2)} GiB` +
      ` of ${(plan.budgetBytes / GiB).toFixed(2)} GiB; ${plan.deleteIds.length} entr(ies) planned for deletion${over}`,
  );
  process.stdout.write(plan.deleteIds.map((id) => `${id}\n`).join(""));
}
