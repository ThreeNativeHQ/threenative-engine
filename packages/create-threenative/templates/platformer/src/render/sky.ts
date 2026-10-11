// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// A vertical blue gradient supplies the background; a measured environment supplies the light.
// The background's lower hemisphere matches skyFloor around the floating route.
import {
  BackSide,
  Color,
  DataTexture,
  DataUtils,
  EquirectangularReflectionMapping,
  Float32BufferAttribute,
  FogExp2,
  HalfFloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  Mesh,
  MeshBasicMaterial,
  RGBAFormat,
  SRGBColorSpace,
  type Scene,
  SphereGeometry,
  type Texture,
  UnsignedByteType,
  Vector3,
} from "three";
import { HEIGHT_FOG, type HeightFogParams, heightFogDepth, heightFogNode } from "./heightFog.js";
import { palette } from "./palette.js";

/** Unit vector toward the authored sun, 47.9° above the horizon. */
export const SUN_DIRECTION = new Vector3(0.555, 0.742, 0.38).normalize();

/** The look this fog replaced: FogExp2 at 0.003, measured at 150 m from 2 m up. */
const EYE_LEVEL = { density: 0.003, distance: 150, cameraHeight: 2 };

/** Lower distance density so distance + height fog preserve the kit's old eye-level haze. */
function distanceDensity(p: HeightFogParams = HEIGHT_FOG): number {
  const { distance, density, cameraHeight } = EYE_LEVEL;
  const old = (density * distance) ** 2;
  const height = heightFogDepth(p, cameraHeight, cameraHeight, distance) * Math.LN2;
  return Math.sqrt(Math.max(0, old - height)) / distance;
}

function gradientColor(row: number, height: number): Color {
  const high = new Color(palette.skyHigh);
  const mid = new Color(palette.skyLow);
  const horizon = new Color(palette.horizon);
  const deep = high.clone().lerp(horizon, 0.45);
  // DataTexture rows start at v=0 (nadir); equirectangular v=0.5 is the horizon.
  const elevation = Math.sin((row / (height - 1) - 0.5) * Math.PI);
  return elevation < 0
    ? horizon.clone().lerp(deep, Math.min(1, -elevation / 0.6))
    : elevation < 0.5
      ? horizon.clone().lerp(mid, elevation * 2)
      : mid.clone().lerp(high, (elevation - 0.5) * 2);
}

/** sRGB equirectangular radiance, from the lower haze through the horizon to the zenith. */
export function skyTexture(): DataTexture {
  // three's PMREM sizes its cube from width / 4, needing at least 16: keep width >= 64.
  const width = 256;
  const height = 128;
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const encoded = gradientColor(row, height).convertLinearToSRGB();
    for (let column = 0; column < width; column += 1) {
      data.set(
        [...encoded.toArray().map((value) => Math.round(value * 255)), 255],
        (row * width + column) * 4,
      );
    }
  }
  const sky = new DataTexture(data, width, height, RGBAFormat, UnsignedByteType);
  sky.mapping = EquirectangularReflectionMapping;
  sky.colorSpace = SRGBColorSpace;
  sky.magFilter = LinearFilter;
  sky.minFilter = LinearFilter;
  sky.needsUpdate = true;
  return sky;
}

// Measured from the photographed sky this kit used to light with, preserving its tuned lighting
// when the background became a stylized gradient; edit these fills to relight.
const UPPER_FILL = new Color(0.355, 0.423, 0.627);
const LOWER_FILL = new Color(0.68, 0.67, 0.633);
export function skyEnvironment(): DataTexture {
  const width = 256;
  const height = 128;
  const data = new Uint16Array(width * height * 4);
  const upperMean = new Color(0, 0, 0);
  let weights = 0;
  for (let row = height / 2; row < height; row += 1) {
    const elevation = (row / (height - 1) - 0.5) * Math.PI;
    const weight = Math.abs(Math.cos(elevation));
    upperMean.add(gradientColor(row, height).multiplyScalar(weight));
    weights += weight;
  }
  upperMean.multiplyScalar(1 / weights);
  const scale = new Color(
    UPPER_FILL.r / upperMean.r,
    UPPER_FILL.g / upperMean.g,
    UPPER_FILL.b / upperMean.b,
  );
  for (let row = 0; row < height; row += 1) {
    const color = row < height / 2 ? LOWER_FILL : gradientColor(row, height).multiply(scale);
    const rgba = [color.r, color.g, color.b, 1].map(DataUtils.toHalfFloat);
    for (let column = 0; column < width; column += 1) {
      data.set(rgba, (row * width + column) * 4);
    }
  }
  const environment = new DataTexture(data, width, height, RGBAFormat, HalfFloatType);
  environment.colorSpace = LinearSRGBColorSpace;
  environment.mapping = EquirectangularReflectionMapping;
  environment.minFilter = LinearFilter;
  environment.magFilter = LinearFilter;
  environment.needsUpdate = true;
  return environment;
}

export function setupSky(scene: Scene, sky: Texture, environment: Texture = sky): void {
  sky.mapping = EquirectangularReflectionMapping;
  scene.background = sky;
  scene.backgroundIntensity = 1;
  // three prefilters an equirectangular `scene.environment` itself (PMREM), on WebGPU and WebGL.
  // The measured fill lights faces the sun misses and supplies reflections as roughness drops.
  scene.environment = environment;
  scene.environmentIntensity = 1;
  // Thin distance fog retains the far cutoff; fogNode adds the height term.
  const distanceFog = new FogExp2(palette.horizon, distanceDensity());
  scene.fog = distanceFog;
  scene.fogNode = heightFogNode(distanceFog, HEIGHT_FOG, SUN_DIRECTION);
}

/** Inside the camera's far plane by the diagonal of the mesh's bounding box (1.73 R). */
const FLOOR_RADIUS = 480;
/** Radians the floor climbs above the horizon before it has faded out. */
const RISE = 0.35;
/** Lower sky fades into horizon haze 20° above the route; unfogged, with no depth writes. */
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

/** Static cloud lobes for the scene to instance as one draw; only the airship and fox move. */
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
