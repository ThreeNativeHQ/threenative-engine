// PRD-521 box 38: every recorded tile-admission, LOD and collider decision reproduces over the native
// TerrainTiles port. The table is generated from packages/core/src/world-tiles.ts
// (packages/runtime-native/tests/native-engine/world/world-tiles-reference.ts): each scene is one
// spec's options, the field grids its tiles read, and a scripted follow path; the reference records
// which tiles are resident and in what order, each tile's bytes, LOD level, per-level resolutions and
// collider body with its exact collider-order heights, the body's create/hand-back sequence, the
// bridges the mixed-LOD pairs need, the peaks, the deferral count and the transition count. Every
// f32 is its 32-bit pattern and every double its 64-bit pattern, and the comparison is exact.
#include "check.h"
#include "engine/world/tiles/terrain_tiles.h"

#include <bit>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <functional>
#include <optional>
#include <string>
#include <vector>

#include "world_tiles_reference.h"

namespace {

/** Bit-exact, except that every NaN is the same value: the reference is JavaScript. */
bool sameFloat(float got, float want) {
    return std::bit_cast<uint32_t>(got) == std::bit_cast<uint32_t>(want) ||
           (std::isnan(got) && std::isnan(want));
}

std::vector<std::string> keysOf(const char* const* keys, uint32_t count) {
    std::vector<std::string> out;
    out.reserve(count);
    for (uint32_t index = 0; index < count; index += 1) out.emplace_back(keys[index]);
    return out;
}

/** The recorded outcome as the port's own: 0 admitted, 1 threw, 2 refused a tile, 3 the stitched cap. */
bool outcomeMatches(uint32_t recorded, bool followOk, TerrainTileBudgetReason reason) {
    if (recorded == 0) return followOk && reason == TerrainTileBudgetReason::kNone;
    if (recorded == 1) return !followOk && reason == TerrainTileBudgetReason::kNone;
    if (recorded == 2) return !followOk && reason == TerrainTileBudgetReason::kTile;
    return !followOk && reason == TerrainTileBudgetReason::kStitch;
}

void compareStep(const RefScene& scene, uint32_t stepIndex, const RefStep& step, TerrainTiles& tiles,
                 std::size_t& compared, std::size_t& mismatched) {
    const std::vector<std::string> resident = tiles.residentKeys();
    const std::vector<std::string> insertion = tiles.residentKeysInOrder();
    const std::vector<std::string> colliders = tiles.residentColliderKeys();
    bool ok = resident.size() == step.residentCount && insertion.size() == step.insertionCount &&
              colliders.size() == step.colliderCount;
    if (ok)
        ok = resident == keysOf(step.resident, step.residentCount) &&
             insertion == keysOf(step.insertion, step.insertionCount) &&
             colliders == keysOf(step.colliders, step.colliderCount);
    if (!ok) {
        if (mismatched < 8)
            std::fprintf(stderr, "%s step %u: residency %zu/%u insertion %zu/%u colliders %zu/%u\n",
                         scene.name, stepIndex, resident.size(), step.residentCount, insertion.size(),
                         step.insertionCount, colliders.size(), step.colliderCount);
        ++mismatched;
    }
    ++compared;

    if (tiles.residentBytes() != step.residentBytes || tiles.stitchBytes() != step.stitchBytes ||
        tiles.stitches().size() != step.bridges || tiles.peakResidentBytes() != step.peakBytes ||
        tiles.peakResidentTileCount() != step.peakTiles ||
        tiles.lodTransitions() != step.lodTransitions || tiles.blendingTiles() != step.blendingTiles) {
        std::fprintf(stderr,
                     "%s step %u: bytes %llu/%llu stitch %llu/%llu bridges %zu/%u peaks %llu/%llu %u/%u "
                     "transitions %u/%u blending %u/%u\n",
                     scene.name, stepIndex, (unsigned long long)tiles.residentBytes(),
                     (unsigned long long)step.residentBytes, (unsigned long long)tiles.stitchBytes(),
                     (unsigned long long)step.stitchBytes, tiles.stitches().size(), step.bridges,
                     (unsigned long long)tiles.peakResidentBytes(), (unsigned long long)step.peakBytes,
                     tiles.peakResidentTileCount(), step.peakTiles, tiles.lodTransitions(),
                     step.lodTransitions, tiles.blendingTiles(), step.blendingTiles);
        ++mismatched;
    }
    ++compared;

    if (tiles.deferredAdmissions() != step.deferredAdmissions) {
        std::fprintf(stderr, "%s step %u: deferred %u/%u\n", scene.name, stepIndex,
                     tiles.deferredAdmissions(), step.deferredAdmissions);
        ++mismatched;
    }
    ++compared;

    const std::vector<ITerrainColliderEvent> events = tiles.takeColliderEvents();
    bool eventsOk = events.size() == step.eventCount;
    if (eventsOk)
        for (uint32_t index = 0; index < step.eventCount; index += 1)
            if (events[index].key != step.events[index].key ||
                events[index].created != (step.events[index].created != 0)) {
                eventsOk = false;
                break;
            }
    if (!eventsOk) {
        std::fprintf(stderr, "%s step %u: %zu collider events, recorded %u\n", scene.name, stepIndex,
                     events.size(), step.eventCount);
        ++mismatched;
    }
    ++compared;

    if (tiles.residentTileCount() != step.tileCount) {
        std::fprintf(stderr, "%s step %u: %u tiles, recorded %u\n", scene.name, stepIndex,
                     tiles.residentTileCount(), step.tileCount);
        ++mismatched;
    }
    ++compared;

    for (uint32_t index = 0; index < step.tileCount; index += 1) {
        const RefTile& ref = step.tiles[index];
        const char* const* order = step.insertion;
        // The recorded tiles are sorted by key; look each one up by its own coordinates.
        const std::string key = std::to_string(ref.tileX) + ":" + std::to_string(ref.tileZ);
        const ITerrainTileInfo* info = tiles.tile(key);
        (void)order;
        ++compared;
        if (info == nullptr) {
            std::fprintf(stderr, "%s step %u: no resident tile '%s'\n", scene.name, stepIndex, key.c_str());
            ++mismatched;
            continue;
        }
        bool tileOk = info->bytes == ref.bytes && info->lodLevel == ref.lodLevel &&
                      info->resolutions.size() == ref.resolutionCount &&
                      info->hasCollider == (ref.hasCollider != 0) &&
                      info->colliderHeights.size() == ref.colliderCount;
        if (tileOk)
            for (uint32_t level = 0; level < ref.resolutionCount; level += 1)
                if (info->resolutions[level] != ref.resolutions[level]) {
                    tileOk = false;
                    break;
                }
        for (uint32_t sample = 0; tileOk && sample < ref.colliderCount; sample += 1)
            if (!sameFloat(info->colliderHeights[sample], floatFromBits(ref.colliderHeights[sample]))) {
                tileOk = false;
                break;
            }
        if (!tileOk) {
            std::fprintf(stderr, "%s step %u tile '%s': bytes %llu/%llu lod %u/%u collider %d/%u\n",
                         scene.name, stepIndex, key.c_str(), (unsigned long long)info->bytes,
                         (unsigned long long)ref.bytes, info->lodLevel, ref.lodLevel,
                         info->hasCollider ? 1 : 0, ref.colliderCount);
            ++mismatched;
        }
    }
}

void worldTiles() {
    std::size_t compared = 0;
    std::size_t mismatched = 0;

    for (const RefScene& scene : kWorldTileScenes) {
        RecordedHeights heights(scene.grids, scene.gridCount);
        const ITerrainTilesOptions options = buildOptions(scene.options);
        std::string error;
        std::optional<TerrainTiles> owner = TerrainTiles::create(options, heights, error);
        if (scene.refusal != 0) {
            ++compared;
            if (owner.has_value()) {
                std::fprintf(stderr, "%s: the port accepted options the core refused\n", scene.name);
                ++mismatched;
            }
            continue;
        }
        if (!owner.has_value()) {
            std::fprintf(stderr, "%s: the port refused valid options (%s)\n", scene.name, error.c_str());
            ++mismatched;
            continue;
        }

        uint32_t refusedAt = scene.stepCount;
        for (uint32_t index = 0; index < scene.stepCount; index += 1) {
            const RefStep& step = scene.steps[index];
            // A step with an allowance is the frame's admission budget; a step without one spends
            // nothing and admits as freely as it wants, exactly as `follow(undefined)` does.
            uint32_t spent = 0;
            const TerrainTileAdmission admission =
                step.units == 0 ? TerrainTileAdmission{}
                                : TerrainTileAdmission{[&](const std::function<void()>& work) {
                                      if (spent >= step.units) return false;
                                      spent += 1;
                                      work();
                                      return true;
                                  }};
            TerrainTileBudgetReason reason = TerrainTileBudgetReason::kNone;
            const bool followOk =
                owner->follow(doubleFromBits(step.x), doubleFromBits(step.z), admission, error, reason);
            if (!outcomeMatches(step.outcome, followOk, reason)) {
                std::fprintf(stderr, "%s step %u: outcome %d, recorded %u (reason %u)\n", scene.name,
                             index, followOk ? 0 : static_cast<int>(reason), step.outcome,
                             static_cast<unsigned>(reason));
                ++mismatched;
            }
            ++compared;
            for (uint32_t frame = 0; frame < step.processes; frame += 1) owner->process();
            // A refused follow leaves the ring as the core left it; the next recorded step then
            // replays onto the same ring, so nothing is skipped.
            if (!followOk && refusedAt == scene.stepCount) refusedAt = index;
            compareStep(scene, index, step, *owner, compared, mismatched);
        }
        owner->dispose();
    }

    std::printf("world tiles: %zu observations, %zu differ\n", compared, mismatched);
    CHECK(compared > 0 && mismatched == 0);
}

} // namespace

TN_TEST_MAIN({"world_tiles", worldTiles})