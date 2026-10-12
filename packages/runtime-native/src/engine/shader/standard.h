#pragma once

#include <array>
#include <memory>
#include <string>
#include <vector>

#include "engine/shader/ir.h"
#include "engine/renderer/probes/schedule.h"
#include "engine/shader/position_node.h"

namespace tn::engine::shader {

// PMREM's extra 16px tiles use mipInt 3 through -2, not hardware mip levels.
constexpr float pmremMip(int lodMax, int lod) { return float(lodMax - lod); }

std::string probeStorageName(std::string_view name);

/** ProbeVolume.sampleNode: padded atlas trilinear sampling followed by RGB L2 irradiance. */
graph::Node probeSample(const probes::ProbePlacement& placement, const std::string& name,
                        graph::Node position = {}, graph::Node normal = {});

/**
 * MeshStandardMaterial / MeshPhysicalMaterial as the native engine reads them (PRD-512). Every field
 * defaults to the three@0.185.1 constructor value. A physical feature the native engine has not
 * ported is refused by name, never drawn as a simpler shader (§9.3).
 */
struct StandardMaterial {
    std::array<float, 3> color{1, 1, 1};
    float opacity = 1;
    float alphaTest = 0;  // > 0: fragments with opacity <= alphaTest are discarded
    float roughness = 1;
    float metalness = 0;
    std::array<float, 3> emissive{0, 0, 0};
    float emissiveIntensity = 1;
    // MeshPhongMaterial.specular and .shininess; read by buildPhong. three's default is
    // Color(0x111111), which setHex converts from sRGB: SRGBToLinear(17/255) = 0.0056053916.
    std::array<float, 3> specular{0.0056053916f, 0.0056053916f, 0.0056053916f};
    float shininess = 30;
    // MeshPhysicalMaterial specular inputs, read by buildPhysical. Defaults match three's
    // MeshPhysicalMaterial: ior 1.5, specularIntensity 1, specularColor linear white.
    float ior = 1.5f;
    float specularIntensity = 1;
    std::array<float, 3> specularColor{1, 1, 1};
    /** MeshStandardMaterial.envMapIntensity: scales the environment's radiance and irradiance. */
    float envMapIntensity = 1;
    // MeshPhysicalMaterial's clearcoat layer (PhysicalLightingModel's clearcoat), read by buildPhysical
    // when VertexVariant::clearcoat is set: three's useClearcoat, clearcoat > 0.
    float clearcoat = 0;
    float clearcoatRoughness = 0;
    /** MeshStandardMaterial.bumpScale: the bumpMap's height scale (three's BumpMapNode). */
    float bumpScale = 1;
    std::array<float, 2> clearcoatNormalScale{1, 1};
    // MeshPhysicalMaterial: any non-default value is a feature in use.
    float sheen = 0;
    float transmission = 0;
    float iridescence = 0;
    float anisotropy = 0;
    float dispersion = 0;
};

/**
 * Per-draw vertex variants (package VariantBits). `instanced`: three's instance() — the vertex reads
 * its instance matrix as four per-instance vec4 attributes (instanceMatrix0..3), transforms
 * positionLocal by it and normalLocal by its inverse transpose. `instanceColor`: the per-instance
 * colour (attribute instanceColor) multiplies the material colour, as setupDiffuseColor does.
 */
/** The scalar and emissive maps MeshStandardMaterial reads besides map and normalMap, as bits of
 *  VertexVariant::pbrMaps. Each is sampled at `<name>UvTransform * vec3(uv, 1)` from texture `<name>`. */
enum PbrMap : uint8_t { kRoughnessMap, kMetalnessMap, kAoMap, kEmissiveMap, kBumpMap, kSpecularColorMap,
                        kSpecularIntensityMap, kClearcoatMap, kClearcoatRoughnessMap, kClearcoatNormalMap, kPbrMapCount };
inline constexpr const char* kPbrMapNames[kPbrMapCount] = {"roughnessMap", "metalnessMap", "aoMap", "emissiveMap",
                                                           "bumpMap", "specularColorMap", "specularIntensityMap",
                                                           "clearcoatMap", "clearcoatRoughnessMap", "clearcoatNormalMap"};
/** MeshStandardMaterial's PbrMaps; the ones after it are MeshPhysicalMaterial's own. */
inline constexpr int kStandardPbrMapCount = kSpecularColorMap;

struct VertexVariant {
    bool background = false;
    uint8_t fog = 0; // 0 none, 1 Fog (range), 2 FogExp2 (density)
    bool sprite = false;
    bool backSide = false;
    /** material.side is DoubleSide: lit fragments turn the normal toward the viewer on a back face. */
    bool doubleSide = false;
    bool instanced = false;
    bool instanceColor = false;
    /** three's material.vertexColors on a geometry with a `color` attribute: its item size (3 or 4), else 0.
     *  The colour multiplies the diffuse colour as a vec4 (a 3-component colour reads alpha 1). */
    uint8_t vertexColors = 0;
    /** The vertex stage passes one tint varying, `instanceColor`: the instance colour times the vertex colour. */
    [[nodiscard]] bool tinted() const { return instanceColor || vertexColors != 0; }
    bool instanceStorage = false; // packed matrix columns and colour in one frame storage buffer
    /**
     * three's skinning(): `skinIndex` (vec4<u32>) and `skinWeight` attributes, the frame's bone
     * matrices in the storage buffer `boneMatrices` from `boneBase` on, `bindMatrix` and
     * `bindMatrixInverse` uniforms.
     */
    bool skinned = false;
    bool skinnedPalette = false; // boneBase + instanceIndex * boneStride
    /**
     * three's morphReference(): `morphTargets` targets read from the storage buffer `morphData`
     * (vec4 per vertex and target; a normal entry after each position one when `morphNormals`) from
     * `morphBase`, with `morphVertexCount` vertices per target; influences from `morphInfluences` at
     * `morphInfluenceBase`; the base scale `morphBaseInfluence`.
     */
    uint8_t morphTargets = 0;
    bool morphNormals = false;
    /** The material's positionNode, applied after every variant above; null keeps positionLocal. */
    std::shared_ptr<const PositionNode> positionNode;
    /**
     * The material has a diffuse `map`: the vertex stage passes `uv` through and the fragment samples
     * `t_map` at `uvTransform * vec3(uv, 1)`, multiplying the diffuse colour and alpha.
     */
    bool map = false;
    /**
     * The material has a tangent-space `normalMap`: the vertex stage passes `uv` through and lit
     * fragments perturb the view normal with three's perturbNormal2Arb (`t_normalMap`, `normalScale`,
     * `normalUvTransform`). A material normalNode takes precedence, as upstream.
     */
    bool normalMap = false;
    /**
     * MeshStandardMaterial's roughnessMap (.g), metalnessMap (.b), aoMap (.r, aoMapIntensity) and
     * emissiveMap (.rgb), and MeshPhysicalMaterial's specularColorMap (.rgb), specularIntensityMap
     * (.a), clearcoatMap (.r), clearcoatRoughnessMap (.r) and tangent-space clearcoatNormalMap, one bit
     * per PbrMap; read only by the standard and physical programs.
     */
    uint16_t pbrMaps = 0;
    [[nodiscard]] bool reads(PbrMap map) const { return (pbrMaps >> map) & 1u; }
    /**
     * The map's colorSpace is SRGBColorSpace: the sampled texel is decoded with three's
     * `sRGBTransferEOTF` in the fragment, as upstream's ColorSpaceNode does, rather than by a
     * hardware -srgb texture format (whose rounding differs from the shader formula).
     */
    bool mapSRGB = false;
    /**
     * The scene sets an environment (or the material an envMap): the fragment samples the PMREM
     * cubeUV texture `env` for IBL irradiance and radiance (three's EnvironmentNode).
     */
    bool environment = false;
    /**
     * MeshPhysicalMaterial's clearcoat layer (three's useClearcoat: clearcoat > 0): the fragment reads
     * `clearcoat`, `clearcoatRoughness` and, with a clearcoatNormalMap, `clearcoatNormalScale`.
     */
    bool clearcoat = false;
    /** The position output is @invariant: this frame draws a normal pass that shares the vertex stage, or TRAA's velocity pass depth-Equal against it. */
    bool invariantPosition = false;
    MaterialNodes nodes;
    /** Equal variants build the same program: a draw whose variant is unchanged reuses its Program*. */
    bool operator==(const VertexVariant&) const = default;
    /** A stable key: two variants with the same key build the same program. */
    [[nodiscard]] std::string key() const {
        return std::to_string(fog) + (background ? "background|" : "") + std::string(sprite ? "sprite|" : "") + (backSide ? "back|" : "") + (doubleSide ? "double|" : "") + std::to_string(instanced) + std::to_string(instanceColor) + "vc" + std::to_string(vertexColors) + std::to_string(skinned) +
               std::to_string(skinnedPalette) + (instanceStorage ? "storage" : "") + "m" + std::to_string(morphTargets) + (morphNormals ? "n" : "") +
               (map ? "t" : "") + (normalMap ? "N" : "") + (pbrMaps ? "P" + std::to_string(pbrMaps) : "") + (mapSRGB ? "s" : "") + (environment ? "e" : "") + (clearcoat ? "c" : "") + (invariantPosition ? "i" : "") +
               (positionNode ? "p:" + positionNode->key : "") + "|nodes:" + nodes.key();
    }
};

/**
 * The direct lights a lit program reads, in three's LightsNode order (sorted by Object3D id): one
 * character each, 'd' directional, 'p' point, 's' spot. Light i reads `light{i}Color` (intensity
 * folded in) and, by kind, `light{i}Direction` (view space, towards the light), `light{i}Position`
 * (view space), `light{i}Distance`, `light{i}Decay`, `light{i}Axis` (view space, target to light),
 * `light{i}ConeCos` and `light{i}PenumbraCos`. An upper-case kind also casts a shadow the mesh
 * receives: `light{i}ShadowMatrix`, `ShadowBias`, `ShadowNormalBias`, `ShadowRadius`,
 * `ShadowMapSize` and `ShadowIntensity`, and the depth texture `shadow{i}`. A program is specialized per layout, as three's is per
 * lights hash; the default is the one directional light the first renderer drew.
 */
// '1'..'8': a directional virtual shadow with that many clip levels. It reads the depth
// atlas `vsm{i}` and storage page table `vsmTable{i}` in both standard and basic lit programs.
struct LightLayout {
    std::string kinds = "d";
    /** three's PCFSoftShadowMap: shadowed directional and spot lights read PCFSoftShadowFilter. */
    bool softShadows = false;
    /** Any upper-case kind: that light's shadow map is read (`light{i}Shadow*`, texture `shadow{i}`). */
    [[nodiscard]] bool shadowed() const {
        for (const char c : kinds)
            if ((c >= 'A' && c <= 'Z') || (c >= '1' && c <= '8')) return true;
        return false;
    }
};

/** TN_MATERIAL_UNSUPPORTED <feature> for each physical feature in use and not yet ported. */
std::vector<std::string> unsupportedFeatures(const StandardMaterial& material);

struct StandardPrograms {
    Program vertex{Stage::Vertex};
    Program fragment{Stage::Fragment};
    std::vector<std::string> diagnostics;  // TN_MATERIAL_UNSUPPORTED ...; empty when drawable
};

/**
 * Builds the standard material's two stages from the pinned node chain: BRDF_GGX_Multiscatter with
 * the DFG lookup, Lambert diffuse, getRoughness with geometry roughness, one directional, one
 * hemisphere and one ambient light (the N09 renderer generalizes lights). It writes linear HDR
 * colour; the output pass (output.h) tone maps and encodes it.
 * Uniforms: modelMatrix, viewMatrix, projectionMatrix, normalMatrix (vertex); diffuse (rgb,
 * opacity), roughness, metalness, emissive, directionalDirection (view space), directionalColor,
 * hemisphereSky, hemisphereGround, hemisphereDirection (world), ambient (fragment); texture "dfg".
 */
StandardPrograms buildStandard(const StandardMaterial& material, const VertexVariant& variant = {},
                               const LightLayout& lights = {});

/**
 * MeshPhysicalNodeMaterial's non-feature path: the standard program with setupSpecular's physical
 * F0/F90 — specularColorBlended = mix(min(pow2((ior-1)/(ior+1)) * specularColor, vec3(1)) *
 * specularIntensity, diffuseColor.rgb, metalness), specularF90 = mix(specularIntensity, 1, metalness)
 * — instead of the standard's fixed 0.04 / 1. VertexVariant::clearcoat adds PhysicalLightingModel's
 * clearcoat layer (uniforms clearcoat, clearcoatRoughness, clearcoatNormalScale). Another physical
 * feature in use (sheen, …) is still refused by name. Same uniforms as buildStandard plus ior,
 * specularIntensity, specularColor.
 */
StandardPrograms buildPhysical(const StandardMaterial& material, const VertexVariant& variant = {},
                               const LightLayout& lights = {});

/**
 * MeshLambertNodeMaterial: PhongLightingModel with specular off — BRDF_Lambert direct and indirect
 * diffuse, no specular. Same vertex and light uniforms as the standard program; it reads no dfg,
 * metalness or roughness. Linear HDR out, materialAlpha tail.
 */
StandardPrograms buildLambert(const VertexVariant& variant = {}, const LightLayout& lights = {});

/**
 * MeshPhongNodeMaterial: PhongLightingModel with the Blinn-Phong specular term
 * (BRDF_BlinnPhong: F_Schlick with `specular` f0 and f90 1, G 0.25, D_BlinnPhong with `shininess`).
 * Same uniforms as buildLambert plus specular (vec3) and shininess (f32). Linear HDR out.
 */
StandardPrograms buildPhong(const VertexVariant& variant = {}, const LightLayout& lights = {});

/**
 * MeshBasicMaterial with no maps and no environment: BasicLightingModel's indirect diffuse is
 * 1 x AO x diffuseColor, so the outgoing light is the colour itself. Same vertex uniforms as the
 * standard program (normalMatrix unused); fragment uniform diffuse (rgb, opacity). Linear out.
 */
StandardPrograms buildBasic(const VertexVariant& variant = {});

/**
 * NodeMaterial.setupDiffuseColor's alpha tail, shared by every material program: discard when
 * alphaTest > 0 and alpha <= alphaTest, then alpha 1 for an opaque material (builder.isOpaque()).
 * Uniform-driven (uniforms "alphaTest", "opaque" 0/1) rather than per-variant programs; the output is
 * the same. Returns the alpha to write.
 */
ExprId materialAlpha(Program& f, ExprId alpha);
/** Pinned nodes/fog/Fog.js rangeFogFactor / densityFogFactor, shared by all material tails. */
/** CubeRenderTarget.fromEquirectangularTexture: camera rotation, level-0 equirectUV sample. */
StandardPrograms buildEquirectangularCube();
ExprId fogFactor(Program& f, uint8_t kind, ExprId viewZ, ExprId nearOrDensity, ExprId far);

}  // namespace tn::engine::shader
