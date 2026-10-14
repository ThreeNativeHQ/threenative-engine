// PRD-516 phase 2: the mixer against the pinned three. scenario.h replays the generated clips,
// timeline and deltas (six clips on a five-node rig, 600 irregular steps) and compares every node's
// transform, every action's state, the mixer stats and every loop and finished event with three's.
#include "check.h"
#include <cmath>
#include <limits>
#include <stdexcept>
#include <thread>
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

#ifndef __EMSCRIPTEN__
struct WorkerEnvironment {
    std::optional<std::string> previous;
    WorkerEnvironment() { if (auto value = std::getenv("TN_ANIMATION_WORKER")) previous = value; set("1"); }
    ~WorkerEnvironment() { set(previous ? previous->c_str() : nullptr); }
    static void set(const char* value) {
#ifdef _WIN32
        _putenv_s("TN_ANIMATION_WORKER", value ? value : "");
#else
        if (value) setenv("TN_ANIMATION_WORKER", value, 1); else unsetenv("TN_ANIMATION_WORKER");
#endif
    }
};
void workerReplay() {
    WorkerEnvironment environment;
    const auto named = [](const char* name) {
        auto bone = std::make_shared<Bone>(); bone->name = name; bone->enableTrackedTransform(); return bone;
    };
    auto rig = named("rig"), hips = named("hips"), spine = named("spine"), head = named("head"), prop = named("prop");
    rig->add(*hips); rig->add(*prop); hips->add(*spine); spine->add(*head);
    const std::shared_ptr<Bone> nodes[] = {rig, hips, spine, head, prop};
    bool deferred = false;
    const auto result = replay(kTracks, kClips, kOps, kDeltas, rig, [&] {
        for (const auto& node : nodes) { deferred = deferred || bool(node->pendingAnimation); node->materializeLocalTransform(); }
        std::string out;
        for (const auto& node : nodes) out += (out.empty() ? "" : "|") + node->name + ":p=" + join(node->position.toArray()) +
            ";q=" + join(node->quaternion.toArray()) + ";s=" + join(node->scale.toArray());
        return out;
    });
    CHECK(deferred);
    CHECK(differences(result.samples, kSamples, "worker sample") == 0);
    CHECK(differences(result.events, kEvents, "worker event") == 0);
}
void workerReads() {
    WorkerEnvironment environment;
    const auto bone = [] { auto result = std::make_shared<Bone>(); result->enableTrackedTransform(); return result; };
    auto clip = std::make_shared<AnimationClip>("worker", 1, std::vector<KeyframeTrack>{
        KeyframeTrack(".position", TrackType::Vector, {0, 1}, {0, 0, 0, 10, 20, 30})});
    auto root = bone(); AnimationMixer mixer(root); auto* action = mixer.clipAction(clip); action->play();
    mixer.update(0.25); CHECK(root->pendingAnimation && mixer.workerEvaluations() == 0);
    PropertyBinding position(root, ".position"); double value[3]{}; position.getValue(value, 0);
    CHECK(value[0] == 2.5 && value[1] == 5 && mixer.workerEvaluations() == 1 && !root->pendingAnimation);
    mixer.update(0.25); Vector3 world; root->getWorldPosition(world); CHECK(world.x == 5 && mixer.workerEvaluations() == 2);
    auto* alias = &root->position; Object3D::prepareTransformView(alias);
    mixer.update(0.25); CHECK(alias->x == 7.5 && mixer.workerEvaluations() == 2 && !root->pendingAnimation);
    auto stopped = bone(); AnimationMixer stopping(stopped); auto* stop = stopping.clipAction(clip); stop->play();
    stopping.update(0.25); stop->stop(); CHECK(stopped->position.x == 0 && stopping.workerEvaluations() == 1);
    stop->play(); stopping.update(0.5); stopping.uncacheRoot(*stopped);
    CHECK(stopped->position.x == 0 && !stopped->pendingAnimation && stopping.workerEvaluations() == 2);
    auto retained = bone();
    { AnimationMixer dying(retained); dying.clipAction(clip)->play(); dying.update(0.25); CHECK(retained->pendingAnimation); }
    CHECK(retained->position.x == 2.5 && !retained->pendingAnimation);
    auto shared = bone(); AnimationMixer first(shared), second(shared);
    first.clipAction(clip)->play(); second.clipAction(clip)->play(); first.update(0.25); second.update(0.5);
    CHECK(first.workerEvaluations() == 1 && shared->pendingAnimation);
    shared->materializeLocalTransform(); CHECK(shared->position.x == 5 && second.workerEvaluations() == 1);
    const auto onceResult = [&](const char* enabled, bool clamp) {
        WorkerEnvironment::set(enabled);
        auto finished = bone(); AnimationMixer events(finished); auto* once = events.clipAction(clip);
        once->clampWhenFinished = clamp; once->setLoop(Loop::Once, 1).play();
        auto owner = std::this_thread::get_id();
        events.addEventListener("finished", [](const MixerEvent&, void* context) {
            CHECK(std::this_thread::get_id() == *static_cast<std::thread::id*>(context));
            throw std::runtime_error("worker listener");
        }, &owner);
        bool threw = false; try { events.update(1); } catch (const std::runtime_error&) { threw = true; }
        CHECK(threw && !finished->pendingAnimation);
        CHECK(events.workerEvaluations() == (enabled[0] == '1' ? 1u : 0u));
        return finished->position.x;
    };
    // Eager execution supplies the oracle, including disabling a non-clamped completed action.
    const auto eagerOnce = onceResult("0", false), eagerClamped = onceResult("0", true);
    CHECK(onceResult("1", false) == eagerOnce);
    CHECK(onceResult("1", true) == eagerClamped);
    auto parent = std::make_shared<Object3D>(); auto child = bone(); child->name = "child"; parent->add(*child);
    AnimationMixer lifetime(parent); lifetime.clipAction(std::make_shared<AnimationClip>("child", 1, std::vector<KeyframeTrack>{
        KeyframeTrack("child.position", TrackType::Vector, {0, 1}, {0, 0, 0, 1, 0, 0})}))->play();
    lifetime.update(0.25); std::weak_ptr<Bone> weak = child; parent->remove(*child); child.reset();
    CHECK(!weak.expired()); lifetime.joinEvaluation(); CHECK(weak.expired());
}
void workerOwnership() {
    WorkerEnvironment environment;
    auto bone = std::make_shared<Bone>(); bone->enableTrackedTransform(); CHECK(bone->enableDeferredTransform());
    auto clip = std::make_shared<AnimationClip>("owned", 2, std::vector<KeyframeTrack>{
        KeyframeTrack(".position", TrackType::Vector, {0, 1}, {0, 0, 0, 10, 0, 0})});
    {
        AnimationMixer earlier(bone); earlier.clipAction(clip)->play(); earlier.update(0.25);
        const double later[] = {99, 0, 0}; PropertyBinding external(bone, ".position"); external.setValue(later, 0);
        bone->materializeLocalTransform(); CHECK(bone->position.x == 99 && earlier.workerEvaluations() == 1);
    }
    bone = std::make_shared<Bone>(); bone->enableTrackedTransform(); CHECK(bone->enableDeferredTransform());
    AnimationMixer mixer(bone); mixer.clipAction(clip)->play(); mixer.update(0.25); CHECK(bone->pendingAnimation);
    bool rejected = false;
    std::thread wrongOwner([&] { try { mixer.joinEvaluation(); } catch (const std::logic_error&) { rejected = true; } });
    wrongOwner.join(); CHECK(rejected && bone->pendingAnimation);
    rejected = false;
    std::thread wrongReader([&] { try { bone->materializeLocalTransform(); } catch (const std::logic_error&) { rejected = true; } });
    wrongReader.join(); CHECK(rejected && bone->pendingAnimation);
    mixer.joinEvaluation();
    // Snapshot old bound spans, then mutate them while the worker owns a separate immutable copy.
    mixer.update(0); clip->tracks[0].times[1] = 2; clip->tracks[0].values[3] = 40;
    mixer.joinEvaluation(); bone->materializeLocalTransform(); CHECK(bone->position.x == 2.5);
    mixer.update(0.25); mixer.joinEvaluation(); bone->materializeLocalTransform(); CHECK(bone->position.x == 10);
    // Queued work survives replacement; a later update rejects changed storage before reading it.
    mixer.update(0.25);
    auto oldTimes = std::move(clip->tracks[0].times), oldValues = std::move(clip->tracks[0].values);
    clip->tracks[0].times = {0, 1, 2}; clip->tracks[0].values = {900, 0, 0, 900, 0, 0, 900, 0, 0};
    mixer.joinEvaluation(); bone->materializeLocalTransform(); CHECK(bone->position.x == 15);
    rejected = false; try { mixer.update(0.25); } catch (const std::logic_error&) { rejected = true; }
    CHECK(rejected && !bone->pendingAnimation);
    oldTimes.clear(); oldTimes.shrink_to_fit(); oldValues.clear(); oldValues.shrink_to_fit();
    rejected = false; try { mixer.update(0.25); } catch (const std::logic_error&) { rejected = true; }
    CHECK(rejected && !bone->pendingAnimation); // no memcmp/eager evaluation of freed original storage
    auto channel = std::make_shared<Bone>(); channel->enableTrackedTransform();
    AnimationMixer scalar(channel); scalar.clipAction(std::make_shared<AnimationClip>("channel", 1, std::vector<KeyframeTrack>{
        KeyframeTrack(".position[x]", TrackType::Number, {0, 1}, {0, 10})}))->play();
    scalar.update(0.25); CHECK(channel->position.x == 2.5 && !channel->pendingAnimation && scalar.workerEvaluations() == 0);
}

#endif

void mixer() {
#ifndef __EMSCRIPTEN__
    workerReplay(); workerReads(); workerOwnership();
#endif
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

TN_TEST_MAIN({"mixer", mixer}, {"events", events}, {"track_hot_fields", track_hot_fields})
