/**
 * The `world.json` package contract: a versioned manifest that names a raw heightmap, stable
 * asset ids, placement runs and the square cells that stream them.
 *
 * Every value is authored by the world exporter and read by the runtime, so the game never
 * hard-codes a cell layout or an asset path. Validation never throws on malformed JSON-shaped
 * input: it collects named errors so an exporter can report every problem in one pass.
 */

export type WorldPackageErrorCode =
  | "WORLD_VERSION_MISMATCH"
  | "WORLD_UNKNOWN_ASSET"
  | "WORLD_RUN_OUT_OF_RANGE"
  | "WORLD_CELL_OUTSIDE_EXTENT"
  | "WORLD_MALFORMED";

export interface IWorldPackageError {
  readonly code: WorldPackageErrorCode;
  readonly message: string;
  /** JSON-shaped path to the offending field, e.g. `cells[2].runs[0].offset`. */
  readonly path: string;
}

export interface IWorldExtent {
  readonly minX: number;
  readonly minZ: number;
  readonly sizeX: number;
  readonly sizeZ: number;
}

export interface IWorldTerrain {
  /** Package-relative path to the raw little-endian uint16 heightmap. */
  readonly heightmap: string;
  /** Vertex counts; `columns = sizeX / spacing + 1`, likewise `rows`. */
  readonly columns: number;
  readonly rows: number;
  /** Metres between adjacent heightmap vertices on both axes. */
  readonly spacing: number;
  readonly heightMin: number;
  readonly heightMax: number;
  /** Optional opaque layer-mask paths, passed through to the game's surface untouched. */
  readonly layers?: Readonly<Record<string, string>>;
}

export interface IWorldAssetLod {
  readonly glb: string;
  readonly distance: number;
}

export interface IWorldAssetBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

export interface IWorldAsset {
  readonly glb: string;
  readonly lods?: readonly IWorldAssetLod[];
  readonly bounds: IWorldAssetBounds;
  readonly maxDistance?: number;
}

export interface IWorldRun {
  readonly asset: string;
  /** Record offset into `placements`; one record is eight float32 values. */
  readonly offset: number;
  readonly count: number;
}

export interface IWorldCellProxy {
  readonly glb: string;
  /** Conservative world-space simplification error bound, in metres. */
  readonly error: number;
  readonly triangles: number;
  readonly materialGroups: number;
  /** Older records without scope cover chunks only. */
  readonly scope?: "cell" | "chunks";
  readonly bounds?: IWorldAssetBounds;
  readonly sourceTriangles?: number;
  /** Cook census only: runtime compares the currently active shared batches. */
  readonly sourcePrimitives?: number;
}

export interface IWorldCell {
  readonly x: number;
  readonly z: number;
  readonly runs: readonly IWorldRun[];
  readonly chunks?: readonly string[];
  readonly proxy?: IWorldCellProxy;
}

export interface IWorldPackage {
  readonly version: 1;
  readonly extent: IWorldExtent;
  readonly cellSize: number;
  readonly terrain: IWorldTerrain;
  readonly assets: Readonly<Record<string, IWorldAsset>>;
  readonly placements: string;
  readonly cells: readonly IWorldCell[];
}

export interface IWorldPackageValidationOptions {
  /** Byte length of the placement buffer the runs index into. */
  readonly placementsByteLength: number;
  /** When known, the heightmap length must be `columns * rows * 2`. */
  readonly heightmapByteLength?: number;
}

const WORLD_PACKAGE_VERSION = 1;
const PLACEMENT_RECORD_BYTES = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a `world.json` manifest against the v1 contract.
 *
 * Never throws on garbage input: a non-object manifest is `WORLD_MALFORMED`. Every problem is
 * collected, so an exporter sees the complete list at once.
 *
 * @situation check a Blender-exported world package before the runtime attaches anything
 * @situation report why a world package cannot be streamed
 * @constraint validation only checks structure and ranges; it never fetches the heightmap or GLBs
 * @example const { ok, errors } = validateWorldPackage(json, { placementsByteLength: buffer.byteLength });
 */
export function validateWorldPackage(
  manifest: unknown,
  options: IWorldPackageValidationOptions,
): { ok: boolean; errors: IWorldPackageError[] } {
  const errors: IWorldPackageError[] = [];
  const record = (code: WorldPackageErrorCode, path: string, message: string): void => {
    errors.push({ code, message, path });
  };
  const malformed = (path: string, message: string): void => {
    record("WORLD_MALFORMED", path, message);
  };
  const finite = (value: unknown, path: string): number | undefined => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      malformed(path, `${path} must be a finite number.`);
      return undefined;
    }
    return value;
  };
  const positive = (value: unknown, path: string): number | undefined => {
    const number = finite(value, path);
    if (number !== undefined && number <= 0) {
      malformed(path, `${path} must be greater than zero.`);
      return undefined;
    }
    return number;
  };
  const positiveInteger = (value: unknown, path: string): number | undefined => {
    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      malformed(path, `${path} must be a positive integer.`);
      return undefined;
    }
    return value;
  };
  const integer = (value: unknown, path: string): number | undefined => {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      malformed(path, `${path} must be an integer.`);
      return undefined;
    }
    return value;
  };
  const text = (value: unknown, path: string): string | undefined => {
    if (typeof value !== "string" || value.length === 0) {
      malformed(path, `${path} must be a non-empty string.`);
      return undefined;
    }
    return value;
  };

  if (!isRecord(manifest)) {
    malformed("", "World package must be a JSON object.");
    return { errors, ok: false };
  }

  if (typeof manifest.version !== "number") {
    malformed("version", "World package version is required and must be a number.");
  } else if (manifest.version !== WORLD_PACKAGE_VERSION) {
    record(
      "WORLD_VERSION_MISMATCH",
      "version",
      `World package version ${String(manifest.version)} is not supported; expected ${String(WORLD_PACKAGE_VERSION)}.`,
    );
  }

  let extent: IWorldExtent | undefined;
  if (!isRecord(manifest.extent)) {
    malformed("extent", "World package extent is required and must be an object.");
  } else {
    const minX = finite(manifest.extent.minX, "extent.minX");
    const minZ = finite(manifest.extent.minZ, "extent.minZ");
    const sizeX = positive(manifest.extent.sizeX, "extent.sizeX");
    const sizeZ = positive(manifest.extent.sizeZ, "extent.sizeZ");
    if (minX !== undefined && minZ !== undefined && sizeX !== undefined && sizeZ !== undefined)
      extent = { minX, minZ, sizeX, sizeZ };
  }

  const cellSize = positive(manifest.cellSize, "cellSize");

  let terrain: IWorldTerrain | undefined;
  if (!isRecord(manifest.terrain)) {
    malformed("terrain", "World package terrain is required and must be an object.");
  } else {
    const raw = manifest.terrain;
    const heightmap = text(raw.heightmap, "terrain.heightmap");
    const columns = positiveInteger(raw.columns, "terrain.columns");
    const rows = positiveInteger(raw.rows, "terrain.rows");
    const spacing = positive(raw.spacing, "terrain.spacing");
    const heightMin = finite(raw.heightMin, "terrain.heightMin");
    const heightMax = finite(raw.heightMax, "terrain.heightMax");
    let layers: Record<string, string> | undefined;
    if (raw.layers !== undefined) {
      if (!isRecord(raw.layers)) {
        malformed("terrain.layers", "terrain.layers must be an object of string paths.");
      } else {
        layers = {};
        for (const [name, value] of Object.entries(raw.layers)) {
          const path = text(value, `terrain.layers.${name}`);
          if (path !== undefined) layers[name] = path;
        }
      }
    }
    if (extent !== undefined && columns !== undefined && spacing !== undefined) {
      const expected = extent.sizeX / spacing + 1;
      if (columns !== expected)
        malformed(
          "terrain.columns",
          `terrain.columns ${String(columns)} does not match extent.sizeX / spacing + 1 (${String(expected)}).`,
        );
    }
    if (extent !== undefined && rows !== undefined && spacing !== undefined) {
      const expected = extent.sizeZ / spacing + 1;
      if (rows !== expected)
        malformed(
          "terrain.rows",
          `terrain.rows ${String(rows)} does not match extent.sizeZ / spacing + 1 (${String(expected)}).`,
        );
    }
    if (
      heightmap !== undefined &&
      columns !== undefined &&
      rows !== undefined &&
      spacing !== undefined &&
      heightMin !== undefined &&
      heightMax !== undefined
    )
      terrain = {
        columns,
        heightMax,
        heightMin,
        heightmap,
        rows,
        spacing,
        ...(layers === undefined ? {} : { layers }),
      };
  }

  if (options.heightmapByteLength !== undefined && terrain !== undefined) {
    const expected = terrain.columns * terrain.rows * 2;
    if (options.heightmapByteLength !== expected)
      malformed(
        "terrain.heightmap",
        `heightmapByteLength ${String(options.heightmapByteLength)} does not match columns * rows * 2 (${String(expected)}).`,
      );
  }

  const assetIds = new Set<string>();
  if (!isRecord(manifest.assets)) {
    malformed("assets", "World package assets is required and must be an object.");
  } else {
    for (const [id, value] of Object.entries(manifest.assets)) {
      assetIds.add(id);
      const path = `assets.${id}`;
      if (!isRecord(value)) {
        malformed(path, `${path} must be an object.`);
        continue;
      }
      text(value.glb, `${path}.glb`);
      if (!isRecord(value.bounds)) {
        malformed(`${path}.bounds`, `${path}.bounds is required and must be an object.`);
      } else {
        for (const key of ["min", "max"] as const) {
          const corner = value.bounds[key];
          if (
            !Array.isArray(corner) ||
            corner.length !== 3 ||
            corner.some((component) => typeof component !== "number" || !Number.isFinite(component))
          )
            malformed(
              `${path}.bounds.${key}`,
              `${path}.bounds.${key} must be three finite numbers.`,
            );
        }
      }
      if (value.lods !== undefined) {
        if (!Array.isArray(value.lods)) {
          malformed(`${path}.lods`, `${path}.lods must be an array.`);
        } else {
          value.lods.forEach((lod, index) => {
            const lodPath = `${path}.lods[${index}]`;
            if (!isRecord(lod)) {
              malformed(lodPath, `${lodPath} must be an object.`);
              return;
            }
            text(lod.glb, `${lodPath}.glb`);
            finite(lod.distance, `${lodPath}.distance`);
          });
        }
      }
      if (value.maxDistance !== undefined) finite(value.maxDistance, `${path}.maxDistance`);
    }
  }

  text(manifest.placements, "placements");

  const maximumCellX =
    extent !== undefined && cellSize !== undefined ? Math.ceil(extent.sizeX / cellSize) : undefined;
  const maximumCellZ =
    extent !== undefined && cellSize !== undefined ? Math.ceil(extent.sizeZ / cellSize) : undefined;

  if (!Array.isArray(manifest.cells)) {
    malformed("cells", "World package cells is required and must be an array.");
  } else {
    manifest.cells.forEach((cell, cellIndex) => {
      const path = `cells[${cellIndex}]`;
      if (!isRecord(cell)) {
        malformed(path, `${path} must be an object.`);
        return;
      }
      const x = integer(cell.x, `${path}.x`);
      const z = integer(cell.z, `${path}.z`);
      if (x !== undefined && (x < 0 || (maximumCellX !== undefined && x >= maximumCellX)))
        record(
          "WORLD_CELL_OUTSIDE_EXTENT",
          `${path}.x`,
          `Cell x ${String(x)} is outside the world extent.`,
        );
      if (z !== undefined && (z < 0 || (maximumCellZ !== undefined && z >= maximumCellZ)))
        record(
          "WORLD_CELL_OUTSIDE_EXTENT",
          `${path}.z`,
          `Cell z ${String(z)} is outside the world extent.`,
        );
      if (cell.chunks !== undefined) {
        if (
          !Array.isArray(cell.chunks) ||
          cell.chunks.some((chunk) => typeof chunk !== "string" || chunk.length === 0)
        )
          malformed(`${path}.chunks`, `${path}.chunks must be an array of non-empty strings.`);
      }
      if (cell.proxy !== undefined) {
        const proxyPath = `${path}.proxy`;
        if (!isRecord(cell.proxy)) malformed(proxyPath, `${proxyPath} must be an object.`);
        else {
          const proxy = cell.proxy;
          text(proxy.glb, `${proxyPath}.glb`);
          const error = finite(proxy.error, `${proxyPath}.error`);
          if (error !== undefined && error < 0)
            malformed(`${proxyPath}.error`, "Proxy error must be non-negative.");
          for (const name of [
            "triangles",
            "materialGroups",
            "sourceTriangles",
            "sourcePrimitives",
          ] as const) {
            if (
              proxy[name] === undefined &&
              (name === "sourceTriangles" || name === "sourcePrimitives")
            )
              continue;
            const value = positiveInteger(proxy[name], `${proxyPath}.${name}`);
            if (value !== undefined && !Number.isSafeInteger(value))
              malformed(`${proxyPath}.${name}`, "Proxy counts must be safe integers.");
          }
          if (proxy.scope !== undefined && proxy.scope !== "cell" && proxy.scope !== "chunks")
            malformed(`${proxyPath}.scope`, "Proxy scope must be cell or chunks.");
          if (proxy.bounds !== undefined) {
            if (
              !isRecord(proxy.bounds) ||
              !Array.isArray(proxy.bounds.min) ||
              !Array.isArray(proxy.bounds.max) ||
              proxy.bounds.min.length !== 3 ||
              proxy.bounds.max.length !== 3
            )
              malformed(`${proxyPath}.bounds`, "Proxy bounds must contain min and max triples.");
            else
              for (let axis = 0; axis < 3; axis += 1) {
                const low = finite(proxy.bounds.min[axis], `${proxyPath}.bounds.min[${axis}]`);
                const high = finite(proxy.bounds.max[axis], `${proxyPath}.bounds.max[${axis}]`);
                if (low !== undefined && high !== undefined && low > high)
                  malformed(`${proxyPath}.bounds`, "Proxy bounds are inverted.");
              }
          }
        }
      }
      if (!Array.isArray(cell.runs)) {
        malformed(`${path}.runs`, `${path}.runs is required and must be an array.`);
        return;
      }
      cell.runs.forEach((run, runIndex) => {
        const runPath = `${path}.runs[${runIndex}]`;
        if (!isRecord(run)) {
          malformed(runPath, `${runPath} must be an object.`);
          return;
        }
        if (typeof run.asset !== "string" || !assetIds.has(run.asset))
          record(
            "WORLD_UNKNOWN_ASSET",
            `${runPath}.asset`,
            `Run references unknown asset '${String(run.asset)}'.`,
          );
        if (typeof run.offset !== "number") {
          malformed(`${runPath}.offset`, `${runPath}.offset must be a number.`);
          return;
        }
        if (typeof run.count !== "number") {
          malformed(`${runPath}.count`, `${runPath}.count must be a number.`);
          return;
        }
        if (
          !Number.isInteger(run.offset) ||
          !Number.isInteger(run.count) ||
          run.offset < 0 ||
          run.count < 0
        )
          record(
            "WORLD_RUN_OUT_OF_RANGE",
            runPath,
            `${runPath} offset and count must be non-negative integers.`,
          );
        else if ((run.offset + run.count) * PLACEMENT_RECORD_BYTES > options.placementsByteLength)
          record(
            "WORLD_RUN_OUT_OF_RANGE",
            runPath,
            `${runPath} reaches past the ${String(options.placementsByteLength)}-byte placement buffer.`,
          );
      });
    });
  }

  return { errors, ok: errors.length === 0 };
}

/**
 * Borrow the run's placement records as a live view over the placement buffer.
 *
 * @situation feed one cell's instance transforms into a batch without copying
 * @constraint the returned view aliases the caller's buffer; writing to it mutates the source
 * @example const records = cellPlacements(buffer, { asset: "tree", offset: 0, count: 120 });
 */
export function cellPlacements(placements: ArrayBuffer, run: IWorldRun): Float32Array {
  if (
    !Number.isInteger(run.offset) ||
    !Number.isInteger(run.count) ||
    run.offset < 0 ||
    run.count < 0
  )
    throw new RangeError("Placement run offset and count must be non-negative integers.");
  const start = run.offset * PLACEMENT_RECORD_BYTES;
  const length = run.count * PLACEMENT_RECORD_BYTES;
  if (start + length > placements.byteLength)
    throw new RangeError(
      `Placement run [${String(run.offset)}, ${String(run.offset + run.count)}) reaches past the ${String(placements.byteLength)}-byte buffer.`,
    );
  return new Float32Array(placements, start, run.count * (PLACEMENT_RECORD_BYTES / 4));
}
