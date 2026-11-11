// Run reuse for the CI change scope: the git helpers, the Actions API reads and the rules that let
// a green run of the same tree, or a green leg of one, stand in for work this run would repeat.
// Re-exported by `scripts/ci-change-scope.mjs`. It imports `classify`, `pathFamily` and
// `selectionPlan` back from that facade, which is a cycle by design: they are read only inside
// function bodies, never while a module evaluates (see ci-leg-carry.mjs for the same pattern).

import { spawnSync } from "node:child_process";
import { classify, pathFamily, selectionPlan } from "../ci-change-scope.mjs";
import { RELEASE_GATE_JOBS, applyCarried, findCarried } from "../ci-leg-carry.mjs";

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
export const FULL_JOBS = [
  "typecheck",
  "test",
  "test-unit",
  "test-native",
  "test-browser",
  "test-playtest",
  "strata",
  "golden-path-template",
  "template-nonvisual",
  "template-engine-cost",
  "golden-path",
  "benchmark",
  "build",
  "build-artifacts",
  "budgets",
  "performance-contracts",
  "native-platforms",
  "integration",
  "native-engine",
];
// Every check the plan can require, in the order the plan declares it. A reused run has to have
// concluded every leg of the set its own profile requires; the reporting jobs are not evidence.
const BOARD_JOBS = [...FULL_JOBS, "lint", "supply-chain"];
// Strength, not identity: a stronger source profile may serve a weaker requirement, never the reverse.
const LANE_RANKS = { review: 0, queue: 1, full: 2 };
const TARGET_RANKS = { main: 2, develop: 1, other: 0 };
const NATIVE_RANKS = { full: 2, reduced: 1, none: 0 };

export function git(root, args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 1024 * 1024 * 16 });
}

/** The tree a commit resolves to, or null when this repository cannot see that commit at all. */
export function treeOf(root, sha) {
  const result = git(root, ["rev-parse", "--verify", "--quiet", `${sha}^{tree}`]);
  const tree = result.stdout.trim();
  return result.status === 0 && /^[0-9a-f]{40}$/u.test(tree) ? tree : null;
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
 * PRD-776. The one ready develop -> main pull request whose head is this commit. It runs the full
 * board on the same head and minute as the push, so a second board only competes with it for the
 * same hosted slots: PR #600 ran both on every head. Anything unreadable or doubtful is no promotion,
 * and no promotion runs the board. GitHub runs no pull-request event for a conflict, so a known
 * conflict keeps the board. `mergeable` is null while GitHub computes it, which is normal this soon
 * after a push, and develop contains main, so a conflict is the rare case.
 */
export function promotionOnHead(candidateSha) {
  const repository = process.env.GITHUB_REPOSITORY ?? "";
  const owner = repository.split("/")[0];
  const listed = ghApi(`pulls?state=open&base=main&head=${owner}:develop&per_page=2`);
  if ("error" in listed || !Array.isArray(listed.value) || listed.value.length !== 1)
    return undefined;
  const number = listed.value[0]?.number;
  if (!Number.isInteger(number)) return undefined;
  const pull = ghApi(`pulls/${number}`);
  if ("error" in pull) return undefined;
  const { base, draft, head, mergeable } = pull.value ?? {};
  return draft === false &&
    mergeable !== false &&
    base?.ref === "main" &&
    head?.ref === "develop" &&
    head?.sha === candidateSha &&
    head?.repo?.full_name === repository
    ? number
    : undefined;
}

/**
 * The verdict's own read, independent of the plan. It runs after the scope job, when the pull request
 * may already have moved on or merged, so it asks what the commit belongs to, not what is open now.
 */
export function promotionOwnsCommit(sha) {
  const listed = ghApi(`commits/${sha}/pulls`);
  if (
    "error" in listed ||
    !Array.isArray(listed.value) ||
    !listed.value.some((pull) => pull?.base?.ref === "main" && pull?.head?.ref === "develop")
  )
    return false;
  // `mergeable` reads null just after a push, and GitHub starts no run on a conflict. No run: no board.
  const runs = ghApi(`actions/workflows/ci.yml/runs?event=pull_request&head_sha=${sha}&per_page=1`);
  return !("error" in runs) && runs.value?.total_count > 0;
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
  "template-engine-cost",
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
  // PRD-731: which gate the run was. A green review run is a pull-request run into develop, and it
  // proves less than the queue's board for the same tree, so no run may cite a weaker lane.
  const lane =
    target === "develop" && eventName === "pull_request"
      ? "review"
      : target === "develop" && eventName === "merge_group"
        ? "queue"
        : "full";
  return { target, native: nativeRequired ? (review ? "reduced" : "full") : "none", lane };
}

/** Equal or stronger, axis by axis. Weaker on either axis is a miss. */
function profileMiss(current, source) {
  for (const [axis, ranks] of [
    ["target", TARGET_RANKS],
    ["native", NATIVE_RANKS],
    ["lane", LANE_RANKS],
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

export function reuseEligible(options) {
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

// PRD-730. The one verdict reuse the merge queue may take: the queue commit has the tree of the
// pull request it names, and that pull request's head already has a green full run. The queue ref
// is `gh-readonly-queue/<base>/pr-<number>-<base sha>`; the head comes from `refs/pull/<number>/head`.
const QUEUE_REF = /^(?:refs\/heads\/)?gh-readonly-queue\/[^/]+\/pr-(\d+)-[0-9a-f]{40}$/u;
export const SHA = /^[0-9a-f]{40}$/u;
const MATRIX_BOARDS = [
  ["test-unit", "unitMatrix", "shard"],
  ["template-nonvisual", "templateMatrix", "template"],
  ["template-engine-cost", "templateMatrix", "template"],
  ["golden-path-template", "goldenMatrix", "template"],
];

/** A commit's tree, fetching the commit first when this clone does not hold it. */
function treeOfFetched(root, sha) {
  const held = treeOf(root, sha);
  if (held !== null) return held;
  git(root, ["fetch", "--quiet", "--no-tags", "origin", sha]);
  return treeOf(root, sha);
}

/**
 * The tested candidate of a CI run: the one sha its artifacts name. A board that carries every
 * integration leg writes no Integration receipt, so the native web reference names it there.
 */
function receiptCandidate(runId) {
  const receipt = new RegExp(
    `^(?:ci-integration-receipt-${runId}-\\d+-|native-web-reference-)([0-9a-f]{40})(?:-|$)`,
    "u",
  );
  const shas = new Set();
  for (let page = 1; page <= 5; page += 1) {
    const listed = ghApi(`actions/runs/${runId}/artifacts?per_page=100&page=${page}`);
    if ("error" in listed) return listed;
    const artifacts = listed.value?.artifacts;
    if (!Array.isArray(artifacts))
      return { error: `CI run ${runId}'s artifact listing could not be interpreted` };
    for (const artifact of artifacts) {
      const sha = receipt.exec(String(artifact?.name ?? ""))?.[1];
      if (sha !== undefined) shas.add(sha);
    }
    if (artifacts.length < 100) break;
  }
  return shas.size === 1
    ? { sha: [...shas][0] }
    : { error: `CI run ${runId} names ${String(shas.size)} tested candidates, not one` };
}

/**
 * The newest pull-request run of the head that the queue commit repeats, when it is green and full.
 * `plan` is the full plan of the queue commit. Every miss, ambiguity or API error is `{ error }`.
 */
export function queueHeadReuse(input) {
  try {
    return decideQueueReuse(input);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function decideQueueReuse({ root, plan, queueRef }) {
  const number = QUEUE_REF.exec(queueRef ?? "")?.[1];
  if (number === undefined) return { error: "the merge-group ref does not name a pull request" };
  const tree = treeOf(root, plan.candidateSha);
  if (tree === null) return { error: "the candidate's tree could not be resolved" };
  const remote = git(root, ["ls-remote", "origin", `refs/pull/${number}/head`]);
  const headSha = remote.stdout.split(/\s/u)[0];
  if (remote.status !== 0 || !SHA.test(headSha))
    return { error: `the head of pull request ${number} could not be read` };
  if (treeOfFetched(root, headSha) !== tree)
    return { error: `the tree differs from the head of pull request ${number}` };
  return greenBoardOfHead({
    root,
    plan,
    tree,
    headSha,
    target: "develop",
    events: ["pull_request", "workflow_dispatch"],
  });
}

/**
 * PRD-630: the main push of a promotion repeats the tree its pull request's board just tested. It
 * runs no board when that board is green. Every miss, a main that moved included, runs the board.
 */
export function promotionReuse({ root, plan }) {
  try {
    const tree = treeOf(root, plan.candidateSha);
    if (tree === null) return { error: "the candidate's tree could not be resolved" };
    const parents = git(root, ["rev-list", "--parents", "-n", "1", plan.candidateSha])
      .stdout.trim()
      .split(" ");
    if (parents.length !== 3) return { error: "the main commit is not a promotion merge" };
    if (treeOfFetched(root, parents[2]) !== tree)
      return { error: "the main tree differs from the head of its promotion pull request" };
    return greenBoardOfHead({
      root,
      plan,
      tree,
      headSha: parents[2],
      target: "main",
      events: ["pull_request"],
    });
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function greenBoardOfHead({ root, plan, tree, headSha, target, events }) {
  const listed = ghApi(`actions/workflows/ci.yml/runs?head_sha=${headSha}&per_page=100`);
  if ("error" in listed) return listed;
  // PRD-731: a pull-request run is the thin review lane and proves too little, so the run worth
  // citing is the full board an author dispatched on the branch. A pull-request run stays a
  // candidate only so that a newer red one still blocks.
  const runs = listed.value?.workflow_runs?.filter?.((run) => events.includes(run?.event));
  if (
    !Array.isArray(runs) ||
    runs.length === 0 ||
    runs.some((run) => !Number.isInteger(run?.id) || !Number.isInteger(run?.run_number))
  )
    return { error: `no pull-request or dispatched CI run of ${headSha} could be interpreted` };
  const run = runs.reduce((newest, next) => (next.run_number > newest.run_number ? next : newest));
  if (run.head_sha !== headSha || run.status !== "completed" || run.conclusion !== "success")
    return { error: `the newest CI run of ${headSha} is ${String(run.conclusion ?? run.status)}` };
  const jobs = runJobs(String(run.id));
  if ("error" in jobs) return jobs;
  const succeeded = (name) =>
    jobs.jobs.some((job) => job.name === name && job.conclusion === "success");
  if (!succeeded("ci-required"))
    return { error: `CI run ${run.id} did not conclude ci-required as success` };
  // A promotion board may carry a leg its `ci-required` proved, but it runs what the reports need.
  const owed =
    target === "main"
      ? RELEASE_GATE_JOBS
      : Object.entries(plan.jobs)
          .filter(([, job]) => job.required)
          .map(([name]) => name);
  const missing = owed.find(
    (name) =>
      !jobs.jobs.some((job) => boardName(job.name) === name && job.conclusion === "success"),
  );
  if (missing !== undefined) return { error: `CI run ${run.id} has no successful ${missing}` };
  for (const [board, matrix, key] of MATRIX_BOARDS) {
    const leg = plan[matrix][key].find((value) => !succeeded(`${board} (${value})`));
    if (leg !== undefined && owed.includes(board))
      return { error: `CI run ${run.id} has no successful ${board} (${leg})` };
  }
  const tested = receiptCandidate(run.id);
  if ("error" in tested) return tested;
  const parents = git(root, ["rev-list", "--parents", "-n", "1", tested.sha])
    .stdout.trim()
    .split(" ");
  // A dispatch tests the branch head itself; a pull request tests its head merged with its base.
  const dispatched = run.event === "workflow_dispatch";
  const testedHead = dispatched
    ? tested.sha === headSha
    : parents.length === 3 && parents[2] === headSha;
  if (treeOfFetched(root, tested.sha) !== tree || !testedHead)
    return {
      error: `CI run ${run.id} tested a candidate other than the head${dispatched ? "" : " merged with its base"}`,
    };
  // The source's own plan, rebuilt from what it tested: a narrowed or review run proves less.
  const source = classify(
    dispatched
      ? {
          root,
          target: "",
          eventName: "workflow_dispatch",
          candidateSha: tested.sha,
          noReuse: true,
        }
      : {
          root,
          base: parents[1],
          head: headSha,
          target,
          eventName: "pull_request",
          candidateSha: tested.sha,
          noReuse: true,
        },
  );
  if (source.selection !== "full")
    return { error: `CI run ${run.id} was not a full board (${source.selection})` };
  if (
    (NATIVE_RANKS[source.nativeTier] ?? -1) < (NATIVE_RANKS[plan.nativeTier] ?? -1) ||
    (LANE_RANKS[source.lane] ?? -1) < (LANE_RANKS[plan.lane] ?? -1) ||
    (plan.qualification && !source.qualification)
  )
    return { error: `CI run ${run.id} proved a weaker native or qualification tier` };
  return { runId: run.id, tree, headSha, testedSha: tested.sha, runAttempt: run.run_attempt };
}

/**
 * PRD-481: the one place a full board may be replaced. A narrowed plan is already cheaper than a
 * reused one and does not consult the API at all.
 */
export function reuseOrKeep(plan, options, candidateSha) {
  if (plan.selection !== "full" || options.noReuse || !reuseEligible(options)) return plan;
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
      plan.nightly,
      plan.strataGpu !== false,
    );
  // PRD-730: the queue takes its own narrow rule, never the generic cross-commit one below.
  if (options.eventName === "merge_group") {
    const hit = queueHeadReuse({ root: options.root, plan, queueRef: options.queueRef });
    if ("error" in hit) return unavailable(hit.error);
    return selectionPlan(
      "reused",
      `queue tree ${hit.tree} equals the head of its pull request and already passed in CI run ${String(hit.runId)}`,
      plan.files,
      candidateSha,
      plan.native,
      hit.runId,
      plan.target,
    );
  }
  // PRD-630: main takes the green board of its promotion pull request, or the board runs.
  if (options.eventName === "push" && plan.target === "main") {
    const hit = promotionReuse({ root: options.root, plan });
    if ("error" in hit) return unavailable(hit.error);
    return selectionPlan(
      "reused",
      `main tree ${hit.tree} already passed in promotion CI run ${String(hit.runId)}`,
      plan.files,
      candidateSha,
      plan.native,
      hit.runId,
      plan.target,
    );
  }
  const found = findReusableRun(options.root, candidateSha);
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

/** What the carry rules read from outside themselves, for the planner and for the verdict. */
export async function carryDeps(root, plan) {
  const { integrationJobNamesByLane, integrationSelection } = await import(
    "../ci-integration-scope.mjs"
  );
  const { nativeInventory } = await import("../ci-native-qualification.mjs");
  return {
    git: (args) => git(root, args),
    gh: ghApi,
    runJobs,
    receiptCandidate,
    isProse: (file) => pathFamily(file, true) === "prose",
    integrationWorkflow: ".github/workflows/integration.yml",
    integrationSelection,
    integrationJobs: integrationJobNamesByLane,
    // iOS is non-blocking in the verdict, so its red cannot hold the matrix's carry either.
    nativeJobs: (owed) =>
      nativeInventory(owed ?? plan)
        .filter((leg) => leg.job !== "ios-simulator")
        .map((leg) => leg.name),
  };
}

/** PRD-776: a full board drops each leg that already passed on the same inputs. */
export async function withCarriedLegs(plan, options) {
  // A manual run is no whole-tree reuse source, but its own legs still need not repeat. `--full` is
  // how a person asks for fresh work, and the scheduled audit exists to find drift.
  const manual =
    options.eventName === "workflow_dispatch" &&
    process.env.GITHUB_ACTIONS === "true" &&
    !options.full;
  if (plan.selection !== "full" || options.noReuse || !(manual || reuseEligible(options)))
    return plan;
  if (options.eventName === "schedule") return plan;
  try {
    const deps = await carryDeps(options.root, plan);
    // The promotion board produces the release reports, so it runs their job itself. PRD-630.
    if (plan.target === "main") deps.reserved = RELEASE_GATE_JOBS;
    return applyCarried(plan, findCarried(plan, deps));
  } catch (error) {
    console.error(`per-job reuse unavailable, the board runs: ${String(error?.message ?? error)}`);
    return plan;
  }
}
