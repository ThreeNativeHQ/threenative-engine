// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// The sky is a photograph: `assets/sky.jpg`, Poly Haven's "Kloofendal 48d Partly Cloudy (Pure Sky)"
// by Greg Zaal and Jarod Guest, CC0 (https://polyhaven.com/a/kloofendal_48d_partly_cloudy_puresky).
// The same image is the background, the environment light every surface reflects and is filled by,
// and — through `SUN_DIRECTION` — the direction the sun's shadows fall. Swap the file for any
// equirectangular sky and re-aim `SUN_DIRECTION` at its sun.
import {
  BackSide,
  Color,
  EquirectangularReflectionMapping,
  Float32BufferAttribute,
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

/** Unit vector toward the photographed sun: 47.9° up, measured from the source HDR. */
export const SUN_DIRECTION = new Vector3(0.555, 0.742, 0.38).normalize();

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

export function setupSky(scene: Scene, sky: Texture): void {
  sky.mapping = EquirectangularReflectionMapping;
  sky.colorSpace = SRGBColorSpace;
  scene.background = sky;
  scene.backgroundIntensity = SKY_RANGE;
  // three prefilters an equirectangular `scene.environment` itself (PMREM), on WebGPU and WebGL.
  // It is what makes a standard material read as a material: sky-blue fill on faces the sun
  // misses, and a sky to reflect, sharper as roughness drops.
  scene.environment = sky;
  scene.environmentIntensity = SKY_RANGE;
  // The route runs to x=97 with the backdrop cliffs another 60 m behind them, so this is thin on
  // purpose: at this density it is under 2% inside the playfield and only reads past the castle.
  // `scene.fog` stays the distance term; `scene.fogNode` is what three applies and adds the height term.
  const distanceFog = new FogExp2(palette.horizon, distanceDensity());
  scene.fog = distanceFog;
  scene.fogNode = heightFogNode(distanceFog, HEIGHT_FOG, SUN_DIRECTION);
}

/**
 * Inside the camera's far plane by a bounding box's diagonal: the playtest's `cameraClearsScene`
 * measures a mesh by its box, and a box of half-width R reaches 1.73 R.
 */
const FLOOR_RADIUS = 480;

/** Radians the floor climbs above the horizon before it has faded out. */
const RISE = 0.35;

/**
 * What the world floats in. A photographed sky ends in a flat grey ground disc, and the route has no
 * ground: everything under the horizon was a white void the fog could not hide. This is the lower
 * hemisphere, from the fog colour at the horizon to a deeper sky blue straight down, so distant
 * rock fades into it exactly as it fades into the fog. It climbs 20 degrees past the horizon and
 * fades out there, so the photograph melts into the haze instead of meeting it at a hard line.
 * It is not fogged and never writes depth.
 */
export function skyFloor(): Mesh {
  const geometry = new SphereGeometry(
    FLOOR_RADIUS,
    32,
    16,
    0,
    Math.PI * 2,
    Math.PI / 2 - RISE,
    Math.PI / 2 + RISE,
  );
  const horizon = new Color(palette.horizon);
  const deep = new Color(palette.skyHigh).lerp(horizon, 0.45);
  const position = geometry.getAttribute("position");
  const colors: number[] = [];
  for (let i = 0; i < position.count; i += 1) {
    const elevation = position.getY(i) / FLOOR_RADIUS;
    const c = horizon.clone().lerp(deep, Math.min(1, Math.max(0, -elevation) / 0.6));
    colors.push(c.r, c.g, c.b, elevation <= 0 ? 1 : Math.max(0, 1 - elevation / Math.sin(RISE)));
  }
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 4));
  const floor = new Mesh(
    geometry,
    new MeshBasicMaterial({
      depthWrite: false,
      fog: false,
      side: BackSide,
      transparent: true,
      vertexColors: true,
    }),
  );
  floor.name = "sky-floor";
  floor.renderOrder = -1;
  floor.frustumCulled = false;
  return floor;
}

/**
 * The cloud bank, as a list of lobes to instance.
 *
 * Eighteen clouds of five to nine squashed lobes is 130-odd separate spheres, and a photograph sky
 * is a static one — so the scene builds one `InstancedBatch` of a unit sphere from this and never
 * touches it again. The motion in the sky is the airship in `scenery.ts`, which crosses the frame
 * in twenty seconds, and the parallax of a fox covering ninety-seven metres.
 *
 * This is data, not objects, so the batching stays the scene's decision: `src/render/` is ordinary
 * Three.js and never reaches back into the framework.
 */
export function cloudLobes(
  rng: () => number,
): { position: [number, number, number]; scale: [number, number, number] }[] {
  const lobes: { position: [number, number, number]; scale: [number, number, number] }[] = [];
  for (let cloud = 0; cloud < 18; cloud += 1) {
    const scale = 4 + rng() * 6;
    const count = 5 + Math.floor(rng() * 4);
    const cx = -140 + rng() * 420;
    const cy = 16 + rng() * 46;
    const cz = -70 - rng() * 200;
    for (let lobe = 0; lobe < count; lobe += 1) {
      const r = (0.6 + rng() * 0.7) * scale;
      lobes.push({
        position: [
          cx + (lobe - count / 2) * scale * 0.75 + (rng() - 0.5) * scale * 0.4,
          cy + (rng() - 0.4) * scale * 0.35,
          cz + (rng() - 0.5) * scale * 0.5,
        ],
        scale: [r, r * 0.72, r],
      });
    }
  }
  return lobes;
}
