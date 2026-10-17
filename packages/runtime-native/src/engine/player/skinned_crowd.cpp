#include "engine/player/skinned_crowd.h"

#include <algorithm>
#include <cmath>

#include "engine/foundation/math/MathUtils.h"
#include "engine/scene/geometries.h"
#include "engine/scene/lights.h"
#include "engine/scene/material.h"

namespace tn::engine::player {

SkinnedCrowd::SkinnedCrowd(bool refusalCases) {
    constexpr int bones = 12, side = 8;
    constexpr double height = 2, spacing = 1.4, extent = side * spacing / 2 + 1;
    camera_.position.set(0, 7, 11);
    camera_.lookAt(0, 0, 0);
    camera_.updateProjectionMatrix();

    auto sky = std::make_shared<HemisphereLight>(Color().setHex(0xdfefff), Color().setHex(0x3a3226), 1.2);
    auto sun = std::make_shared<DirectionalLight>(Color().setHex(0xfff1dc), 2.4);
    sun->position.set(6, 14, 8);
    sun->setCastShadow(true);
    sun->shadow.mapSize.set(1024, 1024);
    auto& shadowCamera = static_cast<OrthographicCamera&>(*sun->shadow.camera);
    shadowCamera.left = shadowCamera.bottom = -extent;
    shadowCamera.right = shadowCamera.top = extent;
    scene_.add(*sky);
    scene_.add(*sun);

    auto skin = std::make_shared<Material>(MaterialType::Standard);
    skin->color.setHex(0xc27d52);
    skin->roughness = 0.6;
    auto groundMaterial = std::make_shared<Material>(MaterialType::Standard);
    groundMaterial->color.setHex(0x6f7c5a);
    groundMaterial->roughness = 0.95;
    auto ground = std::make_shared<Mesh>(makePlaneGeometry(extent * 2, extent * 2), groundMaterial);
    ground->name = "ground";
    ground->rotation.x = -PI / 2;
    ground->position.y = -height / 2;
    ground->setReceiveShadow(true);
    scene_.add(*ground);

    auto geometry = makeCylinderGeometry(0.22, 0.3, height, 12, 22);
    const auto position = geometry->attributes.at("position");
    std::vector<double> indices, weights;
    for (uint64_t vertex = 0; vertex < position->count(); ++vertex) {
        const double along = ((position->getY(vertex) + height / 2) / height) * (bones - 1);
        const double bone = std::min(std::floor(along), double(bones - 2));
        const double blend = along - bone;
        indices.insert(indices.end(), {bone, bone + 1, 0, 0});
        weights.insert(weights.end(), {1 - blend, blend, 0, 0});
    }
    geometry->setAttribute("skinIndex", BufferAttribute::fromDoubles(Scalar::U16, indices, 4));
    geometry->setAttribute("skinWeight", BufferAttribute::fromFloats(weights, 4));
    std::vector<animation::KeyframeTrack> tracks;
    for (int bone = 1; bone < bones; ++bone)
        tracks.emplace_back("bone" + std::to_string(bone) + ".rotation[z]", animation::TrackType::Number,
                            std::vector<double>{0, 1, 2}, std::vector<double>{-0.09, 0.09, -0.09});
    clip_ = std::make_shared<animation::AnimationClip>("sway", 2, std::move(tracks));

    for (int index = 0; index < side * side + (refusalCases ? 4 : 0); ++index) {
        std::vector<std::shared_ptr<Bone>> chain;
        auto mesh = std::make_shared<SkinnedMesh>(geometry, skin);
        for (int bone = 0; bone < bones; ++bone) {
            auto joint = std::make_shared<Bone>();
            joint->name = "bone" + std::to_string(bone);
            joint->position.y = bone == 0 ? -height / 2 : height / (bones - 1);
            if (chain.empty())
                mesh->add(*joint);
            else
                chain.back()->add(*joint);
            chain.push_back(joint);
        }
        mesh->bind(std::make_shared<Skeleton>(chain));
        mesh->setCastShadow(true);
        mesh->setReceiveShadow(true);
        mesh->name = "walker-" + std::to_string(index);
        mesh->position.set(((index % side) - (side - 1) / 2.0) * spacing, 0,
                           (std::floor(index / double(side)) - (side - 1) / 2.0) * spacing);
        mesh->rotation.y = index * 0.37;
        if (index >= side * side) {
            mesh->position.set((index - side * side - 1.5) * spacing, 0, 5.7);
            switch (index - side * side) {
            case 0:
                mesh->name = "refused-non-uniform";
                mesh->scale.set(1, 1.4, 1);
                break;
            case 1:
                mesh->name = "refused-negative";
                mesh->scale.x = -1;
                break;
            case 2: {
                mesh->name = "refused-transparent";
                auto transparent = std::make_shared<Material>(MaterialType::Standard);
                transparent->color = skin->color;
                transparent->roughness = skin->roughness;
                transparent->transparent = true;
                transparent->opacity = 0.65;
                mesh->material = transparent;
                break;
            }
            case 3:
                mesh->name = "refused-render-order";
                mesh->setRenderOrder(1);
                break;
            }
        }
        scene_.add(*mesh);
        auto mixer = std::make_unique<animation::AnimationMixer>(mesh);
        mixer->clipAction(clip_)->play();
        mixers_.push_back(std::move(mixer));
    }
}

void SkinnedCrowd::update(double) {
    ++frames_;
    for (std::size_t index = 0; index < mixers_.size(); ++index)
        mixers_[index]->setTime(std::fmod(index * 0.29, 2.0) + frames_ / 60.0);
}

} // namespace tn::engine::player
