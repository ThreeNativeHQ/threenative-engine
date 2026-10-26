import { expect, it } from "vitest";

const {
  ADMISSION_INVENTORY,
  ADMISSION_NAMESPACES,
  admissionPlan,
  canonicalInstanceId,
  integrationJobLanes,
  parseAdmissionPlan,
  selectInstances,
  validateAdmissionPlan,
} = await import(new URL("../ci-runner-admission.mjs", import.meta.url).href);

const here = (namespace: string) =>
  ADMISSION_INVENTORY.filter((id: string) => id.startsWith(`${namespace}:`));

const selected = [
  "ci:test-unit:1/4",
  "native:desktop-parity",
  "integration:csg",
  "ci:template-nonvisual:racing",
  "ci:typecheck",
];

it("lists the 50 eligible HEAVY instances as 33 ci + 13 integration + 4 native", () => {
  expect(ADMISSION_NAMESPACES).toEqual(["ci", "integration", "native"]);
  expect(ADMISSION_INVENTORY).toHaveLength(50);
  expect(here("ci")).toHaveLength(33);
  expect(here("integration")).toHaveLength(13);
  expect(here("native")).toHaveLength(4);
  expect(new Set(ADMISSION_INVENTORY).size).toBe(50);
});

it("counts each matrix leg as its own instance", () => {
  for (const leg of ["1/4", "2/4", "3/4", "4/4"])
    expect(ADMISSION_INVENTORY).toContain(`ci:test-unit:${leg}`);
  for (const leg of ["starter", "platformer"])
    expect(ADMISSION_INVENTORY).toContain(`ci:golden-path-template:${leg}`);
  expect(ADMISSION_INVENTORY).toContain("ci:template-nonvisual:racing");
  expect(ADMISSION_INVENTORY).toContain("native:starter-linux:linux-x64");
});

it("builds well-formed canonical ids and rejects the malformed ones", () => {
  expect(canonicalInstanceId("ci", "typecheck")).toBe("ci:typecheck");
  expect(canonicalInstanceId("ci", "test-unit", "2/4")).toBe("ci:test-unit:2/4");
  expect(ADMISSION_INVENTORY).toContain(
    canonicalInstanceId("native", "starter-linux", "linux-x64"),
  );
  expect(() => canonicalInstanceId("ci", "test-unit")).toThrow(/LEG_REQUIRED/u);
  expect(() => canonicalInstanceId("ci", "nope")).toThrow(/UNKNOWN_JOB/u);
  expect(() => canonicalInstanceId("ci", "test-unit", "9/9")).toThrow(/UNKNOWN_LEG/u);
});

it("admits at most the published slots, in the caller's order, across every workflow", () => {
  expect(admissionPlan(selected, 3)).toEqual([
    "ci:test-unit:1/4",
    "native:desktop-parity",
    "integration:csg",
  ]);
  expect(admissionPlan(selected, 1)).toEqual(["ci:test-unit:1/4"]);
});

it("treats zero capacity, a missing count or an absent runner as hosted", () => {
  expect(admissionPlan(selected, 0)).toEqual([]);
  expect(admissionPlan(selected, undefined)).toEqual([]);
  expect(admissionPlan(selected, null)).toEqual([]);
  expect(admissionPlan(selected, "")).toEqual([]);
});

it("never routes a fork locally, even with free slots", () => {
  expect(admissionPlan(selected, 4, { fork: true })).toEqual([]);
});

it("returns every selected instance when capacity exceeds the population", () => {
  expect(admissionPlan(selected, 99)).toEqual(selected);
});

it("admits only the caller-selected instances, never the wider inventory", () => {
  const admitted = admissionPlan(["ci:typecheck"], 99);
  expect(admitted).toEqual(["ci:typecheck"]);
  expect(admitted).not.toContain("ci:test-unit:1/4");
});

it.each(["abc", "-1", "1.5", "2x", 1.5, -1])(
  "fails closed on a malformed nonempty count %p",
  (slots) => {
    expect(() => admissionPlan(selected, slots)).toThrow(/INVALID_SLOTS/u);
  },
);

it("fails closed on a count that parses past the safe integer range", () => {
  expect(() => admissionPlan(selected, "999999999999999999999999")).toThrow(/INVALID_SLOTS/u);
  expect(() => admissionPlan(selected, Number.MAX_SAFE_INTEGER + 2)).toThrow(/INVALID_SLOTS/u);
  expect(() => admissionPlan(selected, Number.POSITIVE_INFINITY)).toThrow(/INVALID_SLOTS/u);
  expect(admissionPlan(selected, String(Number.MAX_SAFE_INTEGER))).toEqual(selected);
});

it.each([3, "3"])("accepts the nonnegative integer count %p", (slots) => {
  expect(admissionPlan(selected, slots)).toHaveLength(3);
});

it("selects only the plan-required instances, in the inventory's CPU-heavy order", () => {
  const plan = {
    jobs: {
      typecheck: { required: true },
      "test-unit": { required: true },
      benchmark: { required: false },
      integration: { required: true },
      "native-platforms": { required: false },
    },
    unitMatrix: { shard: ["1/4", "2/4"] },
    goldenMatrix: { template: [] },
    templateMatrix: { template: [] },
  };
  expect(selectInstances(plan, { csg: true, ik: false })).toEqual([
    "ci:test-unit:1/4",
    "ci:test-unit:2/4",
    "ci:typecheck",
    "integration:csg",
  ]);
  expect(selectInstances(plan, {})).not.toContain("integration:csg");
});

it("keeps a plan-required instance with an unroutable matrix leg out of the selection", () => {
  const plan = {
    jobs: { "test-unit": { required: true } },
    unitMatrix: { shard: ["1/1"] },
    goldenMatrix: { template: [] },
    templateMatrix: { template: [] },
  };
  expect(selectInstances(plan, {})).toEqual([]);
});

it("selects ci:native-engine exactly once when the plan requires it, and omits it otherwise", () => {
  const plan = {
    jobs: { "native-engine": { required: true }, typecheck: { required: true } },
    unitMatrix: { shard: [] },
    goldenMatrix: { template: [] },
    templateMatrix: { template: [] },
  };
  const ids = selectInstances(plan, {});
  expect(ids).toContain("ci:native-engine");
  expect(ids.filter((id: string) => id === "ci:native-engine")).toHaveLength(1);
  expect(
    selectInstances(
      { ...plan, jobs: { "native-engine": { required: false }, typecheck: { required: true } } },
      {},
    ),
  ).not.toContain("ci:native-engine");
  expect(selectInstances({ ...plan, jobs: { typecheck: { required: true } } }, {})).not.toContain(
    "ci:native-engine",
  );
});

it("never emits a golden-path leg the inventory does not carry", () => {
  // A `template` selection runs golden-path against the changed kit, which may be neither of the
  // inventory's starter/platformer legs. That leg stays hosted rather than becoming an invalid id.
  const plan = {
    jobs: { "golden-path-template": { required: true } },
    unitMatrix: { shard: [] },
    goldenMatrix: { template: ["racing"] },
    templateMatrix: { template: [] },
  };
  expect(selectInstances(plan, {})).toEqual([]);
  expect(admissionPlan(selectInstances(plan, {}), 4)).toEqual([]);
});

it("normalizes the two integration lanes whose output name differs from the job id", () => {
  const lanes = integrationJobLanes({ "world-capture": true, "fluid-particles": true });
  expect(lanes.capture).toBe(true);
  expect(lanes["fluid-collision"]).toBe(true);
  expect(lanes.csg).toBe(false);
  expect(integrationJobLanes(null).csg).toBe(false);
});

it("rejects malformed JSON, non-arrays, duplicates and unrecognized ids", () => {
  expect(() => parseAdmissionPlan("{")).toThrow(/not valid JSON/u);
  expect(() => parseAdmissionPlan("{}")).toThrow(/must be an array/u);
  expect(() => parseAdmissionPlan("12")).toThrow(/must be an array/u);
  expect(() => parseAdmissionPlan('{"a":1}')).toThrow(/must be an array/u);
  expect(() => parseAdmissionPlan('["ci:typecheck","ci:typecheck"]')).toThrow(/duplicate/u);
  expect(() => parseAdmissionPlan('["ci:typecheck","ci:bogus"]')).toThrow(/unrecognized/u);
  expect(() => validateAdmissionPlan(["ci:typecheck", "ci:typecheck"])).toThrow(/duplicate/u);
});

it("treats an absent plan or legacy missing capacity as hosted", () => {
  expect(parseAdmissionPlan(undefined)).toEqual([]);
  expect(parseAdmissionPlan(null)).toEqual([]);
  expect(parseAdmissionPlan("")).toEqual([]);
  expect(validateAdmissionPlan(undefined)).toEqual([]);
  expect(validateAdmissionPlan(null)).toEqual([]);
});

it("round-trips a published plan back to the same admitted ids", () => {
  const admitted = admissionPlan(selected, 2);
  expect(parseAdmissionPlan(JSON.stringify(admitted))).toEqual([...admitted]);
});
