#!/usr/bin/env node

/**
 * PRD-776 phase 2: a job that passed on the same inputs does not run again.
 *
 * A leg is carried when a recent CI run's same job concluded success and every path that changed
 * between that run's tested commit and this candidate is provably outside the job's inputs. The
 * receipt is GitHub's own job record, so a green result needs no new storage and no write permission.
 * Inputs are deny-by-default: a path stays an input of every leg until a rule below excludes it, so a
 * new directory runs the board. Anything unreadable runs the leg.
 *
 * The window is the upper limit on how long a leg can stay carried: a runner image or a network
 * dependency cannot be read from a tree, so each leg runs for real at least once per window, and the
 * Sunday nightly runs everything cold.
 */

const SOURCE_RUNS = 30;
const WINDOW_DAYS = 7;
const DEADLINE_MS = 120_000;
const SHA = /^[0-9a-f]{40}$/u;

const TEMPLATE_DIR = /^packages\/create-threenative\/(?:templates|template-playtests)\/([^/]+)\//u;
// Authoring and evidence trees that no build or game test reads.
const AUTHORING = [/^\.claude\//u, /^\.agents\//u, /^\.codex\//u];
// The native legs read manifests and scripts under docs/, so only a kit leg drops that tree.
const DOCS = /^docs\//u;
// Root spec files run in the unit legs only. A native leg runs some package specs itself, and a
// package's `__tests__/fixtures` can feed a scenario, so only a kit leg drops package spec files.
const ROOT_SPECS = /^scripts\/__tests__\/[^/]+\.spec\.ts$/u;
const PACKAGE_SPECS = /^packages\/[^/]+\/__tests__\/[^/]+\.spec\.tsx?$/u;
// These scripts decide what a board runs and judge what it ran. They run no game and no engine.
const BOARD_SCRIPTS = [
  /^scripts\/ci-(?:change-scope|required|integration-[a-z]+|attempt-receipts|leg-carry|merge-latency|queue-watch|run-summary|speed-loop|template-typecheck)\.[a-z]+$/u,
];
const WORKFLOWS = /^\.github\/workflows\//u;
const NATIVE_WORKFLOW = ".github/workflows/native-platforms.yml";

// Files `pnpm release:prepare --bump` rewrites beside each package.json. The rule compares both
// sides with every X.Y.Z masked, so it applies only to these files, where a version is the content.
const VERSION_FILES = [
  /^packages\/core\/mcp\/(?:engine-server|servers)\.mjs$/u,
  /^packages\/core\/src\/(?:index|version)\.ts$/u,
  /^packages\/create-threenative\/(?:animation|engine)-mcp-tools\.json$/u,
  /^packages\/create-threenative\/src\/doctor\.ts$/u,
  /^packages\/engine-mcp\/src\/index\.ts$/u,
  /^packages\/engine-mcp\/__tests__\/server\.spec\.ts$/u,
  /^examples\/abyss-framework\/playtests\/replay\.playtest\.json$/u,
];
const COHORT_PACKAGE = /^(?:@threenative\/|create-threenative$|threenative)/u;
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

// Every job the plan can carry and how its inputs are read. Lint and the secrets scan read the whole
// tree on each candidate, and the producers feed other jobs, so they always run.
const JOB_INPUTS = {
  typecheck: "workspace",
  test: "unit",
  "test-browser": "workspace",
  "test-playtest": "workspace",
  benchmark: "workspace",
  "performance-contracts": "workspace",
  budgets: "workspace",
  "test-native": "native",
  "native-engine": "native",
  "native-platforms": "native",
};
const MATRIX_JOBS = {
  "test-unit": { matrix: "unitMatrix", axis: "shard", inputs: "unit" },
  "template-nonvisual": { matrix: "templateMatrix", axis: "template", inputs: "template" },
  "golden-path-template": { matrix: "goldenMatrix", axis: "template", inputs: "template" },
};

/** Every job a plan can carry, for the workflow's job gates. */
export const CARRIABLE_JOBS = [...Object.keys(JOB_INPUTS), ...Object.keys(MATRIX_JOBS)];

// The release reports come from this job's artifacts, so a promotion board runs it itself. PRD-630.
export const RELEASE_GATE_JOBS = ["native-platforms"];

/** The legs a plan owes, before anything is carried. */
export function legsOf(plan) {
  if (plan.selection !== "full") return [];
  const legs = [];
  for (const job of Object.keys(JOB_INPUTS))
    if (plan.jobs[job]?.required) legs.push({ job, leg: job, inputs: JOB_INPUTS[job] });
  for (const [job, { matrix, axis, inputs }] of Object.entries(MATRIX_JOBS)) {
    if (!plan.jobs[job]?.required) continue;
    for (const value of plan[matrix][axis])
      legs.push({ job, leg: `${job} (${value})`, inputs, value });
  }
  return legs;
}

function invalid(detail) {
  return new Error(`CI_SCOPE_INVALID_PLAN: carried ${detail}`);
}

/** What a plan owes once these legs are carried. Malformed entries throw: they would skip a test. */
export function applyCarried(plan, carried) {
  if (carried === undefined || (Array.isArray(carried) && carried.length === 0)) return plan;
  if (!Array.isArray(carried)) throw invalid("is not a list");
  if (plan.selection !== "full") throw invalid(`legs need a full plan, not ${plan.selection}`);
  const owed = new Map(legsOf(plan).map((leg) => [leg.leg, leg]));
  const seen = new Set();
  const next = structuredClone(plan);
  const carriedJobs = [];
  for (const entry of carried) {
    if (
      !Number.isSafeInteger(entry?.runId) ||
      entry.runId <= 0 ||
      !SHA.test(entry?.sourceSha ?? "") ||
      typeof entry?.leg !== "string" ||
      seen.has(entry.leg)
    )
      throw invalid("entry is malformed");
    seen.add(entry.leg);
    if (entry.job === "integration") {
      if (!plan.jobs.integration?.required || typeof entry.lane !== "string" || !entry.lane)
        throw invalid(`lane ${String(entry.lane)} is not owed`);
      continue;
    }
    const leg = owed.get(entry.leg);
    if (leg === undefined || leg.job !== entry.job) throw invalid(`leg ${entry.leg} is not owed`);
    const reason = `Carried: CI run ${entry.runId} passed this job on the same inputs`;
    if (leg.value === undefined) {
      next.jobs[leg.job] = { required: false, reason };
      carriedJobs.push(leg.job);
      continue;
    }
    const { matrix, axis } = MATRIX_JOBS[leg.job];
    next[matrix] = { [axis]: next[matrix][axis].filter((value) => value !== leg.value) };
    if (next[matrix][axis].length === 0) {
      next.jobs[leg.job] = { required: false, reason };
      carriedJobs.push(leg.job);
    }
  }
  next.carried = carried;
  next.carriedJobs = carriedJobs;
  return next;
}

/** The `git diff-tree` of two commits as paths with both blob ids. Throws when git cannot say. */
export function treeChanges(git, source, candidate) {
  const diff = git(["diff-tree", "-r", "-z", "--no-renames", source, candidate]);
  if (diff.status !== 0) throw new Error(`cannot compare ${source} with ${candidate}`);
  const fields = diff.stdout.split("\0");
  const changes = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const raw = /^:\d+ \d+ ([0-9a-f]+) ([0-9a-f]+) [A-Z]/u.exec(fields[index]);
    if (raw === null) throw new Error("unreadable tree diff");
    changes.push({ path: fields[index + 1], before: raw[1], after: raw[2] });
  }
  return changes;
}

function withoutCohortVersions(text) {
  const { version: _version, ...manifest } = JSON.parse(text);
  // Mask only the version, so that adding or removing a cohort dependency stays a change.
  for (const field of DEPENDENCY_FIELDS)
    if (manifest[field] !== undefined)
      manifest[field] = Object.fromEntries(
        Object.entries(manifest[field]).map(([name, range]) => [
          name,
          COHORT_PACKAGE.test(name) ? String(range).replace(/\d+\.\d+\.\d+/gu, "V") : range,
        ]),
      );
  return JSON.stringify(manifest);
}

/**
 * True when a release bump is the whole change. A third-party version change stays a change, because
 * only the cohort's own packages leave a manifest. Anything unreadable is not version-only.
 */
export function versionOnly(path, before, after) {
  try {
    if (/(?:^|\/)package\.json$/u.test(path))
      return withoutCohortVersions(before) === withoutCohortVersions(after);
    if (VERSION_FILES.some((pattern) => pattern.test(path))) {
      const mask = (text) => text.replace(/\b\d+\.\d+\.\d+\b/gu, "V");
      return mask(before) === mask(after);
    }
  } catch {}
  return false;
}

/** Whether a changed path can reach a leg. Deny-by-default: no rule below means it can. */
export function reaches(leg, path, isProse) {
  // Doc links and doc-reading specs run in the unit legs on a full board, so prose reaches them.
  if (leg.inputs === "unit") return true;
  if (isProse(path)) return false;
  if (WORKFLOWS.test(path) && !(leg.inputs === "native" && path === NATIVE_WORKFLOW)) return false;
  if (leg.inputs === "workspace") return true;
  if ([...AUTHORING, ROOT_SPECS, ...BOARD_SCRIPTS].some((pattern) => pattern.test(path)))
    return false;
  if (leg.inputs === "template" && (PACKAGE_SPECS.test(path) || DOCS.test(path))) return false;
  const kit = TEMPLATE_DIR.exec(path)?.[1];
  // The native legs read several kits directly: `examples/native-smoke` reads templates/minimal, and
  // a native-engine test reads templates/sailing/assets/ship.glb.
  if (kit === undefined || leg.inputs === "native") return true;
  // A scaffold copies render sources from starter into other kits and reads every kit manifest.
  return kit === leg.value || kit === "starter" || path.endsWith("/kit.json");
}

/** A job's block in a workflow plus the workflow's `env`, which every job inherits. */
export function jobText(workflow, job) {
  const env = /^env:\n(?: .*\n|\n)*/mu.exec(workflow)?.[0] ?? "";
  const start = workflow.search(new RegExp(`^ {2}${job}:$`, "mu"));
  if (start < 0) return null;
  const body = workflow.indexOf("\n", start) + 1;
  const rest = workflow.slice(body);
  const end = rest.search(/^ {2}[^ #\n]|^[^ #\n]/mu);
  return `${env}${workflow.slice(start, body)}${end < 0 ? rest : rest.slice(0, end)}`;
}

function readText(git, spec) {
  const read = git(["show", spec]);
  return read.status === 0 ? read.stdout : null;
}

function comparison(deps, source, candidate) {
  const changes = treeChanges(deps.git, source, candidate);
  const memo = deps.versionMemo ?? new Map();
  const bumpOnly = ({ path, before, after }) => {
    const key = `${before}:${after}`;
    if (!memo.has(key)) {
      const candidatePath =
        /(?:^|\/)package\.json$/u.test(path) || VERSION_FILES.some((pattern) => pattern.test(path));
      const left = candidatePath ? readText(deps.git, before) : null;
      const right = left === null ? null : readText(deps.git, after);
      memo.set(key, right !== null && versionOnly(path, left, right));
    }
    return memo.get(key);
  };
  const workflow = (sha) => readText(deps.git, `${sha}:.github/workflows/ci.yml`);
  const ciChanged = changes.some(({ path }) => path === ".github/workflows/ci.yml");
  const before = ciChanged ? workflow(source) : null;
  const after = ciChanged ? workflow(candidate) : null;
  return {
    // A release bump reaches no integration lane, so the lane selector never reads it.
    substantive: () => changes.filter((change) => !bumpOnly(change)),
    // `build-artifacts` makes the bytes the other legs test, so its own text counts for all of them.
    jobUnchanged: (job) => {
      if (!ciChanged) return true;
      if (before === null || after === null) return false;
      return [job, "build-artifacts"].every((name) => {
        const text = jobText(after, name);
        return text !== null && text === jobText(before, name);
      });
    },
    clean: (leg) =>
      !changes.some((change) => {
        if (!reaches(leg, change.path, deps.isProse)) return false;
        return leg.inputs === "unit" || !bumpOnly(change);
      }),
  };
}

function laneState(deps, source, candidate, compared) {
  if (!compared.jobUnchanged("integration")) return null;
  const before = readText(deps.git, `${source}:${deps.integrationWorkflow}`);
  const after = readText(deps.git, `${candidate}:${deps.integrationWorkflow}`);
  if (before === null || after === null) return null;
  const selection = deps.integrationSelection({
    files: compared.substantive().map(({ path }) => path),
    before,
    after,
  });
  return { lanes: selection.lanes, jobs: deps.integrationJobs(after) };
}

/** A failed job on the same inputs is the newest thing known about them, so it must run again. */
function redIn(jobs, names) {
  return jobs.some(
    (job) => names.includes(job.name) && ["failure", "timed_out"].includes(job.conclusion),
  );
}

function greenIn(jobs, names) {
  return (
    names.length > 0 &&
    names.every((name) => {
      const rows = jobs.filter((job) => job.name === name);
      return (
        rows.length === 1 && rows[0].status === "completed" && rows[0].conclusion === "success"
      );
    })
  );
}

function jobNames(leg, deps, plan) {
  return leg.job === "native-platforms" ? deps.nativeJobs(plan) : [leg.leg];
}

/**
 * The commit a run tested. A pull-request run tests its merge commit, not `head_sha`. That sha comes
 * from an artifact name, so git has to confirm the commit really merges this run's head.
 */
function testedCommit(run, deps) {
  if (run.event !== "pull_request") return run.head_sha;
  const tested = deps.receiptCandidate(run.id);
  if (!("sha" in tested) || !held(deps, tested.sha)) return null;
  const parent = deps.git(["rev-parse", `${tested.sha}^2`]);
  return parent.status === 0 && parent.stdout.trim() === run.head_sha ? tested.sha : null;
}

function held(deps, sha) {
  if (deps.git(["cat-file", "-e", `${sha}^{commit}`]).status === 0) return true;
  deps.git(["fetch", "--quiet", "--no-tags", "origin", sha]);
  return deps.git(["cat-file", "-e", `${sha}^{commit}`]).status === 0;
}

/**
 * Walk recent CI runs, newest first, until each leg has a result on the same inputs. Green carries it
 * and red keeps it. Returns the carried entries, none when the walk cannot start, which runs the board.
 *
 * ponytail: the runner class is not compared, because scope runs before the matrix legs exist and
 * their routing cannot be read yet. Hosted and tn-local leg times matched, and the 7-day window bounds
 * the drift. Compare it here if a lane starts to pass on one class and fail on the other.
 */
export function findCarried(plan, deps) {
  const started = (deps.now ?? Date.now)();
  const since = new Date(started - WINDOW_DAYS * 86_400_000).toISOString();
  const listed = deps.gh(`actions/workflows/ci.yml/runs?per_page=100&created=%3E%3D${since}`);
  const runs = listed.value?.workflow_runs;
  if (!Array.isArray(runs)) return [];
  const open = new Map(
    legsOf(plan)
      .filter((leg) => !deps.reserved?.includes(leg.job))
      .map((leg) => [leg.leg, leg]),
  );
  const lanesOpen = new Set(plan.jobs.integration?.required ? ["*"] : []);
  const carried = [];
  const memo = new Map();
  let examined = 0;
  for (const run of runs) {
    if (open.size === 0 && lanesOpen.size === 0) break;
    if ((deps.now ?? Date.now)() - started > DEADLINE_MS || examined >= SOURCE_RUNS) break;
    if (
      !Number.isSafeInteger(run?.id) ||
      String(run.id) === process.env.GITHUB_RUN_ID ||
      run.head_repository?.full_name !== process.env.GITHUB_REPOSITORY ||
      !SHA.test(run.head_sha ?? "") ||
      // A scheduled run checks out develop while `head_sha` names the default branch.
      run.event === "schedule"
    )
      continue;
    examined += 1;
    const source = testedCommit(run, deps);
    if (source === null || !held(deps, source)) continue;
    let compared;
    try {
      compared = comparison({ ...deps, versionMemo: memo }, source, plan.candidateSha);
    } catch {
      continue;
    }
    const legs = [...open.values()].filter(
      (leg) => compared.clean(leg) && compared.jobUnchanged(leg.job),
    );
    const lanes =
      lanesOpen.size > 0
        ? laneState({ ...deps, versionMemo: memo }, source, plan.candidateSha, compared)
        : null;
    const quietLanes = Object.entries(lanes?.lanes ?? {}).filter(
      ([lane, touched]) => !touched && (lanesOpen.has("*") || lanesOpen.has(lane)),
    );
    if (legs.length === 0 && quietLanes.length === 0) continue;
    const read = deps.runJobs(String(run.id));
    if ("error" in read) continue;
    for (const leg of legs) {
      const names = jobNames(leg, deps, plan);
      if (redIn(read.jobs, names)) open.delete(leg.leg);
      if (!greenIn(read.jobs, names)) continue;
      open.delete(leg.leg);
      carried.push({ job: leg.job, leg: leg.leg, runId: run.id, sourceSha: source });
    }
    if (lanesOpen.has("*")) {
      lanesOpen.delete("*");
      for (const lane of Object.keys(lanes?.jobs ?? {})) lanesOpen.add(lane);
    }
    for (const [lane] of quietLanes) {
      const names = lanes.jobs[lane] ?? [];
      if (redIn(read.jobs, names)) lanesOpen.delete(lane);
      if (!lanesOpen.has(lane) || !greenIn(read.jobs, names)) continue;
      lanesOpen.delete(lane);
      carried.push({
        job: "integration",
        lane,
        leg: `integration:${lane}`,
        runId: run.id,
        sourceSha: source,
      });
    }
  }
  return carried;
}

/**
 * The verdict's own check, independent of the planner that wrote the entries: the source job is green
 * on the Actions API and the inputs still compare clean. Returns one failure line per miss.
 */
export function carriedFailures(plan, owedPlan, deps) {
  const failures = [];
  const legs = new Map(legsOf(owedPlan).map((leg) => [leg.leg, leg]));
  const reads = new Map();
  const memo = new Map();
  for (const entry of plan.carried ?? []) {
    const miss = (detail) =>
      failures.push(`CI_REQUIRED_CARRIED_LEG: ${entry.leg} from CI run ${entry.runId} ${detail}`);
    if (!reads.has(entry.runId)) reads.set(entry.runId, deps.runJobs(String(entry.runId)));
    const read = reads.get(entry.runId);
    if ("error" in read) {
      miss(`could not be read: ${read.error}`);
      continue;
    }
    try {
      if (!held(deps, entry.sourceSha)) throw new Error("names a commit git cannot read");
      const compared = comparison(
        { ...deps, versionMemo: memo },
        entry.sourceSha,
        plan.candidateSha,
      );
      if (entry.job === "integration") {
        const lanes = laneState(deps, entry.sourceSha, plan.candidateSha, compared);
        if (lanes === null || lanes.lanes[entry.lane] !== false) miss("has changed inputs");
        else if (!greenIn(read.jobs, lanes.jobs[entry.lane] ?? []))
          miss("is not green on the Actions API");
        continue;
      }
      const leg = legs.get(entry.leg);
      if (leg === undefined) miss("is not a leg this plan owes");
      else if (!compared.clean(leg) || !compared.jobUnchanged(leg.job)) miss("has changed inputs");
      else if (!greenIn(read.jobs, jobNames(leg, deps, owedPlan)))
        miss("is not green on the Actions API");
    } catch (error) {
      miss(error instanceof Error ? error.message : String(error));
    }
  }
  return failures;
}
