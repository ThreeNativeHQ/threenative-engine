#include "check.h"
#include "engine/abi/tsl_call.h"
#include "engine/shader/standard.h"
#include "engine/shader/wgsl.h"

#include <cstdio>
#include <string>

using namespace tn::engine::shader;

namespace {
namespace g = tn::engine::shader::graph;

/**
 * three's materialColor, materialEmissive, materialMetalness and materialRoughness are the material's value times its
 * map (MaterialNode COLOR, EMISSIVE, METALNESS, ROUGHNESS). A node slot that reads one must sample that map in the
 * shader. Dropping the map leaves the bare factor: a glTF's emissiveFactor of 1 beside a near-black emissiveMap then
 * draws a white part (the shooter's optic), the same fault whatever the model.
 */
struct Accessor {
    const char* name;
    const char* binding;  // the texture the shader must read when the material has the map
    const char* uniform;  // the bare factor it reads when the material has none
    PbrMap map;           // kPbrMapCount: the diffuse `map`
};
// Every `material*` constant tslConstants answers has a row here. A new one fails `every_accessor_is_listed`
// until it is given its map, or is listed in `kUnbridged` as not answered at all.
const Accessor kAccessors[] = {{"materialColor", "t_map", "f_diffuse", kPbrMapCount},
                               {"materialEmissive", "t_emissiveMap", "f_emissive", kEmissiveMap},
                               {"materialMetalness", "t_metalnessMap", "f_metalness", kMetalnessMap},
                               {"materialRoughness", "t_roughnessMap", "f_roughness", kRoughnessMap}};

g::Node constant(const std::string& name) {
    for (auto& [label, node] : tn::abi::tslConstants())
        if (label == name) return node;
    return {};
}

// The fragment of a lit standard program whose slot for `accessor` reads it.
std::string fragment(const Accessor& accessor, bool mapped) {
    VertexVariant variant;
    if (mapped) {
        if (accessor.map == kPbrMapCount) variant.map = true;
        else variant.pbrMaps = static_cast<uint16_t>(1u << accessor.map);
    }
    const std::string name = accessor.name;
    const g::Node node = constant(name);
    CHECK(node != nullptr);
    if (name == "materialColor") variant.nodes.colorNode = g::vec4({node, g::float_(1)});
    else if (name == "materialEmissive") variant.nodes.emissiveNode = node;
    else if (name == "materialMetalness") variant.nodes.metalnessNode = node;
    else variant.nodes.roughnessNode = node;
    const auto programs = buildStandard(StandardMaterial{}, variant);
    CHECK(programs.diagnostics.empty());
    const auto wgsl = WgslEmitter::emit(programs.fragment, 1);
    CHECK(wgsl.ok());
    return wgsl.code;
}

void accessorsSampleTheirMap() {
    for (const Accessor& accessor : kAccessors) {
        const std::string mapped = fragment(accessor, true), bare = fragment(accessor, false);
        if (mapped.find(accessor.binding) == std::string::npos)
            std::fprintf(stderr, "%s with its map does not sample %s\n", accessor.name, accessor.binding);
        CHECK(mapped.find(accessor.binding) != std::string::npos);
        // The map is a modifier of the factor, so the factor is still read.
        CHECK(mapped.find(accessor.uniform) != std::string::npos);
        // A material without the map keeps the bare factor and binds no texture.
        CHECK(bare.find(accessor.binding) == std::string::npos);
        CHECK(bare.find(accessor.uniform) != std::string::npos);
    }
}

void everyAccessorIsListed() {
    size_t seen = 0;
    for (auto& [label, node] : tn::abi::tslConstants()) {
        if (label.rfind("material", 0) != 0) continue;
        ++seen;
        bool listed = false;
        for (const Accessor& accessor : kAccessors) listed |= label == accessor.name;
        if (!listed) std::fprintf(stderr, "%s is bridged without its map being proved\n", label.c_str());
        CHECK(listed);
    }
    CHECK(seen == sizeof(kAccessors) / sizeof(kAccessors[0]));
}

}  // namespace

TN_TEST_MAIN({"accessors_sample_their_map", accessorsSampleTheirMap}, {"every_accessor_is_listed", everyAccessorIsListed})
