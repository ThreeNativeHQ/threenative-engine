// The native-engine desktop player (PRD-529 phase 2): an SDL window on the display the playtest
// runner provides, the engine's fixed-step clock, the render database into the renderer, the
// presentation of that frame, and the mailbox the runner talks to. No JS engine is linked: the game
// is inspect-demo, in C++. A game bundle on V8 is the sibling tn-native-engine-player-v8.
#if defined(__ANDROID__)
#include <SDL3/SDL_main.h>
#include <cstdlib>
#include <android/log.h>
#include "mystral/platform/android_stdio.h"
#endif

#include <cstdio>
#include <exception>
#include <string>

#include "engine/inspect/endpoint.h"
#include "engine/player/demo.h"
#include "engine/player/skinned_crowd.h"
#include "engine/player/run.h"
#if !defined(__ANDROID__)
#include "engine/player/world_walk.h"
#endif

using namespace tn::engine;

int runPlayer(int argc, char** argv) {
#if defined(__ANDROID__)
    if (argc > 2 && argv[2][0] != '\0')
        setenv("TN_PLAYTEST_MAILBOX_ROOT", argv[2], 1);
#endif
    // The first argument selects the built-in C++ game.
    const std::string game = argc > 1 && argv[1][0] != '\0' ? argv[1] : "inspect-demo";
#if !defined(__ANDROID__)
    if (game == "world-walk" || game == "world-cycles" || game == "world-fault") {
        try {
            player::WorldWalk world(game, argc > 2 ? argv[2] : TN_WORLD_WALK_FIXTURE);
            return player::run(world.game());
        } catch (const std::exception& failure) {
            std::fprintf(stderr, "[Playtest] %s\n", failure.what());
            return 1;
        }
    }
#endif
    if (game == "skinned-crowd") {
        player::SkinnedCrowd crowd;
        player::Game configured;
        configured.name = game;
        configured.scene = &crowd.scene();
        configured.camera = &crowd.camera();
        configured.shadowMapEnabled = true;
        configured.update = [&crowd](double dt) { crowd.update(dt); };
        return player::run(configured);
    }
    if (game != "inspect-demo") {
#if defined(__ANDROID__)
        std::printf("TN_PLAYER_UNKNOWN_GAME: %s; expected inspect-demo or skinned-crowd.\n", game.c_str());
#else
        std::printf("TN_PLAYER_UNKNOWN_GAME: %s; expected inspect-demo, skinned-crowd, world-walk, world-cycles or world-fault.\n", game.c_str());
#endif
        return 1;
    }

    player::InspectDemo demo(game);
    player::Game configured;
    configured.name = demo.name();
    configured.scene = &demo.scene();
    configured.camera = &demo.camera();
    configured.gameRuntime = "cpp";
    configured.update = [&demo](double dt) { demo.update(dt); };
    // The state snapshot a scenario compares across labelled steps, and the input latch the
    // per-tick callback fills. The profile is the loop's own.
    configured.resource = [&demo](const std::string& id, uint64_t tick) -> json::Value {
        if (id == "state") {
            const Vector3 at = demo.scene().getObjectByName("player")->position;
            return json::Value::makeObject({{"playerX", json::Value::makeNumber(at.x)},
                                            {"playerY", json::Value::makeNumber(at.y)},
                                            {"playerZ", json::Value::makeNumber(at.z)},
                                            {"tick", json::Value::makeNumber(double(tick))}});
        }
        if (id == "input") {
            const player::InspectDemo::InputLatch& latch = demo.inputLatch();
            return json::Value::makeObject({{"key", json::Value::makeString(latch.key)},
                                            {"latched", json::Value::makeBool(latch.latched)},
                                            {"injectedTick", json::Value::makeNumber(double(latch.injectedTick))},
                                            {"seenTick", json::Value::makeNumber(double(latch.seenTick))}});
        }
        return json::Value::makeNull();
    };
    configured.attach = [&demo](inspect::Endpoint& endpoint) { demo.attachEndpoint(endpoint); };
    return player::run(configured);
}

int main(int argc, char** argv) {
#if defined(__ANDROID__)
    mystral::platform::redirectStdioToLogcat();
    __android_log_print(ANDROID_LOG_INFO, "TN_Player", "TN_PLAYER_START: argc=%d", argc);
#endif
    try {
        return runPlayer(argc, argv);
    } catch (const std::exception& failure) {
#if defined(__ANDROID__)
        __android_log_print(ANDROID_LOG_ERROR, "TN_Player", "TN_PLAYER_ERROR: %s", failure.what());
#endif
        std::fprintf(stderr, "TN_PLAYER_ERROR: %s\n", failure.what());
        return 1;
    }
}
