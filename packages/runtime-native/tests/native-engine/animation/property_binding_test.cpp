// PRD-516 phase 1: property-path binding against the pinned three. parseTrackName answers three's
// own test names and the edge cases exactly; the binding scenario (bind, reparent inside the root,
// leave the root, rebind, a shadowing name, a removed node) runs here step for step as the
// generator ran it on three, and each step's node transforms and binding reads must be three's bits.
#include "check.h"
#include "engine/animation/property_binding.h"
#include "engine/animation/skinning/skeleton.h"

#include <bit>
#include <cinttypes>
#include <cmath>
#include <cstdio>
#include <iterator>
#include <memory>
#include <string>
#include <vector>

#include "property_binding_reference.inc"

using namespace tn::engine;
using namespace tn::engine::animation;

namespace {

std::string show(const std::optional<std::string>& value) { return value ? *value : "~"; }

void parse() {
    std::size_t mismatched = 0;
    // Twice: the second pass answers every name from parseTrackName's cache.
    for (int pass = 0; pass < 2; ++pass)
    for (const auto& [name, expected] : kParse) {
        ParsedPath p;
        std::string error;
        const std::string got = parseTrackName(name, p, error)
                                    ? "node=" + show(p.nodeName) + ";object=" + show(p.objectName) +
                                          ";objectIndex=" + show(p.objectIndex) + ";property=" + p.propertyName +
                                          ";propertyIndex=" + show(p.propertyIndex)
                                    : "throws";
        if (got != expected) {
            ++mismatched;
            std::fprintf(stderr, "parseTrackName(\"%s\"): got %s, three has %s\n", name, got.c_str(), expected);
        }
    }
    std::printf("parseTrackName: %zu names, %zu differ\n", std::size(kParse), mismatched);
    CHECK(mismatched == 0);
}

std::string bits(double x) {
    char out[17];
    std::snprintf(out, sizeof out, "%016" PRIx64, std::bit_cast<uint64_t>(x));
    return out;
}

template <typename Array> std::string join(const Array& values) {
    std::string out;
    for (double v : values)
        out += (out.empty() ? "" : ",") + bits(v);
    return out;
}

void deferredBinding() {
    auto streamBone = std::make_shared<Bone>(); streamBone->enableTrackedTransform();
    auto stream = std::make_shared<std::vector<float>>(24, -1.0f);
    auto valid = std::make_shared<bool>(true);
    CHECK(!streamBone->enableDeferredTransform(stream, 13, valid));
    CHECK(streamBone->enableDeferredTransform(stream, 12, valid));
    CHECK((*stream)[12] == 0 && (*stream)[19] == 1 && (*stream)[20] == 1 && (*stream)[23] == 0);
    PropertyBinding streamed(streamBone, ".position"); double packedValues[] = {1.0000000000000002, 2, 3};
    streamed.setValue(packedValues, 0);
    CHECK((*stream)[12] == 1 && (*stream)[13] == 2 && (*stream)[14] == 3 && (*stream)[15] == 0);
    CHECK(streamBone->deferredTransformValues()[0] == packedValues[0]);
    std::weak_ptr<std::vector<float>> kept = stream; stream.reset();
    CHECK(!kept.expired()); // Bone owns the sink even when the scene-plan handle is released
    streamed.setValue(packedValues, 0);
    streamBone->exposeLocalTransform();
    CHECK(!*valid && kept.expired() && streamBone->position.x == packedValues[0]);
    auto resized = std::make_shared<std::vector<float>>(12); auto validResize = std::make_shared<bool>(true);
    auto resizeBone = std::make_shared<Bone>(); resizeBone->enableTrackedTransform();
    CHECK(resizeBone->enableDeferredTransform(resized, 0, validResize));
    PropertyBinding resizeBinding(resizeBone, ".position"); resizeBinding.setValue(packedValues, 0);
    resized->clear(); packedValues[0] = 7; resizeBinding.setValue(packedValues, 0);
    CHECK(!*validResize && resizeBone->position.x == 7 && resizeBone->position.y == 2);
    auto deathValid = std::make_shared<bool>(true);
    { auto dying = std::make_shared<Bone>(); dying->enableTrackedTransform();
      CHECK(dying->enableDeferredTransform(std::make_shared<std::vector<float>>(12), 0, deathValid)); }
    CHECK(!*deathValid);
    auto bone = std::make_shared<Bone>();
    PropertyBinding position(bone, ".position"), scale(bone, ".scale"), component(bone, ".position[x]");
    double values[] = {2.0000000000000004, 3, 4}, out[3]{};
    CHECK(!bone->enableDeferredTransform()); // plain C++ remains eager
    position.setValue(values, 0);
    CHECK(bone->position.x == values[0]);
    bone->enableTrackedTransform();
    CHECK(bone->enableDeferredTransform());
    values[0] = 8.000000000000002;
    position.setValue(values, 0);
    CHECK(bone->hasDeferredTransform() && bone->position.x != values[0]);
    values[0] = -99; // pending values never alias a mixer accumulator
    CHECK(bone->deferredTransformValues()[0] == 8.000000000000002);
    position.getValue(out, 0);
    CHECK(out[0] == 8.000000000000002 && out[1] == 3);
    values[0] = 5; position.setValue(values, 0);
    double scales[] = {2, 3, 4}; scale.setValue(scales, 0);
    double x[] = {11}; component.setValue(x, 0);
    CHECK(bone->position.x == 11 && bone->position.y == 3 && bone->scale.y == 3);
    CHECK(!bone->hasDeferredTransform());
    values[0] = 12; position.setValue(values, 0);
    CHECK(bone->position.x == 12); // unsupported component revoked admission
    CHECK(bone->enableDeferredTransform());
    values[0] = 17; position.setValue(values, 0);
    auto head = std::make_shared<Object3D>(); head->position.set(1, 0, 0); bone->add(*head);
    auto untouched = std::make_shared<Bone>(); untouched->enableTrackedTransform(); CHECK(untouched->enableDeferredTransform());
    PropertyBinding other(untouched, ".position"); other.setValue(values, 0);
    Vector3 world; head->getWorldPosition(world);
    CHECK(world.x == 19 && untouched->hasDeferredTransform()); // only needed ancestor path
    values[0] = 20; position.setValue(values, 0);
    position.getValue(out, 0); CHECK(!bone->hasDeferredTransform());
    Skeleton skeleton({bone}, {Matrix4{}}); skeleton.update();
    CHECK(skeleton.boneMatrices[12] == 20); // local read must not hide the outstanding world join
    auto childBone = std::make_shared<Bone>(); childBone->position.set(1, 0, 0); bone->add(*childBone);
    bone->updateMatrixWorld(true);
    Skeleton childSkeleton({childBone}, {Matrix4{}});
    values[0] = 23; position.setValue(values, 0);
    bone->getWorldPosition(world); // parent joined first, leaving unchanged descendants stale
    CHECK(!bone->matrixWorldNeedsUpdate && !childBone->matrixWorldNeedsUpdate);
    childSkeleton.update(); CHECK(childSkeleton.boneMatrices[12] == 25);
    values[0] = 24; position.setValue(values, 0); bone->getWorldPosition(world);
    Object3D::prepareTransformView(&head->matrixWorld);
    CHECK(head->matrixWorld.elements[12] == 26);
    values[0] = 21; position.setValue(values, 0);
    position.unbind(); CHECK(bone->position.x == 21 && !bone->hasDeferredTransform());
    CHECK(bone->enableDeferredTransform());
    values[0] = 25; position.setValue(values, 0);
    Object3D copy; copy.copy(*bone); CHECK(copy.position.x == 25);
    values[0] = 28; position.setValue(values, 0);
    Object3D::prepareTransformView(&bone->position);
    CHECK(bone->position.x == 28 && !bone->enableDeferredTransform());
    values[0] = 30; position.setValue(values, 0); CHECK(bone->position.x == 30);
    other.setValue(values, 0); untouched.reset(); other.setValue(values, 0); // released node safe
}

void binding() {
    deferredBinding();
    const std::pair<const char*, std::size_t> tracks[] = {
        {".position", 3},         {"hand.position", 3},    {"arm.L.quaternion", 4},      {"hand.scale[y]", 1},
        {"armB/hand.visible", 1}, {"missing.position", 3}, {"hand.material.opacity", 1}, {"hand.foo", 1},
    };
    // A boolean track writes 0 or 1. three stores the raw number in `visible`, the engine a bool, so
    // only 0 and 1 read back the same; any other number is still JavaScript truthiness here.
    const double visible[] = {0, 0, 1, 0, 1, 0, 1, 0};
    const auto named = [](const char* name) {
        auto object = std::make_shared<Object3D>();
        object->name = name;
        return object;
    };
    auto root = named("root"), armA = named("armA"), armL = named("arm.L"), armB = named("armB"), hand = named("hand"),
         hand2 = named("hand"), outside = named("outside");
    root->add(*armA);
    root->add(*armB);
    armA->add(*armL);
    armB->add(*hand);
    const std::shared_ptr<Object3D> nodes[] = {root, armA, armL, armB, hand, hand2, outside};
    std::vector<PropertyBinding> bindings;
    for (const auto& [track, size] : tracks)
        bindings.emplace_back(root, track);
    const auto rebind = [&] {
        for (auto& b : bindings)
            b.unbind();
        for (auto& b : bindings)
            b.bind();
    };
    const auto setAll = [&](int step) {
        for (std::size_t i = 0; i < bindings.size(); ++i) {
            double buffer[4] = {};
            for (std::size_t c = 0; c < tracks[i].second; ++c)
                buffer[c] = step * 10 + double(i) + double(c) * 0.25;
            if (i == 4)
                buffer[0] = visible[step];
            bindings[i].setValue(buffer, 0);
        }
    };
    const auto observe = [&](const char* label) {
        std::string out = label;
        for (const auto& o : nodes)
            out += "|" + o->name + ":p=" + join(o->position.toArray()) + ";q=" + join(o->quaternion.toArray()) +
                   ";s=" + join(o->scale.toArray()) + ";v=" + (o->visible() ? "1" : "0") +
                   ";m=" + (o->matrixWorldNeedsUpdate ? "1" : "0");
        for (std::size_t i = 0; i < bindings.size(); ++i) {
            double buffer[4] = {kSentinel, kSentinel, kSentinel, kSentinel};
            bindings[i].getValue(buffer, 0);
            out += "|b" + std::to_string(i) + "=" + join(std::vector<double>(buffer, buffer + tracks[i].second));
        }
        return out;
    };
    std::vector<std::string> steps;
    for (auto& b : bindings)
        b.bind();
    setAll(1);
    steps.push_back(observe("bind"));
    armA->add(*hand);
    setAll(2);
    steps.push_back(observe("reparent-within-root"));
    outside->add(*hand);
    setAll(3);
    steps.push_back(observe("leave-root-still-bound"));
    rebind();
    setAll(4);
    steps.push_back(observe("rebind-outside-root"));
    armB->add(*hand);
    rebind();
    setAll(5);
    steps.push_back(observe("return-and-rebind"));
    armA->add(*hand2);
    rebind();
    setAll(6);
    steps.push_back(observe("shadowing-name-first-in-depth-order"));
    armA->remove(*hand2);
    setAll(7);
    steps.push_back(observe("removed-node-stays-bound"));

    CHECK(steps.size() == std::size(kSteps));
    std::size_t mismatched = 0;
    for (std::size_t s = 0; s < steps.size() && s < std::size(kSteps); ++s) {
        if (steps[s] == kSteps[s])
            continue;
        ++mismatched;
        // Name the first differing field, not two 1 KB strings.
        std::size_t at = 0;
        while (at < steps[s].size() && steps[s][at] == kSteps[s][at])
            ++at;
        const std::size_t from = steps[s].rfind('|', at) + 1;
        std::fprintf(stderr, "step %zu: native %.80s\n        three  %.80s\n", s, steps[s].c_str() + from,
                     kSteps[s] + from);
    }
    std::printf("binding scenario: %zu steps, %zu differ\n", steps.size(), mismatched);
    CHECK(mismatched == 0);
    // Outside three's surface: the paths the engine does not carry yet say so.
    CHECK(bindings[6].diagnostic.rfind("TN_NATIVE_ANIMATION_PATH_UNSUPPORTED", 0) == 0);
    CHECK(bindings[7].diagnostic.rfind("TN_NATIVE_ANIMATION_PATH_UNSUPPORTED", 0) == 0);
}

// A bound node that is released afterwards turns get and set into no-ops: the binding keeps a raw
// pointer for the hot path, so this is the case that would read freed memory if the check went.
void released() {
    auto root = std::make_shared<Object3D>();
    auto hand = std::make_shared<Object3D>();
    hand->name = "hand";
    root->add(*hand);
    PropertyBinding binding(root, "hand.position");
    const double in[3] = {1, 2, 3};
    auto* tracking = Object3D::transformTrackingAddress(&hand->position);
    for (const char* path : {"hand.position", "hand.scale", "hand.scale[x]"}) {
        PropertyBinding transform(root, path);
        tracking[1] = 0;
        transform.setValue(in, 0);
        CHECK(tracking[1] == 1);
    }
    binding.setValue(in, 0);
    CHECK(binding.bound() && hand->position.y == 2);
    root->remove(*hand);
    hand.reset();
    double out[3] = {7, 7, 7};
    binding.setValue(in, 0);
    binding.getValue(out, 0);
    CHECK(out[0] == 7 && out[1] == 7 && out[2] == 7);
    CHECK(binding.targetNode() == nullptr);
}

} // namespace

TN_TEST_MAIN({"parse", parse}, {"binding", binding}, {"released", released})
