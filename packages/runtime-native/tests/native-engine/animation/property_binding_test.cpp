// PRD-516 phase 1: property-path binding against the pinned three. parseTrackName answers three's
// own test names and the edge cases exactly; the binding scenario (bind, reparent inside the root,
// leave the root, rebind, a shadowing name, a removed node) runs here step for step as the
// generator ran it on three, and each step's node transforms and binding reads must be three's bits.
#include "check.h"
#include "engine/animation/property_binding.h"

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

void binding() {
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
