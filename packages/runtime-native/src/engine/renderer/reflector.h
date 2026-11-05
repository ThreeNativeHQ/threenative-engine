#pragma once
// three r185 ReflectorNode's pass state (src/nodes/utils/ReflectorNode.js, ReflectorBaseNode),
// built by TSL's reflector() and drawn by the render database before the frame that samples it.

#include "engine/scene/camera.h"

#include <atomic>
#include <cstdint>
#include <memory>
#include <string>

namespace tn::engine {

struct Reflector {
    /**
     * This mirror's binding name in a program that samples it. three's ReflectorNode owns one render
     * target per reflector, so a material that samples two of them reads two textures; the name keeps
     * them apart in the program's bind group and in the draw that binds it.
     * ponytail: the name is part of a program's key, so two materials over two different mirrors build
     * two programs that differ only in the name. Add it to graph::serialName if program count matters.
     */
    std::string name = nextName();
    /** The mirror's frame: its local +z is the plane normal, its position a point on the plane. */
    std::shared_ptr<Object3D> target;
    /**
     * The virtual camera the pass draws with, posed from the frame's camera each render.
     * ponytail: one per reflector where three keeps one per scene camera; a game rendering one
     * reflector through two cameras shares it (its layers included). Key by camera if one needs both.
     */
    std::shared_ptr<PerspectiveCamera> camera;
    double resolutionScale = 1;

  private:
    static std::string nextName() {
        static std::atomic<uint32_t> serial{0};
        return "reflector" + std::to_string(serial.fetch_add(1, std::memory_order_relaxed));
    }
};

} // namespace tn::engine
