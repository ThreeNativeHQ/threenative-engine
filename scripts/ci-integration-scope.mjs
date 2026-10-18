// No dependencies or install: the paths job runs this against exact Git objects.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { validateEventPlan } from "./ci-change-scope.mjs";

const WORKFLOW = ".github/workflows/integration.yml";
const SELECTOR = "scripts/ci-integration-scope.mjs";

// The package lanes share workspace producers, unlike csg/ik/vegetation's standalone npm
// projects. Producer configuration reaches every package lane; library source reaches its
// runtime consumers. This inventory adds coverage before the unknown-executable fallback.
const PACKAGE_LANES = [
  "animation",
  "exposure",
  "cold-boot",
  "decals",
  "fog",
  "fluid-particles",
  "fluid-native",
  "native-assets",
  "tone",
  "temporal",
  "velocity",
  "world-capture",
];
// The fluid fixtures use FluidParticles3D, Scene/defineGame and core/playtest. These independent
// modules are not imported by that runtime closure; their unit/build proofs stay on the CI board.
// The dependency-boundary spec guards this exception against a new import from the exercised roots.
export const INDEPENDENT_CORE_MODULES = [
  "animation",
  "clip-audit",
  "rig-preparation",
  "skeletal-mesh",
  "world-tiles",
  "world-cells",
  "terrain-jobs",
  "terrain-jobs-worker",
  "world-topology",
  "world-validate",
];
export const INDEPENDENT_PACKAGES = [
  "terrain",
  "metahuman",
  "raw-unreal",
  "ueformat",
  "engine-mcp",
  "blender-mcp",
];
const OWNED_PACKAGES =
  "core|physics|playtest|assets|ui|runtime-native|create-threenative|terrain|metahuman|raw-unreal|ueformat|engine-mcp|blender-mcp";
const PACKAGE_CONTRACT = new RegExp(
  `^packages/(?:${OWNED_PACKAGES})/(?:__tests__/.*\\.spec\\.ts|tests/.*\\.test\\.mjs)$`,
  "u",
);
const PACKAGE_PRODUCER = new RegExp(
  `^packages/(?:${OWNED_PACKAGES})/(?:package\\.json|tsconfig[^/]*\\.json|tsup\\.config\\.ts|scripts/.*|patches/.*)$`,
  "u",
);
export const INDEPENDENT_PROOFS =
  /^scripts\/(?:run-test-suite\.sh|verify-animation-reversal\.ts|verify-vq-locomotion\.ts|temporal-aa-(?:evidence|quality)\.ts|velocity-(?:capture|cost)-proof\.ts|verify-temporal-(?:aa|motion)\.ts|verify-velocity-history\.ts)$/u;
function dependencyLanes(file, current) {
  if (PACKAGE_PRODUCER.test(file)) return PACKAGE_LANES;
  if (/^packages\/core\/src\//u.test(file)) {
    const module = /^packages\/core\/src\/([^/]+)\.ts$/u.exec(file)?.[1];
    return INDEPENDENT_CORE_MODULES.includes(module)
      ? ["exposure", "cold-boot", ...(file.includes("/world-") ? ["world-capture"] : [])]
      : ["fluid-particles", "fluid-native"];
  }
  if (PACKAGE_CONTRACT.test(file)) {
    return [
      ...new Set(
        [...current.jobs]
          .filter(([, body]) => body.includes(file))
          .map(([id]) => current.lanesByJob.get(id))
          .filter(Boolean),
      ),
    ];
  }
  if (
    INDEPENDENT_PROOFS.test(file) ||
    /^packages\/(?:terrain\/__tests__\/fixtures\/(?:glb|png)\.mjs|core\/__tests__\/(?:three-attributes\.d\.ts|velocity-render-fixture\.ts))$/u.test(
      file,
    )
  )
    return [];
  // New terrain/editor and import-package sources are built/unit-tested by the ordinary board,
  // and none of the retained integration fixtures imports these packages.
  if (
    /^packages\/(?:terrain|metahuman|raw-unreal|ueformat|engine-mcp|blender-mcp)\/src\//u.test(file)
  )
    return [];
  return undefined;
}

function parse(source) {
  if (source.includes("\t") || source.includes("\r")) throw new Error("ambiguous indentation");
  const split = source.split("\njobs:\n");
  if (split.length !== 2 || /^\S/mu.test(split[1])) throw new Error("unbounded jobs mapping");
  const headings = [...split[1].matchAll(/^ {2}([a-z][a-z0-9-]*):\n/gmu)];
  if (
    split[1]
      .split("\n")
      .some((line) => /^ {2}[^ #]/u.test(line) && !/^ {2}[a-z][a-z0-9-]*:$/u.test(line))
  )
    throw new Error("unknown job heading");
  const jobs = new Map(
    headings.map((h, i) => [h[1], split[1].slice(h.index, headings[i + 1]?.index)]),
  );
  if (!jobs.has("paths") || jobs.size !== headings.length) throw new Error("unknown job shape");
  if (jobs.has("completion")) {
    const expected = [
      "paths",
      ...[...jobs.keys()].filter((id) => !["paths", "completion"].includes(id)),
    ].sort();
    const body = jobs.get("completion");
    const needs = /^ {4}needs: \[([a-z0-9, -]+)\]$/mu
      .exec(body)?.[1]
      .split(",")
      .map((id) => id.trim())
      .sort();
    if (
      JSON.stringify(needs) !== JSON.stringify(expected) ||
      !body.includes("    if: ${{ always() }}")
    )
      throw new Error("unknown completion join");
    jobs.delete("completion");
  }
  const section = jobs.get("paths");
  const block = / {10}TN_LANE_FILTERS: \|\n((?: {12}[^\n]+\n)+)/u.exec(section)?.[1];
  if (!block) throw new Error("missing filters");
  const filters = new Map();
  for (const line of block.trimEnd().split("\n")) {
    const match = /^ {12}([a-z][a-z-]*) (\^.+)$/u.exec(line);
    if (!match || filters.has(match[1])) throw new Error("ambiguous filters");
    filters.set(match[1], new RegExp(match[2], "u"));
  }
  const outputs = [
    ...section.matchAll(
      /^ {6}([a-z][a-z-]*): \$\{\{ steps\.filter\.outputs\.([a-z][a-z-]*) \}\}$/gmu,
    ),
  ];
  if (
    outputs.length !== filters.size ||
    new Set(outputs.map((m) => m[1])).size !== filters.size ||
    outputs.some((m) => m[1] !== m[2] || !filters.has(m[1]))
  ) {
    throw new Error("filter/output mismatch");
  }
  const dependencies = new Map();
  const roots = new Map();
  for (const [id, body] of jobs) {
    if (id === "paths") continue;
    const declarations = [...body.matchAll(/^ {4}needs: (.+)$/gmu)];
    if (declarations.length !== 1) throw new Error("unknown needs shape");
    const raw = declarations[0][1];
    if (!/^(?:[a-z][a-z0-9-]*|\[[a-z0-9, -]+\])$/u.test(raw))
      throw new Error("unknown needs value");
    const needs = raw
      .replace(/^\[|\]$/gu, "")
      .split(",")
      .map((n) => n.trim());
    if (needs.some((n) => !jobs.has(n))) throw new Error("missing dependency");
    dependencies.set(id, needs);
    const gate = [...body.matchAll(/needs\.paths\.outputs\.([a-z][a-z-]*) == 'true'/gu)];
    if (needs.includes("paths")) {
      if (needs.length !== 1) throw new Error("entry dependency crosses lanes");
      const conditions = [...body.matchAll(/^ {4}if: (.+)$/gmu)];
      const condition =
        conditions.length === 1 &&
        /^\$\{\{ (?:!github\.event\.pull_request\.draft && )?needs\.paths\.outputs\.([a-z][a-z-]*) == 'true'(?: && !github\.event\.pull_request\.draft)? \}\}$/u.exec(
          conditions[0][1],
        );
      if (
        gate.length !== 1 ||
        !condition ||
        condition[1] !== gate[0][1] ||
        !filters.has(gate[0][1])
      )
        throw new Error("unknown root gate");
      roots.set(id, gate[0][1]);
    } else if (gate.length) throw new Error("unbound root gate");
    else if (/^ {4}if:/mu.test(body)) throw new Error("unknown dependent gate");
    if (/^ {4}continue-on-error:/mu.test(body))
      throw new Error("unsupported advisory integration job");
  }
  if (new Set(roots.values()).size !== filters.size) throw new Error("orphan filter");
  const laneFor = (id, seen = new Set()) => {
    if (roots.has(id)) return roots.get(id);
    if (seen.has(id)) throw new Error("cyclic dependencies");
    const lanes = new Set(dependencies.get(id).map((n) => laneFor(n, new Set([...seen, id]))));
    if (lanes.size !== 1) throw new Error("ambiguous dependent lane");
    return [...lanes][0];
  };
  const lanesByJob = new Map([...dependencies.keys()].map((id) => [id, laneFor(id)]));
  return {
    header: split[0],
    jobs,
    filters,
    lanesByJob,
    // Only canonical output entries and the validated filter block may be additive.
    // All other bytes of the shared paths job still participate in comparison.
    scheduling: section
      .replace(block, "<lane filters>\n")
      .replace(/^ {6}[a-z][a-z-]*: \$\{\{ steps\.filter\.outputs\.[a-z][a-z-]* \}\}\n/gmu, ""),
  };
}

export function integrationSelection({ files, before, after }) {
  // An unsupported output expression can override even a true step output. Fail the paths
  // job visibly rather than emit a partial fallback that Actions could treat as a skipped lane.
  const pathsAt = after.indexOf("\n  paths:\n");
  if (pathsAt < 0) throw new Error("missing paths output owner");
  const rest = after.slice(pathsAt + 1);
  const nextJob = /^ {2}[a-z][a-z0-9-]*:/mu.exec(rest.slice(1));
  const paths = nextJob ? rest.slice(0, nextJob.index + 1) : rest;
  const outputHeader = /^ {4}outputs:\n/mu.exec(paths);
  if (!outputHeader) throw new Error("missing integration outputs");
  const outputRest = paths.slice(outputHeader.index + outputHeader[0].length);
  const sibling = /^ {4}[a-z][a-z0-9-]*:/mu.exec(outputRest);
  if (!sibling) throw new Error("unbounded integration outputs");
  const outputBlock = outputRest.slice(0, sibling.index);
  const outputNames = outputBlock
    .split("\n")
    .filter((line) => line.trim() && !line.trimStart().startsWith("#"))
    .filter((line) => {
      // Non-lane metadata outputs (`candidate_sha`, `required_jobs`, PRD-620's `runner_admission`)
      // ride the paths job but are not lane selectors; the CLI emits them from the same step.
      if (!/^ {6}(?:candidate_sha|required_jobs|runner_admission): /u.test(line)) return true;
      const metadata =
        /^ {6}(candidate_sha|required_jobs|runner_admission): \$\{\{ steps\.filter\.outputs\.(candidate_sha|required_jobs|runner_admission) \}\}$/u.exec(
          line,
        );
      if (!metadata || metadata[1] !== metadata[2])
        throw new Error("unsupported integration metadata expression");
      return false;
    })
    .map((line) => {
      const match =
        /^ {6}([a-z][a-z-]*): \$\{\{ steps\.filter\.outputs\.([a-z][a-z-]*) \}\}$/u.exec(line);
      if (!match || match[1] !== match[2])
        throw new Error("unsupported integration output expression");
      return match[1];
    });
  if (!outputNames.length) throw new Error("no integration outputs");
  if (new Set(outputNames).size !== outputNames.length)
    throw new Error("duplicate integration outputs");
  const declaredLanes = new Set([
    ...[...paths.matchAll(/^ {12}([a-z][a-z-]*) /gmu)].map((m) => m[1]),
    ...[...after.matchAll(/needs\.paths\.outputs\.([a-z][a-z-]*)(?![a-z_-])/gu)].map((m) => m[1]),
  ]);
  if (
    declaredLanes.size !== outputNames.length ||
    outputNames.some((name) => !declaredLanes.has(name))
  ) {
    throw new Error("incomplete integration output inventory");
  }
  const all = (reason) => ({
    lanes: Object.fromEntries(outputNames.map((n) => [n, true])),
    reason,
  });
  try {
    const current = parse(after);
    if (!Array.isArray(files) || files.some((f) => typeof f !== "string"))
      return all("unknown changed paths");
    if (files.includes(SELECTOR)) return all("shared selector changed");
    const lanes = new Set();
    for (const file of files) {
      const dependency = dependencyLanes(file, current);
      if (
        dependency === PACKAGE_LANES &&
        [...current.filters.keys()].some(
          (lane) => !PACKAGE_LANES.includes(lane) && !["csg", "ik", "vegetation"].includes(lane),
        )
      )
        return all("unclassified additive producer consumer");
      let matched = dependency !== undefined;
      for (const lane of dependency ?? []) {
        if (!current.filters.has(lane)) return all("unresolved producer lane");
        lanes.add(lane);
      }
      for (const [lane, pattern] of current.filters) {
        if (pattern.test(file)) {
          lanes.add(lane);
          matched = true;
        }
      }
      // Unclassified executable harnesses/configuration cannot silently skip proofs.
      // CI contract specs are checked by the dedicated CI contracts lane.
      if (
        !matched &&
        file !== WORKFLOW &&
        (/^scripts\/(?!__tests__\/).*\.(?:[cm]?[jt]s|sh|py)$/u.test(file) ||
          /^\.github\/actions\//u.test(file) ||
          /^packages\/(?!create-threenative\/).*(?:\/package\.json|\/[^/]+\.config\.[cm]?[jt]s)$/u.test(
            file,
          ) ||
          /^(?!scripts\/__tests__\/|packages\/create-threenative\/|examples\/|docs\/).*\.(?:[cm]?[jt]sx?|cpp|h|hpp|cmake)$/u.test(
            file,
          ) ||
          /^(?:package\.json|pnpm-(?:lock|workspace)\.yaml|tsconfig[^/]*\.json)$/u.test(file))
      )
        return all("unclassified executable integration dependency");
    }
    if (files.includes(WORKFLOW)) {
      const previous = parse(before);
      if (
        current.header !== previous.header ||
        current.scheduling !== previous.scheduling ||
        [...previous.jobs.keys()].some((id) => !current.jobs.has(id)) ||
        [...previous.filters.keys()].some((lane) => !current.filters.has(lane)) ||
        [...previous.lanesByJob].some(([id, lane]) => current.lanesByJob.get(id) !== lane) ||
        [...current.lanesByJob].some(
          ([id, lane]) => !previous.jobs.has(id) && previous.filters.has(lane),
        )
      ) {
        return all("shared scheduling or workflow shape changed");
      }
      for (const [lane, pattern] of current.filters) {
        if (pattern.source !== previous.filters.get(lane)?.source) lanes.add(lane);
      }
      for (const [id, body] of current.jobs) {
        if (id !== "paths" && body.trimEnd() !== previous.jobs.get(id)?.trimEnd()) {
          lanes.add(current.lanesByJob.get(id));
          if (previous.jobs.has(id)) lanes.add(previous.lanesByJob.get(id));
        }
      }
    }
    return {
      lanes: Object.fromEntries(outputNames.map((n) => [n, lanes.has(n)])),
      reason: "source filters and bounded job/dependency comparison",
    };
  } catch (error) {
    if (error.message === "unknown root gate") throw error;
    return all(`fail closed: ${error.message}`);
  }
}

export function integrationGitSelection(base, head) {
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
  const after = git("show", `${head}:${WORKFLOW}`);
  try {
    if (!/^[a-f0-9]{40}$/u.test(base ?? "") || !/^[a-f0-9]{40}$/u.test(head ?? ""))
      throw new Error("missing exact source identity");
    if (git("rev-parse", "HEAD").trim() !== head) throw new Error("checkout/source mismatch");
    git("merge-base", "--is-ancestor", base, head);
    // --no-renames retains both endpoints: removing a source is an impact too.
    const files = git("diff", "--no-renames", "--name-only", "-z", base, head, "--")
      .split("\0")
      .filter(Boolean);
    return integrationSelection({ files, before: git("show", `${base}:${WORKFLOW}`), after });
  } catch {
    return integrationSelection({ files: [SELECTOR], before: "", after });
  }
}

// Exact-candidate inventory shared by the reusable workflow and independent protected verdict.
export function integrationCandidatePreflight({
  plan: value,
  eventName,
  target,
  baseSha,
  candidateSha,
}) {
  const plan = validateEventPlan(value, { eventName, baseRef: target });
  const candidate = candidateSha ?? plan.candidateSha;
  const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
  if (candidate !== plan.candidateSha || git("rev-parse", "HEAD").trim() !== candidate)
    throw new Error("CI_INTEGRATION_CANDIDATE_MISMATCH: checkout, caller and plan must agree");
  const after = git("show", `${candidate}:${WORKFLOW}`);
  const current = parse(after);
  const selection = plan.qualification
    ? integrationSelection({ files: [SELECTOR], before: "", after })
    : integrationGitSelection(baseSha, candidate);
  return {
    candidateSha: candidate,
    lanes: selection.lanes,
    jobs: [...current.lanesByJob]
      .filter(([, lane]) => selection.lanes[lane])
      .map(([id]) => id)
      .sort(),
    jobNames: Object.fromEntries(
      [...current.jobs]
        .filter(([id]) => id !== "paths")
        .map(([id, body]) => {
          const name = /^ {4}name: ([^\n]+)$/mu.exec(body)?.[1] ?? id;
          if (name.includes("${{") || !name.trim()) throw new Error("unknown integration job name");
          return [id, name];
        }),
    ),
    qualification: plan.qualification,
    planVersion: plan.version,
  };
}

export function validateIntegrationReceipts(expected, receipts, listing) {
  if (expected.qualification && expected.jobs.length === 0)
    throw new Error("CI_INTEGRATION_EMPTY_QUALIFICATION");
  if (
    !Array.isArray(receipts) ||
    receipts.length !== expected.jobs.length ||
    new Set(receipts.map((r) => r?.job)).size !== expected.jobs.length ||
    receipts.some((r) => !expected.jobs.includes(r?.job))
  )
    throw new Error(
      "CI_INTEGRATION_RECEIPT_INVENTORY: required receipts are missing, duplicated or unmapped",
    );
  if (
    !Array.isArray(listing?.jobs) ||
    !Number.isInteger(listing.totalCount) ||
    listing.totalCount !== listing.jobs.length
  )
    throw new Error("CI_INTEGRATION_API_INCOMPLETE: job listing must be complete");
  for (const receipt of receipts) {
    const matching = listing.jobs.filter(
      (job) => job.name === `integration / ${expected.jobNames[receipt.job]}`,
    );
    if (matching.length !== 1) throw new Error(`CI_INTEGRATION_JOB_IDENTITY: ${receipt.job}`);
    const job = matching[0];
    if (String(job.run_id) !== expected.runId || String(job.run_attempt) !== expected.runAttempt)
      throw new Error(`CI_INTEGRATION_JOB_IDENTITY: ${receipt.job} belongs to another run/attempt`);
    if (job.status !== "completed" || job.conclusion !== "success")
      throw new Error(
        `CI_INTEGRATION_LEG_NOT_SUCCESS: ${receipt.job} (${job.conclusion ?? job.status})`,
      );
    if (
      receipt.version !== 1 ||
      receipt.candidateSha !== expected.candidateSha ||
      receipt.runId !== expected.runId ||
      receipt.runAttempt !== expected.runAttempt ||
      receipt.planVersion !== expected.planVersion ||
      receipt.conclusion !== "success" ||
      !Number.isSafeInteger(job.id) ||
      job.id <= 0 ||
      receipt.jobId !== String(job.id)
    )
      throw new Error(
        `CI_INTEGRATION_RECEIPT_IDENTITY: ${receipt.job} source, attempt, job or profile mismatch`,
      );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = process.env.TN_CI_PLAN
    ? integrationCandidatePreflight({
        plan: JSON.parse(process.env.TN_CI_PLAN),
        eventName: process.env.TN_CI_EVENT,
        target: process.env.TN_CI_BASE_REF,
        baseSha: process.env.TN_BASE_SHA,
        candidateSha: process.env.TN_HEAD_SHA,
      })
    : integrationGitSelection(process.env.TN_BASE_SHA, process.env.TN_HEAD_SHA);
  console.log(
    result.reason ??
      (result.qualification
        ? "exhaustive candidate qualification"
        : "affected candidate integration"),
  );
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(result.lanes)
      .map(([lane, selected]) => `${lane}=${selected}\n`)
      .join(""),
  );
  if (result.jobs)
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `candidate_sha=${result.candidateSha}\nrequired_jobs=${JSON.stringify(result.jobs)}\n`,
    );
}
