import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PLAYTEST_STARTUP_READY_TIMEOUT_MS } from "@threenative/playtest";
import { expect, test } from "vitest";

import { STARTUP_COMPILE_BUDGET_MS, STARTUP_STABLE_WINDOW_MS } from "../src/startup-readiness.js";

// The runner now waits for `ctx.startup` to reach "ready" before it observes anything, so a
// scenario stops racing the launch. That wait has to outlast the launch's own worst case, or it
// fails exactly the slow, GPU-less lanes it exists to make honest: golden-path runs on a CPU
// rasteriser that can miss the frame budget forever, and `StartupReadiness` resolves anyway only
// after the compile budget plus the sustained-frame window. Pinned here rather than in
// packages/playtest, which must not depend on @threenative/core.
test("the runner's startup wait outlasts core's own bounded launch, with margin", () => {
  // The runner also waits for the UI cover to lift, and that hand-off is bounded by one more window.
  const bound = STARTUP_COMPILE_BUDGET_MS + 2 * STARTUP_STABLE_WINDOW_MS;
  expect(PLAYTEST_STARTUP_READY_TIMEOUT_MS).toBeGreaterThan(bound);
  // Merely exceeding the sum is not enough. The gate's budgets do not cover the scene build and
  // first-use work that run before it opens: measured on a real SwiftShader adapter, a starter
  // scenario reported ready at ~57s against a 25s gate bound. A backstop for a hung page has to
  // clear the slow-but-healthy case by a multiple, not by seconds.
  expect(PLAYTEST_STARTUP_READY_TIMEOUT_MS).toBeGreaterThanOrEqual(bound * 3);
});

// The desktop loading proof carries the same bound and had drifted below it. Its harness injects a
// wall-clock wait before each fixed-step sample, and the settle sample's wait totalled 3s against a
// 25s worst case: macOS and Linux resolve on the fast five-frame path in well under a second, so
// the gap only showed on a cold Windows runner, which reached `startup-settled` with
// `loadingVisible` still true and never logged TN_LOADING_PROOF_DISMISSED. Read from the script so
// the number cannot drift back without this failing.
test("the desktop loading proof waits past core's bounded launch before sampling settled", () => {
  const harness = readFileSync(
    fileURLToPath(
      new URL("../../runtime-native/scripts/verify-desktop-loading.mjs", import.meta.url),
    ),
    "utf8",
  );
  const number = (name: string): number => {
    const declared = harness.match(new RegExp(`const ${name} = ([\\d_]+);`, "u"))?.[1];
    expect(declared, `verify-desktop-loading.mjs must declare ${name}`).toBeDefined();
    return Number(String(declared).replaceAll("_", ""));
  };
  const settleWaitMs = number("LOADING_SETTLE_STEPS") * number("LOADING_SETTLE_STEP_WAIT_MS");
  expect(settleWaitMs).toBeGreaterThan(STARTUP_COMPILE_BUDGET_MS + STARTUP_STABLE_WINDOW_MS);

  // Spread over many advances, never one sleep: a fixed-step bridge renders only when advanced, and
  // the scene's worker proof fails if fewer than two frames advance while its computation is in
  // flight. One long wait stalls the loop and reds that proof instead.
  expect(number("LOADING_SETTLE_STEPS")).toBeGreaterThanOrEqual(8);

  // The scenario must actually carry those settle steps between the two labelled samples.
  const scenario = JSON.parse(
    readFileSync(
      fileURLToPath(
        new URL(
          "../../../examples/native-smoke/playtests/loading-screen-desktop.playtest.json",
          import.meta.url,
        ),
      ),
      "utf8",
    ),
  ) as { steps: { label?: string }[] };
  const unlabelled = scenario.steps.filter((step) => step.label === undefined).length;
  expect(unlabelled).toBe(number("LOADING_SETTLE_STEPS"));
  expect(scenario.steps.at(-1)?.label).toBe("startup-settled");
});
