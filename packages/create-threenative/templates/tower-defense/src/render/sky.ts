// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// The sky photograph (`assets/sky.jpg`, Poly Haven's "Kloofendal 48d Partly Cloudy (Pure Sky)" by Greg
// Zaal and Jarod Guest, CC0) is the *environment* here, not the backdrop: it lights and reflects, and
// the diorama floats in a dark green void, so a photographed cloud never competes with the board.
// Swap the file for any equirectangular image, or delete the environment line for a fully lit-by-lamps look.
import {
  Color,
  EquirectangularReflectionMapping,
  Fog,
  SRGBColorSpace,
  type Scene,
  type Texture,
} from "three";
import { palette } from "./palette.js";

/** How much of the sky's light reaches the board. The JPEG holds radiance x 0.4; 0.7 keeps the sun, not the sky, the main light so shade reads deep (PRD-723). */
const ENVIRONMENT = 0.7;

export function setupSky(scene: Scene, sky: Texture): void {
  sky.mapping = EquirectangularReflectionMapping;
  sky.colorSpace = SRGBColorSpace;
  scene.background = new Color(palette.world.void);
  scene.environment = sky;
  scene.environmentIntensity = ENVIRONMENT;
  scene.fog = new Fog(palette.world.void, 62, 130);
}
