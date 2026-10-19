// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// There is no sky in this game. The vault is a closed room, so what a camera sees past its 1.9 m
// walls is the dark the room sits in, and the only light in the frame is light a named source put
// there. `scene.background` is therefore a colour, not a photograph: swapping in a sky dome or an
// equirectangular capture is a two-line change here, and everything downstream — fog, the tone
// curve, bloom's threshold — is already reading the same palette role.
import { Color, FogExp2, type Scene } from "three";
import { HEIGHT_FOG, type HeightFogParams, heightFogDepth, heightFogNode } from "./heightFog.js";
import { palette } from "./palette.js";

/**
 * Thin enough to be felt and not seen: under 1.5% across the room's 12 m diagonal, so the far
 * corners fall away a little without the crate the player is pushing going hazy.
 */
const FOG_DENSITY = 0.005;

/** The look this fog replaced: FogExp2 at 0.005, measured at 12 m from 2 m up. */
const EYE_LEVEL = { density: FOG_DENSITY, distance: 12, cameraHeight: 2 };

/**
 * The distance term's density that, with the height term, keeps the old eye-level haze: at
 * `EYE_LEVEL.distance` along the horizon from `EYE_LEVEL.cameraHeight` the two together transmit what
 * FogExp2 at `EYE_LEVEL.density` did. The distance term is lowered, never removed, so the ground
 * still ends in fog at a kilometre.
 */
function distanceDensity(p: HeightFogParams = HEIGHT_FOG): number {
  const { distance, density, cameraHeight } = EYE_LEVEL;
  const old = (density * distance) ** 2;
  const height = heightFogDepth(p, cameraHeight, cameraHeight, distance) * Math.LN2;
  return Math.sqrt(Math.max(0, old - height)) / distance;
}

export function setupSky(scene: Scene): void {
  scene.background = new Color(palette.void);
  scene.backgroundIntensity = 1;
  // The room is the horizon, so the fog is the colour beyond it rather than a lit distance: a
  // grey fog in a room this dark would be the brightest thing in the frame.
  const distanceFog = new FogExp2(palette.void, distanceDensity());
  scene.fog = distanceFog;
  scene.fogNode = heightFogNode(distanceFog, HEIGHT_FOG);
}
