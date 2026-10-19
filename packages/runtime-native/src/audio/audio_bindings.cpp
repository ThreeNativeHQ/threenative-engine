/**
 * Web Audio API JavaScript Bindings
 *
 * Exposes AudioContext, AudioBufferSourceNode, GainNode to JavaScript.
 */

#include "mystral/audio/async_audio_decode.h"
#include "mystral/audio/audio_context.h"
#include "mystral/js/engine.h"
#include "runtime_scripts.h"
#include <iostream>
#include <string>
#include <string_view>
#include <unordered_map>

namespace mystral {
namespace audio {

// Global storage for audio objects
static std::unordered_map<void*, std::unique_ptr<AudioContext>> g_audioContexts;
static std::unordered_map<void*, std::shared_ptr<AudioBuffer>> g_audioBuffers;
static std::unordered_map<void*, std::unique_ptr<AudioBufferSourceNode>> g_sourceNodes;
static std::unordered_map<void*, js::JSValueHandle> g_sourceHandles;
static std::unordered_map<void*, std::unique_ptr<GainNode>> g_gainNodes;
static std::unordered_map<void*, std::unique_ptr<PannerNode>> g_pannerNodes;
static std::unordered_map<void*, std::unique_ptr<BiquadFilterNode>> g_biquadNodes;
static std::unordered_map<void*, std::unique_ptr<DynamicsCompressorNode>> g_compressorNodes;

static js::Engine* g_jsEngine = nullptr;

static bool evalAudioScript(js::Engine& engine, std::string_view name, const char* filename) {
    const auto script = runtime_scripts::find(name);
    if (!script.data) {
        std::cerr << "[Audio] Embedded runtime script not found: " << name << std::endl;
        return false;
    }
    const std::string source(script.data, script.size);
    if (!engine.eval(source.c_str(), filename)) {
        std::cerr << "[Audio] Failed to evaluate " << filename << ": " << engine.getException()
                  << std::endl;
        return false;
    }
    return true;
}

// A real Promise settled with a value that already exists as a live JS handle. `Promise.resolve`
// is read off the global rather than built with `evalWithResult` because the settled value is an
// object handle, not something that can be written into a source string.
static js::JSValueHandle settledPromise(js::Engine* engine, const char* method,
                                        js::JSValueHandle value) {
    const js::JSValueHandle promiseCtor = engine->getGlobalProperty("Promise");
    const bool haveCtor = engine->isObject(promiseCtor) || engine->isFunction(promiseCtor);
    const js::JSValueHandle settle =
        haveCtor ? engine->getProperty(promiseCtor, method) : engine->newUndefined();
    if (!engine->isFunction(settle)) {
        engine->throwException("The native Web Audio surface requires a global Promise.");
        return engine->newUndefined();
    }
    return engine->call(settle, promiseCtor, {value});
}

// Browsers reject `decodeAudioData` with an exception object, not a string, and hand the same
// value to the legacy `onError` callback.
static js::JSValueHandle newAudioError(js::Engine* engine, const char* message) {
    const js::JSValueHandle ctor = engine->getGlobalProperty("Error");
    if (!engine->isFunction(ctor)) return engine->newString(message);
    return engine->call(ctor, engine->newUndefined(), {engine->newString(message)});
}

static void installAudioNodeBindings(js::Engine* engine, js::JSValueHandle jsNode,
                                     AudioNode* nodePtr) {
    engine->setPrivateData(jsNode, nodePtr);
    engine->setProperty(jsNode, "connect",
        engine->newFunction("connect", [nodePtr](void*, const std::vector<js::JSValueHandle>& args) {
            if (args.empty()) return g_jsEngine->newUndefined();
            auto* destination = static_cast<AudioNode*>(g_jsEngine->getPrivateData(args[0]));
            nodePtr->connect(destination);
            return args[0];
        })
    );
    engine->setProperty(jsNode, "disconnect",
        engine->newFunction("disconnect", [nodePtr](void*, const std::vector<js::JSValueHandle>& args) {
            if (args.empty()) nodePtr->disconnect();
            else {
                auto* destination = static_cast<AudioNode*>(g_jsEngine->getPrivateData(args[0]));
                nodePtr->disconnect(destination);
            }
            return g_jsEngine->newUndefined();
        })
    );
}

static js::JSValueHandle createPassiveAudioParamJS(js::Engine* engine, float initialValue) {
    auto param = engine->newObject();
    engine->setProperty(param, "value", engine->newNumber(initialValue));
    for (const char* name : {"setTargetAtTime", "setValueAtTime", "linearRampToValueAtTime"}) {
        engine->setProperty(param, name,
            engine->newFunction(name, [](void*, const std::vector<js::JSValueHandle>&) {
                return g_jsEngine->newUndefined();
            })
        );
    }
    return param;
}

/**
 * One Web Audio AudioParam over a native one.
 *
 * It carries the native setters and the native default; `audio-param.js` turns that into the `value`
 * accessor a Web Audio param has, because the engine has no accessor support. Every write lands in
 * C++, which is the difference between a filter that filters and one that remembers a number.
 */
static js::JSValueHandle audioParamJS(js::Engine* engine, AudioParam* param) {
    auto obj = engine->newObject();
    engine->setProperty(obj, "_default", engine->newNumber(param->value()));
    engine->setProperty(obj, "_setValue",
        engine->newFunction("_setValue", [param](void*, const std::vector<js::JSValueHandle>& args) {
            if (!args.empty()) param->setValue(static_cast<float>(g_jsEngine->toNumber(args[0])));
            return g_jsEngine->newUndefined();
        })
    );
    engine->setProperty(obj, "_setValueAtTime",
        engine->newFunction("_setValueAtTime", [param](void*, const std::vector<js::JSValueHandle>& args) {
            if (args.size() >= 2) {
                param->setValueAtTime(static_cast<float>(g_jsEngine->toNumber(args[0])),
                                       g_jsEngine->toNumber(args[1]));
            }
            return g_jsEngine->newUndefined();
        })
    );
    engine->setProperty(obj, "_linearRampToValueAtTime",
        engine->newFunction("_linearRampToValueAtTime", [param](void*, const std::vector<js::JSValueHandle>& args) {
            if (args.size() >= 2) {
                param->linearRampToValueAtTime(static_cast<float>(g_jsEngine->toNumber(args[0])),
                                               g_jsEngine->toNumber(args[1]));
            }
            return g_jsEngine->newUndefined();
        })
    );
    engine->setProperty(obj, "_setTargetAtTime",
        engine->newFunction("_setTargetAtTime", [param](void*, const std::vector<js::JSValueHandle>& args) {
            if (args.size() >= 3) {
                param->setTargetAtTime(static_cast<float>(g_jsEngine->toNumber(args[0])),
                                       g_jsEngine->toNumber(args[1]), g_jsEngine->toNumber(args[2]));
            }
            return g_jsEngine->newUndefined();
        })
    );
    return obj;
}

/**
 * Hand the raw params, and optionally the nodes that need a property of their own, to
 * `audio-param.js`. The global is cleared so one node's bundle cannot leak into the next.
 */
static void wrapAudioParams(js::Engine& engine, const std::vector<js::JSValueHandle>& params,
                            js::JSValueHandle type = {}, js::JSValueHandle reduction = {}) {
    auto bundle = engine.newObject();
    auto array = engine.newArray(params.size());
    for (size_t i = 0; i < params.size(); i++) {
        engine.setPropertyIndex(array, static_cast<uint32_t>(i), params[i]);
    }
    engine.setProperty(bundle, "params", array);
    // An absent handle is a null pointer, and the engine dereferences whatever it is given — so
    // the optional entries are only written when the caller has one.
    if (type.ptr) engine.setProperty(bundle, "type", type);
    if (reduction.ptr) engine.setProperty(bundle, "reduction", reduction);
    engine.setGlobalProperty("__tnAudioParamBundle", bundle);
    evalAudioScript(engine, "audio-param", "audio-param.js");
    engine.setGlobalProperty("__tnAudioParamBundle", engine.newUndefined());
}

// Track the current AudioContext being operated on (set via closure capture)
// This is a workaround for not having 'this' binding in callbacks

/** Which queued decode a completion belongs to. Process-wide, like the decoder it indexes. */
static uint64_t nextAudioDecodeRequestId = 1;

/** Defined below the decode helpers; the settle path builds the JS object from decoded PCM. */
js::JSValueHandle createAudioBufferJS(js::Engine* engine, std::shared_ptr<AudioBuffer> buffer);

/**
 * Ask the embedded script for the promise that will settle when decode `requestId` lands.
 *
 * The resolvers live in JavaScript (`install-async-audio-decode.js`), because a callback the host
 * settles later must not be a native object captured across a thread boundary: the worker hands
 * back data, and this thread — the one that owns the engine — turns it into JS.
 */
static js::JSValueHandle pendingAudioDecodePromise(js::Engine* engine, uint64_t requestId,
                                                   js::JSValueHandle onSuccess,
                                                   js::JSValueHandle onError) {
    js::JSValueGuard pending(*engine, engine->getGlobalProperty("__tnAudioDecodePending"));
    if (!pending || !engine->isFunction(pending.get())) {
        engine->throwException("async audio decoding is not installed (__tnAudioDecodePending missing)");
        return engine->newUndefined();
    }
    js::JSValueGuard thisArg(*engine, engine->newUndefined());
    js::JSValueGuard id(*engine, engine->newNumber(static_cast<double>(requestId)));
    return engine->call(pending.get(), thisArg.get(), {id.get(), onSuccess, onError});
}

/** Settle one decode on the engine's thread: build the JS buffer, then let the script resolve it. */
static void settleAudioDecode(uint64_t requestId, DecodedAudio decoded) {
    auto* engine = g_jsEngine;
    if (engine == nullptr) return;
    js::JSValueGuard settle(*engine, engine->getGlobalProperty("__tnAudioDecodeSettle"));
    if (!settle || !engine->isFunction(settle.get())) {
        std::cerr << "[Audio] async audio decode drain is not installed" << std::endl;
        return;
    }
    js::JSValueGuard result(
        *engine, decoded.buffer ? createAudioBufferJS(engine, decoded.buffer) : engine->newUndefined());
    js::JSValueGuard error(*engine, engine->newString(decoded.error.c_str()));
    js::JSValueGuard thisArg(*engine, engine->newUndefined());
    js::JSValueGuard id(*engine, engine->newNumber(static_cast<double>(requestId)));
    js::JSValueGuard ignored(
        *engine, engine->call(settle.get(), thisArg.get(), {id.get(), result.get(), error.get()}));
    if (!decoded.error.empty()) std::cerr << "[Audio] " << decoded.error << std::endl;
}

/**
 * Deliver finished decodes on the frame thread. Called from `processAudioEvents()`, which the host
 * already runs once per `pollEvents()`.
 */
void drainAudioDecodes() { AsyncAudioDecoder::instance().drain(); }

/**
 * Create AudioBuffer JS object
 */
js::JSValueHandle createAudioBufferJS(js::Engine* engine, std::shared_ptr<AudioBuffer> buffer) {
    auto jsBuffer = engine->newObject();

    // Native ownership is keyed by native identity. JSValueHandle::ptr is the address of an
    // engine-owned handle carrier, which V8 recycles independently of the live JavaScript object.
    AudioBuffer* bufferPtr = buffer.get();
    g_audioBuffers[bufferPtr] = buffer;
    engine->setPrivateData(jsBuffer, bufferPtr);

    // Properties
    engine->setProperty(jsBuffer, "sampleRate", engine->newNumber(buffer->sampleRate()));
    engine->setProperty(jsBuffer, "numberOfChannels", engine->newNumber(buffer->numberOfChannels()));
    engine->setProperty(jsBuffer, "length", engine->newNumber(static_cast<double>(buffer->length())));
    engine->setProperty(jsBuffer, "duration", engine->newNumber(buffer->duration()));

    // getChannelData(channel) - returns Float32Array view into native buffer
    engine->setProperty(jsBuffer, "getChannelData",
        engine->newFunction("getChannelData", [bufferPtr](void* ctx, const std::vector<js::JSValueHandle>& args) -> js::JSValueHandle {
            if (args.empty()) return g_jsEngine->newUndefined();

            int channel = static_cast<int>(g_jsEngine->toNumber(args[0]));
            float* data = bufferPtr->getChannelData(channel);
            size_t length = bufferPtr->length();

            if (!data) return g_jsEngine->newUndefined();

            // Create Float32Array view into native buffer (no copy - JS writes directly to native memory)
            return g_jsEngine->createFloat32ArrayView(data, length);
        })
    );

    return jsBuffer;
}

/**
 * Create AudioBufferSourceNode JS object
 */
js::JSValueHandle createSourceNodeJS(js::Engine* engine, AudioBufferSourceNode* nodePtr, js::JSValueHandle contextJS) {
    auto jsNode = engine->newObject();
    installAudioNodeBindings(engine, jsNode, nodePtr);

    // Store context reference
    engine->setProperty(jsNode, "context", contextJS);

    // buffer property
    engine->setProperty(jsNode, "buffer", engine->newNull());
    engine->setProperty(jsNode, "_setBuffer",
        engine->newFunction("_setBuffer", [nodePtr](void* ctx, const std::vector<js::JSValueHandle>& args) -> js::JSValueHandle {
            if (args.empty()) return g_jsEngine->newUndefined();

            // Get the native AudioBuffer pointer from the JS object's private data
            void* privateData = g_jsEngine->getPrivateData(args[0]);
            if (!privateData) {
                std::cerr << "[Audio] Warning: buffer has no private data" << std::endl;
                return g_jsEngine->newUndefined();
            }

            // Find the shared_ptr by matching the raw pointer
            AudioBuffer* rawBuffer = static_cast<AudioBuffer*>(privateData);
            for (auto& pair : g_audioBuffers) {
                if (pair.second.get() == rawBuffer) {
                    nodePtr->setBuffer(pair.second);
                    std::cout << "[Audio] Buffer set on source node (" << rawBuffer->length() << " frames)" << std::endl;
                    return g_jsEngine->newUndefined();
                }
            }

            std::cerr << "[Audio] Warning: buffer not found in registry" << std::endl;
            return g_jsEngine->newUndefined();
        })
    );

    // loop property
    engine->setProperty(jsNode, "loop", engine->newBoolean(false));
    engine->setProperty(jsNode, "_setLoop",
        engine->newFunction("_setLoop", [nodePtr](void* ctx, const std::vector<js::JSValueHandle>& args) -> js::JSValueHandle {
            if (args.empty()) return g_jsEngine->newUndefined();
            nodePtr->setLoop(g_jsEngine->toBoolean(args[0]));
            return g_jsEngine->newUndefined();
        })
    );

    // loopStart, loopEnd
    engine->setProperty(jsNode, "loopStart", engine->newNumber(0));
    engine->setProperty(jsNode, "loopEnd", engine->newNumber(0));

    // start(when, offset, duration)
    engine->setProperty(jsNode, "start",
        engine->newFunction("start", [nodePtr](void* ctx, const std::vector<js::JSValueHandle>& args) -> js::JSValueHandle {
            double when = args.size() > 0 ? g_jsEngine->toNumber(args[0]) : 0;
            double offset = args.size() > 1 ? g_jsEngine->toNumber(args[1]) : 0;
            double duration = args.size() > 2 ? g_jsEngine->toNumber(args[2]) : -1;

            std::cout << "[Audio] source.start() called - when=" << when << " offset=" << offset << std::endl;
            nodePtr->start(when, offset, duration);
            std::cout << "[Audio] source.start() - isPlaying=" << nodePtr->isPlaying() << std::endl;
            return g_jsEngine->newUndefined();
        })
    );

    // stop(when)
    engine->setProperty(jsNode, "stop",
        engine->newFunction("stop", [nodePtr](void* ctx, const std::vector<js::JSValueHandle>& args) -> js::JSValueHandle {
            double when = args.size() > 0 ? g_jsEngine->toNumber(args[0]) : 0;
            nodePtr->stop(when);
            return g_jsEngine->newUndefined();
        })
    );

    // onended callback
    engine->setProperty(jsNode, "onended", engine->newNull());
    engine->setProperty(jsNode, "detune", createPassiveAudioParamJS(engine, 0.0f));
    engine->setProperty(jsNode, "playbackRate", createPassiveAudioParamJS(engine, 1.0f));

    engine->setGlobalProperty("__tnAudioSourceTemp", jsNode);
    evalAudioScript(*engine, "audio-source-properties", "audio-source-properties.js");

    return jsNode;
}

/**
 * Create GainNode JS object
 */
js::JSValueHandle createGainNodeJS(js::Engine* engine, GainNode* nodePtr, js::JSValueHandle contextJS) {
    auto jsNode = engine->newObject();
    installAudioNodeBindings(engine, jsNode, nodePtr);

    engine->setProperty(jsNode, "context", contextJS);

    // gain AudioParam
    auto gainParam = engine->newObject();
    engine->setProperty(gainParam, "_setValue",
        engine->newFunction("_setValue", [nodePtr](void* ctx, const std::vector<js::JSValueHandle>& args) -> js::JSValueHandle {
            if (args.size() > 0) {
                nodePtr->gain().setValue(static_cast<float>(g_jsEngine->toNumber(args[0])));
            }
            return g_jsEngine->newUndefined();
        })
    );
    engine->setProperty(gainParam, "_setValueAtTime",
        engine->newFunction("_setValueAtTime", [nodePtr](void*, const std::vector<js::JSValueHandle>& args) {
            if (args.size() >= 2) {
                nodePtr->gain().setValueAtTime(
                    static_cast<float>(g_jsEngine->toNumber(args[0])),
                    g_jsEngine->toNumber(args[1])
                );
            }
            return g_jsEngine->newUndefined();
        })
    );
    engine->setProperty(gainParam, "_linearRampToValueAtTime",
        engine->newFunction("_linearRampToValueAtTime", [nodePtr](void*, const std::vector<js::JSValueHandle>& args) {
            if (args.size() >= 2) {
                nodePtr->gain().linearRampToValueAtTime(
                    static_cast<float>(g_jsEngine->toNumber(args[0])),
                    g_jsEngine->toNumber(args[1])
                );
            }
            return g_jsEngine->newUndefined();
        })
    );
    engine->setProperty(gainParam, "_setTargetAtTime",
        engine->newFunction("_setTargetAtTime", [nodePtr](void*, const std::vector<js::JSValueHandle>& args) {
            if (args.size() >= 3) {
                nodePtr->gain().setTargetAtTime(
                    static_cast<float>(g_jsEngine->toNumber(args[0])),
                    g_jsEngine->toNumber(args[1]),
                    g_jsEngine->toNumber(args[2])
                );
            }
            return g_jsEngine->newUndefined();
        })
    );
    engine->setGlobalProperty("__tnAudioGainParamTemp", gainParam);
    evalAudioScript(*engine, "audio-gain-param", "audio-gain-param.js");
    engine->setProperty(jsNode, "gain", gainParam);

    return jsNode;
}

/**
 * Create the bounded PannerNode surface consumed by Three.js PositionalAudio.
 */
js::JSValueHandle createPannerNodeJS(js::Engine* engine, PannerNode* nodePtr,
                                     js::JSValueHandle contextJS) {
    auto jsNode = engine->newObject();
    installAudioNodeBindings(engine, jsNode, nodePtr);
    engine->setProperty(jsNode, "context", contextJS);
    engine->setProperty(jsNode, "setPosition",
        engine->newFunction("setPosition", [nodePtr](void*, const std::vector<js::JSValueHandle>& args) {
            if (args.size() >= 3) {
                nodePtr->setPosition(
                    static_cast<float>(g_jsEngine->toNumber(args[0])),
                    static_cast<float>(g_jsEngine->toNumber(args[1])),
                    static_cast<float>(g_jsEngine->toNumber(args[2]))
                );
            }
            return g_jsEngine->newUndefined();
        })
    );
    engine->setProperty(jsNode, "setOrientation",
        engine->newFunction("setOrientation", [](void*, const std::vector<js::JSValueHandle>&) {
            return g_jsEngine->newUndefined();
        })
    );
    engine->setProperty(jsNode, "_setRefDistance",
        engine->newFunction("_setRefDistance", [nodePtr](void*, const std::vector<js::JSValueHandle>& args) {
            if (!args.empty()) nodePtr->setRefDistance(static_cast<float>(g_jsEngine->toNumber(args[0])));
            return g_jsEngine->newUndefined();
        })
    );
    engine->setProperty(jsNode, "_setMaxDistance",
        engine->newFunction("_setMaxDistance", [nodePtr](void*, const std::vector<js::JSValueHandle>& args) {
            if (!args.empty()) nodePtr->setMaxDistance(static_cast<float>(g_jsEngine->toNumber(args[0])));
            return g_jsEngine->newUndefined();
        })
    );
    engine->setProperty(jsNode, "_setRolloffFactor",
        engine->newFunction("_setRolloffFactor", [nodePtr](void*, const std::vector<js::JSValueHandle>& args) {
            if (!args.empty()) nodePtr->setRolloffFactor(static_cast<float>(g_jsEngine->toNumber(args[0])));
            return g_jsEngine->newUndefined();
        })
    );
    engine->setProperty(jsNode, "_setDistanceModel",
        engine->newFunction("_setDistanceModel", [nodePtr](void*, const std::vector<js::JSValueHandle>& args) {
            if (!args.empty()) nodePtr->setDistanceModel(g_jsEngine->toString(args[0]));
            return g_jsEngine->newUndefined();
        })
    );
    engine->setGlobalProperty("__tnAudioPannerTemp", jsNode);
    evalAudioScript(*engine, "audio-panner-properties", "audio-panner-properties.js");
    return jsNode;
}

/**
 * Create the bounded BiquadFilterNode surface, which is what `AudioBus`'s `lowpassHz` builds.
 *
 * The low-pass is the only implemented type, and `audio-param.js` makes the setter refuse the other
 * five rather than accept a name and pass the signal through unfiltered.
 */
js::JSValueHandle createBiquadFilterJS(js::Engine* engine, BiquadFilterNode* nodePtr,
                                       js::JSValueHandle contextJS) {
    auto jsNode = engine->newObject();
    installAudioNodeBindings(engine, jsNode, nodePtr);
    engine->setProperty(jsNode, "context", contextJS);
    engine->setProperty(jsNode, "_setType",
        engine->newFunction("_setType", [nodePtr](void*, const std::vector<js::JSValueHandle>& args) {
            if (args.empty()) return g_jsEngine->newBoolean(false);
            return g_jsEngine->newBoolean(nodePtr->setType(g_jsEngine->toString(args[0])));
        })
    );
    auto frequency = audioParamJS(engine, &nodePtr->frequency());
    auto q = audioParamJS(engine, &nodePtr->q());
    wrapAudioParams(*engine, {frequency, q}, jsNode);
    engine->setProperty(jsNode, "frequency", frequency);
    engine->setProperty(jsNode, "Q", q);
    return jsNode;
}

/**
 * Create the DynamicsCompressorNode surface, which is what `AudioBus`'s `compressor` builds.
 *
 * `connect(destination)` is what puts it post-mix; see `AudioNode::postMix`. `reduction` is the
 * readout that answers "is the compressor doing anything".
 */
js::JSValueHandle createDynamicsCompressorJS(js::Engine* engine, DynamicsCompressorNode* nodePtr,
                                             js::JSValueHandle contextJS) {
    auto jsNode = engine->newObject();
    installAudioNodeBindings(engine, jsNode, nodePtr);
    engine->setProperty(jsNode, "context", contextJS);
    engine->setProperty(jsNode, "_getReduction",
        engine->newFunction("_getReduction", [nodePtr](void*, const std::vector<js::JSValueHandle>&) {
            return g_jsEngine->newNumber(nodePtr->reduction());
        })
    );
    auto threshold = audioParamJS(engine, &nodePtr->threshold());
    auto knee = audioParamJS(engine, &nodePtr->knee());
    auto ratio = audioParamJS(engine, &nodePtr->ratio());
    auto attack = audioParamJS(engine, &nodePtr->attack());
    auto release = audioParamJS(engine, &nodePtr->release());
    wrapAudioParams(*engine, {threshold, knee, ratio, attack, release}, {}, jsNode);
    engine->setProperty(jsNode, "threshold", threshold);
    engine->setProperty(jsNode, "knee", knee);
    engine->setProperty(jsNode, "ratio", ratio);
    engine->setProperty(jsNode, "attack", attack);
    engine->setProperty(jsNode, "release", release);
    return jsNode;
}

/**
 * Create AudioContext JS object
 */
js::JSValueHandle createAudioContextJS(js::Engine* engine, AudioContext* ctxPtr) {
    g_jsEngine = engine;

    auto jsCtx = engine->newObject();

    // Properties
    engine->setProperty(jsCtx, "sampleRate", engine->newNumber(ctxPtr->sampleRate()));

    // currentTime getter - capture ctxPtr
    engine->setProperty(jsCtx, "_getCurrentTime",
        engine->newFunction("_getCurrentTime", [ctxPtr](void* c, const std::vector<js::JSValueHandle>& args) -> js::JSValueHandle {
            return g_jsEngine->newNumber(ctxPtr->currentTime());
        })
    );

    // state property
    engine->setProperty(jsCtx, "state", engine->newString("suspended"));

    // destination
    auto destNode = engine->newObject();
    installAudioNodeBindings(engine, destNode, ctxPtr->destination());
    engine->setProperty(destNode, "maxChannelCount", engine->newNumber(2));
    engine->setProperty(jsCtx, "destination", destNode);

    // Three.js falls back to these legacy listener methods when AudioParam
    // coordinates are unavailable.
    auto listener = engine->newObject();
    engine->setProperty(listener, "setPosition",
        engine->newFunction("setPosition", [ctxPtr](void*, const std::vector<js::JSValueHandle>& args) {
            if (args.size() >= 3) {
                ctxPtr->setListenerPosition(
                    static_cast<float>(g_jsEngine->toNumber(args[0])),
                    static_cast<float>(g_jsEngine->toNumber(args[1])),
                    static_cast<float>(g_jsEngine->toNumber(args[2]))
                );
            }
            return g_jsEngine->newUndefined();
        })
    );
    engine->setProperty(listener, "setOrientation",
        engine->newFunction("setOrientation", [ctxPtr](void*, const std::vector<js::JSValueHandle>& args) {
            if (args.size() >= 6) {
                ctxPtr->setListenerOrientation(
                    static_cast<float>(g_jsEngine->toNumber(args[0])),
                    static_cast<float>(g_jsEngine->toNumber(args[1])),
                    static_cast<float>(g_jsEngine->toNumber(args[2])),
                    static_cast<float>(g_jsEngine->toNumber(args[3])),
                    static_cast<float>(g_jsEngine->toNumber(args[4])),
                    static_cast<float>(g_jsEngine->toNumber(args[5]))
                );
            }
            return g_jsEngine->newUndefined();
        })
    );
    engine->setProperty(jsCtx, "listener", listener);

    // createBuffer(numberOfChannels, length, sampleRate)
    engine->setProperty(jsCtx, "createBuffer",
        engine->newFunction("createBuffer", [ctxPtr](void* c, const std::vector<js::JSValueHandle>& args) -> js::JSValueHandle {
            if (args.size() < 3) return g_jsEngine->newUndefined();

            int numChannels = static_cast<int>(g_jsEngine->toNumber(args[0]));
            size_t length = static_cast<size_t>(g_jsEngine->toNumber(args[1]));
            float sampleRate = static_cast<float>(g_jsEngine->toNumber(args[2]));

            auto buffer = ctxPtr->createBuffer(numChannels, length, sampleRate);
            return createAudioBufferJS(g_jsEngine, buffer);
        })
    );

    // createBufferSource() - capture ctxPtr only
    engine->setProperty(jsCtx, "createBufferSource",
        engine->newFunction("createBufferSource", [ctxPtr](void* c, const std::vector<js::JSValueHandle>& args) -> js::JSValueHandle {
            auto node = ctxPtr->createBufferSource();
            auto* nodePtr = node.get();

            // Pass undefined for context (not needed for our implementation)
            auto jsNode = createSourceNodeJS(g_jsEngine, nodePtr, g_jsEngine->newUndefined());
            g_sourceNodes[nodePtr] = std::move(node);
            g_jsEngine->freezeHandle(jsNode);
            g_sourceHandles[nodePtr] = jsNode;

            return jsNode;
        })
    );

    // createGain()
    engine->setProperty(jsCtx, "createGain",
        engine->newFunction("createGain", [ctxPtr](void* c, const std::vector<js::JSValueHandle>& args) -> js::JSValueHandle {
            auto node = ctxPtr->createGain();
            auto* nodePtr = node.get();

            // Pass undefined for context (not needed for our implementation)
            auto jsNode = createGainNodeJS(g_jsEngine, nodePtr, g_jsEngine->newUndefined());
            g_gainNodes[nodePtr] = std::move(node);

            return jsNode;
        })
    );

    // createPanner()
    engine->setProperty(jsCtx, "createPanner",
        engine->newFunction("createPanner", [ctxPtr](void*, const std::vector<js::JSValueHandle>&) {
            auto node = ctxPtr->createPanner();
            auto* nodePtr = node.get();
            auto jsNode = createPannerNodeJS(g_jsEngine, nodePtr, g_jsEngine->newUndefined());
            g_pannerNodes[nodePtr] = std::move(node);
            return jsNode;
        })
    );

    // createBiquadFilter() - the low-pass `AudioBus` builds for `lowpassHz`
    engine->setProperty(jsCtx, "createBiquadFilter",
        engine->newFunction("createBiquadFilter", [ctxPtr](void*, const std::vector<js::JSValueHandle>&) {
            auto node = ctxPtr->createBiquadFilter();
            auto* nodePtr = node.get();
            auto jsNode = createBiquadFilterJS(g_jsEngine, nodePtr, g_jsEngine->newUndefined());
            g_biquadNodes[nodePtr] = std::move(node);
            return jsNode;
        })
    );

    // createDynamicsCompressor() - the bus master compressor
    engine->setProperty(jsCtx, "createDynamicsCompressor",
        engine->newFunction("createDynamicsCompressor", [ctxPtr](void*, const std::vector<js::JSValueHandle>&) {
            auto node = ctxPtr->createDynamicsCompressor();
            auto* nodePtr = node.get();
            auto jsNode = createDynamicsCompressorJS(g_jsEngine, nodePtr, g_jsEngine->newUndefined());
            g_compressorNodes[nodePtr] = std::move(node);
            return jsNode;
        })
    );

    // decodeAudioData(arrayBuffer, onSuccess?, onError?) -> Promise<AudioBuffer>
    //
    // The return value has to be a Promise, and twice it was not. First it returned the decoded
    // `AudioBuffer` directly on success and `undefined` on every failure path, with a comment
    // saying a Promise belonged there. Three.js `AudioLoader` ends its load with
    //
    //     context.decodeAudioData(buffer, onSuccess).catch(handleError)
    //
    // so *every* call reached `.catch` on a non-Promise. On the failure path that is
    // `undefined.catch` — a TypeError thrown inside the boot promise, which rejects it and stops
    // the game before its first frame. That is a black screen on device with nothing in logcat
    // except the rejection, and it takes down any game that loads a sound Three's way.
    //
    // The repair for that was a hand-rolled thenable, which fixed exactly Three's one shape. Its
    // `then` ran the handler and returned `undefined`, so `.then(use).catch(report)` still threw on
    // `undefined.catch`, `.then(a).then(b)` broke a chain of two, and `result instanceof Promise`
    // was false. That is why decoding used to be synchronous here: a *settled* promise was the only
    // shape the hand-rolled object could fake convincingly.
    //
    // It is a real `Promise` now, so the decode no longer has to block the frame to settle it.
    // `AsyncAudioDecoder` decodes on a worker and `drainAudioDecodes()` settles on the game thread;
    // a game's whole clip set used to decode inside one frame (146 clips, ~542 ms, measured), and
    // every frame in that window froze. Argument errors still reject immediately — there is no work
    // to defer — and the legacy callbacks fire at settlement, which is what a browser does.
    engine->setProperty(jsCtx, "decodeAudioData",
        engine->newFunction("decodeAudioData", [ctxPtr](void* c, const std::vector<js::JSValueHandle>& args) -> js::JSValueHandle {
            auto* engine = g_jsEngine;
            const auto callbackAt = [&args, engine](size_t index) -> js::JSValueHandle {
                if (args.size() <= index) return engine->newUndefined();
                return engine->isFunction(args[index]) ? args[index] : engine->newUndefined();
            };
            const js::JSValueHandle onSuccess = callbackAt(1);
            const js::JSValueHandle onError = callbackAt(2);

            // An argument that cannot be decoded is rejected now, not queued: there is nothing to
            // defer, and a caller that passed the wrong thing should hear about it at the call.
            const char* failure = nullptr;
            size_t length = 0;
            void* data = nullptr;
            if (args.empty()) {
                failure = "decodeAudioData requires an ArrayBuffer.";
            } else {
                data = engine->getArrayBufferData(args[0], &length);
                if (!data || length == 0) {
                    failure = "decodeAudioData received an empty or non-ArrayBuffer argument.";
                }
            }
            if (failure != nullptr) {
                std::cerr << "[Audio] " << failure << std::endl;
                const js::JSValueHandle rejected = newAudioError(engine, failure);
                if (engine->isFunction(onError)) {
                    engine->call(onError, engine->newUndefined(), {rejected});
                }
                return settledPromise(engine, "reject", rejected);
            }

            // Copy the encoded bytes: the decode runs on a worker and V8's backing store belongs to
            // the caller, who may detach or reuse it the moment this returns.
            const auto* bytes = static_cast<const uint8_t*>(data);
            std::vector<uint8_t> copy(bytes, bytes + length);
            const uint64_t requestId = nextAudioDecodeRequestId++;
            // No guard on the promise: this handle is the return value, and a guard would free it
            // as the function exits — the same corruption `mapAsync`'s promise would have had.
            const js::JSValueHandle promise =
                pendingAudioDecodePromise(engine, requestId, onSuccess, onError);
            if (!promise.ptr || engine->hasException()) return promise;
            const float sampleRate = ctxPtr->sampleRate();
            audio::AsyncAudioDecoder::instance().decode(
                std::move(copy), sampleRate,
                [requestId](audio::DecodedAudio decoded) {
                    settleAudioDecode(requestId, std::move(decoded));
                });
            return promise;
        })
    );

    // resume() -> Promise - capture ctxPtr and jsCtxKey
    engine->setProperty(jsCtx, "resume",
        engine->newFunction("resume", [ctxPtr](void* c, const std::vector<js::JSValueHandle>& args) -> js::JSValueHandle {
            ctxPtr->resume();
            // Skip state update for now - testing crash
            return g_jsEngine->newUndefined();
        })
    );

    // suspend() -> Promise
    engine->setProperty(jsCtx, "suspend",
        engine->newFunction("suspend", [ctxPtr](void* c, const std::vector<js::JSValueHandle>& args) -> js::JSValueHandle {
            ctxPtr->suspend();
            // State update skipped - JS code should track state if needed
            return g_jsEngine->newUndefined();
        })
    );

    // close() -> Promise
    engine->setProperty(jsCtx, "close",
        engine->newFunction("close", [ctxPtr](void* c, const std::vector<js::JSValueHandle>& args) -> js::JSValueHandle {
            ctxPtr->close();
            // State update skipped - JS code should track state if needed
            return g_jsEngine->newUndefined();
        })
    );

    return jsCtx;
}

/**
 * Initialize Web Audio API bindings
 */
void initializeAudioBindings(js::Engine* engine) {
    g_jsEngine = engine;

    // Create AudioContext constructor
    auto audioContextCtor = engine->newFunction("AudioContext",
        [](void* ctx, const std::vector<js::JSValueHandle>& args) -> js::JSValueHandle {
            auto context = std::make_unique<AudioContext>();
            auto* ctxPtr = context.get();

            auto jsCtx = createAudioContextJS(g_jsEngine, ctxPtr);
            g_audioContexts[ctxPtr] = std::move(context);

            return jsCtx;
        }
    );

    // QuickJS native callbacks used directly with `new` keep their empty
    // constructor receiver. Copy the native context surface onto a JavaScript
    // receiver so Three.js gets the browser constructor contract on every engine.
    engine->setGlobalProperty("__tnCreateAudioContext", audioContextCtor);
    if (!evalAudioScript(*engine, "audio-context-constructor", "audio-context-constructor.js")) {
        std::cerr << "[Audio] Failed to install AudioContext constructor" << std::endl;
    }
    if (!evalAudioScript(*engine, "install-async-audio-decode", "install-async-audio-decode.js")) {
        std::cerr << "[Audio] Failed to install the async audio decode drain" << std::endl;
    }

    std::cout << "[Audio] Web Audio API bindings initialized" << std::endl;
}

void processAudioEvents() {
    if (!g_jsEngine) return;

    // A finished decode is data waiting for a V8 object, and this is the only thread allowed to
    // build one. Bounded per call, so a frame that took a burst of queue entries still returns.
    drainAudioDecodes();

    std::vector<void*> completed;
    for (const auto& [key, node] : g_sourceNodes) {
        if (!node->takeEndedEvent()) continue;

        auto handle = g_sourceHandles.find(key);
        if (handle == g_sourceHandles.end()) continue;
        auto callback = g_jsEngine->getProperty(handle->second, "onended");
        if (g_jsEngine->isFunction(callback)) {
            g_jsEngine->call(callback, handle->second, {});
            if (g_jsEngine->hasException()) {
                std::cerr << "[Audio] onended callback threw: "
                          << g_jsEngine->getException() << std::endl;
            }
        }
        g_jsEngine->freeHandle(handle->second);
        completed.push_back(key);
    }
    for (void* key : completed) g_sourceHandles.erase(key);
}

void cleanupAudioBindings() {
    // Note: On macOS, SDL3's audio stream destruction can hang during shutdown
    // due to CoreAudio callbacks. For now, we leak the audio resources and let
    // the OS clean them up on process exit. This is safe since we're shutting down.
    //
    // TODO: Investigate SDL3/CoreAudio interaction on macOS
    // See: https://github.com/libsdl-org/SDL/issues

    // Stop callbacks from retaining source pointers before source storage is released.
    for (auto& pair : g_audioContexts) pair.second->detachSources();
    for (auto& pair : g_sourceHandles) g_jsEngine->freeHandle(pair.second);
    g_sourceHandles.clear();

    // Release audio contexts without destroying them (which calls SDL_DestroyAudioStream)
    for (auto& pair : g_audioContexts) {
        pair.second.release();  // Leak intentionally - OS will clean up on exit
    }
    g_audioContexts.clear();

    // Source nodes and buffers don't have SDL resources, safe to destroy
    g_sourceNodes.clear();
    g_gainNodes.clear();
    g_pannerNodes.clear();
    g_biquadNodes.clear();
    g_compressorNodes.clear();
    g_audioBuffers.clear();
    g_jsEngine = nullptr;
}

}  // namespace audio
}  // namespace mystral
