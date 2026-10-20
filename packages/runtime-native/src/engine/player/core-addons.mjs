// three/addons/tsl/display's GTAO, Denoise, SMAA and Bloom as the engine's live effects, shared with
// the Wasm back end (three-native/src/addons/post-effects.ts). Each returns the effect's node; its
// scalar uniforms read and write the native effect (`ao(...).radius.value`).
import { unsupportedExport } from "../../../../three-native/src/refused.ts";
import { definePostEffects } from "../../../../three-native/src/addons/post-effects.ts";
import { defineScreenSpaceReflections } from "../../../../three-native/src/addons/screen-space.ts";

export const { ao, denoise, smaa, bloom, traa, film, lut3D } = definePostEffects(globalThis.tsl);

// Screen-space reflections: authored over the engine TSL, shared with the Wasm back end.
export const ssr = defineScreenSpaceReflections(globalThis.tsl);

// The other display nodes need live addon-node construction and update scheduling, which the native
// renderer lacks (it consumes cooked post graphs). They stay importable and refuse at use, by name.
export const fxaa = unsupportedExport("fxaa");
export const godrays = unsupportedExport("godrays");
export const ssgi = unsupportedExport("ssgi");
export const sharpen = unsupportedExport("sharpen");
