import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

import { evaluateRichPlaytestAssertions } from "../src/index.js";
import type { IPlaytestReport } from "../src/report.js";
import { validatePlaytestScenario } from "../src/scenario.js";

/**
 * `examples/wasm-engine-boot/playtests/post-normal-node.playtest.json` runs the same page and asserted
 * exactly what `post.playtest.json` asserted, and the page's probe carried no field naming the source of
 * the post normal: a run where the engine could not build the material `normalNode` and wrote the
 * geometric normal instead passed every assertion the scenario had. The scenario is named for the node,
 * so it must fail that run. Ahead of any browser, the evaluator the runner uses decides it: one probe
 * sample that used the node, one that fell back, both otherwise identical.
 */
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const SCENARIO_PATH = join(
  REPO_ROOT,
  "examples/wasm-engine-boot/playtests/post-normal-node.playtest.json",
);

/** The probe as the page publishes it, before the measured step and after it, for one normal source. */
function probe(normalSource: string) {
  const steady = { steadyBindGroups: -1, steadyCompiles: -1, steadyGraphKeys: -1, steadyPrograms: -1, steadyTextKeys: -1 };
  return {
    after: { draws: 3, error: "", frames: 40, normalSource, ...Object.fromEntries(Object.keys(steady).map((name) => [name, 0])) },
    before: { draws: 0, error: "", frames: 1, normalSource, ...steady },
  };
}

function componentResults(normalSource: string): Array<{ id: string; pass: boolean }> {
  const scenario = validatePlaytestScenario(
    JSON.parse(readFileSync(SCENARIO_PATH, "utf8")),
    SCENARIO_PATH,
    SCENARIO_PATH,
  );
  const report = {
    diagnostics: [],
    distance: 0,
    entity: "wasm-post",
    expectMoved: false,
    frames: 40,
    observations: {
      components: { "wasm-post": { probe: probe(normalSource) } },
      console: [],
      hud: {},
      network: [],
      resources: {},
    },
    trivialityOptOuts: [],
  } as unknown as IPlaytestReport;
  return evaluateRichPlaytestAssertions({ report, scenario }).assertions.filter(({ id }) =>
    id.startsWith("component."),
  );
}

describe("the wasm post normal-node scenario", () => {
  test("fails a run whose post normal fell back to the geometric normal", () => {
    // The arm the scenario is named for: every component assertion holds when the node was used.
    expect(componentResults("node").filter(({ pass }) => !pass)).toEqual([]);

    // The fallback arm: the engine named TN_POST_NORMAL_GEOMETRIC and drew the geometric normal.
    expect(componentResults("geometric").filter(({ pass }) => !pass).map(({ id }) => id)).toContain(
      "component.wasm-post.probe.normalSource",
    );
  });
});
