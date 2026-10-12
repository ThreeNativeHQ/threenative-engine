#pragma once
#include <memory>
#include <map>

// three@0.185.1's Material and the five mesh materials, as the properties the native renderer
// reads (PRD-514). One class carries every type's fields; `type` says which three class it is, and
// each constructor sets that class's defaults. Skipped: maps other than `map` (only the diffuse map
// is sampled so far), blending modes other than No/Normal/AdditiveBlending, stencil, clipping planes, polygon
// offset, dithering, userData, clone/toJSON. Physical features
// beyond ior/specular are kept as numbers so the renderer can refuse them by name (TN_MATERIAL_UNSUPPORTED)
// rather than drop them.

#include <cstdint>
#include <string>
#include <string_view>

#include "engine/foundation/math/Color.h"
#include "engine/foundation/math/Vector.h"
#include "engine/scene/texture.h"
#include "engine/shader/position_node.h"

namespace tn::engine {

enum class MaterialType : uint8_t { Basic, Lambert, Phong, Standard, Physical };
enum class Side : uint8_t { Front = 0, Back = 1, Double = 2 };  // three's FrontSide/BackSide/DoubleSide
/** three's NoBlending, NormalBlending and AdditiveBlending, premultipliedAlpha false. */
enum class Blending : uint8_t { None = 0, Normal = 1, Additive = 2 };

class Material {
private:
    uint32_t version_ = 0;
public:
    explicit Material(MaterialType type, bool nodeMaterial = false);
    [[nodiscard]] std::string_view typeName() const;  // "MeshStandardMaterial", ...

    MaterialType type;  // fixed at construction; copy() keeps the target's
    bool nodeMaterial;
    shader::MaterialNodes nodes;
    uint32_t id;  // three's material id counter; a clone takes the next one
    std::string name;

    // Material
    bool spriteMaterial = false;
    bool lineMaterial = false;  // three's LineBasicMaterial: unlit, drawn by a Line or LineSegments
    double rotation = 0;
    bool sizeAttenuation = true;
    bool transparent = false;
    bool forceSinglePass = false;  // three's: a transparent DoubleSide material draws in one pass
    double opacity = 1;
    double alphaTest = 0;
    bool depthTest = true;
    bool depthWrite = true;
    /** three's polygonOffset, polygonOffsetFactor and polygonOffsetUnits: a depth bias. */
    bool polygonOffset = false;
    double polygonOffsetFactor = 0, polygonOffsetUnits = 0;
    Side side = Side::Front;
    Blending blending = Blending::Normal;
    bool visible = true;
    bool toneMapped = true;
    bool fog = true;
    /** NodeMaterial.positionNode: a builder graph replacing the local position; null keeps it. */
    std::shared_ptr<const shader::PositionNode> positionNode;

    // Mesh*Material
    Color color{1, 1, 1};
    Color emissive{0, 0, 0};
    double emissiveIntensity = 1;
    double roughness = 1;            // Standard, Physical
    double envMapIntensity = 1;
    double metalness = 0;            // Standard, Physical
    Color specular;                  // Phong: Color(0x111111)
    double shininess = 30;           // Phong
    double ior = 1.5;                // Physical
    double specularIntensity = 1;    // Physical
    Color specularColor{1, 1, 1};    // Physical
    double clearcoat = 0, sheen = 0, transmission = 0, iridescence = 0, anisotropy = 0, dispersion = 0;
    double clearcoatRoughness = 0;          // Physical
    Vector2 clearcoatNormalScale{1, 1};     // Physical
    bool vertexColors = false;
    bool flatShading = false;
    Vector2 normalScale{1, 1};
    double aoMapIntensity = 1;
    double bumpScale = 1;  // Standard, Physical (Lambert and Phong declare it too; their programs do not read it yet)
    // Texture slots by three's property name (`map`, `normalMap`, ...); empty slots are absent.
    std::map<std::string, std::shared_ptr<const Texture>> maps;

    /** three's Material.clone: every value copied, textures and nodes shared, with its own id and version. */
    [[nodiscard]] std::shared_ptr<Material> clone() const;
    /** three's Material.copy(source): every value taken from source; this keeps its class, id and version. */
    Material& copy(const Material& source);
    /** three's `material.needsUpdate = true`: the renderer rebuilds what depends on the material. */
    void needsUpdate() { ++version_; }
    [[nodiscard]] uint32_t version() const { return version_; }

    mutable std::size_t cachedUniformHash_ = 0;  // projection::detail::uniformHash, valid for one prepare
    mutable uint64_t uniformHashEpoch_ = 0;
};

}  // namespace tn::engine
