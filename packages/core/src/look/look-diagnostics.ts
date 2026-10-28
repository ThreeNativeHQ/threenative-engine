import type { GIVisualizeMode } from "../render/gi-visualize.js";

/**
 * Diagnosis knobs of the calibration harness, kept out of the engine's own reading of the page URL: the harness sets
 * them before it builds a `WorldEnvironment`, and a game never needs to. The defaults are the shipped look.
 */
export const lookDiagnostics: {
  /** The harness ladder layer, 0 to 9 (9 is everything on): below 7 the SSGI gather is off, below 8 so are the reflections. */
  layer: number;
  /** Brings back the antialias stage that squeezed alpha with the colour, for the BEFORE arm of the glint proof. */
  aaAlphaSqueezed: boolean;
  /** Runs N denoise passes over the SSGI gather at any layer, for an A/B against the tier's count. */
  denoisePasses: number | undefined;
  /** Turns on the film curve's 43.7 channel clip (off by default), the ON arm of a paired capture. */
  lutClipOn: boolean;
  /** Draws one GI term alone (PRD-646); needs the gather, so it applies at layer 7 and above. */
  giVisualize: GIVisualizeMode;
} = {
  layer: 9,
  aaAlphaSqueezed: false,
  denoisePasses: undefined,
  lutClipOn: false,
  giVisualize: "off",
};
