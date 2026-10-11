/**
 * Preview environment settings: validated values the editor binds to project-owned render source.
 *
 * This file decides nothing about how the world looks. Every field is optional and an absent field
 * means "the project's own starter value", so the document carries only deliberate overrides and
 * the view reports the effective values it started from.
 */

/** Hex colour as saved: `#rrggbb`. */
export type IHexColour = string;

export interface IEnvironment {
  /** Direction towards the sun, as angles; intensity in the project's light units. */
  readonly sun?: {
    /** Degrees, `atan2(z, x)` of the horizontal part of the direction towards the sun. */
    readonly azimuth?: number;
    /** Degrees above the horizon, 0 to 90. */
    readonly elevation?: number;
    readonly intensity?: number;
    readonly colour?: IHexColour;
  };
  /** Sky fill: the hemisphere light's intensity. */
  readonly fill?: { readonly intensity?: number };
  /**
   * What is drawn behind the world: a procedural colour, or a registered environment/image asset.
   * An image replaces the colour; remove it (null) and the colour is back.
   */
  readonly sky?: {
    readonly colour?: IHexColour;
    /** A registered HDR/EXR or ordinary equirectangular image id. */
    readonly image?: string;
    /** Degrees about the vertical axis. */
    readonly rotation?: number;
    /** Multiplies the image's radiance. */
    readonly intensity?: number;
  };
  /**
   * Illumination from an image, chosen independently of the background. When it is set and the
   * sky fill is not, the hemisphere fill is 0 so the image is the one fill and light is not
   * counted twice; the sun is its own, explicit contribution.
   */
  readonly lighting?: {
    readonly image?: string;
    readonly rotation?: number;
    readonly intensity?: number;
  };
  /** Distance haze. `mode` names a fog this source supports; anything else is refused by name. */
  readonly fog?: {
    readonly mode?: "exp2";
    readonly colour?: IHexColour;
    /** Per metre. */
    readonly density?: number;
  };
  /** Linear exposure multiplier (2^EV). */
  readonly exposure?: number;
  /** The sea's shallow and deep colour; wave behaviour is project render source. */
  readonly ocean?: { readonly shallow?: IHexColour; readonly deep?: IHexColour };
}

export type IEnvironmentOperation =
  | { readonly op: "get" }
  /** Deep-merge validated values; a `null` field returns that field to the project's value. */
  | { readonly op: "patch"; readonly values: unknown }
  | { readonly op: "reset" };

export interface IEnvironmentResult {
  readonly op: string;
  /** The saved overrides after this operation. */
  readonly environment: IEnvironment;
}

const SECTIONS = {
  sun: ["azimuth", "elevation", "intensity", "colour"],
  fill: ["intensity"],
  sky: ["colour", "image", "rotation", "intensity"],
  lighting: ["image", "rotation", "intensity"],
  fog: ["mode", "colour", "density"],
  ocean: ["shallow", "deep"],
} as const;
/** Far beyond any light this preview can show; keeps a typo from becoming a white frame. */
const MAX_INTENSITY = 1000;
const MAX_EXPOSURE = 64;
/** Beyond this a metre of air is opaque and the world is a flat colour. */
const MAX_DENSITY = 1;

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function number(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max)
    throw new Error(`${name} must be a finite number from ${min} to ${max}`);
  return value;
}

function colour(value: unknown, name: string): IHexColour {
  if (typeof value !== "string" || !/^#[0-9a-fA-F]{6}$/u.test(value))
    throw new Error(`${name} must be a #rrggbb colour`);
  return value.toLowerCase();
}

function field(section: string, key: string, value: unknown): unknown {
  const name = `environment.${section}.${key}`;
  switch (`${section}.${key}`) {
    case "sun.azimuth":
      return number(value, name, -360, 360);
    case "sun.elevation":
      return number(value, name, 0, 90);
    case "sky.image":
    case "lighting.image":
      if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,47}$/u.test(value))
        throw new Error(`${name} must be a registered asset id`);
      return value;
    case "sky.rotation":
    case "lighting.rotation":
      return number(value, name, -360, 360);
    case "sun.intensity":
    case "fill.intensity":
    case "sky.intensity":
    case "lighting.intensity":
      return number(value, name, 0, MAX_INTENSITY);
    case "fog.density":
      return number(value, name, 0, MAX_DENSITY);
    case "fog.mode":
      if (value !== "exp2")
        throw new Error(
          `environment.fog.mode '${String(value)}' is not supported by this render source; supported: exp2`,
        );
      return value;
    default:
      return colour(value, name);
  }
}

/**
 * Validate a complete overrides object exactly as a document commit stores it.
 * @summary Validate preview environment overrides
 * @requires npm i -D @threenative/terrain
 * @situation save sun, sky, haze, exposure or ocean overrides in the shared authoring document
 * @constraint authoring metadata only; unknown fields and unsupported fog modes are refused by name
 * @example const environment = validateEnvironment({ sun: { elevation: 25, intensity: 3 } });
 * @override the project's render source defines what each value does; absent fields keep its own
 */
export function validateEnvironment(input: unknown): IEnvironment {
  const value = object(input, "environment");
  const extra = Object.keys(value).filter((key) => key !== "exposure" && !(key in SECTIONS));
  if (extra.length) throw new Error(`environment has unknown fields: ${extra.join(", ")}`);
  const out: Record<string, unknown> = {};
  if (value.exposure !== undefined)
    out.exposure = number(value.exposure, "environment.exposure", 2 ** -8, MAX_EXPOSURE);
  for (const [section, keys] of Object.entries(SECTIONS)) {
    if (value[section] === undefined) continue;
    const entries = object(value[section], `environment.${section}`);
    const unknown = Object.keys(entries).filter(
      (key) => !(keys as readonly string[]).includes(key),
    );
    if (unknown.length)
      throw new Error(`environment.${section} has unknown fields: ${unknown.join(", ")}`);
    const clean: Record<string, unknown> = {};
    for (const key of keys)
      if (entries[key] !== undefined) clean[key] = field(section, key, entries[key]);
    if (Object.keys(clean).length) out[section] = clean;
  }
  return out as IEnvironment;
}

/**
 * Apply one get / patch / reset against the saved environment overrides; the caller commits it.
 * @summary Run one preview-environment operation
 * @requires npm i -D @threenative/terrain
 * @situation patch sun, haze, exposure or sea overrides from a controller or the editor GUI
 * @constraint authoring metadata only; a null field returns to the project's own value
 * @example const result = runEnvironmentOperation({}, { op: "patch", values: { sun: { elevation: 25 } } });
 * @override the project's render source decides what each value does
 */
export function runEnvironmentOperation(
  current: IEnvironment,
  operation: unknown,
): IEnvironmentResult {
  const request = object(operation, "Environment operation");
  if (request.op === "get") return { op: "get", environment: current };
  if (request.op === "reset") return { op: "reset", environment: {} };
  if (request.op !== "patch") throw new Error("Environment op must be get, patch or reset");
  const values = object(request.values, "environment patch");
  const merged: Record<string, unknown> = { ...current };
  // A null returns the field to the project's value; `validateEnvironment` drops what is undefined.
  const clear = (value: unknown): unknown => (value === null ? undefined : value);
  for (const [key, patch] of Object.entries(values)) {
    if (key === "exposure") merged.exposure = clear(patch);
    else if (key in SECTIONS) {
      if (patch === null) merged[key] = undefined;
      else {
        const entries = object(patch, `environment.${key}`);
        const section = { ...((merged[key] as Record<string, unknown> | undefined) ?? {}) };
        for (const [name, entry] of Object.entries(entries)) section[name] = clear(entry);
        merged[key] = section;
      }
    } else throw new Error(`environment has unknown fields: ${key}`);
  }
  return { op: "patch", environment: validateEnvironment(merged) };
}

/**
 * Check that the images an environment names are registered environment or image assets.
 * @summary Validate the assets a preview environment refers to
 * @requires npm i -D @threenative/terrain
 * @situation refuse a saved environment whose sky or lighting image is not a registered file
 * @constraint throws by name; HDR/EXR environment files and ordinary images are accepted, models are not
 * @example checkEnvironmentAssets({ sky: { image: "dusk" } }, document.assets ?? []);
 * @override the project owns which images it registers
 */
export function checkEnvironmentAssets(
  environment: IEnvironment,
  assets: readonly { id: string; kind: string }[],
): void {
  for (const [group, image] of [
    ["sky", environment.sky?.image],
    ["lighting", environment.lighting?.image],
  ] as const) {
    if (image === undefined) continue;
    const found = assets.find((entry) => entry.id === image);
    if (!found || (found.kind !== "environment" && found.kind !== "image"))
      throw new Error(
        `environment.${group}.image names '${image}', which is not a registered environment or image asset`,
      );
  }
}
