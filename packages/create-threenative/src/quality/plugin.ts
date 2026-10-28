import type { ESLint } from "eslint";
import { hotCallbackAllocation } from "./hotCallbackAllocation.js";
import { hotCallbackResourceCreation } from "./rules/hotCallbackResourceCreation.js";
import { hotCallbackSceneWork } from "./rules/hotCallbackSceneWork.js";
import { startupOverrideReason } from "./rules/startupOverrideReason.js";
import { uiStateSelector } from "./rules/uiStateSelector.js";

/** The ThreeNative ESLint plugin: every rule that catches a game-side mistake the engine cannot
 * decide for the author. Registered as `threenative` by `qualityConfig`. */
export const threenativePlugin: ESLint.Plugin = {
  rules: {
    "hot-callback-allocation": hotCallbackAllocation,
    "hot-callback-resource-creation": hotCallbackResourceCreation,
    "hot-callback-scene-work": hotCallbackSceneWork,
    "startup-override-reason": startupOverrideReason,
    "ui-state-selector": uiStateSelector,
  },
};
