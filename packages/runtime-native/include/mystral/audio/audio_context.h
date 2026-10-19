/**
 * Web Audio API Implementation
 *
 * Provides AudioContext, AudioBufferSourceNode, GainNode using SDL3 audio.
 * Implements a subset of the W3C Web Audio API specification.
 */

#pragma once

#include <array>
#include <atomic>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>
#include <mutex>

struct SDL_AudioStream;

namespace mystral {
namespace audio {

// Forward declarations
class AudioContext;
class AudioNode;
class AudioBuffer;
class AudioBufferSourceNode;
class GainNode;
class PannerNode;
class BiquadFilterNode;
class DynamicsCompressorNode;
class AudioDestinationNode;

struct AudioVector3 {
    float x;
    float y;
    float z;
};

/**
 * AudioBuffer - holds decoded audio data
 */
class AudioBuffer {
public:
    AudioBuffer(float sampleRate, int numberOfChannels, size_t length);
    ~AudioBuffer();

    float sampleRate() const { return sampleRate_; }
    int numberOfChannels() const { return numberOfChannels_; }
    size_t length() const { return length_; }
    double duration() const { return static_cast<double>(length_) / sampleRate_; }

    // Get channel data (returns pointer to float samples)
    float* getChannelData(int channel);
    const float* getChannelData(int channel) const;

    // Set data from interleaved samples
    void setFromInterleaved(const float* data, size_t numSamples, int numChannels);

private:
    float sampleRate_;
    int numberOfChannels_;
    size_t length_;  // Number of sample frames
    std::vector<std::vector<float>> channelData_;
};

/**
 * AudioParam - represents an audio parameter that can be automated
 */
class AudioParam {
public:
    AudioParam(float defaultValue = 1.0f);

    float value() const { return targetValue_.load(std::memory_order_relaxed); }
    void setValue(float value);
    void setValueAtTime(float value, double time);
    void linearRampToValueAtTime(float value, double endTime);
    void setTargetAtTime(float value, double startTime, double timeConstant);
    float valueAtTime(double time) const;

    /**
     * True when the value does not change over `[from, to]`, so a caller may read it once for the
     * block instead of per sample. Beyond `Immediate`, a game's automated gain is usually settled:
     * a step whose time has passed, a finished ramp, a target retargeted to the value it holds, or a
     * target converged below a millionth of its value. A ramp or target still moving is not.
     */
    bool isConstantOver(double from, double to) const;

    /** How many times `valueAtTime` was sampled. A readout for a block-hoist test, not a signal. */
    uint64_t valueAtTimeCalls() const {
        return valueAtTimeCalls_.load(std::memory_order_relaxed);
    }

private:
    enum class Automation { Immediate, Scheduled, Linear, Target };

    std::atomic<float> startValue_;
    std::atomic<float> targetValue_;
    std::atomic<double> startTime_{0.0};
    std::atomic<double> endOrConstant_{0.0};
    std::atomic<Automation> automation_{Automation::Immediate};
    mutable std::atomic<uint64_t> valueAtTimeCalls_{0};
};

/**
 * AudioNode - base class for all audio nodes
 */
class AudioNode {
public:
    AudioNode(AudioContext* context);
    virtual ~AudioNode() = default;

    AudioContext* context() const { return context_; }

    virtual void connect(AudioNode* destination);
    virtual void disconnect();
    virtual void disconnect(AudioNode* destination);

    /**
     * True for a node that must see the summed mix rather than one voice at a time.
     *
     * The mixer pulls: it processes each active source through its own chain and adds the
     * result, so anything in that chain sees one voice. A compressor is the one node for which
     * that is the wrong input — its whole job is holding down cues that are each fine and add up
     * to too much — so it declares itself post-mix and becomes a sum boundary: a voice whose chain
     * reaches it stops there and contributes to its accumulator, and the node runs once per block
     * on everything that arrived, with its own downstream chain after it.
     */
    virtual bool postMix() const { return false; }

    // For audio processing
    virtual void process(float* output, size_t numFrames, int numChannels);

    /**
     * Take one voice's block into this sum boundary instead of processing it.
     *
     * The block is zeroed on the way in: it has left the forward walk, so whatever the mixer was
     * going to add from that buffer is now carried by this node's accumulator.
     */
    void accumulate(const float* input, size_t count);

    /**
     * Run this boundary once on what accumulated, forward it down its own chain, and add the
     * result to `output`. Leaves the accumulator zeroed for the next block.
     */
    void flushSum(float* output, size_t numFrames, int numChannels);

protected:
    AudioContext* context_;
    std::vector<AudioNode*> outputs_;
    /** Block-sized accumulator for a sum boundary. Written on the audio thread only. */
    std::vector<float> sum_;
};

/**
 * AudioDestinationNode - represents the final audio output
 */
class AudioDestinationNode : public AudioNode {
public:
    AudioDestinationNode(AudioContext* context);

    int maxChannelCount() const { return 2; }  // Stereo output

    /** Register a node the mixer must run once on the summed output. See `AudioNode::postMix`. */
    void addPostMix(AudioNode* node);
    void removePostMix(AudioNode* node);
    /** How many post-mix nodes are registered. For a contract proof, not a signal. */
    size_t postMixCount() const;
    /** The registered chain, in connect order. Read under `AudioContext::mixMutex`. */
    const std::vector<AudioNode*>& postMixNodes() const { return postMix_; }

private:
    std::vector<AudioNode*> postMix_;
};

/**
 * GainNode - adjusts audio volume
 */
class GainNode : public AudioNode {
public:
    GainNode(AudioContext* context);

    AudioParam& gain() { return gain_; }
    const AudioParam& gain() const { return gain_; }

    void process(float* output, size_t numFrames, int numChannels) override;

private:
    AudioParam gain_;
};

/**
 * PannerNode - bounded positional audio for Three.js PositionalAudio.
 *
 * The native host implements listener-relative stereo pan plus Web Audio's
 * inverse, linear, and exponential distance models. HRTF convolution and
 * directional cones remain outside this bounded mixer.
 */
class PannerNode : public AudioNode {
public:
    explicit PannerNode(AudioContext* context);

    void setPosition(float x, float y, float z);
    void setRefDistance(float value);
    void setMaxDistance(float value);
    void setRolloffFactor(float value);
    bool setDistanceModel(const std::string& value);

    void process(float* output, size_t numFrames, int numChannels) override;

private:
    enum class DistanceModel { Inverse, Linear, Exponential };

    std::atomic<float> x_{0.0f};
    std::atomic<float> y_{0.0f};
    std::atomic<float> z_{0.0f};
    std::atomic<float> refDistance_{1.0f};
    std::atomic<float> maxDistance_{10000.0f};
    std::atomic<float> rolloffFactor_{1.0f};
    std::atomic<DistanceModel> distanceModel_{DistanceModel::Inverse};
};

/**
 * BiquadFilterNode - the low-pass @threenative/core's AudioBus builds for `lowpassHz`.
 *
 * Only `lowpass` is implemented, and `setType` refuses the other Web Audio types rather than
 * accepting a type it does not honour: a cue that asked for a high-pass and got an unfiltered
 * signal is quieter about being wrong than one that is told. The coefficients are RBJ, computed
 * once per block from `frequency` and `Q`.
 */
class BiquadFilterNode : public AudioNode {
public:
    explicit BiquadFilterNode(AudioContext* context);

    bool setType(const std::string& value);
    std::string type() const { return "lowpass"; }

    AudioParam& frequency() { return frequency_; }
    const AudioParam& frequency() const { return frequency_; }
    AudioParam& q() { return q_; }
    const AudioParam& q() const { return q_; }

    void process(float* output, size_t numFrames, int numChannels) override;

private:
    AudioParam frequency_{350.0f};
    AudioParam q_{1.0f};
    /** Per-channel biquad delay line: x1, x2, y1, y2. Two channels is the whole output. */
    std::vector<std::array<float, 4>> state_;
};

/**
 * DynamicsCompressorNode - bus-level dynamics for `AudioBus`'s `compressor` option.
 *
 * A standard feed-forward compressor: an envelope follower over the peak of the block, a soft
 * knee around `threshold`, and the resulting gain reduction smoothed by `attack` and `release`.
 * It runs on the bus sum, which is what makes it a bus compressor rather than a per-voice one.
 */
class DynamicsCompressorNode : public AudioNode {
public:
    explicit DynamicsCompressorNode(AudioContext* context);

    AudioParam& threshold() { return threshold_; }
    const AudioParam& threshold() const { return threshold_; }
    AudioParam& knee() { return knee_; }
    const AudioParam& knee() const { return knee_; }
    AudioParam& ratio() { return ratio_; }
    const AudioParam& ratio() const { return ratio_; }
    AudioParam& attack() { return attack_; }
    const AudioParam& attack() const { return attack_; }
    AudioParam& release() { return release_; }
    const AudioParam& release() const { return release_; }

    bool postMix() const override { return true; }

    /** Current gain reduction in dB, negative or zero. Read back by a mix check. */
    float reduction() const { return reduction_.load(std::memory_order_relaxed); }

    void process(float* output, size_t numFrames, int numChannels) override;

private:
    AudioParam threshold_{-24.0f};
    AudioParam knee_{30.0f};
    AudioParam ratio_{12.0f};
    AudioParam attack_{0.003f};
    AudioParam release_{0.25f};
    /**
     * The smoothed reduction in dB, carried between blocks.
     *
     * It has to be: the mixer hands the node one block at a time, and an envelope restarted at
     * unity every block pumps audibly on a 3 ms attack — once every ~11 ms at 44.1 kHz.
     */
    std::atomic<float> reduction_{0.0f};
};

/**
 * AudioBufferSourceNode - plays an AudioBuffer
 */
class AudioBufferSourceNode : public AudioNode {
public:
    AudioBufferSourceNode(AudioContext* context);
    ~AudioBufferSourceNode();

    void setBuffer(std::shared_ptr<AudioBuffer> buffer);
    std::shared_ptr<AudioBuffer> buffer() const { return buffer_; }

    bool loop() const { return loop_; }
    void setLoop(bool loop) { loop_ = loop; }

    double loopStart() const { return loopStart_; }
    void setLoopStart(double time) { loopStart_ = time; }

    double loopEnd() const { return loopEnd_; }
    void setLoopEnd(double time) { loopEnd_ = time; }

    // Playback control
    void start(double when = 0, double offset = 0, double duration = -1);
    void stop(double when = 0);

    bool isPlaying() const { return isPlaying_.load(std::memory_order_acquire); }
    bool takeEndedEvent() { return endedPending_.exchange(false, std::memory_order_acq_rel); }

    void process(float* output, size_t numFrames, int numChannels) override;

private:
    std::shared_ptr<AudioBuffer> buffer_;
    bool loop_ = false;
    double loopStart_ = 0;
    double loopEnd_ = 0;
    std::atomic<bool> isPlaying_{false};
    std::atomic<bool> endedPending_{false};
    size_t playbackPosition_ = 0;
    double startTime_ = 0;
    std::atomic<double> stopTime_{-1};
    double offsetTime_ = 0;
    double durationTime_ = -1;
};

/**
 * AudioContext - main interface for Web Audio API
 */
class AudioContext {
public:
    AudioContext();
    ~AudioContext();

    // State
    enum class State { Suspended, Running, Closed };
    State state() const {
        std::lock_guard<std::mutex> lock(lifecycleMutex_);
        return state_;
    }

    // Properties
    float sampleRate() const { return sampleRate_; }
    double currentTime() const;
    AudioDestinationNode* destination() { return destination_.get(); }

    // Factory methods
    std::shared_ptr<AudioBuffer> createBuffer(int numberOfChannels, size_t length, float sampleRate);
    std::unique_ptr<AudioBufferSourceNode> createBufferSource();
    std::unique_ptr<GainNode> createGain();
    std::unique_ptr<PannerNode> createPanner();
    std::unique_ptr<BiquadFilterNode> createBiquadFilter();
    std::unique_ptr<DynamicsCompressorNode> createDynamicsCompressor();

    void setListenerPosition(float x, float y, float z);
    void setListenerOrientation(float forwardX, float forwardY, float forwardZ,
                                float upX, float upY, float upZ);
    AudioVector3 listenerPosition() const;
    AudioVector3 listenerRight() const;

    // Decode audio data (async in browser, sync here for simplicity)

    // Lifecycle
    void resume();
    void suspend();
    void close();

    /**
     * Suspend/resume driven by the host's application lifecycle rather than by the game.
     * Tracked separately so that resuming from the background never un-suspends a context the
     * game itself had chosen to suspend.
     */
    void suspendForHost();
    void resumeForHost();
    bool hostSuspended() const {
        std::lock_guard<std::mutex> lock(lifecycleMutex_);
        return hostSuspended_;
    }

    // Internal: register/unregister active source nodes
    void registerSource(AudioBufferSourceNode* source);
    void unregisterSource(AudioBufferSourceNode* source);
    void detachSources();

    /**
     * Mix one block: every playing voice through its chain, the post-mix sums, then the clamp.
     *
     * The body of `audioCallback`, public because the mixer is the thing a routing claim is about
     * and a test has to be able to render a block through it to prove one.
     */
    void renderBlock(float* output, int numFrames);

    /**
     * Guards the post-mix chain against the audio thread.
     *
     * The destination registers a post-mix node from `connect`, which is a JavaScript thread, and
     * runs the chain from `audioCallback`, which is SDL's. The vector they share is not atomic,
     * so both take this.
     */
    std::mutex& mixMutex() { return mixMutex_; }

private:
    void audioCallback(float* output, int numFrames);
    static void sdlAudioCallback(void* userdata, SDL_AudioStream* stream, int additionalAmount, int totalAmount);
    void resumeLocked();
    void suspendLocked();
    void closeLocked();

    mutable std::mutex lifecycleMutex_;
    State state_ = State::Suspended;
    bool hostSuspended_ = false;
    float sampleRate_ = 44100.0f;
    uint64_t startTime_ = 0;
    std::atomic<uint64_t> sampleCount_{0};

    std::unique_ptr<AudioDestinationNode> destination_;
    std::vector<AudioBufferSourceNode*> activeSources_;
    std::mutex sourcesMutex_;
    std::mutex mixMutex_;
    std::array<float, 8192> sourceBuffer_{};
    std::array<float, 8192> callbackBuffer_{};

    std::atomic<float> listenerX_{0.0f};
    std::atomic<float> listenerY_{0.0f};
    std::atomic<float> listenerZ_{0.0f};
    std::atomic<float> listenerForwardX_{0.0f};
    std::atomic<float> listenerForwardY_{0.0f};
    std::atomic<float> listenerForwardZ_{-1.0f};
    std::atomic<float> listenerUpX_{0.0f};
    std::atomic<float> listenerUpY_{1.0f};
    std::atomic<float> listenerUpZ_{0.0f};

    // SDL audio
    uint32_t audioDevice_ = 0;
    SDL_AudioStream* audioStream_ = nullptr;
    std::atomic<bool> shuttingDown_{false};
};

/**
 * Every live AudioContext, so the host can suspend them when the app is backgrounded.
 *
 * `suspend()` and `resume()` existed but were reachable only from JavaScript, and a backgrounded
 * app's JavaScript is exactly what stops running — so nothing ever called them and audio kept
 * playing with the screen off. Each context registers itself on construction.
 */
void suspendAllContexts();
void resumeAllContexts();

/** How many contexts are registered. For proofs, and for the resume marker. */
size_t liveContextCount();

/**
 * Decode audio file data (WAV, MP3, OGG, etc.)
 * Returns nullptr on failure.
 */
std::shared_ptr<AudioBuffer> decodeAudioFile(const uint8_t* data, size_t length, float targetSampleRate);

}  // namespace audio
}  // namespace mystral
