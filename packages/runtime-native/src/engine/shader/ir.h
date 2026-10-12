#pragma once

#include <array>
#include <cstdint>
#include <functional>
#include <source_location>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

namespace tn::engine::shader {

/** WGSL-compatible value types: a scalar, a vector (rows 2–4, cols 1) or a matrix (cols × rows). */
struct Type {
    enum class Scalar : uint8_t { Void, Bool, I32, U32, F32 };
    Scalar scalar = Scalar::Void;
    uint8_t rows = 1;
    uint8_t cols = 1;

    static Type f32() { return {Scalar::F32, 1, 1}; }
    static Type i32() { return {Scalar::I32, 1, 1}; }
    static Type u32() { return {Scalar::U32, 1, 1}; }
    static Type boolean() { return {Scalar::Bool, 1, 1}; }
    static Type vec(uint8_t n, Scalar s = Scalar::F32) { return {s, n, 1}; }
    static Type mat(uint8_t cols, uint8_t rows) { return {Scalar::F32, rows, cols}; }

    bool isScalar() const { return rows == 1 && cols == 1 && scalar != Scalar::Void; }
    bool isVector() const { return rows > 1 && cols == 1; }
    bool isMatrix() const { return cols > 1; }
    bool numeric() const { return scalar == Scalar::I32 || scalar == Scalar::U32 || scalar == Scalar::F32; }
    bool operator==(const Type&) const = default;
    std::string name() const;
};

enum class Stage : uint8_t { Vertex, Fragment, Compute };

using ExprId = uint32_t;
using VarId = uint32_t;
inline constexpr ExprId kInvalid = 0;  // poisons dependents without repeating the diagnostic

enum class Op : uint8_t {
    Constant, Uniform, Attribute, Builtin, Varying,
    Add, Sub, Mul, Div, Neg, Less, Equal, Select,
    Swizzle, Construct, Call,
    // Ordered reads: pinned as statements where created, so they observe prior writes.
    LoadVar, LoadStorage, Sample, SampleLevel, AtomicAdd, TextureSize, TextureLoad,
    // Integer bit operations: r185's `>>` and `^` on one integer type.
    ShiftRight, BitXor,
};

struct Expr {
    Op op;
    Type type;
    std::array<ExprId, 4> args{};
    uint8_t argc = 0;
    uint64_t immediate = 0;  // constant bits, swizzle lanes, or an interned name
};

/** A gather-compare Sample's immediate: the texture index, then the signed whole-texel x and y offsets. */
constexpr uint64_t gatherImmediate(uint32_t texture, int8_t x, int8_t y) {
    return texture | uint64_t(uint8_t(x)) << 32 | uint64_t(uint8_t(y)) << 40;
}
constexpr uint32_t gatherTexture(uint64_t immediate) { return uint32_t(immediate); }
constexpr int gatherOffsetX(uint64_t immediate) { return int8_t(uint8_t(immediate >> 32)); }
constexpr int gatherOffsetY(uint64_t immediate) { return int8_t(uint8_t(immediate >> 40)); }

struct Diagnostic {
    std::string code;     // TN_TSL_TYPE | TN_TSL_UNSUPPORTED
    std::string node;     // the operation that failed
    std::string reason;
    std::string file;
    uint32_t line = 0;
};

using Where = std::source_location;

struct StageModule;
StageModule buildStage(const class Program& program, uint32_t group);

/**
 * One shader stage's IR (PRD-510). Pure expressions are hash-consed, so the same operation on the
 * same operands is one node. Effects — assignments, storage writes, discards, ordered reads — live
 * in blocks that keep program order, nested by If and Loop: a graph is not a DAG of arithmetic.
 * Every type error names the authoring call site.
 */
class Program {
public:
    explicit Program(Stage stage);

    ExprId constant(float value, Where where = Where::current());
    ExprId constant(int32_t value, Where where = Where::current());
    ExprId constant(bool value, Where where = Where::current());
    ExprId uniform(std::string_view name, Type type, Where where = Where::current());
    ExprId attribute(std::string_view name, Type type, Where where = Where::current());
    /** A fragment input written by the vertex stage's output of the same name. */
    ExprId varying(std::string_view name, Type type, Where where = Where::current());
    /** Stage builtins: position, instanceIndex, vertexIndex, frontFacing, globalInvocationId. */
    ExprId builtin(std::string_view name, Where where = Where::current());

    ExprId add(ExprId a, ExprId b, Where where = Where::current());
    ExprId sub(ExprId a, ExprId b, Where where = Where::current());
    ExprId mul(ExprId a, ExprId b, Where where = Where::current());
    ExprId div(ExprId a, ExprId b, Where where = Where::current());
    ExprId neg(ExprId a, Where where = Where::current());
    ExprId less(ExprId a, ExprId b, Where where = Where::current());
    ExprId equal(ExprId a, ExprId b, Where where = Where::current());
    ExprId shiftRight(ExprId a, ExprId b, Where where = Where::current());
    ExprId bitXor(ExprId a, ExprId b, Where where = Where::current());
    ExprId select(ExprId condition, ExprId whenTrue, ExprId whenFalse, Where where = Where::current());
    ExprId swizzle(ExprId value, std::string_view lanes, Where where = Where::current());
    ExprId construct(Type type, const std::vector<ExprId>& parts, Where where = Where::current());
    /** A catalogued builtin function (dot, normalize, mix, …); anything else is TN_TSL_UNSUPPORTED. */
    ExprId call(std::string_view function, const std::vector<ExprId>& args, Where where = Where::current());

    VarId var(Type type, ExprId initial, Where where = Where::current());
    ExprId load(VarId var, Where where = Where::current());
    void assign(VarId var, ExprId value, Where where = Where::current());

    /** `atomic`: an `array<atomic<i32|u32>>`; loads and stores on it become atomicLoad/atomicStore. */
    uint32_t storageBuffer(std::string_view name, Type element, bool atomic = false, Where where = Where::current());
    ExprId loadStorage(uint32_t buffer, ExprId index, Where where = Where::current());
    /** `atomicAdd(&buffer[index], value)` on an atomic buffer: the element's value before the add. */
    ExprId atomicAdd(uint32_t buffer, ExprId index, ExprId value, Where where = Where::current());
    void store(uint32_t buffer, ExprId index, ExprId value, Where where = Where::current());
    /** A sampled 2D float texture and its sampler, bound together. */
    uint32_t texture2d(std::string_view name);
    uint32_t texture3d(std::string_view name);
    uint32_t textureCube(std::string_view name);
    /** vec4<f32>; implicit derivatives in a fragment stage, level 0 elsewhere. */
    ExprId sample(uint32_t texture, ExprId uv, Where where = Where::current());
    /**
     * vec4<f32> at an explicit mip `level` (textureSampleLevel). A cubeUV environment's levels are
     * tiles in one mip, so a bilinearCubeUV tap is always level 0 — three's `.grad(vec2(), vec2())`.
     */
    ExprId sampleLevel(uint32_t texture, ExprId uv, ExprId level, Where where = Where::current());
    ExprId textureSize(uint32_t texture, ExprId level, Where where = Where::current());
    ExprId textureLoad(uint32_t texture, ExprId coordinate, ExprId level, Where where = Where::current());
    /** A depth texture (2D, or a cube) and its comparison sampler, bound together: a shadow map. */
    uint32_t textureDepth(std::string_view name, bool cube = false);
    /** f32 in [0, 1]: `reference` compared against the depth texture at `uv` (vec3 for a cube), filtered. */
    ExprId sampleCompare(uint32_t texture, ExprId uv, ExprId reference, Where where = Where::current());
    /** vec4: the four texels around `uv` (2D depth texture, offset by whole texels) each compared with
     *  `reference`, as textureGatherCompare answers them (three's `.offset(o).gather().compare(z)`). */
    ExprId gatherCompare(uint32_t texture, ExprId uv, ExprId reference, int8_t offsetX, int8_t offsetY,
                         Where where = Where::current());
    void breakLoop(Where where = Where::current());
    void continueLoop(Where where = Where::current());
    void discard(Where where = Where::current());
    /**
     * A stage output: "position" (vec4, vertex) and "color" (vec4, fragment) are the fixed ones;
     * any other name is a varying, located in order of first output.
     */
    void output(std::string_view name, ExprId value, Where where = Where::current());

    void If(ExprId condition, const std::function<void()>& then, const std::function<void()>& otherwise = {},
            Where where = Where::current());
    /** `for (var i: i32 = 0; i < count; i++)`; the body receives the index. */
    void Loop(ExprId count, const std::function<void(ExprId index)>& body, Where where = Where::current());

    const Expr& expr(ExprId id) const { return exprs_[id]; }
    size_t exprCount() const { return exprs_.size() - 1; }
    const std::vector<Diagnostic>& diagnostics() const { return diagnostics_; }
    bool ok() const { return diagnostics_.empty(); }
    Stage stage() const { return stage_; }
    /**
     * Marks the clip position `@invariant`: two pipelines that share this vertex module (a normal pass
     * drawn depth-Equal after the colour pass) are then guaranteed the same position. It costs the
     * compiler its freedom to fuse the position arithmetic, so a program that is drawn alone is left
     * as three's is, and only the programs of a frame that draws a second pipeline depth-Equal against the colour pass (a normal pass, TRAA's velocity pass) ask for it.
     */
    void setInvariantPosition(bool on) { invariantPosition_ = on; }

    /**
     * Canonical text: one line per statement, expressions numbered by first use. `typed` suffixes
     * every expression with `:<type>` (the TSL differential compares structure and types).
     */
    std::string dump(bool typed = false) const;
    std::vector<std::pair<std::string, Type>> varyings() const;
    /** True when this stage already writes the output `name`. */
    [[nodiscard]] bool hasOutput(std::string_view name) const;
    /** Match vertex output locations to the fragment's first-use varying order. */
    void linkVaryings(const Program& fragment);

private:
    uint32_t loopDepth_ = 0;
    friend class WgslEmitter;
    friend StageModule buildStage(const Program& program, uint32_t group);

    enum class StmtKind : uint8_t { Eval, Assign, Store, Discard, If, Loop, Output, Break, Continue };
    struct Stmt {
        StmtKind kind;
        uint32_t a = 0;  // var, buffer, condition, or count
        ExprId b = kInvalid;
        ExprId c = kInvalid;
        uint32_t body = 0;      // block index
        uint32_t otherwise = 0; // block index, 0 = none
    };
    struct Var {
        Type type;
    };
    struct Storage {
        std::string name;
        Type element;
        bool atomic = false;
    };

    ExprId fail(std::string_view node, std::string reason, const Where& where);
    ExprId pure(Expr expr);
    ExprId ordered(Expr expr);
    ExprId arithmetic(Op op, std::string_view node, ExprId a, ExprId b, const Where& where);
    uint64_t intern(std::string_view name);
    uint32_t openBlock();
    void emit(Stmt stmt) { blocks_[current_].push_back(stmt); }
    void dumpBlock(uint32_t block, int depth, std::string& out, std::vector<int>& numbering, int& next) const;
    std::string describe(ExprId id, std::vector<int>& numbering) const;
    std::string describeUntyped(ExprId id, std::vector<int>& numbering) const;
    mutable bool typed_ = false;

    Stage stage_;
    std::vector<Expr> exprs_;
    std::unordered_map<std::string, ExprId> pureIndex_;
    std::vector<std::string> names_;
    std::unordered_map<std::string, uint64_t> nameIndex_;
    std::vector<Var> vars_;
    std::vector<Storage> storage_;
    std::vector<std::string> textures_;
    enum class TextureKind : uint8_t { Float2d, Depth2d, DepthCube, Float3d, FloatCube };
    std::vector<TextureKind> textureKinds_; // per texture
    struct OutputSlot {
        uint64_t name;
        Type type;
    };
    std::vector<OutputSlot> outputs_;
    bool invariantPosition_ = false;
    std::vector<std::vector<Stmt>> blocks_;
    uint32_t current_ = 0;
    std::vector<Diagnostic> diagnostics_;
};

}  // namespace tn::engine::shader
