// three's `MathUtils` namespace in the engine's one binding registry (PRD-531). The four functions
// the minimal template reaches are stateless, so the binding ignores the object it is called on and
// forwards to the ported scalar helpers, which carry three's exact rounding (MathUtils.h).

#include "engine/abi/bindings.h"

#include "engine/foundation/math/MathUtils.h"

#include <memory>

namespace tn::binding {

using namespace tn::engine;

namespace {

/** three's `MathUtils` is a namespace, not a value: this gives the bound class an identity. */
struct MathUtilsObject {};

}  // namespace

void registerMathUtilsBindings(Registry& classes) {
    ClassBinding& b = classes["MathUtils"];
    b.ctor = [](const Args&, Store&) {
        return std::static_pointer_cast<void>(std::make_shared<MathUtilsObject>());
    };
    b.methods["clamp"] = [](void*, const Args& a, Store&) {
        return Value::of(clamp(number(a.at(0)), number(a.at(1)), number(a.at(2))));
    };
    b.methods["lerp"] = [](void*, const Args& a, Store&) {
        return Value::of(lerp(number(a.at(0)), number(a.at(1)), number(a.at(2))));
    };
    b.methods["degToRad"] = [](void*, const Args& a, Store&) {
        return Value::of(degToRad(number(a.at(0))));
    };
    b.methods["euclideanModulo"] = [](void*, const Args& a, Store&) {
        return Value::of(euclideanModulo(number(a.at(0)), number(a.at(1))));
    };
}

}  // namespace tn::binding
