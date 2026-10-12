// PRD-520 phase 2 and PRD-528 phase 1: cooked-package loads for a world, on a real (headless) GPU.
// `failure`: a load that cannot complete reports a stable code, the subsystem, the resource and a
// recovery class, and is never a silent hole. `cancel`: cancelling a half-uploaded load while the GPU
// still reads one of its buffers destroys the handles at once and the GPU objects only after that
// work completes, and its callback never runs (ASan judges the GPU use). `teardown`: a world
// destroyed while its load is still reading runs none of that load's callbacks.
#include "check.h"
#include "engine/world/admission/package_loads.h"
#include "mystral/webgpu/context.h"
#include "package_writer.h"

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <thread>

using namespace tn::engine;
using namespace tn::engine::world;
using tn::test::EntrySpec;

namespace {

std::filesystem::path write(const std::string& name, const std::vector<uint8_t>& bytes) {
    const auto path = std::filesystem::temp_directory_path() / ("tn-package-loads-" + name);
    std::ofstream(path, std::ios::binary)
        .write(reinterpret_cast<const char*>(bytes.data()), std::streamsize(bytes.size()));
    return path;
}

struct Gpu {
    mystral::webgpu::Context context;
    EventQueue events;
    std::unique_ptr<GpuResources> gpu;
    Gpu() {
        CHECK(context.initializeHeadless());
        gpu = std::make_unique<GpuResources>(context.getInstance(), context.getDevice(), context.getQueue(), events, 1);
    }
    void pump() {
        gpu->poll();
        events.drain();
    }
};

// Frames until `done()` holds: each one drains the world's completions and admits uploads.
template <typename Done>
bool frames(Gpu& g, CompletionQueue& queue, PackageLoads& loads, uint64_t allowance, Done done, int limit = 3000) {
    for (int i = 0; i < limit; ++i) {
        queue.drain();
        loads.admit(allowance);
        g.pump();
        if (done())
            return true;
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    return false;
}

std::vector<uint8_t> words(std::size_t bytes, uint8_t seed) {
    std::vector<uint8_t> out(bytes);
    for (std::size_t i = 0; i < bytes; ++i)
        out[i] = static_cast<uint8_t>(seed + i * 7);
    return out;
}

void failure() {
    Gpu g;
    CompletionQueue queue;
    PackageLoads loads(queue, *g.gpu, assets::targetDecoders());
    const auto good = tn::test::writePackage({EntrySpec{"vertices", 1, 0, words(64, 1), 64, {}}});
    auto tampered = good;
    tampered.back() ^= 1;
    const std::vector<std::pair<std::string, std::vector<uint8_t>>> files = {
        {"tampered.tnpk", tampered},
        {"future.tnpk", tn::test::writePackage({EntrySpec{"vertices", 1, 0, words(64, 1), 64, {}}}, 2)},
        {"ktx2.tnpk", tn::test::writePackage({EntrySpec{"albedo", 2, assets::kDecoderKtx2, words(64, 2), 64, {}}})},
    };
    std::vector<std::filesystem::path> paths = {std::filesystem::temp_directory_path() /
                                                "tn-package-loads-missing.tnpk"};
    std::filesystem::remove(paths[0]);
    for (const auto& [name, bytes] : files)
        paths.push_back(write(name, bytes));

    std::vector<std::optional<LoadResult>> results(paths.size());
    for (std::size_t i = 0; i < paths.size(); ++i)
        loads.load(paths[i].string(), [&results, i](LoadResult r) { results[i] = std::move(r); });
    CHECK(frames(g, queue, loads, 1 << 20, [&] {
        return std::all_of(results.begin(), results.end(), [](const auto& r) { return r.has_value(); });
    }));
    struct Want {
        const char* code;
        const char* subsystem;
        Recovery recovery;
    };
    const Want want[] = {{"TN_WORLD_IO_UNAVAILABLE", "io", Recovery::Retry},
                         {"TN_PACKAGE_HASH", "assets", Recovery::Skip},
                         {"TN_PACKAGE_VERSION", "assets", Recovery::Fatal},
                         {"TN_NATIVE_KTX2_UNSUPPORTED", "assets", Recovery::Skip}};
    for (std::size_t i = 0; i < paths.size(); ++i) {
        const auto& r = results[i];
        CHECK(r && r->error && r->entries.empty());
        if (!r || !r->error)
            continue;
        std::printf("failure %s: %s %s recovery %d (%s)\n", paths[i].filename().c_str(), r->error->code.c_str(),
                    r->error->subsystem.c_str(), int(r->error->recovery), r->error->detail.c_str());
        CHECK(r->error->code == want[i].code && r->error->subsystem == want[i].subsystem &&
              r->error->recovery == want[i].recovery && r->error->resource == paths[i].string());
    }
    CHECK(g.gpu->liveCount() == 0); // a failed load holds nothing
}

void cancel() {
    Gpu g;
    CompletionQueue queue;
    PackageLoads loads(queue, *g.gpu, assets::targetDecoders());
    constexpr std::size_t kEntry = 1 << 20;
    const auto path =
        write("three-mib.tnpk", tn::test::writePackage({EntrySpec{"a", 1, 0, words(kEntry, 1), kEntry, {}},
                                                        EntrySpec{"b", 1, 0, words(kEntry, 2), kEntry, {}},
                                                        EntrySpec{"c", 1, 0, words(kEntry, 3), kEntry, {}}}));
    bool called = false;
    const uint64_t id = loads.load(path.string(), [&](LoadResult) { called = true; });

    // Frame by frame with a 1.5 MiB allowance: the first admitting frame uploads two entries, not three.
    uint64_t admitted = 0;
    for (int i = 0; i < 3000 && admitted == 0; ++i) {
        queue.drain();
        admitted = loads.admit(kEntry + kEntry / 2);
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    std::printf("cancel: admitted %llu bytes in the first frame, %u live handles\n", (unsigned long long)admitted,
                g.gpu->liveCount());
    CHECK(admitted == 2 * kEntry && g.gpu->liveCount() == 2 && !called);

    // The GPU reads the first uploaded buffer, then the load is cancelled while that read is in flight.
    const std::vector<LoadedEntry> resident = loads.uploaded(id);
    CHECK(resident.size() == 2 && resident[0].name == "a");
    const Handle first = resident[0].resource;
    bool readDone = false;
    std::vector<uint8_t> readBack;
    const GpuStatus reading = g.gpu->readBuffer(first, 0, 256, [&](GpuStatus s, std::vector<uint8_t> bytes) {
        if (s == GpuStatus::Ok)
            readBack = std::move(bytes);
        readDone = true;
    });
    loads.cancel(id);
    std::printf("cancel: read %d, after cancel %u live, %zu destroys pending\n", int(reading), g.gpu->liveCount(),
                g.gpu->pendingDestroyCount());
    CHECK(g.gpu->liveCount() == 0);           // the handles died with the cancel
    CHECK(g.gpu->pendingDestroyCount() == 2); // the GPU objects wait for the submitted work
    for (int i = 0; i < 4000 && (!readDone || g.gpu->pendingDestroyCount() > 0); ++i) {
        g.pump();
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    CHECK(readDone && g.gpu->pendingDestroyCount() == 0);
    CHECK(readBack.size() == 256 && readBack == std::vector<uint8_t>(words(256, 1))); // the GPU read valid memory
    for (int i = 0; i < 20; ++i)
        frames(g, queue, loads, 1 << 22, [] { return true; });
    CHECK(!called && loads.inFlight() == 0); // its callback never ran
}

void teardown() {
    Gpu g;
    bool called = false;
    {
        auto queue = std::make_unique<CompletionQueue>();
        PackageLoads loads(*queue, *g.gpu, assets::targetDecoders());
        const auto path = write("small.tnpk", tn::test::writePackage({EntrySpec{"v", 1, 0, words(256, 4), 256, {}}}));
        loads.load(path.string(), [&](LoadResult) { called = true; });
        queue->destroy(); // the world goes before its load reports back
        for (int i = 0; i < 50; ++i) {
            queue->drain();
            loads.admit(1 << 20);
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
    } // the loader joins its worker; nothing ran
    std::printf("teardown: callback %s, %u live handles\n", called ? "ran" : "never ran", g.gpu->liveCount());
    CHECK(!called && g.gpu->liveCount() == 0);
}

} // namespace

TN_TEST_MAIN({"failure", failure}, {"cancel", cancel}, {"teardown", teardown})
