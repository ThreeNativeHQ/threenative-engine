import { describe, expect, test } from "vitest";

import { PLAYTEST_ASSERTION_REGISTRY } from "../src/assertion-schema.js";
import { validatePlaytestScenario } from "../src/scenario/schema-validate.js";
import { GENERATED_ASSERTION_FIELD_VALIDATORS } from "../src/scenario/generated-assertion-validators.js";

function scenario(assertions: Record<string, unknown>) {
  return {
    schemaVersion: 1,
    name: "generated-validator-proof",
    viewport: { width: 640, height: 360 },
    steps: [{ release: true, waitFrames: 1 }],
    assert: assertions,
  };
}

describe("generated assertion validators", () => {
  test("cover every field in the assertion registry", () => {
    for (const entry of PLAYTEST_ASSERTION_REGISTRY) {
      const validators = GENERATED_ASSERTION_FIELD_VALIDATORS[entry.kind];
      expect(validators, entry.kind).toBeDefined();
      expect(Object.keys(validators ?? {}).sort()).toEqual(entry.fields.map(({ name }) => name).sort());
    }
  });

  test("reject composite fields with the wrong top-level shape instead of dropping them", () => {
    expect(() => validatePlaytestScenario(scenario({
      movement: { minAxisDelta: "not-an-object" },
    }), "generated-validator-proof.json")).toThrow(/assert\.movement\.minAxisDelta.*must be \{ axis: string, min: number \}/u);

    expect(() => validatePlaytestScenario(scenario({
      framebufferCoverage: { backdrop: "dark", tolerance: 1, window: { endStep: "b", startStep: "a" } },
    }), "generated-validator-proof.json")).toThrow(/assert\.framebufferCoverage\.backdrop.*integer 0\.\.255/u);
  });
});
