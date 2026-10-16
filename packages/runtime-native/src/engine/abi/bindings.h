#pragma once

#include "engine/abi/binding.h"

#include <memory>
#include <initializer_list>
#include <string>

namespace tn::engine {
class BufferAttribute;
class EventDispatcher;
}

namespace tn::binding {

/** The math classes (PRD-501): Vector2/3/4, Matrix3/4, Quaternion, Euler, Color and primitives. */
void registerMathBindings(Registry& classes);

/** three's stateless `MathUtils` namespace (PRD-531): the functions the minimal template reaches. */
void registerMathUtilsBindings(Registry& classes);

/**
 * Where the math value classes keep their doubles, as JSON, for a language that views an object's
 * storage in place (PRD-573 step 4a): `{"Vector3":{"bytes":24,"fields":{"x":0,"y":8,"z":16}}, ...}`,
 * offsets in bytes from the object, plus Euler's `order` (an int at its byte offset) and the six
 * order names by enum value. Measured on live objects, so no consumer hard-codes a stride.
 */
std::string viewLayoutJson();
/** Euler's six orders by enum value, as three spells them. */
inline constexpr const char* kEulerOrderNames[6] = {"XYZ", "YXZ", "ZXY", "ZYX", "YZX", "XZY"};

/** The scene graph (PRD-508): Object3D, Scene, Group, Mesh and the cameras. */
void registerSceneBindings(Registry& classes);
/** Existing native EventDispatcher callbacks, surfaced by both language adapters. */
void registerEventBindings(ClassBinding& binding, engine::EventDispatcher* (*dispatcher)(void*),
                           std::initializer_list<const char*> types);

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
