#include "check.h"
#include "engine/assets/sha256.h"
#include "engine/foundation/json.h"
#include "engine/world/cells/world_cells.h"
#include "engine/world/terrain/heights.h"

#include <algorithm>
#include <bit>
#include <cstdio>
#include <fstream>
#include <iterator>
#include <limits>
#include <string>
#include <utility>

using namespace tn::engine;
using namespace tn::engine::world;
namespace {
using Value = json::Value;
Value number(double n) { return Value::makeNumber(n); }
Value string(std::string s) { return Value::makeString(std::move(s)); }
const Value& member(const Value& value, const char* key) {
    const auto* at = value.find(key);
    CHECK(at != nullptr);
    static const Value missing;
    return at ? *at : missing;
}
bool boolean(const Value& value, const char* key) {
    const auto* at = value.find(key);
    return at && at->boolean();
}
double decoded(const Value& value) {
    if (value.isNumber()) return value.number();
    if (!value.isString() || !value.string().starts_with("f64:") || value.string().size() != 20) {
        CHECK(false);
        return 0;
    }
    uint64_t bits = 0;
    const auto& text = value.string();
    const auto parsed = std::from_chars(text.data() + 4, text.data() + text.size(), bits, 16);
    CHECK(parsed.ec == std::errc{} && parsed.ptr == text.data() + text.size());
    return std::bit_cast<double>(bits);
}
IWorldCellsOptions optionsOf(const Value& source) {
    IWorldCellsOptions o;
    const auto set = [&](const char* key, double& target) { if (const auto* at = source.find(key)) target = decoded(*at); };
    set("ring", o.ring); set("residentCells", o.residentCells); set("instances", o.instances);
    set("bytes", o.bytes); set("admissionBudgetMs", o.admissionBudgetMs);
    set("rebuildsPerUpdate", o.rebuildsPerUpdate); set("concurrency", o.concurrency);
    set("prefetchSeconds", o.prefetchSeconds); set("fovY", o.fovY);
    set("viewportHeight", o.viewportHeight); set("maxPixelError", o.maxPixelError);
    return o;
}
std::vector<float> words(const Value& value) {
    const auto& text = value.string();
    CHECK(text.starts_with("f32:") && (text.size() - 4) % 8 == 0);
    std::vector<float> result;
    for (std::size_t at = 4; at + 8 <= text.size(); at += 8) {
        uint32_t bits = 0;
        const auto parsed = std::from_chars(text.data() + at, text.data() + at + 8, bits, 16);
        CHECK(parsed.ec == std::errc{} && parsed.ptr == text.data() + at + 8);
        result.push_back(std::bit_cast<float>(bits));
    }
    return result;
}
Value keys(const std::vector<std::string>& source) {
    std::vector<Value> values;
    for (const auto& s : source) values.push_back(string(s));
    return Value::makeArray(std::move(values));
}
Value rootWords(const std::vector<std::array<float, 3>>& roots) {
    std::string out = "f32:";
    char hex[9];
    for (const auto& root : roots) for (float component : root) {
        std::snprintf(hex, sizeof hex, "%08x", std::bit_cast<uint32_t>(component));
        out += hex;
    }
    return string(std::move(out));
}
Value drawsOf(const WorldCells& owner) {
    std::vector<Value> result;
    for (const auto& draw : owner.draws()) result.push_back(Value::makeObject({
        {"key", string(draw.key)}, {"triangles", number(draw.triangles)}, {"roots", rootWords(draw.roots)}}));
    return Value::makeArray(std::move(result));
}
Value snapshot(const WorldCells& owner, const TerrainTiles& terrain, bool orderProbe) {
    std::vector<Value> refs;
    for (const auto& [id, count] : owner.assetRefCounts()) refs.push_back(Value::makeArray({string(id), number(count)}));
    std::vector<std::pair<std::string, Value>> chains;
    for (const auto& [id, distances] : owner.reportedChainDistances()) {
        std::vector<Value> values;
        for (double d : distances) values.push_back(number(d));
        chains.push_back({id, Value::makeArray(std::move(values))});
    }
    const auto& pressure = owner.pressure();
    return Value::makeObject({
        {"residentKeys", keys(owner.residentKeys())}, {"instances", number(static_cast<double>(owner.instances()))},
        {"pressure", Value::makeObject({{"cells", number(pressure[0])}, {"instances", number(pressure[1])}, {"bytes", number(pressure[2])}})},
        {"evictions", number(owner.evictions())}, {"refilters", number(owner.refilters())},
        {"refilterEntries", number(owner.refilterEntries())}, {"rebuilds", number(owner.rebuilds())},
        {"admission", Value::makeObject({{"backlog", number(owner.backlog())}, {"deferred", number(owner.deferred())}, {"spentMs", number(owner.spentMs())}})},
        {"terrainSpent", number(terrain.released() ? 0 : owner.terrainSpentMs())},
        {"refs", Value::makeArray(std::move(refs))},
        {"order", orderProbe ? keys(owner.residentKeysInOrder()) : Value{}},
        {"draws", drawsOf(owner)}, {"chainDistances", Value::makeObject(std::move(chains))},
        {"terrain", terrain.released() ? Value{} : Value::makeObject({{"residentKeys", keys(terrain.residentKeys())}, {"deferred", number(terrain.deferredAdmissions())}, {"colliderKeys", keys(terrain.residentColliderKeys())}})},
    });
}

/** All output numbers, including integer counts, compare by their IEEE representation. Scene steps
 * compare as one SHA-256 over their canonical stream, so every bit of every observation is still
 * checked; a length/structure mismatch also fails, never skips a value. */
std::size_t compared = 0, mismatched = 0;
void differ(const std::string& where) {
    ++mismatched;
    if (mismatched <= 30) std::fprintf(stderr, "%s differs\n", where.c_str());
}
void compare(const Value& actual, const Value& expected, const std::string& where) {
    ++compared;
    if (expected.isString() && expected.string().starts_with("f64:")) {
        if (!actual.isNumber() || std::bit_cast<uint64_t>(actual.number()) != std::bit_cast<uint64_t>(decoded(expected))) {
            if (mismatched < 30) std::fprintf(stderr, "actual %.17g expected %.17g: ", actual.number(), decoded(expected));
            differ(where);
        }
    } else if (expected.isString() && expected.string().starts_with("f32:")) {
        if (!actual.isString() || actual.string().size() != expected.string().size()) { differ(where + ".wordCount"); return; }
        for (std::size_t at = 4; at < expected.string().size(); at += 8) {
            ++compared;
            if (actual.string().substr(at, 8) != expected.string().substr(at, 8)) differ(where + "[" + std::to_string((at - 4) / 8) + "]");
        }
    } else if (expected.isArray()) {
        if (!actual.isArray() || actual.items().size() != expected.items().size()) differ(where + ".length");
        if (!actual.isArray()) return;
        for (std::size_t i = 0; i < std::min(actual.items().size(), expected.items().size()); ++i)
            compare(actual.items()[i], expected.items()[i], where + "[" + std::to_string(i) + "]");
    } else if (expected.isObject()) {
        if (!actual.isObject() || actual.members().size() != expected.members().size()) differ(where + ".members");
        if (!actual.isObject()) return;
        for (const auto& [name, value] : expected.members()) {
            const auto* at = actual.find(name);
            if (!at) differ(where + ".missing." + name);
            else compare(*at, value, where + "." + name);
        }
    } else if (json::stringify(actual) != json::stringify(expected)) differ(where);
}

/** The stream world-cells-reference.ts hashes: every number as its f64 bit pattern, object members in
 * key order, no whitespace — the bytes json::stringify and JSON.stringify both write for it. */
Value canonical(const Value& v) {
    if (v.isNumber()) {
        char hex[24];
        std::snprintf(hex, sizeof hex, "f64:%016llx",
            static_cast<unsigned long long>(std::bit_cast<uint64_t>(v.number())));
        return Value::makeString(hex);
    }
    if (v.isArray()) {
        std::vector<Value> items;
        items.reserve(v.items().size());
        for (const auto& item : v.items()) items.push_back(canonical(item));
        return Value::makeArray(std::move(items));
    }
    if (!v.isObject()) return v;
    auto members = v.members();
    std::sort(members.begin(), members.end(),
        [](const std::pair<std::string, Value>& a, const std::pair<std::string, Value>& b) {
            return a.first < b.first;
        });
    for (auto& member : members) member.second = canonical(member.second);
    return Value::makeObject(std::move(members));
}
std::string digestOf(const std::string& text) {
    static const char* const hex = "0123456789abcdef";
    std::string out;
    for (const uint8_t byte : assets::sha256(reinterpret_cast<const uint8_t*>(text.data()), text.size())) {
        out += hex[byte >> 4];
        out += hex[byte & 15];
    }
    return out;
}
/** One observation per node compare() visits, plus one per f32 word, numbered across the scene. The
 * first 16 values stay in the table so a failure can name the observation, not only the digest. */
std::size_t observe(const Value& v, std::size_t& count,
    std::vector<std::pair<std::size_t, std::string>>& prefix) {
    ++count;
    if (prefix.size() < 16 && !v.isArray() && !v.isObject())
        prefix.emplace_back(count, json::stringify(canonical(v)));
    if (v.isString() && v.string().starts_with("f32:")) {
        count += (v.string().size() - 4) / 8;
        return count;
    }
    if (v.isArray())
        for (const auto& item : v.items()) observe(item, count, prefix);
    else if (v.isObject())
        for (const auto& [name, value] : v.members()) observe(value, count, prefix);
    return count;
}

class PackageHeights : public IHeightGridSource {
  public:
    PackageHeights(HeightSampler sampler, double size, uint32_t resolution)
        : sampler_(std::move(sampler)), size_(size), resolution_(resolution) {}
    bool tileGrid(int32_t x, int32_t z, std::vector<float>& heights) override {
        heights.resize(static_cast<std::size_t>(resolution_) * resolution_);
        const double step = size_ / (resolution_ - 1);
        const double left = x * size_ - size_ / 2, near = z * size_ - size_ / 2;
        for (uint32_t row = 0; row < resolution_; ++row) for (uint32_t column = 0; column < resolution_; ++column)
            heights[static_cast<std::size_t>(row) * resolution_ + column] = static_cast<float>(sampler_.sample(left + column * step, near + row * step));
        return true;
    }
  private:
    HeightSampler sampler_;
    double size_;
    uint32_t resolution_;
};
std::vector<WorldCellModel> modelsOf(const Value& input) {
    std::vector<WorldCellModel> models;
    for (const auto& level : input.items()) {
        WorldCellModel model;
        for (const auto& p : level.items()) {
            IWorldCellPart part;
            part.alpha = boolean(p, "alpha");
            for (const auto& error : member(p, "errors").items()) part.errors.push_back(error.number());
            for (const auto& triangles : member(p, "triangles").items()) part.triangles.push_back(static_cast<uint32_t>(triangles.number()));
            model.push_back(std::move(part));
        }
        models.push_back(std::move(model));
    }
    return models;
}
std::vector<Value> replay(const Value& scene, std::span<const std::byte> placements, const std::vector<uint16_t>& heights, bool admission = false) {
    std::vector<Value> frames;
    const std::string name = member(scene, "name").string();
    const auto& manifest = member(scene, "manifest");
    const auto& height = member(manifest, "terrain"), &extent = member(manifest, "extent");
    std::string error;
    auto sampler = HeightSampler::create(static_cast<uint32_t>(member(height, "columns").number()),
        static_cast<uint32_t>(member(height, "rows").number()), member(height, "spacing").number(),
        member(height, "heightMin").number(), member(height, "heightMax").number(),
        member(extent, "minX").number(), member(extent, "minZ").number(), heights, error);
    CHECK(sampler.has_value());
    if (!sampler) return frames;
    const auto config = optionsOf(member(scene, "options"));
    const auto& tc = member(scene, "terrain");
    ITerrainTilesOptions terrainOptions;
    terrainOptions.tileSize = member(manifest, "cellSize").number();
    terrainOptions.skirtDepth = terrainOptions.tileSize;
    terrainOptions.lodDistances = {terrainOptions.tileSize * 2, terrainOptions.tileSize * 4};
    terrainOptions.lodDistancesSet = true;
    terrainOptions.tileResolution = static_cast<uint32_t>(member(tc, "tileResolution").number());
    terrainOptions.streamRadius = static_cast<uint32_t>(member(tc, "streamRadius").number());
    terrainOptions.colliderRadius = static_cast<uint32_t>(member(tc, "colliderRadius").number());
    terrainOptions.colliderRadiusSet = true;
    terrainOptions.createCollider = boolean(tc, "createCollider");
    terrainOptions.residentTileBudget = (2 * terrainOptions.streamRadius + 1) * (2 * terrainOptions.streamRadius + 1);
    terrainOptions.residentByteBudget = 9007199254740991ull;
    PackageHeights grid(std::move(*sampler), terrainOptions.tileSize, terrainOptions.tileResolution);
    auto terrain = TerrainTiles::create(terrainOptions, grid, error);
    CHECK(terrain.has_value());
    if (!terrain) return frames;
    auto owner = WorldCells::create(manifest, placements, config, &*terrain, error);
    CHECK(owner.has_value());
    if (!owner) { std::fprintf(stderr, "%s: %s\n", name.c_str(), error.c_str()); return frames; }
    double clock = 0, x = 0, z = 0;
    const bool priced = boolean(scene, "priced");
    auto now = [&] { if (priced) clock += 1; return clock; };
    std::size_t index = 0, count = 0;
    std::string stepDigests;
    std::vector<std::pair<std::size_t, std::string>> prefix;
    for (const auto& step : member(scene, "steps").items()) {
        const auto& action = member(step, "action");
        if (const auto* at = action.find("at")) { x = at->items()[0].number(); z = at->items()[1].number(); }
        if (const auto* dt = action.find("dt")) clock += dt->number();
        if (boolean(action, "dispose")) owner->dispose();
        else owner->update(x, z, now, boolean(step, "companionPending"));
        const auto current = snapshot(*owner, *terrain, name == "admissionOrder");
        if (admission) frames.push_back(current);
        const std::string digest = digestOf(json::stringify(canonical(current)));
        stepDigests += digest;
        stepDigests += '\n';
        const std::size_t before = count;
        observe(current, count, prefix);
        compared += count - before;
        if (digest != member(step, "digest").string())
            differ(name + ".step" + std::to_string(index) + " digest");
        else if (count - before != static_cast<std::size_t>(member(step, "observations").number()))
            differ(name + ".step" + std::to_string(index) + " observations");
        ++index;
        for (const auto& completed : member(step, "completed").items()) {
            const bool accepted = owner->completeAsset(member(completed, "id").string(), modelsOf(member(completed, "models")));
            CHECK(accepted);
        }
    }
    const auto& stored = member(scene, "prefix").items();
    for (std::size_t i = 0, n = std::min(prefix.size(), stored.size()); i < n; ++i) {
        const auto& at = stored[i].items();
        if (at.size() != 2 || at[1].string() != prefix[i].second) {
            const std::string was = at.size() == 2 ? at[1].string() : "?";
            const std::string at_number = at.size() == 2 ? std::to_string(static_cast<std::size_t>(at[0].number())) : "?";
            ++mismatched;
            if (mismatched <= 30)
                std::fprintf(stderr, "%s differs at observation %s (was %s, now %s)\n", name.c_str(),
                    at_number.c_str(), was.c_str(), prefix[i].second.c_str());
            break;
        }
    }
    if (digestOf(stepDigests) != member(scene, "digest").string()) differ(name + " digest");
    CHECK(prefix.size() == stored.size());
    owner->dispose();
    return frames;
}
Value chunkSnapshot(const IWorldChunkMerge& result) {
    std::vector<Value> kept, groups;
    for (const auto id : result.kept) kept.push_back(number(id));
    for (const auto& group : result.groups) {
        std::vector<Value> parts;
        for (const auto& token : group.parts) parts.push_back(Value::makeArray({number(token[0]), number(token[1])}));
        groups.push_back(Value::makeObject({{"material", number(group.material)}, {"vertices", number(group.vertices)},
            {"indices", number(group.indices)}, {"indexBytes", number(group.indexBytes)},
            {"bytes", number(static_cast<double>(group.bytes))}, {"parts", Value::makeArray(std::move(parts))}}));
    }
    return Value::makeObject({{"refused", Value::makeBool(result.refused)}, {"expanded", number(result.expanded)},
        {"keptInstanced", number(result.keptInstanced)}, {"bytes", number(static_cast<double>(result.bytes))},
        {"kept", Value::makeArray(std::move(kept))}, {"groups", Value::makeArray(std::move(groups))}});
}
void worldCells(bool admission = false) {
    std::ifstream file(TN_WORLD_CELLS_REFERENCE);
    CHECK(file.good());
    const std::string text((std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
    Value table;
    json::Error parseError;
    CHECK(json::parse(text, table, parseError));
    if (!table.isObject()) return;
    const auto floats = words(member(table, "placements"));
    const auto placements = std::as_bytes(std::span(floats));
    std::vector<uint16_t> heights;
    for (const auto& height : member(table, "heightmap").items()) heights.push_back(static_cast<uint16_t>(height.number()));
    CHECK(!member(table, "coverage").items().empty());
    CHECK(!member(table, "scenes").items().empty());
    CHECK(!member(table, "chunks").items().empty());
    std::vector<std::string> admissionScenes;
    std::size_t cases = 0;
    if (admission) for (const auto& row : member(table, "coverage").items()) {
        if (member(row, "file").string() != "world-cells-admission.spec.ts") continue;
        ++cases;
        CHECK(!member(row, "reproduced").items().empty());
        for (const auto& lane : member(row, "reproduced").items())
            if (std::find(admissionScenes.begin(), admissionScenes.end(), lane.string()) == admissionScenes.end())
                admissionScenes.push_back(lane.string());
    }
    std::map<std::string, std::vector<Value>> traces;
    for (const auto& scene : member(table, "scenes").items()) {
        const auto& name = member(scene, "name").string();
        if (admission && std::find(admissionScenes.begin(), admissionScenes.end(), name) == admissionScenes.end()) continue;
        auto frames = replay(scene, placements, heights, admission);
        if (admission) traces.emplace(name, std::move(frames));
    }
    if (admission) {
        CHECK(cases == 9 && traces.size() == 8);
        const auto count = [](const Value& frame, const char* key) { return member(member(frame, "admission"), key).number(); };
        for (const auto& name : {"boundedAdmission", "boundedColliders"}) {
            const auto& frames = traces.at(name);
            CHECK(!frames.empty());
            std::size_t owed = 0, shared = 0;
            bool deferred = false;
            double previous = 0;
            for (const auto& frame : frames) {
                CHECK(count(frame, "spentMs") <= 3); // 2 ms budget + one 1 ms unit.
                if (count(frame, "backlog") > 0) ++owed;
                deferred |= count(frame, "deferred") > 0;
                if (member(member(frame, "terrain"), "deferred").number() > 0 && count(frame, "backlog") < previous) ++shared;
                previous = count(frame, "backlog");
            }
            CHECK(owed > 2 && deferred && shared > 0);
            CHECK(count(frames.back(), "backlog") == 0 && count(frames.back(), "deferred") == 0);
            CHECK(count(frames.back(), "spentMs") <= 2);
            CHECK(member(member(frames.back(), "terrain"), "deferred").number() == 0);
        }
        const auto& tiny = traces.at("tinyTerrainAdmission");
        CHECK(tiny.size() == 9);
        for (std::size_t i = 0; i < tiny.size(); ++i) {
            CHECK(count(tiny[i], "spentMs") <= 1.05);
            CHECK(member(member(tiny[i], "terrain"), "residentKeys").items().size() == std::min(2 * (i + 1), std::size_t{9}));
            CHECK(!member(member(tiny[i], "terrain"), "colliderKeys").items().empty());
        }
        for (const auto& name : {"jump1", "jump2"}) {
            const auto& frames = traces.at(name);
            CHECK(member(frames.front(), "residentKeys").items().size() == 4);
            CHECK(member(frames.back(), "residentKeys").items().size() == 4);
            CHECK(member(member(frames.back(), "pressure"), "cells").number() == 5);
        }
        const auto& replacement = traces.at("replacement");
        CHECK(replacement.size() == 202);
        CHECK(member(replacement[100], "draws").items().size() > 0);
        compare(member(replacement[101], "draws"), member(replacement[100], "draws"), "replacement keeps old draws");
        CHECK(count(replacement[101], "deferred") > 0 && member(replacement[101], "rebuilds").number() > 0);
        CHECK(json::stringify(member(replacement.back(), "draws")) != json::stringify(member(replacement[100], "draws")));
        const auto& eviction = traces.at("queuedEviction");
        CHECK(count(eviction[1], "deferred") > 0);
        CHECK(count(eviction.back(), "backlog") == 0 && count(eviction.back(), "deferred") == 0);
        CHECK(member(eviction.back(), "residentKeys").items().empty() && member(eviction.back(), "draws").items().empty());
        // Native draw decisions match after draining; Three mesh identity and actual rendering
        // in the spec's draw-equality/refilter/eviction assertions are not a CPU proof.
        compare(member(traces.at("boundedAdmission").back(), "draws"),
            member(traces.at("unboundedAdmission").back(), "draws"), "bounded/unbounded draw decisions");
    }
    if (!admission) for (const auto& scene : member(table, "chunks").items()) {
        std::vector<IWorldChunkPart> parts;
        for (const auto& item : member(scene, "parts").items()) {
            IWorldChunkPart p;
            p.id = static_cast<uint32_t>(member(item, "id").number());
            p.material = static_cast<uint32_t>(member(item, "material").number());
            p.vertices = static_cast<uint32_t>(member(item, "vertices").number());
            p.indices = static_cast<uint32_t>(member(item, "indices").number());
            p.copies = static_cast<uint32_t>(member(item, "copies").number());
            p.instanced = boolean(item, "instanced"); p.chain = boolean(item, "chain"); p.morph = boolean(item, "morph");
            p.normal = boolean(item, "normal"); p.uv = boolean(item, "uv");
            parts.push_back(p);
        }
        compare(chunkSnapshot(mergeWorldChunk(parts, static_cast<uint32_t>(member(scene, "maxTriangles").number()))),
            member(scene, "expected"), member(scene, "name").string());
    }
    const auto& manifest = member(member(table, "scenes").items()[0], "manifest");
    for (const auto& refusal : member(table, "refusals").items()) {
        IWorldCellsOptions o;
        const auto option = member(refusal, "option").string();
        if (admission && option != "admissionBudgetMs") continue;
        const double value = decoded(member(refusal, "value"));
        if (option == "concurrency") o.concurrency = value;
        if (option == "rebuildsPerUpdate") o.rebuildsPerUpdate = value;
        if (option == "chunkMergeMaxTriangles") o.chunkMergeMaxTriangles = value;
        if (option == "admissionBudgetMs") o.admissionBudgetMs = value;
        std::string error;
        auto owner = WorldCells::create(manifest, placements, o, nullptr, error);
        ++compared;
        if (owner) differ("refused option accepted: " + option);
        compare(string(error), member(refusal, "expected"), "refusal." + option);
    }
    std::printf("%s: %zu observations, %zu differ\n", admission ? "admission budget (9 spec cases)" : "world cells", compared, mismatched);
    CHECK(compared > 0 && mismatched == 0);
}
void allWorldCells() { worldCells(); }
void admissionBudget() { worldCells(true); }
}
TN_TEST_MAIN({"world_cells", allWorldCells}, {"admission_budget", admissionBudget})
