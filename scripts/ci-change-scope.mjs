#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

const EXCLUDED_MARKDOWN = [
  /^docs\/PRDs\/realism-effects\/README\.md$/u,
  /^docs\/verification\/(?:PRD-289-conventions|alpha-bar|runtime-perf-state)\.md$/u,
  /^docs\/verification\/realism-effects-ao(?:-|\.)/u,
  /^docs\/verification\/worker-wake(?:-|\.)/u,
  /^docs\/verification\/native-(?:runtime-)?(?:census|coverage)(?:-|\.)/u,
  /^docs\/verification\/(?:round-|parity-|sweep-|tier-1-)/u,
];
// Paths whose change the native platform matrix has to prove. Recorded as data beside the other
// path classes: a new package or action that `native-platforms.yml` builds or consumes belongs in
// this list, or the matrix silently stops covering it. The action directories are enumerated from
// the `uses: ./.github/actions/...` references in that workflow.
export const NATIVE_PATHS = [
  /^packages\/runtime-native\//u,
  // Runtime mechanisms, generated hosts and their dependency manifests have native consumers.
  /^packages\/(?:core|physics|ui|assets|playtest|create-threenative)\/(?:src\/|package\.json$)/u,
  /^examples\/native-smoke\//u,
  /^tsconfig(?:\.base)?\.json$/u,
  /^\.github\/workflows\/native-platforms\.yml$/u,
  /^\.github\/actions\/(?:android-v8-source|playwright-chromium|pnpm|scaffold-from-tarballs|workspace-dist)\//u,
  /^pnpm-lock\.yaml$/u,
  /^pnpm-workspace\.yaml$/u,
];

function isNativePath(file) {
  return NATIVE_PATHS.some((pattern) => pattern.test(file));
}
// Derive coverage from shipped kit identities; directory-prefix lookalikes earn no exemption.
export const TEMPLATE_NAMES = readdirSync(
  new URL("../packages/create-threenative/templates/", import.meta.url),
).sort();
for (const name of TEMPLATE_NAMES) {
  const kit = JSON.parse(
    readFileSync(
      new URL(`../packages/create-threenative/templates/${name}/kit.json`, import.meta.url),
      "utf8",
    ),
  );
  if (kit.name !== name || !/^[a-z][a-z0-9-]*$/u.test(name))
    throw new Error("CI_TEMPLATE_IDENTITY_INVALID");
}
export function changedTemplates(files) {
  const names = new Set();
  for (const file of files) {
    const match =
      /^packages\/create-threenative\/(?:templates|template-playtests)\/([^/]+)\/.+/u.exec(file);
    if (match && TEMPLATE_NAMES.includes(match[1]) && !file.endsWith(".md")) names.add(match[1]);
  }
  return [...names].sort();
}

// These producer families keep the existing full build/unit/browser/native board. Only the
// redundant kit fanout narrows: each changed kit still proves itself, and starter exercises the
// default tarball/scaffold/physics/React/asset/MCP/boot route. Unknown executables keep all kits.
const REPRESENTATIVE_INPUTS = [
  /^docs\/(?:verification|benchmark)\/.*\.(?:png|jpe?g|webp|json|gz|txt)$/u,
  /^packages\/(?:core|physics|ui|assets|playtest|runtime-native|create-threenative|terrain|metahuman|raw-unreal|ueformat|engine-mcp|blender-mcp)\//u,
  /^examples\//u,
  /^scripts\/__tests__\/[^/]+\.spec\.ts$/u,
  /^scripts\/(?:api-surface\.json|run-test-suite\.sh|verify-animation-reversal\.ts|temporal-aa-(?:evidence|quality)\.ts|velocity-(?:capture|cost)-proof\.ts|verify-temporal-(?:aa|motion)\.ts|verify-velocity-history\.ts)$/u,
  /^\.github\/(?:workflows\/[^/]+\.yml|actions\/(?:workspace-dist|pnpm|playwright-chromium|scaffold-from-tarballs|android-v8-source)\/)/u,
  /^(?:package\.json|pnpm-(?:lock|workspace)\.yaml|tsconfig(?:\.base)?\.json|biome\.json|\.gitignore)$/u,
];
function representativeTemplates(files, target) {
  if (
    files.some((file) => {
      const kit =
        /^packages\/create-threenative\/(?:templates|template-playtests)\/([^/]+)\//u.exec(file);
      return kit && !TEMPLATE_NAMES.includes(kit[1]);
    })
  )
    return false;
  return (
    target === "develop" &&
    files.length > 0 &&
    files.every(
      (file) =>
        file.endsWith(".md") ||
        REPRESENTATIVE_INPUTS.some((pattern) => pattern.test(file)) ||
        CI_CONFIG_PATHS.some((pattern) => pattern.test(file)),
    )
  );
}

const SELECTIONS = new Set(["full", "prose", "instructions", "reused", "ci", "warm", "template"]);
// CI configuration: the workflows, the scripts that decide and report on the board, their own specs
// and the runner images. A diff made only of these cannot change a line of engine, template or
// package, so the jobs with no consumer for a workflow file are the only thing it can break — and
// the `ci` selection is exactly those. Deliberately narrow: `.github/actions/**` is excluded because
// the native matrix consumes it, and `pnpm-lock.yaml`/`pnpm-workspace.yaml` because they change what
// every job installs. Both keep `full`.
const CI_CONFIG_PATHS = [
  /^\.github\/workflows\/[^/]+\.yml$/u,
  /^scripts\/ci-[^/]+\.(?:mjs|sh|ts)$/u,
  /^scripts\/__tests__\/ci-[^/]+\.spec\.ts$/u,
  /^tools\/ci-runners\//u,
];
// PRD-481. Reuse replaces a full board only, and only for a tree a successful CI run already
// tested. `workflow_dispatch` is the explicit audit a person asked for, so it stays full; the
// Sunday nightly is always full too, because its subject is the runner image and the network
// rather than the tree.
const REUSE_EVENTS = new Set(["pull_request", "push", "merge_group", "schedule"]);
// Enough recent runs to cover the promotion, the merge queue and a re-push. The cap bounds the
// git work per run; a miss past it is a miss, which runs the board.
const REUSE_CANDIDATES = 30;
// No package/template exemption yet: core, playtest, scaffolding, physics, fixtures, toolchains
// and dependencies have native consumers. Narrow those only with an explicit dependency proof.
const FULL_JOBS = [
  "typecheck",
  "test",
  "test-unit",
  "test-native",
  "test-browser",
  "test-playtest",
  "golden-path-template",
  "template-nonvisual",
  "golden-path",
  "benchmark",
  "build",
  "build-artifacts",
  "budgets",
  "performance-contracts",
  "native-platforms",
  "integration",
];
// Every check the plan can require, in the order the plan declares it. A reused run has to have
// concluded every leg of the set its own profile requires; the reporting jobs are not evidence.
const BOARD_JOBS = [...FULL_JOBS, "lint", "supply-chain"];
// What a `ci` selection still owes: the gates that read CI configuration. `test-unit` is here
// because the unit shards are where every `ci-*.spec.ts` runs, and `build-artifacts` because
// typecheck, test-unit and budgets are ordered behind its upload — dropping it would leave three
// required jobs waiting on a producer that never ran.
const CI_JOBS = new Set(["typecheck", "test-unit", "budgets", "build-artifacts"]);
// PRD-481 phase 2: the two jobs whose product is a cache every pull request into develop reads —
// `build-artifacts` runs the shared workspace-dist action and saves `workspace-dist-*`, and
// `test-native` saves `native-build-*`, `native-third-party-*` and its ccache through the cache
// action's own post step. A warm run verifies nothing else, so nothing else runs.
const WARM_JOBS = ["build-artifacts", "test-native"];
// Strength, not identity: a stronger source profile may serve a weaker requirement, never the reverse.
const TARGET_RANKS = { main: 2, develop: 1, other: 0 };
const NATIVE_RANKS = { full: 2, reduced: 1, none: 0 };

export function selectionPlan(
  selection,
  reason,
  files = [],
  candidateSha = "",
  native = false,
  reusedRunId = 0,
  target = "",
  qualification = selection === "full" && target !== "develop",
) {
  const full = selection === "full";
  const reused = selection === "reused";
  const ciLane = selection === "ci";
  const warm = selection === "warm";
  const template = selection === "template";
  const representative = full && !qualification && representativeTemplates(files, target);
  const checks = {
    docs: !reused,
    ci: files.some((file) => CI_CONFIG_PATHS.some((pattern) => pattern.test(file))),
    instructions:
      full ||
      selection === "instructions" ||
      files.some((file) => /(?:^|\/)(?:AGENTS|CLAUDE)\.md$/u.test(file)),
    // A warm run builds the workspace, because publishing it is the run's whole product.
    workspace: full || warm || ciLane || template,
    native: full && native,
    templates: full || template,
  };
  // A reused plan skips everything, so its exemption is the run that did the work, not a rule
  // about what the change touched.
  const exemption = (proseReason) =>
    reused
      ? `Reused: CI run ${String(reusedRunId)} already passed this identical whole-repo tree`
      : proseReason;
  const jobs = Object.fromEntries(
    FULL_JOBS.map((name) => {
      // `ci` narrows the board to the gates that read the configuration and `warm` to the two cache
      // producers; neither widens one, so any other job is exempt exactly as it is for prose.
      const required =
        (full && (name !== "test-native" || native)) ||
        ((ciLane || template) && CI_JOBS.has(name)) ||
        (template &&
          ["template-nonvisual", "golden-path-template", "golden-path"].includes(name)) ||
        (warm && WARM_JOBS.includes(name));
      return [
        name,
        {
          required,
          reason: required
            ? full
              ? `Full dependency closure: ${reason}`
              : warm
                ? `Cache warm only: ${reason}`
                : `Selected dependency closure: ${reason}`
            : exemption(`Exempt: the ${selection} dependency closure does not reach ${name}`),
        },
      ];
    }),
  );
  const proseOnly = selection === "prose";
  const exemptLane = proseOnly || reused || warm;
  // A warm run verifies nothing at all, so its exemptions say what this run really is instead of
  // borrowing the prose lane's reason: every develop push would otherwise report that it skipped a
  // gate because it changed only Markdown.
  const exemptReason = (what) =>
    warm
      ? `Exempt: a develop push publishes the base-branch caches and runs no gate; ${what} run at promotion`
      : exemption(
          "Exempt: a Markdown-only change runs no gate; docs are re-validated on the develop nightly and at promotion",
        );
  jobs.integration = {
    required: !exemptLane,
    reason: !exemptLane
      ? "Exact candidate integration inventory and current-attempt receipts"
      : exemptReason("integration gates"),
  };
  jobs.lint = {
    required: !exemptLane || ciLane,
    reason: exemptLane
      ? exemptReason("docs are")
      : "Documentation, formatting and selected instruction contracts",
  };
  jobs["supply-chain"] = {
    required: !exemptLane || ciLane,
    reason: exemptLane
      ? exemptReason("secrets and dependency review are")
      : "Changed prose can still contain credentials; dependency review remains applicable",
  };
  // The native matrix blocks the merge in exactly three cases: a full selection that touches a
  // native path; a pull request into main; and any full selection that is not a clean pull-request
  // diff (push, schedule, dispatch, --full, or a fail-safe-to-full fallback). Everything else is a
  // clean develop pull request that provably excludes native code, and skips this lane entirely.
  const nativeRequired = full && native;
  jobs["native-platforms"] = {
    required: nativeRequired,
    reason: nativeRequired
      ? "Native evidence blocks the merge: a full selection that touches native code, targets main, or cannot prove from a clean pull request that it avoids native code"
      : exemption(
          "Exempt: a clean develop pull request whose diff provably touches no native path; the matrix is skipped rather than awaited or run",
        ),
  };
  // PRD-380 phase 2: how much of the matrix this run owes. Decided here, from whether the change
  // reached native code plus the branch it targets, and read from the plan by both the reusable
  // workflow's job gates and the reuse profile — so a run that owes the Linux rows and a run that
  // owes all of them can never disagree about which one this is. A reused plan keeps the `native`
  // flag of the full plan it stands in for, because what it owes did not change when it stopped
  // running the work itself.
  const nativeTier = qualification
    ? "full"
    : validationProfile({ baseRef: target, nativeRequired: native }).native;
  return {
    version: 2,
    qualification,
    files,
    reason,
    scope: selection,
    selection,
    candidateSha,
    reusedRunId,
    native,
    target,
    nativeTier,
    unitMatrix: { shard: ciLane || template ? ["1/1"] : ["1/4", "2/4", "3/4", "4/4"] },
    templateMatrix: {
      template: full
        ? representative
          ? [...new Set(["starter", ...changedTemplates(files)])].sort()
          : TEMPLATE_NAMES
        : template
          ? changedTemplates(files)
          : ["starter"],
    },
    goldenMatrix: {
      template: template
        ? changedTemplates(files).slice(0, 1)
        : representative
          ? ["starter"]
          : ["starter", "platformer"],
    },
    checks,
    jobs,
  };
}

export function validatePlan(value) {
  if (
    !value ||
    typeof value !== "object" ||
    value.version !== 2 ||
    typeof value.qualification !== "boolean" ||
    (value.qualification &&
      (value.selection !== "full" || !value.native || value.reusedRunId !== 0)) ||
    !SELECTIONS.has(value.selection) ||
    typeof value.reason !== "string" ||
    !value.reason ||
    /[\r\n]/u.test(value.reason) ||
    !Array.isArray(value.files) ||
    (value.selection === "template" && changedTemplates(value.files).length === 0) ||
    value.files.some((file) => typeof file !== "string" || !file || file.includes("\0")) ||
    typeof value.native !== "boolean" ||
    typeof value.target !== "string" ||
    !["full", "reduced", "none"].includes(value.nativeTier) ||
    !Number.isInteger(value.reusedRunId) ||
    value.reusedRunId < 0 ||
    // A reused plan without a source run, or a source run without a reused selection, is the one
    // thing that turns this into a skip with nothing behind it.
    (value.selection === "reused") !== value.reusedRunId > 0 ||
    typeof value.candidateSha !== "string" ||
    !/^[0-9a-f]{40}$/u.test(value.candidateSha)
  ) {
    throw new Error(
      "CI_SCOPE_INVALID_PLAN: missing or malformed selection, paths, native requirement, reason, reused run or candidate SHA",
    );
  }
  const expected = selectionPlan(
    value.selection,
    value.reason,
    value.files,
    value.candidateSha,
    value.native,
    value.reusedRunId,
    value.target,
    value.qualification,
  );
  for (const field of [
    "scope",
    "checks",
    "jobs",
    "nativeTier",
    "templateMatrix",
    "goldenMatrix",
    "unitMatrix",
  ]) {
    if (JSON.stringify(value[field]) !== JSON.stringify(expected[field])) {
      throw new Error(`CI_SCOPE_INVALID_PLAN: ${field} does not match the selected check families`);
    }
  }
  return expected;
}

export function validateEventPlan(value, { eventName, baseRef, forceFull = false } = {}) {
  const plan = validatePlan(value);
  // Event minima are independent of the plan's self-description. A valid review plan does not
  // qualify a queue candidate, promotion, audit or unknown event, even with green aggregate jobs.
  const event = eventName;
  const target = (baseRef ?? "").replace(/^refs\/heads\//u, "");
  const review = event === "pull_request" && target === "develop";
  // PRD-550: the queue reviews the exact tree a merge would produce on the base branch, so it earns
  // the same narrowed plan a pull request into develop earns. A queue entry against any other target
  // still qualifies its tree here.
  const queue =
    event === "merge_group" &&
    validationProfile({ eventName: event, baseRef: baseRef ?? "" }).target === "develop";
  if ((!review && !queue) || forceFull) {
    if (
      !plan.qualification ||
      plan.selection !== "full" ||
      !plan.native ||
      plan.nativeTier !== "full" ||
      plan.reusedRunId !== 0 ||
      Object.values(plan.jobs).some((job) => !job.required) ||
      JSON.stringify(plan.templateMatrix.template) !== JSON.stringify(TEMPLATE_NAMES) ||
      JSON.stringify(plan.goldenMatrix.template) !== JSON.stringify(["starter", "platformer"]) ||
      JSON.stringify(plan.unitMatrix.shard) !== JSON.stringify(["1/4", "2/4", "3/4", "4/4"])
    )
      throw new Error(
        "CI_REQUIRED_QUALIFICATION_MINIMUM: event requires fresh exhaustive candidate verification",
      );
  }
  return plan;
}

function requiredValue(argv, index, argument) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`CI_SCOPE_MALFORMED_ARGUMENT: ${argument} needs a value`);
  }
  return value;
}

function parseArgs(argv) {
  const keys = new Map([
    ["--root", "root"],
    ["--base", "base"],
    ["--head", "head"],
    ["--target", "target"],
    ["--event-name", "eventName"],
    ["--event", "eventName"],
    ["--format", "format"],
    ["--validate-plan", "plan"],
    ["--candidate-sha", "candidateSha"],
    ["--day-of-week", "dayOfWeek"],
  ]);
  const options = { root: process.cwd(), format: "text" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--full" || argument === "--local") {
      options[argument.slice(2)] = true;
    } else if (keys.has(argument)) {
      options[keys.get(argument)] = requiredValue(argv, index, argument);
      index += 1;
    } else {
      throw new Error(`CI_SCOPE_MALFORMED_ARGUMENT: unknown argument '${argument}'`);
    }
  }
  if (!["text", "json", "github"].includes(options.format)) {
    throw new Error("CI_SCOPE_MALFORMED_ARGUMENT: --format must be text, json or github");
  }
  return options;
}

function git(root, args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 * 16 });
}

/** The tree a commit resolves to, or null when this repository cannot see that commit at all. */
function treeOf(root, sha) {
  const result = git(root, ["rev-parse", "--verify", "--quiet", `${sha}^{tree}`]);
  const tree = result.stdout.trim();
  return result.status === 0 && /^[0-9a-f]{40}$/u.test(tree) ? tree : null;
}

/** A pull-request candidate must be the exact base/head merge, so a changed input needs fresh verification. */
export function assertMergeParentCandidate(root, candidateSha, base, head) {
  const commit = git(root, ["cat-file", "-p", candidateSha]);
  const headers = commit.stdout?.split("\n\n", 1)[0] ?? "";
  const parents = [...headers.matchAll(/^parent ([0-9a-f]{40})$/gmu)].map((match) => match[1]);
  if (
    commit.status !== 0 ||
    !/^[0-9a-f]{40}$/u.test(base ?? "") ||
    !/^[0-9a-f]{40}$/u.test(head ?? "") ||
    JSON.stringify(parents) !== JSON.stringify([base, head])
  )
    throw new Error(
      "CI_REQUIRED_PR_CANDIDATE_MISMATCH: expected the exact proposed base/head merge; changed inputs require fresh verification",
    );
}

function ghApi(pathname) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (repository === undefined || !/^[^/\s]+\/[^/\s]+$/u.test(repository)) {
    return { error: "GITHUB_REPOSITORY is missing or malformed" };
  }
  // `gh` rather than fetch: it is already on every runner, it reads GH_TOKEN from the job's own
  // `github.token`, and one stubbed binary is one thing to assert against.
  const result = spawnSync("gh", ["api", `repos/${repository}/${pathname}`], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 16,
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = (result.stderr ?? "").trim().split("\n")[0] ?? "";
    return { error: `the Actions API was unreadable${detail === "" ? "" : `: ${detail}`}` };
  }
  try {
    return { value: JSON.parse(result.stdout) };
  } catch {
    return { error: "the Actions API answered with malformed JSON" };
  }
}

/**
 * A develop push is the cache-warm lane and nothing else, so it proves nothing: it ran no gate and
 * required only the two jobs that publish caches. `head_branch` is the branch the run was pushed to,
 * and `ci.yml` names develop on `push` only for this lane — so a push whose branch is develop is a
 * warm run by construction. Both the scan and the verdict consult it: the scan has to keep looking
 * past it rather than select it and then refuse.
 */
function isWarmRun(run) {
  return run?.event === "push" && run?.head_branch === "develop";
}

/**
 * The successful CI run that tested this exact tree, newest first.
 *
 * The key is a whole repository tree read out of git, never a name, label or artifact a job could
 * have written: the tree of every recent successful CI run is compared with the candidate's, and a
 * run whose commit this clone cannot see is fetched rather than assumed. Anything unreadable —
 * no token, no repository, a failed or malformed listing, a commit that will not resolve — is a
 * miss, and a miss runs the board.
 */
export function findReusableRun(root, candidateSha) {
  const candidateTree = treeOf(root, candidateSha);
  if (candidateTree === null) return { error: "the candidate's tree could not be resolved" };
  const listed = ghApi("actions/workflows/ci.yml/runs?status=success&per_page=100");
  if ("error" in listed) return listed;
  const runs = listed.value?.workflow_runs;
  if (!Array.isArray(runs)) return { error: "the successful-run listing could not be interpreted" };
  let examined = 0;
  for (const run of runs) {
    const id = run?.id;
    const sha = run?.head_sha;
    if (
      !Number.isInteger(id) ||
      id <= 0 ||
      run?.conclusion !== "success" ||
      !/^[0-9a-f]{40}$/u.test(sha ?? "")
    ) {
      return { error: "a listed CI run could not be interpreted" };
    }
    if (String(id) === process.env.GITHUB_RUN_ID) continue;
    examined += 1;
    if (examined > REUSE_CANDIDATES) break;
    if (isWarmRun(run)) continue;
    if (treeOf(root, sha) === candidateTree) return { runId: id, tree: candidateTree };
    // A promotion, a re-push or a queue entry names a commit this full-history clone already has,
    // so the fetch below is the exception rather than the rule.
    git(root, ["fetch", "--quiet", "--no-tags", "origin", sha]);
    if (treeOf(root, sha) === candidateTree) return { runId: id, tree: candidateTree };
  }
  return {
    error: `none of the ${String(examined)} recent successful CI runs tested this exact tree`,
  };
}

/**
 * The only part of a reuse that git cannot settle. An identical tree is not the same validation:
 * PRD-380 gives an ordinary pull request a reduced native matrix and this planner already lets a
 * clean develop pull request skip the lane, so the source run has to prove what this run proves —
 * the same or a stronger target tier and native tier, every job and matrix leg this run requires,
 * and the same runner class for every job. Nothing in a tree carries a repository variable or a
 * runner image, so all of it comes back from the Actions API, and every gap is a miss that runs the
 * board.
 */
export function sourceVerdict({ runId, current }) {
  const record = ghApi(`actions/runs/${runId}`);
  if ("error" in record) return { error: record.error, code: "CI_REQUIRED_SOURCE_UNKNOWN" };
  const run = record.value;
  if (run?.status !== "completed" || run?.conclusion !== "success") {
    return {
      error: `CI run ${runId} did not complete successfully`,
      code: "CI_REQUIRED_SOURCE_UNKNOWN",
    };
  }
  // A dispatch is the explicit audit a person asked for, so it is never the evidence a run leans on.
  if (!REUSE_EVENTS.has(run.event)) {
    return {
      error: `CI run ${runId} is a ${String(run.event)} run, which is never a reuse source`,
      code: "CI_REQUIRED_SOURCE_COVERAGE",
    };
  }
  // A warm run published caches and verified nothing, so it cannot stand in for a board.
  if (isWarmRun(run)) {
    return {
      error: `CI run ${runId} is the develop cache-warm lane, which is never a reuse source`,
      code: "CI_REQUIRED_SOURCE_COVERAGE",
    };
  }
  const listed = runJobs(runId);
  if ("error" in listed) return { error: listed.error, code: "CI_REQUIRED_SOURCE_UNKNOWN" };
  const jobs = listed.jobs;
  const verdict = jobs.find((job) => job.name === "ci-required");
  if (verdict === undefined) {
    return {
      error: `CI run ${runId} reports no ci-required job`,
      code: "CI_REQUIRED_SOURCE_UNKNOWN",
    };
  }
  if (verdict.conclusion !== "success") {
    return {
      error: `CI run ${runId} reported ci-required as ${String(verdict.conclusion)}`,
      code: "CI_REQUIRED_SOURCE_NOT_SUCCESS",
    };
  }
  // The native tier is the lane's own evidence, not its presence: a develop pull request that waived
  // the lane leaves a skipped `native-platforms` behind, and that proves nothing about native code.
  const source = {
    profile: validationProfile({
      eventName: run.event,
      baseRef: sourceBase(run),
      nativeRequired: jobs.some(
        (job) => boardName(job.name) === "native-platforms" && job.conclusion === "success",
      ),
    }),
    jobs,
  };
  const miss = coverageMiss(current, source);
  if (miss !== "") return { error: miss, code: "CI_REQUIRED_SOURCE_COVERAGE" };
  return { succeeded: true, conclusion: verdict.conclusion, profile: source.profile };
}

// Actions can report only a skipped reusable-workflow stub or an incomplete matrix graph.
// Even two matching expanded graphs can omit the same leg. Until an authoritative expansion and
// per-leg routing exists, these boards must execute normally rather than reuse an unproven pass.
const UNPROVEN_REUSE_BOARDS = new Set([
  "integration",
  "test-unit",
  "golden-path-template",
  "template-nonvisual",
  "native-platforms",
]);

/**
 * What this run demands of a source: its profile, the runner class each of its jobs routes to, and
 * the board jobs and matrix legs its own job graph carries. `exempt` names the board jobs the plan
 * waived — the native lane on a clean develop pull request — so the requirement set is the plan's,
 * not the job graph's, because a waived job is still listed, as a skip.
 */
export function currentRun({ eventName, baseRef = "", exempt = [] }) {
  const listed = runJobs(process.env.GITHUB_RUN_ID ?? "");
  if ("error" in listed) return listed;
  const jobs = listed.jobs;
  const requiredBoards = BOARD_JOBS.filter((name) => !exempt.includes(name));
  const unproven = requiredBoards.find((name) => UNPROVEN_REUSE_BOARDS.has(name));
  if (unproven !== undefined) {
    return {
      error: `required matrix/reusable board ${unproven} has no authoritative complete expansion and routing; run the normal full board`,
    };
  }
  const missing = requiredBoards.find((name) => !jobs.some((job) => boardName(job.name) === name));
  if (missing !== undefined)
    return { error: `the current run has not materialized required board ${missing}` };
  // Per job, not per run: `supply-chain` is always hosted, the small joins always run on
  // `tn-local-light` and the platform legs are hosted, so a board is mixed on purpose and one class
  // for the whole run is a routing this check cannot model — which was PRD-480. Labels are known
  // before a job starts, so each job's own class is read from its own record and a job that has not
  // been assigned a runner yet is left out.
  const runnerClasses = new Map();
  for (const job of jobs) {
    const value = runnerClass(job);
    if (value !== "unknown") runnerClasses.set(job.name, value);
  }
  return {
    profile: validationProfile({
      eventName,
      baseRef,
      nativeRequired: !exempt.includes("native-platforms"),
    }),
    runnerClasses,
    required: jobs
      .map((job) => job.name)
      .filter((name) => boardName(name) !== null && !exempt.includes(boardName(name))),
  };
}

/** Every way a source run can fail to cover what this run requires. An empty string means it can. */
export function coverageMiss(current, source) {
  const weaker = profileMiss(current.profile, source.profile);
  if (weaker !== "") return weaker;
  const unproven = current.required.find((name) => UNPROVEN_REUSE_BOARDS.has(boardName(name)));
  if (unproven !== undefined)
    return `required matrix/reusable board ${unproven} has no authoritative complete expansion and routing`;
  if (current.required.length === 0) return "the current run has no proven required job graph";
  for (const name of current.required) {
    const ran = source.jobs.find((job) => job.name === name);
    if (ran === undefined) return `the source run never ran ${name}`;
    if (ran.conclusion !== "success") {
      return `the source run's ${name} concluded ${String(ran.conclusion)}`;
    }
    const on = runnerClass(ran);
    // Only this job's own known routing is evidence; another job's runner is never its proxy.
    const routes = current.runnerClasses.get(name) ?? "unknown";
    if (on === "unknown" || on !== routes) {
      return `the source run's ${name} ran on ${on} while this run routes to ${routes}`;
    }
  }
  return "";
}

/**
 * The validation profile a run has to prove. `main` is a promotion or a main push, `develop` an
 * ordinary pull request or the merge queue on develop, `other` any run whose target the API does not
 * report — which ranks lowest, because an unproven target never stands in for a proven one. The
 * native tier follows the target: a pull request or the merge queue on develop owes the reduced
 * matrix PRD-380 gives it, everything else the full one, and a run owing no lane owes none.
 */
export function validationProfile({ eventName, baseRef = "", nativeRequired = false }) {
  // Only an explicit target can earn reduced validation; GitHub also reports refs/heads/<name>.
  const ref = baseRef.replace(/^refs\/heads\//u, "");
  const target = ref === "main" ? "main" : ref === "develop" ? "develop" : "other";
  const review =
    target === "develop" &&
    (eventName === "pull_request" || eventName === "merge_group" || eventName === undefined);
  return { target, native: nativeRequired ? (review ? "reduced" : "full") : "none" };
}

/** Equal or stronger, axis by axis. Weaker on either axis is a miss. */
function profileMiss(current, source) {
  for (const [axis, ranks] of [
    ["target", TARGET_RANKS],
    ["native", NATIVE_RANKS],
  ]) {
    if ((ranks[source[axis]] ?? -1) < (ranks[current[axis]] ?? -1)) {
      return `the source run proved ${axis} ${String(source[axis])}, this run requires ${String(current[axis])}`;
    }
  }
  return "";
}

/**
 * Hosted or self-hosted, from the labels and runner name the jobs API reports. Anything else is
 * `unknown`, and an unknown class never matches: no tree proves which image ran.
 */
export function runnerClass(job) {
  const labels = Array.isArray(job?.labels) ? job.labels.map(String) : [];
  if (labels.includes("self-hosted")) {
    return labels.some((label) => label.startsWith("tn-")) ? "tn-local" : "self-hosted";
  }
  const hosted = [...labels, String(job?.runner_name ?? "")].some(
    (label) => /^(?:ubuntu|macos|windows)-/u.test(label) || label.startsWith("GitHub Actions"),
  );
  return hosted ? "hosted" : "unknown";
}

/** The board job a check belongs to: a matrix leg and a reusable-workflow prefix included. */
function boardName(name) {
  return (
    BOARD_JOBS.find(
      (board) => name === board || name.startsWith(`${board} `) || name.startsWith(`${board}/`),
    ) ?? null
  );
}

/** One read of a run's job list. Unreadable, malformed or truncated is a miss. */
function runJobs(runId) {
  if (!/^\d+$/u.test(runId ?? "")) return { error: "the run id is missing or malformed" };
  const listed = ghApi(`actions/runs/${runId}/jobs?per_page=100`);
  if ("error" in listed) return listed;
  const jobs = listed.value?.jobs;
  if (
    !Array.isArray(jobs) ||
    jobs.some((job) => typeof job?.name !== "string" || job.name === "")
  ) {
    return { error: `CI run ${runId}'s job listing could not be interpreted` };
  }
  // A truncated page would silently shrink the requirement set, so `total_count` has to agree with it.
  if ((listed.value?.total_count ?? 0) > jobs.length) {
    return { error: `CI run ${runId} reports more jobs than this read returns` };
  }
  return { jobs };
}

/**
 * The branch a source run had to pass. `base_ref` is null on every run record in this repository,
 * so a pull request's base comes from the pull requests its commit belongs to. Nothing readable is
 * no base, which ranks as `other` and therefore can never stand in for a promotion.
 */
function sourceBase(run) {
  if (typeof run?.base_ref === "string" && run.base_ref !== "") return run.base_ref;
  if (run?.event !== "pull_request" || !/^[0-9a-f]{40}$/u.test(run.head_sha ?? "")) return "";
  const listed = ghApi(`commits/${run.head_sha}/pulls`);
  if ("error" in listed || !Array.isArray(listed.value)) return "";
  const bases = new Set(
    listed.value
      .map((pull) => pull?.base?.ref)
      .filter((base) => typeof base === "string" && base !== ""),
  );
  return bases.size === 1 ? [...bases][0] : "";
}

function reuseEligible(options) {
  // Never on a developer machine: `pnpm ci:local` runs the work it selected, and a reuse verdict
  // there would be a claim about a run that is not happening.
  if (process.env.GITHUB_ACTIONS !== "true" || options.full) return false;
  if (options.eventName === undefined || !REUSE_EVENTS.has(options.eventName)) return false;
  // Sunday's nightly exists to catch drift in the runner image and in network dependencies, which
  // an unchanged tree cannot hide.
  if (options.eventName === "schedule") return dayOfWeek(options) !== 7;
  return true;
}

/** ISO weekday, 1 = Monday. `--day-of-week` states it so the split above is testable at any hour. */
function dayOfWeek(options) {
  if (options.dayOfWeek !== undefined) return Number(options.dayOfWeek);
  return new Date().getUTCDay() || 7;
}

function parseNameStatus(output) {
  if (!output.endsWith("\0")) return { error: "unterminated name-status records" };
  const fields = output.slice(0, -1).split("\0");
  const paths = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    if (!status || !/^(?:[ADM]|[RC]\d{3})$/u.test(status)) {
      return { error: `unsupported or malformed diff status ${JSON.stringify(status ?? "")}` };
    }
    const count = status[0] === "R" || status[0] === "C" ? 2 : 1;
    const changed = fields.slice(index, index + count);
    if (changed.length !== count || changed.some((file) => !file))
      return { error: `malformed ${status} diff record` };
    paths.push(...changed);
    index += count;
  }
  return { paths: [...new Set(paths)].sort() };
}

function pathFamily(file, selective) {
  if (
    /^packages\/create-threenative\/templates\/[^/]+\/(?:AGENTS|CLAUDE)\.md$/u.test(file) &&
    selective
  )
    return "ci";
  if (/(?:^|\/)(?:AGENTS|CLAUDE)\.md$/u.test(file)) {
    // Root and playtest instruction consumers have explicit contracts in the instruction lane.
    // Shipped template/native instructions may affect scaffolding and platform contracts too.
    return selective && /^(?:packages\/playtest\/)?(?:AGENTS|CLAUDE)\.md$/u.test(file)
      ? "instructions"
      : "an instruction consumer whose narrower dependency closure is unproven";
  }
  if (EXCLUDED_MARKDOWN.some((pattern) => pattern.test(file)))
    return "a Markdown file consumed by an executable fixture, parser or gate";
  if (CI_CONFIG_PATHS.some((pattern) => pattern.test(file))) return "ci";
  // Any Markdown the executable fixtures do not consume is inert: a .md-only PR runs no CI job.
  // Doc links, evidence budgets and secret scans are re-validated on the develop nightly run and
  // at promotion. AGENTS.md/CLAUDE.md are instruction consumers and are handled above.
  if (file.endsWith(".md")) return "prose";
  if (changedTemplates([file]).length > 0) return "template";
  return "a non-Markdown path";
}

function changedPaths(options) {
  if (!options.base || !options.head)
    return { error: "the pull-request merge-base inputs are missing" };
  const mergeBase = git(options.root, ["merge-base", "--all", options.base, options.head]);
  if (mergeBase.status !== 0 || !/^[0-9a-f]{40}\n?$/u.test(mergeBase.stdout))
    return { error: "the pull-request merge base could not be resolved" };
  const base = mergeBase.stdout.trim();
  const diff = git(options.root, [
    "diff",
    "--name-status",
    "-z",
    "--find-renames",
    "--no-ext-diff",
    base,
    options.head,
    "--",
  ]);
  if (diff.status !== 0) return { error: "Git could not discover the pull-request diff" };
  if (!diff.stdout) return { error: "the pull-request diff is empty" };
  const parsed = parseNameStatus(diff.stdout);
  if ("error" in parsed) return { error: `the pull-request diff is incomplete: ${parsed.error}` };
  // A symlink named .md is not inert prose. Check BOTH trees, including deleted/renamed inputs.
  for (const ref of [base, options.head]) {
    const tree = git(options.root, ["ls-tree", "-r", "-z", ref, "--", ...parsed.paths]);
    if (
      tree.status !== 0 ||
      tree.stdout.split("\0").some((entry) => entry && !/^100(?:644|755) blob /u.test(entry))
    ) {
      return { error: "the diff contains an unresolved, symlink or submodule input" };
    }
  }
  return parsed;
}

export function classify(input) {
  const options = { ...input, target: input.target?.replace(/^refs\/heads\//u, "") };
  const candidateSha =
    options.candidateSha ?? git(options.root, ["rev-parse", "HEAD"]).stdout.trim();
  // A full selection reached without a resolved pull-request diff cannot prove the change avoids
  // native code, so it is native-blocking by default. Only the clean-diff path below may clear it.
  const target = (options.target ?? "").replace(/^refs\/heads\//u, "");
  const full = (reason, files = [], native = true, qualification = true) =>
    reuseOrKeep(
      selectionPlan(
        "full",
        reason,
        files,
        candidateSha,
        qualification || native,
        0,
        target,
        qualification,
      ),
      options,
      candidateSha,
    );
  if (options.full) return full("explicit full verification requested");
  // PRD-550. The exhaustive board left the queue, so a develop push is the promotion of an exact
  // tree and qualifies that tree with every supported system, every kit and every native row. A
  // full selection still runs `build-artifacts` and `test-native`, so the base-branch caches every
  // pull request into develop reads keep being published here.
  if (options.eventName === "push" && options.target === "develop")
    return full("a develop push qualifies the exact tree with the full board");
  // Every event except a pull request and a merge group stays full, and so does every target but
  // develop. The narrowings below review a change on develop; the exhaustive board belongs to the
  // tree-qualifying events — a push, the nightly, an explicit audit and a promotion into main — which
  // are excluded here rather than narrowed further downstream.
  if (!["pull_request", "merge_group"].includes(options.eventName))
    return full(`event ${JSON.stringify(options.eventName)} requires complete verification`);
  if (options.target !== "develop")
    return full(
      `target ${JSON.stringify(options.target)} requires complete verification (promotion/rollback policy)`,
    );
  if (options.local) {
    const status = git(options.root, ["status", "--porcelain", "-z", "--untracked-files=normal"]);
    if (status.status !== 0 || status.stdout)
      return full(
        "local working tree is dirty or unreadable; committed-diff exemptions are unsafe",
      );
  }
  if (options.eventName === "merge_group") {
    // Queue scope is the complete base-to-candidate diff, never one constituent PR's head.
    const ancestor = git(options.root, [
      "merge-base",
      "--is-ancestor",
      options.base ?? "",
      candidateSha,
    ]);
    if (options.head !== candidateSha || ancestor.status !== 0)
      return full("merge group base/head identity is unresolved");
  }
  const parsed = changedPaths(options);
  if ("error" in parsed) return full(parsed.error);
  // `native-platforms.yml` is the one workflow the CI-configuration rule would otherwise narrow, and
  // it is the matrix's own definition: exempting it would waive the very lane that has to prove the
  // change. Any native path therefore keeps `full`, not merely `native: true`. Computed over the
  // whole diff — a native file sorted after a non-native one must still block.
  const native = parsed.paths.find(
    (file) => pathFamily(file, options.target === "develop") !== "prose" && isNativePath(file),
  );
  if (native !== undefined)
    return full(
      `${JSON.stringify(native)} is a native path`,
      parsed.paths,
      true,
      !representativeTemplates(parsed.paths, target),
    );
  const narrowed = diffSelection(parsed.paths, options.target === "develop");
  if (narrowed.blocked !== undefined)
    return full(
      `${JSON.stringify(narrowed.blocked)} is ${narrowed.family}`,
      parsed.paths,
      // These two scripts operate on generated web projects and the browser-only sweep; all other
      // unknown executable families retain native evidence until their consumer boundary is proved.
      !parsed.paths.every(
        (file) =>
          ["prose", "instructions", "ci", "template"].includes(pathFamily(file, true)) ||
          /^scripts\/(?:__tests__\/)?verify-template-playtests(?:\.spec)?\.ts$/u.test(file),
      ),
      !representativeTemplates(parsed.paths, target),
    );

  const reason = `all ${String(parsed.paths.length)} changed path(s) match explicit ${[...narrowed.families].sort().join(" + ")} dependency rules`;
  return selectionPlan(narrowed.selection, reason, parsed.paths, candidateSha, false, 0, target);
}

/**
 * The selection a complete diff earns, or the first path that keeps the whole board. Every path has
 * to be in an accepted family: one `packages/` file sorted after a workflow still decides the board.
 * Prose is already covered by lint's doc lane, so prose plus instructions is `instructions`; `ci`
 * outranks both — it is the narrower set by a wide margin, so a diff mixing a workflow with a doc
 * must not drop typecheck or the unit shards to gain lint alone.
 */
function diffSelection(paths, selective) {
  const families = new Set();
  for (const file of paths) {
    const family = pathFamily(file, selective);
    if (!["prose", "instructions", "ci", "template"].includes(family))
      return { blocked: file, family };
    families.add(family);
  }
  return {
    families,
    selection: families.has("template")
      ? "template"
      : families.has("ci")
        ? "ci"
        : families.has("instructions")
          ? "instructions"
          : "prose",
  };
}

/**
 * PRD-481: the one place a full board may be replaced. A narrowed plan is already cheaper than a
 * reused one and does not consult the API at all.
 */
function reuseOrKeep(plan, options, candidateSha) {
  if (plan.selection !== "full" || !reuseEligible(options)) return plan;
  const found = findReusableRun(options.root, candidateSha);
  // Fail closed means run the work. The reason carries why, so a run that ran the board for no
  // stated reason cannot be confused with one that never looked.
  const unavailable = (error) =>
    selectionPlan(
      "full",
      `${plan.reason}; tree reuse unavailable: ${error}`,
      plan.files,
      candidateSha,
      plan.native,
      0,
      plan.target,
      plan.qualification,
    );
  if (!("runId" in found)) return unavailable(found.error);
  const current = currentRun({
    eventName: options.eventName,
    baseRef: options.target ?? "",
    // The plan states exactly which checks this run owes, so a source cannot be credited with
    // standing in for a lane this run itself waived.
    exempt: Object.entries(plan.jobs)
      .filter(([, job]) => !job.required)
      .map(([name]) => name),
  });
  if ("error" in current) return unavailable(current.error);
  if (plan.qualification) return unavailable("qualification requires fresh candidate verification");
  const verdict = sourceVerdict({ runId: found.runId, current });
  if (!("succeeded" in verdict)) return unavailable(verdict.error);
  return selectionPlan(
    "reused",
    `whole-repo tree ${found.tree} already passed in CI run ${String(found.runId)}, which proves a ${verdict.profile.target}/${verdict.profile.native} profile on this run's per-job runner classes`,
    plan.files,
    candidateSha,
    // What this run owes did not change when it stopped running the work itself, so the tier
    // travels with the verdict: a reused develop pull request still owes the Linux rows.
    plan.native,
    found.runId,
    plan.target,
  );
}

function output(result, format) {
  if (format === "json") return console.log(JSON.stringify(result));
  if (format === "github") {
    for (const key of ["scope", "selection", "reason"]) console.log(`${key}=${result[key]}`);
    console.log(`candidate_sha=${result.candidateSha}`);
    console.log(`reused_run_id=${result.reusedRunId}`);
    console.log(`native_tier=${result.nativeTier}`);
    console.log(`plan=${JSON.stringify(result)}`);
    return;
  }
  console.log(
    `CI change scope: ${result.scope}\nCandidate: ${result.candidateSha}\nSource run: ${result.reusedRunId || "none"}\nReason: ${result.reason}`,
  );
  for (const [name, job] of Object.entries(result.jobs))
    console.log(`${job.required ? "Required" : "Exempt"}: ${name} — ${job.reason}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.plan !== undefined) {
      output(validatePlan(JSON.parse(options.plan)), options.format);
    } else {
      // Only the live GitHub projection owes the parent assertion; local and offline keep classify().
      if (options.format === "github" && options.eventName === "pull_request" && !options.local)
        assertMergeParentCandidate(
          options.root,
          options.candidateSha ?? git(options.root, ["rev-parse", "HEAD"]).stdout.trim(),
          options.base,
          options.head,
        );
      output(classify(options), options.format);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
