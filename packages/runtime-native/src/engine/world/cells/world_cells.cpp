#include "engine/world/cells/world_cells.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <numeric>

namespace tn::engine::world {
namespace {
double distance(double x, double z) {
    // V8's two-argument Math.hypot operation order, as in the existing GPU-scene CPU oracle.
    const double high = std::max(std::abs(x), std::abs(z));
    const double low = std::min(std::abs(x), std::abs(z));
    if (!std::isfinite(high) || high == 0) return high;
    const double ratio = low / high;
    return high * std::sqrt(1 + ratio * ratio);
}
bool integer(double value, bool positive) {
    return std::isfinite(value) && std::floor(value) == value && (positive ? value > 0 : value >= 0);
}
std::string key(double x, double z) { return json::numberToString(x) + ":" + json::numberToString(z); }
struct Budget {
    double limit, spent = 0;
    const std::function<double()>& now;
    bool admit(const std::function<void()>& work) {
        if (spent >= limit) return false;
        const double start = now();
        work();
        spent += now() - start;
        return true;
    }
};
}

std::optional<WorldCells> WorldCells::create(const json::Value& manifest,
    std::span<const std::byte> placements, const IWorldCellsOptions& o,
    TerrainTiles* terrain, std::string& error) {
    error.clear();
    WorldPackageOptions validation;
    validation.placementsByteLength = static_cast<double>(placements.size());
    const auto defects = validateWorldPackage(manifest, validation);
    if (!defects.empty()) { error = defects.front().code; return std::nullopt; }
    for (const auto& [name, value] : std::vector<std::pair<std::string, double>>{
        {"budgets.bytes", o.bytes}, {"budgets.instances", o.instances},
        {"budgets.residentCells", o.residentCells}, {"rebuildsPerUpdate", o.rebuildsPerUpdate},
        {"concurrency", o.concurrency}, {"chunkMergeMaxTriangles", o.chunkMergeMaxTriangles}}) {
        if (!integer(value, true)) { error = name; return std::nullopt; }
    }
    if (!integer(o.ring, false)) error = "ring";
    else if (!(o.admissionBudgetMs > 0)) error = "admissionBudgetMs";
    else if (!std::isfinite(o.prefetchSeconds) || o.prefetchSeconds < 0) error = "prefetchSeconds";
    else if (!std::isfinite(o.fovY) || o.fovY <= 0 || o.fovY >= 180) error = "autoLod.fovY";
    else if (!std::isfinite(o.viewportHeight) || o.viewportHeight <= 0) error = "autoLod.viewportHeight";
    else if (!std::isfinite(o.maxPixelError) || o.maxPixelError <= 0) error = "autoLod.maxPixelError";
    if (!error.empty()) return std::nullopt;
    WorldCells owner;
    owner.options_ = o;
    owner.terrain_ = terrain;
    owner.cellSize_ = manifest.find("cellSize")->number();
    owner.minX_ = manifest.find("extent")->find("minX")->number();
    owner.minZ_ = manifest.find("extent")->find("minZ")->number();
    for (const auto& [id, def] : manifest.find("assets")->members()) {
        Asset asset;
        asset.id = id;
        asset.distances.push_back(0);
        if (const auto* cap = def.find("maxDistance")) asset.maxDistance = cap->number();
        if (const auto* lods = def.find("lods")) {
            asset.authored = true;
            for (const auto& lod : lods->items()) {
                const double gate = lod.find("distance")->number();
                if (asset.maxDistance && gate >= *asset.maxDistance) continue;
                asset.distances.push_back(gate);
                asset.gates.push_back(gate);
            }
        }
        if (asset.maxDistance) asset.gates.push_back(*asset.maxDistance - *asset.maxDistance / 8);
        if (!asset.gates.empty()) asset.threshold = *std::min_element(asset.gates.begin(), asset.gates.end());
        owner.definitions_.push_back(std::move(asset));
    }
    for (const auto& entry : manifest.find("cells")->items()) {
        Cell cell;
        cell.x = entry.find("x")->number();
        cell.z = entry.find("z")->number();
        for (const auto& run : entry.find("runs")->items()) {
            auto records = cellPlacements(placements,
                {run.find("offset")->number(), run.find("count")->number()}, error);
            if (!records) return std::nullopt;
            cell.instances += records->size() / 8;
            cell.runs.push_back({run.find("asset")->string(), std::move(*records)});
        }
        owner.cells_.push_back(std::move(cell));
    }
    return owner;
}
WorldCells::Asset* WorldCells::asset(const std::string& id) {
    const auto at = std::find_if(assets_.begin(), assets_.end(), [&](const Asset& a) { return a.id == id; });
    return at == assets_.end() ? nullptr : &*at;
}
WorldCells::Resident* WorldCells::resident(std::size_t cell) {
    const auto at = std::find_if(residents_.begin(), residents_.end(), [&](const Resident& r) { return r.cell == cell; });
    return at == residents_.end() ? nullptr : &*at;
}
void WorldCells::noteGates(const Asset& a) {
    for (const double gate : a.gates) {
        const auto at = std::lower_bound(gates_.begin(), gates_.end(), gate);
        if (at == gates_.end() || *at != gate) gates_.insert(at, gate);
    }
}
void WorldCells::queue(std::size_t cell, std::size_t run, bool replace) {
    if (std::any_of(jobs_.begin(), jobs_.end(), [&](const Job& j) { return j.cell == cell && j.run == run; })) return;
    const auto* r = resident(cell);
    if (r == nullptr) return;
    if (!replace && std::any_of(r->batches.begin(), r->batches.end(), [&](const Batch& b) { return b.run == run; })) return;
    Job job;
    job.cell = cell;
    job.run = run;
    job.x = x_;
    job.z = z_;
    jobs_.push_back(std::move(job));
}

bool WorldCells::completeAsset(const std::string& id, const std::vector<WorldCellModel>& models) {
    Asset* a = asset(id);
    if (released_ || a == nullptr || models.empty() || models[0].empty() || !a->levels.empty()) return false;
    // Each registered chain has level-zero error zero, finite nondecreasing errors, and a triangle
    // count at every level. Refuse a malformed loader observation before changing any resident state.
    for (const auto& model : models) for (const auto& part : model) {
        if (part.triangles.empty() || (!part.errors.empty() &&
            (part.errors.size() != part.triangles.size() || part.errors.front() != 0))) return false;
        double last = 0;
        for (const double error : part.errors) {
            if (!std::isfinite(error) || error < last) return false;
            last = error;
        }
    }
    a->levels = models;
    if (!a->authored) {
        std::size_t deepest = 1;
        for (const auto& part : models[0]) deepest = std::max(deepest, part.errors.size());
        const double scale = options_.viewportHeight / (2 * std::tan(options_.fovY * std::acos(-1.0) / 360));
        for (std::size_t level = 1; level < deepest; ++level) {
            double error = 0;
            for (const auto& part : models[0]) if (part.errors.size() == deepest) error = std::max(error, part.errors[level]);
            const double at = error * scale / options_.maxPixelError;
            if (at <= a->distances.back() || (a->maxDistance && at >= *a->maxDistance)) break;
            a->distances.push_back(at);
        }
        if (a->distances.size() > 1) {
            a->chained = true;
            a->gates.clear();
            for (std::size_t level = 1; level < a->distances.size(); ++level) {
                WorldCellModel shape;
                for (const auto& part : models[0]) {
                    const std::size_t at = std::min(level, part.triangles.size() - 1);
                    shape.push_back({{}, {part.triangles[at]}, part.alpha});
                }
                a->levels.push_back(std::move(shape));
                a->gates.push_back(a->distances[level]);
            }
            if (a->maxDistance) a->gates.push_back(*a->maxDistance - *a->maxDistance / 8);
            a->threshold = *std::min_element(a->gates.begin(), a->gates.end());
            noteGates(*a);
        }
    } else {
        // The loader supplies each authored level, including a fallback to the previous model.
        if (a->levels.size() != a->distances.size()) { a->levels.clear(); return false; }
        std::vector<IWorldCellPart> rootAlpha;
        for (const auto& part : a->levels[0]) if (part.alpha) rootAlpha.push_back(part);
        for (std::size_t level = 1; level < a->levels.size(); ++level) {
            const auto alpha = std::count_if(a->levels[level].begin(), a->levels[level].end(), [](const auto& part) { return part.alpha; });
            for (std::size_t at = static_cast<std::size_t>(alpha); at < rootAlpha.size(); ++at)
                a->levels[level].push_back(rootAlpha[at]);
        }
    }
    for (const auto& r : residents_) for (std::size_t run = 0; run < cells_[r.cell].runs.size(); ++run)
        if (cells_[r.cell].runs[run].asset == id) queue(r.cell, run);
    return true;
}

void WorldCells::evict(std::size_t index) {
    if (resident(index) == nullptr) return;
    jobs_.erase(std::remove_if(jobs_.begin(), jobs_.end(), [&](const Job& job) { return job.cell == index; }), jobs_.end());
    for (const auto& run : cells_[index].runs) {
        auto* a = asset(run.asset);
        if (a == nullptr) continue;
        if (--a->refs == 0) {
            assets_.erase(std::remove_if(assets_.begin(), assets_.end(), [&](const Asset& held) { return held.id == run.asset; }), assets_.end());
        }
    }
    instances_ -= cells_[index].instances;
    bytes_ -= cells_[index].instances * 32;
    residents_.erase(std::remove_if(residents_.begin(), residents_.end(), [&](const Resident& r) { return r.cell == index; }), residents_.end());
    ++epoch_;
    ++evictions_;
}
std::array<double, 2> WorldCells::ahead(double x, double z, const std::function<double()>& now) {
    if (options_.prefetchSeconds == 0) return {x, z};
    const double t = now();
    if (lastSample_) {
        const double seconds = (t - (*lastSample_)[0]) / 1000;
        if (seconds >= 0.004) {
            const double dx = x - (*lastSample_)[1], dz = z - (*lastSample_)[2];
            if (distance(dx, dz) > cellSize_ * options_.ring) velocityX_ = velocityZ_ = 0;
            else {
                const double blend = std::min(1.0, seconds / 0.25);
                velocityX_ += (dx / seconds - velocityX_) * blend;
                velocityZ_ += (dz / seconds - velocityZ_) * blend;
            }
            lastSample_ = {t, x, z};
        }
    } else lastSample_ = {t, x, z};
    double leadX = velocityX_ * options_.prefetchSeconds, leadZ = velocityZ_ * options_.prefetchSeconds;
    const double limit = cellSize_ * options_.ring * 0.75, length = distance(leadX, leadZ);
    if (length > limit) { leadX *= limit / length; leadZ *= limit / length; }
    return {x + leadX, z + leadZ};
}
void WorldCells::residency(double x, double z, double leadX, double leadZ) {
    const double cx = std::floor((leadX - minX_) / cellSize_), cz = std::floor((leadZ - minZ_) / cellSize_);
    auto away = [&](std::size_t at) { return std::max(std::abs(cells_[at].x - cx), std::abs(cells_[at].z - cz)); };
    std::vector<std::size_t> wanted, leaving;
    for (std::size_t i = 0; i < cells_.size(); ++i) if (away(i) <= options_.ring) wanted.push_back(i);
    std::stable_sort(wanted.begin(), wanted.end(), [&](auto a, auto b) {
        const auto reach = [&](auto at) { return distance(leadX - (minX_ + (cells_[at].x + 0.5) * cellSize_), leadZ - (minZ_ + (cells_[at].z + 0.5) * cellSize_)); };
        const double da = reach(a), db = reach(b);
        if (da != db) return da < db;
        if (cells_[a].z != cells_[b].z) return cells_[a].z < cells_[b].z;
        return cells_[a].x < cells_[b].x;
    });
    for (const auto& r : residents_) if (away(r.cell) > options_.ring + 1) leaving.push_back(r.cell);
    for (const auto at : leaving) evict(at);
    const std::array<double, 2> here{std::floor((x - minX_) / cellSize_), std::floor((z - minZ_) / cellSize_)};
    const bool jumped = lastCell_ && std::max(std::abs((*lastCell_)[0] - here[0]), std::abs((*lastCell_)[1] - here[1])) > 1;
    lastCell_ = here;
    for (const auto at : wanted) {
        if (resident(at) != nullptr) continue;
        const auto count = cells_[at].instances, bytes = count * 32;
        const auto full = [&] { return residents_.size() >= options_.residentCells || instances_ + count > options_.instances || bytes_ + bytes > options_.bytes; };
        while (jumped && full()) {
            std::optional<std::size_t> spare;
            double reach = options_.ring;
            for (const auto& r : residents_) if (away(r.cell) > reach) { reach = away(r.cell); spare = r.cell; }
            if (!spare) break;
            evict(*spare);
        }
        if (residents_.size() >= options_.residentCells) { ++pressure_[0]; continue; }
        if (instances_ + count > options_.instances) { ++pressure_[1]; continue; }
        if (bytes_ + bytes > options_.bytes) { ++pressure_[2]; continue; }
        Resident r;
        r.cell = at;
        residents_.push_back(r);
        ++epoch_;
        instances_ += count;
        bytes_ += bytes;
        for (std::size_t run = 0; run < cells_[at].runs.size(); ++run) {
            const auto& id = cells_[at].runs[run].asset;
            auto* a = asset(id);
            if (a == nullptr) {
                const auto def = std::find_if(definitions_.begin(), definitions_.end(), [&](const Asset& d) { return d.id == id; });
                assets_.push_back(*def);
                a = &assets_.back();
                noteGates(*a);
            }
            ++a->refs;
            if (!a->levels.empty()) queue(at, run);
        }
    }
}
std::array<double, 2> WorldCells::span(std::size_t at, double x, double z) const {
    const auto& cell = cells_[at];
    const double left = minX_ + cell.x * cellSize_, near = minZ_ + cell.z * cellSize_;
    const double right = left + cellSize_, far = near + cellSize_;
    return {distance(std::max({left - x, x - right, 0.0}), std::max({near - z, z - far, 0.0})),
        distance(std::max(std::abs(x - left), std::abs(x - right)), std::max(std::abs(z - near), std::abs(z - far)))};
}
void WorldCells::refilter(double x, double z) {
    ++refilters_;
    struct Stale { std::size_t cell; double near; std::string asset; };
    std::vector<Stale> stale;
    for (auto& r : residents_) {
        const auto range = span(r.cell, x, z);
        const auto gate = std::lower_bound(gates_.begin(), gates_.end(), std::min(range[0], r.near));
        if (gate == gates_.end() || *gate > std::max(range[1], r.far)) continue;
        std::vector<std::string> seen;
        for (const auto& batch : r.batches) {
            const auto& id = cells_[r.cell].runs[batch.run].asset;
            const auto* a = asset(id);
            if (!a || !a->threshold || std::find(seen.begin(), seen.end(), id) != seen.end()) continue;
            seen.push_back(id);
            if (distance(x - batch.x, z - batch.z) <= *a->threshold / 8) continue;
            const auto built = span(r.cell, batch.x, batch.z);
            const double low = std::min(range[0], built[0]), high = std::max(range[1], built[1]);
            if (std::none_of(a->gates.begin(), a->gates.end(), [&](double g) { return g >= low && g <= high; })) continue;
            stale.push_back({r.cell, range[0], id});
            ++refilterEntries_;
        }
    }
    std::stable_sort(stale.begin(), stale.end(), [](const auto& a, const auto& b) { return a.near == b.near ? a.asset < b.asset : a.near < b.near; });
    owed_ = stale.size() > options_.rebuildsPerUpdate;
    const auto limit = static_cast<std::size_t>(std::min(static_cast<double>(stale.size()), options_.rebuildsPerUpdate));
    for (std::size_t i = 0; i < limit; ++i) for (std::size_t run = 0; run < cells_[stale[i].cell].runs.size(); ++run) {
        if (cells_[stale[i].cell].runs[run].asset != stale[i].asset) continue;
        queue(stale[i].cell, run, true);
        ++rebuilds_;
    }
}
bool WorldCells::step(Job& job) {
    const auto& run = cells_[job.cell].runs[job.run];
    const auto* a = asset(run.asset);
    if (!a || a->levels.empty()) return true;
    const std::size_t count = run.records.size() / 8;
    if (job.next < count) {
        if (job.levels.empty()) job.levels.assign(count, -1);
        const std::size_t end = std::min(count, job.next + 256);
        for (std::size_t at = job.next; at < end; ++at) {
            const auto* record = &run.records[at * 8];
            const double d = distance(static_cast<double>(record[0]) - job.x, static_cast<double>(record[2]) - job.z);
            if (a->maxDistance && d > *a->maxDistance - *a->maxDistance / 8) continue;
            // Authored/chain gates are strict (distance > gate), independent of scale.
            job.levels[at] = static_cast<int32_t>(std::lower_bound(a->distances.begin() + 1, a->distances.end(), d) - a->distances.begin() - 1);
        }
        job.next = end;
        return false;
    }
    if (count == 0) return true;
    std::size_t meshes = 0;
    for (const auto& level : a->levels) meshes += level.size();
    if (job.published < meshes) {
        const auto range = span(job.cell, job.x, job.z);
        auto* r = resident(job.cell);
        r->near = std::min(r->near, range[0]);
        r->far = std::max(r->far, range[1]);
        ++job.published;
        return false;
    }
    auto* r = resident(job.cell);
    const auto old = std::find_if(r->batches.begin(), r->batches.end(), [&](const Batch& b) { return b.run == job.run; });
    if (old == r->batches.end()) r->batches.push_back({job.run, job.x, job.z, job.levels});
    else *old = {job.run, job.x, job.z, job.levels};
    return true;
}
void WorldCells::update(double x, double z, const std::function<double()>& now, bool companionPending) {
    if (released_) return;
    x_ = x; z_ = z;
    const double terrainLimit = jobs_.empty() ? options_.admissionBudgetMs : options_.admissionBudgetMs / 2;
    Budget ground{terrainLimit, 0, now};
    const bool pending = companionPending || !jobs_.empty() || (terrain_ && terrain_->deferredAdmissions() > 0) ||
        std::any_of(assets_.begin(), assets_.end(), [](const Asset& a) { return a.levels.empty(); });
    if (pending || distance(x - residencyX_, z - residencyZ_) >= 0.5) {
        residencyX_ = x; residencyZ_ = z;
        if (terrain_) {
            std::string error;
            TerrainTileBudgetReason reason;
            const bool ok = terrain_->follow(x, z, [&](const auto& work) { return ground.admit(work); }, error, reason);
            terrain_->process();
            if (!ok && error == kTerrainTileBudgetCode) ++pressure_[2];
        }
        const auto point = ahead(x, z, now);
        residency(x, z, point[0], point[1]);
        if (owed_ || epoch_ != filterEpoch_ || distance(x - refilterX_, z - refilterZ_) >= 2) {
            filterEpoch_ = epoch_; refilterX_ = x; refilterZ_ = z;
            refilter(x, z);
        }
    } else if (terrain_ && terrain_->blendingTiles() > 0) terrain_->process();
    Budget props{options_.admissionBudgetMs - std::min(ground.spent, terrainLimit), 0, now};
    while (!jobs_.empty()) {
        bool done = false;
        if (!props.admit([&] { done = step(jobs_[0]); })) break;
        if (done) jobs_.erase(jobs_.begin());
    }
    terrainSpentMs_ = ground.spent;
    spentMs_ = ground.spent + props.spent;
}
uint32_t WorldCells::backlog() const {
    uint32_t total = 0;
    for (const auto& j : jobs_) {
        const auto& run = cells_[j.cell].runs[j.run];
        const auto a = std::find_if(assets_.begin(), assets_.end(), [&](const Asset& v) { return v.id == run.asset; });
        std::size_t meshes = 0;
        if (!j.levels.empty() && a != assets_.end()) for (const auto& level : a->levels) meshes += level.size();
        total += static_cast<uint32_t>((run.records.size() / 8 - j.next + 255) / 256 + meshes - j.published);
    }
    return total;
}
std::vector<std::string> WorldCells::residentKeysInOrder() const {
    std::vector<std::string> result;
    for (const auto& r : residents_) result.push_back(key(cells_[r.cell].x, cells_[r.cell].z));
    return result;
}
std::vector<std::string> WorldCells::residentKeys() const {
    auto result = residentKeysInOrder();
    std::sort(result.begin(), result.end());
    return result;
}
std::vector<std::pair<std::string, uint32_t>> WorldCells::assetRefCounts() const {
    std::vector<std::pair<std::string, uint32_t>> result;
    for (const auto& a : assets_) result.emplace_back(a.id, a.refs);
    return result;
}
std::vector<IWorldCellDraw> WorldCells::draws() const {
    std::map<std::string, IWorldCellDraw> result;
    for (const auto& r : residents_) for (const auto& b : r.batches) {
        const auto& run = cells_[r.cell].runs[b.run];
        const auto a = std::find_if(assets_.begin(), assets_.end(), [&](const Asset& held) { return held.id == run.asset; });
        for (std::size_t record = 0; record < b.levels.size(); ++record) {
            const int32_t level = b.levels[record];
            if (level < 0) continue;
            for (std::size_t part = 0; part < a->levels[static_cast<std::size_t>(level)].size(); ++part) {
                const std::string name = run.asset + ":" + std::to_string(level) + ":" + std::to_string(part);
                auto& draw = result[name];
                draw.key = name;
                draw.triangles = a->levels[static_cast<std::size_t>(level)][part].triangles[0];
                const auto* at = &run.records[record * 8];
                draw.roots.push_back({at[0], at[1], at[2]});
            }
        }
    }
    std::vector<IWorldCellDraw> draws;
    for (auto& [name, draw] : result) { std::sort(draw.roots.begin(), draw.roots.end()); draws.push_back(std::move(draw)); }
    return draws;
}
std::map<std::string, std::vector<double>> WorldCells::reportedChainDistances() const {
    std::map<std::string, std::vector<double>> result;
    for (const auto& a : assets_) if (a.chained) {
        auto& distances = result[a.id];
        for (const double d : a.distances) distances.push_back(std::round(d * 10) / 10);
    }
    return result;
}
void WorldCells::dispose() {
    if (released_) return;
    released_ = true;
    while (!residents_.empty()) evict(residents_[0].cell);
    if (terrain_) terrain_->dispose();
}

IWorldChunkMerge mergeWorldChunk(std::span<const IWorldChunkPart> parts, uint32_t maxTriangles) {
    struct Group { uint32_t material; std::vector<std::array<uint32_t, 2>> parts; uint64_t vertices = 0, triangles = 0; };
    std::vector<std::pair<uint32_t, std::vector<Group>>> materials;
    IWorldChunkMerge result;
    auto groupFor = [&](const IWorldChunkPart& part) -> Group& {
        auto at = std::find_if(materials.begin(), materials.end(), [&](const auto& group) { return group.first == part.material; });
        if (at == materials.end()) { materials.push_back({part.material, {}}); at = materials.end() - 1; }
        auto& groups = at->second;
        // The reference counts 32 attribute bytes per source vertex before de-indexing. Index bytes
        // and a single part above the allowance do not change this split rule.
        constexpr uint64_t byteCap = 4 * 1024 * 1024;
        if (groups.empty() || (groups.back().vertices + part.vertices) * 32 > byteCap)
            groups.push_back({part.material, {}, 0, 0});
        return groups.back();
    };
    auto add = [&](const IWorldChunkPart& part, uint32_t instance) {
        auto& group = groupFor(part);
        group.parts.push_back({part.id, instance});
        group.vertices += part.vertices;
        group.triangles += (part.indices == 0 ? part.vertices : part.indices) / 3;
    };
    for (const auto& part : parts) {
        if (part.chain || part.morph) { result.kept.push_back(part.id); continue; }
        // mergeChunk removes these non-mergeable sources after mergeByMaterial omits them. Match the
        // current TS decision rather than silently fixing its skinned/multi-material behavior here.
        if (part.skinned || part.multiMaterial) continue;
        if (!part.instanced) { add(part, 0); continue; }
        const uint64_t shape = (part.indices == 0 ? part.vertices : part.indices) / 3;
        const uint64_t cost = shape * part.copies;
        const auto triangles = groupFor(part).triangles;
        if (shape > 2048 || triangles + cost > maxTriangles) {
            result.kept.push_back(part.id); ++result.keptInstanced; continue;
        }
        ++result.expanded;
        for (uint32_t copy = 0; copy < part.copies; ++copy) add(part, copy);
    }
    const auto source = [&](uint32_t id) -> const IWorldChunkPart& {
        return *std::find_if(parts.begin(), parts.end(), [&](const auto& part) { return part.id == id; });
    };
    for (const auto& [material, groups] : materials) for (const auto& group : groups) {
        if (group.parts.empty()) continue;
        bool indexed = true, allUv = true, someUv = false;
        for (const auto& item : group.parts) {
            const auto& p = source(item[0]);
            indexed = indexed && p.indices > 0;
            allUv = allUv && p.uv;
            someUv = someUv || p.uv;
        }
        if (someUv && !allUv) {
            result = {}; result.refused = true;
            for (const auto& p : parts) { result.kept.push_back(p.id); if (p.instanced) ++result.keptInstanced; }
            return result;
        }
        IWorldChunkGroup merged;
        merged.material = material;
        merged.parts = group.parts;
        for (const auto& item : group.parts) {
            const auto& p = source(item[0]);
            merged.vertices += !indexed && p.indices > 0 ? p.indices : p.vertices;
            if (indexed) merged.indices += p.indices;
        }
        merged.indexBytes = indexed ? merged.indices * (merged.vertices > 65535 ? 4 : 2) : 0;
        merged.bytes = static_cast<uint64_t>(merged.vertices) * (someUv ? 32 : 24) + merged.indexBytes;
        result.bytes += merged.bytes;
        result.groups.push_back(std::move(merged));
    }
    // Three retains skipped nodes in traversal order, then appends retained instanced results.
    std::sort(result.kept.begin(), result.kept.end(), [&](uint32_t a, uint32_t b) {
        const auto at = [&](uint32_t id) { return std::find_if(parts.begin(), parts.end(), [&](const auto& p) { return p.id == id; }) - parts.begin(); };
        return at(a) < at(b);
    });
    return result;
}
} // namespace tn::engine::world
