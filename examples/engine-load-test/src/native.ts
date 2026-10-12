// Native entry for the PRD-117 ThreeNative desktop/device arms on the legacy host: the shared run with the
// Fox decoded by `GLTFLoader`.
import { createFoxCrowd } from "./ladder-characters.js";
import { runNative } from "./native-run.js";

void runNative(createFoxCrowd);
