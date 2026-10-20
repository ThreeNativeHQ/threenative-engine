#include "engine/world/package/world_package.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>

namespace tn::engine::world {

namespace {

constexpr double kWorldPackageVersion = 1.0;
constexpr double kPlacementRecordBytes = 32.0;

// JavaScript distinctions json.h leaves to us: an absent key is `undefined` (not JSON null), and
// `typeof` is the reader's kind. A JSON number is binary64, so Number.isInteger is a finite double
// with no fractional part. Object member order is JavaScript's (jsEntries below).
bool isRecord(const json::Value* value) { return value != nullptr && value->isObject(); }

bool isNumber(const json::Value* value) { return value != nullptr && value->isNumber(); }

bool isFiniteNumber(const json::Value* value) { return isNumber(value) && std::isfinite(value->number()); }

bool isInteger(const json::Value* value) {
    if (!isNumber(value))
        return false;
    const double number = value->number();
    return std::isfinite(number) && std::floor(number) == number;
}

// Object.entries order: array-index keys (canonical decimal below 2^32 - 1) ascending, then every
// other key in insertion order. json.h keeps insertion order only.
std::optional<uint32_t> arrayIndex(const std::string& key) {
    if (key.empty() || key.size() > 10 || (key.size() > 1 && key[0] == '0'))
        return std::nullopt;
    uint64_t value = 0;
    for (const char c : key) {
        if (c < '0' || c > '9')
            return std::nullopt;
        value = value * 10 + static_cast<uint64_t>(c - '0');
    }
    if (value >= 4294967295u)
        return std::nullopt;
    return static_cast<uint32_t>(value);
}

std::vector<const std::pair<std::string, json::Value>*> jsEntries(const json::Value& object) {
    std::vector<const std::pair<std::string, json::Value>*> indexed, named;
    for (const auto& member : object.members())
        (arrayIndex(member.first) ? indexed : named).push_back(&member);
    std::stable_sort(indexed.begin(), indexed.end(),
                     [](const auto* a, const auto* b) { return *arrayIndex(a->first) < *arrayIndex(b->first); });
    indexed.insert(indexed.end(), named.begin(), named.end());
    return indexed;
}

/** JavaScript's String(value); an absent value is `undefined`, and an array joins as Array.prototype.toString. */
std::string jsArrayString(const json::Value& value);
std::string jsString(const json::Value* value) {
    if (value == nullptr)
        return "undefined";
    switch (value->kind()) {
    case json::Value::Kind::Null:
        return "null";
    case json::Value::Kind::Bool:
        return value->boolean() ? "true" : "false";
    case json::Value::Kind::Number:
        return json::numberToString(value->number());
    case json::Value::Kind::String:
        return value->string();
    case json::Value::Kind::Array:
        return jsArrayString(*value);
    case json::Value::Kind::Object:
        return "[object Object]";
    }
    return "undefined";
}

// Array.prototype.join: null and undefined elements become empty, nested arrays recurse, objects are
// "[object Object]".
std::string jsArrayString(const json::Value& value) {
    std::string out;
    const auto& items = value.items();
    for (std::size_t i = 0; i < items.size(); ++i) {
        if (i)
            out += ',';
        if (items[i].isNull())
            continue;
        out += jsString(&items[i]);
    }
    return out;
}

class Validator {
  public:
    Validator(const json::Value& manifest, const WorldPackageOptions& options) : manifest_(manifest), options_(options) {}

    std::vector<WorldPackageError> run() {
        if (!isRecord(&manifest_)) {
            malformed("", "World package must be a JSON object.");
            return std::move(errors_);
        }
        version();
        extent();
        cellSize_ = positive(member("cellSize"), "cellSize");
        cellSizeValid_ = cellSize_ > 0.0;
        terrain();
        if (options_.hasHeightmapByteLength && terrainValid_)
            heightmapByteLength();
        assets();
        text(member("placements"), "placements");
        cells();
        return std::move(errors_);
    }

  private:
    const json::Value* member(std::string_view key) const { return manifest_.find(key); }

    void record(std::string code, std::string path, std::string message) {
        errors_.push_back(WorldPackageError{std::move(code), std::move(path), std::move(message)});
    }
    void malformed(const std::string& path, const std::string& message) { record("WORLD_MALFORMED", path, message); }

    double finite(const json::Value* value, const std::string& path, bool& ok) {
        if (!isFiniteNumber(value)) {
            malformed(path, path + " must be a finite number.");
            ok = false;
            return 0.0;
        }
        ok = true;
        return value->number();
    }
    double positive(const json::Value* value, const std::string& path) {
        bool ok = false;
        const double number = finite(value, path, ok);
        if (!ok)
            return 0.0;
        if (number <= 0) {
            malformed(path, path + " must be greater than zero.");
            return 0.0;
        }
        return number;
    }
    double positiveInteger(const json::Value* value, const std::string& path, bool& ok) {
        if (!isInteger(value) || value->number() <= 0) {
            malformed(path, path + " must be a positive integer.");
            ok = false;
            return 0.0;
        }
        ok = true;
        return value->number();
    }
    double integer(const json::Value* value, const std::string& path, bool& ok) {
        if (!isInteger(value)) {
            malformed(path, path + " must be an integer.");
            ok = false;
            return 0.0;
        }
        ok = true;
        return value->number();
    }
    std::string text(const json::Value* value, const std::string& path, bool& ok) {
        if (!value || !value->isString() || value->string().empty()) {
            malformed(path, path + " must be a non-empty string.");
            ok = false;
            return {};
        }
        ok = true;
        return value->string();
    }
    std::string text(const json::Value* value, const std::string& path) {
        bool ok = false;
        return text(value, path, ok);
    }

    void version() {
        const json::Value* value = member("version");
        if (!isNumber(value)) {
            malformed("version", "World package version is required and must be a number.");
        } else if (value->number() != kWorldPackageVersion) {
            record("WORLD_VERSION_MISMATCH", "version",
                   "World package version " + jsString(value) + " is not supported; expected " +
                       json::numberToString(kWorldPackageVersion) + ".");
        }
    }

    void extent() {
        const json::Value* record0 = member("extent");
        if (!isRecord(record0)) {
            malformed("extent", "World package extent is required and must be an object.");
            return;
        }
        bool okMinX = false, okMinZ = false, okSizeX = false, okSizeZ = false;
        const double minX = finite(record0->find("minX"), "extent.minX", okMinX);
        const double minZ = finite(record0->find("minZ"), "extent.minZ", okMinZ);
        const double sizeX = positive(record0->find("sizeX"), "extent.sizeX");
        const double sizeZ = positive(record0->find("sizeZ"), "extent.sizeZ");
        okSizeX = sizeX > 0;
        okSizeZ = sizeZ > 0;
        if (okMinX && okMinZ && okSizeX && okSizeZ) {
            extentValid_ = true;
            extentSizeX_ = sizeX;
            extentSizeZ_ = sizeZ;
        }
    }

    void terrain() {
        const json::Value* raw = member("terrain");
        if (!isRecord(raw)) {
            malformed("terrain", "World package terrain is required and must be an object.");
            return;
        }
        bool okHeightmap = false, okColumns = false, okRows = false, okMin = false, okMax = false;
        const std::string heightmap = text(raw->find("heightmap"), "terrain.heightmap", okHeightmap);
        const double columns = positiveInteger(raw->find("columns"), "terrain.columns", okColumns);
        const double rows = positiveInteger(raw->find("rows"), "terrain.rows", okRows);
        const double spacing = positive(raw->find("spacing"), "terrain.spacing");
        const bool okSpacing = spacing > 0;
        const double heightMin = finite(raw->find("heightMin"), "terrain.heightMin", okMin);
        const double heightMax = finite(raw->find("heightMax"), "terrain.heightMax", okMax);
        const json::Value* layers = raw->find("layers");
        if (layers != nullptr) {
            if (!layers->isObject()) {
                malformed("terrain.layers", "terrain.layers must be an object of string paths.");
            } else {
                for (const auto* entry : jsEntries(*layers))
                    text(&entry->second, "terrain.layers." + entry->first);
            }
        }
        if (extentValid_ && okColumns && okSpacing) {
            const double expected = extentSizeX_ / spacing + 1.0;
            if (columns != expected)
                malformed("terrain.columns",
                          "terrain.columns " + json::numberToString(columns) +
                              " does not match extent.sizeX / spacing + 1 (" + json::numberToString(expected) + ").");
        }
        if (extentValid_ && okRows && okSpacing) {
            const double expected = extentSizeZ_ / spacing + 1.0;
            if (rows != expected)
                malformed("terrain.rows",
                          "terrain.rows " + json::numberToString(rows) +
                              " does not match extent.sizeZ / spacing + 1 (" + json::numberToString(expected) + ").");
        }
        if (okHeightmap && okColumns && okRows && okSpacing && okMin && okMax) {
            terrainValid_ = true;
            terrainColumns_ = columns;
            terrainRows_ = rows;
        }
    }

    void heightmapByteLength() {
        const double expected = terrainColumns_ * terrainRows_ * 2.0;
        if (options_.heightmapByteLength != expected)
            malformed("terrain.heightmap",
                      "heightmapByteLength " + json::numberToString(options_.heightmapByteLength) +
                          " does not match columns * rows * 2 (" + json::numberToString(expected) + ").");
    }

    void assets() {
        const json::Value* value = member("assets");
        if (!isRecord(value)) {
            malformed("assets", "World package assets is required and must be an object.");
            return;
        }
        for (const auto* entry : jsEntries(*value)) {
            const std::string& id = entry->first;
            const json::Value& asset = entry->second;
            assetIds_.push_back(id);
            const std::string path = "assets." + id;
            if (!asset.isObject()) {
                malformed(path, path + " must be an object.");
                continue;
            }
            text(asset.find("glb"), path + ".glb");
            assetBounds(asset, path);
            assetLods(asset, path);
            if (asset.find("maxDistance") != nullptr)
                finite(asset.find("maxDistance"), path + ".maxDistance", ignored_);
        }
    }

    void assetBounds(const json::Value& asset, const std::string& path) {
        const json::Value* bounds = asset.find("bounds");
        if (!isRecord(bounds)) {
            malformed(path + ".bounds", path + ".bounds is required and must be an object.");
            return;
        }
        for (const char* key : {"min", "max"}) {
            const json::Value* corner = bounds->find(key);
            const std::string cornerPath = path + ".bounds." + key;
            bool bad = !corner || !corner->isArray() || corner->items().size() != 3;
            if (!bad)
                for (const json::Value& component : corner->items())
                    if (!isFiniteNumber(&component)) {
                        bad = true;
                        break;
                    }
            if (bad)
                malformed(cornerPath, cornerPath + " must be three finite numbers.");
        }
    }

    void assetLods(const json::Value& asset, const std::string& path) {
        const json::Value* lods = asset.find("lods");
        if (lods == nullptr)
            return;
        if (!lods->isArray()) {
            malformed(path + ".lods", path + ".lods must be an array.");
            return;
        }
        const auto& items = lods->items();
        for (std::size_t index = 0; index < items.size(); ++index) {
            const std::string lodPath = path + ".lods[" + std::to_string(index) + "]";
            if (!items[index].isObject()) {
                malformed(lodPath, lodPath + " must be an object.");
                continue;
            }
            text(items[index].find("glb"), lodPath + ".glb");
            finite(items[index].find("distance"), lodPath + ".distance", ignored_);
        }
    }

    void cells() {
        const json::Value* value = member("cells");
        if (value == nullptr || !value->isArray()) {
            malformed("cells", "World package cells is required and must be an array.");
            return;
        }
        const bool hasMaximum = extentValid_ && cellSizeValid_;
        const double maximumCellX = hasMaximum ? std::ceil(extentSizeX_ / cellSize_) : 0.0;
        const double maximumCellZ = hasMaximum ? std::ceil(extentSizeZ_ / cellSize_) : 0.0;
        const auto& items = value->items();
        for (std::size_t index = 0; index < items.size(); ++index) {
            const json::Value& cell = items[index];
            const std::string path = "cells[" + std::to_string(index) + "]";
            if (!cell.isObject()) {
                malformed(path, path + " must be an object.");
                continue;
            }
            bool okX = false, okZ = false;
            const double x = integer(cell.find("x"), path + ".x", okX);
            const double z = integer(cell.find("z"), path + ".z", okZ);
            if (okX && (x < 0 || (hasMaximum && x >= maximumCellX)))
                record("WORLD_CELL_OUTSIDE_EXTENT", path + ".x",
                       "Cell x " + json::numberToString(x) + " is outside the world extent.");
            if (okZ && (z < 0 || (hasMaximum && z >= maximumCellZ)))
                record("WORLD_CELL_OUTSIDE_EXTENT", path + ".z",
                       "Cell z " + json::numberToString(z) + " is outside the world extent.");
            const json::Value* chunks = cell.find("chunks");
            if (chunks != nullptr) {
                bool bad = !chunks->isArray();
                if (!bad)
                    for (const json::Value& chunk : chunks->items())
                        if (!chunk.isString() || chunk.string().empty()) {
                            bad = true;
                            break;
                        }
                if (bad)
                    malformed(path + ".chunks", path + ".chunks must be an array of non-empty strings.");
            }
            const json::Value* runs = cell.find("runs");
            if (runs == nullptr || !runs->isArray()) {
                malformed(path + ".runs", path + ".runs is required and must be an array.");
                continue;
            }
            const auto& runItems = runs->items();
            for (std::size_t runIndex = 0; runIndex < runItems.size(); ++runIndex) {
                const json::Value& run = runItems[runIndex];
                const std::string runPath = path + ".runs[" + std::to_string(runIndex) + "]";
                if (!run.isObject()) {
                    malformed(runPath, runPath + " must be an object.");
                    continue;
                }
                runAsset(run, runPath);
            }
        }
    }

    void runAsset(const json::Value& run, const std::string& runPath) {
        const json::Value* asset = run.find("asset");
        bool known = asset != nullptr && asset->isString();
        if (known) {
            known = false;
            for (const std::string& id : assetIds_)
                if (id == asset->string()) {
                    known = true;
                    break;
                }
        }
        if (!known)
            record("WORLD_UNKNOWN_ASSET", runPath + ".asset",
                   "Run references unknown asset '" + jsString(asset) + "'.");
        const json::Value* offset = run.find("offset");
        if (!isNumber(offset)) {
            malformed(runPath + ".offset", runPath + ".offset must be a number.");
            return;
        }
        const json::Value* count = run.find("count");
        if (!isNumber(count)) {
            malformed(runPath + ".count", runPath + ".count must be a number.");
            return;
        }
        if (!isInteger(offset) || !isInteger(count) || offset->number() < 0 || count->number() < 0) {
            record("WORLD_RUN_OUT_OF_RANGE", runPath, runPath + " offset and count must be non-negative integers.");
        } else if ((offset->number() + count->number()) * kPlacementRecordBytes > options_.placementsByteLength) {
            record("WORLD_RUN_OUT_OF_RANGE", runPath,
                   runPath + " reaches past the " + json::numberToString(options_.placementsByteLength) +
                       "-byte placement buffer.");
        }
    }

    const json::Value& manifest_;
    const WorldPackageOptions& options_;
    std::vector<WorldPackageError> errors_;
    std::vector<std::string> assetIds_;
    bool extentValid_ = false;
    double extentSizeX_ = 0.0;
    double extentSizeZ_ = 0.0;
    double cellSize_ = 0.0;
    bool cellSizeValid_ = false;
    bool terrainValid_ = false;
    double terrainColumns_ = 0.0;
    double terrainRows_ = 0.0;
    bool ignored_ = false;
};

} // namespace

std::vector<WorldPackageError> validateWorldPackage(const json::Value& manifest, const WorldPackageOptions& options) {
    return Validator(manifest, options).run();
}

std::optional<std::vector<float>> cellPlacements(std::span<const std::byte> placements, const PlacementRun& run,
                                                 std::string& error) {
    if (!std::isfinite(run.offset) || !std::isfinite(run.count) || std::floor(run.offset) != run.offset ||
        std::floor(run.count) != run.count || run.offset < 0 || run.count < 0) {
        error.assign(kPlacementRunRangeCode);
        return std::nullopt;
    }
    const double start = run.offset * kPlacementRecordBytes;
    const double length = run.count * kPlacementRecordBytes;
    if (start + length > static_cast<double>(placements.size())) {
        error.assign(kPlacementRunBoundsCode);
        return std::nullopt;
    }
    const std::size_t floatCount = static_cast<std::size_t>(run.count) * 8;
    std::vector<float> out(floatCount);
    // The host reads the placement buffer as little-endian float32, as Float32Array does.
    for (std::size_t i = 0; i < floatCount; ++i) {
        float value = 0.0f;
        std::memcpy(&value, placements.data() + static_cast<std::size_t>(start) + i * 4, sizeof value);
        out[i] = value;
    }
    return out;
}

} // namespace tn::engine::world
