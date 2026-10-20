#include "check.h"
#include "engine/player/skinned_crowd.h"
#include "engine/renderer/render_database.h"

#include <cstring>
#include <algorithm>
#include <regex>
#include <unordered_map>

using namespace tn::engine;

// Resolve generated straight-line WGSL lets so assertions follow operands, not declaration order.
std::string vertexOutput(const std::string& code, const char* output) {
    std::unordered_map<std::string, std::string> values;
    const std::regex identifier(R"(\b[el][0-9]+\b)");
    const auto expand = [&](const std::string& expression) {
        std::string result;
        std::size_t begin = 0;
        for (auto token = std::sregex_iterator(expression.begin(), expression.end(), identifier);
             token != std::sregex_iterator(); ++token) {
            result += expression.substr(begin, token->position() - begin);
            const auto found = values.find(token->str());
            result += found == values.end() ? token->str() : found->second;
            begin = token->position() + token->length();
        }
        return result + expression.substr(begin);
    };
    const std::regex assignment(R"((?:let )?([a-zA-Z0-9_.]+) = ([^;]+);)");
    for (auto line = std::sregex_iterator(code.begin(), code.end(), assignment); line != std::sregex_iterator();
         ++line) {
        const std::string expression = expand((*line)[2]);
        if ((*line)[1] == output)
            return expression;
        values[(*line)[1]] = expression;
    }
    return {};
}

void paletteShaderOrder() {
    for (bool palette : {false, true})
        for (bool storage : {false, true}) {
            shader::VertexVariant variant;
            variant.instanced = variant.skinned = true;
            variant.skinnedPalette = palette;
            variant.instanceStorage = storage;
            for (int material = 0; material < 5; ++material) {
                auto programs = material == 0   ? shader::buildBasic(variant)
                                : material == 1 ? shader::buildStandard({}, variant)
                                : material == 2 ? shader::buildLambert(variant)
                                : material == 3 ? shader::buildPhong(variant)
                                                : shader::buildPhysical({}, variant);
                const auto module = shader::buildStage(programs.vertex, 0);
                CHECK(module.wgsl.ok());
                for (const char* output : {"out.position", "out.o_normalView"}) {
                    const std::string expression = vertexOutput(module.wgsl.code, output);
                    if (std::string(output) == "out.o_normalView" && material == 0)
                        continue;
                    CHECK(!expression.empty());
                    const auto placement = expression.find(storage ? "s_instances" : "a_instanceMatrix");
                    const auto bone = expression.find("s_boneMatrices");
                    CHECK(placement != std::string::npos && bone != std::string::npos);
                    CHECK(palette ? placement < bone : bone < placement);
                    if (palette && placement != std::string::npos && bone != std::string::npos) {
                        Matrix4 root, pose, world;
                        root.makeRotationY(0.7).scale(Vector3(1.4, 1.4, 1.4)).setPosition(Vector3(3, 2, -4));
                        pose.makeRotationZ(-0.6).setPosition(Vector3(0.5, 0.2, 1));
                        world.multiplyMatrices(root, pose);
                        for (bool legacy : {false, true}) {
                            const Matrix4 instance = legacy ? Matrix4() : root;
                            const Matrix4 skin = legacy ? world : pose;
                            Vector3 actual(0.3, 0.7, -0.2), expected = actual, reversed = actual;
                            if (std::string(output) == "out.position") {
                                expected.applyMatrix4(world);
                                reversed.applyMatrix4(instance).applyMatrix4(skin);
                                if (placement < bone)
                                    actual.applyMatrix4(skin).applyMatrix4(instance);
                                else
                                    actual.applyMatrix4(instance).applyMatrix4(skin);
                            } else {
                                Matrix3 instanceNormal;
                                instanceNormal.getNormalMatrix(instance);
                                expected.transformDirection(world);
                                reversed.applyMatrix3(instanceNormal).normalize().transformDirection(skin);
                                if (placement < bone)
                                    actual.transformDirection(skin).applyMatrix3(instanceNormal).normalize();
                                else
                                    actual.applyMatrix3(instanceNormal).normalize().transformDirection(skin);
                            }
                            CHECK(actual.distanceTo(expected) < 1e-12);
                            if (!legacy)
                                CHECK(reversed.distanceTo(expected) > 0.01);
                        }
                    }
                    if (placement == std::string::npos || bone == std::string::npos)
                        std::fprintf(stderr, "%s\n", module.wgsl.code.c_str());
                }
            }
        }
}

void crowdCpu() {
    paletteShaderOrder();
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
