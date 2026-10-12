#pragma once

#include "engine/shader/ir.h"

#include <cstdint>
#include <functional>
#include <initializer_list>
#include <string>
#include <string_view>
#include <vector>

/**
 * The native TSL builder (PRD-510 phase 2): one function per catalogued TSL authoring function,
 * named as TSL names it, each constructing the IR the upstream node means. Authored C++ reads like
 * the TS it came from: `vec4(positionLocal().mul(u), 1)`. The program being built is the one a
 * `Build` scope holds, as TSL's builder is ambient during `Fn` construction.
 *
 * Proof: tests/native-engine/differential.mjs --suite tsl-ir compares each corpus graph's typed IR
 * dump with the upstream node tree, normalised into the same syntax.
 */
namespace tn::engine::shader::tsl {

inline thread_local Program* current = nullptr;

/** The program TSL calls build into while this scope lives. */
class Build {
public:
    explicit Build(Program& program, Where where = Where::current()) : previous_(current), where_(where) {
        current = &program;
    }
    ~Build() { current = previous_; }
    Build(const Build&) = delete;
    Build& operator=(const Build&) = delete;

private:
    Program* previous_;
    Where where_;
};

inline Program& program() { return *current; }

struct Node;
inline Node float_(double value, Where where = Where::current());

/** A TSL node: an IR expression in the current program. */
struct Node {
    ExprId id = kInvalid;

    Node() = default;
    Node(ExprId expr) : id(expr) {}  // NOLINT(google-explicit-constructor): TSL's implicit nodeObject
    Node(double value) : id(program().constant(static_cast<float>(value))) {}  // NOLINT: TSL lifts JS numbers to float
    Node(int value) : Node(static_cast<double>(value)) {}                      // NOLINT

    Node add(Node b, Where w = Where::current()) const { return program().add(id, b.id, w); }
    Node sub(Node b, Where w = Where::current()) const { return program().sub(id, b.id, w); }
    Node mul(Node b, Where w = Where::current()) const { return program().mul(id, b.id, w); }
    Node div(Node b, Where w = Where::current()) const { return program().div(id, b.id, w); }
    Node negate(Where w = Where::current()) const { return program().neg(id, w); }
    Node lessThan(Node b, Where w = Where::current()) const { return program().less(id, b.id, w); }
    /** TSL's `a > b`: the IR has one ordering comparison, so it is `b < a`. */
    Node greaterThan(Node b, Where w = Where::current()) const { return program().less(b.id, id, w); }
    Node equal(Node b, Where w = Where::current()) const { return program().equal(id, b.id, w); }

    Node swizzle(std::string_view lanes, Where w = Where::current()) const { return program().swizzle(id, lanes, w); }
    Node x() const { return swizzle("x"); }
    Node y() const { return swizzle("y"); }
    Node z() const { return swizzle("z"); }
    Node w() const { return swizzle("w"); }
    Node xy() const { return swizzle("xy"); }
    Node xyz() const { return swizzle("xyz"); }

    Node operator+(Node b) const { return add(b); }
    Node operator-(Node b) const { return sub(b); }
    Node operator*(Node b) const { return mul(b); }
    Node operator/(Node b) const { return div(b); }
    Node operator-() const { return negate(); }
};

inline Node float_(double value, Where where) { return program().constant(static_cast<float>(value), where); }
/** TSL's `float(node)`: a conversion. */
inline Node float_(Node value, Where where = Where::current()) { return program().construct(Type::f32(), {value.id}, where); }
inline Node int_(int32_t value, Where where = Where::current()) { return program().constant(value, where); }
/** TSL's `uint(node)`: a conversion. */
inline Node uint_(Node value, Where where = Where::current()) { return program().construct(Type::u32(), {value.id}, where); }
inline Node uint_(uint32_t value, Where where = Where::current()) {
    return program().construct(Type::u32(), {program().constant(static_cast<int32_t>(value), where)}, where);
}

namespace detail {
inline Node join(uint8_t n, std::initializer_list<Node> parts, Where where) {
    std::vector<ExprId> ids;
    for (const Node& part : parts) ids.push_back(part.id);
    // `vec3(1)` splats a number the way the upstream constant does: one part per lane.
    if (ids.size() == 1 && program().expr(ids[0]).op == Op::Constant) ids.assign(n, ExprId{ids[0]});  // a copy: no aliasing
    return program().construct(Type::vec(n), ids, where);
}
}  // namespace detail

inline Node vec2(std::initializer_list<Node> parts, Where w = Where::current()) { return detail::join(2, parts, w); }
inline Node vec3(std::initializer_list<Node> parts, Where w = Where::current()) { return detail::join(3, parts, w); }
inline Node vec4(std::initializer_list<Node> parts, Where w = Where::current()) { return detail::join(4, parts, w); }

/** A named uniform: upstream TSL's `uniform(value).setName(name)`. */
inline Node uniform(std::string_view name, Type type, Where w = Where::current()) { return program().uniform(name, type, w); }
/** In a fragment stage an attribute arrives through the varying of its name, as upstream builds it. */
inline Node attribute(std::string_view name, Type type, Where w = Where::current()) {
    return program().stage() == Stage::Fragment ? program().varying(name, type, w) : program().attribute(name, type, w);
}
/** The `position` attribute; in a fragment stage, upstream's `positionLocal` varying. */
inline Node positionLocal(Where w = Where::current()) {
    return program().stage() == Stage::Fragment ? program().varying("positionLocal", Type::vec(3), w)
                                                : program().attribute("position", Type::vec(3), w);
}
inline Node uv(Where w = Where::current()) { return attribute("uv", Type::vec(2), w); }
/** In a compute stage TSL's instanceIndex is the invocation's global x, as upstream builds it. */
inline Node instanceIndex(Where w = Where::current()) {
    if (program().stage() == Stage::Compute) return program().swizzle(program().builtin("globalInvocationId", w), "x", w);
    return program().builtin("instanceIndex", w);
}

namespace detail {
inline Node call(std::string_view name, std::initializer_list<Node> args, Where where) {
    std::vector<ExprId> ids;
    for (const Node& arg : args) ids.push_back(arg.id);
    return program().call(name, ids, where);
}
}  // namespace detail

#define TN_TSL_UNARY(name) \
    inline Node name(Node a, Where w = Where::current()) { return detail::call(#name, {a}, w); }
#define TN_TSL_BINARY(name) \
    inline Node name(Node a, Node b, Where w = Where::current()) { return detail::call(#name, {a, b}, w); }
#define TN_TSL_TERNARY(name) \
    inline Node name(Node a, Node b, Node c, Where w = Where::current()) { return detail::call(#name, {a, b, c}, w); }
TN_TSL_UNARY(abs)
TN_TSL_UNARY(sin)
TN_TSL_UNARY(cos)
TN_TSL_UNARY(floor)
TN_TSL_UNARY(fract)
TN_TSL_UNARY(sqrt)
TN_TSL_UNARY(exp)
TN_TSL_UNARY(exp2)
TN_TSL_UNARY(log2)
TN_TSL_UNARY(normalize)
TN_TSL_UNARY(length)
TN_TSL_UNARY(atan)
TN_TSL_UNARY(fwidth)
TN_TSL_BINARY(min)
TN_TSL_BINARY(max)
TN_TSL_BINARY(pow)
TN_TSL_BINARY(step)
TN_TSL_BINARY(dot)
TN_TSL_BINARY(distance)
TN_TSL_BINARY(cross)
TN_TSL_BINARY(atan2)
TN_TSL_BINARY(mod)
TN_TSL_TERNARY(mix)
TN_TSL_TERNARY(clamp)
TN_TSL_TERNARY(smoothstep)
inline Node shiftRight(Node a, Node b, Where w = Where::current()) { return program().shiftRight(a.id, b.id, w); }
inline Node bitXor(Node a, Node b, Where w = Where::current()) { return program().bitXor(a.id, b.id, w); }
#undef TN_TSL_UNARY
#undef TN_TSL_BINARY
#undef TN_TSL_TERNARY

inline Node select(Node condition, Node whenTrue, Node whenFalse, Where w = Where::current()) {
    return program().select(condition.id, whenTrue.id, whenFalse.id, w);
}

/** `textureNode.sample(uv)` on a texture already declared (e.g. a pass's output). */
inline Node sample(uint32_t texture, Node uvs, Where w = Where::current()) { return program().sample(texture, uvs.id, w); }

/** `texture(map, uv)`: the map is declared by name on first use. */
inline Node texture(std::string_view map, Node uvs, Where w = Where::current()) {
    return program().sample(program().texture2d(map), uvs.id, w);
}

/** `node.toVar()`: a variable; every use reads it (an ordered load), `assign` writes it. */
struct Var {
    VarId id = 0;
    Type type;

    Node read(Where w = Where::current()) const { return program().load(id, w); }
    operator Node() const { return read(); }  // NOLINT(google-explicit-constructor): a TSL var is a node
    void assign(Node value, Where w = Where::current()) const { program().assign(id, value.id, w); }
    Node add(Node b, Where w = Where::current()) const { return read(w).add(b, w); }
    Node mul(Node b, Where w = Where::current()) const { return read(w).mul(b, w); }
};
inline Var toVar(Node initial, Where w = Where::current()) {
    return Var{program().var(program().expr(initial.id).type, initial.id, w), program().expr(initial.id).type};
}

/** `instancedArray(count, type)` / `storage(...)`: a storage buffer, named as `setName` names it. */
struct Storage {
    uint32_t buffer = 0;

    struct Element {
        uint32_t buffer;
        Node index;
        Node read(Where w = Where::current()) const { return program().loadStorage(buffer, index.id, w); }
        operator Node() const { return read(); }  // NOLINT(google-explicit-constructor)
        void assign(Node value, Where w = Where::current()) const { program().store(buffer, index.id, value.id, w); }
    };
    Element element(Node index) const { return Element{buffer, index}; }
};
inline Storage storage(std::string_view name, Type element) { return Storage{program().storageBuffer(name, element)}; }

/** `Fn(body)`: native authored code is the function; calling it constructs its IR in place. */
inline void Fn(const std::function<void()>& body) { body(); }
inline void If(Node condition, const std::function<void()>& then, const std::function<void()>& otherwise = {},
               Where w = Where::current()) {
    program().If(condition.id, then, otherwise, w);
}
/** TSL's `If(c, a).Else(b)`. */
inline void IfElse(Node condition, const std::function<void()>& then, const std::function<void()>& otherwise,
                   Where w = Where::current()) {
    program().If(condition.id, then, otherwise, w);
}
/** TSL's `Loop(count, ({ i }) => ...)` with a number count: an i32 loop from 0. */
inline void Loop(int32_t count, const std::function<void(Node)>& body, Where w = Where::current()) {
    program().Loop(program().constant(count, w), [&](ExprId index) { body(Node(index)); }, w);
}
inline void Loop(Node count, const std::function<void(Node)>& body, Where w = Where::current()) {
    program().Loop(count.id, [&](ExprId index) { body(Node(index)); }, w);
}

/** A stage output (`material.positionNode` writes "position", `colorNode` writes "color"). */
inline void output(std::string_view name, Node value, Where w = Where::current()) { program().output(name, value.id, w); }

}  // namespace tn::engine::shader::tsl
