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

it("lists the 47 eligible HEAVY instances as 30 ci + 13 integration + 4 native", () => {
  expect(ADMISSION_NAMESPACES).toEqual(["ci", "integration", "native"]);
  expect(ADMISSION_INVENTORY).toHaveLength(47);
  expect(here("ci")).toHaveLength(30);
  expect(here("integration")).toHaveLength(13);
  expect(here("native")).toHaveLength(4);
  expect(new Set(ADMISSION_INVENTORY).size).toBe(47);
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

it("selects required Strata before the remaining CPU-heavy instances", () => {
  const plan = {
    jobs: {
      typecheck: { required: true },
      strata: { required: true },
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
    "ci:strata",
    "ci:test-unit:1/4",
    "ci:test-unit:2/4",
    "ci:typecheck",
    "integration:csg",
  ]);
  expect(selectInstances(plan, {})).not.toContain("integration:csg");
});

it("reserves available heavy capacity for required Strata before hostable CI work", () => {
  const plan = {
    qualification: true,
    jobs: {
      "test-unit": { required: true },
      "test-native": { required: true },
      test: { required: true },
      typecheck: { required: true },
      lint: { required: true },
      "build-artifacts": { required: true },
      "performance-contracts": { required: true },
      benchmark: { required: true },
      budgets: { required: true },
      "test-browser": { required: true },
      "test-playtest": { required: true },
      strata: { required: true },
      "golden-path-template": { required: true },
      "template-nonvisual": { required: true },
      integration: { required: true },
      "native-platforms": { required: true },
    },
    unitMatrix: { shard: ["1/4", "2/4", "3/4", "4/4"] },
    goldenMatrix: { template: ["starter", "platformer"] },
    templateMatrix: {
      template: ADMISSION_INVENTORY.filter((id: string) =>
        id.startsWith("ci:template-nonvisual:"),
      ).map((id: string) => id.slice("ci:template-nonvisual:".length)),
    },
  };
  const selectedInstances = selectInstances(plan, {
    csg: true,
    ik: true,
    vegetation: true,
    decals: true,
    tone: true,
    temporal: true,
    velocity: true,
    animation: true,
    fog: true,
    capture: true,
    "fluid-collision": true,
    exposure: true,
    "cold-boot": true,
  });

  expect(new Set(selectedInstances)).toEqual(new Set(ADMISSION_INVENTORY));
  expect(admissionPlan(selectedInstances, 6)).toEqual([
    "ci:strata",
    "ci:test-unit:1/4",
    "ci:test-unit:2/4",
    "ci:test-unit:3/4",
    "ci:test-unit:4/4",
    "ci:test-native",
  ]);
  expect(admissionPlan(selectedInstances, 1)).toEqual(["ci:strata"]);
});

it("keeps the prior admission order when Strata is not selected", () => {
  const plan = {
    jobs: { "test-unit": { required: true }, typecheck: { required: true } },
    unitMatrix: { shard: ["1/4", "2/4"] },
  };
  const selectedInstances = selectInstances(plan);

  expect(selectedInstances).toEqual(["ci:test-unit:1/4", "ci:test-unit:2/4", "ci:typecheck"]);
  expect(admissionPlan(selectedInstances, 1)).toEqual(["ci:test-unit:1/4"]);
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
