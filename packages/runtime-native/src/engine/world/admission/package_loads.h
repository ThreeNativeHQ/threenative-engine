#pragma once

#include <cstdint>
#include <condition_variable> // TN_WORKER_ONLY: PackageLoads IO worker parking, never game-thread completion.
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#include "engine/renderer/package_loader.h"
#include "engine/world/events/completion_queue.h"

namespace tn::engine::world {

/**
 * How a failed load may be recovered (§12): `Retry` the same request later (the file was not there
 * or not readable), `Skip` this resource and keep the world running (its bytes are bad or need a
 * decoder this build lacks), or `Fatal`, the world cannot continue (it was cooked for another
 * package format).
 */
enum class Recovery { Retry, Skip, Fatal };

/** A failed load: stable code, the subsystem that refused it, the resource and how to recover. */
struct LoadError {
    std::string code;      // TN_WORLD_IO_UNAVAILABLE, TN_PACKAGE_*, TN_NATIVE_*_UNSUPPORTED
    std::string subsystem; // "io", "assets" or "gpu"
    std::string resource;  // the package path, plus `#entry` when one entry refused
    Recovery recovery;
    std::string detail;
};

struct LoadResult {
    std::vector<LoadedEntry> entries;
    std::optional<LoadError> error;
    // Verified CPU data stays valid through done(), without an upload/readback round trip.
    std::shared_ptr<const std::vector<uint8_t>> bytes;
    assets::Package package;
};

/**
 * Cooked-package loads for a world (PRD-520). A worker thread reads and verifies each package and
 * posts its completion to the world's queue; on the game thread, after the queue drains, `admit`
 * uploads verified entries within a byte allowance per frame, so a large load spreads over frames,
 * and calls `done` once every entry is resident (or once the load fails).
 *
 * `cancel` is safe at any point: `done` never runs for a cancelled load, and entries it already
 * uploaded are destroyed through GpuResources, whose GPU objects live on until every submission
 * that may use them has completed. Destroying the world's queue first is safe too: a worker's
 * completion is refused, so nothing of that world runs afterwards.
 *
 * IO workers are reused across requests; dispatch never creates or joins a thread.
 */
class PackageLoads {
  public:
    using Done = std::function<void(LoadResult)>;

    PackageLoads(CompletionQueue& completions, GpuResources& gpu, uint32_t availableDecoders,
                 uint32_t concurrency = 12);
    ~PackageLoads();
    PackageLoads(const PackageLoads&) = delete;
    PackageLoads& operator=(const PackageLoads&) = delete;

    uint64_t load(std::string path, Done done);
    void cancel(uint64_t id);
    /** Game thread: uploads verified entries until `byteAllowance` is spent. Returns the bytes uploaded. */
    uint64_t admit(uint64_t byteAllowance);
    [[nodiscard]] std::size_t inFlight() const { return requests_.size(); }
    /** What a load in flight has made resident so far (empty for an unknown or finished id). */
    [[nodiscard]] std::vector<LoadedEntry> uploaded(uint64_t id) const;

  private:
    struct Request {
        uint64_t id;
        std::string path;
        Done done;
        std::shared_ptr<std::vector<uint8_t>> bytes;
        assets::Package package;
        bool verified = false;
        std::size_t next = 0; // the next entry `admit` uploads
        std::vector<LoadedEntry> uploaded;
    };
    Request* find(uint64_t id);
    void finish(uint64_t id, LoadResult result);

    CompletionQueue::Poster poster_;
    GpuResources& gpu_;
    uint32_t decoders_;
    uint64_t nextId_ = 0;
    std::vector<std::unique_ptr<Request>> requests_; // game thread only
    std::vector<std::thread> workers_;
    std::mutex mutex_;
    std::condition_variable work_; // TN_WORKER_ONLY: only the persistent IO worker entry waits.
    std::deque<std::pair<uint64_t, std::string>> pending_;
    bool stopping_ = false;
    std::shared_ptr<int> alive_ = std::make_shared<int>(0); // completions hold it weakly
};

} // namespace tn::engine::world
