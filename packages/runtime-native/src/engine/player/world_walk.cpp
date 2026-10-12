#include "engine/player/world_walk.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <iterator>
#include <stdexcept>
#if defined(__has_feature)
#if __has_feature(address_sanitizer)
#define TN_WORLD_WALK_ASAN 1
#endif
#endif
#if defined(__SANITIZE_ADDRESS__) || defined(TN_WORLD_WALK_ASAN)
extern "C" std::size_t __sanitizer_get_current_allocated_bytes();
#endif
#if defined(__linux__)
#include <malloc.h>
#elif defined(__APPLE__)
#include <malloc/malloc.h>
#endif

#include "engine/renderer/renderer.h"
#include "engine/scene/geometries.h"
#include "engine/scene/lights.h"
#include "engine/scene/material.h"

namespace tn::engine::player {
namespace {
constexpr uint64_t kByteAllowance = 1024;
constexpr double kMsAllowance = 4;
constexpr uint64_t kPositionBytes = 72; // six cooked vec3 f32 ground vertices per committed cell
constexpr uint32_t kWalkTicks = 168;
constexpr std::array<double, 7> kPath{2, 6, 10, 14, 10, 6, 2};

double now() {
    return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count();
}
std::vector<uint8_t> read(const std::filesystem::path& path) {
    std::ifstream in(path, std::ios::binary | std::ios::ate);
    const auto size = in.tellg();
    if (!in || size < 0 || size > 1024 * 1024)
        throw std::runtime_error("TN_WORLD_IO_UNAVAILABLE: " + path.string());
    std::vector<uint8_t> bytes(static_cast<std::size_t>(size));
    in.seekg(0);
    if (!in.read(reinterpret_cast<char*>(bytes.data()), size))
        throw std::runtime_error("TN_WORLD_IO_UNAVAILABLE: " + path.string());
    return bytes;
}
double heapBytes() {
#if defined(__SANITIZE_ADDRESS__) || defined(TN_WORLD_WALK_ASAN)
    return double(__sanitizer_get_current_allocated_bytes());
#elif defined(__linux__)
    const auto heap = mallinfo2();
    return double(heap.uordblks) + double(heap.hblkhd);
#elif defined(__APPLE__)
    malloc_statistics_t heap{};
    malloc_zone_statistics(nullptr, &heap);
    return double(heap.size_in_use);
#else
    return -1; // Missing allocator observation fails the scenario; no invented CPU-memory claim.
#endif
}
std::shared_ptr<BufferGeometry> geometry(std::span<const uint8_t> bytes, const world::HeightSampler& heights,
                                         const std::array<double, 2>& origin) {
    if (bytes.size() != kPositionBytes)
        throw std::runtime_error("TN_WORLD_CELL_LAYOUT: positions must be six vec3 f32 vertices");
    auto attribute = std::make_shared<BufferAttribute>(Scalar::F32, 18, 3);
    if (attribute->store->write(0, bytes.data(), bytes.size()) != BufferError::None)
        throw std::runtime_error("TN_WORLD_CELL_LAYOUT: position store refused bytes");
    for (uint64_t i = 0; i < 6; ++i)
        for (int component = 0; component < 3; ++component)
            if (!std::isfinite(attribute->getComponent(i, component)))
                throw std::runtime_error("TN_WORLD_CELL_LAYOUT: non-finite position");
    for (uint64_t i = 0; i < attribute->count(); ++i)
        attribute->setY(i, heights.sample(origin[0] + attribute->getX(i), origin[1] + attribute->getZ(i)));
    auto result = std::make_shared<BufferGeometry>();
    result->setAttribute("position", attribute);
    result->computeVertexNormals();
    return result;
}
std::string recovery(world::Recovery value) {
    return value == world::Recovery::Skip ? "skip" : value == world::Recovery::Retry ? "retry" : "fatal";
}
} // namespace

WorldWalk::WorldWalk(std::string mode, std::filesystem::path fixture)
    : mode_(std::move(mode)), fixture_(std::move(fixture)) {
    const auto text = read(fixture_ / "world.json");
    json::Error defect;
    if (!json::parse(std::string_view(reinterpret_cast<const char*>(text.data()), text.size()), manifest_, defect))
        throw std::runtime_error("WORLD_MALFORMED: " + defect.detail);
    const auto* path = manifest_.find("placements");
    if (!path || !path->isString()) throw std::runtime_error("WORLD_MALFORMED: placements");
    placements_ = read(fixture_ / path->string());
    const auto heights = read(fixture_ / "heightmap.u16");
    const auto defects = world::validateWorldPackage(manifest_, {double(placements_.size()), true, double(heights.size())});
    if (!defects.empty()) throw std::runtime_error(defects.front().code + ": " + defects.front().path);
    const auto& terrain = *manifest_.find("terrain");
    const auto& extent = *manifest_.find("extent");
    std::vector<uint16_t> samples(heights.size() / 2);
    for (std::size_t i = 0; i < samples.size(); ++i)
        samples[i] = uint16_t(heights[i * 2]) | (uint16_t(heights[i * 2 + 1]) << 8);
    std::string heightError;
    heights_ = world::HeightSampler::create(uint32_t(terrain.find("columns")->number()),
        uint32_t(terrain.find("rows")->number()), terrain.find("spacing")->number(),
        terrain.find("heightMin")->number(), terrain.find("heightMax")->number(),
        extent.find("minX")->number(), extent.find("minZ")->number(), samples, heightError);
    if (!heights_) throw std::runtime_error(heightError);
    for (const auto& entry : manifest_.find("cells")->items()) {
        const auto& runs = entry.find("runs")->items();
        const auto* chunks = entry.find("chunks");
        if (runs.size() != 1 || !chunks || chunks->items().size() != 1)
            throw std::runtime_error("TN_WORLD_CELL_LAYOUT: one run and cooked chunk per fixture cell");
        Cell cell;
        cell.asset = runs[0].find("asset")->string();
        cell.key = json::numberToString(entry.find("x")->number()) + ":" + json::numberToString(entry.find("z")->number());
        cell.file = chunks->items()[0].string();
        cell.origin = {extent.find("minX")->number() + entry.find("x")->number() * manifest_.find("cellSize")->number(),
                       extent.find("minZ")->number() + entry.find("z")->number() * manifest_.find("cellSize")->number()};
        cells_.push_back(std::move(cell));
    }
    if (cells_.size() != 4) throw std::runtime_error("TN_WORLD_CELL_LAYOUT: expected four cells");
    samples_.reserve(10);
    errors_.reserve(4);
    material_ = std::make_shared<Material>(MaterialType::Standard);
    material_->color.setHex(0x609050);
    material_->side = Side::Double;
    auto sky = std::make_shared<HemisphereLight>(Color().setHex(0xdfefff), Color().setHex(0x3a3226), 0.8);
    auto sun = std::make_shared<DirectionalLight>(Color().setHex(0xfff1dc), 2.4);
    sun->position.set(-3, 8, 5);
    scene_.add(*sky);
    scene_.add(*sun);
    scene_.add(*sun->target);
    rockMaterial_ = std::make_shared<Material>(MaterialType::Standard);
    rockMaterial_->color.setHex(0xc49b71);
    rockGeometry_ = makeSphereGeometry(0.65, 5, 3);
    rockGeometry_->deleteAttribute("uv"); // No texture: share only positions, normals and indices (696 bytes).
    // A permanent lit trail marker also keeps the unloaded capture observable.
    auto beacon = std::make_shared<Mesh>(rockGeometry_, rockMaterial_);
    beacon->name = "world-beacon";
    beacon->scale.set(3, 3, 3);
    beacon->position.set(2, heights_->sample(2, 2) + 1.95, 2);
    scene_.add(*beacon);
    camera_.position.set(2, 5, 10);
    camera_.lookAt(2, 0, 2);
    camera_.updateProjectionMatrix();
}

Game WorldWalk::game() {
    Game configured;
    configured.name = mode_;
    configured.scene = &scene_;
    configured.camera = &camera_;
    configured.renderEachTick = true;
    configured.initialize = [this](Renderer& renderer) {
        renderer_ = &renderer;
        geometryUploaded_ = renderer.geometry().stats().bytesUploaded;
        completions_ = std::make_unique<world::CompletionQueue>();
        loads_ = std::make_unique<world::PackageLoads>(*completions_, renderer.gpu(), assets::targetDecoders(), 2);
    };
    configured.update = [this](double) { update(); };
    configured.resource = [this](const std::string& id, uint64_t) {
        return id == "world" ? snapshot() : json::Value::makeNull();
    };
    configured.frameComplete = [this](Renderer& renderer, const auto& diagnostics) { frameComplete(renderer, diagnostics); };
    configured.shutdown = [this] {
        unload();
        if (completions_)
            completions_->destroy();
        loads_.reset();
        completions_.reset();
        renderer_ = nullptr;
    };
    return configured;
}

void WorldWalk::error(world::LoadError failure) {
    std::printf("[Playtest] %s: subsystem %s resource %s recovery %s (%s)\n", failure.code.c_str(),
                failure.subsystem.c_str(), failure.resource.c_str(), recovery(failure.recovery).c_str(), failure.detail.c_str());
    if (failure.recovery == world::Recovery::Fatal) phase_ = "failed";
    errors_.push_back(std::move(failure));
}

void WorldWalk::begin() {
    std::string failure;
    world::IWorldCellsOptions options;
    options.ring = 0;
    options.prefetchSeconds = 0;
    options.residentCells = 2;
    options.instances = 2;
    options.bytes = 64;
    options.admissionBudgetMs = 1;
    world_ = world::WorldCells::create(manifest_, std::as_bytes(std::span(placements_)), options, nullptr, failure);
    if (!world_) {
        error({failure, "world", (fixture_ / "world.json").string(), world::Recovery::Fatal, "world creation refused"});
        return;
    }
    skipped_.clear();
    walkTick_ = settleTicks_ = waitingTicks_ = 0;
    phase_ = "walking";
}

void WorldWalk::release(Cell& cell) {
    ++cell.generation; // Completions from an evicted residency cannot publish later.
    if (cell.request && loads_) loads_->cancel(cell.request);
    cell.request = 0;
    for (const auto& entry : cell.entries) renderer_->gpu().destroy(entry.resource);
    cell.entries.clear();
    if (cell.mesh) cell.mesh->removeFromParent();
    cell.mesh.reset();
    cell.geometry.reset();
    cell.bufferBytes = cell.textureBytes = 0;
    cell.ready = false;
}

void WorldWalk::unload() {
    for (auto& cell : cells_) release(cell);
    if (completions_)
        completions_->drain(); // cancelled/generation-stale results publish nothing
    if (world_) {
        evictions_ += world_->evictions();
        world_->dispose();
    }
    world_.reset();
}

void WorldWalk::update() {
    if (!renderer_ || phase_ == "done" || phase_ == "failed") return;
    updated_ = true;
    frameBytes_ = 0;
    const double start = now();
    completions_->drain(); // also retire cancelled loads during post-unload settling
    if (phase_ == "ready") begin();
    if (phase_ != "walking") { frameMs_ = now() - start; return; }
    if (walkTick_ >= kWalkTicks) {
        unload();
        phase_ = "settling";
        frameMs_ = now() - start;
        return;
    }
    const uint32_t segment = std::min(walkTick_ / 24, uint32_t(kPath.size() - 2));
    const double blend = std::min(1.0, double(walkTick_ - segment * 24) / 24);
    const double x = kPath[segment] + (kPath[segment + 1] - kPath[segment]) * blend;
    walked_ += std::abs(camera_.position.x - x);
    maxCameraX_ = std::max(maxCameraX_, x);
    camera_.position.set(x, 5, 10);
    camera_.lookAt(x, 0, 2);
    world_->update(x, 2, now);
    const auto resident = world_->residentKeys();
    peakResident_ = std::max(peakResident_, uint32_t(resident.size()));
    for (std::size_t index = 0; index < cells_.size(); ++index) {
        auto& cell = cells_[index];
        const bool wanted = std::find(resident.begin(), resident.end(), cell.key) != resident.end();
        if (!wanted) { release(cell); continue; }
        if (cell.request || cell.ready || skipped_.contains(cell.key))
            continue;
        ++attempts_;
        const auto generation = ++cell.generation;
        const std::string file = mode_ == "world-fault" && index == 1 ? "cell-1-corrupt.tnpk" : cell.file;
        cell.request = loads_->load((fixture_ / file).string(), [this, index, generation](world::LoadResult result) {
            auto& current = cells_[index];
            if (current.generation != generation) return;
            current.request = 0;
            if (result.error) {
                // Retry is left eligible for the next update; Skip stays absent for this world.
                if (result.error->recovery == world::Recovery::Skip) skipped_.insert(current.key);
                error(std::move(*result.error));
                return;
            }
            current.entries = std::move(result.entries);
            const auto position = std::find_if(result.package.entries.begin(), result.package.entries.end(),
                                               [](const auto& e) { return e.name == "positions"; });
            if (!result.bytes || position == result.package.entries.end() || current.entries.size() != 2) {
                error({"TN_WORLD_CELL_LAYOUT", "world", current.file, world::Recovery::Fatal, "missing cooked resources"});
                return;
            }
            current.bufferBytes = kPositionBytes;
            current.textureBytes = 4;
            // Use the same verified bytes that loadEntry uploaded; no GPU readback is needed.
            current.geometry = geometry(result.package.data(*position), *heights_, current.origin);
            if (!world_->completeAsset(current.asset, {{{{}, {2}, false}}})) {
                error({"TN_WORLD_CELL_LAYOUT", "world", current.file, world::Recovery::Fatal,
                       "model observation refused"});
                return;
            }
            current.ready = true;
            ++completedLoads_;
            visited_.insert(current.key);
        });
    }
    frameBytes_ = loads_->admit(kByteAllowance);
    world_->update(x, 2, now);
    for (const auto& draw : world_->draws()) {
        for (auto& cell : cells_) {
            if (draw.key != cell.asset + ":0:0" || !cell.ready || cell.mesh) continue;
            cell.mesh = std::make_shared<Mesh>(cell.geometry, material_);
            cell.mesh->name = cell.asset;
            const auto& root = draw.roots.at(0);
            cell.mesh->position.set(root[0], root[1], root[2]);
            auto rock = std::make_shared<Mesh>(rockGeometry_, rockMaterial_);
            rock->name = cell.asset + "-rock";
            rock->position.set(3, heights_->sample(root[0] + 3, root[2] + 2) - root[1] + 0.65, 2);
            cell.mesh->add(*rock);
            scene_.add(*cell.mesh);
        }
    }
    const bool pending = loads_->inFlight() || world_->deferred();
    if (pending) {
        if (++waitingTicks_ > 300)
            error({"TN_WORLD_LOAD_TIMEOUT", "world", fixture_.string(), world::Recovery::Fatal, "cell did not settle in 300 rendered ticks"});
    } else { ++walkTick_; waitingTicks_ = 0; }
    frameMs_ = now() - start;
}

double WorldWalk::slope(const std::vector<Sample>& samples, double Sample::*field) {
    const double center = (samples.size() - 1) / 2.0;
    double numerator = 0, denominator = 0;
    for (std::size_t i = 0; i < samples.size(); ++i) {
        const double x = double(i) - center;
        numerator += x * (samples[i].*field);
        denominator += x * x;
    }
    return numerator / denominator;
}

std::array<uint64_t, 2> WorldWalk::gpuBytes() const {
    std::array<uint64_t, 2> bytes{};
    if (!renderer_) return bytes;
    // Entry sizes are the cooked fixture contract checked by world_walk_fixture. Only live
    // generational handles count; the settling gate also requires deferred destroys to retire.
    for (const auto& cell : cells_) for (const auto& entry : cell.entries) {
        if (renderer_->gpu().status(entry.resource, entry.resource.type) != GpuStatus::Ok) continue;
        if (entry.resource.type == GpuResources::kBuffer) bytes[0] += cell.bufferBytes;
        else if (entry.resource.type == GpuResources::kTexture) bytes[1] += cell.textureBytes;
    }
    const auto stores = [&](const BufferGeometry& geometry) {
        uint64_t size = geometry.index ? geometry.index->store->byteLength() : 0;
        for (const auto& [name, attribute] : geometry.attributes) size += attribute->store->byteLength();
        return size;
    };
    bytes[0] += stores(*rockGeometry_); // Shared by the permanent marker and every placed rock.
    for (const auto& cell : cells_) if (cell.mesh) bytes[0] += stores(*cell.geometry);
    return bytes;
}

void WorldWalk::frameComplete(Renderer& renderer, const std::vector<std::string>& diagnostics) {
    for (const auto& diagnostic : diagnostics) rendererDiagnostics_.insert(diagnostic);
    const auto uploaded = renderer.geometry().stats().bytesUploaded;
    if (updated_) {
        ++frames_;
        frameBytes_ += uploaded - geometryUploaded_;
        maxMs_ = std::max(maxMs_, frameMs_);
        maxBytes_ = std::max(maxBytes_, frameBytes_);
        budgetViolations_ += frameMs_ > kMsAllowance || frameBytes_ > kByteAllowance;
        peakHandles_ = std::max(peakHandles_, renderer.gpu().liveCount());
        if (std::any_of(cells_.begin(), cells_.end(), [](const auto& cell) { return bool(cell.mesh); }) && renderer.lastFrame().draws > 1)
            ++renderedWorldFrames_;
        if (phase_ == "settling" && ++settleTicks_ >= 8 && renderer.gpu().pendingDestroyCount() == 0) {
            const auto bytes = gpuBytes();
            samples_.push_back({heapBytes(), double(bytes[0]), double(bytes[1]),
                                double(renderer.gpu().liveCount()), double(renderer.geometry().entries())});
            ++cycles_;
            phase_ = cycles_ == (mode_ == "world-cycles" ? 10u : 1u) ? "done" : "ready";
        }
        updated_ = false;
    }
    geometryUploaded_ = uploaded;
}

json::Value WorldWalk::snapshot() const {
    using V = json::Value;
    const auto n = [](double value) { return V::makeNumber(value); };
    const auto bytes = gpuBytes();
    std::vector<V> diagnostics, samples, skipped;
    for (const auto& failure : errors_)
        diagnostics.push_back(V::makeObject({{"code", V::makeString(failure.code)}, {"subsystem", V::makeString(failure.subsystem)},
            {"resource", V::makeString(failure.resource)}, {"recovery", V::makeString(recovery(failure.recovery))}}));
    for (const auto& sample : samples_)
        samples.push_back(V::makeObject({{"cpuHeapBytes", n(sample.cpu)}, {"gpuBufferBytes", n(sample.buffers)},
            {"gpuTextureBytes", n(sample.textures)}, {"liveHandles", n(sample.handles)}, {"geometryEntries", n(sample.geometry)}}));
    for (const auto& key : skipped_) skipped.push_back(V::makeString(key));
    const auto trend = [&](double Sample::*field) { return samples_.size() >= 2 ? n(slope(samples_, field)) : V::makeNull(); };
    const auto range = [&](double Sample::*field) {
        if (samples_.empty()) return n(0);
        const auto bounds = std::minmax_element(samples_.begin(), samples_.end(), [&](const auto& a, const auto& b) { return a.*field < b.*field; });
        return n((*bounds.second).*field - (*bounds.first).*field);
    };
    return V::makeObject({{"phase", V::makeString(phase_)}, {"cycles", n(cycles_)}, {"frames", n(frames_)},
        {"walkTicks", n(walkTick_)}, {"walkedMetres", n(walked_)}, {"maxCameraX", n(maxCameraX_)},
        {"residentCells", n(world_ ? world_->residentKeys().size() : 0)}, {"peakResidentCells", n(peakResident_)},
        {"visitedCells", n(visited_.size())}, {"completedLoads", n(completedLoads_)}, {"loadAttempts", n(attempts_)},
        {"evictions", n(evictions_ + (world_ ? world_->evictions() : 0))}, {"renderedWorldFrames", n(renderedWorldFrames_)},
        {"TN_FRAME_BUDGET", V::makeObject({{"admissionMs", n(frameMs_)}, {"admissionBytes", n(frameBytes_)},
            {"maxAdmissionMs", n(maxMs_)}, {"maxAdmissionBytes", n(maxBytes_)}, {"admissionMsAllowance", n(kMsAllowance)},
            {"admissionByteAllowance", n(kByteAllowance)}, {"violations", n(budgetViolations_)}})},
        {"gpuBufferBytes", n(bytes[0])}, {"gpuTextureBytes", n(bytes[1])},
        {"liveHandles", n(renderer_ ? renderer_->gpu().liveCount() : 0)}, {"peakLiveHandles", n(peakHandles_)},
        {"pendingDestroyCount", n(renderer_ ? renderer_->gpu().pendingDestroyCount() : 0)},
        {"inFlight", n(loads_ ? loads_->inFlight() : 0)}, {"pendingCompletions", n(completions_ ? completions_->pending() : 0)},
        {"diagnostics", V::makeArray(std::move(diagnostics))}, {"diagnosticCount", n(errors_.size())},
        {"rendererDiagnosticCount", n(rendererDiagnostics_.size())}, {"skippedCells", V::makeArray(std::move(skipped))},
        {"samples", V::makeArray(std::move(samples))}, {"cpuHeapBytes", n(heapBytes())}, {"cpuRangeBytes", range(&Sample::cpu)},
        {"gpuBufferRangeBytes", range(&Sample::buffers)}, {"gpuTextureRangeBytes", range(&Sample::textures)},
        {"handleRange", range(&Sample::handles)},
        {"cpuSlopeBytesPerCycle", trend(&Sample::cpu)}, {"gpuBufferSlopeBytesPerCycle", trend(&Sample::buffers)},
        {"gpuTextureSlopeBytesPerCycle", trend(&Sample::textures)}, {"handleSlopePerCycle", trend(&Sample::handles)},
        {"geometrySlopePerCycle", trend(&Sample::geometry)}});
}

} // namespace tn::engine::player
