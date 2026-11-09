#pragma once

#include <cstdlib>
#include <optional>
#include <string>

// PRD-840 (H4): every TN_* environment flag the engine reads, in one list, each declared read once or live. No engine
// file outside this one calls getenv (scripts/__tests__/ablation-flags-never-ship.spec.ts enumerates the list).
namespace tn::engine::flags {

/** Once: the first read holds for the process. Live: each call reads the environment again (per frame, per
 *  construction or per thread start, as its caller says). */
enum class Read { Once, Live };

struct Flag {
    const char* name;
    Read read;
};

// Foundation and scene.
inline constexpr Flag JobWorkers{"TN_JOB_WORKERS", Read::Live};
inline constexpr Flag AnimationPoseObservation{"TN_ANIMATION_POSE_OBSERVATION", Read::Live};  // per thread start
inline constexpr Flag MaterialDiagnostics{"TN_MATERIAL_DIAGNOSTICS", Read::Once};

// Renderer.
inline constexpr Flag GpuPasses{"TN_GPU_PASSES", Read::Live};  // per FrameGpuTimer: the web host sets it first
inline constexpr Flag ShadowInstanceGroups{"TN_SHADOW_INSTANCE_GROUPS", Read::Live};  // per frame: paired arms
inline constexpr Flag ShadowInstanceCull{"TN_SHADOW_INSTANCE_CULL", Read::Live};      // per frame: paired arms
inline constexpr Flag ProgramProbes{"TN_PROGRAM_PROBES", Read::Once};
inline constexpr Flag ShadowPageScan{"TN_SHADOW_PAGE_SCAN", Read::Once};
inline constexpr Flag ProjectionWalks{"TN_PROJECTION_WALKS", Read::Once};
inline constexpr Flag BatchDecisionCache{"TN_BATCH_DECISION_CACHE", Read::Once};
inline constexpr Flag GpuJointDrawUse{"TN_GPU_JOINT_DRAW_USE", Read::Once};

// Player (the native host).
inline constexpr Flag GameSpans{"TN_GAME_SPANS", Read::Live};
inline constexpr Flag PlayerWidth{"TN_PLAYER_WIDTH", Read::Live};
inline constexpr Flag PlayerHeight{"TN_PLAYER_HEIGHT", Read::Live};
inline constexpr Flag PlayerTitle{"TN_PLAYER_TITLE", Read::Live};
inline constexpr Flag PlayerVsync{"TN_PLAYER_VSYNC", Read::Live};
inline constexpr Flag PlayerPriority{"TN_PLAYER_PRIORITY", Read::Live};
inline constexpr Flag PlayerMetrics{"TN_PLAYER_METRICS", Read::Live};
inline constexpr Flag PlayerGpuTiming{"TN_PLAYER_GPU_TIMING", Read::Live};
inline constexpr Flag PlayerMainThreadCpu{"TN_PLAYER_MAIN_THREAD_CPU", Read::Live};
inline constexpr Flag RenderThread{"TN_RENDER_THREAD", Read::Live};
inline constexpr Flag StablePasses{"TN_STABLE_PASSES", Read::Live};
inline constexpr Flag StableRows{"TN_STABLE_ROWS", Read::Live};
inline constexpr Flag GpuThread{"TN_GPU_THREAD", Read::Live};
inline constexpr Flag RenderPrepareSplit{"TN_RENDER_PREPARE_SPLIT", Read::Live};
inline constexpr Flag BenchLaunchMs{"TN_BENCH_LAUNCH_MS", Read::Live};
inline constexpr Flag PlaytestMailboxRoot{"TN_PLAYTEST_MAILBOX_ROOT", Read::Live};
inline constexpr Flag NativeAssetPackage{"TN_NATIVE_ASSET_PACKAGE", Read::Live};
inline constexpr Flag NativeJsMath{"TN_NATIVE_JS_MATH", Read::Live};
inline constexpr Flag Debug{"TN_DEBUG", Read::Live};
inline constexpr Flag PlayerCrossings{"TN_PLAYER_CROSSINGS", Read::Live};
inline constexpr Flag FrameSpans{"TN_FRAME_SPANS", Read::Live};
inline constexpr Flag UiRenderer{"TN_UI_RENDERER", Read::Live};
inline constexpr Flag JsCpuProfileStartFrame{"TN_JS_CPU_PROFILE_START_FRAME", Read::Once};
// The PS4 guest cannot read its host environment, so the pad trace is on unless the host says 0.
inline constexpr Flag Ps4PadTrace{"TN_PS4_PAD_TRACE", Read::Once};

/** A Live flag's text now, or nullptr when it is unset. */
template <const Flag& F>
const char* read() {
    static_assert(F.read == Read::Live, "a Once flag is read with flags::once");
    return std::getenv(F.name);
}

/** A Once flag's text at its first read, held for the process, or nullptr when it was unset. */
template <const Flag& F>
const char* once() {
    static_assert(F.read == Read::Once, "a Live flag is read with flags::read");
    static const std::optional<std::string> text = [] {
        const char* value = std::getenv(F.name);
        return value ? std::optional<std::string>(value) : std::nullopt;
    }();
    return text ? text->c_str() : nullptr;
}

}  // namespace tn::engine::flags
