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
  /** `pnpm release --prove-upgrade --skip-gates`: pack, prove, publish nothing. */
  readonly prove: () => void;
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

/** The tag every runtime release hangs on. */
const TAG_PREFIX = "runtime-native-v";

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

/**
 * The release a tag carries, read through `gh release view`.
 *
 * Only a real miss is "none": a failed read here could move the tag of a public release.
 */
function ghReleaseState(deps: IShipDeps, tag: string): ReleaseState {
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
    if (/release not found/iu.test(errorText(error))) return "none";
    throw error;
  }
  const release = JSON.parse(out) as { isDraft: boolean; isPrerelease: boolean };
  if (release.isDraft) return "draft";
  return release.isPrerelease ? "prerelease" : "public";
}

/** The commit `origin` carries for a tag, peeled when it points at one. */
function remoteTagCommit(deps: IShipDeps, tag: string): string | undefined {
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
    release: ghReleaseState(deps, tag),
    tag: { commit: remoteTagCommit(deps, tag) },
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

/** The version this tree ships, read from the commit being shipped rather than the checkout. */
function manifestVersion(deps: IShipDeps, sha: string): string {
  const manifest = JSON.parse(
    deps.git(["show", `${sha}:packages/runtime-native/package.json`]),
  ) as { version: string };
  return manifest.version;
}

/** The facts a burn is decided from: a release, its tag, and what npm serves of the version. */
export interface IVersionCensus {
  /** How many packages of the cohort npm already serves at this version. */
  readonly onNpm: number;
  readonly release: ReleaseState;
  readonly tag: { readonly commit?: string };
  /** The cohort's size. A version is spent only when all of it is on npm. */
  readonly total: number;
}

/** The one proof-only command. A drift in these names must fail a spec, not a release. */
export const PROVE_ARGV = ["release", "--prove-upgrade", "--skip-gates"] as const;

/** What is being shipped, for the messages a refusal writes. */
export interface IReleaseTarget {
  readonly sha: string;
  readonly tag: string;
  readonly version: string;
}

/**
 * A version is burned when its tag already carries a release at another commit while npm does not
 * serve its whole cohort. `assertTagMovable` refuses such a tag, and nothing can undo a public
 * release and an npm version by itself, so the version can never ship: the moves are a bump, or
 * deleting a draft, which is the one state where deleting loses nothing.
 *
 * On 2026-11-12 the 0.3.14 release went public and its npm cohort never landed. The next release
 * PR ran a full board, merged, and only then did the tag step refuse it — an hour and a merge
 * later. This reads the same facts before the evidence and the candidate, so it costs a minute.
 */
export function assertVersionNotBurned(census: IVersionCensus, target: IReleaseTarget): void {
  // Spent: npm serves the whole version, so there is nothing left to ship.
  if (census.onNpm >= census.total) return;
  // A first push with nothing on npm is the normal case, and a tag on this very commit is a resume.
  if (census.release === "none" && census.onNpm === 0) return;
  if (census.tag.commit === target.sha) return;
  // A draft made by hand may carry no tag at all: deleting it loses nothing, and the same version
  // can still ship — unless npm already serves part of the cohort, which a bump is the only fix for.
  // Every other state leaves the version name spent, and a partial cohort is finished from the commit
  // the tag already points at. Deleting a public release is the owner's call, so this never advises it.
  const kind = census.release === "prerelease" ? "a prerelease" : `a ${census.release} release`;
  const state =
    census.release === "none"
      ? `${target.tag} has no release yet`
      : census.tag.commit === undefined
        ? `${target.tag} already has ${kind} and no tag yet`
        : `${target.tag} already has ${kind} at ${census.tag.commit}`;
  const served =
    census.onNpm === 0
      ? `npm serves nothing of ${target.version}`
      : `${census.onNpm} of ${census.total} cohort packages are on npm at ${target.version} and the rest are not`;
  const lead =
    census.onNpm > 0 && census.release === "none" && census.tag.commit === undefined
      ? "Those packages hold the version name and a bump is the only fix"
      : census.release === "draft" && census.onNpm === 0
        ? "That draft holds the version name"
        : census.tag.commit === undefined
          ? "That release still owns the version name"
          : "The tag cannot move, so this commit cannot ship";
  const advice =
    census.onNpm === 0 && census.release === "draft"
      ? "delete the draft (nothing is public yet), then ship this version"
      : census.onNpm > 0 && census.tag.commit !== undefined
        ? `finish that cohort from the commit the tag points at (\`pnpm release:ship --sha ${census.tag.commit}\`)`
        : "run `pnpm release:prepare --bump`, then ship the new version";
  throw new Error(`TN_SHIP_VERSION_BURNED: ${state}. ${served}. ${lead}: ${advice}.`);
}

/**
 * `pnpm release:check-version` — the release pull request's early gate.
 *
 * The same decision as `assertVersionNotBurned`, read from the tree the pull request would merge,
 * so a burned version goes red in the board's first minutes instead of after the merge.
 */
export function checkReleaseVersion(deps: IShipDeps, sha: string): string {
  const version = manifestVersion(deps, sha);
  const tag = `${TAG_PREFIX}${version}`;
  const release = ghReleaseState(deps, tag);
  const commit = remoteTagCommit(deps, tag);
  // A settled release — none yet, or the one on the commit being shipped, which is a resume — has
  // nothing to decide about npm, so the registry is not read at all. Everything else counts the whole
  // cohort: a version whose core landed while four of its packages did not is not a spent version,
  // and either answer for it ("nothing to ship", or a bump that strands the half-published version)
  // would be wrong.
  const cohort = deps.cohort();
  if (cohort.length === 0)
    throw new Error(
      `TN_SHIP_EMPTY_COHORT: the publish set is empty, so ${tag} has no cohort to decide about. Fail closed rather than read an empty list as a served version.`,
    );
  // Only a tag already on this commit is settled: any other state has to answer what npm serves,
  // because a version whose cohort npm partly serves can never ship from here (a missed bump).
  const settled = commit === sha;
  const onNpm = settled
    ? 0
    : cohort.filter(({ name, version: at }) => deps.npmVersions(name).includes(at)).length;
  const census: IVersionCensus = { onNpm, release, tag: { commit }, total: cohort.length };
  assertVersionNotBurned(census, { sha, tag, version });
  if (onNpm >= census.total)
    return `every package of ${version} is on npm: nothing to ship for ${tag}.`;
  return `${tag} is shippable: ${
    release === "none"
      ? "no release exists for it"
      : `its ${release} release sits at the shipped commit`
  }.`;
}

/**
 * `npm view <pkg> versions --json` answers a bare string when the package has one version.
 *
 * Left as a string, `.includes(version)` is a substring match: `"0.3.14".includes("0.3.1")` is true,
 * so a different version would read as present.
 */
export function parseNpmVersions(stdout: string): readonly string[] {
  const parsed = JSON.parse(stdout) as string | string[];
  return Array.isArray(parsed) ? parsed : [parsed];
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

function describeStep(
  step: ShipStep,
  state: IShipState,
  sha: string,
  tag: string,
  proves: boolean,
): string {
  switch (step) {
    case "evidence":
      return `blocked: CI is ${evidenceLabel(state.ci)}.`;
    case "candidate":
      return `dispatch release-candidate.yml for ${sha}.`;
    case "tag": {
      const proof = proves ? ", after the upgrade proof" : "";
      return state.tag.commit === undefined
        ? `create and push ${tag} at ${sha}${proof}.`
        : `move ${tag} from ${state.tag.commit} to ${sha}${proof}.`;
    }
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
  const version = manifestVersion(deps, sha);
  const tag = `${TAG_PREFIX}${version}`;
  // Before the plan spends an evidence read or a 20-minute candidate: a tag that already carries
  // a release at another commit can never be moved, and npm has nothing to resume. This is the
  // same call the release pull request's own board job makes, on the same commit.
  checkReleaseVersion(deps, sha);
  const acted: ShipStep[] = [];
  // The proof takes minutes, and a release or a tag run created during it would make the tag
  // unmovable. So the tag step proves first and re-reads the state before it touches the ref.
  let proved = false;
  for (let guard = 0; guard < 8; guard += 1) {
    const state = readShipState(deps, sha, tag);
    const step = nextStep(state, sha, options.override !== undefined);
    if (options.auto && step === "verify") {
      deps.log(`${version} is already on npm. Nothing to ship.`);
      return acted;
    }
    // The plan line says "after the upgrade proof" only when this pass will actually prove.
    const proves = step === "tag" && !proved && options.override === undefined;
    deps.log(`next: ${describeStep(step, state, sha, tag, proves)}`);
    if (typeof state.ci === "number") {
      const request = buildCandidateRequest(deps.repository, sha, version, state.ci);
      // The gate's own parser: a request it would reject never reaches a dispatch.
      parseReleaseCandidateRequest(request, deps.repository, options.repo ?? REPO);
      deps.log(`request: ${JSON.stringify(request)}`);
    }
    if (options.override !== undefined) deps.log(`OVERRIDE: ${options.override}`);
    if (options.dryRun || step === "evidence") {
      if (!options.dryRun)
        throw new Error(`TN_SHIP_EVIDENCE: ${describeStep(step, state, sha, tag, proves)}`);
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
      // Nothing about this version is public yet, and the upgrade proof is the last gate before the
      // first npm upload. Prove it here: the tag creates a release that is public the moment it
      // exists, so a red proof after the tag has already burned the version (0.3.14, 2026-11-12).
      // Nothing is tagged before the proof, for any cohort: a partial one was refused above, and
      // the publish never proves for one. This step then starts over, so the tag is moved on facts
      // read after the proof and not before it.
      if (proves) {
        deps.log("proving the previous latest upgrades before anything is public…");
        deps.prove();
        proved = true;
        // This step proved instead of acting: the next pass re-reads the state and moves the tag on
        // facts read after the proof.
        acted.pop();
        continue;
      }
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
        return parseNpmVersions(run("npm", ["view", name, "versions", "--json"]));
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
    prove: () => void execFileSync("pnpm", [...PROVE_ARGV], { cwd: REPO, stdio: "inherit" }),
    repository,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    verify: () =>
      void execFileSync("pnpm", ["tsx", "scripts/verify-registry-install.ts"], {
        cwd: REPO,
        stdio: "inherit",
      }),
  };
}

/**
 * `pnpm release:check-version` — the early gate the release pull request runs in its first minutes.
 * Reads the tree at HEAD and refuses a burned version; nothing is dispatched, tagged or published.
 */
export function runVersionCheck(argv: readonly string[]): void {
  if (argv.length > 0) throw new Error(`TN_SHIP_UNKNOWN_FLAG: ${argv.join(", ")}`);
  const deps = systemDeps();
  deps.log(checkReleaseVersion(deps, deps.git(["rev-parse", "HEAD"]).trim()));
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
