#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { applyCarried } from "./ci-leg-carry.mjs";
import {
  CI_CONFIG_PATHS,
  NATIVE_ENGINE_PATHS,
  NATIVE_PATHS,
  changedTemplates as changedTemplatesIn,
  diffSelection as diffSelectionIn,
  isEnginePath,
  isNativePath,
  isStrataPath,
  parseNameStatus,
  pathFamily as pathFamilyIn,
  representativeTemplates as representativeTemplatesIn,
} from "./ci/classify.mjs";
import {
  FULL_JOBS,
  SHA,
  carryDeps,
  git,
  promotionOnHead,
  reuseEligible,
  reuseOrKeep,
  validationProfile,
  withCarriedLegs,
} from "./ci/reuse.mjs";
import { templateNames } from "./lib/repo-inventory.mjs";

// The classifier and the run-reuse rules live in ./ci/classify.mjs and ./ci/reuse.mjs. This module
// is their facade: callers keep importing from here, and the kit names the pure classifier needs
// are bound once, from the kits on disk.
export { NATIVE_ENGINE_PATHS, NATIVE_PATHS, isStrataPath } from "./ci/classify.mjs";
export {
  carryDeps,
  coverageMiss,
  currentRun,
  findReusableRun,
  promotionOwnsCommit,
  promotionReuse,
  queueHeadReuse,
  runnerClass,
  sourceVerdict,
  validationProfile,
  withCarriedLegs,
} from "./ci/reuse.mjs";

// Derive coverage from shipped kit identities; directory-prefix lookalikes earn no exemption.
export const TEMPLATE_NAMES = templateNames();
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
export const changedTemplates = (files) => changedTemplatesIn(files, TEMPLATE_NAMES);
export const pathFamily = (file, selective) => pathFamilyIn(file, selective, TEMPLATE_NAMES);
const diffSelection = (paths, selective) => diffSelectionIn(paths, selective, TEMPLATE_NAMES);
const representativeTemplates = (files, target) =>
  representativeTemplatesIn(files, target, TEMPLATE_NAMES);

const SELECTIONS = new Set([
  "full",
  "prose",
  "instructions",
  "reused",
  "review",
  "ci",
  "warm",
  "template",
  "native-engine",
]);
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
function strataSelected(files, qualification) {
  if (qualification) return true;
  if (files.some(isStrataPath)) return true;
  return false;
}

// PRD-731. The thin lane a ready pull request into develop runs; the merge queue runs the board.
const REVIEW_JOBS = [
  "typecheck",
  "test-unit",
  "budgets",
  "build-artifacts",
  "golden-path-template",
  "golden-path",
];
export function selectionPlan(
  selection,
  reason,
  files = [],
  candidateSha = "",
  native = false,
  reusedRunId = 0,
  target = "",
  qualification = selection === "full" && target !== "develop",
  nightly = false,
  // Strata needs a real GPU: SwiftShader allows 16 sampled textures per stage, the terrain binds
  // 24, and the view-window gate needs GPU timings (owner, 2026-11-06). The workflow says whether
  // this run's `runs-on` reaches the GPU runner; unset means a caller outside CI. The plan records
  // a `false` so every replay of it (`--validate-plan`, carried legs) owes the same jobs.
  strataGpu = process.env.TN_CI_STRATA_GPU !== "false",
) {
  const full = selection === "full";
  const reused = selection === "reused";
  const ciLane = selection === "ci";
  const warm = selection === "warm";
  const template = selection === "template";
  const engine = selection === "native-engine";
  const review = selection === "review";
  const representative = full && !qualification && representativeTemplates(files, target);
  const checks = {
    docs: !reused,
    ci: files.some((file) => CI_CONFIG_PATHS.some((pattern) => pattern.test(file))),
    instructions:
      full ||
      selection === "instructions" ||
      files.some((file) => /(?:^|\/)(?:AGENTS|CLAUDE)\.md$/u.test(file)),
    // A warm run builds the workspace, because publishing it is the run's whole product.
    workspace: full || warm || ciLane || template || review,
    native: full && native,
    templates: full || template || review,
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
      if (name === "strata") {
        const selected = full && strataSelected(files, qualification);
        const required = selected && strataGpu;
        return [
          name,
          {
            required,
            reason: required
              ? qualification
                ? `Full dependency closure: ${reason}`
                : `Selected dependency closure: ${reason}`
              : selected
                ? exemption(
                    "Exempt: no GPU runner serves this run (TN_RUNNER_GPU / TN_RUNNER_GPU_HEAD), and hosted SwiftShader cannot draw the Strata world",
                  )
                : exemption(`Exempt: the ${selection} dependency closure does not reach ${name}`),
          },
        ];
      }
      // The engine job is the one lane a full board owes only conditionally: when the diff reaches the
      // engine tree, or when the run qualifies a whole candidate. Every other full diff reads as before.
      // The engine-cost row is nightly only (owner, 2026-11-01): it costs 180 job-minutes a board.
      const required =
        name === "template-engine-cost"
          ? nightly && (full || template)
          : name === "native-engine"
            ? engine || (full && (qualification || files.some(isEnginePath)))
            : (full && (name !== "test-native" || native)) ||
              ((ciLane || template) && CI_JOBS.has(name)) ||
              (template &&
                ["template-nonvisual", "golden-path-template", "golden-path"].includes(name)) ||
              (review &&
                (REVIEW_JOBS.includes(name) ||
                  (name === "test" && files.some((file) => file.startsWith("packages/"))))) ||
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
                : review
                  ? `Review lane: ${reason}; the merge queue runs the full board`
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
  // The review lane is thin on purpose: integration is the queue's, but lint and the secrets scan
  // stay with the author's push.
  jobs.integration = {
    required: !exemptLane && !review,
    reason: !exemptLane
      ? "Exact candidate integration inventory and current-attempt receipts"
      : review
        ? "Exempt: the review lane leaves the integration join to the merge queue"
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
  const reviewExempt = "Exempt: the review lane leaves native evidence to the merge queue";
  jobs["native-platforms"] = {
    required: nativeRequired,
    reason: nativeRequired
      ? "Native evidence blocks the merge: a full selection that touches native code, targets main, or cannot prove from a clean pull request that it avoids native code"
      : engine
        ? "Exempt: the diff touches only native-engine paths, which the native-engine job proves; the matrix is skipped rather than awaited or run"
        : review
          ? reviewExempt
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
    nightly,
    ...(strataGpu ? {} : { strataGpu: false }),
    files,
    reason,
    scope: selection,
    selection,
    candidateSha,
    reusedRunId,
    native,
    target,
    nativeTier,
    // How exhaustive the gate behind this plan is: the author's thin push, the queue's selected
    // board, or a whole qualification. Derived, so `validatePlan` can recompute it.
    lane: review ? "review" : full && (qualification || target !== "develop") ? "full" : "queue",
    unitMatrix: { shard: ciLane || template || review ? ["1/1"] : ["1/4", "2/4", "3/4", "4/4"] },
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
        : review
          ? [changedTemplates(files)[0] ?? "starter"]
          : representative
            ? ["starter"]
            : ["starter", "platformer"],
    },
    checks,
    jobs,
  };
}

/** What a plan owed before any leg was carried: the full requirement a carried leg answers to. */
export function owedPlan(value) {
  return selectionPlan(
    value.selection,
    value.reason,
    value.files,
    value.candidateSha,
    value.native,
    value.reusedRunId,
    value.target,
    value.qualification,
    value.nightly,
    value.strataGpu !== false,
  );
}

export function validatePlan(value) {
  if (
    !value ||
    typeof value !== "object" ||
    value.version !== 2 ||
    typeof value.qualification !== "boolean" ||
    typeof value.nightly !== "boolean" ||
    ("strataGpu" in value && value.strataGpu !== false) ||
    (value.qualification &&
      (value.selection !== "full" || !value.native || value.reusedRunId !== 0)) ||
    !SELECTIONS.has(value.selection) ||
    typeof value.reason !== "string" ||
    !value.reason ||
    /[\r\n]/u.test(value.reason) ||
    !Array.isArray(value.files) ||
    (value.selection === "template" && changedTemplates(value.files).length === 0) ||
    (value.selection === "native-engine" && (value.native || !value.files.some(isEnginePath))) ||
    // A review plan is thin by construction and states a resolved diff; anything else is a plan
    // a queue or a promotion could mistake for evidence.
    (value.selection === "review" &&
      (value.native || value.qualification || value.files.length === 0)) ||
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
  const expected = applyCarried(owedPlan(value), value.carried);
  for (const field of [
    "scope",
    "checks",
    "jobs",
    "nativeTier",
    "lane",
    "templateMatrix",
    "goldenMatrix",
    "unitMatrix",
    "carriedJobs",
  ]) {
    if (JSON.stringify(value[field]) !== JSON.stringify(expected[field])) {
      throw new Error(`CI_SCOPE_INVALID_PLAN: ${field} does not match the selected check families`);
    }
  }
  return expected;
}

export function validateEventPlan(value, { eventName, baseRef, forceFull = false } = {}) {
  const plan = validatePlan(value);
  // A scheduled audit exists to find drift that an unchanged tree cannot show, and a forced full run
  // is a person asking for fresh work, so neither takes a carried leg.
  if (plan.carried?.length && (eventName === "schedule" || forceFull))
    throw new Error(
      "CI_REQUIRED_QUALIFICATION_MINIMUM: event requires fresh exhaustive candidate verification",
    );
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
  // PRD-731: the thin lane is the author's push on a pull request into develop, and nothing else.
  if (plan.selection === "review" && !review)
    throw new Error(
      "CI_REQUIRED_REVIEW_LANE: the review lane only gates a pull request into develop; the queue, pushes, audits and main need the full selected board",
    );
  // PRD-776: a develop push may leave the board to its promotion pull request. `ci-required` confirms
  // that pull request from the commit itself.
  const yielded = event === "push" && target === "develop" && plan.selection === "warm";
  // PRD-630: a main push may rest on its promotion board. `ci-required` re-decides that rule.
  const promoted = event === "push" && target === "main" && plan.selection === "reused";
  if ((!review && !queue && !yielded && !promoted) || forceFull) {
    // The minimum reads what the plan owed: a carried leg still owes its proof, and `ci-required`
    // reads that proof from the source run.
    const owed = owedPlan(plan);
    if (
      !owed.qualification ||
      owed.selection !== "full" ||
      !owed.native ||
      owed.nativeTier !== "full" ||
      owed.reusedRunId !== 0 ||
      // Only the nightly owes the engine-cost row, and strata is owed only where a GPU runner serves
      // the run (the plan records the GPU-less exemption, so it is never silent).
      Object.entries(owed.jobs).some(
        ([name, job]) =>
          !job.required &&
          (name !== "template-engine-cost" || event === "schedule") &&
          (name !== "strata" || owed.strataGpu !== false),
      ) ||
      JSON.stringify(owed.templateMatrix.template) !== JSON.stringify(TEMPLATE_NAMES) ||
      JSON.stringify(owed.goldenMatrix.template) !== JSON.stringify(["starter", "platformer"]) ||
      JSON.stringify(owed.unitMatrix.shard) !== JSON.stringify(["1/4", "2/4", "3/4", "4/4"])
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
    ["--queue-ref", "queueRef"],
  ]);
  const options = { root: process.cwd(), format: "text" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--full" || argument === "--local" || argument === "--queue-lane") {
      // `--queue-lane` asks a pull request for the board the merge queue will run (`pnpm ci:local`).
      options[argument === "--queue-lane" ? "queueLane" : argument.slice(2)] = true;
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

// The payload base can lag; resolve the target ref frozen by the full-history checkout.
function fetchedTargetBase(root, target) {
  const ref = `refs/remotes/origin/${(target ?? "").replace(/^refs\/heads\//u, "")}`;
  const resolved =
    target && git(root, ["check-ref-format", ref]).status === 0
      ? git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
      : undefined;
  const sha = resolved?.stdout.trim() ?? "";
  if (resolved?.status !== 0 || !/^[0-9a-f]{40}$/u.test(sha))
    throw new Error(
      `CI_REQUIRED_PR_CANDIDATE_MISMATCH: the fetched target ref ${JSON.stringify(ref)} is missing or malformed; changed inputs require fresh verification`,
    );
  return sha;
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
  // PRD-731: a ready pull request into develop earns the thin review lane wherever it would have
  // earned the whole board, as long as its diff resolved. The merge queue runs that board, once.
  const review =
    options.eventName === "pull_request" &&
    target === "develop" &&
    !options.full &&
    !options.queueLane;
  const full = (reason, files = [], native = true, qualification = true) =>
    review && files.length > 0
      ? selectionPlan("review", reason, files, candidateSha, false, 0, target)
      : reuseOrKeep(
          selectionPlan(
            "full",
            reason,
            files,
            candidateSha,
            qualification || native,
            0,
            target,
            qualification,
            options.eventName === "schedule",
          ),
          options,
          candidateSha,
        );
  if (options.full) return full("explicit full verification requested");
  // PRD-550. The exhaustive board left the queue, so a develop push is the promotion of an exact
  // tree and qualifies that tree with every supported system, every kit and every native row. A
  // full selection still runs `build-artifacts` and `test-native`, so the base-branch caches every
  // pull request into develop reads keep being published here.
  if (options.eventName === "push" && options.target === "develop") {
    const promotion = options.local ? undefined : promotionOnHead(candidateSha);
    if (promotion !== undefined)
      return selectionPlan(
        "warm",
        `promotion pull request #${String(promotion)} runs the full board on this head`,
        [],
        candidateSha,
        false,
        0,
        target,
      );
    return full("a develop push qualifies the exact tree with the full board");
  }
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

function output(result, format, base = "") {
  if (format === "json") return console.log(JSON.stringify(result));
  if (format === "github") {
    for (const key of ["scope", "selection", "reason"]) console.log(`${key}=${result[key]}`);
    console.log(`candidate_sha=${result.candidateSha}`);
    console.log(`base_sha=${base}`);
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

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.plan !== undefined) {
      output(validatePlan(JSON.parse(options.plan)), options.format);
    } else {
      // Only the live GitHub projection owes the parent assertion; local and offline keep classify().
      if (options.format === "github" && options.eventName === "pull_request" && !options.local) {
        // The API payload's base.sha may lag the fetched branch; the frozen target ref is the base.
        if (!/^[0-9a-f]{40}$/u.test(options.base ?? ""))
          throw new Error(
            "CI_REQUIRED_PR_CANDIDATE_MISMATCH: the proposed base input is missing or malformed; changed inputs require fresh verification",
          );
        options.base = fetchedTargetBase(options.root, options.target);
        assertMergeParentCandidate(
          options.root,
          options.candidateSha ?? git(options.root, ["rev-parse", "HEAD"]).stdout.trim(),
          options.base,
          options.head,
        );
      }
      output(await withCarriedLegs(classify(options), options), options.format, options.base);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}

// Not a top-level await: the carry rules import modules that import this one, and a module still
// awaiting at its top level would deadlock them.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
