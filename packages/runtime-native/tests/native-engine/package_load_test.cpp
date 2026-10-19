#include "check.h"
#include "engine/renderer/package_loader.h"
#include "mystral/webgpu/context.h"
#include "package_writer.h"

#include <chrono>
#include <thread>

using namespace tn::engine;
using tn::test::EntrySpec;

namespace {

template <typename Done>
bool pump(GpuResources& gpu, EventQueue& events, Done done) {
    for (int i = 0; i < 2000 && !done(); ++i) {
        gpu.poll();
        events.drain();
        if (!done()) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    return done();
}

void load() {
    std::vector<uint8_t> vertices(256);
    for (size_t i = 0; i < vertices.size(); ++i) vertices[i] = static_cast<uint8_t>(i * 3);
    std::vector<uint8_t> texture;
    tn::test::put(texture, 8, 4);
    tn::test::put(texture, 4, 4);
    tn::test::put(texture, 18, 4); // TNPK wire code, not the active backend enum
    for (int i = 0; i < 8 * 4 * 4; ++i) texture.push_back(static_cast<uint8_t>(255 - i));
    const auto file = tn::test::writePackage({{"geometry/positions", 1, 0, vertices, 256, {}},
                                              {"textures/albedo", 2, 0, texture, 128, {}},
                                              {"scenes/main", 6, 0, {1, 2, 3, 4}, 0, {0, 1}}});
    assets::Package package;
    assets::PackageError error;
    CHECK(assets::parsePackage(file, package, error));
    CHECK(assets::verifyPackage(package, 0, error));

    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    GpuResources gpu(context.getInstance(), context.getDevice(), context.getQueue(), events, 1);
    std::vector<LoadedEntry> loaded;
    CHECK(loadPackage(package, gpu, loaded, error));
    CHECK(loaded.size() == 2);  // the scene entry belongs to the scene loader
    if (loaded.size() != 2) return;

    std::vector<uint8_t> buffer, pixels;
    bool bufferDone = false, textureDone = false;
    gpu.readBuffer(loaded[0].resource, 0, 256, [&](GpuStatus s, std::vector<uint8_t> b) {
        CHECK(s == GpuStatus::Ok);
        buffer = std::move(b);
        bufferDone = true;
    });
    gpu.readTexture(loaded[1].resource, [&](GpuStatus s, std::vector<uint8_t> b) {
        CHECK(s == GpuStatus::Ok);
        pixels = std::move(b);
        textureDone = true;
    });
    CHECK(pump(gpu, events, [&] { return bufferDone && textureDone; }));
    CHECK(buffer == vertices);
    CHECK(pixels == std::vector<uint8_t>(texture.begin() + 12, texture.end()));

    // A texture whose header disagrees with its pixels is refused, not uploaded short.
    texture[0] = 9;
    const auto bad = tn::test::writePackage({{"textures/albedo", 2, 0, texture, 0, {}}});
    assets::Package badPackage;
    CHECK(assets::parsePackage(bad, badPackage, error) && assets::verifyPackage(badPackage, 0, error));
    std::vector<LoadedEntry> none;
    CHECK(!loadPackage(badPackage, gpu, none, error));
    CHECK(error.code == "TN_PACKAGE_ENTRY");

    // Upload size states a Buffer's use: 0 is CPU data (an HDRLoader's 7-byte .hdr here) that the
    // GPU loader leaves alone at any length; a GPU buffer still has to be 4-byte aligned.
    const std::vector<uint8_t> hdr{'#', '?', 'R', 'G', 'B', 'E', '\n'};
    const auto cpu = tn::test::writePackage({{"sky.hdr", 1, 0, hdr, 0, {}}});
    assets::Package cpuPackage;
    CHECK(assets::parsePackage(cpu, cpuPackage, error) && assets::verifyPackage(cpuPackage, 0, error));
    std::vector<LoadedEntry> cpuLoaded;
    CHECK(loadPackage(cpuPackage, gpu, cpuLoaded, error));
    CHECK(cpuLoaded.empty());
    const auto gpuUnaligned = tn::test::writePackage({{"positions", 1, 0, hdr, 7, {}}});
    assets::Package gpuPackage;
    CHECK(assets::parsePackage(gpuUnaligned, gpuPackage, error) && assets::verifyPackage(gpuPackage, 0, error));
    CHECK(!loadPackage(gpuPackage, gpu, none, error));
    CHECK(error.code == "TN_PACKAGE_ENTRY");
}

}  // namespace

TN_TEST_MAIN({"load", load})
