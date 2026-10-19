// Generated for you. The sky is game-owned source, not an engine preset.
//
// The storm's sky is drawn by the cloud pass (`clouds.ts`) and the haze the coast fades into is
// drawn by the world pass (`world.ts`); this file decides both colours. The deck's own lighting —
// the sun's direction — is `lighting.ts`.
import { Color, type Scene } from "three";
import * as clouds from "./clouds-shader.js";
import { palette } from "./palette.js";
import * as world from "./world-shader.js";

/** The clear sky behind the deck, near the horizon and overhead: linear RGB, the study's own. */
const SKY_LOW = new Color(0.22, 0.3, 0.355);
const SKY_HIGH = new Color(0.055, 0.1, 0.17);

/**
 * Writes the sky and haze colours into both passes. Run once, before the first frame. The world
 * quad covers every pixel, so `scene.background` is never seen; it is set to the horizon anyway so
 * a frame that lost the quad still reads as this storm's haze rather than as black.
 */
export function setupSky(scene: Scene): void {
  const horizon = new Color(palette.horizon);
  scene.background = horizon.clone();
  const zenith = new Color(palette.zenith);
  world.uHazeLow.value.set(horizon.r, horizon.g, horizon.b);
  world.uHazeHigh.value.set(zenith.r, zenith.g, zenith.b);
  clouds.uSkyLow.value.set(SKY_LOW.r, SKY_LOW.g, SKY_LOW.b);
  clouds.uSkyHigh.value.set(SKY_HIGH.r, SKY_HIGH.g, SKY_HIGH.b);
}
