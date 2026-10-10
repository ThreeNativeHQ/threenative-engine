// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// The sky is a photograph: `assets/sky.jpg`, Poly Haven's "Kloofendal 48d Partly Cloudy (Pure Sky)"
// by Greg Zaal and Jarod Guest, CC0 (https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky).
// The same image is the background, the environment light every surface is filled by, and — through
// `SUN_DIRECTION` — the direction the sun's shadows fall. Swap the file for any equirectangular sky
// and re-aim `SUN_DIRECTION` at its sun.
import {
  BackSide,
  EquirectangularReflectionMapping,
  Euler,
  FogExp2,
  Mesh,
  MeshBasicMaterial,
  SRGBColorSpace,
  type Scene,
  SphereGeometry,
  type Texture,
  Vector3,
} from "three";
import { HEIGHT_FOG, type HeightFogParams, heightFogDepth, heightFogNode } from "./heightFog.js";
import { palette } from "./palette.js";

/**
 * How the JPEG was made from the 4k HDR: linear radiance × 0.4, clipped, sRGB-encoded — so white
 * in the file is 2.5 in the sky. Multiplying back restores the HDR brightness of the clouds; the sun
 * disk itself is clipped, which is why the sun is a light (`lighting.ts`) and not a texel.
 */
const SKY_RANGE = 2.5;

/**
 * How much of that sky **lights** the scene, as a fraction of how brightly it is drawn.
 *
 * Not the same number, and the reason is the file itself. Half of `sky.jpg` is a flat grey
 * `0x8f8e8a`: the lower hemisphere of a "pure sky" panorama is a placeholder, not a sky, and at
 * `SKY_RANGE` it arrives as a 0.7-radiance grey dome under the model's feet. On a scene that is
 * two thirds sky it is invisible. On a sea it is the largest single term in every surface's light
 * budget — the timber, the canvas and the water all came back a stop and a half paler than they
 * were authored, and the whole frame read as haze. So the sky is *drawn* at full range and *lights*
 * at this one, which is a decision this game makes about its own scene.
 */
const FILL_RANGE = 0.9;

/**
 * How far out the dome stands, in metres. Inside `camera.far` (8 km) and far enough that the sea's
 * own disc — which reaches 6 km — never pokes through it.
 */
const SKY_RADIUS = 7_000;

/** Unit vector toward the photographed sun, read off the file: 47.9° up. */
const SUN_IN_PHOTO = new Vector3(0.555, 0.742, 0.38);

/**
 * Where this game hangs the photograph, in radians about world up.
 *
 * A panorama is a whole sky and a game may put any part of it overhead, so the photograph is
 * *placed* rather than inherited: the sun is swung round to stand fifty-five degrees off the
 * starboard bow, which is where the camera looks when the ship leaves the buoy. Untouched, the
 * sun sat behind the player's shoulder — a fine place for a sun and the worst one in the frame,
 * because every frame then looks away from the light and the sea has nothing to sparkle with.
 */
export const SKY_YAW = 1.2;

/** Unit vector toward the sun as the game placed the photograph. `lighting.ts` lights from it. */
export const SUN_DIRECTION = SUN_IN_PHOTO.clone().applyAxisAngle(new Vector3(0, 1, 0), SKY_YAW);

let sky: Texture | undefined;

/**
 * Fetch the photograph. Called from a scene's `load()`, which is the one place a game is allowed
 * to wait, and kept out of `setupSky` so that entering a scene stays synchronous — a playtest
 * runner reads the registry the instant a scene's `enter()` returns.
 *
 * Takes the loader by shape rather than by type so this file keeps no framework import.
 */
export async function loadSky(assets: { texture(path: string): Promise<Texture> }): Promise<void> {
  sky = await assets.texture("sky.jpg");
}

/** The look this fog replaced: FogExp2 at 0.003, measured at 150 m from 2 m up. */
const EYE_LEVEL = { density: 0.003, distance: 150, cameraHeight: 2 };

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

export function setupSky(scene: Scene, options: { readonly software?: boolean } = {}): void {
  if (sky === undefined) throw new Error("setupSky must run after loadSky.");
  sky.mapping = EquirectangularReflectionMapping;
  sky.colorSpace = SRGBColorSpace;
  // The photograph is a **dome**, not `scene.background`, and that is the single change that fixes
  // the sea.
  //
  // `scene.background` is drawn by every camera the renderer has, including the half-res mirrored
  // pass the water samples. So every cumulus in the photograph was reflected crisply across six
  // kilometres of sea, which is the whole of the owner's complaint: a partly-cloudy sky in a
  // planar mirror is a lake. A dome is an ordinary object on an ordinary layer, so putting it on
  // layer 0 alone keeps it out of that pass, and what the mirror then holds is the hull, the marks
  // and the headland — the silhouettes a player reads in the water, which no prefiltered
  // environment can supply. The sky's own reflection is the material's image-based specular, read
  // from `scene.environment` at the water's own roughness: rough, blurred and Fresnel-weighted.
  const dome = new Mesh(
    new SphereGeometry(SKY_RADIUS, 32, 20),
    new MeshBasicMaterial({ fog: false, map: sky, side: BackSide }),
  );
  // The same 2.5 the photograph used to be drawn at as `scene.backgroundIntensity`, carried as a
  // colour multiplier because that is how a basic material expresses a range above one.
  (dome.material as MeshBasicMaterial).color.setScalar(SKY_RANGE);
  // Placed the way `scene.backgroundRotation` placed the photograph, about world up.
  dome.rotation.y = SKY_YAW;
  dome.name = "sky-dome";
  // Inside the camera's far plane, which is 8 km — a dome further out than that is a cut edge with
  // the void showing above it, which is the same defect as a sea that ends inside the haze.
  dome.frustumCulled = false;
  scene.add(dome);
  scene.background = null;
  scene.backgroundIntensity = SKY_RANGE;
  scene.backgroundRotation = new Euler(0, SKY_YAW, 0);
  // three prefilters an equirectangular `scene.environment` itself (PMREM), on WebGPU and WebGL.
  // It is what makes a standard material read as a material: sky-blue fill on every face the sun
  // misses, a sky to reflect — sharper as roughness drops — and, for the sea, the rough blurred
  // reflection the dome cannot provide.
  //
  // Not on a software adapter. PMREM-filtering this photograph keeps a CPU rasteriser's GPU process
  // busy past its watchdog, the sea's pipeline compile queues behind it, and the device is lost
  // before the first frame (measured on four cores: 29 pipelines compile and the run passes with
  // it off, the sea pipeline dies after 25 s with it on). That lane is not render evidence, so it
  // gives up the fill light and keeps every assertion.
  if (options.software !== true) {
    scene.environment = sky;
    scene.environmentIntensity = FILL_RANGE;
    scene.environmentRotation = new Euler(0, SKY_YAW, 0);
  }
  // Open sea, so the far water is nearly all haze. At 0.003 the sea is half gone by 300 m and gone
  // by a kilometre, and the colour it goes to is the photograph's own horizon measured off this
  // file — which is why the water and the sky meet in one line instead of in a seam.
  // `scene.fog` stays the distance term; `scene.fogNode` is what three applies and adds the height term.
  const distanceFog = new FogExp2(palette.skyLow, distanceDensity());
  scene.fog = distanceFog;
  scene.fogNode = heightFogNode(distanceFog, HEIGHT_FOG, SUN_DIRECTION);
}
