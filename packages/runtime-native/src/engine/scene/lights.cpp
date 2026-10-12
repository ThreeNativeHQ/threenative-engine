#include "engine/scene/lights.h"

namespace tn::engine {

DirectionalLight::DirectionalLight(Color c, double i)
    : Light(c, i), target(std::make_shared<Object3D>()) {
    position.copy(Object3D::defaultUp);  // three: this.position.copy( Object3D.DEFAULT_UP )
    updateMatrix();
}

SpotLight::SpotLight(Color c, double i, double d, double a, double p, double decayValue)
    : Light(c, i), distance(d), angle(a), penumbra(p), decay(decayValue), ownTarget(std::make_unique<Object3D>()),
      target(ownTarget.get()) {
    position.copy(Object3D::defaultUp); // three: this.position.copy( Object3D.DEFAULT_UP )
    updateMatrix();
}

HemisphereLight::HemisphereLight(Color sky, Color ground, double i) : Light(sky, i), groundColor(ground) {
    position.copy(Object3D::defaultUp);
    updateMatrix();
}

}  // namespace tn::engine
