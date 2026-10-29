#include "check.h"
#include "threenative/abi/tn_abi.h"
#include "threenative/abi/tn_tsl.h"
#include "engine/abi/abi_internal.h"
#include "engine/shader/graph/graph.h"
#include "engine/shader/tsl/tsl.h"
#include "engine/abi/pooled_shared.h"
#include "engine/abi/bindings.h"
#include "engine/abi/tsl_call.h"
#include "engine/shader/graph/post_effects.h"
#include "engine/shader/graph/serialized.h"
#include "engine/shader/output.h"
#include "engine/shader/sprite.h"
#include "engine/shader/package.h"
#include "engine/animation/mixer.h"
#include "engine/animation/skinning/skeleton.h"
#include "engine/scene/object3d.h"
#include "engine/scene/texture.h"
#include "engine/scene/render_target.h"
#include "engine/scene/nodes.h"
#include "engine/scene/lights.h"
#include "engine/scene/camera.h"
#include "engine/scene/geometry.h"
#include "engine/scene/projected_cull.h"

#include <algorithm>
#include <fstream>
#include <cstdlib>
#include <cmath>
#include <limits>
#include <cstring>
#include <map>

#include <cstdio>
#include <cstring>
#include <string>
#include <stdexcept>

namespace tn::binding {
// How many times the matrix walk's node count was recounted (bindings_scene.cpp).
}  // namespace tn::binding

extern "C" uintptr_t tnw_attribute_view(const tn_handle_t* attribute, uint64_t* out);
extern "C" void tnw_attribute_view_release(uintptr_t lease);
extern "C" uintptr_t tnw_attribute_defer(const tn_handle_t* attribute, uintptr_t pull, uintptr_t forget);

namespace {

struct Diag {
    tn_diagnostic_t value{nullptr, 0};
    ~Diag() { tn_diagnostic_release(&value); }
    std::string message() const { return value.message ? value.message : ""; }
};

void version() {
    const tn_version_info_t own = tn_engine_version();
    {
        Diag d;
        tn_version_info_t engine{};
        CHECK(tn_version_handshake(&own, &engine, &d.value) == TN_OK);
        CHECK(std::memcmp(&engine, &own, sizeof own) == 0);
        CHECK(d.value.message == nullptr);
    }
    struct Case {
        void (*mutate)(tn_version_info_t&);
        uint32_t code;
        const char* name;
    };
    const Case cases[] = {
        {[](tn_version_info_t& v) { v.engine_abi += 1; }, TN_DIAG_ENGINE_ABI_MISMATCH, "TN_DIAG_ENGINE_ABI_MISMATCH"},
        {[](tn_version_info_t& v) { v.compatibility_contract += 1; }, TN_DIAG_CONTRACT_MISMATCH, "TN_DIAG_CONTRACT_MISMATCH"},
        {[](tn_version_info_t& v) { v.scene += 1; }, TN_DIAG_SCENE_MISMATCH, "TN_DIAG_SCENE_MISMATCH"},
        {[](tn_version_info_t& v) { v.shader_package += 1; }, TN_DIAG_SHADER_PACKAGE_MISMATCH, "TN_DIAG_SHADER_PACKAGE_MISMATCH"},
        {[](tn_version_info_t& v) { v.capability_digest ^= 1; }, TN_DIAG_CAPABILITY_MISMATCH, "TN_DIAG_CAPABILITY_MISMATCH"},
        {[](tn_version_info_t& v) { v.capability_count += 1; }, TN_DIAG_CAPABILITY_MISMATCH, "TN_DIAG_CAPABILITY_MISMATCH"},
        // Two fields differ: the first in the documented order is the one named.
        {[](tn_version_info_t& v) { v.scene += 1; v.engine_abi += 1; }, TN_DIAG_ENGINE_ABI_MISMATCH, "TN_DIAG_ENGINE_ABI_MISMATCH"},
    };
    for (const Case& c : cases) {
        tn_version_info_t module = own;
        c.mutate(module);
        Diag d;
        CHECK(tn_version_handshake(&module, nullptr, &d.value) == TN_ERROR_VERSION_MISMATCH);
        CHECK(d.value.code == c.code);
        CHECK(d.message().rfind(c.name, 0) == 0);
        // Rejected before start: no context exists for a mismatched module.
        tn_context_t* context = reinterpret_cast<tn_context_t*>(1);
        Diag d2;
        CHECK(tn_context_create(&context, &module, &d2.value) == TN_ERROR_VERSION_MISMATCH);
        CHECK(context == nullptr);
        CHECK(d2.value.code == c.code);
    }
}

void handles() {
    const tn_version_info_t own = tn_engine_version();
    tn_context_t* a = nullptr;
    tn_context_t* b = nullptr;
    Diag d;
    CHECK(tn_context_create(&a, &own, &d.value) == TN_OK);
    CHECK(tn_context_create(&b, &own, &d.value) == TN_OK);
    CHECK(tn_type_id("Mesh") != 0);
    CHECK(tn_type_id("Mesh") != tn_type_id("Scene"));
    CHECK(tn_type_id("NotAThreeClass") == 0);
    CHECK(tn_type_id(nullptr) == 0);

    tn_handle_t mesh{};
    CHECK(tn_object_create(a, tn_type_id("Mesh"), &mesh, &d.value) == TN_OK);
    tn_handle_t forged = mesh;
    forged.type = tn_type_id("Scene");
    CHECK(tn_object_release(forged, &d.value) == TN_ERROR_WRONG_TYPE);
    tn_handle_t foreign = mesh;
    foreign.context = 999;
    CHECK(tn_object_release(foreign, &d.value) == TN_ERROR_INVALID_HANDLE);
    tn_handle_t outOfRange = mesh;
    outOfRange.index = 1u << 30;
    CHECK(tn_object_release(outOfRange, &d.value) == TN_ERROR_INVALID_HANDLE);
    CHECK(tn_object_release(mesh, &d.value) == TN_OK);
    CHECK(tn_object_release(mesh, &d.value) == TN_ERROR_STALE_HANDLE);   // stale generation
    tn_handle_t again{};
    CHECK(tn_object_create(a, tn_type_id("Mesh"), &again, &d.value) == TN_OK);
    CHECK(again.index == mesh.index && again.generation != mesh.generation);
    CHECK(tn_object_release(mesh, &d.value) == TN_ERROR_STALE_HANDLE);   // the old handle never reaches the new object
    CHECK(tn_object_create(a, 0, &again, &d.value) == TN_ERROR_WRONG_TYPE);
    CHECK(tn_object_create(a, 0xffff, &again, &d.value) == TN_ERROR_WRONG_TYPE);

    tn_handle_t inB{};
    CHECK(tn_object_create(b, tn_type_id("Scene"), &inB, &d.value) == TN_OK);
    CHECK(tn_context_destroy(b, &d.value) == TN_OK);
    CHECK(tn_object_release(inB, &d.value) == TN_ERROR_INVALID_HANDLE);   // its context is gone
    CHECK(tn_context_destroy(b, &d.value) == TN_ERROR_INVALID_STATE);     // destroyed twice: refused, not touched
    CHECK(tn_object_create(b, tn_type_id("Mesh"), &inB, &d.value) == TN_ERROR_INVALID_STATE);
    CHECK(tn_context_destroy(a, &d.value) == TN_OK);
    tn_diagnostic_t zero{nullptr, 0};
    tn_diagnostic_release(&zero);
    tn_diagnostic_release(nullptr);
}

tn_value_t num(double n) {
    tn_value_t v{};
    v.kind = TN_VALUE_NUMBER;
    v.number = n;
    return v;
}
tn_value_t ref(tn_handle_t h) {
    tn_value_t v{};
    v.kind = TN_VALUE_HANDLE;
    v.handle = h;
    return v;
}
tn_value_t boolean(bool b) {
    tn_value_t v{};
    v.kind = TN_VALUE_BOOL;
    v.boolean = b ? 1 : 0;
    return v;
}
std::string text(const tn_value_t& v) { return std::string(v.text, v.count); }
bool same(tn_handle_t a, tn_handle_t b) { return a.type == b.type && a.index == b.index && a.generation == b.generation; }

// The generic calls drive the same registry the differential fixtures prove.
void generic() {
    const tn_version_info_t own = tn_engine_version();
    tn_context_t* ctx = nullptr;
    Diag d;
    CHECK(tn_context_create(&ctx, &own, &d.value) == TN_OK);

    const tn_value_t xyz[3] = {num(1), num(2), num(3)};
    tn_handle_t v{};
    CHECK(tn_construct(ctx, "Vector3", xyz, 3, &v, &d.value) == TN_OK);
    CHECK(v.type == tn_type_id("Vector3"));

    tn_handle_t m{};
    CHECK(tn_construct(ctx, "Matrix4", nullptr, 0, &m, &d.value) == TN_OK);
    tn_value_t result{};
    const tn_value_t offset[3] = {num(10), num(0), num(-5)};
    CHECK(tn_invoke(m, "makeTranslation", offset, 3, &result, &d.value) == TN_OK);
    CHECK(result.kind == TN_VALUE_HANDLE && same(result.handle, m));         // chaining returns self

    const tn_value_t byMatrix[1] = {ref(m)};
    CHECK(tn_invoke(v, "applyMatrix4", byMatrix, 1, &result, &d.value) == TN_OK);
    CHECK(tn_get(v, "x", &result, &d.value) == TN_OK);
    CHECK(result.kind == TN_VALUE_NUMBER && result.number == 11);
    CHECK(tn_get(v, "z", &result, &d.value) == TN_OK && result.number == -2);

    const tn_value_t seven = num(7);
    CHECK(tn_set(v, "y", &seven, &d.value) == TN_OK);
    CHECK(tn_get(v, "y", &result, &d.value) == TN_OK && result.number == 7);

    CHECK(tn_get(m, "elements", &result, &d.value) == TN_OK);
    CHECK(result.kind == TN_VALUE_NUMBERS && result.count == 16 && result.numbers[12] == 10);

    CHECK(tn_invoke(v, "clone", nullptr, 0, &result, &d.value) == TN_OK);  // a new object, a new handle
    CHECK(result.kind == TN_VALUE_HANDLE && !same(result.handle, v));
    tn_value_t copyX{};
    CHECK(tn_get(result.handle, "x", &copyX, &d.value) == TN_OK && copyX.number == 11);

    // Restating a texture field is no change. The shooter's sky restates its mapping and colour space
    // on every enter; each one moved the version, which retired the retained environment bake, and a
    // restart on SwiftShader waited 15 s to bake an unchanged sky again.
    {
        tn_handle_t texture{};
        CHECK(tn_construct(ctx, "Texture", nullptr, 0, &texture, &d.value) == TN_OK);
        auto version = [&] {
            tn_value_t out{};
            CHECK(tn_get(texture, "version", &out, &d.value) == TN_OK);
            return out.number;
        };
        tn_value_t value{};
        const double before = version();
        for (const char* field : {"mapping", "wrapS", "minFilter", "rotation", "repeat.x", "flipY"}) {
            CHECK(tn_get(texture, field, &value, &d.value) == TN_OK);
            CHECK(tn_set(texture, field, &value, &d.value) == TN_OK);
        }
        tn_value_t space{};
        CHECK(tn_get(texture, "colorSpace", &space, &d.value) == TN_OK);
        const std::string restated = text(space);
        tn_value_t same_space{};
        same_space.kind = TN_VALUE_STRING;
        same_space.text = restated.c_str();
        same_space.count = restated.size();
        CHECK(tn_set(texture, "colorSpace", &same_space, &d.value) == TN_OK);
        CHECK(version() == before);
        const tn_value_t reflection = num(303);  // EquirectangularReflectionMapping: a real change
        CHECK(tn_set(texture, "mapping", &reflection, &d.value) == TN_OK);
        CHECK(version() == before + 1);
    }

    // Particle culling passes the camera's live projection conventions into Frustum.
    for (const char* cls : {"Camera", "PerspectiveCamera", "OrthographicCamera"}) {
        tn_handle_t camera{};
        CHECK(tn_construct(ctx, cls, nullptr, 0, &camera, &d.value) == TN_OK);
        CHECK(tn_get(camera, "coordinateSystem", &result, &d.value) == TN_OK && result.number == 2000);
        CHECK(tn_get(camera, "reversedDepth", &result, &d.value) == TN_OK && result.kind == TN_VALUE_BOOL && !result.boolean);
        const tn_value_t gpu = num(2001);
        CHECK(tn_set(camera, "coordinateSystem", &gpu, &d.value) == TN_OK);
        CHECK(tn_get(camera, "coordinateSystem", &result, &d.value) == TN_OK && result.number == 2001);
        CHECK(tn_set(camera, "reversedDepth", &gpu, &d.value) == TN_ERROR_UNSUPPORTED);
        const tn_value_t invalid = num(2000.5);
        CHECK(tn_set(camera, "coordinateSystem", &invalid, &d.value) == TN_ERROR_UNSUPPORTED);
        CHECK(tn_get(camera, "coordinateSystem", &result, &d.value) == TN_OK && result.number == 2001);
        if (std::string(cls) != "PerspectiveCamera") continue;
        tn_handle_t frustum{};
        CHECK(tn_construct(ctx, "Frustum", nullptr, 0, &frustum, &d.value) == TN_OK);
        for (const auto system : {2000, 2001}) {
            const tn_value_t convention = num(system);
            CHECK(tn_set(camera, "coordinateSystem", &convention, &d.value) == TN_OK);
            for (const bool reversed : {false, true}) {
                // The renderer owns reversedDepth; the public Camera property is read-only.
                static_cast<tn::engine::Camera*>(tn::abi::objectOf(camera)->ptr.get())->setReversedDepth(reversed);
                CHECK(tn_invoke(camera, "updateProjectionMatrix", nullptr, 0, &result, &d.value) == TN_OK);
                tn_value_t args[3]{};
                CHECK(tn_get(camera, "projectionMatrix", &args[0], &d.value) == TN_OK);
                CHECK(tn_get(camera, "coordinateSystem", &args[1], &d.value) == TN_OK);
                CHECK(tn_get(camera, "reversedDepth", &args[2], &d.value) == TN_OK);
                CHECK(tn_invoke(frustum, "setFromProjectionMatrix", args, 3, &result, &d.value) == TN_OK);
                for (const double z : {-0.05, -0.2, -3000.0}) {
                    const tn_value_t depth = num(z);
                    CHECK(tn_set(v, "x", &offset[1], &d.value) == TN_OK);
                    CHECK(tn_set(v, "y", &offset[1], &d.value) == TN_OK);
                    CHECK(tn_set(v, "z", &depth, &d.value) == TN_OK);
                    const tn_value_t point = ref(v);
                    CHECK(tn_invoke(frustum, "containsPoint", &point, 1, &result, &d.value) == TN_OK);
                    CHECK(result.kind == TN_VALUE_BOOL && bool(result.boolean) == (z == -0.2));
                }
            }
        }
    }

    // Refusals are statuses with named reasons, never a crash or an exception across the ABI.
    CHECK(tn_invoke(v, "teleport", nullptr, 0, &result, &d.value) == TN_ERROR_UNSUPPORTED);
    CHECK(d.message().find("Vector3.teleport()") != std::string::npos);
    CHECK(tn_invoke(v, "applyMatrix4", nullptr, 0, &result, &d.value) == TN_ERROR_INVALID_ARGUMENT);
    const tn_value_t wrong[1] = {ref(v)};
    CHECK(tn_invoke(v, "applyMatrix4", wrong, 1, &result, &d.value) == TN_ERROR_UNSUPPORTED);  // a Vector3, not a Matrix4
    CHECK(tn_construct(ctx, "Spaceship", nullptr, 0, &v, &d.value) == TN_ERROR_UNSUPPORTED);

    tn_handle_t gone{};
    CHECK(tn_construct(ctx, "Vector3", nullptr, 0, &gone, &d.value) == TN_OK);
    CHECK(tn_object_release(gone, &d.value) == TN_OK);
    CHECK(tn_get(gone, "x", &result, &d.value) == TN_ERROR_INVALID_HANDLE);
    CHECK(tn_context_destroy(ctx, &d.value) == TN_OK);
}

// PRD-508: the scene graph over the same generic calls, and the member alias a caller reads back as
// one object rather than a copy per read.
void scene() {
    const tn_version_info_t own = tn_engine_version();
    tn_context_t* ctx = nullptr;
    Diag d;
    CHECK(tn_context_create(&ctx, &own, &d.value) == TN_OK);

    tn_handle_t parent{};
    tn_handle_t child{};
    CHECK(tn_construct(ctx, "Object3D", nullptr, 0, &parent, &d.value) == TN_OK);
    CHECK(tn_construct(ctx, "Object3D", nullptr, 0, &child, &d.value) == TN_OK);

    const tn_value_t offset[3] = {num(1), num(2), num(3)};
    CHECK(tn_set(parent, "position.x", &offset[0], &d.value) == TN_OK);
    CHECK(tn_set(parent, "position.y", &offset[1], &d.value) == TN_OK);
    CHECK(tn_set(parent, "position.z", &offset[2], &d.value) == TN_OK);
    const tn_value_t two = num(2);
    CHECK(tn_set(child, "position.y", &two, &d.value) == TN_OK);

    tn_value_t result{};
    CHECK(tn_invoke(parent, "add", nullptr, 0, &result, &d.value) == TN_ERROR_INVALID_ARGUMENT);
    const tn_value_t childRef = ref(child);
    CHECK(tn_invoke(parent, "add", &childRef, 1, &result, &d.value) == TN_OK);
    CHECK(result.kind == TN_VALUE_HANDLE && same(result.handle, parent));

    const tn_value_t force = num(1);
    CHECK(tn_invoke(parent, "updateMatrixWorld", &force, 1, &result, &d.value) == TN_OK);
    CHECK(tn_get(child, "matrixWorld.elements", &result, &d.value) == TN_OK);
    CHECK(result.kind == TN_VALUE_NUMBERS && result.count == 16);
    CHECK(result.numbers[12] == 1 && result.numbers[13] == 4 && result.numbers[14] == 3);

    tn_handle_t deferredRoot{}, deferredChild{};
    CHECK(tn_construct(ctx, "Bone", nullptr, 0, &deferredRoot, &d.value) == TN_OK);
    CHECK(tn_construct(ctx, "Object3D", nullptr, 0, &deferredChild, &d.value) == TN_OK);
    auto deferredBone = std::static_pointer_cast<tn::engine::Bone>(tn::abi::objectOf(deferredRoot)->ptr);
    auto* band = static_cast<tn::engine::Object3D*>(tn::abi::objectOf(deferredChild)->ptr.get());
    band->position.set(1, 0, 0); deferredBone->add(*band); deferredBone->updateMatrixWorld(true);
    deferredBone->enableTrackedTransform(); CHECK(deferredBone->enableDeferredTransform());
    tn::engine::animation::PropertyBinding deferredBinding(deferredBone, ".position");
    const double pose[] = {7, 8, 9}; deferredBinding.setValue(pose, 0);
    tn::engine::Vector3 joined; deferredBone->getWorldPosition(joined);
    CHECK(tn_get(deferredChild, "matrixWorld.elements", &result, &d.value) == TN_OK);
    CHECK(result.kind == TN_VALUE_NUMBERS && result.numbers[12] == 8);
    const double nextPose[] = {11, 12, 13}; deferredBinding.setValue(nextPose, 0);
    CHECK(tn_get(deferredRoot, "matrixWorld.elements", &result, &d.value) == TN_OK);
    CHECK(result.kind == TN_VALUE_NUMBERS && result.numbers[12] == 11);

    // `mesh.position` is the member, not a copy: the same handle every time, and a write through it
    // is the object's own write.
    tn_value_t first{};
    tn_value_t second{};
    CHECK(tn_get(child, "position", &first, &d.value) == TN_OK);
    CHECK(tn_get(child, "position", &second, &d.value) == TN_OK);
    CHECK(first.kind == TN_VALUE_HANDLE && same(first.handle, second.handle));
    const tn_value_t forty = num(40);
    CHECK(tn_set(first.handle, "y", &forty, &d.value) == TN_OK);
    CHECK(tn_get(child, "position.y", &result, &d.value) == TN_OK);
    CHECK(result.number == 40);

    // The alias keeps the object alive, so releasing the object first does not dangle the alias.
    CHECK(tn_object_release(child, &d.value) == TN_OK);
    CHECK(tn_get(first.handle, "y", &result, &d.value) == TN_OK && result.number == 40);

    // PRD-514: Scene.background is a typed Color member; null clears it.
    tn_handle_t stage{};
    tn_handle_t background{};
    CHECK(tn_construct(ctx, "Scene", nullptr, 0, &stage, &d.value) == TN_OK);
    const tn_value_t bg[3] = {num(0.05), num(0.06), num(0.08)};
    CHECK(tn_construct(ctx, "Color", bg, 3, &background, &d.value) == TN_OK);
    const tn_value_t bgRef = ref(background);
    CHECK(tn_set(stage, "background", &bgRef, &d.value) == TN_OK);
    tn_value_t alias{};
    CHECK(tn_get(stage, "background", &alias, &d.value) == TN_OK && alias.kind == TN_VALUE_HANDLE);
    CHECK(tn_get(alias.handle, "g", &result, &d.value) == TN_OK && result.number == 0.06);
    const tn_value_t empty{};
    CHECK(tn_set(stage, "background", &empty, &d.value) == TN_OK);
    CHECK(tn_get(stage, "background", &result, &d.value) == TN_OK && result.kind == TN_VALUE_NULL);
    CHECK(tn_object_release(background, &d.value) == TN_OK);
    CHECK(tn_object_release(stage, &d.value) == TN_OK);

    CHECK(tn_context_destroy(ctx, &d.value) == TN_OK);
}

// PRD-508 phase 3: a catalogued class whose registry lacks a member refuses it by name, so an
// uncatalogued method is a status a caller can read, never a crash.
void unsupported_member() {
    const tn_version_info_t own = tn_engine_version();
    tn_context_t* ctx = nullptr;
    Diag d;
    CHECK(tn_context_create(&ctx, &own, &d.value) == TN_OK);

    tn_handle_t geometry{};
    CHECK(tn_construct(ctx, "BufferGeometry", nullptr, 0, &geometry, &d.value) == TN_OK);
    tn_value_t result{};
    CHECK(tn_invoke(geometry, "computeBoundingVolume", nullptr, 0, &result, &d.value) == TN_ERROR_UNSUPPORTED);
    CHECK(d.message().find("TN_NATIVE_UNSUPPORTED") != std::string::npos);
    CHECK(d.message().find("BufferGeometry.computeBoundingVolume()") != std::string::npos);
    CHECK(tn_get(geometry, "attributes.tangent.array", &result, &d.value) == TN_ERROR_UNSUPPORTED);
    CHECK(d.message().find("TN_NATIVE_UNSUPPORTED") != std::string::npos);
    CHECK(tn_object_release(geometry, &d.value) == TN_OK);
    CHECK(tn_context_destroy(ctx, &d.value) == TN_OK);
}

// PRD-514: the material classes over the generic calls. A whole-color write reaches the Store, and
// the Color member is one alias Ref, as the fixture driver proves too.
void material() {
    const tn_version_info_t own = tn_engine_version();
    tn_context_t* ctx = nullptr;
    Diag d;
    CHECK(tn_context_create(&ctx, &own, &d.value) == TN_OK);

    tn_handle_t basic{};
    CHECK(tn_construct(ctx, "MeshBasicMaterial", nullptr, 0, &basic, &d.value) == TN_OK);
    tn_value_t result{};
    CHECK(tn_get(basic, "type", &result, &d.value) == TN_OK);
    CHECK(result.kind == TN_VALUE_STRING && text(result) == "MeshBasicMaterial");
    CHECK(tn_get(basic, "transparent", &result, &d.value) == TN_OK && result.boolean == 0);
    CHECK(tn_get(basic, "opacity", &result, &d.value) == TN_OK && result.number == 1);

    // A parameters object is out of scope; the no-argument constructor is the only one.
    const tn_value_t one = num(1);
    tn_handle_t refused{};
    CHECK(tn_construct(ctx, "MeshBasicMaterial", &one, 1, &refused, &d.value) == TN_ERROR_UNSUPPORTED);
    CHECK(d.message().find("TN_NATIVE_UNSUPPORTED") != std::string::npos);

    // `material.color = ref` copies through the Store; the member reads back as one alias Ref.
    tn_handle_t paint{};
    const tn_value_t rgb[3] = {num(0.2), num(0.4), num(0.6)};
    CHECK(tn_construct(ctx, "Color", rgb, 3, &paint, &d.value) == TN_OK);
    const tn_value_t paintRef = ref(paint);
    CHECK(tn_set(basic, "color", &paintRef, &d.value) == TN_OK);
    CHECK(tn_get(basic, "color.g", &result, &d.value) == TN_OK && result.number == 0.4);

    tn_value_t first{};
    tn_value_t second{};
    CHECK(tn_get(basic, "color", &first, &d.value) == TN_OK);
    CHECK(tn_get(basic, "color", &second, &d.value) == TN_OK);
    CHECK(first.kind == TN_VALUE_HANDLE && same(first.handle, second.handle));
    const tn_value_t nine = num(0.9);
    CHECK(tn_set(first.handle, "r", &nine, &d.value) == TN_OK);
    CHECK(tn_get(basic, "color.r", &result, &d.value) == TN_OK && result.number == 0.9);

    const tn_value_t yes = boolean(true);
    CHECK(tn_set(basic, "needsUpdate", &yes, &d.value) == TN_OK);
    CHECK(tn_object_release(basic, &d.value) == TN_OK);
    CHECK(tn_object_release(paint, &d.value) == TN_OK);
    CHECK(tn_context_destroy(ctx, &d.value) == TN_OK);
}

// PRD-514: a light takes a hex number through ColorManagement, inherits Object3D's bindings, and a
// DirectionalLight's target is an Object3D member alias.
void light() {
    const tn_version_info_t own = tn_engine_version();
    tn_context_t* ctx = nullptr;
    Diag d;
    CHECK(tn_context_create(&ctx, &own, &d.value) == TN_OK);

    tn_handle_t directional{};
    const tn_value_t args[2] = {num(16777215), num(3)};
    CHECK(tn_construct(ctx, "DirectionalLight", args, 2, &directional, &d.value) == TN_OK);
    tn_value_t result{};
    CHECK(tn_get(directional, "type", &result, &d.value) == TN_OK && text(result) == "DirectionalLight");
    CHECK(tn_get(directional, "intensity", &result, &d.value) == TN_OK && result.number == 3);
    CHECK(tn_get(directional, "position.y", &result, &d.value) == TN_OK && result.number == 1);  // DEFAULT_UP
    CHECK(tn_get(directional, "target", &result, &d.value) == TN_OK && result.kind == TN_VALUE_HANDLE);
    const tn_handle_t originalTarget = result.handle;
    tn_handle_t target{};
    CHECK(tn_construct(ctx, "Group", nullptr, 0, &target, &d.value) == TN_OK);
    const tn_value_t targetRef = ref(target);
    CHECK(tn_set(directional, "target", &targetRef, &d.value) == TN_OK);
    CHECK(tn_object_release(target, &d.value) == TN_OK);
    CHECK(tn_get(directional, "target", &result, &d.value) == TN_OK && result.kind == TN_VALUE_HANDLE);
    const tn_value_t offset = num(2);
    CHECK(tn_set(result.handle, "position.x", &offset, &d.value) == TN_OK);
    CHECK(tn_get(originalTarget, "position.x", &result, &d.value) == TN_OK && result.number == 0);
    const tn_value_t invalidTarget = num(1);
    CHECK(tn_set(directional, "target", &invalidTarget, &d.value) != TN_OK);

    tn_handle_t hemisphere{};
    const tn_value_t hemiArgs[3] = {num(11189137), num(2236962), num(0.6)};
    CHECK(tn_construct(ctx, "HemisphereLight", hemiArgs, 3, &hemisphere, &d.value) == TN_OK);
    CHECK(tn_get(hemisphere, "type", &result, &d.value) == TN_OK && text(result) == "HemisphereLight");
    CHECK(tn_get(hemisphere, "intensity", &result, &d.value) == TN_OK && result.number == 0.6);
    CHECK(tn_get(hemisphere, "groundColor.g", &result, &d.value) == TN_OK && result.kind == TN_VALUE_NUMBER);

    tn_handle_t ambient{};
    CHECK(tn_construct(ctx, "AmbientLight", nullptr, 0, &ambient, &d.value) == TN_OK);
    CHECK(tn_get(ambient, "color.r", &result, &d.value) == TN_OK && result.number == 1);

    // A light is an Object3D: `add` and the inherited setters reach it through the same binding.
    const tn_value_t x = num(4);
    CHECK(tn_set(directional, "position.x", &x, &d.value) == TN_OK);
    CHECK(tn_get(directional, "position.x", &result, &d.value) == TN_OK && result.number == 4);

    CHECK(tn_object_release(ambient, &d.value) == TN_OK);
    CHECK(tn_object_release(hemisphere, &d.value) == TN_OK);
    CHECK(tn_object_release(directional, &d.value) == TN_OK);
    CHECK(tn_context_destroy(ctx, &d.value) == TN_OK);
}

// Objects the engine still uses outlive the caller's handles, as three objects outlive a JS scope:
// a deleted attribute stays readable through a reference to it, a scene keeps the mesh it draws
// (and the mesh its geometry and material), and a replaced background stays readable. Run under
// ASan, a use-after-free in any of these fails the case.
void pooledLifetime() {
    // Exercise the actual binding factory, including enable_shared_from_this and late weak teardown.
    for (int cycle = 0; cycle < 3; ++cycle) {
        auto mesh = tn::binding::detail::makeShared<tn::engine::Mesh>();
        CHECK(mesh->shared_from_this().get() == mesh.get());
        std::weak_ptr<tn::engine::Mesh> weak = mesh;
        mesh.reset();
        CHECK(weak.expired());
        auto replacement = tn::binding::detail::makeShared<tn::engine::Mesh>();
        CHECK(replacement->shared_from_this().get() == replacement.get());
        weak.reset();
        CHECK(replacement->parent == nullptr);
    }
#if defined(__EMSCRIPTEN__) || !defined(__APPLE__)
    struct Upstream final : std::pmr::memory_resource {
        std::size_t bytes = 0;
        bool fail = false;
        void* do_allocate(std::size_t size, std::size_t alignment) override {
            if (fail)
                throw std::bad_alloc();
            void* pointer = std::pmr::new_delete_resource()->allocate(size, alignment);
            bytes += size;
            return pointer;
        }
        void do_deallocate(void* pointer, std::size_t size, std::size_t alignment) override {
            bytes -= size;
            std::pmr::new_delete_resource()->deallocate(pointer, size, alignment);
        }
        bool do_is_equal(const std::pmr::memory_resource& other) const noexcept override { return this == &other; }
    } upstream;
    struct alignas(64) Item {
        int value;
        explicit Item(int n) : value(n) {
            if (n < 0)
                throw std::runtime_error("constructor");
        }
    };
    tn::binding::detail::SharedObjectPool pool(&upstream);
    const auto initial = upstream.bytes;
    const std::pmr::polymorphic_allocator<Item> allocator(&pool);
    for (int cycle = 0; cycle < 3; ++cycle) {
        auto live = std::allocate_shared<Item>(allocator, 17);
        CHECK(reinterpret_cast<std::uintptr_t>(live.get()) % alignof(Item) == 0);
        std::weak_ptr<Item> weak = live;
        live.reset();
        CHECK(weak.expired() && upstream.bytes > initial);
        auto other = std::allocate_shared<Item>(allocator, 23);
        CHECK(other->value == 23);
        other.reset();
        CHECK(upstream.bytes > initial);
        weak.reset();
        CHECK(upstream.bytes <= initial);
        try {
            auto failed = std::allocate_shared<Item>(allocator, -1);
            CHECK(false);
        } catch (const std::runtime_error&) {
        }
        CHECK(upstream.bytes <= initial);
        upstream.fail = true;
        try {
            auto failed = std::allocate_shared<Item>(allocator, 1);
            CHECK(false);
        } catch (const std::bad_alloc&) {
        }
        upstream.fail = false;
        CHECK(upstream.bytes <= initial);
    }
#endif
}

void lifetime() {
    pooledLifetime();
    const tn_version_info_t own = tn_engine_version();
    tn_context_t* ctx = nullptr;
    Diag d;
    CHECK(tn_context_create(&ctx, &own, &d.value) == TN_OK);
    auto str = [](const char* s) {
        tn_value_t v{};
        v.kind = TN_VALUE_STRING;
        v.text = s;
        v.count = std::strlen(s);
        return v;
    };
    auto ref = [](tn_handle_t h) {
        tn_value_t v{};
        v.kind = TN_VALUE_HANDLE;
        v.handle = h;
        return v;
    };
    tn_value_t out{};

    // 1. An attribute reference survives deleteAttribute.
    tn_handle_t box{};
    CHECK(tn_construct(ctx, "BoxGeometry", nullptr, 0, &box, &d.value) == TN_OK);
    CHECK(tn_get(box, "attributes.position", &out, &d.value) == TN_OK && out.kind == TN_VALUE_HANDLE);
    const tn_handle_t position = out.handle;
    const tn_value_t name = str("position");
    CHECK(tn_invoke(box, "deleteAttribute", &name, 1, &out, &d.value) == TN_OK);
    const tn_value_t zero = num(0);
    CHECK(tn_invoke(position, "getX", &zero, 1, &out, &d.value) == TN_OK && out.kind == TN_VALUE_NUMBER && out.number == 0.5);

    // 2. A scene keeps its mesh, and the mesh its geometry and material, after every other handle goes.
    tn_handle_t scene{}, geometry{}, material{}, mesh{};
    CHECK(tn_construct(ctx, "Scene", nullptr, 0, &scene, &d.value) == TN_OK);
    CHECK(tn_construct(ctx, "SphereGeometry", nullptr, 0, &geometry, &d.value) == TN_OK);
    CHECK(tn_construct(ctx, "MeshBasicMaterial", nullptr, 0, &material, &d.value) == TN_OK);
    const tn_value_t parts[2] = {ref(geometry), ref(material)};
    CHECK(tn_construct(ctx, "Mesh", parts, 2, &mesh, &d.value) == TN_OK);
    CHECK(tn_get(mesh, "geometry", &out, &d.value) == TN_OK && out.handle.index == geometry.index &&
          out.handle.generation == geometry.generation);  // the geometry it was built from, not a new handle
    const tn_value_t meshName = str("kept");
    CHECK(tn_set(mesh, "name", &meshName, &d.value) == TN_OK);
    const tn_value_t meshRef = ref(mesh);
    CHECK(tn_invoke(scene, "add", &meshRef, 1, &out, &d.value) == TN_OK);
    CHECK(tn_object_release(mesh, &d.value) == TN_OK);
    CHECK(tn_object_release(geometry, &d.value) == TN_OK);
    CHECK(tn_object_release(material, &d.value) == TN_OK);
    CHECK(tn_invoke(scene, "getObjectByName", &meshName, 1, &out, &d.value) == TN_OK && out.kind == TN_VALUE_HANDLE);
    const tn_handle_t found = out.handle;
    CHECK(tn_get(found, "geometry", &out, &d.value) == TN_OK && out.kind == TN_VALUE_HANDLE);
    const tn_handle_t keptGeometry = out.handle;
    CHECK(tn_get(keptGeometry, "attributes.position", &out, &d.value) == TN_OK && out.kind == TN_VALUE_HANDLE);
    CHECK(tn_get(out.handle, "count", &out, &d.value) == TN_OK && out.kind == TN_VALUE_NUMBER && out.number > 0);
    CHECK(tn_get(found, "material", &out, &d.value) == TN_OK && out.kind == TN_VALUE_HANDLE);
    CHECK(tn_get(out.handle, "type", &out, &d.value) == TN_OK && std::string(out.text, out.count) == "MeshBasicMaterial");

    // 3. A replaced background stays readable through the old reference, and is the caller's Color.
    const tn_value_t red[3] = {num(1), num(0), num(0)};
    tn_handle_t c1{}, c2{};
    CHECK(tn_construct(ctx, "Color", red, 3, &c1, &d.value) == TN_OK);
    CHECK(tn_construct(ctx, "Color", nullptr, 0, &c2, &d.value) == TN_OK);
    const tn_value_t c1Ref = ref(c1), c2Ref = ref(c2);
    CHECK(tn_set(scene, "background", &c1Ref, &d.value) == TN_OK);
    CHECK(tn_get(scene, "background", &out, &d.value) == TN_OK && out.handle.index == c1.index);  // the same Color
    CHECK(tn_object_release(c1, &d.value) == TN_OK);
    CHECK(tn_get(scene, "background", &out, &d.value) == TN_OK && out.kind == TN_VALUE_HANDLE);
    const tn_handle_t oldBackground = out.handle;
    CHECK(tn_set(scene, "background", &c2Ref, &d.value) == TN_OK);
    CHECK(tn_get(oldBackground, "r", &out, &d.value) == TN_OK && out.number == 1);

    CHECK(tn_context_destroy(ctx, &d.value) == TN_OK);
}

struct Calls {
    int invoked = 0;
    int released = 0;
    bool fail = false;
    uint32_t count = 0;
    tn_value_t args[6] = {};
};

tn_status_t recordCall(void* context, const tn_value_t* args, uint32_t count, char* error, uint32_t capacity) {
    auto* calls = static_cast<Calls*>(context);
    ++calls->invoked;
    calls->count = count;
    for (uint32_t i = 0; i < count && i < 6; ++i) calls->args[i] = args[i];
    if (!calls->fail) return TN_OK;
    std::snprintf(error, capacity, "boom");
    return TN_ERROR_INVALID_STATE;
}

void releaseCall(void* context) { ++static_cast<Calls*>(context)->released; }

template <typename T>
T* engineObject(tn_handle_t h) {
    return static_cast<T*>(tn::abi::objectOf(h)->ptr.get());
}

// PRD-531/506: a callback set through the ABI runs with three's arguments as handles, reports a
// throw as a status, and its context is released exactly once: replaced, cleared or destroyed.
void callbacks() {
    const tn_version_info_t own = tn_engine_version();
    tn_context_t* ctx = nullptr;
    Diag d;
    CHECK(tn_context_create(&ctx, &own, &d.value) == TN_OK);
    tn_handle_t scene{}, camera{}, geometry{}, material{}, mesh{}, other{};
    CHECK(tn_construct(ctx, "Scene", nullptr, 0, &scene, &d.value) == TN_OK);
    CHECK(tn_construct(ctx, "PerspectiveCamera", nullptr, 0, &camera, &d.value) == TN_OK);
    CHECK(tn_construct(ctx, "BoxGeometry", nullptr, 0, &geometry, &d.value) == TN_OK);
    CHECK(tn_construct(ctx, "MeshBasicMaterial", nullptr, 0, &material, &d.value) == TN_OK);
    const tn_value_t parts[2] = {ref(geometry), ref(material)};
    CHECK(tn_construct(ctx, "Mesh", parts, 2, &mesh, &d.value) == TN_OK);
    CHECK(tn_construct(ctx, "Mesh", parts, 2, &other, &d.value) == TN_OK);

    Calls first, second, third;
    CHECK(tn_set_callback(mesh, "onBeforeRender", recordCall, &first, releaseCall, &d.value) == TN_OK);
    auto* object = engineObject<tn::engine::Object3D>(mesh);
    const tn::engine::RenderCallbackArgs args{
        engineObject<tn::engine::Object3D>(scene), engineObject<tn::engine::Object3D>(camera),
        std::static_pointer_cast<const tn::engine::BufferGeometry>(tn::abi::objectOf(geometry)->ptr),
        std::static_pointer_cast<const tn::engine::Material>(tn::abi::objectOf(material)->ptr)};
    std::string error;
    CHECK(object->onBeforeRender && (*object->onBeforeRender)(args, error));
    CHECK(first.invoked == 1 && first.count == 6);
    CHECK(first.args[0].kind == TN_VALUE_NULL && first.args[5].kind == TN_VALUE_NULL);  // renderer, group
    CHECK(first.args[1].kind == TN_VALUE_HANDLE && same(first.args[1].handle, scene));
    CHECK(first.args[2].kind == TN_VALUE_HANDLE && same(first.args[2].handle, camera));
    CHECK(first.args[3].kind == TN_VALUE_HANDLE && same(first.args[3].handle, geometry));
    CHECK(first.args[4].kind == TN_VALUE_HANDLE && same(first.args[4].handle, material));
    // A camera the engine keeps on its stack (a probe capture's face) has no shared owner: the callback
    // is handed null, never a handle that would dangle once the capture returns.
    const tn::engine::PerspectiveCamera stackCamera(90, 1, 0.1, 10);
    tn::engine::RenderCallbackArgs borrowed = args;
    borrowed.camera = &stackCamera;
    CHECK((*object->onBeforeRender)(borrowed, error));
    CHECK(first.invoked == 2 && first.args[2].kind == TN_VALUE_NULL && first.args[1].kind == TN_VALUE_HANDLE);
    first.fail = true;
    CHECK(!(*object->onBeforeRender)(args, error) && error == "boom");

    CHECK(tn_set_callback(mesh, "onBeforeRender", recordCall, &second, releaseCall, &d.value) == TN_OK);
    CHECK(first.released == 1 && second.released == 0);  // replaced: released once
    CHECK(tn_set_callback(mesh, "onBeforeRender", nullptr, nullptr, nullptr, &d.value) == TN_OK);
    CHECK(second.released == 1 && !object->onBeforeRender);  // cleared

    CHECK(tn_set_callback(other, "onBeforeRender", recordCall, &third, releaseCall, &d.value) == TN_OK);
    CHECK(tn_object_release(other, &d.value) == TN_OK);
    CHECK(third.released == 1);  // its object destroyed

    Calls unused;
    CHECK(tn_set_callback(mesh, "onAfterShadow", recordCall, &unused, releaseCall, &d.value) == TN_ERROR_UNSUPPORTED);
    tn_handle_t vector{};
    CHECK(tn_construct(ctx, "Vector3", nullptr, 0, &vector, &d.value) == TN_OK);
    CHECK(tn_set_callback(vector, "onBeforeRender", recordCall, &unused, releaseCall, &d.value) == TN_ERROR_UNSUPPORTED);
    CHECK(unused.released == 0);  // a refused pair was never taken
    CHECK(tn_context_destroy(ctx, &d.value) == TN_OK);
}

// PRD-540: three's one-argument Color is Color.set(): a hex in sRGB, a CSS string, or a Color to
// copy. Three numbers stay linear components.
void color_set() {
    const tn_version_info_t own = tn_engine_version();
    tn_context_t* ctx = nullptr;
    Diag d;
    CHECK(tn_context_create(&ctx, &own, &d.value) == TN_OK);
    tn_value_t result{};
    const auto channel = [&](tn_handle_t color, const char* name) {
        CHECK(tn_get(color, name, &result, &d.value) == TN_OK && result.kind == TN_VALUE_NUMBER);
        return result.number;
    };

    tn_handle_t red{};
    const tn_value_t hex = num(0xff0000);
    CHECK(tn_construct(ctx, "Color", &hex, 1, &red, &d.value) == TN_OK);
    CHECK(channel(red, "r") == 1 && channel(red, "g") == 0 && channel(red, "b") == 0);

    tn_handle_t green{};
    tn_value_t css{};
    css.kind = TN_VALUE_STRING;
    css.text = "#00ff00";
    css.count = 7;
    CHECK(tn_construct(ctx, "Color", &css, 1, &green, &d.value) == TN_OK);
    CHECK(channel(green, "r") == 0 && channel(green, "g") == 1 && channel(green, "b") == 0);

    tn_handle_t copy{};
    const tn_value_t source = ref(red);
    CHECK(tn_construct(ctx, "Color", &source, 1, &copy, &d.value) == TN_OK);
    CHECK(!same(copy, red) && channel(copy, "r") == 1 && channel(copy, "g") == 0);

    tn_handle_t linear{};
    const tn_value_t rgb[3] = {num(0.25), num(0.5), num(0.75)};
    CHECK(tn_construct(ctx, "Color", rgb, 3, &linear, &d.value) == TN_OK);
    CHECK(channel(linear, "r") == 0.25 && channel(linear, "g") == 0.5 && channel(linear, "b") == 0.75);
    CHECK(tn_context_destroy(ctx, &d.value) == TN_OK);
}

// PRD-540: `children` answers the attached objects in order, as three's array does.
void children() {
    const tn_version_info_t own = tn_engine_version();
    tn_context_t* ctx = nullptr;
    Diag d;
    CHECK(tn_context_create(&ctx, &own, &d.value) == TN_OK);
    tn_handle_t scene{}, first{}, second{};
    CHECK(tn_construct(ctx, "Scene", nullptr, 0, &scene, &d.value) == TN_OK);
    CHECK(tn_construct(ctx, "Group", nullptr, 0, &first, &d.value) == TN_OK);
    CHECK(tn_construct(ctx, "Mesh", nullptr, 0, &second, &d.value) == TN_OK);
    tn_value_t result{};
    CHECK(tn_get(scene, "children", &result, &d.value) == TN_OK && result.kind == TN_VALUE_ARRAY && result.count == 0);
    // three's add(...objects) and remove(...objects): every argument, in order, in one call.
    const tn_value_t both[2] = {ref(first), ref(second)};
    CHECK(tn_invoke(scene, "add", both, 2, &result, &d.value) == TN_OK);
    CHECK(tn_get(scene, "children", &result, &d.value) == TN_OK && result.kind == TN_VALUE_ARRAY && result.count == 2);
    CHECK(result.values[0].kind == TN_VALUE_HANDLE && same(result.values[0].handle, first));
    CHECK(result.values[1].kind == TN_VALUE_HANDLE && same(result.values[1].handle, second));
    CHECK(tn_invoke(scene, "remove", both, 2, &result, &d.value) == TN_OK);
    CHECK(tn_get(scene, "children", &result, &d.value) == TN_OK && result.count == 0);
    CHECK(tn_context_destroy(ctx, &d.value) == TN_OK);
}

// The walk with parents: each object, then its parent's index in the walk (-1 for the root), so a
// back end learns every `parent` in the subtree from the one crossing.
void walk_parents() {
    const tn_version_info_t own = tn_engine_version();
    tn_context_t* ctx = nullptr;
    Diag d;
    CHECK(tn_context_create(&ctx, &own, &d.value) == TN_OK);
    tn_handle_t scene{}, group{}, mesh{}, other{};
    CHECK(tn_construct(ctx, "Scene", nullptr, 0, &scene, &d.value) == TN_OK);
    CHECK(tn_construct(ctx, "Group", nullptr, 0, &group, &d.value) == TN_OK);
    CHECK(tn_construct(ctx, "Mesh", nullptr, 0, &mesh, &d.value) == TN_OK);
    CHECK(tn_construct(ctx, "Mesh", nullptr, 0, &other, &d.value) == TN_OK);
    tn_value_t result{};
    const tn_value_t children[2] = {ref(group), ref(other)};
    CHECK(tn_invoke(scene, "add", children, 2, &result, &d.value) == TN_OK);
    const tn_value_t child = ref(mesh);
    CHECK(tn_invoke(group, "add", &child, 1, &result, &d.value) == TN_OK);
    const tn_value_t args[2] = {boolean(false), boolean(true)};
    CHECK(tn_invoke(scene, "__walk", args, 2, &result, &d.value) == TN_OK);
    CHECK(result.kind == TN_VALUE_ARRAY && result.count == 8);
    if (result.count != 8) return;
    const tn_handle_t order[4] = {scene, group, mesh, other};
    const double parents[4] = {-1, 0, 1, 0};
    for (int i = 0; i < 4; ++i) {
        CHECK(result.values[2 * i].kind == TN_VALUE_HANDLE && same(result.values[2 * i].handle, order[i]));
        CHECK(result.values[2 * i + 1].kind == TN_VALUE_NUMBER && result.values[2 * i + 1].number == parents[i]);
    }
    CHECK(tn_context_destroy(ctx, &d.value) == TN_OK);
}

// `__hierarchyRevision` is the engine's count of adds, removes, attaches and destroys: core keeps a walk
// that only finds who is under whom while it holds still, so it moves on each of those and nothing else.
// core's AutoBatch guard on the engine: a watched source that moves, hides or changes material is
// answered once by index; one held still never is, and a limit checks that many from where it stopped.
void source_guard() {
    const tn_version_info_t own = tn_engine_version();
    tn_context_t* ctx = nullptr;
    Diag d;
    CHECK(tn_context_create(&ctx, &own, &d.value) == TN_OK);
    tn_handle_t scene{}, meshes[3]{}, other{};
    CHECK(tn_construct(ctx, "Scene", nullptr, 0, &scene, &d.value) == TN_OK);
    tn_value_t result{};
    for (auto& mesh : meshes) {
        CHECK(tn_construct(ctx, "Mesh", nullptr, 0, &mesh, &d.value) == TN_OK);
        const tn_value_t child = ref(mesh);
        CHECK(tn_invoke(scene, "add", &child, 1, &result, &d.value) == TN_OK);
    }
    CHECK(tn_construct(ctx, "MeshBasicMaterial", nullptr, 0, &other, &d.value) == TN_OK);
    const tn_value_t items[3] = {ref(meshes[0]), ref(meshes[1]), ref(meshes[2])};
    tn_value_t list{};
    list.kind = TN_VALUE_ARRAY;
    list.count = 3;
    list.values = items;
    CHECK(tn_invoke(scene, "__tnGuardWatch", &list, 1, &result, &d.value) == TN_OK && result.number == 3);
    const auto changed = [&](double limit) {
        const tn_value_t arg = num(limit);
        tn_value_t out{};
        CHECK(tn_invoke(scene, "__tnGuardCheck", &arg, 1, &out, &d.value) == TN_OK);
        CHECK(out.kind == TN_VALUE_NUMBERS);
        return std::vector<double>(out.numbers, out.numbers + out.count);
    };
    CHECK(changed(10).empty());
    const tn_value_t moved = num(0.5), hidden = boolean(false), material = ref(other);
    CHECK(tn_set(meshes[1], "position.x", &moved, &d.value) == TN_OK);
    CHECK((changed(10) == std::vector<double>{1}));
    CHECK(changed(10).empty());  // answered once, then no longer watched
    CHECK(tn_set(meshes[2], "visible", &hidden, &d.value) == TN_OK);
    CHECK(tn_set(meshes[0], "material", &material, &d.value) == TN_OK);
    // A limit checks that many sources from where the last check stopped.
    CHECK((changed(1) == std::vector<double>{0}));
    CHECK(changed(1).empty());  // source 1 is no longer watched
    CHECK((changed(1) == std::vector<double>{2}));
    CHECK(tn_invoke(scene, "__tnGuardWatch", &list, 1, &result, &d.value) == TN_OK);
    CHECK(changed(3).empty());  // rewatched as they are now
    const tn_value_t zero = num(0), far = num(4);
    CHECK(tn_set(meshes[0], "position.x", &zero, &d.value) == TN_OK);  // the value it holds: still
    CHECK(tn_set(meshes[2], "position.x", &far, &d.value) == TN_OK);
    CHECK(changed(2).empty());  // sources 0 and 1
    CHECK((changed(2) == std::vector<double>{2}));
    CHECK(tn_context_destroy(ctx, &d.value) == TN_OK);
}

void matrix_evaluations() {
    const tn_version_info_t own = tn_engine_version();
    tn_context_t* ctx = nullptr;
    Diag d;
    CHECK(tn_context_create(&ctx, &own, &d.value) == TN_OK);
    tn_handle_t scene{}, group{}, mesh{};
    CHECK(tn_construct(ctx, "Scene", nullptr, 0, &scene, &d.value) == TN_OK);
    CHECK(tn_construct(ctx, "Group", nullptr, 0, &group, &d.value) == TN_OK);
    CHECK(tn_construct(ctx, "Mesh", nullptr, 0, &mesh, &d.value) == TN_OK);
    const auto composes = [&]() {
        tn_value_t out{};
        CHECK(tn_get(scene, "__matrixEvaluations", &out, &d.value) == TN_OK && out.kind == TN_VALUE_NUMBER);
        return out.number;
    };
    tn_value_t result{};
    const tn_value_t groupRef = ref(group), meshRef = ref(mesh), hidden = boolean(false);
    CHECK(tn_invoke(scene, "add", &groupRef, 1, &result, &d.value) == TN_OK);
    CHECK(tn_invoke(group, "add", &meshRef, 1, &result, &d.value) == TN_OK);
    CHECK(tn_set(mesh, "visible", &hidden, &d.value) == TN_OK);
    const tn_value_t pruned[2] = {boolean(true), boolean(true)}, full[2] = {boolean(true), boolean(false)};
    double before = composes();
    CHECK(tn_invoke(scene, "__tnUpdateMatrixWorld", pruned, 2, &result, &d.value) == TN_OK);
    CHECK(composes() - before == 2);  // scene and group: the hidden mesh composes when it shows
    before = composes();
    CHECK(tn_invoke(scene, "__tnUpdateMatrixWorld", full, 2, &result, &d.value) == TN_OK);
    CHECK(composes() - before == 3);
    CHECK(tn_context_destroy(ctx, &d.value) == TN_OK);
}

void hierarchy_revision() {
    const tn_version_info_t own = tn_engine_version();
    tn_context_t* ctx = nullptr;
    Diag d;
    CHECK(tn_context_create(&ctx, &own, &d.value) == TN_OK);
    tn_handle_t scene{}, group{}, mesh{};
    CHECK(tn_construct(ctx, "Scene", nullptr, 0, &scene, &d.value) == TN_OK);
    CHECK(tn_construct(ctx, "Group", nullptr, 0, &group, &d.value) == TN_OK);
    CHECK(tn_construct(ctx, "Mesh", nullptr, 0, &mesh, &d.value) == TN_OK);
    const auto revision = [&](tn_handle_t object) {
        tn_value_t out{};
        CHECK(tn_get(object, "__hierarchyRevision", &out, &d.value) == TN_OK && out.kind == TN_VALUE_NUMBER);
        return out.number;
    };
    tn_value_t result{};
    const double start = revision(scene);
    CHECK(revision(mesh) == start);
    const tn_value_t groupRef = ref(group), meshRef = ref(mesh);
    CHECK(tn_invoke(scene, "add", &groupRef, 1, &result, &d.value) == TN_OK);
    const double added = revision(scene);
    CHECK(added > start);
    const tn_value_t hidden = boolean(false);
    CHECK(tn_set(mesh, "visible", &hidden, &d.value) == TN_OK);
    CHECK(revision(scene) == added);
    CHECK(tn_invoke(group, "add", &meshRef, 1, &result, &d.value) == TN_OK);
    const double nested = revision(scene);
    CHECK(nested > added);
    CHECK(tn_invoke(scene, "attach", &meshRef, 1, &result, &d.value) == TN_OK);
    const double attached = revision(scene);
    CHECK(attached > nested);
    // Per subtree: a walk kept under one root (a rig) holds while another subtree changes. A shot crate's
    // shards added under the scene re-walked every rig in the shooter (573 nodes in one frame).
    const double rig = revision(group);
    tn_handle_t shard{};
    CHECK(tn_construct(ctx, "Mesh", nullptr, 0, &shard, &d.value) == TN_OK);
    const tn_value_t shardRef = ref(shard);
    CHECK(tn_invoke(scene, "add", &shardRef, 1, &result, &d.value) == TN_OK);
    CHECK(revision(scene) > attached);
    CHECK(revision(group) == rig);
    CHECK(tn_invoke(group, "add", &shardRef, 1, &result, &d.value) == TN_OK);
    CHECK(revision(group) > rig);
    const double moved = revision(scene);
    CHECK(moved > attached);
    CHECK(tn_invoke(shard, "removeFromParent", nullptr, 0, &result, &d.value) == TN_OK);
    CHECK(revision(scene) > moved);
    std::printf("TN_HIERARCHY_REVISION rig %g after an unrelated add under the scene, %g after one under the rig\n", rig, revision(group));
    CHECK(tn_context_destroy(ctx, &d.value) == TN_OK);
}

// A SpotLight's target is a shared-owned Object3D like a DirectionalLight's, so a scene that holds it as a
// child hands it to a walk and a clear. A C++-owned target made both throw "not shared-owned" (lamp-room).
void spot_target_in_scene() {
    const tn_version_info_t own = tn_engine_version();
    tn_context_t* ctx = nullptr;
    Diag d;
    CHECK(tn_context_create(&ctx, &own, &d.value) == TN_OK);
    tn_handle_t scene{}, spot{};
    CHECK(tn_construct(ctx, "Scene", nullptr, 0, &scene, &d.value) == TN_OK);
    CHECK(tn_construct(ctx, "SpotLight", nullptr, 0, &spot, &d.value) == TN_OK);
    tn_value_t result{};
    CHECK(tn_get(spot, "target", &result, &d.value) == TN_OK && result.kind == TN_VALUE_HANDLE);
    const tn_handle_t target = result.handle;
    const tn_value_t children[2] = {ref(spot), ref(target)};
    CHECK(tn_invoke(scene, "add", children, 2, &result, &d.value) == TN_OK);
    const tn_value_t args[2] = {boolean(false), boolean(true)};
    CHECK(tn_invoke(scene, "__walk", args, 2, &result, &d.value) == TN_OK);
    CHECK(result.kind == TN_VALUE_ARRAY && result.count == 6);
    CHECK(tn_get(scene, "children", &result, &d.value) == TN_OK && result.kind == TN_VALUE_ARRAY && result.count == 2);
    const tn_value_t targetRef = ref(target);
    CHECK(tn_invoke(scene, "remove", &targetRef, 1, &result, &d.value) == TN_OK);
    CHECK(tn_invoke(scene, "add", &targetRef, 1, &result, &d.value) == TN_OK);
    CHECK(tn_invoke(scene, "clear", nullptr, 0, &result, &d.value) == TN_OK);
    CHECK(tn_context_destroy(ctx, &d.value) == TN_OK);
}

// A light's shadow camera is shared-owned like any Object3D. It was a unique_ptr member read through an
// alias, so a scene that held it as a child made __walk, children and clear throw "not shared-owned", and a
// LOD level or a Raycaster camera kept a raw pointer that dangled once the light was freed.
void shadow_camera_in_scene() {
    const tn_version_info_t own = tn_engine_version();
    tn_context_t* ctx = nullptr;
    Diag d;
    CHECK(tn_context_create(&ctx, &own, &d.value) == TN_OK);
    for (const char* type : {"DirectionalLight", "PointLight", "SpotLight"}) {
        tn_handle_t scene{}, light{}, lod{}, caster{};
        CHECK(tn_construct(ctx, "Scene", nullptr, 0, &scene, &d.value) == TN_OK);
        CHECK(tn_construct(ctx, type, nullptr, 0, &light, &d.value) == TN_OK);
        CHECK(tn_construct(ctx, "LOD", nullptr, 0, &lod, &d.value) == TN_OK);
        CHECK(tn_construct(ctx, "Raycaster", nullptr, 0, &caster, &d.value) == TN_OK);
        tn_value_t result{};
        CHECK(tn_get(light, "shadow", &result, &d.value) == TN_OK && result.kind == TN_VALUE_HANDLE);
        const tn_handle_t shadow = result.handle;
        CHECK(tn_get(shadow, "camera", &result, &d.value) == TN_OK && result.kind == TN_VALUE_HANDLE);
        const tn_handle_t camera = result.handle;
        const tn_value_t cameraRef = ref(camera);
        CHECK(tn_invoke(scene, "add", &cameraRef, 1, &result, &d.value) == TN_OK);
        const tn_value_t args[2] = {boolean(false), boolean(true)};
        CHECK(tn_invoke(scene, "__walk", args, 2, &result, &d.value) == TN_OK);
        CHECK(result.kind == TN_VALUE_ARRAY && result.count == 4);
        CHECK(tn_get(scene, "children", &result, &d.value) == TN_OK && result.kind == TN_VALUE_ARRAY && result.count == 1);
        // The same camera is also a LOD level and a Raycaster's camera, then the light goes first.
        const tn_value_t level[2] = {cameraRef, num(10)};
        CHECK(tn_invoke(lod, "addLevel", level, 2, &result, &d.value) == TN_OK);
        CHECK(tn_set(caster, "camera", &cameraRef, &d.value) == TN_OK);
        CHECK(tn_object_release(shadow, &d.value) == TN_OK);
        CHECK(tn_object_release(light, &d.value) == TN_OK);
        CHECK(tn_object_release(camera, &d.value) == TN_OK);
        CHECK(tn_invoke(scene, "__walk", args, 2, &result, &d.value) == TN_OK);
        CHECK(result.kind == TN_VALUE_ARRAY && result.count == 2);  // the LOD took the camera from the scene
        CHECK(tn_get(caster, "camera", &result, &d.value) == TN_OK && result.kind == TN_VALUE_HANDLE);
        CHECK(tn_get(lod, "levels", &result, &d.value) == TN_OK && result.kind == TN_VALUE_ARRAY && result.count == 1);
        CHECK(tn_invoke(lod, "clear", nullptr, 0, &result, &d.value) == TN_OK);
        CHECK(tn_invoke(scene, "clear", nullptr, 0, &result, &d.value) == TN_OK);
    }
    CHECK(tn_context_destroy(ctx, &d.value) == TN_OK);
}

// `__bind`: a PropertyBinding binds and answers its reason and target in one call.
void property_bind() {
    const tn_version_info_t own = tn_engine_version();
    tn_context_t* ctx = nullptr;
    Diag d;
    CHECK(tn_context_create(&ctx, &own, &d.value) == TN_OK);
    tn_handle_t root{}, hip{}, bound{}, missing{};
    CHECK(tn_construct(ctx, "Group", nullptr, 0, &root, &d.value) == TN_OK);
    CHECK(tn_construct(ctx, "Bone", nullptr, 0, &hip, &d.value) == TN_OK);
    tn_value_t name{};
    name.kind = TN_VALUE_STRING;
    name.text = "hip";
    name.count = 3;
    CHECK(tn_set(hip, "name", &name, &d.value) == TN_OK);
    tn_value_t result{};
    const tn_value_t child = ref(hip);
    CHECK(tn_invoke(root, "add", &child, 1, &result, &d.value) == TN_OK);
    for (const auto& [path, out] : {std::pair{"hip.position", &bound}, std::pair{"leg.position", &missing}}) {
        tn_value_t args[2] = {ref(root), {}};
        args[1].kind = TN_VALUE_STRING;
        args[1].text = path;
        args[1].count = std::strlen(path);
        CHECK(tn_construct(ctx, "PropertyBinding", args, 2, out, &d.value) == TN_OK);
    }
    CHECK(tn_invoke(bound, "__bind", nullptr, 0, &result, &d.value) == TN_OK);
    CHECK(result.kind == TN_VALUE_ARRAY && result.count == 2);
    if (result.count == 2) {
        CHECK(result.values[0].kind == TN_VALUE_STRING && text(result.values[0]).empty());
        CHECK(result.values[1].kind == TN_VALUE_HANDLE && same(result.values[1].handle, hip));
    }
    CHECK(tn_invoke(missing, "__bind", nullptr, 0, &result, &d.value) == TN_OK);
    CHECK(result.kind == TN_VALUE_ARRAY && result.count == 2);
    if (result.count == 2) {
        CHECK(text(result.values[0]).find("No target node found") != std::string::npos);
        CHECK(result.values[1].kind == TN_VALUE_NULL);
    }
    CHECK(tn_context_destroy(ctx, &d.value) == TN_OK);
}

// PRD-540: TSL by name through the C ABI, the table the V8 back end shares. Midway's first call is
// a class field `uniform(0)`; its graph then reaches a node material and compiles.
tn_value_t bytes(const char* type, const void* data, uint64_t count);

void tsl_call() {
    const tn_version_info_t own = tn_engine_version();
    tn_context_t* ctx = nullptr;
    Diag d;
    CHECK(tn_context_create(&ctx, &own, &d.value) == TN_OK);
    const auto number = [](double n) { tn_tsl_arg_t a{}; a.kind = TN_TSL_ARG_NUMBER; a.number = n; return a; };
    const auto nodeArg = [](uint64_t id) { tn_tsl_arg_t a{}; a.kind = TN_TSL_ARG_NODE; a.node = id; return a; };

    uint64_t clock = 0, scaled = 0, uv = 0, color = 0, unknown = 0;
    const tn_tsl_arg_t zero = number(0);
    CHECK(tn_tsl_call(ctx, "uniform", nullptr, &zero, 1, &clock, &d.value) == TN_OK && clock != 0);
    const tn_tsl_arg_t two = number(2);
    CHECK(tn_tsl_call(ctx, "mul", &clock, &two, 1, &scaled, &d.value) == TN_OK && scaled != 0);
    CHECK(tn_tsl_call(ctx, "uv", nullptr, nullptr, 0, &uv, &d.value) == TN_OK);
    const tn_tsl_arg_t parts[3] = {nodeArg(uv), nodeArg(scaled), number(1)};
    CHECK(tn_tsl_call(ctx, "vec4", nullptr, parts, 3, &color, &d.value) == TN_OK);
    CHECK(tn_tsl_call(ctx, "noSuchNode", nullptr, nullptr, 0, &unknown, &d.value) == TN_ERROR_UNSUPPORTED && unknown == 0);
    tn_diagnostic_release(&d.value);
    // three's denoise converts its input to a texture itself (DenoiseNode.js: convertToTexture(node)), so a
    // computed node is a valid input: the template denoises SSGI's AO, which the engine's ssgi answers as vec4(1).
    {
        uint64_t depth = 0, denoised = 0;
        const tn_tsl_arg_t source = nodeArg(color);
        CHECK(tn_tsl_call(ctx, "convertToTexture", nullptr, &source, 1, &depth, &d.value) == TN_OK);
        const tn_tsl_arg_t inputs[3] = {nodeArg(color), nodeArg(depth), nodeArg(depth)};
        CHECK(tn_tsl_call(ctx, "denoise", nullptr, inputs, 3, &denoised, &d.value) == TN_OK && denoised != 0);
        tn_diagnostic_release(&d.value);
    }
    const tn_tsl_arg_t stale = nodeArg(999999);
    CHECK(tn_tsl_call(ctx, "sin", nullptr, &stale, 1, &unknown, &d.value) != TN_OK);
    tn_diagnostic_release(&d.value);

    tn_handle_t material{};
    CHECK(tn_construct(ctx, "MeshBasicNodeMaterial", nullptr, 0, &material, &d.value) == TN_OK);
    CHECK(tn_tsl_set(ctx, material, "colorNode", color, &d.value) == TN_OK);
    CHECK(tn_tsl_compile(material, nullptr, &d.value) == TN_OK);
    tn::engine::shader::Program direct(tn::engine::shader::Stage::Fragment);
    {
        tn::engine::shader::tsl::Build build(direct);
        direct.output("color", tn::engine::shader::graph::lower(tn::abi::shaderNode(material, "colorNode"), direct));
    }

    const auto handleArg = [](tn_handle_t h) {
        tn_tsl_arg_t a{}; a.kind = TN_TSL_ARG_HANDLE;
        std::memcpy(&a.reserved, &h, 4); std::memcpy(&a.node, reinterpret_cast<const char*>(&h) + 4, 8);
        return a;
    };
    const auto stringArg = [](const char* s) { tn_tsl_arg_t a{}; a.kind = TN_TSL_ARG_STRING; a.text = s; return a; };

    // Snow reads instanceIndex in a fragment's opacity; the index must arrive from the vertex stage.
    for (const char* name : {"instanceIndex", "vertexIndex"}) {
        uint64_t index = 0, scalar = 0, indexedColor = 0;
        const std::string constant = std::string("constant:") + name;
        CHECK(tn_tsl_call(ctx, constant.c_str(), nullptr, nullptr, 0, &index, &d.value) == TN_OK);
        const auto value = nodeArg(index);
        CHECK(tn_tsl_call(ctx, "float", nullptr, &value, 1, &scalar, &d.value) == TN_OK);
        const tn_tsl_arg_t rgba[] = {nodeArg(scalar), number(0), number(0), number(1)};
        CHECK(tn_tsl_call(ctx, "vec4", nullptr, rgba, 4, &indexedColor, &d.value) == TN_OK);
        const float position[4] = {1, 2, 3, 1};
        const tn_value_t attributeArgs[] = {bytes("Float32Array", position, 4), num(4)};
        tn_handle_t attribute{};
        CHECK(tn_construct(ctx, "BufferAttribute", attributeArgs, 2, &attribute, &d.value) == TN_OK);
        const tn_tsl_arg_t storageArgs[] = {handleArg(attribute), stringArg("vec4"), stringArg("points"), nodeArg(index)};
        uint64_t element = 0, carried = 0, combined = 0;
        CHECK(tn_tsl_call(ctx, "storage:object", nullptr, storageArgs, 4, &element, &d.value) == TN_OK);
        const auto elementArg = nodeArg(element);
        CHECK(tn_tsl_call(ctx, "varying", nullptr, &elementArg, 1, &carried, &d.value) == TN_OK);
        const auto carriedArg = nodeArg(carried);
        CHECK(tn_tsl_call(ctx, "add", &indexedColor, &carriedArg, 1, &combined, &d.value) == TN_OK);
        CHECK(tn_tsl_set(ctx, material, "colorNode", combined, &d.value) == TN_OK);
        CHECK(tn_tsl_compile(material, nullptr, &d.value) == TN_OK);
        tn_diagnostic_release(&d.value);
        tn::engine::shader::VertexVariant variant;
        variant.nodes.colorNode = tn::abi::shaderNode(material, "colorNode");
        uint64_t positionNode = 0;
        CHECK(tn_tsl_call(ctx, "swizzle:xyz", &element, nullptr, 0, &positionNode, &d.value) == TN_OK);
        CHECK(tn_tsl_set(ctx, material, "positionNode", positionNode, &d.value) == TN_OK);
        variant.nodes.positionNode = tn::abi::shaderNode(material, "positionNode");
        const auto programs = tn::engine::shader::buildSprite(variant);
        const auto vertex = tn::engine::shader::buildStage(programs.vertex);
        const auto fragment = tn::engine::shader::buildStage(programs.fragment);
        CHECK(vertex.wgsl.ok() && fragment.wgsl.ok());
        size_t storageBindings = 0;
        for (const auto& binding : vertex.bindings)
            storageBindings += binding.kind == tn::engine::shader::BindingKind::Storage;
        CHECK(storageBindings == 1);  // The sprite's position and fragment varying share this storage.

        CHECK(vertex.wgsl.code.find("var<storage") != std::string::npos);
        CHECK(fragment.wgsl.code.find("var<storage") == std::string::npos);
        CHECK(vertex.wgsl.code.find(std::string("@builtin(") + (std::string(name) == "instanceIndex" ? "instance_index" : "vertex_index")) != std::string::npos);
        CHECK(fragment.wgsl.code.find("@interpolate(flat)") != std::string::npos);
    }
    CHECK(tn_tsl_set(ctx, material, "colorNode", color, &d.value) == TN_OK);

    // A native struct selects typed members into the material graph; no JS shader builder.
    const tn_tsl_arg_t layout[] = {stringArg("Sample"), stringArg("colour"), stringArg("vec4"), stringArg("weight"), stringArg("float")};
    uint64_t schema = 0, sample = 0, member = 0;
    CHECK(tn_tsl_call(ctx, "struct", nullptr, layout, 5, &schema, &d.value) == TN_OK);
    const tn_tsl_arg_t values[] = {nodeArg(color), number(0.5)};
    CHECK(tn_tsl_call(ctx, "struct:new", &schema, values, 2, &sample, &d.value) == TN_OK);
    const auto colourName = stringArg("colour");
    CHECK(tn_tsl_call(ctx, "struct:get", &sample, &colourName, 1, &member, &d.value) == TN_OK);
    CHECK(tn_tsl_set(ctx, material, "colorNode", member, &d.value) == TN_OK);
    CHECK(tn_tsl_compile(material, nullptr, &d.value) == TN_OK);
    tn::engine::shader::Program selected(tn::engine::shader::Stage::Fragment);
    {
        tn::engine::shader::tsl::Build build(selected);
        selected.output("color", tn::engine::shader::graph::lower(tn::abi::shaderNode(material, "colorNode"), selected));
    }
    CHECK(selected.dump(true) == direct.dump(true));
    const auto missingName = stringArg("missing");
    CHECK(tn_tsl_call(ctx, "struct:get", &sample, &missingName, 1, &unknown, &d.value) != TN_OK);
    tn_diagnostic_release(&d.value);
    const tn_tsl_arg_t invalidLayout[] = {stringArg("Bad"), stringArg("value"), stringArg("not-a-type")};
    CHECK(tn_tsl_call(ctx, "struct", nullptr, invalidLayout, 3, &unknown, &d.value) != TN_OK);
    tn_diagnostic_release(&d.value);
    for (const auto id : {schema, sample, member}) CHECK(tn_tsl_release(ctx, id, &d.value) == TN_OK);

    // pmremTexture takes the texture object itself as a handle argument.
    tn_handle_t sky{};
    CHECK(tn_construct(ctx, "DataTexture", nullptr, 0, &sky, &d.value) == TN_OK);
    uint64_t direction = 0, pmrem = 0, lit = 0;
    const tn_tsl_arg_t axes[3] = {number(0), number(1), number(0)};
    CHECK(tn_tsl_call(ctx, "vec3", nullptr, axes, 3, &direction, &d.value) == TN_OK);
    const tn_tsl_arg_t sampled[3] = {handleArg(sky), nodeArg(direction), number(0.5)};
    CHECK(tn_tsl_call(ctx, "pmremTexture", nullptr, sampled, 3, &pmrem, &d.value) == TN_OK && pmrem != 0);
    const tn_tsl_arg_t opaque[2] = {nodeArg(pmrem), number(1)};
    CHECK(tn_tsl_call(ctx, "vec4", nullptr, opaque, 2, &lit, &d.value) == TN_OK);
    CHECK(tn_tsl_set(ctx, material, "colorNode", lit, &d.value) == TN_OK);
    CHECK(tn_tsl_compile(material, nullptr, &d.value) == TN_OK);
    {
        namespace g = tn::engine::shader::graph;
        uint64_t serial = 0;
        auto first = std::make_shared<tn::engine::Texture>();
        auto second = std::make_shared<tn::engine::Texture>();
        // Render-target textures are sampleable without CPU pixels.
        auto target = tn::engine::RenderTarget::make(1, 1, 1009);
        first = target->texture;
        auto target2 = tn::engine::RenderTarget::make(1, 1, 1009);
        second = target2->texture;
        const auto texture = tn::abi::tslCall("texture", nullptr, {tn::abi::TslArg::objectOf("Texture", first)}, serial);
        const auto other = tn::abi::tslCall("texture", nullptr, {tn::abi::TslArg::objectOf("Texture", first)}, serial);
        auto copy = std::make_shared<g::NodeData>(*texture);
        const auto key = g::key(texture);
        const auto receiver = tn::abi::TslArg::of(texture);
        CHECK(tn::abi::tslCall("textureValue", &receiver, {tn::abi::TslArg::objectOf("Texture", second)}, serial) == texture);
        CHECK(texture->textureObject() == second && copy->textureObject() == second);
        CHECK(other->textureObject() == first && other->name != texture->name);
        CHECK(g::key(texture) == key);
        // three's placeholder, `texture(new Texture())` then `.value = target.texture` (the exposure meter).
        const auto placeholder = std::make_shared<tn::engine::Texture>();
        const auto holder = tn::abi::tslCall("texture", nullptr, {tn::abi::TslArg::objectOf("Texture", placeholder)}, serial);
        CHECK(holder && holder->textureObject() == placeholder);
        const auto holderReceiver = tn::abi::TslArg::of(holder);
        CHECK(tn::abi::tslCall("textureValue", &holderReceiver, {tn::abi::TslArg::objectOf("Texture", target->texture)}, serial) == holder);
        CHECK(holder->textureObject() == target->texture);
        // Dimensions must query the bound texture, retaining its owner and deferred producer.
        using tn::abi::TslArg;
        using namespace tn::engine::shader;
        const auto biased = tn::abi::tslCall("bias", &holderReceiver, {TslArg::of(-0.5)}, serial);
        CHECK(biased);
        if (!biased) { tn_context_destroy(ctx, &d.value); return; }
        CHECK(biased->textureObject() == holder->textureObject());
        CHECK(biased->textureBinding == holder->textureBinding);
        const auto biasedWgsl = [&](g::Node root) {
            Program fragment(Stage::Fragment);
            tn::engine::shader::tsl::Build scope(fragment);
            fragment.output("color", g::lower(root, fragment));
            const auto stage = buildStage(fragment);
            CHECK(stage.wgsl.ok());
            return stage.wgsl.code;
        };
        const auto biasedCode = biasedWgsl(biased);
        CHECK(biasedCode.find("textureSampleBias(") != std::string::npos &&
              biasedCode.find("-0.5") != std::string::npos);
        CHECK(biasedWgsl(holder).find("textureSampleBias(") == std::string::npos);
        const auto sameLevel = tn::abi::tslCall("level", &holderReceiver, {TslArg::of(-0.5)}, serial);
        CHECK(g::key(biased) != g::key(sameLevel));
        CHECK(biasedWgsl(sameLevel).find("textureSampleLevel(") != std::string::npos);
        auto depth = std::make_shared<g::NodeData>(*holder);
        depth->bits = 1;
        for (const auto& wrongSource : {g::float_(1), g::Node(depth)}) {
            const auto self = TslArg::of(wrongSource);
            bool refused = false;
            try { tn::abi::tslCall("bias", &self, {TslArg::of(-0.5)}, serial); }
            catch (const std::runtime_error&) { refused = true; }
            CHECK(refused);
        }
        for (const auto& invalid : std::vector<std::vector<TslArg>>{{}, {TslArg::of(-0.5), TslArg::of(0.0)},
                {TslArg::of(g::int_(0))}, {TslArg::of(g::vec2({g::float_(0)}))}}) {
            bool refused = false;
            try { tn::abi::tslCall("bias", &holderReceiver, invalid, serial); }
            catch (const std::runtime_error&) { refused = true; }
            CHECK(refused);
        }
        const auto dimensions = tn::abi::tslCall("textureSize", nullptr, {TslArg::of(holder)}, serial);
        CHECK(dimensions);
        if (!dimensions) { tn_context_destroy(ctx, &d.value); return; }
        CHECK(dimensions->kind == g::Kind::TextureSize && dimensions->textureObject() == target->texture);
        CHECK(dimensions->otherwise.size() == 1 && dimensions->otherwise[0] == holder);
        const auto producer = tn::abi::tslCall("convertToTexture", nullptr, {TslArg::of(g::vec4({g::float_(1)}))}, serial);
        const auto producedSize = tn::abi::tslCall("textureSize", nullptr, {TslArg::of(producer), TslArg::of(0.0)}, serial);
        CHECK(producedSize->otherwise.size() == 1 && producedSize->otherwise[0] == producer);
        const auto producerSelf = TslArg::of(producer);
        const auto biasedProducer = tn::abi::tslCall("bias", &producerSelf, {TslArg::of(-0.5)}, serial);
        CHECK(biasedProducer && biasedProducer->args[0] == producer->args[0] &&
              biasedProducer->rtt == producer->rtt && biasedProducer->name == producer->name);
        CHECK(biasedWgsl(biasedProducer).find("textureSampleBias(") != std::string::npos);
        const auto passes = g::postPasses(biasedProducer);
        CHECK(passes.size() == 1 && passes[0].output == producer->name);

        Program query(Stage::Fragment);
        tn::engine::shader::tsl::Build queryScope(query);
        query.output("color", g::lower(g::vec4({g::vec2({dimensions}), g::float_(0), g::float_(1)}), query));
        const auto built = buildStage(query);
        CHECK(built.wgsl.ok() && built.wgsl.code.find("textureDimensions(") != std::string::npos);
        for (const auto& invalid : std::vector<std::vector<TslArg>>{{}, {TslArg::of(2.0)}, {TslArg::of(g::float_(1))},
                {TslArg::of(holder), TslArg::of(g::int_(0)), TslArg::of(g::int_(0))}}) {
            bool refused = false;
            try { tn::abi::tslCall("textureSize", nullptr, invalid, serial); }
            catch (const std::runtime_error&) { refused = true; }
            CHECK(refused);
        }
    }
    // A material is no texture, and a released handle is no object.
    const tn_tsl_arg_t wrong[3] = {handleArg(material), nodeArg(direction), number(0.5)};
    CHECK(tn_tsl_call(ctx, "pmremTexture", nullptr, wrong, 3, &unknown, &d.value) != TN_OK && unknown == 0);
    tn_diagnostic_release(&d.value);
    CHECK(tn_object_release(sky, &d.value) == TN_OK);
    CHECK(tn_tsl_call(ctx, "pmremTexture", nullptr, sampled, 3, &unknown, &d.value) != TN_OK && unknown == 0);
    tn_diagnostic_release(&d.value);
    CHECK(tn_context_destroy(ctx, &d.value) == TN_OK);
}

// PRD-540: a uniform's value is live. Midway writes `clock.value` every frame; the write reaches the
// material's graph data without changing the program key, so nothing recompiles.
// A mat4 built from four vec4 uniforms, as a game reads a camera matrix column by column, compiles and takes each
// column's new value without a new program: the uniforms sit inside the matrix and the renderer reads them afresh.
void tsl_matrix_columns() {
    const tn_version_info_t own = tn_engine_version();
    tn_context_t* ctx = nullptr;
    Diag d;
    CHECK(tn_context_create(&ctx, &own, &d.value) == TN_OK);
    const auto vector = [](double a, double b, double c, double e) {
        tn_tsl_arg_t arg{};
        arg.kind = TN_TSL_ARG_VECTOR;
        arg.reserved = 4;
        arg.numbers[0] = a, arg.numbers[1] = b, arg.numbers[2] = c, arg.numbers[3] = e;
        return arg;
    };
    uint64_t columns[4]{};
    tn_tsl_arg_t parts[4]{};
    for (int i = 0; i < 4; ++i) {
        const tn_tsl_arg_t zero = vector(0, 0, 0, 0);
        CHECK(tn_tsl_call(ctx, "uniform", nullptr, &zero, 1, &columns[i], &d.value) == TN_OK);
        parts[i].kind = TN_TSL_ARG_NODE;
        parts[i].node = columns[i];
    }
    uint64_t matrix = 0, product = 0;
    CHECK(tn_tsl_call(ctx, "mat4", nullptr, parts, 4, &matrix, &d.value) == TN_OK);
    const tn_tsl_arg_t point = vector(1, 1, 1, 1);
    CHECK(tn_tsl_call(ctx, "mul", &matrix, &point, 1, &product, &d.value) == TN_OK);
    tn_handle_t material{};
    CHECK(tn_construct(ctx, "MeshBasicNodeMaterial", nullptr, 0, &material, &d.value) == TN_OK);
    CHECK(tn_tsl_set(ctx, material, "colorNode", product, &d.value) == TN_OK);
    CHECK(tn_tsl_compile(material, nullptr, &d.value) == TN_OK);
    namespace g = tn::engine::shader::graph;
    const auto graph = tn::abi::shaderNode(material, "colorNode");
    const std::string key = g::key(graph);
    // The four columns of a camera at (1, 2, 3), then at (4, 5, 6).
    for (const double position : {1.0, 4.0}) {
        const double axes[4][4] = {{1, 0, 0, 0}, {0, 1, 0, 0}, {0, 0, 1, 0}, {position, position + 1, position + 2, 1}};
        for (int i = 0; i < 4; ++i) CHECK(tn_tsl_set_uniform(ctx, &columns[i], axes[i], 4, &d.value) == TN_OK);
        std::vector<std::vector<double>> seen;
        for (const auto& [name, values] : g::uniforms(graph)) seen.push_back(values);
        std::sort(seen.begin(), seen.end());
        std::vector<std::vector<double>> expected;
        for (const auto& axis : axes) expected.emplace_back(axis, axis + 4);
        std::sort(expected.begin(), expected.end());
        CHECK(seen == expected);
        CHECK(g::key(graph) == key);
    }
    CHECK(tn_context_destroy(ctx, &d.value) == TN_OK);
}

void tsl_uniform_value() {
    const tn_version_info_t own = tn_engine_version();
    tn_context_t* ctx = nullptr;
    Diag d;
    CHECK(tn_context_create(&ctx, &own, &d.value) == TN_OK);
    tn_tsl_arg_t zero{};
    zero.kind = TN_TSL_ARG_NUMBER;
    uint64_t clock = 0, color = 0;
    CHECK(tn_tsl_call(ctx, "uniform", nullptr, &zero, 1, &clock, &d.value) == TN_OK);
    tn_tsl_arg_t parts[4]{};
    for (auto& part : parts) part.kind = TN_TSL_ARG_NODE, part.node = clock;
    CHECK(tn_tsl_call(ctx, "vec4", nullptr, parts, 4, &color, &d.value) == TN_OK);
    tn_handle_t material{};
    CHECK(tn_construct(ctx, "MeshBasicNodeMaterial", nullptr, 0, &material, &d.value) == TN_OK);
    CHECK(tn_tsl_set(ctx, material, "colorNode", color, &d.value) == TN_OK);
    namespace g = tn::engine::shader::graph;
    const auto graph = tn::abi::shaderNode(material, "colorNode");
    const std::string key = g::key(graph);
    CHECK(g::uniforms(graph).begin()->second == std::vector<double>{0});

    const double quarter = 0.25;
    CHECK(tn_tsl_set_uniform(ctx, &clock, &quarter, 1, &d.value) == TN_OK);
    CHECK(g::uniforms(graph).begin()->second == std::vector<double>{0.25f});
    CHECK(g::key(graph) == key);  // same program: the value is data
    const double pair[2] = {1, 2};
    CHECK(tn_tsl_set_uniform(ctx, &clock, pair, 2, &d.value) != TN_OK);  // a float takes one value
    tn_diagnostic_release(&d.value);
    CHECK(tn_tsl_set_uniform(ctx, &color, &quarter, 1, &d.value) != TN_OK);  // not a uniform
    tn_diagnostic_release(&d.value);
    // f32 values retain the previous rounding and uploaded bits.
    for (const double value : {0.1, -0.0}) {
        CHECK(tn_tsl_set_uniform(ctx, &clock, &value, 1, &d.value) == TN_OK);
        const auto node = tn::abi::tslNode(ctx, clock);
        const float rounded = static_cast<float>(value);
        CHECK(node->values.at(0) == rounded);
        std::vector<uint8_t> upload(4);
        tn::engine::shader::writeUniform(upload, {"float", node->type, 0, 4}, node->values);
        CHECK(std::memcmp(upload.data(), &rounded, 4) == 0);
    }
    // Integer uniforms keep every 32-bit integer, through creation and public value reassignment.
    for (const bool unsignedType : {false, true}) {
        tn_tsl_arg_t args[2]{};
        args[0].kind = TN_TSL_ARG_NUMBER;
        args[0].number = unsignedType ? 16777217 : -16777217;
        args[1].kind = TN_TSL_ARG_STRING;
        args[1].text = unsignedType ? "uint" : "int";
        uint64_t integer = 0;
        CHECK(tn_tsl_call(ctx, "uniform", nullptr, args, 2, &integer, &d.value) == TN_OK);
        const auto node = tn::abi::tslNode(ctx, integer);
        CHECK(node && node->values.at(0) == args[0].number);
        const std::string integerKey = g::key(node);
        const double updated = unsignedType ? 4294967295.0 : -2147483648.0;
        CHECK(tn_tsl_set_uniform(ctx, &integer, &updated, 1, &d.value) == TN_OK);
        tn_diagnostic_release(&d.value);
        CHECK(node->values.at(0) == updated && g::key(node) == integerKey);
        tn::engine::shader::UniformField field{"typed", node->type, 0, 4};
        std::vector<uint8_t> upload(4);
        tn::engine::shader::writeUniform(upload, field, node->values);
        uint32_t word = 0;
        std::memcpy(&word, upload.data(), 4);
        CHECK(word == (unsignedType ? 0xffffffffu : 0x80000000u));
        for (const double invalid : {0.5, unsignedType ? -1.0 : -2147483649.0,
                                     unsignedType ? 4294967296.0 : 2147483648.0, double(INFINITY), double(NAN)}) {
            CHECK(tn_tsl_set_uniform(ctx, &integer, &invalid, 1, &d.value) != TN_OK);
            tn_diagnostic_release(&d.value);
            CHECK(node->values.at(0) == updated);
            args[0].number = invalid;
            uint64_t refused = 0;
            CHECK(tn_tsl_call(ctx, "uniform", nullptr, args, 2, &refused, &d.value) != TN_OK);
            tn_diagnostic_release(&d.value);
        }
    }
    CHECK(tn_context_destroy(ctx, &d.value) == TN_OK);
}

// PRD-540: Fn/If/Else/Loop/toVar/assign through the C ABI for a back end that runs the callbacks
// itself (the Wasm browser back end), building the very graph g::Block builds. The statement forms
// are tn_tsl_call names, over the engine's TslScopes (tsl_call.h) that V8 shares.
void tsl_statements() {
    const tn_version_info_t own = tn_engine_version();
    tn_context_t* ctx = nullptr;
    Diag d;
    CHECK(tn_context_create(&ctx, &own, &d.value) == TN_OK);
    const auto number = [](double n) { tn_tsl_arg_t a{}; a.kind = TN_TSL_ARG_NUMBER; a.number = n; return a; };
    const auto nodeArg = [](uint64_t id) { tn_tsl_arg_t a{}; a.kind = TN_TSL_ARG_NODE; a.node = id; return a; };
    const auto open = [&] { uint64_t none = 0; return tn_tsl_call(ctx, "scope:open", nullptr, nullptr, 0, &none, &d.value); };
    const auto close = [&](const tn_tsl_arg_t* result, uint64_t* out) {
        return tn_tsl_call(ctx, "scope:close", nullptr, result, result ? 1 : 0, out, &d.value);
    };
    uint64_t zero = 0, acc = 0, index = 0, cond = 0, then = 0, branch = 0, otherwise = 0, body = 0, fn = 0, done = 0;
    const tn_tsl_arg_t z = number(0), one = number(1), two = number(2);
    CHECK(tn_tsl_call(ctx, "float", nullptr, &z, 1, &zero, &d.value) == TN_OK);
    CHECK(tn_tsl_call(ctx, "toVar", &zero, nullptr, 0, &acc, &d.value) != TN_OK);  // outside any Fn
    tn_diagnostic_release(&d.value);

    CHECK(open() == TN_OK);
    CHECK(tn_tsl_call(ctx, "toVar", &zero, nullptr, 0, &acc, &d.value) == TN_OK);
    CHECK(tn_tsl_call(ctx, "Loop:index", nullptr, nullptr, 0, &index, &d.value) == TN_OK);
    CHECK(open() == TN_OK);
    CHECK(tn_tsl_call(ctx, "lessThan", &index, &one, 1, &cond, &d.value) == TN_OK);
    CHECK(open() == TN_OK);
    CHECK(tn_tsl_call(ctx, "assign", &acc, &one, 1, &done, &d.value) == TN_OK);
    CHECK(close(nullptr, &then) == TN_OK);
    const tn_tsl_arg_t ifArgs[2] = {nodeArg(cond), nodeArg(then)};
    CHECK(tn_tsl_call(ctx, "If", nullptr, ifArgs, 2, &branch, &d.value) == TN_OK);
    CHECK(open() == TN_OK);
    CHECK(tn_tsl_call(ctx, "assign", &acc, &two, 1, &done, &d.value) == TN_OK);
    CHECK(close(nullptr, &otherwise) == TN_OK);
    const tn_tsl_arg_t elseArg = nodeArg(otherwise);
    uint64_t withElse = 0;
    CHECK(tn_tsl_call(ctx, "Else", &branch, &elseArg, 1, &withElse, &d.value) == TN_OK);
    CHECK(tn_tsl_call(ctx, "Else", &withElse, &elseArg, 1, &done, &d.value) != TN_OK);  // one Else
    tn_diagnostic_release(&d.value);
    CHECK(close(nullptr, &body) == TN_OK);
    const tn_tsl_arg_t loopArgs[3] = {two, nodeArg(index), nodeArg(body)};
    CHECK(tn_tsl_call(ctx, "Loop", nullptr, loopArgs, 3, &done, &d.value) == TN_OK);
    CHECK(close(nullptr, &fn) == TN_OK);

    namespace g = tn::engine::shader::graph;
    g::Block block;
    const auto variable = block.var(g::float_(0));
    block.Loop(2, [&](g::Node i) {
        block.IfElse(g::lessThan(i, g::float_(1)), [&] { block.assign(variable.declaration, g::float_(1)); },
                     [&] { block.assign(variable.declaration, g::float_(2)); });
    });
    // The graph itself is checked through a material, where the ABI keeps it.
    uint64_t color = 0;
    tn_handle_t material{};
    CHECK(tn_construct(ctx, "MeshBasicNodeMaterial", nullptr, 0, &material, &d.value) == TN_OK);
    CHECK(tn_tsl_set(ctx, material, "colorNode", fn, &d.value) == TN_OK);
    CHECK(g::key(tn::abi::shaderNode(material, "colorNode")) == g::key(block.node()));
    // A callback that adds nothing answers its result: Fn(() => vec3(1)).
    CHECK(open() == TN_OK);
    CHECK(close(&one, &color) == TN_OK);
    CHECK(tn_tsl_set(ctx, material, "colorNode", color, &d.value) == TN_OK);
    CHECK(g::key(tn::abi::shaderNode(material, "colorNode")) == g::key(g::float_(1)));
    CHECK(tn_context_destroy(ctx, &d.value) == TN_OK);
}

// PRD-540: a live post effect's scalar uniform through the C ABI (lane-531's tslEffectParameter), as
// three's `ao(...).radius.value`; an omitted optional input is an OTHER argument.
void tsl_effect_parameter() {
    const tn_version_info_t own = tn_engine_version();
    tn_context_t* ctx = nullptr;
    Diag d;
    CHECK(tn_context_create(&ctx, &own, &d.value) == TN_OK);
    uint64_t uv = 0, depth = 0, ao = 0, plain = 0;
    CHECK(tn_tsl_call(ctx, "uv", nullptr, nullptr, 0, &uv, &d.value) == TN_OK);
    tn_tsl_arg_t map[2]{};
    map[0].kind = TN_TSL_ARG_NAMED;
    map[0].text = "depth";
    map[1].kind = TN_TSL_ARG_NODE;
    map[1].node = uv;
    CHECK(tn_tsl_call(ctx, "texture", nullptr, map, 2, &depth, &d.value) == TN_OK);
    tn_tsl_arg_t args[2]{};
    args[0].kind = TN_TSL_ARG_NODE;
    args[0].node = depth;
    args[1].kind = TN_TSL_ARG_OTHER;  // no normal node
    CHECK(tn_tsl_call(ctx, "ao", nullptr, args, 2, &ao, &d.value) == TN_OK);
    double out = 0;
    const double radius = 0.5;
    CHECK(tn_tsl_effect_parameter(ctx, &ao, "radius", &radius, &out, &d.value) == TN_OK && out == 0.5);
    out = 0;
    CHECK(tn_tsl_effect_parameter(ctx, &ao, "radius", nullptr, &out, &d.value) == TN_OK && out == 0.5);
    CHECK(tn_tsl_effect_parameter(ctx, &ao, "noSuchUniform", nullptr, &out, &d.value) != TN_OK);
    tn_diagnostic_release(&d.value);
    // A live effect carries a GPU stage too (post_effects.h kStage*): 1 labels it, 7 is no stage.
    const double gatherStage = 1, noStage = 7;
    CHECK(tn_tsl_effect_parameter(ctx, &ao, "stage", &gatherStage, &out, &d.value) == TN_OK && out == 1);
    CHECK(tn_tsl_effect_parameter(ctx, &ao, "stage", nullptr, &out, &d.value) == TN_OK && out == 1);
    CHECK(tn_tsl_effect_parameter(ctx, &ao, "stage", &noStage, &out, &d.value) != TN_OK);
    tn_diagnostic_release(&d.value);
    CHECK(tn_tsl_call(ctx, "uv", nullptr, nullptr, 0, &plain, &d.value) == TN_OK);
    CHECK(tn_tsl_effect_parameter(ctx, &plain, "radius", nullptr, &out, &d.value) != TN_OK);  // not an effect
    tn_diagnostic_release(&d.value);
    CHECK(tn_context_destroy(ctx, &d.value) == TN_OK);
}

// A game reads `mixer.time` every frame; the Wasm back end reads it in place through its field.
void mixer_time_field() {
    tn::binding::Registry classes;
    tn::binding::registerAll(classes);
    const tn::binding::ClassBinding& binding = classes.at("AnimationMixer");
    CHECK(binding.fields.count("time") == 1);
    if (binding.fields.count("time") == 0) return;
    tn::engine::animation::AnimationMixer mixer(std::make_shared<tn::engine::Object3D>());
    mixer.update(0.5);
    const auto [offset, count] = binding.fields.at("time");
    CHECK(count == 1);
    CHECK(binding.getters.at("__address")(&mixer).number == double(reinterpret_cast<uintptr_t>(&mixer)));
    CHECK(*reinterpret_cast<const double*>(reinterpret_cast<const char*>(&mixer) + offset) == 0.5);
}

// A game sets `visible` every frame; the Wasm back end reads it in place, one byte (count 0), and
// skips the engine call when it is unchanged. The Wasm build reads the offsets this 64-bit build
// dumps, so a flag counts from the first flag, not from the object (344 here, 192 in Wasm).
void visible_field() {
    tn::binding::Registry classes;
    tn::binding::registerAll(classes);
    using tn::engine::Object3D;
    const std::pair<const char*, void (Object3D::*)(bool)> flags[] = {
        {"visible", &Object3D::setVisible}, {"castShadow", &Object3D::setCastShadow}, {"receiveShadow", &Object3D::setReceiveShadow}};
    for (const char* name : {"Object3D", "Group", "Mesh", "SkinnedMesh"}) {
        const tn::binding::ClassBinding& binding = classes.at(name);
        for (const auto& [flag, set] : flags) {
            CHECK(binding.fields.count(flag) == 1);
            if (binding.fields.count(flag) == 0) return;
            const auto [offset, count] = binding.fields.at(flag);
            CHECK(count == 0);
            CHECK(offset < 3);
            Object3D object;
            const auto address = static_cast<uintptr_t>(binding.getters.at("__address")(&object).number);
            const auto* byte = reinterpret_cast<const unsigned char*>(address) + offset;
            const bool before = *byte != 0;
            (object.*set)(!before);
            CHECK((*byte != 0) == !before);
            // An unchanged set leaves the revision, so the children keep their world matrices.
            const uint64_t revision = object.revision();
            (object.*set)(!before);
            CHECK(object.revision() == revision);
        }
    }
}

void layers_field() {
    tn::binding::Registry classes;
    tn::binding::registerAll(classes);
    const tn::binding::ClassBinding& binding = classes.at("Layers");
    CHECK(binding.fields.count("mask") == 1);
    if (binding.fields.count("mask") == 0) return;
    const auto [offset, count] = binding.fields.at("mask");
    CHECK(count == 1);
    tn::engine::Layers layers;
    void* self = &layers;
    CHECK(binding.getters.at("__address")(self).number == double(reinterpret_cast<uintptr_t>(self)));
    layers.enable(1);
    double mask = 0;
    std::memcpy(&mask, reinterpret_cast<const char*>(self) + offset, sizeof mask);
    CHECK(mask == 3);
}

void euler_order_field() {
    tn::binding::Registry classes;
    tn::binding::registerAll(classes);
    const tn::binding::ClassBinding& binding = classes.at("Euler");
    CHECK(binding.fields.count("__order") == 1);
    if (binding.fields.count("__order") == 0) return;
    const auto [offset, count] = binding.fields.at("__order");
    CHECK(count == 0);  // one byte, as a bool field is
    tn::engine::Object3D object;
    object.rotation.order = tn::engine::EulerOrder::XZY;
    CHECK(reinterpret_cast<const unsigned char*>(&object.rotation)[offset] == 5);
}

// One `__addresses` call answers each kept member's `__address`, as the member alias answers it.
void object_addresses() {
    tn::binding::Registry classes;
    tn::binding::registerAll(classes);
    for (const char* name : {"Object3D", "Group", "Mesh"}) {
        const tn::binding::ClassBinding& binding = classes.at(name);
        CHECK(binding.getters.count("__addresses") == 1);
        if (binding.getters.count("__addresses") == 0) return;
        tn::engine::Object3D object;
        const auto at = [](const void* member) { return double(reinterpret_cast<uintptr_t>(member)); };
        const std::map<std::string, double> expected = {
            {"__address", binding.getters.at("__address")(&object).number}, {"position", at(&object.position)},
            {"rotation", at(&object.rotation)}, {"quaternion", at(&object.quaternion)}, {"scale", at(&object.scale)},
            {"up", at(&object.up)}, {"matrix", at(&object.matrix)}, {"matrixWorld", at(&object.matrixWorld)},
            {"layers", at(&object.layers())}};
        std::map<std::string, double> got;
        for (const auto& [member, address] : binding.getters.at("__addresses")(&object).fields) got[member] = address.number;
        CHECK(got == expected);
    }
}

// One `__attributes` read answers each attribute, the handle `getAttribute` returns, and its `__shape`.
void geometry_shapes() {
    const tn_version_info_t own = tn_engine_version();
    tn_context_t* ctx = nullptr;
    Diag d;
    CHECK(tn_context_create(&ctx, &own, &d.value) == TN_OK);
    tn_handle_t box{};
    CHECK(tn_construct(ctx, "BoxGeometry", nullptr, 0, &box, &d.value) == TN_OK);
    tn_value_t result{};
    CHECK(tn_get(box, "__attributes", &result, &d.value) == TN_OK);
    CHECK(result.kind == TN_VALUE_RECORD && result.count == 3);  // position, normal, uv
    if (result.kind != TN_VALUE_RECORD) return;
    struct Entry {
        std::string name;
        tn_handle_t handle;
        std::vector<double> shape;
    };
    std::vector<Entry> entries;
    for (uint64_t i = 0; i + 1 < 2 * result.count; i += 2) {
        const tn_value_t& pair = result.values[i + 1];
        CHECK(pair.kind == TN_VALUE_ARRAY && pair.count == 2);
        if (pair.kind != TN_VALUE_ARRAY || pair.count != 2) return;
        CHECK(pair.values[0].kind == TN_VALUE_HANDLE && pair.values[1].kind == TN_VALUE_NUMBERS);
        entries.push_back({text(result.values[i]), pair.values[0].handle,
                           std::vector<double>(pair.values[1].numbers, pair.values[1].numbers + pair.values[1].count)});
    }
    CHECK(entries.size() == 3);
    for (const Entry& entry : entries) {
        tn_value_t name{};
        name.kind = TN_VALUE_STRING;
        name.text = entry.name.c_str();
        name.count = entry.name.size();
        CHECK(tn_invoke(box, "getAttribute", &name, 1, &result, &d.value) == TN_OK);
        CHECK(result.kind == TN_VALUE_HANDLE && same(result.handle, entry.handle));
        CHECK(tn_get(entry.handle, "__shape", &result, &d.value) == TN_OK && result.kind == TN_VALUE_NUMBERS);
        CHECK(std::vector<double>(result.numbers, result.numbers + result.count) == entry.shape);
        CHECK(entry.shape.size() == 4 && entry.shape[1] == (entry.name == "uv" ? 2 : 3));
        // Float data answers as its real class, so `instanceof Float32BufferAttribute` needs no array copy.
        CHECK(entry.handle.type == tn_type_id("Float32BufferAttribute"));
    }
    CHECK(tn_context_destroy(ctx, &d.value) == TN_OK);
}

tn_value_t bytes(const char* type, const void* data, uint64_t count) {
    tn_value_t v{};
    v.kind = TN_VALUE_BYTES;
    v.text = type;
    v.count = count;
    v.bytes = data;
    return v;
}
std::vector<double> numbersOf(tn_handle_t object, const char* name, Diag& d) {
    tn_value_t result{};
    CHECK(tn_get(object, name, &result, &d.value) == TN_OK && result.kind == TN_VALUE_NUMBERS);
    return result.kind == TN_VALUE_NUMBERS ? std::vector<double>(result.numbers, result.numbers + result.count) : std::vector<double>{};
}

// A typed array crosses as its own bytes: an attribute keeps them as its storage, every other
// consumer reads the numbers they hold, and a name that is no typed array is refused.
void typed_bytes() {
    const tn_version_info_t own = tn_engine_version();
    tn_context_t* ctx = nullptr;
    Diag d;
    CHECK(tn_context_create(&ctx, &own, &d.value) == TN_OK);
    tn_handle_t attribute{};
    const float positions[6] = {0.1f, -2.5f, 3, 4, 5, 6};
    const tn_value_t f32[2] = {bytes("Float32Array", positions, 6), num(3)};
    CHECK(tn_construct(ctx, "BufferAttribute", f32, 2, &attribute, &d.value) == TN_OK);
    CHECK(numbersOf(attribute, "array", d) == std::vector<double>(positions, positions + 6));
    CHECK(numbersOf(attribute, "__shape", d) == (std::vector<double>{2, 3, 0, 1015}));

    Calls disposed;
    auto* nativeAttribute = engineObject<tn::engine::BufferAttribute>(attribute);
    nativeAttribute->addEventListener("dispose", [](const tn::engine::Event& event, void* target) {
        CHECK(event.target == static_cast<tn::engine::BufferAttribute*>(target));
    }, nativeAttribute);
    CHECK(tn_set_callback(attribute, "dispose", recordCall, &disposed, releaseCall, &d.value) == TN_OK);
    tn_value_t disposal{};
    for (int i = 0; i < 2; ++i) {
        CHECK(tn_invoke(attribute, "dispose", nullptr, 0, &disposal, &d.value) == TN_OK);
        CHECK(disposal.kind == TN_VALUE_UNDEFINED);
        CHECK(numbersOf(attribute, "array", d) == std::vector<double>(positions, positions + 6));
    }
    CHECK(disposed.invoked == 2 && disposed.count == 1);
    CHECK(tn_set_callback(attribute, "dispose", nullptr, nullptr, nullptr, &d.value) == TN_OK);
    CHECK(disposed.released == 1);
    CHECK(tn_invoke(attribute, "dispose", nullptr, 0, &disposal, &d.value) == TN_OK);
    CHECK(disposed.invoked == 2);

    const uint16_t index[3] = {0, 65535, 7};
    const tn_value_t u16[2] = {bytes("Uint16Array", index, 3), num(1)};
    CHECK(tn_construct(ctx, "BufferAttribute", u16, 2, &attribute, &d.value) == TN_OK);
    CHECK(numbersOf(attribute, "array", d) == (std::vector<double>{0, 65535, 7}));
    tn_value_t result{};
    const tn_value_t wraps[2] = {num(0), num(70000)};  // u16 storage, as the typed array chose: 70000 wraps
    CHECK(tn_invoke(attribute, "setX", wraps, 2, &result, &d.value) == TN_OK);
    CHECK(numbersOf(attribute, "array", d) == (std::vector<double>{70000 - 65536, 65535, 7}));

    const int16_t packed[2] = {-3, 300};  // no exact storage: read as numbers into float storage
    const tn_value_t i16[2] = {bytes("Int16Array", packed, 2), num(2)};
    CHECK(tn_construct(ctx, "BufferAttribute", i16, 2, &attribute, &d.value) == TN_OK);
    CHECK(numbersOf(attribute, "array", d) == (std::vector<double>{-3, 300}));

    tn_handle_t m{};
    CHECK(tn_construct(ctx, "Matrix4", nullptr, 0, &m, &d.value) == TN_OK);
    double elements[16] = {1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1};
    const tn_value_t f64 = bytes("Float64Array", elements, 16);
    CHECK(tn_invoke(m, "fromArray", &f64, 1, &result, &d.value) == TN_OK);
    CHECK(numbersOf(m, "elements", d) == std::vector<double>(elements, elements + 16));

    const tn_value_t unknown = bytes("BigInt64Array", elements, 2);
    CHECK(tn_invoke(m, "fromArray", &unknown, 1, &result, &d.value) == TN_ERROR_INVALID_ARGUMENT);
    // No bytes with a count: an attribute that keeps that storage type takes the count, zeroed, and the
    // caller defers its contents (tnw_attribute_defer); anything else is refused.
    const tn_value_t missing = bytes("Float32Array", nullptr, 2);
    CHECK(tn_construct(ctx, "BufferAttribute", &missing, 1, &attribute, &d.value) == TN_OK);
    CHECK(numbersOf(attribute, "array", d) == (std::vector<double>{0, 0}));
    CHECK(tn_invoke(m, "fromArray", &missing, 1, &result, &d.value) == TN_ERROR_INVALID_ARGUMENT);
    const tn_value_t converted = bytes("Int16Array", nullptr, 2);
    CHECK(tn_construct(ctx, "BufferAttribute", &converted, 1, &attribute, &d.value) != TN_OK);
    CHECK(tn_context_destroy(ctx, &d.value) == TN_OK);
}

// fromArray(array, offset) reads the lanes that start at offset, as three's does: a mat4 built from four vec4 columns
// fills column k from offset 4k of the camera matrix, and every column read the first four lanes before this check.
// A window that leaves the array is refused, where a read past the end used to take whatever followed it.
void array_offset() {
    const tn_version_info_t own = tn_engine_version();
    tn_context_t* ctx = nullptr;
    Diag d;
    CHECK(tn_context_create(&ctx, &own, &d.value) == TN_OK);
    double lanes[20];
    for (int i = 0; i < 20; ++i) lanes[i] = i + 1;
    const tn_value_t array = bytes("Float64Array", lanes, 20);
    tn_value_t result_{};
    const auto toArray = [&](tn_handle_t object) {
        tn_value_t result{};
        CHECK(tn_invoke(object, "toArray", nullptr, 0, &result, &d.value) == TN_OK && result.kind == TN_VALUE_NUMBERS);
        return std::vector<double>(result.numbers, result.numbers + result.count);
    };
    const auto window = [&](double first, size_t count) {
        std::vector<double> out;
        for (size_t i = 0; i < count; ++i) out.push_back(first + static_cast<double>(i));
        return out;
    };
    // class name, lane count: the offset 2 window starts at the third lane of 1, 2, 3, ...
    const std::pair<const char*, size_t> classes[] = {{"Vector2", 2}, {"Vector3", 3}, {"Vector4", 4}, {"Quaternion", 4},
                                                      {"Color", 3}, {"Matrix3", 9}, {"Matrix4", 16}};
    for (const auto& [name, count] : classes) {
        tn_handle_t object{};
        CHECK(tn_construct(ctx, name, nullptr, 0, &object, &d.value) == TN_OK);
        const tn_value_t args[2] = {array, num(2)};
        CHECK(tn_invoke(object, "fromArray", args, 2, &result_, &d.value) == TN_OK);
        CHECK(toArray(object) == window(3, count));
        const tn_value_t start[2] = {array, num(static_cast<double>(20 - count))};
        CHECK(tn_invoke(object, "fromArray", start, 2, &result_, &d.value) == TN_OK);
        CHECK(toArray(object) == window(static_cast<double>(21 - count), count));
        const tn_value_t past[2] = {array, num(static_cast<double>(21 - count))};
        CHECK(tn_invoke(object, "fromArray", past, 2, &result_, &d.value) == TN_ERROR_INVALID_ARGUMENT);
        const tn_value_t negative[2] = {array, num(-1)};
        CHECK(tn_invoke(object, "fromArray", negative, 2, &result_, &d.value) == TN_ERROR_INVALID_ARGUMENT);
        const tn_value_t fractional[2] = {array, num(0.5)};
        CHECK(tn_invoke(object, "fromArray", fractional, 2, &result_, &d.value) == TN_ERROR_INVALID_ARGUMENT);
        // The refusals changed nothing, and no offset still means offset 0.
        CHECK(toArray(object) == window(static_cast<double>(21 - count), count));
        CHECK(tn_invoke(object, "fromArray", &array, 1, &result_, &d.value) == TN_OK);
        CHECK(toArray(object) == window(1, count));
    }
    CHECK(tn_context_destroy(ctx, &d.value) == TN_OK);
}

// A DataTexture keeps a typed array's bytes when they are already its stored layout, as three
// uploads them: a Float32Array's bits (a signalling NaN included), a Uint16Array's binary16 bits, a
// Uint8Array's bytes. Any other array still converts value by value, and half floats still check.
void data_texture_bytes() {
    const tn_version_info_t own = tn_engine_version();
    tn_context_t* ctx = nullptr;
    Diag d;
    CHECK(tn_context_create(&ctx, &own, &d.value) == TN_OK);
    const auto texels = [&](const tn_value_t& data, double type) {
        const tn_value_t args[5] = {data, num(1), num(1), num(1023), num(type)};
        tn_handle_t texture{};
        if (tn_construct(ctx, "DataTexture", args, 5, &texture, &d.value) != TN_OK) return std::vector<uint8_t>{};
        return engineObject<tn::engine::DataTexture>(texture)->data;
    };
    const auto same = [](const std::vector<uint8_t>& data, const void* expected, size_t size) {
        return data.size() == size && std::memcmp(data.data(), expected, size) == 0;
    };
    const uint32_t floats[4] = {0x7f800001u, 0x80000000u, 0x3f000000u, 0x3f800000u};  // sNaN, -0, 0.5, 1
    CHECK(same(texels(bytes("Float32Array", floats, 4), 1015), floats, sizeof(floats)));
    const uint16_t halves[4] = {0x3c00, 0x8000, 0x7e01, 0xffff};
    CHECK(same(texels(bytes("Uint16Array", halves, 4), 1016), halves, sizeof(halves)));
    const uint8_t rgba[4] = {0, 1, 128, 255};
    CHECK(same(texels(bytes("Uint8Array", rgba, 4), 1009), rgba, sizeof(rgba)));
    const int16_t wide[4] = {-5, 300, 7, 255};  // no byte layout: clamped value by value
    const uint8_t clamped[4] = {0, 255, 7, 255};
    CHECK(same(texels(bytes("Int16Array", wide, 4), 1009), clamped, sizeof(clamped)));
    const float notHalf[4] = {0.5f, 0, 0, 1};
    CHECK(texels(bytes("Float32Array", notHalf, 4), 1016).empty());

    // `image.data = array` keeps the bytes the same way, and the new texels wait for needsUpdate.
    const float zeros[4] = {};
    const tn_value_t args[5] = {bytes("Float32Array", zeros, 4), num(1), num(1), num(1023), num(1015)};
    tn_handle_t texture{};
    CHECK(tn_construct(ctx, "DataTexture", args, 5, &texture, &d.value) == TN_OK);
    auto* data = engineObject<tn::engine::DataTexture>(texture);
    const uint32_t version = data->version();
    const tn_value_t image = bytes("Float32Array", floats, 4);
    CHECK(tn_set(texture, "image.data", &image, &d.value) == TN_OK);
    CHECK(same(data->data, floats, sizeof(floats)));
    CHECK(data->version() == version);
    const tn_value_t short_ = bytes("Float32Array", floats, 3);
    CHECK(tn_set(texture, "image.data", &short_, &d.value) != TN_OK);
    const tn_value_t deferred = bytes("Float32Array", nullptr, 4);
    CHECK(tn_set(texture, "image.data", &deferred, &d.value) != TN_OK);
    const tn_value_t cubeArgs[4] = {bytes("Float32Array", zeros, 4), num(1), num(1), num(1)};
    tn_handle_t cube{};
    CHECK(tn_construct(ctx, "Data3DTexture", cubeArgs, 4, &cube, &d.value) == TN_OK);
    const auto halfType = num(1016);
    CHECK(tn_set(cube, "type", &halfType, &d.value) == TN_OK);
    const auto halfData = bytes("Uint16Array", halves, 4);
    CHECK(tn_set(cube, "image.data", &halfData, &d.value) == TN_OK);
    const auto* cubeData = engineObject<tn::engine::DataTexture>(cube);
    CHECK(cubeData && cubeData->type == 1016 && same(cubeData->data, halves, sizeof(halves)));

    // DataArrayTexture(data, width, height, depth): the typed array's bytes, `depth` layers, an array flag.
    const uint8_t layerBytes[2 * 2 * 3 * 4] = {1, 2, 3, 4};
    const tn_value_t layerArgs[4] = {bytes("Uint8Array", layerBytes, sizeof(layerBytes)), num(2), num(2), num(3)};
    tn_handle_t layers{};
    CHECK(tn_construct(ctx, "DataArrayTexture", layerArgs, 4, &layers, &d.value) == TN_OK);
    const auto* layerData = engineObject<tn::engine::DataTexture>(layers);
    CHECK(layerData && layerData->array && !layerData->volume && layerData->depth == 3 && layerData->hasImage());
    CHECK(layerData && same(layerData->data, layerBytes, sizeof(layerBytes)));
    const tn_value_t shortLayers[4] = {bytes("Uint8Array", layerBytes, 2 * 2 * 2 * 4), num(2), num(2), num(3)};
    tn_handle_t refusedLayers{};
    CHECK(tn_construct(ctx, "DataArrayTexture", shortLayers, 4, &refusedLayers, &d.value) != TN_OK);

    CHECK(tn_context_destroy(ctx, &d.value) == TN_OK);
}

// The Wasm view reports the store's write count (out[3]): a write through the view, which the JS
// mirror made itself, leaves it; an engine write moves it.
void attribute_view_writes() {
    const tn_version_info_t own = tn_engine_version();
    tn_context_t* ctx = nullptr;
    Diag d;
    CHECK(tn_context_create(&ctx, &own, &d.value) == TN_OK);
    tn_handle_t attribute{};
    const float positions[3] = {1, 2, 3};
    const tn_value_t f32[2] = {bytes("Float32Array", positions, 3), num(3)};
    CHECK(tn_construct(ctx, "BufferAttribute", f32, 2, &attribute, &d.value) == TN_OK);
    uint64_t out[4] = {};
    uintptr_t lease = tnw_attribute_view(&attribute, out);
    CHECK(lease != 0 && out[1] == 3);
    const uint64_t seen = out[3];
    reinterpret_cast<float*>(static_cast<uintptr_t>(out[0]))[1] = 9;
    tnw_attribute_view_release(lease);
    lease = tnw_attribute_view(&attribute, out);
    CHECK(out[3] == seen);
    tnw_attribute_view_release(lease);
    CHECK(numbersOf(attribute, "array", d) == (std::vector<double>{1, 9, 3}));
    tn_value_t result{};
    const tn_value_t set[2] = {num(0), num(5)};
    CHECK(tn_invoke(attribute, "setX", set, 2, &result, &d.value) == TN_OK);
    lease = tnw_attribute_view(&attribute, out);
    CHECK(out[3] != seen);
    tnw_attribute_view_release(lease);
    CHECK(tn_context_destroy(ctx, &d.value) == TN_OK);
}

std::vector<uintptr_t> pulled;
std::vector<uintptr_t> forgotten;

// The Wasm back end defers writing its copy of an attribute's array: the store calls the pull
// trampoline with the key, data, count and Scalar before the engine next reads it, and the forget
// trampoline when it dies still deferred.
void attribute_defer() {
    const tn_version_info_t own = tn_engine_version();
    tn_context_t* ctx = nullptr;
    Diag d;
    CHECK(tn_context_create(&ctx, &own, &d.value) == TN_OK);
    tn_handle_t attribute{};
    const float positions[3] = {1, 2, 3};
    const tn_value_t f32[2] = {bytes("Float32Array", positions, 3), num(3)};
    CHECK(tn_construct(ctx, "BufferAttribute", f32, 2, &attribute, &d.value) == TN_OK);
    uint32_t (*pull)(uintptr_t, uintptr_t, uint32_t, uint32_t) = [](uintptr_t key, uintptr_t data, uint32_t count,
                                                                      uint32_t scalar) -> uint32_t {
        CHECK(count == 3 && scalar == 0);
        reinterpret_cast<float*>(data)[2] = 9;
        pulled.push_back(key);
        return count;
    };
    void (*forget)(uintptr_t) = [](uintptr_t key) { forgotten.push_back(key); };
    const uintptr_t key =
        tnw_attribute_defer(&attribute, reinterpret_cast<uintptr_t>(pull), reinterpret_cast<uintptr_t>(forget));
    CHECK(key != 0 && pulled.empty());
    CHECK(numbersOf(attribute, "array", d) == (std::vector<double>{1, 2, 9}));
    CHECK(pulled == std::vector<uintptr_t>{key});
    CHECK(numbersOf(attribute, "array", d) == (std::vector<double>{1, 2, 9}));
    CHECK(pulled.size() == 1);
    CHECK(tnw_attribute_defer(&attribute, reinterpret_cast<uintptr_t>(pull), reinterpret_cast<uintptr_t>(forget)) ==
          key);
    CHECK(tn_object_release(attribute, &d.value) == TN_OK);
    CHECK(forgotten == std::vector<uintptr_t>{key} && pulled.size() == 1);
    tn_handle_t scene{};
    CHECK(tn_construct(ctx, "Scene", nullptr, 0, &scene, &d.value) == TN_OK);
    CHECK(tnw_attribute_defer(&scene, reinterpret_cast<uintptr_t>(pull), reinterpret_cast<uintptr_t>(forget)) == 0);
    CHECK(tn_context_destroy(ctx, &d.value) == TN_OK);
}

// Midway cockpit: a game keys a batch, a cache or a dedupe map by `material.uuid`. An unbound uuid read
// as undefined, so every material shared one key and a cockpit merged into its first material.
void material_uuid() {
    const tn_version_info_t own = tn_engine_version();
    tn_context_t* ctx = nullptr;
    Diag d;
    CHECK(tn_context_create(&ctx, &own, &d.value) == TN_OK);
    const auto uuidOf = [&](tn_handle_t handle) {
        tn_value_t out{};
        CHECK(tn_get(handle, "uuid", &out, &d.value) == TN_OK && out.kind == TN_VALUE_STRING);
        return text(out);
    };
    const auto v4 = [](const std::string& u) {
        return u.size() == 36 && u[8] == '-' && u[13] == '-' && u[14] == '4' && u[18] == '-' &&
               std::strchr("89ab", u[19]) != nullptr && u[23] == '-';
    };
    tn_handle_t a{}, b{}, standard{}, geometry{}, other{};
    CHECK(tn_construct(ctx, "MeshBasicMaterial", nullptr, 0, &a, &d.value) == TN_OK);
    CHECK(tn_construct(ctx, "MeshBasicMaterial", nullptr, 0, &b, &d.value) == TN_OK);
    CHECK(tn_construct(ctx, "MeshStandardMaterial", nullptr, 0, &standard, &d.value) == TN_OK);
    CHECK(tn_construct(ctx, "BufferGeometry", nullptr, 0, &geometry, &d.value) == TN_OK);
    CHECK(tn_construct(ctx, "BufferGeometry", nullptr, 0, &other, &d.value) == TN_OK);
    const std::string ua = uuidOf(a);
    CHECK(v4(ua) && uuidOf(a) == ua);  // three's format, stable across reads
    CHECK(uuidOf(b) != ua && uuidOf(standard) != ua && uuidOf(standard) != uuidOf(b));
    CHECK(v4(uuidOf(geometry)) && uuidOf(geometry) != uuidOf(other));
    tn_value_t out{};
    CHECK(tn_invoke(a, "clone", nullptr, 0, &out, &d.value) == TN_OK && out.kind == TN_VALUE_HANDLE);
    CHECK(uuidOf(out.handle) != ua);  // a clone is another material
    CHECK(tn_context_destroy(ctx, &d.value) == TN_OK);
}

void material_alpha_hash() {
    const tn_version_info_t own = tn_engine_version();
    tn_context_t* ctx = nullptr;
    Diag d;
    CHECK(tn_context_create(&ctx, &own, &d.value) == TN_OK);
    tn_handle_t material{};
    CHECK(tn_construct(ctx, "MeshStandardMaterial", nullptr, 0, &material, &d.value) == TN_OK);
    tn_value_t value{};
    CHECK(tn_get(material, "alphaHash", &value, &d.value) == TN_OK);
    CHECK(value.kind == TN_VALUE_BOOL && !value.boolean);
    const tn_value_t enabled = boolean(true);
    CHECK(tn_set(material, "alphaHash", &enabled, &d.value) == TN_OK);
    CHECK(tn_get(material, "alphaHash", &value, &d.value) == TN_OK);
    CHECK(value.kind == TN_VALUE_BOOL && value.boolean);
    CHECK(tn_invoke(material, "clone", nullptr, 0, &value, &d.value) == TN_OK);
    CHECK(value.kind == TN_VALUE_HANDLE);
    CHECK(tn_get(value.handle, "alphaHash", &value, &d.value) == TN_OK);
    CHECK(value.kind == TN_VALUE_BOOL && value.boolean);
    CHECK(tn_context_destroy(ctx, &d.value) == TN_OK);
}

// three's `geometry.setIndex(null)` removes the index (core's mergeParts deindexes this way); the web
// platformer failed to start on it with TN_NATIVE_UNSUPPORTED.
void geometry_index_null() {
    const tn_version_info_t own = tn_engine_version();
    tn_context_t* ctx = nullptr;
    Diag d;
    CHECK(tn_context_create(&ctx, &own, &d.value) == TN_OK);
    tn_handle_t geometry{};
    CHECK(tn_construct(ctx, "BufferGeometry", nullptr, 0, &geometry, &d.value) == TN_OK);
    const double indices[] = {0, 1, 2};
    tn_value_t list{};
    list.kind = TN_VALUE_NUMBERS;
    list.numbers = indices;
    list.count = 3;
    tn_value_t out{};
    CHECK(tn_invoke(geometry, "setIndex", &list, 1, &out, &d.value) == TN_OK);
    CHECK(tn_invoke(geometry, "getIndex", nullptr, 0, &out, &d.value) == TN_OK && out.kind == TN_VALUE_HANDLE);
    const tn_value_t none{};  // TN_VALUE_NULL
    CHECK(none.kind == TN_VALUE_NULL);
    CHECK(tn_invoke(geometry, "setIndex", &none, 1, &out, &d.value) == TN_OK);
    CHECK(tn_invoke(geometry, "getIndex", nullptr, 0, &out, &d.value) == TN_OK && out.kind == TN_VALUE_NULL);
    CHECK(tn_context_destroy(ctx, &d.value) == TN_OK);
}

// three's localToWorld(v) and worldToLocal(v) answer the vector they converted, so a call chains
// (`mesh.worldToLocal(point).multiplyScalar(2)`); the binding answered the object, which broke the
// racing template on the web native engine.
void world_space_conversions() {
    const tn_version_info_t own = tn_engine_version();
    tn_context_t* ctx = nullptr;
    Diag d;
    CHECK(tn_context_create(&ctx, &own, &d.value) == TN_OK);
    tn_handle_t group{}, point{};
    CHECK(tn_construct(ctx, "Group", nullptr, 0, &group, &d.value) == TN_OK);
    CHECK(tn_construct(ctx, "Vector3", nullptr, 0, &point, &d.value) == TN_OK);
    const tn_value_t pointArg = ref(point);
    for (const char* method : {"localToWorld", "worldToLocal"}) {
        tn_value_t out{};
        CHECK(tn_invoke(group, method, &pointArg, 1, &out, &d.value) == TN_OK);
        CHECK(out.kind == TN_VALUE_HANDLE && same(out.handle, point));
    }
    CHECK(tn_context_destroy(ctx, &d.value) == TN_OK);
}

// PRD-610: core's per-frame `__tnUpdateMatrixWorld(force, prune)` answers the nodes its own walk visited, so no
// second walk counts the tree. With `prune` a hidden subtree composes only its root, as core's JS pass does
// (9,903 nodes a Midway frame against 779): its world matrices catch up, forced, on the first frame it shows.
// A hidden node with a Bone under it is walked whole, because a visible SkinnedMesh draws with those matrices,
// and a subtree core froze with markStatic is a leaf (its JS pass stops there too).
void matrix_walk_count() {
    const tn_version_info_t own = tn_engine_version();
    tn_context_t* ctx = nullptr;
    Diag d;
    CHECK(tn_context_create(&ctx, &own, &d.value) == TN_OK);
    tn_handle_t scene{}, group{}, mesh{}, rig{}, bone{};
    CHECK(tn_construct(ctx, "Scene", nullptr, 0, &scene, &d.value) == TN_OK);
    CHECK(tn_construct(ctx, "Group", nullptr, 0, &group, &d.value) == TN_OK);
    CHECK(tn_construct(ctx, "Mesh", nullptr, 0, &mesh, &d.value) == TN_OK);
    CHECK(tn_construct(ctx, "Group", nullptr, 0, &rig, &d.value) == TN_OK);
    CHECK(tn_construct(ctx, "Bone", nullptr, 0, &bone, &d.value) == TN_OK);
    tn_value_t out{};
    const tn_value_t groupArg = ref(group), meshArg = ref(mesh), rigArg = ref(rig), boneArg = ref(bone);
    CHECK(tn_invoke(scene, "add", &groupArg, 1, &out, &d.value) == TN_OK);
    CHECK(tn_invoke(group, "add", &meshArg, 1, &out, &d.value) == TN_OK);
    const auto walk = [&](bool prune) {
        const tn_value_t args[] = {boolean(false), boolean(prune)};
        tn_value_t walked{};
        CHECK(tn_invoke(scene, "__tnUpdateMatrixWorld", args, 2, &walked, &d.value) == TN_OK);
        CHECK(walked.kind == TN_VALUE_NUMBER);
        return walked.number;
    };
    CHECK(walk(true) == 3 && walk(true) == 3);
    auto* groupObject = engineObject<tn::engine::Object3D>(group);
    tn_handle_t snapshotHandle{};
    CHECK(tn_construct(ctx, "Matrix4", nullptr, 0, &snapshotHandle, &d.value) == TN_OK);
    const tn_value_t snapshotArg = ref(snapshotHandle);
    auto* snapshot = engineObject<tn::engine::Matrix4>(snapshotHandle);
    const auto initialWorld = groupObject->matrixWorld;
    const std::array<double, 16> exactWorld{-2, .25, .5, 0, .75, 3, 1.25, 0, -.5, .125, 4, 0, 7, -8, 9, 1};
    groupObject->matrixWorld.elements = exactWorld;
    const auto* nativeFlags = groupObject->ownTransformTracking();
    CHECK(nativeFlags[0] == 0 && nativeFlags[2] == 1);
    CHECK(tn_invoke(group, "__tnCopyMatrixWorld", &snapshotArg, 1, &out, &d.value) == TN_OK);
    CHECK(snapshot->elements == exactWorld && nativeFlags[0] == 0 && nativeFlags[2] == 1);
    groupObject->enableTrackedTransform();
    CHECK(tn_invoke(group, "__tnCopyMatrixWorld", &snapshotArg, 1, &out, &d.value) == TN_OK);
    CHECK(snapshot->elements == exactWorld && nativeFlags[0] == 1 && nativeFlags[2] == 0);
    groupObject->matrixWorld.elements[12] = 99;
    CHECK(snapshot->elements == exactWorld);
    CHECK(tn_invoke(group, "__tnCopyMatrixWorld", nullptr, 0, &out, &d.value) == TN_ERROR_INVALID_ARGUMENT);
    CHECK(tn_invoke(group, "__tnCopyMatrixWorld", &meshArg, 1, &out, &d.value) == TN_ERROR_UNSUPPORTED);
    CHECK(nativeFlags[2] == 0 && snapshot->elements == exactWorld);
    groupObject->matrixWorld.copy(initialWorld);
    groupObject->enableTrackedTransform();
    auto* tracking = tn::engine::Object3D::transformTrackingAddress(&groupObject->position);
    for (const char* path : {"position.x", "scale.y", "matrixAutoUpdate", "matrixWorldAutoUpdate", "matrixWorldNeedsUpdate"}) {
        const tn_value_t value = std::strcmp(path, "position.x") == 0 ? num(0) :
            std::strcmp(path, "scale.y") == 0 ? num(1) : boolean(true);
        tracking[1] = 0;
        CHECK(tn_set(group, path, &value, &d.value) == TN_OK);
        CHECK(tracking[1] == 1);
        CHECK(tracking[2] == 0);
    }
    tn_value_t addresses{};
    CHECK(tn_get(group, "__addresses", &addresses, &d.value) == TN_OK);
    CHECK(tracking[2] == 1);
    groupObject->enableTrackedTransform();
    CHECK(tracking[2] == 1);
    auto* meshNative = engineObject<tn::engine::Object3D>(mesh);
    meshNative->enableTrackedTransform();
    auto* meshTracking = tn::engine::Object3D::transformTrackingAddress(&meshNative->position);
    tn_value_t position{}, address{};
    CHECK(tn_get(mesh, "position", &position, &d.value) == TN_OK && position.kind == TN_VALUE_HANDLE);
    CHECK(meshTracking[2] == 0);
    CHECK(tn_get(position.handle, "__address", &address, &d.value) == TN_OK);
    CHECK(address.kind == TN_VALUE_NUMBER && address.number == double(reinterpret_cast<uintptr_t>(&meshNative->position)));
    CHECK(meshTracking[2] == 1);
    // A hidden group composes itself and stops: its mesh is not visited, pruned or not asked to prune.
    const tn_value_t hidden = boolean(false), shown = boolean(true);
    CHECK(tn_set(group, "visible", &hidden, &d.value) == TN_OK);
    CHECK(walk(true) == 2);
    CHECK(walk(false) == 3);
    // The group moves while hidden: the mesh's world matrix waits, then catches up the frame the group shows.
    auto* meshObject = engineObject<tn::engine::Object3D>(mesh);
    CHECK(walk(true) == 2);
    engineObject<tn::engine::Object3D>(group)->position.x = 5;
    CHECK(walk(true) == 2);
    CHECK(meshObject->matrixWorld.elements[12] == 0);
    CHECK(tn_set(group, "visible", &shown, &d.value) == TN_OK);
    CHECK(walk(true) == 3);
    CHECK(meshObject->matrixWorld.elements[12] == 5);
    // A hidden rig is walked whole: a skinned mesh elsewhere draws with its bones.
    CHECK(tn_invoke(scene, "add", &rigArg, 1, &out, &d.value) == TN_OK);
    CHECK(tn_invoke(rig, "add", &boneArg, 1, &out, &d.value) == TN_OK);
    CHECK(tn_set(rig, "visible", &hidden, &d.value) == TN_OK);
    CHECK(walk(true) == 5);
    // A subtree frozen by core's markStatic (`static` on, the root's matrixWorldAutoUpdate off) is a leaf, in
    // either mode: its matrices were composed when it froze. Re-armed (the world compose back on), it is walked.
    const tn_value_t on = boolean(true), off = boolean(false);
    CHECK(tn_set(rig, "visible", &shown, &d.value) == TN_OK);
    CHECK(tn_set(group, "static", &on, &d.value) == TN_OK && tn_set(mesh, "static", &on, &d.value) == TN_OK);
    CHECK(walk(true) == 5);  // static alone is three's renderer hint, not a freeze
    CHECK(tn_set(group, "matrixWorldAutoUpdate", &off, &d.value) == TN_OK);
    CHECK(walk(true) == 4 && walk(false) == 4);
    tn_value_t flagValue{};
    CHECK(tn_get(group, "static", &flagValue, &d.value) == TN_OK && flagValue.kind == TN_VALUE_BOOL && flagValue.boolean);
    CHECK(tn_set(group, "matrixWorldAutoUpdate", &on, &d.value) == TN_OK);
    CHECK(walk(true) == 5);
    CHECK(tn_context_destroy(ctx, &d.value) == TN_OK);
}

// PRD-610: the player draws in C++ after core's beforeRender restored its cull, so it holds the restore until it
// has drawn; held or not, the cull's hides are undone exactly once.
void projected_cull_held_restore() {
    using namespace tn::engine;
    auto scene = std::make_shared<Scene>();
    auto mesh = std::make_shared<Mesh>(std::make_shared<BufferGeometry>(), nullptr);
    auto position = std::make_shared<BufferAttribute>(Scalar::F32, 6, 3);
    position->setXYZ(0, -0.01, 0, 0).setXYZ(1, 0.01, 0, 0);
    mesh->geometry->setAttribute("position", position);
    mesh->position.z = -1000;
    scene->add(*mesh);
    PerspectiveCamera camera(50, 1, 0.1, 5000);
    camera.updateMatrixWorld();
    scene->updateMatrixWorld();
    ProjectedCull cull;
    CHECK(cull.apply(*scene, camera, true, 720, 2, true).culled == 1);
    CHECK(!mesh->visible());
    ProjectedCull::holdRestores(true);
    cull.restoreAfterDraw();
    CHECK(!mesh->visible());
    ProjectedCull::releaseHeld();
    CHECK(mesh->visible());
    ProjectedCull::holdRestores(false);
    CHECK(cull.apply(*scene, camera, true, 720, 2, true).culled == 1);
    cull.restoreAfterDraw();
    CHECK(mesh->visible());
    ProjectedCull::holdRestores(false);
    // The ABI's core-facing restore must honor the same host hold.
    tn_context_t* ctx = nullptr;
    Diag d;
    const tn_version_info_t version = tn_engine_version();
    CHECK(tn_context_create(&ctx, &version, &d.value) == TN_OK);
    const auto root = tn::abi::shareObject(ctx, "Scene", scene);
    const auto view = tn::abi::shareObject(ctx, "PerspectiveCamera", std::make_shared<PerspectiveCamera>(50, 1, 0.1, 5000));
    const tn_value_t args[] = {ref(view), boolean(true), num(720), num(2), boolean(true)};
    tn_value_t out{};
    CHECK(tn_invoke(root, "__cullProjected", args, 5, &out, &d.value) == TN_OK);
    CHECK(!mesh->visible());
    ProjectedCull::holdRestores(true);
    CHECK(tn_invoke(root, "__restoreCull", nullptr, 0, &out, &d.value) == TN_OK);
    CHECK(!mesh->visible());
    ProjectedCull::releaseHeld();
    CHECK(mesh->visible());
    ProjectedCull::holdRestores(false);
    CHECK(tn_context_destroy(ctx, &d.value) == TN_OK);
}

// PRD-610 AC-4: the projected-size cull reads a flat list of the tree, built once per hierarchy version, instead
// of comparing type strings and casting every node every frame (7.7% of a Midway tick). The answer is the same:
// a hidden subtree is skipped whole, a sub-threshold mesh is hidden for the frame, and an added mesh is seen.
void projected_cull_list() {
    using namespace tn::engine;
    auto scene = std::make_shared<Scene>();
    auto group = std::make_shared<Object3D>();
    auto geometry = std::make_shared<BufferGeometry>();
    auto narrow = std::make_shared<BufferAttribute>(Scalar::F32, 6, 3);
    narrow->setXYZ(0, -0.01, 0, 0).setXYZ(1, 0.01, 0, 0);
    geometry->setAttribute("position", narrow);
    auto nearMesh = std::make_shared<Mesh>(geometry, nullptr);
    auto farMesh = std::make_shared<Mesh>(geometry, nullptr);
    nearMesh->position.z = -2;
    farMesh->position.z = -1000;
    scene->add(*group);
    group->add(*nearMesh);
    group->add(*farMesh);
    PerspectiveCamera camera(50, 1, 0.1, 5000);
    camera.updateMatrixWorld();
    scene->updateMatrixWorld();
    const double scale = 720 / (2 * std::tan(25 * 3.141592653589793 / 180));
    ProjectedCull cull;
    for (int frame = 0; frame < 6; ++frame) {
        const auto report = cull.apply(*scene, camera, true, scale, 2, true);
        CHECK(report.considered == 2 && report.culled == 1);
        CHECK(nearMesh->visible() && !farMesh->visible());
    }
    CHECK(cull.rebuilds() == 1);  // six frames, one walk of the tree
    group->setVisible(false);
    CHECK(cull.apply(*scene, camera, true, scale, 2, true).considered == 0);
    group->setVisible(true);
    CHECK(cull.apply(*scene, camera, true, scale, 2, true).considered == 2);
    CHECK(cull.rebuilds() == 1);  // visibility is not a hierarchy change
    auto added = std::make_shared<Mesh>(geometry, nullptr);
    added->position.z = -3;
    scene->add(*added);
    scene->updateMatrixWorld();
    const auto report = cull.apply(*scene, camera, true, scale, 2, true);
    CHECK(report.considered == 3 && report.culled == 1 && cull.rebuilds() == 2);
    cull.restore();
    CHECK(farMesh->visible());
    // A position attribute swapped on the geometry is read, not the one cached before it: the larger
    // bound it gives keeps the far mesh above the pixel threshold.
    auto wide = std::make_shared<BufferAttribute>(Scalar::F32, 6, 3);
    wide->setXYZ(0, -50, -50, -50).setXYZ(1, 50, 50, 50);
    wide->setNeedsUpdate();
    geometry->setAttribute("position", wide);
    CHECK(cull.apply(*scene, camera, true, scale, 2, true).culled == 0);
    cull.restore();
    CHECK(ProjectedCull::cpuTiming.calls == 0 && ProjectedCull::cpuTiming.clock == nullptr);
    ProjectedCull::cpuTiming = {[]() { static double ms = 0; return ms += 0.25; }};
    for (int call = 0; call < 6; ++call) cull.apply(*scene, camera, true, scale, 2, true);
    CHECK(ProjectedCull::cpuTiming.calls == 6 && ProjectedCull::cpuTiming.ms == 1.5);
    cull.restore();
    CHECK(ProjectedCull::cpuTiming.calls == 6 && ProjectedCull::cpuTiming.ms == 1.5);
    ProjectedCull::cpuTiming = {ProjectedCull::cpuTiming.clock};
    cull.apply(*scene, camera, true, scale, 2, true);
    CHECK(ProjectedCull::cpuTiming.calls == 1 && ProjectedCull::cpuTiming.ms == 0.25);
    ProjectedCull::cpuTiming = {[]() { return -1.0; }};
    cull.apply(*scene, camera, true, scale, 2, true);
    CHECK(!ProjectedCull::cpuTiming.available && ProjectedCull::cpuTiming.calls == 1);
    ProjectedCull::cpuTiming = {};
}

}  // namespace

void gpu_bind_escape() {
    const tn_version_info_t own = tn_engine_version();
    tn_context_t* ctx = nullptr; Diag d;
    CHECK(tn_context_create(&ctx, &own, &d.value) == TN_OK);
    tn_handle_t mesh{}, skeleton{};
    CHECK(tn_construct(ctx, "SkinnedMesh", nullptr, 0, &mesh, &d.value) == TN_OK);
    CHECK(tn_construct(ctx, "Skeleton", nullptr, 0, &skeleton, &d.value) == TN_OK);
    auto* rig = static_cast<tn::engine::SkinnedMesh*>(tn::abi::objectOf(mesh)->ptr.get());
    auto valid = std::make_shared<bool>(true); rig->gpuSkinValidity = valid;
    tn_value_t result{};
    CHECK(!rig->gpuBindExposed);
    CHECK(tn_get(mesh, "bindMatrix", &result, &d.value) == TN_OK);
    CHECK(rig->gpuBindExposed && !*valid && result.kind == TN_VALUE_HANDLE);
    *valid = true;
    CHECK(tn_get(mesh, "bindMatrixInverse", &result, &d.value) == TN_OK && !*valid);
    auto* nativeSkeleton = static_cast<tn::engine::Skeleton*>(tn::abi::objectOf(skeleton)->ptr.get());
    nativeSkeleton->gpuSkinValidity = valid; *valid = true;
    CHECK(tn_get(skeleton, "boneMatrices", &result, &d.value) == TN_OK && !*valid);
    CHECK(tn_context_destroy(ctx, &d.value) == TN_OK);
}


// PRD-617: a Fn result that ran statements (rain's baseColor: toVar, an If chain, `return res`) is one
// Body node. Lowering it at every use re-ran its assignments after the first read, so a later consumer
// (surfaceLight's lamp loop) saw a different value than the first and the conifers came out red. Its
// statements lower once per scope; every use reads the variable.
void body_result_lowers_once() {
    namespace g = tn::engine::shader::graph;
    using namespace tn::engine::shader;
    g::Block fnBlock;
    const auto result = fnBlock.var(g::float_(0.1f));
    fnBlock.assign(result.declaration, g::float_(0.7391f));
    auto called = std::make_shared<g::NodeData>(*fnBlock.node());
    called->args = {result.read()};
    g::Block consumer;
    const auto first = consumer.var(g::mul(called, g::float_(2)));
    const auto second = consumer.var(g::mul(called, g::float_(3)));
    consumer.Loop(2, [&](g::Node) { consumer.assign(second.declaration, g::add(second.read(), called)); });
    auto root = std::make_shared<g::NodeData>(*consumer.node());
    root->args = {g::vec4({first.read(), second.read(), first.read(), g::float_(1)})};
    Program program(Stage::Fragment);
    tn::engine::shader::tsl::Build scope(program);
    program.output("color", g::lower(root, program));
    const auto shader = buildStage(program);
    CHECK(shader.wgsl.ok());
    size_t assignments = 0;
    for (size_t at = shader.wgsl.code.find("0.7391"); at != std::string::npos; at = shader.wgsl.code.find("0.7391", at + 1))
        ++assignments;
    CHECK(assignments == 1);
}

// The first use sits inside an If and a second after it. The If may not run, so the later use lowers the
// statements again in the scope that dominates it: two emissions, one per scope, each use after its own.
void body_result_in_a_branch() {
    namespace g = tn::engine::shader::graph;
    using namespace tn::engine::shader;
    g::Block fnBlock;
    const auto result = fnBlock.var(g::float_(0.1f));
    fnBlock.assign(result.declaration, g::float_(0.7391f));
    auto called = std::make_shared<g::NodeData>(*fnBlock.node());
    called->args = {result.read()};
    g::Block consumer;
    const auto inside = consumer.var(g::float_(0));
    consumer.If(g::greaterThan(g::uniform("gate", Type::f32(), {1}), g::float_(0)),
                [&] { consumer.assign(inside.declaration, g::mul(called, g::float_(2))); });
    const auto after = consumer.var(g::mul(called, g::float_(3)));
    const auto again = consumer.var(g::add(called, g::float_(1)));
    auto root = std::make_shared<g::NodeData>(*consumer.node());
    root->args = {g::vec4({inside.read(), after.read(), again.read(), g::float_(1)})};
    Program program(Stage::Fragment);
    tn::engine::shader::tsl::Build scope(program);
    program.output("color", g::lower(root, program));
    const auto shader = buildStage(program);
    CHECK(shader.wgsl.ok());
    size_t assignments = 0;
    for (size_t at = shader.wgsl.code.find("0.7391"); at != std::string::npos; at = shader.wgsl.code.find("0.7391", at + 1))
        ++assignments;
    CHECK(assignments == 2);
}

// ivec2(a, b) and vec2(a, b) of whole-number parts: three's JoinNode casts each part to the vector's element
// type, so the starter's auto exposure can load a texel at ivec2(i.mod(width), i.div(width)). The graph used to
// refuse it as "construct vec2<f32>: part 0 is i32", which made the exposure pass throw inside the frame.
void join_converts_integer_parts() {
    namespace g = tn::engine::shader::graph;
    using tn::abi::TslArg;
    using namespace tn::engine::shader;
    uint64_t serial = 0;
    const auto whole = [&](double value) { return tn::abi::tslCall("int", nullptr, {TslArg::of(value)}, serial); };
    const auto texel = tn::abi::tslCall("ivec2", nullptr, {TslArg::of(whole(3)), TslArg::of(whole(4))}, serial);
    const auto mixed = tn::abi::tslCall("vec2", nullptr, {TslArg::of(whole(5)), TslArg::of(0.5)}, serial);
    const auto root = g::vec4({g::float_(g::swizzle(texel, "y")), g::swizzle(mixed, "x"), g::swizzle(mixed, "y"), g::float_(1)});
    Program program(Stage::Fragment);
    tn::engine::shader::tsl::Build scope(program);
    program.output("color", g::lower(root, program));
    CHECK(buildStage(program).wgsl.ok());
}

void struct_function_return() {
    namespace g = tn::engine::shader::graph;
    using tn::abi::TslArg;
    using namespace tn::engine::shader;
    uint64_t serial = 0;
    const auto schema = tn::abi::tslCall("struct", nullptr,
        {TslArg::of(std::string("Pair")), TslArg::of(std::string("first")), TslArg::of(std::string("float")),
         TslArg::of(std::string("second")), TslArg::of(std::string("float"))}, serial);
    g::Block block;
    const auto variable = block.var(g::float_(0));
    block.assign(variable.declaration, g::add(variable.read(), g::float_(1)));
    const auto receiver = TslArg::of(schema);
    const auto value = tn::abi::tslCall("newStruct", &receiver,
        {TslArg::of(variable.read()), TslArg::of(variable.read())}, serial);
    auto body = std::make_shared<g::NodeData>(*block.node());
    body->args = {value};
    const auto function = TslArg::of(body);
    const auto first = tn::abi::tslCall("get", &function, {TslArg::of(std::string("first"))}, serial);
    const auto second = tn::abi::tslCall("get", &function, {TslArg::of(std::string("second"))}, serial);
    g::Block consumer;
    const auto savedFirst = consumer.var(first);
    const auto savedSecond = consumer.var(second);
    auto root = std::make_shared<g::NodeData>(*consumer.node());
    root->args = {g::vec4({savedFirst.read(), savedSecond.read(), first, second})};
    Program program(Stage::Fragment);
    tn::engine::shader::tsl::Build scope(program);
    program.output("color", g::lower(root, program));
    const auto shader = buildStage(program);
    CHECK(shader.wgsl.ok());
    const auto addition = shader.wgsl.code.find(" + ");
    CHECK(addition != std::string::npos);
    CHECK(shader.wgsl.code.find(" + ", addition + 3) == std::string::npos);
    auto callable = std::make_shared<g::NodeData>();
    callable->kind = g::Kind::Call;
    callable->args = {body};
    const auto call = TslArg::of(callable);
    const auto calledFirst = tn::abi::tslCall("get", &call, {TslArg::of(std::string("first"))}, serial);
    auto early = std::make_shared<g::NodeData>(); early->kind = g::Kind::Return; early->args = {value};
    auto branch = std::make_shared<g::NodeData>(); branch->kind = g::Kind::If;
    branch->args = {g::greaterThan(g::uniform("early", Type::f32(), {1}), g::float_(0))}; branch->body = {early};
    auto earlyBody = std::make_shared<g::NodeData>(*body); earlyBody->body.push_back(branch);
    auto earlyCall = std::make_shared<g::NodeData>(*callable); earlyCall->args = {earlyBody};
    const auto earlyReceiver = TslArg::of(earlyCall);
    const auto earlyFirst = tn::abi::tslCall("get", &earlyReceiver, {TslArg::of(std::string("first"))}, serial);
    const auto earlySecond = tn::abi::tslCall("get", &earlyReceiver, {TslArg::of(std::string("second"))}, serial);
    Program aggregateProgram(Stage::Fragment);
    {
        tn::engine::shader::tsl::Build aggregateBuild(aggregateProgram);
        aggregateProgram.output("color", g::lower(g::vec4({calledFirst, earlyFirst, earlySecond, g::float_(1)}), aggregateProgram));
    }
    const auto aggregateShader = buildStage(aggregateProgram);
    CHECK(aggregateProgram.ok() && aggregateShader.wgsl.ok());
    if (const char* output = std::getenv("TN_STRUCT_WGSL_OUTPUT")) std::ofstream(output) << aggregateShader.wgsl.code;


}

void authored_output() {
    namespace g = tn::engine::shader::graph;
    using tn::abi::TslArg;
    uint64_t serial = 0;
    const auto scene = g::texture("scene", g::uv());
    const auto authored = tn::abi::tslCall("renderOutput", nullptr,
        {TslArg::of(scene), TslArg::of(4.0), TslArg::of(std::string("srgb"))}, serial);
    CHECK(authored != nullptr);
    if (!authored) return;
    const auto post = g::serializedPost(authored);
    const auto programs = tn::engine::shader::buildOutput(std::nullopt, false, &post, false);
    const auto fragment = tn::engine::shader::buildStage(programs.fragment);
    CHECK(fragment.wgsl.ok());
    bool exposure = false;
    for (const auto& uniform : fragment.uniforms) exposure |= uniform.name == "toneMappingExposure";
    CHECK(exposure);
    CHECK(fragment.wgsl.code.find("pow(") != std::string::npos);
    const auto inherited = tn::abi::tslCall("renderOutput", nullptr, {TslArg::of(scene)}, serial);
    CHECK(inherited != nullptr);
    const auto disabled = tn::abi::tslCall("pipelineOutput", nullptr, {TslArg::of(inherited), TslArg::of(0.0)}, serial);
    const auto inheritedPost = g::serializedPost(disabled, tn::engine::shader::ToneMapping::ACESFilmic, true);
    CHECK(!inheritedPost.outputTransform);
    const auto inheritedPrograms = tn::engine::shader::buildOutput(tn::engine::shader::ToneMapping::ACESFilmic, true, &inheritedPost);
    CHECK(tn::engine::shader::buildStage(inheritedPrograms.fragment).wgsl.code == fragment.wgsl.code);
    const auto bloom = g::bloom(inherited, 1, 0, 1);
    const auto bloomPost = g::serializedPost(bloom, tn::engine::shader::ToneMapping::ACESFilmic, true);
    CHECK(!bloomPost.passes.empty());
    CHECK(bloomPost.passes.front().package.variants.at(0).stages[1].wgsl.code.find("pow(") != std::string::npos);
    bool refused = false;
    try {
        const auto custom = tn::abi::tslCall("renderOutput", nullptr,
            {TslArg::of(scene), TslArg::of(5.0), TslArg::of(std::string("srgb"))}, serial);
        const auto missing = g::serializedPost(custom);
        tn::engine::shader::buildOutput(std::nullopt, false, &missing, false);
    }
    catch (const std::exception& error) { refused = std::string(error.what()).find("TN_NATIVE_CUSTOM_TONEMAPPING_MISSING") != std::string::npos; }
    CHECK(refused);
}

// three wraps a fragmentNode in vec4(): rain's world quad hands the pass a vec3 (PRD-617).
void fragment_node_vec3_is_opaque() {
    namespace g = tn::engine::shader::graph;
    namespace s = tn::engine::shader;
    s::VertexVariant variant;
    variant.nodes.fragmentNode = g::vec3({g::float_(0.25f), g::float_(0.5f), g::float_(1.0f)});
    const auto programs = s::buildBasic(variant);
    CHECK(programs.diagnostics.empty() && programs.fragment.ok());
    CHECK(s::WgslEmitter::emit(programs.fragment, 1).ok());
}

// A quad pass whose fragment reads `depth` (rain's post shader) needs a vertex positionView to interpolate.
void rtt_quad_depth_has_a_vertex_output() {
    namespace g = tn::engine::shader::graph;
    using tn::abi::TslArg;
    uint64_t serial = 0;
    const auto depth = tn::abi::tslCall("depth", nullptr, {}, serial);
    const auto shown = g::vec4({depth, depth, depth, g::float_(1.0f)});
    const auto rtt = tn::abi::tslCall("rtt", nullptr,
        {TslArg::of(shown), TslArg::of(64.0), TslArg::of(32.0), TslArg::of(1003.0), TslArg::of(1003.0)}, serial);
    CHECK(rtt != nullptr);
    if (!rtt) return;
    const auto target = tn::engine::RenderTarget::make(64, 32, 1016);
    const auto quad = std::make_shared<tn::engine::Mesh>();
    quad->material = std::make_shared<tn::engine::Material>(tn::engine::MaterialType::Basic, true);
    quad->material->nodes.fragmentNode = shown;
    quad->material->nodes.vertexNode = g::vec4(
        {g::attribute("position", tn::engine::shader::Type::vec(2)), g::float_(0), g::float_(1)});
    const auto self = TslArg::of(rtt);
    tn::abi::tslCall("__rtt", &self, {TslArg::objectOf("RenderTarget", target), TslArg::objectOf("Mesh", quad)}, serial);
    const auto passes = g::postPasses(rtt);
    CHECK(passes.size() == 1);
    for (const auto& error : passes[0].package.errors) std::fprintf(stderr, "pass error: %s\n", error.c_str());
    CHECK(passes[0].package.errors.empty());
    const auto& vertex = passes[0].package.variants.at(0).stages[0];
    CHECK(vertex.wgsl.ok() && vertex.wgsl.code.find("positionView") != std::string::npos);
}

void post_output_depth_has_a_vertex_output() {
    namespace g = tn::engine::shader::graph;
    namespace s = tn::engine::shader;
    using tn::abi::TslArg;
    uint64_t serial = 0;
    const auto depth = tn::abi::tslCall("depth", nullptr, {}, serial);
    const auto post = g::serializedPost(g::vec4({depth, depth, depth, g::float_(1.0f)}));
    const auto programs = s::buildOutput(std::nullopt, false, &post);
    CHECK(programs.vertex.hasOutput("positionView"));
    CHECK(s::WgslEmitter::emit(programs.vertex, 1).ok() && s::WgslEmitter::emit(programs.fragment, 1).ok());
}

// PRD-617: a glTF skin binds with an identity bind matrix, so before the first frame `bindMatrixInverse` is still the
// identity. The shooter measures its rifle then with updateWorldMatrix; the bounds must still cancel the mesh's own
// world matrix, else the rifle turns a quarter-turn and the muzzle and the aiming optic move.
void skinned_bounds_before_the_first_frame() {
    using namespace tn::engine;
    Group root;
    root.rotation.x = -1.5707963267948966;
    auto geometry = std::make_shared<BufferGeometry>();
    geometry->setAttribute("position", BufferAttribute::fromDoubles(Scalar::F32, {1, 2, 3}, 3));
    geometry->setAttribute("skinIndex", BufferAttribute::fromDoubles(Scalar::F32, {0, 0, 0, 0}, 4));
    geometry->setAttribute("skinWeight", BufferAttribute::fromDoubles(Scalar::F32, {1, 0, 0, 0}, 4));
    auto bone = std::make_shared<Bone>();
    SkinnedMesh mesh(geometry, std::make_shared<Material>(MaterialType::Basic));
    root.add(*bone);
    root.add(mesh);
    root.updateWorldMatrix(false, true);
    Matrix4 inverse;
    inverse.copy(bone->matrixWorld).invert();
    const Matrix4 identity;
    mesh.bind(std::make_shared<Skeleton>(std::vector<std::shared_ptr<Bone>>{bone}, std::vector<Matrix4>{inverse}), &identity);
    Box3 box;
    box.setFromObject(mesh);
    const auto near = [](double a, double b) { return std::abs(a - b) < 1e-9; };
    CHECK(near(box.min.x, 1) && near(box.min.y, 2) && near(box.min.z, 3));
    CHECK(near(box.max.x, 1) && near(box.max.y, 2) && near(box.max.z, 3));
}

// PRD-617: three's mat2(a, b, c, d) with four plain numbers builds a Matrix2, whose constructor is row-major, while the
// same call with any node argument emits the WGSL constructor, which is column-major. The rain template's fbm octave
// rotation reads it, so a transposed matrix moved its terrain and every tree on it.
void tsl_mat2_scalar_order() {
    namespace g = tn::engine::shader::graph;
    using tn::abi::TslArg;
    uint64_t serial = 0;
    const auto dumped = [&](std::vector<TslArg> args) {
        const auto matrix = tn::abi::tslCall("mat2", nullptr, args, serial);
        CHECK(matrix != nullptr);
        tn::engine::shader::Program p(tn::engine::shader::Stage::Fragment);
        tn::engine::shader::tsl::Build build(p);
        p.output("color", g::lower(g::vec4({g::mul(matrix, g::vec2({g::float_(1), g::float_(0)})), g::float_(0), g::float_(1)}), p));
        return p.dump(true);
    };
    const auto node = [](double n) { return TslArg::of(g::float_(n)); };
    // Constants: the arguments read row by row, so the columns are (a, c) and (b, d).
    CHECK(dumped({TslArg::of(1.0), TslArg::of(2.0), TslArg::of(3.0), TslArg::of(4.0)}) ==
          dumped({node(1), node(3), node(2), node(4)}));
    // Any node argument: column by column, untouched.
    CHECK(dumped({node(1), node(2), node(3), node(4)}) != dumped({node(1), node(3), node(2), node(4)}));
    CHECK(dumped({TslArg::of(1.0), node(2), TslArg::of(3.0), TslArg::of(4.0)}) == dumped({node(1), node(2), node(3), node(4)}));
}

void starter_post_bindings() {
    namespace g = tn::engine::shader::graph;
    using tn::abi::TslArg;
    uint64_t serial = 0;
    const auto call = [&](const char* name, std::vector<TslArg> args) {
        const auto result = tn::abi::tslCall(name, nullptr, args, serial);
        CHECK(result != nullptr);
        return result;
    };
    const auto scene = g::texture("scene", g::uv());
    const auto rtt = call("rtt", {TslArg::of(scene), TslArg::of(64.0), TslArg::of(32.0),
                                  TslArg::of(1003.0), TslArg::of(1003.0)});
    if (!rtt) return;
    auto passes = g::postPasses(rtt);
    CHECK(passes.size() == 1 && passes[0].width == 64 && passes[0].height == 32);
    const double scale = 0.5, width = 80, no = 0, yes = 1;
    CHECK(tn::abi::tslEffectParameter(rtt, "resolutionScale", &scale) == scale);
    CHECK(tn::abi::tslEffectParameter(rtt, "width", &width) == width);
    CHECK(tn::abi::tslEffectParameter(rtt, "autoUpdate", &no) == no);
    CHECK(tn::abi::tslEffectParameter(rtt, "textureNeedsUpdate", &yes) == yes);
    passes = g::postPasses(rtt);
    CHECK(passes[0].width == 80 && passes[0].resolutionScale == 0.5 && !passes[0].autoUpdate);
    // The author labels a pass with a GPU stage; the pass carries it, and an unknown stage is refused.
    const double gather = g::kStageScreenSpaceGi, unknown = 7;
    CHECK(passes[0].stage == g::kStageNone);
    CHECK(tn::abi::tslEffectParameter(rtt, "stage", &gather) == gather);
    CHECK(tn::abi::tslEffectParameter(rtt, "stage", nullptr) == gather);
    CHECK(g::postPasses(rtt)[0].stage == g::kStageScreenSpaceGi);
    bool stageRefused = false;
    try { tn::abi::tslEffectParameter(rtt, "stage", &unknown); } catch (const std::exception&) { stageRefused = true; }
    CHECK(stageRefused);
    CHECK(tn::abi::tslEffectParameter(rtt, "stage", nullptr) == gather);
    const auto actualTarget = tn::engine::RenderTarget::make(64, 32, 1016);
    CHECK(actualTarget->texture->minFilter == 1006);
    const auto quad = std::make_shared<tn::engine::Mesh>();
    quad->material = std::make_shared<tn::engine::Material>(tn::engine::MaterialType::Basic, true);
    quad->material->nodes.fragmentNode = scene;
    const auto self = TslArg::of(rtt);
    CHECK(tn::abi::tslCall("__rtt", &self,
                           {TslArg::objectOf("RenderTarget", actualTarget), TslArg::objectOf("Mesh", quad)},
                           serial) == rtt);
    CHECK(rtt->rtt->target == actualTarget && rtt->rtt->quad == quad);
    actualTarget->setSize(123, 45);
    CHECK(tn::abi::tslEffectParameter(rtt, "actualWidth", nullptr) == 123);
    CHECK(tn::abi::tslEffectParameter(rtt, "actualHeight", nullptr) == 45);
    const auto vertexScale = g::uniform("rttVertexScale", tn::engine::shader::Type::f32(), {0.5f});
    quad->material->nodes.vertexNode = g::vec4(
        {g::mul(g::attribute("position", tn::engine::shader::Type::vec(2)), vertexScale), g::float_(0), g::float_(1)});
    const auto materialGraph = g::postPasses(rtt);
    CHECK(materialGraph.size() == 1 && materialGraph[0].rtt->material == quad->material);
    CHECK(materialGraph[0].package.errors.empty());
    const auto& rttVertex = materialGraph[0].package.variants.at(0).stages[0];
    CHECK(rttVertex.wgsl.ok() && rttVertex.wgsl.code.find("@group(1)") != std::string::npos);
    CHECK(materialGraph[0].uniforms.at("rttVertexScale")[0] == 0.5f);

    bool badQuad = false;
    try {
        tn::abi::tslCall("__rtt", &self, {TslArg::of(1.0), TslArg::of(2.0)}, serial);
    } catch (const std::exception& e) {
        badQuad = std::string(e.what()).find("QuadMesh") != std::string::npos;
    }
    CHECK(badQuad);
    const auto lifecycle = call("traa", {TslArg::of(scene), TslArg::of(g::texture("depth", g::uv())),
                                         TslArg::of(g::texture("velocity", g::uv())), TslArg::other()});
    for (size_t i = 0; i < 16; ++i) {
        const double projection = 0.125 * i;
        const auto name = "projection" + std::to_string(i);
        CHECK(tn::abi::tslEffectParameter(lifecycle, name, &projection) == projection);
        CHECK(lifecycle->post->originalProjection[i] == projection);
    }
    CHECK(tn::abi::tslEffectParameter(lifecycle, "viewOffset", &yes) == 1);
    CHECK(lifecycle->post->viewOffset);
    CHECK(tn::abi::tslEffectParameter(lifecycle, "viewOffset", &no) == 0);
    CHECK(!lifecycle->post->viewOffset);
    tn_context_t* context = nullptr;
    tn_diagnostic_t diagnostic{};
    const auto version = tn_engine_version();
    CHECK(tn_context_create(&context, &version, &diagnostic) == TN_OK);
    tn_handle_t depth{};
    const tn_value_t depthArgs[]{num(64.0), num(32.0)};
    CHECK(tn_construct(context, "DepthTexture", depthArgs, 2, &depth, &diagnostic) == TN_OK);
    if (depth.type) {
        const auto* object = tn::abi::objectOf(depth);
        const auto sampled = call("texture", {TslArg::objectOf("DepthTexture", object->ptr), TslArg::of(g::uv())});
        tn::engine::shader::Program p(tn::engine::shader::Stage::Fragment);
        tn::engine::shader::tsl::Build build(p);
        const auto value = g::lower(sampled, p);
        p.output("color", p.construct(tn::engine::shader::Type::vec(4), {value}));
        const auto stage = tn::engine::shader::buildStage(p);
        CHECK(stage.wgsl.ok());
        CHECK(stage.wgsl.code.find("texture_depth_2d") != std::string::npos);
        tn_handle_t target{};
        CHECK(tn_construct(context, "RenderTarget", depthArgs, 2, &target, &diagnostic) == TN_OK);
        const auto attachment = ref(depth);
        CHECK(tn_set(target, "depthTexture", &attachment, &diagnostic) == TN_OK);
        tn_value_t attached{};
        CHECK(tn_get(target, "depthTexture", &attached, &diagnostic) == TN_OK && same(attached.handle, depth));
        CHECK(tn_object_release(depth, &diagnostic) == TN_OK);
        CHECK(tn_get(target, "depthTexture", &attached, &diagnostic) == TN_OK);
    }
    {
        // three's RenderTarget options: the exposure meter reads its 1x1 target with nearest filters.
        const tn_value_t nearest[]{
            {TN_VALUE_STRING, 0, 0, {}, 0, "type", 4, {}}, num(1015.0),
            {TN_VALUE_STRING, 0, 0, {}, 0, "minFilter", 9, {}}, num(1003.0),
            {TN_VALUE_STRING, 0, 0, {}, 0, "magFilter", 9, {}}, num(1003.0),
            {TN_VALUE_STRING, 0, 0, {}, 0, "depthBuffer", 11, {}}, boolean(false)};
        tn_value_t options{};
        options.kind = TN_VALUE_RECORD;
        options.count = 4;
        options.values = nearest;
        const tn_value_t metered[]{num(1.0), num(1.0), options};
        tn_handle_t meter{};
        CHECK(tn_construct(context, "RenderTarget", metered, 3, &meter, &diagnostic) == TN_OK);
        if (meter.type) {
            const auto made = std::static_pointer_cast<tn::engine::RenderTarget>(tn::abi::objectOf(meter)->ptr);
            CHECK(made->texture->minFilter == 1003 && made->texture->magFilter == 1003);
        }
        const tn_value_t mipmapped[]{{TN_VALUE_STRING, 0, 0, {}, 0, "minFilter", 9, {}}, num(1008.0)};
        tn_value_t bad{};
        bad.kind = TN_VALUE_RECORD;
        bad.count = 1;
        bad.values = mipmapped;
        const tn_value_t rejected[]{num(1.0), num(1.0), bad};
        tn_handle_t none{};
        CHECK(tn_construct(context, "RenderTarget", rejected, 3, &none, &diagnostic) == TN_ERROR_UNSUPPORTED);
        tn_diagnostic_release(&diagnostic);
    }
    CHECK(tn_context_destroy(context, &diagnostic) == TN_OK);
    std::string authoredSource = "fn authoredArea(sample: u32, lo: vec2<f32>, hi: vec2<f32>) -> f32 { return f32(sample) + dot(hi-lo, hi-lo); }";
    std::string authoredName = "authoredArea";
    if (const char* source = std::getenv("TN_AUTHORED_WGSL_SOURCE")) {
        std::ifstream input(source); CHECK(input.good());
        authoredSource.assign(std::istreambuf_iterator<char>(input), {}); authoredName = "currentSampleArea";
    }
    const auto authored = call("wgslFunction", {TslArg::of(authoredSource),
        TslArg::of(authoredName), TslArg::of(std::string("float")),
        TslArg::of(std::string("uint")), TslArg::of(std::string("vec2")), TslArg::of(std::string("vec2"))});
    if (!authored) return;
    const auto authoredReceiver = TslArg::of(authored);
    const auto invoked = tn::abi::tslCall("invoke", &authoredReceiver,
        {TslArg::of(g::uint_(1)), TslArg::of(g::vec2({g::float_(0)})), TslArg::of(g::vec2({g::float_(1)}))}, serial);
    CHECK(invoked != nullptr);
    {
        tn::engine::shader::Program p(tn::engine::shader::Stage::Fragment);
        tn::engine::shader::tsl::Build build(p);
        const auto value = g::lower(invoked, p);
        p.output("color", p.construct(tn::engine::shader::Type::vec(4), {value}));
        const auto stage = tn::engine::shader::buildStage(p);
        CHECK(stage.wgsl.ok() && p.ok());
        CHECK(stage.wgsl.code.find("fn " + authoredName) != std::string::npos);
        if (const char* output = std::getenv("TN_AUTHORED_WGSL_OUTPUT")) std::ofstream(output) << stage.wgsl.code;
    }
    const auto sun = std::make_shared<tn::engine::DirectionalLight>();
    const auto shadowMatrix = call("lightShadowMatrix", {TslArg::objectOf("DirectionalLight", sun)});
    if (!shadowMatrix) return;
    CHECK(shadowMatrix->name == "authoredLightShadowMatrix" + std::to_string(sun->id()));
    {
        const auto buffer = g::storage("rejection", tn::engine::shader::Type::u32());
        auto element = std::make_shared<g::NodeData>(*buffer.element(g::uint_(0)));
        *element->atomic = true;
        tn::abi::TslScopes scopes;
        g::Node ignored, body;
        CHECK(scopes.call("scope:open", nullptr, {}, ignored));
        CHECK(scopes.call("atomicStore", nullptr, {TslArg::of(element), TslArg::of(g::uint_(0))}, ignored));
        CHECK(scopes.call("atomicAdd", nullptr, {TslArg::of(element), TslArg::of(g::uint_(1))}, ignored));
        CHECK(scopes.call("scope:close", nullptr, {}, body));
        tn::engine::shader::Program p(tn::engine::shader::Stage::Compute);
        tn::engine::shader::tsl::Build build(p);
        g::lower(body, p);
        const auto stage = tn::engine::shader::buildStage(p);
        CHECK(stage.wgsl.ok() && p.ok());
        CHECK(stage.wgsl.code.find("array<atomic<u32>>") != std::string::npos);
        CHECK(stage.wgsl.code.find("atomicStore") < stage.wgsl.code.find("atomicAdd"));
        if (const char* output = std::getenv("TN_ATOMIC_WGSL_OUTPUT")) std::ofstream(output) << stage.wgsl.code;
    }
    const auto temporal = call("traa", {TslArg::of(scene), TslArg::of(g::texture("depth", g::uv())),
                                      TslArg::of(g::texture("velocity", g::uv())), TslArg::other()});
    if (!temporal) return;
    CHECK(g::postPasses(temporal).empty());
    CHECK(g::traaEffect(temporal) == temporal->post);
    const double threshold = 0.002;
    CHECK(tn::abi::tslEffectParameter(temporal, "depthThreshold", &threshold) == float(threshold));
    CHECK(tn::abi::tslEffectParameter(temporal, "depthThreshold", nullptr) == float(threshold));
    bool refused = false;
    try { call("traa", {TslArg::of(g::mul(scene, g::float_(0.5))), TslArg::of(scene), TslArg::of(scene), TslArg::other()}); }
    catch (const std::exception& error) { refused = std::string(error.what()).find("TN_NATIVE_TRAA_INPUT") != std::string::npos; }
    CHECK(refused);
    // Over a texture the graph drew (convertToTexture of a frame its effects changed) the resolve is a pass of the graph:
    // the composite's own pass, then the resolve, which the renderer draws.
    const auto composite = call("convertToTexture", {TslArg::of(g::mul(scene, g::float_(0.5)))});
    if (!composite) return;
    const auto late = call("traa", {TslArg::of(composite), TslArg::of(g::texture("depth", g::uv())),
                                    TslArg::of(g::texture("velocity", g::uv())), TslArg::other()});
    if (!late) return;
    CHECK(g::traaEffect(late) == late->post);
    CHECK(g::traaResolvesLate(*late->post));
    CHECK(late->name != "scene" && late->name.starts_with("native_traa_"));
    CHECK(!g::traaResolvesLate(*temporal->post));
    const auto latePasses = g::postPasses(late);
    CHECK(latePasses.size() == 2);
    if (latePasses.size() == 2) {
        CHECK(latePasses.back().host == "traa" && latePasses.back().output == late->name);
        CHECK(latePasses.back().reads.at("beauty") == composite->name && latePasses.back().reads.at("depth") == "depth");
        CHECK(latePasses.front().host.empty() && latePasses.front().output == composite->name);
    }
    const auto compile = [&](g::Node root) {
        const auto post = g::serializedPost(root);
        auto programs = tn::engine::shader::buildOutput(std::nullopt, false, &post, false);
        const auto fragment = tn::engine::shader::buildStage(programs.fragment);
        CHECK(fragment.wgsl.ok());
        CHECK(programs.fragment.diagnostics().empty());
        return fragment;
    };
    // An early resolve's "scene" is the unresolved colour inside a render target, so it is drawn to a texture of its own.
    CHECK(call("convertToTexture", {TslArg::of(temporal)})->kind == g::Kind::RenderTexture);
    for (const auto& effect : {late}) {
        const auto texture = call("convertToTexture", {TslArg::of(effect)});
        CHECK(texture->kind == g::Kind::Texture && texture->name == effect->name);
        CHECK(call("convertToTexture", {TslArg::of(texture)}) == texture);
        const auto self = TslArg::of(texture);
        const auto sampled = tn::abi::tslCall("sample", &self, {TslArg::of(g::uv())}, serial);
        const auto texel = call("ivec2", {TslArg::of(0.0), TslArg::of(0.0)});
        const auto loaded = call("textureLoad", {self, TslArg::of(texel)});
        const auto size = call("textureSize", {self});
        for (const auto& consumer : {texture, sampled, loaded, size}) {
            CHECK(g::traaEffect(consumer) == effect->post);
            const auto retained = g::postPasses(consumer);
            CHECK(retained.size() == 2u);
            if (retained.size() == 2)
                CHECK(retained.back().host == "traa" && retained.back().output == effect->name);
        }
        compile(sampled);
        compile(loaded);
    }
    // `.level(n)` on a render texture reads it at an explicit level, as the motion blur's loop does.
    const auto compositeSelf = TslArg::of(composite);
    const auto leveled = tn::abi::tslCall("level", &compositeSelf, {TslArg::of(g::float_(0))}, serial);
    CHECK(leveled && leveled->kind == g::Kind::RenderTexture && leveled->args.size() == 3 &&
          leveled->name == composite->name);
    if (leveled)
        CHECK(compile(leveled).wgsl.code.find("textureSampleLevel(t_" + composite->name) !=
              std::string::npos);
    const auto intensity = g::uniform("grainIntensity", tn::engine::shader::Type::f32(), {0.2f});
    const auto film = call("film", {TslArg::of(scene), TslArg::of(intensity), TslArg::other()});
    if (!film) return;
    const auto grain = compile(film);
    bool hasClock = false, hasIntensity = false;
    for (const auto& field : grain.uniforms) {
        hasClock |= field.name == "time";
        hasIntensity |= field.name == "grainIntensity";
    }
    CHECK(hasClock && hasIntensity);
    const auto key = g::key(film);
    g::setUniformValues(intensity, {0.7f});
    CHECK(g::key(film) == key);
    CHECK(g::uniforms(film).at("grainIntensity").at(0) == 0.7f);
    const auto volume = std::make_shared<tn::engine::DataTexture>();
    volume->volume = true;
    volume->setImage(std::vector<double>(32, 0.5), "Float32Array", 2, 2, 1023, 1015);
    volume->depth = 2;
    const auto lut = call("texture3D", {TslArg::objectOf("Data3DTexture", volume)});
    if (!lut) return;
    const auto graded = call("lut3D", {TslArg::of(scene), TslArg::of(lut), TslArg::of(2.0), TslArg::of(intensity)});
    if (!graded) return;
    const auto grade = compile(graded);
    bool hasVolume = false;
    for (const auto& binding : grade.bindings) hasVolume |= binding.volume;
    CHECK(hasVolume);
    // A DataArrayTexture samples as texture_2d_array: texture(array, uv).depth(layer) reads (uv, layer), and a
    // texture(array, uv) alone reads layer 0. A texture that is not an array refuses depth(layer).
    {
        const auto layers = std::make_shared<tn::engine::DataTexture>();
        layers->array = true;
        layers->setImage(std::vector<double>(48, 128), "Uint8Array", 2, 2, 1023, 1009);
        layers->depth = 3;
        const auto sampled = call("texture", {TslArg::objectOf("DataArrayTexture", layers)});
        const auto sampledReceiver = sampled ? TslArg::of(sampled) : TslArg::other();
        const auto layered = sampled ? tn::abi::tslCall("depth", &sampledReceiver, {TslArg::of(g::int_(2))}, serial) : nullptr;
        CHECK(layered != nullptr);
        if (layered) {
            const auto stage = compile(g::vec4({g::swizzle(layered, "xyz"), g::float_(1)}));
            bool hasArray = false;
            for (const auto& binding : stage.bindings) hasArray |= binding.array && !binding.volume;
            CHECK(hasArray);
            CHECK(stage.wgsl.code.find("texture_2d_array<f32>") != std::string::npos);
            CHECK(stage.wgsl.code.find("textureSample(t_" + layered->name + ", smp_" + layered->name) != std::string::npos);
            CHECK(stage.wgsl.code.find("i32(floor(") != std::string::npos);
            const auto flat = compile(g::vec4({g::swizzle(sampled, "xyz"), g::float_(1)}));
            CHECK(flat.wgsl.code.find("texture_2d_array<f32>") != std::string::npos);
            const auto leveledLayer = tn::abi::tslCall("level", &sampledReceiver, {TslArg::of(g::float_(1))}, serial);
            CHECK(leveledLayer != nullptr);
            if (leveledLayer)
                CHECK(compile(g::vec4({g::swizzle(leveledLayer, "xyz"), g::float_(1)})).wgsl.code.find("textureSampleLevel(t_") != std::string::npos);
        }
        const auto plain = std::make_shared<tn::engine::DataTexture>();
        plain->setImage(std::vector<double>(4, 128), "Uint8Array", 1, 1, 1023, 1009);
        const auto flatTexture = call("texture", {TslArg::objectOf("DataTexture", plain)});
        const auto flatReceiver = flatTexture ? TslArg::of(flatTexture) : TslArg::other();
        bool refused = false;
        try { tn::abi::tslCall("depth", &flatReceiver, {TslArg::of(g::int_(0))}, serial); }
        catch (const std::exception& error) { refused = std::string(error.what()).find("TN_NATIVE_TEXTURE_DEPTH_TYPE") != std::string::npos; }
        CHECK(refused);
    }
    const double size = 4;
    CHECK(tn::abi::tslEffectParameter(graded, "size", &size) == 4);
    CHECK(tn::abi::tslEffectParameter(graded, "size", nullptr) == 4);
    for (const char* name : {"viewZToOrthographicDepth", "viewZToPerspectiveDepth", "logarithmicDepthToViewZ"}) {
        const auto value = call(name, {TslArg::of(-1.0), TslArg::of(0.1), TslArg::of(100.0)});
        if (value) compile(g::vec4({value, value, value, g::float_(1)}));
    }
    const auto luma = call("luminance", {TslArg::of(g::vec3({g::float_(0.5)}))});
    if (luma) compile(g::vec4({luma, luma, luma, g::float_(1)}));
    const auto vertex = call("constant:vertexIndex", {});
    CHECK(vertex && vertex->kind == g::Kind::Builtin && vertex->name == "vertexIndex");
    const auto schema = call("struct", {TslArg::of(std::string("Sample")), TslArg::of(std::string("color")), TslArg::of(std::string("vec4"))});
    if (schema) {
        const auto receiver = TslArg::of(schema);
        const auto value = tn::abi::tslCall("newStruct", &receiver, {TslArg::of(scene)}, serial);
        const auto instance = TslArg::of(value);
        const auto member = tn::abi::tslCall("get", &instance, {TslArg::of(std::string("color"))}, serial);
        CHECK(member != nullptr);
        if (member) compile(member);
        const auto aggregate = TslArg::of(g::float_(1));
        bool aggregateRefused = false;
        try { tn::abi::tslCall("get", &aggregate, {TslArg::of(std::string("color"))}, serial); }
        catch (const std::exception& error) {
            aggregateRefused = std::string(error.what()).find("TN_NATIVE_STRUCT_AGGREGATE_UNBOUND") != std::string::npos;
        }
        CHECK(aggregateRefused);
    }

}


void tsl_ssr_parameters() {
    namespace g = tn::engine::shader::graph;
    using tn::abi::TslArg;
    uint64_t serial = 0;
    const auto tex = TslArg::of(g::texture("scene", g::uv()));
    const auto node = tn::abi::tslCall("ssr", nullptr, {tex, tex, tex, TslArg::other(), TslArg::other()}, serial);
    CHECK(node && node->post->kind == "SSRNode" && !node->post->roughness);
    const auto rough = tn::abi::tslCall("ssr", nullptr, {tex, tex, tex, TslArg::of(0.4), TslArg::of(0.2)}, serial);
    CHECK(rough && rough->post->roughness);
    // Unbounded by default, like the three patch's SSRNode.maxSteps; a quality tier caps the march.
    CHECK(tn::abi::tslEffectParameter(node, "maxSteps", nullptr) == 1e6);
    const std::pair<const char*, double> valid[]{{"maxDistance", 2}, {"thickness", 0}, {"opacity", 0.5},
        {"quality", 1}, {"maxSteps", 8}, {"blurQuality", 3}, {"reflectNonMetals", 1}, {"binaryRefine", 1},
        {"intensity", 2}, {"maxLuminance", 20}, {"resolutionScale", 0.5}};
    for (const auto& [name, value] : valid) {
        CHECK(tn::abi::tslEffectParameter(node, name, &value) == value);
        CHECK(tn::abi::tslEffectParameter(node, name, nullptr) == value);
    }
    const std::pair<const char*, double> invalid[]{{"maxDistance", 0}, {"thickness", -1}, {"opacity", -1},
        {"quality", -0.1}, {"quality", 1.1}, {"maxSteps", 0}, {"maxSteps", 0.5}, {"blurQuality", 0}, {"blurQuality", 4}, {"blurQuality", 1.5},
        {"reflectNonMetals", 0.5}, {"binaryRefine", 2}, {"intensity", -1}, {"maxLuminance", -1},
        {"maxDistance", std::numeric_limits<double>::max()}, {"resolutionScale", 0}, {"resolutionScale", 1.1}};
    for (const auto& [name, value] : invalid) {
        const double before = tn::abi::tslEffectParameter(node, name, nullptr);
        bool refused = false;
        try { tn::abi::tslEffectParameter(node, name, &value); }
        catch (const std::runtime_error& e) {
            refused = std::string(e.what()).find(std::string(name) == "resolutionScale" ? "resolutionScale" : "TN_NATIVE_SSR_PARAMETER") != std::string::npos;
        }
        CHECK(refused);
        CHECK(tn::abi::tslEffectParameter(node, name, nullptr) == before);
    }
}

void tsl_texture_store() {
    namespace g = tn::engine::shader::graph;
    using namespace tn::engine::shader;
    using tn::abi::TslArg;
    uint64_t serial = 0;
    const auto texture = std::make_shared<tn::engine::Texture>();
    texture->storageTexture = true;
    texture->width = 16; texture->height = 8;
    const auto object = TslArg::objectOf("StorageTexture", texture);
    const auto target = tn::abi::tslCall("storageTexture", nullptr, {object}, serial);
    CHECK(target && target->object == texture && target->lanes == "rgba8unorm");
    const auto coord = tn::abi::tslCall("uvec2", nullptr, {TslArg::of(3.0), TslArg::of(5.0)}, serial);
    CHECK(coord->type == Type::vec(2, Type::Scalar::U32));
    const auto value = g::vec4({g::float_(0.25), g::float_(0.5), g::float_(0.75), g::float_(1)});
    for (bool direct : {true, false}) {
        tn::abi::TslScopes scopes;
        g::Node out, body;
        CHECK(scopes.call("scope:open", nullptr, {}, out));
        CHECK(scopes.call("textureStore", nullptr, {direct ? object : TslArg::of(target), TslArg::of(coord), TslArg::of(value)}, out));
        CHECK(out->object == texture && out->kind == g::Kind::StorageTexture);
        CHECK(scopes.call("scope:close", nullptr, {}, body));
        CHECK(body->body.size() == 1 && body->body[0]->kind == g::Kind::TextureStore);
        CHECK(body->body[0]->args == std::vector<g::Node>({coord, value}));
        Program p(Stage::Compute);
        g::lower(body, p);
        CHECK(p.ok());
        CHECK(p.dump().find("textureStore " + target->name + "[") != std::string::npos);
        const auto module = buildStage(p);
        CHECK(module.wgsl.ok());
        CHECK(module.wgsl.code.find("texture_storage_2d<rgba8unorm, write>") != std::string::npos);
        CHECK(module.wgsl.code.find("textureStore(st_" + target->name + ",") != std::string::npos);
        CHECK(module.bindings.size() == 1 && module.bindings[0].kind == BindingKind::StorageTexture);
    }
    for (const auto& bad : {TslArg::of(g::float_(1)), TslArg::of(g::texture("scene", g::uv()))}) {
        tn::abi::TslScopes scopes;
        g::Node out, body;
        CHECK(scopes.call("scope:open", nullptr, {}, out));
        bool refused = false;
        try { scopes.call("textureStore", nullptr, {bad, TslArg::of(coord), TslArg::of(value)}, out); }
        catch (const std::runtime_error& e) { refused = std::string(e.what()) == "textureStore needs a StorageTexture or storageTexture node"; }
        CHECK(refused);
        CHECK(scopes.call("scope:close", nullptr, {}, body));
        CHECK(body->body.empty());
    }
    bool refused = false;
    try { tn::abi::tslCall("storageTexture", nullptr, {TslArg::of(1.0)}, serial); }
    catch (const std::runtime_error& e) { refused = std::string(e.what()).find("storageTexture needs an engine StorageTexture") != std::string::npos; }
    CHECK(refused);
}

void tsl_mat4_element() {
    namespace g = tn::engine::shader::graph;
    using namespace tn::engine::shader;
    using tn::abi::TslArg;
    uint64_t serial = 0;
    const auto matrix = g::uniform("authoredMatrix", Type::mat(4, 4));
    const auto self = TslArg::of(matrix);
    for (uint32_t index = 0; index < 4; ++index) {
        const auto column = tn::abi::tslCall("element", &self, {TslArg::of(double(index))}, serial);
        CHECK(column && column->binary == g::BinOp::Mul && column->args[0] == matrix);
        const auto basis = column->args[1];
        CHECK(basis->args.size() == 4);
        for (uint32_t lane = 0; lane < 4; ++lane) {
            const auto select = basis->args[lane];
            CHECK(select->kind == g::Kind::Select);
            CHECK(select->args[0]->binary == g::BinOp::Equal);
            CHECK(g::key(select->args[0]->args[0]) == g::key(g::uint_(g::float_(index))));
            CHECK(g::key(select->args[0]->args[1]) == g::key(g::uint_(lane)));
            CHECK(g::key(select->args[1]) == g::key(g::float_(1)));
            CHECK(g::key(select->args[2]) == g::key(g::float_(0)));
        }
        Program p(Stage::Fragment);
        p.output("color", g::lower(column, p));
        CHECK(p.ok());
        const auto module = buildStage(p);
        CHECK(module.wgsl.ok());
        CHECK(module.wgsl.code.find("authoredMatrix") != std::string::npos);
        CHECK(module.wgsl.code.find("select(") != std::string::npos);
    }
    for (double index : {-1.0, 4.0, 1.5}) {
        bool refused = false;
        try { tn::abi::tslCall("element", &self, {TslArg::of(index)}, serial); }
        catch (const std::runtime_error& e) { refused = std::string(e.what()) == "mat4 element index must be an integer in [0, 3]"; }
        CHECK(refused);
    }
    const auto scalar = TslArg::of(g::float_(1));
    bool refused = false;
    try { tn::abi::tslCall("element", &scalar, {TslArg::of(0.0)}, serial); }
    catch (const std::runtime_error& e) { refused = std::string(e.what()) == "element needs a mat4 node"; }
    CHECK(refused);
}

TN_TEST_MAIN({"tsl_ssr_parameters", tsl_ssr_parameters}, {"tsl_texture_store", tsl_texture_store}, {"tsl_mat4_element", tsl_mat4_element}, {"body_result_lowers_once", body_result_lowers_once}, {"body_result_in_a_branch", body_result_in_a_branch}, {"join_converts_integer_parts", join_converts_integer_parts}, {"struct_function_return", struct_function_return}, {"authored_output", authored_output}, {"fragment_node_vec3_is_opaque", fragment_node_vec3_is_opaque}, {"rtt_quad_depth_has_a_vertex_output", rtt_quad_depth_has_a_vertex_output}, {"post_output_depth_has_a_vertex_output", post_output_depth_has_a_vertex_output}, {"skinned_bounds_before_the_first_frame", skinned_bounds_before_the_first_frame}, {"tsl_mat2_scalar_order", tsl_mat2_scalar_order}, {"starter_post_bindings", starter_post_bindings}, {"gpu_bind_escape", gpu_bind_escape}, {"version", version}, {"handles", handles}, {"generic", generic}, {"scene", scene},
             {"unsupported_member", unsupported_member}, {"material", material}, {"light", light}, {"spot_target_in_scene", spot_target_in_scene}, {"hierarchy_revision", hierarchy_revision}, {"matrix_evaluations", matrix_evaluations}, {"source_guard", source_guard}, {"shadow_camera_in_scene", shadow_camera_in_scene}, {"lifetime", lifetime},
             {"callbacks", callbacks}, {"color_set", color_set}, {"children", children}, {"tsl_call", tsl_call}, {"tsl_uniform_value", tsl_uniform_value}, {"tsl_matrix_columns", tsl_matrix_columns}, {"tsl_statements", tsl_statements}, {"tsl_effect_parameter", tsl_effect_parameter}, {"mixer_time_field", mixer_time_field}, {"visible_field", visible_field}, {"layers_field", layers_field}, {"walk_parents", walk_parents}, {"property_bind", property_bind}, {"euler_order_field", euler_order_field}, {"object_addresses", object_addresses}, {"geometry_shapes", geometry_shapes}, {"typed_bytes", typed_bytes}, {"array_offset", array_offset}, {"data_texture_bytes", data_texture_bytes}, {"attribute_view_writes", attribute_view_writes},
             {"attribute_defer", attribute_defer}, {"material_uuid", material_uuid}, {"material_alpha_hash", material_alpha_hash}, {"matrix_walk_count", matrix_walk_count}, {"geometry_index_null", geometry_index_null}, {"world_space_conversions", world_space_conversions},
             {"projected_cull_list", projected_cull_list}, {"projected_cull_held_restore", projected_cull_held_restore})
