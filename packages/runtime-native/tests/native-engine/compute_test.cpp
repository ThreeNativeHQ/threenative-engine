// PRD-513 phase 1: a compute pass writes 10,000 instance positions into a storage buffer, and a
// readback equals the positions computed on the CPU, bit for bit. The program is built in the IR:
// instance i sits on a 100 x 100 grid, row = i / 100 and column = i - row * 100 (exact u32
// arithmetic), at `spacing` apart, and one invocation in the last workgroup past 10,000 writes
// nothing. Every value is exact in f32, so the GPU answer must equal the CPU's.

#include "check.h"
#include "engine/renderer/compute.h"
#include "engine/renderer/pipeline_cache.h"
#include "mystral/webgpu/context.h"

#include <algorithm>
#include <array>
#include <cmath>
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

using Matrix = std::array<double, 16>;
using PackedTrs = std::array<float, 12>;
Matrix identity() { Matrix m{}; for (int i = 0; i < 4; ++i) m[i * 5] = 1; return m; }
Matrix multiply(const Matrix& a, const Matrix& b) {
    Matrix c{};
    for (int col = 0; col < 4; ++col) for (int row = 0; row < 4; ++row)
        for (int k = 0; k < 4; ++k) c[col * 4 + row] += a[k * 4 + row] * b[col * 4 + k];
    return c;
}
// Independent double reference: rotate basis vectors by q*v*conjugate(q), then scale.
Matrix compose(const PackedTrs& t) {
    Matrix m = identity();
    const double q[4] = {t[4], t[5], t[6], t[7]};
    auto quatMul = [](const std::array<double, 4>& a, const std::array<double, 4>& b) {
        return std::array<double, 4>{a[3]*b[0]+a[0]*b[3]+a[1]*b[2]-a[2]*b[1],
            a[3]*b[1]-a[0]*b[2]+a[1]*b[3]+a[2]*b[0],
            a[3]*b[2]+a[0]*b[1]-a[1]*b[0]+a[2]*b[3],
            a[3]*b[3]-a[0]*b[0]-a[1]*b[1]-a[2]*b[2]};
    };
    for (int col = 0; col < 3; ++col) {
        std::array<double, 4> v{}; v[col] = 1;
        const auto rotated = quatMul(quatMul({q[0],q[1],q[2],q[3]}, v), {-q[0],-q[1],-q[2],q[3]});
        for (int row = 0; row < 3; ++row) m[col * 4 + row] = rotated[row] * t[8 + col];
        m[12 + col] = t[col];
    }
    return m;
}

void jointReadback(mystral::webgpu::Context& context, GpuResources& gpu, EventQueue& events) {
    std::array<JointComputeRig, 2> rigs{{{3, 0, 0, 0, 2}, {3, 3, 0, 3, 6}}};
    const std::array<uint32_t, 6> parents{UINT32_MAX, 0, 1, UINT32_MAX, 0, 1};
    std::array<PackedTrs, 3> locals{};
    for (int j = 0; j < 3; ++j) {
        locals[j] = {float(j + 1), float(2 - j), float(j * 2), 0, 0, 0, 0, 0,
            1.2f, j == 1 ? 0.7f : 1.2f, j == 2 ? 1.7f : 1.2f, 0};
        locals[j][4 + j] = std::sin(float(j + 1) * 0.2f);
        locals[j][7] = std::cos(float(j + 1) * 0.2f);
    }
    std::array<std::array<float, 16>, 12> fixed{};
    for (size_t k = 0; k < fixed.size(); ++k) {
        const auto m = identity();
        for (int i = 0; i < 16; ++i) fixed[k][i] = float(m[i]);
        fixed[k][12 + k % 3] = float(k + 1) * (k % 2 ? -0.13f : 0.19f);
    }
    // A fixed non-Bone intermediary rotates as well as translates.
    fixed[2][0] = fixed[2][5] = 0; fixed[2][1] = 1; fixed[2][4] = -1;
    fixed[5][5] = fixed[5][10] = 0; fixed[5][6] = -1; fixed[5][9] = 1;
    std::array<float, 10 * 16> initial{}; initial.fill(-777.0f);
    const auto usage = WGPUBufferUsage_Storage | WGPUBufferUsage_CopySrc | WGPUBufferUsage_CopyDst;
    const Handle input = gpu.createBuffer(sizeof(locals), usage, locals.data(), sizeof(locals));
    const Handle output = gpu.createBuffer(sizeof(initial), usage, initial.data(), sizeof(initial));
    JointComputePass pass(context.getDevice(), gpu, rigs, parents, fixed, input, output);
    if (!pass.error().empty()) std::fprintf(stderr, "%s\n", pass.error().c_str());
    CHECK(pass.error().empty());
    const std::array<uint32_t, 2> overlapBases{2, 3}, outsideBases{2, UINT32_MAX};
    CHECK(!pass.remapOutputs(overlapBases));
    CHECK(!pass.remapOutputs(outsideBases));
    CHECK(!pass.remapOutputs(std::span<const uint32_t>{overlapBases.data(), 1}));
    CHECK(pass.error().empty());
    for (int frame = 0; frame < 2; ++frame) {
        if (frame) {
            std::swap(rigs[0].outputBase, rigs[1].outputBase);
            const std::array<uint32_t, 2> remapped{rigs[0].outputBase, rigs[1].outputBase};
            CHECK(pass.remapOutputs(remapped));
            CHECK(pass.remapOutputs(remapped));
            locals[1][0] += 2.3f; locals[2][6] = std::sin(0.9f); locals[2][7] = std::cos(0.9f);
            CHECK(gpu.writeBuffer(input, 0, locals.data(), sizeof(locals)) == GpuStatus::Ok);
        }
        WGPUCommandEncoderDescriptor desc{};
        const auto encoder = wgpuDeviceCreateCommandEncoder(context.getDevice(), &desc);
        CHECK(pass.dispatch(encoder));
        WGPUCommandBufferDescriptor commands{};
        gpu.submit(wgpuCommandEncoderFinish(encoder, &commands));
        wgpuCommandEncoderRelease(encoder);
        std::vector<uint8_t> got; bool done = false;
        CHECK(gpu.readBuffer(output, 0, sizeof(initial), [&](GpuStatus status, std::vector<uint8_t> bytes) {
            CHECK(status == GpuStatus::Ok); got = std::move(bytes); done = true;
        }) == GpuStatus::Ok);
        for (int i = 0; i < 4000 && !done; ++i) {
            gpu.poll(); events.drain();
            if (!done) std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        CHECK(done && got.size() == sizeof(initial));
        if (got.size() != sizeof(initial)) break;
        auto expected = initial;
        for (const auto& rig : rigs) {
            std::vector<Matrix> worlds;
            for (uint32_t j = 0; j < rig.count; ++j) {
                auto matrix = [&](uint32_t n) { Matrix m{}; for (int i = 0; i < 16; ++i) m[i] = fixed[n][i]; return m; };
                auto world = multiply(matrix((rig.fixedBase + j) * 2), compose(locals[rig.inputBase + j]));
                if (parents[rig.parentBase + j] != UINT32_MAX) world = multiply(worlds[parents[rig.parentBase + j]], world);
                worlds.push_back(world);
                const auto palette = multiply(world, matrix((rig.fixedBase + j) * 2 + 1));
                for (int k = 0; k < 16; ++k) expected[(rig.outputBase + j) * 16 + k] = float(palette[k]);
            }
        }
        size_t mismatch = 0;
        for (size_t k = 0; k < expected.size(); ++k) {
            float value; std::memcpy(&value, got.data() + k * 4, 4);
            mismatch += !std::isfinite(value) || std::abs(value - expected[k]) > 2e-5f * std::max(1.0f, std::abs(expected[k]));
        }
        std::printf("joint readback frame %d: %zu mismatched components\n", frame, mismatch);
        CHECK(mismatch == 0);
    }
    auto badParents = parents; badParents[1] = 1;
    JointComputePass badParent(context.getDevice(), gpu, rigs, badParents, fixed, input, output);
    CHECK(!badParent.error().empty());
    auto badRigs = rigs; badRigs[1].outputBase = rigs[0].outputBase + 1;
    JointComputePass overlap(context.getDevice(), gpu, badRigs, parents, fixed, input, output);
    CHECK(!overlap.error().empty());
    badRigs = rigs; badRigs[0].inputBase = UINT32_MAX;
    JointComputePass outOfRange(context.getDevice(), gpu, badRigs, parents, fixed, input, output);
    CHECK(!outOfRange.error().empty());
    badRigs = rigs; badRigs[0].fixedBase = UINT32_MAX;
    JointComputePass badFixed(context.getDevice(), gpu, badRigs, parents, fixed, input, output);
    CHECK(!badFixed.error().empty());
    badRigs = rigs; badRigs[0].outputBase = UINT32_MAX;
    JointComputePass badOutput(context.getDevice(), gpu, badRigs, parents, fixed, input, output);
    CHECK(!badOutput.error().empty());
    auto nonfinite = fixed; nonfinite[0][0] = NAN;
    JointComputePass badMatrix(context.getDevice(), gpu, rigs, parents, nonfinite, input, output);
    CHECK(!badMatrix.error().empty());
    JointComputePass alias(context.getDevice(), gpu, rigs, parents, fixed, input, input);
    CHECK(!alias.error().empty());
    gpu.destroy(input); gpu.destroy(output);
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

    // A steady dispatch (the same buffers as last frame) creates no bind group; new buffers create one.
    const auto groupsFor = [&](Handle buffer) {
        const uint64_t before = bindGroupsCreated();
        WGPUCommandEncoder steady = wgpuDeviceCreateCommandEncoder(context.getDevice(), &encoderDesc);
        const Handle buffers[] = {buffer};
        CHECK(pass.dispatch(steady, buffers, kCount, {{"spacing", 0.5}}));
        gpu.submit(wgpuCommandEncoderFinish(steady, &commandDesc));
        wgpuCommandEncoderRelease(steady);
        return bindGroupsCreated() - before;
    };
    CHECK(groupsFor(positions) == 0);
    CHECK(groupsFor(positions) == 0);
    const Handle moved = gpu.createBuffer(bytes, WGPUBufferUsage_Storage | WGPUBufferUsage_CopySrc | WGPUBufferUsage_CopyDst);
    CHECK(groupsFor(moved) == 1);
    CHECK(groupsFor(positions) == 0);
    gpu.destroy(moved);

    // A dispatch given the wrong buffers is refused, not recorded.
    WGPUCommandEncoder other = wgpuDeviceCreateCommandEncoder(context.getDevice(), &encoderDesc);
    CHECK(!pass.dispatch(other, {}, kCount) && !pass.error().empty());
    wgpuCommandEncoderRelease(other);
    gpu.destroy(positions);
    jointReadback(context, gpu, events);
}

}  // namespace

TN_TEST_MAIN({"readback", readback})
