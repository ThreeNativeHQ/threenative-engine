// tn-native-engine-render-driver: the fixture driver with a GPU. It answers `render` lines by
// drawing the fixture's scene through the native renderer's render database — the path a game's
// `renderer.render(scene, camera)` takes — and writing the frame as a PNG for run-native to compare
// with the browser's golden frame.
#include "tsl_programs.h"
#include "traa_dump.h"
#include "driver.h"
#include "engine/abi/bindings.h"
#include "engine/renderer/render_database.h"
#include "engine/shader/graph/serialized.h"
#include "mystral/webgpu/context.h"

#include <array>
#include <chrono>
#include <cmath>
#include <algorithm>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <memory>
#include <sstream>
#include <thread>

#include <unistd.h>

extern "C" int stbi_write_png(const char* filename, int w, int h, int comp, const void* data, int stride);

using namespace tn::engine;

namespace {

std::optional<shader::ToneMapping> toneMapping(const std::string& name) {
    using T = shader::ToneMapping;
    if (name == "linear") return T::Linear;
    if (name == "reinhard") return T::Reinhard;
    if (name == "cineon") return T::Cineon;
    if (name == "aces") return T::ACESFilmic;
    if (name == "agx") return T::AgX;
    if (name == "neutral") return T::Neutral;
    return std::nullopt;  // none
}

struct Gpu {
    mystral::webgpu::Context context;
    EventQueue events;
    std::unique_ptr<Renderer> renderer;
    RenderDatabase database;
    std::vector<std::shared_ptr<void>> fixtureResources;
    shader::graph::Node postGraph;
};

double percentileOf(std::vector<double> samples, double fraction) {
    if (samples.empty()) return 0;
    std::sort(samples.begin(), samples.end());
    const double rank = std::ceil(fraction * double(samples.size())) - 1;
    return samples[size_t(std::clamp(rank, 0.0, double(samples.size() - 1)))];
}

// The drawn scene's own census, the way GLTFExporter's onlyVisible walks it: a hidden object hides its
// subtree. Meshes (skinned ones too) and the triangles their geometry holds.
struct Census { uint64_t meshes = 0, triangles = 0; };
void countVisible(const Object3D& object, Census& census) {
    if (!object.visible()) return;
    const std::string_view type = object.type();
    if (type == "Mesh" || type == "SkinnedMesh") {
        const auto& mesh = static_cast<const Mesh&>(object);
        ++census.meshes;
        if (mesh.geometry) {  // three's count: the index when there is one, else the positions
            const auto position = mesh.geometry->attributes.find("position");
            census.triangles += mesh.geometry->index ? mesh.geometry->index->count() / 3
                                : position != mesh.geometry->attributes.end() ? position->second->count() / 3 : 0;
        }
    }
    for (const Object3D* child : object.children) countVisible(*child, census);
}

std::string meterFrames(Gpu& gpu, Renderer& renderer, Scene& scene, Camera& camera, const std::array<double, 4>& clear,
                        unsigned long count, uint32_t width, uint32_t height, const char* reportFile) {
    using Clock = std::chrono::steady_clock;
    const auto ms = [](Clock::time_point a, Clock::time_point b) { return std::chrono::duration<double, std::milli>(b - a).count(); };
    std::vector<double> submit, frame, gpuMs;
    renderer.setGpuTimer(true);
    const unsigned long warmup = std::min<unsigned long>(count / 4, 30);
    for (unsigned long i = 0; i < count + warmup; ++i) {
        const uint64_t seen = renderer.gpuSamples();
        const auto t0 = Clock::now();
        gpu.database.render(renderer, scene, camera, clear);
        const auto t1 = Clock::now();
        while (renderer.gpu().completedSerial() < renderer.gpu().submittedSerial()) {
            renderer.poll();
            gpu.events.drain();
        }
        const auto t2 = Clock::now();
        // The renderer times one frame at a time: wait (bounded) for this frame's sample.
        const auto until = t2 + std::chrono::milliseconds(250);
        while (renderer.gpuSamples() == seen && Clock::now() < until) {
            renderer.poll();
            gpu.events.drain();
        }
        if (!gpu.database.diagnostics().empty()) return gpu.database.diagnostics().front();
        if (i < warmup) continue;
        submit.push_back(ms(t0, t1));
        frame.push_back(ms(t0, t2));
        if (renderer.gpuSamples() != seen) gpuMs.push_back(renderer.lastGpuMs());
    }
    const auto series = [](const std::vector<double>& samples) {
        char buffer[96];
        std::snprintf(buffer, sizeof buffer, "{\"p50\": %.4f, \"p95\": %.4f}", percentileOf(samples, 0.5), percentileOf(samples, 0.95));
        return std::string(buffer);
    };
    const auto& stats = renderer.lastFrame();
    Census census;
    countVisible(scene, census);
    std::ofstream out(reportFile);
    out << "{\n  \"arm\": \"native-render-driver\",\n  \"frames\": " << count << ",\n  \"warmup\": " << warmup
        << ",\n  \"submitMs\": " << series(submit) << ",\n  \"frameMs\": " << series(frame)
        << ",\n  \"gpuMs\": " << (gpuMs.empty() ? std::string("null") : series(gpuMs)) << ",\n  \"gpuSamples\": " << gpuMs.size()
        << ",\n  \"draws\": " << stats.draws << ",\n  \"triangles\": " << stats.triangles
        << ",\n  \"sceneMeshes\": " << census.meshes << ",\n  \"sceneTriangles\": " << census.triangles
        << ",\n  \"size\": [" << width << ", " << height << "]\n}\n";
    return out ? "" : std::string("cannot write ") + reportFile;
}

std::string draw(Gpu& gpu, tn::binding::Object& sceneObject, tn::binding::Object& cameraObject, const tn::fixture::RenderRequest& r) {
    if (sceneObject.cls != "Scene") return "render scene is a " + sceneObject.cls;
    Camera* camera = nullptr;
    if (cameraObject.cls == "PerspectiveCamera") camera = static_cast<PerspectiveCamera*>(cameraObject.ptr.get());
    if (cameraObject.cls == "OrthographicCamera") camera = static_cast<OrthographicCamera*>(cameraObject.ptr.get());
    if (!camera) return "render camera is a " + cameraObject.cls;
    if (!gpu.renderer) {
        if (!gpu.context.initializeHeadless()) return "no GPU device";
        gpu.renderer = std::make_unique<Renderer>(gpu.context.getInstance(), gpu.context.getDevice(), gpu.context.getQueue(), gpu.events);
        if (gpu.postGraph) gpu.renderer->setPostGraph(gpu.postGraph);
    }
    Renderer& renderer = *gpu.renderer;
    renderer.setSize(r.width, r.height);
    renderer.setOutput(OutputState{toneMapping(r.toneMapping), r.exposure, r.srgb});
    auto& scene = *static_cast<Scene*>(sceneObject.ptr.get());
    // WebGPURenderer's default alpha:true clears to transparent black without a background.
    std::array<double, 4> clear{0, 0, 0, 0};
    if (scene.background) clear = {scene.background->r, scene.background->g, scene.background->b, 1};
    gpu.database.shadowMapEnabled = r.shadowMap;
    gpu.database.shadowMapType = r.shadowMapType;
    const char* dumpDirectory = std::getenv("TN_TRAA_DUMP");
    const bool dumpTraa = dumpDirectory && *dumpDirectory &&
        std::any_of(r.tsl.begin(), r.tsl.end(), [](const auto& op) { return op.first == "traa-history"; });
    const auto finishDump = [&](bool captured) -> std::string {
        if (!dumpTraa) return "";
        try {
            if (auto* traa = renderer.traaDebugPass())
                tn::fixture::finishTraaDump(*traa, gpu.context.getInstance(), dumpDirectory, captured);
            return "";
        } catch (const std::exception& error) { return error.what(); }
    };
    const auto renderAt = [&](uint32_t width, uint32_t height) -> std::string {
        renderer.setSize(width, height);
        gpu.database.render(renderer, scene, *camera, clear);
        renderer.setSize(r.width, r.height);
        if (const auto error = finishDump(false); !error.empty()) return error;
        return gpu.database.diagnostics().empty() ? "" : gpu.database.diagnostics().front();
    };
    for (auto [program, object] : r.tsl)
        if (const std::string failed =
                tn::fixture::applyTslProgram(program, object, renderer, gpu.context.getDevice(), renderAt, gpu.fixtureResources, camera);
            !failed.empty())
            return failed;
    gpu.database.render(renderer, scene, *camera, clear);
    if (!gpu.database.diagnostics().empty()) return gpu.database.diagnostics().front();
    if (const auto error = finishDump(true); !error.empty()) return error;
    for (const std::string& note : renderer.diagnostics()) std::fprintf(stderr, "%s\n", note.c_str());
    // TN_FIXTURE_FRAMES=<n> with TN_FIXTURE_REPORT=<file>: the same frame rendered n more times with
    // the per-frame meter (CPU submit, frame wall time, GPU timestamps, draws, triangles), the
    // GPU-heavy holdout's native arm. Each frame waits for the GPU and for its own timestamp sample.
    if (const char* frames = std::getenv("TN_FIXTURE_FRAMES"); frames && *frames) {
        const char* report = std::getenv("TN_FIXTURE_REPORT");
        if (!report || !*report) return "TN_FIXTURE_FRAMES needs TN_FIXTURE_REPORT";
        const std::string failed = meterFrames(gpu, renderer, scene, *camera, clear, std::stoul(frames), r.width, r.height, report);
        if (!failed.empty()) return failed;
    }
    // TN_FIXTURE_PROGRAM_DUMP=<file>: every compiled vertex program, "### <key>" then its WGSL.
    if (const char* programs = std::getenv("TN_FIXTURE_PROGRAM_DUMP"); programs && *programs) {
        std::ofstream out(programs, std::ios::binary);
        for (const auto& [key, source] : renderer.programVertexSources()) out << "### " << key << "\n" << source << "\n";
    }
    // TN_FIXTURE_NORMAL_DUMP=<file>: the post normal target as raw RGBA16Float, packed rows.
    if (const char* normals = std::getenv("TN_FIXTURE_NORMAL_DUMP"); normals && *normals) {
        std::vector<uint8_t> bytes;
        bool read = false;
        const auto status = renderer.readNormalPixels([&](GpuStatus s, std::vector<uint8_t> px) {
            if (s == GpuStatus::Ok) bytes = std::move(px);
            read = true;
        });
        if (status != GpuStatus::Ok) return "no normal target: the post graph reads none";
        for (int i = 0; i < 5000 && !read; ++i) {
            renderer.poll();
            gpu.events.drain();
            if (!read) std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        if (bytes.size() != size_t{r.width} * r.height * 8) return "normal readback failed";
        std::ofstream(normals, std::ios::binary).write(reinterpret_cast<const char*>(bytes.data()), std::streamsize(bytes.size()));
    }
    std::vector<uint8_t> pixels;
    bool done = false;
    renderer.readPixels([&](GpuStatus s, std::vector<uint8_t> px) {
        if (s == GpuStatus::Ok) pixels = std::move(px);
        done = true;
    });
    for (int i = 0; i < 5000 && !done; ++i) {
        renderer.poll();
        gpu.events.drain();
        if (!done) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    if (pixels.size() != size_t{r.width} * r.height * 4) return "frame readback failed";
    if (!stbi_write_png(r.png.c_str(), int(r.width), int(r.height), 4, pixels.data(), int(r.width * 4))) return "png write failed: " + r.png;
    return "";
}

}  // namespace

int main() {
    // The GPU context logs to stdout, and stdout is the protocol: keep a handle on the real stdout
    // for the replies and point fd 1 at stderr for everything else.
    const int protocol = dup(STDOUT_FILENO);
    dup2(STDERR_FILENO, STDOUT_FILENO);
    tn::fixture::Driver driver;
    tn::binding::registerAll(driver.classes);
    Gpu gpu;
    // The visual arm imports the actual authored r185 graph, not a named fixture substitute.
    if (const char* file = std::getenv("TN_FIXTURE_POST_GRAPH"); file && *file) {
        std::ifstream input(file);
        if (!input) { std::cerr << "TN_VISUAL_POST_GRAPH_UNREADABLE: " << file << '\n'; return 2; }
        const std::string source{std::istreambuf_iterator<char>(input), {}};
        std::vector<std::string> errors;
        gpu.postGraph = shader::graph::importSerialized(source, errors);
        if (!gpu.postGraph || !errors.empty()) {
            for (const auto& error : errors) std::cerr << "TN_VISUAL_POST_GRAPH_INVALID: " << error << '\n';
            return 2;
        }
    }
    driver.render = [&gpu](tn::binding::Object& scene, tn::binding::Object& camera, const tn::fixture::RenderRequest& r) {
        return draw(gpu, scene, camera, r);
    };
    std::ostringstream replies;
    const int status = driver.run(std::cin, replies);
    const std::string text = replies.str();
    for (size_t written = 0; written < text.size();) {
        const ssize_t n = write(protocol, text.data() + written, text.size() - written);
        if (n <= 0) return 1;
        written += size_t(n);
    }
    close(protocol);
    return status;
}
