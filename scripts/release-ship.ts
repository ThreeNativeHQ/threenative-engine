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
  /** `pnpm release --yes --skip-gates`, then the clean-room verification. */
  readonly publish: () => void;
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
  readonly native: number | string;
  readonly npmPublished: boolean;
  readonly release: ReleaseState;
  readonly tag: { readonly commit?: string };
  readonly tagRun: "none" | "running" | "success" | "failed";
}

export type ShipStep = "evidence" | "candidate" | "tag" | "wait" | "publish" | "verify" | "done";

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
  } catch {
    return "none";
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
export function readShipState(
  deps: IShipDeps,
  sha: string,
  tag: string,
  runtimeVersion: string,
): IShipState {
  const ciAll = runs(deps, "ci.yml", sha);
  const nativeAll = runs(deps, "native-platforms.yml", sha);
  const ci = greenRun(ciAll, sha, ["push"]);
  const native = greenRun(nativeAll, sha, ["push", "workflow_dispatch"]);
  const candidateRuns = runs(deps, "release-candidate.yml", sha).filter(
    (run) => run.headBranch === "main" && run.event === "workflow_dispatch",
  );
  const tagRuns = runs(deps, "native-release.yml", sha).filter(
    (run) => run.event === "push" && run.headBranch === tag,
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
    native: native?.databaseId ?? describeMissing(nativeAll, sha),
    npmPublished: deps.npmVersions("@threenative/runtime-native").includes(runtimeVersion),
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
  runIds: { readonly ci: number; readonly native: number },
): IReleaseCandidateRequest {
  return {
    schemaVersion: 1,
    repository,
    tag: `runtime-native-v${runtimeVersion}`,
    candidateSha: sha,
    runtimeVersion,
    requiredRunIds: { ci: runIds.ci, native: runIds.native },
    reportArtifacts: {
      parity: expectedReleaseReportReference("parity", runIds.native),
      provenance: expectedReleaseReportReference("provenance", runIds.native),
    },
    releaseScope: SHIP_SCOPE,
  };
}

/** The first step that is not done. A second invocation resumes here. */
export function nextStep(state: IShipState, sha: string): ShipStep {
  if (typeof state.ci !== "number" || typeof state.native !== "number") return "evidence";
  if (state.npmPublished) return "verify";
  if (state.candidate.successes === 0) return "candidate";
  if (state.tag.commit !== sha) return "tag";
  if (state.release !== "public" || state.tagRun !== "success") return "wait";
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
      return `blocked: CI is ${evidenceLabel(state.ci)}; native-platforms is ${evidenceLabel(state.native)}.`;
    case "candidate":
      return `dispatch release-candidate.yml for ${sha}.`;
    case "tag":
      return state.tag.commit === undefined
        ? `create and push ${tag} at ${sha}.`
        : `move ${tag} from ${state.tag.commit} to ${sha}.`;
    case "wait":
      return `wait for the ${tag} run (${state.tagRun}) and a public release (${state.release}).`;
    case "publish":
      return "publish the npm cohort with `pnpm release --yes --skip-gates`.";
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
  readonly dryRun: boolean;
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
    const state = readShipState(deps, sha, tag, version);
    const step = nextStep(state, sha);
    deps.log(`next: ${describeStep(step, state, sha, tag)}`);
    if (typeof state.ci === "number" && typeof state.native === "number") {
      const request = buildCandidateRequest(deps.repository, sha, version, {
        ci: state.ci,
        native: state.native,
      });
      // The gate's own parser: a request it would reject never reaches a dispatch.
      parseReleaseCandidateRequest(request, deps.repository, options.repo ?? REPO);
      deps.log(`request: ${JSON.stringify(request)}`);
    }
    if (options.dryRun || step === "evidence") {
      if (!options.dryRun)
        throw new Error(`TN_SHIP_EVIDENCE: ${describeStep(step, state, sha, tag)}`);
      return acted;
    }
    acted.push(step);
    if (step === "candidate") {
      assertCandidateDispatchable(state, sha);
      const request = buildCandidateRequest(deps.repository, sha, version, {
        ci: state.ci as number,
        native: state.native as number,
      });
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
          const now = readShipState(deps, sha, tag, version).candidate;
          const fresh = now.failed.filter((id) => !state.candidate.failed.includes(id));
          if (fresh.length > 0)
            throw new Error(`TN_SHIP_CANDIDATE_FAILED: release-candidate run ${fresh[0]} failed.`);
          return now.successes > 0;
        },
        60,
      );
    } else if (step === "tag") {
      if (state.tag.commit !== undefined) assertTagMovable(state, tag);
      deps.git(["tag", "-f", tag, sha]);
      deps.git(["push", "--force", "origin", `refs/tags/${tag}`]);
    } else if (step === "wait") {
      await waitFor(
        deps,
        `${tag} run and release`,
        () => {
          const now = readShipState(deps, sha, tag, version);
          if (now.tagRun === "failed")
            throw new Error(
              `TN_SHIP_TAG_RUN_FAILED: the ${tag} run failed. Fix it on main and ship the new commit.`,
            );
          return now.release === "public" && now.tagRun === "success";
        },
        120,
      );
    } else if (step === "publish") {
      // `pnpm release --yes` ends with the clean-room registry install, so nothing follows it.
      deps.publish();
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
    gh: (args) => run("gh", args),
    git: (args) => run("git", args),
    log: (line) => process.stdout.write(`${line}\n`),
    npmVersions: (name) => {
      try {
        const out = run("npm", ["view", name, "versions", "--json"]);
        return JSON.parse(out) as string[];
      } catch {
        return [];
      }
    },
    publish: () =>
      void execFileSync("pnpm", ["release", "--yes", "--skip-gates"], {
        cwd: REPO,
        stdio: "inherit",
      }),
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
  const flags = new Set(argv.filter((arg) => arg.startsWith("--") && arg !== "--sha"));
  const shaIndex = argv.indexOf("--sha");
  const sha = shaIndex === -1 ? undefined : argv[shaIndex + 1];
  const unknown = argv.filter(
    (arg, index) =>
      !["--yes", "--dry-run", "--sha"].includes(arg) &&
      !(index === shaIndex + 1 && shaIndex !== -1),
  );
  if (unknown.length > 0) throw new Error(`TN_SHIP_UNKNOWN_FLAG: ${unknown.join(", ")}`);
  if (flags.has("--yes") && flags.has("--dry-run"))
    throw new Error("TN_SHIP_FLAGS_CONFLICT: --dry-run and --yes cannot be combined.");
  if (shaIndex !== -1 && (sha === undefined || !SHA_PATTERN.test(sha)))
    throw new Error("TN_SHIP_SHA: --sha needs a full 40-character commit SHA.");
  const deps = systemDeps();
  const resolved = sha ?? deps.git(["rev-parse", "HEAD"]).trim();
  const dryRun = !flags.has("--yes");
  await ship(deps, { dryRun, sha: resolved });
  if (dryRun)
    deps.log("Dry run: nothing was dispatched, tagged or published. Re-run with --yes to ship.");
}
