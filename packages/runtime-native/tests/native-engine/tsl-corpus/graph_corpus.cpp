// PRD-531 slice 1: the TSL corpus authored as a lazy shader graph (src/engine/shader/graph), graph
// for graph the same as tsl_corpus.cpp and tsl-corpus/reference.ts. Each graph is built with no
// program in scope, then lowered into a Program through the native TSL builder and printed in the
// same typed IR dump. differential.mjs --suite tsl-ir compares it with the upstream node tree.
#include "engine/shader/graph/graph.h"
#include "engine/shader/tsl/tsl.h"

#include <cstdio>
#include <functional>
#include <string>

using namespace tn::engine::shader;
using namespace tn::engine::shader::graph;
namespace tsl = tn::engine::shader::tsl;

namespace {

/** three's hash(seed) (math/Hash.js), spelled with the graph's integer operations. */
Node hashOf(Node seed) {
    const Node state = add(mul(uint_(seed), uint_(747796405u)), uint_(2891336453u));
    const Node shifted = shiftRight(state, add(shiftRight(state, uint_(28u)), uint_(4u)));
    const Node word = mul(bitXor(shifted, state), uint_(277803737u));
    return mul(float_(bitXor(shiftRight(word, uint_(22u)), word)), float_(1.0 / 4294967296.0));
}

void shaderGraph(const char* name, const char* output, const std::function<Node()>& make) {
    Program p(std::string(output) == "color" ? Stage::Fragment : Stage::Vertex);
    const Node root = make();
    {
        tsl::Build build(p);
        tsl::output(output, lower(root, p));
    }
    std::printf("# %s\n", name);
    if (!p.ok()) {
        for (const Diagnostic& d : p.diagnostics())
            std::printf("DIAGNOSTIC %s %s: %s\n", d.code.c_str(), d.node.c_str(), d.reason.c_str());
        return;
    }
    std::printf("%s", p.dump(true).c_str());
}

/** A compute graph: the body of an `Fn`, dispatched one invocation per instance. */
void compute(const char* name, const std::function<void(Block&, Storage)>& make) {
    Program p(Stage::Compute);
    Block body;
    const Storage positions = storage("positions", Type::vec(4));
    make(body, positions);
    const Node root = body.node();
    std::printf("# %s\n", name);
    {
        tsl::Build build(p);
        lower(root, p);
    }
    for (const Diagnostic& d : p.diagnostics())
        std::printf("DIAGNOSTIC %s %s: %s\n", d.code.c_str(), d.node.c_str(), d.reason.c_str());
    if (p.ok()) std::printf("%s", p.dump(true).c_str());
}

Node u() { return uniform("u", Type::f32()); }
Node tint() { return uniform("tint", Type::vec(3)); }
Node time() { return uniform("time", Type::f32()); }

}  // namespace

int main() {
    shaderGraph("scale-by-uniform", "position", [] { return vec4({mul(positionLocal(), u()), float_(1)}); });
    shaderGraph("swizzle-and-join", "color",
          [] { return vec4({swizzle(positionLocal(), "zyx"), swizzle(positionLocal(), "x")}); });
    shaderGraph("sin-of-sum", "color", [] { return vec4({vec3({sin(add(float_(2), u()))}), float_(1)}); });
    shaderGraph("attribute-weight", "position",
          [] { return vec4({mul(positionLocal(), attribute("weight", Type::f32())), float_(1)}); });
    shaderGraph("vector-math", "color",
          [] { return vec4({normalize(cross(positionLocal(), tint())), dot(positionLocal(), tint())}); });
    shaderGraph("length-distance", "color",
          [] {
              return vec4(
                  {length(positionLocal()), distance(positionLocal(), tint()), float_(0), float_(1)});
          });
    shaderGraph("mix-clamp-smoothstep", "color",
          [] {
              return vec4({mix(tint(), positionLocal(), clamp(u(), float_(0), float_(1))),
                           smoothstep(float_(0), float_(1), u())});
          });
    shaderGraph("unary-math", "color", [] { return vec4({abs(u()), floor(u()), fract(u()), sqrt(u())}); });
    shaderGraph("binary-math", "color",
          [] {
              return vec4({pow(u(), float_(2)), min(u(), time()), max(u(), time()), step(u(), time())});
          });
    shaderGraph("exp-cos", "color", [] { return vec4({exp2(u()), cos(time()), float_(0), float_(1)}); });
    shaderGraph("compare-select", "color",
          [] { return vec4({vec3({select(lessThan(u(), time()), u(), time())}), float_(1)}); });
    shaderGraph("greater-select", "color",
          [] {
              return vec4({vec3({select(greaterThan(u(), float_(0.25)), float_(1), float_(0))}), float_(1)});
          });
    shaderGraph("negate-sub-div", "color",
          [] { return vec4({negate(u()), sub(u(), time()), div(u(), float_(2)), float_(1)}); });
    shaderGraph("uv-texture", "color", [] { return texture("albedo", uv()); });
    shaderGraph("texture-scaled-uv", "color", [] { return mul(texture("albedo", mul(uv(), float_(2))), u()); });
    shaderGraph("int-convert", "color",
          [] { return vec4({float_(int_(3)), float_(uint_(4)), float_(0), float_(1)}); });
    shaderGraph("vector-constants", "color",
          [] { return vec4({add(vec3({float_(1), float_(2), float_(3)}), tint()), float_(1)}); });
    shaderGraph("constant-splat", "color", [] { return vec4({mul(vec3({float_(0.5)}), tint()), float_(1)}); });
    shaderGraph("vec2-swizzle", "color",
          [] { return vec4({swizzle(vec2({u(), time()}), "yx"), float_(0), float_(1)}); });
    shaderGraph("instance-offset", "position",
          [] {
              return vec4({add(positionLocal(), vec3({float_(instanceIndex()), float_(0), float_(0)})),
                           float_(1)});
          });
    shaderGraph("time-wave", "position",
          [] {
              return vec4({add(positionLocal(),
                               vec3({float_(0), sin(add(time(), swizzle(positionLocal(), "x"))), float_(0)})),
                           float_(1)});
          });
    shaderGraph("camera-position", "color",
          [] { return vec4({uniform("cameraPosition", Type::vec(3)), float_(1)}); });
    shaderGraph("camera-projection", "position",
          [] {
              return mul(uniform("cameraProjectionMatrix", Type::mat(4, 4)),
                         vec4({attribute("position", Type::vec(3)), float_(1)}));
          });
    shaderGraph("camera-world-matrix", "color",
          [] {
              return mul(uniform("cameraWorldMatrix", Type::mat(4, 4)),
                         vec4({float_(1), float_(0), float_(0), float_(0)}));
          });
    shaderGraph("position-geometry", "position",
          [] { return vec4({swizzle(attribute("position", Type::vec(3)), "xy"), float_(0), float_(1)}); });
    shaderGraph("normal-world", "color",
          [] {
              return vec4({normalize(swizzle(mul(vec4({normalize(varying("normalView", Type::vec(3))), float_(0)}),
                                                 uniform("viewMatrix", Type::mat(4, 4))), "xyz")),
                           float_(1)});
          });
    shaderGraph("varying-fragment", "color",
          [] { return vec4({varying(mul(attribute("position", Type::vec(3)), u()), "scaled"), float_(1)}); });
    shaderGraph("varying-vertex", "position",
          [] { return vec4({varying(mul(attribute("position", Type::vec(3)), u()), "scaled"), float_(1)}); });
    shaderGraph("atan", "color", [] { return vec4({atan(u()), atan2(time(), u()), float_(0), float_(1)}); });
    shaderGraph("mod", "color", [] { return vec4({mod(positionLocal(), tint()), mod(u(), time())}); });
    shaderGraph("fwidth", "color", [] { return vec4({fwidth(uv()), fwidth(u()), float_(1)}); });
    shaderGraph("saturation", "color", [] {
        const Node rgb = swizzle(tint(), "xyz");
        const Node luminance = dot(rgb, vec3({float_(0.2126), float_(0.7152), float_(0.0722)}));
        return vec4({max(mix(splat(luminance, 3), rgb, u()), splat(float_(0), 3)), float_(1)});
    });
    shaderGraph("mat2", "color", [] {
        return vec4({mul(mat2({vec2({float_(1), float_(0)}), vec2({float_(0), float_(1)})}), vec2({u(), time()})),
                     float_(0), float_(1)});
    });
    shaderGraph("hash", "color", [] { return vec4({hashOf(u()), float_(0), float_(0), float_(1)}); });
    shaderGraph("time", "color", [] { return vec4({time(), float_(0), float_(0), float_(1)}); });
    shaderGraph("normal-local", "position",
          [] { return vec4({add(positionLocal(), mul(attribute("normal", Type::vec(3)), u())), float_(1)}); });
    shaderGraph("tangent-local", "position", [] {
        return vec4({add(positionLocal(), mul(swizzle(attribute("tangent", Type::vec(4)), "xyz"), u())), float_(1)});
    });
    shaderGraph("position-previous", "color",
          [] { return vec4({varying(attribute("position", Type::vec(3)), "positionPrevious"), float_(1)}); });
    shaderGraph("storage-attribute", "position", [] {
        return vec4({add(positionLocal(), swizzle(storage("palette", Type::vec(4)).element(instanceIndex()), "xyz")),
                     float_(1)});
    });
    shaderGraph("screen-coordinate", "color",
          [] { return vec4({swizzle(builtin("position"), "xy"), float_(0), float_(1)}); });
    shaderGraph("position-view-direction", "color",
          [] { return vec4({normalize(varying("positionViewDirection", Type::vec(3))), float_(1)}); });
    shaderGraph("screen-size", "color", [] { return vec4({uniform("screenSize", Type::vec(2)), float_(0), float_(1)}); });
    shaderGraph("depth", "color", [] {
        const Node near = uniform("cameraNear", Type::f32()), far = uniform("cameraFar", Type::f32());
        const Node viewZ = swizzle(varying("positionView", Type::vec(3)), "z");
        return vec4({div(mul(add(near, viewZ), far), mul(sub(far, near), viewZ)), float_(0), float_(0), float_(1)});
    });
    shaderGraph("normal-world-geometry", "color",
          [] { return vec4({normalize(varying("normalWorldGeometry", Type::vec(3))), float_(1)}); });
    shaderGraph("get-view-position", "color", [] {
        const Node uvs = uv();
        const Node screen = sub(mul(vec2({swizzle(uvs, "x"), sub(float_(1), swizzle(uvs, "y"))}), float_(2)), float_(1));
        const Node view = mul(uniform("cameraProjectionMatrix", Type::mat(4, 4)), vec4({vec3({screen, u()}), float_(1)}));
        return vec4({div(swizzle(view, "xyz"), swizzle(view, "w")), float_(1)});
    });
    shaderGraph("set-group", "color",
          [] { return vec4({uniform("grouped", Type::f32()), float_(0), float_(0), float_(1)}); });
    shaderGraph("transform-normal-to-view", "color", [] {
        const Node transformed = mul(uniform("modelNormalMatrix", Type::mat(3, 3)), tint());
        return vec4({normalize(swizzle(mul(uniform("viewMatrix", Type::mat(4, 4)), vec4({transformed, float_(0)})), "xyz")), float_(1)});
    });
    shaderGraph("property", "color", [] { return vec4({add(vec3({float_(0)}), tint()), float_(1)}); });

    compute("fn-if-store", [](Block& b, Storage positions) {
        const Var acc = b.var(float_(0));
        b.If(lessThan(instanceIndex(), uint_(16)), [&] {
            b.assign(acc, add(acc.read(), float_(1)));
            b.assign(positions.element(instanceIndex()), vec4({acc.read(), float_(0), float_(0), float_(1)}));
        });
    });
    compute("loop-accumulate", [](Block& b, Storage positions) {
        const Var acc = b.var(float_(0));
        b.Loop(4, [&](Node i) { b.assign(acc, add(acc.read(), float_(i))); });
        b.assign(positions.element(instanceIndex()), vec4({acc.read(), float_(0), float_(0), float_(1)}));
    });
    compute("if-else", [](Block& b, Storage positions) {
        b.IfElse(lessThan(instanceIndex(), uint_(8)),
                 [&] {
                     b.assign(positions.element(instanceIndex()),
                              vec4({float_(1), float_(0), float_(0), float_(1)}));
                 },
                 [&] {
                     b.assign(positions.element(instanceIndex()),
                              vec4({float_(0), float_(1), float_(0), float_(1)}));
                 });
    });
    compute("storage-read-modify", [](Block& b, Storage positions) {
        b.assign(positions.element(instanceIndex()),
                 mul(positions.element(instanceIndex()), float_(2)));
    });
    return 0;
}
