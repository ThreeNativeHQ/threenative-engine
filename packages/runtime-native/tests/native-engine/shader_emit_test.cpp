#include "check.h"
#include "engine/shader/standard.h"
#include "engine/shader/wgsl.h"
#include "mystral/webgpu/context.h"
#include "shader_corpus.h"

#include <webgpu/webgpu.h>
#include "mystral/webgpu_compat.h"
#if defined(MYSTRAL_WEBGPU_WGPU)
#if __has_include(<webgpu/wgpu.h>)
#include <webgpu/wgpu.h>
#else
#include <wgpu/wgpu.h>
#endif
#endif

#include <chrono>
#include <cstdio>
#include <string>
#include <thread>

using namespace tn::engine::shader;

namespace {

// Creates the module inside a validation scope: Tint judges it on Dawn, naga on wgpu-native.
std::string validate(mystral::webgpu::Context& context, const std::string& code) {
    WGPUDevice device = context.getDevice();
    wgpuDevicePushErrorScope(device, WGPUErrorFilter_Validation);
    WGPUShaderModuleWGSLDescriptor_Compat wgsl = {};
    WGPUShaderModuleDescriptor desc = {};
    setupShaderModuleWGSL(&desc, &wgsl, code.c_str());
    WGPUShaderModule module = wgpuDeviceCreateShaderModule(device, &desc);

    struct Result {
        bool done = false;
        std::string error;
    } result;
    WGPUPopErrorScopeCallbackInfo info = {};
    info.mode = WGPUCallbackMode_AllowProcessEvents;
    info.userdata1 = &result;
    info.callback = [](WGPUPopErrorScopeStatus, WGPUErrorType type, WGPUStringView message, void* user, void*) {
        auto* r = static_cast<Result*>(user);
        if (type != WGPUErrorType_NoError) r->error = message.data ? std::string(message.data, message.length) : "error";
        r->done = true;
    };
    wgpuDevicePopErrorScope(device, info);
    for (int i = 0; i < 2000 && !result.done; ++i) {
#if defined(MYSTRAL_WEBGPU_DAWN)
        wgpuInstanceProcessEvents(context.getInstance());
#else
        wgpuDevicePoll(device, false, nullptr);
#endif
        if (!result.done) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    if (module) wgpuShaderModuleRelease(module);
    return result.done ? result.error : "validation never completed";
}

void validates() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    // The validator is live: broken WGSL is refused.
    CHECK(!validate(context, "fn main( {").empty());
    for (const auto& [name, build] : corpus::all()) {
        const Program program = build();
        CHECK(program.ok());
        const WgslModule module = WgslEmitter::emit(program);
        CHECK(module.ok());
        const std::string error = validate(context, module.code);
        if (!error.empty()) std::fprintf(stderr, "%s rejected:\n%s\n--- WGSL ---\n%s", name, error.c_str(), module.code.c_str());
        CHECK(error.empty());
    }
}

void stable() {
    for (const auto& [name, build] : corpus::all()) {
        const std::string first = WgslEmitter::emit(build()).code;
        const std::string second = WgslEmitter::emit(build()).code;
        CHECK(!first.empty());
        CHECK(first == second);
        if (first != second) std::fprintf(stderr, "%s emits differently on a second run\n", name);
    }
    // A non-finite constant is refused by name rather than emitted as invalid WGSL.
    Program p(Stage::Fragment);
    p.output("color", p.construct(Type::vec(4), {p.constant(1.0f / 0.0f)}));
    const WgslModule bad = WgslEmitter::emit(p);
    CHECK(!bad.ok());
    CHECK(!bad.errors.empty() && bad.errors[0].rfind("TN_SHADER_PACKAGE_INVALID", 0) == 0);
}

// A subexpression the program uses twice is emitted once and named: inlining it at every use grew
// Midway's largest fragment module to 192 KB, one 87 000-character line, and stalled the GPU process.
void sharedOnce() {
    Program p(Stage::Fragment);
    const ExprId shared = p.call("normalize", {p.varying("normal", Type::vec(3))});
    const ExprId twice = p.add(shared, shared);
    p.If(p.less(p.swizzle(shared, "x"), p.constant(0.0f)),
         [&] { p.output("color", p.construct(Type::vec(4), {twice, p.constant(1.0f)})); },
         [&] { p.output("color", p.construct(Type::vec(4), {p.mul(twice, shared), p.constant(1.0f)})); });
    const std::string code = WgslEmitter::emit(p).code;
    std::size_t count = 0;
    for (std::size_t at = code.find("normalize("); at != std::string::npos; at = code.find("normalize(", at + 1)) ++count;
    CHECK(count == 1);
    if (count != 1) std::fprintf(stderr, "normalize emitted %zu times:\n%s", count, code.c_str());
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    const std::string error = validate(context, code);
    if (!error.empty()) std::fprintf(stderr, "%s\n%s", error.c_str(), code.c_str());
    CHECK(error.empty());
}

// Two pipelines that share a vertex module (a depth-Equal normal pass after the colour pass) are only
// guaranteed the same clip position when the position output is invariant.
void positionInvariant() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    Program vertex(Stage::Vertex);
    vertex.output("position", vertex.construct(Type::vec(4), {vertex.constant(0.0f), vertex.constant(0.0f),
                                                              vertex.constant(0.0f), vertex.constant(1.0f)}));
    // Left alone a program is as three's is: no @invariant, which would stop the compiler fusing the
    // position arithmetic and move sub-pixel silhouettes against three's frame.
    const WgslModule plain = WgslEmitter::emit(vertex);
    CHECK(plain.ok());
    CHECK(plain.code.find("@invariant") == std::string::npos);
    CHECK(plain.code.find("@builtin(position) position: vec4<f32>") != std::string::npos);
    vertex.setInvariantPosition(true);
    const WgslModule module = WgslEmitter::emit(vertex);
    CHECK(module.ok());
    CHECK(module.code.find("@invariant @builtin(position) position: vec4<f32>") != std::string::npos);
    CHECK(validate(context, module.code).empty());  // Tint on Dawn, naga on wgpu-native accept it
    VertexVariant off, on;
    on.invariantPosition = true;
    CHECK(off.key() != on.key());  // the program cache keeps the two apart
}

}  // namespace

TN_TEST_MAIN({"validates", validates}, {"stable", stable}, {"position_invariant", positionInvariant},
            {"shared_once", sharedOnce})
