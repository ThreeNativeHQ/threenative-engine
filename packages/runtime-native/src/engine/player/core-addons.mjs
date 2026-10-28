// three/addons/tsl/display's GTAO, Denoise, SMAA and Bloom as the engine's live effects, shared with
// the Wasm back end (three-native/src/addons/post-effects.ts). Each returns the effect's node; its
// scalar uniforms read and write the native effect (`ao(...).radius.value`).
import { unsupportedExport } from "../../../../three-native/src/refused.ts";
import { definePostEffects } from "../../../../three-native/src/addons/post-effects.ts";
import { defineScreenSpaceGi } from "../../../../three-native/src/addons/screen-space.ts";
import { rtt, uniform } from "./core-tsl.mjs";

// SSR uses the engine's native SSRNode port (post_effects.cpp, PRD-652); the Wasm browser
// exports its separate screen-space.ts implementation.
export const { ao, ssr, denoise, smaa, bloom, traa, film, lut3D } = definePostEffects(globalThis.tsl);
// Screen-space diffuse GI: authored over the engine TSL, shared with the Wasm back end.
export const ssgi = defineScreenSpaceGi({ ...globalThis.tsl, rtt, uniform });

// The other display nodes need live addon-node construction and update scheduling, which the native
// renderer lacks (it consumes cooked post graphs). They stay importable and refuse at use, by name.
export const fxaa = unsupportedExport("fxaa");
export const godrays = unsupportedExport("godrays");
export const sharpen = unsupportedExport("sharpen");
