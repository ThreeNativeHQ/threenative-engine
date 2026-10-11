// Numeric handles over the shipped SDL WebAudio and its async decoder; no VM state here.
#include <limits>
#include "threenative/abi/tn_audio.h"
#include "mystral/audio/audio_context.h"
#include "mystral/audio/async_audio_decode.h"
#include <cmath>
#include <map>
#include <stdexcept>

namespace {
using namespace mystral::audio;
struct Session {
    AudioContext context;
    std::map<int64_t, std::unique_ptr<AudioNode>> nodes;
    std::map<int64_t, std::shared_ptr<AudioBuffer>> buffers;
    std::map<int64_t, DecodedAudio> decodes;
    int64_t next = 1;
    ~Session() { context.close(); context.detachSources(); }
    AudioNode* node(int64_t id) {
        if (id == 0) return context.destination();
        const auto it = nodes.find(id);
        if (it == nodes.end()) throw std::runtime_error("TN_AUDIO_HANDLE: AudioNode");
        return it->second.get();
    }
    std::shared_ptr<AudioBuffer> buffer(int64_t id) {
        const auto it = buffers.find(id);
        if (it == buffers.end()) throw std::runtime_error("TN_AUDIO_HANDLE: AudioBuffer");
        return it->second;
    }
    template<class T> T* as(int64_t id, const char* member) {
        auto* value = dynamic_cast<T*>(node(id));
        if (!value) throw std::runtime_error(std::string("TN_AUDIO_MEMBER: ") + member);
        return value;
    }
};
// Only the game thread accesses handles; decode callbacks run on that thread's drain.
std::map<int64_t, std::shared_ptr<Session>> sessions;
int64_t nextSession = 1;
thread_local std::string failure;
void info(double* p, int64_t id, const AudioBuffer& buffer) {
    p[0] = id; p[1] = buffer.numberOfChannels(); p[2] = buffer.length(); p[3] = buffer.sampleRate();
}
AudioParam& parameter(Session& s, int64_t id, int kind) {
    switch (kind) {
        case 0: return s.as<GainNode>(id, "GainNode.gain")->gain();
        case 1: return s.as<BiquadFilterNode>(id, "BiquadFilterNode.frequency")->frequency();
        case 2: return s.as<BiquadFilterNode>(id, "BiquadFilterNode.Q")->q();
        case 3: return s.as<DynamicsCompressorNode>(id, "DynamicsCompressorNode.threshold")->threshold();
        case 4: return s.as<DynamicsCompressorNode>(id, "DynamicsCompressorNode.knee")->knee();
        case 5: return s.as<DynamicsCompressorNode>(id, "DynamicsCompressorNode.ratio")->ratio();
        case 6: return s.as<DynamicsCompressorNode>(id, "DynamicsCompressorNode.attack")->attack();
        case 7: return s.as<DynamicsCompressorNode>(id, "DynamicsCompressorNode.release")->release();
        case 8: return s.as<AudioBufferSourceNode>(id, "AudioBufferSourceNode.playbackRate")->playbackRate();
        default: throw std::runtime_error("TN_AUDIO_MEMBER: AudioParam");
    }
}
}
extern "C" int64_t js_tnp_audio_call(int32_t op, int64_t context, int64_t object,
                                     int64_t packet, int64_t data, int64_t bytes) {
    try {
        if (!packet) throw std::runtime_error("TN_AUDIO_ARGUMENT: packet");
        auto* p = reinterpret_cast<double*>(packet);
        for (int i = 0; i < 8; ++i)
            if (!std::isfinite(p[i])) throw std::runtime_error("TN_AUDIO_ARGUMENT: nonfinite value");
        if (op == TNP_AUDIO_DRAIN) { AsyncAudioDecoder::instance().drain(); return 0; }
        if (op == TNP_AUDIO_CREATE) {
            const auto id = nextSession++;
            auto session = std::make_shared<Session>();
            sessions.emplace(id, session);
            p[0] = id; p[1] = session->context.sampleRate();
            return 0;
        }
        const auto it = sessions.find(context);
        if (it == sessions.end()) throw std::runtime_error("TN_AUDIO_HANDLE: AudioContext");
        const auto session = it->second;
        auto& s = *session;
        switch (op) {
            case TNP_AUDIO_INFO:
                p[0] = s.context.sampleRate(); p[1] = s.context.currentTime(); p[2] = int(s.context.state()); break;
            case TNP_AUDIO_RESUME: s.context.resume(); break;
            case TNP_AUDIO_SUSPEND: s.context.suspend(); break;
            case TNP_AUDIO_CLOSE: sessions.erase(it); break;
            case TNP_AUDIO_NODE: {
                if (s.nodes.size() >= 65536) throw std::runtime_error("TN_AUDIO_CAPACITY: AudioNode");
                std::unique_ptr<AudioNode> node;
                switch (int(p[0])) {
                    case 0: node = s.context.createGain(); break;
                    case 1: node = s.context.createBufferSource(); break;
                    case 2: node = s.context.createPanner(); break;
                    case 3: node = s.context.createBiquadFilter(); break;
                    case 4: node = s.context.createDynamicsCompressor(); break;
                    default: throw std::runtime_error("TN_AUDIO_MEMBER: AudioContext.createNode");
                }
                const auto id = s.next++; s.nodes.emplace(id, std::move(node)); p[0] = id; break;
            }
            case TNP_AUDIO_CONNECT: s.node(object)->connect(s.node(int64_t(p[0]))); break;
            case TNP_AUDIO_DISCONNECT:
                if (p[0] < 0) s.node(object)->disconnect();
                else s.node(object)->disconnect(s.node(int64_t(p[0])));
                break;
            case TNP_AUDIO_BUFFER:
                s.as<AudioBufferSourceNode>(object, "AudioBufferSourceNode.buffer")->setBuffer(p[0] == 0 ? nullptr : s.buffer(int64_t(p[0]))); break;
            case TNP_AUDIO_SOURCE_OPTIONS: {
                auto* node = s.as<AudioBufferSourceNode>(object, "AudioBufferSourceNode.loop");
                if (p[1] < 0 || p[2] < 0) throw std::runtime_error("TN_AUDIO_ARGUMENT: AudioBufferSourceNode.loopStart/loopEnd");
                node->setLoop(p[0] != 0); node->setLoopStart(p[1]); node->setLoopEnd(p[2]); break;
            }
            case TNP_AUDIO_START:
                if (p[0] < 0 || p[1] < 0 || p[2] < -1) throw std::runtime_error("TN_AUDIO_ARGUMENT: AudioBufferSourceNode.start");
                s.as<AudioBufferSourceNode>(object, "AudioBufferSourceNode.start")->start(p[0], p[1], p[2]); break;
            case TNP_AUDIO_STOP:
                if (p[0] < 0) throw std::runtime_error("TN_AUDIO_ARGUMENT: AudioBufferSourceNode.stop");
                s.as<AudioBufferSourceNode>(object, "AudioBufferSourceNode.stop")->stop(p[0]); break;
            case TNP_AUDIO_ENDED: p[0] = s.as<AudioBufferSourceNode>(object, "AudioBufferSourceNode.onended")->takeEndedEvent(); break;
            case TNP_AUDIO_PARAM: {
                if (int(p[0]) == 8 && p[1] >= 1 && p[1] <= 4 && (p[2] < 0 || p[2] > std::numeric_limits<float>::max()))
                    throw std::runtime_error("TN_AUDIO_ARGUMENT: AudioBufferSourceNode.playbackRate");
                auto& param = parameter(s, object, int(p[0]));
                switch (int(p[1])) {
                    case 0: p[0] = param.value(); break;
                    case 1: param.setValue(float(p[2])); break;
                    case 2: param.setValueAtTime(float(p[2]), p[3]); break;
                    case 3: param.linearRampToValueAtTime(float(p[2]), p[3]); break;
                    case 4: param.setTargetAtTime(float(p[2]), p[3], p[4]); break;
                    case 5: param.setValue(param.valueAtTime(p[3])); break;
                    default: throw std::runtime_error("TN_AUDIO_MEMBER: AudioParam.automation");
                }
                break;
            }
            case TNP_AUDIO_DECODE: {
                if (!data || bytes <= 0 || bytes > 64 * 1024 * 1024)
                    throw std::runtime_error("TN_AUDIO_ARGUMENT: AudioContext.decodeAudioData");
                if (s.decodes.size() >= 512) throw std::runtime_error("TN_AUDIO_CAPACITY: decodeAudioData");
                const auto id = s.next++;
                s.decodes.emplace(id, DecodedAudio{});
                const auto* input = reinterpret_cast<const uint8_t*>(data);
                std::weak_ptr<Session> weak = session;
                AsyncAudioDecoder::instance().decode({input, input + bytes}, s.context.sampleRate(),
                    [weak, id](DecodedAudio result) {
                        if (const auto session = weak.lock()) session->decodes[id] = std::move(result);
                    });
                p[0] = id; break;
            }
            case TNP_AUDIO_POLL: {
                auto found = s.decodes.find(object);
                if (found == s.decodes.end()) throw std::runtime_error("TN_AUDIO_HANDLE: decodeAudioData");
                if (!found->second.error.empty()) {
                    const auto error = found->second.error; s.decodes.erase(found);
                    throw std::runtime_error("TN_AUDIO_DECODE: " + error);
                }
                if (!found->second.buffer) { p[0] = 0; break; }
                const auto id = s.next++;
                s.buffers.emplace(id, std::move(found->second.buffer)); s.decodes.erase(found);
                p[0] = 1; info(p + 1, id, *s.buffer(id)); break;
            }
            case TNP_AUDIO_BUFFER_INFO: info(p, object, *s.buffer(object)); break;
            case TNP_AUDIO_CHANNEL: {
                auto buffer = s.buffer(object);
                if (p[0] < 0 || p[0] >= buffer->numberOfChannels() || std::floor(p[0]) != p[0])
                    throw std::runtime_error("TN_AUDIO_ARGUMENT: AudioBuffer.getChannelData");
                p[0] = double(reinterpret_cast<uintptr_t>(buffer->getChannelData(int(p[0])))); p[1] = buffer->length(); break;
            }
            case TNP_AUDIO_PANNER: {
                auto* node = s.as<PannerNode>(object, "PannerNode");
                switch (int(p[0])) {
                    case 0: node->setRefDistance(float(p[1])); break;
                    case 1: node->setMaxDistance(float(p[1])); break;
                    case 2: node->setRolloffFactor(float(p[1])); break;
                    case 3:
                        if (p[1] < 0 || p[1] > 2) throw std::runtime_error("TN_AUDIO_ARGUMENT: PannerNode.distanceModel");
                        node->setDistanceModel(p[1] == 0 ? "inverse" : p[1] == 1 ? "linear" : "exponential"); break;
                    case 4: node->setPosition(float(p[1]), float(p[2]), float(p[3])); break;
                    default: throw std::runtime_error("TN_AUDIO_UNSUPPORTED: PannerNode.setOrientation");
                }
                break;
            }
            case TNP_AUDIO_LISTENER:
                if (p[0] == 0) s.context.setListenerPosition(float(p[1]), float(p[2]), float(p[3]));
                else if (p[0] == 1) s.context.setListenerOrientation(float(p[1]), float(p[2]), float(p[3]), float(p[4]), float(p[5]), float(p[6]));
                else throw std::runtime_error("TN_AUDIO_MEMBER: AudioListener");
                break;
            case TNP_AUDIO_FILTER_TYPE:
                if (p[0] != 0) throw std::runtime_error("TN_AUDIO_UNSUPPORTED: BiquadFilterNode.type");
                s.as<BiquadFilterNode>(object, "BiquadFilterNode.type")->setType("lowpass"); break;
            case TNP_AUDIO_CREATE_BUFFER: {
                if (p[0] < 1 || p[0] > 32 || std::floor(p[0]) != p[0] || p[1] < 1 || p[1] > 16777216 || std::floor(p[1]) != p[1] || p[2] < 8000 || p[2] > 192000)
                    throw std::runtime_error("TN_AUDIO_ARGUMENT: AudioContext.createBuffer");
                auto buffer = s.context.createBuffer(int(p[0]), size_t(p[1]), float(p[2]));
                const auto id = s.next++; s.buffers.emplace(id, buffer); info(p, id, *buffer); break;
            }
            default: throw std::runtime_error("TN_AUDIO_MEMBER: unknown WebAudio operation");
        }
        return 0;
    } catch (const std::exception& error) { failure = error.what(); }
    catch (...) { failure = "TN_AUDIO_NATIVE: WebAudio operation failed"; }
    return int64_t(reinterpret_cast<uintptr_t>(failure.c_str()));
}
