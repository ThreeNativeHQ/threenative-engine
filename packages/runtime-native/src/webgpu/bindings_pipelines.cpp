/** WebGPU shader, pipeline, layout, and bind-group bindings. */

#include "bindings_pipelines.h"
#include "bindings_resources.h"
#include "bindings_state.h"
#include "mystral/runtime.h"
#include "mystral/stall_budget.h"
#include "mystral/webgpu/bindings.h"
#include "mystral/webgpu/checked_handle.h"
#include "mystral/webgpu/wrapper_factories.h"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <deque>
#include <functional>
#include <iomanip>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#if defined(MYSTRAL_WEBGPU_WGPU) || defined(MYSTRAL_WEBGPU_DAWN)
#include <webgpu/webgpu.h>
#include "mystral/webgpu_compat.h"
#endif

#if defined(MYSTRAL_WGPU_PIPELINE_CACHE)
// The cache API is wgpu-native's own extension, not part of the shared `webgpu.h` surface, and the
// two distributions place the header differently. `bindings_resources.cpp` probes the same paths.
#if __has_include(<webgpu/wgpu.h>)
#include <webgpu/wgpu.h>
#else
#include <wgpu/wgpu.h>
#endif
#endif

namespace mystral {
namespace webgpu {
#if defined(MYSTRAL_WEBGPU_WGPU) || defined(MYSTRAL_WEBGPU_DAWN)


// ============================================================================
// PRD-327: first-use pipeline compilation leaves the main loop
// ============================================================================
//
// Every distinct pipeline used to be compiled synchronously on the main loop the first time
// something using it was drawn. On a Pixel 8 running Bayview that first frame lasted 12-14 s —
// 8,038 ms across 105 `createRenderPipeline` calls, 67.5 % of an 11.7 s gap — and the warm-up that
// exists to hide it behind the loading screen compiled nothing, because the host answered
// `createRenderPipelineAsync` with the synchronous call wrapped in a resolved promise. The loading
// screen therefore never moved and the player saw a frozen device.
//
// The compile runs on a small host pool rather than through the backend's own async entry.
// Phase 0 measured why (`tests/async_pipeline_thread_test.cpp`): Dawn's entry leaves the thread in
// 0.33 ms of a 73 ms compile, but wgpu-native's is `unimplemented!()` and aborts the process — and
// wgpu-native is what Android ships, which is the platform with the defect. One mechanism that
// works everywhere beats two that each work somewhere.
//
// Both backends' devices are internally synchronised, so calling the synchronous create from a
// worker is legal. What is *not* legal is touching the JS engine from one, so a worker only ever
// pushes a `PipelineCompileCompletion`; `pollEvents()` settles the promise on the game thread.

namespace {

/**
 * A `WGPURenderPipelineDescriptor` that owns everything it points at.
 *
 * The descriptor the handler builds points into locals — entry-point strings, attribute vectors,
 * blend states — that die when the handler returns. The synchronous create reads them before
 * returning so that is fine today; a pool thread reads them later, so it cannot be. Every pointer
 * below is re-aimed at storage this object owns, and the handles it references are ref-counted up
 * so a JavaScript module going out of scope cannot free a shader mid-compile.
 */
struct OwnedRenderPipelineDescriptor {
    std::string label;
    std::string vertexEntryPoint;
    std::string fragmentEntryPoint;
    std::vector<std::string> constantKeys;
    std::vector<WGPUConstantEntry> vertexConstants;
    std::vector<WGPUConstantEntry> fragmentConstants;
    std::vector<WGPUVertexAttribute> attributes;
    std::vector<WGPUVertexBufferLayout> vertexBuffers;
    std::vector<WGPUColorTargetState> targets;
    std::vector<WGPUBlendState> blendStates;
    WGPUDepthStencilState depthStencil = {};
    bool hasDepthStencil = false;
    WGPUFragmentState fragment = {};
    bool hasFragment = false;
    WGPURenderPipelineDescriptor descriptor = {};

    ~OwnedRenderPipelineDescriptor() {
        if (descriptor.vertex.module != nullptr) wgpuShaderModuleRelease(descriptor.vertex.module);
        if (hasFragment && fragment.module != nullptr) wgpuShaderModuleRelease(fragment.module);
        if (descriptor.layout != nullptr) wgpuPipelineLayoutRelease(descriptor.layout);
    }
};

std::string ownStringView(WGPUStringView view) {
    if (view.data == nullptr) return {};
    if (view.length == WGPU_STRLEN) return std::string(view.data);
    return std::string(view.data, view.length);
}

WGPUStringView viewOf(const std::string& owned) {
    WGPUStringView view = {};
    view.data = owned.c_str();
    view.length = owned.size();
    return view;
}

/**
 * Deep-copies a finished descriptor.
 *
 * Written against the finished struct rather than woven into the 350-line builder above, so the
 * synchronous path stays exactly the code it was and there is one obvious place to check when a
 * WebGPU version adds a field. `nextInChain` is deliberately dropped: silently copying a pointer
 * whose target we do not own would be the bug this whole type exists to prevent. PRD-368 does
 * attach a pipeline-cache extension to worker compiles, and it obeys the same rule — the worker
 * rebuilds the extension on its own stack beside the creation call instead of carrying one here.
 */
std::unique_ptr<OwnedRenderPipelineDescriptor> ownDescriptor(
    const WGPURenderPipelineDescriptor& source) {
    auto owned = std::make_unique<OwnedRenderPipelineDescriptor>();
    owned->label = ownStringView(source.label);
    owned->vertexEntryPoint = ownStringView(source.vertex.entryPoint);

    // Constants first: the keys have to live in one vector whose addresses never move again, so
    // both stages' key strings are reserved up front.
    size_t constantCount = source.vertex.constantCount;
    if (source.fragment != nullptr) constantCount += source.fragment->constantCount;
    owned->constantKeys.reserve(constantCount);
    const auto ownConstants = [&](const WGPUConstantEntry* entries, size_t count,
                                  std::vector<WGPUConstantEntry>& into) {
        into.reserve(count);
        for (size_t index = 0; index < count; index += 1) {
            owned->constantKeys.push_back(ownStringView(entries[index].key));
            WGPUConstantEntry entry = entries[index];
            entry.nextInChain = nullptr;
            entry.key = viewOf(owned->constantKeys.back());
            into.push_back(entry);
        }
    };
    ownConstants(source.vertex.constants, source.vertex.constantCount, owned->vertexConstants);

    // Vertex buffers, then their attributes. The attributes of every buffer share one vector, so
    // each layout is re-aimed at its own slice of it once the vector has stopped growing.
    std::vector<size_t> attributeOffsets;
    attributeOffsets.reserve(source.vertex.bufferCount);
    size_t attributeTotal = 0;
    for (size_t index = 0; index < source.vertex.bufferCount; index += 1) {
        attributeTotal += source.vertex.buffers[index].attributeCount;
    }
    owned->attributes.reserve(attributeTotal);
    owned->vertexBuffers.reserve(source.vertex.bufferCount);
    for (size_t index = 0; index < source.vertex.bufferCount; index += 1) {
        const WGPUVertexBufferLayout& layout = source.vertex.buffers[index];
        attributeOffsets.push_back(owned->attributes.size());
        for (size_t attribute = 0; attribute < layout.attributeCount; attribute += 1) {
            owned->attributes.push_back(layout.attributes[attribute]);
        }
        owned->vertexBuffers.push_back(layout);
    }
    for (size_t index = 0; index < owned->vertexBuffers.size(); index += 1) {
        owned->vertexBuffers[index].attributes = owned->attributes.data() + attributeOffsets[index];
    }

    owned->descriptor = source;
    owned->descriptor.nextInChain = nullptr;
    owned->descriptor.label = viewOf(owned->label);
    owned->descriptor.vertex.nextInChain = nullptr;
    owned->descriptor.vertex.entryPoint = viewOf(owned->vertexEntryPoint);
    owned->descriptor.vertex.constantCount = owned->vertexConstants.size();
    owned->descriptor.vertex.constants =
        owned->vertexConstants.empty() ? nullptr : owned->vertexConstants.data();
    owned->descriptor.vertex.bufferCount = owned->vertexBuffers.size();
    owned->descriptor.vertex.buffers =
        owned->vertexBuffers.empty() ? nullptr : owned->vertexBuffers.data();
    owned->descriptor.primitive.nextInChain = nullptr;

    if (source.depthStencil != nullptr) {
        owned->depthStencil = *source.depthStencil;
        owned->depthStencil.nextInChain = nullptr;
        owned->hasDepthStencil = true;
        owned->descriptor.depthStencil = &owned->depthStencil;
    } else {
        owned->descriptor.depthStencil = nullptr;
    }

    if (source.fragment != nullptr) {
        owned->hasFragment = true;
        owned->fragmentEntryPoint = ownStringView(source.fragment->entryPoint);
        ownConstants(source.fragment->constants, source.fragment->constantCount,
                     owned->fragmentConstants);
        owned->blendStates.reserve(source.fragment->targetCount);
        owned->targets.reserve(source.fragment->targetCount);
        for (size_t index = 0; index < source.fragment->targetCount; index += 1) {
            WGPUColorTargetState target = source.fragment->targets[index];
            target.nextInChain = nullptr;
            if (target.blend != nullptr) {
                owned->blendStates.push_back(*target.blend);
            } else {
                // A placeholder keeps `blendStates` index-aligned with `targets`, so the fix-up
                // below is a straight index rather than a second running counter.
                owned->blendStates.push_back(WGPUBlendState{});
            }
            owned->targets.push_back(target);
        }
        for (size_t index = 0; index < owned->targets.size(); index += 1) {
            owned->targets[index].blend = source.fragment->targets[index].blend == nullptr
                                              ? nullptr
                                              : &owned->blendStates[index];
        }
        owned->fragment = *source.fragment;
        owned->fragment.nextInChain = nullptr;
        owned->fragment.entryPoint = viewOf(owned->fragmentEntryPoint);
        owned->fragment.constantCount = owned->fragmentConstants.size();
        owned->fragment.constants =
            owned->fragmentConstants.empty() ? nullptr : owned->fragmentConstants.data();
        owned->fragment.targetCount = owned->targets.size();
        owned->fragment.targets = owned->targets.empty() ? nullptr : owned->targets.data();
        owned->descriptor.fragment = &owned->fragment;
    } else {
        owned->descriptor.fragment = nullptr;
    }

    // Ref-count the handles last, so an early return above cannot leak one.
    if (owned->descriptor.vertex.module != nullptr) {
        wgpuShaderModuleAddRef(owned->descriptor.vertex.module);
    }
    if (owned->hasFragment && owned->fragment.module != nullptr) {
        wgpuShaderModuleAddRef(owned->fragment.module);
    }
    if (owned->descriptor.layout != nullptr) wgpuPipelineLayoutAddRef(owned->descriptor.layout);
    return owned;
}

/**
 * Starts the compile pool on first use.
 *
 * Two threads, not `hardware_concurrency`. The work is a handful of compiles at launch, each of
 * which is itself internally parallel in the driver, and a phone has a small budget of cores that
 * the game thread and the render thread are already competing for.
 */
void ensureCompilePool(BindingsState* state) {
    AsyncPipelineCompiles& pool = state->asyncPipelines;
    if (!pool.workers.empty()) return;
    const unsigned hardware = std::thread::hardware_concurrency();
    const unsigned count = hardware > 2u ? 2u : 1u;
    for (unsigned index = 0; index < count; index += 1) {
        pool.workers.emplace_back([&pool]() {
            while (true) {
                std::function<void()> job;
                {
                    std::unique_lock<std::mutex> lock(pool.mutex);
                    pool.wake.wait(lock, [&pool]() { return pool.stopping || !pool.queue.empty(); });
                    if (pool.stopping && pool.queue.empty()) return;
                    job = std::move(pool.queue.front());
                    pool.queue.pop_front();
                }
                job();
            }
        });
    }
}

/**
 * Hands JavaScript a promise this host can settle later.
 *
 * The engine abstraction has no deferred-promise primitive — every other "async" binding in this
 * host blocks and polls, then returns an already-settled `Promise.resolve()`, which is exactly the
 * shape PRD-327 is removing. So the deferred lives in JavaScript: `install-async-pipelines.js`
 * keeps a map of resolvers, this asks it for one, and `drainAsyncPipelineCompiles` calls the
 * matching settler once the compile lands.
 */
js::JSValueHandle pendingPipelinePromise(BindingsState* state, uint64_t requestId) {
    js::JSValueGuard pending(*state->engine,
                             state->engine->getGlobalProperty("__tnPipelinePending"));
    if (!pending || !state->engine->isFunction(pending.get())) {
        state->engine->throwException(
            "async pipeline creation is not installed (__tnPipelinePending missing)");
        return state->engine->newUndefined();
    }
    js::JSValueGuard thisArg(*state->engine, state->engine->newUndefined());
    js::JSValueGuard id(*state->engine,
                        state->engine->newNumber(static_cast<double>(requestId)));
    return state->engine->call(pending.get(), thisArg.get(), {id.get()});
}

void enqueueCompile(BindingsState* state, std::function<void()> job) {
    ensureCompilePool(state);
    {
        std::lock_guard<std::mutex> lock(state->asyncPipelines.mutex);
        state->asyncPipelines.queue.push_back(std::move(job));
    }
    state->asyncPipelines.wake.notify_one();
}

}  // namespace

static std::string singleWgslEntryPoint(const std::string& code, const char* stage) {
    const std::string marker = std::string("@") + stage;
    std::string result;
    size_t searchFrom = 0;
    while (true) {
        const size_t markerAt = code.find(marker, searchFrom);
        if (markerAt == std::string::npos) break;
        const size_t functionAt = code.find("fn", markerAt + marker.size());
        if (functionAt == std::string::npos) break;
        size_t nameStart = functionAt + 2;
        while (nameStart < code.size() &&
               (code[nameStart] == ' ' || code[nameStart] == '\t' ||
                code[nameStart] == '\r' || code[nameStart] == '\n')) {
            ++nameStart;
        }
        size_t nameEnd = nameStart;
        while (nameEnd < code.size()) {
            const char character = code[nameEnd];
            const bool identifier =
                (character >= 'a' && character <= 'z') ||
                (character >= 'A' && character <= 'Z') ||
                (character >= '0' && character <= '9') || character == '_';
            if (!identifier) break;
            ++nameEnd;
        }
        if (nameEnd == nameStart || !result.empty()) return {};
        result = code.substr(nameStart, nameEnd - nameStart);
        searchFrom = nameEnd;
    }
    return result;
}

/** A process-monotonic origin shared by all pipeline events in one native launch. */
double pipelineClockMs() {
    static const auto origin = std::chrono::steady_clock::now();
    return std::chrono::duration<double, std::milli>(
               std::chrono::steady_clock::now() - origin)
        .count();
}

/** Stable source identity; the full WGSL is deliberately never written to a capture. */
std::string pipelineSourceHash(const std::string& code) {
    uint64_t hash = 14695981039346656037ULL;
    for (const unsigned char character : code) {
        hash ^= character;
        hash *= 1099511628211ULL;
    }
    std::ostringstream formatted;
    formatted << std::hex << std::setw(16) << std::setfill('0') << hash;
    return formatted.str();
}

std::string pipelineJsonString(const std::string& value) {
    std::ostringstream escaped;
    escaped << '"';
    for (const unsigned char character : value) {
        switch (character) {
            case '"': escaped << "\\\""; break;
            case '\\': escaped << "\\\\"; break;
            case '\n': escaped << "\\n"; break;
            case '\r': escaped << "\\r"; break;
            case '\t': escaped << "\\t"; break;
            default:
                if (character < 0x20) {
                    escaped << "\\u" << std::hex << std::setw(4) << std::setfill('0')
                            << static_cast<unsigned int>(character) << std::dec;
                } else {
                    escaped << character;
                }
        }
    }
    escaped << '"';
    return escaped.str();
}

const char* pipelineBackendName(WGPUBackendType backend) {
    switch (backend) {
        case WGPUBackendType_Null: return "null";
        case WGPUBackendType_WebGPU: return "webgpu";
        case WGPUBackendType_D3D11: return "d3d11";
        case WGPUBackendType_D3D12: return "d3d12";
        case WGPUBackendType_Metal: return "metal";
        case WGPUBackendType_Vulkan: return "vulkan";
        case WGPUBackendType_OpenGL: return "opengl";
        case WGPUBackendType_OpenGLES: return "opengles";
        default: return "unknown";
    }
}

static void writePipelineLine(const std::string& line) {
    const size_t written = std::fwrite(line.data(), 1, line.size(), stdout);
    const int flushed = std::fflush(stdout);
    if (written != line.size() || flushed != 0) std::abort();
}

void reportPipelineCaptureMetadata(WGPUAdapter adapter) {
    std::string device;
    std::string vendor;
    std::string architecture;
    std::string description;
    WGPUBackendType backend = WGPUBackendType_Undefined;
    if (adapter != nullptr) {
        WGPUAdapterInfo info = {};
        wgpuAdapterGetInfo(adapter, &info);
        device = ownStringView(info.device);
        vendor = ownStringView(info.vendor);
        architecture = ownStringView(info.architecture);
        description = ownStringView(info.description);
        backend = info.backendType;
        wgpuAdapterInfoFreeMembers(info);
    }
    std::string identity = "native:";
    identity += pipelineBackendName(backend);
    for (const std::string& part : {vendor, device, architecture, description}) {
        if (!part.empty()) identity += "/" + part;
    }
    std::ostringstream line;
    line << "TN_PIPELINE_CAPTURE:{\"version\":1,\"build\":{\"identity\":"
              << pipelineJsonString(std::string("mystral-native@") + mystral::getVersion())
              << "},\"adapter\":{\"identity\":" << pipelineJsonString(identity)
              << ",\"thermal\":\"unavailable\"},\"clock\":{\"source\":\"steady\",\"originMs\":0}}"
              << '\n';
    writePipelineLine(line.str());
}

void reportPipelineFirstPresent() {
    std::ostringstream line;
    line << std::setprecision(17)
              << "TN_PIPELINE_FIRST_PRESENT:{\"version\":1,\"boundaryMs\":"
              << pipelineClockMs() << "}" << '\n';
    writePipelineLine(line.str());
}

void reportPipelineCaptureComplete(uint64_t eventCount) {
    std::ostringstream line;
    line << "TN_PIPELINE_COMPLETE:{\"version\":1,\"eventCount\":"
              << eventCount << "}" << '\n';
    writePipelineLine(line.str());
}

/** Serialize pipeline event writes with their counters and checkpoint snapshots. */
std::mutex& pipelineOutputMutex() {
    static std::mutex mutex;
    return mutex;
}

/**
 * Emit the same bounded event fields that the browser census and perf reader consume.
 *
 * `state` is here only to count the line against the capture that wrote it. The stream is shared
 * by every runtime in the process; the census is not, so the count that a checkpoint reconciles
 * has to belong to one `BindingsState` the way `nextRequestId` and the pool counters do.
 */
static void emitPipelineEvent(BindingsState* state,
                              const PipelineCompileCompletion& completion,
                              uint64_t pipelineId, const char* mode, bool success,
                              const std::string& error = {}) {
    std::lock_guard<std::mutex> outputLock(pipelineOutputMutex());
    const uint64_t identity = pipelineId == 0 ? completion.requestId : pipelineId;
    const std::string kind = completion.render ? "render" : "compute";
    const std::string program = completion.render
        ? completion.vertexHash + "/" + completion.fragmentHash
        : completion.vertexHash;
    const double queueMs = std::max(0.0, completion.startedMs - completion.enqueuedMs);
    const double serviceMs = std::max(0.0, completion.finishedMs - completion.startedMs);
    const double wallMs = std::max(0.0, completion.finishedMs - completion.enqueuedMs);
    std::ostringstream line;
    line << std::setprecision(17)
              << "TN_PIPELINE_EVENT:{\"version\":1,\"eventId\":" << completion.requestId
              << ",\"pipelineIdentity\":\"native-" << kind << '-' << identity
              << "\",\"programIdentity\":" << pipelineJsonString(program)
              << ",\"kind\":" << pipelineJsonString(kind)
              << ",\"pass\":" << pipelineJsonString(completion.render ? "unknown" : "compute")
              << ",\"mode\":" << pipelineJsonString(mode)
              << ",\"status\":\"" << (success ? "created" : "failed") << "\""
              << ",\"startedMs\":" << completion.startedMs
              << ",\"settledMs\":" << completion.finishedMs
              << ",\"queueMs\":" << queueMs << ",\"serviceMs\":" << serviceMs
              << ",\"wallMs\":" << wallMs << ",\"provenance\":{\"unknown\":true}";
    if (!completion.vertexHash.empty()) {
        line << (completion.render ? ",\"vertex\":{\"hash\":" : ",\"compute\":{\"hash\":")
                  << pipelineJsonString(completion.vertexHash)
                  << ",\"bytes\":" << completion.vertexBytes << '}';
    }
    if (!completion.fragmentHash.empty()) {
        line << ",\"fragment\":{\"hash\":"
                  << pipelineJsonString(completion.fragmentHash)
                  << ",\"bytes\":" << completion.fragmentBytes << '}';
    }
    // PRD-368. What the host did, never what the backend found: the cache API reports no
    // per-pipeline hit or miss, so this says a cache of this mode was in force for the creation.
    line << ",\"cache\":" << pipelineJsonString(state->pipelineCache.mode);
    if (!completion.label.empty())
        line << ",\"label\":" << pipelineJsonString(completion.label);
    if (!success) line << ",\"error\":" << pipelineJsonString(error);
    line << "}\n";
    writePipelineLine(line.str());
    state->asyncPipelines.emitted += 1;
}

/**
 * Prints a live snapshot of the capture from a present that reached the display.
 *
 * The Android runner ends a run with `am force-stop`, so `shutdownAsyncPipelineCompiles` — and the
 * `TN_PIPELINE_COMPLETE` it prints — never runs, and a reader cannot tell a whole capture from one
 * the kill cut in half. Joining the compile pool early to get a boundary would change what is being
 * measured; this prints the three counts the host already keeps apart instead:
 *
 * - `requested`, every request id handed out, sync and async alike;
 * - `emitted`, every event line this capture actually wrote;
 * - `outstanding`, compiles the pool has started and not yet settled.
 *
 * `requested == emitted + outstanding` at every point where this can run, so a reader that sees the
 * three disagree, or fewer event lines than `emitted`, is holding a partial capture and must say so
 * rather than report a total. Nothing here is a verdict about the game: the present this rides on
 * is only the instant the counts were read, never a claim that compilation is finished or that the
 * player can play. The finalizer stays exactly as it was and remains the authoritative end of a
 * process that gets to exit.
 */
void reportPipelineCheckpoint(BindingsState* state, uint64_t presentCount) {
    if (state == nullptr) return;
    AsyncPipelineCompiles& pool = state->asyncPipelines;
    // Read every count under the output lock: a line written between reading `emitted` and taking
    // the lock would be a line this checkpoint claims to cover and does not precede.
    std::lock_guard<std::mutex> outputLock(pipelineOutputMutex());
    const uint64_t requested = pool.nextRequestId - 1;
    const uint64_t emitted = pool.emitted;
    const uint64_t outstanding = pool.started > pool.settled ? pool.started - pool.settled : 0;
    if (pool.checkpointRequested == requested && pool.checkpointEmitted == emitted &&
        pool.checkpointOutstanding == outstanding)
        return;
    pool.checkpointRequested = requested;
    pool.checkpointEmitted = emitted;
    pool.checkpointOutstanding = outstanding;
    std::ostringstream line;
    line << "TN_PIPELINE_CHECKPOINT:{\"version\":1,\"present\":" << presentCount
              << ",\"requested\":" << requested << ",\"emitted\":" << emitted
              << ",\"outstanding\":" << outstanding << "}" << '\n';
    writePipelineLine(line.str());
}

// PRD-368. Persistence and lifecycle live in bindings_pipeline_cache.cpp. Attachment stays beside
// each native creation call. It reports supplies, not hits; warm-up and material choices are intact.

/**
 * The handle a creation call should chain, or `nullptr`.
 *
 * Read from worker threads as well as the game thread. That is safe because it is written once,
 * before any pipeline can be requested, and cleared only in `releasePipelineCache`, which
 * `shutdownAsyncPipelineCompiles` calls after it has joined every worker.
 */
#if defined(MYSTRAL_WGPU_PIPELINE_CACHE)
static WGPUPipelineCache livePipelineCache(BindingsState* state) {
    if (state == nullptr || state->pipelineCache.handle == nullptr) return nullptr;
    return static_cast<WGPUPipelineCache>(state->pipelineCache.handle);
}

/**
 * Fills `extension` with the device cache and returns the chain to hang off a descriptor.
 *
 * `extension` has to outlive the creation call it is chained onto, so every caller keeps it on the
 * stack immediately beside that call. Returns `nullptr` when there is no cache, which leaves the
 * descriptor's `nextInChain` exactly as it was and the creation exactly as it used to be.
 */
static const WGPUChainedStruct* attachPipelineCache(BindingsState* state,
                                                    WGPUPipelineCacheExtras& extension,
                                                    bool render) {
    WGPUPipelineCache handle = livePipelineCache(state);
    if (handle == nullptr) return nullptr;
    extension = {};
    extension.chain.sType = static_cast<WGPUSType>(WGPUSType_PipelineCacheExtras);
    extension.cache = handle;
    if (render) {
        state->pipelineCache.renderAttached += 1;
    } else {
        state->pipelineCache.computeAttached += 1;
    }
    return &extension.chain;
}
#endif

void releaseComputePipelineRegistryEntry(BindingsState* state, uint64_t pipelineId) {
    if (!state) return;
    const auto it = state->registries.computePipelineRegistry.find(pipelineId);
    if (it == state->registries.computePipelineRegistry.end())
        return;
    if (it->second) wgpuComputePipelineRelease(it->second);
    state->registries.computePipelineRegistry.erase(it);
    if (state->registries.nextComputePipelineId == pipelineId + 1)
        state->registries.nextComputePipelineId = pipelineId;
}

void releaseRenderPipelineRegistryEntry(BindingsState* state, uint64_t pipelineId) {
    if (!state) return;
    const auto it = state->registries.renderPipelineRegistry.find(pipelineId);
    if (it == state->registries.renderPipelineRegistry.end())
        return;
    if (it->second) wgpuRenderPipelineRelease(it->second);
    state->registries.renderPipelineRegistry.erase(it);
    if (state->registries.nextRenderPipelineId == pipelineId + 1)
        state->registries.nextRenderPipelineId = pipelineId;
}

// Maps JS WebGPU feature names onto this header's WGPUFeatureName values for the
js::JSValueHandle handleGpuDeviceCreatePipelineLayout(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
                            if (args.empty()) {
                                state->engine->throwException("createPipelineLayout requires a descriptor");
                                return state->engine->newUndefined();
                            }
                            auto descriptor = args[0];
                            auto bindGroupLayouts = state->engine->getProperty(descriptor, "bindGroupLayouts");
                            auto lengthProp = state->engine->getProperty(bindGroupLayouts, "length");
                            int layoutCount = state->engine->isUndefined(lengthProp) ? 0 : (int)state->engine->toNumber(lengthProp);
                            std::vector<WGPUBindGroupLayout> layouts;
                            layouts.reserve(layoutCount);
                            for (int i = 0; i < layoutCount; i++) {
                                auto layoutHandle = state->engine->getPropertyIndex(bindGroupLayouts, i);
                                WGPUBindGroupLayout layout = (WGPUBindGroupLayout)state->engine->getPrivateData(layoutHandle);
                                layouts.push_back(layout);
                            }
                            WGPUPipelineLayoutDescriptor layoutDesc = {};
                            layoutDesc.bindGroupLayoutCount = layouts.size();
                            layoutDesc.bindGroupLayouts = layouts.data();
                            WGPUPipelineLayout pipelineLayout = wgpuDeviceCreatePipelineLayout(state->device, &layoutDesc);
                            if (!requireHandle(state->engine, pipelineLayout, "device.createPipelineLayout",
                                               "bindGroupLayouts=" + std::to_string(layouts.size())))
                                return state->engine->newUndefined();
                            auto jsLayout = createNativeWrapper(
                                state, "GPUPipelineLayout", pipelineLayout);
                            if (state->verboseLogging) std::cout << "[WebGPU] Created pipeline layout with " << layoutCount << " bind group layouts" << std::endl;
                            return jsLayout;
}

js::JSValueHandle handleGpuDeviceCreateBindGroup(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
                            if (args.empty()) {
                                state->engine->throwException("createBindGroup requires a descriptor");
                                return state->engine->newUndefined();
                            }
                            auto descriptor = args[0];
                            auto layoutHandle = state->engine->getProperty(descriptor, "layout");
                            WGPUBindGroupLayout layout = (WGPUBindGroupLayout)state->engine->getPrivateData(layoutHandle);
                            if (!layout) {
                                state->engine->throwException("Failed to create bind group");
                                return state->engine->newUndefined();
                            }
                            auto entries = state->engine->getProperty(descriptor, "entries");
                            auto lengthProp = state->engine->getProperty(entries, "length");
                            int entryCount = state->engine->isUndefined(lengthProp) ? 0 : (int)state->engine->toNumber(lengthProp);
                            std::vector<WGPUBindGroupEntry> bindGroupEntries;
                            bindGroupEntries.reserve(entryCount);
                            std::vector<WGPUTextureView> autoCreatedViews;
                            auto releaseAutoCreatedViews = [&autoCreatedViews]() {
                                for (auto v : autoCreatedViews) {
                                    wgpuTextureViewRelease(v);
                                }
                            };
                            auto failResource = [&](const std::string& resourceType, const std::string& reason, uint32_t binding) -> js::JSValueHandle {
                                releaseAutoCreatedViews();
                                const std::string message =
                                    "Failed to create bind group: " + resourceType +
                                    " at binding " + std::to_string(binding) + ": " + reason;
                                state->engine->throwException(message.c_str());
                                return state->engine->newUndefined();
                            };
                            for (int i = 0; i < entryCount; i++) {
                                auto entry = state->engine->getPropertyIndex(entries, i);
                                WGPUBindGroupEntry bgEntry = {};
                                bgEntry.binding = (uint32_t)state->engine->toNumber(state->engine->getProperty(entry, "binding"));
                                auto resource = state->engine->getProperty(entry, "resource");
                                if (state->engine->isUndefined(resource) || state->engine->isNull(resource)) {
                                    return failResource("resource", "resource handle is null or undefined", bgEntry.binding);
                                }
                                // Check if resource is a sampler (has no buffer property)
                                auto bufferProp = state->engine->getProperty(resource, "buffer");
                                if (!state->engine->isUndefined(bufferProp)) {
                                    // Buffer binding: {buffer, offset?, size?}
                                    bgEntry.buffer = (WGPUBuffer)state->engine->getPrivateData(bufferProp);
                                    if (!bgEntry.buffer) {
                                        return failResource("buffer", "native handle is null", bgEntry.binding);
                                    }
                                    auto offset = state->engine->getProperty(resource, "offset");
                                    bgEntry.offset = state->engine->isUndefined(offset) ? 0 : (uint64_t)state->engine->toNumber(offset);
                                    auto size = state->engine->getProperty(resource, "size");
                                    // Size 0 means whole buffer
                                    bgEntry.size = state->engine->isUndefined(size) ? WGPU_WHOLE_SIZE : (uint64_t)state->engine->toNumber(size);
                                } else {
                                    // Could be a sampler or texture view
                                    void* resourcePtr = state->engine->getPrivateData(resource);
                                    // Check for type hints set when creating the object
                                    auto typeHint = state->engine->getProperty(resource, "_type");
                                    if (!state->engine->isUndefined(typeHint)) {
                                        std::string typeStr = state->engine->toString(typeHint);
                                        if (typeStr == "sampler") {
                                            if (resourcePtr) {
                                                bgEntry.sampler = (WGPUSampler)resourcePtr;
                                            } else {
                                                return failResource("sampler", "native handle is null", bgEntry.binding);
                                            }
                                        } else if (typeStr == "textureView") {
                                            if (resourcePtr) {
                                                bgEntry.textureView = (WGPUTextureView)resourcePtr;
                                            } else {
                                                return failResource("texture view", "native handle is null", bgEntry.binding);
                                            }
                                        } else if (!resourcePtr) {
                                            return failResource("resource", "native handle is null", bgEntry.binding);
                                        }
                                    } else if (resourcePtr) {
                                        // No type hint - try to detect based on properties
                                        // Check if it looks like a texture (has width/height/format properties)
                                        auto widthProp = state->engine->getProperty(resource, "width");
                                        auto formatProp = state->engine->getProperty(resource, "format");
                                        if (!state->engine->isUndefined(widthProp) && !state->engine->isUndefined(formatProp)) {
                                            // This is a texture, create a view automatically
                                            WGPUTexture tex = (WGPUTexture)resourcePtr;
                                            WGPUTextureViewDescriptor viewDesc = {};
                                            WGPUTextureView view = wgpuTextureCreateView(tex, &viewDesc);
                                            if (!requireHandle(state->engine, view, "device.createBindGroup/autoTextureView",
                                                               "binding=" + std::to_string(bgEntry.binding))) {
                                                return failResource("texture view", "native handle is null after automatic creation", bgEntry.binding);
                                            }
                                            autoCreatedViews.push_back(view);
                                            bgEntry.textureView = view;
                                            if (state->verboseLogging) std::cout << "[WebGPU] Auto-created texture view for binding " << bgEntry.binding << std::endl;
                                        } else {
                                            // Assume sampler as fallback
                                            bgEntry.sampler = (WGPUSampler)resourcePtr;
                                        }
                                    } else {
                                        return failResource("resource", "native handle is null", bgEntry.binding);
                                    }
                                }
                                bindGroupEntries.push_back(bgEntry);
                            }
                            WGPUBindGroupDescriptor bgDesc = {};
                            bgDesc.layout = layout;
                            bgDesc.entryCount = bindGroupEntries.size();
                            bgDesc.entries = bindGroupEntries.data();
                            WGPUBindGroup bindGroup = wgpuDeviceCreateBindGroup(state->device, &bgDesc);
                            if (!bindGroup) {
                                releaseAutoCreatedViews();
                                // Name the operation in the platform log — logcat is the only place a
                                // phone crash can be read from — then fail closed with this binding's
                                // own message.
                                requireHandle(state->engine, bindGroup, "device.createBindGroup",
                                              "entries=" + std::to_string(bindGroupEntries.size()));
                                state->engine->throwException("Failed to create bind group");
                                return state->engine->newUndefined();
                            }
                            // Release auto-created texture views — Dawn holds its own
                            // internal references through the bind group
                            releaseAutoCreatedViews();
                            auto jsBindGroup = createNativeWrapper(
                                state, "GPUBindGroup", bindGroup);
                            const uint64_t bindGroupId = state->registries.nextBindGroupId++;
                            state->registries.bindGroupRegistry[bindGroupId] = bindGroup;
                            state->engine->setProperty(
                                jsBindGroup, "_bindGroupId",
                                state->engine->newNumber((double)bindGroupId));
                            state->engine->registerRelease(jsBindGroup, [state, bindGroup, bindGroupId]() {
                                state->registries.bindGroupRegistry.erase(bindGroupId);
                                wgpuBindGroupRelease(bindGroup);
                            });
                            if (state->verboseLogging) std::cout << "[WebGPU] Created bind group with " << entryCount << " entries" << std::endl;
                            return jsBindGroup;
}

js::JSValueHandle handleGpuDeviceCreateBindGroupLayout(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
                            if (args.empty()) {
                                state->engine->throwException("createBindGroupLayout requires a descriptor");
                                return state->engine->newUndefined();
                            }
                            auto descriptor = args[0];
                            auto entries = state->engine->getProperty(descriptor, "entries");
                            auto lengthProp = state->engine->getProperty(entries, "length");
                            int entryCount = state->engine->isUndefined(lengthProp) ? 0 : (int)state->engine->toNumber(lengthProp);
                            std::vector<WGPUBindGroupLayoutEntry> layoutEntries;
                            layoutEntries.reserve(entryCount);
                            for (int i = 0; i < entryCount; i++) {
                                auto entry = state->engine->getPropertyIndex(entries, i);
                                WGPUBindGroupLayoutEntry layoutEntry = {};
                                layoutEntry.binding = (uint32_t)state->engine->toNumber(state->engine->getProperty(entry, "binding"));
                                layoutEntry.visibility = (WGPUShaderStage)(uint32_t)state->engine->toNumber(state->engine->getProperty(entry, "visibility"));
                                // Check for buffer binding
                                auto buffer = state->engine->getProperty(entry, "buffer");
                                if (!state->engine->isUndefined(buffer)) {
                                    auto typeProp = state->engine->getProperty(buffer, "type");
                                    std::string typeStr = state->engine->isUndefined(typeProp) ? "" : state->engine->toString(typeProp);
                                    if (typeStr == "uniform" || typeStr == "") {
                                        // Default to uniform if no type specified (Three.js uses empty {})
                                        layoutEntry.buffer.type = WGPUBufferBindingType_Uniform;
                                    } else if (typeStr == "storage") {
                                        layoutEntry.buffer.type = WGPUBufferBindingType_Storage;
                                    } else if (typeStr == "read-only-storage") {
                                        layoutEntry.buffer.type = WGPUBufferBindingType_ReadOnlyStorage;
                                    } else {
                                        // Default to uniform for unknown types
                                        layoutEntry.buffer.type = WGPUBufferBindingType_Uniform;
                                    }
                                    // Dropping these makes every setBindGroup that passes dynamic offsets invalid.
                                    auto dynamicProp = state->engine->getProperty(buffer, "hasDynamicOffset");
                                    layoutEntry.buffer.hasDynamicOffset = !state->engine->isUndefined(dynamicProp) && state->engine->toBoolean(dynamicProp);
                                    auto minSizeProp = state->engine->getProperty(buffer, "minBindingSize");
                                    if (!state->engine->isUndefined(minSizeProp))
                                        layoutEntry.buffer.minBindingSize = (uint64_t)state->engine->toNumber(minSizeProp);
                                }
                                // Check for sampler binding
                                auto sampler = state->engine->getProperty(entry, "sampler");
                                if (!state->engine->isUndefined(sampler)) {
                                    std::string typeStr = state->engine->toString(state->engine->getProperty(sampler, "type"));
                                    if (typeStr == "filtering") {
                                        layoutEntry.sampler.type = WGPUSamplerBindingType_Filtering;
                                    } else if (typeStr == "non-filtering") {
                                        layoutEntry.sampler.type = WGPUSamplerBindingType_NonFiltering;
                                    } else if (typeStr == "comparison") {
                                        layoutEntry.sampler.type = WGPUSamplerBindingType_Comparison;
                                    } else {
                                        // Default to filtering
                                        layoutEntry.sampler.type = WGPUSamplerBindingType_Filtering;
                                    }
                                }
                                // Check for texture binding
                                auto texture = state->engine->getProperty(entry, "texture");
                                if (!state->engine->isUndefined(texture)) {
                                    auto sampleTypeProp = state->engine->getProperty(texture, "sampleType");
                                    std::string sampleType = state->engine->isUndefined(sampleTypeProp) ? "" : state->engine->toString(sampleTypeProp);
                                    if (sampleType == "float" || sampleType == "") {
                                        // Default to float if no type specified (Three.js uses empty {})
                                        layoutEntry.texture.sampleType = WGPUTextureSampleType_Float;
                                    } else if (sampleType == "unfilterable-float") {
                                        layoutEntry.texture.sampleType = WGPUTextureSampleType_UnfilterableFloat;
                                    } else if (sampleType == "depth") {
                                        layoutEntry.texture.sampleType = WGPUTextureSampleType_Depth;
                                    } else if (sampleType == "sint") {
                                        layoutEntry.texture.sampleType = WGPUTextureSampleType_Sint;
                                    } else if (sampleType == "uint") {
                                        layoutEntry.texture.sampleType = WGPUTextureSampleType_Uint;
                                    } else {
                                        // Default to float for unknown types
                                        layoutEntry.texture.sampleType = WGPUTextureSampleType_Float;
                                    }
                                    auto viewDim = state->engine->getProperty(texture, "viewDimension");
                                    if (!state->engine->isUndefined(viewDim)) {
                                        layoutEntry.texture.viewDimension = stringToTextureViewDimension(state->engine->toString(viewDim));
                                    } else {
                                        layoutEntry.texture.viewDimension = WGPUTextureViewDimension_2D;
                                    }
                                    auto multisampled = state->engine->getProperty(texture, "multisampled");
                                    layoutEntry.texture.multisampled = !state->engine->isUndefined(multisampled) && state->engine->toBoolean(multisampled);
                                }
                                // Check for storageTexture binding
                                auto storageTexture = state->engine->getProperty(entry, "storageTexture");
                                if (!state->engine->isUndefined(storageTexture)) {
                                    std::string access = state->engine->toString(state->engine->getProperty(storageTexture, "access"));
                                    if (access == "write-only") {
                                        layoutEntry.storageTexture.access = WGPUStorageTextureAccess_WriteOnly;
                                    } else if (access == "read-only") {
                                        layoutEntry.storageTexture.access = WGPUStorageTextureAccess_ReadOnly;
                                    } else if (access == "read-write") {
                                        layoutEntry.storageTexture.access = WGPUStorageTextureAccess_ReadWrite;
                                    }
                                    auto format = state->engine->getProperty(storageTexture, "format");
                                    if (!state->engine->isUndefined(format)) {
                                        layoutEntry.storageTexture.format = stringToFormat(state->engine->toString(format));
                                    }
                                    auto viewDim = state->engine->getProperty(storageTexture, "viewDimension");
                                    if (!state->engine->isUndefined(viewDim)) {
                                        layoutEntry.storageTexture.viewDimension = stringToTextureViewDimension(state->engine->toString(viewDim));
                                    } else {
                                        layoutEntry.storageTexture.viewDimension = WGPUTextureViewDimension_2D;
                                    }
                                }
                                layoutEntries.push_back(layoutEntry);
                            }
                            WGPUBindGroupLayoutDescriptor layoutDesc = {};
                            layoutDesc.entryCount = layoutEntries.size();
                            layoutDesc.entries = layoutEntries.data();
                            WGPUBindGroupLayout layout = wgpuDeviceCreateBindGroupLayout(state->device, &layoutDesc);
                            if (!requireHandle(state->engine, layout, "device.createBindGroupLayout",
                                               "entries=" + std::to_string(entryCount)))
                                return state->engine->newUndefined();
                            auto jsLayout = createNativeWrapper(
                                state, "GPUBindGroupLayout", layout);
                            if (state->verboseLogging) std::cout << "[WebGPU] Created bind group layout with " << entryCount << " entries" << std::endl;
                            return jsLayout;
}


// device.createQuerySet(descriptor) -> GPUQuerySet
//
// The instrument PRD-228 was filed to build. Every GPU number in the perf record before this was
// obtained by ablating scene content and differencing a blocking device poll in a diagnostic
// build that never ships: that gives a total per object and can never give a cost per pass stage.
static js::JSValueHandle createComputePipelineImpl(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args, bool asyncMode) {
                            // See the render path: an async compile does not run on the main loop,
                            // so counting it in the stall budget would report the removed stall.
                            std::optional<mystral::StallScope> stall;
                            if (!asyncMode) stall.emplace(mystral::StallSegment::PipelineCompile);
                            if (args.empty()) {
                                state->engine->throwException("createComputePipeline requires a descriptor");
                                return state->engine->newUndefined();
                            }
                            auto descriptor = args[0];
                            // Get layout
                            auto layoutProp = state->engine->getProperty(descriptor, "layout");
                            WGPUPipelineLayout layout = nullptr;
                            bool isAutoLayout = false;
                            if (!state->engine->isUndefined(layoutProp) && !state->engine->isString(layoutProp)) {
                                layout = (WGPUPipelineLayout)state->engine->getPrivateData(layoutProp);
                            } else if (state->engine->isString(layoutProp)) {
                                std::string layoutStr = state->engine->toString(layoutProp);
                                if (layoutStr == "auto") {
                                    isAutoLayout = true;
                                    if (state->verboseLogging) std::cout << "[WebGPU] Using 'auto' layout for compute pipeline" << std::endl;
                                    std::cout.flush();
                                }
                            }
                            // Get compute stage
                            auto computeProp = state->engine->getProperty(descriptor, "compute");
                            auto moduleProp = state->engine->getProperty(computeProp, "module");
                            WGPUShaderModule module = (WGPUShaderModule)state->engine->getPrivateData(moduleProp);
                            // Entry point (default "main")
                            std::string entryPoint = "main";
                            auto entryPointProp = state->engine->getProperty(computeProp, "entryPoint");
                            if (!state->engine->isUndefined(entryPointProp)) {
                                entryPoint = state->engine->toString(entryPointProp);
                            }
                            const auto computeMetadata =
                                state->registries.shaderModuleMetadata->entries.find(module);
                            const std::string computeHash =
                                computeMetadata == state->registries.shaderModuleMetadata->entries.end()
                                    ? ""
                                    : computeMetadata->second.hash;
                            const size_t computeBytes =
                                computeMetadata == state->registries.shaderModuleMetadata->entries.end()
                                    ? 0
                                    : computeMetadata->second.bytes;
                            // Create pipeline
                            WGPUComputePipelineDescriptor pipelineDesc = {};
                            pipelineDesc.layout = layout;
                            pipelineDesc.compute.module = module;
                            WGPU_SET_ENTRY_POINT(pipelineDesc.compute, entryPoint.c_str());
                            if (asyncMode) {
                                // A compute descriptor owns far less than a render one: a module
                                // handle, an entry point and a layout. Copying it needs no arena.
                                const uint64_t requestId = state->asyncPipelines.nextRequestId++;
                                state->asyncPipelines.started += 1;
                                const double enqueuedMs = pipelineClockMs();
                                WGPUDevice device = state->device;
                                if (module != nullptr) wgpuShaderModuleAddRef(module);
                                if (layout != nullptr) wgpuPipelineLayoutAddRef(layout);
                                enqueueCompile(state, [state, device, requestId, module, layout,
                                                       entryPoint, computeHash, computeBytes,
                                                       enqueuedMs]() {
                                    const double startedMs = pipelineClockMs();
                                    WGPUComputePipelineDescriptor descriptor = {};
                                    descriptor.layout = layout;
                                    descriptor.compute.module = module;
                                    WGPU_SET_ENTRY_POINT(descriptor.compute, entryPoint.c_str());
#if defined(MYSTRAL_WGPU_PIPELINE_CACHE)
                                    // PRD-368. The cache outlives every worker: the pool is joined
                                    // before `releasePipelineCache` runs.
                                    WGPUPipelineCacheExtras cacheExtension = {};
                                    descriptor.nextInChain =
                                        attachPipelineCache(state, cacheExtension, false);
#endif
                                    PipelineCompileCompletion completion;
                                    completion.requestId = requestId;
                                    completion.render = false;
                                    completion.enqueuedMs = enqueuedMs;
                                    completion.startedMs = startedMs;
                                    completion.computePipeline =
                                        createCachedComputePipeline(state, device, &descriptor);
                                    completion.finishedMs = pipelineClockMs();
                                    completion.vertexHash = computeHash;
                                    completion.vertexBytes = computeBytes;
                                    if (completion.computePipeline == nullptr) {
                                        completion.error = "Failed to create compute pipeline";
                                    }
                                    if (module != nullptr) wgpuShaderModuleRelease(module);
                                    if (layout != nullptr) wgpuPipelineLayoutRelease(layout);
                                    std::lock_guard<std::mutex> lock(state->asyncPipelines.completedMutex);
                                    state->asyncPipelines.completed.push_back(std::move(completion));
                                });
                                return pendingPipelinePromise(state, requestId);
                            }
                            PipelineCompileCompletion observation;
                            observation.requestId = state->asyncPipelines.nextRequestId++;
                            observation.render = false;
                            observation.enqueuedMs = pipelineClockMs();
                            observation.startedMs = observation.enqueuedMs;
                            observation.vertexHash = computeHash;
                            observation.vertexBytes = computeBytes;
#if defined(MYSTRAL_WGPU_PIPELINE_CACHE)
                            WGPUPipelineCacheExtras cacheExtension = {};
                            pipelineDesc.nextInChain =
                                attachPipelineCache(state, cacheExtension, false);
#endif
                            WGPUComputePipeline pipeline = createCachedComputePipeline(state, state->device, &pipelineDesc);
                            observation.finishedMs = pipelineClockMs();
                            if (!pipeline) {
                                emitPipelineEvent(state, observation, 0, "sync", false,
                                                   "Failed to create compute pipeline");
                                state->engine->throwException("Failed to create compute pipeline");
                                return state->engine->newUndefined();
                            }
                            // Register pipeline for getBindGroupLayout
                            uint64_t pipelineId = state->registries.nextComputePipelineId++;
                            state->registries.computePipelineRegistry[pipelineId] = pipeline;
                            auto jsPipeline = createPipelineWrapper(state, pipeline, pipelineId, false);
                            emitPipelineEvent(state, observation, pipelineId, "sync", true);
                            if (state->verboseLogging) std::cout << "[WebGPU] Compute pipeline created (id=" << pipelineId << ")" << std::endl;
                            return jsPipeline;
}

js::JSValueHandle handleGpuDeviceCreateComputePipeline(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
    return createComputePipelineImpl(state, bindingDestination, args, false);
}

js::JSValueHandle handleGpuDeviceCreateComputePipelineAsync(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
    return createComputePipelineImpl(state, bindingDestination, args, true);
}

/**
 * Builds the descriptor once and either compiles it here or hands it to the pool.
 *
 * The 350 lines between here and the creation are unchanged: they read the descriptor out of
 * JavaScript, which only the game thread may do, and they are identical work for both paths. Only
 * what happens at the end differs.
 */
static js::JSValueHandle createRenderPipelineImpl(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args, bool asyncMode) {
                            // The stall budget measures what the main loop paid. An async compile
                            // does not run here, so counting it would report the very stall this
                            // change removes.
                            std::optional<mystral::StallScope> stall;
                            if (!asyncMode) stall.emplace(mystral::StallSegment::PipelineCompile);
                            if (args.empty()) {
                                state->engine->throwException("createRenderPipeline requires a descriptor");
                                return state->engine->newUndefined();
                            }
                            const size_t blendStatesBefore = state->registries.blendStates.size();
                            const auto rollbackBlendStates = [&]() {
                                state->registries.blendStates.resize(blendStatesBefore);
                            };
                            auto descriptor = args[0];
                            // Get vertex stage
                            auto vertex = state->engine->getProperty(descriptor, "vertex");
                            auto vertexModule = state->engine->getProperty(vertex, "module");
                            WGPUShaderModule vsModule =
                                (WGPUShaderModule)state->engine->getPrivateData(vertexModule);
                            auto vertexEntryProp = state->engine->getProperty(vertex, "entryPoint");
                            const bool hasVertexEntry = !state->engine->isUndefined(vertexEntryProp);
                            const auto vertexMetadata = state->registries.shaderModuleMetadata->entries.find(vsModule);
                            std::string vertexEntry =
                                hasVertexEntry ? state->engine->toString(vertexEntryProp)
                                : vertexMetadata != state->registries.shaderModuleMetadata->entries.end()
                                    ? vertexMetadata->second.vertexEntryPoint
                                    : "";
                            if (vertexEntry.empty()) {
                                state->engine->throwException(
                                    "createRenderPipeline: omitted vertex entryPoint requires exactly one @vertex function");
                                return state->engine->newUndefined();
                            }
                            // Get fragment stage (optional - depth-only pipelines don't have fragment)
                            auto fragment = state->engine->getProperty(descriptor, "fragment");
                            WGPUShaderModule fsModule = nullptr;
                            std::string fragmentEntry;
                            bool hasFragment = !state->engine->isUndefined(fragment) && !state->engine->isNull(fragment);
                            if (hasFragment) {
                                auto fragmentModule = state->engine->getProperty(fragment, "module");
                                fsModule = (WGPUShaderModule)state->engine->getPrivateData(fragmentModule);
                                auto fragEntryProp = state->engine->getProperty(fragment, "entryPoint");
                                if (!state->engine->isUndefined(fragEntryProp)) {
                                    fragmentEntry = state->engine->toString(fragEntryProp);
                                } else {
                                    const auto fragmentMetadata =
                                        state->registries.shaderModuleMetadata->entries.find(fsModule);
                                    fragmentEntry =
                                        fragmentMetadata != state->registries.shaderModuleMetadata->entries.end()
                                            ? fragmentMetadata->second.fragmentEntryPoint
                                            : "";
                                    if (fragmentEntry.empty()) {
                                        state->engine->throwException(
                                            "createRenderPipeline: omitted fragment entryPoint requires exactly one @fragment function");
                                        return state->engine->newUndefined();
                                    }
                                }
                            }
                            const auto fragmentMetadataForCapture =
                                state->registries.shaderModuleMetadata->entries.find(fsModule);
                            const std::string vertexHash =
                                vertexMetadata == state->registries.shaderModuleMetadata->entries.end()
                                    ? ""
                                    : vertexMetadata->second.hash;
                            const size_t vertexBytes =
                                vertexMetadata == state->registries.shaderModuleMetadata->entries.end()
                                    ? 0
                                    : vertexMetadata->second.bytes;
                            const std::string fragmentHash =
                                fragmentMetadataForCapture == state->registries.shaderModuleMetadata->entries.end()
                                    ? ""
                                    : fragmentMetadataForCapture->second.hash;
                            const size_t fragmentBytes =
                                fragmentMetadataForCapture == state->registries.shaderModuleMetadata->entries.end()
                                    ? 0
                                    : fragmentMetadataForCapture->second.bytes;
                            auto labelProp = state->engine->getProperty(descriptor, "label");
                            const std::string pipelineLabel =
                                state->engine->isUndefined(labelProp)
                                    ? ""
                                    : state->engine->toString(labelProp);
                            // Create pipeline descriptor
                            WGPURenderPipelineDescriptor pipelineDesc = {};
                            // Carry the label the game already set into the native descriptor so a
                            // backend validation error names this pipeline instead of an unlabeled
                            // one. `ownDescriptor()` copies `source.label` for the async path.
                            pipelineDesc.label = viewOf(pipelineLabel);
                            // Check for layout property
                            auto layoutProp = state->engine->getProperty(descriptor, "layout");
                            if (!state->engine->isUndefined(layoutProp)) {
                                // Check if it's "auto" string or a PipelineLayout object
                                if (state->engine->isString(layoutProp)) {
                                    std::string layoutStr = state->engine->toString(layoutProp);
                                    if (layoutStr == "auto") {
                                        pipelineDesc.layout = nullptr;  // Auto layout
                                    }
                                } else {
                                    // It's a PipelineLayout object
                                    WGPUPipelineLayout layout = (WGPUPipelineLayout)state->engine->getPrivateData(layoutProp);
                                    pipelineDesc.layout = layout;
                                }
                            }
                            // Vertex state
                            pipelineDesc.vertex.module = vsModule;
                            WGPU_SET_ENTRY_POINT(pipelineDesc.vertex, vertexEntry.c_str());
                            // Parse vertex buffers if present
                            std::vector<WGPUVertexBufferLayout> vertexBuffers;
                            std::vector<std::vector<WGPUVertexAttribute>> allAttributes; // Keep attributes alive
                            auto buffersArray = state->engine->getProperty(vertex, "buffers");
                            if (!state->engine->isUndefined(buffersArray)) {
                                auto buffersLen = state->engine->getProperty(buffersArray, "length");
                                int bufferCount = (int)state->engine->toNumber(buffersLen);
                                for (int i = 0; i < bufferCount; i++) {
                                    auto buffer = state->engine->getPropertyIndex(buffersArray, i);
                                    WGPUVertexBufferLayout layout = {};
                                    layout.arrayStride = (uint64_t)state->engine->toNumber(state->engine->getProperty(buffer, "arrayStride"));
                                    layout.stepMode = WGPUVertexStepMode_Vertex;
                                    // Parse step mode if present
                                    auto stepModeProp = state->engine->getProperty(buffer, "stepMode");
                                    if (!state->engine->isUndefined(stepModeProp)) {
                                        std::string stepModeStr = state->engine->toString(stepModeProp);
                                        if (stepModeStr == "instance") {
                                            layout.stepMode = WGPUVertexStepMode_Instance;
                                        }
                                    }
                                    // Parse attributes
                                    auto attrsArray = state->engine->getProperty(buffer, "attributes");
                                    if (!state->engine->isUndefined(attrsArray)) {
                                        auto attrsLen = state->engine->getProperty(attrsArray, "length");
                                        int attrCount = (int)state->engine->toNumber(attrsLen);
                                        std::vector<WGPUVertexAttribute> attributes;
                                        for (int j = 0; j < attrCount; j++) {
                                            auto attr = state->engine->getPropertyIndex(attrsArray, j);
                                            WGPUVertexAttribute va = {};
                                            va.shaderLocation = (uint32_t)state->engine->toNumber(state->engine->getProperty(attr, "shaderLocation"));
                                            va.offset = (uint64_t)state->engine->toNumber(state->engine->getProperty(attr, "offset"));
                                            std::string formatStr = state->engine->toString(state->engine->getProperty(attr, "format"));
                                            // Parse vertex format
                                            if (formatStr == "float32") va.format = WGPUVertexFormat_Float32;
                                            else if (formatStr == "float32x2") va.format = WGPUVertexFormat_Float32x2;
                                            else if (formatStr == "float32x3") va.format = WGPUVertexFormat_Float32x3;
                                            else if (formatStr == "float32x4") va.format = WGPUVertexFormat_Float32x4;
                                            else if (formatStr == "uint8x2") va.format = WGPUVertexFormat_Uint8x2;
                                            else if (formatStr == "uint8x4") va.format = WGPUVertexFormat_Uint8x4;
                                            else if (formatStr == "sint8x2") va.format = WGPUVertexFormat_Sint8x2;
                                            else if (formatStr == "sint8x4") va.format = WGPUVertexFormat_Sint8x4;
                                            else if (formatStr == "unorm8x2") va.format = WGPUVertexFormat_Unorm8x2;
                                            else if (formatStr == "unorm8x4") va.format = WGPUVertexFormat_Unorm8x4;
                                            else if (formatStr == "snorm8x2") va.format = WGPUVertexFormat_Snorm8x2;
                                            else if (formatStr == "snorm8x4") va.format = WGPUVertexFormat_Snorm8x4;
                                            else if (formatStr == "uint16x2") va.format = WGPUVertexFormat_Uint16x2;
                                            else if (formatStr == "uint16x4") va.format = WGPUVertexFormat_Uint16x4;
                                            else if (formatStr == "sint16x2") va.format = WGPUVertexFormat_Sint16x2;
                                            else if (formatStr == "sint16x4") va.format = WGPUVertexFormat_Sint16x4;
                                            else if (formatStr == "unorm16x2") va.format = WGPUVertexFormat_Unorm16x2;
                                            else if (formatStr == "unorm16x4") va.format = WGPUVertexFormat_Unorm16x4;
                                            else if (formatStr == "snorm16x2") va.format = WGPUVertexFormat_Snorm16x2;
                                            else if (formatStr == "snorm16x4") va.format = WGPUVertexFormat_Snorm16x4;
                                            else if (formatStr == "float16x2") va.format = WGPUVertexFormat_Float16x2;
                                            else if (formatStr == "float16x4") va.format = WGPUVertexFormat_Float16x4;
                                            else if (formatStr == "uint32") va.format = WGPUVertexFormat_Uint32;
                                            else if (formatStr == "uint32x2") va.format = WGPUVertexFormat_Uint32x2;
                                            else if (formatStr == "uint32x3") va.format = WGPUVertexFormat_Uint32x3;
                                            else if (formatStr == "uint32x4") va.format = WGPUVertexFormat_Uint32x4;
                                            else if (formatStr == "sint32") va.format = WGPUVertexFormat_Sint32;
                                            else if (formatStr == "sint32x2") va.format = WGPUVertexFormat_Sint32x2;
                                            else if (formatStr == "sint32x3") va.format = WGPUVertexFormat_Sint32x3;
                                            else if (formatStr == "sint32x4") va.format = WGPUVertexFormat_Sint32x4;
                                            else va.format = WGPUVertexFormat_Float32x3; // Default
                                            attributes.push_back(va);
                                        }
                                        allAttributes.push_back(attributes);
                                        layout.attributeCount = attributes.size();
                                        layout.attributes = allAttributes.back().data();
                                    }
                                    vertexBuffers.push_back(layout);
                                }
                                pipelineDesc.vertex.bufferCount = vertexBuffers.size();
                                pipelineDesc.vertex.buffers = vertexBuffers.data();
                            }
                            // Fragment state (only if fragment shader exists)
                            WGPUColorTargetState colorTarget = {};
                            WGPUFragmentState fragmentState = {};
                            std::vector<WGPUColorTargetState> colorTargets;
                            bool targetsExplicitlySpecified = false;
                            if (hasFragment && fsModule) {
                                // Parse targets from fragment descriptor
                                auto targetsProp = state->engine->getProperty(fragment, "targets");
                                if (!state->engine->isUndefined(targetsProp)) {
                                    targetsExplicitlySpecified = true;  // Even if empty array
                                    auto targetsLen = state->engine->getProperty(targetsProp, "length");
                                    int targetCount = (int)state->engine->toNumber(targetsLen);
                                    for (int i = 0; i < targetCount; i++) {
                                        auto target = state->engine->getPropertyIndex(targetsProp, i);
                                        WGPUColorTargetState targetState = {};
                                        auto formatProp = state->engine->getProperty(target, "format");
                                        if (!state->engine->isUndefined(formatProp)) {
                                            std::string formatStr = state->engine->toString(formatProp);
                                            targetState.format = stringToFormat(formatStr);
                                            if (targetCount >= 5) {
                                                if (state->verboseLogging) std::cout << "[WebGPU] Pipeline target " << i << ": format=" << formatStr << " (enum=" << targetState.format << ")" << std::endl;
                                            }
                                        } else {
                                            targetState.format = state->presentation.surfaceFormat;
                                        }
                                        targetState.writeMask = WGPUColorWriteMask_All;
                                        // Parse blend state if provided
                                        auto blendProp = state->engine->getProperty(target, "blend");
                                        if (!state->engine->isUndefined(blendProp)) {
                                            // Store blend state in a persistent container
                                            auto blendState = std::make_unique<WGPUBlendState>();
                                            // Helper lambda to parse blend factor
                                            auto parseBlendFactor = [](const std::string& str) -> WGPUBlendFactor {
                                                if (str == "zero") return WGPUBlendFactor_Zero;
                                                if (str == "one") return WGPUBlendFactor_One;
                                                if (str == "src") return WGPUBlendFactor_Src;
                                                if (str == "one-minus-src") return WGPUBlendFactor_OneMinusSrc;
                                                if (str == "src-alpha") return WGPUBlendFactor_SrcAlpha;
                                                if (str == "one-minus-src-alpha") return WGPUBlendFactor_OneMinusSrcAlpha;
                                                if (str == "dst") return WGPUBlendFactor_Dst;
                                                if (str == "one-minus-dst") return WGPUBlendFactor_OneMinusDst;
                                                if (str == "dst-alpha") return WGPUBlendFactor_DstAlpha;
                                                if (str == "one-minus-dst-alpha") return WGPUBlendFactor_OneMinusDstAlpha;
                                                if (str == "src-alpha-saturated") return WGPUBlendFactor_SrcAlphaSaturated;
                                                if (str == "constant") return WGPUBlendFactor_Constant;
                                                if (str == "one-minus-constant") return WGPUBlendFactor_OneMinusConstant;
                                                return WGPUBlendFactor_One;  // Default
                                            };
                                            // Helper lambda to parse blend operation
                                            auto parseBlendOp = [](const std::string& str) -> WGPUBlendOperation {
                                                if (str == "add") return WGPUBlendOperation_Add;
                                                if (str == "subtract") return WGPUBlendOperation_Subtract;
                                                if (str == "reverse-subtract") return WGPUBlendOperation_ReverseSubtract;
                                                if (str == "min") return WGPUBlendOperation_Min;
                                                if (str == "max") return WGPUBlendOperation_Max;
                                                return WGPUBlendOperation_Add;  // Default
                                            };
                                            // Parse color blend component
                                            auto colorProp = state->engine->getProperty(blendProp, "color");
                                            if (!state->engine->isUndefined(colorProp)) {
                                                auto srcFactor = state->engine->getProperty(colorProp, "srcFactor");
                                                auto dstFactor = state->engine->getProperty(colorProp, "dstFactor");
                                                auto operation = state->engine->getProperty(colorProp, "operation");
                                                if (!state->engine->isUndefined(srcFactor))
                                                    blendState->color.srcFactor = parseBlendFactor(state->engine->toString(srcFactor));
                                                else
                                                    blendState->color.srcFactor = WGPUBlendFactor_One;
                                                if (!state->engine->isUndefined(dstFactor))
                                                    blendState->color.dstFactor = parseBlendFactor(state->engine->toString(dstFactor));
                                                else
                                                    blendState->color.dstFactor = WGPUBlendFactor_Zero;
                                                if (!state->engine->isUndefined(operation))
                                                    blendState->color.operation = parseBlendOp(state->engine->toString(operation));
                                                else
                                                    blendState->color.operation = WGPUBlendOperation_Add;
                                            } else {
                                                // Default color blend (no blending)
                                                blendState->color.srcFactor = WGPUBlendFactor_One;
                                                blendState->color.dstFactor = WGPUBlendFactor_Zero;
                                                blendState->color.operation = WGPUBlendOperation_Add;
                                            }
                                            // Parse alpha blend component
                                            auto alphaProp = state->engine->getProperty(blendProp, "alpha");
                                            if (!state->engine->isUndefined(alphaProp)) {
                                                auto srcFactor = state->engine->getProperty(alphaProp, "srcFactor");
                                                auto dstFactor = state->engine->getProperty(alphaProp, "dstFactor");
                                                auto operation = state->engine->getProperty(alphaProp, "operation");
                                                if (!state->engine->isUndefined(srcFactor))
                                                    blendState->alpha.srcFactor = parseBlendFactor(state->engine->toString(srcFactor));
                                                else
                                                    blendState->alpha.srcFactor = WGPUBlendFactor_One;
                                                if (!state->engine->isUndefined(dstFactor))
                                                    blendState->alpha.dstFactor = parseBlendFactor(state->engine->toString(dstFactor));
                                                else
                                                    blendState->alpha.dstFactor = WGPUBlendFactor_Zero;
                                                if (!state->engine->isUndefined(operation))
                                                    blendState->alpha.operation = parseBlendOp(state->engine->toString(operation));
                                                else
                                                    blendState->alpha.operation = WGPUBlendOperation_Add;
                                            } else {
                                                // Default alpha blend (no blending)
                                                blendState->alpha.srcFactor = WGPUBlendFactor_One;
                                                blendState->alpha.dstFactor = WGPUBlendFactor_Zero;
                                                blendState->alpha.operation = WGPUBlendOperation_Add;
                                            }
                                            targetState.blend = blendState.get();
                                            state->registries.blendStates.push_back(std::move(blendState));
                                            if (state->verboseLogging) std::cout << "[WebGPU] Pipeline target " << i << " has blend state" << std::endl;
                                        }
                                        colorTargets.push_back(targetState);
                                    }
                                }
                                // Only add default target if targets wasn't explicitly specified
                                // If targets: [] was specified, don't add any (depth-only pass)
                                if (colorTargets.empty() && !targetsExplicitlySpecified) {
                                    // Default single target only when targets is not specified at all
                                    colorTarget.format = state->presentation.surfaceFormat;
                                    colorTarget.writeMask = WGPUColorWriteMask_All;
                                    colorTargets.push_back(colorTarget);
                                }
                                fragmentState.module = fsModule;
                                WGPU_SET_ENTRY_POINT(fragmentState, fragmentEntry.c_str());
                                fragmentState.targetCount = colorTargets.size();
                                fragmentState.targets = colorTargets.data();
                                pipelineDesc.fragment = &fragmentState;
                                if (state->verboseLogging) std::cout << "[WebGPU] Render pipeline with " << colorTargets.size() << " color targets" << std::endl;
                            } else {
                                // Depth-only pipeline - no fragment state
                                pipelineDesc.fragment = nullptr;
                            }
                            // Primitive state
                            pipelineDesc.primitive.topology = WGPUPrimitiveTopology_TriangleList;
                            pipelineDesc.primitive.stripIndexFormat = WGPUIndexFormat_Undefined;
                            pipelineDesc.primitive.frontFace = WGPUFrontFace_CCW;
                            pipelineDesc.primitive.cullMode = WGPUCullMode_None;
                            // Parse primitive state if provided
                            auto primitiveProp = state->engine->getProperty(descriptor, "primitive");
                            if (!state->engine->isUndefined(primitiveProp)) {
                                auto topologyProp = state->engine->getProperty(primitiveProp, "topology");
                                if (!state->engine->isUndefined(topologyProp)) {
                                    std::string topologyStr = state->engine->toString(topologyProp);
                                    if (topologyStr == "point-list") pipelineDesc.primitive.topology = WGPUPrimitiveTopology_PointList;
                                    else if (topologyStr == "line-list") pipelineDesc.primitive.topology = WGPUPrimitiveTopology_LineList;
                                    else if (topologyStr == "line-strip") pipelineDesc.primitive.topology = WGPUPrimitiveTopology_LineStrip;
                                    else if (topologyStr == "triangle-list") pipelineDesc.primitive.topology = WGPUPrimitiveTopology_TriangleList;
                                    else if (topologyStr == "triangle-strip") pipelineDesc.primitive.topology = WGPUPrimitiveTopology_TriangleStrip;
                                }
                                auto cullModeProp = state->engine->getProperty(primitiveProp, "cullMode");
                                if (!state->engine->isUndefined(cullModeProp)) {
                                    std::string cullModeStr = state->engine->toString(cullModeProp);
                                    if (cullModeStr == "none") pipelineDesc.primitive.cullMode = WGPUCullMode_None;
                                    else if (cullModeStr == "front") pipelineDesc.primitive.cullMode = WGPUCullMode_Front;
                                    else if (cullModeStr == "back") pipelineDesc.primitive.cullMode = WGPUCullMode_Back;
                                }
                                auto frontFaceProp = state->engine->getProperty(primitiveProp, "frontFace");
                                if (!state->engine->isUndefined(frontFaceProp)) {
                                    std::string frontFaceStr = state->engine->toString(frontFaceProp);
                                    if (frontFaceStr == "ccw") pipelineDesc.primitive.frontFace = WGPUFrontFace_CCW;
                                    else if (frontFaceStr == "cw") pipelineDesc.primitive.frontFace = WGPUFrontFace_CW;
                                }
                            }
                            // Depth stencil state
                            WGPUDepthStencilState depthStencilState = {};
                            bool hasDepthStencil = false;
                            auto depthStencilProp = state->engine->getProperty(descriptor, "depthStencil");
                            if (!state->engine->isUndefined(depthStencilProp)) {
                                hasDepthStencil = true;
                                auto formatProp = state->engine->getProperty(depthStencilProp, "format");
                                if (!state->engine->isUndefined(formatProp)) {
                                    depthStencilState.format = stringToFormat(state->engine->toString(formatProp));
                                } else {
                                    depthStencilState.format = WGPUTextureFormat_Depth24Plus;
                                }
                                auto depthWriteEnabledProp = state->engine->getProperty(depthStencilProp, "depthWriteEnabled");
                                depthStencilState.depthWriteEnabled = state->engine->isUndefined(depthWriteEnabledProp)
                                    ? WGPU_OPTIONAL_BOOL_TRUE
                                    : (state->engine->toBoolean(depthWriteEnabledProp) ? WGPU_OPTIONAL_BOOL_TRUE : WGPU_OPTIONAL_BOOL_FALSE);
                                auto depthCompareProp = state->engine->getProperty(depthStencilProp, "depthCompare");
                                if (!state->engine->isUndefined(depthCompareProp)) {
                                    std::string compareStr = state->engine->toString(depthCompareProp);
                                    if (compareStr == "never") depthStencilState.depthCompare = WGPUCompareFunction_Never;
                                    else if (compareStr == "less") depthStencilState.depthCompare = WGPUCompareFunction_Less;
                                    else if (compareStr == "less-equal") depthStencilState.depthCompare = WGPUCompareFunction_LessEqual;
                                    else if (compareStr == "greater") depthStencilState.depthCompare = WGPUCompareFunction_Greater;
                                    else if (compareStr == "greater-equal") depthStencilState.depthCompare = WGPUCompareFunction_GreaterEqual;
                                    else if (compareStr == "equal") depthStencilState.depthCompare = WGPUCompareFunction_Equal;
                                    else if (compareStr == "not-equal") depthStencilState.depthCompare = WGPUCompareFunction_NotEqual;
                                    else if (compareStr == "always") depthStencilState.depthCompare = WGPUCompareFunction_Always;
                                } else {
                                    depthStencilState.depthCompare = WGPUCompareFunction_Less;
                                }
                                // Default stencil operations
                                depthStencilState.stencilFront.compare = WGPUCompareFunction_Always;
                                depthStencilState.stencilFront.failOp = WGPUStencilOperation_Keep;
                                depthStencilState.stencilFront.depthFailOp = WGPUStencilOperation_Keep;
                                depthStencilState.stencilFront.passOp = WGPUStencilOperation_Keep;
                                depthStencilState.stencilBack = depthStencilState.stencilFront;
                                depthStencilState.stencilReadMask = 0xFFFFFFFF;
                                depthStencilState.stencilWriteMask = 0xFFFFFFFF;
                                pipelineDesc.depthStencil = &depthStencilState;
                            }
                            // Multisample state - parse from descriptor or use defaults
                            pipelineDesc.multisample.count = 1;
                            pipelineDesc.multisample.mask = 0xFFFFFFFF;
                            pipelineDesc.multisample.alphaToCoverageEnabled = false;
                            auto multisampleProp = state->engine->getProperty(descriptor, "multisample");
                            if (!state->engine->isUndefined(multisampleProp)) {
                                auto countProp = state->engine->getProperty(multisampleProp, "count");
                                if (!state->engine->isUndefined(countProp)) {
                                    pipelineDesc.multisample.count = (uint32_t)state->engine->toNumber(countProp);
                                }
                                auto maskProp = state->engine->getProperty(multisampleProp, "mask");
                                if (!state->engine->isUndefined(maskProp)) {
                                    pipelineDesc.multisample.mask = (uint32_t)state->engine->toNumber(maskProp);
                                }
                                auto alphaToCoverageProp = state->engine->getProperty(multisampleProp, "alphaToCoverageEnabled");
                                if (!state->engine->isUndefined(alphaToCoverageProp)) {
                                    pipelineDesc.multisample.alphaToCoverageEnabled = state->engine->toBoolean(alphaToCoverageProp);
                                }
                                if (state->verboseLogging) {
                                    std::cout << "[WebGPU] Render pipeline multisample: count=" << pipelineDesc.multisample.count
                                              << ", mask=" << pipelineDesc.multisample.mask << std::endl;
                                }
                            }
                            if (asyncMode) {
                                // Everything the pool needs, copied out of storage that dies with
                                // this call. `state` and `device` outlive every compile: the pool
                                // is joined in `shutdownAsyncPipelineCompiles` before either goes.
                                auto owned = ownDescriptor(pipelineDesc);
                                const uint64_t requestId = state->asyncPipelines.nextRequestId++;
                                state->asyncPipelines.started += 1;
                                const double enqueuedMs = pipelineClockMs();
                                WGPUDevice device = state->device;
                                enqueueCompile(state, [state, device, requestId,
                                                       descriptor = std::shared_ptr<OwnedRenderPipelineDescriptor>(std::move(owned)),
                                                       enqueuedMs, vertexHash, vertexBytes,
                                                       fragmentHash, fragmentBytes,
                                                       pipelineLabel]() {
                                    const double startedMs = pipelineClockMs();
                                    PipelineCompileCompletion completion;
                                    completion.requestId = requestId;
                                    completion.render = true;
                                    completion.enqueuedMs = enqueuedMs;
                                    completion.startedMs = startedMs;
                                    completion.vertexHash = vertexHash;
                                    completion.vertexBytes = vertexBytes;
                                    completion.fragmentHash = fragmentHash;
                                    completion.fragmentBytes = fragmentBytes;
                                    completion.label = pipelineLabel;
                                    // PRD-368. `ownDescriptor()` drops `nextInChain` by design, so
                                    // the cache extension is rebuilt here against storage this
                                    // frame owns rather than copied out of a pointer nobody owns.
                                    WGPURenderPipelineDescriptor request = descriptor->descriptor;
#if defined(MYSTRAL_WGPU_PIPELINE_CACHE)
                                    WGPUPipelineCacheExtras cacheExtension = {};
                                    request.nextInChain =
                                        attachPipelineCache(state, cacheExtension, true);
#endif
                                    completion.renderPipeline =
                                        createCachedRenderPipeline(state, device, &request);
                                    completion.finishedMs = pipelineClockMs();
                                    if (completion.renderPipeline == nullptr) {
                                        completion.error = "Failed to create render pipeline";
                                    }
                                    std::lock_guard<std::mutex> lock(state->asyncPipelines.completedMutex);
                                    state->asyncPipelines.completed.push_back(std::move(completion));
                                });
                                return pendingPipelinePromise(state, requestId);
                            }
                            // Create pipeline
                            PipelineCompileCompletion observation;
                            observation.requestId = state->asyncPipelines.nextRequestId++;
                            observation.render = true;
                            observation.enqueuedMs = pipelineClockMs();
                            observation.startedMs = observation.enqueuedMs;
                            observation.vertexHash = vertexHash;
                            observation.vertexBytes = vertexBytes;
                            observation.fragmentHash = fragmentHash;
                            observation.fragmentBytes = fragmentBytes;
                            observation.label = pipelineLabel;
#if defined(MYSTRAL_WGPU_PIPELINE_CACHE)
                            WGPUPipelineCacheExtras cacheExtension = {};
                            pipelineDesc.nextInChain =
                                attachPipelineCache(state, cacheExtension, true);
#endif
                            WGPURenderPipeline pipeline = createCachedRenderPipeline(state, state->device, &pipelineDesc);
                            observation.finishedMs = pipelineClockMs();
                            if (!pipeline) {
                                rollbackBlendStates();
                                emitPipelineEvent(state, observation, 0, "sync", false,
                                                  "Failed to create render pipeline");
                                state->engine->throwException("Failed to create render pipeline");
                                return state->engine->newUndefined();
                            }
                            // Register pipeline for getBindGroupLayout
                            uint64_t pipelineId = state->registries.nextRenderPipelineId++;
                            state->registries.renderPipelineRegistry[pipelineId] = pipeline;
                            auto jsPipeline = createPipelineWrapper(state, pipeline, pipelineId, true);
                            if (state->engine->hasException()) rollbackBlendStates();
                            emitPipelineEvent(state, observation, pipelineId, "sync", true);
                            if (state->verboseLogging) std::cout << "[WebGPU] Render pipeline created (id=" << pipelineId << ")" << std::endl;
                            return jsPipeline;
}

js::JSValueHandle handleGpuDeviceCreateRenderPipeline(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
    return createRenderPipelineImpl(state, bindingDestination, args, false);
}

js::JSValueHandle handleGpuDeviceCreateRenderPipelineAsync(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
    return createRenderPipelineImpl(state, bindingDestination, args, true);
}

/**
 * Settles every finished compile on the game thread.
 *
 * Called from `pollEvents()`'s `kIo` segment, which is where worker completions already cross into
 * the engine — the one place in the loop where entering JavaScript from work that finished
 * elsewhere is already the established shape.
 */
void drainAsyncPipelineCompiles(BindingsState* state) {
    if (state == nullptr || state->engine == nullptr) return;
    std::vector<PipelineCompileCompletion> finished;
    {
        std::lock_guard<std::mutex> lock(state->asyncPipelines.completedMutex);
        if (state->asyncPipelines.completed.empty()) return;
        finished.swap(state->asyncPipelines.completed);
    }
    js::JSValueGuard settle(*state->engine,
                            state->engine->getGlobalProperty("__tnPipelineSettle"));
    const bool canSettle = settle && state->engine->isFunction(settle.get());
    for (auto& completion : finished) {
        state->asyncPipelines.settled += 1;
        js::JSValueGuard thisArg(*state->engine, state->engine->newUndefined());
        js::JSValueGuard id(*state->engine,
                            state->engine->newNumber(static_cast<double>(completion.requestId)));
        if (!completion.error.empty()) {
            emitPipelineEvent(state, completion, 0, "async", false, completion.error);
            if (canSettle) {
                js::JSValueGuard nothing(*state->engine, state->engine->newUndefined());
                js::JSValueGuard error(*state->engine,
                                       state->engine->newString(completion.error.c_str()));
                js::JSValueGuard ignored(
                    *state->engine,
                    state->engine->call(settle.get(), thisArg.get(),
                                        {id.get(), nothing.get(), error.get()}));
            }
            continue;
        }
        if (!canSettle) {
            emitPipelineEvent(state, completion, 0, "async", true);
            if (completion.renderPipeline != nullptr) wgpuRenderPipelineRelease(completion.renderPipeline);
            if (completion.computePipeline != nullptr) wgpuComputePipelineRelease(completion.computePipeline);
            continue;
        }
        // Registration is identical to the synchronous path's, and has to happen here rather than
        // on the worker: the registries are game-thread state.
        js::JSValueHandle wrapper;
        if (completion.render) {
            const uint64_t pipelineId = state->registries.nextRenderPipelineId++;
            state->registries.renderPipelineRegistry[pipelineId] = completion.renderPipeline;
            wrapper = createPipelineWrapper(state, completion.renderPipeline, pipelineId, true);
        } else {
            const uint64_t pipelineId = state->registries.nextComputePipelineId++;
            state->registries.computePipelineRegistry[pipelineId] = completion.computePipeline;
            wrapper = createPipelineWrapper(state, completion.computePipeline, pipelineId, false);
        }
        const uint64_t pipelineId = completion.render
            ? state->registries.nextRenderPipelineId - 1
            : state->registries.nextComputePipelineId - 1;
        emitPipelineEvent(state, completion, pipelineId, "async", true);
        js::JSValueGuard pipeline(*state->engine, wrapper);
        js::JSValueGuard undefinedError(*state->engine, state->engine->newUndefined());
        js::JSValueGuard ignored(
            *state->engine,
            state->engine->call(settle.get(), thisArg.get(),
                                {id.get(), pipeline.get(), undefinedError.get()}));
    }
}

/** Joins the pool. Called before the device and the bindings state go away. */
void shutdownAsyncPipelineCompiles(BindingsState* state) {
    if (state == nullptr) return;
    AsyncPipelineCompiles& pool = state->asyncPipelines;
    if (pool.finalized) return;
    {
        std::lock_guard<std::mutex> lock(pool.mutex);
        pool.stopping = true;
    }
    if (!pool.workers.empty()) {
        pool.wake.notify_all();
        for (auto& worker : pool.workers) {
            if (worker.joinable()) worker.join();
        }
        pool.workers.clear();
    }
    // Jobs the workers never reached still own their descriptor, and an
    // `OwnedRenderPipelineDescriptor` releases a shader module and a pipeline layout when it dies.
    // Left in the queue they would die with `BindingsState` — which is freed *after* the device —
    // and release handles into a destroyed device. That is a SIGSEGV during shutdown, and it is
    // what this clear exists to prevent: drop them here, while the device is still alive.
    {
        std::lock_guard<std::mutex> lock(pool.mutex);
        pool.queue.clear();
    }
    // A worker can finish after the last pollEvents() call. Drain those completions while the
    // engine and registries are still alive, so the completion count and event stream reconcile.
    drainAsyncPipelineCompiles(state);
    // A pipeline that finished after the last drain still holds a backend handle.
    {
        std::lock_guard<std::mutex> lock(pool.completedMutex);
        for (auto& completion : pool.completed) {
            if (completion.renderPipeline != nullptr) wgpuRenderPipelineRelease(completion.renderPipeline);
            if (completion.computePipeline != nullptr) wgpuComputePipelineRelease(completion.computePipeline);
        }
        pool.completed.clear();
    }
    pool.finalized = true;
    // PRD-368. Only now is it safe: a worker still compiling would be reading the handle this
    // releases. The report it prints is the last statement of what the cache actually did.
    releasePipelineCache(state);
    reportPipelineCaptureComplete(pool.nextRequestId - 1);
}

js::JSValueHandle handleGpuDeviceCreateShaderModule(BindingsState* state, BindingDestination bindingDestination, const std::vector<js::JSValueHandle>& args) {
                            mystral::StallScope stall(mystral::StallSegment::ShaderCompile);
                            if (args.empty()) {
                                state->engine->throwException("createShaderModule requires a descriptor");
                                return state->engine->newUndefined();
                            }
                            auto descriptor = args[0];
                            std::string code = state->engine->toString(state->engine->getProperty(descriptor, "code"));
                            // Debug: Print first 500 chars of shader code
                            if (state->verboseLogging && code.length() > 0) {
                                std::cout << "[Shader] Creating shader (" << code.length() << " chars):\n"
                                          << code.substr(0, std::min((size_t)500, code.length()))
                                          << (code.length() > 500 ? "\n..." : "") << std::endl;
                            }
                            WGPUShaderModuleWGSLDescriptor_Compat wgslDesc = {};
                            WGPUShaderModuleDescriptor shaderDesc = {};
                            setupShaderModuleWGSL(&shaderDesc, &wgslDesc, code.c_str());
                            WGPUShaderModule shaderModule = wgpuDeviceCreateShaderModule(state->device, &shaderDesc);
                            if (!requireHandle(state->engine, shaderModule, "device.createShaderModule",
                                               "wgslBytes=" + std::to_string(code.size())))
                                return state->engine->newUndefined();
                            auto jsShader = createNativeWrapper(
                                state, "GPUShaderModule", shaderModule);
                            state->registries.shaderModuleMetadata->entries[shaderModule] = {
                                singleWgslEntryPoint(code, "vertex"),
                                singleWgslEntryPoint(code, "fragment"),
                                pipelineSourceHash(code),
                                code.size(),
                            };
                            state->engine->registerRelease(
                                jsShader, [metadata = std::weak_ptr<ShaderModuleMetadataStore>(
                                               state->registries.shaderModuleMetadata),
                                           shaderModule]() {
                                    const auto shaderModuleMetadata = metadata.lock();
                                    if (shaderModuleMetadata) {
                                        shaderModuleMetadata->release(shaderModule, &wgpuShaderModuleRelease);
                                    }
                                });
                            return jsShader;
}


#endif
}  // namespace webgpu
}  // namespace mystral
