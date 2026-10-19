#include "mystral/audio/audio_context.h"

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <memory>
#include <vector>

#if defined(_WIN32)
#include <windows.h>
#else
#include <unistd.h>
#endif

using mystral::audio::AudioContext;

namespace {

void sleepMs(int ms) {
#if defined(_WIN32)
    Sleep(static_cast<DWORD>(ms));
#else
    usleep(static_cast<useconds_t>(ms) * 1000);
#endif
}

bool closeTo(float actual, float expected, float tolerance = 0.0001f) {
    return std::abs(actual - expected) <= tolerance;
}

std::shared_ptr<mystral::audio::AudioBuffer> constantBuffer(AudioContext& context, size_t length = 4) {
    auto buffer = context.createBuffer(1, length, 44100.0f);
    std::fill_n(buffer->getChannelData(0), buffer->length(), 1.0f);
    return buffer;
}

/** A whole second of a sine at `hz`, so a filter's energy loss is measurable rather than transient. */
std::shared_ptr<mystral::audio::AudioBuffer> toneBuffer(AudioContext& context, float hz) {
    constexpr size_t kFrames = 44100;
    auto buffer = context.createBuffer(1, kFrames, 44100.0f);
    for (size_t i = 0; i < kFrames; i++) {
        const double t = static_cast<double>(i) / 44100.0;
        buffer->getChannelData(0)[i] = static_cast<float>(0.5 * std::sin(2.0 * 3.14159265358979 * hz * t));
    }
    return buffer;
}

float rms(const float* samples, size_t count) {
    double sum = 0.0;
    for (size_t i = 0; i < count; i++) sum += static_cast<double>(samples[i]) * samples[i];
    return static_cast<float>(std::sqrt(sum / static_cast<double>(count)));
}

}  // namespace

int main() {
#if defined(_WIN32)
    _putenv_s("SDL_AUDIO_DRIVER", "dummy");
#else
    setenv("SDL_AUDIO_DRIVER", "dummy", 1);
#endif

    AudioContext context;

    mystral::audio::AudioParam ramp(0.0f);
    ramp.setValueAtTime(0.0f, 0.0);
    ramp.linearRampToValueAtTime(1.0f, 1.0);
    if (!closeTo(ramp.valueAtTime(0.5), 0.5f)) {
        std::cerr << "gain automation failed: " << ramp.valueAtTime(0.5) << '\n';
        return 1;
    }

    auto gainSource = context.createBufferSource();
    auto gain = context.createGain();
    gain->gain().setValue(0.5f);
    gainSource->setBuffer(constantBuffer(context));
    gainSource->connect(gain.get());
    gain->connect(context.destination());
    gainSource->start();
    float gained[8] = {};
    gainSource->process(gained, 4, 2);
    if (!closeTo(gained[0], 0.5f) || !closeTo(gained[1], 0.5f)) {
        std::cerr << "gain graph failed: " << gained[0] << ", " << gained[1] << '\n';
        return 1;
    }

    // PRD-444: a constant gain is read once for the whole block; a ramp still varies per sample.
    auto blockGain = context.createGain();
    blockGain->gain().setValue(0.25f);
    if (!blockGain->gain().isConstantOver(0.0, 1.0)) {
        std::cerr << "an Immediate gain must read as constant\n";
        return 1;
    }
    auto blockSource = context.createBufferSource();
    blockSource->setBuffer(constantBuffer(context));
    blockSource->connect(blockGain.get());
    blockGain->connect(context.destination());
    blockSource->start();
    const uint64_t blockCallsBefore = blockGain->gain().valueAtTimeCalls();
    float block[8] = {};
    blockSource->process(block, 4, 2);
    const uint64_t blockCalls = blockGain->gain().valueAtTimeCalls() - blockCallsBefore;
    if (blockCalls != 1) {
        std::cerr << "a constant gain sampled " << blockCalls << " times for a 4-frame block, want 1\n";
        return 1;
    }
    if (!closeTo(block[0], 0.25f) || !closeTo(block[6], 0.25f)) {
        std::cerr << "block gain failed: " << block[0] << ", " << block[6] << '\n';
        return 1;
    }

    // Midway's gains are automated, not Immediate: a step whose time has passed, a target retargeted
    // to the value it already holds, and a target that has converged are all constant over a block.
    struct SettledCase { const char* name; float expected; void (*arm)(mystral::audio::AudioParam&); };
    const SettledCase settledCases[] = {
        {"a past setValueAtTime step", 0.75f, [](mystral::audio::AudioParam& p) { p.setValueAtTime(0.75f, -1.0); }},
        {"a target retargeted to its own value", 0.5f, [](mystral::audio::AudioParam& p) {
            p.setValue(0.5f);
            p.setTargetAtTime(0.5f, 0.0, 0.1);
        }},
        {"a converged setTargetAtTime", 0.5f, [](mystral::audio::AudioParam& p) {
            p.setValue(1.0f);
            p.setTargetAtTime(0.5f, -10.0, 0.01);
        }},
    };
    for (const auto& settled : settledCases) {
        auto gain = context.createGain();
        settled.arm(gain->gain());
        auto source = context.createBufferSource();
        source->setBuffer(constantBuffer(context));
        source->connect(gain.get());
        gain->connect(context.destination());
        source->start();
        const uint64_t before = gain->gain().valueAtTimeCalls();
        float out[8] = {};
        source->process(out, 4, 2);
        const uint64_t calls = gain->gain().valueAtTimeCalls() - before;
        if (calls != 1 || !closeTo(out[0], settled.expected) || !closeTo(out[6], settled.expected)) {
            std::cerr << settled.name << " sampled " << calls << " times (want 1) and gave " << out[0]
                      << ", " << out[6] << " (want " << settled.expected << ")\n";
            return 1;
        }
    }

    auto rampGain = context.createGain();
    rampGain->gain().setValueAtTime(0.0f, 0.0);
    rampGain->gain().linearRampToValueAtTime(1.0f, 1.0);
    if (rampGain->gain().isConstantOver(0.0, 1.0)) {
        std::cerr << "a linear ramp must not read as constant\n";
        return 1;
    }
    auto rampSource = context.createBufferSource();
    rampSource->setBuffer(constantBuffer(context));
    rampSource->connect(rampGain.get());
    rampGain->connect(context.destination());
    rampSource->start();
    const uint64_t rampCallsBefore = rampGain->gain().valueAtTimeCalls();
    float ramped[8] = {};
    rampSource->process(ramped, 4, 2);
    const uint64_t rampCalls = rampGain->gain().valueAtTimeCalls() - rampCallsBefore;
    if (rampCalls != 4) {
        std::cerr << "a ramp sampled " << rampCalls << " times for a 4-frame block, want 4\n";
        return 1;
    }

    // The exponential target a fade uses, proved on the block it renders: the first frame is still
    // silent and the last is the closed form, so a setter that only stored a value would fail.
    auto targetGain = context.createGain();
    targetGain->gain().setValueAtTime(0.0f, 0.0);
    targetGain->gain().setTargetAtTime(1.0f, context.currentTime(), 0.25);
    auto targetSource = context.createBufferSource();
    targetSource->setBuffer(constantBuffer(context));
    targetSource->connect(targetGain.get());
    targetGain->connect(context.destination());
    targetSource->start();
    float targeted[8] = {};
    targetSource->process(targeted, 4, 2);
    const float targetEnd = 1.0f - std::exp(-3.0f / 44100.0f / 0.25f);
    if (std::abs(targeted[0]) > 0.0001f || !closeTo(targeted[7], targetEnd)) {
        std::cerr << "target ramp failed: first " << targeted[0] << " last " << targeted[7]
                  << " (want 0 and " << targetEnd << ")\n";
        return 1;
    }

    auto rightSource = context.createBufferSource();
    auto panner = context.createPanner();
    rightSource->setBuffer(constantBuffer(context));
    panner->setPosition(10.0f, 0.0f, 0.0f);
    rightSource->connect(panner.get());
    panner->connect(context.destination());
    rightSource->start();
    float right[8] = {};
    rightSource->process(right, 4, 2);
    if (std::abs(right[0]) > 0.0001f || !closeTo(right[1], 0.1f)) {
        std::cerr << "right panner failed: " << right[0] << ", " << right[1] << '\n';
        return 1;
    }

    context.setListenerOrientation(0.0f, 0.0f, 1.0f, 0.0f, 1.0f, 0.0f);
    auto leftSource = context.createBufferSource();
    leftSource->setBuffer(constantBuffer(context));
    leftSource->connect(panner.get());
    leftSource->start();
    float left[8] = {};
    leftSource->process(left, 4, 2);
    if (!closeTo(left[0], 0.1f) || std::abs(left[1]) > 0.0001f) {
        std::cerr << "listener-relative panner failed: " << left[0] << ", " << left[1] << '\n';
        return 1;
    }

    auto endingSource = context.createBufferSource();
    endingSource->setBuffer(constantBuffer(context));
    endingSource->start();
    float ended[10] = {};
    endingSource->process(ended, 5, 2);
    if (endingSource->isPlaying() || !endingSource->takeEndedEvent() ||
        endingSource->takeEndedEvent()) {
        std::cerr << "source completion event was not edge-triggered\n";
        return 1;
    }

    // `start(when)` is an absolute AudioContext time: Three's `Audio.play()` passes
    // `context.currentTime + delay`. Adding `currentTime()` again rescheduled a cue fired at t
    // to 2t, so one-shots stayed silent for as long as the context had run. Needs the clock off
    // zero, so resume the (SDL opens it paused) stream and let the dummy device tick (bounded).
    context.resume();
    double now = context.currentTime();
    for (int spin = 0; now <= 0.02 && spin < 1000; spin++) {
        sleepMs(1);
        now = context.currentTime();
    }
    if (now <= 0.02) {
        std::cerr << "the audio clock never advanced; cannot prove scheduling\n";
        return 1;
    }
    auto scheduled = context.createBufferSource();
    scheduled->setBuffer(constantBuffer(context));
    scheduled->start(now);
    float scheduledOut[8] = {};
    scheduled->process(scheduledOut, 4, 2);
    if (!closeTo(scheduledOut[0], 1.0f)) {
        std::cerr << "an absolute-time start did not sound immediately: " << scheduledOut[0] << '\n';
        return 1;
    }

    // The other half of the same conditional: a cue the game schedules ahead of the clock must
    // still wait for it. A fix that simply started everything at `currentTime` would pass the
    // leg above and fire every queued gun cue in the same block.
    auto pending = context.createBufferSource();
    pending->setBuffer(constantBuffer(context));
    pending->start(now + 1.0);
    float pendingOut[8] = {};
    pending->process(pendingOut, 4, 2);
    if (!closeTo(pendingOut[0], 0.0f) || !pending->isPlaying()) {
        std::cerr << "a cue scheduled 1s ahead sounded early: " << pendingOut[0] << '\n';
        return 1;
    }

    // `lowpassHz` on the native host: a real biquad, not an inert param. A 4 kHz tone through a
    // 200 Hz low-pass loses most of its energy; the same tone unfiltered does not. Anything that
    // accepted the write and filtered nothing fails here.
    auto filterSource = context.createBufferSource();
    filterSource->setBuffer(toneBuffer(context, 4000.0f));
    auto lowpass = context.createBiquadFilter();
    if (!lowpass->setType("lowpass") || lowpass->type() != "lowpass") {
        std::cerr << "a biquad refused the only type it implements\n";
        return 1;
    }
    if (lowpass->setType("highpass")) {
        std::cerr << "a biquad accepted a type it does not filter\n";
        return 1;
    }
    lowpass->frequency().setValue(200.0f);
    filterSource->connect(lowpass.get());
    lowpass->connect(context.destination());
    filterSource->start();
    float filtered[1024] = {};
    filterSource->process(filtered, 512, 2);
    const float filteredEnergy = rms(filtered, 1024);
    float unfiltered[1024] = {};
    auto wideSource = context.createBufferSource();
    wideSource->setBuffer(toneBuffer(context, 4000.0f));
    wideSource->connect(context.destination());
    wideSource->start();
    wideSource->process(unfiltered, 512, 2);
    const float wideEnergy = rms(unfiltered, 1024);
    // The transient's first samples dominate a 200 Hz sine's ramp-up either way, so the
    // comparison is against a generous fraction rather than an exact figure.
    if (!(filteredEnergy < wideEnergy * 0.25f)) {
        std::cerr << "a 200 Hz low-pass did not attenuate a 4 kHz tone: " << filteredEnergy
                  << " against " << wideEnergy << '\n';
        return 1;
    }
    // Retuning must change the answer, or the frequency would be a number the DSP ignores.
    lowpass->frequency().setValue(20000.0f);
    float openFiltered[1024] = {};
    filterSource->connect(lowpass.get());
    filterSource->process(openFiltered, 512, 2);
    if (!(rms(openFiltered, 1024) > filteredEnergy)) {
        std::cerr << "opening the low-pass did not restore energy\n";
        return 1;
    }

    // The bus compressor: post-mix, so it holds down a sum rather than one voice. Two voices at
    // -6 dBFS each are quiet individually and clip when summed; post-mix they come out under.
    auto compressor = context.createDynamicsCompressor();
    if (!compressor->postMix()) {
        std::cerr << "a compressor must declare itself post-mix\n";
        return 1;
    }
    compressor->threshold().setValue(-20.0f);
    compressor->knee().setValue(0.0f);
    compressor->ratio().setValue(4.0f);
    compressor->attack().setValue(0.0f);
    compressor->release().setValue(0.0f);
    compressor->connect(context.destination());
    if (context.destination()->postMixCount() != 1) {
        std::cerr << "connecting a compressor did not register it for post-mix processing\n";
        return 1;
    }
    float loud[512] = {};
    std::fill_n(loud, 512, 0.5f);
    // A block through the node directly, then through the mixer's own post-mix pass, must agree:
    // the sum is the compressor's only legal input and the mixer is what feeds it.
    float direct[512] = {};
    std::copy_n(loud, 512, direct);
    compressor->process(direct, 256, 2);
    if (compressor->reduction() >= 0.0f) {
        std::cerr << "a 0.5 signal did not pull a -20 dB threshold down: " << compressor->reduction()
                  << '\n';
        return 1;
    }
    float quiet[512] = {};
    std::fill_n(quiet, 512, 0.01f);
    float unquiet[512] = {};
    std::copy_n(quiet, 512, unquiet);
    compressor->process(unquiet, 256, 2);
    if (std::abs(compressor->reduction()) > 0.001f) {
        std::cerr << "a signal below the threshold was still reduced: " << compressor->reduction()
                  << '\n';
        return 1;
    }
    // A DC-ish input passes untouched, which is what makes the reduction above a real measurement
    // rather than a constant offset.
    std::fill_n(direct, 512, 0.001f);
    compressor->process(direct, 256, 2);
    if (!closeTo(direct[0], 0.001f, 0.0005f)) {
        std::cerr << "a below-threshold signal was not passed through: " << direct[0] << '\n';
        return 1;
    }

    // Disconnecting lifts it out of the mix, so a disposed compressor stops processing.
    compressor->disconnect(context.destination());
    if (context.destination()->postMixCount() != 0) {
        std::cerr << "disconnecting a compressor left it in the post-mix chain\n";
        return 1;
    }
    compressor->connect(context.destination());
    if (context.destination()->postMixCount() != 1) {
        std::cerr << "reconnecting a compressor did not restore it\n";
        return 1;
    }

    // The real `AudioBus` topology, driven through the mixer: two voices into ONE compressor, then
    // the listener's master gain, then the destination — plus a second bus that reaches the same
    // master gain without a compressor. `compressor.connect(destination)` above proved a node the
    // mixer would run; it said nothing about the graph the game actually builds, where the
    // compressor's own downstream is a gain and never the destination.
    float compressed = 0.0f;
    float bypass = 0.0f;
    {
        AudioContext bus;
        auto busCompressor = bus.createDynamicsCompressor();
        busCompressor->threshold().setValue(-20.0f);
        busCompressor->knee().setValue(0.0f);
        busCompressor->ratio().setValue(4.0f);
        busCompressor->attack().setValue(0.0f);
        busCompressor->release().setValue(0.0f);
        auto master = bus.createGain();
        master->gain().setValue(0.42f);
        busCompressor->connect(master.get());
        master->connect(bus.destination());
        if (bus.destination()->postMixCount() != 1) {
            std::cerr << "a compressor wired into a master gain was not registered as a sum boundary\n";
            return 1;
        }

        // Two voices, each -6 dBFS. On their own neither crosses the -20 dB threshold, so a
        // per-source compressor leaves them alone; summed they reach 0 dBFS and must come down.
        const size_t kFrames = 256;
        constexpr size_t kLongEnough = 1u << 16;
        std::vector<std::unique_ptr<mystral::audio::AudioBufferSourceNode>> voices;
        std::vector<std::unique_ptr<mystral::audio::GainNode>> voiceGains;
        for (int voice = 0; voice < 2; voice++) {
            auto source = bus.createBufferSource();
            source->setBuffer(constantBuffer(bus, kLongEnough));
            auto gain = bus.createGain();
            gain->gain().setValue(0.5f);
            source->connect(gain.get());
            gain->connect(busCompressor.get());
            source->start();
            voices.push_back(std::move(source));
            voiceGains.push_back(std::move(gain));
        }
        // The bypass bus: the same master gain, no compressor, so it must be bit-identical whatever
        // the compressor is doing to its own bus.
        auto bypassSource = bus.createBufferSource();
        bypassSource->setBuffer(constantBuffer(bus, kLongEnough));
        auto bypassGain = bus.createGain();
        bypassGain->gain().setValue(0.25f);
        bypassSource->connect(bypassGain.get());
        bypassGain->connect(master.get());
        bypassSource->start();

        std::vector<float> mixed(kFrames * 2, 0.0f);
        bus.renderBlock(mixed.data(), static_cast<int>(kFrames));
        compressed = mixed[kFrames - 2];
        // The bypass bus measured on its own, with the compressor's voices out of the way.
        for (auto& voice : voices) voice->stop(bus.currentTime());
        std::vector<float> bypassOnly(kFrames * 2, 0.0f);
        bus.renderBlock(bypassOnly.data(), static_cast<int>(kFrames));
        bypass = bypassOnly[kFrames - 2];

        // Summed, the two voices reach 0 dBFS — 20 dB over a -20 dB threshold at 4:1, so 15 dB of
        // reduction — and only then the master gain's 0.42, which is the order the graph wires them
        // in. Gain first would give 0.1416 for the bus against 0.0747 here; per-source compression
        // would have left each 0.5 voice alone at 0.21. The bypass bus rides the same master gain.
        const float expectedCompressed = std::pow(10.0f, -15.0f / 20.0f) * 0.42f;
        const float expectedMixed = expectedCompressed + 0.25f * 0.42f;
        if (!(compressed < 2.0f * 0.5f * 0.42f + 0.25f * 0.42f)) {
            std::cerr << "two voices summed through a compressor were not held down at all: "
                      << compressed << '\n';
            return 1;
        }
        if (std::abs(compressed - expectedMixed) > 0.001f) {
            std::cerr << "the compressor bus did not reduce the sum by 15 dB and then apply the "
                         "master gain: "
                      << compressed << " against " << expectedMixed << '\n';
            return 1;
        }
        if (std::abs(bypass - 0.25f * 0.42f) > 0.0001f) {
            std::cerr << "a bus bypassing the compressor was altered by it: " << bypass << " against "
                      << 0.25f * 0.42f << '\n';
            return 1;
        }

        // Disconnecting the compressor must take the two voices out of the mix entirely and leave
        // the bypass bus exactly where it was.
        busCompressor->disconnect(master.get());
        for (auto& voice : voices) voice->start();
        bypassSource->start();
        std::vector<float> disconnected(kFrames * 2, 0.0f);
        bus.renderBlock(disconnected.data(), static_cast<int>(kFrames));
        if (std::abs(disconnected[kFrames - 2] - 0.25f * 0.42f) > 0.0001f) {
            std::cerr << "disconnecting the compressor did not silence its own bus: "
                      << disconnected[kFrames - 2] << '\n';
            return 1;
        }
    }

    // The soft knee. Web Audio's `knee` spans `[-knee/2, +knee/2]` around the threshold: no
    // reduction below it, a quadratic ease across it, and the straight ratio line above. The defect
    // this catches is the direction of the reduction — a compressor must never add gain, and the
    // previous form produced +11 dB for a signal 1 dB over a 30 dB knee.
    {
        AudioContext kneeContext;
        const float threshold = -20.0f;
        const float knee = 30.0f;
        const float ratio = 5.0f;
        auto probe = kneeContext.createDynamicsCompressor();
        probe->threshold().setValue(threshold);
        probe->knee().setValue(knee);
        probe->ratio().setValue(ratio);
        probe->attack().setValue(0.0f);
        probe->release().setValue(0.0f);
        // A fresh node per level: the reduction is carried between blocks by design, and this sweep
        // is about the curve, not about an envelope settling.
        // Levels chosen to straddle every branch of the curve: below the knee, at its lower edge,
        // inside it, just over the threshold (where the old form amplified hardest — 1 dB over a
        // 30 dB knee gave +11.2 dB of *gain*), at its upper edge, and far above it.
        const std::vector<float> levels = {-60.0f, -40.0f, -35.5f, -35.0f, -30.0f, -20.0f, -19.0f,
                                           -10.0f, -5.0f, -4.9f, 0.0f, 3.0f};
        float previousReduction = 0.0f;
        float previousLevel = 1e9f;
        for (const float levelDb : levels) {
            auto node = kneeContext.createDynamicsCompressor();
            node->threshold().setValue(threshold);
            node->knee().setValue(knee);
            node->ratio().setValue(ratio);
            node->attack().setValue(0.0f);
            node->release().setValue(0.0f);
            const float level = std::pow(10.0f, levelDb / 20.0f);
            std::vector<float> block(64 * 2, level);
            node->process(block.data(), 64, 2);
            const float reduction = node->reduction();
            if (reduction > 0.0001f) {
                std::cerr << "a " << levelDb << " dB signal through a -20 dB threshold was boosted "
                          << reduction << " dB\n";
                return 1;
            }
            if (reduction > previousReduction + 0.0001f) {
                std::cerr << "the knee curve is not monotonic: " << previousLevel << " dB gave "
                          << previousReduction << " dB and " << levelDb << " dB gave " << reduction
                          << " dB\n";
                return 1;
            }
            // Nothing below `-knee/2` of the threshold is touched at all.
            if (levelDb < threshold - knee * 0.5f && std::abs(reduction) > 0.0001f) {
                std::cerr << "a " << levelDb << " dB signal was reduced " << reduction
                          << " dB below the knee\n";
                return 1;
            }
            // Past the top of the knee it is the straight ratio line: `ratio:1` identity below.
            const float overshoot = levelDb - threshold;
            if (overshoot > knee * 0.5f) {
                const float expected = (1.0f / ratio - 1.0f) * overshoot;
                if (std::abs(reduction - expected) > 0.01f) {
                    std::cerr << "above the knee the curve is not the ratio line: " << levelDb
                              << " dB gave " << reduction << " dB against " << expected << " dB\n";
                    return 1;
                }
            }
            // Continuity at the knee's lower edge, where the quadratic starts from zero.
            if (levelDb == -35.0f && std::abs(reduction) > 0.001f) {
                std::cerr << "the knee did not start from unity at its lower edge: " << reduction
                          << " dB\n";
                return 1;
            }
            previousReduction = reduction;
            previousLevel = levelDb;
        }

        // `ratio: 1` is the identity: a compressor asked not to compress must not touch the signal.
        auto unity = kneeContext.createDynamicsCompressor();
        unity->threshold().setValue(threshold);
        unity->knee().setValue(knee);
        unity->ratio().setValue(1.0f);
        unity->attack().setValue(0.0f);
        unity->release().setValue(0.0f);
        std::vector<float> unityBlock(64 * 2, 0.9f);
        unity->process(unityBlock.data(), 64, 2);
        if (std::abs(unity->reduction()) > 0.0001f || !closeTo(unityBlock[0], 0.9f, 0.0005f)) {
            std::cerr << "ratio 1 was not an identity: reduction " << unity->reduction() << " dB, out "
                      << unityBlock[0] << '\n';
            return 1;
        }
        // Silence is untouched, which is what makes the checks above measurements.
        auto silent = kneeContext.createDynamicsCompressor();
        silent->threshold().setValue(threshold);
        silent->knee().setValue(knee);
        silent->ratio().setValue(ratio);
        silent->attack().setValue(0.0f);
        silent->release().setValue(0.0f);
        std::vector<float> silence(64 * 2, 0.0f);
        silent->process(silence.data(), 64, 2);
        if (std::abs(silent->reduction()) > 0.0001f) {
            std::cerr << "silence was reduced " << silent->reduction() << " dB\n";
            return 1;
        }
    }

    std::cout << "audio graph ok: ramp-mid=0.5 gain=0.5 right=0.1 flipped-left=0.1 ended=1"
              << " absolute-start=1 scheduled-ahead=0"
              << " lowpass=attenuated postmix=1 reduction=" << compressor->reduction()
              << " bus-sum=" << compressed << " bypass=" << bypass
              << " target-ramp-first=" << targeted[0] << " target-ramp-last=" << targeted[7] << '\n';
    return 0;
}
