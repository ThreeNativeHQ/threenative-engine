#include "check.h"
#include "engine/foundation/waste_counters.h"
#include "engine/renderer/material_uniforms.h"
#include "engine/shader/package.h"
#include "engine/shader/tsl/tsl.h"

#include <array>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

using namespace tn::engine;
using namespace tn::engine::shader;

namespace {

// A stage of the named uniforms, laid out by the real builder: offsets, schedules and the name hashes a
// draw's material is resolved against.
StageModule stageOf(const std::vector<std::pair<std::string, Type>>& uniforms) {
    Program program(Stage::Fragment);
    for (const auto& [name, type] : uniforms) program.uniform(name, type);
    return buildStage(program, 0);
}

const UniformField* fieldNamed(const StageModule& stage, const std::string& name) {
    for (const UniformField& field : stage.uniforms)
        if (field.name == name) return &field;
    return nullptr;
}

// One draw resolves its material against a stage field by field. Both sides carry the name's hash, so a
// field the draw does not bind costs a word compare and only a bound field compares names. Before this
// every field compared its name against every bound value (59% of the shooter's frame memcmp time, #574).
void materialUniformsResolveByNameHash() {
    const StageModule stage = stageOf({
        {"nodeTint", Type::vec(3)}, {"time", Type::f32()},  {"roughness", Type::f32()},
        {"metalness", Type::f32()}, {"diffuse", Type::vec(3)}, {"emissive", Type::vec(3)},
        {"alphaTest", Type::f32()}, {"opacity", Type::f32()}, {"envMapIntensity", Type::f32()},
        {"clearcoat", Type::f32()}, {"bumpScale", Type::f32()}, {"aoMapIntensity", Type::f32()},
    });
    CHECK(stage.uniforms.size() == 12);

    MaterialNodes nodes;
    nodes.colorNode = graph::uniform("nodeTint", Type::vec(3), {0.35, 0.2, 0.1});
    std::vector<BoundUniform> values;
    const std::array<double, 2> clock{2.5, 0.016};
    const uint64_t before = waste::counters().uniformNameCompares.load();
    bindMaterialUniforms(values, nodes, clock);
    uint32_t bound = 0;
    for (const UniformField& field : stage.uniforms) {
        const BoundUniform* value = findBoundUniform(values, field);
        if (value != nullptr) ++bound;
    }
    const uint64_t compares = waste::counters().uniformNameCompares.load() - before;

    // Two of the twelve fields are bound this draw: three's `time` and the graph's `nodeTint`.
    CHECK(bound == 2);
    CHECK(compares == 2);
    // The two resolve to the values the draw asked for, by name and at their own layout offset.
    const UniformField* tint = fieldNamed(stage, "nodeTint");
    const BoundUniform* tinted = tint ? findBoundUniform(values, *tint) : nullptr;
    const auto asFloat = [](double value) { return static_cast<float>(value); };
    CHECK(tinted != nullptr && tinted->values.size() == 3 && asFloat(tinted->values[0]) == 0.35f &&
          asFloat(tinted->values[2]) == 0.1f);
    const UniformField* time = fieldNamed(stage, "time");
    const BoundUniform* timed = time ? findBoundUniform(values, *time) : nullptr;
    CHECK(timed != nullptr && timed->values.size() == 1 && timed->values[0] == 2.5);
    const UniformField* roughness = fieldNamed(stage, "roughness");
    CHECK(roughness != nullptr && findBoundUniform(values, *roughness) == nullptr);
    CHECK(tinted != nullptr && tinted->hash == hashUniformName("nodeTint"));
}

// Two graphs binding one name to different values is a material the engine refuses, not one of the two
// winning by walk order. The hash is what brings them together; the name compare is what finds it.
void materialUniformConflictThrows() {
    MaterialNodes nodes;
    nodes.colorNode = graph::uniform("nodeTint", Type::vec(3), {0.35, 0.2, 0.1});
    nodes.emissiveNode = graph::uniform("nodeTint", Type::vec(3), {0.5, 0.2, 0.1});
    std::vector<BoundUniform> values;
    const std::array<double, 2> clock{1.0, 0.016};
    bool refused = false;
    try {
        bindMaterialUniforms(values, nodes, clock);
    } catch (const std::runtime_error& error) {
        refused = std::string(error.what()).starts_with("TN_TSL_UNIFORM_CONFLICT");
    }
    CHECK(refused);
}

// `authoredLightShadowMatrix<id>` carries its light's id from where the stage was laid out, so resolving a
// draw no longer parses (and allocates a substring of) every such field's name on every draw.
void shadowFieldCarriesItsLight() {
    const StageModule stage = stageOf({{"authoredLightShadowMatrix7", Type::mat(4, 4)}, {"roughness", Type::f32()}});
    const UniformField* field = fieldNamed(stage, "authoredLightShadowMatrix7");
    CHECK(field != nullptr && field->shadowLightId == 7);
    const UniformField* roughness = fieldNamed(stage, "roughness");
    CHECK(roughness != nullptr && roughness->shadowLightId == kNoShadowLight);
}

}  // namespace

TN_TEST_MAIN({"material-uniforms-resolve-by-name-hash", materialUniformsResolveByNameHash},
             {"material-uniforms-conflict-throws", materialUniformConflictThrows},
             {"material-uniforms-shadow-field", shadowFieldCarriesItsLight});
