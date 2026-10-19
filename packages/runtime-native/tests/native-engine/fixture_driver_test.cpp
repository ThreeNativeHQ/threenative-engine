#include "check.h"
#include "fixture/driver.h"
#include "engine/abi/bindings.h"
#include "engine/scene/material.h"
#include "engine/scene/lights.h"

#include <bit>
#include <cinttypes>
#include <cstdio>
#include <memory>
#include <sstream>

using namespace tn::fixture;

namespace {

struct Pair {
    double x = 0;
    double y = 0;
};

std::string hex(double v) {
    char b[24];
    std::snprintf(b, sizeof b, "n:%016" PRIx64, std::bit_cast<uint64_t>(v));
    return b;
}

void protocol() {
    Driver driver;
    ClassBinding pair;
    pair.ctor = [](const Args& a, Store&) {
        auto p = std::make_shared<Pair>();
        if (a.size() == 2) *p = Pair{number(a[0]), number(a[1])};
        return std::static_pointer_cast<void>(p);
    };
    pair.methods["add"] = [](void* self, const Args& a, Store& d) {
        auto& p = *static_cast<Pair*>(self);
        const Pair& o = d.ref<Pair>(a.at(0), "Pair");
        p.x += o.x;
        p.y += o.y;
        return chain();
    };
    pair.methods["length"] = [](void* self, const Args&, Store&) {
        auto& p = *static_cast<Pair*>(self);
        return Value::of(p.x * p.x + p.y * p.y);
    };
    pair.getters["x"] = [](void* self) { return Value::of(static_cast<Pair*>(self)->x); };
    pair.getters["xy"] = [](void* self) { auto& p = *static_cast<Pair*>(self); return Value::list({p.x, p.y}); };
    pair.setters["y"] = [](void* self, const Value& v) { static_cast<Pair*>(self)->y = number(v); };
    driver.classes["Pair"] = pair;

    std::istringstream in(
        "fixture probe\n"
        "new a Pair " + hex(1.5) + " " + hex(-0.0) + "\n"
        "new b Pair " + hex(2) + " " + hex(3) + "\n"
        "call a add c r:b\n"
        "set b y " + hex(10) + "\n"
        "observe 0 c xy - numbers\n"
        "observe 1 a - length number\n"
        "observe 2 b x - number\n"
        "observe 3 b z - number\n"
        "new d Matrix4\n"
        "call a add - r:missing\n"
        "end\n");
    std::ostringstream out;
    CHECK(driver.run(in, out) == 0);
    const std::string want =
        "obs 0 numbers " + hex(3.5) + "," + hex(3) + "\n"
        "obs 1 number " + hex(3.5 * 3.5 + 9) + "\n"
        "obs 2 number " + hex(2) + "\n"
        "unsupported 3 Pair.z\n"
        "unsupported - class%20Matrix4\n"
        "unsupported - argument%20is%20not%20a%20Pair\n";
    CHECK(out.str() == want);
    if (out.str() != want) std::fprintf(stderr, "--- got ---\n%s--- want ---\n%s", out.str().c_str(), want.c_str());
}

void nodeMaterials() {
    Driver driver;
    registerAll(driver.classes);
    for (const char* material : {"MeshBasicMaterial", "MeshLambertMaterial", "MeshPhongMaterial",
                                 "MeshStandardMaterial", "MeshPhysicalMaterial",
                                 "MeshBasicNodeMaterial", "MeshStandardNodeMaterial"}) {
        for (const char* mesh : {"Mesh", "InstancedMesh", "SkinnedMesh"}) {
            std::istringstream in(
                std::string("fixture nodemat\nnew g PlaneGeometry\nnew m ") + material +
                "\nnew replacement MeshStandardNodeMaterial\nnew mesh " + mesh + " r:g r:m " + hex(1) +
                "\ncall mesh material original\nobserve 0 original type - string\n"
                "set mesh material r:replacement\ncall mesh material updated\nobserve 1 updated type - string\n"
                "set mesh material r:g\ncall mesh material unchanged\nobserve 2 unchanged type - string\nend\n");
            std::ostringstream out;
            CHECK(driver.run(in, out) == 0);
            const std::string want = std::string("obs 0 string s:") + material +
                "\nobs 1 string s:MeshStandardNodeMaterial\nunsupported - argument%20is%20not%20a%20Material\n"
                "obs 2 string s:MeshStandardNodeMaterial\n";
            CHECK(out.str() == want);
            if (out.str() != want) std::fprintf(stderr, "%s/%s got:\n%s", mesh, material, out.str().c_str());
            const Value ref{Value::Kind::Ref, 0, "m"};
            CHECK(driver.shared<tn::engine::Material>(ref, "Material").get() == driver.find(ref)->ptr.get());
            CHECK(&driver.ref<tn::engine::Material>(ref, "Material") == driver.find(ref)->ptr.get());
        }
    }
}

void lightTargets() {
    Driver driver;
    registerAll(driver.classes);
    std::istringstream in("new sun DirectionalLight\ncall sun target original\nnew aim Group\n"
                          "set aim position.x " + hex(2) + "\nset sun target r:aim\n"
                          "call sun target assigned\nobserve 0 assigned position.x - number\n"
                          "observe 1 original position.x - number\nset sun target " + hex(1) + "\nend\n");
    std::ostringstream out;
    CHECK(driver.run(in, out) == 0);
    CHECK(out.str() == "obs 0 number " + hex(2) + "\nobs 1 number " + hex(0) +
                       "\nunsupported - argument%20is%20not%20an%20Object3D\n");
    const Value aim{Value::Kind::Ref, 0, "aim"};
    const Value sun{Value::Kind::Ref, 0, "sun"};
    CHECK(driver.ref<tn::engine::DirectionalLight>(sun, "DirectionalLight").target.get() == driver.find(aim)->ptr.get());
}

void probeFailures() {
    for (const char* reason : {"TN_FIXTURE_PROBES_NO_IRRADIANCE", "TN_FIXTURE_PROBES_BAKED_RECAPTURE",
                               "TN_FIXTURE_PROBES_STALE_FRAME: 123"}) {
        Driver driver;
        registerAll(driver.classes);
        driver.render = [reason](Object&, Object&, const RenderRequest&) { return std::string(reason); };
        std::istringstream in("new scene Scene\nnew camera PerspectiveCamera\nrender scene camera 320 240 aces " +
                              hex(1) + " srgb s:unused.png\nobserve 0 scene - - pixels\nend\n");
        std::ostringstream out;
        CHECK(driver.run(in, out) == 0);
        CHECK(out.str().starts_with("error TN_FIXTURE_PROBES_"));
    }
}

}  // namespace

TN_TEST_MAIN({"protocol", protocol}, {"probe_failures", probeFailures}, {"node_materials", nodeMaterials}, {"light_targets", lightTargets})
