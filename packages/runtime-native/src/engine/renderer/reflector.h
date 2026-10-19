#pragma once
// three r185 ReflectorNode's pass state (src/nodes/utils/ReflectorNode.js, ReflectorBaseNode),
// built by TSL's reflector() and drawn by the render database before the frame that samples it.

#include "engine/scene/camera.h"

#include <memory>

namespace tn::engine {

struct Reflector {
    /** The mirror's frame: its local +z is the plane normal, its position a point on the plane. */
    std::shared_ptr<Object3D> target;
    /**
     * The virtual camera the pass draws with, posed from the frame's camera each render.
     * ponytail: one per reflector where three keeps one per scene camera; a game rendering one
     * reflector through two cameras shares it (its layers included). Key by camera if one needs both.
     */
    std::shared_ptr<PerspectiveCamera> camera;
    double resolutionScale = 1;
};

} // namespace tn::engine
