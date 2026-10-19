#pragma once

#include "engine/foundation/json.h"

#include <cstddef>
#include <optional>
#include <span>
#include <string>
#include <vector>

namespace tn::engine::world {

/**
 * The `world.json` v1 package contract from packages/core/src/world-package.ts (PRD-521 phase 1):
 * `validateWorldPackage` collects every defect in the same order with the same code, path and
 * message as the reference, and `cellPlacements` borrows one run's placement records. Validation
 * never throws on malformed JSON-shaped input; a refused run is a named code, not a throw.
 */
struct WorldPackageOptions {
    /** Byte length of the placement buffer the runs index into. */
    double placementsByteLength = 0.0;
    /** When known, the heightmap length must be `columns * rows * 2`. */
    bool hasHeightmapByteLength = false;
    double heightmapByteLength = 0.0;
};

/** One collected defect; empty `errors` means the manifest is valid. */
struct WorldPackageError {
    std::string code;
    /** JSON-shaped path to the offending field, e.g. `cells[2].runs[0].offset`. */
    std::string path;
    std::string message;
};

/**
 * Validate a parsed `world.json` manifest against the v1 contract. A non-object manifest is
 * `WORLD_MALFORMED` at path "". Every problem is collected, so an exporter sees the complete list.
 */
std::vector<WorldPackageError> validateWorldPackage(const json::Value& manifest, const WorldPackageOptions& options);

/** One placement run; only `offset` and `count` reach `cellPlacements`. */
struct PlacementRun {
    double offset = 0.0;
    double count = 0.0;
};

/** A run whose offset/count are not non-negative integers is refused by this name. */
inline constexpr std::string_view kPlacementRunRangeCode = "TN_WORLD_PLACEMENT_RANGE";
/** A run that reaches past the placement buffer is refused by this name. */
inline constexpr std::string_view kPlacementRunBoundsCode = "TN_WORLD_PLACEMENT_BOUNDS";

/**
 * Borrow the run's placement records as a live view over `placements` (the caller's stale data is
 * read as float32, little-endian). A refused run returns nullopt and sets `error` to a named code
 * instead of throwing, as `cellPlacements` throws a RangeError.
 */
std::optional<std::vector<float>> cellPlacements(std::span<const std::byte> placements, const PlacementRun& run,
                                                 std::string& error);

} // namespace tn::engine::world
