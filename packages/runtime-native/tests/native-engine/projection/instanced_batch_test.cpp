// PRD-519: InstancedBatch decides every case of packages/core/__tests__/instanced-batch.spec.ts as
// the real InstancedBatch does, over the native scene graph (instanced_batch_reference.inc, written by
// instanced-batch-reference.ts): the matrix each placement composes, what each build made or refused
// with which reason code, and every LOD partition, its per-frame level, its bounds and its counts.
//
// Every float is compared through its bit pattern, so a decision that is right to sixteen digits and
// wrong in the last one still fails. Each step is `case|step|field;field` and the two sides must agree
// on the whole line.
#include "check.h"
#include "engine/renderer/projection/instanced_batch.h"

#include <cstdio>
#include <cstring>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "engine/scene/geometries.h"
#include "engine/scene/material.h"

#include "instanced_batch_reference.inc"

using namespace tn::engine;
using namespace tn::engine::projection;

namespace {

std::string bits(double value) {
    char out[17];
    std::snprintf(out, sizeof out, "%016llx", static_cast<unsigned long long>(std::bit_cast<uint64_t>(value)));
    return out;
}

const std::string flag(bool value) { return value ? "1" : "0"; }

/** The `readInstance` of the spec: position, scale, and the axis a unit +Y shape points along. */
std::string instanceOf(const InstancedMesh& mesh, uint32_t index) {
    Matrix4 read;
    mesh.getMatrixAt(index, read);
    Vector3 position, scale;
    position.setFromMatrixPosition(read);
    scale.setFromMatrixScale(read);
    Vector3 axis(0, 1, 0);
    axis.transformDirection(read);
    std::string out;
    for (const double component : {position.x, position.y, position.z, scale.x, scale.y, scale.z, axis.x,
                                  axis.y, axis.z})
        out += (out.empty() ? "" : ",") + bits(component);
    return out;
}

Matrix4 translation(double x, double y, double z) { return Matrix4().makeTranslation(x, y, z); }

/** The `draws(root)` of the spec: a visible partition with instances and something to draw. */
void collectDraw(Object3D& object, void* context) {
    auto* drawn = static_cast<std::vector<InstancedMesh*>*>(context);
    auto* mesh = dynamic_cast<InstancedMesh*>(&object);
    if (mesh == nullptr || !mesh->visible() || mesh->count == 0 || mesh->geometry == nullptr) return;
    if (mesh->geometry->drawRange.count <= 0) return;
    drawn->push_back(mesh);
}

std::vector<InstancedMesh*> draws(Object3D& root) {
    std::vector<InstancedMesh*> found;
    root.traverse(collectDraw, &found);
    return found;
}

/** One partition as the generator records it: cell:level:count:indexCount:colours:visible:cast:recv. */
std::string partitionOf(const InstancedMesh& draw) {
    std::string label;
    const std::size_t at = draw.name.find(':');
    label = at == std::string::npos ? draw.name : draw.name.substr(at + 1);
    std::string out = label + ":" + std::to_string(draw.count) + ":";
    const uint64_t elements = draw.geometry != nullptr && draw.geometry->index
                                  ? draw.geometry->index->count()
                                  : (draw.geometry != nullptr && draw.geometry->attributes.count("position")
                                         ? draw.geometry->attributes.at("position")->count()
                                         : 0);
    out += std::to_string(elements) + ":";
    for (int component = 0; component < 3; ++component) {
        const double colour = draw.instanceColor == nullptr || draw.count == 0
                                  ? 0
                                  : (component == 0 ? draw.instanceColor->getX(0)
                                                    : component == 1 ? draw.instanceColor->getY(0)
                                                                     : draw.instanceColor->getZ(0));
        out += (component == 0 ? "" : ",") + bits(colour);
    }
    return out + ":" + flag(draw.visible()) + ":" + flag(draw.castShadow()) + ":" +
           flag(draw.receiveShadow());
}

std::string partitionsOf(Object3D& root) {
    std::string out;
    for (const InstancedMesh* draw : draws(root))
        out += (out.empty() ? "" : ",") + partitionOf(*draw);
    return out;
}

/** A triangle count as a JS number prints it: whole numbers carry no fraction. */
std::string trianglesText(double triangles) {
    return std::to_string(static_cast<uint64_t>(triangles));
}

std::string built(const Build& build) {
    return "m=" + flag(build.mesh != nullptr) + ";mc=" + std::to_string(build.count) + ";ms=" +
           std::to_string(build.slots);
}

std::string reports(const Build& build) {
    return "w=" + std::to_string(build.warnings.size()) +
           (build.warnings.empty() ? "" : ":" + build.warnings[0]);
}

const std::string verdict(const Verdict& v) { return v.ok ? "ok" : v.reasonCode; }

std::shared_ptr<BufferGeometry> box() { return makeBoxGeometry(); }
std::shared_ptr<Material> material() { return std::make_shared<Material>(MaterialType::Basic); }

/** One baked chain over a unit box: LOD0 is 12 triangles, LOD1 the first two, as the loader builds it. */
std::shared_ptr<BufferGeometry> bakedGeometry(LodChain& chain) {
    auto base = makeBoxGeometry();
    auto level = std::make_shared<BufferGeometry>();
    for (const auto& entry : base->attributes) level->setAttribute(entry.first, entry.second);
    level->setIndexFromArray({0, 1, 2, 0, 2, 3});
    base->computeBoundingSphere();
    base->computeBoundingBox();
    level->boundingSphere = base->boundingSphere;
    level->boundingBox = base->boundingBox;
    chain.levels = {base, level};
    chain.errors = {0, 0.1};
    return base;
}

std::unique_ptr<InstancedBatch> makeBatch(BatchOptions options) {
    Verdict created;
    return InstancedBatch::create(std::move(options), created);
}

/** One placement's authored numbers, owning the storage its spans point into. */
struct Spot {
    std::array<double, 3> position{};
    std::array<double, 3> scale{};
    std::array<double, 3> rotation{};
    Placement placement;

    explicit Spot(double x, double y, double z) : position{x, y, z} { reset(); }

    /** Adds an authored scale, as `IInstancedPlacement.scale`. */
    Spot& scaled(double x, double y, double z) {
        scale = {x, y, z};
        placement.scaleAxes = scale;
        return *this;
    }
    /** Adds an authored rotation in radians, as `IInstancedPlacement.rotation`. */
    Spot& turned(double x, double y, double z) {
        rotation = {x, y, z};
        placement.rotation = rotation;
        return *this;
    }

  private:
    void reset() { placement.position = position; }
};

std::shared_ptr<PerspectiveCamera> lodCamera() {
    auto camera = std::make_shared<PerspectiveCamera>(60, 1, 0.1, 1000);
    camera->updateMatrixWorld();
    return camera;
}

std::vector<std::string> observed;

void observe(const char* name, const char* step, const std::vector<std::string>& fields) {
    std::string line = std::string(name) + "|" + step + "|";
    for (std::size_t i = 0; i < fields.size(); ++i) line += (i == 0 ? "" : ";") + fields[i];
    observed.push_back(line);
}

// ------------------------------------------------------------------------------------- the cases

/** 1. Every placement collapses into one mesh with the transforms it was given. */
void collapse() {
    auto props = makeBatch({box(), material()});
    uint32_t index = 0;
    Spot first(1, 2, 3);
    Spot second(-4, 0, 5);
    second.scaled(2, 3, 4).turned(0, 3.141592653589793 / 2, 0);
    props->place(first.placement, index);
    props->place(second.placement, index);
    observe("collapse", "placed", {"n=" + std::to_string(props->count())});
    const Build build = props->build();
    observe("collapse", "built", {built(build), "i0=" + instanceOf(*build.mesh, 0),
                                  "i1=" + instanceOf(*build.mesh, 1)});
}

/** 2. Each placement hands back its instance index, and animating one leaves its neighbours alone. */
void index() {
    auto props = makeBatch({box(), material()});
    uint32_t first = 0, second = 0, third = 0;
    Spot ground(0, 0, 0), flame(0, 5, 0), crown(0, 9, 0);
    props->place(ground.placement, first);
    props->place(flame.placement, second);
    props->place(crown.placement, third);
    observe("index", "placed",
            {"idx=" + std::to_string(first) + "," + std::to_string(second) + "," + std::to_string(third)});
    const Build build = props->build();
    build.mesh->setMatrixAt(second, translation(7, 7, 7));
    observe("index", "built",
            {built(build), "i1=" + instanceOf(*build.mesh, second), "i2=" + instanceOf(*build.mesh, 2)});
}

/** 3. The matrix it is handed is copied, so one scratch Matrix4 can drive every call. */
void add() {
    auto props = makeBatch({box(), material()});
    uint32_t index = 0;
    Matrix4 scratch;
    props->add(scratch.makeTranslation(1, 0, 0), index);
    props->add(scratch.makeTranslation(2, 0, 0), index);
    const Build build = props->build();
    observe("add", "built", {built(build), "i0=" + instanceOf(*build.mesh, 0),
                              "i1=" + instanceOf(*build.mesh, 1)});
}

/** 4. A span stretches a unit-height shape from one point toward the other. */
void span() {
    auto props = makeBatch({makeCylinderGeometry(1, 1, 1, 6), material()});
    uint32_t index = 0;
    props->span(std::span<const double>(std::array<double, 3>{0, 0, 0}),
                std::span<const double>(std::array<double, 3>{0, 0, 10}), 0.25, index);
    const Build build = props->build();
    observe("span", "built", {built(build), "i0=" + instanceOf(*build.mesh, 0)});
}

/** 5. The batch is bounded around every instance, not around one un-transformed copy. */
void bounds() {
    auto props = makeBatch({box(), material()});
    uint32_t index = 0;
    Spot near(0, 0, 0), far(100, 0, 0);
    props->place(near.placement, index);
    props->place(far.placement, index);
    const Build build = props->build();
    const double radius = build.mesh->boundingSphere != nullptr ? build.mesh->boundingSphere->radius : 0;
    observe("bounds", "built", {built(build), "r=" + bits(radius), "over=" + flag(radius > 50)});
}

/** 6. The built mesh goes straight through to the parent, name and shadow flags. */
void parent() {
    auto group = std::make_shared<Group>();
    auto props = makeBatch({box(), material()});
    uint32_t index = 0;
    Spot one(0, 0, 0);
    props->place(one.placement, index);
    BuildOptions options;
    options.castShadow = true;
    options.receiveShadow = true;
    options.name = "curbs";
    options.parent = group.get();
    const Build build = props->build(options);
    observe("parent", "built",
            {built(build), "pc=" + std::to_string(group->children.size()),
             "nm=" + (build.mesh != nullptr ? build.mesh->name : std::string()),
             "cast=" + flag(build.mesh != nullptr && build.mesh->castShadow()),
             "recv=" + flag(build.mesh != nullptr && build.mesh->receiveShadow()),
             "mm=" + flag(props->mesh() == build.mesh)});
}

/** 7. The shadow flags default to three's own, so the batch decides nothing. */
void shadowDefaults() {
    auto props = makeBatch({box(), material()});
    uint32_t index = 0;
    Spot one(0, 0, 0);
    props->place(one.placement, index);
    const Build build = props->build();
    observe("shadow-defaults", "built",
            {built(build), "cast=" + flag(build.mesh != nullptr && build.mesh->castShadow()),
             "recv=" + flag(build.mesh != nullptr && build.mesh->receiveShadow())});
}

/** 8. An empty batch builds no mesh at all, and refuses every later placement. */
void empty() {
    auto props = makeBatch({box(), material()});
    const Build build = props->build();
    uint32_t index = 0;
    const std::array<double, 3> origin{0, 0, 0};
    const std::array<double, 3> up{0, 1, 0};
    Spot one(1, 0, 0);
    const Verdict placed = props->place(one.placement, index);
    const Verdict stretched = props->span(origin, up, 0.1, index);
    const Verdict added = props->add(Matrix4(), index);
    observe("empty", "built",
            {built(build), "mm=" + flag(props->mesh() == nullptr), "v=" + verdict(placed),
             "v=" + verdict(stretched), "v=" + verdict(added)});
}

/** 9. A batch refuses to place after build, because an InstancedMesh count is fixed. */
void closed() {
    auto props = makeBatch({box(), material()});
    uint32_t index = 0;
    Spot one(0, 0, 0);
    props->place(one.placement, index);
    const Build build = props->build();
    const std::array<double, 3> origin{0, 0, 0};
    const std::array<double, 3> up{0, 1, 0};
    Spot after(1, 0, 0);
    const Verdict placed = props->place(after.placement, index);
    const Verdict stretched = props->span(origin, up, 0.1, index);
    const Verdict added = props->add(Matrix4(), index);
    const Verdict again = props->build().verdict;
    observe("closed", "built",
            {built(build), "v=" + verdict(placed), "v=" + verdict(stretched), "v=" + verdict(added),
             "v=" + verdict(again)});
}

/** 10. Input that would silently shift every later index fails closed. */
void failClosed() {
    auto props = makeBatch({box(), material()});
    uint32_t index = 0;
    const std::array<double, 3> at{1, 2, 3};
    const std::array<double, 3> origin{0, 0, 0};
    const std::array<double, 3> up{0, 1, 0};
    const std::array<double, 2> shortScale{1, 2};
    const Verdict samePoint = props->span(at, at, 0.2, index);
    const Verdict noRadius = props->span(origin, up, 0, index);
    Spot notFinite(0, std::nan(""), 0);
    const Verdict notFiniteVerdict = props->place(notFinite.placement, index);
    Spot broken(0, 0, 0);
    broken.placement.scaleAxes = shortScale;
    const Verdict notTriple = props->place(broken.placement, index);
    observe("fail-closed", "refused",
            {"v=" + verdict(samePoint), "v=" + verdict(noRadius), "v=" + verdict(notFiniteVerdict),
             "v=" + verdict(notTriple), "n=" + std::to_string(props->count())});
}

/** 11. The game supplies both the shape and the surface; the batch chooses neither. */
void requiresParts() {
    Verdict verdict;
    InstancedBatch::create({nullptr, material()}, verdict);
    const std::string geometry = verdict.reasonCode;
    InstancedBatch::create({box(), nullptr}, verdict);
    observe("requires-parts", "refused", {"v=" + geometry, "v=" + verdict.reasonCode});
}

/** 12. Invalid automatic selection options are refused even on geometry without a chain. */
void autoLod() {
    BatchOptions options{box(), material()};
    options.autoLod = true;
    options.maxPixelError = std::nan("");
    auto props = makeBatch(std::move(options));
    uint32_t index = 0;
    Spot at(0, 0, 0);
    props->place(at.placement, index);
    observe("auto-lod", "built", {"v=" + verdict(props->build().verdict)});
}

/** 13. Near and far instances partition through the engine frame tracker, with no game LOD code. */
void partitions() {
    LodChain chain;
    BatchOptions options{bakedGeometry(chain), material()};
    options.chain = chain;
    auto props = makeBatch(std::move(options));
    uint32_t index = 0;
    Spot close(0, 0, -5), distant(0, 0, -100);
    props->place(close.placement, index);
    props->place(distant.placement, index);
    auto root = std::make_shared<Group>();
    BuildOptions build;
    build.name = "pines";
    build.parent = root.get();
    build.castShadow = true;
    const Build built = props->build(build);
    built.mesh->setColorAt(0, Color(1, 0, 0));
    built.mesh->setColorAt(1, Color(0, 0, 1));
    root->updateMatrixWorld(true);
    {
        const auto camera = lodCamera();
        const double triangles = updateInstancedLods(*root, *camera, 1080);
        observe("partitions", "frame",
                {"t=" + trianglesText(triangles), "d=" + partitionsOf(*root),
                 "ac=" + std::to_string(built.mesh->children.size())});
    }
    // Public matrices retain placement order: a far slot moved near joins the near partition.
    built.mesh->setMatrixAt(1, translation(0, 0, -5));
    {
        const auto camera = lodCamera();
        const double triangles = updateInstancedLods(*root, *camera, 1080);
        observe("partitions", "moved", {"t=" + trianglesText(triangles), "d=" + partitionsOf(*root)});
    }
    root->remove(*built.mesh);
    root->add(*built.mesh);
    {
        const auto camera = lodCamera();
        const double triangles = updateInstancedLods(*root, *camera, 1080);
        observe("partitions", "readded", {"t=" + trianglesText(triangles), "d=" + partitionsOf(*root)});
    }
}

/** 14. Empty render partitions stay visible across LOD changes, so projection lights are stable. */
void emptyPartitions() {
    LodChain chain;
    BatchOptions options{bakedGeometry(chain), material()};
    options.chain = chain;
    auto props = makeBatch(std::move(options));
    uint32_t index = 0;
    Spot distant(0, 0, -100);
    props->place(distant.placement, index);
    auto root = std::make_shared<Group>();
    BuildOptions build;
    build.parent = root.get();
    build.castShadow = true;
    build.receiveShadow = true;
    const Build builtMesh = props->build(build);
    InstancedMesh& mesh = *builtMesh.mesh;
    const auto flags = [&mesh]() {
        std::string out;
        for (const Object3D* child : mesh.children)
            out += (out.empty() ? "" : ",") +
                   flag(child->castShadow() && child->receiveShadow()) + flag(child->visible());
        return out;
    };
    observe("empty-partitions", "built",
            {"ac=" + std::to_string(mesh.children.size()), "f=" + flags()});
    {
        const auto camera = lodCamera();
        const double triangles = updateInstancedLods(*root, *camera, 1080);
        observe("empty-partitions", "far", {"t=" + trianglesText(triangles), "f=" + flags()});
    }
    mesh.setMatrixAt(0, translation(0, 0, -5));
    {
        const auto camera = lodCamera();
        const double triangles = updateInstancedLods(*root, *camera, 1080);
        observe("empty-partitions", "near", {"t=" + trianglesText(triangles), "f=" + flags()});
    }
}

/** 15. A broad LOD batch is spatially bounded while retaining its offscreen shadow casters. */
void broad() {
    LodChain chain;
    BatchOptions options{bakedGeometry(chain), material()};
    options.chain = chain;
    auto props = makeBatch(std::move(options));
    uint32_t index = 0;
    for (double x : {100.0, 0.0, -100.0, 80.0, -1.0, -80.0, 60.0, 1.0, -60.0}) {
        Spot at(x, 0, -10);
        props->place(at.placement, index);
    }
    auto root = std::make_shared<Group>();
    BuildOptions build;
    build.parent = root.get();
    build.castShadow = true;
    const Build builtMesh = props->build(build);
    const auto camera = lodCamera();
    updateInstancedLods(*root, *camera, 1080);
    Frustum frustum;
    frustum.setFromProjectionMatrix(
        Matrix4().multiplyMatrices(camera->projectionMatrix, camera->matrixWorldInverse));
    const std::vector<InstancedMesh*> found = draws(*root);
    int visibleTriangles = 0;
    int total = 0;
    bool everyCaster = true;
    for (const InstancedMesh* child : found) {
        if (child->boundingSphere != nullptr &&
            frustum.intersectsSphere(child->boundingSphere->clone().applyMatrix4(child->matrixWorld)))
            visibleTriangles += int(child->count) * 12;
        total += int(child->count);
        everyCaster = everyCaster && child->castShadow() && child->visible();
    }
    Matrix4 read;
    builtMesh.mesh->getMatrixAt(0, read);
    observe("broad", "frame",
            {"t=" + trianglesText(updateInstancedLods(*root, *camera, 1080)), "d=" + partitionsOf(*root),
             "fr=" + std::to_string(visibleTriangles), "tot=" + std::to_string(total),
             "cv=" + flag(everyCaster), "nx=" + bits(read.elements[12])});
}

/** 16. A scaled parent and a moving camera both move the switch distances. */
void scaledParent() {
    LodChain chain;
    auto geometry = bakedGeometry(chain);
    // The loader's clone hook scales a chain's errors by the geometry's own scale; 4 is the largest.
    geometry->applyMatrix4(Matrix4().makeScale(2, 3, 4));
    chain.errors = {0, 0.1 * 4};
    BatchOptions options{geometry, material()};
    options.chain = chain;
    auto props = makeBatch(std::move(options));
    uint32_t index = 0;
    Spot distant(0, 0, -150);
    props->place(distant.placement, index);
    auto root = std::make_shared<Group>();
    root->scale.setScalar(2);
    BuildOptions build;
    build.parent = root.get();
    props->build(build);
    root->updateMatrixWorld(true);
    const auto camera = lodCamera();
    observe("scaled-parent", "chain", {"e1=" + bits(chain.errors[1])});
    const double far = updateInstancedLods(*root, *camera, 1080);
    camera->position.z = -290;
    const double near = updateInstancedLods(*root, *camera, 1080);
    observe("scaled-parent", "levels", {"t0=" + trianglesText(far), "t1=" + trianglesText(near)});
}

/** 17. Authored levels win, a failed rung warns once with the batch name, and opt-out keeps LOD0. */
void authored() {
    LodChain chain;
    auto geometry = bakedGeometry(chain);
    auto authoredLevel = makeBoxGeometry(2, 2, 2);
    authoredLevel->setIndexFromArray({0, 1, 2});
    BatchOptions options{geometry, material()};
    options.lods = std::vector<AuthoredLod>{{10, authoredLevel}, {20, nullptr}};
    auto props = makeBatch(std::move(options));
    uint32_t index = 0;
    Spot distant(0, 0, -100);
    props->place(distant.placement, index);
    auto root = std::make_shared<Group>();
    BuildOptions build;
    build.parent = root.get();
    build.name = "authored-pines";
    const Build builtMesh = props->build(build);
    root->updateMatrixWorld(true);
    {
        updateInstancedLods(*root, *lodCamera(), 1080);
        updateInstancedLods(*root, *lodCamera(), 1080);
    }
    bool everyAuthored = true;
    for (const InstancedMesh* draw : draws(*root)) everyAuthored = everyAuthored && draw->geometry == authoredLevel;
    observe("authored", "built",
            {built(builtMesh), "d=" + partitionsOf(*root), "g=" + std::string(everyAuthored ? "authored" : "other"),
             reports(builtMesh)});
    BatchOptions keep{geometry, material()};
    keep.autoLod = false;
    auto fixed = makeBatch(std::move(keep));
    Spot keptSpot(0, 0, -100);
    fixed->place(keptSpot.placement, index);
    const Build kept = fixed->build();
    observe("authored", "opt-out",
            {"g=" + std::string(kept.mesh != nullptr && kept.mesh->geometry == geometry ? "base" : "other"),
             "ac=" + std::to_string(kept.mesh != nullptr ? kept.mesh->children.size() : 0)});
}

void batchingEligibility() {
    collapse();
    index();
    add();
    span();
    bounds();
    parent();
    shadowDefaults();
    empty();
    closed();
    failClosed();
    requiresParts();
    autoLod();
    partitions();
    emptyPartitions();
    broad();
    scaledParent();
    authored();

    // A case is the unit of the verdict: one differing step fails its case, not the whole table.
    std::size_t cases = 0;
    std::size_t differ = 0;
    std::string current;
    for (std::size_t i = 0; i < observed.size() && i < std::size(kSteps); ++i) {
        const std::string name = observed[i].substr(0, observed[i].find('|'));
        if (name != current) {
            current = name;
            ++cases;
        }
        if (observed[i] == kSteps[i]) continue;
        std::size_t at = 0;
        while (at < observed[i].size() && at < std::strlen(kSteps[i]) && observed[i][at] == kSteps[i][at])
            ++at;
        const std::size_t from = observed[i].rfind(';', at) + 1;
        std::fprintf(stderr, "  %s: native %s\n        three %s\n", name.c_str(),
                     observed[i].substr(from).c_str(), std::string(kSteps[i]).substr(from).c_str());
        ++differ;
    }
    std::printf("instanced batch: %zu steps, %zu cases, %zu steps differ\n", observed.size(), cases,
                differ);
    if (observed.size() != std::size(kSteps)) {
        std::fprintf(stderr, "step count: %zu native vs %zu recorded\n", observed.size(),
                     std::size(kSteps));
        ++differ;
    }
    if (cases != 17) {
        std::fprintf(stderr, "cases: %zu, expected the 17 cases of instanced-batch.spec.ts\n", cases);
        ++differ;
    }
    CHECK(differ == 0);
}

} // namespace

TN_TEST_MAIN({"batching_eligibility", batchingEligibility})
