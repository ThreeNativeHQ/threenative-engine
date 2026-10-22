#pragma once
#include "engine/shader/graph/graph.h"
#include "engine/shader/package.h"
#include "engine/foundation/json.h"
#include <map>

namespace tn::engine::shader::graph {
/**
 * The labelled GPU stage a post pass reports its time under (`Renderer::lastGpuSegments`, then `info.engine.gpuStages` on the web
 * renderer). The author labels a stage's passes when it creates them; a pass with no label counts under "other passes".
 * three-native's `GPU_STAGES` lists the names in this order, starting at 1.
 */
inline constexpr uint8_t kStageNone = 0, kStageScreenSpaceGi = 1;
struct PostImage {
    std::string name;
    uint32_t width = 0, height = 0;
    std::vector<uint8_t> bytes;
    bool nearest = false, repeat = false;
};
struct PostEffect {
    std::string kind, output;
    std::vector<Node> inputs;
    std::map<std::string, std::vector<double>> parameters;
    std::vector<PostImage> images;
    float resolutionScale = 1;
    bool normal = false, temporal = false;
    bool viewOffset = false;
    std::array<double, 16> originalProjection{};
    uint8_t stage = kStageNone;
};
struct PostPass {
    std::shared_ptr<RttState> rtt;
    std::string output;
    ShaderPackage package;
    // Shader binding name -> render graph resource name. All inputs require a producer.
    std::map<std::string, std::string> reads;
    std::map<std::string, std::vector<double>> uniforms;
    /** The graph's uniform nodes, read each frame over `uniforms`: three's `uniform.value = x` after install. */
    std::vector<Node> live;
    std::vector<PostImage> images;
    float resolutionScale = 1;
    uint32_t width = 0, height = 0; // RTT fixed dimensions; zero uses viewport
    bool floorSize = false, autoUpdate = true, visible = true;
    // GTAONode uses RedFormat + UnsignedByteType (R8Unorm), not an HDR colour target.
    bool redFormat = false;
    float clear = 0;
    bool temporal = false;
    /** The effect whose parameters this pass draws with, read each frame (null: `uniforms` only). */
    std::shared_ptr<const PostEffect> effect;
    /** Non-empty: the renderer draws this pass itself, as `traa` does, and the pass has no shader package. */
    std::string host;
    uint8_t stage = kStageNone;
};
Node importPostEffect(const json::Value& record, const std::vector<Node>& args, std::vector<std::string>& errors);

// three r185's effect nodes built live (PRD-531: a game's `ao()`, `denoise()`, `smaa()`, `bloom()` on V8),
// with each node's own default uniforms and its generated lookup images: the effect an export of the
// same call records. The effect stays mutable until its node is installed, as three's uniforms are
// set after construction (`ao(...).radius.value = 0.35`).
/** GTAONode(depth, normal, camera); `normal` may be null (normals from depth). */
std::shared_ptr<PostEffect> gtaoEffect(Node depth, Node normal);
/** DenoiseNode(input, depth, normal, camera). `seed` draws the SimplexNoise permutation three draws
 *  from Math.random; a fixed seed keeps a native frame reproducible. */
std::shared_ptr<PostEffect> denoiseEffect(Node input, Node depth, Node normal, uint32_t seed);
/** SMAANode(input) with three's embedded area and search tables. */
std::shared_ptr<PostEffect> smaaEffect(Node input);
/** A `bloom()` node's uniform for BloomNode's `strength`, `radius`, `threshold` or `smoothWidth`; null
 *  when the node is no bloom or the name is no such uniform. */
Node bloomParameter(const Node& bloomNode, std::string_view name);
/** The node a live effect is used as: its output texture, a vec4 as three's effect nodes sample. */
Node effectNode(const std::shared_ptr<PostEffect>& effect);
/** three's luminosity high pass, five separable mip blurs and composite (BloomNode r185), as render textures. */
Node bloom(Node input, double strength, double radius, double threshold);
/** mulberry32, the deterministic stand-in for Math.random a reference page can install too. */
double mulberry32(uint32_t& state);
/** Ordered native passes, including materialization of the authored SMAA colour input. */
std::vector<PostPass> postPasses(Node root, std::optional<ToneMapping> toneMapping = std::nullopt, bool srgb = false, Node custom = {});
/** The scene TRAA pass requested by this graph; two distinct resolves fail. */
std::shared_ptr<const PostEffect> traaEffect(Node root);
/**
 * True when the resolve reads a texture the graph drew (the frame after its screen-space stages) and not the scene
 * pass's own colour. It then runs as a pass of the graph, where its input is ready, and not right after the scene pass.
 */
bool traaResolvesLate(const PostEffect& effect);
} // namespace tn::engine::shader::graph
