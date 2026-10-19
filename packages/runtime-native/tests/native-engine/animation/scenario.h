// The mixer scenario both PRD-516 and PRD-517 tests replay: clips, a timeline of operations and the
// frame deltas come from a generated table (animation-reference.ts runs the same timeline on three),
// and every fifth frame the caller's observation, each action's state and the mixer stats are
// compared with three's record, bit for bit, as are the loop and finished events.
#pragma once

#include <bit>
#include <cinttypes>
#include <cstdio>
#include <cstdlib>
#include <functional>
#include <memory>
#include <string>
#include <string_view>
#include <vector>

#include "engine/animation/mixer.h"

namespace tn::engine::animation::scenario {

struct TrackSpec {
    int clip;
    const char* name;
    TrackType type;
    Interpolation interpolation;
    const double* times;
    std::size_t timeCount;
    const double* values;
    std::size_t valueCount;
};
struct ClipSpec {
    const char* name;
    double duration;
    BlendMode blendMode;
};
struct OpSpec {
    int frame;
    const char* op;
    int action;
    double a, b, c;
};

inline std::string bits(double x) {
    char out[17];
    std::snprintf(out, sizeof out, "%016" PRIx64, std::bit_cast<uint64_t>(x));
    return out;
}

template <typename Array> std::string join(const Array& values) {
    std::string out;
    for (double v : values)
        out += (out.empty() ? "" : ",") + bits(v);
    return out;
}

struct Replay {
    std::vector<std::string> samples, events;
};

/** Plays the table on a mixer over `root`, observing with `observe` every fifth frame. */
template <std::size_t NTracks, std::size_t NClips, std::size_t NOps, std::size_t NDeltas>
Replay replay(const TrackSpec (&tracks)[NTracks], const ClipSpec (&clipSpecs)[NClips], const OpSpec (&ops)[NOps],
              const double (&deltas)[NDeltas], const std::shared_ptr<Object3D>& root,
              const std::function<std::string()>& observe) {
    std::vector<std::shared_ptr<const AnimationClip>> clips;
    for (std::size_t ci = 0; ci < NClips; ++ci) {
        std::vector<KeyframeTrack> clipTracks;
        for (const TrackSpec& t : tracks) {
            if (t.clip != static_cast<int>(ci))
                continue;
            clipTracks.emplace_back(t.name, t.type, std::vector<double>(t.times, t.times + t.timeCount),
                                    std::vector<double>(t.values, t.values + t.valueCount), t.interpolation);
        }
        clips.push_back(std::make_shared<AnimationClip>(clipSpecs[ci].name, clipSpecs[ci].duration,
                                                        std::move(clipTracks), clipSpecs[ci].blendMode));
    }
    AnimationMixer mixer(root);
    std::vector<AnimationAction*> actions;
    for (const auto& clip : clips)
        actions.push_back(mixer.clipAction(clip));
    struct Recorder {
        std::vector<std::string> events;
        int frame = 0;
    } recorder;
    const auto record = [](const MixerEvent& e, void* context) {
        auto& r = *static_cast<Recorder*>(context);
        r.events.push_back(std::to_string(r.frame) + ":" + std::string(e.type) + ":" + e.action->getClip().name + ":" +
                           std::to_string(e.direction) + ":" + bits(e.loopDelta));
    };
    mixer.addEventListener("finished", record, &recorder);
    mixer.addEventListener("loop", record, &recorder);

    const Loop loops[] = {Loop::Once, Loop::Repeat, Loop::PingPong};
    const auto apply = [&](const OpSpec& o) {
        AnimationAction& action = *actions[static_cast<std::size_t>(o.action)];
        const std::string_view op = o.op;
        AnimationAction* other =
            o.a >= 0 && o.a < static_cast<double>(actions.size()) ? actions[static_cast<std::size_t>(o.a)] : nullptr;
        if (op == "play")
            action.play();
        else if (op == "stop")
            action.stop();
        else if (op == "reset")
            action.reset();
        else if (op == "fadeIn")
            action.fadeIn(o.a);
        else if (op == "fadeOut")
            action.fadeOut(o.a);
        else if (op == "crossFadeFrom")
            action.crossFadeFrom(*other, o.b, o.c == 1);
        else if (op == "crossFadeTo")
            action.crossFadeTo(*other, o.b, o.c == 1);
        else if (op == "halt")
            action.halt(o.a);
        else if (op == "warp")
            action.warp(o.a, o.b, o.c);
        else if (op == "setLoop")
            action.setLoop(loops[static_cast<int>(o.a)], o.b);
        else if (op == "clamp")
            action.clampWhenFinished = o.a == 1;
        else if (op == "weight")
            action.weight = o.a;
        else if (op == "timeScale")
            action.timeScale = o.a;
        else if (op == "setEffectiveWeight")
            action.setEffectiveWeight(o.a);
        else if (op == "setEffectiveTimeScale")
            action.setEffectiveTimeScale(o.a);
        else if (op == "setDuration")
            action.setDuration(o.a);
        else if (op == "syncWith")
            action.syncWith(*other);
        else if (op == "startAt")
            action.startAt(mixer.time + o.a);
        else if (op == "zeroSlope") {
            action.zeroSlopeAtStart = o.a == 1;
            action.zeroSlopeAtEnd = o.b == 1;
        } else if (op == "mixerTimeScale")
            mixer.timeScale = o.a;
        else if (op == "mixerSetTime")
            mixer.setTime(o.a);
        else if (op == "stopAll")
            mixer.stopAllAction();
        else if (op == "uncacheAction")
            mixer.uncacheAction(*clips[static_cast<std::size_t>(o.action)]);
        else {
            std::fprintf(stderr, "unknown op %s\n", o.op);
            std::abort();
        }
    };

    Replay result;
    const auto flag = [](bool x) { return x ? "1" : "0"; };
    for (int frame = 0; frame < static_cast<int>(NDeltas); ++frame) {
        recorder.frame = frame;
        for (const OpSpec& o : ops)
            if (o.frame == frame)
                apply(o);
        mixer.update(deltas[frame]);
        if (frame % 5 != 4)
            continue;
        std::string out = "f" + std::to_string(frame) + "|t=" + bits(mixer.time) + "|" + observe();
        for (std::size_t i = 0; i < actions.size(); ++i) {
            const AnimationAction& a = *actions[i];
            out += "|a" + std::to_string(i) + ":t=" + bits(a.time) + ";w=" + bits(a.getEffectiveWeight()) +
                   ";ts=" + bits(a.getEffectiveTimeScale()) + ";e=" + flag(a.enabled) + ";p=" + flag(a.paused) +
                   ";r=" + flag(a.isRunning()) + ";s=" + flag(a.isScheduled());
        }
        out += "|stats=" + std::to_string(mixer.actionsTotal()) + "," + std::to_string(mixer.actionsInUse()) + "," +
               std::to_string(mixer.bindingsTotal()) + "," + std::to_string(mixer.bindingsInUse()) + "," +
               std::to_string(mixer.controlInterpolantsTotal()) + "," +
               std::to_string(mixer.controlInterpolantsInUse());
        result.samples.push_back(out);
    }
    result.events = recorder.events;
    return result;
}

/** How many entries differ from three's (a length difference counts as one); prints the first four. */
template <std::size_t N>
std::size_t differences(const std::vector<std::string>& got, const char* const (&want)[N], const char* what) {
    std::size_t mismatched = got.size() == N ? 0 : 1;
    if (mismatched)
        std::fprintf(stderr, "%s: native has %zu, three has %zu\n", what, got.size(), N);
    for (std::size_t i = 0; i < got.size() && i < N; ++i) {
        if (got[i] == want[i])
            continue;
        if (mismatched++ < 4) {
            std::size_t at = 0;
            while (at < got[i].size() && got[i][at] == want[i][at])
                ++at;
            const std::size_t bar = got[i].rfind('|', at);
            const std::size_t from = bar == std::string::npos ? 0 : bar + 1;
            std::fprintf(stderr, "%s %zu (%.6s): native %.110s\n%*s  three  %.110s\n", what, i, got[i].c_str(),
                         got[i].c_str() + from, static_cast<int>(std::string_view(what).size() + 12), "",
                         want[i] + from);
        }
    }
    return mismatched;
}

} // namespace tn::engine::animation::scenario
