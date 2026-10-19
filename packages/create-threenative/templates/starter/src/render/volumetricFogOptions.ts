// The contract this medium accepts. Everything here is checked before a graph, a target or a
// material exists, so a rejected request costs nothing and names itself in the error.
import type { Box3, Color, DirectionalLight, PerspectiveCamera, PointLight } from "three";

export interface IFogVolume {
  bounds: Box3;
  /** Extinction per metre at/below baseHeight, independent of light intensity. */
  density: number;
  baseHeight: number;
  heightFalloff: number;
}
export interface IVolumetricFogOptions {
  enabled: boolean;
  /** The live renderer's backend, `renderer.kind`. Anything but `webgpu` allocates nothing. */
  renderer: string;
  /** Explicit unqualified budget, 8–128. No automatic tier admission before measurements. */
  steps: number;
  resolutionScale: number;
  volumes: IFogVolume[];
  albedo: Color;
  ambient: Color;
  anisotropy: number;
  /**
   * A shadow-casting `DirectionalLight` whose `shadow.map` is already initialized — there is no
   * other shadow source this graph can read, and none is created for it.
   */
  sun?: DirectionalLight;
  /** At most four unshadowed finite-range PointLights; spot/cube shadows are excluded. */
  points?: PointLight[];
  logarithmicDepth?: boolean;
  reversedDepth?: boolean;
  /**
   * What else is already drawing the same air. Both false is the only qualified answer: the
   * medium takes `scene.fog` over while it lives and puts it back on disposal, so only aerial
   * perspective and god rays have to stay off — either would add its contribution a second time.
   */
  environment: { aerialPerspective: boolean; godRays: boolean };
}
function finite(name: string, value: number, low: number, high = Number.POSITIVE_INFINITY): void {
  if (!Number.isFinite(value) || value < low || value > high)
    throw new Error(`volumetricFog: ${name} must be finite in [${low}, ${high}].`);
}
function validateVolumes(volumes: IFogVolume[]): void {
  if (volumes.length > 8) throw new Error("volumetricFog: at most eight bounds.");
  for (const volume of volumes) {
    finite("density", volume.density, 0);
    finite("heightFalloff", volume.heightFalloff, 0);
    finite("baseHeight", volume.baseHeight, Number.NEGATIVE_INFINITY);
    const { min: low, max: high } = volume.bounds;
    if (
      ![...low, ...high].every(Number.isFinite) ||
      low.x >= high.x ||
      low.y >= high.y ||
      low.z >= high.z
    )
      throw new Error("volumetricFog: bounds need finite positive extent.");
  }
}
export function validateFogOptions(
  camera: PerspectiveCamera,
  options: IVolumetricFogOptions,
): void {
  if (!camera.isPerspectiveCamera) throw new Error("volumetricFog: perspective camera required.");
  if (options.logarithmicDepth || options.reversedDepth)
    throw new Error("volumetricFog: only ordinary perspective depth is qualified for this graph.");
  finite("steps", options.steps, 8, 128);
  if (!Number.isInteger(options.steps)) throw new Error("volumetricFog: steps must be integer.");
  if (options.resolutionScale !== 1 && options.resolutionScale !== 0.5)
    throw new Error("volumetricFog: resolutionScale must be 1 or 0.5.");
  finite("anisotropy", options.anisotropy, -0.9, 0.9);
  validateVolumes(options.volumes);
  for (const channel of options.albedo.toArray()) finite("albedo", channel, 0, 1);
  for (const channel of options.ambient.toArray()) finite("ambient", channel, 0);
  if (options.environment.aerialPerspective || options.environment.godRays)
    throw new Error(
      "volumetricFog: aerial perspective and god rays must be off — this graph renders the same medium.",
    );
  const sun = options.sun;
  if (
    sun !== undefined &&
    (!sun.castShadow || sun.shadow.map?.depthTexture == null || sun.shadow.shadowNode != null)
  )
    throw new Error("volumetricFog: sun needs an initialized ordinary directional shadow map.");
  const points = options.points ?? [];
  if (points.length > 4) throw new Error("volumetricFog: at most four local lights.");
  for (const point of points) {
    if (
      !point.isPointLight ||
      point.castShadow ||
      !Number.isFinite(point.distance) ||
      point.distance <= 0
    )
      throw new Error("volumetricFog: local lights must be unshadowed finite-range PointLights.");
    finite("point decay", point.decay, 0, 4);
  }
}
