// PRD-529 phase 1: the playtest device protocol on the native engine.
// `protocol`: every message type in packages/playtest/src/three/device.ts (the generated kMethods)
// decodes and answers either a result of the shape device.ts and protocol.ts define or an error whose
// message starts with a named TN_INSPECT_* code, for valid and invalid arguments alike; so do
// malformed and oversized frames. No listed method is ever "unknown".
// `input_tick`: input injected before tick N is what tick N's game code reads, not tick N+1's.
#include "check.h"
#include "engine/inspect/endpoint.h"
#include "engine/scene/material.h"
#ifndef _WIN32
#include <unistd.h>
#endif
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
        // A game runtime installs the observation bridge; renderOnly reaches it here (PRD-617),
        // while the native fallback answers the rest.
        host.observe = [](const std::string& method, const json::Value*, json::Value& result, std::string&) {
            if (method != "renderOnly") return false;
            result = json::Value::makeNumber(1);
            return true;
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

void automaticRenderHold() {
#ifndef _WIN32
    auto& stats = Material::diagnostics();
    const auto savedStats = stats;
    stats = {};
    std::fflush(stdout);
    FILE* captured = std::tmpfile();
    CHECK(captured != nullptr);
    if (!captured) { stats = savedStats; return; }
    const int savedStdout = dup(fileno(stdout));
    CHECK(savedStdout >= 0);
    if (savedStdout < 0) { std::fclose(captured); stats = savedStats; return; }
    const int redirected = dup2(fileno(captured), fileno(stdout));
    CHECK(redirected >= 0);
    if (redirected < 0) { close(savedStdout); std::fclose(captured); stats = savedStats; return; }
#endif
    Host host;
    Endpoint unsupported(host);
    CHECK(reply(unsupported, request("h", "_holdAutomaticRender", "true")).find("error") != nullptr);
    CHECK(!unsupported.automaticRenderHeld());
    uint64_t updates = 0;
    host.tick = [&] { return updates + 9007199254740993ULL; };
    host.step = [&] { ++updates;
#ifndef _WIN32
        if (stats.enabled) ++stats.writes;
#endif
    };
    host.renderEachTick = true;
    Endpoint endpoint(host);
    CHECK(!endpoint.automaticRenderHeld());
    for (const std::string argument : {"", "null", "1", "\"true\"", "{}"}) {
        const auto answer = reply(endpoint, request("h", "_holdAutomaticRender", argument));
        CHECK(answer.find("error")->find("message")->string().rfind("TN_INSPECT_INVALID_ARGUMENT", 0) == 0);
        CHECK(!endpoint.automaticRenderHeld());
    }
    CHECK(reply(endpoint, request("h", "_holdAutomaticRender", "true")).find("error") == nullptr);
    CHECK(endpoint.automaticRenderHeld());
#ifndef _WIN32
    stats.enabled = true;
    CHECK(reply(endpoint, request("h", "_holdAutomaticRender", "true")).find("error") == nullptr);
#endif
    CHECK(reply(endpoint, request("s", "sample", "{}")).find("error") == nullptr);
    CHECK(updates == 0);
    CHECK(reply(endpoint, request("a", "advance", "1000")).find("error") == nullptr);
    CHECK(updates == 1000);
    CHECK(endpoint.automaticRenderHeld());
    CHECK(reply(endpoint, request("s", "sample", "{}")).find("error") == nullptr);
    CHECK(updates == 1000);
    CHECK(reply(endpoint, request("h", "_holdAutomaticRender", "false")).find("error") == nullptr);
    CHECK(!endpoint.automaticRenderHeld());
#ifndef _WIN32
    std::fflush(stdout);
    CHECK(dup2(savedStdout, fileno(stdout)) >= 0); close(savedStdout);
    std::rewind(captured);
    std::vector<json::Value> markers;
    char line[4096]; std::string raw;
    while (std::fgets(line, sizeof(line), captured)) {
        const std::string text(line), prefix = "TN_PLAYER_RENDER_HOLD:"; raw += text;
        if (text.rfind(prefix, 0) != 0) continue;
        json::Value value; json::Error error;
        CHECK(json::parse(text.substr(prefix.size()), value, error)); markers.push_back(std::move(value));
    }
    std::fclose(captured);
    CHECK(raw.find("TN_PLAYER_RENDER_HOLD:{\"held\":true,\"tick\":9007199254740993}\n") != std::string::npos);
    CHECK(markers.size() == 3);
    if (markers.size() == 3) {
        CHECK(markers[0].find("materialDiagnostic") == nullptr);
        const auto* beforeTick = markers[1].find("tick"); const auto* afterTick = markers[2].find("tick");
        const auto* before = markers[1].find("materialDiagnostic"); const auto* after = markers[2].find("materialDiagnostic");
        CHECK(beforeTick && afterTick && before && after);
        if (beforeTick && afterTick && before && after) {
            const auto* beforeWrites = before->find("writes"); const auto* afterWrites = after->find("writes");
            CHECK(beforeWrites && afterWrites);
            CHECK(beforeTick->number() - afterTick->number() == -1000);
            if (beforeWrites && afterWrites) CHECK(afterWrites->number() - beforeWrites->number() == 1000);
        }
    }
    stats = savedStats;
#endif
}

void liveClockProtocol() {
    Host host;
    Endpoint unsupported(host);
    CHECK(reply(unsupported, request("u", "_setClockMode", "\"wall-clock\"")).find("error"));
    bool live = false;
    int transitions = 0;
    host.renderEachTick = true;
    host.setLiveClock = [&](bool enabled) { live = enabled; ++transitions; };
    host.observe = [](const std::string& method, const json::Value*, json::Value& result, std::string&) {
        if (method != "sample") return false;
        result = json::Value::makeObject({{"clock", json::Value::makeObject({{"mode", json::Value::makeString("fixed-step")}})}});
        return true;
    };
    Endpoint endpoint(host);
    const auto record = [&](double time) { endpoint.recordPresentation(time, endpoint.presentationEpoch(), true); };
    CHECK(reply(endpoint, request("bad", "_setClockMode", "true")).find("error"));
    CHECK(!live && transitions == 0);
    reply(endpoint, request("hold", "_holdAutomaticRender", "true"));
    CHECK(!reply(endpoint, request("held", "_setClockMode", "\"wall-clock\"")).find("error"));
    reply(endpoint, request("release", "_holdAutomaticRender", "false"));
    CHECK(!reply(endpoint, request("live", "_setClockMode", "\"wall-clock\"")).find("error"));
    CHECK(live && transitions == 1);
    reply(endpoint, request("same", "_setClockMode", "\"wall-clock\""));
    CHECK(transitions == 1);
    CHECK(reply(endpoint, request("advance", "advance", "1")).find("error"));
    CHECK(!reply(endpoint, request("holdlive", "_holdAutomaticRender", "true")).find("error"));
    record(90);
    CHECK(reply(endpoint, request("excluded", "_presentationCompletions", "")).find("result")->find("samples")->items().empty());
    reply(endpoint, request("resume", "_holdAutomaticRender", "false"));
    CHECK(reply(endpoint, request("sample", "sample", "{}")).find("result")->find("clock")->find("mode")->string() == "wall-clock");
    endpoint.recordPresentation(99, endpoint.presentationEpoch(), false);
    auto failed = reply(endpoint, request("failedpresent", "_presentationCompletions", ""));
    CHECK(failed.find("result")->find("samples")->items().empty());
    CHECK(failed.find("result")->find("sequence")->number() == 0);
    record(100);
    record(125); // full-loop delay belongs in completion intervals
    auto cadence = reply(endpoint, request("cadence", "_presentationCompletions", ""));
    const auto& samples = cadence.find("result")->find("samples")->items();
    CHECK(samples.size() == 2);
    CHECK(samples.back().find("completedAtMs")->number() - samples.front().find("completedAtMs")->number() == 25);
    CHECK(samples.back().find("sequence")->number() == 2);
    const double epoch = cadence.find("result")->find("epoch")->number();
    auto negotiated = reply(endpoint, request("pollmode", "_setClockMode", "\"wall-clock\""));
    CHECK(negotiated.find("result")->find("epoch") && negotiated.find("result")->find("epoch")->number() == epoch);
    auto unchanged = reply(endpoint, request("unchanged", "_presentationCompletions", ""));
    CHECK(transitions == 1 && unchanged.find("result")->find("epoch")->number() == epoch);
    CHECK(unchanged.find("result")->find("samples")->items().size() == 2);
    CHECK(unchanged.find("result")->find("sequence")->number() == 2);
    const auto queuedEpoch = endpoint.presentationEpoch();
    reply(endpoint, request("pause", "_holdAutomaticRender", "true"));
    record(500);
    reply(endpoint, request("unpause", "_holdAutomaticRender", "false"));
    endpoint.recordPresentation(900, queuedEpoch, true); // an old queued job completing after hold release must be rejected
    CHECK(reply(endpoint, request("stale", "_presentationCompletions", "")).find("result")->find("samples")->items().empty());
    record(1000);
    CHECK(reply(endpoint, request("epoch", "_presentationCompletions", "")).find("result")->find("epoch")->number() > epoch);
    CHECK(reply(endpoint, request("gap", "_presentationCompletions", "")).find("result")->find("samples")->items().size() == 1);
    record(1000); // invalid/nonmonotonic observations fail closed
    CHECK(!reply(endpoint, request("invalid", "_presentationCompletions", "")).find("result")->find("valid")->boolean());
    reply(endpoint, request("fixed", "_setClockMode", "\"fixed-step\""));
    CHECK(!live && transitions == 2);
    record(200);
    CHECK(reply(endpoint, request("cleared", "_presentationCompletions", "")).find("result")->find("samples")->items().empty());
    reply(endpoint, request("liveagain", "_setClockMode", "\"wall-clock\""));
    for (int i = 0; i < 2049; ++i) record(300 + i);
    cadence = reply(endpoint, request("bounded", "_presentationCompletions", ""));
    CHECK(cadence.find("result")->find("samples")->items().size() == 2048);
    CHECK(cadence.find("result")->find("dropped")->number() == 1);
}

void protocol() {
    automaticRenderHold();
    liveClockProtocol();
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
        {"renderOnly", "", true},
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
        auto* tracking = Object3D::transformTrackingAddress(&game.player->position);
        tracking[1] = 0;
        const json::Value r = reply(*game.endpoint, request(id, c.method, c.argument));
        if (c.method == "applySetup" && c.ok) CHECK(tracking[1] == 1);
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


// PRD-617: runtime.renderOnly is a device.ts message type and a bridge method the installed JS
// runtime answers; the endpoint forwards it to the observer like the other observation methods and
// never advances the simulation itself.
void renderOnlyRoute() {
    uint64_t observed = 0, steps = 0, ticks = 0;
    Host host;
    host.tick = [&] { ++ticks; return 0; };
    host.step = [&] { ++steps; };
    host.observe = [&](const std::string& method, const json::Value*, json::Value& result, std::string&) {
        if (method != "renderOnly") return false; // the native fallback answers the rest
        ++observed;
        result = json::Value::makeNumber(7);
        return true;
    };
    Endpoint endpoint(host);
    const json::Value answer = reply(endpoint, request("r", "renderOnly", ""));
    const json::Value* resolved = answer.find("result");
    CHECK(observed == 1);
    CHECK(steps == 0 && ticks == 0);
    CHECK(resolved && resolved->number() == 7);
    const json::Value unknown = reply(endpoint, request("u", "teleport", ""));
    const json::Value* error = unknown.find("error");
    CHECK(error && error->find("message")->string().rfind("TN_INSPECT_UNKNOWN_METHOD", 0) == 0);
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

TN_TEST_MAIN({"protocol", protocol}, {"input_tick", inputTick}, {"render_only", renderOnlyRoute})
