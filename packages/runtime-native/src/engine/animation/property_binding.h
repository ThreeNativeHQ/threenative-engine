#pragma once

#include <cstddef>
#include <memory>
#include <optional>
#include <string>
#include <string_view>

#include "engine/scene/camera.h"
#include "engine/foundation/prefetch.h"
#include "engine/scene/material.h"
#include "engine/scene/object3d.h"

namespace tn::engine { class Bone; }

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
    // Hot members first: every apply of a track reads them, so a binding costs one cache line, not the
    // lines the parsed path and diagnostics sit on.
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

    std::weak_ptr<Object3D> node_;
    // node_'s object, read after a node_.expired() check instead of a lock() per apply.
    // ponytail: safe while one thread owns the scene; PRD-574 swaps in a frame-scoped strong
    // reference if a second thread can release nodes.
    Object3D* raw_ = nullptr;
    Bone* bone_ = nullptr;
    Target target_ = Target::Unavailable;
    bool bindAttempted_ = false; // three's `_getValue_unbound`: the first get or set binds
    int component_ = 0;

  public:
    PropertyBinding(const std::shared_ptr<Object3D>& root, std::string path);

    void bind();
    void unbind();
    void materializeValue();
    [[nodiscard]] bool bound() const { return target_ != Target::Unavailable; }
    [[nodiscard]] bool unescapedBoneTransform() const;
    /** The object cached by bind(), for the animation audit's targetObject reflection. */
    [[nodiscard]] std::shared_ptr<Object3D> targetNode() const { return bound() ? node_.lock() : nullptr; }
    [[nodiscard]] std::shared_ptr<Material> targetMaterial() const { return bound() ? material_ : nullptr; }

    void getValue(double* buffer, std::size_t offset);
    void setValue(const double* buffer, std::size_t offset);

    /**
     * A track writes once a frame, long after the frame before it evicted everything, so the first
     * touch of the node and of its transform columns misses. The mixer calls these a few tracks ahead:
     * `prefetchNode` starts the node's own lines, `prefetchColumns` (once those arrived) the columns the
     * write lands on. They read nothing the write does not, and a binding that is not bound ignores them.
     */
    void prefetchNode() const {
        if (raw_ == nullptr) return;
        TN_PREFETCH(reinterpret_cast<const char*>(raw_) - 16, 1, 3); // the shared_ptr count the write checks
        TN_PREFETCH(raw_, 1, 3);
        TN_PREFETCH(&raw_->matrixWorldNeedsUpdate, 1, 3);
    }
    void prefetchColumns() const {
        if (raw_ == nullptr) return;
        switch (target_) {
        case Target::Position: TN_PREFETCH(&raw_->position, 1, 3); break;
        case Target::Scale: TN_PREFETCH(&raw_->scale, 1, 3); break;
        case Target::Quaternion:
            TN_PREFETCH(&raw_->quaternion, 1, 3);
            TN_PREFETCH(&raw_->rotation, 1, 3);
            break;
        default: break;
        }
    }

    const std::string path;
    /** Why the last bind left this unavailable, empty when it bound. */
    std::string diagnostic;

  private:
    std::weak_ptr<Object3D> root_;
    ParsedPath parsed_;
    bool parsedOk_ = false;
    Vector3& (Object3D::*vector_)() = nullptr; // the vector a component binding writes
    std::size_t morphIndex_ = 0;
    std::shared_ptr<Material> material_; // the material bound, held until unbind like three's targetObject
    double Material::* materialNumber_ = nullptr;
    Color Material::* materialColor_ = nullptr;
    double PerspectiveCamera::* cameraNumber_ = nullptr;
};

} // namespace tn::engine::animation
