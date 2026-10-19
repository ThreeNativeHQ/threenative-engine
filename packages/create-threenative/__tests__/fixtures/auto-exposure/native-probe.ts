import { PLAYTEST_CLOCK_GLOBAL } from "../../../../core/dist/playtest.js";
import { createExposureFixture } from "./game.js";
Reflect.deleteProperty(globalThis, PLAYTEST_CLOCK_GLOBAL);
export default createExposureFixture({
  enabled: true,
  bright: true,
  stops: 11,
  snapGain: 0,
  deterministic: true,
  nativeValidation: true,
});
