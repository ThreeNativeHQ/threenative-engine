#pragma once

#include "engine/abi/binding.h"

#include <memory>

namespace tn::engine {
class BufferAttribute;
}

namespace tn::binding {

/** The math classes (PRD-501): Vector2/3/4, Matrix3/4, Quaternion, Euler, Color and primitives. */
void registerMathBindings(Registry& classes);

/** three's stateless `MathUtils` namespace (PRD-531): the functions the minimal template reaches. */
void registerMathUtilsBindings(Registry& classes);

/** The scene graph (PRD-508): Object3D, Scene, Group, Mesh and the cameras. */
void registerSceneBindings(Registry& classes);

/** Object3D's own getters, setters, members and methods, for a derived node to build on. */
void registerObject3DBindings(ClassBinding& b);

/** Resolves any scene node argument, refusing non-Object3D classes. */
engine::Object3D& objectArg(Store& store, const Value& arg);
/** The caller's BufferAttribute (any of its bound classes) itself, not a copy. */
std::shared_ptr<engine::BufferAttribute> sharedAttributeArg(Store& store, const Value& arg);

/** Geometry (PRD-508): BufferAttribute, BufferGeometry and the built-in generators. */
void registerGeometryBindings(Registry& classes);

/** Materials and lights (PRD-514): the five mesh materials and three lights the renderer draws. */
void registerMaterialBindings(Registry& classes);

/** Textures (PRD-531 textures slice): Texture and DataTexture, the material `map`'s sources. */
void registerTextureBindings(Registry& classes);

/** Every engine class any caller can reach; each work package adds its own register function. */
inline void registerAll(Registry& classes) {
    registerMathBindings(classes);
    registerMathUtilsBindings(classes);
    registerSceneBindings(classes);
    registerGeometryBindings(classes);
    registerMaterialBindings(classes);
    registerTextureBindings(classes);
}

}  // namespace tn::binding
