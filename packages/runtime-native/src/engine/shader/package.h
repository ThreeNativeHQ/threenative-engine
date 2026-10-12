#pragma once

#include <cstdint>
#include <string>
#include <vector>

#include "threenative/abi/tn_abi.h"
#include "engine/shader/ir.h"
#include "engine/shader/wgsl.h"

namespace tn::engine::shader {

/** The ABI header's shader-package revision; a package of another revision is refused. */
inline constexpr uint32_t kShaderPackageVersion = TN_SHADER_PACKAGE_VERSION;

/** When the engine refreshes a uniform from a known source (§9.2). */
enum class UpdateSchedule : uint8_t { Object, Material, Camera, Frame, Render };

struct UniformField {
    std::string name;
    Type type;
    uint32_t offset = 0;
    uint32_t size = 0;
    UpdateSchedule schedule = UpdateSchedule::Material;
};

enum class BindingKind : uint8_t { Uniform, Storage, Texture, Sampler };

struct Binding {
    uint32_t group = 0;
    uint32_t binding = 0;
    BindingKind kind = BindingKind::Uniform;
    std::string name;
    uint32_t minSize = 0;  // bytes; for storage, one element's stride
    bool depth = false;    // texture: texture_depth_2d (or _cube); sampler: sampler_comparison
    bool cube = false;     // a depth texture's view is a cube
    bool volume = false;   // a float texture's view is 3D
};

struct VertexAttribute {
    std::string name;
    uint32_t location = 0;
    Type type;
};

/** One stage of one variant: its WGSL and everything needed to bind and feed it. */
struct StageModule {
    Stage stage;
    WgslModule wgsl;
    std::vector<Binding> bindings;
    std::vector<UniformField> uniforms;
    uint32_t uniformBlockSize = 0;
    std::vector<VertexAttribute> attributes;
};

/** Variant keys the engine selects per draw (PRD-511): bit flags, stable across revisions. */
enum VariantBits : uint32_t {
    kVariantSkinning = 1u << 0,
    kVariantMorphs = 1u << 1,
    kVariantInstancing = 1u << 2,
    kVariantShadow = 1u << 3,
    kVariantAlphaTest = 1u << 4,
};

struct Variant {
    uint32_t key = 0;
    std::vector<StageModule> stages;
};

/**
 * A complete shader package (§9.2): WGSL plus layouts, attributes, variants and update schedules.
 * WGSL text alone cannot execute a material; this can.
 */
struct ShaderPackage {
    uint32_t version = kShaderPackageVersion;
    std::string name;
    std::vector<Variant> variants;
    std::vector<std::string> errors;
    bool ok() const { return errors.empty(); }
    const Variant* variant(uint32_t key) const;
};

/** WGSL uniform address-space layout of one field type (align, size). */
struct Layout {
    uint32_t align;
    uint32_t size;
};
Layout uniformLayout(const Type& type);

/** Builds a stage module: emits WGSL and derives the layouts that WGSL declares. */
StageModule buildStage(const Program& program, uint32_t group = 0);

/** Refuses a package of another revision before any pipeline is made. */
bool acceptPackage(const ShaderPackage& package, std::string& error);

}  // namespace tn::engine::shader
