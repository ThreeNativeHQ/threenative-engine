/**
 * The browser entry for three/addons/tsl/display's GTAO, Denoise, SMAA and Bloom (and the refused rest) under
 * `engine: "threenative"` (PRD-540): the shared post effects over the Wasm engine's TSL functions, which
 * the web engine module hands over as `__tnTsl` beside three's own exports.
 */
// quality-allow: the symbol exists only in the web engine module the bundler resolves "three/tsl" to, so no declaration can type it.
// @ts-expect-error -- `__tnTsl` exists only in the web engine module "three/tsl" resolves to.
import { __tnTsl } from "three/tsl";
import { unsupportedExport } from "../refused.js";
import { type IEffectTsl, definePostEffects } from "./post-effects.js";
import {
  type IScreenSpaceTsl,
  defineScreenSpaceGi,
  defineScreenSpaceReflections,
} from "./screen-space.js";

export const { ao, denoise, smaa, bloom, traa, film, lut3D } = definePostEffects(
  __tnTsl as IEffectTsl,
);

// Screen-space reflections are authored over the engine TSL (screen-space.ts), not three's SSRNode.
export const ssr = defineScreenSpaceReflections(__tnTsl as IScreenSpaceTsl);
// Screen-space diffuse GI, the same way (three's SSGINode runs `Fn(...).setLayout(...)` at import).
export const ssgi = defineScreenSpaceGi(__tnTsl as IScreenSpaceTsl);

// The other display nodes need live addon-node construction the engine lacks: importable, and they
// refuse at use by name (as core-addons.mjs on the V8 player).
export const fxaa = unsupportedExport("fxaa");
export const godrays = unsupportedExport("godrays");
export const sharpen = unsupportedExport("sharpen");
