#include "check.h"
#include "engine/player/skinned_crowd.h"
#include "engine/renderer/render_database.h"

#include <cstring>
#include <algorithm>

using namespace tn::engine;

void crowdCpu() {
    player::SkinnedCrowd crowd;
    crowd.update(1.0 / 60);
    RenderDatabase db;
    db.shadowMapEnabled = true;
    LightState lights;
    db.batching = false;
    const auto separate = db.prepare(crowd.scene(), crowd.camera(), lights);
    CHECK(separate.size() == 69); // 64 compatible + 4 refusals + ground
    CameraState camera;
    camera.matrixWorldInverse = crowd.camera().matrixWorldInverse.elements;
    camera.projectionMatrix = crowd.camera().projectionMatrix.elements;
    const auto expected = Renderer::sortDraws(separate, camera);
    db.batching = true;
    const auto batched = db.prepare(crowd.scene(), crowd.camera(), lights);
    std::vector<const DrawItem*> compatible;
    for (const auto& [depth, draw] : expected)
        if (draw->skinnedRig && draw->skinnedRig->name.starts_with("walker-")) compatible.push_back(draw);
    std::size_t batches = 0, exact = 0, instances = 0;
    CHECK(batched.size() == 6); // one compatible batch + four exact rigs + ground
    for (const DrawItem& item : batched) {
        if (!item.boneStride) {
            exact += item.boneMatrices != nullptr;
            continue;
        }
        ++batches;
        instances += item.instanceCount;
        CHECK(item.instanceCount == compatible.size());
        CHECK(!compatible.empty() && item.id == compatible.front()->id);
        if (!compatible.empty()) {
            const auto& world = compatible.front()->matrixWorld;
            CHECK((item.sortOrigin == std::array<double, 3>{world[12], world[13], world[14]}));
        }
        const std::size_t stride = item.boneStride * 16;
        CHECK(item.boneMatrices->size() == item.instanceCount * stride);
        for (uint32_t slot = 0; slot < item.instanceCount && slot < compatible.size(); ++slot) {
            const DrawItem& source = *compatible[slot];
            CHECK(source.boneMatrices && source.boneMatrices->size() == stride);
            if (source.boneMatrices && source.boneMatrices->size() == stride)
                CHECK(std::memcmp(item.boneMatrices->data() + slot * stride, source.boneMatrices->data(),
                                  stride * sizeof(float)) == 0);
        }
    }
    std::printf("crowd submission: %zu batches, %zu instances, %zu exact rigs\n", batches, instances, exact);
    CHECK(batches == 1 && instances == 64 && exact == 4);
    CHECK(lights.direct.size() == 1 && lights.direct.front().shadow.has_value());
    CHECK(db.diagnostics().empty());
    for (const DrawItem& item : batched) {
        if (!item.boneMatrices || item.instanceMatrices)
            continue;
        const auto source =
            std::find_if(separate.begin(), separate.end(), [&](const DrawItem& draw) { return draw.id == item.id; });
        CHECK(source != separate.end());
        if (source != separate.end()) {
            CHECK(source->boneMatrices == item.boneMatrices);
            CHECK(item.frontFace() ==
                  (item.skinnedRig->name == "refused-negative" ? WGPUFrontFace_CW : WGPUFrontFace_CCW));
            CHECK(source->matrixWorld == item.matrixWorld && source->bindMatrix == item.bindMatrix &&
                  source->bindMatrixInverse == item.bindMatrixInverse);
        }
    }
    // Main and depth variants both address an instance's palette, rather than always rig zero.
    shader::VertexVariant variant;
    variant.instanced = variant.skinned = variant.skinnedPalette = true;
    for (bool depth : {false, true}) {
        auto programs = depth ? shader::buildBasic(variant) : shader::buildStandard({}, variant);
        const auto module = shader::buildStage(programs.vertex, 0);
        CHECK(module.wgsl.ok());
        CHECK(module.wgsl.code.find("@builtin(instance_index)") != std::string::npos);
        CHECK(module.wgsl.code.find("boneStride") != std::string::npos);
    }
    auto* walker = static_cast<SkinnedMesh*>(crowd.scene().getObjectByName("walker-0"));
    walker->scale.y = 1.5;
    const auto changed = db.prepare(crowd.scene(), crowd.camera(), lights);
    CHECK(std::count_if(changed.begin(), changed.end(),
                        [](const DrawItem& item) { return item.boneMatrices && !item.instanceMatrices; }) == 5);
    std::size_t changedInstances = 0;
    for (const DrawItem& item : changed)
        if (item.boneStride) changedInstances += item.instanceCount;
    CHECK(changedInstances == 63);
    walker->scale.y = 1;
    walker->material->positionNode = std::make_shared<shader::PositionNode>(
        shader::PositionNode{"crowd-position", [](shader::Program&, uint32_t position) { return position; }});
    const auto blocked = db.prepare(crowd.scene(), crowd.camera(), lights);
    CHECK(blocked.size() == 69);
}

TN_TEST_MAIN({"crowd_cpu", crowdCpu})
