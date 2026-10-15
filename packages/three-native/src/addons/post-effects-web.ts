/**
 * The browser entry for three/addons/tsl/display's GTAO, Denoise, SMAA and Bloom under
 * `engine: "native"` (PRD-540): the shared post effects over the Wasm engine's TSL functions, which
 * the web engine module hands over as `__tnTsl` beside three's own exports.
 */
// quality-allow: the symbol exists only in the web engine module the bundler resolves "three/tsl" to, so no declaration can type it.
// @ts-expect-error -- `__tnTsl` exists only in the web engine module "three/tsl" resolves to.
import { __tnTsl } from "three/tsl";
import { type IEffectTsl, definePostEffects } from "./post-effects.js";

export const { ao, denoise, smaa, bloom, traa, film, lut3D } = definePostEffects(
  __tnTsl as IEffectTsl,
);
