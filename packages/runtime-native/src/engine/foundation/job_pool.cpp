#include "job_pool.h"

#include <cstdlib>
#include <memory>

#ifdef __EMSCRIPTEN_PTHREADS__
#include <emscripten/em_js.h>
#include <emscripten/heap.h>
// A worker that grows the heap refreshes only its own JS views; the caller's HEAPU8, the one the facade
// reads, would keep the old length. The join refreshes the caller's views when a job grew the heap.
EM_JS(void, tn_job_pool_refresh_views, (), { updateMemoryViews(); });
#endif

namespace tn::engine {

namespace {
// A web build without `-pthread` cannot start a thread; the pool is then a loop on the caller.
#if defined(__EMSCRIPTEN__) && !defined(__EMSCRIPTEN_PTHREADS__)
constexpr bool kThreads = false;
#else
constexpr bool kThreads = true;
#endif

std::unique_ptr<JobPool>& sharedSlot() {
    static std::unique_ptr<JobPool> pool;
    return pool;
}
}  // namespace

JobPool::JobPool(unsigned workers) {
    if constexpr (kThreads) {
        threads_.reserve(workers);
        for (unsigned i = 0; i < workers; ++i) threads_.emplace_back([this] { work(); });
    }
}

JobPool::~JobPool() {
    {
        std::lock_guard lock(mutex_);
        stopping_ = true;
    }
    wake_.notify_all();
    for (auto& thread : threads_) thread.join();
}

unsigned JobPool::defaultWorkers() {
    if constexpr (!kThreads) return 0;
#ifndef __EMSCRIPTEN__
    if (const char* named = std::getenv("TN_JOB_WORKERS"); named != nullptr && *named != '\0') {
        char* end = nullptr;
        const unsigned long value = std::strtoul(named, &end, 10);
        if (end != nullptr && *end == '\0') return unsigned(value);
    }
#endif
    // The web build's -sPTHREAD_POOL_SIZE spells the same formula (NativeEngineCore.cmake).
    const unsigned hardware = std::thread::hardware_concurrency();
    const unsigned spare = hardware > 1 ? hardware - 1 : 0;
    return spare < kMaxWorkers ? spare : kMaxWorkers;
}

JobPool& JobPool::shared() {
    auto& pool = sharedSlot();
    if (!pool) pool = std::make_unique<JobPool>(defaultWorkers());
    return *pool;
}

void JobPool::resetShared(unsigned workers) {
    auto& pool = sharedSlot();
    pool.reset();
    pool = std::make_unique<JobPool>(workers);
}

void JobPool::runItems(const Job& job) {
    for (uint32_t i; (i = next_.fetch_add(1, std::memory_order_relaxed)) < job.count;) job.call(job.context, i);
}

void JobPool::run(uint32_t count, Call call, void* context) {
    if (count == 0) return;
    // One job at a time: a second caller (another thread, or an item) runs its items inline.
    if (threads_.empty() || count == 1 || inJob_ || running_.exchange(true, std::memory_order_acquire)) {
        for (uint32_t i = 0; i < count; ++i) call(context, i);
        return;
    }
    runs_.fetch_add(1, std::memory_order_relaxed);
    items_.fetch_add(count, std::memory_order_relaxed);
    const Job job{call, context, count, ++generation_};
    {
        std::lock_guard lock(mutex_);
        next_.store(0, std::memory_order_relaxed);
        pending_.push_back(job);
    }
#ifdef __EMSCRIPTEN_PTHREADS__
    const std::size_t heap = emscripten_get_heap_size();
#endif
    wake_.notify_all();
    inJob_ = true;
    runItems(job);
    inJob_ = false;
    {
        // A worker joins a job only while it is pending, so after this only joined workers remain.
        std::lock_guard lock(mutex_);
        pending_.clear();
    }
    // Not a wait on the GPU or on async work: the items left are CPU work already running on a worker.
    while (busy_.load(std::memory_order_acquire) != 0) {}
    running_.store(false, std::memory_order_release);
#ifdef __EMSCRIPTEN_PTHREADS__
    if (emscripten_get_heap_size() != heap) tn_job_pool_refresh_views();
#endif
}

void JobPool::work() {
    uint64_t seen = 0;
    for (;;) {
        Job job;
        {
            std::unique_lock lock(mutex_);
            wake_.wait(lock, [this] { return stopping_ || !pending_.empty(); });  // TN_WORKER_ONLY: a worker entry parks between jobs
            if (stopping_) return;
            job = pending_.back();
            if (job.generation == seen) {
                // This worker ran its share; the caller clears the job at its join, an item's time away.
                lock.unlock();
                std::this_thread::yield();
                continue;
            }
            seen = job.generation;
            busy_.fetch_add(1, std::memory_order_relaxed);
        }
        inJob_ = true;
        runItems(job);
        inJob_ = false;
        busy_.fetch_sub(1, std::memory_order_release);
    }
}

}  // namespace tn::engine
