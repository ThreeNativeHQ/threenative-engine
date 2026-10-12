#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "engine/foundation/json.h"
#include "engine/scene/object3d.h"

namespace tn::engine::inspect {

/** One keyboard or pointer event the runner injected, as three/device.ts hands it to the host. */
struct InputEvent {
    std::string type; // keydown, keyup, pointerdown, pointermove, pointerup, wheel
    std::string key, code;
    double x = 0, y = 0;
    double buttons = 0;
    double deltaX = 0, deltaY = 0; // wheel
    int pointerId = 1;
    std::string pointerType = "mouse";
    bool isPrimary = true;
    /**
     * The simulation tick this input was queued for: input injected while tick N-1 has run is
     * consumed by tick N. The game's per-tick callback records it beside the tick it first saw the
     * input, so a playtest can prove both are the same tick (PRD-528 box 59).
     */
    uint64_t injectedTick = 0;
};

/** A bridge answer that is still a pending promise: the request is answered on a later frame. */
inline constexpr const char* kStillSettling = "TN_INSPECT_STILL_SETTLING";
/** handle()'s reply for such a request: empty, so a transport holds the request and asks again. */

/** What the endpoint drives: the scene it samples and the engine's own tick. */
struct Host {
    Object3D* scene = nullptr;
    std::function<uint64_t()> tick; // the simulation tick that last ran
    std::function<void()> step;     // runs one simulation tick; it takes the queued input first
    std::string name = "threenative-native-engine";
    /** The artifact's game runtime, reported in `describe.profile`: "cpp" for a built-in game, "v8"
     *  for a game bundle on the V8 adapter. Mirrored into `sample.resources.profile`. */
    std::string gameRuntime = "cpp";
    /** One JSON-safe registered resource by id, or null for an id this player does not carry. */
    std::function<json::Value(const std::string& id)> resource;
    /** A game runtime's installed observation bridge. False without an error uses native fallback;
     *  false with `kStillSettling` as the error means its answer is a promise not yet settled. */
    std::function<bool(const std::string&, const json::Value*, json::Value&, std::string&)> observe;
};

/**
 * The playtest device bridge on the native engine (PRD-529): one request frame
 * ({"id","method","argument"}) in, one response frame ({"id","result"} or {"error":{"message"},"id"})
 * out, as packages/playtest/src/three/device.ts answers them. The seven bridge methods (describe,
 * ready, sample, advance, applySetup, drainEvents, focus) and the input methods (input.keyDown,
 * input.keyUp, input.pointer, input.pointers) each answer with a result or an error whose message
 * starts with a named code: TN_INSPECT_MALFORMED, TN_INSPECT_PAYLOAD_TOO_LARGE,
 * TN_INSPECT_UNKNOWN_METHOD, TN_INSPECT_INVALID_ARGUMENT, or TN_INSPECT_UNSUPPORTED for a protocol
 * field this player does not carry yet. Input is queued, not applied: the host's step takes it at
 * the start of the next tick, so input injected before tick N is seen by tick N's game code.
 */
class Endpoint {
  public:
    explicit Endpoint(Host host) : host_(std::move(host)) {}
    /** The world named lookups search, for a game that publishes or swaps its scene at run time. */
    void setScene(Object3D* scene) { host_.scene = scene; }

    /** One request frame to one response frame. Never throws. */
    std::string handle(std::string_view frame);
    /** The input queued since the last call, in injection order; the host applies it per tick. */
    std::vector<InputEvent> takeInput() { return std::exchange(input_, {}); }

    /** The simulation tick that last ran, as the host reports it, so a game callback can stamp
     *  what it first saw. */
    [[nodiscard]] uint64_t tick() const { return host_.tick ? host_.tick() : 0; }

    static constexpr std::size_t kMaxPayloadBytes = 1'000'000;

  private:
    struct Pointer {
        int id;
        double x, y, buttons;
    };
    bool dispatch(const std::string& method, const json::Value* argument, json::Value& result, std::string& error);
    bool input(const std::string& method, const json::Value* argument, std::string& error);
    json::Value describe() const;
    bool sample(const json::Value* argument, json::Value& result, std::string& error) const;
    bool advance(const json::Value* argument, json::Value& result, std::string& error);
    bool applySetup(const json::Value* argument, json::Value& result, std::string& error);
    json::Value clock() const;

    Host host_;
    std::vector<InputEvent> input_;
    std::vector<Pointer> pointers_; // the touch set input.pointers last reported, in its order
};

} // namespace tn::engine::inspect
