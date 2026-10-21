// Harness overlay (PRD-633, L3): the starter's photographed sky, with a fog that has no colour of
// its own. Unreal's exponential height fog has black inscattering and takes all of its colour from
// the sky's ambient light (Engine/Source/Runtime/Engine/Private/Components/
// ExponentialHeightFogComponent.cpp, the FogInscatteringLuminance and
// SkyAtmosphereAmbientContributionColorScale defaults; Engine/Shaders/Private/HeightFogCommon.ush,
// the sky ambient term of the inscattering). The void beyond the floor is the planet, fogged
// until opaque, so it shows that colour and nothing else.
//
// The sky itself is the atmosphere of `atmosphere.ts` baked at load in the sun's units (PRD-632:
// the sun and the sky read one illuminance), and the ambient colour is that sky's upper
// hemisphere, weighted by the cosine to the zenith, in the radiance the sky is drawn at. The
// photograph the starter ships stays as the fallback when there is no OffscreenCanvas.
import {
  CanvasTexture,
  Color,
  EquirectangularReflectionMapping,
  FogExp2,
  SRGBColorSpace,
  type Scene,
  type Texture,
  Vector3,
} from "three";
import {
  SKY_TO_SUN,
  SUN_ILLUMINANCE,
  SUN_KELVIN,
  bakeSkyRadiance,
  sunLight,
  sunTransmittance,
  temperatureColour,
} from "./atmosphere.js";
import { bakeCloudRadiance } from "./clouds.js";
import { skyRadiance } from "./giCache.js";
import { atmosphereFogColour, createGpuSky, distantFogColour } from "./gpuSky.js";
import { HEIGHT_FOG, type HeightFogParams, heightFogNode } from "./heightFog.js";

/**
 * Unreal's scale is white (SkyAtmosphereAmbientContributionColorScale). The fit that stood here
 * pulled the photograph's ambient toward Unreal's void band; the atmosphere bake needs none.
 */
/** Draw the sky with gpuSky.ts (Unreal LUT atmosphere and clouds) instead of the CPU bake. */
const GPU_SKY = true;

const AMBIENT_SCALE = new Color(1, 1, 1);

/**
 * Scene radiance that white spans in the sky texture (8-bit sRGB over 0..SKY_RANGE). The baked sky
 * peaks near 1.6 at the 60 degree sun and brighter in the aureole at low sun, which clips here.
 */
const SKY_RANGE = 4;

/** Baked sky resolution. Smooth sky, bilinear lookups: 256 x 128 is 1.4 degrees a texel. */
const SKY_WIDTH = 256;

/** Unit vector toward the photographed sun: 47.9 deg up, measured from the source HDR. */
export const SUN_DIRECTION = new Vector3(0.555, 0.742, 0.38).normalize();

/**
 * The reference level's fog, converted from Unreal's units (density and falloff are per 1000 cm,
 * so x0.1 per metre; the height is the fog actor's z, 68.5 m under the floor). Base-2 depth, as in
 * HeightFogCommon.ush. Inscattering and start distance are Unreal's defaults (black, 0).
 */
const UNREAL_FOG: HeightFogParams = {
  ...HEIGHT_FOG,
  density: 0.00436,
  heightFalloff: 0.02,
  fogHeight: -68.5,
  startDistance: 0,
};

const srgbToLinear = (v: number): number =>
  v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
const linearToSrgb = (v: number): number =>
  v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;

type Canvas = OffscreenCanvas;

function drawSky(sky: Texture, width: number, height: number): Canvas | undefined {
  const image = sky.image as CanvasImageSource & { width?: number; height?: number };
  if (typeof OffscreenCanvas === "undefined" || !image?.width || !image.height) return undefined;
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d");
  if (context === null) return undefined;
  context.imageSmoothingQuality = "high";
  context.drawImage(image, 0, 0, width, height);
  return canvas;
}

/** Cosine-weighted mean radiance of the sky's upper hemisphere, in the units it is drawn at. */
function skyAmbient(sky: Texture): Color | undefined {
  const [w, h] = [256, 128];
  const canvas = drawSky(sky, w, h);
  const pixels = canvas?.getContext("2d")?.getImageData(0, 0, w, h).data;
  if (pixels === undefined) return undefined;
  // Row 0 is the zenith unless the decode flipped the bitmap (the WebGL2 path).
  const sum = [0, 0, 0];
  let weight = 0;
  for (let y = 0; y < h / 2; y += 1) {
    const theta = ((y + 0.5) / h) * Math.PI;
    const row = Math.cos(theta) * Math.sin(theta);
    const at = sky.flipY ? y : h - 1 - y;
    for (let x = 0; x < w; x += 1) {
      for (let c = 0; c < 3; c += 1) {
        sum[c] = (sum[c] ?? 0) + srgbToLinear((pixels[(at * w + x) * 4 + c] ?? 0) / 255) * row;
      }
      weight += row;
    }
  }
  return new Color(
    ((sum[0] ?? 0) / weight) * SKY_RANGE,
    ((sum[1] ?? 0) / weight) * SKY_RANGE,
    ((sum[2] ?? 0) / weight) * SKY_RANGE,
  );
}

/**
 * The photograph with its lower hemisphere painted the fog colour, because three.js never fogs a
 * background and Unreal's void is fogged to opaque. The software fallback only: a 1.5 degree ramp
 * above the horizon stands in for the haze. The GPU sky fogs by the height fog's own opacity
 * (`skyFogOpacity` in gpuSky.ts).
 */
function voidSky(sky: Texture, fog: Color): Texture | undefined {
  const width = (sky.image as { width?: number }).width ?? 0;
  const height = (sky.image as { height?: number }).height ?? 0;
  const canvas = drawSky(sky, width, height);
  const context = canvas?.getContext("2d");
  if (canvas === undefined || context === undefined || context === null) return undefined;
  const encoded = [fog.r, fog.g, fog.b].map((v) =>
    Math.round(255 * linearToSrgb(Math.min(1, v / SKY_RANGE))),
  );
  const paint = `rgb(${encoded.join(",")})`;
  const horizon = height / 2;
  const ramp = (1.5 / 180) * height;
  const [top, bottom] = sky.flipY ? [horizon - ramp, height] : [0, horizon + ramp];
  const gradient = context.createLinearGradient(0, top, 0, bottom);
  const edge = ramp / (bottom - top);
  const clear = `rgba(${encoded.join(",")},0)`;
  if (sky.flipY) {
    gradient.addColorStop(0, clear);
    gradient.addColorStop(edge, paint);
    gradient.addColorStop(1, paint);
  } else {
    gradient.addColorStop(0, paint);
    gradient.addColorStop(1 - edge, paint);
    gradient.addColorStop(1, clear);
  }
  context.fillStyle = gradient;
  context.fillRect(0, top, width, bottom - top);
  const texture = new CanvasTexture(canvas as unknown as HTMLCanvasElement);
  texture.mapping = EquirectangularReflectionMapping;
  texture.colorSpace = SRGBColorSpace;
  texture.flipY = sky.flipY;
  return texture;
}

/** The atmosphere for the current `SUN_DIRECTION`, in scene radiance, as an 8-bit equirect canvas. */
function atmosphereSky(clouds = false): Texture | undefined {
  if (typeof OffscreenCanvas === "undefined") return undefined;
  const [w, h] = [SKY_WIDTH, SKY_WIDTH / 2];
  const radiance = bakeSkyRadiance(SUN_DIRECTION, w, h);
  const clearRadiance = { data: radiance.slice(), width: w, height: h };
  if (clouds) bakeCloudRadiance(radiance, SUN_DIRECTION, w, h);
  const tint = temperatureColour(SUN_KELVIN);
  // The world-space light cache gathers this same sky, unclipped, in the sun's units.
  const scale = [0, 1, 2].map((c) => (tint[c] ?? 1) * SUN_ILLUMINANCE * SKY_TO_SUN) as [
    number,
    number,
    number,
  ];
  skyRadiance.current = { data: radiance, width: w, height: h, scale };
  const canvas = new OffscreenCanvas(w, h);
  const context = canvas.getContext("2d");
  if (context === null) return undefined;
  const image = context.createImageData(w, h);
  for (let i = 0; i < w * h; i += 1) {
    for (let c = 0; c < 3; c += 1) {
      const value = (radiance[i * 3 + c] ?? 0) * (tint[c] ?? 1) * SUN_ILLUMINANCE * SKY_TO_SUN;
      image.data[i * 4 + c] = Math.round(255 * linearToSrgb(Math.min(1, value / SKY_RANGE)));
    }
    image.data[i * 4 + 3] = 255;
  }
  context.putImageData(image, 0, 0);
  const texture = new CanvasTexture(canvas as unknown as HTMLCanvasElement);
  texture.mapping = EquirectangularReflectionMapping;
  texture.colorSpace = SRGBColorSpace;
  texture.userData.clearRadiance = clearRadiance;
  return texture;
}

/** The sun reaches the ground through the air: its colour is the temperature tint times transmittance. */
function tintSun(): void {
  const sun = sunLight.current;
  if (sun === undefined) return;
  const tint = temperatureColour(SUN_KELVIN);
  const through = sunTransmittance(Math.asin(Math.min(1, Math.max(-1, SUN_DIRECTION.y))));
  sun.color.setRGB(
    (tint[0] ?? 1) * through[0],
    (tint[1] ?? 1) * through[1],
    (tint[2] ?? 1) * through[2],
  );
}

/**
 * `fogged` false (Unreal's layers below L3) keeps the sky as it is: with no fog, Unreal's void
 * below the horizon is dark, not the fog band.
 */
export function setupSky(
  scene: Scene,
  photo: Texture,
  software = false,
  fogged = true,
  clouds = false,
): void {
  // The GPU sky needs TSL acos/tan/ceil on the Wasm engine; off until the engine math lands.
  const gpu =
    software || !GPU_SKY
      ? undefined
      : createGpuSky(scene, SUN_DIRECTION, fogged, clouds, UNREAL_FOG);
  const sky = gpu?.environment ?? atmosphereSky(clouds) ?? photo;
  tintSun();
  sky.mapping = EquirectangularReflectionMapping;
  sky.colorSpace = SRGBColorSpace;
  const ambient = sky.userData.clearRadiance
    ? gpu
      ? distantFogColour(SUN_DIRECTION)
      : atmosphereFogColour(sky.userData.clearRadiance)
    : skyAmbient(sky);
  const fogColor = (ambient ?? new Color(0xacb1c1)).multiply(AMBIENT_SCALE);
  scene.background = (ambient === undefined || !fogged ? undefined : voidSky(sky, fogColor)) ?? sky;
  scene.backgroundNode = gpu?.node.backgroundNode ?? null;
  scene.backgroundIntensity = gpu === undefined ? SKY_RANGE : 1;
  // The environment keeps the unpainted photograph: the light from below is the sky's, not the fog's.
  if (!software) {
    scene.environment = sky;
    scene.environmentIntensity = SKY_RANGE;
  }
  // Height fog only: FogExp2 stays as the colour holder `heightFogNode` reads, at zero density.
  const fog = new FogExp2(fogColor, 0);
  scene.fog = fog;
  scene.fogNode = heightFogNode(fog, { ...UNREAL_FOG }, SUN_DIRECTION);
}
