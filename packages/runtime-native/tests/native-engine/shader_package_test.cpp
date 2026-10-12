#include "check.h"
#include "engine/renderer/gpu_resources.h"
#include "engine/shader/package.h"
#include "mystral/webgpu/context.h"

#include <webgpu/webgpu.h>
#include "mystral/webgpu_compat.h"

#include <chrono>
#include <cstdio>
#include <cstring>
#include <string>
#include <thread>

using namespace tn::engine;
using namespace tn::engine::shader;

namespace {

struct Gpu {
    mystral::webgpu::Context context;
    EventQueue events;
    bool ok = context.initializeHeadless();
    WGPUDevice device() { return context.getDevice(); }
};

template <typename Done>
bool pump(GpuResources& gpu, EventQueue& events, Done done) {
    for (int i = 0; i < 2000 && !done(); ++i) {
        gpu.poll();
        events.drain();
        if (!done()) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    return done();
}

WGPUShaderModule shaderModule(WGPUDevice device, const std::string& code) {
    WGPUShaderModuleWGSLDescriptor_Compat wgsl = {};
    WGPUShaderModuleDescriptor desc = {};
    setupShaderModuleWGSL(&desc, &wgsl, code.c_str());
    return wgpuDeviceCreateShaderModule(device, &desc);
}

// Runs `make` inside a validation scope and returns the error text, empty when none.
template <typename Make>
std::string scoped(Gpu& gpu, GpuResources& resources, Make make) {
    wgpuDevicePushErrorScope(gpu.device(), WGPUErrorFilter_Validation);
    make();
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
    wgpuDevicePopErrorScope(gpu.device(), info);
    pump(resources, gpu.events, [&] { return result.done; });
    return result.done ? result.error : "the validation scope never completed";
}

WGPUVertexFormat vertexFormat(const Type& t) {
    if (t.scalar == Type::Scalar::U32 && t.rows == 4) return WGPUVertexFormat_Uint32x4;
    switch (t.rows) {
        case 1: return WGPUVertexFormat_Float32;
        case 2: return WGPUVertexFormat_Float32x2;
        case 3: return WGPUVertexFormat_Float32x3;
        default: return WGPUVertexFormat_Float32x4;
    }
}

void layouts() {
    // Static: the WGSL uniform rules for a mixed block. c packs into b's vec3 tail.
    Program p(Stage::Compute);
    const uint32_t out = p.storageBuffer("out", Type::f32());
    const ExprId a = p.uniform("a", Type::f32());
    const ExprId b = p.uniform("b", Type::vec(3));
    const ExprId c = p.uniform("c", Type::f32());
    const ExprId d = p.uniform("d", Type::mat(4, 4));
    const ExprId e = p.uniform("e", Type::vec(2));
    int32_t k = 0;
    auto write = [&](ExprId value) { p.store(out, p.constant(k++), value); };
    write(a);
    for (const char* lane : {"x", "y", "z"}) write(p.swizzle(b, lane));
    write(c);
    for (int column = 0; column < 4; ++column) {
        std::vector<ExprId> basis;
        for (int i = 0; i < 4; ++i) basis.push_back(p.constant(i == column ? 1.0f : 0.0f));
        const ExprId col = p.mul(d, p.construct(Type::vec(4), basis));
        for (const char* lane : {"x", "y", "z", "w"}) write(p.swizzle(col, lane));
    }
    write(p.swizzle(e, "x"));
    write(p.swizzle(e, "y"));
    CHECK(p.ok());
    const StageModule stage = buildStage(p);
    CHECK(stage.wgsl.ok());
    CHECK(stage.uniforms.size() == 5);
    const uint32_t offsets[] = {0, 16, 28, 32, 96};
    for (size_t i = 0; i < stage.uniforms.size() && i < 5; ++i) CHECK(stage.uniforms[i].offset == offsets[i]);
    CHECK(stage.uniformBlockSize == 112);
    CHECK(stage.bindings.size() == 2);
    CHECK(stage.bindings[0].kind == BindingKind::Uniform && stage.bindings[0].binding == 0 && stage.bindings[0].minSize == 112);
    CHECK(stage.bindings[1].kind == BindingKind::Storage && stage.bindings[1].binding == 1);

    // Dynamic: bytes written at the computed offsets come back through the WGSL the device compiled.
    Gpu gpu;
    CHECK(gpu.ok);
    if (!gpu.ok) return;
    GpuResources resources(gpu.context.getInstance(), gpu.device(), gpu.context.getQueue(), gpu.events, 1);
    std::vector<uint8_t> block(stage.uniformBlockSize, 0);
    float next = 1.0f;
    for (const UniformField& field : stage.uniforms) {
        const uint32_t columns = field.type.isMatrix() ? field.type.cols : 1;
        const uint32_t stride = field.type.isMatrix() ? uniformLayout(field.type).size / columns : 0;
        for (uint32_t col = 0; col < columns; ++col) {
            for (uint32_t row = 0; row < field.type.rows; ++row) {
                const float value = next++;
                std::memcpy(&block[field.offset + col * stride + row * 4], &value, 4);
            }
        }
    }
    const Handle uniforms = resources.createBuffer(block.size(), WGPUBufferUsage_Uniform | WGPUBufferUsage_CopyDst);
    const Handle output = resources.createBuffer(64 * 4, WGPUBufferUsage_Storage | WGPUBufferUsage_CopySrc);
    CHECK(resources.writeBuffer(uniforms, 0, block.data(), block.size()) == GpuStatus::Ok);

    WGPUComputePipeline pipeline = nullptr;
    WGPUShaderModule module = nullptr;
    const std::string error = scoped(gpu, resources, [&] {
        module = shaderModule(gpu.device(), stage.wgsl.code);
        WGPUComputePipelineDescriptor desc = {};
        desc.compute.module = module;
        WGPU_SET_ENTRY_POINT(desc.compute, "main");
        pipeline = wgpuDeviceCreateComputePipeline(gpu.device(), &desc);
    });
    CHECK(error.empty());
    if (!error.empty()) std::fprintf(stderr, "%s\n%s", error.c_str(), stage.wgsl.code.c_str());
    if (!pipeline) return;
    WGPUBindGroupLayout layout = wgpuComputePipelineGetBindGroupLayout(pipeline, 0);
    WGPUBindGroupEntry entries[2] = {};
    entries[0].binding = 0;
    entries[0].buffer = resources.buffer(uniforms);
    entries[0].size = block.size();
    entries[1].binding = 1;
    entries[1].buffer = resources.buffer(output);
    entries[1].size = 64 * 4;
    WGPUBindGroupDescriptor groupDesc = {};
    groupDesc.layout = layout;
    groupDesc.entryCount = 2;
    groupDesc.entries = entries;
    WGPUBindGroup group = wgpuDeviceCreateBindGroup(gpu.device(), &groupDesc);
    WGPUCommandEncoderDescriptor encoderDesc = {};
    WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(gpu.device(), &encoderDesc);
    WGPUComputePassDescriptor passDesc = {};
    WGPUComputePassEncoder pass = wgpuCommandEncoderBeginComputePass(encoder, &passDesc);
    wgpuComputePassEncoderSetPipeline(pass, pipeline);
    wgpuComputePassEncoderSetBindGroup(pass, 0, group, 0, nullptr);
    wgpuComputePassEncoderDispatchWorkgroups(pass, 1, 1, 1);
    wgpuComputePassEncoderEnd(pass);
    wgpuComputePassEncoderRelease(pass);
    WGPUCommandBufferDescriptor commandDesc = {};
    resources.submit(wgpuCommandEncoderFinish(encoder, &commandDesc));
    wgpuCommandEncoderRelease(encoder);

    std::vector<uint8_t> bytes;
    bool done = false;
    CHECK(resources.readBuffer(output, 0, 23 * 4, [&](GpuStatus s, std::vector<uint8_t> out) {
        CHECK(s == GpuStatus::Ok);
        bytes = std::move(out);
        done = true;
    }) == GpuStatus::Ok);
    CHECK(pump(resources, gpu.events, [&] { return done; }));
    CHECK(bytes.size() == 23 * 4);
    for (int i = 0; i < 23 && bytes.size() == 23 * 4; ++i) {
        float got;
        std::memcpy(&got, &bytes[i * 4], 4);
        if (got != float(i + 1)) std::fprintf(stderr, "out[%d] = %g, want %d\n", i, got, i + 1);
        CHECK(got == float(i + 1));
    }
    wgpuBindGroupRelease(group);
    wgpuBindGroupLayoutRelease(layout);
    wgpuComputePipelineRelease(pipeline);
    wgpuShaderModuleRelease(module);
}

Program skinnedVertex() {
    Program v(Stage::Vertex);
    const ExprId position = v.attribute("position", Type::vec(3));
    const ExprId joints = v.attribute("skinIndex", Type::vec(4, Type::Scalar::U32));
    const ExprId weights = v.attribute("skinWeight", Type::vec(4));
    const uint32_t bones = v.storageBuffer("bones", Type::mat(4, 4));
    const ExprId local = v.construct(Type::vec(4), {position, v.constant(1.0f)});
    auto bone = [&](const char* lane) {
        return v.mul(v.mul(v.loadStorage(bones, v.swizzle(joints, lane)), local), v.swizzle(weights, lane));
    };
    const ExprId skinned = v.add(bone("x"), bone("y"));
    v.output("position", v.mul(v.uniform("viewProjection", Type::mat(4, 4)), skinned));
    return v;
}

ShaderPackage skinnedPackage() {
    Program flat(Stage::Fragment);
    flat.output("color", flat.construct(Type::vec(4), {flat.constant(1.0f)}));
    ShaderPackage package;
    package.name = "skinned-standard";
    package.variants.push_back(Variant{kVariantSkinning, {buildStage(skinnedVertex()), buildStage(flat)}});
    package.variants.push_back(Variant{kVariantSkinning | kVariantShadow, {buildStage(skinnedVertex())}});
    return package;
}

void variants() {
    const ShaderPackage package = skinnedPackage();
    std::string refusal;
    CHECK(acceptPackage(package, refusal));
    CHECK(package.variant(kVariantSkinning) != nullptr);
    CHECK(package.variant(kVariantSkinning | kVariantShadow) != nullptr);
    CHECK(package.variant(kVariantMorphs) == nullptr);
    CHECK(package.variants[0].stages[0].uniforms[0].schedule == UpdateSchedule::Camera);

    Gpu gpu;
    CHECK(gpu.ok);
    if (!gpu.ok) return;
    GpuResources resources(gpu.context.getInstance(), gpu.device(), gpu.context.getQueue(), gpu.events, 1);
    for (const Variant& variant : package.variants) {
        const StageModule& vertex = variant.stages[0];
        const bool shadow = (variant.key & kVariantShadow) != 0;
        std::vector<WGPUVertexAttribute> attributes(vertex.attributes.size());
        std::vector<WGPUVertexBufferLayout> buffers(vertex.attributes.size());
        for (size_t i = 0; i < vertex.attributes.size(); ++i) {
            const Type& t = vertex.attributes[i].type;
            attributes[i] = {};
            attributes[i].format = vertexFormat(t);
            attributes[i].shaderLocation = vertex.attributes[i].location;
            buffers[i] = {};
            buffers[i].arrayStride = uniformLayout(t).size == 12 ? 12 : t.rows * 4;
            buffers[i].stepMode = WGPUVertexStepMode_Vertex;
            buffers[i].attributeCount = 1;
            buffers[i].attributes = &attributes[i];
        }
        WGPURenderPipeline pipeline = nullptr;
        WGPUShaderModule vs = nullptr;
        WGPUShaderModule fs = nullptr;
        const std::string error = scoped(gpu, resources, [&] {
            vs = shaderModule(gpu.device(), vertex.wgsl.code);
            WGPURenderPipelineDescriptor desc = {};
            desc.vertex.module = vs;
            WGPU_SET_ENTRY_POINT(desc.vertex, "main");
            desc.vertex.bufferCount = buffers.size();
            desc.vertex.buffers = buffers.data();
            desc.primitive.topology = WGPUPrimitiveTopology_TriangleList;
            desc.multisample.count = 1;
            desc.multisample.mask = 0xffffffffu;
            WGPUDepthStencilState depth = {};
            depth.format = WGPUTextureFormat_Depth32Float;
            depth.depthWriteEnabled = WGPU_OPTIONAL_BOOL_TRUE;
            depth.depthCompare = WGPUCompareFunction_Less;
            desc.depthStencil = &depth;
            WGPUColorTargetState target = {};
            target.format = WGPUTextureFormat_RGBA8Unorm;
            target.writeMask = WGPUColorWriteMask_All;
            WGPUFragmentState fragment = {};
            if (!shadow) {
                fs = shaderModule(gpu.device(), variant.stages[1].wgsl.code);
                fragment.module = fs;
                WGPU_SET_ENTRY_POINT(fragment, "main");
                fragment.targetCount = 1;
                fragment.targets = &target;
                desc.fragment = &fragment;
            }
            pipeline = wgpuDeviceCreateRenderPipeline(gpu.device(), &desc);
        });
        if (!error.empty()) std::fprintf(stderr, "variant %u: %s\n%s", variant.key, error.c_str(), vertex.wgsl.code.c_str());
        CHECK(error.empty());
        CHECK(pipeline != nullptr);
        if (pipeline) wgpuRenderPipelineRelease(pipeline);
        if (vs) wgpuShaderModuleRelease(vs);
        if (fs) wgpuShaderModuleRelease(fs);
    }
}

void version() {
    ShaderPackage package = skinnedPackage();
    std::string refusal;
    CHECK(acceptPackage(package, refusal));
    package.version = kShaderPackageVersion + 1;
    CHECK(!acceptPackage(package, refusal));
    CHECK(refusal.rfind("TN_SHADER_PACKAGE_VERSION", 0) == 0);
    package.version = kShaderPackageVersion;
    package.variants[0].stages[0].wgsl.errors.push_back("TN_SHADER_PACKAGE_INVALID: probe");
    CHECK(!acceptPackage(package, refusal));
    CHECK(refusal.rfind("TN_SHADER_PACKAGE_INVALID", 0) == 0);
}

}  // namespace

TN_TEST_MAIN({"layouts", layouts}, {"variants", variants}, {"version", version})
