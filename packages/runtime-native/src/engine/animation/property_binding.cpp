#include "engine/animation/property_binding.h"

#include <array>
#include <cmath>
#include <regex>
#include <unordered_map>
#include <utility>

#include "engine/scene/camera.h"
#include "engine/scene/lights.h"
#include "engine/scene/material.h"
#include "engine/scene/nodes.h"

namespace tn::engine::animation {

namespace {

// three's `_trackRe`, assembled from the same pieces: reserved characters are `[ ] . : /`.
const std::regex& trackRe() {
    static const std::regex re(
        R"(^((?:[^\[\]\.:\/]+[\/:])*)([^\[\]:\/]+)?(?:\.([^\[\]\.:\/]+)(?:\[(.+)\])?)?\.([^\[\]\.:\/]+)(?:\[(.+)\])?$)",
        std::regex::ECMAScript);
    return re;
}

constexpr std::array<std::string_view, 4> kSupportedObjectNames = {"material", "materials", "bones", "map"};

std::optional<std::string> group(const std::smatch& m, std::size_t i) {
    return m[i].matched ? std::optional<std::string>(m[i].str()) : std::nullopt;
}

Object3D* searchNodeSubtree(const std::vector<Object3D*>& children, const std::string& nodeName) {
    for (Object3D* child : children) {
        if (child->name == nodeName)
            return child;
        if (Object3D* result = searchNodeSubtree(child->children, nodeName))
            return result;
    }
    return nullptr;
}

} // namespace

bool parseTrackName(std::string_view trackName, ParsedPath& out, std::string& error) {
    // Every action binds the same few track names again and the regex costs more than the bind.
    // ponytail: the cache is dropped whole when it fills; an LRU if a game cycles more names.
    thread_local std::unordered_map<std::string, ParsedPath> parsed;
    const std::string name(trackName);
    if (const auto hit = parsed.find(name); hit != parsed.end()) {
        out = hit->second;
        return true;
    }
    if (parsed.size() >= 4096) parsed.clear();
    std::smatch m;
    if (!std::regex_match(name, m, trackRe())) {
        error = "THREE.PropertyBinding: Cannot parse trackName: " + name;
        return false;
    }
    out = ParsedPath{group(m, 2), group(m, 3), group(m, 4), m[5].str(), group(m, 6)};
    if (out.nodeName) {
        const std::size_t lastDot = out.nodeName->rfind('.');
        if (lastDot != std::string::npos) {
            const std::string objectName = out.nodeName->substr(lastDot + 1);
            for (std::string_view supported : kSupportedObjectNames) {
                if (objectName == supported) {
                    out.nodeName = out.nodeName->substr(0, lastDot);
                    out.objectName = objectName;
                    break;
                }
            }
        }
    }
    if (out.propertyName.empty()) {
        error = "THREE.PropertyBinding: can not parse propertyName from trackName: " + name;
        return false;
    }
    parsed.emplace(name, out);
    return true;
}

Object3D* findNode(Object3D& root, const std::optional<std::string>& nodeName) {
    if (!nodeName || nodeName->empty() || *nodeName == "." || *nodeName == root.name)
        return &root;
    return searchNodeSubtree(root.children, *nodeName);
}

PropertyBinding::PropertyBinding(const std::shared_ptr<Object3D>& root, std::string trackPath)
    : path(std::move(trackPath)), root_(root) {
    std::string error;
    parsedOk_ = parseTrackName(path, parsed_, error);
    if (!parsedOk_) {
        diagnostic = error;
        return;
    }
    // Like three, the node is looked up once here; bind() searches again only after unbind().
    if (Object3D* found = findNode(*root, parsed_.nodeName))
        node_ = found->weak_from_this();
    raw_ = node_.lock().get();
}

namespace {

// The material properties a track may drive, by the material types three declares them on. The
// Physical setters that bump `version` on their own when crossing zero (clearcoat, sheen,
// transmission, iridescence, anisotropy, dispersion) are left out until they are ported with it.
double Material::* materialNumber(std::string_view property, MaterialType type) {
    const bool lit = type != MaterialType::Basic,
               pbr = type == MaterialType::Standard || type == MaterialType::Physical;
    if (property == "opacity")
        return &Material::opacity;
    if (property == "alphaTest")
        return &Material::alphaTest;
    if (property == "emissiveIntensity" && lit)
        return &Material::emissiveIntensity;
    if (property == "roughness" && pbr)
        return &Material::roughness;
    if (property == "metalness" && pbr)
        return &Material::metalness;
    if (property == "shininess" && type == MaterialType::Phong)
        return &Material::shininess;
    if (property == "ior" && type == MaterialType::Physical)
        return &Material::ior;
    if (property == "specularIntensity" && type == MaterialType::Physical)
        return &Material::specularIntensity;
    return nullptr;
}

Color Material::* materialColor(std::string_view property, MaterialType type) {
    if (property == "color")
        return &Material::color;
    if (property == "emissive" && type != MaterialType::Basic)
        return &Material::emissive;
    if (property == "specular" && type == MaterialType::Phong)
        return &Material::specular;
    if (property == "specularColor" && type == MaterialType::Physical)
        return &Material::specularColor;
    return nullptr;
}

double PerspectiveCamera::* cameraNumber(std::string_view property) {
    if (property == "fov")
        return &PerspectiveCamera::fov;
    if (property == "zoom")
        return &PerspectiveCamera::zoom;
    if (property == "near")
        return &PerspectiveCamera::near;
    if (property == "far")
        return &PerspectiveCamera::far;
    if (property == "aspect")
        return &PerspectiveCamera::aspect;
    if (property == "focus")
        return &PerspectiveCamera::focus;
    return nullptr;
}

} // namespace

void PropertyBinding::bind() {
    bindAttempted_ = true;
    target_ = Target::Unavailable;
    material_.reset();
    if (!parsedOk_)
        return; // three throws in the constructor; the diagnostic says why
    std::shared_ptr<Object3D> node = node_.lock();
    if (!node) {
        const std::shared_ptr<Object3D> root = root_.lock();
        Object3D* found = root ? findNode(*root, parsed_.nodeName) : nullptr;
        node = found ? found->weak_from_this().lock() : nullptr;
        node_ = node; // an object no shared_ptr owns cannot be held, so it reads as not found
    }
    raw_ = node.get();
    if (!node) {
        diagnostic = "PropertyBinding: No target node found for track: " + path + ".";
        return;
    }
    const auto unsupported = [&](const std::string& what) {
        diagnostic = "TN_NATIVE_ANIMATION_PATH_UNSUPPORTED: " + path + " (" + what + ")";
    };
    const std::string& property = parsed_.propertyName;
    const auto bound = [&](Target target) {
        target_ = target;
        diagnostic.clear();
    };

    // `.material.<property>`: three binds the mesh's material object itself, with NeedsUpdate
    // versioning, and keeps that object until unbind even if the mesh takes another one.
    if (parsed_.objectName) {
        auto* mesh = dynamic_cast<Mesh*>(node.get());
        if (*parsed_.objectName != "material" || parsed_.objectIndex || !mesh || !mesh->material)
            return unsupported("object " + *parsed_.objectName);
        if (parsed_.propertyIndex)
            return unsupported("property " + property + "[" + *parsed_.propertyIndex + "]");
        material_ = mesh->material;
        if ((materialNumber_ = materialNumber(property, material_->type)))
            return bound(Target::MaterialNumber);
        if ((materialColor_ = materialColor(property, material_->type)))
            return bound(Target::MaterialColor);
        material_.reset();
        return unsupported("material property " + property);
    }

    // morphTargetInfluences: the mesh's array whole (EntireArray), or one element of it
    // (ArrayElement), the index read through morphTargetDictionary — which, for unnamed morph
    // attributes, maps each index's own decimal string to it.
    if (property == "morphTargetInfluences") {
        auto* mesh = dynamic_cast<Mesh*>(node.get());
        if (!mesh || !mesh->geometry) return unsupported("morphTargetInfluences without a geometry");
        if (!parsed_.propertyIndex) return bound(Target::MorphArray);
        const std::string& index = *parsed_.propertyIndex;
        if (index.empty() || !std::all_of(index.begin(), index.end(), [](char c) { return c >= '0' && c <= '9'; }))
            return unsupported("morph target name " + index); // named morph attributes are not carried yet
        morphIndex_ = std::stoul(index);
        return bound(Target::MorphElement);
    }

    Vector3& (Object3D::*vector)() = property == "position" ? &Object3D::positionValue
                                 : property == "scale"  ? &Object3D::scaleValue
                                                        : nullptr;
    if (parsed_.propertyIndex) {
        static constexpr std::array<std::string_view, 3> kComponents = {"x", "y", "z"};
        for (int i = 0; i < 3 && vector; ++i) {
            if (*parsed_.propertyIndex == kComponents[i]) {
                vector_ = vector;
                component_ = i;
                return bound(Target::Component);
            }
        }
        return unsupported("property " + property + "[" + *parsed_.propertyIndex + "]");
    }
    if (property == "position")
        return bound(Target::Position);
    if (property == "scale")
        return bound(Target::Scale);
    if (property == "quaternion")
        return bound(Target::Quaternion);
    if (property == "visible")
        return bound(Target::Visible);
    if (dynamic_cast<Light*>(node.get())) {
        if (property == "intensity")
            return bound(Target::LightIntensity);
        if (property == "color")
            return bound(Target::LightColor);
    }
    if (dynamic_cast<PerspectiveCamera*>(node.get()) && (cameraNumber_ = cameraNumber(property)))
        return bound(Target::CameraNumber);
    return unsupported("property " + property);
}

void PropertyBinding::unbind() {
    node_.reset();
    material_.reset();
    target_ = Target::Unavailable;
    bindAttempted_ = false;
}

void PropertyBinding::getValue(double* buffer, std::size_t offset) {
    if (!bindAttempted_)
        bind();
    Object3D* node = node_.expired() ? nullptr : raw_;
    if (!node)
        return;
    const auto put = [&](const auto& array) { std::copy(array.begin(), array.end(), buffer + offset); };
    switch (target_) {
    case Target::Unavailable:
        return;
    case Target::Position:
        return put(node->position.toArray());
    case Target::Scale:
        return put(node->scale.toArray());
    case Target::Quaternion:
        return put(node->quaternion.toArray());
    case Target::Component:
        buffer[offset] = (((*node).*vector_)()).getComponent(component_);
        return;
    case Target::Visible:
        buffer[offset] = node->visible() ? 1 : 0;
        return;
    case Target::MaterialNumber:
        buffer[offset] = (*material_).*materialNumber_;
        return;
    case Target::MaterialColor: {
        const Color& c = (*material_).*materialColor_;
        return put(std::array<double, 3>{c.r, c.g, c.b});
    }
    case Target::LightIntensity:
        buffer[offset] = static_cast<Light&>(*node).intensity;
        return;
    case Target::LightColor: {
        const Color& c = static_cast<Light&>(*node).color;
        return put(std::array<double, 3>{c.r, c.g, c.b});
    }
    case Target::CameraNumber:
        buffer[offset] = static_cast<PerspectiveCamera&>(*node).*cameraNumber_;
        return;
    case Target::MorphArray:
        return put(static_cast<Mesh&>(*node).morphTargetInfluences);
    case Target::MorphElement: {
        const auto& influences = static_cast<Mesh&>(*node).morphTargetInfluences;
        buffer[offset] = morphIndex_ < influences.size() ? influences[morphIndex_] : std::nan(""); // JS undefined
        return;
    }
    }
}

// three's setters by versioning: an Object3D target flags matrixWorldNeedsUpdate, a material
// target sets needsUpdate (its version moves on every write, as three's does).
void PropertyBinding::setValue(const double* buffer, std::size_t offset) {
    if (!bindAttempted_)
        bind();
    Object3D* node = node_.expired() ? nullptr : raw_;
    if (!node || target_ == Target::Unavailable)
        return;
    const int at = static_cast<int>(offset);
    switch (target_) {
    case Target::Unavailable:
        return;
    case Target::Position:
        node->position.fromArray(buffer, at);
        break;
    case Target::Scale:
        node->scale.fromArray(buffer, at);
        break;
    case Target::Quaternion:
        node->quaternion.fromArray(buffer, at);
        break;
    case Target::Component:
        (((*node).*vector_)()).setComponent(component_, buffer[offset]);
        break;
    // three stores the number itself; any read of `visible` treats it as JavaScript truthiness.
    case Target::Visible:
        node->setVisible(buffer[offset] != 0 && !std::isnan(buffer[offset]));
        break;
    case Target::MaterialNumber:
        (*material_).*materialNumber_ = buffer[offset];
        material_->needsUpdate();
        return;
    case Target::MaterialColor:
        ((*material_).*materialColor_).fromArray(buffer, at);
        material_->needsUpdate();
        return;
    case Target::LightIntensity:
        static_cast<Light&>(*node).intensity = buffer[offset];
        break;
    case Target::LightColor:
        static_cast<Light&>(*node).color.fromArray(buffer, at);
        break;
    case Target::CameraNumber:
        static_cast<PerspectiveCamera&>(*node).*cameraNumber_ = buffer[offset];
        break;
    case Target::MorphArray: {
        auto& influences = static_cast<Mesh&>(*node).morphTargetInfluences;
        std::copy(buffer + offset, buffer + offset + influences.size(), influences.begin());
        break;
    }
    case Target::MorphElement: {
        auto& influences = static_cast<Mesh&>(*node).morphTargetInfluences;
        if (morphIndex_ < influences.size()) influences[morphIndex_] = buffer[offset];
        break;
    }
    }
    node->matrixWorldNeedsUpdate = true;
}

} // namespace tn::engine::animation
