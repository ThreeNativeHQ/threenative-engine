#pragma once

#include <cstddef>
#include <memory>
#include <optional>
#include <string>
#include <string_view>

#include "engine/scene/camera.h"
#include "engine/scene/material.h"
#include "engine/scene/object3d.h"

namespace tn::engine::animation {

/** three's `PropertyBinding.parseTrackName` result; an absent part is three's `undefined`. */
struct ParsedPath {
    std::optional<std::string> nodeName, objectName, objectIndex;
    std::string propertyName;
    std::optional<std::string> propertyIndex;
};

/** three's `parseTrackName`: false, with three's message in `error`, where three throws. */
bool parseTrackName(std::string_view trackName, ParsedPath& out, std::string& error);

/**
 * three's `PropertyBinding.findNode`: the root itself for no name, "" or "." or the root's name,
 * else the first descendant with that name in three's depth-first order. The native object has no
 * `uuid` and no skeleton yet (PRD-518), so a name is only ever matched against `name`.
 */
Object3D* findNode(Object3D& root, const std::optional<std::string>& nodeName);

/**
 * three's `PropertyBinding` for an object's transform and visibility (`position`, `quaternion`,
 * `scale`, whole or one component as `[x]`, and `visible`), a light's `intensity` and `color`, a
 * perspective camera's `fov`, `zoom`, `near`, `far`, `aspect` and `focus`, and `.material.<property>`
 * for the material's numbers and colours its type declares. Like three, it binds on the first get
 * or set after construction or `unbind()`, and the node it found stays bound until `unbind()`, even
 * after it leaves the root; the next bind searches again.
 * Any other path (another object name, a material array, morph influences, a property not listed)
 * leaves the binding unavailable with TN_NATIVE_ANIMATION_PATH_UNSUPPORTED naming the path in
 * `diagnostic`; an unavailable binding's get and set do nothing, as three's do.
 */
class PropertyBinding {
  public:
    PropertyBinding(const std::shared_ptr<Object3D>& root, std::string path);

    void bind();
    void unbind();
    [[nodiscard]] bool bound() const { return target_ != Target::Unavailable; }
    /** The object cached by bind(), for the animation audit's targetObject reflection. */
    [[nodiscard]] std::shared_ptr<Object3D> targetNode() const { return bound() ? node_.lock() : nullptr; }
    [[nodiscard]] std::shared_ptr<Material> targetMaterial() const { return bound() ? material_ : nullptr; }

    void getValue(double* buffer, std::size_t offset);
    void setValue(const double* buffer, std::size_t offset);

    const std::string path;
    /** Why the last bind left this unavailable, empty when it bound. */
    std::string diagnostic;

  private:
    enum class Target {
        Unavailable,
        Position,
        Quaternion,
        Scale,
        Component,
        Visible,
        MaterialNumber,
        MaterialColor,
        LightIntensity,
        LightColor,
        CameraNumber,
        MorphArray,   // `morphTargetInfluences`: three's EntireArray binding
        MorphElement  // `morphTargetInfluences[i]`: three's ArrayElement binding
    };

    std::weak_ptr<Object3D> root_;
    std::weak_ptr<Object3D> node_;
    // node_'s object, read after a node_.expired() check instead of a lock() per apply.
    // ponytail: safe while one thread owns the scene; PRD-574 swaps in a frame-scoped strong
    // reference if a second thread can release nodes.
    Object3D* raw_ = nullptr;
    ParsedPath parsed_;
    bool parsedOk_ = false;
    bool bindAttempted_ = false; // three's `_getValue_unbound`: the first get or set binds
    Target target_ = Target::Unavailable;
    Vector3& (Object3D::*vector_)() = nullptr; // the vector a component binding writes
    int component_ = 0;
    std::size_t morphIndex_ = 0;
    std::shared_ptr<Material> material_; // the material bound, held until unbind like three's targetObject
    double Material::* materialNumber_ = nullptr;
    Color Material::* materialColor_ = nullptr;
    double PerspectiveCamera::* cameraNumber_ = nullptr;
};

} // namespace tn::engine::animation
