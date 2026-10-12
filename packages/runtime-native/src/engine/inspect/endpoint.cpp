#include "engine/inspect/endpoint.h"

#include <cmath>
#include <regex>

namespace tn::engine::inspect {

namespace {

using json::Value;

Value obj(std::vector<std::pair<std::string, Value>> members) { return Value::makeObject(std::move(members)); }
Value num(double x) { return Value::makeNumber(x); }
Value str(std::string s) { return Value::makeString(std::move(s)); }

bool fail(std::string& error, std::string message) {
    error = std::move(message);
    return false;
}

bool isInteger(const Value* v) {
    return v && v->isNumber() && std::isfinite(v->number()) && v->number() == std::floor(v->number());
}

// Every node under `root` whose name is `name`, first in depth order (Object3D.getObjectByName).
Object3D* named(Object3D* root, const std::string& name) { return root ? root->getObjectByName(name) : nullptr; }

std::string response(const std::string& id, const Value* result, const std::string* error) {
    // device.ts builds { id, result } or { error: { message }, id }; JSON.stringify keeps that order.
    if (error)
        return json::stringify(obj({{"error", obj({{"message", str(*error)}})}, {"id", str(id)}}));
    if (!result)
        return json::stringify(obj({{"id", str(id)}}));
    return json::stringify(obj({{"id", str(id)}, {"result", *result}}));
}

} // namespace

std::string Endpoint::handle(std::string_view frame) {
    if (frame.size() > kMaxPayloadBytes) {
        const std::string e = "TN_INSPECT_PAYLOAD_TOO_LARGE: the request is " + std::to_string(frame.size()) +
                              " bytes; the limit is " + std::to_string(kMaxPayloadBytes) + ".";
        return response("", nullptr, &e);
    }
    Value request;
    json::Error parseError;
    const Value* id = nullptr;
    const Value* method = nullptr;
    if (json::parse(frame, request, parseError) && request.isObject()) {
        id = request.find("id");
        method = request.find("method");
    }
    if (!id || !id->isString() || !method || !method->isString()) {
        const std::string e = "TN_INSPECT_MALFORMED: Device request must contain string id and method fields.";
        return response(id && id->isString() ? id->string() : "", nullptr, &e);
    }
    Value result;
    std::string error;
    const bool hasResult = dispatch(method->string(), request.find("argument"), result, error);
    if (error == kStillSettling) return {};
    if (!error.empty())
        return response(id->string(), nullptr, &error);
    if (hasResult && json::stringify(result).size() > kMaxPayloadBytes) {
        const std::string e = "TN_INSPECT_PAYLOAD_TOO_LARGE: the reply to " + method->string() + " is over " +
                              std::to_string(kMaxPayloadBytes) + " bytes.";
        return response(id->string(), nullptr, &e);
    }
    return response(id->string(), hasResult ? &result : nullptr, nullptr);
}

// True when the method answers a result; false with `error` set when it refused, false with no error
// when it answered nothing (device.ts then sends { id } alone).
bool Endpoint::dispatch(const std::string& method, const Value* argument, Value& result, std::string& error) {
    if (host_.observe && (method == "describe" || method == "ready" || method == "sample" ||
                          method == "applySetup" || method == "drainEvents")) {
        if (host_.observe(method, argument, result, error)) {
            if (method == "describe" && result.isObject()) {
                auto members = result.members();
                std::erase_if(members, [](const auto& member) { return member.first == "profile"; });
                members.emplace_back("profile", obj({{"engine", str("native")},
                                                      {"gameRuntime", str(host_.gameRuntime)}}));
                result = obj(std::move(members));
            }
            return true;
        }
        if (!error.empty()) return false;
    }
    if (method.rfind("input.", 0) == 0) {
        if (!input(method, argument, error))
            return false;
        result = Value::makeNull();
        return true;
    }
    if (method == "describe")
        return result = describe(), true;
    if (method == "ready")
        return result = obj({{"ready", Value::makeBool(true)}}), true;
    if (method == "focus")
        return result = Value::makeBool(true), true;
    if (method == "drainEvents") {
        if (argument && !argument->isNull() && !isInteger(argument))
            return fail(error, "TN_INSPECT_INVALID_ARGUMENT: drainEvents takes an integer limit.");
        return result = Value::makeArray({}), true; // nothing in the native engine posts playtest events yet
    }
    if (method == "sample")
        return sample(argument, result, error);
    if (method == "advance")
        return advance(argument, result, error);
    if (method == "applySetup")
        return applySetup(argument, result, error);
    return fail(error, "TN_INSPECT_UNKNOWN_METHOD: Bridge operation '" + method + "' is unavailable.");
}

Value Endpoint::describe() const {
    // Only names in packages/playtest/src/capabilities.ts: an unregistered name fails the run with
    // TN_PLAYTEST_BRIDGE_CAPABILITY_UNKNOWN. runtime.fixedStep is mandatory on a device bridge.
    return obj({{"capabilities", Value::makeArray({str("runtime.fixedStep"), str("entity.observe"),
                                                   str("entity.setup"), str("runtime.resources")})},
                {"limits", obj({{"maxEntitiesPerSample", num(100)},
                                {"maxEventsPerDrain", num(1000)},
                                {"maxPayloadBytes", num(double(kMaxPayloadBytes))},
                                {"operationTimeoutMs", num(5000)}})},
                {"name", str(host_.name)},
                // PRD-529 solution 3: which artifact is running. Engine `native` (the C++ engine,
                // never the legacy host) and the game runtime: `cpp` for a built-in game, `v8` for a
                // game bundle on the adapter. Mirrored into sample.resources["profile"] so the
                // existing scenario schema can assert it.
                {"profile", obj({{"engine", str("native")}, {"gameRuntime", str(host_.gameRuntime)}})},
                {"protocolVersion", num(1)}});
}

Value Endpoint::clock() const {
    return obj({{"mode", str("fixed-step")}, {"tick", num(host_.tick ? double(host_.tick()) : 0.0)}});
}

bool Endpoint::sample(const Value* argument, Value& result, std::string& error) const {
    if (argument && !argument->isNull() && !argument->isObject())
        return fail(error, "TN_INSPECT_INVALID_ARGUMENT: sample takes a request object.");
    std::vector<Value> entities;
    std::vector<std::pair<std::string, Value>> resources;
    bool askedResources = false;
    if (argument && argument->isObject()) {
        for (const auto& [field, value] : argument->members()) {
            // The step label labels a sample series the runner keeps; it changes no observation.
            // `include` names observation families, and this endpoint always sends what it has.
            if (field == "label" || field == "include")
                continue;
            if (field == "resources") {
                if (!value.isArray())
                    return fail(error, "TN_INSPECT_INVALID_ARGUMENT: sample.resources must be an array.");
                askedResources = true;
                for (const Value& id : value.items()) {
                    if (!id.isString())
                        return fail(error, "TN_INSPECT_INVALID_ARGUMENT: sample.resources holds resource ids.");
                    // An id this player does not carry is absent, as on the web bridge.
                    if (!host_.resource)
                        continue;
                    const Value carried = host_.resource(id.string());
                    if (!carried.isNull())
                        resources.emplace_back(id.string(), carried);
                }
                continue;
            }
            if (field != "entities")
                return fail(error, "TN_INSPECT_UNSUPPORTED: sample." + field +
                                       " is not carried by the native-engine player yet.");
            if (!value.isArray())
                return fail(error, "TN_INSPECT_INVALID_ARGUMENT: sample.entities must be an array.");
            if (value.items().size() > 100)
                return fail(error, "TN_INSPECT_INVALID_ARGUMENT: sample.entities is over maxEntitiesPerSample (100).");
            for (const Value& id : value.items()) {
                if (!id.isString())
                    return fail(error, "TN_INSPECT_INVALID_ARGUMENT: sample.entities holds entity ids.");
                const Object3D* o = named(host_.scene, id.string());
                if (!o)
                    continue; // an entity this scene does not hold is absent, as on the web bridge
                const auto triple = [](double a, double b, double c) {
                    return Value::makeArray({num(a), num(b), num(c)});
                };
                entities.push_back(obj(
                    {{"id", str(id.string())},
                     {"transform", obj({{"position", triple(o->position.x, o->position.y, o->position.z)},
                                        {"rotation", Value::makeArray({num(o->quaternion.x), num(o->quaternion.y),
                                                                       num(o->quaternion.z), num(o->quaternion.w)})},
                                        {"scale", triple(o->scale.x, o->scale.y, o->scale.z)}})},
                     {"visible", Value::makeBool(o->visible())}}));
            }
        }
    }
    std::vector<std::pair<std::string, Value>> snapshot{{"clock", clock()}};
    if (argument && argument->find("entities"))
        snapshot.emplace_back("entities", Value::makeArray(std::move(entities)));
    if (askedResources)
        snapshot.emplace_back("resources", obj(std::move(resources)));
    result = obj(std::move(snapshot));
    return true;
}

bool Endpoint::advance(const Value* argument, Value& result, std::string& error) {
    if (!isInteger(argument) || argument->number() < 1 || argument->number() > 100000)
        return fail(error, "TN_INSPECT_INVALID_ARGUMENT: advance takes a whole number of ticks from 1 to 100000.");
    if (!host_.step)
        return fail(error, "TN_INSPECT_UNSUPPORTED: this player cannot step ticks.");
    const auto ticks = static_cast<uint64_t>(argument->number());
    for (uint64_t i = 0; i < ticks; ++i)
        host_.step();
    result = obj({{"clock", clock()}, {"ticks", num(double(ticks))}});
    return true;
}

bool Endpoint::applySetup(const Value* argument, Value& result, std::string& error) {
    if (!argument || !argument->isObject())
        return fail(error, "TN_INSPECT_INVALID_ARGUMENT: applySetup takes a setup object.");
    if (argument->find("resources"))
        return fail(error, "TN_INSPECT_UNSUPPORTED: applySetup.resources is not carried yet.");
    std::vector<Value> placed;
    if (const Value* entities = argument->find("entities")) {
        if (!entities->isArray())
            return fail(error, "TN_INSPECT_INVALID_ARGUMENT: applySetup.entities must be an array.");
        // Validate everything before moving anything, so a refused setup changes nothing.
        struct Placement {
            Object3D* object;
            const Value* transform;
        };
        std::vector<Placement> plan;
        for (const Value& e : entities->items()) {
            const Value* id = e.isObject() ? e.find("entity") : nullptr;
            const Value* transform = e.isObject() ? e.find("transform") : nullptr;
            if (!id || !id->isString() || !transform || !transform->isObject())
                return fail(error,
                            "TN_INSPECT_INVALID_ARGUMENT: each setup entity needs an entity id and a transform.");
            if (const Value* frozen = e.find("frozen"); frozen && !(frozen->isBool() && !frozen->boolean()))
                return fail(
                    error,
                    "TN_INSPECT_UNSUPPORTED: applySetup frozen entities need the game's marker, not carried yet.");
            Object3D* object = named(host_.scene, id->string());
            if (!object)
                return fail(error, "TN_INSPECT_INVALID_ARGUMENT: no entity named '" + id->string() + "'.");
            for (const auto& [field, value] : transform->members()) {
                const std::size_t want = field == "rotation" ? 4 : 3;
                if ((field != "position" && field != "rotation" && field != "scale") || !value.isArray() ||
                    value.items().size() != want)
                    return fail(error, "TN_INSPECT_INVALID_ARGUMENT: transform." + field +
                                           " is not a position, rotation or scale.");
                for (const Value& x : value.items())
                    if (!x.isNumber() || !std::isfinite(x.number()))
                        return fail(error,
                                    "TN_INSPECT_INVALID_ARGUMENT: transform." + field + " holds finite numbers.");
            }
            plan.push_back({object, transform});
            placed.push_back(str(id->string()));
        }
        for (const Placement& p : plan) {
            const auto at = [&](const char* field, std::size_t i) {
                return p.transform->find(field)->items()[i].number();
            };
            if (p.transform->find("position"))
                p.object->position.set(at("position", 0), at("position", 1), at("position", 2));
            if (p.transform->find("rotation"))
                p.object->quaternion.set(at("rotation", 0), at("rotation", 1), at("rotation", 2), at("rotation", 3));
            if (p.transform->find("scale"))
                p.object->scale.set(at("scale", 0), at("scale", 1), at("scale", 2));
        }
    }
    result = obj({{"entities", Value::makeArray(std::move(placed))}});
    return true;
}

// three/device.ts dispatchInput, message for message, queuing what it would hand the host.
bool Endpoint::input(const std::string& method, const Value* argument, std::string& error) {
    const auto invalid = [&](const std::string& message) {
        return fail(error, "TN_INSPECT_INVALID_ARGUMENT: " + message);
    };
    if (!argument || !argument->isObject())
        return invalid("Device " + method + " requires an object argument.");
    // Input queued while tick N-1 has run is consumed by tick N, which is the tick it is for.
    const uint64_t forTick = tick() + 1;
    if (method == "input.keyDown" || method == "input.keyUp") {
        const Value* key = argument->find("key");
        if (!key || !key->isString())
            return invalid("Device " + method + " requires a key.");
        const std::string& code = key->string();
        static const std::regex letter("^Key[A-Z]$");
        std::string named = code;
        if (std::regex_match(code, letter))
            named = std::string(1, char(code[3] - 'A' + 'a'));
        InputEvent e{method == "input.keyDown" ? "keydown" : "keyup", named, code};
        e.injectedTick = forTick;
        input_.push_back(e);
        return true;
    }
    if (method == "input.pointer") {
        const Value *x = argument->find("x"), *y = argument->find("y"), *buttons = argument->find("buttons");
        if (!x || !x->isNumber() || !y || !y->isNumber() || !buttons || !buttons->isNumber())
            return invalid("Device input.pointer requires numeric x, y, and buttons.");
        const Value* type = argument->find("type");
        const std::string t = type && type->isString() ? type->string() : "";
        InputEvent e{t == "down" ? "pointerdown" : t == "up" ? "pointerup" : "pointermove"};
        e.x = x->number();
        e.y = y->number();
        e.buttons = buttons->number();
        e.injectedTick = forTick;
        input_.push_back(e);
        return true;
    }
    if (method == "input.wheel") {
        const Value *x = argument->find("x"), *y = argument->find("y"), *dx = argument->find("deltaX"),
                    *dy = argument->find("deltaY");
        for (const Value* v : {x, y, dx, dy})
            if (!v || !v->isNumber() || !std::isfinite(v->number()))
                return invalid("Device input.wheel requires finite x, y, deltaX and deltaY.");
        InputEvent e{"wheel"};
        e.x = x->number();
        e.y = y->number();
        e.deltaX = dx->number();
        e.deltaY = dy->number();
        e.injectedTick = forTick;
        input_.push_back(e);
        return true;
    }
    if (method == "input.media") {
        // Media emulation reaches a native-css UI; the native-engine player has none, so it refuses
        // by name, as device.ts does for a host with no UI attached.
        const Value *dark = argument->find("dark"), *reduced = argument->find("reducedMotion");
        for (const Value* v : {dark, reduced})
            if (!v || !v->isNumber() || (v->number() != -1 && v->number() != 0 && v->number() != 1))
                return invalid("Device input.media requires dark and reducedMotion as -1, 0 or 1.");
        return fail(error, "TN_INSPECT_UNSUPPORTED: Native playtest media emulation is unavailable: the host has no "
                           "native-css UI attached to take it.");
    }
    if (method == "input.pointers") {
        const Value* list = argument->find("pointers");
        if (!list || !list->isArray())
            return invalid("Device input.pointers requires a pointer array.");
        std::vector<Pointer> next;
        for (std::size_t i = 0; i < list->items().size(); ++i) {
            const Value& p = list->items()[i];
            const std::string at = "Device input.pointers[" + std::to_string(i) + "]";
            if (!p.isObject())
                return invalid(at + " must be an object.");
            const Value *id = p.find("id"), *x = p.find("x"), *y = p.find("y"), *buttons = p.find("buttons");
            if (!isInteger(id) || id->number() < 1 || !x || !x->isNumber() || !std::isfinite(x->number()) || !y ||
                !y->isNumber() || !std::isfinite(y->number()) ||
                (buttons && (!isInteger(buttons) || buttons->number() < 1)))
                return invalid(at + " contains invalid pointer coordinates or buttons.");
            next.push_back({int(id->number()), x->number(), y->number(), buttons ? buttons->number() : 1});
        }
        for (std::size_t i = 0; i < next.size(); ++i)
            for (std::size_t j = 0; j < i; ++j)
                if (next[i].id == next[j].id)
                    return invalid("Device input.pointers requires unique pointer ids.");
        const int previousPrimary = pointers_.empty() ? -1 : pointers_.front().id;
        const int nextPrimary = next.empty() ? -1 : next.front().id;
        const auto find = [](const std::vector<Pointer>& set, int id) -> const Pointer* {
            for (const Pointer& p : set)
                if (p.id == id)
                    return &p;
            return nullptr;
        };
        const auto touch = [&](const char* type, const Pointer& p, double buttons, bool primary) {
            InputEvent e{type};
            e.x = p.x;
            e.y = p.y;
            e.buttons = buttons;
            e.pointerId = p.id;
            e.pointerType = "touch";
            e.isPrimary = primary;
            e.injectedTick = forTick;
            input_.push_back(e);
        };
        for (const Pointer& p : pointers_)
            if (!find(next, p.id))
                touch("pointerup", p, 0, p.id == previousPrimary);
        for (const Pointer& p : next) {
            const Pointer* previous = find(pointers_, p.id);
            if (!previous)
                touch("pointerdown", p, p.buttons, p.id == nextPrimary);
            else if (previous->x != p.x || previous->y != p.y || previous->buttons != p.buttons)
                touch("pointermove", p, p.buttons, p.id == nextPrimary);
        }
        pointers_ = std::move(next);
        return true;
    }
    return fail(error, "TN_INSPECT_UNKNOWN_METHOD: Device input operation '" + method + "' is unavailable.");
}

} // namespace tn::engine::inspect
