#pragma once
#include <memory>
#include <optional>
#include <map>

// three@0.185.1's Material and the five mesh materials, as the properties the native renderer
// reads (PRD-514). One class carries every type's fields; `type` says which three class it is, and
// each constructor sets that class's defaults. Skipped: maps other than `map` (only the diffuse map
// is sampled so far), blending modes other than No/Normal/AdditiveBlending, stencil, clipping planes, polygon
// offset, dithering, userData, clone/toJSON. Physical features
// beyond ior/specular are kept as numbers so the renderer can refuse them by name (TN_MATERIAL_UNSUPPORTED)
// rather than drop them.

#include <cstdint>
#include <cstdlib>
#include <ctime>
#include <string>
#include <string_view>

#include "engine/foundation/math/Color.h"
#include "engine/foundation/uuid.h"
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
    // Temporary internal measurement only; no setter/cache semantics change.
    struct Diagnostic {
        bool enabled = false, threadCpuSupported = false;
        uint64_t writes = 0, unchanged = 0, changed = 0, signedZero = 0, nan = 0;
        uint64_t recordRebuilds = 0, graphRebuilds = 0, recordCpuNs = 0, graphCpuNs = 0;
    };
    static Diagnostic& diagnostics() {
        static Diagnostic state = [] { Diagnostic d; const char* flag = std::getenv("TN_MATERIAL_DIAGNOSTICS");
            d.enabled = flag && flag[0] == '1' && flag[1] == '\0'; return d; }();
        return state;
    }
    struct DiagnosticTimer {
        bool enabled; uint64_t& total; int64_t begin = -1;
        static int64_t now() {
#if defined(__linux__)
            timespec time{};
            if (clock_gettime(CLOCK_THREAD_CPUTIME_ID, &time) == 0) return int64_t(time.tv_sec) * 1000000000 + time.tv_nsec;
#endif
            return -1; // Unsupported is explicit, never process CPU or wall time.
        }
        DiagnosticTimer(bool active, uint64_t& destination) : enabled(active), total(destination) {
            if (enabled) { begin = now(); diagnostics().threadCpuSupported = begin >= 0; }
        }
        ~DiagnosticTimer() { if (enabled) { const auto end = now();
            if (begin >= 0 && end >= begin) total += end - begin; else diagnostics().threadCpuSupported = false; } }
    };
    explicit Material(MaterialType type, bool nodeMaterial = false);
    [[nodiscard]] std::string_view typeName() const;  // "MeshStandardMaterial", ...

    MaterialType type;  // fixed at construction; copy() keeps the target's
    bool nodeMaterial;
    bool rawNodeMaterial = false;
    shader::MaterialNodes nodes;
    uint32_t id;  // three's material id counter; a clone takes the next one
    std::string name;
    std::string uuid = generateUuid();  // three's: unique per material, new for a clone

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
    bool colorWrite = true;  // three's: false draws depth only, with every colour channel masked
    /** three's polygonOffset, polygonOffsetFactor and polygonOffsetUnits: a depth bias. */
    bool polygonOffset = false;
    double polygonOffsetFactor = 0, polygonOffsetUnits = 0;
    Side side = Side::Front;
    std::optional<Side> shadowSide;  // three's material.shadowSide: the faces a shadow pass draws; null derives it
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
    /** Unreal's Two Sided Foliage shading model (PRD-651): a receiver that looks its shadow up where it stands. */
    bool twoSidedFoliage = false;
    /** Unreal's Substrate rough diffuse, the EON model (PRD-653): direct light shades the diffuse lobe with EON, not Lambert. */
    bool roughDiffuse = false;
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
