import type { ESLint } from "eslint";
import { hotCallbackAllocation } from "./hotCallbackAllocation.js";
import { hotCallbackResourceCreation } from "./rules/hotCallbackResourceCreation.js";
import { hotCallbackSceneWork } from "./rules/hotCallbackSceneWork.js";
import { noNativeIncompatibleThree } from "./rules/noNativeIncompatibleThree.js";
import { noRawModelAdd } from "./rules/noRawModelAdd.js";
import { noUnstableUiSelector } from "./rules/noUnstableUiSelector.js";
import { noUnusedAssets } from "./rules/noUnusedAssets.js";
import { startupOverrideReason } from "./rules/startupOverrideReason.js";
import { uiStateSelector } from "./rules/uiStateSelector.js";

/** The ThreeNative ESLint plugin: every rule that catches a game-side mistake the engine cannot
 * decide for the author. Registered as `threenative` by `qualityConfig`. */
export const threenativePlugin: ESLint.Plugin = {
  rules: {
    "hot-callback-allocation": hotCallbackAllocation,
    "hot-callback-resource-creation": hotCallbackResourceCreation,
    "hot-callback-scene-work": hotCallbackSceneWork,
    "no-native-incompatible-three": noNativeIncompatibleThree,
    "no-raw-model-add": noRawModelAdd,
    "no-unstable-ui-selector": noUnstableUiSelector,
    "no-unused-assets": noUnusedAssets,
    "startup-override-reason": startupOverrideReason,
    "ui-state-selector": uiStateSelector,
  },
};
