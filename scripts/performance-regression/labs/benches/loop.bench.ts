// Labs adapter for the loop/dispatch family. The measured work and every correctness assertion
// live in the pure fixture; this file only registers the fixture with the runner. Setup (module
// loading, registration, the semantics control) happens before `yield`, so the timed region is
// only `stepFrame` dispatch.
import { bench, group } from "@pmndrs/labs";
import { LOOP_CASES, createLoopWorkload } from "../workloads/loop-workload.js";

group("fixed-step loop dispatch @loop", () => {
  for (const loopCase of LOOP_CASES) {
    bench(loopCase.name, async function* () {
      const workload = await createLoopWorkload(loopCase);
      try {
        yield () => workload.run();
        workload.verify();
      } finally {
        workload.dispose();
      }
    });
  }
});
