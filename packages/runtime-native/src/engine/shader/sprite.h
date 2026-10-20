#pragma once
#include "engine/shader/standard.h"
namespace tn::engine::shader {
// SpriteNodeMaterial.setupPositionView: game positionNode is the sprite centre;
// geometry corners are aligned, scaled and rotated in view space.
StandardPrograms buildSprite(const VertexVariant& variant);
}
