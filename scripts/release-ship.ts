/**
 * `pnpm release:ship` — one resumable command from a green main commit to a verified npm release.
 *
 * A release used to be six hand steps: wait for the main CI run, dispatch native-platforms, edit the
 * candidate request in three places, dispatch release-candidate once, move or create the tag, wait,
 * then `pnpm release`. PRD-624 took 30 hours because each step waited on the one before it and a
 * failure at the end restarted the chain by hand.
 *
 * Every step reads the current state before it acts, so a second invocation resumes at the first
 * step that is not done. Every gate stays in force: this only removes the hand work between them.
 * Dry by default: without `--yes`, nothing is dispatched, tagged or published.
 */

import { execFileSync } from "node:child_process";
import path from "node:path";
import { publishSet } from "./check-publish-state.js";
import {
  type IReleaseCandidateRequest,
  type IReleaseScope,
  expectedReleaseReportReference,
  parseReleaseCandidateRequest,
} from "./release-candidate-gate.js";

const REPO = path.resolve(import.meta.dirname, "..");
const SHA_PATTERN = /^[0-9a-f]{40}$/u;

/** What the candidate artifacts of the 0.3.x releases declared: four platforms, unsigned. */
export const SHIP_SCOPE: IReleaseScope = {
  platforms: ["linux", "windows", "macos", "android"],
  signed: false,
};

/** The hosted capabilities those candidates declared, as `release-candidate.yml` dispatch inputs. */
const CANDIDATE_INPUTS = [
  "ubuntu_runner=true",
  "windows_runner=true",
  "macos_runner=true",
  "android_sdk=true",
  "xcode=false",
  "timestamp_service=false",
];

export interface IShipDeps {
  readonly gh: (args: readonly string[]) => string;
  readonly git: (args: readonly string[]) => string;
  readonly log: (line: string) => void;
  readonly npmVersions: (name: string) => readonly string[];
  /** Every package of the npm cohort. A crash between levels leaves only part of it published. */
  readonly cohort: () => readonly { readonly name: string; readonly version: string }[];
  /** `pnpm release --yes --skip-gates --resume`, then the clean-room verification. */
  readonly publish: (override: boolean) => void;
  readonly repository: string;
  readonly sleep: (ms: number) => Promise<void>;
  readonly verify: () => void;
}

interface IRun {
  readonly conclusion: string;
  readonly databaseId: number;
  readonly event: string;
  readonly headBranch: string;
  readonly headSha: string;
  readonly status: string;
}

type ReleaseState = "none" | "draft" | "prerelease" | "public";

export interface IShipState {
  readonly candidate: {
    readonly failed: readonly number[];
    readonly inFlight: boolean;
    readonly successes: number;
  };
  readonly ci: number | string;
  readonly mainHead: string;
  readonly latestTagRun?: number;
  readonly npmPublished: boolean;
  readonly release: ReleaseState;
  readonly tag: { readonly commit?: string };
  readonly tagRun: "none" | "running" | "success" | "failed";
}

export type ShipStep =
  | "evidence"
  | "candidate"
  | "tag"
  | "dispatch"
  | "wait"
  | "publish"
  | "verify"
  | "done";

const RUN_FIELDS = "databaseId,status,conclusion,event,headBranch,headSha";

function runs(deps: IShipDeps, workflow: string, sha: string): readonly IRun[] {
  const out = deps.gh([
    "run",
    "list",
    "--repo",
    deps.repository,
    "--workflow",
    workflow,
    "--commit",
    sha,
    "--limit",
    "50",
    "--json",
    RUN_FIELDS,
  ]);
  return JSON.parse(out) as IRun[];
}

/** The newest completed, successful push (or dispatch) run on main for this exact commit. */
function greenRun(all: readonly IRun[], sha: string, events: readonly string[]): IRun | undefined {
  return all
    .filter(
      (run) =>
        run.status === "completed" &&
        run.conclusion === "success" &&
        run.headBranch === "main" &&
        run.headSha === sha &&
        events.includes(run.event),
    )
    .sort((a, b) => b.databaseId - a.databaseId)[0];
}

/** Why there is no green run: the newest run's state, or that none exists. */
function describeMissing(all: readonly IRun[], sha: string): string {
  const latest = all
    .filter((run) => run.headSha === sha)
    .sort((a, b) => b.databaseId - a.databaseId)[0];
  return latest === undefined
    ? "not green (no run exists for this commit)"
    : `not green (run ${latest.databaseId} is ${latest.status}${latest.conclusion ? `/${latest.conclusion}` : ""})`;
}

function errorText(error: unknown): string {
  const { message, stderr } = error as { message?: string; stderr?: string };
  return `${message ?? ""}\n${stderr ?? ""}`;
}

function releaseState(deps: IShipDeps, tag: string): ReleaseState {
  let out: string;
  try {
    out = deps.gh([
      "release",
      "view",
      tag,
      "--repo",
      deps.repository,
      "--json",
      "isDraft,isPrerelease",
    ]);
  } catch (error) {
    // Only a real miss is "none": a failed read here could move the tag of a public release.
    if (/release not found/iu.test(errorText(error))) return "none";
    throw error;
  }
  const release = JSON.parse(out) as { isDraft: boolean; isPrerelease: boolean };
  if (release.isDraft) return "draft";
  return release.isPrerelease ? "prerelease" : "public";
}

function tagCommit(deps: IShipDeps, tag: string): string | undefined {
  for (const ref of [`refs/tags/${tag}^{}`, `refs/tags/${tag}`]) {
    const commit = deps.git(["ls-remote", "origin", ref]).trim().split(/\s+/u)[0];
    if (commit) return commit;
  }
  return undefined;
}

/** Read every fact the plan depends on. Pure reads: safe in a dry run. */
export function readShipState(deps: IShipDeps, sha: string, tag: string): IShipState {
  const ciAll = runs(deps, "ci.yml", sha);
  const ci = greenRun(ciAll, sha, ["push"]);
  const candidateRuns = runs(deps, "release-candidate.yml", sha).filter(
    (run) => run.headBranch === "main" && run.event === "workflow_dispatch",
  );
  const tagRuns = runs(deps, "native-release.yml", sha).filter(
    (run) => run.event === "workflow_dispatch" && run.headBranch === tag,
  );
  const latestTagRun = tagRuns.sort((a, b) => b.databaseId - a.databaseId)[0];
  let tagRun: IShipState["tagRun"] = "none";
  if (latestTagRun !== undefined)
    tagRun =
      latestTagRun.status !== "completed"
        ? "running"
        : latestTagRun.conclusion === "success"
          ? "success"
          : "failed";
  return {
    ...(latestTagRun === undefined ? {} : { latestTagRun: latestTagRun.databaseId }),
    candidate: {
      failed: candidateRuns
        .filter((run) => run.status === "completed" && run.conclusion !== "success")
        .map((run) => run.databaseId),
      inFlight: candidateRuns.some((run) => run.status !== "completed"),
      successes: candidateRuns.filter(
        (run) => run.status === "completed" && run.conclusion === "success",
      ).length,
    },
    ci: ci?.databaseId ?? describeMissing(ciAll, sha),
    mainHead: deps.gh(["api", `repos/${deps.repository}/commits/main`, "--jq", ".sha"]).trim(),
    npmPublished: deps
      .cohort()
      .every(({ name, version }) => deps.npmVersions(name).includes(version)),
    release: releaseState(deps, tag),
    tag: { commit: tagCommit(deps, tag) },
    tagRun,
  };
}

/** The candidate request `rc.json` used to hold, built from the runs found for the commit. */
export function buildCandidateRequest(
  repository: string,
  sha: string,
  runtimeVersion: string,
  ciRunId: number,
): IReleaseCandidateRequest {
  return {
    schemaVersion: 1,
    repository,
    tag: `runtime-native-v${runtimeVersion}`,
    candidateSha: sha,
    runtimeVersion,
    requiredRunIds: { ci: ciRunId },
    reportArtifacts: {
      parity: expectedReleaseReportReference("parity", ciRunId),
      provenance: expectedReleaseReportReference("provenance", ciRunId),
    },
    releaseScope: SHIP_SCOPE,
  };
}

/** The first step that is not done. A second invocation resumes here. */
export function nextStep(state: IShipState, sha: string, override = false): ShipStep {
  if (state.npmPublished) return "verify";
  if (!override && typeof state.ci !== "number") return "evidence";
  if (!override && state.candidate.successes === 0) return "candidate";
  if (state.tag.commit !== sha) return "tag";
  if (
    state.release !== "public" &&
    (state.tagRun === "none" || (override && state.tagRun === "failed"))
  )
    return "dispatch";
  // Promotion is the verdict: `finalize` makes a release public only after its gating consumers pass.
  // The run's own conclusion also carries the iOS evidence job, which does not gate (owner, 2026-09-23).
  if (state.release !== "public") return "wait";
  return "publish";
}

/** A tag moves only when it points at a commit with no release, no draft and no tag run. */
export function assertTagMovable(state: IShipState, tag: string): void {
  if (state.release !== "none")
    throw new Error(
      `TN_SHIP_TAG_HAS_RELEASE: ${tag} already has a ${state.release} release. Refusing to move it: delete the release by hand if that is intended.`,
    );
  if (state.tagRun === "running")
    throw new Error(`TN_SHIP_TAG_RUN_ACTIVE: a native-release run for ${tag} is still running.`);
}

/** The exactly-once rule: `validate-tag` demands exactly one successful candidate run per commit. */
export function assertCandidateDispatchable(state: IShipState, sha: string): void {
  if (state.candidate.successes > 0)
    throw new Error(
      `TN_SHIP_CANDIDATE_EXISTS: ${sha} already has a successful release-candidate run. Dispatching a second one would break the exactly-once rule.`,
    );
  if (state.candidate.inFlight)
    throw new Error(`TN_SHIP_CANDIDATE_RUNNING: a release-candidate run for ${sha} is in flight.`);
  if (state.mainHead !== sha)
    throw new Error(
      `TN_SHIP_MAIN_MOVED: main is at ${state.mainHead}, not ${sha}. release-candidate runs against the head of main.`,
    );
}

const evidenceLabel = (value: number | string): string =>
  typeof value === "number" ? `green (run ${value})` : value;

function describeStep(step: ShipStep, state: IShipState, sha: string, tag: string): string {
  switch (step) {
    case "evidence":
      return `blocked: CI is ${evidenceLabel(state.ci)}.`;
    case "candidate":
      return `dispatch release-candidate.yml for ${sha}.`;
    case "tag":
      return state.tag.commit === undefined
        ? `create and push ${tag} at ${sha}.`
        : `move ${tag} from ${state.tag.commit} to ${sha}.`;
    case "dispatch":
      return `dispatch native-release.yml on ${tag}.`;
    case "wait":
      return `wait for the ${tag} run (${state.tagRun}) and a public release (${state.release}).`;
    case "publish":
      return "publish the npm cohort with `pnpm release --yes --skip-gates --resume`.";
    case "verify":
      return "verify the registry install in a clean room.";
    case "done":
      return "nothing left to do.";
  }
}

async function waitFor(
  deps: IShipDeps,
  what: string,
  done: () => boolean,
  timeoutMinutes: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMinutes * 60_000;
  while (!done()) {
    if (Date.now() > deadline)
      throw new Error(`TN_SHIP_TIMEOUT: ${what} did not finish in ${timeoutMinutes} minutes.`);
    deps.log(`  waiting for ${what}…`);
    await deps.sleep(60_000);
  }
}

export interface IShipOptions {
  /** The CI lane: a commit whose cohort is already on npm has nothing left to do. */
  readonly auto?: boolean;
  readonly dryRun: boolean;
  /** Admin only, enforced by the tag run: publish without CI evidence or consumer proofs. */
  readonly override?: string;
  readonly repo?: string;
  readonly sha: string;
}

/** Run the plan. Returns the steps it acted on, so a test can assert the resume behaviour. */
export async function ship(deps: IShipDeps, options: IShipOptions): Promise<readonly ShipStep[]> {
  const { sha } = options;
  const head = deps.git(["rev-parse", "HEAD"]).trim();
  if (head !== sha) {
    const message = `TN_SHIP_CHECKOUT: HEAD is ${head}. Check out ${sha} first; the release builds from this tree.`;
    // A plan reads GitHub only, so it may look at another commit. A real run builds this tree.
    if (!options.dryRun) throw new Error(message);
    deps.log(`note: ${message}`);
  }
  const manifest = JSON.parse(
    deps.git(["show", `${sha}:packages/runtime-native/package.json`]),
  ) as { version: string };
  const version = manifest.version;
  const tag = `runtime-native-v${version}`;
  const acted: ShipStep[] = [];
  for (let guard = 0; guard < 8; guard += 1) {
    const state = readShipState(deps, sha, tag);
    const step = nextStep(state, sha, options.override !== undefined);
    if (options.auto && step === "verify") {
      deps.log(`${version} is already on npm. Nothing to ship.`);
      return acted;
    }
    deps.log(`next: ${describeStep(step, state, sha, tag)}`);
    if (typeof state.ci === "number") {
      const request = buildCandidateRequest(deps.repository, sha, version, state.ci);
      // The gate's own parser: a request it would reject never reaches a dispatch.
      parseReleaseCandidateRequest(request, deps.repository, options.repo ?? REPO);
      deps.log(`request: ${JSON.stringify(request)}`);
    }
    if (options.override !== undefined) deps.log(`OVERRIDE: ${options.override}`);
    if (options.dryRun || step === "evidence") {
      if (!options.dryRun)
        throw new Error(`TN_SHIP_EVIDENCE: ${describeStep(step, state, sha, tag)}`);
      return acted;
    }
    acted.push(step);
    if (step === "candidate") {
      assertCandidateDispatchable(state, sha);
      const request = buildCandidateRequest(deps.repository, sha, version, state.ci as number);
      deps.gh([
        "workflow",
        "run",
        "release-candidate.yml",
        "--repo",
        deps.repository,
        "--ref",
        "main",
        "-f",
        `candidate_request=${JSON.stringify(request)}`,
        ...CANDIDATE_INPUTS.flatMap((input) => ["-f", input]),
      ]);
      await waitFor(
        deps,
        "release-candidate",
        () => {
          const now = readShipState(deps, sha, tag).candidate;
          const fresh = now.failed.filter((id) => !state.candidate.failed.includes(id));
          if (fresh.length > 0)
            throw new Error(`TN_SHIP_CANDIDATE_FAILED: release-candidate run ${fresh[0]} failed.`);
          return now.successes > 0;
        },
        60,
      );
    } else if (step === "tag") {
      if (state.tag.commit !== undefined) assertTagMovable(state, tag);
      // Through the API: a push would run this checkout's pre-push hook, which needs a built tree.
      deps.gh(
        state.tag.commit === undefined
          ? [
              "api",
              "--method",
              "POST",
              `repos/${deps.repository}/git/refs`,
              "-f",
              `ref=refs/tags/${tag}`,
              "-f",
              `sha=${sha}`,
            ]
          : [
              "api",
              "--method",
              "PATCH",
              `repos/${deps.repository}/git/refs/tags/${tag}`,
              "-f",
              `sha=${sha}`,
              "-F",
              "force=true",
            ],
      );
    } else if (step === "dispatch") {
      deps.gh([
        "workflow",
        "run",
        "native-release.yml",
        "--repo",
        deps.repository,
        "--ref",
        tag,
        ...(options.override === undefined ? [] : ["-f", `override=${options.override}`]),
      ]);
      // The run list lags a dispatch, and a second dispatch would start a second release run.
      await waitFor(
        deps,
        `the ${tag} run to start`,
        () => readShipState(deps, sha, tag).latestTagRun !== state.latestTagRun,
        10,
      );
    } else if (step === "wait") {
      await waitFor(
        deps,
        `${tag} run and release`,
        () => {
          const now = readShipState(deps, sha, tag);
          if (now.release === "public") return true;
          if (now.tagRun === "failed")
            throw new Error(
              `TN_SHIP_TAG_RUN_FAILED: the ${tag} run failed. Rerun a flake with \`gh run rerun --failed\`, or fix it on main and ship the new commit.`,
            );
          return false;
        },
        120,
      );
    } else if (step === "publish") {
      // `pnpm release --yes` ends with the clean-room registry install, so nothing follows it.
      deps.publish(options.override !== undefined);
      return acted;
    } else {
      deps.verify();
      return acted;
    }
  }
  throw new Error("TN_SHIP_LOOP: the plan did not converge.");
}

function systemDeps(): IShipDeps {
  const run = (command: string, args: readonly string[]): string =>
    execFileSync(command, [...args], {
      cwd: REPO,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  const repository = run("gh", [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "--jq",
    ".nameWithOwner",
  ]).trim();
  return {
    cohort: () => publishSet(REPO),
    gh: (args) => run("gh", args),
    git: (args) => run("git", args),
    log: (line) => process.stdout.write(`${line}\n`),
    npmVersions: (name) => {
      try {
        const out = run("npm", ["view", name, "versions", "--json"]);
        return JSON.parse(out) as string[];
      } catch (error) {
        if (/E404|404 Not Found/u.test(errorText(error))) return [];
        throw error;
      }
    },
    publish: (override) =>
      void execFileSync(
        "pnpm",
        ["release", "--yes", "--skip-gates", "--resume", ...(override ? ["--override"] : [])],
        { cwd: REPO, stdio: "inherit" },
      ),
    repository,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    verify: () =>
      void execFileSync("pnpm", ["tsx", "scripts/verify-registry-install.ts"], {
        cwd: REPO,
        stdio: "inherit",
      }),
  };
}

export async function runShip(argv: readonly string[]): Promise<void> {
  const flagValue = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const sha = flagValue("--sha");
  const override = flagValue("--override");
  const unknown = argv.filter(
    (arg, index) =>
      !["--yes", "--dry-run", "--auto", "--sha", "--override"].includes(arg) &&
      !["--sha", "--override"].includes(argv[index - 1] ?? ""),
  );
  if (unknown.length > 0) throw new Error(`TN_SHIP_UNKNOWN_FLAG: ${unknown.join(", ")}`);
  if (argv.includes("--yes") && argv.includes("--dry-run"))
    throw new Error("TN_SHIP_FLAGS_CONFLICT: --dry-run and --yes cannot be combined.");
  if (argv.includes("--sha") && (sha === undefined || !SHA_PATTERN.test(sha)))
    throw new Error("TN_SHIP_SHA: --sha needs a full 40-character commit SHA.");
  if (argv.includes("--override") && !override?.trim())
    throw new Error("TN_SHIP_OVERRIDE: --override needs a reason.");
  const deps = systemDeps();
  const resolved = sha ?? deps.git(["rev-parse", "HEAD"]).trim();
  const dryRun = !argv.includes("--yes");
  await ship(deps, {
    auto: argv.includes("--auto"),
    dryRun,
    sha: resolved,
    ...(override === undefined ? {} : { override }),
  });
  if (dryRun)
    deps.log("Dry run: nothing was dispatched, tagged or published. Re-run with --yes to ship.");
}
