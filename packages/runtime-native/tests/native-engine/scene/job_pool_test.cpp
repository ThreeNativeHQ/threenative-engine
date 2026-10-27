// PRD-752 phase 4 / PRD-573 v3.1: the engine's job pool, and the matrix walk it splits. The pool runs every
// item exactly once, at 0 and N workers, nested calls inline. The walk over the pool composes every node,
// revision and visit count of the one-thread walk, bit for bit, frame after frame of random edits.
#include "check.h"
#include "engine/foundation/job_pool.h"
#include "engine/scene/object3d.h"

#include <atomic>
#include <bit>
#include <cstdio>
#include <memory>
#include <random>
#include <thread>
#include <vector>

using namespace tn::engine;

namespace {

void forEachOnce() {
    for (unsigned workers : {0u, 1u, 3u}) {
        JobPool pool(workers);
        CHECK(pool.workers() == workers);
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
    // Two callers at once: the second runs its items inline, and each item still runs once.
    JobPool pool(3);
    std::atomic<uint32_t> first{0}, second{0};
    std::thread other([&] {
        for (int round = 0; round < 200; ++round) pool.forEach(256, [&](uint32_t) { second.fetch_add(1); });
    });
    for (int round = 0; round < 200; ++round) pool.forEach(256, [&](uint32_t) { first.fetch_add(1); });
    other.join();
    CHECK(first.load() == 200u * 256u);
    CHECK(second.load() == 200u * 256u);
    std::printf("job pool: every item ran once at 0, 1 and 3 workers, 500 rounds; two callers at once\n");
}

struct Tree {
    std::vector<std::shared_ptr<Object3D>> nodes;
};

// The same seed builds the same tree: wide groups, deep chains, hidden and frozen subtrees.
Tree build(uint32_t seed, std::size_t count) {
    std::mt19937 random(seed);
    std::uniform_real_distribution<double> unit(-1, 1);
    Tree tree;
    tree.nodes.push_back(std::make_shared<Object3D>());
    for (std::size_t i = 1; i < count; ++i) {
        auto node = std::make_shared<Object3D>();
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

std::size_t differ(const Tree& one, const Tree& many) {
    std::size_t differing = 0;
    for (std::size_t i = 0; i < one.nodes.size(); ++i) {
        const auto& a = *one.nodes[i];
        const auto& b = *many.nodes[i];
        bool same = a.revision() == b.revision();
        for (int e = 0; e < 16; ++e)
            same = same && std::bit_cast<uint64_t>(a.matrixWorld.elements[e]) ==
                               std::bit_cast<uint64_t>(b.matrixWorld.elements[e]);
        differing += same ? 0 : 1;
    }
    return differing;
}

void matrixWalkJobs() {
    constexpr std::size_t kNodes = 6000;
    Tree one = build(7, kNodes), many = build(7, kNodes);
    std::mt19937 editsOne(11), editsMany(11);
    std::size_t differing = 0, visitsDiffer = 0;
    for (int frame = 0; frame < 40; ++frame) {
        const bool prune = frame % 3 != 0;
        JobPool::resetShared(0);
        const uint32_t serial = one.nodes[0]->updateMatrixWorldVisibleJobs(frame == 0, prune);
        JobPool::resetShared(3);
        const uint32_t jobs = many.nodes[0]->updateMatrixWorldVisibleJobs(frame == 0, prune);
        visitsDiffer += serial == jobs ? 0 : 1;
        differing += differ(one, many);
        edit(one, editsOne);
        edit(many, editsMany);
    }
    JobPool::resetShared(0);
    std::printf("matrix walk on 3 workers: %zu nodes, 40 frames, %zu node states differ, %zu visit counts differ\n",
                kNodes, differing, visitsDiffer);
    CHECK(differing == 0);
    CHECK(visitsDiffer == 0);
}

}  // namespace

TN_TEST_MAIN({"for_each_once", forEachOnce}, {"matrix_walk_jobs", matrixWalkJobs})
