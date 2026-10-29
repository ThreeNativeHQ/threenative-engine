#include "engine/scene/material.h"

namespace tn::engine {

namespace {
uint32_t nextMaterialId = 0;  // three's `_materialId`
}

Material::Material(MaterialType t, bool node) : type(t), nodeMaterial(node), id(nextMaterialId++) {
    specular.setHex(0x111111);  // MeshPhongMaterial's default, through ColorManagement as setHex does
}

std::shared_ptr<Material> Material::clone() const {
    auto copy = std::make_shared<Material>(*this);
    copy->id = nextMaterialId++;
    copy->uuid = generateUuid();
    copy->version_ = 0;
    return copy;
}

Material& Material::copy(const Material& source) {
    if (&source == this) return *this;
    const MaterialType keptType = type;
    const bool keptRaw = rawNodeMaterial, keptNode = nodeMaterial, keptSprite = spriteMaterial, keptLine = lineMaterial;
    const uint32_t keptId = id, keptVersion = version_;
    const std::string keptUuid = uuid;
    *this = source;
    type = keptType;
    nodeMaterial = keptNode;
    rawNodeMaterial = keptRaw;
    spriteMaterial = keptSprite;
    lineMaterial = keptLine;
    id = keptId;
    uuid = keptUuid;
    version_ = keptVersion;
    needsUpdate();
    return *this;
}

std::string_view Material::typeName() const {
    if (rawNodeMaterial)
        return "NodeMaterial";
    if (spriteMaterial) return nodeMaterial ? "SpriteNodeMaterial" : "SpriteMaterial";
    if (lineMaterial) return "LineBasicMaterial";
    if (nodeMaterial)
        return type == MaterialType::Basic ? "MeshBasicNodeMaterial"
               : type == MaterialType::Physical ? "MeshPhysicalNodeMaterial" : "MeshStandardNodeMaterial";
    switch (type) {
        case MaterialType::Basic: return "MeshBasicMaterial";
        case MaterialType::Lambert: return "MeshLambertMaterial";
        case MaterialType::Phong: return "MeshPhongMaterial";
        case MaterialType::Standard: return "MeshStandardMaterial";
        case MaterialType::Physical: return "MeshPhysicalMaterial";
    }
    return "Material";
}

}  // namespace tn::engine
