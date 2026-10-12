#pragma once

#include <cstddef>
#include <cstdint>
#include <limits>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "engine/animation/interpolant.h"
#include "engine/animation/property_binding.h"

namespace tn::engine::animation {

// three's constants, by meaning: LoopOnce/LoopRepeat/LoopPingPong and the two blend modes.
enum class Loop { Once, Repeat, PingPong };
enum class BlendMode { Normal, Additive };
/** A track's ValueTypeName. String tracks are not carried yet. */
enum class TrackType { Number, Vector, Quaternion, Color, Bool };

/**
 * three's Number, Vector, Quaternion, Color and BooleanKeyframeTrack. Times and values are stored as
 * three stores them: float32 (each entry is that float's exact double), except a boolean track's
 * values, a plain array of true and false, held here as 1 and 0.
 */
struct KeyframeTrack {
    KeyframeTrack(std::string name, TrackType type, const std::vector<double>& times, const std::vector<double>& values,
                  Interpolation interpolation = Interpolation::Linear);

    std::string name;
    TrackType type;
    std::vector<double> times, values;
    /** What createInterpolant builds: a quaternion track's Linear is QuaternionLinear and its
     * Smooth falls back to Linear; a boolean track is always Discrete, as three's setInterpolation
     * falls back to each track's default. */
    Interpolation interpolation;

    [[nodiscard]] std::size_t valueSize() const { return values.size() / times.size(); }
    [[nodiscard]] std::unique_ptr<Interpolant> createInterpolant() const;
};

/** three's AnimationClip: a negative duration is replaced by the last key time of any track. */
struct AnimationClip {
    AnimationClip(std::string name, double duration, std::vector<KeyframeTrack> tracks,
                  BlendMode blendMode = BlendMode::Normal);
    AnimationClip& resetDuration();

    std::string name;
    std::vector<KeyframeTrack> tracks;
    double duration;
    BlendMode blendMode;
};

/** three's PropertyMixer: the per-property accumulation buffer the mixer blends actions into. */
class PropertyMixer {
  public:
    PropertyMixer(PropertyBinding binding, TrackType type, std::size_t valueSize);

    void accumulate(int accuIndex, double weight);
    void accumulateAdditive(double weight);
    void apply(int accuIndex);
    void saveOriginalState();
    void restoreOriginalState();

    PropertyBinding binding;
    const std::size_t valueSize;
    std::vector<double> buffer;
    double cumulativeWeight = 0, cumulativeWeightAdditive = 0;
    int useCount = 0, referenceCount = 0;
    std::optional<std::size_t> cacheIndex;
    const Object3D* rootKey = nullptr; // three keys bindings by root uuid; the root is the key here

  private:
    void select(std::size_t dst, std::size_t src, double t);
    void mix(std::size_t dst, std::size_t src, double t);
    void mixAdditive(std::size_t dst, std::size_t src, double t);
    void setIdentity();

    TrackType type_;
    static constexpr std::size_t kOrigIndex = 3, kAddIndex = 4, kWorkIndex = 5;
};

class AnimationMixer;

/** A mixer event, three's shape: `finished` carries the direction, `loop` the loop delta. */
struct MixerEvent {
    std::string_view type;
    class AnimationAction* action = nullptr;
    int direction = 0;
    double loopDelta = 0;
};

/** The interpolant a fade or a warp runs on: two float32 keys, like three's control interpolants. */
struct ControlInterpolant {
    ControlInterpolant();
    void set(double time0, double value0, double time1, double value1);
    double times[2] = {0, 0};
    double values[2] = {0, 0};
    Interpolant interpolant;
    std::size_t cacheIndex = 0;
};

/** three's AnimationAction. Fields and methods keep three's names; the mixer owns every action. */
class AnimationAction {
  public:
    AnimationAction(AnimationMixer& mixer, std::shared_ptr<const AnimationClip> clip,
                    std::shared_ptr<Object3D> localRoot, BlendMode blendMode);

    AnimationAction& play();
    AnimationAction& stop();
    AnimationAction& reset();
    [[nodiscard]] bool isRunning() const;
    [[nodiscard]] bool isScheduled() const;
    AnimationAction& startAt(double time);
    AnimationAction& setLoop(Loop mode, double repetitions);
    AnimationAction& setEffectiveWeight(double weight);
    [[nodiscard]] double getEffectiveWeight() const { return effectiveWeight_; }
    AnimationAction& fadeIn(double duration);
    AnimationAction& fadeOut(double duration);
    AnimationAction& crossFadeFrom(AnimationAction& fadeOutAction, double duration, bool warp = false);
    AnimationAction& crossFadeTo(AnimationAction& fadeInAction, double duration, bool warp = false);
    AnimationAction& stopFading();
    AnimationAction& setEffectiveTimeScale(double timeScale);
    [[nodiscard]] double getEffectiveTimeScale() const { return effectiveTimeScale_; }
    AnimationAction& setDuration(double duration);
    AnimationAction& syncWith(const AnimationAction& action);
    AnimationAction& halt(double duration);
    AnimationAction& warp(double startTimeScale, double endTimeScale, double duration);
    AnimationAction& stopWarping();
    [[nodiscard]] const AnimationClip& getClip() const { return *clip_; }
    /** The clip as the action shares it, for a binding that answers the caller's own clip object. */
    [[nodiscard]] const std::shared_ptr<const AnimationClip>& clip() const { return clip_; }
    [[nodiscard]] Object3D& getRoot() const;

    BlendMode blendMode;
    Loop loop = Loop::Repeat;
    double time = 0;
    double timeScale = 1;
    double weight = 1;
    double repetitions = std::numeric_limits<double>::infinity();
    bool paused = false;
    bool enabled = true;
    bool clampWhenFinished = false;
    bool zeroSlopeAtStart = true;
    bool zeroSlopeAtEnd = true;

  private:
    friend class AnimationMixer;

    void update(double time, double deltaTime, double timeDirection, int accuIndex);
    double updateWeight(double time);
    double updateTimeScale(double time);
    double updateTime(double deltaTime);
    void setEndings(bool atStart, bool atEnd, bool pingPong);
    AnimationAction& scheduleFading(double duration, double weightNow, double weightThen);

    AnimationMixer& mixer_;
    std::shared_ptr<const AnimationClip> clip_;
    std::shared_ptr<Object3D> localRoot_;
    std::shared_ptr<InterpolantSettings> interpolantSettings_ = std::make_shared<InterpolantSettings>();
    std::vector<std::unique_ptr<Interpolant>> interpolants_;
    std::vector<PropertyMixer*> propertyBindings_;
    std::optional<std::size_t> cacheIndex_, byClipCacheIndex_;
    ControlInterpolant* timeScaleInterpolant_ = nullptr;
    std::optional<double> restoreTimeScale_;
    ControlInterpolant* weightInterpolant_ = nullptr;
    double loopCount_ = -1;
    std::optional<double> startTime_;
    double effectiveTimeScale_ = 1;
    double effectiveWeight_ = 1;
};

/**
 * three's AnimationMixer, cache for cache: the active actions and bindings are the front of their
 * lists and move by the same swaps, so actions accumulate in three's order and blend to three's
 * bits. Clips and roots are keyed by identity, where three keys them by uuid, in insertion order
 * like a JavaScript object's keys.
 *
 * ponytail: the mixer owns every action, binding and control interpolant it ever made until it is
 * destroyed (three lets the collector take uncached ones); a game that churns clips grows it.
 */
class AnimationMixer {
  public:
    explicit AnimationMixer(std::shared_ptr<Object3D> root);
    ~AnimationMixer();
    AnimationMixer(const AnimationMixer&) = delete;
    AnimationMixer& operator=(const AnimationMixer&) = delete;

    /** three's clipAction by clip object; null for a clip whose track the engine refuses. */
    AnimationAction* clipAction(const std::shared_ptr<const AnimationClip>& clip,
                                const std::shared_ptr<Object3D>& optionalRoot = nullptr,
                                std::optional<BlendMode> blendMode = std::nullopt);
    AnimationAction* existingAction(const AnimationClip& clip, const Object3D* optionalRoot = nullptr) const;
    AnimationMixer& stopAllAction();
    AnimationMixer& update(double deltaTime);
    AnimationMixer& setTime(double time);
    [[nodiscard]] Object3D& getRoot() const { return *root_; }
    /** Every `update` so far, explicit or scheduled (`setTime` is one): what the schedule reads. */
    [[nodiscard]] std::uint64_t updateCount() const { return updateCount_; }
    void uncacheClip(const AnimationClip& clip);
    void uncacheRoot(const Object3D& root);
    void uncacheAction(const AnimationClip& clip, const Object3D* optionalRoot = nullptr);

    using Listener = void (*)(const MixerEvent& event, void* context);
    void addEventListener(std::string_view type, Listener listener, void* context);
    void removeEventListener(std::string_view type, Listener listener, void* context);

    double time = 0;
    double timeScale = 1;
    /** Owned for a language binding that listens to this mixer's events; dies with the mixer. */
    std::shared_ptr<void> languageListeners;

    // three's `stats`.
    [[nodiscard]] std::size_t actionsTotal() const { return actions_.size(); }
    [[nodiscard]] std::size_t actionsInUse() const { return nActiveActions_; }
    [[nodiscard]] std::size_t bindingsTotal() const { return bindings_.size(); }
    [[nodiscard]] std::size_t bindingsInUse() const { return nActiveBindings_; }
    [[nodiscard]] std::size_t controlInterpolantsTotal() const { return controlInterpolants_.size(); }
    [[nodiscard]] std::size_t controlInterpolantsInUse() const { return nActiveControlInterpolants_; }

  private:
    friend class AnimationAction;

    struct ActionsForClip {
        const AnimationClip* clip;
        std::vector<AnimationAction*> knownActions;
        std::vector<std::pair<const Object3D*, AnimationAction*>> actionByRoot;
    };
    struct BindingsForRoot {
        const Object3D* root;
        std::vector<std::pair<std::string, PropertyMixer*>> byName;
    };

    void bindAction(AnimationAction& action, AnimationAction* prototypeAction);
    void activateAction(AnimationAction& action);
    void deactivateAction(AnimationAction& action);
    [[nodiscard]] bool isActiveAction(const AnimationAction& action) const;
    void addInactiveAction(AnimationAction& action, const AnimationClip* clip, const Object3D* root);
    void removeInactiveAction(AnimationAction& action);
    void removeInactiveBindingsForAction(AnimationAction& action);
    void lendAction(AnimationAction& action);
    void takeBackAction(AnimationAction& action);
    void addInactiveBinding(PropertyMixer& binding, const Object3D* root, const std::string& trackName);
    void removeInactiveBinding(PropertyMixer& binding);
    void lendBinding(PropertyMixer& binding);
    void takeBackBinding(PropertyMixer& binding);
    ControlInterpolant* lendControlInterpolant();
    void takeBackControlInterpolant(ControlInterpolant* interpolant);
    void dispatchEvent(const MixerEvent& event);
    ActionsForClip* actionsFor(const AnimationClip* clip);
    BindingsForRoot* bindingsFor(const Object3D* root);

    std::shared_ptr<Object3D> root_;
    int accuIndex_ = 0;
    std::uint64_t updateCount_ = 0;
    bool updating_ = false;
    std::vector<MixerEvent> pendingEvents_;  // dispatched once update()'s loops finish
    std::vector<AnimationAction*> actions_;
    std::size_t nActiveActions_ = 0;
    std::vector<ActionsForClip> actionsByClip_;
    std::vector<PropertyMixer*> bindings_;
    std::size_t nActiveBindings_ = 0;
    std::vector<BindingsForRoot> bindingsByRootAndName_;
    std::vector<ControlInterpolant*> controlInterpolants_;
    std::size_t nActiveControlInterpolants_ = 0;
    std::vector<std::unique_ptr<AnimationAction>> ownedActions_;
    std::vector<std::unique_ptr<PropertyMixer>> ownedBindings_;
    std::vector<std::unique_ptr<ControlInterpolant>> ownedControls_;
    struct ListenerEntry {
        std::string type;
        Listener listener;
        void* context;
    };
    std::vector<ListenerEntry> listeners_;
};

} // namespace tn::engine::animation
