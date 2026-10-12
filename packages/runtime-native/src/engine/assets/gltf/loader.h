#pragma once
// glTF 2.0 / GLB to a native scene (PRD-515 phase 1): cgltf parses and validates; the scene, meshes,
// materials, skins and clips are built here in three@0.185.1 GLTFLoader's hierarchy and naming, so a
// game finds the same names, parents and transforms it would under the upstream loader.
//
// Supported: core glTF 2.0 in a GLB or a glTF with embedded (data URI) buffers, and
// KHR_mesh_quantization, KHR_lights_punctual, KHR_materials_unlit, KHR_materials_ior and KHR_materials_specular. An extension GLTFLoader implements and this loader does not is refused
// by name (TN_NATIVE_GLTF_EXTENSION_UNSUPPORTED) instead of being dropped, as is a required
// extension nobody knows; an unknown optional extension is ignored, as GLTFLoader ignores it.
// Images: PNG and JPEG decode to RGBA8 (a texture also takes its sampler); WebP, AVIF, KTX2 and
// external image files stay undecoded. Not yet:
// a node shared between scenes, external buffer files.
//
// Engine code never throws: a refusal is the result's `error`, a TN_NATIVE_GLTF_* code and detail.

#include <cstdint>
#include <functional>
#include <memory>
#include <span>
#include <string>
#include <vector>

#include "engine/animation/mixer.h"
#include "engine/scene/nodes.h"
#include "engine/scene/camera.h"

namespace tn::engine::gltf {

struct LoadResult {
    std::shared_ptr<Group> scene;                 // the default scene (json.scene, else the first)
    std::vector<std::shared_ptr<Group>> scenes;   // every scene, in file order
    std::vector<std::shared_ptr<animation::AnimationClip>> animations;
    std::vector<std::shared_ptr<Camera>> cameras;  // definitions, like GLTFLoader result.cameras
    std::string error;                            // empty on success
};

struct LoadOptions {
    /**
     * A host that decodes images itself (the web host, with the browser's decoders off the main
     * thread) answers by glTF image index; null leaves that image to this loader's decoders.
     */
    std::function<std::shared_ptr<const ExternalImage>(std::size_t image)> externalImage;
};

/** Loads a GLB (or glTF JSON with embedded buffers) from memory. */
LoadResult load(std::span<const uint8_t> bytes, const LoadOptions& options = {});

} // namespace tn::engine::gltf
