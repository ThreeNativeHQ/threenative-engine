#pragma once

#include "engine/shader/graph/graph.h"

#include <cstddef>
#include <cstdint>
#include <map>
#include <memory>
#include <string>
#include <vector>

namespace tn::abi {

/** One argument of a TSL authoring call, as a language back end hands it over. */
struct TslArg {
    enum class Kind : uint8_t { Node, Number, String, Named, Rgb, Vector, Other, Object };  // Other: no TSL meaning
    Kind kind = Kind::Number;
    engine::shader::graph::Node node;
    double number = 0;
    std::string text;           // a String, or the name of a Named object (a texture)
    double numbers[4] = {0, 0, 0, 0};  // Rgb: a three Color's r, g, b; Vector: a three VectorN's lanes
    uint8_t lanes = 0;                  // Vector: 2, 3 or 4
    std::string cls;               // an Object: the engine object's class
    std::shared_ptr<void> object;  // an Object: the engine object itself (pmremTexture's texture)

    static TslArg of(engine::shader::graph::Node value) { TslArg a; a.kind = Kind::Node; a.node = std::move(value); return a; }
    static TslArg of(double value) { TslArg a; a.kind = Kind::Number; a.number = value; return a; }
    static TslArg of(std::string value) { TslArg a; a.kind = Kind::String; a.text = std::move(value); return a; }
    static TslArg named(std::string value) { TslArg a; a.kind = Kind::Named; a.text = std::move(value); return a; }
    static TslArg other() { TslArg a; a.kind = Kind::Other; return a; }
    static TslArg objectOf(std::string cls, std::shared_ptr<void> value) {
        TslArg a; a.kind = Kind::Object; a.cls = std::move(cls); a.object = std::move(value); return a;
    }
    static TslArg rgbOf(double r, double g, double b) { TslArg a; a.kind = Kind::Rgb; a.numbers[0] = r; a.numbers[1] = g; a.numbers[2] = b; a.lanes = 3; return a; }
    static TslArg vectorOf(uint8_t lanes, const double* values) {
        TslArg a; a.kind = Kind::Vector; a.lanes = lanes;
        for (uint8_t i = 0; i < lanes && i < 4; ++i) a.numbers[i] = values[i];
        return a;
    }
};

/**
 * TSL's authoring functions and node methods by name over the native lazy graph: the one table the
 * V8 and the Wasm back ends share (PRD-540). `receiver` is the node a method is called on, or null
 * for a module function. The statement forms (If, Else, Loop, toVar, assign) are TslScopes below;
 * the calls that change a wrapper (setName, element, setResolutionScale, instancedArray) stay with
 * each back end, which owns its wrappers.
 *
 * Returns null when `name` is not in the table. A bad call throws std::runtime_error with the reason.
 * `serial` numbers the uniforms and render textures the table names.
 */
engine::shader::graph::Node tslCall(const std::string& name, const TslArg* receiver, const std::vector<TslArg>& args,
                                    uint64_t& serial);

/**
 * A live post effect's scalar uniform (`radius`, `samples`, ...) or its `resolutionScale`: read, or
 * written when `value` is given, which a pass reads again every frame. Throws for anything else.
 */
double tslEffectParameter(const engine::shader::graph::Node& node, const std::string& name, const double* value);

/** The inputs TSL exports as values, not functions (positionLocal, instanceIndex, materialColor...).
 * tslCall answers each as `constant:<name>`. */
std::vector<std::pair<std::string, engine::shader::graph::Node>> tslConstants();

/** three's `uniform.value = x` for every back end: the uniform node's live values, one per lane. */
void tslSetUniform(const engine::shader::graph::Node& uniform, const double* values, size_t count);

/**
 * TSL's statement forms (Fn, If, Else, Loop, toVar, assign) over a stack of open bodies, for a back
 * end whose language runs the callbacks (PRD-540). The back end opens a body, runs the game's
 * callback, and closes it; statements the callback makes land in the innermost open body.
 * By name, as tslCall takes them:
 *   scope:open ()                  a callback starts; no node
 *   scope:close ([result])         its Body, or `result` alone when it made no statement
 *   toVar (receiver)               declares a variable in the open body
 *   assign (receiver, value)       assigns a variable or storage element; returns the receiver
 *   If (condition, body)           appends an If; `body` is a closed Body
 *   Else (receiver If, body)       gives the last If of this body its else branch; returns the new If
 *   Loop:index ()                  the index node the loop callback gets as `{ i }`
 *   Loop (count, index, body)      appends an i32 loop from 0 over that index
 */
class TslScopes {
public:
    /** Returns false when `name` is not a statement form. A bad call throws std::runtime_error. */
    bool call(const std::string& name, const TslArg* receiver, const std::vector<TslArg>& args,
              engine::shader::graph::Node& out);
    /** Bodies still open: a back end closes every body it opens, even when the callback throws. */
    size_t depth() const { return open_.size(); }

private:
    struct Body {
        uint64_t id;
        std::vector<engine::shader::graph::Node> statements;
    };
    std::vector<Body>& open();
    std::vector<Body> open_;
    uint64_t nextBody_ = 0;
    // Where each If sits, so Else can find it still last in its own body.
    std::map<const engine::shader::graph::NodeData*, std::pair<uint64_t, size_t>> ifs_;
};

}  // namespace tn::abi
