// PRD-752 phase 4 / PRD-573 v3.1: the engine's job pool, and the matrix walk it splits. The pool runs every
// item exactly once, at 0 and N workers, nested calls inline. The walk over the pool composes every node,
// revision and visit count of the one-thread walk, bit for bit, frame after frame of random edits, and keeps
// the pruned walk's contract: a hidden subtree keeps its matrices, a hidden camera is still walked.
#include "check.h"
#include "engine/foundation/job_pool.h"
#include "engine/scene/camera.h"
#include "engine/scene/object3d.h"

#include <atomic>
#include <bit>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <random>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
#if !defined(__EMSCRIPTEN__) && !defined(_WIN32)
#include <sys/resource.h>
#endif

using namespace tn::engine;

namespace {

// A web build without `-pthread` (CI runs this suite as Wasm under node too) starts no threads: the pool
// is a loop on the caller, so it reports no workers and no pool runs.
#if defined(__EMSCRIPTEN__) && !defined(__EMSCRIPTEN_PTHREADS__)
constexpr bool kThreaded = false;
#else
constexpr bool kThreaded = true;
#endif

void forEachOnce() {
    for (unsigned workers : {0u, 1u, 8u, 16u}) {
        JobPool pool(workers);
        CHECK(pool.workers() == (kThreaded ? workers : 0u));
        std::vector<std::atomic<uint32_t>> runs(4096);
        for (int round = 0; round < 500; ++round) {
            const uint32_t count = uint32_t(round * 7 % 4096 + 1);
            pool.forEach(count, [&](uint32_t i) {
                runs[i].fetch_add(1, std::memory_order_relaxed);
                // A nested job runs inline on the thread that asked.
                uint32_t inner = 0;
                pool.forEach(3, [&](uint32_t) { ++inner; });
                if (inner != 3) runs[i].fetch_add(1000, std::memory_order_relaxed);
            });
            for (uint32_t i = 0; i < 4096; ++i) {
                const uint32_t expected = i < count ? 1 : 0;
                if (runs[i].load() != expected) {
                    std::fprintf(stderr, "workers %u round %d item %u ran %u times\n", workers, round, i,
                                 runs[i].load());
                    CHECK(false);
                    return;
                }
                runs[i].store(0);
            }
        }
    }
    // Two callers at once: the second runs its items inline, and each item still runs once. A build
    // without threads has no second caller to start.
    if constexpr (kThreaded) {
        JobPool pool(3);
        std::atomic<uint32_t> first{0}, second{0};
        std::thread other([&] {
            for (int round = 0; round < 200; ++round) pool.forEach(256, [&](uint32_t) { second.fetch_add(1); });
        });
        for (int round = 0; round < 200; ++round) pool.forEach(256, [&](uint32_t) { first.fetch_add(1); });
        other.join();
        CHECK(first.load() == 200u * 256u);
        CHECK(second.load() == 200u * 256u);
    }
    std::printf("job pool: every item ran once at 0, 1, 8 and 16 workers, 500 rounds; two callers at once\n");
}

struct Tree {
    std::vector<std::shared_ptr<Object3D>> nodes;
};

// The same seed builds the same tree: wide groups, deep chains, hidden and frozen subtrees, cameras.
Tree build(uint32_t seed, std::size_t count) {
    std::mt19937 random(seed);
    std::uniform_real_distribution<double> unit(-1, 1);
    Tree tree;
    tree.nodes.push_back(std::make_shared<Object3D>());
    for (std::size_t i = 1; i < count; ++i) {
        auto node = i % 23 == 0 ? std::make_shared<PerspectiveCamera>() : std::make_shared<Object3D>();
        node->position.set(unit(random) * 10, unit(random) * 10, unit(random) * 10);
        node->rotation.set(unit(random), unit(random), unit(random));
        node->scale.set(1 + unit(random) * 0.5, 1 + unit(random) * 0.5, 1 + unit(random) * 0.5);
        // Mostly shallow parents (wide groups), some the previous node (deep chains).
        const std::size_t parent = random() % 4 == 0 ? i - 1 : random() % std::min<std::size_t>(i, 64);
        tree.nodes[parent]->add(*node);
        if (random() % 17 == 0) node->setVisible(false);
        if (random() % 97 == 0) node->matrixAutoUpdate = false;
        tree.nodes.push_back(std::move(node));
    }
    return tree;
}

void edit(Tree& tree, std::mt19937& random) {
    std::uniform_real_distribution<double> unit(-1, 1);
    for (int k = 0; k < 200; ++k) {
        auto& node = tree.nodes[1 + random() % (tree.nodes.size() - 1)];
        switch (random() % 4) {
        case 0: node->position.x = node->position.x + unit(random); break;
        case 1: node->rotation.y = node->rotation.y + unit(random); break;
        case 2: node->setVisible(!node->visible()); break;
        default: node->matrixWorldNeedsUpdate = true; break;
        }
    }
}

bool sameMatrix(const Matrix4& a, const Matrix4& b) {
    for (int e = 0; e < 16; ++e)
        if (std::bit_cast<uint64_t>(a.elements[e]) != std::bit_cast<uint64_t>(b.elements[e])) return false;
    return true;
}

// The pruned walk's contract: a hidden node (not a camera) and everything under it keep their world
// matrices, and a hidden camera under shown parents is walked (it renders from its world matrix).
bool prunedAway(const Object3D& node) {
    for (const Object3D* at = &node; at != nullptr; at = at->parent)
        if (!at->visible() && !at->isCamera()) return true;
    return false;
}

std::size_t differ(const Tree& one, const Tree& many) {
    std::size_t differing = 0;
    for (std::size_t i = 0; i < one.nodes.size(); ++i) {
        const auto& a = *one.nodes[i];
        const auto& b = *many.nodes[i];
        differing += a.revision() == b.revision() && sameMatrix(a.matrixWorld, b.matrixWorld) ? 0 : 1;
    }
    return differing;
}

void matrixWalkJobs() {
    constexpr std::size_t kNodes = 6000;
    Tree one = build(7, kNodes), many = build(7, kNodes);
    std::mt19937 editsOne(11), editsMany(11);
    std::size_t differing = 0, visitsDiffer = 0, composesDiffer = 0, hiddenWalked = 0, camerasStale = 0,
                camerasChecked = 0;
    std::vector<Matrix4> held(kNodes);
    const uint64_t runsBefore = JobPool::runs();
    for (int frame = 0; frame < 40; ++frame) {
        const bool prune = frame % 3 != 0;
        JobPool::resetShared(0);
        uint64_t before = Object3D::matrixEvaluations();
        const uint32_t serial = one.nodes[0]->updateMatrixWorldVisibleJobs(frame == 0, prune);
        const uint64_t serialComposes = Object3D::matrixEvaluations() - before;
        JobPool::resetShared(3);
        for (std::size_t i = 0; i < kNodes; ++i) held[i] = many.nodes[i]->matrixWorld;
        before = Object3D::matrixEvaluations();
        const uint32_t jobs = many.nodes[0]->updateMatrixWorldVisibleJobs(frame == 0, prune);
        if (prune && frame > 0)
            for (std::size_t i = 1; i < kNodes; ++i) {
                const Object3D& node = *many.nodes[i];
                if (prunedAway(node)) {
                    hiddenWalked += sameMatrix(node.matrixWorld, held[i]) ? 0 : 1;
                } else if (!node.visible() && node.isCamera() && node.matrixAutoUpdate) {
                    Matrix4 expected;
                    expected.multiplyMatrices(node.parent->matrixWorld, node.matrix);
                    ++camerasChecked;
                    camerasStale += sameMatrix(expected, node.matrixWorld) ? 0 : 1;
                }
            }
        // The engine-cost counter reads composes per frame: the jobs count every one, as one thread does.
        composesDiffer += Object3D::matrixEvaluations() - before == serialComposes ? 0 : 1;
        visitsDiffer += serial == jobs ? 0 : 1;
        differing += differ(one, many);
        edit(one, editsOne);
        edit(many, editsMany);
    }
    JobPool::resetShared(0);
    const uint64_t poolRuns = JobPool::runs() - runsBefore;
    std::printf("matrix walk on 3 workers: %zu nodes, 40 frames, %llu pool runs, %zu node states differ, %zu visit counts differ, "
                "%zu compose counts differ; pruned frames: %zu hidden-subtree matrices moved, %zu of %zu hidden "
                "cameras stale\n", kNodes, (unsigned long long)poolRuns, differing, visitsDiffer, composesDiffer, hiddenWalked, camerasStale,
                camerasChecked);
    CHECK(kThreaded ? poolRuns > 0 : poolRuns == 0);
    CHECK(hiddenWalked == 0);
    CHECK(camerasChecked > 0);
    CHECK(camerasStale == 0);
    CHECK(differing == 0);
    CHECK(visitsDiffer == 0);
    CHECK(composesDiffer == 0);
}

// The pool pays for itself on composes, not visits: a walk of hidden batch sources (visits only) stays on
// one thread, and a walk that recomposes thousands of nodes shares out.
void matrixWalkThreshold() {
    JobPool::resetShared(3);
    auto root = std::make_shared<Object3D>();
    std::vector<std::shared_ptr<Object3D>> nodes;
    for (std::size_t i = 0; i < 8000; ++i) {
        auto group = std::make_shared<Object3D>();
        group->setVisible(i % 40 == 0);  // 200 shown, 7800 hidden
        root->add(*group);
        nodes.push_back(std::move(group));
    }
    const auto runs = [] { return JobPool::runs(); };
    for (int frame = 0; frame < 3; ++frame) root->updateMatrixWorldVisibleJobs(true, true);
    const uint64_t before = runs();
    for (int frame = 0; frame < 5; ++frame) {
        root->position.x = root->position.x + 1;  // every shown node recomposes
        root->updateMatrixWorldVisibleJobs(false, true);
    }
    const uint64_t hiddenRuns = runs() - before;
    for (auto& node : nodes) node->setVisible(true);
    root->updateMatrixWorldVisibleJobs(false, true);  // 8001 composes: the next walk shares out
    const uint64_t shown = runs();
    root->position.x = root->position.x + 1;
    root->updateMatrixWorldVisibleJobs(false, true);
    const uint64_t shownRuns = runs() - shown;
    JobPool::resetShared(0);
    std::printf("matrix walk threshold: 8000 nodes, 200 shown -> %llu pool runs in 5 frames; all shown -> %llu\n",
                (unsigned long long)hiddenRuns, (unsigned long long)shownRuns);
    CHECK(hiddenRuns == 0);
    CHECK(shownRuns == (kThreaded ? 1u : 0u));
}

// The pool starts on the first walk that shares out, so a realm that walks no large scene (the page that only
// hosts the game's worker) and a read of the engine-cost counters start no threads.
void poolStartsOnNeed() {
    auto root = std::make_shared<Object3D>();
    std::vector<std::shared_ptr<Object3D>> nodes;
    const auto grow = [&](std::size_t count) {
        for (std::size_t i = 0; i < count; ++i) {
            nodes.push_back(std::make_shared<Object3D>());
            root->add(*nodes.back());
        }
    };
    grow(100);
    for (int frame = 0; frame < 3; ++frame) root->updateMatrixWorldVisibleJobs(frame == 0, true);
    (void)JobPool::runs();
    (void)JobPool::items();
    const bool idle = !JobPool::started();
    grow(4000);
    root->updateMatrixWorldVisibleJobs(true, true);
    root->updateMatrixWorldVisibleJobs(true, true);  // 4,101 composes last walk: this one needs the pool
    std::printf("job pool: started after a 101-node walk and a counter read: %s; after a 4,101-node walk: %s\n",
                idle ? "no" : "yes", JobPool::started() ? "yes" : "no");
    CHECK(idle);
    CHECK(JobPool::started());
}

// Worker threads are on wherever a thread can start: the default count is never 0, and naming 0 workers
// (or a count that is not a number) refuses instead of running the engine on one thread.
void poolIsAlwaysOn() {
    if constexpr (!kThreaded) return;
    CHECK(JobPool::defaultWorkers() >= 1);
#ifndef __EMSCRIPTEN__
    for (const char* off : {"0", "none"}) {
        setenv("TN_JOB_WORKERS", off, 1);
        bool refused = false;
        try {
            (void)JobPool::defaultWorkers();
        } catch (const std::runtime_error& error) {
            refused = std::string(error.what()).rfind("TN_JOB_WORKERS_OFF", 0) == 0;
        }
        CHECK(refused);
    }
    setenv("TN_JOB_WORKERS", "2", 1);
    CHECK(JobPool::defaultWorkers() == 2);
    unsetenv("TN_JOB_WORKERS");
#endif
}

// A host with 16 or more logical threads gets the pool's whole cap: the one pooled job that matters is 21-24 ms
// of serial work, and a bench of its shape (132 items x 0.165 ms) runs 3.89 lanes at 3 workers, 7.53 at 8, 8.76
// at 15 and 8.50 at 23, so past 8 the item count is the wall and the extra Workers buy nothing.
void workersCoverTheMachine() {
    if constexpr (!kThreaded) {
        std::printf("job pool: this build starts no thread: the ceiling is not measured\n");
        return;
    }
#ifndef __EMSCRIPTEN__
    unsetenv("TN_JOB_WORKERS");  // the case is about the default, not a named count
#endif
    const unsigned hardware = std::thread::hardware_concurrency();
    const unsigned workers = JobPool::defaultWorkers();
    std::printf("job pool: %u hardware threads -> %u workers, cap %u\n", hardware, workers, JobPool::kMaxWorkers);
    CHECK(workers >= 1);
    CHECK(workers <= JobPool::kMaxWorkers);
    if (hardware >= 16) CHECK(workers >= 8);
}

// The F8 lesson: a larger pool must not make a job's work grow. 200 rounds of an empty 132-item job and of the
// same job where each item writes its own slot must each stay a round trip (the bench measures 0.0106 ms at 23
// workers; 1 ms is a ceiling only a per-item barrier or a per-worker serialisation can break), and the
// engine-cost counter must advance by exactly one item per item.
void dispatchFloor() {
    if constexpr (!kThreaded) {
        std::printf("job pool: this build starts no thread: the dispatch floor is not measured\n");
        return;
    }
    constexpr uint32_t kItems = 132;
    constexpr int kRounds = 200;
    JobPool pool(JobPool::defaultWorkers());
    std::vector<uint32_t> written(kItems);
    pool.forEach(kItems, [](uint32_t) {});  // starts the workers once, outside the measured rounds
    const auto roundTrip = [&](bool write) {
        const auto start = std::chrono::steady_clock::now();
        for (int round = 0; round < kRounds; ++round) {
            if (write)
                pool.forEach(kItems, [&](uint32_t i) { written[i] = i; });
            else
                pool.forEach(kItems, [](uint32_t) {});
        }
        const std::chrono::duration<double, std::milli> spent = std::chrono::steady_clock::now() - start;
        return spent.count() / kRounds;
    };
    const uint64_t before = JobPool::items();
    const double empty = roundTrip(false);
    const double writes = roundTrip(true);
    const uint64_t advanced = JobPool::items() - before;
    uint32_t wrong = 0;
    for (uint32_t i = 0; i < kItems; ++i) wrong += written[i] == i ? 0 : 1;
    std::printf("job pool dispatch floor: %u workers, %d rounds of %u items: %.4f ms empty, %.4f ms writing, "
                "%llu items counted\n", pool.workers(), kRounds, kItems, empty, writes, (unsigned long long)advanced);
    CHECK(empty < 1.0);
    CHECK(writes < 1.0);
    CHECK(wrong == 0);
    CHECK(advanced == uint64_t(kItems) * kRounds * 2);
}

// A spawn the platform refuses fails the pool by name, not by an unnamed std::system_error and not by a silent
// run on one thread (owner, 2026-10-29: "failing closed", web and native). A soft thread limit of 1 refuses
// every std::thread this process starts, which is the same refusal a browser with no Worker left gives.
void poolFailsClosedWhenNoWorkerStarts() {
    if constexpr (!kThreaded) {
        std::printf("job pool: this build starts no thread: the refusal is not measured\n");
        return;
    }
#if defined(RLIMIT_NPROC) && !defined(__EMSCRIPTEN__) && !defined(_WIN32)
    rlimit original{};
    if (getrlimit(RLIMIT_NPROC, &original) != 0) {
        std::printf("job pool: getrlimit(RLIMIT_NPROC) failed: the refusal is not measured\n");
        return;
    }
    rlimit refused = original;
    refused.rlim_cur = 1;  // this process's own thread already meets it, so every spawn is refused
    if (setrlimit(RLIMIT_NPROC, &refused) != 0) {
        std::printf("job pool: setrlimit(RLIMIT_NPROC) failed: the refusal is not measured\n");
        return;
    }
    std::string message;
    unsigned started = 0;
    try {
        JobPool pool(4);
        started = pool.workers();
    } catch (const std::runtime_error& error) {
        message = error.what();
    }
    setrlimit(RLIMIT_NPROC, &original);
    std::printf("job pool: with every spawn refused: %u of 4 started, %s\n", started,
                message.empty() ? "no refusal" : message.c_str());
    CHECK(started == 0);
    CHECK(message.rfind("TN_JOB_WORKERS_START_FAILED: 4 of 4 workers did not start", 0) == 0);
#else
    std::printf("job pool: no per-process thread limit on this platform: the refusal is not measured\n");
#endif
}

}  // namespace

TN_TEST_MAIN({"for_each_once", forEachOnce}, {"matrix_walk_jobs", matrixWalkJobs},
             {"matrix_walk_threshold", matrixWalkThreshold}, {"pool_starts_on_need", poolStartsOnNeed}, {"pool_is_always_on", poolIsAlwaysOn},
             {"dispatch_floor", dispatchFloor}, {"workers_cover_the_machine", workersCoverTheMachine},
             {"pool_fails_closed_when_no_worker_starts", poolFailsClosedWhenNoWorkerStarts})
