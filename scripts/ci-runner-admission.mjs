// Admission of eligible Linux job instances to the tn-local heavy pool (PRD-620).
//
// One publisher advertises `TN_RUNNER_SLOTS`, the number of idle heavy slots, as a nonnegative
// integer. The scope parent turns the actual selected job instances into one ordered array and
// admits at most that many of them, so every workflow shares one capacity budget instead of
// three. A workflow consumer keeps its own fork/TN_RUNNER guard and asks
// `contains(fromJSON(needs.scope.outputs.runner_admission || '[]'), '<id>')`; anything absent stays
// hosted.
//
// Canonical instance id: `namespace:job[:leg]`, one matrix leg per instance:
// `ci:typecheck`, `ci:test-unit:2/4`, `integration:csg`, `native:starter-linux:linux-x64`.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
// The shipped-kit discovery is the authoritative one: it refuses a directory whose `kit.json`
// disagrees with its name, so a README or a stray file never becomes a template leg.
import { TEMPLATE_NAMES } from "./ci-change-scope.mjs";
import { integrationGitSelection } from "./ci-integration-scope.mjs";

export const ADMISSION_NAMESPACES = Object.freeze(["ci", "integration", "native"]);

// The eligible HEAVY set: every Linux job on the TN_RUNNER heavy switch, per its matrix —
// 30 ci + 13 integration + 4 native = 47 instances. The order is the default admission
// preference (CPU-heavy lanes first); the caller passes its own actual selected order instead.
const INVENTORY = Object.freeze({
  ci: Object.freeze({
    "test-unit": Object.freeze(["1/4", "2/4", "3/4", "4/4"]),
    "test-native": Object.freeze([null]),
    test: Object.freeze([null]),
    typecheck: Object.freeze([null]),
    lint: Object.freeze([null]),
    "build-artifacts": Object.freeze([null]),
    "performance-contracts": Object.freeze([null]),
    benchmark: Object.freeze([null]),
    budgets: Object.freeze([null]),
    "test-browser": Object.freeze([null]),
    "test-playtest": Object.freeze([null]),
    strata: Object.freeze([null]),
    "golden-path-template": Object.freeze(["starter", "platformer"]),
    "template-nonvisual": Object.freeze(TEMPLATE_NAMES),
  }),
  integration: Object.freeze(
    Object.fromEntries(
      [
        "csg",
        "ik",
        "vegetation",
        "decals",
        "tone",
        "temporal",
        "velocity",
        "animation",
        "fog",
        "capture",
        "fluid-collision",
        "exposure",
        "cold-boot",
      ].map((job) => [job, Object.freeze([null])]),
    ),
  ),
  native: Object.freeze({
    "web-reference": Object.freeze([null]),
    "android-v8-source": Object.freeze([null]),
    "desktop-parity": Object.freeze([null]),
    "starter-linux": Object.freeze(["linux-x64"]),
  }),
});

const INVENTORY_SET = new Set(
  ADMISSION_NAMESPACES.flatMap((namespace) =>
    Object.entries(INVENTORY[namespace]).flatMap(([job, legs]) =>
      legs.map((leg) => (leg === null ? `${namespace}:${job}` : `${namespace}:${job}:${leg}`)),
    ),
  ),
);

// Two integration jobs gate on a lane output whose name differs from the job id.
const INTEGRATION_LANE = Object.freeze({
  capture: "world-capture",
  "fluid-collision": "fluid-particles",
});

// Normalize the integration selector's lane outputs (keyed by output name) to inventory job names.
export function integrationJobLanes(raw) {
  return Object.fromEntries(
    Object.keys(INVENTORY.integration).map((job) => [
      job,
      raw?.[INTEGRATION_LANE[job] ?? job] === true,
    ]),
  );
}

// The flat eligible set in deterministic order, for a caller that has no order of its own.
export const ADMISSION_INVENTORY = Object.freeze([...INVENTORY_SET]);

export function canonicalInstanceId(namespace, job, leg = null) {
  const legs = INVENTORY[namespace]?.[job];
  if (legs === undefined) throw new Error(`CI_ADMISSION_UNKNOWN_JOB: ${namespace}:${job}`);
  if (leg === null || leg === undefined) {
    if (legs.length !== 1 || legs[0] !== null)
      throw new Error(`CI_ADMISSION_LEG_REQUIRED: ${namespace}:${job}`);
    return `${namespace}:${job}`;
  }
  if (!legs.includes(leg)) throw new Error(`CI_ADMISSION_UNKNOWN_LEG: ${namespace}:${job}:${leg}`);
  return `${namespace}:${job}:${leg}`;
}

// `TN_RUNNER_SLOTS`: a nonnegative integer, or nothing at all. An absent count means no slot was
// advertised, which is hosted routing, not a malformed value — a malformed nonempty count is not.
// A count that parses to something other than a safe integer (a 30-digit string, `Infinity`) is
// malformed too, or `slice(0, Infinity)` would silently admit the whole board.
function slotCount(slots, prefix) {
  if (slots === undefined || slots === null || slots === "") return null;
  if (typeof slots === "number") {
    if (!Number.isSafeInteger(slots) || slots < 0)
      throw new Error(`${prefix}_INVALID_SLOTS: TN_RUNNER_SLOTS must be a nonnegative integer`);
    return slots;
  }
  if (typeof slots !== "string" || !/^\d+$/u.test(slots))
    throw new Error(`${prefix}_INVALID_SLOTS: TN_RUNNER_SLOTS must be a nonnegative integer`);
  const count = Number(slots);
  if (!Number.isSafeInteger(count))
    throw new Error(`${prefix}_INVALID_SLOTS: TN_RUNNER_SLOTS must be a nonnegative integer`);
  return count;
}

// A published plan is an array of unique, recognized canonical ids. An absent plan is hosted.
export function validateAdmissionPlan(value, prefix = "CI_ADMISSION") {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value))
    throw new Error(`${prefix}_INVALID_PLAN: the admission plan must be an array`);
  const seen = new Set();
  for (const id of value) {
    if (typeof id !== "string" || !INVENTORY_SET.has(id))
      throw new Error(`${prefix}_INVALID_PLAN: unrecognized job instance ${JSON.stringify(id)}`);
    if (seen.has(id)) throw new Error(`${prefix}_INVALID_PLAN: duplicate job instance ${id}`);
    seen.add(id);
  }
  return Object.freeze([...value]);
}

export function parseAdmissionPlan(value, prefix = "CI_ADMISSION") {
  if (value === undefined || value === null || value === "") return Object.freeze([]);
  if (typeof value !== "string") return validateAdmissionPlan(value, prefix);
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${prefix}_INVALID_PLAN: the admission plan is not valid JSON`);
  }
  return validateAdmissionPlan(parsed, prefix);
}

// The parent's one decision: admit the first `slots` of the caller's ordered selected instances.
// At most that many instances total, across every workflow — never one budget per namespace.
export function admissionPlan(selected, slots, { fork = false, prefix = "CI_ADMISSION" } = {}) {
  const count = slotCount(slots, prefix);
  if (fork || count === null) return Object.freeze([]);
  const selectedInstances = validateAdmissionPlan(selected, prefix);
  return Object.freeze(selectedInstances.slice(0, count));
}

// The parent's selection puts required hardware Strata first, then uses CPU-heavy order. Only
// instances whose owning job the plan requires are listed, so no slot goes to an unselected job.
export function selectInstances(plan, integrationLanes = {}) {
  const job = plan?.jobs ?? {};
  const ids = [];
  // Strata is a hardware WebGPU gate; admit it before CPU-heavy work that can fall back hosted.
  if (job.strata?.required) ids.push("ci:strata");
  if (job["test-unit"]?.required)
    for (const leg of plan?.unitMatrix?.shard ?? [])
      if (INVENTORY.ci["test-unit"].includes(leg)) ids.push(`ci:test-unit:${leg}`);
  if (job["test-native"]?.required) ids.push("ci:test-native");
  if (job.test?.required) ids.push("ci:test");
  if (job.typecheck?.required) ids.push("ci:typecheck");
  if (job.lint?.required) ids.push("ci:lint");
  if (job["build-artifacts"]?.required) ids.push("ci:build-artifacts");
  if (job["performance-contracts"]?.required) ids.push("ci:performance-contracts");
  if (job.benchmark?.required) ids.push("ci:benchmark");
  if (job.budgets?.required) ids.push("ci:budgets");
  if (job["test-browser"]?.required) ids.push("ci:test-browser");
  if (job["test-playtest"]?.required) ids.push("ci:test-playtest");
  if (job["golden-path-template"]?.required)
    for (const template of plan?.goldenMatrix?.template ?? [])
      if (INVENTORY.ci["golden-path-template"].includes(template))
        ids.push(`ci:golden-path-template:${template}`);
  if (job["template-nonvisual"]?.required)
    for (const template of plan?.templateMatrix?.template ?? [])
      if (INVENTORY.ci["template-nonvisual"].includes(template))
        ids.push(`ci:template-nonvisual:${template}`);
  if (job.integration?.required)
    for (const lane of Object.keys(INVENTORY.integration))
      if (integrationLanes[lane] === true) ids.push(`integration:${lane}`);
  if (job["native-platforms"]?.required)
    ids.push(
      "native:web-reference",
      "native:android-v8-source",
      "native:desktop-parity",
      "native:starter-linux:linux-x64",
    );
  return ids;
}

// The reusable scope forwards the caller's plan after validation; an absent or malformed plan is
// hosted (`[]` or a throw, never a partial array).
function emit(output) {
  appendFileSync(process.env.GITHUB_OUTPUT, `runner_admission=${JSON.stringify(output)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  if (mode === "--validate-admission") {
    // Missing input is hosted; a malformed nonempty plan throws and fails the scope job closed.
    emit(parseAdmissionPlan(process.env.TN_RUNNER_ADMISSION, "CI_RUNNER_ADMISSION"));
  } else if (mode === "--admit") {
    const plan = JSON.parse(process.env.TN_CI_PLAN);
    const fork = process.env.TN_CI_FORK === "true";
    let lanes = {};
    if (plan.jobs?.integration?.required) {
      // The integration paths job emits lanes by output name; two inventory jobs carry a different
      // output name, so the raw lanes are normalized to inventory job names before selection.
      lanes = plan.qualification
        ? Object.fromEntries(Object.keys(INVENTORY.integration).map((job) => [job, true]))
        : integrationJobLanes(
            integrationGitSelection(process.env.TN_CI_BASE_SHA ?? "", plan.candidateSha).lanes,
          );
    }
    emit(
      admissionPlan(selectInstances(plan, lanes), process.env.TN_RUNNER_SLOTS, {
        fork: fork || !process.env.TN_RUNNER,
      }),
    );
  } else {
    throw new Error("CI_ADMISSION_USAGE: expected --admit or --validate-admission");
  }
}
