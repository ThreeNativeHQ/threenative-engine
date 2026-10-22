#include "check.h"
#include "engine/renderer/shadows/virtual/atlas.h"
#include "engine/shader/standard.h"
#include "engine/shader/package.h"
#include "engine/abi/bindings.h"
#include "engine/scene/geometry.h"
#include "engine/scene/lights.h"

#include <algorithm>
#include <cmath>
#include <limits>

using namespace tn::engine;
using namespace tn::engine::shadows;

// The same registry setter is reached by the Wasm ABI and desktop V8 adapter.
void binding() {
    using namespace tn::binding;
    struct EmptyStore : Store {
        Object* find(const Value&) override { return nullptr; }
        Value adopt(std::string, std::shared_ptr<void>) override { return {}; }
        Value adoptAlias(std::string, void*, void*) override { return {}; }
        Value share(std::string, std::shared_ptr<void>) override { return {}; }
        std::vector<double> numbers(const Value&) override { return {}; }
    } store;
    Registry registry;
    registerMaterialBindings(registry);
    const auto& setters = registry.at("DirectionalLightShadow").setters;
    CHECK(setters.count("shadowNode") == 1);
    if (!setters.count("shadowNode")) return;
    DirectionalLight light;
    light.shadow.bias = -0.002; light.shadow.normalBias = 0.03;
    light.shadow.intensity = 0.7; light.shadow.radius = 1.25;
    const Value options = Value::record({{"clipExtents", Value::list({8, 24})},
        {"mapSize", Value::of(256.0)}, {"lightDistance", Value::of(20.0)}, {"depthRange", Value::of(40.0)}});
    const auto& set = setters.at("shadowNode");
    set(&light.shadow, options, store);
    const auto installed = light.shadow.virtualShadow;
    CHECK(installed != nullptr);
    CHECK(light.shadow.bias == -0.002 && light.shadow.normalBias == 0.03);
    CHECK(light.shadow.intensity == 0.7 && light.shadow.radius == 1.25);
    std::string error;
    auto plan = PageAtlas::create(*installed, error);
    CHECK(plan.has_value());
    CHECK(!plan->update(Vector3(0, 0, 0), Vector3(0, 1, 1)).empty());
    CHECK(!plan->update(Vector3(0, 0, 0), Vector3(0, 1, 1)).empty());
    CHECK(plan->update(Vector3(0, 0, 0), Vector3(0, 1, 1)).empty());
    const auto held = plan->table();
    CHECK(!plan->update(Vector3(100, 0, 0), Vector3(0, 1, 1)).empty());
    CHECK(plan->table() != held);
    auto defaults = options;
    for (const char* key : {"adaptiveRefresh", "adaptiveCasterGate", "followViewFocus", "shadowLodBias"})
        defaults.fields.emplace_back(key, Value::of(true));
    defaults.fields.emplace_back("invalidationDelay", Value::list({0.25, 0.75}));
    defaults.fields.emplace_back("minCasterTexels", Value::of(1.5));
    bool accepted = true;
    try { set(&light.shadow, defaults, store); } catch (const Unsupported&) { accepted = false; }
    CHECK(accepted);
    auto bad = options;
    bad.fields.emplace_back("autoDepth", Value::of(true));
    set(&light.shadow, bad, store);
    CHECK(light.shadow.virtualShadow != installed);
    auto automatic = PageAtlas::create(*light.shadow.virtualShadow, error);
    CHECK(automatic.has_value());
    CHECK(!automatic->update(Vector3(0, 0, 0), Vector3(0, 1, 0)).empty());
    const Value filter = Value::record({{"sourceAngleRad", Value::of(0.01)},
        {"blockerSamples", Value::of(8.0)}, {"filterSamples", Value::of(12.0)}});
    setters.at("filterNode")(&light.shadow, filter, store);
    CHECK(light.shadow.sourceAngleFilter && (*light.shadow.sourceAngleFilter)[0] == 0.01);
    CHECK((*light.shadow.sourceAngleFilter)[1] == 8 && (*light.shadow.sourceAngleFilter)[2] == 12);
    CHECK((*light.shadow.sourceAngleFilter)[3] == 0);  // no floor unless the record names one
    auto floored = filter; floored.fields.emplace_back("minPenumbraPixels", Value::of(1.5));
    setters.at("filterNode")(&light.shadow, floored, store);
    CHECK((*light.shadow.sourceAngleFilter)[3] == 1.5);
    auto stray = filter; stray.fields.emplace_back("minPenumbraPixel", Value::of(1.5));
    bool refusedStray = false;
    try { setters.at("filterNode")(&light.shadow, stray, store); }
    catch (const Unsupported& e) { refusedStray = e.reason == "TN_VIRTUAL_SHADOW_INVALID: source-angle filter"; }
    CHECK(refusedStray && (*light.shadow.sourceAngleFilter)[3] == 1.5);  // an unknown key never passes quietly
    auto negative = filter; negative.fields.emplace_back("minPenumbraPixels", Value::of(-1.0));
    bool refusedNegative = false;
    try { setters.at("filterNode")(&light.shadow, negative, store); }
    catch (const Unsupported&) { refusedNegative = true; }
    CHECK(refusedNegative);
    setters.at("filterNode")(&light.shadow, filter, store);
    CHECK((*light.shadow.sourceAngleFilter)[3] == 0);
    auto invalidFilter = filter; invalidFilter.fields[0].second = Value::of(-0.1);
    bool invalid = false;
    try { setters.at("filterNode")(&light.shadow, invalidFilter, store); }
    catch (const Unsupported& e) { invalid = e.reason == "TN_VIRTUAL_SHADOW_INVALID: source-angle filter"; }
    CHECK(invalid && (*light.shadow.sourceAngleFilter)[0] == 0.01);
    setters.at("filterNode")(&light.shadow, Value{}, store);
    CHECK(!light.shadow.sourceAngleFilter);
    bool refused = false;
    try { setters.at("filterNode")(&light.shadow, Value::of(1.0), store); }
    catch (const Unsupported& e) { refused = e.reason.find("TN_VIRTUAL_SHADOW_UNSUPPORTED: filterNode") == 0; }
    CHECK(refused);
    // The starter's PCF radius (2 texels) is wider than a page border; the source-angle filter
    // replaces that footprint, so installing the node before or after the filter must not refuse.
    light.shadow.radius = 2;
    bool wide = true;
    try { set(&light.shadow, options, store); } catch (const Unsupported&) { wide = false; }
    CHECK(wide);
    // The ground-fitted window ratio crosses the facade; a ratio outside (0, 1] is refused.
    auto fitted = options;
    fitted.fields.emplace_back("minWindowAspect", Value::of(0.2));
    set(&light.shadow, fitted, store);
    CHECK(light.shadow.virtualShadow && light.shadow.virtualShadow->minWindowAspect == 0.2);
    fitted.fields.back().second = Value::of(0.0);
    bool flat = false;
    try { set(&light.shadow, fitted, store); } catch (const Unsupported&) { flat = true; }
    CHECK(flat);
    set(&light.shadow, Value{}, store);
    CHECK(!light.shadow.virtualShadow);
    // The filter without the node is refused whichever was set first, and says the fix.
    DirectionalLight order;
    setters.at("filterNode")(&order.shadow, filter, store);
    const char* refusal = sourceAngleFilterRefusal(order.shadow);
    CHECK(refusal && std::string(refusal).find("TN_VIRTUAL_SHADOW_UNSUPPORTED: sourceAngleShadowFilter requires VirtualShadowNode") == 0);
    CHECK(refusal && std::string(refusal).find("set light.shadow.shadowNode = new VirtualShadowNode(light)") != std::string::npos);
    set(&order.shadow, options, store);
    CHECK(!sourceAngleFilterRefusal(order.shadow));
    DirectionalLight reverse;
    set(&reverse.shadow, options, store);
    setters.at("filterNode")(&reverse.shadow, filter, store);
    CHECK(!sourceAngleFilterRefusal(reverse.shadow));
    set(&reverse.shadow, Value{}, store);
    CHECK(sourceAngleFilterRefusal(reverse.shadow));
    setters.at("filterNode")(&reverse.shadow, Value{}, store);
    CHECK(!sourceAngleFilterRefusal(reverse.shadow));
    // A lamp's filter names the share of the geometric penumbra it keeps; a sun's record never carries one.
    SpotLight lamp;
    const auto& lampSet = registry.at("SpotLightShadow").setters.at("filterNode");
    const Value soft = Value::record({{"sourceRadius", Value::of(0.05)}, {"blockerSamples", Value::of(16.0)},
        {"filterSamples", Value::of(8.0)}, {"penumbraScale", Value::of(0.6)}});
    lampSet(&lamp.shadow, soft, store);
    CHECK(lamp.shadow.sourceRadiusFilter && *lamp.shadow.sourceRadiusFilter == (std::array<double, 4>{0.05, 16, 8, 0.6}));
    for (const double scale : {0.0, -1.0, 4.5, std::nan("")}) {
        auto bad = soft; bad.fields[3].second = Value::of(scale);
        bool refusedScale = false;
        try { lampSet(&lamp.shadow, bad, store); }
        catch (const Unsupported& e) { refusedScale = e.reason == "TN_VIRTUAL_SHADOW_INVALID: source-radius filter"; }
        CHECK(refusedScale && (*lamp.shadow.sourceRadiusFilter)[3] == 0.6);
    }
    auto named = soft; named.fields[3].first = "gain";  // four fields, none of them penumbraScale
    bool unnamed = false;
    try { lampSet(&lamp.shadow, named, store); }
    catch (const Unsupported& e) { unnamed = e.reason == "TN_VIRTUAL_SHADOW_INVALID: source-radius filter"; }
    CHECK(unnamed);
    auto old = Value::record({{"sourceRadius", Value::of(0.05)}, {"blockerSamples", Value::of(16.0)}, {"filterSamples", Value::of(8.0)}});
    bool threeFields = false;
    try { lampSet(&lamp.shadow, old, store); }
    catch (const Unsupported& e) { threeFields = e.reason.find("TN_VIRTUAL_SHADOW_UNSUPPORTED: filterNode") == 0; }
    CHECK(threeFields);
    lampSet(&lamp.shadow, Value{}, store);
    CHECK(!lamp.shadow.sourceRadiusFilter);
    // A caster's chain crosses as its derived geometries and their errors, and reaches the atlas control.
    struct GeometryStore : Store {
        Object object{"BufferGeometry", std::make_shared<BufferGeometry>()};
        bool known = true;
        Object* find(const Value&) override { return known ? &object : nullptr; }
        Value adopt(std::string, std::shared_ptr<void>) override { return {}; }
        Value adoptAlias(std::string, void*, void*) override { return {}; }
        Value share(std::string, std::shared_ptr<void>) override { return {}; }
        std::vector<double> numbers(const Value&) override { return {}; }
    } geometries;
    DirectionalLight chained;
    set(&chained.shadow, options, store);
    const auto lodCommand = [&](std::vector<Value> rungs, std::vector<double> errors) {
        return Value::record({{"command", Value{Value::Kind::String, 0, "lod"}}, {"id", Value::of(7.0)},
            {"geometries", Value::array(std::move(rungs))}, {"errors", Value::list(std::move(errors))}});
    };
    const Value rung{Value::Kind::Ref, 0, "g"};
    set(&chained.shadow, lodCommand({rung, rung}, {0.25, 1.0}), geometries);
    const auto& chains = chained.shadow.virtualShadow->control->lods;
    CHECK(chains.count(7) == 1 && chains.at(7).rungs.size() == 2 && chains.at(7).errors == std::vector<double>({0.25, 1.0}));
    const auto refusesLod = [&](Value command, bool known = true) {
        geometries.known = known;
        bool refused = false;
        try { set(&chained.shadow, command, geometries); }
        catch (const Unsupported& e) { refused = e.reason.find("TN_VIRTUAL_SHADOW_INVALID: lod") == 0; }
        geometries.known = true;
        return refused;
    };
    CHECK(refusesLod(lodCommand({rung, rung}, {0.25})));      // an error for every rung
    CHECK(refusesLod(lodCommand({rung}, {-0.25})));           // and none negative
    CHECK(refusesLod(lodCommand({rung}, {std::nan("")})));    // or unmeasured
    CHECK(refusesLod(lodCommand({}, {})));                    // a chain has a rung
    CHECK(refusesLod(lodCommand({rung}, {0.25}), false));     // that the engine holds
    CHECK(chains.at(7).rungs.size() == 2);                    // a refused chain leaves the held one alone
    // The texel budget of a coarser rung is one unless the node names it, and a positive number (infinity too).
    DirectionalLight budgeted;
    set(&budgeted.shadow, options, store);
    CHECK(budgeted.shadow.virtualShadow->shadowLodTexels == 1);
    auto unbounded = options;
    unbounded.fields.emplace_back("shadowLodTexels", Value::of(std::numeric_limits<double>::infinity()));
    set(&budgeted.shadow, unbounded, store);
    CHECK(std::isinf(budgeted.shadow.virtualShadow->shadowLodTexels));
    for (const double bad : {0.0, -1.0, std::nan("")}) {
        auto refusedBudget = options;
        refusedBudget.fields.emplace_back("shadowLodTexels", Value::of(bad));
        bool refusedBad = false;
        try { set(&budgeted.shadow, refusedBudget, store); }
        catch (const Unsupported& e) { refusedBad = e.reason == "TN_VIRTUAL_SHADOW_INVALID: shadowLodTexels"; }
        CHECK(refusedBad);
    }
    CHECK(std::isinf(budgeted.shadow.virtualShadow->shadowLodTexels));  // a refused budget leaves the node alone
}

// A level draws the coarsest rung one of its texels cannot tell from the full mesh, never one finer than
// the main pass shows, and the mesh's own geometry (rung 0) where no rung is that accurate.
void lodRung() {
    const std::vector<double> errors{0.02, 0.1, 0.5};  // rungs 1 to 3
    CHECK(shadowLodRung(errors, 0, 0.1, 1) == 2);      // 0.1 fits a texel of 0.1, 0.5 does not
    CHECK(shadowLodRung(errors, 0, 0.6, 1) == 3);
    CHECK(shadowLodRung(errors, 0, 0.01, 1) == 0);     // finer than the first rung: the mesh's own
    CHECK(shadowLodRung(errors, 0, 0.1, 2) == 1);      // twice the size, twice the error: 0.2 and 0.04
    CHECK(shadowLodRung(errors, 3, 0.6, 1) == 0);      // the main pass already shows the coarsest
    CHECK(shadowLodRung(errors, 2, 0.1, 1) == 0);      // and a rung that is not coarser than what it shows is no change
    CHECK(shadowLodRung({}, 0, 1, 1) == 0);
}

void policies() {
    std::string error;
    AtlasOptions options;
    options.clipExtents = {8, 24}; options.mapSize = 256; options.pageTexels = 64;
    options.staticAfterFrames = 2;
    options.adaptiveRefresh = true; options.adaptiveCasterGate = true;
    options.minCasterTexels = 1.5;
    auto atlas = PageAtlas::create(options, error);
    CHECK(atlas.has_value()); if (!atlas) return;
    const Vector3 eye(0, 0, 0), sun(0, 1, 0);
    CasterState caster; caster.key = 1;
    caster.bounds.set(Vector3(-1, 0, -1), Vector3(1, 2, 1));
    atlas->updateCasters({caster});
    atlas->update(eye, sun); atlas->update(eye, sun);
    CHECK(atlas->update(eye, sun).empty());
    const double base = atlas->refreshStep(0), gate = atlas->casterGate(0);
    atlas->recordCost(0, 100, 1.0 / 120); atlas->recordCost(0, 100, 1.0 / 120);
    CHECK(atlas->refreshStep(0) == base); // warm-up readings ignored
    atlas->recordCost(0, 100, 1.0 / 120);
    CHECK(atlas->refreshStep(0) > base);
    CHECK(atlas->refreshStep(0) <= 1 - (0.9 - base));
    CHECK(atlas->casterGate(0) > gate);
    CHECK(atlas->casterGate(1) == 1.5 * 48 / 256);
    // Rotation can change a caster while leaving its AABB exactly unchanged.
    caster.world.makeRotationY(0.5);
    atlas->updateCasters({caster});
    CHECK(atlas->isMover(1) && !atlas->drawsStatic(1));
    auto pages = atlas->update(eye, sun);
    CHECK(!pages.empty() && pages.size() < 32); // urgent regional eviction on both levels
    CHECK(std::any_of(pages.begin(), pages.end(), [](const auto& p) { return p.level == 0; }));
    CHECK(std::any_of(pages.begin(), pages.end(), [](const auto& p) { return p.level == 1; }));
    CHECK(atlas->table()[35] == 1 && atlas->table()[71] == 1);
    atlas->appendMoverPages(pages);
    CHECK(std::count_if(pages.begin(), pages.end(), [](const auto& p) { return p.mover; }) == 2);
    CHECK(atlas->table().back() == 1);
    // Deformation renders movers every frame without a new static invalidation.
    caster.deforming = true;
    for (int frame = 0; frame < 4; ++frame) {
        atlas->updateCasters({caster});
        pages = atlas->update(eye, sun);
        CHECK(pages.empty());
        atlas->appendMoverPages(pages);
        CHECK(pages.size() == 2 && pages.front().mover);
    }
    // Settling outside the fine window must wait only for the coarse level which covers it.
    caster.bounds.set(Vector3(18, 0, -1), Vector3(20, 2, 1));
    caster.world.makeTranslation(19, 0, 0);
    atlas->updateCasters({caster});
    atlas->update(eye, sun);
    caster.deforming = false;
    // Unreal's rule: static only after MORE than staticAfterFrames quiet frames (here 2).
    atlas->updateCasters({caster});
    CHECK(!atlas->drawsStatic(1));
    atlas->updateCasters({caster});
    CHECK(!atlas->drawsStatic(1));
    atlas->updateCasters({caster});
    CHECK(atlas->drawsStatic(1) && atlas->isMover(1));
    for (int frame = 0; frame < 120; ++frame) atlas->update(eye, sun);
    CHECK(!atlas->isMover(1));
    // Explicit tracking survives stillness; pinStatic opts out of transform detection.
    caster.tracked = true; atlas->updateCasters({caster});
    CHECK(atlas->isMover(1));
    caster.tracked = false; caster.pinned = true; atlas->updateCasters({caster});
    for (int frame = 0; frame < 120; ++frame) atlas->update(eye, sun);
    caster.world.makeRotationY(1); atlas->updateCasters({caster});
    CHECK(!atlas->isMover(1));
    atlas->updateCasters({});
    CHECK(!atlas->isMover(1));

    options.adaptiveRefresh = false; options.adaptiveCasterGate = false;
    options.invalidationDelay = {0.25, 0.75};
    auto delayed = PageAtlas::create(options, error);
    delayed->update(eye, sun); delayed->update(eye, sun);
    Box3 region; region.set(Vector3(-1, 0, -1), Vector3(1, 2, 1));
    delayed->invalidate(region);
    CHECK(delayed->update(eye, sun).empty());
    std::set<int> redrawn;
    for (int frame = 0; frame < 60; ++frame) {
        pages = delayed->update(eye, sun);
        if (!pages.empty()) redrawn.insert(pages.front().level);
    }
    CHECK(redrawn == std::set<int>({0, 1}));
    CHECK(delayed->update(eye, sun).empty());
    Box3 floor; floor.set(Vector3(-100, -1, -100), Vector3(100, 0, 100));
    const auto focused = PageAtlas::viewFocus(Vector3(0, 30, 0), Vector3(0, -0.6, -0.8), 100, 8, {floor});
    CHECK(focused.distanceTo(Vector3(0, 0, -40)) < 1e-10);
    CHECK(PageAtlas::viewFocus(Vector3(0, 3, 0), Vector3(0, -1, 0), 100, 8, {floor}).y == 3);
    CHECK(PageAtlas::viewFocus(Vector3(0, 30, 0), Vector3(0, 1, 0), 100, 8, {floor}).y == 30);
    options.invalidationDelay = {-1}; CHECK(!PageAtlas::create(options, error));
    options.invalidationDelay = {0}; options.expensiveRefreshShare = 0; CHECK(!PageAtlas::create(options, error));
}

void atlas() {
    binding();
    policies();
    std::string error;
    AtlasOptions options;
    options.clipExtents = {8, 24}; options.mapSize = 256; options.pageTexels = 64;
    options.refreshStep = {0}; options.lightDistance = 20; options.depthRange = 40;
    auto atlas = PageAtlas::create(options, error);
    CHECK(atlas.has_value());
    if (!atlas) return;
    const Vector3 eye(0, 0, 0), sun(0, 1, 1);
    auto pages = atlas->update(eye, sun);
    CHECK(pages.size() == 16);
    CHECK(atlas->table().size() == (18 + 32 + 2) * 4);
    CHECK(atlas->table()[35] == 1 && atlas->table()[71] == 0);
    for (const auto& page : pages) {
        const auto [px, py] = atlas->origin(page.slot);
        CHECK(px + atlas->stride() <= atlas->edge() && py + atlas->stride() <= atlas->edge());
        // Page projection into the padded tile and page-table translation agree at the centre.
        Vector3 center = page.axisU;
        center.multiplyScalar((page.lowU + page.highU) / 2).addScaledVector(page.axisV, (page.lowV + page.highV) / 2);
        center.applyMatrix4(page.view).applyMatrix4(page.projection);
        CHECK(std::abs(center.x) < 1e-12 && std::abs(center.y) < 1e-12);
        const int tableRow = 18 + (3 - page.y) * 4 + page.x;
        CHECK(atlas->table()[tableRow * 4] == px && atlas->table()[tableRow * 4 + 1] == py);
    }
    CHECK(atlas->update(eye, sun).size() == 16); // coarsest warm-up
    CHECK(atlas->update(eye, sun).empty()); // cached
    Box3 changed; changed.set(Vector3(-1, 0, -1), Vector3(1, 2, 1));
    atlas->invalidate(changed);
    CHECK(atlas->update(eye, sun).size() == 4);
    const auto held = atlas->table();
    pages = atlas->update(Vector3(100, 0, 0), sun);
    CHECK(pages.size() == 16 && pages.front().level == 0);
    CHECK(atlas->table()[35] == 1 && atlas->table()[71] == 1);
    // The deferred coarse map keeps its own matrix/window and protected physical pages.
    CHECK(std::equal(held.begin() + 36, held.begin() + 72, atlas->table().begin() + 36));
    CHECK(std::equal(held.begin() + 136, held.begin() + 200, atlas->table().begin() + 136));
    for (const auto& page : pages) {
        const auto [px, py] = atlas->origin(page.slot);
        for (int i = 136; i < 200; i += 4)
            CHECK(atlas->table()[i] != px || atlas->table()[i + 1] != py);
    }
    CHECK(atlas->table()[16] == -100);
    CHECK(atlas->update(Vector3(100, 0, 0), sun).size() == 16);
    CHECK(atlas->update(Vector3(100, 0, 0), sun, true).size() == 16); // explicit rotation cut
    CHECK(atlas->table()[71] == 1);
    CHECK(atlas->update(Vector3(100, 0, 0), sun).size() == 16);
    CHECK(atlas->update(Vector3(100, 0, 0), sun).empty());

    // vsm-cut: two pre-cut renders, then inspect the first post-cut plan without warming it.
    auto cut = PageAtlas::create(options, error), fresh = PageAtlas::create(options, error);
    const Vector3 after(0.5, 5.5, 6.5), before(100.5, 5.5, 6.5), light(-2, 6, 1);
    CHECK(cut->update(before, light).size() == 16);
    CHECK(cut->update(before, light).size() == 16);
    const auto beforeTable = cut->table();
    pages = cut->update(after, light, true);
    const auto first = fresh->update(after, light);
    CHECK(pages.size() == first.size() && pages.front().level == 0);
    CHECK(std::equal(cut->table().begin(), cut->table().begin() + 36, fresh->table().begin()));
    CHECK(std::equal(beforeTable.begin() + 36, beforeTable.begin() + 72, cut->table().begin() + 36));
    for (int i = 0; i < int(pages.size()); ++i) {
        CHECK(pages[i].view.elements == first[i].view.elements);
        CHECK(pages[i].projection.elements == first[i].projection.elements);
    }
    CHECK(cut->update(after, light).size() == 16);
    CHECK(fresh->update(after, light).size() == 16);
    CHECK(std::equal(cut->table().begin(), cut->table().begin() + 72, fresh->table().begin()));
    CHECK(cut->update(after, light).empty());
    // Automatic depth uses only overlapping casters, holds cached/deferred cameras, and refits
    // a changed caster. A wide ground mass contributes its height, not its world diagonal.
    options.autoDepth = true;
    auto fitted = PageAtlas::create(options, error);
    Box3 prop; prop.set(Vector3(-1, 2, -1), Vector3(1, 4, 1));
    Box3 remote; remote.set(Vector3(100, 1000, 100), Vector3(101, 1001, 101));
    const std::vector<Box3> casters{prop, remote};
    auto fitPages = fitted->update(eye, Vector3(0, 1, 0), false, casters);
    CHECK(!fitPages.empty());
    CHECK(std::abs(fitted->table()[31] - std::sqrt(12.0)) < 1e-5);
    for (const auto& point : {prop.min, prop.max}) {
        Vector3 projected = point;
        projected.applyMatrix4(fitPages[0].view).applyMatrix4(fitPages[0].projection);
        CHECK(projected.z >= 0 && projected.z <= 1);
    }
    fitted->update(eye, Vector3(0, 1, 0), false, casters);
    const auto fittedTable = fitted->table();
    CHECK(fitted->update(Vector3(0, 5, 0), Vector3(0, 1, 0), false, casters).empty());
    CHECK(fitted->table() == fittedTable);
    prop.max.y = 14;
    fitted->invalidate(prop);
    CHECK(!fitted->update(eye, Vector3(0, 1, 0), false, {prop}).empty());
    CHECK(fitted->table()[31] > fittedTable[31]);
    Box3 mass; mass.set(Vector3(-1000, -2, -1000), Vector3(1000, 0, 1000));
    fitted->invalidateAll();
    fitPages = fitted->update(eye, Vector3(0, 1, 0), false, {mass});
    CHECK(fitted->table()[fitPages.front().level * 36 + 31] == 2);
    // A sun below the derivation threshold keeps the configured fallback, as the JS node does.
    auto horizon = PageAtlas::create(options, error);
    horizon->update(eye, Vector3(1, 0, 0), false, casters);
    CHECK(horizon->table()[31] == 59);
    options.autoDepth = false;
    options.adaptiveRefresh = true;
    CHECK(PageAtlas::create(options, error).has_value());
    options.adaptiveRefresh = false;
    options.mapSize = 255;
    CHECK(!PageAtlas::create(options, error));
    options.mapSize = 256; options.selectionGuard = {0.1}; options.refreshStep = {0.2};
    CHECK(!PageAtlas::create(options, error));
}

void continuousInvalidation() {
    std::string error;
    AtlasOptions options;
    options.clipExtents = {8, 24, 72}; options.mapSize = 256; options.pageTexels = 64;
    options.refreshStep = {0}; options.lightDistance = 20; options.depthRange = 40;
    auto atlas = PageAtlas::create(options, error);
    CHECK(atlas.has_value());
    if (!atlas) return;
    const int count = int(options.clipExtents.size());
    for (int frame = 0; frame < 2 * count; ++frame) {
        const auto held = atlas->table();
        atlas->invalidateAll();
        const auto pages = atlas->update(Vector3(0, 0, 0), Vector3(0, 1, 1));
        CHECK(pages.size() == 16);
        if (pages.empty()) return;
        CHECK(pages.front().level == frame % count);
        for (const auto& page : pages) CHECK(page.level == pages.front().level);
        // One level per frame, as in the browser: all levels must be resident after count frames.
        for (int level = 0; level < count; ++level) {
            CHECK(atlas->table()[level * 36 + 35] == (frame >= level ? 1 : 0));
            if (!held.empty() && level != pages.front().level)
                CHECK(std::equal(held.begin() + level * 36, held.begin() + (level + 1) * 36,
                                 atlas->table().begin() + level * 36));
        }
    }
}

void sampling() {
    using namespace shader;
    const auto standard = buildStandard({}, {}, {"2"});
    const auto lambert = buildLambert({}, {"2"});
    const auto phong = buildPhong({}, {"2"});
    for (const auto* p : {&standard, &lambert, &phong}) {
        const auto vertex = buildStage(p->vertex, 0), fragment = buildStage(p->fragment, 1);
        CHECK(vertex.wgsl.ok() && fragment.wgsl.ok());
        CHECK(fragment.wgsl.code.find("vsmTable0") != std::string::npos);
        CHECK(fragment.wgsl.code.find("textureSampleCompare") != std::string::npos);
        CHECK(fragment.wgsl.code.find("textureLoad") != std::string::npos);
        CHECK(vertex.wgsl.code.find("positionWorld") != std::string::npos);
    }
}

// A low sun stretches a texel along the light's V axis over 1 / sin(elevation) of floor, so a window
// as high as it is wide would blur every floor shadow edge that many times more than a high sun does.
// With `minWindowAspect` the window's light-space height is sin(elevation) of its width, never less.
void groundWindow() {
    constexpr double kPi = 3.14159265358979323846;
    std::string error;
    AtlasOptions options;
    options.clipExtents = {8, 24}; options.mapSize = 256; options.pageTexels = 64;
    options.refreshStep = {0}; options.lightDistance = 20; options.depthRange = 40;
    options.minWindowAspect = 0.1;
    const double elevation = 15 * kPi / 180, sinEl = std::sin(elevation);
    const Vector3 eye(0, 0, 0), sun(std::cos(elevation), sinEl, 0);
    auto atlas = PageAtlas::create(options, error);
    CHECK(atlas.has_value());
    if (!atlas) return;
    const auto pages = atlas->update(eye, sun);
    CHECK(pages.size() == 16);
    for (const auto& page : pages) {
        // The page camera is `vScale` as high as it is wide: elements 0 and 5 are 2 / width and 2 / height.
        CHECK(std::abs(page.projection.elements[0] / page.projection.elements[5] - sinEl) < 1e-9);
        // It still lands on its own tile: the page centre projects to the middle of its padded viewport.
        Vector3 center = page.axisU;
        center.multiplyScalar((page.lowU + page.highU) / 2).addScaledVector(page.axisV, (page.lowV + page.highV) / 2);
        center.applyMatrix4(page.view).applyMatrix4(page.projection);
        CHECK(std::abs(center.x) < 1e-9 && std::abs(center.y) < 1e-9);
    }
    // The shader's V row is the unit V over the ratio, so its dot product counts pages along the height.
    const auto& table = atlas->table();
    for (int level = 0; level < 2; ++level) {
        const float* row = table.data() + level * 36 + 24;
        CHECK(std::abs(std::sqrt(row[0] * row[0] + row[1] * row[1] + row[2] * row[2]) - 1 / sinEl) < 1e-4);
    }
    // One metre of floor along the sun's azimuth is one page-grid unit, as one metre across it is.
    const auto along = atlas->clipmap().project(Vector3(1, 0, 0)), across = atlas->clipmap().project(Vector3(0, 0, 1));
    CHECK(std::abs(std::abs(along.v) - 1) < 1e-9 && std::abs(std::abs(across.u) - 1) < 1e-9);
    // Under minWindowAspect the height stops shrinking, an overhead sun stays square, and 1 keeps every sun square.
    auto aspectOf = [&](const Vector3& towards, double minimum) {
        auto o = options; o.minWindowAspect = minimum;
        auto a = PageAtlas::create(o, error);
        const auto p = a->update(eye, towards);
        return p.front().projection.elements[0] / p.front().projection.elements[5];
    };
    const double low = 4 * kPi / 180;
    CHECK(std::abs(aspectOf(Vector3(std::cos(low), std::sin(low), 0), 0.25) - 0.25) < 1e-9);
    CHECK(std::abs(aspectOf(Vector3(std::cos(low), std::sin(low), 0), 1) - 1) < 1e-9);
    CHECK(std::abs(aspectOf(Vector3(0.1, 1, 0), 0.25) - 1) < 1e-9);
    options.minWindowAspect = 0;
    CHECK(!PageAtlas::create(options, error));
}

// The mover maps share the square with the static pages: six 3072-texel levels and their 512 mover maps
// fit WebGPU's 8192 texture edge, which a mover column beside the pages (10884 texels) did not.
void packing() {
    std::string error;
    AtlasOptions options;
    options.clipExtents = {1, 2, 4, 8, 16, 32}; options.mapSize = 3072; options.pageTexels = 128;
    options.moverMapSize = 512;
    auto atlas = PageAtlas::create(options, error);
    CHECK(atlas.has_value());
    if (!atlas) return;
    std::printf("packing: atlas edge %d\n", atlas->edge());
    CHECK(atlas->edge() <= 8192);
    const int slots = atlas->tiles() * atlas->tiles() * 6, mover = options.moverMapSize + 2 * options.border;
    int lastStatic = 0;
    for (int slot = 0; slot < slots; ++slot) lastStatic = std::max(lastStatic, atlas->origin(slot).second + atlas->stride());
    for (int l = 0; l < 6; ++l) {
        const auto [x, y] = atlas->moverOrigin(l);
        CHECK(x + mover <= atlas->edge() && y + mover <= atlas->edge());
        CHECK(y >= lastStatic);  // below every static page
        for (int k = 0; k < l; ++k) {
            const auto [ox, oy] = atlas->moverOrigin(k);
            CHECK(x >= ox + mover || ox >= x + mover || y >= oy + mover || oy >= y + mover);
        }
    }
}

TN_TEST_MAIN({"atlas", atlas}, {"packing", packing}, {"continuous_invalidation", continuousInvalidation}, {"sampling", sampling}, {"ground_window", groundWindow}, {"lod_rung", lodRung})
