import { Group, Vector3 } from "three";
import { exp, float, mix, uniform, vec2, vec3, vec4 } from "three/tsl";
import type { ComputeNode, Node, TextureNode, UniformNode } from "three/webgpu";
import type { IRendererLike } from "../renderer.js";
import { AtmosphereLuts, type IAtmosphereLutResolutions } from "./luts.js";
import {
  type AtmosphereRgb,
  type IAtmosphereParameterPatch,
  type IAtmosphereParameters,
  type IResolvedAtmosphereParameters,
  type ISolarPosition,
  type ISolarPositionInput,
  directionFromSolarPosition,
  directionalTransmittance,
  resolveAtmosphereParameters,
  solarPosition,
  updateAtmosphereParameters,
} from "./params.js";

/** The structural contract consumed by the compute registry from PRD-242. */
interface IComputeDriven {
  readonly warmupNodes: readonly unknown[];
  attachRenderer(renderer: IRendererLike): void;
  readonly processCadence?: "fixed" | "render";
  process(renderer: IRendererLike): void;
  detach(): void;
  readonly released: boolean;
}

export interface IAtmosphereOptions extends IAtmosphereParameters {
  readonly resolutions?: Partial<IAtmosphereLutResolutions>;
}

export interface IAtmosphereScenePass {
  getTextureNode(name?: string): Node<"vec4">;
}

export type AtmosphereDirection = Vector3 | readonly [number, number, number] | Node<"vec3">;

function isNode(value: unknown): value is Node {
  return (
    value !== null && typeof value === "object" && (value as { isNode?: unknown }).isNode === true
  );
}

function asVector(value: Vector3 | readonly [number, number, number]): Vector3 {
  if (!(value instanceof Vector3) && value.length !== 3)
    throw new Error("Atmosphere direction must contain three numbers.");
  const result =
    value instanceof Vector3 ? value.clone() : new Vector3(value[0], value[1], value[2]);
  if (![result.x, result.y, result.z].every((component) => Number.isFinite(component))) {
    throw new Error("Atmosphere direction must contain finite numbers.");
  }
  if (result.lengthSq() === 0) throw new Error("Atmosphere direction must not be zero.");
  return result.normalize();
}

function averageExtinction(parameters: IResolvedAtmosphereParameters): number {
  return (
    (parameters.rayleigh.x +
      parameters.rayleigh.y +
      parameters.rayleigh.z +
      parameters.mie.x +
      parameters.mie.y +
      parameters.mie.z) /
    3
  );
}

function directionNode(direction: AtmosphereDirection): Node<"vec3"> {
  if (isNode(direction)) return direction as Node<"vec3">;
  return vec3(asVector(direction));
}

function nodeRgb(value: TextureNode): Node<"vec3"> {
  return value.rgb;
}

/**
 * Own the compute lifetime and expose only parameter-driven atmosphere nodes.
 *
 * The class deliberately creates no mesh, material, or scene light. A template chooses all of
 * those, and the same object remains useful when a game supplies a completely different look.
 * @situation render a sunrise that changes as time and place change
 * @situation add distance haze from the depth of a scene pass
 * @alias green platforms bright saturated sky
 * @constraint supply rayleigh, mie, ozone, planetRadius, and atmosphereRadius; there is no Earth fallback
 * @constraint the game creates the sky object, surface, and sun from the returned nodes
 * @example const atmosphere = new Atmosphere({ rayleigh, mie, ozone, planetRadius, atmosphereRadius });
 * ctx.add(atmosphere);
 */
export class Atmosphere extends Group implements IComputeDriven {
  readonly luts: AtmosphereLuts;
  #parameters: IResolvedAtmosphereParameters;
  #renderer: IRendererLike | undefined;
  #released = false;
  #dirty = true;
  #sunDirection = new Vector3(0, 1, 0);
  #sunDirectionNode: UniformNode<"vec3", Vector3>;
  #extinctionNode: UniformNode<"float", number>;

  constructor(options: IAtmosphereOptions) {
    super();
    this.#parameters = resolveAtmosphereParameters(options);
    this.luts = new AtmosphereLuts(this.#parameters, options.resolutions);
    this.#sunDirectionNode = uniform(this.#sunDirection.clone());
    this.#extinctionNode = uniform(averageExtinction(this.#parameters));
    this.addEventListener("removed", this.#onRemoved);
  }

  get parameters(): IResolvedAtmosphereParameters {
    return {
      atmosphereRadius: this.#parameters.atmosphereRadius,
      mie: this.#parameters.mie.clone(),
      ozone: this.#parameters.ozone.clone(),
      planetRadius: this.#parameters.planetRadius,
      rayleigh: this.#parameters.rayleigh.clone(),
    };
  }

  get warmupNodes(): readonly ComputeNode[] {
    return this.luts.warmupNodes;
  }

  get released(): boolean {
    return this.#released;
  }

  get hash(): string {
    return this.luts.hash;
  }

  attachRenderer(renderer: IRendererLike): void {
    if (this.#released) throw new Error("Atmosphere cannot be attached after release.");
    if (this.#renderer === renderer) return;
    this.#renderer = renderer;
    this.#dispatch(renderer);
    this.#dirty = false;
  }

  process(renderer = this.#renderer): void {
    if (this.#released) return;
    if (renderer === undefined) throw new Error("Atmosphere is not attached to a renderer.");
    if (this.#dirty) {
      this.#dispatch(renderer);
      this.#dirty = false;
    }
  }

  detach(): void {
    if (this.#released) return;
    this.#renderer = undefined;
    this.luts.dispose();
    this.#released = true;
  }

  setAtmosphere(patch: IAtmosphereParameterPatch): this {
    if (this.#released) throw new Error("Atmosphere cannot change after release.");
    this.#parameters = updateAtmosphereParameters(this.#parameters, patch);
    this.luts.update(this.#parameters);
    this.#extinctionNode.value = averageExtinction(this.#parameters);
    this.#dirty = true;
    return this;
  }

  setCoefficients(patch: IAtmosphereParameterPatch): this {
    return this.setAtmosphere(patch);
  }

  setSunDirection(elevation: number, azimuth: number): this;
  setSunDirection(direction: Vector3): this;
  setSunDirection(position: Pick<ISolarPosition, "elevation" | "azimuth">): this;
  setSunDirection(
    elevationOrDirection: number | Vector3 | Pick<ISolarPosition, "elevation" | "azimuth">,
    azimuth?: number,
  ): this {
    let direction: Vector3;
    if (typeof elevationOrDirection === "number") {
      if (azimuth === undefined)
        throw new Error("Atmosphere sun direction requires elevation and azimuth.");
      direction = directionFromSolarPosition(elevationOrDirection, azimuth);
    } else if (elevationOrDirection instanceof Vector3) {
      direction = asVector(elevationOrDirection);
    } else {
      direction = directionFromSolarPosition(
        elevationOrDirection.elevation,
        elevationOrDirection.azimuth,
      );
    }
    this.#sunDirection.copy(direction);
    this.#sunDirectionNode.value.copy(direction);
    return this;
  }

  getSunDirection(target = new Vector3()): Vector3 {
    return target.copy(this.#sunDirection);
  }

  /** Return the game-owned sky radiance lookup as a TSL vec3 or a CPU validation sample. */
  radiance(direction: AtmosphereDirection): Node<"vec3"> | Vector3 {
    if (!isNode(direction)) {
      const normal = asVector(direction);
      const horizon = 1 - Math.max(0, normal.y);
      const sunWeight = Math.max(0, normal.dot(this.#sunDirection));
      return new Vector3(
        this.#parameters.rayleigh.x * (0.75 + horizon) + this.#parameters.mie.x * sunWeight,
        this.#parameters.rayleigh.y * (0.75 + horizon) + this.#parameters.mie.y * sunWeight,
        this.#parameters.rayleigh.z * (0.75 + horizon) + this.#parameters.mie.z * sunWeight,
      );
    }

    const normal = directionNode(direction).normalize();
    const uv = vec2(normal.x.mul(0.5).add(0.5), normal.y.mul(0.5).add(0.5));
    const lookup = nodeRgb(this.luts.sampleSkyView(uv));
    const sunWeight = normal.dot(this.#sunDirectionNode).max(0);
    return lookup.mul(float(0.35).add(sunWeight.mul(0.65)));
  }

  /** Return direct solar transmittance as a TSL vec3 or a CPU validation sample. */
  sunTransmittance(direction: AtmosphereDirection): Node<"vec3"> | Vector3 {
    if (!isNode(direction)) return directionalTransmittance(this.#parameters, asVector(direction));
    const normal = directionNode(direction).normalize();
    const uv = vec2(normal.y.max(0.05), float(0.5));
    return nodeRgb(this.luts.sampleTransmittance(uv));
  }

  /**
   * Composite scene colour against game-supplied in-scattered radiance using scene-pass depth.
   *
   * The optional radiance node lets the game apply its own exposure or artistic tint. Leaving it
   * out uses the raw unit-illumination LUT value and does not introduce a framework look.
   */
  aerialPerspective(
    scenePass: IAtmosphereScenePass,
    depth: Node<"float"> | number,
    inScatteredRadiance?: Node<"vec3"> | Vector3,
  ): Node<"vec4"> {
    const sceneColour = scenePass.getTextureNode();
    if (typeof depth === "number" && !Number.isFinite(depth))
      throw new Error("Atmosphere depth must be finite.");
    const depthNode = typeof depth === "number" ? float(depth) : depth;
    const distanceKm = depthNode.abs().div(1000);
    const haze = float(1)
      .sub(exp(distanceKm.mul(this.#extinctionNode).negate()))
      .clamp(0, 0.98);
    const sky =
      inScatteredRadiance === undefined
        ? (this.radiance(vec3(0, 1, 0)) as Node<"vec3">)
        : isNode(inScatteredRadiance)
          ? (inScatteredRadiance as Node<"vec3">)
          : vec3(inScatteredRadiance);
    return mix(sceneColour, vec4(sky, sceneColour.a), haze);
  }

  #dispatch(renderer: IRendererLike): void {
    for (const node of this.luts.warmupNodes) renderer.compute(node);
  }

  #onRemoved = (): void => this.detach();
}

export type {
  AtmosphereRgb,
  IAtmosphereParameterPatch,
  IAtmosphereParameters,
  IResolvedAtmosphereParameters,
  ISolarPosition,
  ISolarPositionInput,
};

/** Approximate direct transmittance for a ray leaving the game surface.
 * @situation colour a game-owned sun from atmosphere extinction
 * @constraint pass a non-zero direction; coefficients and radii come from the game
 * @example const transmittance = directionalTransmittance(parameters, sunDirection);
 */
export { directionalTransmittance } from "./params.js";

/** Convert solar elevation and azimuth degrees into a normalized Three.js direction.
 * @situation aim a template's sun from solarPosition output
 * @constraint elevation and azimuth must be finite degrees
 * @example const direction = directionFromSolarPosition(sun.elevation, sun.azimuth);
 */
export { directionFromSolarPosition } from "./params.js";

/** Validate and clone game-owned atmosphere coefficients.
 * @situation validate atmosphere coefficients before a game creates its sky
 * @constraint provide all three coefficient vectors and both radii; omitted fields are errors
 * @example const parameters = resolveAtmosphereParameters({ rayleigh, mie, ozone, planetRadius, atmosphereRadius });
 */
export { resolveAtmosphereParameters } from "./params.js";

/** Calculate solar elevation and azimuth from time, latitude, and longitude.
 * @situation move a sun across a real day at a game's latitude and longitude
 * @situation run a day and night cycle over the game's sky
 * @constraint dates are interpreted as UTC unless utcOffset is supplied; no fixed sun direction is assumed
 * @example const sun = solarPosition({ date, latitude: 49.28, longitude: -123.12, utcOffset: -8 });
 */
export { solarPosition } from "./params.js";

/** Apply a partial game-owned atmosphere change while preserving validation.
 * @situation change scattering coefficients and rebake an atmosphere
 * @constraint patches cannot introduce omitted, negative, or non-finite physical values
 * @example atmosphere.setAtmosphere({ rayleigh: [0.008, 0.016, 0.04] });
 */
export { updateAtmosphereParameters } from "./params.js";

/** Return direct vertical transmittance for the supplied atmosphere.
 * @situation check a supplied atmosphere's direct vertical transmittance
 * @constraint use the returned value as a validation oracle; the rendered path samples the LUT
 * @example const zenith = zenithTransmittance({ rayleigh, mie, ozone, planetRadius, atmosphereRadius });
 */
export { zenithTransmittance } from "./params.js";
export {
  ATMOSPHERE_LUT_RESOLUTIONS,
  AtmosphereLuts,
  LUT_RESOLUTIONS,
  resolveAtmosphereLutResolutions,
} from "./luts.js";
export type {
  IAtmosphereLutResolution,
  IAtmosphereLutResolutions,
} from "./luts.js";

/** Calculate solar elevation and azimuth for one UTC date.
 * @situation calculate a sun direction from a timestamp and a game location
 * @constraint dates are interpreted as UTC; use solarPosition for an explicit local offset
 * @example const sun = solarPositionAt(new Date(), 49.28, -123.12);
 */
export function solarPositionAt(
  date: Date | string,
  latitude: number,
  longitude: number,
): ISolarPosition {
  return solarPosition({ date, latitude, longitude });
}
