// PRD-519 phase 2: frozen static subtrees against packages/core/src/static-transform.ts. The same
// script runs on the native scene graph: freeze, a deep write nobody announces (the subtree keeps
// its matrices), an invalidate from a grandchild, a moved root that refresh re-arms, a forced
// updateMatrixWorld while frozen, a game-owned matrixAutoUpdate the freeze must not take over,
// unmark, census and reset. After every step each node's local and world matrix, its update flags,
// isStatic and the census must be three's, bit for bit.
#include "check.h"
#include "engine/scene/static_transform.h"

#include <bit>
#include <cinttypes>
#include <cstdio>
#include <iterator>
#include <memory>
#include <string>
#include <vector>

#include "static_transform_reference.inc"

using namespace tn::engine;

namespace {

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

void staticTransform() {
    const auto named = [](const char* name) {
        auto object = std::make_shared<Object3D>();
        object->name = name;
        return object;
    };
    auto scene = named("scene"), a = named("a"), b = named("b"), c = named("c"), d = named("d"), e = named("e"),
         f = named("f");
    scene->add(*a);
    scene->add(*d);
    scene->add(*f);
    a->add(*b);
    b->add(*c);
    d->add(*e);
    a->position.set(1, 2, 3);
    a->rotation.set(0.3, 0.2, 0.1);
    a->scale.set(2, 1, 0.5);
    b->position.set(0, 1, 0);
    b->rotation.set(0, 0.7, 0);
    c->position.set(0.5, 0, -1);
    d->position.set(-4, 0, 0);
    e->position.set(0, 0, 2);
    f->position.set(0, -3, 0);
    const std::shared_ptr<Object3D> nodes[] = {scene, a, b, c, d, e, f};

    StaticTransforms statics;
    std::vector<std::string> steps;
    const auto flag = [](bool x) { return x ? "1" : "0"; };
    const auto observe = [&](const char* label, const std::string& result) {
        const StaticTransforms::Census census = statics.census();
        std::string out = std::string(label) + "|r=" + result;
        for (const auto& o : nodes)
            out += "|" + o->name + ":m=" + join(o->matrix.elements) + ";w=" + join(o->matrixWorld.elements) +
                   ";au=" + flag(o->matrixAutoUpdate) + ";wau=" + flag(o->matrixWorldAutoUpdate) +
                   ";wnu=" + flag(o->matrixWorldNeedsUpdate) + ";s=" + flag(statics.isStatic(*o));
        out += "|census=" + std::to_string(census.roots) + "," + std::to_string(census.objects) + "," +
               std::to_string(census.rearmed);
        steps.push_back(out);
    };
    const auto version = [](std::optional<uint32_t> v) { return v ? std::to_string(*v) : std::string("undefined"); };

    scene->updateMatrixWorld();
    observe("initial", "-");
    observe("mark-a", std::to_string(statics.mark(*a)));
    b->position.x += 1;
    scene->updateMatrixWorld();
    observe("deep-write-unannounced", "-");
    const auto v = statics.invalidate(*c);
    scene->updateMatrixWorld();
    observe("invalidate-from-grandchild", version(v));
    a->position.y += 0.5;
    statics.refresh();
    scene->updateMatrixWorld();
    observe("root-moved-refresh", "-");
    statics.refresh();
    observe("refresh-still", "-");
    a->position.z = 9;
    scene->updateMatrixWorld(true);
    observe("forced-walk-while-frozen", "-");
    e->matrixAutoUpdate = false;
    observe("mark-d", std::to_string(statics.mark(*d)));
    observe("mark-d-again", std::to_string(statics.mark(*d)));
    statics.unmark(*d);
    scene->updateMatrixWorld();
    observe("unmark-d", "-");
    observe("invalidate-outside", version(statics.invalidate(*f)));
    statics.unmark(*a);
    scene->updateMatrixWorld();
    observe("unmark-a", "-");
    statics.mark(*a);
    statics.reset();
    observe("reset", "-");

    std::size_t mismatched = steps.size() == std::size(kSteps) ? 0 : 1;
    for (std::size_t s = 0; s < steps.size() && s < std::size(kSteps); ++s) {
        if (steps[s] == kSteps[s])
            continue;
        ++mismatched;
        std::size_t at = 0;
        while (at < steps[s].size() && steps[s][at] == kSteps[s][at])
            ++at;
        const std::size_t from = steps[s].rfind('|', at) + 1;
        std::fprintf(stderr, "step %zu: native %.90s\n        three  %.90s\n", s, steps[s].c_str() + from,
                     kSteps[s] + from);
    }
    std::printf("static transform: %zu steps, %zu differ\n", steps.size(), mismatched);
    CHECK(mismatched == 0);
}

} // namespace

TN_TEST_MAIN({"static_transform", staticTransform})
