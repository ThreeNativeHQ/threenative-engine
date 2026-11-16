import { isAbsolute } from "node:path";
import { type IGroundRequest, locationSurvey } from "../ground/surveys.js";

// The small checks every request argument shares: a closed record, a relative output directory,
// and the three ground sources both cook tools accept.

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rejects any field the tool does not declare, so a typo never falls back to a default. */
export function closedRecord(
  input: unknown,
  tool: string,
  fields: readonly string[],
): Record<string, unknown> {
  if (!isRecord(input)) throw new TypeError(`${tool}: arguments must be an object.`);
  for (const key of Object.keys(input)) {
    if (!fields.includes(key)) throw new TypeError(`${tool}: unknown field '${key}'.`);
  }
  return input;
}

export function relativeDirectory(out: unknown): string {
  if (
    typeof out !== "string" ||
    out.trim() === "" ||
    isAbsolute(out) ||
    out.split(/[\\/]/).includes("..")
  ) {
    throw new TypeError("terrain_generate: out must be a relative directory inside the project.");
  }
  return out;
}

/**
 * The `ground` argument: "procedural", a heightmap file, or a latitude and longitude. Closed to those
 * three forms, so a misspelt source fails here instead of cooking the default it did not ask for.
 */
export function parseGround(value: unknown, tool: string): IGroundRequest | undefined {
  if (value === undefined) return undefined;
  if (value === "procedural") return "procedural";
  const forms = `${tool}: ground must be "procedural", { heightmap } or { location }.`;
  if (!isRecord(value)) throw new TypeError(forms);
  for (const key of Object.keys(value)) {
    if (!["heightmap", "location", "min", "max"].includes(key)) {
      throw new TypeError(`${tool}: ground field '${key}' is not a ground source.`);
    }
  }
  const { heightmap, location, min, max } = value;
  if (heightmap !== undefined) {
    if (typeof heightmap !== "string" || !/\.(png|r16)$/iu.test(heightmap)) {
      throw new TypeError(`${tool}: ground.heightmap must name a .png or .r16 file.`);
    }
    if ((min === undefined) !== (max === undefined)) {
      throw new TypeError(`${tool}: ground.heightmap needs min and max together, in metres.`);
    }
    if (min !== undefined && max !== undefined) {
      if (
        typeof min !== "number" ||
        typeof max !== "number" ||
        !Number.isFinite(min) ||
        !Number.isFinite(max)
      )
        throw new TypeError(`${tool}: ground.heightmap min and max must be finite metres.`);
      if (max <= min) throw new TypeError(`${tool}: ground.heightmap max must exceed min.`);
      return { heightmap, min, max };
    }
    return { heightmap };
  }
  if (location !== undefined) {
    if (!isRecord(location) || Object.keys(location).some((key) => !["lat", "lon"].includes(key))) {
      throw new TypeError(`${tool}: ground.location must be { lat, lon }.`);
    }
    const { lat, lon } = location;
    if (typeof lat !== "number" || typeof lon !== "number") {
      throw new TypeError(`${tool}: ground.location lat and lon must be numbers.`);
    }
    // The row a bare coordinate builds is validated here too, so a bad coordinate never reaches a fetch.
    locationSurvey(lat, lon);
    return { location: { lat, lon } };
  }
  throw new TypeError(forms);
}
