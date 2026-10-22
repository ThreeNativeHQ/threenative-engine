#pragma once

// three@0.185.1's lights the native renderer draws (PRD-514): Light, AmbientLight, DirectionalLight,
// HemisphereLight, PointLight and SpotLight, and their shadows. Skipped: RectAreaLight/LightProbe
// (not yet drawn), SpotLight.map, VSM and basic shadow types, dispose, toJSON.

#include <memory>

#include "engine/foundation/math/Color.h"
#include "engine/foundation/math/Vector.h"
#include "engine/scene/camera.h"
#include "engine/scene/object3d.h"
#include "engine/renderer/shadows/virtual/atlas.h"

namespace tn::engine {

class Light : public Object3D {
public:
    explicit Light(Color color = Color(1, 1, 1), double intensity = 1) : color(color), intensity(intensity) {}
    [[nodiscard]] std::string_view type() const override { return "Light"; }
    [[nodiscard]] bool isLight() const override { return true; }
    Color color;
    double intensity;
};

class AmbientLight : public Light {
public:
    using Light::Light;
    [[nodiscard]] std::string_view type() const override { return "AmbientLight"; }
};

/**
 * three's LightShadow with its defaults: the camera the shadow map is drawn from, the map's size in
 * texels, and the receiver-side bias, normal offset, filter radius and darkness.
 */
class LightShadow {
public:
    explicit LightShadow(std::shared_ptr<Camera> camera) : camera(std::move(camera)) {}
    /** Shared like any Object3D: a scene, a LOD or a Raycaster that holds it keeps it alive past the light. */
    std::shared_ptr<Camera> camera;
    std::shared_ptr<const shadows::AtlasOptions> virtualShadow;
    // sourceAngleShadowFilter on a sun: {sourceAngleRad, blockerSamples, filterSamples, minPenumbraPixels}.
    std::optional<std::array<double, 4>> sourceAngleFilter;
    // sourceRadiusShadowFilter on a lamp: {sourceRadius m, blockerSamples, filterSamples, penumbraScale}.
    std::optional<std::array<double, 4>> sourceRadiusFilter;
    double intensity = 1;
    double bias = 0;
    double normalBias = 0;
    double radius = 1;
    Vector2 mapSize{512, 512};
    double focus = 1;  // SpotLightShadow: the share of the cone the shadow camera's fov covers
    double aspect = 1; // SpotLightShadow: a factor on the map's aspect
};

/**
 * The source-angle filter reads the virtual atlas, so a shadow that has the filter and no
 * VirtualShadowNode is refused at render, whichever of the two was set first. Null when fine.
 */
template <class Shadow>
[[nodiscard]] inline const char* sourceAngleFilterRefusal(const Shadow& shadow) {
    return shadow.sourceAngleFilter && !shadow.virtualShadow
        ? "TN_VIRTUAL_SHADOW_UNSUPPORTED: sourceAngleShadowFilter requires VirtualShadowNode; "
          "set light.shadow.shadowNode = new VirtualShadowNode(light)"
        : nullptr;
}

class DirectionalLight : public Light {
public:
    explicit DirectionalLight(Color color = Color(1, 1, 1), double intensity = 1);
    [[nodiscard]] std::string_view type() const override { return "DirectionalLight"; }
    /** The light points from its position towards target's world position; not in the scene by default. */
    std::shared_ptr<Object3D> target;
    /** DirectionalLightShadow: an OrthographicCamera(-5, 5, 5, -5, 0.5, 500). */
    LightShadow shadow{std::make_shared<OrthographicCamera>(-5, 5, 5, -5, 0.5, 500)};
};

/** three's PointLight: light from its world position; `distance` 0 is no cutoff; `decay` 2 is physical. */
class PointLight : public Light {
public:
    explicit PointLight(Color color = Color(1, 1, 1), double intensity = 1, double distance = 0, double decay = 2)
        : Light(color, intensity), distance(distance), decay(decay) {}
    [[nodiscard]] std::string_view type() const override { return "PointLight"; }
    double distance;
    double decay;
    /** Unreal's Source Radius in metres (PRD-653): a rough diffuse surface blends back to Lambert as the lamp grows. */
    double sourceRadius = 0;
    /** PointLightShadow: a PerspectiveCamera(90, 1, 0.5, 500) turned to each cube face. */
    LightShadow shadow{std::make_shared<PerspectiveCamera>(90, 1, 0.5, 500)};
};

/** three's SpotLight: a point light limited to a cone towards `target` (off the scene by default). */
class SpotLight : public Light {
public:
    explicit SpotLight(Color color = Color(1, 1, 1), double intensity = 1, double distance = 0,
                       double angle = 1.0471975511965976, double penumbra = 0, double decay = 2);
    [[nodiscard]] std::string_view type() const override { return "SpotLight"; }
    double distance;
    double angle;    // radians, the cone's half angle; three's default is PI / 3
    double penumbra; // 0..1, the fraction of the cone that fades
    double decay;
    /** Unreal's Source Radius in metres (PRD-653), as on PointLight. */
    double sourceRadius = 0;
    /** Shared like a DirectionalLight's, so a scene that holds it as a child can hand it to a walk. */
    std::shared_ptr<Object3D> target;
    /** SpotLightShadow: a PerspectiveCamera(50, 1, 0.5, 500) fitted to the cone each frame. */
    LightShadow shadow{std::make_shared<PerspectiveCamera>(50, 1, 0.5, 500)};
};

class HemisphereLight : public Light {
public:
    HemisphereLight(Color skyColor = Color(1, 1, 1), Color groundColor = Color(1, 1, 1), double intensity = 1);
    [[nodiscard]] std::string_view type() const override { return "HemisphereLight"; }
    Color groundColor;
};

}  // namespace tn::engine
