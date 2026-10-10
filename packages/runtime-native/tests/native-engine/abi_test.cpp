#include "check.h"
#include "threenative/abi/tn_abi.h"
#include "threenative/abi/tn_tsl.h"
#include "engine/abi/abi_internal.h"
#include "engine/shader/graph/graph.h"
#include "engine/abi/pooled_shared.h"
#include "engine/abi/bindings.h"
#include "engine/animation/mixer.h"
#include "engine/scene/object3d.h"
#include "engine/scene/nodes.h"

#include <cstring>
#include <map>

#include <cstdio>
#include <cstring>
#include <string>
#include <stdexcept>

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
    const tn_tsl_arg_t stale = nodeArg(999999);
    CHECK(tn_tsl_call(ctx, "sin", nullptr, &stale, 1, &unknown, &d.value) != TN_OK);
    tn_diagnostic_release(&d.value);

    tn_handle_t material{};
    CHECK(tn_construct(ctx, "MeshBasicNodeMaterial", nullptr, 0, &material, &d.value) == TN_OK);
    CHECK(tn_tsl_set(ctx, material, "colorNode", color, &d.value) == TN_OK);
    CHECK(tn_tsl_compile(material, nullptr, &d.value) == TN_OK);

    // pmremTexture takes the texture object itself as a handle argument.
    const auto handleArg = [](tn_handle_t h) {
        tn_tsl_arg_t a{}; a.kind = TN_TSL_ARG_HANDLE;
        std::memcpy(&a.reserved, &h, 4); std::memcpy(&a.node, reinterpret_cast<const char*>(&h) + 4, 8);
        return a;
    };
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
    CHECK(g::uniforms(graph).begin()->second == std::vector<float>{0});

    const double quarter = 0.25;
    CHECK(tn_tsl_set_uniform(ctx, &clock, &quarter, 1, &d.value) == TN_OK);
    CHECK(g::uniforms(graph).begin()->second == std::vector<float>{0.25f});
    CHECK(g::key(graph) == key);  // same program: the value is data
    const double pair[2] = {1, 2};
    CHECK(tn_tsl_set_uniform(ctx, &clock, pair, 2, &d.value) != TN_OK);  // a float takes one value
    tn_diagnostic_release(&d.value);
    CHECK(tn_tsl_set_uniform(ctx, &color, &quarter, 1, &d.value) != TN_OK);  // not a uniform
    tn_diagnostic_release(&d.value);
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
    const tn_value_t missing = bytes("Float32Array", nullptr, 2);
    CHECK(tn_construct(ctx, "BufferAttribute", &missing, 1, &attribute, &d.value) == TN_ERROR_INVALID_ARGUMENT);
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
    void (*pull)(uintptr_t, uintptr_t, uint32_t, uint32_t) = [](uintptr_t key, uintptr_t data, uint32_t count,
                                                                  uint32_t scalar) {
        CHECK(count == 3 && scalar == 0);
        reinterpret_cast<float*>(data)[2] = 9;
        pulled.push_back(key);
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

}  // namespace

TN_TEST_MAIN({"version", version}, {"handles", handles}, {"generic", generic}, {"scene", scene},
             {"unsupported_member", unsupported_member}, {"material", material}, {"light", light}, {"lifetime", lifetime},
             {"callbacks", callbacks}, {"color_set", color_set}, {"children", children}, {"tsl_call", tsl_call}, {"tsl_uniform_value", tsl_uniform_value}, {"tsl_statements", tsl_statements}, {"tsl_effect_parameter", tsl_effect_parameter}, {"mixer_time_field", mixer_time_field}, {"visible_field", visible_field}, {"layers_field", layers_field}, {"walk_parents", walk_parents}, {"property_bind", property_bind}, {"euler_order_field", euler_order_field}, {"object_addresses", object_addresses}, {"geometry_shapes", geometry_shapes}, {"typed_bytes", typed_bytes}, {"attribute_view_writes", attribute_view_writes},
             {"attribute_defer", attribute_defer})
