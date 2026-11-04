import { Terrain } from "./terrain.js";
import type { ITerrainConfig } from "./types.js";

export type LandformKind =
  | "alpine"
  | "temperateMountains"
  | "rollingHills"
  | "desertMesa"
  | "coastalCliffs"
  | "tundra"
  | "volcanic";

export interface ILandformOptions extends Partial<ITerrainConfig> {
  /** Highest minus lowest height in metres. Defaults to the kind's real ratio times `size`. */
  relief?: number;
}

export interface ILandformInfo {
  readonly summary: string;
  /** Default relief as a fraction of the world size. */
  readonly reliefRatio: number;
  /** Where the shape comes from: a public-domain DEM the repo carries, or a cited landscape. */
  readonly reference: string;
  /** Measured DEM statistics (5 km, 513 samples), when the repo carries that DEM; `terrainStats` fields. */
  readonly target?: {
    readonly slopeP50: number;
    readonly slopeP90: number;
    readonly hypsometricIntegral: number;
    readonly curvatureKurtosis: number;
  };
}

/**
 * Shape-only presets. Each names its reference landscape so a calibration can be repeated; no
 * material, colour or texture is chosen here. Targets were measured with `terrainStats` on the
 * 1/3 arc-second USGS 3DEP crops in `examples/strata-terrain-preview/scripts/dem` (public domain).
 */
export const LANDFORMS: Readonly<Record<LandformKind, ILandformInfo>> = {
  alpine: {
    summary: "Glacier-cut granite peaks: steep headwalls, sharp arêtes, dendritic gullies.",
    reliefRatio: 0.25,
    reference: "Longs Peak, Rocky Mountain National Park, Colorado (USGS 3DEP, DEM crop `alpine`)",
    target: { slopeP50: 27.3, slopeP90: 42.5, hypsometricIntegral: 0.452, curvatureKurtosis: 89.3 },
  },
  temperateMountains: {
    summary: "Forested mountain backdrop: rounded massifs cut by branching valleys.",
    reliefRatio: 0.17,
    reference: "Sprague Lake / Glacier Creek, Rocky Mountain National Park (DEM crop `forest`)",
    target: { slopeP50: 14.7, slopeP90: 28.1, hypsometricIntegral: 0.398, curvatureKurtosis: 13.7 },
  },
  rollingHills: {
    summary: "Low dendritic hills with convex ridges and gentle slopes.",
    reliefRatio: 0.03,
    reference:
      "Driftless Area, Wisconsin: fluvially dissected flat-lying bedrock, local relief up to about 115 m (WGNHS county reports); no DEM crop in the repo, so no measured target",
  },
  desertMesa: {
    summary: "Caprock mesas and buttes over a stepped, cliff-and-bench canyon landscape.",
    reliefRatio: 0.055,
    reference: "Valley of the Gods, Utah (DEM crop `desert`)",
    target: { slopeP50: 3.7, slopeP90: 16.9, hypsometricIntegral: 0.276, curvatureKurtosis: 203.9 },
  },
  coastalCliffs: {
    summary: "Island massif with steep rocky shore and drowned gullies.",
    reliefRatio: 0.075,
    reference: "Sand Beach / Great Head, Acadia National Park, Maine (DEM crop `coastal`)",
    target: { slopeP50: 1.6, slopeP90: 19.4, hypsometricIntegral: 0.11, curvatureKurtosis: 34.7 },
  },
  tundra: {
    summary: "Broad rounded uplands above the tree line with shallow glacial valleys.",
    reliefRatio: 0.15,
    reference: "Trail Ridge, Rocky Mountain National Park (DEM crop `tundra`)",
    target: { slopeP50: 17.1, slopeP90: 27.9, hypsometricIntegral: 0.473, curvatureKurtosis: 16.7 },
  },
  volcanic: {
    summary: "Stratovolcano cone with a summit crater and radial gullies.",
    reliefRatio: 0.18,
    reference:
      "Mayon Volcano, Philippines: summit 2469 m, slope about 1:2.5 above 500 m easing to 1:7.8 and 1:19.9 (JICA hazard report); no DEM crop in the repo, so no measured target",
  },
};

/**
 * One call, one landscape: a calibrated layer recipe for a kind of environment.
 * @requires npm i @threenative/terrain
 * @situation start an open world, a distant backdrop or a mountain level from a kind of place
 * @constraint returns an ordinary `Terrain`: add roads, rivers, scatter or more layers, then `evaluate()` in a build script
 * @constraint shape only; materials, colours and textures belong to the game
 * @constraint calibrated at size 5000, resolution 513; other sizes keep the same slopes and scale the relief with `size`
 * @example const terrain = landform("alpine", { size: 5000, resolution: 513, seed: 4 }); const state = terrain.evaluate();
 * @override `relief` is the highest-minus-lowest height in metres before the finishing passes shave a few percent; `size`, `resolution` and `seed` as in `Terrain`
 */
export function landform(kind: LandformKind, options: ILandformOptions = {}): Terrain {
  const info = LANDFORMS[kind];
  if (!info) throw new TypeError(`Unknown landform kind: ${String(kind)}`);
  const { size = 5000, resolution = 513, seed = 73 } = options;
  const s = size;
  const relief = options.relief ?? info.reliefRatio * s;
  const t = new Terrain({ size, resolution, seed });
  // Constants below were fitted at size 5000 against the DEM targets (random search over the
  // envelope, uplift, threshold slope and finishing passes, scored on slope, hypsometry and
  // curvature). Uplift follows the size: with K fixed, slope depends on U / A^m, which a world of
  // another size keeps by scaling U with it (relief grows with size, A^m with size^0.9).
  const uplift = (u: number): number => u * (s / 5000);
  const valleys = (u: number, talus: number, iterations: number) =>
    ({
      id: "valleys",
      method: "fluvial",
      iterations,
      uplift: uplift(u),
      erodibility: 1e-5,
      talus,
      // Rescales the eroded surface, so the finished relief follows the request at any seed.
      relief,
    }) as const;
  switch (kind) {
    case "alpine":
      t.noise({
        id: "massif",
        amplitude: relief * 3.01,
        scale: s * 0.535,
        octaves: 4,
        mode: "ridged",
        warp: s * 0.0706,
      })
        .stamp({
          id: "peak",
          shape: "mountain",
          at: [0, 0],
          radius: s * 0.42,
          amplitude: relief * 7.83,
          roughness: 0.5,
        })
        .erode(valleys(1.5e-4, 60.5, 49))
        .erode({ id: "talus", method: "thermal", iterations: 13, talus: 26.8 })
        .smooth({ id: "grain", iterations: 3 });
      break;
    case "temperateMountains":
      t.noise({
        id: "massif",
        amplitude: relief * 2.18,
        scale: s * 0.988,
        octaves: 4,
        mode: "fbm",
        warp: s * 0.0716,
      })
        .stamp({
          id: "peak",
          shape: "mountain",
          at: [0, 0],
          radius: s * 0.42,
          amplitude: relief * 4.5,
          roughness: 0.5,
        })
        .erode(valleys(4.13e-5, 30.2, 43))
        .smooth({ id: "grain", iterations: 3 });
      break;
    case "rollingHills":
      t.noise({
        id: "hills",
        amplitude: relief * 1.6,
        scale: s * 0.25,
        octaves: 4,
        mode: "fbm",
        warp: s * 0.05,
      })
        .erode(valleys(1e-5, 12, 40))
        .smooth({ id: "grain", iterations: 2 });
      break;
    case "desertMesa":
      t.noise({
        id: "plateau",
        amplitude: relief * 1.75,
        scale: s * 0.447,
        octaves: 3,
        mode: "fbm",
        warp: s * 0.12,
      })
        .erode(valleys(8.37e-4, 33.4, 28))
        .terrace({ id: "caprock", step: relief / 6, softness: 0.15, strength: 0.688 })
        .erode({ id: "talus", method: "thermal", iterations: 16, talus: 25 })
        .smooth({ id: "grain", iterations: 1 });
      break;
    case "coastalCliffs":
      t.noise({
        id: "island",
        amplitude: relief * 1.11,
        scale: s * 0.962,
        octaves: 6,
        mode: "ridged",
        warp: s * 0.0456,
        island: true,
        coastDepth: relief * 0.111,
      })
        .erode(valleys(7.75e-5, 64.8, 55))
        .erode({ id: "talus", method: "thermal", iterations: 8, talus: 32.7 })
        .smooth({ id: "grain", iterations: 3 });
      break;
    case "tundra":
      t.noise({
        id: "uplands",
        amplitude: relief * 3.59,
        scale: s * 0.837,
        octaves: 4,
        mode: "fbm",
        warp: s * 0.097,
      })
        .stamp({
          id: "ridge",
          shape: "mountain",
          at: [0, 0],
          radius: s * 0.42,
          amplitude: relief * 3.95,
          roughness: 0.5,
        })
        .erode(valleys(8.69e-5, 30.1, 30))
        .erode({ id: "talus", method: "thermal", iterations: 8, talus: 26.2 });
      break;
    case "volcanic":
      t.noise({ id: "rubble", amplitude: relief * 0.04, scale: s * 0.1, octaves: 4, mode: "fbm" })
        .stamp({
          id: "cone",
          shape: "mountain",
          at: [0, 0],
          radius: s * 0.45,
          amplitude: relief,
          roughness: 0.15,
        })
        .stamp({
          id: "crater",
          shape: "crater",
          at: [0, 0],
          radius: s * 0.07,
          amplitude: relief * 0.08,
          blend: "add",
        })
        .erode(valleys(3e-4, 38, 15))
        .erode({ id: "talus", method: "thermal", iterations: 8, talus: 36 })
        .smooth({ id: "grain", iterations: 1 });
      break;
  }
  return t;
}
