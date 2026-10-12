// The native `OrthographicCamera`'s projection matrix and its inverse, bit-for-bit against what the
// pinned three builds (ortho_projection_reference.json, written by ortho_projection-reference.ts).
// The cases cover zoom != 1, asymmetric frusta, view offsets, both coordinate systems a renderer
// uses and reversed depth, so a difference in the expression order of `updateProjectionMatrix`,
// `Matrix4::makeOrthographic` or `Matrix4::invert` fails here.
#include <bit>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <iterator>
#include <string>

#include "engine/foundation/json.h"
#include "engine/scene/camera.h"

using JsonValue = tn::engine::json::Value;
using tn::engine::CoordinateSystem;
using tn::engine::Matrix4;
using tn::engine::OrthographicCamera;

namespace {

std::string readFile(const char* path) {
    std::ifstream in(path, std::ios::binary);
    return std::string(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
}

double bits(const std::string& hex) { return std::bit_cast<double>(std::stoull(hex, nullptr, 16)); }

/** Every bit matches; any NaN matches any NaN (payload is not a claim). */
bool same(double expected, double actual) {
    if (std::isnan(expected) && std::isnan(actual)) return true;
    return std::bit_cast<uint64_t>(expected) == std::bit_cast<uint64_t>(actual);
}

int compare(const Matrix4& matrix, const JsonValue& expected, const char* which) {
    int differ = 0;
    const auto& values = expected.items();
    for (size_t i = 0; i < 16 && i < values.size(); i++) {
        const double want = bits(values[i].string());
        if (!same(want, matrix.elements[i])) {
            std::printf("      %s[%zu] expected %016llx, got %016llx\n", which, i,
                        static_cast<unsigned long long>(std::bit_cast<uint64_t>(want)),
                        static_cast<unsigned long long>(
                            std::bit_cast<uint64_t>(matrix.elements[i])));
            ++differ;
        }
    }
    return differ;
}

}  // namespace

int main() {
    JsonValue reference;
    tn::engine::json::Error error;
    if (!tn::engine::json::parse(readFile(TN_ORTHO_PROJECTION_REFERENCE), reference, error)) {
        std::printf("FAIL: cannot read %s\n", TN_ORTHO_PROJECTION_REFERENCE);
        return 1;
    }

    int checks = 0;
    int differ = 0;
    for (const JsonValue& test : reference.find("cases")->items()) {
        const std::string name = test.find("name")->string();
        OrthographicCamera camera(
            test.find("left")->number(), test.find("right")->number(),
            test.find("top")->number(), test.find("bottom")->number(),
            test.find("near")->number(), test.find("far")->number());
        camera.zoom = test.find("zoom")->number();
        camera.coordinateSystem = test.find("coordinateSystem")->string() == "webgpu"
                                      ? CoordinateSystem::WebGPU
                                      : CoordinateSystem::WebGL;
        camera.setReversedDepth(test.find("reversedDepth")->boolean());

        const JsonValue* view = test.find("viewOffset");
        if (view != nullptr && view->isObject()) {
            camera.setViewOffset(view->find("fullWidth")->number(),
                                 view->find("fullHeight")->number(), view->find("x")->number(),
                                 view->find("y")->number(), view->find("width")->number(),
                                 view->find("height")->number());
            const JsonValue* clear = test.find("clearViewOffset");
            if (clear != nullptr && clear->isBool() && clear->boolean()) {
                camera.clearViewOffset();
            } else {
                camera.updateProjectionMatrix();
            }
        } else {
            camera.updateProjectionMatrix();
        }

        checks += 2;
        const int matrixDiffer = compare(camera.projectionMatrix, *test.find("projectionMatrix"), "projection");
        const int inverseDiffer =
            compare(camera.projectionMatrixInverse, *test.find("projectionMatrixInverse"), "inverse");
        if (matrixDiffer + inverseDiffer != 0) {
            std::printf("  %s differs (%d)\n", name.c_str(), matrixDiffer + inverseDiffer);
            differ += matrixDiffer + inverseDiffer;
        }
    }

    std::printf("ortho projection: %d checks, %d differ\n", checks, differ);
    if (checks == 0 || differ != 0) {
        std::printf("FAIL\n");
        return 1;
    }
    std::printf("PASS\n");
    return 0;
}
