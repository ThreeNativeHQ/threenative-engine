#pragma once

#include <atomic>
#include <condition_variable>  // TN_WORKER_ONLY: the pool's workers park on it between frame jobs
#include <cstdint>
#include <mutex>
#include <thread>
#include <type_traits>
#include <vector>

namespace tn::engine {

/**
 * The engine's one fork-join pool (PRD-573 v3.1 "Jobs on every core", PRD-752 phase 4), shared by the
 * native hosts and the threaded web build. A frame job hands it `count` independent items; the caller
 * runs items too, so a pool with 0 workers is a plain loop on the calling thread, and a web build
 * without `-pthread` (no cross-origin isolation) always has 0 workers.
 *
 * Fork-join only: `forEach` returns after every item ran, so an item may read anything the caller
 * wrote before the call and must write only what no other item reads. A `forEach` inside an item runs
 * inline (no nested dispatch).
 */
class JobPool {
public:
    /** At most this many workers: the frame's splittable work is a few milliseconds (PRD-752). */
    static constexpr unsigned kMaxWorkers = 3;

    explicit JobPool(unsigned workers);
    ~JobPool();
    JobPool(const JobPool&) = delete;
    JobPool& operator=(const JobPool&) = delete;

    /**
     * The process pool: min(hardware threads - 1, kMaxWorkers) workers, started on first use. On native
     * `TN_JOB_WORKERS=<n>` names the count (0 turns the pool off); the web build reads it from the same
     * formula as its pthread pool (`-sPTHREAD_POOL_SIZE`), so no worker waits on a thread to load.
     */
    static JobPool& shared();
    /** Replaces the process pool with one of `workers` workers: tests run one case at 1 and N threads. */
    static void resetShared(unsigned workers);
    /** The worker count `shared()` starts with. */
    static unsigned defaultWorkers();

    [[nodiscard]] unsigned workers() const { return unsigned(threads_.size()); }
    /** True on a pool worker, and on the caller while it runs items. */
    [[nodiscard]] static bool inJob() { return inJob_; }
    // Engine-cost counters: forEach calls the workers shared, and the items those calls ran.
    [[nodiscard]] uint64_t runs() const { return runs_.load(std::memory_order_relaxed); }
    [[nodiscard]] uint64_t items() const { return items_.load(std::memory_order_relaxed); }

    /** Runs `body(i)` for every `i` in [0, count) across the caller and the workers. */
    template <class F>
    void forEach(uint32_t count, F&& body) {
        run(count, [](void* f, uint32_t i) { (*static_cast<std::remove_reference_t<F>*>(f))(i); },
            const_cast<void*>(static_cast<const void*>(&body)));
    }

private:
    using Call = void (*)(void*, uint32_t);
    struct Job {
        Call call;
        void* context;
        uint32_t count;
        uint64_t generation;
    };
    void run(uint32_t count, Call call, void* context);
    void runItems(const Job& job);
    void work();

    std::vector<std::thread> threads_;
    std::mutex mutex_;
    std::condition_variable wake_;  // TN_WORKER_ONLY: workers park here; the caller only notifies
    // The job in flight, or none: a worker joins it while it is here, and the caller clears it at the join.
    std::vector<Job> pending_;
    uint64_t generation_ = 0;
    bool stopping_ = false;
    std::atomic<uint32_t> next_{0};
    std::atomic<uint32_t> busy_{0};
    std::atomic<uint64_t> runs_{0}, items_{0};
    std::atomic<bool> running_{false};
    inline static thread_local bool inJob_ = false;
};

}  // namespace tn::engine
