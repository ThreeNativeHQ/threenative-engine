#include "gpu_pages.h"

#include <algorithm>
#include <bit>
#include <cmath>
#include <stdexcept>

namespace tn::engine::shadows {

namespace {
// A row's instances go to the kernel in chunks, so that one big instanced caster spreads over the workgroup's threads.
constexpr uint32_t kChunkInstances = 128;
// A float record base is exact up to here (the same limit as the instance base it rides beside).
constexpr uint64_t kMaxRecords = uint64_t{1} << 24;
}  // namespace

GpuPagePlan::Level GpuPagePlan::addLevel(const PageAtlas& atlas, int level, std::span<const AtlasPage> drawn, const AtlasPage& stand) {
    const auto grid = atlas.pageGrid(level);
    if (!grid) throw std::runtime_error("TN_VIRTUAL_SHADOW_INVALID: a drawn level has no pages");
    // The clear draw addresses a page as instance * 2.
    while (plan_.size() % 8) plan_.push_back(0);
    Level out;
    out.firstPage = uint32_t(plan_.size() / 8);
    out.pageCount = uint32_t(drawn.size());
    out.tiles = uint32_t(atlas.tiles(level));
    const double edge = atlas.edge(), scale = atlas.stride() / edge;
    std::vector<uint32_t> cells(std::size_t(out.tiles) * out.tiles, 0);
    for (const AtlasPage& page : drawn) {
        cells[std::size_t(page.y) * out.tiles + std::size_t(page.x)] = uint32_t(plan_.size() / 4) + 1;
        const auto [x, y] = atlas.origin(page.slot);
        // The slot's centre in atlas clip space, as the viewport (x, y, stride, stride) placed it: page NDC +1 is
        // framebuffer row y (UE 5.8.3: Engine/Shaders/Private/ShadowDepthVertexShader.usf:42-63 scales and biases the
        // clip position into the physical page in the same way). A page differs from `stand` only by translation.
        const double centerX = 2 * x / edge + scale - 1, centerY = 1 - 2 * y / edge - scale;
        const double shiftX = page.projection.elements[12] - stand.projection.elements[12];
        const double shiftY = page.projection.elements[13] - stand.projection.elements[13];
        plan_.insert(plan_.end(), {float(scale), float(scale * shiftX + centerX), float(scale * shiftY + centerY), 0.0f,
                                   float(centerX - scale), float(centerY - scale), float(centerX + scale), float(centerY + scale)});
    }
    out.levelAt = uint32_t(plan_.size() / 4);
    const uint32_t lookupAt = out.levelAt + 4;
    plan_.insert(plan_.end(), {float(grid->axisU.x), float(grid->axisU.y), float(grid->axisU.z), float(grid->lowU),
                               float(grid->axisV.x), float(grid->axisV.y), float(grid->axisV.z), float(grid->lowV),
                               float(grid->highU), float(grid->highV), float(grid->cellU), float(grid->cellV),
                               float(out.tiles), float(lookupAt), 0.0f, 0.0f});
    for (const uint32_t cell : cells) plan_.insert(plan_.end(), {float(cell), 0.0f, 0.0f, 0.0f});
    return out;
}

uint32_t GpuPagePlan::addRow(const PageAtlas& atlas, int level, const Level& at, const Row& row) {
    const auto grid = atlas.pageGrid(level);
    if (!grid) throw std::runtime_error("TN_VIRTUAL_SHADOW_INVALID: a drawn level has no pages");
    // The most cells one instance can reach: its extent along the axis, the page rect's own overlap of its neighbours,
    // and a cell each way for a float that rounds past the edge. Unreal sizes the same output conservatively
    // (UE 5.8.3: Engine/Source/Runtime/Renderer/Private/VirtualShadowMaps/VirtualShadowMapArray.cpp:3964-3970).
    const auto reach = [&](const Vector3& axis, double low, double high, double cell) {
        const double extent = std::abs(axis.x) * row.largest.x + std::abs(axis.y) * row.largest.y + std::abs(axis.z) * row.largest.z;
        const double cells = std::ceil((extent + high - low - cell) / cell) + 3;
        return std::isfinite(cells) ? std::min<uint64_t>(uint64_t(cells), at.tiles) : uint64_t(at.tiles);
    };
    const uint64_t perInstance = row.cull == Cull::Everywhere ? at.pageCount
        : std::min<uint64_t>(at.pageCount, reach(grid->axisU, grid->lowU, grid->highU, grid->cellU) * reach(grid->axisV, grid->lowV, grid->highV, grid->cellV));
    const uint64_t capacity = perInstance * row.instances;
    const uint32_t recordBase = uint32_t(records_);
    records_ += capacity;
    if (records_ > kMaxRecords) throw std::runtime_error("TN_VIRTUAL_SHADOW_RECORDS: a frame's page records exceed 2^24");
    const uint32_t rowAt = uint32_t(plan_.size() / 4);
    Vector3 center, half;
    row.box.getCenter(center);
    row.box.getSize(half);
    plan_.insert(plan_.end(), {float(center.x), float(center.y), float(center.z), float(int(row.cull)),
                               float(half.x / 2), float(half.y / 2), float(half.z / 2), float(row.instanceBase)});
    if (row.model) for (const double element : *row.model) plan_.push_back(float(element));
    else plan_.insert(plan_.end(), {1.0f, 0.0f, 0.0f, 0.0f, 0.0f, 1.0f, 0.0f, 0.0f, 0.0f, 0.0f, 1.0f, 0.0f, 0.0f, 0.0f, 0.0f, 1.0f});
    const uint32_t countWord = rows_ * 5 + 1;
    plan_.insert(plan_.end(), {float(recordBase), float(capacity), float(countWord), float(at.levelAt)});
    // Count, instances (the kernel adds them), then zero first index, base vertex and first instance.
    const uint32_t words[5] = {row.drawCount, 0, 0, 0, 0};
    for (const uint32_t word : words) args_.push_back(std::bit_cast<float>(word));
    for (uint32_t first = 0; first < row.instances; first += kChunkInstances) {
        chunks_.insert(chunks_.end(), {float(rowAt), float(first), float(std::min(kChunkInstances, row.instances - first)), 0.0f});
        ++chunkCount_;
    }
    ++rows_;
    return recordBase;
}

void GpuPagePlan::finish() {
    chunkBase_ = uint32_t(plan_.size() / 4);
    plan_.insert(plan_.end(), chunks_.begin(), chunks_.end());
    if (plan_.size() / 4 > kMaxRecords) throw std::runtime_error("TN_VIRTUAL_SHADOW_RECORDS: a frame's page plan exceeds 2^24");
}

shader::Program pageCullProgram() {
    using namespace shader;
    Program p(Stage::Compute);
    const auto plan = p.storageBuffer("vsmPlan", Type::vec(4));
    const auto instances = p.storageBuffer("instances", Type::vec(4));
    const auto records = p.storageBuffer("vsmRecords", Type::vec(2, Type::Scalar::U32));
    const auto args = p.storageBuffer("vsmArgs", Type::u32(), true);
    const auto u = [&](ExprId value) { return p.construct(Type::u32(), {value}); };
    const auto un = [&](int32_t n) { return p.construct(Type::u32(), {p.constant(n)}); };
    const auto i = [&](ExprId value) { return p.construct(Type::i32(), {value}); };
    const auto f = [&](float n) { return p.constant(n); };
    const auto lane = [&](ExprId value, const char* name) { return p.swizzle(value, name); };
    const auto at = [&](ExprId base, int32_t n) { return p.loadStorage(plan, p.add(base, un(n))); };
    const auto id = lane(p.builtin("globalInvocationId"), "x");
    p.If(p.less(id, u(p.uniform("pageChunkCount", Type::f32()))), [&] {
        const auto chunk = p.loadStorage(plan, p.add(u(p.uniform("pageChunkBase", Type::f32())), id));
        const auto rowAt = u(lane(chunk, "x")), first = u(lane(chunk, "y"));
        const auto r0 = at(rowAt, 0), r1 = at(rowAt, 1), m0 = at(rowAt, 2), m1 = at(rowAt, 3), m2 = at(rowAt, 4), m3 = at(rowAt, 5), r6 = at(rowAt, 6);
        const auto cull = lane(r0, "w");
        const auto levelAt = u(lane(r6, "w"));
        const auto l0 = at(levelAt, 0), l1 = at(levelAt, 1), l2 = at(levelAt, 2), l3 = at(levelAt, 3);
        const auto axisU = lane(l0, "xyz"), axisV = lane(l1, "xyz");
        const auto tiles = lane(l3, "x");
        const auto lookupAt = u(lane(l3, "y"));
        const auto instanceBase = u(lane(r1, "w"));
        const auto recordBase = u(lane(r6, "x")), capacity = u(lane(r6, "y")), countWord = u(lane(r6, "z"));
        p.Loop(i(lane(chunk, "z")), [&](ExprId index) {
            const auto j = p.add(first, u(index));
            const auto last = p.sub(tiles, f(1));
            const auto x0 = p.var(Type::f32(), f(0)), x1 = p.var(Type::f32(), last);
            const auto y0 = p.var(Type::f32(), f(0)), y1 = p.var(Type::f32(), last);
            p.If(p.less(cull, f(1.5f)), [&] {
                const auto c0 = p.var(Type::vec(4), m0), c1 = p.var(Type::vec(4), m1), c2 = p.var(Type::vec(4), m2), c3 = p.var(Type::vec(4), m3);
                p.If(p.less(f(0.5f), cull), [&] {
                    // UE 5.8.3: VirtualShadowMapBuildPerPageDrawCommands.usf:206-215 reads each instance's own bounds.
                    const auto model = p.construct(Type::mat(4, 4), {m0, m1, m2, m3});
                    const auto base = p.add(instanceBase, p.mul(j, un(5)));
                    p.assign(c0, p.mul(model, p.loadStorage(instances, p.add(base, un(0)))));
                    p.assign(c1, p.mul(model, p.loadStorage(instances, p.add(base, un(1)))));
                    p.assign(c2, p.mul(model, p.loadStorage(instances, p.add(base, un(2)))));
                    p.assign(c3, p.mul(model, p.loadStorage(instances, p.add(base, un(3)))));
                });
                const auto a = p.load(c0), b = p.load(c1), c = p.load(c2), d = p.load(c3);
                const auto center = lane(p.add(p.add(p.add(p.mul(a, lane(r0, "x")), p.mul(b, lane(r0, "y"))), p.mul(c, lane(r0, "z"))), d), "xyz");
                const auto half = p.add(p.add(p.mul(p.call("abs", {lane(a, "xyz")}), lane(r1, "x")), p.mul(p.call("abs", {lane(b, "xyz")}), lane(r1, "y"))),
                                        p.mul(p.call("abs", {lane(c, "xyz")}), lane(r1, "z")));
                // The inverse of PageAtlas::overlaps, in float32. The slack only widens the range: a page too many
                // draws nothing, because the vertex stage clips to its slot. A thousandth of a cell, plus what float32
                // rounding of the world coordinates can lose. (UE 5.8.3: :307 takes the rect, :309 tests its pages.)
                const auto range = [&](ExprId axis, ExprId low, ExprId high, ExprId cell, VarId from, VarId to) {
                    const auto middle = p.call("dot", {center, axis});
                    const auto reach = p.call("dot", {half, p.call("abs", {axis})});
                    const auto slack = p.add(p.mul(cell, f(1e-3f)), p.mul(p.call("abs", {middle}), f(1e-6f)));
                    p.assign(from, p.call("max", {f(0), p.call("ceil", {p.div(p.sub(p.sub(p.sub(middle, reach), slack), high), cell)})}));
                    p.assign(to, p.call("min", {last, p.call("floor", {p.div(p.sub(p.add(p.add(middle, reach), slack), low), cell)})}));
                };
                range(axisU, lane(l0, "w"), lane(l2, "x"), lane(l2, "z"), x0, x1);
                range(axisV, lane(l1, "w"), lane(l2, "y"), lane(l2, "w"), y0, y1);
            });
            const auto fromX = p.load(x0), fromY = p.load(y0);
            const auto width = i(p.add(p.sub(p.load(x1), fromX), f(1))), height = i(p.add(p.sub(p.load(y1), fromY), f(1)));
            p.Loop(height, [&](ExprId row) {
                const auto y = p.add(fromY, p.construct(Type::f32(), {row}));
                p.Loop(width, [&](ExprId column) {
                    const auto x = p.add(fromX, p.construct(Type::f32(), {column}));
                    const auto cell = p.add(lookupAt, u(p.add(p.mul(y, tiles), x)));
                    const auto page = lane(p.loadStorage(plan, cell), "x");
                    p.If(p.less(f(0.5f), page), [&] {
                        const auto slot = p.atomicAdd(args, countWord, un(1));
                        p.If(p.less(slot, capacity), [&] {
                            p.store(records, p.add(recordBase, slot),
                                    p.construct(Type::vec(2, Type::Scalar::U32), {j, u(p.sub(page, f(1)))}));
                        });
                    });
                });
            });
        });
    });
    return p;
}

shader::Program pageClearProgram() {
    using namespace shader;
    Program v(Stage::Vertex);
    const auto plan = v.storageBuffer("vsmPlan", Type::vec(4));
    const auto un = [&](int32_t n) { return v.construct(Type::u32(), {v.constant(n)}); };
    const auto rect = v.loadStorage(plan, v.add(v.mul(v.builtin("instanceIndex"), un(2)), un(1)));
    const auto i = v.builtin("vertexIndex");
    const auto xMin = v.swizzle(rect, "x"), yMin = v.swizzle(rect, "y"), xMax = v.swizzle(rect, "z"), yMax = v.swizzle(rect, "w");
    // Two triangles: (min, min) (max, min) (min, max), (min, max) (max, min) (max, max).
    const auto x = v.select(v.equal(i, un(1)), xMax, v.select(v.equal(i, un(4)), xMax, v.select(v.equal(i, un(5)), xMax, xMin)));
    const auto y = v.select(v.equal(i, un(2)), yMax, v.select(v.equal(i, un(3)), yMax, v.select(v.equal(i, un(5)), yMax, yMin)));
    v.output("position", v.construct(Type::vec(4), {x, y, v.constant(1.0f), v.constant(1.0f)}));
    return v;
}

}  // namespace tn::engine::shadows
