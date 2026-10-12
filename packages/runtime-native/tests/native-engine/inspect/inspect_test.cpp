// PRD-529 phase 1: the playtest device protocol on the native engine.
// `protocol`: every message type in packages/playtest/src/three/device.ts (the generated kMethods)
// decodes and answers either a result of the shape device.ts and protocol.ts define or an error whose
// message starts with a named TN_INSPECT_* code, for valid and invalid arguments alike; so do
// malformed and oversized frames. No listed method is ever "unknown".
// `input_tick`: input injected before tick N is what tick N's game code reads, not tick N+1's.
#include "check.h"
#include "engine/inspect/endpoint.h"
#include "engine/world/loop/fixed_step.h"

#include <cstdint>
#include <cstdio>
#include <iterator>
#include <memory>
#include <set>
#include <string>
#include <vector>

#include "protocol_methods.inc"

using namespace tn::engine;
using namespace tn::engine::inspect;

namespace {

struct Game {
    std::shared_ptr<Object3D> scene = std::make_shared<Object3D>();
    std::shared_ptr<Object3D> player = std::make_shared<Object3D>();
    world::FixedStepClock clock{1.0 / 60, 5};
    std::set<std::string> held;          // keys down, as game code reads them
    std::vector<std::string> seenAtTick; // "tick:key" for each key first seen down
    std::vector<uint64_t> injectedTicks; // the tick each injected keydown was for
    std::unique_ptr<Endpoint> endpoint;
    double now = 0;
    Game() {
        player->name = "player";
        player->position.set(1, 2, 3);
        scene->add(*player);
        clock.start(0);
        Host host;
        host.scene = scene.get();
        host.tick = [this] { return clock.tick(); };
        host.step = [this] {
            now += 1000.0 / 60;
            clock.advance(now);
            // The loop applies queued input at the start of the tick, before game code runs.
            for (const InputEvent& e : endpoint->takeInput()) {
                if (e.type == "keydown") {
                    held.insert(e.key);
                    injectedTicks.push_back(e.injectedTick);
                }
                if (e.type == "keyup")
                    held.erase(e.key);
            }
            for (const std::string& key : held)
                seenAtTick.push_back(std::to_string(clock.tick()) + ":" + key);
        };
        endpoint = std::make_unique<Endpoint>(host);
    }
};

json::Value reply(Endpoint& endpoint, const std::string& frame) {
    json::Value out;
    json::Error error;
    CHECK(json::parse(endpoint.handle(frame), out, error));
    return out;
}

std::string request(const std::string& id, const std::string& method, const std::string& argument) {
    return "{\"id\":\"" + id + "\",\"method\":\"" + method + "\"" +
           (argument.empty() ? "" : ",\"argument\":" + argument) + "}";
}

void protocol() {
    Game game;
    // Valid and invalid arguments for every method device.ts dispatches.
    struct Case {
        std::string method, argument;
        bool ok;
    };
    const std::vector<Case> cases = {
        {"describe", "", true},
        {"ready", "", true},
        {"focus", "", true},
        {"drainEvents", "100", true},
        {"drainEvents", "\"x\"", false},
        {"sample", "{\"entities\":[\"player\",\"ghost\"],\"label\":\"s\"}", true},
        {"sample", "{}", true},
        {"sample", "{\"geometry\":{}}", false},
        {"sample", "[1]", false},
        {"advance", "3", true},
        {"advance", "0", false},
        {"advance", "1.5", false},
        {"advance", "\"3\"", false},
        {"applySetup", "{\"entities\":[{\"entity\":\"player\",\"transform\":{\"position\":[0,1,0]}}]}", true},
        {"applySetup", "{\"entities\":[{\"entity\":\"nobody\",\"transform\":{}}]}", false},
        {"applySetup", "{\"resources\":[]}", false},
        {"applySetup", "{\"entities\":[{\"entity\":\"player\",\"transform\":{\"position\":[0,1]}}]}", false},
        {"input.keyDown", "{\"key\":\"KeyW\"}", true},
        {"input.keyDown", "{}", false},
        {"input.keyUp", "{\"key\":\"KeyW\"}", true},
        {"input.keyUp", "3", false},
        {"input.pointer", "{\"x\":10,\"y\":20,\"buttons\":1,\"type\":\"down\"}", true},
        {"input.pointer", "{\"x\":10}", false},
        {"input.pointers", "{\"pointers\":[{\"id\":1,\"x\":5,\"y\":6},{\"id\":2,\"x\":7,\"y\":8,\"buttons\":1}]}",
         true},
        {"input.pointers", "{\"pointers\":[{\"id\":1,\"x\":5,\"y\":6},{\"id\":1,\"x\":7,\"y\":8}]}", false},
        {"input.pointers", "{\"pointers\":[{\"id\":0,\"x\":5,\"y\":6}]}", false},
        {"input.wheel", "{\"x\":10,\"y\":20,\"deltaX\":0,\"deltaY\":120}", true},
        {"input.wheel", "{\"x\":10,\"y\":20,\"deltaY\":120}", false},
        {"input.media", "{\"dark\":1,\"reducedMotion\":0}", false},
        {"input.media", "{\"dark\":2,\"reducedMotion\":0}", false},
    };
    // A message type the native-engine player refuses by design, by name: media emulation needs a
    // native-css UI it does not have (device.ts refuses the same way for a host with no UI).
    const std::set<std::string> refusedByDesign{"input.media"};
    std::set<std::string> covered;
    std::size_t bad = 0, n = 0;
    for (const Case& c : cases) {
        const std::string id = "r" + std::to_string(n++);
        const json::Value r = reply(*game.endpoint, request(id, c.method, c.argument));
        const json::Value* echoed = r.find("id");
        const json::Value* error = r.find("error");
        const bool answered = r.find("result") != nullptr;
        const std::string message = error && error->find("message") ? error->find("message")->string() : "";
        const bool named = message.rfind("TN_INSPECT_", 0) == 0 && message.find("TN_INSPECT_UNKNOWN_METHOD") != 0;
        if (!echoed || echoed->string() != id || (c.ok ? !answered || error : !named)) {
            ++bad;
            std::fprintf(stderr, "%s %s -> %s\n", c.method.c_str(), c.argument.c_str(), json::stringify(r).c_str());
        }
        if (c.ok)
            covered.insert(c.method);
    }
    // Every message type device.ts knows was answered with a result at least once.
    for (const char* method : kMethods) {
        if (!covered.count(method) && !refusedByDesign.count(method)) {
            ++bad;
            std::fprintf(stderr, "no answered case for %s\n", method);
        }
    }
    // Shapes the runner reads.
    const json::Value d = reply(*game.endpoint, request("d", "describe", "")).find("result")[0];
    CHECK(d.find("protocolVersion")->number() == 1 && d.find("capabilities")->isArray() &&
          d.find("limits")->find("maxPayloadBytes")->number() == 1000000);
    const json::Value s =
        reply(*game.endpoint, request("s", "sample", "{\"entities\":[\"player\"]}")).find("result")[0];
    CHECK(s.find("clock")->find("mode")->string() == "fixed-step" && s.find("clock")->find("tick")->number() == 3);
    CHECK(s.find("entities")->items().size() == 1 &&
          json::stringify(*s.find("entities")->items()[0].find("transform")->find("position")) == "[0,1,0]");
    // Frames the transport itself must refuse by name.
    const auto refused = [&](const std::string& frame, const char* code) {
        const json::Value r = reply(*game.endpoint, frame);
        const json::Value* e = r.find("error");
        const bool ok = e && e->find("message")->string().rfind(code, 0) == 0;
        if (!ok)
            std::fprintf(stderr, "frame %.60s -> %s\n", frame.c_str(), json::stringify(r).c_str());
        return ok;
    };
    CHECK(refused("not json", "TN_INSPECT_MALFORMED"));
    CHECK(refused("{\"id\":\"x\"}", "TN_INSPECT_MALFORMED"));
    CHECK(refused("{\"id\":1,\"method\":\"ready\"}", "TN_INSPECT_MALFORMED"));
    CHECK(refused(request("u", "teleport", ""), "TN_INSPECT_UNKNOWN_METHOD"));
    CHECK(refused(request("u", "input.shake", "{}"), "TN_INSPECT_UNKNOWN_METHOD"));
    CHECK(refused(std::string(1'000'001, ' '), "TN_INSPECT_PAYLOAD_TOO_LARGE"));
    std::printf("inspect protocol: %zu message types, %zu cases, %zu wrong\n", std::size(kMethods), cases.size(), bad);
    CHECK(bad == 0);
}

void inputTick() {
    Game game;
    const auto send = [&](const std::string& method, const std::string& argument) {
        const json::Value r = reply(*game.endpoint, request("i", method, argument));
        CHECK(r.find("error") == nullptr);
    };
    send("advance", "3");
    send("input.keyDown", "{\"key\":\"KeyW\"}"); // injected before tick 4
    send("advance", "1");
    send("input.keyUp", "{\"key\":\"KeyW\"}");
    send("advance", "2");
    std::printf("input tick: seen %s for %s\n", game.seenAtTick.empty() ? "nothing" : game.seenAtTick.front().c_str(),
                game.injectedTicks.empty() ? "nothing" : std::to_string(game.injectedTicks.front()).c_str());
    CHECK(game.seenAtTick == std::vector<std::string>{"4:w"}); // tick 4 only, as "w" (KeyW -> w)
    CHECK(game.injectedTicks == std::vector<uint64_t>{4});     // and it was injected for tick 4
}

} // namespace

TN_TEST_MAIN({"protocol", protocol}, {"input_tick", inputTick})
