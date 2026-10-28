#pragma once

#include <array>
#include <cstdint>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

#include "engine/foundation/waste_counters.h"
#include "engine/shader/package.h"
#include "engine/shader/position_node.h"

namespace tn::engine::shader {

/**
 * One value a draw's material binds this frame: the uniform's name, the name's hash and the values.
 * A view, never a copy: the values live in the material's graphs and the names in the program's stage.
 */
struct BoundUniform {
    uint64_t hash;
    std::string_view name;
    std::span<const double> values;
};

/**
 * Fills `values` for one draw's material: three's `time` (the frame's elapsed seconds) and `deltaTime`
 * from `clock`, then each value the material's node graphs bind. Then out of the way, whether a stage
 * reads any of them is the stage's business. A name two graphs bind to different values fails rather
 * than pick one. Read in place every draw — no map and no allocation per draw, which is why the hash
 * travels with it. The views outlive the call, so `clock` is the caller's: two doubles it owns.
 */
inline void bindMaterialUniforms(std::vector<BoundUniform>& values, const MaterialNodes& nodes,
                                 const std::array<double, 2>& clock) {
    values.clear();
    const auto bind = [&](std::string_view name, std::span<const double> bound) {
        const uint64_t hash = hashUniformName(name);
        for (const BoundUniform& value : values) {
            if (value.hash != hash) continue;
            waste::count(waste::counters().uniformNameCompares);
            if (value.name != name) continue;
            if (!std::ranges::equal(value.values, bound))
                throw std::runtime_error("TN_TSL_UNIFORM_CONFLICT: " + std::string(name));
            return;
        }
        values.push_back(BoundUniform{hash, name, bound});
    };
    bind("time", std::span<const double>(&clock[0], 1));
    bind("deltaTime", std::span<const double>(&clock[1], 1));
    for (const auto& graph : nodes.graphs()) {
        if (!graph) continue;
        for (const auto& node : graph::uniformList(graph)) {
            if (node->values.empty()) continue;
            bind(node->name, node->values);
        }
    }
}

/**
 * The value `field` reads this draw, or null when this draw binds none. Both sides arrive with the name's
 * hash — `UniformField::nameHash` from where the stage was laid out, `BoundUniform::hash` from the bind —
 * so a field the draw does not bind costs a word compare, not a string compare; that per-field string
 * scan was 59% of the shooter's frame memcmp time (PR #574). A hash hit still compares the names, so a
 * collision cannot merge two uniforms, and the compares are counted (`waste::counters().uniformNameCompares`)
 * so tests/native-engine/material_uniforms_test.cpp can fail if a name compare comes back per field.
 */
inline const BoundUniform* findBoundUniform(std::span<const BoundUniform> values, const UniformField& field) {
    for (const BoundUniform& value : values) {
        if (value.hash != field.nameHash) continue;
        waste::count(waste::counters().uniformNameCompares);
        if (value.name != field.name) continue;
        return &value;
    }
    return nullptr;
}

}  // namespace tn::engine::shader
