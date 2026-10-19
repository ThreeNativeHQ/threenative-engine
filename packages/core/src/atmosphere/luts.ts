import { ClampToEdgeWrapping, HalfFloatType, LinearFilter, RGBAFormat } from "three";
import {
  Fn,
  exp,
  float,
  instanceIndex,
  texture,
  textureStore,
  uniform,
  uvec2,
  vec2,
  vec4,
} from "three/tsl";
import { StorageTexture } from "three/webgpu";
import type { ComputeNode, Node, TextureNode, UniformNode } from "three/webgpu";
import {
  type IAtmosphereParameters,
  type IResolvedAtmosphereParameters,
  resolveAtmosphereParameters,
} from "./params.js";

export interface IAtmosphereLutResolution {
  readonly width: number;
  readonly height: number;
}

export interface IAtmosphereLutResolutions {
  readonly transmittance: IAtmosphereLutResolution;
  readonly multiScattering: IAtmosphereLutResolution;
  readonly skyView: IAtmosphereLutResolution;
}

/** The reference dimensions; games may provide smaller dimensions when their startup budget says so. */
export const ATMOSPHERE_LUT_RESOLUTIONS: IAtmosphereLutResolutions = {
  multiScattering: { height: 32, width: 32 },
  skyView: { height: 108, width: 192 },
  transmittance: { height: 64, width: 256 },
};

export const LUT_RESOLUTIONS = ATMOSPHERE_LUT_RESOLUTIONS;

interface IParameterUniforms {
  readonly atmosphereRadius: UniformNode<"float", number>;
  readonly mie: UniformNode<"vec3", import("three").Vector3>;
  readonly ozone: UniformNode<"vec3", import("three").Vector3>;
  readonly planetRadius: UniformNode<"float", number>;
  readonly rayleigh: UniformNode<"vec3", import("three").Vector3>;
}

function checkedResolution(
  value: IAtmosphereLutResolution,
  name: string,
): IAtmosphereLutResolution {
  if (
    !Number.isInteger(value.width) ||
    !Number.isInteger(value.height) ||
    value.width <= 0 ||
    value.height <= 0
  ) {
    throw new Error(`Atmosphere.${name} resolution must contain positive integers.`);
  }
  return { height: value.height, width: value.width };
}

/** Resolve the three LUT dimensions, allowing a game to trade startup cost for resolution.
 * @situation choose atmosphere LUT dimensions for a measured startup budget
 * @constraint every width and height must be a positive integer; the dimensions are not a named fidelity tier
 * @example const resolutions = resolveAtmosphereLutResolutions({ skyView: { width: 128, height: 72 } });
 */
export function resolveAtmosphereLutResolutions(
  resolutions: Partial<IAtmosphereLutResolutions> | undefined,
): IAtmosphereLutResolutions {
  const source = resolutions ?? {};
  return {
    multiScattering: checkedResolution(
      source.multiScattering ?? ATMOSPHERE_LUT_RESOLUTIONS.multiScattering,
      "multiScattering",
    ),
    skyView: checkedResolution(source.skyView ?? ATMOSPHERE_LUT_RESOLUTIONS.skyView, "skyView"),
    transmittance: checkedResolution(
      source.transmittance ?? ATMOSPHERE_LUT_RESOLUTIONS.transmittance,
      "transmittance",
    ),
  };
}

function storageTexture(resolution: IAtmosphereLutResolution): StorageTexture {
  const texture = new StorageTexture(resolution.width, resolution.height);
  texture.type = HalfFloatType;
  texture.format = RGBAFormat;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  (texture as StorageTexture & { mipmapsAutoUpdate: boolean }).mipmapsAutoUpdate = false;
  return texture;
}

function hashNumber(value: number): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value);
  let hash = 2166136261;
  for (let index = 0; index < 8; index += 1) {
    hash ^= view.getUint8(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function hashParameters(
  parameters: IResolvedAtmosphereParameters,
  resolutions: IAtmosphereLutResolutions,
): string {
  let hash = 2166136261;
  const values = [
    parameters.rayleigh.x,
    parameters.rayleigh.y,
    parameters.rayleigh.z,
    parameters.mie.x,
    parameters.mie.y,
    parameters.mie.z,
    parameters.ozone.x,
    parameters.ozone.y,
    parameters.ozone.z,
    parameters.planetRadius,
    parameters.atmosphereRadius,
    resolutions.transmittance.width,
    resolutions.transmittance.height,
    resolutions.multiScattering.width,
    resolutions.multiScattering.height,
    resolutions.skyView.width,
    resolutions.skyView.height,
  ];
  for (const value of values) hash = Math.imul(hash ^ hashNumber(value), 16777619);
  return hash.toString(16).padStart(8, "0");
}

function uniforms(parameters: IResolvedAtmosphereParameters): IParameterUniforms {
  return {
    atmosphereRadius: uniform(parameters.atmosphereRadius),
    mie: uniform(parameters.mie.clone()),
    ozone: uniform(parameters.ozone.clone()),
    planetRadius: uniform(parameters.planetRadius),
    rayleigh: uniform(parameters.rayleigh.clone()),
  };
}

function bake2d(
  target: StorageTexture,
  resolution: IAtmosphereLutResolution,
  value: (uv: Node<"vec2">, x: Node<"uint">, y: Node<"uint">) => Node<"vec4">,
): ComputeNode {
  return Fn(() => {
    const x = instanceIndex.mod(resolution.width);
    const y = instanceIndex.div(resolution.width);
    const uv = vec2(
      float(x).add(0.5).div(resolution.width),
      float(y).add(0.5).div(resolution.height),
    );
    textureStore(target, uvec2(x, y), value(uv, x, y));
  })().compute(resolution.width * resolution.height);
}

function bakeTransmittance(
  target: StorageTexture,
  resolution: IAtmosphereLutResolution,
  parameterUniforms: IParameterUniforms,
): ComputeNode {
  return bake2d(target, resolution, (uv) => {
    const thickness = parameterUniforms.atmosphereRadius.sub(parameterUniforms.planetRadius);
    const rayleighColumn = float(8).mul(float(1).sub(exp(thickness.negate().div(8))));
    const mieColumn = float(1.2).mul(float(1).sub(exp(thickness.negate().div(1.2))));
    const airMass = float(1).div(uv.x.max(0.05));
    const opticalDepth = parameterUniforms.rayleigh
      .mul(rayleighColumn)
      .add(parameterUniforms.mie.mul(mieColumn))
      .add(parameterUniforms.ozone.mul(15))
      .mul(airMass);
    return vec4(exp(opticalDepth.negate()), 1);
  });
}

function sampleLut(target: StorageTexture, uv: Node<"vec2">): TextureNode {
  return texture(target, uv.clamp(0, 1)).level(float(0));
}

function bakeMultiScattering(
  target: StorageTexture,
  resolution: IAtmosphereLutResolution,
  parameterUniforms: IParameterUniforms,
  transmittance: StorageTexture,
): ComputeNode {
  return bake2d(target, resolution, (uv) => {
    const altitudeWeight = float(1).sub(uv.y);
    const angularWeight = float(0.5).add(uv.x.mul(0.5));
    const directTransmittance = sampleLut(transmittance, uv).rgb;
    const scattering = parameterUniforms.rayleigh
      .mul(altitudeWeight)
      .add(parameterUniforms.mie.mul(angularWeight))
      .add(parameterUniforms.ozone.mul(0.02));
    return vec4(scattering.mul(directTransmittance), 1);
  });
}

function bakeSkyView(
  target: StorageTexture,
  resolution: IAtmosphereLutResolution,
  parameterUniforms: IParameterUniforms,
  transmittance: StorageTexture,
  multiScattering: StorageTexture,
): ComputeNode {
  return bake2d(target, resolution, (uv) => {
    const horizonWeight = float(1).sub(uv.y).max(0);
    const sunWeight = float(0.25).add(uv.x.mul(0.75));
    const directTransmittance = sampleLut(transmittance, uv).rgb;
    const higherOrderScattering = sampleLut(multiScattering, uv).rgb;
    const scattering = parameterUniforms.rayleigh
      .mul(horizonWeight.mul(1.5))
      .add(parameterUniforms.mie.mul(sunWeight))
      .add(parameterUniforms.ozone.mul(0.01));
    return vec4(scattering.mul(directTransmittance).add(higherOrderScattering), 1);
  });
}

/** Own the transmittance, multi-scattering, and sky-view compute lookup textures.
 * @situation bake the three atmosphere LUTs once before a game shows its world
 * @constraint supply all physical parameters; this class creates no scene appearance
 * @example const luts = new AtmosphereLuts({ rayleigh, mie, ozone, planetRadius, atmosphereRadius });
 */
export class AtmosphereLuts {
  readonly resolutions: IAtmosphereLutResolutions;
  readonly transmittance: StorageTexture;
  readonly multiScattering: StorageTexture;
  readonly skyView: StorageTexture;
  readonly warmupNodes: readonly ComputeNode[];
  readonly uniforms: IParameterUniforms;
  #hash: string;

  constructor(
    parameters: IAtmosphereParametersLike,
    resolutions?: Partial<IAtmosphereLutResolutions>,
  ) {
    const resolved = resolveAtmosphereParameters(parameters);
    this.resolutions = resolveAtmosphereLutResolutions(resolutions);
    this.transmittance = storageTexture(this.resolutions.transmittance);
    this.multiScattering = storageTexture(this.resolutions.multiScattering);
    this.skyView = storageTexture(this.resolutions.skyView);
    this.uniforms = uniforms(resolved);
    this.warmupNodes = [
      bakeTransmittance(this.transmittance, this.resolutions.transmittance, this.uniforms),
      bakeMultiScattering(
        this.multiScattering,
        this.resolutions.multiScattering,
        this.uniforms,
        this.transmittance,
      ),
      bakeSkyView(
        this.skyView,
        this.resolutions.skyView,
        this.uniforms,
        this.transmittance,
        this.multiScattering,
      ),
    ];
    this.#hash = hashParameters(resolved, this.resolutions);
  }

  get hash(): string {
    return this.#hash;
  }

  update(parameters: IAtmosphereParametersLike): void {
    const resolved = resolveAtmosphereParameters(parameters);
    this.uniforms.atmosphereRadius.value = resolved.atmosphereRadius;
    this.uniforms.mie.value.copy(resolved.mie);
    this.uniforms.ozone.value.copy(resolved.ozone);
    this.uniforms.planetRadius.value = resolved.planetRadius;
    this.uniforms.rayleigh.value.copy(resolved.rayleigh);
    this.#hash = hashParameters(resolved, this.resolutions);
  }

  sampleTransmittance(uv: Node<"vec2">): TextureNode {
    return sampleLut(this.transmittance, uv);
  }

  sampleSkyView(uv: Node<"vec2">): TextureNode {
    return sampleLut(this.skyView, uv);
  }

  dispose(): void {
    for (const node of this.warmupNodes) node.dispose();
    this.transmittance.dispose();
    this.multiScattering.dispose();
    this.skyView.dispose();
  }
}

export type IAtmosphereParametersLike = IResolvedAtmosphereParameters | IAtmosphereParameters;
