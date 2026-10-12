// PRD-516 phase 2: the mixer against the pinned three. scenario.h replays the generated clips,
// timeline and deltas (six clips on a five-node rig, 600 irregular steps) and compares every node's
// transform, every action's state, the mixer stats and every loop and finished event with three's.
#include "check.h"
#include "scenario.h"

using namespace tn::engine;
using namespace tn::engine::animation;
using namespace tn::engine::animation::scenario;

namespace {

#include "mixer_reference.inc"

const Replay& rigReplay() {
    static const Replay result = [] {
        const auto named = [](const char* name) {
            auto object = std::make_shared<Object3D>();
            object->name = name;
            return object;
        };
        auto rig = named("rig"), hips = named("hips"), spine = named("spine"), head = named("head"),
             prop = named("prop");
        rig->add(*hips);
        rig->add(*prop);
        hips->add(*spine);
        spine->add(*head);
        const std::shared_ptr<Object3D> nodes[] = {rig, hips, spine, head, prop};
        return replay(kTracks, kClips, kOps, kDeltas, rig, [&] {
            std::string out;
            for (const auto& o : nodes)
                out += (out.empty() ? "" : "|") + o->name + ":p=" + join(o->position.toArray()) +
                       ";q=" + join(o->quaternion.toArray()) + ";s=" + join(o->scale.toArray());
            return out;
        });
    }();
    return result;
}

// Loop modes, clampWhenFinished, weights, additive blending, fades and warps: the pose dumps.
void mixer() {
    const std::size_t diffs = differences(rigReplay().samples, kSamples, "sample");
    std::printf("mixer: %zu samples, %zu differ\n", rigReplay().samples.size(), diffs);
    CHECK(diffs == 0);
}

// `loop` and `finished`: type, action, direction or loop delta, and the frame each fired on.
void events() {
    const std::size_t diffs = differences(rigReplay().events, kEvents, "event");
    std::printf("events: %zu, %zu differ\n", rigReplay().events.size(), diffs);
    CHECK(diffs == 0);
}

} // namespace

TN_TEST_MAIN({"mixer", mixer}, {"events", events})
