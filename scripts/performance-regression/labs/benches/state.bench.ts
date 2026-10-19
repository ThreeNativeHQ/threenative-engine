// Labs adapter for the state family. The measured work and every correctness assertion live in
// the pure fixture; this file only registers the fixture with the runner. Setup (module loading,
// subscriptions) happens before `yield`, so the timed region is only the coalesced writes+flush.
import { bench, group } from "@pmndrs/labs";
import { STATE_CASES, createStateWorkload } from "../workloads/state-workload.js";

group("coalesced state publication @state", () => {
  for (const stateCase of STATE_CASES) {
    bench(stateCase.name, async function* () {
      const workload = await createStateWorkload(stateCase);
      try {
        yield () => workload.run();
        workload.verify();
      } finally {
        workload.dispose();
      }
    });
  }
});
