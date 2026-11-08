// PRD-515 meshopt slice: a meshopt-compressed glTF decodes to the bytes that were compressed, and a
// malformed stream is a refusal that names its buffer view. The fixture is a 912-byte GLB whose
// compressed buffer views have no fallback data: a loader that only reads the uncompressed buffer
// reads nothing here. `meshopt-compressed.glb` is the pinned meshoptimizer v1.3 encoder run over the
// arrays below (vertex stream stride 12, count 8, mode ATTRIBUTES, no filter; index stream 16-bit,
// count 6, mode TRIANGLES), then wrapped in a GLB by hand.
#include "check.h"
#include "engine/assets/gltf/loader.h"
#include "engine/scene/geometry.h"
#include "engine/scene/nodes.h"

#include <cmath>
#include <cstdint>
#include <cstdio>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

using namespace tn::engine;

namespace {

float kPositions[8][3] = {{-0.5f, -0.5f, 0.5f},  {0.5f, -0.5f, 0.5f},  {0.5f, 0.5f, 0.5f},  {-0.5f, 0.5f, 0.5f},
                          {-0.5f, -0.5f, -0.5f}, {0.5f, -0.5f, -0.5f}, {0.5f, 0.5f, -0.5f}, {-0.5f, 0.5f, -0.5f}};
const uint16_t kIndices[6] = {0, 1, 2, 0, 2, 3};

std::string readFixture() {
    std::ifstream in(TN_GLTF_MESHOPT_FIXTURE, std::ios::binary);
    return std::string(std::istreambuf_iterator<char>(in), std::istreambuf_iterator<char>());
}

// Every occurrence, in place, so the file stays the same length: an extension rename has to reach
// extensionsUsed, extensionsRequired and each bufferView at once.
std::string replace(std::string bytes, const std::string& from, const std::string& to) {
    if (from.size() != to.size() || bytes.find(from) == std::string::npos) return {};
    for (std::size_t at = bytes.find(from); at != std::string::npos; at = bytes.find(from, at + to.size()))
        bytes.replace(at, from.size(), to);
    return bytes;
}

gltf::LoadResult loadBytes(const std::string& bytes) {
    return gltf::load(std::span<const uint8_t>(reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size()));
}

// The one mesh's geometry, or null (with the load error printed) when the model did not load.
std::shared_ptr<BufferGeometry> geometryOf(const gltf::LoadResult& result, const char* what) {
    if (!result.error.empty() || !result.scene) {
        std::printf("%s: %s\n", what, result.error.c_str());
        return nullptr;
    }
    const auto* mesh = dynamic_cast<Mesh*>(result.scene->getObjectByName("mesh0"));
    if (!mesh || !mesh->geometry) {
        std::printf("%s: no mesh0 geometry\n", what);
        return nullptr;
    }
    return mesh->geometry;
}

// Decoded positions and indices equal the arrays the fixture was built from.
void decodedMatchesSource() {
    const std::string bytes = readFixture();
    CHECK(!bytes.empty());
    const gltf::LoadResult loaded = loadBytes(bytes);
    const auto geometry = geometryOf(loaded, "meshopt fixture");
    CHECK(geometry != nullptr);
    if (!geometry) return;
    const auto position = geometry->getAttribute("position");
    const auto index = geometry->getIndex();
    CHECK(position != nullptr && index != nullptr);
    CHECK(position && position->count() == 8 && position->itemSize == 3);
    CHECK(index && index->count() == 6);
    if (!position || !index) return;
    int differ = 0;
    for (std::uint64_t v = 0; v < 8; ++v)
        for (int c = 0; c < 3; ++c)
            if (position->getComponent(v, c) != double(kPositions[v][c])) {
                std::printf("position %llu.%d: %g, want %g\n", static_cast<unsigned long long>(v), c,
                            position->getComponent(v, c), double(kPositions[v][c]));
                ++differ;
            }
    for (std::uint64_t i = 0; i < 6; ++i)
        if (index->getComponent(i, 0) != double(kIndices[i])) {
            std::printf("index %llu: %g, want %u\n", static_cast<unsigned long long>(i), index->getComponent(i, 0),
                        unsigned(kIndices[i]));
            ++differ;
        }
    CHECK(differ == 0);
}

// KHR_meshopt_compression states the same fields under another name ("EXT" and "KHR" are the same
// length, so the fixture's JSON rewrites in place) and decodes alike: cgltf parses only EXT.
void khrDecodesAlike() {
    std::string khr = replace(readFixture(), "EXT_meshopt_compression", "KHR_meshopt_compression");
    CHECK(!khr.empty());
    if (khr.empty()) return;
    const gltf::LoadResult loaded = loadBytes(khr);
    const auto geometry = geometryOf(loaded, "KHR fixture");
    CHECK(geometry != nullptr);
    if (!geometry) return;
    const auto position = geometry->getAttribute("position");
    CHECK(position && position->count() == 8);
    CHECK(position && position->getComponent(1, 0) == double(kPositions[1][0]));
    CHECK(position && position->getComponent(6, 2) == double(kPositions[6][2]));
}

// Every malformed stream is refused with the stable code, naming its buffer view, and never crashes.
// The declarative cases run on the KHR name: cgltf validates EXT_meshopt_compression's own fields and
// refuses those first, while KHR_meshopt_compression is nobody's but this loader's.
void malformedIsRefused() {
    const std::string bytes = readFixture();
    const std::string khr = replace(bytes, "EXT_meshopt_compression", "KHR_meshopt_compression");
    CHECK(!khr.empty());
    if (khr.empty()) return;
    struct Case {
        const char* what;
        std::string mutated;
    };
    const Case cases[] = {
        // count * byteStride no longer equals the parent bufferView's byteLength (96 = 8 * 12).
        {"count", replace(khr, R"("count":8)", R"("count":4)")},
        // A compressed buffer that does not exist.
        {"buffer", replace(khr, R"("buffer":0)", R"("buffer":9)")},
        // An index count that is not a multiple of three (6 -> 5).
        {"triangles", replace(khr, R"("count":6)", R"("count":5)")},
        // A parent bufferView longer than count * byteStride can fill.
        {"decoded size", replace(khr, R"("byteLength":96)", R"("byteLength":97)")},
        // A mode the spec does not name.
        {"mode", replace(khr, R"("mode":"ATTRIBUTES")", R"("mode":"ATTRIBUTE!")")},
    };
    for (const Case& c : cases) {
        CHECK(!c.mutated.empty());
        if (c.mutated.empty()) continue;
        const gltf::LoadResult loaded = loadBytes(c.mutated);
        std::printf("malformed %s: %s\n", c.what, loaded.error.empty() ? "(loaded)" : loaded.error.c_str());
        CHECK(loaded.error.rfind("TN_NATIVE_GLTF_MESHOPT_INVALID bufferView ", 0) == 0);
        CHECK(!loaded.scene);
    }
    // A corrupted bitstream, under either name: the vertex codec's header byte is not one it knows.
    for (const std::string& fixture : {bytes, khr}) {
        std::string corrupt = fixture;
        const std::size_t bin = corrupt.rfind("BIN");
        CHECK(bin != std::string::npos && bin + 4 < corrupt.size());
        if (bin == std::string::npos || bin + 4 >= corrupt.size()) continue;
        corrupt[bin + 4] = char(0xff);
        const gltf::LoadResult loaded = loadBytes(corrupt);
        std::printf("corrupt stream: %s\n", loaded.error.empty() ? "(loaded)" : loaded.error.c_str());
        CHECK(loaded.error.rfind("TN_NATIVE_GLTF_MESHOPT_INVALID bufferView 0: meshopt decode failed", 0) == 0);
    }
}

}  // namespace

TN_TEST_MAIN({"decoded_matches_source", decodedMatchesSource}, {"khr_decodes_alike", khrDecodesAlike},
             {"malformed_is_refused", malformedIsRefused})
