// PRD-510 phase 2: the TSL corpus authored with the native builder, graph for graph the same as
// tsl-corpus/reference.ts. Prints each graph's typed IR dump; differential.mjs --suite tsl-ir
// compares it with the upstream node tree normalised into the same syntax. A graph whose program
// carries a diagnostic prints it instead, which never equals the reference.
#include "engine/shader/tsl/tsl.h"

#include <cstdio>
#include <functional>
#include <string>

using namespace tn::engine::shader;
using namespace tn::engine::shader::tsl;

namespace {

void graph(const char* name, const char* output, const std::function<Node()>& body) {
    Program p(std::string(output) == "color" ? Stage::Fragment : Stage::Vertex);
    {
        Build build(p);
        tsl::output(output, body());
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
void compute(const char* name, const std::function<void(Storage)>& body) {
    Program p(Stage::Compute);
    {
        Build build(p);
        const Storage positions = storage("positions", Type::vec(4));
        Fn([&] { body(positions); });
    }
    std::printf("# %s\n", name);
    for (const Diagnostic& d : p.diagnostics())
        std::printf("DIAGNOSTIC %s %s: %s\n", d.code.c_str(), d.node.c_str(), d.reason.c_str());
    if (p.ok()) std::printf("%s", p.dump(true).c_str());
}

Node u() { return uniform("u", Type::f32()); }
Node tint() { return uniform("tint", Type::vec(3)); }
Node time() { return uniform("time", Type::f32()); }
/** A scalar widened by one constructor part, as MathNode.generate splats it; vec3() would expand a constant. */
Node splat3(Node scalar) { return Node(program().construct(Type::vec(3), {scalar.id}, Where::current())); }
Node matrix2(Node a, Node b) { return Node(program().construct(Type::mat(2, 2), {a.id, b.id}, Where::current())); }
/** three's hash(seed) (math/Hash.js), spelled with the builder's integer operations. */
Node hashOf(Node seed) {
    const Node state = uint_(seed).mul(uint_(747796405u)).add(uint_(2891336453u));
    const Node shifted = shiftRight(state, shiftRight(state, uint_(28u)).add(uint_(4u)));
    const Node word = bitXor(shifted, state).mul(uint_(277803737u));
    return float_(bitXor(shiftRight(word, uint_(22u)), word)).mul(float_(1.0 / 4294967296.0));
}

}  // namespace

int main() {
    graph("scale-by-uniform", "position", [] { return vec4({positionLocal().mul(u()), 1}); });
    graph("swizzle-and-join", "color", [] { return vec4({positionLocal().swizzle("zyx"), positionLocal().x()}); });
    graph("sin-of-sum", "color", [] { return vec4({vec3({sin(float_(2).add(u()))}), 1}); });
    graph("attribute-weight", "position",
          [] { return vec4({positionLocal().mul(attribute("weight", Type::f32())), 1}); });
    graph("vector-math", "color",
          [] { return vec4({normalize(cross(positionLocal(), tint())), dot(positionLocal(), tint())}); });
    graph("length-distance", "color",
          [] { return vec4({length(positionLocal()), distance(positionLocal(), tint()), 0, 1}); });
    graph("mix-clamp-smoothstep", "color",
          [] { return vec4({mix(tint(), positionLocal(), clamp(u(), 0, 1)), smoothstep(0, 1, u())}); });
    graph("unary-math", "color", [] { return vec4({abs(u()), floor(u()), fract(u()), sqrt(u())}); });
    graph("binary-math", "color",
          [] { return vec4({pow(u(), 2), min(u(), time()), max(u(), time()), step(u(), time())}); });
    graph("exp-cos", "color", [] { return vec4({exp2(u()), cos(time()), 0, 1}); });
    graph("compare-select", "color",
          [] { return vec4({vec3({select(u().lessThan(time()), u(), time())}), 1}); });
    graph("greater-select", "color",
          [] { return vec4({vec3({select(u().greaterThan(0.25), float_(1), float_(0))}), 1}); });
    graph("negate-sub-div", "color", [] { return vec4({u().negate(), u().sub(time()), u().div(2), 1}); });
    graph("uv-texture", "color", [] { return texture("albedo", uv()); });
    graph("texture-scaled-uv", "color", [] { return texture("albedo", uv().mul(2)).mul(u()); });
    graph("int-convert", "color", [] { return vec4({float_(int_(3)), float_(uint_(4)), 0, 1}); });
    graph("vector-constants", "color", [] { return vec4({vec3({1, 2, 3}).add(tint()), 1}); });
    graph("constant-splat", "color", [] { return vec4({vec3({0.5}).mul(tint()), 1}); });
    graph("vec2-swizzle", "color", [] { return vec4({vec2({u(), time()}).swizzle("yx"), 0, 1}); });
    graph("instance-offset", "position",
          [] { return vec4({positionLocal().add(vec3({float_(instanceIndex()), 0, 0})), 1}); });
    graph("time-wave", "position",
          [] { return vec4({positionLocal().add(vec3({0, sin(time().add(positionLocal().x())), 0})), 1}); });
    graph("camera-position", "color", [] { return vec4({uniform("cameraPosition", Type::vec(3)), 1}); });
    graph("camera-projection", "position", [] {
        return uniform("cameraProjectionMatrix", Type::mat(4, 4)).mul(vec4({attribute("position", Type::vec(3)), 1}));
    });
    graph("camera-world-matrix", "color",
          [] { return uniform("cameraWorldMatrix", Type::mat(4, 4)).mul(vec4({1, 0, 0, 0})); });
    graph("position-geometry", "position", [] { return vec4({attribute("position", Type::vec(3)).xy(), 0, 1}); });
    graph("normal-world", "color", [] {
        const Node normalView = normalize(program().varying("normalView", Type::vec(3)));
        return vec4({normalize(vec4({normalView, 0}).mul(uniform("viewMatrix", Type::mat(4, 4))).xyz()), 1});
    });
    graph("varying-fragment", "color", [] { return vec4({program().varying("scaled", Type::vec(3)), 1}); });
    graph("varying-vertex", "position", [] { return vec4({attribute("position", Type::vec(3)).mul(u()), 1}); });
    graph("atan", "color", [] { return vec4({atan(u()), atan2(time(), u()), 0, 1}); });
    graph("mod", "color", [] { return vec4({mod(positionLocal(), tint()), mod(u(), time())}); });
    graph("fwidth", "color", [] { return vec4({fwidth(uv()), fwidth(u()), 1}); });
    graph("saturation", "color", [] {
        const Node rgb = tint().swizzle("xyz");
        const Node luminance = dot(rgb, vec3({0.2126, 0.7152, 0.0722}));
        return vec4({max(mix(splat3(luminance), rgb, u()), splat3(float_(0))), 1});
    });
    graph("mat2", "color", [] { return vec4({matrix2(vec2({1, 0}), vec2({0, 1})).mul(vec2({u(), time()})), 0, 1}); });
    graph("hash", "color", [] { return vec4({hashOf(u()), 0, 0, 1}); });
    graph("time", "color", [] { return vec4({time(), 0, 0, 1}); });
    graph("normal-local", "position", [] { return vec4({positionLocal().add(attribute("normal", Type::vec(3)).mul(u())), 1}); });
    graph("tangent-local", "position",
          [] { return vec4({positionLocal().add(attribute("tangent", Type::vec(4)).xyz().mul(u())), 1}); });
    graph("position-previous", "color", [] { return vec4({program().varying("positionPrevious", Type::vec(3)), 1}); });
    graph("storage-attribute", "position", [] {
        return vec4({positionLocal().add(Node(storage("palette", Type::vec(4)).element(instanceIndex())).xyz()), 1});
    });
    graph("screen-coordinate", "color",
          [] { return vec4({Node(program().builtin("position")).xy(), 0, 1}); });
    graph("position-view-direction", "color",
          [] { return vec4({normalize(Node(program().varying("positionViewDirection", Type::vec(3)))), 1}); });
    graph("screen-size", "color", [] { return vec4({uniform("screenSize", Type::vec(2)), 0, 1}); });
    graph("depth", "color", [] {
        const Node near = uniform("cameraNear", Type::f32()), far = uniform("cameraFar", Type::f32());
        const Node viewZ = Node(program().varying("positionView", Type::vec(3))).z();
        return vec4({near.add(viewZ).mul(far).div(far.sub(near).mul(viewZ)), 0, 0, 1});
    });
    graph("normal-world-geometry", "color",
          [] { return vec4({normalize(Node(program().varying("normalWorldGeometry", Type::vec(3)))), 1}); });
    graph("get-view-position", "color", [] {
        const Node uvs = uv();
        const Node screen = vec2({uvs.x(), float_(1).sub(uvs.y())}).mul(2).sub(1);
        const Node view = uniform("cameraProjectionMatrix", Type::mat(4, 4)).mul(vec4({vec3({screen, u()}), 1}));
        return vec4({view.xyz().div(view.w()), 1});
    });
    graph("set-group", "color", [] { return vec4({uniform("grouped", Type::f32()), 0, 0, 1}); });
    graph("transform-normal-to-view", "color", [] {
        const Node transformed = uniform("modelNormalMatrix", Type::mat(3, 3)).mul(tint());
        return vec4({normalize(uniform("viewMatrix", Type::mat(4, 4)).mul(vec4({transformed, 0})).xyz()), 1});
    });
    graph("property", "color", [] { return vec4({vec3({float_(0)}).add(tint()), 1}); });

    compute("fn-if-store", [](Storage positions) {
        const Var acc = toVar(float_(0));
        If(instanceIndex().lessThan(uint_(16)), [&] {
            acc.assign(acc.add(1));
            positions.element(instanceIndex()).assign(vec4({acc, 0, 0, 1}));
        });
    });
    compute("loop-accumulate", [](Storage positions) {
        const Var acc = toVar(float_(0));
        Loop(4, [&](Node i) { acc.assign(acc.add(float_(i))); });
        positions.element(instanceIndex()).assign(vec4({acc, 0, 0, 1}));
    });
    compute("if-else", [](Storage positions) {
        IfElse(instanceIndex().lessThan(uint_(8)),
               [&] { positions.element(instanceIndex()).assign(vec4({1, 0, 0, 1})); },
               [&] { positions.element(instanceIndex()).assign(vec4({0, 1, 0, 1})); });
    });
    compute("storage-read-modify", [](Storage positions) {
        positions.element(instanceIndex()).assign(Node(positions.element(instanceIndex())).mul(2));
    });
    return 0;
}
