// Native entry for the `tn-engine-desktop` arm: the same run on the owned engine player, with the Fox read
// from the cooked package. `run-engine.ts` bundles it with `__TN_PLATFORM__` set to "engine-desktop".
import { createEngineFoxCrowd } from "./ladder-characters-engine.js";
import { runNative } from "./native-run.js";

void runNative(createEngineFoxCrowd);
