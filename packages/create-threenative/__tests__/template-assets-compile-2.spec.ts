/**
 * No shipped template may configure a compile pass off — second half of the sweep.
 *
 * The cases and the reason they exist live in `template-assets-compile-cases.ts`; this file is the
 * half of the template list `vitest --shard` sends here, and the other half's twin is
 * `template-assets-compile-1.spec.ts`, which carries the suite's one whole-suite assertion. This
 * file's half fails closed in that module rather than by repeating it.
 */

import { describe, it } from "vitest";
import {
  compilesUnderTheDefaultConfig,
  compilesWithCompressionOnByDefault,
  reachesTheUncookedBudgetWithAnEligibleSourceProbe,
  secondHalf,
} from "./template-assets-compile-cases.js";

// The twin of `template-assets-compile-1.spec.ts`, with the same budget for the same reason: a
// template compile is tens of seconds of real work, not a unit test's 60 s default.
describe("shipped templates", { timeout: 180_000 }, () => {
  it.each(secondHalf)(
    "%s reaches the uncooked budget with an eligible source probe",
    reachesTheUncookedBudgetWithAnEligibleSourceProbe,
  );

  it.each(secondHalf)(
    "%s should compile with compression on by default",
    compilesWithCompressionOnByDefault,
  );

  it.each(secondHalf)(
    "%s assets should compile under the default config",
    compilesUnderTheDefaultConfig,
  );
});
