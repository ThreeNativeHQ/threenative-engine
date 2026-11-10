import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { makeTempDir } from "../../../test-support/temp-dir.js";
import { loadPlaytestScenario } from "../src/scenario.js";

// PRD-182 Phase 1 characterization net for the scenario load/validate layer: malformed
// scenarios throw at load with these exact messages (fail-closed), and a canonical scenario
// loads with its fields preserved. Pinning current behavior; fixing behavior is NOT this PRD.

async function writeScenario(body: unknown): Promise<string> {
  const projectPath = await makeTempDir("playtest-scenario-net-");
  await mkdir(join(projectPath, "artifacts"), { recursive: true });
  await writeFile(join(projectPath, "scenario.json"), JSON.stringify(body));
  return projectPath;
}

const CANONICAL = {
  assert: { world: { seed: 7 } },
  name: "canonical-scenario",
  schemaVersion: 1,
  steps: [{ release: true, waitTicks: 1 }],
};

describe("scenario load characterization", () => {
  test("a canonical minimal scenario loads with its fields preserved", async () => {
    const projectPath = await writeScenario(CANONICAL);
    const scenario = await loadPlaytestScenario(projectPath, "scenario.json");
    expect(scenario.name).toBe("canonical-scenario");
    expect(scenario.schemaVersion).toBe(1);
    expect(scenario.steps).toHaveLength(1);
    expect(scenario.assert?.world).toBeDefined();
  });

  test.each([
    ["a JSON array", [], /Scenario root must be a JSON object\./u],
    ["a non-object scalar", 7, /Scenario root must be a JSON object\./u],
    [
      "a wrong schemaVersion",
      { ...CANONICAL, schemaVersion: 2 },
      /Scenario schemaVersion must be 1\./u,
    ],
    [
      "an unknown target",
      { ...CANONICAL, target: "android" },
      /Scenario target must be one of: web, desktop, bevy\./u,
    ],
    [
      "an unknown inputDelivery",
      { ...CANONICAL, inputDelivery: "random" },
      /Scenario inputDelivery must be deterministic or focused-dom\./u,
    ],
    [
      "an unsupported assertion kind",
      { ...CANONICAL, assert: { teleports: {} } },
      /Unknown key 'teleports' at assert\.teleports\. Supported keys: aerodynamics, animation, audio, camera/u,
    ],
    [
      "an unstable name",
      { ...CANONICAL, name: "Not A Stable Name" },
      /Scenario name must be a stable file-safe identifier\./u,
    ],
  ])("fails closed on %s", async (_label, body, message) => {
    const projectPath = await writeScenario(body);
    await expect(loadPlaytestScenario(projectPath, "scenario.json")).rejects.toThrow(message);
  });
});
