#pragma once

#include "engine/shader/ir.h"
#include "engine/shader/tonemap.h"
#include <optional>

#include <cstdint>
#include <functional>
#include <initializer_list>
#include <memory>
#include <map>
#include <unordered_map>
#include <string>
#include <string_view>
#include <vector>

/**
 * A native lazy shader graph (PRD-531 slice 1): one node per upstream TSL node kind, built with no
 * program in scope, then lowered into the IR through the native TSL builder when a program exists.
 * A node is an immutable ref-counted value, so a shared node lowers once — as upstream builds one
 * node per stage — and statement nodes keep their program order.
 */
namespace tn::engine {
class Material;
class RenderTarget;
class Mesh;
} // namespace tn::engine
namespace tn::engine::shader::graph {

struct NodeData;
struct PostEffect;

/** A graph node: an immutable, ref-counted value of one upstream TSL kind. */
using Node = std::shared_ptr<const NodeData>;

enum class Kind : uint8_t {
    AtomicAdd, AtomicStore, WgslFunction, WgslCall, Constant, Uniform, Attribute, Builtin, Varying, PositionLocal,
    Unary, Binary, Math, Swizzle, Join, Convert, Select, Texture,
    StorageElement, VarRead, LoopIndex,
    Body, Var, Assign, If, Loop, RenderTexture, TextureSize, TextureLoad, Call, Return, Break, Continue, Discard, PostEffect,
    Pmrem, ScreenUv, Reflector, ViewportDepth, StructType, Struct, StructMember, RenderOutput, PipelineOutput,
    Compute,
};

enum class UnOp : uint8_t { Negate };
enum class BinOp : uint8_t { Add, Sub, Mul, Div, Less, Greater, Equal, ShiftRight, BitXor, LessEqual, GreaterEqual };

struct RttState {
    std::shared_ptr<tn::engine::RenderTarget> target;
    std::shared_ptr<tn::engine::Material> material;
    std::shared_ptr<tn::engine::Mesh> quad;
    Node source;
    double scale = 1;
    uint32_t width = 0, height = 0, actualWidth = 1, actualHeight = 1;
    uint16_t minFilter = 1006, magFilter = 1006;
    bool autoUpdate = true, textureNeedsUpdate = true;
    uint64_t revision = 1, disposal = 0;
    /** The GPU stage this pass's time is reported under (post_effects.h kStage*); the author sets it at creation. */
    uint8_t stage = 0;
};

struct TextureBinding { std::shared_ptr<const void> object; };
struct NodeData {
    std::shared_ptr<TextureBinding> textureBinding;
    const std::shared_ptr<const void>& textureObject() const { return textureBinding ? textureBinding->object : object; }

    std::shared_ptr<RttState> rtt;
    std::shared_ptr<bool> atomic;

    Kind kind = Kind::Constant;
    std::shared_ptr<const PostEffect> post;
    std::shared_ptr<const void> object; // Pmrem: the source texture the renderer prefilters; Reflector: its engine::Reflector
    Type type;
    std::string name;
    std::string lanes;
    uint64_t bits = 0;
    // A uniform's value: data, not part of the program key. A field that changes after a node
    // is built (three's `uniform.value = x`, through setUniformValues); every draw reads it afresh.
    // Keep i32/u32 exact; f32 lanes are rounded by setUniformValues before storage.
    mutable std::vector<double> values;
    UnOp unary = UnOp::Negate;
    BinOp binary = BinOp::Add;
    std::vector<Node> args;
    std::vector<std::pair<std::string, Type>> members; // StructType/Struct: declaration order
    std::vector<Node> body;
    std::vector<Node> otherwise;
    double scale = 1;
    uint32_t width = 0, height = 0; // RTT: zero means drawing-buffer size
    /**
     * What the renderer asks of a graph every draw, worked out once: its interned structural key and
     * its uniform nodes. A copied node (then edited) starts with none, so it never reads its source's.
     */
    struct Memo {
        mutable uint64_t keyId = 0;
        mutable std::shared_ptr<const std::vector<std::shared_ptr<const NodeData>>> uniforms;
        Memo() = default;
        Memo(const Memo&) {}
        Memo& operator=(const Memo&) { return *this; }
    } memo;
};

Node float_(double value);
/** TSL's `float(node)`: a conversion. */
Node float_(Node value);
Node int_(int32_t value);
Node uint_(uint32_t value);
/** TSL's `uint(node)`: a conversion. */
Node uint_(Node value);

Node uniform(std::string_view name, Type type, std::vector<double> values = {});
/** three's `uniform.value = x`: one number per lane of the uniform's type; the program is unchanged. */
void setUniformValues(const Node& uniform, std::vector<double> values);
Node attribute(std::string_view name, Type type);
Node varying(std::string_view name, Type type);
/** TSL's `varying(node, name)`: `value` computed in the vertex stage, read by name in the fragment. */
Node varying(Node value, std::string_view name);
Node builtin(std::string_view name);
Node positionLocal();
Node uv();
/** TSL's screenUV: the fragment's position over the target size; a post pass maps it to its quad's uv. */
Node screenUV();
/** ViewportDepthTextureNode: the frame's depth as drawn before this draw, read at `uv` (0..1). */
Node viewportDepth(Node uv);
Node instanceIndex();

Node vec2(std::initializer_list<Node> parts);
Node vec3(std::initializer_list<Node> parts);
Node vec4(std::initializer_list<Node> parts);
/** A scalar widened to `lanes` as a generator's operand splat: one constructor part, constant or not. */
Node splat(Node scalar, uint8_t lanes);
/** TSL's mat2 over two column vectors, or four scalars in column-major order. */
Node mat2(std::initializer_list<Node> parts);

Node add(Node a, Node b);
Node sub(Node a, Node b);
Node mul(Node a, Node b);
Node div(Node a, Node b);
/** TSL's `>>` and `^` on one integer type (r185's OperatorNode). */
Node shiftRight(Node a, Node b);
Node bitXor(Node a, Node b);
Node negate(Node a);
Node lessThan(Node a, Node b);
Node greaterThan(Node a, Node b);
Node equal(Node a, Node b);
/** TSL's lessThanEqual and greaterThanEqual: a bool per lane. */
Node lessThanEqual(Node a, Node b);
Node greaterThanEqual(Node a, Node b);
/** TSL's `and`, `or` and `not` on bool operands, and `all` / `any` over a bool vector's lanes. */
Node logicalAnd(Node a, Node b);
Node logicalOr(Node a, Node b);
Node logicalNot(Node a);
Node all(Node a);
Node any(Node a);
Node select(Node condition, Node whenTrue, Node whenFalse);
Node swizzle(Node value, std::string_view lanes);
Node texture(std::string_view map, Node uvs);
/** TSL's texture(textureObject, uv): that engine Texture itself, bound under `name`, not a material slot. */
Node textureObject(std::shared_ptr<const void> texture, std::string_view name, Node uvs);
/**
 * TSL's `texture(object, uv)` over an engine Texture the material does not own as a map: sampled
 * under `name`, the binding the renderer fills from `texture` per draw (RenderDatabase::graphSources).
 */
Node objectTexture(std::shared_ptr<const void> texture, std::string name, Node uvs);
/**
 * TSL's `pmremTexture(texture, direction, level)`: the texture's PMREM (prefiltered radiance, cubeUV
 * layout) sampled along `direction` at roughness `level`. `texture` is the engine Texture the
 * renderer prefilters; the program samples it as "pmrem".
 */
Node pmremTexture(std::shared_ptr<const void> texture, Node direction, Node level);
/**
 * TSL's `reflector()` texture node: the mirrored pass the renderer draws for `reflector` (an
 * engine::Reflector), sampled at `uvs` (three's default is screenUV.flipX()) as "reflector".
 */
Node reflectorTexture(std::shared_ptr<const void> reflector, Node uvs);

#define TN_GRAPH_UNARY(name) Node name(Node a);
#define TN_GRAPH_BINARY(name) Node name(Node a, Node b);
#define TN_GRAPH_TERNARY(name) Node name(Node a, Node b, Node c);
TN_GRAPH_UNARY(abs)
TN_GRAPH_UNARY(sin)
TN_GRAPH_UNARY(cos)
TN_GRAPH_UNARY(floor)
TN_GRAPH_UNARY(fract)
TN_GRAPH_UNARY(sqrt)
TN_GRAPH_UNARY(exp)
TN_GRAPH_UNARY(exp2)
TN_GRAPH_UNARY(log2)
TN_GRAPH_UNARY(log)
TN_GRAPH_UNARY(normalize)
TN_GRAPH_UNARY(length)
TN_GRAPH_UNARY(dFdx)
TN_GRAPH_UNARY(dFdy)
TN_GRAPH_UNARY(sign)
TN_GRAPH_UNARY(atan)
TN_GRAPH_UNARY(fwidth)
TN_GRAPH_BINARY(min)
TN_GRAPH_BINARY(max)
TN_GRAPH_BINARY(pow)
TN_GRAPH_BINARY(step)
TN_GRAPH_BINARY(dot)
TN_GRAPH_BINARY(distance)
TN_GRAPH_BINARY(cross)
TN_GRAPH_BINARY(atan2)
TN_GRAPH_BINARY(mod)
TN_GRAPH_TERNARY(mix)
TN_GRAPH_TERNARY(clamp)
TN_GRAPH_TERNARY(smoothstep)
#undef TN_GRAPH_UNARY
#undef TN_GRAPH_BINARY
#undef TN_GRAPH_TERNARY

/** `node.toVar()`: a variable declaration; every read is an ordered load. */
struct Var {
    Node declaration;
    Type type;

    Node read() const;
    operator Node() const { return declaration; }  // NOLINT(google-explicit-constructor): a TSL var is a node
};

/** `instancedArray(count, type)` / `storage(...)`: a storage buffer, named as `setName` names it. */
struct Storage {
    std::string name;
    Type elementType;
    /** TSL storage(attribute, ...): the engine BufferAttribute the renderer binds under `name`; null
     *  for a buffer the renderer owns (instancedArray). */
    std::shared_ptr<const void> object;
    std::shared_ptr<bool> atomic = std::make_shared<bool>(false);

    Node element(Node index) const;
};
inline Storage storage(std::string_view name, Type element) { return Storage{std::string(name), element}; }

/**
 * TSL's `Fn(...)().compute(count, workgroupSize)` (PRD-620): the Body `body` as one compute dispatch
 * of `count` invocations, `workgroupSize` threads to a group. `bits` holds the count, `width` the
 * workgroup size and `name` the label setName gives it. It lowers through computeProgram, never lower().
 */
Node computeNode(Node body, uint32_t count, uint32_t workgroupSize = 64, std::string label = {});

/** Builds a function body: the statement nodes in program order, nested by If and Loop. */
class Block {
public:
    Var var(Node initial);
    void assign(Node target, Node value);
    void If(Node condition, const std::function<void()>& then);
    void IfElse(Node condition, const std::function<void()>& then, const std::function<void()>& otherwise);
    /** TSL's `Loop(count, ({ i }) => ...)` with a number count: an i32 loop from 0. */
    void Loop(int32_t count, const std::function<void(Node)>& body);
    /** The function body node. */
    Node node() const;

private:
    void append(Node statement);
    std::vector<std::shared_ptr<std::vector<Node>>> blocks_{std::make_shared<std::vector<Node>>()};
};

/** A graph is a function body or a single expression. */
using Graph = Node;

/** Walks the graph and emits IR into `program`; a Build scope must be active, as tsl.h requires. */
ExprId lower(const Graph& graph, Program& program,
             const std::unordered_map<std::string, ExprId>& inputs = {},
             std::optional<ToneMapping> toneMapping = std::nullopt, bool srgb = false, Node custom = {});
/**
 * One lowering for all of a program's node slots: a node two slots read (the colour and the depth of
 * one raymarch) lowers once, as three builds a material once. `lower` above is a lowering of one slot.
 */
class Lowering {
public:
    explicit Lowering(Program& program, std::unordered_map<std::string, ExprId> inputs = {},
                      std::optional<ToneMapping> toneMapping = std::nullopt, bool srgb = false, Node custom = {});
    ~Lowering();
    Lowering(const Lowering&) = delete;
    Lowering& operator=(const Lowering&) = delete;
    ExprId lower(const Graph& graph);

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};
/** Canonical DAG serialization, independent of addresses; includes sharing and every operation. */
std::string key(const Graph& graph);
/** How many times key() has serialized a graph in this process; a steady frame serializes none. */
uint64_t keyBuilds();
/** key(graph) interned: equal structures answer the same id, computed once per node (0 for null). */
uint64_t keyId(const Graph& graph);
/** Named uniform data reachable from the graph. Conflicting values fail rather than pick one. */
std::map<std::string, std::vector<double>> uniforms(const Graph& graph);
/** How many maps uniforms() has built in this process; a steady frame builds none. */
uint64_t uniformMapBuilds();
/** Every uniform node reachable from the graph, in first-visit order, found once per graph; a node
 *  may hold no value (a renderer-fed uniform such as `viewMatrix`). */
const std::vector<Node>& uniformList(const Graph& graph);
/** The graph's authored uniform nodes (each with a value), so a pass reads `uniform.value` every frame. */
std::vector<Node> uniformNodes(const Graph& graph);

}  // namespace tn::engine::shader::graph
