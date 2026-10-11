#include "check.h"
#include "threenative/abi/tn_audio.h"
#include "mystral/audio/audio_context.h"
#include <array>
#include <chrono>
#include <cmath>
#include <fstream>
#include <thread>
#include <vector>

namespace {
using Packet = std::array<double, 8>;
int64_t call(int op, int64_t context, int64_t object, Packet& p, const std::vector<uint8_t>& bytes = {}) {
    return js_tnp_audio_call(op, context, object, reinterpret_cast<int64_t>(p.data()),
        bytes.empty() ? 0 : reinterpret_cast<int64_t>(bytes.data()), bytes.size());
}
int64_t create() {
    Packet p{};
    CHECK(call(TNP_AUDIO_CREATE, 0, 0, p) == 0);
    CHECK(p[0] > 0 && p[1] == 44100);
    return int64_t(p[0]);
}
int64_t node(int64_t context, int kind) {
    Packet p{double(kind)};
    CHECK(call(TNP_AUDIO_NODE, context, 0, p) == 0);
    return int64_t(p[0]);
}
void decode_graph() {
    std::ifstream file(TN_AUDIO_FIXTURE, std::ios::binary);
    std::vector<uint8_t> ogg((std::istreambuf_iterator<char>(file)), {});
    CHECK(ogg.size() > 4);
    const auto context = create();
    Packet p{};
    CHECK(call(TNP_AUDIO_DECODE, context, 0, p, ogg) == 0);
    const auto pending = int64_t(p[0]);
    p = {};
    CHECK(call(TNP_AUDIO_POLL, context, pending, p) == 0 && p[0] == 0); // no drain, never inline
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (p[0] == 0 && std::chrono::steady_clock::now() < deadline) {
        Packet drain{};
        CHECK(call(TNP_AUDIO_DRAIN, 0, 0, drain) == 0);
        CHECK(call(TNP_AUDIO_POLL, context, pending, p) == 0);
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    CHECK(p[0] == 1 && p[2] >= 1 && p[3] > 0 && p[4] == 44100);
    if (p[0] != 1) return;
    const auto buffer = int64_t(p[1]);
    p = {0};
    CHECK(call(TNP_AUDIO_CHANNEL, context, buffer, p) == 0);
    const auto* pcm = reinterpret_cast<const float*>(uintptr_t(p[0]));
    bool audible = false;
    for (size_t i = 0; i < size_t(p[1]); ++i) {
        CHECK(std::isfinite(pcm[i]));
        audible |= std::abs(pcm[i]) > 0.001f;
    }
    CHECK(audible);
    const auto source = node(context, 1);
    const auto gain = node(context, 0);
    const auto panner = node(context, 2);
    const auto filter = node(context, 3);
    const auto compressor = node(context, 4);
    const int64_t chain[] = {source, panner, filter, gain, compressor, 0};
    for (size_t i = 1; i < 6; ++i) {
        p = {double(chain[i])}; CHECK(call(TNP_AUDIO_CONNECT, context, chain[i-1], p) == 0);
    }
    p = {double(buffer)}; CHECK(call(TNP_AUDIO_BUFFER, context, source, p) == 0);
    p = {0, 1, 0.25}; CHECK(call(TNP_AUDIO_PARAM, context, gain, p) == 0);
    p = {0, 0}; CHECK(call(TNP_AUDIO_PARAM, context, gain, p) == 0 && p[0] == 0.25);
    p = {1, 2, 1000, 0}; CHECK(call(TNP_AUDIO_PARAM, context, filter, p) == 0);
    p = {3, 2, -12, 0}; CHECK(call(TNP_AUDIO_PARAM, context, compressor, p) == 0);
    p = {4, 10, 0, -5}; CHECK(call(TNP_AUDIO_PANNER, context, panner, p) == 0);
    p = {3, 2}; CHECK(call(TNP_AUDIO_PANNER, context, panner, p) == 0);
    p = {0, 2, 3, 4}; CHECK(call(TNP_AUDIO_LISTENER, context, 0, p) == 0);
    p = {1, 0, 0, -1, 0, 1, 0}; CHECK(call(TNP_AUDIO_LISTENER, context, 0, p) == 0);
    p = {1, 0, 0}; CHECK(call(TNP_AUDIO_SOURCE_OPTIONS, context, source, p) == 0);
    p = {}; CHECK(call(TNP_AUDIO_RESUME, context, 0, p) == 0);
    p = {0, 0, -1}; CHECK(call(TNP_AUDIO_START, context, source, p) == 0);
    p = {0}; CHECK(call(TNP_AUDIO_STOP, context, source, p) == 0);
    const auto stopDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
    do {
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
        p = {}; CHECK(call(TNP_AUDIO_ENDED, context, source, p) == 0);
    } while (p[0] == 0 && std::chrono::steady_clock::now() < stopDeadline);
    CHECK(p[0] == 1);
    p = {}; CHECK(call(TNP_AUDIO_ENDED, context, source, p) == 0 && p[0] == 0);
    p = {-1}; CHECK(call(TNP_AUDIO_DISCONNECT, context, source, p) == 0);
    p = {}; CHECK(call(TNP_AUDIO_SUSPEND, context, 0, p) == 0);
    CHECK(call(TNP_AUDIO_INFO, context, 0, p) == 0 && p[2] == 0);
    p = {}; CHECK(call(TNP_AUDIO_CLOSE, context, 0, p) == 0);
}
void playback_rate() {
    const auto context = create();
    const auto source = node(context, 1);
    Packet p{8, 2, 0.5, 0}; CHECK(call(TNP_AUDIO_PARAM, context, source, p) == 0);
    p = {8, 0}; CHECK(call(TNP_AUDIO_PARAM, context, source, p) == 0 && p[0] == 0.5);
    p = {8, 4, 1.25, 0, 0.2}; CHECK(call(TNP_AUDIO_PARAM, context, source, p) == 0);
    p = {8, 0}; CHECK(call(TNP_AUDIO_PARAM, context, source, p) == 0 && p[0] == 1.25);
    p = {8, 1, -1}; CHECK(call(TNP_AUDIO_PARAM, context, source, p) != 0);
    p = {}; CHECK(call(TNP_AUDIO_CLOSE, context, 0, p) == 0);
    mystral::audio::AudioContext mixer;
    auto buffer = mixer.createBuffer(1, 8, 44100);
    for (int i = 0; i < 8; ++i) buffer->getChannelData(0)[i] = float(i) / 8;
    for (const float rate : {0.5f, 2.0f}) {
        auto voice = mixer.createBufferSource();
        voice->setBuffer(buffer); voice->playbackRate().setValue(rate); voice->start();
        float samples[4]{}; voice->process(samples, 4, 1);
        for (int i = 0; i < 4; ++i) CHECK(std::abs(samples[i] - float(i) * rate / 8) < 0.0001f);
    }
    auto voice = mixer.createBufferSource();
    voice->setBuffer(buffer); voice->setLoop(true);
    voice->setLoopStart(2.0 / 44100); voice->setLoopEnd(4.0 / 44100);
    voice->playbackRate().setValue(1.5f); voice->start();
    float samples[4]{}; voice->process(samples, 4, 1);
    CHECK(std::abs(samples[3] - 2.5f / 8) < 0.0001f);
}
void rejects() {
    auto context = create();
    Packet p{};
    auto error = call(TNP_AUDIO_DECODE, context, 0, p);
    CHECK(error && std::strstr(reinterpret_cast<const char*>(error), "AudioContext.decodeAudioData"));
    std::vector<uint8_t> damaged{0, 1, 2, 3};
    p = {}; CHECK(call(TNP_AUDIO_DECODE, context, 0, p, damaged) == 0);
    const auto pending = int64_t(p[0]);
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
    error = 0;
    while (!error && std::chrono::steady_clock::now() < deadline) {
        Packet drain{}; CHECK(call(TNP_AUDIO_DRAIN, 0, 0, drain) == 0);
        p = {}; error = call(TNP_AUDIO_POLL, context, pending, p);
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    CHECK(error && std::strstr(reinterpret_cast<const char*>(error), "TN_AUDIO_DECODE"));
    p = {1, 4, 44100}; CHECK(call(TNP_AUDIO_CREATE_BUFFER, context, 0, p) == 0);
    const auto buffer = int64_t(p[0]);
    p = {2}; error = call(TNP_AUDIO_CHANNEL, context, buffer, p);
    CHECK(error && std::strstr(reinterpret_cast<const char*>(error), "AudioBuffer.getChannelData"));
    const auto gain = node(context, 0);
    p = {0, 1, NAN}; error = call(TNP_AUDIO_PARAM, context, gain, p);
    CHECK(error && std::strstr(reinterpret_cast<const char*>(error), "nonfinite"));
    p = {}; error = call(TNP_AUDIO_START, context, gain, p);
    CHECK(error && std::strstr(reinterpret_cast<const char*>(error), "AudioBufferSourceNode.start"));
    p = {}; CHECK(call(TNP_AUDIO_CLOSE, context, 0, p) == 0);
    error = call(TNP_AUDIO_INFO, context, 0, p);
    CHECK(error && std::strstr(reinterpret_cast<const char*>(error), "TN_AUDIO_HANDLE: AudioContext"));
}
}
TN_TEST_MAIN({"decode_graph", decode_graph}, {"rejects", rejects}, {"playback_rate", playback_rate})
