// Timer behaviour is proved by running the host, not by reading `runtime.cpp`.
//
// `tests/timer_delivery_test.cpp` boots a headless `Runtime` and checks, through the real
// scheduler: timeout and interval delivery, `clearInterval`, ordering, and a finite,
// non-negative, monotonic `performance.now()`. It builds twice:
//   - `threenative-timer-delivery-test`: the production scheduler-first bootstrap;
//   - `threenative-timer-engine-first-test`: the engine-first seam (`testEngineFirstTimers`).
// If post-engine installation is skipped, `setTimeout` is absent, `evalScript()` fails and the
// binary exits 1. An engine that installs its own non-scheduling `setTimeout` stub breaks
// delivery the same way. `pnpm native:verify:desktop` builds and runs both through
// `scripts/verify-native-contracts.mjs`. What stays here is the wiring: the lane must carry
// both binaries and require the pass line each prints.

import assert from "node:assert/strict";
import { test } from "vitest";

import { executionContracts } from "../scripts/verify-native-contracts.mjs";

test("the native lane builds and runs both timer delivery binaries", () => {
  assert.deepEqual(executionContracts["threenative-timer-delivery-test"].invocations, [
    { args: [], passLine: "native timer delivery contract passed" },
  ]);
  assert.deepEqual(executionContracts["threenative-timer-engine-first-test"].invocations, [
    { args: [], passLine: "native engine-first timer delivery contract passed" },
  ]);
});
