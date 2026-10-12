/**
 * The browser entry for three/addons/tsl/display's GTAO, Denoise, SMAA and Bloom under
 * `engine: "native"` (PRD-540): the shared post effects over the Wasm engine's TSL functions, which
 * the web engine module hands over as `__tnTsl` beside three's own exports.
 */
// @ts-expect-error -- `__tnTsl` exists only in the web engine module "three/tsl" resolves to.
import { __tnTsl } from "three/tsl";
import { type IEffectTsl, definePostEffects } from "./post-effects.js";

export const { ao, denoise, smaa, bloom } = definePostEffects(__tnTsl as IEffectTsl);
