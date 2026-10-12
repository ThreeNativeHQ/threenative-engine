#pragma once

// three@0.185.1 core/Raycaster.js and objects/{Mesh,InstancedMesh,LOD}.js.
// Ray is the existing operation-for-operation foundation port. No native Sprite/Line/Points exist.
#include "engine/foundation/math/Primitives.h"
#include "engine/scene/camera.h"
#include <optional>

namespace tn::engine {
struct IntersectionFace {
    uint64_t a = 0, b = 0, c = 0;
    Vector3 normal;
    double materialIndex = 0;
};
struct Intersection {
    double distance = 0;
    Vector3 point;
    IntersectionFace face;
    uint64_t faceIndex = 0;
    std::optional<Vector2> uv, uv1;
    std::optional<Vector3> normal;
    Vector3 barycoord;
    Object3D* object = nullptr;
    std::optional<uint32_t> instanceId;
    /** A Line hit: the segment's first vertex index; its face, faceIndex and barycoord are null. */
    std::optional<uint64_t> index;
};
class Raycaster {
public:
    Raycaster(const Vector3& origin = {}, const Vector3& direction = {0, 0, -1}, double near = 0,
              double far = std::numeric_limits<double>::infinity()) : ray(origin, direction), near(near), far(far) {}
    Ray ray;
    double near = 0, far = std::numeric_limits<double>::infinity();
    double lineThreshold = 1;  // three's params.Line.threshold
    Camera* camera = nullptr;
    std::shared_ptr<Object3D> cameraOwner; // Bound cameras stay alive while the caster uses them.
    Layers layers;
    void set(const Vector3& origin, const Vector3& direction) { ray.set(origin, direction); }
    bool setFromCamera(const Vector2& coords, Camera& camera);
    Raycaster& setFromXRController(const Object3D& controller);
    std::vector<Intersection>& intersectObject(Object3D& object, bool recursive, std::vector<Intersection>& target) const;
    std::vector<Intersection> intersectObject(Object3D& object, bool recursive = true) const;
    std::vector<Intersection>& intersectObjects(const std::vector<Object3D*>& objects, bool recursive,
                                               std::vector<Intersection>& target) const;
    std::vector<Intersection> intersectObjects(const std::vector<Object3D*>& objects, bool recursive = true) const;
};
class LOD : public Object3D {
public:
    struct Level { Object3D* object; double distance, hysteresis; std::shared_ptr<Object3D> owner; };
    std::string_view type() const override { return "LOD"; }
    bool autoUpdate = true;
    std::vector<Level> levels;
    LOD& addLevel(Object3D& object, double distance = 0, double hysteresis = 0);
    bool removeLevel(double distance);
    Object3D* getObjectForDistance(double distance) const;
    int getCurrentLevel() const { return currentLevel_; }
    void update(const Camera& camera);
    bool raycast(const Raycaster& raycaster, std::vector<Intersection>& intersects) override;
private:
    int currentLevel_ = 0;
};
} // namespace tn::engine
