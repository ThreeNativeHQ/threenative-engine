// PRD-784 E5: the PS4 entry point for tn-native-engine-player-v8.
//
// The player already owns a main(): src/engine/player/v8_main.cpp parses the host's arguments,
// boots V8 with the game bundle and runs the surface loop through player::run. A console has no
// shell to write those arguments in, so the PS4 build compiles that file with
// -Dmain=tn_player_v8_main (cmake/NativeEngineAdapters.cmake) and this file supplies the entry the
// OpenOrbis crt reaches. Everything added here is the environment a PS4 run cannot state for
// itself -- the bundle's fixed path, the scanout's 1920x1080, V8's flags -- so no line of the
// player forks. An argument the loader does provide still wins: only argc == 1 gets the default.
#include <cstdio>
#include <cstdlib>
#include <vector>

int tn_player_v8_main(int argc, char** argv);

namespace {

// /app0 is the app folder shadPS4 mounts (the directory holding eboot.bin), which is where the
// runner writes game.js and native/assets.tnpk; E1/E3 read their files from the same mount.
constexpr const char* kDefaultBundle = "/app0/game.js";

void setDefault(const char* name, const char* value) {
    if (std::getenv(name) == nullptr) setenv(name, value, 1);
}

}  // namespace

int main(int argc, char** argv) {
    std::printf("TN_PS4_E5 stage=entry argc=%d\n", argc);
    std::fflush(stdout);

    // run.cpp reads both, sizes the drawing buffer from them and configures the surface with them.
    // The VideoOut swapchain is the screen's own size and takes no other, so this is not a default
    // a game may scale: PS4's fixed scanout is 1920x1080.
    setDefault("TN_PLAYER_WIDTH", "1920");
    setDefault("TN_PLAYER_HEIGHT", "1080");
    // The only channel the player offers V8 (src/js/v8_engine.cpp reads TN_V8_FLAGS): a guest has no
    // command line. jitless because the PS4 monolith is built without a JIT page provider (E4),
    // single-threaded because the engine's own job pool owns every worker the guest gets, and the
    // flags must stay mutable after init so a later SetFlagsFromString can still take effect.
    setDefault("TN_V8_FLAGS", "--jitless --single-threaded --no-freeze-flags-after-init");

    std::vector<char*> arguments(argv, argv + argc);
    if (argc <= 1) {
        arguments.push_back(const_cast<char*>(kDefaultBundle));
        ++argc;
    }
    arguments.push_back(nullptr);

    const int status = tn_player_v8_main(argc, arguments.data());
    std::printf("TN_PS4_E5 stage=exit status=%d\n", status);
    std::fflush(stdout);
    return status;
}
