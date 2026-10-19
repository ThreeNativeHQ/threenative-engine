/**
 * No shipped template may configure a compile pass off — first half of the sweep.
 *
 * The cases and the reason they exist live in `template-assets-compile-cases.ts`; this file is the
 * half of the template list `vitest --shard` sends here, and the other half's twin is
 * `template-assets-compile-2.spec.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  compilesUnderTheDefaultConfig,
  compilesWithCompressionOnByDefault,
  firstHalf,
  reachesTheUncookedBudgetWithAnEligibleSourceProbe,
  templates,
} from "./template-assets-compile-cases.js";

// A template compile is tens of seconds of real work on an idle machine: the first half measured
// 1.0-44.6 s per template locally, and a merge-group runner shared with twenty jobs is 2-3 times
// slower, so the shared 60 s unit-test ceiling turned a compile that was merely concurrent into
// `Test timed out in 60000ms`. PRD-550 phase 1: the budget follows the work, not the default.
describe("shipped templates", { timeout: 180_000 }, () => {
  it.each(firstHalf)(
    "%s reaches the uncooked budget with an eligible source probe",
    reachesTheUncookedBudgetWithAnEligibleSourceProbe,
  );

  it("should name at least one template, or this gate is measuring nothing", () => {
    expect(templates.length).toBeGreaterThan(0);
  });

  it.each(firstHalf)(
    "%s should compile with compression on by default",
    compilesWithCompressionOnByDefault,
  );

  it.each(firstHalf)(
    "%s assets should compile under the default config",
    compilesUnderTheDefaultConfig,
  );
});
