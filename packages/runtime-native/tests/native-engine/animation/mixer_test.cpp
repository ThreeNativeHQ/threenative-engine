// PRD-516 phase 2: the mixer against the pinned three. scenario.h replays the generated clips,
// timeline and deltas (six clips on a five-node rig, 600 irregular steps) and compares every node's
// transform, every action's state, the mixer stats and every loop and finished event with three's.
#include "check.h"
#include <cmath>
#include <cstdlib>
#include <limits>
#include <stdexcept>
#include "scenario.h"
#include "engine/animation/skinning/skeleton.h"

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
void deferredMixer() {
    auto bone = std::make_shared<Bone>();
    bone->enableTrackedTransform();
    AnimationMixer mixer(bone);
    auto clip = std::make_shared<AnimationClip>("move", 1, std::vector<KeyframeTrack>{
        KeyframeTrack(".position", TrackType::Vector, {0, 1}, {0, 0, 0, 10, 20, 30}),
        KeyframeTrack(".quaternion", TrackType::Quaternion, {0, 1}, {0, 0, 0, 1, 0, 1, 0, 0})});
    auto* action = mixer.clipAction(clip);
    action->play();
    auto stream = std::make_shared<std::vector<float>>(12); auto valid = std::make_shared<bool>(true);
    CHECK(bone->enableDeferredTransform(stream, 0, valid));
    mixer.update(0.25);
    CHECK(bone->hasDeferredTransform() && bone->position.x == 0);
    CHECK(bone->deferredTransformValues()[0] == 2.5);
    CHECK((*stream)[0] == 2.5f && (*stream)[1] == 5 && (*stream)[3] == 0 && (*stream)[8] == 1);
    mixer.update(0.25); // alternating accumulator cannot overwrite the stable previous property
    CHECK(bone->position.x == 0 && bone->deferredTransformValues()[0] == 5);
    Vector3 world; bone->getWorldPosition(world); CHECK(world.x == 5 && world.y == 10);
    mixer.update(0.25); CHECK(bone->hasDeferredTransform());
    action->stop(); // original state restored through the same binding
    PropertyBinding position(bone, ".position"); double values[3]{}; position.getValue(values, 0);
    CHECK(values[0] == 0 && values[1] == 0 && bone->quaternion.w == 1);
    action->play(); mixer.update(0.125);
    mixer.uncacheRoot(*bone);
    CHECK(!bone->hasDeferredTransform() && bone->position.x == 0);
}

void poseObservation() {
    CHECK(Object3D::poseObserver == nullptr && Object3D::poseObservationReport == nullptr);
    if (const auto* flag = std::getenv("TN_ANIMATION_POSE_OBSERVATION"); flag && std::strcmp(flag, "1") == 0) {
        auto bone = std::make_shared<Bone>(); const auto& borrowed = bone->deferredTransformValues(); (void)borrowed;
        CHECK(bone->poseObservationEscapedValues && Object3D::poseObserver == nullptr); // Process-start flag, before any mixer.
    }
    const auto clip = std::make_shared<AnimationClip>("move", 1, std::vector<KeyframeTrack>{
        KeyframeTrack(".position", TrackType::Vector, {0, 1}, {0, 0, 0, 10, 20, 30}),
        KeyframeTrack(".quaternion", TrackType::Quaternion, {0, 1}, {0, 0, 0, 1, 0, 1, 0, 0})});
    const auto run = [&](int query) {
        if (query == 7) CHECK(Object3D::poseObserver == nullptr && Object3D::poseObservationReport == nullptr);
        AnimationMixer::poseObservation = {true};
        Object3D::poseObservationEnabled = true;
        auto bone = std::make_shared<Bone>(); bone->enableTrackedTransform();
        const std::array<double, 10>* earlyBorrow = query == 7 ? &bone->deferredTransformValues() : nullptr;
        AnimationMixer mixer(bone); mixer.clipAction(clip)->play();
        auto valid = std::make_shared<bool>(true);
        CHECK(bone->enableDeferredTransform(std::make_shared<std::vector<float>>(12), 0, valid));
        bone->gpuJointBoundary = valid; bone->gpuJointHierarchy = Object3D::hierarchyVersion();
        mixer.update(0.25);
        if (earlyBorrow) { volatile double consumed = (*earlyBorrow)[0]; (void)consumed; }
        const std::array<double, 10>* borrowed = query == 6 ? &bone->deferredTransformValues() : nullptr;
        if (query == 1) { PropertyBinding local(bone, ".position"); double values[3]; local.getValue(values, 0); }
        if (query == 2) { Vector3 world; bone->getWorldPosition(world); }
        if (query == 3) Object3D::poseObserver(*bone, 2);
        if (query == 4) *valid = false;
        if (query == 5) { Group parent; parent.add(*bone); }
        if (query == 8) Object3D::prepareTransformView(&bone->position);
        mixer.update(0.25);
        if (borrowed) { volatile double consumed = (*borrowed)[0]; (void)consumed; mixer.update(0.25); }
        return AnimationMixer::poseObservation;
    };
    const auto earlyBorrow = run(7);
    CHECK(earlyBorrow.intervals == 1 && earlyBorrow.unusedTracks == 0 && earlyBorrow.conservativeTracks == 2);
    const auto hidden = run(0);
    CHECK(hidden.intervals == 1 && hidden.tracks == 2 && hidden.bindings == 2);
    CHECK(hidden.unusedIntervals == 1 && hidden.unusedTracks == 2 && hidden.wholeUnusedTracks == 2);
    CHECK(hidden.unusedBindings == 2 && hidden.queriedTracks == 0 && hidden.drawnTracks == 0);
    for (int query = 1; query <= 5; ++query) {
        const auto observed = run(query);
        CHECK(observed.intervals == 1 && observed.unusedIntervals == 0 && observed.unusedTracks == 0);
        if (query <= 2) CHECK(observed.queriedTracks == 2);
        if (query == 3) CHECK(observed.drawnTracks == 2);
        if (query >= 4) CHECK(observed.conservativeTracks == 2);
    }
    CHECK(Object3D::poseObserver == nullptr && Object3D::poseObservationReport == nullptr);
    const auto retained = run(6);
    CHECK(retained.intervals == 2 && retained.unusedTracks == 0);
    const auto mathBorrow = run(8);
    CHECK(mathBorrow.unusedTracks == 0 && mathBorrow.conservativeTracks == 2 && mathBorrow.queriedTracks == 2);
    AnimationMixer::poseObservation = {true};
    {
        auto bone = std::make_shared<Bone>(); bone->enableTrackedTransform();
        AnimationMixer first(bone), second(bone);
        first.clipAction(clip)->play(); second.clipAction(clip)->play();
        auto valid = std::make_shared<bool>(true);
        CHECK(bone->enableDeferredTransform(std::make_shared<std::vector<float>>(12), 0, valid));
        bone->gpuJointBoundary = valid; bone->gpuJointHierarchy = Object3D::hierarchyVersion();
        first.update(0.25); second.update(0.25); first.update(0.25); second.update(0.25);
        CHECK(AnimationMixer::poseObservation.intervals == 2);
        CHECK(AnimationMixer::poseObservation.unusedTracks == 0 && AnimationMixer::poseObservation.conservativeTracks == 4);
    }
    CHECK(Object3D::poseObserver == nullptr);
    AnimationMixer::poseObservation = {true};
    {
        auto node = std::make_shared<Object3D>(); AnimationMixer mixer(node);
        mixer.clipAction(clip)->play(); mixer.update(0.25); mixer.update(0.25);
        CHECK(AnimationMixer::poseObservation.unusedTracks == 0 && AnimationMixer::poseObservation.conservativeTracks == 2);
    }
    CHECK(Object3D::poseObserver == nullptr);
    AnimationMixer::poseObservation = {true};
    {
        auto root = std::make_shared<Group>();
        auto bone = std::make_shared<Bone>(); bone->name = "joint"; bone->enableTrackedTransform(); root->add(*bone);
        const auto id = bone->id();
        AnimationMixer mixer(root);
        auto childClip = std::make_shared<AnimationClip>("child", 1, std::vector<KeyframeTrack>{
            KeyframeTrack("joint.position", TrackType::Vector, {0, 1}, {0, 0, 0, 10, 20, 30})});
        mixer.clipAction(childClip)->play();
        auto valid = std::make_shared<bool>(true);
        CHECK(bone->enableDeferredTransform(std::make_shared<std::vector<float>>(12), 0, valid));
        bone->gpuJointBoundary = valid; bone->gpuJointHierarchy = Object3D::hierarchyVersion();
        mixer.update(0.25); root->remove(*bone); bone.reset(); mixer.update(0.25);
        CHECK(AnimationMixer::poseObservation.unusedTracks == 0 && AnimationMixer::poseObservation.conservativeTracks == 1);
        bone = std::make_shared<Bone>(); CHECK(bone->id() != id); // Reused addresses cannot reuse subscription IDs.
    }
    CHECK(Object3D::poseObserver == nullptr);
    CHECK(run(0).unusedTracks == 2); // Destruction removed every old mixer subscription.
    AnimationMixer::poseObservation = {};
    Object3D::poseObservationEnabled = false;
    const auto disabled = AnimationMixer::poseObservation;
    deferredMixer();
    CHECK(AnimationMixer::poseObservation.intervals == disabled.intervals && Object3D::poseObserver == nullptr);
}

double meterClock = 0;
AnimationMixer* meterReentry = nullptr;
void cpuTiming() {
    AnimationMixer mixer(std::make_shared<Object3D>());
    AnimationMixer::cpuTiming = {};
    mixer.update(0);
    CHECK(AnimationMixer::cpuTiming.calls == 0 && AnimationMixer::cpuTiming.ms == 0);
    const auto clock = []() { return meterClock += 0.25; };
    meterClock = 0;
    AnimationMixer::cpuTiming = {clock};
    mixer.update(0); mixer.update(0);
    CHECK(AnimationMixer::cpuTiming.calls == 2 && AnimationMixer::cpuTiming.ms == 0.5);
    meterReentry = &mixer;
    AnimationMixer::cpuTiming = {[]() {
        if (auto* nested = meterReentry) { meterReentry = nullptr; nested->update(0); }
        return meterClock += 0.25;
    }};
    mixer.update(0);
    CHECK(AnimationMixer::cpuTiming.calls == 2 && AnimationMixer::cpuTiming.ms == 0.25);
    AnimationMixer::cpuTiming = {clock};
    CHECK(AnimationMixer::cpuTiming.calls == 0 && AnimationMixer::cpuTiming.ms == 0);
    auto clip = std::make_shared<AnimationClip>("meter", 1, std::vector<KeyframeTrack>{});
    auto* action = mixer.clipAction(clip);
    action->setLoop(Loop::Once, 1).play();
    mixer.addEventListener("finished", [](const MixerEvent&, void* context) {
        CHECK(AnimationMixer::cpuTiming.calls == 1 && AnimationMixer::cpuTiming.ms == 0.25);
        meterClock += 100; // arbitrary listener CPU must not enter the native-mixer numerator
        static_cast<AnimationMixer*>(context)->update(0);
        throw std::runtime_error("listener");
    }, &mixer);
    bool threw = false;
    try { mixer.update(1); } catch (const std::runtime_error&) { threw = true; }
    CHECK(threw && AnimationMixer::cpuTiming.available);
    CHECK(AnimationMixer::cpuTiming.calls == 2 && AnimationMixer::cpuTiming.ms == 0.5);
    AnimationMixer::cpuTiming = {[]() { return -1.0; }};
    mixer.update(0);
    CHECK(!AnimationMixer::cpuTiming.available && AnimationMixer::cpuTiming.calls == 1);
    AnimationMixer::cpuTiming = {[]() { return std::numeric_limits<double>::quiet_NaN(); }};
    mixer.update(0);
    CHECK(!AnimationMixer::cpuTiming.available && AnimationMixer::cpuTiming.ms == 0);
    meterClock = 1;
    AnimationMixer::cpuTiming = {[]() { return meterClock -= 0.25; }};
    mixer.update(0);
    CHECK(!AnimationMixer::cpuTiming.available && AnimationMixer::cpuTiming.ms == 0);
    AnimationMixer::cpuTiming = {};
    mixer.update(0);
    CHECK(AnimationMixer::cpuTiming.available && AnimationMixer::cpuTiming.clock == nullptr);
    CHECK(AnimationMixer::cpuTiming.calls == 0 && AnimationMixer::cpuTiming.ms == 0);
}

void mixer() {
    cpuTiming();
    deferredMixer();
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

// A track is applied once a frame over memory the rest of the frame evicted, so what an update reads
// of a PropertyMixer (its weights, its buffer pointer, the binding's node and target) must sit in the
// first two cache lines, ahead of the binding's parsed path and diagnostics. The mixer prefetches
// those two lines; a layout that spreads them over four loses most of that.
void track_hot_fields() {
    auto root = std::make_shared<Object3D>();
    root->name = "bone";
    PropertyMixer track(PropertyBinding(root, "bone.quaternion"), TrackType::Quaternion, 4);
    const char* base = reinterpret_cast<const char*>(&track);
    const auto at = [&](const void* member) { return static_cast<std::size_t>(reinterpret_cast<const char*>(member) - base); };
    CHECK(at(&track.valueSize) < 64);
    CHECK(at(&track.buffer) < 64);
    CHECK(at(&track.cumulativeWeight) < 64);
    CHECK(at(&track.cumulativeWeightAdditive) < 128);
    // `path` is the binding's first cold member: the node, target and flags an apply reads precede it.
    CHECK(at(&track.binding.path) - at(&track.binding) >= 32);
    CHECK(at(&track.binding.path) < 128);
}

} // namespace

TN_TEST_MAIN({"mixer", mixer}, {"events", events}, {"track_hot_fields", track_hot_fields}, {"pose_observation", poseObservation})
