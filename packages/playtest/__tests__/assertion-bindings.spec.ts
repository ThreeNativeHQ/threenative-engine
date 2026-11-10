import { describe, expect, test } from "vitest";

import { ASSERTION_BINDINGS, ASSERTION_EMITTERS } from "../src/assertion-bindings.js";
import { PLAYTEST_ASSERTION_REGISTRY } from "../src/assertion-schema.js";
import { emitCausedBy } from "../src/evaluators/caused-by.js";
import { emitMovementEvidence } from "../src/evaluators/movement-evidence.js";
import { emitTone } from "../src/evaluators/tone.js";
import { PLAYTEST_LANES } from "../src/lanes.js";
import { HOST_PLAYTEST_OBSERVATION_FIELDS } from "../src/runner/observationFields.js";
import { validateAssertions } from "../src/scenario/schema-validate.js";

describe("assertion bindings", () => {
  test("every registry kind has exactly one binding, and every binding has a registry kind", () => {
    expect(Object.keys(ASSERTION_BINDINGS).sort()).toEqual(PLAYTEST_ASSERTION_REGISTRY.map(({ kind }) => kind).sort());
  });

  test("the emitter list is each bound emitter once, in row order", () => {
    expect(ASSERTION_EMITTERS[0]).toBe(emitTone);
    expect(ASSERTION_EMITTERS.at(-1)).toBe(emitMovementEvidence);
    expect(ASSERTION_EMITTERS.indexOf(emitCausedBy)).toBeLessThan(ASSERTION_EMITTERS.indexOf(emitMovementEvidence));
    expect(new Set(ASSERTION_EMITTERS).size).toBe(ASSERTION_EMITTERS.length);
    // camera is the one kind the base report evaluates instead of a rich emitter.
    expect(Object.entries(ASSERTION_BINDINGS).filter(([, { evaluate }]) => evaluate === undefined).map(([kind]) => kind)).toEqual(["camera"]);
  });

  test("the dispatch validates through the binding and keeps typed results", () => {
    expect(validateAssertions({ geometry: { limit: 5, sort: "draws" } }, "geometry.json")).toEqual({ geometry: { limit: 5, sort: "draws" } });
    expect(() => validateAssertions({ geometry: { limit: 0 } }, "geometry.json")).toThrow(/geometry\.limit.*1 to 500/u);
    expect(() => validateAssertions({ geometry: { sort: 7 } }, "geometry.json")).toThrow(/geometry\.sort/u);
    expect(() => validateAssertions({ geometry: [] }, "geometry.json")).toThrow(/geometry.*object/u);
    expect(() => validateAssertions({ tone: [] }, "tone.json")).toThrow(/tone.*at least one tone/u);
  });

  test("host observations come from the registry, not a second list", () => {
    const host = PLAYTEST_ASSERTION_REGISTRY.filter(({ observationSource }) => observationSource === "host").map(({ observationPath }) => observationPath);
    expect(host.sort()).toEqual(["deviceMetrics", "footSlip", "hudAudit", "sightLine", "tone"]);
    for (const path of host) expect(HOST_PLAYTEST_OBSERVATION_FIELDS).toContain(path);
  });

  test("supportedOn names only real lanes, and each kind has at least one", () => {
    for (const entry of PLAYTEST_ASSERTION_REGISTRY) {
      expect(entry.supportedOn.length, entry.kind).toBeGreaterThan(0);
      for (const lane of entry.supportedOn) expect(PLAYTEST_LANES, `${entry.kind} -> ${lane}`).toContain(lane);
    }
  });

  test("tone is supported on android, as the android runner runs it", () => {
    expect(PLAYTEST_ASSERTION_REGISTRY.find(({ kind }) => kind === "tone")?.supportedOn).toContain("android");
  });
});
