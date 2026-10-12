#include "engine/animation/mixer.h"

#include <algorithm>
#include <cmath>
#include <cstdint>

namespace tn::engine::animation {

namespace {

double float32(double x) { return static_cast<double>(static_cast<float>(x)); }

std::vector<double> float32s(const std::vector<double>& in) {
    std::vector<double> out(in.size());
    std::transform(in.begin(), in.end(), out.begin(), float32);
    return out;
}

// JavaScript's `x & 1` on a number: ToInt32, then the low bit.
bool odd(double x) {
    const double m = std::fmod(std::trunc(x), 4294967296.0);
    return (static_cast<int64_t>(m < 0 ? m + 4294967296.0 : m) & 1) == 1;
}

template <typename T, typename Key> auto findKey(std::vector<std::pair<Key, T>>& entries, const Key& key) {
    return std::find_if(entries.begin(), entries.end(), [&](const auto& e) { return e.first == key; });
}

} // namespace

// ---- tracks and clips

KeyframeTrack::KeyframeTrack(std::string trackName, TrackType trackType, const std::vector<double>& keyTimes,
                             const std::vector<double>& keyValues, Interpolation mode)
    : name(std::move(trackName)), type(trackType), times(float32s(keyTimes)),
      values(trackType == TrackType::Bool ? keyValues : float32s(keyValues)) {
    if (type == TrackType::Bool)
        interpolation = Interpolation::Discrete;
    else if (type == TrackType::Quaternion)
        interpolation = mode == Interpolation::Discrete ? Interpolation::Discrete : Interpolation::QuaternionLinear;
    else
        interpolation = mode == Interpolation::QuaternionLinear ? Interpolation::Linear : mode;
}

std::unique_ptr<Interpolant> KeyframeTrack::createInterpolant() const {
    return std::make_unique<Interpolant>(interpolation, times, values, valueSize());
}

AnimationClip::AnimationClip(std::string clipName, double clipDuration, std::vector<KeyframeTrack> clipTracks,
                             BlendMode mode)
    : name(std::move(clipName)), tracks(std::move(clipTracks)), duration(clipDuration), blendMode(mode) {
    if (duration < 0)
        resetDuration();
}

AnimationClip& AnimationClip::resetDuration() {
    double d = 0;
    for (const KeyframeTrack& track : tracks)
        d = std::max(d, track.times.back());
    duration = d;
    return *this;
}

// ---- PropertyMixer

PropertyMixer::PropertyMixer(PropertyBinding propertyBinding, TrackType type, std::size_t size)
    : binding(std::move(propertyBinding)), valueSize(size), buffer(size * (type == TrackType::Quaternion ? 6 : 5), 0.0),
      type_(type) {}

// three's _select: a boolean property takes the source whole once its share reaches one half.
void PropertyMixer::select(std::size_t dst, std::size_t src, double t) {
    if (t >= 0.5)
        for (std::size_t i = 0; i != valueSize; ++i)
            buffer[dst + i] = buffer[src + i];
}

void PropertyMixer::mix(std::size_t dst, std::size_t src, double t) {
    if (type_ == TrackType::Bool)
        return select(dst, src, t);
    if (type_ == TrackType::Quaternion) {
        slerpFlat(&buffer[dst], &buffer[dst], &buffer[src], t);
        return;
    }
    const double s = 1 - t;
    for (std::size_t i = 0; i != valueSize; ++i)
        buffer[dst + i] = buffer[dst + i] * s + buffer[src + i] * t;
}

void PropertyMixer::mixAdditive(std::size_t dst, std::size_t src, double t) {
    if (type_ == TrackType::Bool)
        return select(dst, src, t);
    if (type_ == TrackType::Quaternion) {
        const std::size_t work = kWorkIndex * valueSize;
        multiplyQuaternionsFlat(&buffer[work], &buffer[dst], &buffer[src]);
        slerpFlat(&buffer[dst], &buffer[dst], &buffer[work], t);
        return;
    }
    for (std::size_t i = 0; i != valueSize; ++i)
        buffer[dst + i] = buffer[dst + i] + buffer[src + i] * t;
}

void PropertyMixer::setIdentity() {
    if (type_ == TrackType::Bool) { // _setAdditiveIdentityOther: the original value
        for (std::size_t i = 0; i < valueSize; ++i)
            buffer[kAddIndex * valueSize + i] = buffer[kOrigIndex * valueSize + i];
        return;
    }
    const std::size_t start = kAddIndex * valueSize;
    for (std::size_t i = start; i < start + valueSize; ++i)
        buffer[i] = 0;
    if (type_ == TrackType::Quaternion)
        buffer[start + 3] = 1;
}

void PropertyMixer::accumulate(int accuIndex, double weight) {
    const std::size_t stride = valueSize, offset = static_cast<std::size_t>(accuIndex) * stride + stride;
    double currentWeight = cumulativeWeight;
    if (currentWeight == 0) {
        for (std::size_t i = 0; i != stride; ++i)
            buffer[offset + i] = buffer[i];
        currentWeight = weight;
    } else {
        currentWeight += weight;
        mix(offset, 0, weight / currentWeight);
    }
    cumulativeWeight = currentWeight;
}

void PropertyMixer::accumulateAdditive(double weight) {
    if (cumulativeWeightAdditive == 0)
        setIdentity();
    mixAdditive(valueSize * kAddIndex, 0, weight);
    cumulativeWeightAdditive += weight;
}

void PropertyMixer::apply(int accuIndex) {
    const std::size_t stride = valueSize, offset = static_cast<std::size_t>(accuIndex) * stride + stride;
    const double weight = cumulativeWeight, weightAdditive = cumulativeWeightAdditive;
    cumulativeWeight = 0;
    cumulativeWeightAdditive = 0;
    if (weight < 1)
        mix(offset, stride * kOrigIndex, 1 - weight);
    if (weightAdditive > 0)
        mixAdditive(offset, kAddIndex * stride, 1);
    for (std::size_t i = stride, e = stride + stride; i != e; ++i) {
        if (buffer[i] != buffer[i + stride]) {
            binding.setValue(buffer.data(), offset);
            break;
        }
    }
}

void PropertyMixer::saveOriginalState() {
    const std::size_t stride = valueSize, originalValueOffset = stride * kOrigIndex;
    binding.getValue(buffer.data(), originalValueOffset);
    for (std::size_t i = stride, e = originalValueOffset; i != e; ++i)
        buffer[i] = buffer[originalValueOffset + (i % stride)];
    setIdentity();
    cumulativeWeight = 0;
    cumulativeWeightAdditive = 0;
}

void PropertyMixer::restoreOriginalState() { binding.setValue(buffer.data(), valueSize * 3); }

// ---- control interpolants

ControlInterpolant::ControlInterpolant() : interpolant(Interpolation::Linear, times, values, 1) {}

void ControlInterpolant::set(double time0, double value0, double time1, double value1) {
    times[0] = float32(time0);
    values[0] = float32(value0);
    times[1] = float32(time1);
    values[1] = float32(value1);
}

// ---- AnimationAction

AnimationAction::AnimationAction(AnimationMixer& mixer, std::shared_ptr<const AnimationClip> clip,
                                 std::shared_ptr<Object3D> localRoot, BlendMode mode)
    : blendMode(mode), mixer_(mixer), clip_(std::move(clip)), localRoot_(std::move(localRoot)) {
    for (const KeyframeTrack& track : clip_->tracks) {
        interpolants_.push_back(track.createInterpolant());
        interpolants_.back()->settings = interpolantSettings_;
    }
    propertyBindings_.assign(clip_->tracks.size(), nullptr);
}

Object3D& AnimationAction::getRoot() const { return localRoot_ ? *localRoot_ : *mixer_.root_; }

AnimationAction& AnimationAction::play() {
    mixer_.activateAction(*this);
    return *this;
}

AnimationAction& AnimationAction::stop() {
    mixer_.deactivateAction(*this);
    return reset();
}

AnimationAction& AnimationAction::reset() {
    paused = false;
    enabled = true;
    time = 0;
    loopCount_ = -1;
    startTime_.reset();
    return stopFading().stopWarping();
}

bool AnimationAction::isRunning() const {
    return enabled && !paused && timeScale != 0 && !startTime_ && mixer_.isActiveAction(*this);
}

bool AnimationAction::isScheduled() const { return mixer_.isActiveAction(*this); }

AnimationAction& AnimationAction::startAt(double t) {
    startTime_ = t;
    return *this;
}

AnimationAction& AnimationAction::setLoop(Loop mode, double count) {
    loop = mode;
    repetitions = count;
    return *this;
}

AnimationAction& AnimationAction::setEffectiveWeight(double w) {
    weight = w;
    effectiveWeight_ = enabled ? w : 0;
    return stopFading();
}

AnimationAction& AnimationAction::fadeIn(double duration) { return scheduleFading(duration, 0, 1); }
AnimationAction& AnimationAction::fadeOut(double duration) { return scheduleFading(duration, 1, 0); }

AnimationAction& AnimationAction::crossFadeFrom(AnimationAction& fadeOutAction, double duration, bool warpTime) {
    fadeOutAction.fadeOut(duration);
    fadeIn(duration);
    if (warpTime) {
        const double fadeInDuration = clip_->duration, fadeOutDuration = fadeOutAction.clip_->duration;
        const double startEndRatio = fadeOutDuration / fadeInDuration, endStartRatio = fadeInDuration / fadeOutDuration;
        fadeOutAction.restoreTimeScale_ = fadeOutAction.timeScale;
        restoreTimeScale_ = timeScale;
        fadeOutAction.warp(1.0, startEndRatio, duration);
        warp(endStartRatio, 1.0, duration);
    }
    return *this;
}

AnimationAction& AnimationAction::crossFadeTo(AnimationAction& fadeInAction, double duration, bool warpTime) {
    return fadeInAction.crossFadeFrom(*this, duration, warpTime);
}

AnimationAction& AnimationAction::stopFading() {
    if (ControlInterpolant* interpolant = weightInterpolant_) {
        weightInterpolant_ = nullptr;
        mixer_.takeBackControlInterpolant(interpolant);
    }
    return *this;
}

AnimationAction& AnimationAction::setEffectiveTimeScale(double scale) {
    timeScale = scale;
    effectiveTimeScale_ = paused ? 0 : scale;
    return stopWarping();
}

AnimationAction& AnimationAction::setDuration(double duration) {
    timeScale = clip_->duration / duration;
    return stopWarping();
}

AnimationAction& AnimationAction::syncWith(const AnimationAction& action) {
    time = action.time;
    timeScale = action.timeScale;
    return stopWarping();
}

AnimationAction& AnimationAction::halt(double duration) { return warp(effectiveTimeScale_, 0, duration); }

AnimationAction& AnimationAction::warp(double startTimeScale, double endTimeScale, double duration) {
    const double now = mixer_.time;
    if (!timeScaleInterpolant_)
        timeScaleInterpolant_ = mixer_.lendControlInterpolant();
    timeScaleInterpolant_->set(now, startTimeScale / timeScale, now + duration, endTimeScale / timeScale);
    return *this;
}

AnimationAction& AnimationAction::stopWarping() {
    if (ControlInterpolant* interpolant = timeScaleInterpolant_) {
        timeScaleInterpolant_ = nullptr;
        mixer_.takeBackControlInterpolant(interpolant);
    }
    restoreTimeScale_.reset();
    return *this;
}

void AnimationAction::update(double t, double deltaTime, double timeDirection, int accuIndex) {
    if (!enabled) {
        updateWeight(t);
        return;
    }
    if (startTime_) {
        const double timeRunning = (t - *startTime_) * timeDirection;
        if (timeRunning < 0 || timeDirection == 0) {
            deltaTime = 0;
        } else {
            startTime_.reset();
            deltaTime = timeDirection * timeRunning;
        }
    }
    deltaTime *= updateTimeScale(t);
    const double clipTime = updateTime(deltaTime);
    const double w = updateWeight(t);
    if (w > 0) {
        if (blendMode == BlendMode::Additive) {
            for (std::size_t j = 0; j != interpolants_.size(); ++j) {
                interpolants_[j]->evaluate(clipTime);
                propertyBindings_[j]->accumulateAdditive(w);
            }
        } else {
            for (std::size_t j = 0; j != interpolants_.size(); ++j) {
                interpolants_[j]->evaluate(clipTime);
                propertyBindings_[j]->accumulate(accuIndex, w);
            }
        }
    }
}

double AnimationAction::updateWeight(double t) {
    double w = 0;
    if (enabled) {
        w = weight;
        if (ControlInterpolant* interpolant = weightInterpolant_) {
            const double interpolantValue = interpolant->interpolant.evaluate(t)[0];
            w *= interpolantValue;
            if (t > interpolant->times[1]) {
                stopFading();
                if (interpolantValue == 0)
                    enabled = false;
            }
        }
    }
    effectiveWeight_ = w;
    return w;
}

double AnimationAction::updateTimeScale(double t) {
    double scale = 0;
    if (!paused) {
        scale = timeScale;
        if (ControlInterpolant* interpolant = timeScaleInterpolant_) {
            const double interpolantValue = interpolant->interpolant.evaluate(t)[0];
            scale *= interpolantValue;
            if (t > interpolant->times[1]) {
                if (scale == 0) {
                    paused = true;
                } else {
                    if (restoreTimeScale_)
                        scale = *restoreTimeScale_;
                    timeScale = scale;
                }
                stopWarping();
            }
        }
    }
    effectiveTimeScale_ = scale;
    return scale;
}

double AnimationAction::updateTime(double deltaTime) {
    const double duration = clip_->duration;
    double t = time + deltaTime;
    double loopCount = loopCount_;
    const bool pingPong = loop == Loop::PingPong;
    if (deltaTime == 0) {
        if (loopCount == -1)
            return t;
        return pingPong && odd(loopCount) ? duration - t : t;
    }
    if (loop == Loop::Once) {
        if (loopCount == -1) {
            loopCount_ = 0;
            setEndings(true, true, false);
        }
        if (t >= duration) {
            t = duration;
        } else if (t < 0) {
            t = 0;
        } else {
            time = t;
            return t; // break handle_stop
        }
        if (clampWhenFinished)
            paused = true;
        else
            enabled = false;
        time = t;
        mixer_.dispatchEvent({"finished", this, deltaTime < 0 ? -1 : 1, 0});
        return t;
    }
    if (loopCount == -1) {
        if (deltaTime >= 0) {
            loopCount = 0;
            setEndings(true, repetitions == 0, pingPong);
        } else {
            setEndings(repetitions == 0, true, pingPong);
        }
    }
    if (t >= duration || t < 0) {
        const double loopDelta = std::floor(t / duration);
        t -= duration * loopDelta;
        loopCount += std::abs(loopDelta);
        const double pending = repetitions - loopCount;
        if (pending <= 0) {
            if (clampWhenFinished)
                paused = true;
            else
                enabled = false;
            t = deltaTime > 0 ? duration : 0;
            time = t;
            mixer_.dispatchEvent({"finished", this, deltaTime > 0 ? 1 : -1, 0});
        } else {
            if (pending == 1) {
                const bool atStart = deltaTime < 0;
                setEndings(atStart, !atStart, pingPong);
            } else {
                setEndings(false, false, pingPong);
            }
            loopCount_ = loopCount;
            time = t;
            mixer_.dispatchEvent({"loop", this, 0, loopDelta});
        }
    } else {
        loopCount_ = loopCount;
        time = t;
    }
    if (pingPong && odd(loopCount))
        return duration - t;
    return t;
}

void AnimationAction::setEndings(bool atStart, bool atEnd, bool pingPong) {
    InterpolantSettings& settings = *interpolantSettings_;
    if (pingPong) {
        settings.endingStart = Ending::ZeroSlope;
        settings.endingEnd = Ending::ZeroSlope;
        return;
    }
    settings.endingStart =
        atStart ? (zeroSlopeAtStart ? Ending::ZeroSlope : Ending::ZeroCurvature) : Ending::WrapAround;
    settings.endingEnd = atEnd ? (zeroSlopeAtEnd ? Ending::ZeroSlope : Ending::ZeroCurvature) : Ending::WrapAround;
}

AnimationAction& AnimationAction::scheduleFading(double duration, double weightNow, double weightThen) {
    const double now = mixer_.time;
    if (!weightInterpolant_)
        weightInterpolant_ = mixer_.lendControlInterpolant();
    weightInterpolant_->set(now, weightNow, now + duration, weightThen);
    return *this;
}

// ---- AnimationMixer

AnimationMixer::AnimationMixer(std::shared_ptr<Object3D> root) : root_(std::move(root)) {}
AnimationMixer::~AnimationMixer() = default;

AnimationMixer::ActionsForClip* AnimationMixer::actionsFor(const AnimationClip* clip) {
    for (ActionsForClip& entry : actionsByClip_)
        if (entry.clip == clip)
            return &entry;
    return nullptr;
}

AnimationMixer::BindingsForRoot* AnimationMixer::bindingsFor(const Object3D* root) {
    for (BindingsForRoot& entry : bindingsByRootAndName_)
        if (entry.root == root)
            return &entry;
    return nullptr;
}

void AnimationMixer::bindAction(AnimationAction& action, AnimationAction* /*prototypeAction*/) {
    const std::shared_ptr<Object3D> root = action.localRoot_ ? action.localRoot_ : root_;
    const auto& tracks = action.clip_->tracks;
    if (!bindingsFor(root.get()))
        bindingsByRootAndName_.push_back({root.get(), {}});
    for (std::size_t i = 0; i != tracks.size(); ++i) {
        const KeyframeTrack& track = tracks[i];
        BindingsForRoot* byName = bindingsFor(root.get()); // created above; nothing removes it while binding
        auto found = findKey(byName->byName, track.name);
        PropertyMixer* binding = found != byName->byName.end() ? found->second : nullptr;
        if (binding) {
            ++binding->referenceCount;
            action.propertyBindings_[i] = binding;
        } else {
            binding = action.propertyBindings_[i];
            if (binding) {
                if (!binding->cacheIndex) {
                    ++binding->referenceCount;
                    addInactiveBinding(*binding, root.get(), track.name);
                }
                continue;
            }
            ownedBindings_.push_back(
                std::make_unique<PropertyMixer>(PropertyBinding(root, track.name), track.type, track.valueSize()));
            binding = ownedBindings_.back().get();
            binding->rootKey = root.get();
            ++binding->referenceCount;
            addInactiveBinding(*binding, root.get(), track.name);
            action.propertyBindings_[i] = binding;
        }
        action.interpolants_[i]->setResultBuffer(binding->buffer.data());
    }
}

void AnimationMixer::activateAction(AnimationAction& action) {
    if (isActiveAction(action))
        return;
    if (!action.cacheIndex_) {
        const Object3D* root = action.localRoot_ ? action.localRoot_.get() : root_.get();
        ActionsForClip* forClip = actionsFor(action.clip_.get());
        bindAction(action, forClip ? forClip->knownActions[0] : nullptr);
        addInactiveAction(action, action.clip_.get(), root);
    }
    for (PropertyMixer* binding : action.propertyBindings_) {
        if (binding->useCount++ == 0) {
            lendBinding(*binding);
            binding->saveOriginalState();
        }
    }
    lendAction(action);
}

void AnimationMixer::deactivateAction(AnimationAction& action) {
    if (!isActiveAction(action))
        return;
    for (PropertyMixer* binding : action.propertyBindings_) {
        if (--binding->useCount == 0) {
            binding->restoreOriginalState();
            takeBackBinding(*binding);
        }
    }
    takeBackAction(action);
}

bool AnimationMixer::isActiveAction(const AnimationAction& action) const {
    return action.cacheIndex_ && *action.cacheIndex_ < nActiveActions_;
}

void AnimationMixer::addInactiveAction(AnimationAction& action, const AnimationClip* clip, const Object3D* root) {
    ActionsForClip* forClip = actionsFor(clip);
    if (!forClip) {
        actionsByClip_.push_back({clip, {&action}, {}});
        action.byClipCacheIndex_ = 0;
        forClip = &actionsByClip_.back();
    } else {
        action.byClipCacheIndex_ = forClip->knownActions.size();
        forClip->knownActions.push_back(&action);
    }
    action.cacheIndex_ = actions_.size();
    actions_.push_back(&action);
    if (auto it = findKey(forClip->actionByRoot, root); it != forClip->actionByRoot.end())
        it->second = &action;
    else
        forClip->actionByRoot.emplace_back(root, &action);
}

void AnimationMixer::removeInactiveAction(AnimationAction& action) {
    AnimationAction* lastInactiveAction = actions_.back();
    const std::size_t cacheIndex = *action.cacheIndex_;
    lastInactiveAction->cacheIndex_ = cacheIndex;
    actions_[cacheIndex] = lastInactiveAction;
    actions_.pop_back();
    action.cacheIndex_.reset();

    ActionsForClip* forClip = actionsFor(action.clip_.get());
    AnimationAction* lastKnownAction = forClip->knownActions.back();
    const std::size_t byClipCacheIndex = *action.byClipCacheIndex_;
    lastKnownAction->byClipCacheIndex_ = byClipCacheIndex;
    forClip->knownActions[byClipCacheIndex] = lastKnownAction;
    forClip->knownActions.pop_back();
    action.byClipCacheIndex_.reset();
    const Object3D* root = action.localRoot_ ? action.localRoot_.get() : root_.get();
    if (auto it = findKey(forClip->actionByRoot, root); it != forClip->actionByRoot.end())
        forClip->actionByRoot.erase(it);
    if (forClip->knownActions.empty())
        actionsByClip_.erase(actionsByClip_.begin() + (forClip - actionsByClip_.data()));
    removeInactiveBindingsForAction(action);
}

void AnimationMixer::removeInactiveBindingsForAction(AnimationAction& action) {
    for (PropertyMixer* binding : action.propertyBindings_)
        if (--binding->referenceCount == 0)
            removeInactiveBinding(*binding);
}

void AnimationMixer::lendAction(AnimationAction& action) {
    const std::size_t prevIndex = *action.cacheIndex_, lastActiveIndex = nActiveActions_++;
    AnimationAction* firstInactiveAction = actions_[lastActiveIndex];
    action.cacheIndex_ = lastActiveIndex;
    actions_[lastActiveIndex] = &action;
    firstInactiveAction->cacheIndex_ = prevIndex;
    actions_[prevIndex] = firstInactiveAction;
}

void AnimationMixer::takeBackAction(AnimationAction& action) {
    const std::size_t prevIndex = *action.cacheIndex_, firstInactiveIndex = --nActiveActions_;
    AnimationAction* lastActiveAction = actions_[firstInactiveIndex];
    action.cacheIndex_ = firstInactiveIndex;
    actions_[firstInactiveIndex] = &action;
    lastActiveAction->cacheIndex_ = prevIndex;
    actions_[prevIndex] = lastActiveAction;
}

void AnimationMixer::addInactiveBinding(PropertyMixer& binding, const Object3D* root, const std::string& trackName) {
    BindingsForRoot* byName = bindingsFor(root);
    if (!byName) {
        bindingsByRootAndName_.push_back({root, {}});
        byName = &bindingsByRootAndName_.back();
    }
    if (auto it = findKey(byName->byName, trackName); it != byName->byName.end())
        it->second = &binding;
    else
        byName->byName.emplace_back(trackName, &binding);
    binding.cacheIndex = bindings_.size();
    bindings_.push_back(&binding);
}

void AnimationMixer::removeInactiveBinding(PropertyMixer& binding) {
    BindingsForRoot* byName = bindingsFor(binding.rootKey);
    PropertyMixer* lastInactiveBinding = bindings_.back();
    const std::size_t cacheIndex = *binding.cacheIndex;
    lastInactiveBinding->cacheIndex = cacheIndex;
    bindings_[cacheIndex] = lastInactiveBinding;
    bindings_.pop_back();
    // three leaves the index set, so replaying an uncached action throws there; cleared here, the
    // replay rebinds through bindAction's `cacheIndex` check instead.
    binding.cacheIndex.reset();
    if (byName) {
        if (auto it = findKey(byName->byName, binding.binding.path); it != byName->byName.end())
            byName->byName.erase(it);
        if (byName->byName.empty())
            bindingsByRootAndName_.erase(bindingsByRootAndName_.begin() + (byName - bindingsByRootAndName_.data()));
    }
}

void AnimationMixer::lendBinding(PropertyMixer& binding) {
    const std::size_t prevIndex = *binding.cacheIndex, lastActiveIndex = nActiveBindings_++;
    PropertyMixer* firstInactiveBinding = bindings_[lastActiveIndex];
    binding.cacheIndex = lastActiveIndex;
    bindings_[lastActiveIndex] = &binding;
    firstInactiveBinding->cacheIndex = prevIndex;
    bindings_[prevIndex] = firstInactiveBinding;
}

void AnimationMixer::takeBackBinding(PropertyMixer& binding) {
    const std::size_t prevIndex = *binding.cacheIndex, firstInactiveIndex = --nActiveBindings_;
    PropertyMixer* lastActiveBinding = bindings_[firstInactiveIndex];
    binding.cacheIndex = firstInactiveIndex;
    bindings_[firstInactiveIndex] = &binding;
    lastActiveBinding->cacheIndex = prevIndex;
    bindings_[prevIndex] = lastActiveBinding;
}

ControlInterpolant* AnimationMixer::lendControlInterpolant() {
    const std::size_t lastActiveIndex = nActiveControlInterpolants_++;
    if (lastActiveIndex < controlInterpolants_.size())
        return controlInterpolants_[lastActiveIndex];
    ownedControls_.push_back(std::make_unique<ControlInterpolant>());
    ControlInterpolant* interpolant = ownedControls_.back().get();
    interpolant->cacheIndex = lastActiveIndex;
    controlInterpolants_.push_back(interpolant);
    return interpolant;
}

void AnimationMixer::takeBackControlInterpolant(ControlInterpolant* interpolant) {
    const std::size_t prevIndex = interpolant->cacheIndex, firstInactiveIndex = --nActiveControlInterpolants_;
    ControlInterpolant* lastActiveInterpolant = controlInterpolants_[firstInactiveIndex];
    interpolant->cacheIndex = firstInactiveIndex;
    controlInterpolants_[firstInactiveIndex] = interpolant;
    lastActiveInterpolant->cacheIndex = prevIndex;
    controlInterpolants_[prevIndex] = lastActiveInterpolant;
}

AnimationAction* AnimationMixer::clipAction(const std::shared_ptr<const AnimationClip>& clip,
                                            const std::shared_ptr<Object3D>& optionalRoot,
                                            std::optional<BlendMode> blendMode) {
    if (!clip)
        return nullptr;
    const Object3D* root = optionalRoot ? optionalRoot.get() : root_.get();
    const BlendMode mode = blendMode.value_or(clip->blendMode);
    AnimationAction* prototypeAction = nullptr;
    if (ActionsForClip* forClip = actionsFor(clip.get())) {
        if (auto it = findKey(forClip->actionByRoot, root);
            it != forClip->actionByRoot.end() && it->second->blendMode == mode)
            return it->second;
        prototypeAction = forClip->knownActions[0];
    }
    ownedActions_.push_back(std::make_unique<AnimationAction>(*this, clip, optionalRoot, mode));
    AnimationAction& action = *ownedActions_.back();
    bindAction(action, prototypeAction);
    addInactiveAction(action, clip.get(), root);
    return &action;
}

AnimationAction* AnimationMixer::existingAction(const AnimationClip& clip, const Object3D* optionalRoot) const {
    const Object3D* root = optionalRoot ? optionalRoot : root_.get();
    for (const ActionsForClip& entry : actionsByClip_) {
        if (entry.clip != &clip)
            continue;
        for (const auto& [key, action] : entry.actionByRoot)
            if (key == root)
                return action;
        return nullptr;
    }
    return nullptr;
}

AnimationMixer& AnimationMixer::stopAllAction() {
    for (std::size_t i = nActiveActions_; i-- > 0;)
        actions_[i]->stop();
    return *this;
}

AnimationMixer& AnimationMixer::update(double deltaTime) {
    ++updateCount_;
    deltaTime *= timeScale;
    const std::size_t nActions = nActiveActions_;
    const double t = time += deltaTime;
    const double timeDirection = deltaTime > 0 ? 1 : deltaTime < 0 ? -1 : deltaTime; // Math.sign
    const int accuIndex = accuIndex_ ^= 1;
    // Events wait for both loops: a listener that uncaches an action shrinks the lists they walk.
    // Actions live as long as the mixer (ownedActions_), so a queued event's action stays valid.
    updating_ = true;
    for (std::size_t i = 0; i != nActions; ++i)
        actions_[i]->update(t, deltaTime, timeDirection, accuIndex);
    const std::size_t nBindings = nActiveBindings_;
    for (std::size_t i = 0; i != nBindings; ++i)
        bindings_[i]->apply(accuIndex);
    updating_ = false;
    std::vector<MixerEvent> pending;
    pending.swap(pendingEvents_);
    for (const MixerEvent& event : pending)
        dispatchEvent(event);
    return *this;
}

AnimationMixer& AnimationMixer::setTime(double t) {
    time = 0;
    for (AnimationAction* action : actions_)
        action->time = 0;
    return update(t);
}

void AnimationMixer::uncacheClip(const AnimationClip& clip) {
    ActionsForClip* forClip = actionsFor(&clip);
    if (!forClip)
        return;
    const std::vector<AnimationAction*> actionsToRemove = forClip->knownActions;
    for (AnimationAction* action : actionsToRemove) {
        deactivateAction(*action);
        const std::size_t cacheIndex = *action->cacheIndex_;
        AnimationAction* lastInactiveAction = actions_.back();
        action->cacheIndex_.reset();
        action->byClipCacheIndex_.reset();
        lastInactiveAction->cacheIndex_ = cacheIndex;
        actions_[cacheIndex] = lastInactiveAction;
        actions_.pop_back();
        removeInactiveBindingsForAction(*action);
    }
    if ((forClip = actionsFor(&clip)))
        actionsByClip_.erase(actionsByClip_.begin() + (forClip - actionsByClip_.data()));
}

void AnimationMixer::uncacheRoot(const Object3D& root) {
    const std::vector<ActionsForClip> snapshot = actionsByClip_; // `for in` over the keys present at the start
    for (const ActionsForClip& entry : snapshot) {
        ActionsForClip* forClip = actionsFor(entry.clip);
        if (!forClip)
            continue;
        auto it = findKey(forClip->actionByRoot, &root);
        if (it == forClip->actionByRoot.end())
            continue;
        AnimationAction* action = it->second;
        deactivateAction(*action);
        removeInactiveAction(*action);
    }
    if (BindingsForRoot* byName = bindingsFor(&root)) {
        const auto names = byName->byName;
        for (const auto& [trackName, binding] : names) {
            binding->restoreOriginalState();
            removeInactiveBinding(*binding);
        }
    }
}

void AnimationMixer::uncacheAction(const AnimationClip& clip, const Object3D* optionalRoot) {
    if (AnimationAction* action = existingAction(clip, optionalRoot)) {
        deactivateAction(*action);
        removeInactiveAction(*action);
    }
}

void AnimationMixer::addEventListener(std::string_view type, Listener listener, void* context) {
    for (const ListenerEntry& e : listeners_)
        if (e.type == type && e.listener == listener && e.context == context)
            return;
    listeners_.push_back({std::string(type), listener, context});
}

void AnimationMixer::removeEventListener(std::string_view type, Listener listener, void* context) {
    std::erase_if(listeners_, [&](const ListenerEntry& e) {
        return e.type == type && e.listener == listener && e.context == context;
    });
}

void AnimationMixer::dispatchEvent(const MixerEvent& event) {
    if (updating_) {
        pendingEvents_.push_back(event);
        return;
    }
    const std::vector<ListenerEntry> copy = listeners_; // a listener may remove itself while it runs
    for (const ListenerEntry& e : copy)
        if (e.type == event.type)
            e.listener(event, e.context);
}

} // namespace tn::engine::animation
