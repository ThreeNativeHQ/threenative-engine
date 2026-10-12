#include "check.h"
#include "engine/foundation/reachability.h"

#include <cstdio>
#include <thread>
#include <vector>

using namespace tn::engine;

namespace {

enum : uint16_t { kScene = 1, kMesh, kMaterial, kCallback, kWrapper, kObject };

// Parent/child is observable both ways in three, so both directions are edges.
void attach(ObjectGraph& g, Handle parent, Handle child) {
    g.addEdge(parent, child);
    g.addEdge(child, parent);
}
void detach(ObjectGraph& g, Handle parent, Handle child) {
    g.removeEdge(parent, child);
    g.removeEdge(child, parent);
}

void detachCase() {
    ObjectGraph g(1);
    const Handle scene = g.create(kScene);
    g.root(scene);
    int reclaimed = 0;
    const Handle mesh = g.create(kMesh, [&] { ++reclaimed; });
    attach(g, scene, mesh);
    g.root(mesh);                  // the game still holds it
    detach(g, scene, mesh);        // scene.remove(mesh): detached, not destroyed
    g.collect();
    CHECK(g.alive(mesh));
    CHECK(reclaimed == 0);
    g.unroot(mesh);
    const auto stats = g.collect();
    CHECK(!g.alive(mesh));
    CHECK(reclaimed == 1);
    CHECK(stats.reclaimed == 1);
    CHECK(g.alive(scene));
}

void sharedCase() {
    ObjectGraph g(1);
    const Handle scene = g.create(kScene);
    g.root(scene);
    bool gpuReleased = false;
    int materialReclaimed = 0;
    const Handle material = g.create(kMaterial, [&] { ++materialReclaimed; });
    std::vector<Handle> meshes;
    for (int i = 0; i < 3; ++i) {
        meshes.push_back(g.create(kMesh));
        attach(g, scene, meshes.back());
        g.addEdge(meshes.back(), material);
    }
    gpuReleased = true;            // material.dispose(): the owner frees GPU data, the object stays
    g.collect();
    CHECK(gpuReleased);
    CHECK(g.alive(material));
    CHECK(materialReclaimed == 0);
    for (Handle mesh : meshes) CHECK(g.alive(mesh));
    // Still shared: dropping one mesh keeps the material for the others.
    detach(g, scene, meshes[0]);
    g.collect();
    CHECK(!g.alive(meshes[0]));
    CHECK(g.alive(material));
}

void cycles() {
    ObjectGraph g(1);
    int reclaimed = 0;
    const Handle parent = g.create(kObject, [&] { ++reclaimed; });
    const Handle child = g.create(kObject, [&] { ++reclaimed; });
    attach(g, parent, child);                   // parent <-> child
    const Handle a = g.create(kObject, [&] { ++reclaimed; });
    const Handle b = g.create(kObject, [&] { ++reclaimed; });
    g.addEdge(a, b);                            // a.userData.peer = b
    g.addEdge(b, a);                            // b.userData.peer = a
    g.addEdge(a, a);                            // a.userData.self = a
    const auto stats = g.collect();
    CHECK(stats.reclaimed == 4);
    CHECK(reclaimed == 4);
    CHECK(g.liveCount() == 0);
}

void callbackCycle() {
    ObjectGraph g(1);
    int reclaimed = 0;
    const Handle mesh = g.create(kMesh, [&] { ++reclaimed; });
    const Handle callback = g.create(kCallback, [&] { ++reclaimed; });   // mesh.onBeforeRender
    const Handle wrapper = g.create(kWrapper, [&] { ++reclaimed; });     // the JS object for mesh
    g.addEdge(mesh, callback);
    g.addEdge(callback, wrapper);              // the closure captured the wrapper
    g.addEdge(wrapper, mesh);
    g.root(wrapper);                           // the adapter: script code can still reach it
    g.collect();
    CHECK(g.liveCount() == 3);
    g.unroot(wrapper);                         // the adapter: only the native side reaches it now
    g.collect();
    CHECK(g.liveCount() == 0);
    CHECK(reclaimed == 3);
}

void soak() {
    ObjectGraph g(1);
    const Handle scene = g.create(kScene);
    g.root(scene);
    uint64_t worstPauseNs = 0;
    uint64_t totalPauseNs = 0;
    for (int round = 0; round < 1000; ++round) {
        std::vector<Handle> objects;
        objects.reserve(10000);
        const Handle group = g.create(kObject);
        attach(g, scene, group);
        g.root(group);
        for (int i = 0; i < 10000; ++i) {
            const Handle o = g.create(kObject);
            attach(g, i % 100 == 0 ? group : objects[i - 1], o);   // chains and fans
            objects.push_back(o);
        }
        detach(g, scene, group);
        g.unroot(group);
        const auto stats = g.collect();
        CHECK(stats.reclaimed == 10001);
        worstPauseNs = std::max(worstPauseNs, stats.pauseNs);
        totalPauseNs += stats.pauseNs;
    }
    CHECK(g.liveCount() == 1);   // the scene alone
    CHECK(g.reclaimedTotal() == 1000u * 10001u);
    std::printf("soak: 1000 rounds x 10001 objects, safe-point pause mean %.3f ms worst %.3f ms\n",
                totalPauseNs / 1000.0 / 1e6, worstPauseNs / 1e6);
}

void singleThread() {
    ObjectGraph g(1);
    const std::thread::id engine = std::this_thread::get_id();
    bool sameThread = false;
    const Handle o = g.create(kObject, [&] { sameThread = std::this_thread::get_id() == engine; });
    (void)o;
    g.collect();
    CHECK(sameThread);   // reclamation needs no worker: the Wasm single-thread build runs it as is
}

}  // namespace

TN_TEST_MAIN({"detach", detachCase}, {"shared", sharedCase}, {"cycles", cycles}, {"callback_cycle", callbackCycle},
             {"soak", soak}, {"single_thread", singleThread})
