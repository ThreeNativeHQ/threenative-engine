// The mesh materials and lights in the engine's one binding registry (PRD-514). One native Material
// carries every type's fields and `type` names the three class it is; each three class binds only the
// fields three declares on it, so `MeshBasicMaterial` has no `roughness` (PRD-531). A light
// inherits Object3D's bindings exactly as Mesh and Group do.
//
// Every material setter that changes what the renderer reads calls `needsUpdate()`, so the render
// database rebuilds. A Color member is read three ways: its components (`material.color.r`), the
// member itself (`material.color`, the one alias Ref), and a whole copy (`material.color = ref`).

#include "engine/abi/bindings.h"
#include "engine/abi/pooled_shared.h"

#include "engine/foundation/math/Color.h"
#include "engine/scene/lights.h"
#include "engine/scene/material.h"
#include "engine/scene/render_target.h"
#include "engine/scene/object3d.h"
#include "engine/scene/texture.h"
#include "engine/shader/standard.h"

#include <cmath>
#include <map>
#include <memory>
#include <optional>
#include <string>

namespace tn::binding {

using namespace tn::engine;

namespace {

double optional(const Args& a, size_t i, double fallback) {
    return i < a.size() ? number(a.at(i)) : fallback;
}

bool flag(const Value& v) { return v.kind == Value::Kind::Bool ? v.flag : number(v) != 0; }

template <typename T>
T* as(void* self) {
    return static_cast<T*>(self);
}

Value string(std::string text) { return Value{Value::Kind::String, 0, std::move(text)}; }

/** A light constructor colour: a NUMBER is a hex, exactly as `new Color(hex)` reads it. */
Color colorArg(const Value& v, Store& store) {
    if (v.kind == Value::Kind::Number) {
        Color color;
        color.setHex(v.number);
        return color;
    }
    if (v.kind == Value::Kind::Ref) return store.ref<Color>(v, "Color");
    throw Unsupported{"a light colour must be a number (hex) or a Color"};
}

/** Registers `<prefix>.x`/`y`/`z` for a Color field, read and written; `update` bumps a material. */
template <typename Owner>
void nestedColor(ClassBinding& b, const char* prefix, Color Owner::*field, bool update) {
    const char* const names[3] = {"r", "g", "b"};
    for (int i = 0; i < 3; ++i) {
        const std::string path = std::string(prefix) + "." + names[i];
        b.getters[path] = [field, i](void* self) {
            const Color& c = as<Owner>(self)->*field;
            return Value::of(i == 0 ? c.r : (i == 1 ? c.g : c.b));
        };
        b.setters[path] = [field, i, update](void* self, const Value& v) {
            Color& c = as<Owner>(self)->*field;
            (i == 0 ? c.r : (i == 1 ? c.g : c.b)) = number(v);
            if (update) as<Material>(self)->needsUpdate();
        };
    }
}

/** The Ref of one of `self`'s own members; the same Ref on every call, keeping its owner alive. */
template <typename Owner, typename M>
Method memberAliasMethod(M Owner::*field, const char* cls) {
    return [field, cls](void* self, const Args&, Store& store) {
        return memberAlias(store, self, as<Owner>(self)->*field, cls);
    };
}

/** A whole Color member write (`material.color = ref`) that copies the referenced Color. */
template <typename Owner>
Setter colorSetter(Color Owner::*field, bool update) {
    return [field, update](void* self, const Value& v, Store& store) {
        as<Owner>(self)->*field = store.ref<Color>(v, "Color");
        if (update) as<Material>(self)->needsUpdate();
    };
}

// ---------------------------------------------------------------------------- materials

void materialBool(ClassBinding& b, const char* name, bool Material::*field) {
    b.getters[name] = [field](void* self) { return Value::of(as<Material>(self)->*field); };
    b.setters[name] = [field](void* self, const Value& v) {
        as<Material>(self)->*field = flag(v);
        as<Material>(self)->needsUpdate();
    };
}

void materialNumber(ClassBinding& b, const char* name, double Material::*field) {
    b.getters[name] = [field](void* self) { return Value::of(as<Material>(self)->*field); };
    b.setters[name] = [field](void* self, const Value& v) {
        auto& material = *as<Material>(self);
        const double next = number(v), previous = material.*field;
        auto& diagnostic = Material::diagnostics();
        if (diagnostic.enabled && field == &Material::opacity) {
            ++diagnostic.writes;
            if (std::isnan(previous) || std::isnan(next)) ++diagnostic.nan;
            else if (previous == next && std::signbit(previous) != std::signbit(next)) ++diagnostic.signedZero;
            else if (previous == next) ++diagnostic.unchanged;
            else ++diagnostic.changed;
        }
        material.*field = next;
        material.needsUpdate();
    };
}

void registerMaterialBase(ClassBinding& b) {
    b.methods["clone"] = [](void* self, const Args&, Store& store) {
        const std::shared_ptr<Material> copy = as<Material>(self)->clone();
        return store.adopt(std::string(copy->typeName()), std::static_pointer_cast<void>(copy));
    };
    // three's Material.dispose(): it tells the renderer to free the material's GPU programs. The
    // engine frees a material's GPU state when the material itself is released, so there is nothing to
    // free early; the material stays usable, as three's does after dispose().
    registerEventBindings(b, [](void* self) -> EventDispatcher* { return &as<Material>(self)->events; }, {"dispose"});
    b.methods["dispose"] = [](void* self, const Args&, Store&) { as<Material>(self)->dispose(); return Value{}; };
    b.methods["copy"] = [](void* self, const Args& a, Store& store) {
        as<Material>(self)->copy(*store.shared<Material>(a.at(0), "Material"));
        return chain();
    };
    b.getters["type"] = [](void* self) { return string(std::string(as<Material>(self)->typeName())); };
    b.getters["id"] = [](void* self) { return Value::of(double(as<Material>(self)->id)); };
    b.getters["uuid"] = [](void* self) { return string(as<Material>(self)->uuid); };
    b.getters["name"] = [](void* self) { return string(as<Material>(self)->name); };
    b.setters["name"] = [](void* self, const Value& v) {
        if (v.kind != Value::Kind::String) throw Unsupported{"name must be a string"};
        as<Material>(self)->name = v.text;
    };
    b.setters["needsUpdate"] = [](void* self, const Value& v) {
        if (flag(v)) as<Material>(self)->needsUpdate();
    };

    materialBool(b, "transparent", &Material::transparent);
    materialBool(b, "depthTest", &Material::depthTest);
    materialBool(b, "depthWrite", &Material::depthWrite);
    materialBool(b, "colorWrite", &Material::colorWrite);
    materialBool(b, "forceSinglePass", &Material::forceSinglePass);
    materialBool(b, "vertexColors", &Material::vertexColors);
    materialBool(b, "polygonOffset", &Material::polygonOffset);
    materialNumber(b, "polygonOffsetFactor", &Material::polygonOffsetFactor);
    materialNumber(b, "polygonOffsetUnits", &Material::polygonOffsetUnits);
    materialBool(b, "visible", &Material::visible);
    materialBool(b, "toneMapped", &Material::toneMapped);
    materialBool(b, "fog", &Material::fog);
    materialNumber(b, "opacity", &Material::opacity);
    materialNumber(b, "alphaTest", &Material::alphaTest);
    b.getters["maxPositionOffset"] = [](void* self) { return Value::of(as<Material>(self)->maxPositionOffset); };
    b.setters["maxPositionOffset"] = [](void* self, const Value& v) {
        const double metres = number(v);
        if (!std::isfinite(metres) || metres < 0) throw Unsupported{"maxPositionOffset must be a finite distance of 0 or more"};
        as<Material>(self)->maxPositionOffset = metres;
        as<Material>(self)->needsUpdate();
    };
    materialBool(b, "alphaHash", &Material::alphaHash);
    materialBool(b, "alphaToCoverage", &Material::alphaToCoverage);
    b.getters["side"] = [](void* self) { return Value::of(double(as<Material>(self)->side)); };
    b.setters["side"] = [](void* self, const Value& v) {
        const double side = number(v);  // FrontSide 0, BackSide 1, DoubleSide 2; anything else is refused
        if (side != 0 && side != 1 && side != 2) throw Unsupported{"side must be FrontSide, BackSide or DoubleSide"};
        as<Material>(self)->side = static_cast<Side>(static_cast<int>(side));
        as<Material>(self)->needsUpdate();
    };
    b.getters["shadowSide"] = [](void* self) {
        const auto& side = as<Material>(self)->shadowSide;
        return side ? Value::of(double(*side)) : Value{};
    };
    b.setters["shadowSide"] = [](void* self, const Value& v) {
        auto& material = *as<Material>(self);
        if (v.kind == Value::Kind::Null) material.shadowSide.reset();
        else {
            const double side = number(v);
            if (side != 0 && side != 1 && side != 2) throw Unsupported{"shadowSide must be null, FrontSide, BackSide or DoubleSide"};
            material.shadowSide = static_cast<Side>(static_cast<int>(side));
        }
        material.needsUpdate();
    };
    b.getters["blending"] = [](void* self) { return Value::of(double(as<Material>(self)->blending)); };
    b.setters["blending"] = [](void* self, const Value& v) {
        // NoBlending 0 ... CustomBlending 5; MaterialBlending (6) names a material's own, so a material cannot take it.
        const double blending = number(v);
        if (blending != std::floor(blending) || blending < 0 || blending > 5)
            throw Unsupported{"blending must be NoBlending, NormalBlending, AdditiveBlending, SubtractiveBlending, "
                              "MultiplyBlending or CustomBlending"};
        as<Material>(self)->blending = static_cast<Blending>(static_cast<int>(blending));
        as<Material>(self)->needsUpdate();
    };
    materialBool(b, "premultipliedAlpha", &Material::premultipliedAlpha);
    // three's CustomBlending factors (ZeroFactor 200 ... OneMinusConstantAlphaFactor 214) and equations (AddEquation 100
    // ... MaxEquation 104); the alpha ones also take null, which uses the colour one.
    const auto blendConstant = [&b](const char* name, int16_t Material::*field, int16_t low, int16_t high, bool nullable) {
        b.getters[name] = [field](void* self) {
            const int16_t value = as<Material>(self)->*field;
            return value < 0 ? Value{} : Value::of(double(value));
        };
        b.setters[name] = [name, field, low, high, nullable](void* self, const Value& v) {
            auto& material = *as<Material>(self);
            if (nullable && v.kind == Value::Kind::Null) material.*field = -1;
            else {
                const double value = number(v);
                if (value != std::floor(value) || value < low || value > high)
                    throw Unsupported{std::string(name) + " must be one of three's " +
                                      (low == 100 ? "blend equations" : "blend factors") + (nullable ? " or null" : "")};
                material.*field = static_cast<int16_t>(value);
            }
            material.needsUpdate();
        };
    };
    blendConstant("blendSrc", &Material::blendSrc, 200, 214, false);
    blendConstant("blendDst", &Material::blendDst, 200, 214, false);
    blendConstant("blendEquation", &Material::blendEquation, 100, 104, false);
    blendConstant("blendSrcAlpha", &Material::blendSrcAlpha, 200, 214, true);
    blendConstant("blendDstAlpha", &Material::blendDstAlpha, 200, 214, true);
    blendConstant("blendEquationAlpha", &Material::blendEquationAlpha, 100, 104, true);
}

/** A Color field read by component, as the member alias, and written whole. */
void materialColor(ClassBinding& b, const char* name, Color Material::*field) {
    nestedColor(b, name, field, true);
    fixedMember(b, name, memberAliasMethod(field, "Color"));
    b.setters[name] = colorSetter(field, true);
}

/** three's `material.map`: read as a member (`material.map`) and written whole (`material.map = ref`). */
void materialMapSlot(ClassBinding& b, const std::string& slot = "map") {
    b.members[slot] = [slot](void* self, const Args&, Store& store) -> Value {
        const auto found = as<Material>(self)->maps.find(slot);
        if (found == as<Material>(self)->maps.end() || !found->second) return Value{};
        return store.share("Texture", std::const_pointer_cast<Texture>(found->second));
    };
    b.setters[slot] = [slot](void* self, const Value& v, Store& store) {
        Material& material = *as<Material>(self);
        if (v.kind == Value::Kind::Null) {
            material.maps.erase(slot);
            material.needsUpdate();
            return;
        }
        Object* object = store.find(v);
        if (object == nullptr || !isTextureClass(object->cls))
            throw Unsupported{slot + " must be a Texture"};
        material.maps[slot] = std::static_pointer_cast<const Texture>(object->ptr);
        material.needsUpdate();
    };
}

/** Exactly the fields three declares on each class, so a class publishes no sibling's surface. */
void registerTypeFields(ClassBinding& b, MaterialType type) {
    materialColor(b, "color", &Material::color);
    materialMapSlot(b);
    if (type == MaterialType::Basic) return;
    materialBool(b, "flatShading", &Material::flatShading);
    // An engine field three does not declare: the Two Sided Foliage marker (PRD-651), on every lit class.
    materialBool(b, "twoSidedFoliage", &Material::twoSidedFoliage);
    // Its Subsurface Color (PRD-643), another engine field: undefined until set, as three reads an unset one.
    b.members["subsurfaceColor"] = [](void* self, const Args&, Store& store) -> Value {
        Material& material = *as<Material>(self);
        return material.hasSubsurfaceColor ? memberAlias(store, self, material.subsurfaceColor, "Color") : Value::undefined();
    };
    b.setters["subsurfaceColor"] = [](void* self, const Value& v, Store& store) {
        Material& material = *as<Material>(self);
        material.hasSubsurfaceColor = v.kind != Value::Kind::Null && v.kind != Value::Kind::Undefined;
        material.subsurfaceColor = material.hasSubsurfaceColor ? store.ref<Color>(v, "Color") : Color{0, 0, 0};
        material.needsUpdate();
    };
    // A tangent-space normal map, which the lit programs perturb with three's perturbNormal2Arb, and
    // its scale: the member alias, written whole with a Vector2 (three's setValues assigns it).
    materialMapSlot(b, "normalMap");
    fixedMember(b, "normalScale", memberAliasMethod(&Material::normalScale, "Vector2"));
    b.setters["normalScale"] = [](void* self, const Value& v, Store& store) {
        as<Material>(self)->normalScale.copy(store.ref<Vector2>(v, "Vector2"));
        as<Material>(self)->needsUpdate();
    };
    materialColor(b, "emissive", &Material::emissive);
    materialNumber(b, "emissiveIntensity", &Material::emissiveIntensity);
    if (type == MaterialType::Lambert) return;
    if (type == MaterialType::Phong) {
        materialColor(b, "specular", &Material::specular);
        materialNumber(b, "shininess", &Material::shininess);
        return;
    }
    materialMapSlot(b, "envMap");
    materialNumber(b, "envMapIntensity", &Material::envMapIntensity);
    materialNumber(b, "roughness", &Material::roughness);
    materialNumber(b, "metalness", &Material::metalness);
    // An engine field three does not declare: Unreal's rough diffuse (PRD-653), on the classes that have a roughness.
    materialBool(b, "roughDiffuse", &Material::roughDiffuse);
    // The standard program's scalar and emissive maps (shader::kPbrMapNames) and the occlusion strength.
    for (int k = 0; k < shader::kStandardPbrMapCount; ++k) materialMapSlot(b, shader::kPbrMapNames[k]);
    materialNumber(b, "aoMapIntensity", &Material::aoMapIntensity);
    materialNumber(b, "bumpScale", &Material::bumpScale);
    if (type == MaterialType::Standard) return;
    materialNumber(b, "ior", &Material::ior);
    materialNumber(b, "specularIntensity", &Material::specularIntensity);
    materialColor(b, "specularColor", &Material::specularColor);
    // The physical program's own PbrMaps: specularColorMap, specularIntensityMap and the clearcoat maps.
    for (int k = shader::kStandardPbrMapCount; k < shader::kPbrMapCount; ++k) materialMapSlot(b, shader::kPbrMapNames[k]);
    materialNumber(b, "clearcoat", &Material::clearcoat);
    materialNumber(b, "clearcoatRoughness", &Material::clearcoatRoughness);
    fixedMember(b, "clearcoatNormalScale", memberAliasMethod(&Material::clearcoatNormalScale, "Vector2"));
    b.setters["clearcoatNormalScale"] = [](void* self, const Value& v, Store& store) {
        as<Material>(self)->clearcoatNormalScale.copy(store.ref<Vector2>(v, "Vector2"));
        as<Material>(self)->needsUpdate();
    };
    materialNumber(b, "sheen", &Material::sheen);
    materialNumber(b, "transmission", &Material::transmission);
    materialNumber(b, "iridescence", &Material::iridescence);
    materialNumber(b, "anisotropy", &Material::anisotropy);
    materialNumber(b, "dispersion", &Material::dispersion);
}

void registerMeshMaterial(ClassBinding& b, MaterialType type, bool node = false, bool raw = false) {
    // A parameters object is applied by the language adapter (V8's setValues) after construction.
    b.ctor = [type, node, raw](const Args& a, Store&) -> std::shared_ptr<void> {
        if (!a.empty())
            throw Unsupported{"a material parameters object is not supported"};
        auto material = detail::makeShared<Material>(type, node);
        material->rawNodeMaterial = raw;
        return material;
    };
    registerMaterialBase(b);
    if (!raw)
        registerTypeFields(b, type);
    if (!node) return;
    using Nodes = shader::MaterialNodes;
    for (const auto& [name, field] : std::initializer_list<std::pair<const char*, shader::graph::Node Nodes::*>>{
             {"fragmentNode", &Nodes::fragmentNode},
             {"colorNode", &Nodes::colorNode},
             {"positionNode", &Nodes::positionNode},
             {"normalNode", &Nodes::normalNode},
             {"opacityNode", &Nodes::opacityNode},
             {"emissiveNode", &Nodes::emissiveNode},
             {"roughnessNode", &Nodes::roughnessNode},
             {"metalnessNode", &Nodes::metalnessNode},
             {"vertexNode", &Nodes::vertexNode},
             {"aoNode", &Nodes::aoNode},
             {"irradianceNode", &Nodes::irradianceNode},
             {"envNode", &Nodes::envNode},
             {"depthNode", &Nodes::depthNode},
             {"castShadowPositionNode", &Nodes::castShadowPositionNode},
             {"maskNode", &Nodes::maskNode},
             {"maskShadowNode", &Nodes::maskShadowNode},
             {"alphaTestNode", &Nodes::alphaTestNode}}) {
        if (raw && (std::string_view(name) == "emissiveNode" || std::string_view(name) == "roughnessNode" ||
                    std::string_view(name) == "metalnessNode"))
            continue;
        b.getters[name] = [field](void* self) { return Value::shaderNode(as<Material>(self)->nodes.*field); };
        b.setters[name] = [field, name](void* self, const Value& v) {
            if (v.kind != Value::Kind::Null && (v.kind != Value::Kind::ShaderNode || !v.node))
                throw Unsupported{std::string(name) + " must be a shader node or null"};
            as<Material>(self)->nodes.*field = v.node;
            as<Material>(self)->needsUpdate();
        };
    }
    // three's mrtNode: the material's custom colour attachments by slot name, as a record of shader nodes. The V8 and
    // browser facades set one slot at a time through the "mrtNode.<name>" setter path (abi.cpp); this record form
    // serves the C ABI and replaces the whole set.
    b.getters["mrtNode"] = [](void* self) {
        std::vector<std::pair<std::string, Value>> fields;
        for (const auto& slot : as<Material>(self)->nodes.mrt)
            fields.emplace_back(slot.name, Value::shaderNode(slot.node));
        return Value::record(std::move(fields));
    };
    b.setters["mrtNode"] = [](void* self, const Value& v, Store&) {
        Material& material = *as<Material>(self);
        if (v.kind == Value::Kind::Null || v.kind == Value::Kind::Undefined) {
            if (material.nodes.mrt.empty()) return;
            material.nodes.mrt.clear();
            material.needsUpdate();
            return;
        }
        if (v.kind != Value::Kind::Record) throw Unsupported{"mrtNode must be mrt()"};
        std::vector<shader::MrtOutput> slots;
        slots.reserve(v.fields.size());
        for (const auto& [slot, field] : v.fields) {
            if (field.kind != Value::Kind::ShaderNode || !field.node)
                throw Unsupported{"mrtNode." + slot + " must be a shader node"};
            slots.push_back({slot, field.node});
        }
        if (material.nodes.mrt == slots) return;
        material.nodes.mrt = std::move(slots);
        material.needsUpdate();
    };
    b.getters["lightsNode"] = [](void* self) { return Value::shaderNode(as<Material>(self)->nodes.lightsNode); };
    b.setters["lightsNode"] = [](void* self, const Value& v) {
        if (v.kind != Value::Kind::Null && (v.kind != Value::Kind::ShaderNode || !v.node ||
                                            v.node->kind != shader::graph::Kind::Struct || v.node->name != "lights"))
            throw Unsupported{"lightsNode must be a lights([...]) node or null"};
        as<Material>(self)->nodes.lightsNode = v.node;
        as<Material>(self)->needsUpdate();
    };
}

// ------------------------------------------------------------------------------- lights

void registerLightBase(ClassBinding& b) {
    b.getters["intensity"] = [](void* self) { return Value::of(as<Light>(self)->intensity); };
    b.setters["intensity"] = [](void* self, const Value& v) { as<Light>(self)->intensity = number(v); };
    nestedColor(b, "color", &Light::color, false);
    fixedMember(b, "color", memberAliasMethod(&Light::color, "Color"));
    b.setters["color"] = colorSetter(&Light::color, false);
}

void registerAmbientLight(ClassBinding& b) {
    registerObject3DBindings(b);
    b.ctor = [](const Args& a, Store& store) -> std::shared_ptr<void> {
        Color color = a.empty() ? Color(1, 1, 1) : colorArg(a.at(0), store);
        return std::static_pointer_cast<void>(std::make_shared<AmbientLight>(color, optional(a, 1, 1)));
    };
    registerLightBase(b);
}

// `light.shadow` by path: its numbers, the map size and the shadow camera's own numbers, which the
// renderer re-projects every frame it draws the map (the spot camera's fov, aspect and far are
// SpotLightShadow.updateMatrices' to set, so only near and far are bound there).
template <typename L, typename C>
void shadowBindings(ClassBinding& b, const char* shadowClass, std::vector<const char*> cameraNames,
                    std::vector<double C::*> cameraFields) {
    // `light.shadow` as an object: the light's own shadow record, the same one for its life.
    fixedMember(b, "shadow", [shadowClass](void* self, const Args&, Store& store) {
        return store.adoptAlias(shadowClass, &as<L>(self)->shadow, self);
    });
    const auto number = [&b](const std::string& path, double LightShadow::*field) {
        b.getters[path] = [field](void* self) { return Value::of(as<L>(self)->shadow.*field); };
        b.setters[path] = [field](void* self, const Value& v) { as<L>(self)->shadow.*field = tn::binding::number(v); };
    };
    for (const auto& [name, field] : std::initializer_list<std::pair<const char*, double LightShadow::*>>{
             {"bias", &LightShadow::bias}, {"normalBias", &LightShadow::normalBias}, {"radius", &LightShadow::radius},
             {"intensity", &LightShadow::intensity}, {"focus", &LightShadow::focus}})
        number(std::string("shadow.") + name, field);
    for (const char* axis : {"x", "y", "width", "height"}) {
        const bool first = axis[0] == 'x' || axis[0] == 'w';
        const std::string path = std::string("shadow.mapSize.") + axis;
        b.getters[path] = [first](void* self) {
            const Vector2& size = as<L>(self)->shadow.mapSize;
            return Value::of(first ? size.x : size.y);
        };
        b.setters[path] = [first](void* self, const Value& v) {
            Vector2& size = as<L>(self)->shadow.mapSize;
            (first ? size.x : size.y) = tn::binding::number(v);
        };
    }
    for (std::size_t i = 0; i < cameraNames.size(); ++i) {
        const std::string path = std::string("shadow.camera.") + cameraNames[i];
        double C::*field = cameraFields[i];
        auto camera = [](void* self) { return static_cast<C*>(as<L>(self)->shadow.camera.get()); };
        b.getters[path] = [field, camera](void* self) { return Value::of(camera(self)->*field); };
        b.setters[path] = [field, camera](void* self, const Value& v) { camera(self)->*field = tn::binding::number(v); };
    }
}

// three's DirectionalLightShadow, SpotLightShadow and PointLightShadow, reached through `light.shadow`:
// its numbers, `mapSize`, and `camera`, which is the shadow camera itself (orthographic for a
// directional light, perspective otherwise). Only a spot shadow has `focus`.
void registerLightShadow(ClassBinding& b, bool spot) {
    b.setters["shadowNode"] = [](void* self, const Value& value, Store& store) {
        auto& shadow = *as<LightShadow>(self);
        if (value.kind == Value::Kind::Null) { shadow.virtualShadow.reset(); return; }
        if (value.kind != Value::Kind::Record || !dynamic_cast<OrthographicCamera*>(shadow.camera.get()))
            throw Unsupported{"TN_NATIVE_SHADOW_NODE_UNSUPPORTED: directional VirtualShadowNode required"};
        const auto command = std::find_if(value.fields.begin(), value.fields.end(), [](const auto& f) { return f.first == "command"; });
        if (command != value.fields.end()) {
            if (!shadow.virtualShadow) throw Unsupported{"TN_VIRTUAL_SHADOW_INVALID: command without node"};
            auto& control = *shadow.virtualShadow->control;
            if (command->second.kind != Value::Kind::String) throw Unsupported{"TN_VIRTUAL_SHADOW_INVALID: command"};
            const std::string& name = command->second.text;
            if (name == "invalidateAll") { control.invalidateAll = true; return; }
            if (name == "focus") {
                // Three numbers set the point every clip window centres on, an empty list hands it back to the eye.
                const auto at = std::find_if(value.fields.begin(), value.fields.end(), [](const auto& f) { return f.first == "at"; });
                const auto point = at == value.fields.end() ? std::vector<double>{0} : numbersOf(at->second);
                if ((point.size() != 0 && point.size() != 3) ||
                    std::any_of(point.begin(), point.end(), [](double n) { return !std::isfinite(n); }))
                    throw Unsupported{"TN_VIRTUAL_SHADOW_INVALID: focus"};
                if (point.empty()) control.focus.reset(); else control.focus = Vector3(point[0], point[1], point[2]);
                return;
            }
            if (name == "lod") {
                const Value* idValue = nullptr; const Value* geometriesValue = nullptr; const Value* errorsValue = nullptr;
                for (const auto& [key, v] : value.fields) {
                    if (key == "id") idValue = &v;
                    if (key == "geometries") geometriesValue = &v;
                    if (key == "errors") errorsValue = &v;
                }
                if (!idValue || !geometriesValue || !errorsValue) throw Unsupported{"TN_VIRTUAL_SHADOW_INVALID: lod command"};
                const double id = number(*idValue);
                if (!std::isfinite(id) || id < 0 || id > 9007199254740991.0 || id != std::floor(id))
                    throw Unsupported{"TN_VIRTUAL_SHADOW_INVALID: caster id"};
                shadows::ShadowLodChain chain;
                chain.errors = numbersOf(*errorsValue);
                for (const Value& ref : refsOf(*geometriesValue)) {
                    auto* object = store.find(ref);
                    if (!object || !acceptsClass(object->cls, "BufferGeometry")) throw Unsupported{"TN_VIRTUAL_SHADOW_INVALID: lod geometry"};
                    chain.rungs.push_back(std::static_pointer_cast<BufferGeometry>(object->ptr));
                }
                if (chain.rungs.empty() || chain.rungs.size() != chain.errors.size() ||
                    std::any_of(chain.errors.begin(), chain.errors.end(), [](double e) { return !std::isfinite(e) || e < 0; }))
                    throw Unsupported{"TN_VIRTUAL_SHADOW_INVALID: lod rungs and errors"};
                control.lods[uint64_t(id)] = std::move(chain);
                // A chain changes the rung this one caster draws with, so only its pages redraw (Unreal invalidates
                // the primitive, UE 5.8.3: VirtualShadowMapCacheManager.cpp:489). A streamed forest registers a chain
                // per arriving batch: invalidating every level for each one redrew the whole cache as the player walked.
                control.lodChanged.insert(uint64_t(id)); return;
            }
            const auto arg = std::find_if(value.fields.begin(), value.fields.end(), [&](const auto& f) { return f.first == (name == "invalidateRegion" ? "bounds" : "id"); });
            if (arg == value.fields.end()) throw Unsupported{"TN_VIRTUAL_SHADOW_INVALID: command argument"};
            if (name == "invalidateRegion") {
                const auto box = numbersOf(arg->second);
                if (box.size() != 6 || std::any_of(box.begin(), box.end(), [](double n) { return !std::isfinite(n); }) || box[0] > box[3] || box[1] > box[4] || box[2] > box[5])
                    throw Unsupported{"TN_VIRTUAL_SHADOW_INVALID: region"};
                Box3 bounds; bounds.set(Vector3(box[0], box[1], box[2]), Vector3(box[3], box[4], box[5]));
                control.regions.push_back(bounds); return;
            }
            const double id = number(arg->second);
            if (!std::isfinite(id) || id < 0 || id > 9007199254740991.0 || id != std::floor(id))
                throw Unsupported{"TN_VIRTUAL_SHADOW_INVALID: caster id"};
            if (name == "pin") control.pinned.insert(uint64_t(id));
            else if (name == "track") control.tracked.insert(uint64_t(id));
            else if (name == "untrack") control.tracked.erase(uint64_t(id));
            else if (name == "unlod") { control.lods.erase(uint64_t(id)); control.lodChanged.insert(uint64_t(id)); }
            else throw Unsupported{"TN_VIRTUAL_SHADOW_INVALID: command"};
            return;
        }
        shadows::AtlasOptions options;
        options.autoDepth = true;
        bool distanceGiven = false, rangeGiven = false, automaticGiven = false;
        for (const auto& [key, v] : value.fields) {
            distanceGiven |= key == "lightDistance";
            rangeGiven |= key == "depthRange";
            automaticGiven |= key == "autoDepth";
            if (key == "pinnedStatic" || key == "trackedCasters") {
                auto& ids = key == "pinnedStatic" ? options.control->pinned : options.control->tracked;
                for (double id : numbersOf(v)) {
                    if (!std::isfinite(id) || id < 0 || id > 9007199254740991.0 || id != std::floor(id))
                        throw Unsupported{"TN_VIRTUAL_SHADOW_INVALID: caster id"};
                    ids.insert(uint64_t(id));
                }
            }
            else if (key == "clipExtents") options.clipExtents = numbersOf(v);
            else if (key == "selectionGuard") options.selectionGuard = numbersOf(v);
            else if (key == "refreshStep") options.refreshStep = numbersOf(v);
            else if (key == "invalidationDelay") options.invalidationDelay = numbersOf(v);
            else if (key == "mapSize") {
                // One size for every level, or one per level (core resolves it per level).
                const auto sizes = v.kind == Value::Kind::Number ? std::vector<double>{number(v)} : numbersOf(v);
                if (sizes.empty() || std::any_of(sizes.begin(), sizes.end(), [](double n) {
                        return !std::isfinite(n) || n != std::floor(n) || n < 1 || n > 4096; }))
                    throw Unsupported{"TN_VIRTUAL_SHADOW_INVALID: mapSize"};
                options.mapSize = int(sizes[0]);
                options.levelMapSizes.clear();
                if (sizes.size() > 1) for (double n : sizes) options.levelMapSizes.push_back(int(n));
                options.pageTexels = std::min(128, int(*std::min_element(sizes.begin(), sizes.end())));
            }
            else if (key == "autoMapSize") options.autoMapSize = flag(v);
            else if (key == "resolutionLodBiasDirectional") {
                options.resolutionLodBias = number(v);
                if (!std::isfinite(options.resolutionLodBias)) throw Unsupported{"TN_VIRTUAL_SHADOW_INVALID: resolutionLodBiasDirectional"};
            }
            else if (key == "maxPhysicalPages") {
                const double n = number(v);
                if (!std::isfinite(n) || n != std::floor(n) || n < 1 || n > 4096)
                    throw Unsupported{"TN_VIRTUAL_SHADOW_INVALID: maxPhysicalPages"};
                options.maxPhysicalPages = int(n);
            }
            else if (key == "lightDistance") options.lightDistance = number(v);
            else if (key == "depthRange") options.depthRange = number(v);
            else if (key == "autoDepth") options.autoDepth = flag(v);
            else if (key == "adaptiveRefresh") options.adaptiveRefresh = flag(v);
            else if (key == "adaptiveCasterGate") options.adaptiveCasterGate = flag(v);
            else if (key == "followViewFocus") options.followViewFocus = flag(v);
            else if (key == "shadowLodBias") options.shadowLodBias = flag(v);
            else if (key == "shadowLodTexels") {
                const double n = number(v);
                if (!(n > 0)) throw Unsupported{"TN_VIRTUAL_SHADOW_INVALID: shadowLodTexels"};
                options.shadowLodTexels = n;
            }
            else if (key == "staticAfterFrames" || key == "moverMapSize") {
                const double n = number(v);
                if (!std::isfinite(n) || n != std::floor(n) || n < 1 || n > 4096)
                    throw Unsupported{"TN_VIRTUAL_SHADOW_INVALID: " + key};
                (key == "staticAfterFrames" ? options.staticAfterFrames : options.moverMapSize) = int(n);
            }
            else if (key == "expensiveRefreshShare") options.expensiveRefreshShare = number(v);
            else if (key == "minCasterTexels") options.minCasterTexels = number(v);
            else if (key == "minWindowAspect") options.minWindowAspect = number(v);
            else if (key == "partialRedraw") options.partialRedraw = flag(v);
            else if (key == "receiverPlaneBias") options.receiverPlaneBias = flag(v);
        }
        if (!automaticGiven) options.autoDepth = !distanceGiven || !rangeGiven;
        // The page-border limit on the PCF radius is checked where the filter is known, at render:
        // a source-angle filter replaces that footprint, and it may be installed after this node.
        if (!std::isfinite(shadow.radius) || shadow.radius < 0)
            throw Unsupported{"TN_VIRTUAL_SHADOW_UNSUPPORTED: PCF radius exceeds page guard texels"};
        std::string error;
        if (!shadows::PageAtlas::create(options, error)) throw Unsupported{error};
        shadow.virtualShadow = std::make_shared<const shadows::AtlasOptions>(std::move(options));
    };
    b.setters["filterNode"] = [](void* self, const Value& value) {
        auto& shadow = *as<LightShadow>(self);
        if (value.kind == Value::Kind::Null) {
            shadow.sourceAngleFilter.reset();
            shadow.sourceRadiusFilter.reset();
            return;
        }
        // sourceAngleShadowFilter on a sun (orthographic map), sourceRadiusShadowFilter on a lamp.
        const bool lamp = dynamic_cast<PerspectiveCamera*>(shadow.camera.get()) != nullptr;
        const char* size = lamp ? "sourceRadius" : "sourceAngleRad";
        if (value.kind != Value::Kind::Record || value.fields.size() < (lamp ? 4u : 3u) || value.fields.size() > (lamp ? 4u : 6u) ||
            (!lamp && !dynamic_cast<OrthographicCamera*>(shadow.camera.get())))
            throw Unsupported{"TN_VIRTUAL_SHADOW_UNSUPPORTED: filterNode (sourceAngleShadowFilter on a directional "
                              "light, or sourceRadiusShadowFilter on a spot or point light, required)"};
        double extent = -1, blockers = 0, samples = 0, penumbraScale = lamp ? -1 : 1;  // a lamp must name its share
        double minPixels = 0, samplesPerRay = 4, rayLengthScale = 1.5;  // core's defaults
        std::size_t known = 0;
        for (const auto& [key, v] : value.fields) {
            if (key == size) extent = number(v);
            else if (key == "blockerSamples") blockers = number(v);
            else if (key == "filterSamples") samples = number(v);
            else if (lamp && key == "penumbraScale") penumbraScale = number(v);
            else if (!lamp && key == "minPenumbraPixels") minPixels = number(v);
            else if (!lamp && key == "samplesPerRay") samplesPerRay = number(v);
            else if (!lamp && key == "rayLengthScale") rayLengthScale = number(v);
            else continue;
            ++known;
        }
        if (!std::isfinite(extent) || extent < 0 || (!lamp && extent >= 1.5707963267948966) ||
            !std::isfinite(blockers) || blockers < 1 || blockers > 64 || blockers != std::floor(blockers) ||
            !std::isfinite(samples) || samples < 1 || samples > 64 || samples != std::floor(samples) ||
            !std::isfinite(penumbraScale) || penumbraScale <= 0 || penumbraScale > 4 ||
            !std::isfinite(minPixels) || minPixels < 0 || minPixels > 16 ||
            !std::isfinite(samplesPerRay) || samplesPerRay < 0 || samplesPerRay > 64 || samplesPerRay != std::floor(samplesPerRay) ||
            !std::isfinite(rayLengthScale) || rayLengthScale <= 0 || known != value.fields.size())
            throw Unsupported{lamp ? "TN_VIRTUAL_SHADOW_INVALID: source-radius filter" : "TN_VIRTUAL_SHADOW_INVALID: source-angle filter"};
        if (lamp) shadow.sourceRadiusFilter = std::array<double, 4>{extent, blockers, samples, penumbraScale};
        else shadow.sourceAngleFilter = std::array<double, 6>{extent, blockers, samples, minPixels, samplesPerRay, rayLengthScale};
    };
    if (spot) {
        b.getters["focus"] = [](void* self) { return Value::of(as<LightShadow>(self)->focus); };
        b.setters["focus"] = [](void* self, const Value& v) { as<LightShadow>(self)->focus = number(v); };
    }
    for (const auto& [name, field] : std::initializer_list<std::pair<const char*, double LightShadow::*>>{
             {"bias", &LightShadow::bias}, {"normalBias", &LightShadow::normalBias}, {"radius", &LightShadow::radius},
             {"intensity", &LightShadow::intensity}}) {
        b.getters[name] = [field](void* self) { return Value::of(as<LightShadow>(self)->*field); };
        b.setters[name] = [field](void* self, const Value& v) { as<LightShadow>(self)->*field = number(v); };
    }
    fixedMember(b, "mapSize", [](void* self, const Args&, Store& store) {
        return memberAlias(store, self, as<LightShadow>(self)->mapSize, "Vector2");
    });
    fixedMember(b, "camera", [](void* self, const Args&, Store& store) {
        const std::shared_ptr<Object3D> camera = as<LightShadow>(self)->camera;
        return store.share(std::string(camera->type()), camera);
    });
}

void registerDirectionalLight(ClassBinding& b) {
    registerObject3DBindings(b);
    b.ctor = [](const Args& a, Store& store) -> std::shared_ptr<void> {
        Color color = a.empty() ? Color(1, 1, 1) : colorArg(a.at(0), store);
        return std::static_pointer_cast<void>(
            std::make_shared<DirectionalLight>(color, optional(a, 1, 1)));
    };
    registerLightBase(b);
    b.members["target"] = [](void* self, const Args&, Store& store) -> Value {
        DirectionalLight* light = as<DirectionalLight>(self);
        if (light->target == nullptr) return Value{};
        return store.share(std::string(light->target->type()), light->target);
    };
    b.setters["target"] = [](void* self, const Value& value, Store& store) {
        Object3D& target = objectArg(store, value);
        as<DirectionalLight>(self)->target = std::shared_ptr<Object3D>(store.find(value)->ptr, &target);
    };
    shadowBindings<DirectionalLight, OrthographicCamera>(b, "DirectionalLightShadow", {"left", "right", "top", "bottom", "near", "far"},
                                                         {&OrthographicCamera::left, &OrthographicCamera::right,
                                                          &OrthographicCamera::top, &OrthographicCamera::bottom,
                                                          &OrthographicCamera::near, &OrthographicCamera::far});
}

// A number field of a light class: getter and setter over one member.
template <typename L> void numberField(ClassBinding& b, const char* name, double L::* member) {
    b.getters[name] = [member](void* self) { return Value::of(as<L>(self)->*member); };
    b.setters[name] = [member](void* self, const Value& v) { as<L>(self)->*member = number(v); };
}

// three's PointLight(color, intensity, distance = 0, decay = 2).
void registerPointLight(ClassBinding& b) {
    registerObject3DBindings(b);
    b.ctor = [](const Args& a, Store& store) -> std::shared_ptr<void> {
        Color color = a.empty() ? Color(1, 1, 1) : colorArg(a.at(0), store);
        return std::static_pointer_cast<void>(
            std::make_shared<PointLight>(color, optional(a, 1, 1), optional(a, 2, 0), optional(a, 3, 2)));
    };
    registerLightBase(b);
    numberField<PointLight>(b, "distance", &PointLight::distance);
    numberField<PointLight>(b, "decay", &PointLight::decay);
    // An engine field three does not declare: Unreal's Source Radius (PRD-653).
    numberField<PointLight>(b, "sourceRadius", &PointLight::sourceRadius);
    shadowBindings<PointLight, PerspectiveCamera>(b, "PointLightShadow", {"near", "far"}, {&PerspectiveCamera::near, &PerspectiveCamera::far});
}

// three's SpotLight(color, intensity, distance = 0, angle = PI / 3, penumbra = 0, decay = 2).
void registerSpotLight(ClassBinding& b) {
    registerObject3DBindings(b);
    b.ctor = [](const Args& a, Store& store) -> std::shared_ptr<void> {
        Color color = a.empty() ? Color(1, 1, 1) : colorArg(a.at(0), store);
        return std::static_pointer_cast<void>(std::make_shared<SpotLight>(
            color, optional(a, 1, 1), optional(a, 2, 0), optional(a, 3, 1.0471975511965976), optional(a, 4, 0),
            optional(a, 5, 2)));
    };
    registerLightBase(b);
    numberField<SpotLight>(b, "distance", &SpotLight::distance);
    numberField<SpotLight>(b, "angle", &SpotLight::angle);
    numberField<SpotLight>(b, "penumbra", &SpotLight::penumbra);
    numberField<SpotLight>(b, "decay", &SpotLight::decay);
    numberField<SpotLight>(b, "sourceRadius", &SpotLight::sourceRadius);
    b.members["target"] = [](void* self, const Args&, Store& store) -> Value {
        SpotLight* light = as<SpotLight>(self);
        if (light->target == nullptr) return Value{};
        return store.share(std::string(light->target->type()), light->target);
    };
    b.setters["target"] = [](void* self, const Value& value, Store& store) {
        Object3D& target = objectArg(store, value);
        as<SpotLight>(self)->target = std::shared_ptr<Object3D>(store.find(value)->ptr, &target);
    };
    shadowBindings<SpotLight, PerspectiveCamera>(b, "SpotLightShadow", {"near", "far"}, {&PerspectiveCamera::near, &PerspectiveCamera::far});
}

void registerHemisphereLight(ClassBinding& b) {
    registerObject3DBindings(b);
    b.ctor = [](const Args& a, Store& store) -> std::shared_ptr<void> {
        Color sky = a.empty() ? Color(1, 1, 1) : colorArg(a.at(0), store);
        Color ground = a.size() < 2 ? Color(1, 1, 1) : colorArg(a.at(1), store);
        return std::static_pointer_cast<void>(
            std::make_shared<HemisphereLight>(sky, ground, optional(a, 2, 1)));
    };
    registerLightBase(b);
    nestedColor(b, "groundColor", &HemisphereLight::groundColor, false);
    fixedMember(b, "groundColor", memberAliasMethod(&HemisphereLight::groundColor, "Color"));
    b.setters["groundColor"] = colorSetter(&HemisphereLight::groundColor, false);
}

// ------------------------------------------------------------------------------ textures

/** A number field of any class: getter and setter over one member, bumping the texture's version. */
template <typename Owner, typename T>
void textureNumber(ClassBinding& b, const char* name, T Owner::*member) {
    b.getters[name] = [member](void* self) { return Value::of(double(as<Owner>(self)->*member)); };
    // Only a change moves the version: a restated value would retire every bake keyed by it (the
    // retained environment of a sky a scene restates on each enter).
    b.setters[name] = [member](void* self, const Value& v) {
        const T next = static_cast<T>(number(v));
        if (as<Owner>(self)->*member == next) return;
        as<Owner>(self)->*member = next;
        as<Owner>(self)->needsUpdate();
    };
}

/** A Vector2 field (`repeat`, `offset`): its x/y by path, and the member itself as one alias. */
template <typename Owner>
void textureVector2(ClassBinding& b, const char* field, Vector2 Owner::*member) {
    const char* const names[2] = {"x", "y"};
    for (int i = 0; i < 2; ++i) {
        const std::string path = std::string(field) + "." + names[i];
        b.getters[path] = [member, i](void* self) {
            const Vector2& v = as<Owner>(self)->*member;
            return Value::of(i == 0 ? v.x : v.y);
        };
        b.setters[path] = [member, i](void* self, const Value& value) {
            Vector2& v = as<Owner>(self)->*member;
            const double next = number(value);
            if ((i == 0 ? v.x : v.y) == next) return;
            (i == 0 ? v.x : v.y) = next;
            as<Owner>(self)->needsUpdate();
        };
    }
    fixedMember(b, field, [member](void* self, const Args&, Store& store) {
        return memberAlias(store, self, as<Owner>(self)->*member, "Vector2");
    });
}

void registerTextureFields(ClassBinding& b, const char* cls) {
    b.methods["clone"] = [cls](void* self, const Args&, Store& store) {
        const auto* texture = as<Texture>(self);
        std::shared_ptr<Texture> clone;
        if (const auto* data = dynamic_cast<const DataTexture*>(texture))
            clone = std::make_shared<DataTexture>(*data);
        else
            clone = std::make_shared<Texture>(*texture);
        clone->needsUpdate();
        return store.share(cls, std::move(clone));
    };
    b.getters["image.width"] = [](void* self) { return Value::of(double(as<Texture>(self)->width)); };
    b.getters["image.height"] = [](void* self) { return Value::of(double(as<Texture>(self)->height)); };
    b.getters["name"] = [](void* self) { return string(as<Texture>(self)->name); };
    b.setters["name"] = [](void* self, const Value& v) {
        if (v.kind != Value::Kind::String) throw Unsupported{"name must be a string"};
        as<Texture>(self)->name = v.text;
    };
    b.getters["version"] = [](void* self) { return Value::of(double(as<Texture>(self)->version())); };
    // three's Texture.dispose(): the renderer frees the GPU copy; the texture stays usable and uploads again.
    b.methods["dispose"] = [](void* self, const Args&, Store&) { as<Texture>(self)->dispose(); return Value{}; };
    // three's Texture extends EventDispatcher and dispatches `dispose`.
    registerEventBindings(b, [](void* self) -> EventDispatcher* { return static_cast<EventDispatcher*>(as<Texture>(self)); },
                          {"dispose"});
    b.setters["needsUpdate"] = [](void* self, const Value& v) {
        if (flag(v)) as<Texture>(self)->needsUpdate();
    };
    b.getters["generateMipmaps"] = [](void* self) { return Value::of(as<Texture>(self)->generateMipmaps); };
    b.setters["generateMipmaps"] = [](void* self, const Value& v) { as<Texture>(self)->generateMipmaps = flag(v); };
    b.getters["anisotropy"] = [](void* self) { return Value::of(as<Texture>(self)->anisotropy); };
    b.setters["anisotropy"] = [](void* self, const Value& v) {
        const double anisotropy = number(v);
        if (!(anisotropy >= 1) || !std::isfinite(anisotropy)) throw Unsupported{"anisotropy must be a finite number of at least 1"};
        as<Texture>(self)->anisotropy = anisotropy;
    };
    b.getters["flipY"] = [](void* self) { return Value::of(as<Texture>(self)->flipY); };
    b.setters["flipY"] = [](void* self, const Value& v) {
        if (as<Texture>(self)->flipY == flag(v)) return;
        as<Texture>(self)->flipY = flag(v);
        as<Texture>(self)->needsUpdate();
    };
    // three's `texture.type` and `format` (UnsignedByteType, HalfFloatType, FloatType; RGBAFormat, or RGFormat on a render target): fixed
    // by the constructor or the render target that owns the texture. Writing the value a texture already
    // has is accepted (the rain template restates them); another value is refused by name.
    b.getters["type"] = [](void* self) { return Value::of(double(as<Texture>(self)->type)); };
    b.setters["type"] = [](void* self, const Value& v) {
        if (number(v) != as<Texture>(self)->type) throw Unsupported{"texture.type is fixed by the texture's data"};
    };
    b.getters["format"] = [](void* self) { return Value::of(double(as<Texture>(self)->format)); };
    b.setters["format"] = [](void* self, const Value& v) {
        if (number(v) != as<Texture>(self)->format) throw Unsupported{"texture.format is fixed by the texture's data"};
    };
    textureNumber<Texture>(b, "mapping", &Texture::mapping);
    textureNumber<Texture>(b, "wrapS", &Texture::wrapS);
    textureNumber<Texture>(b, "wrapT", &Texture::wrapT);
    textureNumber<Texture>(b, "magFilter", &Texture::magFilter);
    textureNumber<Texture>(b, "minFilter", &Texture::minFilter);
    textureNumber<Texture>(b, "rotation", &Texture::rotation);
    // three's `texture.source`: the texture's own image record, whose version moves with needsUpdate.
    fixedMember(b, "source", [](void* self, const Args&, Store& store) {
        return store.share("Source", as<Texture>(self)->imageSource);
    });
    textureVector2<Texture>(b, "repeat", &Texture::repeat);
    textureVector2<Texture>(b, "offset", &Texture::offset);
    textureVector2<Texture>(b, "center", &Texture::center);
    b.getters["colorSpace"] = [](void* self) { return string(as<Texture>(self)->isSRGB() ? "srgb" : ""); };
    b.setters["colorSpace"] = [](void* self, const Value& v) {
        if (v.kind != Value::Kind::String) throw Unsupported{"colorSpace must be a string"};
        const TextureColorSpace next = v.text == "srgb" ? TextureColorSpace::SRGB : TextureColorSpace::None;
        if (as<Texture>(self)->colorSpace == next) return;
        as<Texture>(self)->colorSpace = next;
        as<Texture>(self)->needsUpdate();
    };
}

/** HalfFloatType data is a Uint16Array of binary16 bits: anything else would upload garbage. */
void checkHalfFloatBits(const std::vector<double>& values) {
    for (const double v : values)
        if (!(v >= 0 && v <= 65535) || v != std::floor(v))
            throw Unsupported{"HalfFloatType DataTexture data must be a Uint16Array of binary16 bits"};
}

/**
 * A RedFormat texel as the RGBA texel three samples it as, (r, 0, 0, 1): the store and upload are RGBA only.
 * ponytail: 4x the bytes of an R texture; add an R8/R16F/R32F upload path if a large red texture shows up.
 */
std::vector<double> widenRed(const std::vector<double>& red, uint16_t type) {
    const double one = type == kTextureHalfFloatType ? 15360.0 : type == kTextureFloatType ? 1.0 : 255.0;
    std::vector<double> rgba(red.size() * 4, 0.0);
    for (std::size_t i = 0; i < red.size(); ++i) {
        rgba[i * 4] = red[i];
        rgba[i * 4 + 3] = one;
    }
    return rgba;
}

void registerTextureClass(ClassBinding& b, bool data, const char* cls) {
    b.ctor = [data](const Args& a, Store&) -> std::shared_ptr<void> {
        if (!data) return std::static_pointer_cast<void>(std::make_shared<Texture>());
        auto texture = std::make_shared<DataTexture>();
        if (!a.empty() && a[0].kind == Value::Kind::Numbers) {
            const uint32_t width = a.size() > 1 ? static_cast<uint32_t>(number(a[1])) : 1;
            const uint32_t height = a.size() > 2 ? static_cast<uint32_t>(number(a[2])) : 1;
            const uint16_t format = a.size() > 3 ? static_cast<uint16_t>(number(a[3])) : kTextureRGBAFormat;
            const uint16_t type = a.size() > 4 ? static_cast<uint16_t>(number(a[4])) : kTextureUnsignedByteType;
            if (format != kTextureRGBAFormat && format != kTextureRedFormat)
                throw Unsupported{"DataTexture format must be RGBAFormat or RedFormat"};
            if (type != kTextureUnsignedByteType && type != kTextureFloatType && type != kTextureHalfFloatType)
                throw Unsupported{"DataTexture type must be UnsignedByteType, FloatType or HalfFloatType"};
            // The C ABI hands DataTexture its typed array's bytes (ctorTakesBytes); V8 hands numbers.
            if (a[0].bytes.empty() && a[0].number != 0)
                throw Unsupported{"DataTexture data must arrive with its contents, not deferred"};
            if (format == kTextureRGBAFormat && !a[0].bytes.empty() &&
                texture->setImageBytes(a[0].bytes, a[0].text, width, height, format, type))
                return std::static_pointer_cast<void>(texture);
            std::vector<double> values = a[0].bytes.empty() ? a[0].numbers : typedArrayNumbers(a[0].text, a[0].bytes);
            if (type == kTextureHalfFloatType) checkHalfFloatBits(values);
            texture->redSource = format == kTextureRedFormat;
            if (texture->redSource) values = widenRed(values, type);
            texture->setImage(values, a[0].text, width, height, kTextureRGBAFormat, type);
        }
        return std::static_pointer_cast<void>(texture);
    };
    registerTextureFields(b, cls);
    if (!data) return;
    // three's `texture.image.data = array`: new texels of the same size and type, uploaded on the
    // next needsUpdate. The V8 and browser back ends copy an array when it crosses, so a game that
    // edits its typed array in place re-sends it this way before it sets needsUpdate.
    b.setters["image.data"] = [](void* self, const Value& v) {
        auto* texture = as<DataTexture>(self);
        const std::size_t texels = std::size_t(texture->width) * texture->height;
        // The C ABI hands DataTexture its typed array's bytes (settersTakeBytes); V8 hands numbers.
        const std::size_t count = v.bytes.empty() ? v.numbers.size() : v.bytes.size() / typedArrayElementBytes(v.text);
        const std::size_t lanes = texture->redSource ? 1 : 4;
        if (v.kind != Value::Kind::Numbers || texels == 0 || count != texels * lanes)
            throw Unsupported{"image.data must be a typed array of width * height * " + std::to_string(lanes) + " values"};
        // three moves `version` on needsUpdate only, so the new texels wait for it.
        if (!texture->redSource && !v.bytes.empty() && texture->setImageBytes(v.bytes, v.text, texture->width, texture->height,
                                                       texture->format, texture->type, false))
            return;
        const std::vector<double> values = v.bytes.empty() ? v.numbers : typedArrayNumbers(v.text, v.bytes);
        if (texture->isHalfFloat()) checkHalfFloatBits(values);
        texture->setImage(texture->redSource ? widenRed(values, texture->type) : values, v.text, texture->width,
                          texture->height, texture->format, texture->type, false);
    };
}

}  // namespace

void registerMaterialBindings(Registry& classes) {
    for (const auto& [name, node] : {std::pair{"SpriteMaterial", false}, std::pair{"SpriteNodeMaterial", true}}) {
        auto& b = classes[name];
        registerMeshMaterial(b, MaterialType::Basic, node);
        const auto ctor = b.ctor;
        // SpriteMaterial's defaults; V8's setValues applies a parameters object after them, as three does.
        b.ctor = [ctor](const Args& a, Store& store) {
            auto value = ctor(a, store);
            auto* material = static_cast<Material*>(value.get());
            material->spriteMaterial = true;
            material->transparent = true;
            material->fog = false;
            return value;
        };
        // MSVC cannot parse a qualified class in a pointer-to-member template argument
        // (`Node shader::MaterialNodes::*`); the alias form is the one registerMeshMaterial uses.
        using Nodes = shader::MaterialNodes;
        if (node)
            for (const auto& [slot, field] : std::initializer_list<std::pair<const char*, shader::graph::Node Nodes::*>>{
                     {"scaleNode", &Nodes::scaleNode}, {"rotationNode", &Nodes::rotationNode}}) {
                b.getters[slot] = [field](void* self) { return Value::shaderNode(as<Material>(self)->nodes.*field); };
                b.setters[slot] = [field, slot](void* self, const Value& v) {
                    if (v.kind != Value::Kind::Null && (v.kind != Value::Kind::ShaderNode || !v.node))
                        throw Unsupported{std::string(slot) + " must be a shader node or null"};
                    as<Material>(self)->nodes.*field = v.node;
                    as<Material>(self)->needsUpdate();
                };
            }
        b.getters["rotation"] = [](void* self) { return Value::of(as<Material>(self)->rotation); };
        b.setters["rotation"] = [](void* self, const Value& v) { as<Material>(self)->rotation = number(v); };
        b.getters["sizeAttenuation"] = [](void* self) { return Value::of(as<Material>(self)->sizeAttenuation); };
        b.setters["sizeAttenuation"] = [](void* self, const Value& v) { as<Material>(self)->sizeAttenuation = flag(v); };
    }
    {
        auto& line = classes["LineBasicMaterial"];
        registerMeshMaterial(line, MaterialType::Basic);
        const auto ctor = line.ctor;
        line.ctor = [ctor](const Args& a, Store& store) {
            auto value = ctor(a, store);
            static_cast<Material*>(value.get())->lineMaterial = true;
            return value;
        };
    }
    {
        auto& points = classes["PointsMaterial"];
        registerMeshMaterial(points, MaterialType::Basic);
        const auto ctor = points.ctor;
        // PointsMaterial's defaults: opaque and fogged as three's are, and unlit like a SpriteMaterial's.
        points.ctor = [ctor](const Args& a, Store& store) {
            auto value = ctor(a, store);
            static_cast<Material*>(value.get())->pointsMaterial = true;
            return value;
        };
        // PointsMaterial.size is kept and read; WebGPU's point primitive is 1 px, so it moves no pixel here
        // either (three's PointsNodeMaterial.js:56-60). That is also why PointsNodeMaterial — upstream's way
        // to size a point cloud, through a Sprite — stays unbound and is refused by name.
        points.getters["size"] = [](void* self) { return Value::of(as<Material>(self)->size); };
        points.setters["size"] = [](void* self, const Value& v) { as<Material>(self)->size = number(v); };
        points.getters["sizeAttenuation"] = [](void* self) { return Value::of(as<Material>(self)->sizeAttenuation); };
        points.setters["sizeAttenuation"] = [](void* self, const Value& v) { as<Material>(self)->sizeAttenuation = flag(v); };
    }
    registerMeshMaterial(classes["MeshBasicMaterial"], MaterialType::Basic);
    registerMeshMaterial(classes["NodeMaterial"], MaterialType::Basic, true, true);
    registerMeshMaterial(classes["MeshBasicNodeMaterial"], MaterialType::Basic, true);
    registerMeshMaterial(classes["MeshStandardNodeMaterial"], MaterialType::Standard, true);
    registerMeshMaterial(classes["MeshPhysicalNodeMaterial"], MaterialType::Physical, true);
    registerMeshMaterial(classes["MeshLambertMaterial"], MaterialType::Lambert);
    registerMeshMaterial(classes["MeshPhongMaterial"], MaterialType::Phong);
    registerMeshMaterial(classes["MeshStandardMaterial"], MaterialType::Standard);
    registerMeshMaterial(classes["MeshPhysicalMaterial"], MaterialType::Physical);
    registerAmbientLight(classes["AmbientLight"]);
    registerLightShadow(classes["DirectionalLightShadow"], false);
    registerLightShadow(classes["PointLightShadow"], false);
    registerLightShadow(classes["SpotLightShadow"], true);
    registerDirectionalLight(classes["DirectionalLight"]);
    registerPointLight(classes["PointLight"]);
    registerSpotLight(classes["SpotLight"]);
    registerHemisphereLight(classes["HemisphereLight"]);
}

void registerTextureBindings(Registry& classes) {
    ClassBinding& source = classes["Source"];
    source.getters["version"] = [](void* self) { return Value::of(double(as<TextureSource>(self)->version)); };
    source.setters["needsUpdate"] = [](void* self, const Value& v) {
        if (flag(v)) ++as<TextureSource>(self)->version;
    };
    source.getters["dataReady"] = [](void* self) { return Value::of(as<TextureSource>(self)->dataReady); };
    source.setters["dataReady"] = [](void* self, const Value& v) { as<TextureSource>(self)->dataReady = flag(v); };
    registerTextureClass(classes["Texture"], false, "Texture");
    registerTextureClass(classes["DataTexture"], true, "DataTexture");
    classes["DataTexture"].ctorTakesBytes = true;
    classes["DataTexture"].settersTakeBytes = {"image.data"};
    // three's CompressedTexture (PRD-867): block levels uploaded as they are, BC7 or ETC2 RGBA. The ABI takes
    // (levelCount, width, height, format); three's facade turns its `mipmaps` into those and one
    // `mipmaps.N.data = bytes` per level, which is also how a streamed finer level arrives (writeMipLevel).
    {
        ClassBinding& compressed = classes["CompressedTexture"];
        registerTextureClass(compressed, false, "CompressedTexture");
        compressed.ctor = [](const Args& a, Store&) -> std::shared_ptr<void> {
            if (a.size() < 4 || a[0].kind != Value::Kind::Number)
                throw Unsupported{"CompressedTexture takes (levelCount, width, height, format) on the engine ABI"};
            auto texture = std::make_shared<Texture>();
            texture->width = static_cast<uint32_t>(number(a[1]));
            texture->height = static_cast<uint32_t>(number(a[2]));
            texture->flipY = false;  // three's CompressedTexture: blocks cannot be flipped
            texture->generateMipmaps = false;
            try {
                texture->allocateMipmaps(static_cast<uint16_t>(number(a[3])), static_cast<uint32_t>(number(a[0])));
            } catch (const std::invalid_argument& refused) {
                throw Unsupported{refused.what()};
            }
            return std::static_pointer_cast<void>(texture);
        };
        // three's `format` is the block format; the engine's own `format` stays the RGBA one its RGBA paths read.
        compressed.getters["format"] = [](void* self) { return Value::of(double(as<Texture>(self)->imageSource->mipmapFormat)); };
        compressed.setters["format"] = [](void* self, const Value& v) {
            if (static_cast<uint16_t>(number(v)) != as<Texture>(self)->imageSource->mipmapFormat)
                throw Unsupported{"CompressedTexture format is fixed by its constructor (BC7 or ETC2 RGBA)"};
        };
        for (uint32_t level = 0; level < 16; ++level) {  // 16 levels: a full chain of a 32768 px texture
            const std::string path = "mipmaps." + std::to_string(level) + ".data";
            compressed.setters[path] = [level](void* self, const Value& v) {
                // The C ABI hands the typed array's bytes (settersTakeBytes); V8 hands numbers.
                if (v.kind != Value::Kind::Numbers || (!v.bytes.empty() && typedArrayElementBytes(v.text) != 1))
                    throw Unsupported{"CompressedTexture mipmaps[" + std::to_string(level) + "].data must be a Uint8Array"};
                std::vector<uint8_t> blocks(v.bytes.begin(), v.bytes.end());
                if (v.bytes.empty()) blocks.assign(v.numbers.begin(), v.numbers.end());
                try {
                    as<Texture>(self)->writeMipLevel(level, std::move(blocks));
                } catch (const std::invalid_argument& refused) {
                    throw Unsupported{refused.what()};
                }
            };
            compressed.settersTakeBytes.insert(path);
        }
    }
    // three's StorageTexture(width, height) and Storage3DTexture(width, height, depth): a texture a compute kernel
    // writes and a material samples. The 3D one is a volume (prd476's density), sampled with texture3D.
    for (const bool volume : {false, true}) {
        const std::string name = volume ? "Storage3DTexture" : "StorageTexture";
        const double limit = volume ? 2048 : 16384;  // WebGPU's default maxTextureDimension3D and maxTextureDimension2D
        const std::string extents = name + " needs integer extents in [1, " + (volume ? "2048" : "16384") + "]";
        const auto whole = [limit](double n) { return n >= 1 && n <= limit && n == std::floor(n); };
        auto& storage = classes[name];
        registerTextureFields(storage, name.c_str());
        storage.ctor = [volume, extents, whole](const Args& a, Store&) -> std::shared_ptr<void> {
            const double width = optional(a, 0, 1), height = optional(a, 1, 1), depth = volume ? optional(a, 2, 1) : 1;
            if (a.size() > (volume ? 3u : 2u) || !whole(width) || !whole(height) || !whole(depth)) throw Unsupported{extents};
            auto texture = std::make_shared<Texture>();
            texture->storageTexture = true;
            texture->volume = volume;
            texture->width = uint32_t(width); texture->height = uint32_t(height); texture->depth = uint32_t(depth);
            texture->minFilter = texture->magFilter = uint16_t(TextureFilter::Linear);
            return texture;
        };
        storage.getters["isStorageTexture"] = [](void*) { return Value::of(true); };
        if (volume) {
            storage.getters["is3DTexture"] = [](void*) { return Value::of(true); };
            textureNumber<Texture>(storage, "wrapR", &Texture::wrapR);
        }
        storage.getters["mipmapsAutoUpdate"] = [](void* self) { return Value::of(as<Texture>(self)->mipmapsAutoUpdate); };
        storage.setters["mipmapsAutoUpdate"] = [](void* self, const Value& v) { as<Texture>(self)->mipmapsAutoUpdate = flag(v); };
        for (const bool isType : {true, false}) {
            storage.setters[isType ? "type" : "format"] = [isType](void* self, const Value& v) {
                const double n = number(v);
                if (!(n >= 0 && n <= UINT16_MAX) || n != std::floor(n))
                    throw Unsupported{"TN_NATIVE_STORAGE_TEXTURE_FORMAT: type/format must be an unsigned 16-bit integer"};
                auto* texture = as<Texture>(self);
                (isType ? texture->type : texture->format) = uint16_t(n);
                texture->needsUpdate();
            };
        }
        storage.methods["setSize"] = [volume, name, extents, whole](void* self, const Args& a, Store&) {
            if (a.size() != (volume ? 3u : 2u))
                throw Unsupported{name + (volume ? ".setSize needs width, height and depth" : ".setSize needs width and height")};
            const double w = number(a[0]), h = number(a[1]), d = volume ? number(a[2]) : 1;
            if (!whole(w) || !whole(h) || !whole(d)) throw Unsupported{extents};
            auto* texture = as<Texture>(self);
            if (texture->width != w || texture->height != h || texture->depth != d) {
                texture->width = uint32_t(w); texture->height = uint32_t(h); texture->depth = uint32_t(d); texture->needsUpdate();
            }
            return Value{};
        };
    }
    auto& depth = classes["DepthTexture"];
    registerTextureFields(depth, "DepthTexture");
    depth.ctor = [](const Args& a, Store&) -> std::shared_ptr<void> {
        const double width = optional(a, 0, 1), height = optional(a, 1, 1), type = optional(a, 2, 1014);
        if (a.size() > 3 || width < 1 || height < 1 || width > 16384 || height > 16384 ||
            width != std::floor(width) || height != std::floor(height) || (type != 1014 && type != 1015))
            throw Unsupported{"DepthTexture needs integer extents in [1, 16384] and UnsignedIntType or FloatType"};
        auto texture = std::make_shared<Texture>();
        texture->depthTexture = true; texture->width = uint32_t(width); texture->height = uint32_t(height);
        texture->type = uint16_t(type); texture->format = 1026;
        texture->flipY = false; texture->generateMipmaps = false;
        texture->minFilter = texture->magFilter = uint16_t(TextureFilter::Nearest);
        return texture;
    };
    // three's RenderTarget (PRD-551): its size, type and colour texture. The renderer facades draw into it
    // (setRenderTarget) and read it back; a material samples `target.texture`.
    // ponytail: the colour is RGBA16Float whatever the type, so a FloatType target reads back at half
    // precision; depth testing is always on (depthBuffer: false is accepted and not modelled).
    ClassBinding& target = classes["RenderTarget"];
    target.ctor = [](const Args& a, Store&) -> std::shared_ptr<void> {
        const double width = a.size() > 0 ? number(a[0]) : 1, height = a.size() > 1 ? number(a[1]) : 1;
        if (!(width >= 1) || !(height >= 1) || width > 16384 || height > 16384)
            throw Unsupported{"RenderTarget size must be 1 to 16384"};
        uint16_t type = kTextureUnsignedByteType;
        std::optional<uint16_t> minFilter, magFilter, wrapS, wrapT;
        uint16_t format = kTextureRGBAFormat;
        uint32_t count = 1, layers = 1;
        bool generateMipmaps = false;
        if (a.size() > 2 && a[2].kind == Value::Kind::Record)
            for (const auto& [key, value] : a[2].fields) {
                if (key == "minFilter" || key == "magFilter") {
                    // Only an array target keeps a mip chain, so the mip filters wait for `depth` below.
                    const auto filter = static_cast<uint16_t>(number(value));
                    if (filter < uint16_t(TextureFilter::Nearest) || filter > uint16_t(TextureFilter::LinearMipmapLinear) ||
                        (key == "magFilter" && filter != uint16_t(TextureFilter::Nearest) && filter != uint16_t(TextureFilter::Linear)))
                        throw Unsupported{"RenderTarget " + key + " must be a filter constant"};
                    (key == "minFilter" ? minFilter : magFilter) = filter;
                } else if (key == "type") {
                    type = static_cast<uint16_t>(number(value));
                    if (type != kTextureUnsignedByteType && type != kTextureHalfFloatType && type != kTextureFloatType)
                        throw Unsupported{"RenderTarget type must be UnsignedByteType, HalfFloatType or FloatType"};
                } else if (key == "format") {
                    format = static_cast<uint16_t>(number(value));
                    if (format != kTextureRGBAFormat && format != kTextureRGFormat)
                        throw Unsupported{"RenderTarget format must be RGBAFormat or RGFormat"};
                } else if (key == "wrapS" || key == "wrapT") {
                    const auto wrap = static_cast<uint16_t>(number(value));
                    if (wrap != uint16_t(TextureWrap::Repeat) && wrap != uint16_t(TextureWrap::ClampToEdge) &&
                        wrap != uint16_t(TextureWrap::MirroredRepeat))
                        throw Unsupported{"RenderTarget " + key + " must be a wrapping constant"};
                    (key == "wrapS" ? wrapS : wrapT) = wrap;
                } else if (key == "generateMipmaps") {
                    if (value.kind != Value::Kind::Bool) throw Unsupported{"RenderTarget generateMipmaps must be a boolean"};
                    generateMipmaps = value.flag;
                } else if (key == "depth") {
                    // three's array target: `depth` layers, each drawn by setRenderTarget(target, layer).
                    const double n = number(value);
                    if (!(n >= 1 && n <= 256) || n != std::floor(n)) throw Unsupported{"RenderTarget depth must be 1 to 256"};
                    layers = static_cast<uint32_t>(n);
                } else if (key == "count") {
                    // three's MRT: one colour texture per output, 8 at most (WebGPU's maxColorAttachments).
                    const double n = number(value);
                    if (!(n >= 1 && n <= 8) || n != std::floor(n)) throw Unsupported{"RenderTarget count must be 1 to 8"};
                    count = static_cast<uint32_t>(n);
                } else if (key != "depthBuffer" && key != "stencilBuffer") {
                    throw Unsupported{"RenderTarget option " + key + " is not supported natively"};
                }
            }
        // A plain target holds one level: a mip chain after each draw is built for an array target only.
        const bool mipFilter = minFilter && *minFilter != uint16_t(TextureFilter::Nearest) && *minFilter != uint16_t(TextureFilter::Linear);
        if (layers == 1 && (generateMipmaps || mipFilter))
            throw Unsupported{"RenderTarget mipmaps need an array target (depth > 1) natively"};
        auto target = RenderTarget::make(static_cast<uint32_t>(width), static_cast<uint32_t>(height), type, count);
        target->layers = layers;
        for (const auto& attachment : target->more) attachment->layers = layers;
        for (const auto& texture : RenderTarget::texturesOf(*target)) {
            texture->generateMipmaps = generateMipmaps;
            // The texture a material samples is the layer array, read with depth(layer) like a DataArrayTexture.
            texture->array = layers > 1;
            texture->depth = layers;
            if (minFilter) texture->minFilter = *minFilter;
            if (magFilter) texture->magFilter = *magFilter;
            if (wrapS) texture->wrapS = *wrapS;
            if (wrapT) texture->wrapT = *wrapT;
            texture->format = format;
        }
        return target;
    };
    // three's `textures`: every colour texture of the target, `texture` first; an MRT target has `count` of them.
    target.members["textures"] = [](void* self, const Args&, Store& store) {
        Args textures;
        for (const auto& texture : RenderTarget::texturesOf(*as<RenderTarget>(self))) textures.push_back(store.share("Texture", texture));
        return Value::array(std::move(textures));
    };
    fixedMember(target, "texture", [](void* self, const Args&, Store& store) {
        return store.share("Texture", as<RenderTarget>(self)->texture);
    });
    target.members["depthTexture"] = [](void* self, const Args&, Store& store) -> Value {
        const auto& texture = as<RenderTarget>(self)->depthTexture;
        return texture ? store.share("DepthTexture", texture) : Value{};
    };
    target.setters["depthTexture"] = [](void* self, const Value& v, Store& store) {
        auto& target = *as<RenderTarget>(self);
        if (v.kind == Value::Kind::Null) { target.depthTexture.reset(); return; }
        const auto* object = store.find(v);
        if (!object || object->cls != "DepthTexture") throw Unsupported{"RenderTarget depthTexture needs a DepthTexture"};
        auto texture = std::static_pointer_cast<Texture>(object->ptr);
        if (!texture->depthTexture) throw Unsupported{"RenderTarget depthTexture needs a DepthTexture"};
        target.depthTexture = std::move(texture);
        target.setSize(target.width, target.height);
    };
    target.getters["width"] = [](void* self) { return Value::of(double(as<RenderTarget>(self)->width)); };
    target.getters["height"] = [](void* self) { return Value::of(double(as<RenderTarget>(self)->height)); };
    target.methods["setSize"] = [](void* self, const Args& a, Store&) {
        as<RenderTarget>(self)->setSize(static_cast<uint32_t>(number(a.at(0))), static_cast<uint32_t>(number(a.at(1))));
        return chain();
    };
    target.methods["dispose"] = [](void* self, const Args&, Store&) {
        as<RenderTarget>(self)->dispose();
        return Value{};
    };
    // three's RenderTarget extends EventDispatcher and dispatches `dispose`.
    registerEventBindings(
        target, [](void* self) -> EventDispatcher* { return static_cast<EventDispatcher*>(as<RenderTarget>(self)); },
        {"dispose"});
    // three's CanvasTexture: the canvas's RGBA pixels as a DataTexture with Texture's own defaults
    // (flipped rows, linear filters, a generated mip chain). Each back end reads the canvas
    // (getImageData) and passes (pixels, width, height, mapping, wrapS, wrapT, magFilter, minFilter).
    ClassBinding& canvas = classes["CanvasTexture"];
    registerTextureClass(canvas, true, "CanvasTexture");
    canvas.ctor = [](const Args& a, Store&) -> std::shared_ptr<void> {
        // null pixels: a host that copies the canvas itself on the GPU (the web host) gives it next.
        const bool hosted = a.size() >= 3 && (a[0].kind == Value::Kind::Null || a[0].kind == Value::Kind::Undefined);
        if (a.size() < 3 || (!hosted && a[0].kind != Value::Kind::Numbers))
            throw Unsupported{"CanvasTexture takes the canvas's pixels, width and height"};
        const auto width = static_cast<uint32_t>(number(a[1])), height = static_cast<uint32_t>(number(a[2]));
        if (width == 0 || height == 0 || (!hosted && a[0].numbers.size() != std::size_t(width) * height * 4))
            throw Unsupported{"CanvasTexture pixels must be width * height * 4 bytes"};
        auto texture = std::make_shared<DataTexture>();
        if (hosted) {
            texture->width = width;
            texture->height = height;
        } else {
            texture->setImage(a[0].numbers, a[0].text, width, height, kTextureRGBAFormat, kTextureUnsignedByteType);
        }
        texture->flipY = true;
        texture->generateMipmaps = true;
        texture->magFilter = static_cast<uint16_t>(TextureFilter::Linear);
        texture->minFilter = static_cast<uint16_t>(TextureFilter::LinearMipmapLinear);
        uint16_t* const optional[] = {&texture->mapping, &texture->wrapS, &texture->wrapT, &texture->magFilter,
                                      &texture->minFilter};
        for (std::size_t i = 3; i < a.size() && i - 3 < std::size(optional); ++i)
            if (a[i].kind == Value::Kind::Number) *optional[i - 3] = static_cast<uint16_t>(a[i].number);
        texture->needsUpdate();  // three's CanvasTexture sets needsUpdate in its constructor
        return std::static_pointer_cast<void>(texture);
    };
    // three's Data3DTexture(data, width, height, depth): RGBA texels, `depth` slices of width * height,
    // with DataTexture's defaults (nearest filters, no flip, no mipmaps) and its own wrapR.
    ClassBinding& volume = classes["Data3DTexture"];
    registerTextureClass(volume, true, "Data3DTexture");
    volume.ctor = [](const Args& a, Store&) -> std::shared_ptr<void> {
        auto texture = std::make_shared<DataTexture>();
        texture->volume = true;
        const auto size = [&](std::size_t i) { return a.size() > i ? static_cast<uint32_t>(number(a[i])) : 1u; };
        // three's RenderTarget3D makes `new Data3DTexture(null, width, height, depth)`: a sized volume with no texels,
        // which the engine holds as texels written on the GPU (`dataReady` false) until `image.data` brings some.
        if (a.size() > 1 && (a[0].kind == Value::Kind::Null || a[0].kind == Value::Kind::Undefined)) {
            texture->width = size(1); texture->height = size(2); texture->depth = size(3);
            if (texture->width == 0 || texture->height == 0 || texture->depth == 0)
                throw Unsupported{"Data3DTexture width, height and depth must be at least 1"};
            texture->dataReady = false;
            return std::static_pointer_cast<void>(texture);
        }
        if (a.empty() || a[0].kind != Value::Kind::Numbers) return std::static_pointer_cast<void>(texture);
        const uint32_t width = size(1), height = size(2), depth = size(3);
        if (width == 0 || height == 0 || depth == 0 || a[0].numbers.size() != std::size_t(width) * height * depth * 4)
            throw Unsupported{"Data3DTexture data must be width * height * depth * 4 RGBA values"};
        if (a[0].text == "Uint16Array") throw Unsupported{"Data3DTexture data must be bytes or floats"};
        const uint16_t type = a[0].text == "Float32Array" ? kTextureFloatType : kTextureUnsignedByteType;
        texture->setImage(a[0].numbers, a[0].text, width, height, kTextureRGBAFormat, type);
        texture->depth = depth;
        return std::static_pointer_cast<void>(texture);
    };
    textureNumber<Texture>(volume, "wrapR", &Texture::wrapR);
    volume.setters["type"] = [](void* self, const Value& v) {
        const auto type = number(v);
        if (type != kTextureFloatType && type != kTextureHalfFloatType && type != kTextureUnsignedByteType)
            throw Unsupported{"Data3DTexture type must be UnsignedByteType, FloatType or HalfFloatType"};
        as<Texture>(self)->type = static_cast<uint16_t>(type);
    };
    // three's `texture.image.data = array` for a volume: width * height * depth texels.
    volume.setters["image.data"] = [](void* self, const Value& v) {
        auto* texture = as<DataTexture>(self);
        const std::size_t texels = std::size_t(texture->width) * texture->height * texture->depth;
        if (v.kind != Value::Kind::Numbers || texels == 0 || v.numbers.size() != texels * 4)
            throw Unsupported{"image.data must be a typed array of width * height * depth * 4 values"};
        if (texture->isHalfFloat()) checkHalfFloatBits(v.numbers);
        const uint32_t depth = texture->depth;
        texture->setImage(v.numbers, v.text, texture->width, texture->height, texture->format, texture->type, false);
        texture->depth = depth;
        texture->dataReady = true;  // a volume made with null data uploads the texels it is given
    };
    // three's CubeTexture(images, mapping, wrapS, wrapT, magFilter, minFilter, format, type): six faces sampled along a
    // direction. Natively only a render target's faces are bound (CubeRenderTarget's six `{ width, height }` records),
    // whose texels the GPU writes; six images with pixels are refused at construction.
    ClassBinding& cube = classes["CubeTexture"];
    registerTextureClass(cube, false, "CubeTexture");
    cube.ctor = [](const Args& a, Store&) -> std::shared_ptr<void> {
        auto texture = std::make_shared<Texture>();
        texture->array = texture->cube = true;
        texture->depth = 6;
        texture->flipY = false;
        texture->mapping = 301;  // CubeReflectionMapping
        if (a.empty() || a[0].kind == Value::Kind::Null || a[0].kind == Value::Kind::Undefined ||
            (a[0].kind == Value::Kind::Array && a[0].items.empty())) {
            texture->width = texture->height = 0;  // an empty cube, as three's `new CubeTexture()`
        } else {
            const auto faceSize = [](const Value& face, const char* key) -> uint32_t {
                if (face.kind != Value::Kind::Record) return 0;
                for (const auto& [name, value] : face.fields) {
                    if (name == "data" && value.kind != Value::Kind::Null && value.kind != Value::Kind::Undefined) return 0;
                    if (name == key && value.kind == Value::Kind::Number && value.number >= 1 && value.number <= 16384)
                        return static_cast<uint32_t>(value.number);
                }
                return 0;
            };
            if (a[0].kind != Value::Kind::Array || a[0].items.size() != 6)
                throw Unsupported{"CubeTexture images must be six render-target faces"};
            texture->width = faceSize(a[0].items[0], "width");
            texture->height = faceSize(a[0].items[0], "height");
            for (const auto& face : a[0].items)
                if (texture->width == 0 || texture->height != texture->width || faceSize(face, "width") != texture->width ||
                    faceSize(face, "height") != texture->height)
                    throw Unsupported{"CubeTexture images must be six square render-target faces of one size, with no pixels"};
        }
        texture->dataReady = false;  // the GPU writes the faces (copyTextureToTexture, a CubeCamera render)
        uint16_t* const optional[] = {&texture->mapping, &texture->wrapS, &texture->wrapT, &texture->magFilter,
                                      &texture->minFilter};
        for (std::size_t i = 1; i < a.size() && i - 1 < std::size(optional); ++i)
            if (a[i].kind == Value::Kind::Number) *optional[i - 1] = static_cast<uint16_t>(a[i].number);
        if (a.size() > 7 && a[7].kind == Value::Kind::Number) texture->type = static_cast<uint16_t>(a[7].number);
        if (texture->type != kTextureUnsignedByteType && texture->type != kTextureFloatType && texture->type != kTextureHalfFloatType)
            throw Unsupported{"CubeTexture type must be UnsignedByteType, FloatType or HalfFloatType"};
        return std::static_pointer_cast<void>(texture);
    };
    // A cube holds no CPU texels, so its type (the GPU format) is free until the GPU texture exists.
    cube.setters["type"] = [](void* self, const Value& v) {
        const auto type = static_cast<uint16_t>(number(v));
        if (type != kTextureUnsignedByteType && type != kTextureFloatType && type != kTextureHalfFloatType)
            throw Unsupported{"CubeTexture type must be UnsignedByteType, FloatType or HalfFloatType"};
        as<Texture>(self)->type = type;
    };
    // three's DataArrayTexture(data, width, height, depth): `depth` layers of width * height RGBA texels, with
    // DataTexture's defaults (nearest filters, no flip, no mipmaps). The typed array crosses as bytes, as a
    // DataTexture's does: a splat array is megabytes, and a double per byte would be eight times that.
    ClassBinding& layers = classes["DataArrayTexture"];
    registerTextureClass(layers, true, "DataArrayTexture");
    layers.ctorTakesBytes = true;
    layers.settersTakeBytes = {"image.data"};
    layers.ctor = [](const Args& a, Store&) -> std::shared_ptr<void> {
        auto texture = std::make_shared<DataTexture>();
        texture->array = true;
        if (a.empty() || a[0].kind != Value::Kind::Numbers) return std::static_pointer_cast<void>(texture);
        const auto size = [&](std::size_t i) { return a.size() > i ? static_cast<uint32_t>(number(a[i])) : 1u; };
        const uint32_t width = size(1), height = size(2), depth = size(3);
        const std::size_t count = a[0].bytes.empty() ? a[0].numbers.size() : a[0].bytes.size() / typedArrayElementBytes(a[0].text);
        if (width == 0 || height == 0 || depth == 0 || count != std::size_t(width) * height * depth * 4)
            throw Unsupported{"DataArrayTexture data must be width * height * depth * 4 RGBA values"};
        if (a[0].text == "Uint16Array") throw Unsupported{"DataArrayTexture data must be bytes or floats"};
        const uint16_t type = a[0].text == "Float32Array" ? kTextureFloatType : kTextureUnsignedByteType;
        if (a[0].bytes.empty() || !texture->setImageBytes(a[0].bytes, a[0].text, width, height, kTextureRGBAFormat, type))
            texture->setImage(a[0].bytes.empty() ? a[0].numbers : typedArrayNumbers(a[0].text, a[0].bytes), a[0].text,
                              width, height, kTextureRGBAFormat, type);
        texture->depth = depth;
        return std::static_pointer_cast<void>(texture);
    };
    // three's `texture.image.data = array` for an array texture: width * height * depth texels, uploaded on needsUpdate.
    layers.setters["image.data"] = [](void* self, const Value& v) {
        auto* texture = as<DataTexture>(self);
        const std::size_t texels = std::size_t(texture->width) * texture->height * texture->depth;
        const std::size_t count = v.bytes.empty() ? v.numbers.size() : v.bytes.size() / typedArrayElementBytes(v.text);
        // An empty array releases the CPU copy of texels the GPU holds (`source.dataReady = false`), as in three.
        if (v.kind == Value::Kind::Numbers && count == 0 && !texture->dataReady) return std::vector<uint8_t>().swap(texture->data);
        if (v.kind != Value::Kind::Numbers || texels == 0 || count != texels * 4)
            throw Unsupported{"image.data must be a typed array of width * height * depth * 4 values"};
        const uint32_t depth = texture->depth;
        if (v.bytes.empty() || !texture->setImageBytes(v.bytes, v.text, texture->width, texture->height, texture->format,
                                                       texture->type, false)) {
            const std::vector<double> values = v.bytes.empty() ? v.numbers : typedArrayNumbers(v.text, v.bytes);
            if (texture->isHalfFloat()) checkHalfFloatBits(values);
            texture->setImage(values, v.text, texture->width, texture->height, texture->format, texture->type, false);
        }
        texture->depth = depth;
    };
}

}  // namespace tn::binding
