/**
 * The cache budget is 10 GiB for every lane together, and GitHub evicts by last access. That is why
 * a 20 MB compiler cache disappeared between two develop runs while a 1.5 GB build tree stayed: the
 * cheap victim is the hot key every board needs. This janitor plan keeps the total under a stated
 * budget, bounds the resumable V8 state to one entry per recipe, and never deletes the newest copy
 * of a hot key — an older copy of one is stale, because its key carries a source hash.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../test-support/temp-dir.js";
import {
  CACHE_BUDGET_BYTES,
  FAMILY_SHARES,
  HOT_PREFIXES,
  type ICacheEntry,
  parseCaches,
  planCachePrune,
} from "../ci-cache-prune.mjs";
import { jobSections } from "../ci-workflow.js";

const repo = join(import.meta.dirname, "..", "..");

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

let nextId = 1;
function entry(key: string, sizeGiB: number, accessedHoursAgo: number, ref = "refs/heads/develop") {
  return {
    id: nextId++,
    key,
    ref,
    size_in_bytes: Math.round(sizeGiB * GiB),
    last_accessed_at: new Date(
      Date.UTC(2026, 10, 3, 4, 0, 0) - accessedHoursAgo * 3_600_000,
    ).toISOString(),
  };
}

describe("the cache janitor plan", () => {
  it("states a budget under GitHub's 10 GiB and a share for the resumable V8 state", () => {
    expect(CACHE_BUDGET_BYTES).toBeLessThan(10 * GiB);
    expect(CACHE_BUDGET_BYTES).toBeGreaterThan(8 * GiB);
    expect(FAMILY_SHARES["android-v8-source-"]).toBeLessThan(CACHE_BUDGET_BYTES);
    // The hot keys are named, not inferred: a rule that guessed would eventually guess wrong.
    expect(HOT_PREFIXES).toContain("native-ccache-");
    expect(HOT_PREFIXES).toContain("node-cache-");
  });

  it("leaves a healthy cache alone", () => {
    const plan = planCachePrune({
      caches: [
        entry("native-ccache-ci-test-native-Linux-X64-gcc-3ea15707-41575174097", 0.02, 1),
        entry("native-third-party-Linux-X64-40c3eb14", 0.16, 2),
      ],
    });
    expect(plan.deleteIds).toEqual([]);
    expect(plan.overBudget).toBe(false);
    expect(plan.totalAfter).toBe(plan.totalBefore);
  });

  it("keeps one resumable V8 state per recipe and ref, the newest", () => {
    const recipe = "android-v8-source-Linux-X64-3ea15707d0b3667e1a323f728a5339364";
    const older = entry(`${recipe}-41569108715-1`, 3.2, 5);
    const middle = entry(`${recipe}-41575174097-1`, 3.2, 3);
    const newest = entry(`${recipe}-41590000001-2`, 3.2, 1);
    // A second recipe is its own bound: bounding by prefix alone would delete another recipe's state.
    const other = entry("android-v8-source-Linux-X64-9f8e7d6c-41575174097-1", 3.2, 2);
    const plan = planCachePrune({ caches: [older, middle, newest, other] });
    expect(plan.deleteIds.sort()).toEqual([older.id, middle.id].sort());
  });

  it("never lets one ref's newer state delete another ref's", () => {
    const recipe = "android-v8-source-Linux-X64-3ea15707d0b3667e1a323f728a5339364";
    // Caches are ref-scoped, so two pull requests' states never interact: the newer entry on ref B
    // is not a reason to drop ref A's only entry.
    const pullRequestA = entry(`${recipe}-41569108715-1`, 3.2, 5, "refs/pull/628/merge");
    const pullRequestB = entry(`${recipe}-41575174097-1`, 3.2, 1, "refs/pull/629/merge");
    const plan = planCachePrune({ caches: [pullRequestA, pullRequestB] });
    expect(plan.deleteIds).toEqual([]);
    // Within one ref the rule still applies.
    const olderOnB = entry(`${recipe}-41590000001-1`, 3.2, 4, "refs/pull/629/merge");
    expect(planCachePrune({ caches: [olderOnB, pullRequestB] }).deleteIds).toEqual([olderOnB.id]);
  });

  it("protects only the newest copy of a hot prefix in one ref, so a stale copy stays evictable", () => {
    // A hot prefix saves a new key per source change (`cargo-v1-<os>-<arch>-<image>-<rust>-<libs>-<hash>`,
    // the tail is a `hashFiles()` digest), so an older copy in the same ref is stale by construction.
    // Treating every copy as hot made the family immortal: the budget then fitted cold keys only, and
    // the stale GBs never left. The lane identity is the key without that digest.
    const lane = "cargo-v1-Linux-X64-20261103.354.1-rust1.90-9f2c4d-";
    const newer = entry(`${lane}${"b".repeat(64)}`, 0.15, 1);
    const older = entry(`${lane}${"a".repeat(64)}`, 0.5, 9);
    const plan = planCachePrune({
      caches: [older, newer],
      budgetBytes: 0.3 * GiB,
      familyShares: {},
    });
    expect(plan.deleteIds).toEqual([older.id]);
    expect(plan.deleteIds).not.toContain(newer.id);
    expect(plan.totalAfter).toBeLessThanOrEqual(0.3 * GiB);
  });

  it("protects the newest hot copy of each ref, never one ref's copy at another ref's expense", () => {
    // Caches are ref-scoped: the newest entry of a prefix in ref A is the only copy A can restore,
    // so ref B's newer copy must not make it the eviction victim.
    const develop = entry("wgpu-cache-25.0.2.2-rust1.90-ndk27-aaa-111", 0.5, 9);
    const pullRequest = entry(
      "wgpu-cache-25.0.2.2-rust1.90-ndk27-bbb-222",
      0.5,
      1,
      "refs/pull/700/merge",
    );
    const plan = planCachePrune({
      caches: [develop, pullRequest],
      budgetBytes: 0.3 * GiB,
      familyShares: {},
    });
    expect(plan.deleteIds).toEqual([]);
    expect(plan.overBudget).toBe(true);
  });

  it("protects the newest copy of every lane in a hot family, not one copy of the family", () => {
    // `native-ccache-` is one prefix over seven lanes that each compile a different target set.
    // Protecting the newest entry of the prefix alone leaves the other lanes to the budget, which
    // is how a 20 MB compiler cache kept disappearing: the live list on 2026-11-03 planned to
    // delete `native-ccache-ci-test-native-…-ccb139…` (19.6 MiB) and `native-ccache-ci-native-engine-…`
    // (148.3 MiB) while keeping a third lane's copy of the same family.
    const nativeEngine = entry(
      "native-ccache-ci-native-engine-Linux-X64-gcc-d2c019c3-100",
      0.15,
      8,
    );
    const testNative = entry("native-ccache-ci-test-native-Linux-X64-gcc-ccb13964-101", 0.02, 9);
    const starter = entry("native-ccache-starter-linux-Linux-X64-gcc-3ea15707-102", 0.02, 7);
    const cold = entry("native-build-Linux-X64-oldimage-abc", 1.5, 6);
    const plan = planCachePrune({
      caches: [testNative, nativeEngine, starter, cold],
      budgetBytes: 0.5 * GiB,
      familyShares: {},
    });
    expect(plan.deleteIds).toEqual([cold.id]);
    expect(plan.totalAfter).toBeLessThanOrEqual(0.5 * GiB);
  });

  it("still drops an older copy of one lane, which its own newer key replaced", () => {
    // The protection is per lane, not per copy: a lane that moved to a new source hash keeps only
    // the copy its newest key describes, or the family becomes immortal again.
    const oldHash = entry("native-ccache-ci-test-native-Linux-X64-gcc-3ea15707-200", 0.02, 9);
    const newHash = entry("native-ccache-ci-test-native-Linux-X64-gcc-ccb13964-201", 0.02, 1);
    const cold = entry("native-build-Linux-X64-oldimage-def", 0.5, 8);
    const plan = planCachePrune({
      caches: [oldHash, newHash, cold],
      budgetBytes: 0.3 * GiB,
      familyShares: {},
    });
    expect(plan.deleteIds).not.toContain(newHash.id);
    expect(plan.totalAfter).toBeLessThanOrEqual(0.3 * GiB);
    expect(plan.deleteIds.length).toBe(2);
  });

  it("keeps the Android dependency caches, which a miss re-downloads in minutes", () => {
    // ~793 MiB of SDK-independent downloads: measured 499.6 MiB (Gradle), 153.6 MiB (cargo) and
    // 139.5 MiB (third_party) on the live list. They are the largest entries a board writes, so a
    // size-first plan deletes them first and every android run pays for the download again.
    const gradle = entry("gradle-Linux-167ca67887bc33a0", 0.49, 9);
    const cargo = entry("cargo-android-Linux-fa1cf88765967fb9", 0.15, 8);
    const thirdParty = entry("native-android-third-party-Linux-X64-4c553d1e", 0.14, 7);
    const stale = entry("native-build-Linux-X64-oldimage-ghi", 1.5, 6);
    const plan = planCachePrune({
      caches: [gradle, cargo, thirdParty, stale],
      budgetBytes: GiB,
      familyShares: {},
    });
    expect(plan.deleteIds).toEqual([stale.id]);
  });

  it("deletes the oldest cold entry first and never the newest copy of a hot key", () => {
    const ccache = entry("native-ccache-ci-test-native-Linux-X64-gcc-3ea15707-1", 0.02, 9);
    const stale = entry("native-build-Linux-X64-oldimage-abc", 1.5, 7);
    const fresh = entry("native-engine-emsdk-Linux-X64-6.0.11", 0.47, 0.1);
    const plan = planCachePrune({
      caches: [ccache, stale, fresh],
      budgetBytes: GiB,
      familyShares: { "android-v8-source-": MiB },
    });
    // 2 GiB against a 1 GiB budget: the oldest cold entry goes, the hot one and the fresh one stay.
    expect(plan.deleteIds).toEqual([stale.id]);
    expect(plan.totalAfter).toBeLessThanOrEqual(GiB);
  });

  it("reports a cache it cannot bring under budget rather than deleting a hot key", () => {
    const hot = [entry("native-ccache-ci-test-native-Linux-X64-gcc-3ea15707-1", 0.02, 9)];
    const plan = planCachePrune({ caches: hot, budgetBytes: 0, familyShares: {} });
    expect(plan.deleteIds).toEqual([]);
    expect(plan.overBudget).toBe(true);
  });

  it("reads the JSONL the janitor fetches, and one JSON document too", () => {
    const first = entry("native-ccache-a-1", 0.02, 1);
    const second = entry("node-cache-Linux-x64-pnpm-b", 0.16, 2);
    // `gh api --paginate --jq '.actions_caches[]'` prints one object per line, and the first line
    // starts with `{` — parsing the whole file as one document then throws and deletes nothing.
    expect(parseCaches(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`)).toEqual([
      first,
      second,
    ]);
    expect(parseCaches(JSON.stringify({ actions_caches: [first] }))).toEqual([first]);
    expect(parseCaches('[{"id":1,"key":"k"}]')).toEqual([{ id: 1, key: "k" }]);
    expect(parseCaches("")).toEqual([]);
  });

  it("ignores a malformed entry instead of throwing away the whole run", () => {
    const plan = planCachePrune({
      caches: [
        // The API shape with the wrong type in one field: skipped, not a crash.
        {
          id: "not-a-number",
          key: "native-build-Linux-X64-a",
          size_in_bytes: 1,
        } as unknown as ICacheEntry,
        entry("native-build-Linux-X64-b", 1.5, 7),
      ],
      budgetBytes: GiB,
      familyShares: {},
    });
    expect(plan.deleteIds).toHaveLength(1);
  });
});

/** Every cache-key prefix this repository declares, literal head of a `key:` or of a `prefix=`. */
function declaredCachePrefixes(): readonly string[] {
  const files = [
    ...readdirSync(join(repo, ".github/workflows")).map((name) =>
      join(repo, ".github/workflows", name),
    ),
    ...readdirSync(join(repo, ".github/actions")).map((name) =>
      join(repo, ".github/actions", name, "action.yml"),
    ),
  ];
  const prefixes: string[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/^\s+(?:key|restore-keys): ([^\s$]+)/gmu))
      prefixes.push(match[1] ?? "");
    for (const match of source.matchAll(/prefix=([^\s$]+)/gu)) prefixes.push(match[1] ?? "");
  }
  return prefixes;
}

describe("the hot keys the janitor must keep", () => {
  it("names the prefixes the workflows actually declare, not a guess", () => {
    const declared = declaredCachePrefixes();
    // The three the review added: a cargo registry, a wgpu pipeline cache and the host deps of the
    // pipeline-cache workflow. A prefix with no declaration in this tree would protect nothing.
    // Round 5 added the Android lane's three downloads and the web-wasm payload: each is the only
    // copy of something a miss re-downloads, and the plan used to delete them first.
    for (const prefix of [
      "cargo-v1-",
      "wgpu-cache-",
      "pipeline-cache-host-deps-",
      "gradle-",
      "cargo-android-",
      "native-android-third-party-",
      "native-engine-web-wasm-v2-",
    ]) {
      expect(HOT_PREFIXES).toContain(prefix);
      expect(
        declared.some((candidate) => candidate.startsWith(prefix)),
        `no cache key in .github/ starts with ${prefix}`,
      ).toBe(true);
    }
  });

  it("keeps a cargo registry, a wgpu cache and the host deps under budget pressure", () => {
    const cargo = entry("cargo-v1-Linux-X64-image-rust1.90-abc-deadbeef", 0.15, 9);
    const wgpu = entry("wgpu-cache-25.0.2.2-rust1.90-ndk27-x86_64-linux-android", 0.2, 8);
    const hostDeps = entry("pipeline-cache-host-deps-Linux-abc", 0.05, 7);
    const stale = entry("native-build-Linux-X64-oldimage-abc", 1.5, 6);
    const plan = planCachePrune({
      caches: [stale, cargo, wgpu, hostDeps],
      budgetBytes: GiB,
      familyShares: {},
    });
    expect(plan.deleteIds).toEqual([stale.id]);
  });
});

describe("the janitor that applies the plan", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
  });

  it("reports what it planned, because the caller does the deleting", () => {
    const root = makeTempDirSync("tn-ci-cache-prune-");
    roots.push(root);
    const file = join(root, "caches.jsonl");
    writeFileSync(
      file,
      `${JSON.stringify({
        id: 1,
        key: "native-build-Linux-X64-oldimage-abc",
        ref: "refs/heads/develop",
        // Over the 9 GiB budget on its own, so the plan names it.
        size_in_bytes: 10 * GiB,
        last_accessed_at: "2026-11-01T00:00:00Z",
      })}\n`,
    );
    const result = spawnSync("node", [join(repo, "scripts/ci-cache-prune.mjs"), file], {
      encoding: "utf8",
      env: process.env,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("1\n");
    expect(result.stderr).toContain("planned for deletion");
    // "deleted" would be a lie: the workflow deletes them, and one may have expired first.
    expect(result.stderr).not.toMatch(/\bdeleted\b/u);
  });

  it("serializes the deletes, so two janitors never race on the same list", () => {
    const source = readFileSync(join(repo, ".github/workflows/ci-janitor.yml"), "utf8");
    const job = jobSections(source).find(([name]) => name === "prune-cache")?.[1];
    expect(job).toBeDefined();
    const group = /^ {4}concurrency:\n {6}group: (\S+)\n {6}cancel-in-progress: (\w+)$/mu.exec(
      job ?? "",
    );
    expect(group?.[1]).toBe("ci-janitor-prune-cache");
    // A cancelled janitor could stop between its list and its last delete; the queued one must wait.
    expect(group?.[2]).toBe("false");
  });
});
