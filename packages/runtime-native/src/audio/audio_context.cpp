/**
 * Web Audio API Implementation using SDL3
 */

#include "mystral/audio/audio_context.h"
#include <SDL3/SDL.h>
#include <iostream>
#include <cstring>
#include <cmath>
#include <algorithm>
#include <cstdlib>
#include <limits>
#include <vector>

namespace mystral {
namespace audio {

// ============================================================================
// AudioBuffer
// ============================================================================

AudioBuffer::AudioBuffer(float sampleRate, int numberOfChannels, size_t length)
    : sampleRate_(sampleRate)
    , numberOfChannels_(numberOfChannels)
    , length_(length) {
    channelData_.resize(numberOfChannels);
    for (int i = 0; i < numberOfChannels; i++) {
        channelData_[i].resize(length, 0.0f);
    }
}

AudioBuffer::~AudioBuffer() = default;

float* AudioBuffer::getChannelData(int channel) {
    if (channel < 0 || channel >= numberOfChannels_) return nullptr;
    return channelData_[channel].data();
}

const float* AudioBuffer::getChannelData(int channel) const {
    if (channel < 0 || channel >= numberOfChannels_) return nullptr;
    return channelData_[channel].data();
}

void AudioBuffer::setFromInterleaved(const float* data, size_t numSamples, int numChannels) {
    size_t frames = numSamples / numChannels;
    length_ = frames;
    numberOfChannels_ = numChannels;
    channelData_.resize(numChannels);

    for (int ch = 0; ch < numChannels; ch++) {
        channelData_[ch].resize(frames);
        for (size_t i = 0; i < frames; i++) {
            channelData_[ch][i] = data[i * numChannels + ch];
        }
    }
}

// ============================================================================
// AudioParam
// ============================================================================

AudioParam::AudioParam(float defaultValue)
    : startValue_(defaultValue)
    , targetValue_(defaultValue) {}

void AudioParam::setValue(float value) {
    startValue_.store(value, std::memory_order_relaxed);
    targetValue_.store(value, std::memory_order_relaxed);
    automation_.store(Automation::Immediate, std::memory_order_release);
}

void AudioParam::setValueAtTime(float value, double time) {
    startValue_.store(valueAtTime(time), std::memory_order_relaxed);
    targetValue_.store(value, std::memory_order_relaxed);
    startTime_.store(time, std::memory_order_relaxed);
    endOrConstant_.store(time, std::memory_order_relaxed);
    automation_.store(Automation::Scheduled, std::memory_order_release);
}

void AudioParam::linearRampToValueAtTime(float value, double endTime) {
    const double startTime = endOrConstant_.load(std::memory_order_relaxed);
    startValue_.store(valueAtTime(startTime), std::memory_order_relaxed);
    targetValue_.store(value, std::memory_order_relaxed);
    startTime_.store(startTime, std::memory_order_relaxed);
    endOrConstant_.store(std::max(endTime, startTime), std::memory_order_relaxed);
    automation_.store(Automation::Linear, std::memory_order_release);
}

void AudioParam::setTargetAtTime(float value, double startTime, double timeConstant) {
    startValue_.store(valueAtTime(startTime), std::memory_order_relaxed);
    targetValue_.store(value, std::memory_order_relaxed);
    startTime_.store(startTime, std::memory_order_relaxed);
    endOrConstant_.store(std::max(timeConstant, 0.0001), std::memory_order_relaxed);
    automation_.store(Automation::Target, std::memory_order_release);
}

bool AudioParam::isConstantOver(double from, double to) const {
    const float start = startValue_.load(std::memory_order_relaxed);
    const float target = targetValue_.load(std::memory_order_relaxed);
    const double startTime = startTime_.load(std::memory_order_relaxed);
    const double endOrConstant = endOrConstant_.load(std::memory_order_relaxed);
    switch (automation_.load(std::memory_order_acquire)) {
    case Automation::Immediate:
        return true;
    case Automation::Scheduled:
        return to < startTime || from >= startTime;
    case Automation::Linear:
        return start == target || to <= startTime || from >= endOrConstant;
    case Automation::Target:
        if (start == target || to <= startTime) return true;
        return from > startTime &&
            std::abs(start - target) * std::exp(-(from - startTime) / endOrConstant) <=
                1e-6 * std::max(1.0f, std::abs(target));
    }
    return false;
}

float AudioParam::valueAtTime(double time) const {
    // A plain load and store, never a locked read-modify-write: this runs per sample on the audio
    // thread, and a `fetch_add` here measured as a net regression on native Midway (PRD-444).
    valueAtTimeCalls_.store(valueAtTimeCalls_.load(std::memory_order_relaxed) + 1, std::memory_order_relaxed);
    const float start = startValue_.load(std::memory_order_relaxed);
    const float target = targetValue_.load(std::memory_order_relaxed);
    const double startTime = startTime_.load(std::memory_order_relaxed);
    const double endOrConstant = endOrConstant_.load(std::memory_order_relaxed);
    switch (automation_.load(std::memory_order_acquire)) {
    case Automation::Scheduled:
        return time < startTime ? start : target;
    case Automation::Linear:
        if (time <= startTime) return start;
        if (time >= endOrConstant) return target;
        return start + (target - start) * static_cast<float>(
            (time - startTime) / std::max(endOrConstant - startTime, 0.0001)
        );
    case Automation::Target:
        if (time <= startTime) return start;
        return target + (start - target) * static_cast<float>(
            std::exp(-(time - startTime) / endOrConstant)
        );
    case Automation::Immediate:
        return target;
    }
    return target;
}

// ============================================================================
// AudioNode
// ============================================================================

AudioNode::AudioNode(AudioContext* context)
    : context_(context) {}

void AudioNode::connect(AudioNode* destination) {
    if (!destination) return;
    // A post-mix node is a sum boundary wherever it is wired, not only when its destination is
    // the context destination: `AudioBus` routes voices through the compressor into the listener's
    // master gain, so the compressor's own downstream is that gain and never the destination. It
    // registers with the destination either way so the mixer knows to run it once per block.
    if (postMix() && context_ != nullptr) {
        static_cast<AudioDestinationNode*>(context_->destination())->addPostMix(this);
    }
    if (std::find(outputs_.begin(), outputs_.end(), destination) == outputs_.end()) {
        outputs_.push_back(destination);
    }
}

void AudioNode::disconnect() {
    outputs_.clear();
    if (postMix() && context_ != nullptr) {
        static_cast<AudioDestinationNode*>(context_->destination())->removePostMix(this);
        std::fill(sum_.begin(), sum_.end(), 0.0f);
    }
}

void AudioNode::disconnect(AudioNode* destination) {
    outputs_.erase(std::remove(outputs_.begin(), outputs_.end(), destination), outputs_.end());
    // The sum registration outlives one erase while another output is still connected, otherwise
    // this bus goes silent for every remaining downstream node, not just the one disconnected.
    if (outputs_.empty() && postMix() && context_ != nullptr) {
        static_cast<AudioDestinationNode*>(context_->destination())->removePostMix(this);
        std::fill(sum_.begin(), sum_.end(), 0.0f);
    }
}

void AudioNode::accumulate(const float* input, size_t count) {
    if (sum_.size() < count) sum_.assign(count, 0.0f);
    for (size_t i = 0; i < count; i++) sum_[i] += input[i];
}

void AudioNode::flushSum(float* output, size_t numFrames, int numChannels) {
    const size_t count = numFrames * static_cast<size_t>(numChannels);
    if (sum_.size() != count) sum_.assign(count, 0.0f);
    // The block's contribution to the mix. It runs its own chain first — for a compressor that is
    // the listener's master gain, so the volume the game set is applied after the reduction, which
    // is the order `AudioBus` wires them in.
    process(sum_.data(), numFrames, numChannels);
    for (size_t i = 0; i < count; i++) output[i] += sum_[i];
    std::fill(sum_.begin(), sum_.end(), 0.0f);
}

void AudioNode::process(float* output, size_t numFrames, int numChannels) {
    for (auto* destination : outputs_) {
        if (!destination) continue;
        if (destination->postMix()) {
            // A sum boundary: hand it the block and stop, so the same voice is not also mixed
            // straight to the destination. What it produces comes back through `flushSum`.
            destination->accumulate(output, numFrames * static_cast<size_t>(numChannels));
            std::fill_n(output, numFrames * static_cast<size_t>(numChannels), 0.0f);
            continue;
        }
        destination->process(output, numFrames, numChannels);
    }
}

// ============================================================================
// AudioDestinationNode
// ============================================================================

AudioDestinationNode::AudioDestinationNode(AudioContext* context)
    : AudioNode(context) {}

void AudioDestinationNode::addPostMix(AudioNode* node) {
    std::lock_guard<std::mutex> lock(context_->mixMutex());
    if (std::find(postMix_.begin(), postMix_.end(), node) == postMix_.end()) {
        postMix_.push_back(node);
    }
}

void AudioDestinationNode::removePostMix(AudioNode* node) {
    std::lock_guard<std::mutex> lock(context_->mixMutex());
    postMix_.erase(std::remove(postMix_.begin(), postMix_.end(), node), postMix_.end());
}

size_t AudioDestinationNode::postMixCount() const {
    std::lock_guard<std::mutex> lock(context_->mixMutex());
    return postMix_.size();
}

// ============================================================================
// GainNode
// ============================================================================

GainNode::GainNode(AudioContext* context)
    : AudioNode(context)
    , gain_(1.0f) {}

void GainNode::process(float* output, size_t numFrames, int numChannels) {
    const double startTime = context_->currentTime();
    const double secondsPerFrame = 1.0 / context_->sampleRate();
    if (gain_.isConstantOver(startTime, startTime + numFrames * secondsPerFrame)) {
        // A static or settled gain is the common case and does not change across the block, so one
        // read replaces four atomic loads, a switch and (for a target) an `exp` per sample.
        const float gainValue = gain_.valueAtTime(startTime);
        for (size_t frame = 0; frame < numFrames; frame++) {
            for (int channel = 0; channel < numChannels; channel++) {
                output[frame * numChannels + channel] *= gainValue;
            }
        }
    } else {
        for (size_t frame = 0; frame < numFrames; frame++) {
            const float gainValue = gain_.valueAtTime(startTime + frame * secondsPerFrame);
            for (int channel = 0; channel < numChannels; channel++) {
                output[frame * numChannels + channel] *= gainValue;
            }
        }
    }
    AudioNode::process(output, numFrames, numChannels);
}

// ============================================================================
// PannerNode
// ============================================================================

PannerNode::PannerNode(AudioContext* context)
    : AudioNode(context) {}

void PannerNode::setPosition(float x, float y, float z) {
    x_.store(x, std::memory_order_relaxed);
    y_.store(y, std::memory_order_relaxed);
    z_.store(z, std::memory_order_relaxed);
}

void PannerNode::setRefDistance(float value) {
    refDistance_.store(std::max(value, 0.0001f), std::memory_order_relaxed);
}

void PannerNode::setMaxDistance(float value) {
    maxDistance_.store(std::max(value, 0.0001f), std::memory_order_relaxed);
}

void PannerNode::setRolloffFactor(float value) {
    rolloffFactor_.store(std::max(value, 0.0f), std::memory_order_relaxed);
}

bool PannerNode::setDistanceModel(const std::string& value) {
    if (value == "inverse") distanceModel_.store(DistanceModel::Inverse, std::memory_order_relaxed);
    else if (value == "linear") distanceModel_.store(DistanceModel::Linear, std::memory_order_relaxed);
    else if (value == "exponential") {
        distanceModel_.store(DistanceModel::Exponential, std::memory_order_relaxed);
    } else {
        return false;
    }
    return true;
}

void PannerNode::process(float* output, size_t numFrames, int numChannels) {
    const AudioVector3 listener = context_->listenerPosition();
    const AudioVector3 right = context_->listenerRight();
    const float dx = x_.load(std::memory_order_relaxed) - listener.x;
    const float dy = y_.load(std::memory_order_relaxed) - listener.y;
    const float dz = z_.load(std::memory_order_relaxed) - listener.z;
    const float distance = std::sqrt(dx * dx + dy * dy + dz * dz);
    const float refDistance = refDistance_.load(std::memory_order_relaxed);
    const float maxDistance = std::max(maxDistance_.load(std::memory_order_relaxed), refDistance);
    const float rolloff = rolloffFactor_.load(std::memory_order_relaxed);
    float attenuation = 1.0f;
    if (distance > refDistance) {
        switch (distanceModel_.load(std::memory_order_relaxed)) {
        case DistanceModel::Linear:
            attenuation = 1.0f - rolloff * (distance - refDistance) /
                std::max(maxDistance - refDistance, 0.0001f);
            break;
        case DistanceModel::Exponential:
            attenuation = std::pow(distance / refDistance, -rolloff);
            break;
        case DistanceModel::Inverse:
            attenuation = refDistance / (refDistance + rolloff * (distance - refDistance));
            break;
        }
    }
    attenuation = std::clamp(attenuation, 0.0f, 1.0f);
    const float inverseDistance = distance > 0.0001f ? 1.0f / distance : 0.0f;
    const float pan = std::clamp(
        (dx * right.x + dy * right.y + dz * right.z) * inverseDistance,
        -1.0f,
        1.0f
    );
    const float angle = (pan + 1.0f) * 3.14159265358979323846f * 0.25f;
    const float leftGain = std::cos(angle) * attenuation;
    const float rightGain = std::sin(angle) * attenuation;
    for (size_t frame = 0; frame < numFrames; frame++) {
        const size_t base = frame * numChannels;
        if (numChannels > 0) output[base] *= leftGain;
        if (numChannels > 1) output[base + 1] *= rightGain;
    }
    AudioNode::process(output, numFrames, numChannels);
}

// ============================================================================
// BiquadFilterNode
// ============================================================================

BiquadFilterNode::BiquadFilterNode(AudioContext* context)
    : AudioNode(context) {}

bool BiquadFilterNode::setType(const std::string& value) {
    // `lowpass` is the only type `AudioBus` ever asks for. Accepting a name and then not
    // filtering that way is the silent failure this whole node exists to remove, so the other
    // five Web Audio types are refused and the caller finds out at the call.
    return value == "lowpass";
}

void BiquadFilterNode::process(float* output, size_t numFrames, int numChannels) {
    if (numChannels <= 0) return;
    const double sampleRate = std::max(context_->sampleRate(), 1.0f);
    const double startTime = context_->currentTime();

    // RBJ low-pass, with the corner clamped below Nyquist: an unfiltered corner would divide by
    // zero in the coefficient and emit a full-scale oscillation. Coefficients are computed once
    // per block from the block's opening values — the same hoist `GainNode` does, for the same
    // reason. A retune mid-block is picked up on the next one, which is under 23 ms at 44.1 kHz.
    const float hz = frequency_.valueAtTime(startTime);
    const float q = std::max(q_.valueAtTime(startTime), 0.0001f);
    const double nyquist = sampleRate * 0.5;
    const double f0 = std::clamp(static_cast<double>(hz), 1.0, std::max(nyquist - 1.0, 1.0));
    const double w0 = 2.0 * 3.14159265358979323846 * f0 / sampleRate;
    const double alpha = std::sin(w0) / (2.0 * static_cast<double>(q));
    const double a0 = 1.0 + alpha;
    const double b0 = ((1.0 - std::cos(w0)) / 2.0) / a0;
    const double b1 = (1.0 - std::cos(w0)) / a0;
    const double b2 = b0;  // A low-pass is symmetric: b0 == b2.
    const double a1 = (-2.0 * std::cos(w0)) / a0;
    const double a2 = (1.0 - alpha) / a0;

    // The delay line is per channel and lives for the life of the node, so a voice that keeps its
    // filter keeps its filter memory instead of restarting from silence on every cue.
    if (state_.size() < static_cast<size_t>(numChannels)) state_.resize(numChannels);
    for (size_t frame = 0; frame < numFrames; frame++) {
        for (int channel = 0; channel < numChannels; channel++) {
            std::array<float, 4>& s = state_[static_cast<size_t>(channel)];
            const float x1 = s[0];
            const float x2 = s[1];
            const float y1 = s[2];
            const float y2 = s[3];
            const float x = output[frame * numChannels + channel];
            const float y = static_cast<float>(b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2);
            s[0] = x;
            s[1] = x1;
            s[2] = y;
            s[3] = y1;
            output[frame * numChannels + channel] = y;
        }
    }
    AudioNode::process(output, numFrames, numChannels);
}

// ============================================================================
// DynamicsCompressorNode
// ============================================================================

DynamicsCompressorNode::DynamicsCompressorNode(AudioContext* context)
    : AudioNode(context) {}

void DynamicsCompressorNode::process(float* output, size_t numFrames, int numChannels) {
    if (numFrames == 0 || numChannels <= 0) return;
    const double sampleRate = std::max(context_->sampleRate(), 1.0f);
    const double startTime = context_->currentTime();

    const float threshold = threshold_.valueAtTime(startTime);
    const float knee = std::max(knee_.valueAtTime(startTime), 0.0f);
    const float ratio = std::max(ratio_.valueAtTime(startTime), 1.0f);
    const float attack = std::max(attack_.valueAtTime(startTime), 0.0f);
    const float release = std::max(release_.valueAtTime(startTime), 0.0f);

    // One-pole smoothing coefficients for the envelope, from the attack/release time constants.
    // `1 - exp(-1/tc)` rather than `1/tc` so a very short constant still converges inside a block.
    const auto smoothing = [sampleRate](float seconds) -> float {
        if (seconds <= 0.0f) return 1.0f;
        return static_cast<float>(1.0 - std::exp(-1.0 / (static_cast<double>(seconds) * sampleRate)));
    };
    const float attackCoefficient = smoothing(attack);
    const float releaseCoefficient = smoothing(release);

    float reductionDb = reduction_.load(std::memory_order_relaxed);
    for (size_t frame = 0; frame < numFrames; frame++) {
        // Detector over the loudest channel of the frame: peak, not RMS, so one thunder crack is
        // what pulls the gain down rather than the average of a quiet bed and a loud transient.
        float peak = 0.0f;
        for (int channel = 0; channel < numChannels; channel++) {
            peak = std::max(peak, std::abs(output[frame * numChannels + channel]));
        }
        const float peakDb = peak > 1e-6f ? 20.0f * std::log10(peak) : -100.0f;
        const float overshoot = peakDb - threshold;
        // Standard dB-domain soft knee, measured from the threshold: nothing below `-knee/2`, a
        // quadratic ease across the knee, and the straight ratio line above `+knee/2`. A reduction
        // is dB removed, so it is negative or zero everywhere — the previous form subtracted half
        // the knee from the overshoot unconditionally and *added* gain for a signal just over the
        // threshold, which is an amplifier wearing a compressor's parameters.
        const float kneeSlope = 1.0f / ratio - 1.0f;
        float targetDb = 0.0f;
        if (overshoot > knee * 0.5f) {
            targetDb = kneeSlope * overshoot;
        } else if (knee > 0.0f && overshoot > -knee * 0.5f) {
            const float x = overshoot + knee * 0.5f;
            targetDb = kneeSlope * x * x / (2.0f * knee);
        }
        const float coefficient = targetDb < reductionDb ? attackCoefficient : releaseCoefficient;
        reductionDb += (targetDb - reductionDb) * coefficient;
        // One gain for the frame, taken from the smoothed dB rather than per sample: a bus
        // compressor is a slow envelope, and a per-sample exponential here would be both slower to
        // converge and a `pow` on the audio thread for a curve that is already settled.
        const float gain = std::pow(10.0f, reductionDb / 20.0f);
        for (int channel = 0; channel < numChannels; channel++) {
            output[frame * numChannels + channel] *= gain;
        }
    }
    reduction_.store(reductionDb, std::memory_order_relaxed);
    AudioNode::process(output, numFrames, numChannels);
}

// ============================================================================
// AudioBufferSourceNode
// ============================================================================

AudioBufferSourceNode::AudioBufferSourceNode(AudioContext* context)
    : AudioNode(context) {}

AudioBufferSourceNode::~AudioBufferSourceNode() {
    if (isPlaying()) {
        context_->unregisterSource(this);
    }
}

void AudioBufferSourceNode::setBuffer(std::shared_ptr<AudioBuffer> buffer) {
    buffer_ = buffer;
}

void AudioBufferSourceNode::start(double when, double offset, double duration) {
    if (isPlaying() || !buffer_) return;

    // `when` is a point on the AudioContext timeline, not a delay from now: the Web Audio spec
    // says so, and Three's `Audio.play()` passes `context.currentTime + delay` already absolute.
    // Adding `currentTime()` a second time doubled the schedule, so a cue fired at t was held
    // until 2t — every one-shot went silent for as long as the context had been alive, while
    // loops started at t≈0 were unaffected. A zero or past `when` means "start now".
    const double now = context_->currentTime();
    startTime_ = when > now ? when : now;
    offsetTime_ = offset;
    durationTime_ = duration;
    playbackPosition_ = static_cast<size_t>(offset * buffer_->sampleRate());
    stopTime_.store(-1, std::memory_order_release);
    endedPending_.store(false, std::memory_order_release);
    isPlaying_.store(true, std::memory_order_release);

    context_->registerSource(this);
}

void AudioBufferSourceNode::stop(double when) {
    if (!isPlaying()) return;
    // Absolute context time for the same reason `start` is: Three passes `currentTime + delay`.
    const double now = context_->currentTime();
    stopTime_.store(when > now ? when : now, std::memory_order_release);
}

void AudioBufferSourceNode::process(float* output, size_t numFrames, int numChannels) {
    if (!isPlaying() || !buffer_) return;

    double currentTime = context_->currentTime();

    // Check if we should stop
    const double stopTime = stopTime_.load(std::memory_order_acquire);
    if (stopTime >= 0 && currentTime >= stopTime) {
        isPlaying_.store(false, std::memory_order_release);
        endedPending_.store(true, std::memory_order_release);
        return;
    }

    // Check if we should start yet
    if (currentTime < startTime_) {
        return;
    }

    int bufferChannels = buffer_->numberOfChannels();
    size_t bufferLength = buffer_->length();

    for (size_t frame = 0; frame < numFrames; frame++) {
        if (playbackPosition_ >= bufferLength) {
            if (loop_) {
                size_t loopStartSample = static_cast<size_t>(loopStart_ * buffer_->sampleRate());
                size_t loopEndSample = loopEnd_ > 0
                    ? static_cast<size_t>(loopEnd_ * buffer_->sampleRate())
                    : bufferLength;
                playbackPosition_ = loopStartSample;
            } else {
                // End of buffer
                isPlaying_.store(false, std::memory_order_release);
                endedPending_.store(true, std::memory_order_release);
                break;
            }
        }

        // Check duration limit
        if (durationTime_ > 0) {
            double playedTime = static_cast<double>(playbackPosition_) / buffer_->sampleRate() - offsetTime_;
            if (playedTime >= durationTime_) {
                isPlaying_.store(false, std::memory_order_release);
                endedPending_.store(true, std::memory_order_release);
                break;
            }
        }

        // Mix audio into output
        for (int ch = 0; ch < numChannels; ch++) {
            int srcChannel = ch % bufferChannels;
            const float* channelData = buffer_->getChannelData(srcChannel);
            if (channelData) {
                output[frame * numChannels + ch] += channelData[playbackPosition_];
            }
        }

        playbackPosition_++;
    }
    AudioNode::process(output, numFrames, numChannels);
}

// ============================================================================
// AudioContext
// ============================================================================

// The host-side registry of live contexts. A backgrounded app stops running JavaScript, so the
// only code that could have called `suspend()` is the code that is no longer executing; the
// lifecycle watch reaches these instead.
namespace {
std::mutex& contextRegistryMutex() {
    static std::mutex mutex;
    return mutex;
}
std::vector<AudioContext*>& contextRegistry() {
    static std::vector<AudioContext*> contexts;
    return contexts;
}
}  // namespace

void suspendAllContexts() {
    std::lock_guard<std::mutex> lock(contextRegistryMutex());
    for (AudioContext* context : contextRegistry()) {
        if (context == nullptr) continue;
        context->suspendForHost();
    }
}

void resumeAllContexts() {
    std::lock_guard<std::mutex> lock(contextRegistryMutex());
    for (AudioContext* context : contextRegistry()) {
        // A context the game had deliberately suspended is not resumed by the host: only one that
        // the host itself suspended. `Closed` stays closed.
        if (context != nullptr && context->hostSuspended()) context->resumeForHost();
    }
}

size_t liveContextCount() {
    std::lock_guard<std::mutex> lock(contextRegistryMutex());
    return contextRegistry().size();
}

AudioContext::AudioContext() {
    destination_ = std::make_unique<AudioDestinationNode>(this);

    // Initialize SDL audio
    if (!SDL_WasInit(SDL_INIT_AUDIO)) {
        if (!SDL_InitSubSystem(SDL_INIT_AUDIO)) {
            std::cerr << "[Audio] Failed to init SDL audio: " << SDL_GetError() << std::endl;
            return;
        }
    }

    // Create audio stream
    SDL_AudioSpec spec;
    spec.freq = static_cast<int>(sampleRate_);
    spec.format = SDL_AUDIO_F32;
    spec.channels = 2;

    audioStream_ = SDL_OpenAudioDeviceStream(
        SDL_AUDIO_DEVICE_DEFAULT_PLAYBACK,
        &spec,
        sdlAudioCallback,
        this
    );

    if (!audioStream_) {
        // A machine with no sound card is an environment fact, not a runtime failure: the context
        // degrades to silence and the game keeps running either way. Report the two cases in
        // different words, because they are different events and the logs are read by machines.
        // The Windows CI runner has no audio device, and the desktop core gate scrapes this log
        // for "failed to" — so calling an absent device a failure failed a run that had rendered
        // all 300 frames and presented each exactly once.
        int playbackDeviceCount = 0;
        SDL_AudioDeviceID* playbackDevices = SDL_GetAudioPlaybackDevices(&playbackDeviceCount);
        if (playbackDevices) SDL_free(playbackDevices);
        if (playbackDeviceCount <= 0) {
            std::cout << "[Audio] No audio playback device on this machine; continuing in silence."
                      << std::endl;
        } else {
            std::cerr << "[Audio] Failed to open audio device: " << SDL_GetError() << std::endl;
        }
        return;
    }

    // Publish only after every field the lifecycle watch can touch is initialized. The watch is
    // synchronous on SDL's event-sending thread, so publishing `this` at constructor entry would
    // let a background event observe a partially constructed stream or state.
    {
        std::lock_guard<std::mutex> lock(contextRegistryMutex());
        contextRegistry().push_back(this);
    }
    std::cout << "[Audio] AudioContext created (sample rate: " << sampleRate_ << " Hz)" << std::endl;
}

AudioContext::~AudioContext() {
    {
        std::lock_guard<std::mutex> lock(contextRegistryMutex());
        auto& contexts = contextRegistry();
        contexts.erase(std::remove(contexts.begin(), contexts.end(), this), contexts.end());
    }
    close();
}

double AudioContext::currentTime() const {
    return static_cast<double>(sampleCount_.load(std::memory_order_acquire)) / sampleRate_;
}

std::shared_ptr<AudioBuffer> AudioContext::createBuffer(int numberOfChannels, size_t length, float sampleRate) {
    return std::make_shared<AudioBuffer>(sampleRate, numberOfChannels, length);
}

std::unique_ptr<AudioBufferSourceNode> AudioContext::createBufferSource() {
    return std::make_unique<AudioBufferSourceNode>(this);
}

std::unique_ptr<GainNode> AudioContext::createGain() {
    return std::make_unique<GainNode>(this);
}

std::unique_ptr<PannerNode> AudioContext::createPanner() {
    return std::make_unique<PannerNode>(this);
}

std::unique_ptr<BiquadFilterNode> AudioContext::createBiquadFilter() {
    return std::make_unique<BiquadFilterNode>(this);
}

std::unique_ptr<DynamicsCompressorNode> AudioContext::createDynamicsCompressor() {
    return std::make_unique<DynamicsCompressorNode>(this);
}

void AudioContext::setListenerPosition(float x, float y, float z) {
    listenerX_.store(x, std::memory_order_relaxed);
    listenerY_.store(y, std::memory_order_relaxed);
    listenerZ_.store(z, std::memory_order_relaxed);
}

void AudioContext::setListenerOrientation(float forwardX, float forwardY, float forwardZ,
                                          float upX, float upY, float upZ) {
    listenerForwardX_.store(forwardX, std::memory_order_relaxed);
    listenerForwardY_.store(forwardY, std::memory_order_relaxed);
    listenerForwardZ_.store(forwardZ, std::memory_order_relaxed);
    listenerUpX_.store(upX, std::memory_order_relaxed);
    listenerUpY_.store(upY, std::memory_order_relaxed);
    listenerUpZ_.store(upZ, std::memory_order_relaxed);
}

AudioVector3 AudioContext::listenerPosition() const {
    return {
        listenerX_.load(std::memory_order_relaxed),
        listenerY_.load(std::memory_order_relaxed),
        listenerZ_.load(std::memory_order_relaxed),
    };
}

AudioVector3 AudioContext::listenerRight() const {
    const float fx = listenerForwardX_.load(std::memory_order_relaxed);
    const float fy = listenerForwardY_.load(std::memory_order_relaxed);
    const float fz = listenerForwardZ_.load(std::memory_order_relaxed);
    const float ux = listenerUpX_.load(std::memory_order_relaxed);
    const float uy = listenerUpY_.load(std::memory_order_relaxed);
    const float uz = listenerUpZ_.load(std::memory_order_relaxed);
    float x = fy * uz - fz * uy;
    float y = fz * ux - fx * uz;
    float z = fx * uy - fy * ux;
    const float length = std::sqrt(x * x + y * y + z * z);
    if (length <= 0.0001f) return {1.0f, 0.0f, 0.0f};
    x /= length;
    y /= length;
    z /= length;
    return {x, y, z};
}

// The synchronous entry point is gone with its only caller: `decodeAudioData` now queues the
// bytes for `AsyncAudioDecoder`, so no decode runs on the frame thread.

void AudioContext::resume() {
    std::lock_guard<std::mutex> lock(lifecycleMutex_);
    resumeLocked();
}

void AudioContext::resumeLocked() {
    if (state_ == State::Closed) return;
    if (audioStream_) {
        SDL_ResumeAudioStreamDevice(audioStream_);
    }
    state_ = State::Running;
    std::cout << "[Audio] AudioContext resumed" << std::endl;
}

void AudioContext::suspend() {
    std::lock_guard<std::mutex> lock(lifecycleMutex_);
    suspendLocked();
}

void AudioContext::suspendLocked() {
    if (state_ == State::Closed) return;
    if (audioStream_) {
        SDL_PauseAudioStreamDevice(audioStream_);
    }
    state_ = State::Suspended;
}

void AudioContext::suspendForHost() {
    std::lock_guard<std::mutex> lock(lifecycleMutex_);
    if (state_ == State::Closed) return;
    // A context the game already suspended stays the game's business; the host does not claim it,
    // and so will not resume it later.
    if (state_ == State::Suspended) return;
    suspendLocked();
    hostSuspended_ = true;
    std::cout << "[Audio] AudioContext suspended by the host lifecycle" << std::endl;
}

void AudioContext::resumeForHost() {
    std::lock_guard<std::mutex> lock(lifecycleMutex_);
    if (!hostSuspended_) return;
    hostSuspended_ = false;
    if (state_ == State::Closed) return;
    resumeLocked();
}

void AudioContext::close() {
    std::lock_guard<std::mutex> lock(lifecycleMutex_);
    closeLocked();
}

void AudioContext::closeLocked() {
    if (state_ == State::Closed) return;

    // Signal callback to stop processing first
    shuttingDown_.store(true, std::memory_order_release);

    if (audioStream_) {
        // Destroy the audio stream - SDL will wait for callbacks to finish
        SDL_DestroyAudioStream(audioStream_);
        audioStream_ = nullptr;
    }

    state_ = State::Closed;
}

void AudioContext::registerSource(AudioBufferSourceNode* source) {
    std::lock_guard<std::mutex> lock(sourcesMutex_);
    activeSources_.push_back(source);
    std::cout << "[Audio] Source registered, active sources: " << activeSources_.size() << std::endl;
}

void AudioContext::unregisterSource(AudioBufferSourceNode* source) {
    std::lock_guard<std::mutex> lock(sourcesMutex_);
    activeSources_.erase(
        std::remove(activeSources_.begin(), activeSources_.end(), source),
        activeSources_.end()
    );
}

void AudioContext::detachSources() {
    std::lock_guard<std::mutex> lock(sourcesMutex_);
    activeSources_.clear();
}

void AudioContext::renderBlock(float* output, int numFrames) {
    // Clear output buffer
    std::memset(output, 0, numFrames * 2 * sizeof(float));

    // Mix all active sources. A chain that reaches a sum boundary hands its block to that node and
    // comes back zeroed, so this loop adds nothing for a voice the compressor owns.
    {
        std::lock_guard<std::mutex> lock(sourcesMutex_);
        const size_t sampleCount = static_cast<size_t>(numFrames) * 2;
        for (auto* source : activeSources_) {
            std::fill_n(sourceBuffer_.data(), sampleCount, 0.0f);
            source->process(sourceBuffer_.data(), numFrames, 2);
            for (size_t sample = 0; sample < sampleCount; sample++) {
                output[sample] += sourceBuffer_[sample];
            }
        }
        activeSources_.erase(
            std::remove_if(activeSources_.begin(), activeSources_.end(),
                           [](AudioBufferSourceNode* source) { return !source->isPlaying(); }),
            activeSources_.end()
        );
    }

    // Sum boundaries — the bus compressor — run once on everything their own voices contributed,
    // and only then contribute to the mix, so an unrelated bus that never routed through them is
    // untouched. Under the mix lock because `connect` is a JavaScript thread registering into the
    // same vector.
    {
        std::lock_guard<std::mutex> lock(mixMutex_);
        for (AudioNode* node : destination_->postMixNodes()) {
            node->flushSum(output, static_cast<size_t>(numFrames), 2);
        }
    }

    // Clamp output to [-1, 1]
    for (int i = 0; i < numFrames * 2; i++) {
        output[i] = std::clamp(output[i], -1.0f, 1.0f);
    }

    sampleCount_.fetch_add(static_cast<uint64_t>(numFrames), std::memory_order_release);
}

void AudioContext::audioCallback(float* output, int numFrames) {
    renderBlock(output, numFrames);
}

void AudioContext::sdlAudioCallback(void* userdata, SDL_AudioStream* stream, int additionalAmount, int totalAmount) {
    // Safety check: validate userdata pointer first
    if (!userdata || !stream) {
        return;
    }

    // SDL3 callback: we need to provide audio data to the stream
    // additionalAmount is the minimum bytes needed
    if (additionalAmount <= 0) return;

    auto* ctx = static_cast<AudioContext*>(userdata);

    // Check if we're shutting down - return silence immediately
    // Note: Don't do any I/O (cout) in callbacks - can cause hangs
    if (ctx->shuttingDown_.load(std::memory_order_relaxed)) {
        const int bytes = std::min(additionalAmount, static_cast<int>(ctx->callbackBuffer_.size() * sizeof(float)));
        std::memset(ctx->callbackBuffer_.data(), 0, bytes);
        SDL_PutAudioStreamData(stream, ctx->callbackBuffer_.data(), bytes);
        return;
    }

    int numFrames = additionalAmount / (2 * sizeof(float));  // Stereo float

    // Safety: limit numFrames to static buffer size
    if (numFrames <= 0 || numFrames > 4096) {
        numFrames = std::min(numFrames, 4096);
        if (numFrames <= 0) return;
    }

    // Use context-owned fixed storage to avoid allocation and cross-context races.
    ctx->audioCallback(ctx->callbackBuffer_.data(), numFrames);

    // Put audio data into the stream
    SDL_PutAudioStreamData(stream, ctx->callbackBuffer_.data(), numFrames * 2 * sizeof(float));
}

// ============================================================================
// Audio Decoding
// ============================================================================

// stb_vorbis, compiled exactly once in `src/audio/vorbis_impl.c`. Declared rather than included
// for the same reason `stb_image` is declared in `src/webgpu/context.cpp`: the single-file library
// is parsed by one translation unit and used by the others through its C entry points.
extern "C" int stb_vorbis_decode_memory(const uint8_t* mem, int len, int* channels,
                                        int* sample_rate, short** output);

namespace {

/**
 * Linear resample of interleaved float frames.
 *
 * `AudioBufferSourceNode::process` advances the read head one buffer frame per output frame, with
 * no rate conversion anywhere in the graph. So a buffer that keeps its own sample rate plays at
 * `bufferRate / contextRate` speed — a 22 050 Hz asset an octave high and half as long, on a
 * 44 100 Hz context. Web Audio says `decodeAudioData` resamples to the context rate, which is
 * exactly what `decodeAudioFile`'s `targetSampleRate` parameter was for; it was accepted and never
 * read. WAV hid it because the fixtures and most game audio already matched, and Vorbis will not:
 * 48 000 Hz is the common Ogg rate and would play about 9% sharp.
 */
std::vector<float> resampleInterleaved(const std::vector<float>& source, int channels,
                                       double sourceRate, double targetRate) {
    if (channels <= 0 || sourceRate <= 0.0 || targetRate <= 0.0) return {};
    const size_t sourceFrames = source.size() / static_cast<size_t>(channels);
    if (sourceFrames == 0) return {};

    const double ratio = targetRate / sourceRate;
    size_t targetFrames = static_cast<size_t>(std::llround(static_cast<double>(sourceFrames) * ratio));
    if (targetFrames == 0) targetFrames = 1;

    std::vector<float> resampled(targetFrames * static_cast<size_t>(channels));
    for (size_t frame = 0; frame < targetFrames; frame++) {
        const double position = static_cast<double>(frame) / ratio;
        size_t left = static_cast<size_t>(position);
        if (left >= sourceFrames) left = sourceFrames - 1;
        const size_t right = left + 1 < sourceFrames ? left + 1 : left;
        const float blend = static_cast<float>(position - static_cast<double>(left));
        for (int channel = 0; channel < channels; channel++) {
            const float a = source[left * static_cast<size_t>(channels) + channel];
            const float b = source[right * static_cast<size_t>(channels) + channel];
            resampled[frame * static_cast<size_t>(channels) + channel] = a + (b - a) * blend;
        }
    }
    return resampled;
}

/** Interleaved float PCM into an `AudioBuffer` at the context's rate. */
std::shared_ptr<AudioBuffer> buildAudioBuffer(std::vector<float> interleaved, int numChannels,
                                              float sourceRate, float targetSampleRate,
                                              const char* container) {
    if (numChannels <= 0 || interleaved.empty() || sourceRate <= 0.0f) {
        std::cerr << "[Audio] " << container << " decoded to no usable audio" << std::endl;
        return nullptr;
    }
    float rate = sourceRate;
    if (targetSampleRate > 0.0f && std::fabs(targetSampleRate - sourceRate) > 0.5f) {
        interleaved = resampleInterleaved(interleaved, numChannels, sourceRate, targetSampleRate);
        if (interleaved.empty()) {
            std::cerr << "[Audio] " << container << " could not be resampled from " << sourceRate
                      << " Hz to " << targetSampleRate << " Hz" << std::endl;
            return nullptr;
        }
        rate = targetSampleRate;
    }

    const size_t numSamples = interleaved.size();
    const size_t numFrames = numSamples / static_cast<size_t>(numChannels);
    auto buffer = std::make_shared<AudioBuffer>(rate, numChannels, numFrames);
    buffer->setFromInterleaved(interleaved.data(), numSamples, numChannels);

    std::cout << "[Audio] Decoded audio: " << numFrames << " frames, " << numChannels
              << " channels, " << rate << " Hz (" << container;
    if (std::fabs(rate - sourceRate) > 0.5f) std::cout << ", resampled from " << sourceRate << " Hz";
    std::cout << ")" << std::endl;

    return buffer;
}

/**
 * Ogg Vorbis, through stb_vorbis.
 *
 * Fails closed on everything it cannot read, and that is deliberate: an Ogg container can also
 * carry Opus or FLAC, which this decoder does not implement and must not pretend to. Every
 * failure — truncated page, corrupt payload, a codec that is not Vorbis — returns nullptr, which
 * reaches the game as the same rejected `decodeAudioData` a WAV failure produces. Handing back a
 * buffer of silence instead would be worse than the black screen this fixes.
 */
std::shared_ptr<AudioBuffer> decodeOggVorbis(const uint8_t* data, size_t length,
                                             float targetSampleRate) {
    if (length > static_cast<size_t>(std::numeric_limits<int>::max())) {
        std::cerr << "[Audio] Ogg Vorbis payload is too large to decode: " << length << " bytes"
                  << std::endl;
        return nullptr;
    }

    int numChannels = 0;
    int sourceRate = 0;
    short* samples = nullptr;
    const int frames =
        stb_vorbis_decode_memory(data, static_cast<int>(length), &numChannels, &sourceRate, &samples);
    if (frames < 0 || samples == nullptr) {
        // stb_vorbis reports nothing but the -1; the container name is what makes the message
        // actionable, since the caller only knows it handed over an `.ogg`.
        std::cerr << "[Audio] Failed to load audio: not decodable Ogg Vorbis "
                     "(truncated, corrupt, or an Ogg carrying a codec this runtime does not "
                     "implement, such as Opus)"
                  << std::endl;
        if (samples != nullptr) std::free(samples);
        return nullptr;
    }
    if (frames == 0 || numChannels <= 0 || sourceRate <= 0) {
        std::cerr << "[Audio] Failed to load audio: Ogg Vorbis decoded to " << frames << " frames, "
                  << numChannels << " channels, " << sourceRate << " Hz" << std::endl;
        std::free(samples);
        return nullptr;
    }

    const size_t numSamples = static_cast<size_t>(frames) * static_cast<size_t>(numChannels);
    std::vector<float> floatData(numSamples);
    for (size_t index = 0; index < numSamples; index++) floatData[index] = samples[index] / 32768.0f;
    std::free(samples);

    return buildAudioBuffer(std::move(floatData), numChannels, static_cast<float>(sourceRate),
                            targetSampleRate, "Ogg Vorbis");
}

/** RIFF/WAVE, through SDL. The only container any native target could read before Ogg landed. */
std::shared_ptr<AudioBuffer> decodeRiffWave(const uint8_t* data, size_t length,
                                            float targetSampleRate) {
    SDL_IOStream* io = SDL_IOFromConstMem(data, length);
    if (!io) {
        std::cerr << "[Audio] Failed to create IO stream" << std::endl;
        return nullptr;
    }

    SDL_AudioSpec spec;
    uint8_t* audioData = nullptr;
    uint32_t audioLen = 0;

    if (!SDL_LoadWAV_IO(io, true, &spec, &audioData, &audioLen)) {
        std::cerr << "[Audio] Failed to load audio: " << SDL_GetError() << std::endl;
        return nullptr;
    }

    // Convert to float if necessary
    std::vector<float> floatData;
    int numChannels = spec.channels;
    size_t numSamples = 0;

    if (spec.format == SDL_AUDIO_F32) {
        numSamples = audioLen / sizeof(float);
        floatData.resize(numSamples);
        std::memcpy(floatData.data(), audioData, audioLen);
    } else if (spec.format == SDL_AUDIO_S16) {
        numSamples = audioLen / sizeof(int16_t);
        floatData.resize(numSamples);
        const int16_t* src = reinterpret_cast<const int16_t*>(audioData);
        for (size_t i = 0; i < numSamples; i++) {
            floatData[i] = src[i] / 32768.0f;
        }
    } else if (spec.format == SDL_AUDIO_U8) {
        numSamples = audioLen;
        floatData.resize(numSamples);
        for (size_t i = 0; i < numSamples; i++) {
            floatData[i] = (audioData[i] - 128) / 128.0f;
        }
    } else {
        std::cerr << "[Audio] Unsupported audio format: " << spec.format << std::endl;
        SDL_free(audioData);
        return nullptr;
    }

    SDL_free(audioData);

    return buildAudioBuffer(std::move(floatData), numChannels, static_cast<float>(spec.freq),
                            targetSampleRate, "RIFF/WAVE");
}

}  // namespace

/**
 * Decode by what the bytes are, never by what the file is called.
 *
 * The extension is not evidence: the hand workaround for the missing Vorbis decoder was to
 * transcode to WAV *content* and keep the `.ogg` filenames, and it worked because this reads the
 * header. `asset-preflight.mjs` sniffs the same twelve bytes for the same reason.
 */
std::shared_ptr<AudioBuffer> decodeAudioFile(const uint8_t* data, size_t length, float targetSampleRate) {
    if (data == nullptr || length < 12) {
        std::cerr << "[Audio] Failed to load audio: " << length << " bytes is too short to be any "
                                                                   "audio container"
                  << std::endl;
        return nullptr;
    }
    if (std::memcmp(data, "OggS", 4) == 0) return decodeOggVorbis(data, length, targetSampleRate);
    return decodeRiffWave(data, length, targetSampleRate);
}

}  // namespace audio
}  // namespace mystral
