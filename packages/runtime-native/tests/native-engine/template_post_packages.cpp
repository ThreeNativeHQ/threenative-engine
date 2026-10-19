#include "engine/shader/graph/serialized.h"
#include "engine/shader/graph/post_effects.h"
#include "engine/renderer/graph/render_graph.h"
#include "engine/shader/output.h"
#include "engine/shader/package.h"
#include "engine/shader/tsl/tsl.h"
#include "engine/foundation/json.h"

#include <fstream>
#include <iostream>
#include <iterator>
#include <functional>
#include <unordered_set>

using namespace tn::engine::shader;

namespace {
/**
 * PRD-531 slice 4: the effect a game builds live on V8 (`ao()`, `denoise()`, `smaa()`) against the one
 * three's own node exported: the same parameters (camera matrices are per-frame state) and the
 * same lookup images, byte for byte. DenoiseNode's noise is drawn with the harness's seed 1.
 */
int compareLive(const std::string& kind, const graph::Node& root) {
    std::shared_ptr<const graph::PostEffect> exported;
    std::unordered_set<const graph::NodeData*> seen;
    const std::function<void(graph::Node)> find = [&](graph::Node n) {
        if (!n || !seen.insert(n.get()).second) return;
        if (n->post && n->post->kind == kind) exported = n->post;
        for (const auto* list : {&n->args, &n->body, &n->otherwise}) for (const auto& c : *list) find(c);
    };
    find(root);
    if (!exported) { std::cerr << kind << ": TN_POST_LIVE: no exported " << kind << "\n"; return 1; }
    const auto& in = exported->inputs;
    const std::shared_ptr<graph::PostEffect> live =
        kind == "GTAONode" ? graph::gtaoEffect(in.at(0), exported->normal ? in.at(1) : nullptr)
        : kind == "DenoiseNode" ? graph::denoiseEffect(in.at(0), in.at(1), exported->normal ? in.at(2) : nullptr, 1)
                                : graph::smaaEffect(in.at(0));
    int failures = 0;
    const auto fail = [&](const std::string& what) { std::cerr << kind << ": TN_POST_LIVE_DIFFERS: " << what << "\n"; ++failures; };
    for (const auto& [name, values] : exported->parameters) {
        if (name.find("Matrix") != std::string::npos) continue;
        const auto found = live->parameters.find(name);
        if (found == live->parameters.end()) fail("missing parameter " + name);
        else if (found->second != values) fail("parameter " + name);
    }
    if (live->parameters.size() != exported->parameters.size()) fail("parameter count");
    if (live->images.size() != exported->images.size()) fail("image count");
    for (size_t i = 0; i < std::min(live->images.size(), exported->images.size()); ++i) {
        const auto& a = live->images[i];
        const auto& b = exported->images[i];
        if (a.width != b.width || a.height != b.height || a.nearest != b.nearest || a.repeat != b.repeat)
            fail("image " + std::to_string(i) + " format");
        if (a.bytes != b.bytes) {
            size_t at = 0;
            while (at < std::min(a.bytes.size(), b.bytes.size()) && a.bytes[at] == b.bytes[at]) ++at;
            fail("image " + std::to_string(i) + " bytes from " + std::to_string(at));
        }
    }
    if (live->normal != exported->normal || live->temporal != exported->temporal ||
        live->resolutionScale != exported->resolutionScale)
        fail("descriptor");
    if (failures == 0) std::cout << kind << ": live effect equals the exported one\n";
    return failures == 0 ? 0 : 1;
}
}  // namespace

int main(int argc, char** argv) {
    if (argc == 4 && std::string(argv[1]) == "--live") {
        std::ifstream input(argv[3]);
        const std::string source{std::istreambuf_iterator<char>(input), {}};
        std::vector<std::string> errors;
        const auto node = graph::importSerialized(source, errors);
        if (!node) { for (const auto& e : errors) std::cerr << e << "\n"; return 1; }
        return compareLive(argv[2], node);
    }
    if (argc != 4) { std::cerr << "expected template, exported graph, output prefix\n"; return 2; }
    std::ifstream input(argv[2]);
    if (!input) { std::cerr << argv[1] << ": cannot read exported graph\n"; return 2; }
    const std::string source{std::istreambuf_iterator<char>(input), {}};
    ShaderPackage package;
    package.name = argv[1];
    const auto node = graph::importSerialized(source, package.errors);
    if (!node || !package.ok()) {
        for (const auto& error : package.errors) std::cerr << package.name << ": " << error << '\n';
        return 1;
    }
    const PostNode post{graph::key(node), [&](Program& p, uint32_t, ExprId uv) {
        tsl::Build build(p);
        return graph::lower(node, p, {{"uv", uv}});
    }};
    const auto programs = buildOutput(std::nullopt, false, &post);
    for (const Program* p : {&programs.vertex, &programs.fragment})
        for (const auto& d : p->diagnostics()) package.errors.push_back(d.code + ": " + d.node + ": " + d.reason);
    package.variants.push_back(Variant{0, {buildStage(programs.vertex), buildStage(programs.fragment)}});
    std::vector<ShaderPackage> packages;
    tn::engine::graph::RenderGraph renderGraph;
    using Desc = tn::engine::graph::TextureDesc;
    std::map<std::string, tn::engine::graph::ResourceId> resources;
    for (const std::string name : {"scene", "depth", "normal"}) resources[name] = renderGraph.external(name, Desc{320,240,1,1});
    const auto passes = graph::postPasses(node);
    for (const auto& pass : passes) {
        for (const auto& image : pass.images) resources[image.name] = renderGraph.external(image.name, Desc{image.width,image.height,1,1});
        resources[pass.output] = renderGraph.transient(pass.output, Desc{320,240,1,1});
    }
    for (const auto& pass : passes) {
        std::vector<tn::engine::graph::Read> reads;
        for (const auto& [binding, name] : pass.reads) {
            if (!resources.count(name)) { std::cerr << package.name << ": TN_POST_INPUT_MISSING: " << name << '\n'; return 1; }
            reads.push_back({resources.at(name)});
        }
        renderGraph.pass(pass.output, tn::engine::graph::PassKind::Render, reads, {resources.at(pass.output)});
        packages.push_back(pass.package);
    }
    const auto plan = renderGraph.compile();
    if (!plan.ok()) { for (const auto& d : plan.errors) std::cerr << d.code << ": " << d.detail << '\n'; return 1; }
    packages.push_back(package);
    std::string error;
    for (const auto& compiled : packages) if (!acceptPackage(compiled, error)) { std::cerr << package.name << ": " << error << '\n'; return 1; }
    std::vector<tn::engine::json::Value> modules;
    size_t index = 0;
    for (const auto& compiled : packages) for (const auto& module : compiled.variants[0].stages) {
        const std::string file = std::string(argv[3]) + "-" + std::to_string(index++) + ".wgsl";
        std::ofstream output(file);
        output << module.wgsl.code;
        if (!output) { std::cerr << package.name << ": failed to write " << file << '\n'; return 2; }
        modules.push_back(tn::engine::json::Value::makeString(file));
    }
    std::ofstream manifest(std::string(argv[3]) + ".modules.json");
    manifest << tn::engine::json::stringify(tn::engine::json::Value::makeArray(std::move(modules)));
    return manifest ? 0 : 2;
}
