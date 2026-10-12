// PRD-513 phase 1: a compute pass writes 10,000 instance positions into a storage buffer, and a
// readback equals the positions computed on the CPU, bit for bit. The program is built in the IR:
// instance i sits on a 100 x 100 grid, row = i / 100 and column = i - row * 100 (exact u32
// arithmetic), at `spacing` apart, and one invocation in the last workgroup past 10,000 writes
// nothing. Every value is exact in f32, so the GPU answer must equal the CPU's.

#include "check.h"
#include "engine/renderer/compute.h"
#include "mystral/webgpu/context.h"

#include <chrono>
#include <cstring>
#include <thread>
#include <vector>

using namespace tn::engine;
using namespace tn::engine::shader;

namespace {

constexpr uint32_t kCount = 10000;

Program positionsProgram() {
    Program p(Stage::Compute);
    const uint32_t positions = p.storageBuffer("positions", Type::vec(4));
    const ExprId id = p.swizzle(p.builtin("globalInvocationId"), "x");
    const ExprId spacing = p.uniform("spacing", Type::f32());
    p.If(p.less(id, p.construct(Type::u32(), {p.constant(int32_t(kCount))})), [&] {
        const ExprId row = p.div(id, p.construct(Type::u32(), {p.constant(100)}));
        const ExprId column = p.sub(id, p.mul(row, p.construct(Type::u32(), {p.constant(100)})));
        const ExprId x = p.mul(p.construct(Type::f32(), {column}), spacing);
        const ExprId z = p.mul(p.construct(Type::f32(), {row}), spacing);
        const ExprId y = p.mul(p.construct(Type::f32(), {column}), p.constant(0.25f));
        p.store(positions, id, p.construct(Type::vec(4), {x, y, z, p.constant(1.0f)}));
    });
    return p;
}

void readback() {
    mystral::webgpu::Context context;
    CHECK(context.initializeHeadless());
    EventQueue events;
    GpuResources gpu(context.getInstance(), context.getDevice(), context.getQueue(), events, 1);
    const Program program = positionsProgram();
    for (const Diagnostic& d : program.diagnostics()) std::fprintf(stderr, "%s %s: %s\n", d.code.c_str(), d.node.c_str(), d.reason.c_str());
    CHECK(program.diagnostics().empty());
    ComputePass pass(context.getDevice(), gpu, program);
    if (!pass.error().empty()) std::fprintf(stderr, "%s\n", pass.error().c_str());
    CHECK(pass.error().empty());

    const uint64_t bytes = uint64_t{kCount} * 16;
    const Handle positions = gpu.createBuffer(bytes, WGPUBufferUsage_Storage | WGPUBufferUsage_CopySrc | WGPUBufferUsage_CopyDst);
    WGPUCommandEncoderDescriptor encoderDesc = {};
    WGPUCommandEncoder encoder = wgpuDeviceCreateCommandEncoder(context.getDevice(), &encoderDesc);
    const Handle storage[] = {positions};
    CHECK(pass.dispatch(encoder, storage, kCount + 37, {{"spacing", 0.5}}));
    WGPUCommandBufferDescriptor commandDesc = {};
    gpu.submit(wgpuCommandEncoderFinish(encoder, &commandDesc));
    wgpuCommandEncoderRelease(encoder);

    std::vector<uint8_t> got;
    bool done = false;
    gpu.readBuffer(positions, 0, bytes, [&](GpuStatus s, std::vector<uint8_t> b) {
        CHECK(s == GpuStatus::Ok);
        got = std::move(b);
        done = true;
    });
    for (int i = 0; i < 4000 && !done; ++i) {
        gpu.poll();
        events.drain();
        if (!done) std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    CHECK(done && got.size() == bytes);
    if (got.size() != bytes) return;

    std::vector<float> expected(size_t{kCount} * 4);
    for (uint32_t i = 0; i < kCount; ++i) {
        const uint32_t row = i / 100, column = i - row * 100;
        expected[i * 4 + 0] = float(column) * 0.5f;
        expected[i * 4 + 1] = float(column) * 0.25f;
        expected[i * 4 + 2] = float(row) * 0.5f;
        expected[i * 4 + 3] = 1.0f;
    }
    size_t mismatched = 0;
    for (size_t k = 0; k < expected.size(); ++k) {
        float v;
        std::memcpy(&v, got.data() + k * 4, 4);
        mismatched += v != expected[k];
    }
    std::printf("compute readback: %u positions, %zu components differ\n", kCount, mismatched);
    CHECK(mismatched == 0);

    // A dispatch given the wrong buffers is refused, not recorded.
    WGPUCommandEncoder other = wgpuDeviceCreateCommandEncoder(context.getDevice(), &encoderDesc);
    CHECK(!pass.dispatch(other, {}, kCount) && !pass.error().empty());
    wgpuCommandEncoderRelease(other);
    gpu.destroy(positions);
}

}  // namespace

TN_TEST_MAIN({"readback", readback})
