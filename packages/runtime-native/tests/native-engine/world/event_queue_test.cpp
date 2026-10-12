// PRD-520 phase 1: the world's completion queue. Worker threads post completions for several
// sources while the game thread runs frames; every completion runs on the game thread, inside a
// frame-boundary drain, in each source's posting order, and none is lost. Destroying the world drops
// what is pending, refuses later posts and runs nothing more, even from a drain already under way.
#include "check.h"
#include "engine/world/events/completion_queue.h"

#include <atomic>
#include <cstdio>
#include <memory>
#include <thread>
#include <vector>

using namespace tn::engine::world;

namespace {

constexpr int kWorkers = 4, kSourcesPerWorker = 3, kPerSource = 2000;

void eventQueue() {
    CompletionQueue queue;
    const std::thread::id game = std::this_thread::get_id();
    std::vector<int> next(kWorkers * kSourcesPerWorker, 0); // game-thread only
    std::atomic<int> finishedWorkers{0};
    bool inDrain = false;
    int wrongThread = 0, outOfOrder = 0, outsideDrain = 0, ran = 0;

    std::vector<std::thread> workers;
    for (int w = 0; w < kWorkers; ++w) {
        workers.emplace_back([&, w, poster = queue.poster()] {
            // Interleave this worker's sources so each one's order is a real constraint.
            for (int i = 0; i < kPerSource; ++i) {
                for (int s = 0; s < kSourcesPerWorker; ++s) {
                    const int source = w * kSourcesPerWorker + s;
                    CHECK(poster.post([&, source, i] {
                        if (std::this_thread::get_id() != game)
                            ++wrongThread;
                        if (!inDrain)
                            ++outsideDrain;
                        if (next[source] != i)
                            ++outOfOrder;
                        next[source] = i + 1;
                        ++ran;
                    }));
                }
                if (i % 97 == 0)
                    std::this_thread::yield();
            }
            ++finishedWorkers;
        });
    }
    int frames = 0;
    for (;;) { // the game loop: one drain per frame boundary
        const bool done = finishedWorkers.load() == kWorkers;
        inDrain = true;
        queue.drain();
        inDrain = false;
        ++frames;
        if (done && queue.pending() == 0)
            break;
        std::this_thread::sleep_for(std::chrono::microseconds(200));
    }
    for (std::thread& t : workers)
        t.join();
    std::printf("event queue: %d completions over %d frames; wrong thread %d, outside a drain %d, out of order %d\n",
                ran, frames, wrongThread, outsideDrain, outOfOrder);
    CHECK(ran == kWorkers * kSourcesPerWorker * kPerSource);
    CHECK(wrongThread == 0 && outsideDrain == 0 && outOfOrder == 0);
    CHECK(frames > 1); // the completions really arrived across frame boundaries
}

void teardown() {
    std::atomic<bool> destroyed{false};
    std::atomic<int> afterDestroy{0}, ran{0};
    auto captured = std::make_shared<int>(0);
    std::weak_ptr<int> watch = captured;
    {
        auto queue = std::make_unique<CompletionQueue>();
        const CompletionQueue::Poster poster = queue->poster();
        std::atomic<bool> stop{false};
        std::atomic<int> refused{0};
        std::thread worker([&, mine = captured] { // its own reference, taken before the reset below
            while (!stop.load()) {
                if (!poster.post([&, keep = mine] {
                        if (destroyed.load())
                            ++afterDestroy;
                        ++ran;
                    }))
                    ++refused;
            }
        });
        captured.reset(); // only pending completions hold it now
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
        queue->drain();
        std::this_thread::sleep_for(std::chrono::milliseconds(5)); // more pending
        queue->destroy();
        destroyed = true;
        CHECK(queue->drain() == 0 && queue->pending() == 0);
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
        stop = true;
        worker.join();
        CHECK(refused.load() > 0); // posts after destroy are refused
        queue.reset();
        CHECK(!poster.post([&] { ++afterDestroy; })); // a poster outliving the world is harmless
    }
    CHECK(watch.expired()); // dropped completions released what they captured

    // A completion that destroys its world mid-drain: the rest of that batch never runs.
    CompletionQueue queue;
    int later = 0;
    queue.poster().post([&] { queue.destroy(); });
    queue.poster().post([&] { ++later; });
    CHECK(queue.drain() == 1 && later == 0 && queue.destroyed());

    std::printf("teardown: %d ran before destroy, %d after\n", ran.load(), afterDestroy.load());
    CHECK(ran.load() > 0 && afterDestroy.load() == 0);
}

} // namespace

TN_TEST_MAIN({"event_queue", eventQueue}, {"teardown", teardown})
