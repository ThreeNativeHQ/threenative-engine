/**
 * The oracle for terrain geometry that is otherwise trusted every frame.
 *
 * `TerrainTiles` re-derives what it already knows — every rendered vertex checked for finiteness,
 * every resident seam re-measured, every LOD blend's visible displacement sampled — and that is a
 * measurement, not a mechanism: on a 289-tile ring a six-second walk paid ~270 ms in three loops
 * that only throw when something is already broken. So it is off by default and the shipped frame
 * trusts the cheap change detector instead, which compares buffer versions and the residency and
 * LOD state the class writes itself.
 *
 * `TN_TERRAIN_VALIDATE=1`, `?tnTerrainValidate=1`, or `validate: true` on the constructor puts the
 * loops back and every assertion with them. It is a validation mode, not a proof: it proves the
 * frames it ran on.
 */
import { readLaunchFlag } from "./debug.js";

/** Marker printed when terrain validation is on, so a log says which mode produced it. */
export const TERRAIN_VALIDATE_MARKER = "TN_TERRAIN_VALIDATE";

/** The launch flag. */
export const TERRAIN_VALIDATE_FLAG = "TN_TERRAIN_VALIDATE";

/**
 * Whether `TN_TERRAIN_VALIDATE` asks for terrain validation on this launch.
 *
 * @situation turn terrain's per-frame seam, LOD pop and vertex checks on for one run
 * @situation assert the terrain geometry a game streams before it ships
 * @constraint off by default: it is the work it checks, every frame
 * @example // Reads its own the way `renderListValidationRequested` does: a native launch sets the
 * // environment variable, a browser asks with the query string, a test or harness sets the
 * // global. `0` and `false` are off, so a saved URL that enabled it still says "off".
 * const tiles = new TerrainTiles({ ...options, validate: terrainValidationRequested() });
 */
export function terrainValidationRequested(): boolean {
  return readLaunchFlag({
    environment: TERRAIN_VALIDATE_FLAG,
    global: "__tnTerrainValidate",
    query: "tnTerrainValidate",
  });
}
