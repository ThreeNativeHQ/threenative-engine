#include "mystral/runtime.h"
#include "mystral/webgpu/bindings.h"

#include "../src/webgpu/bindings_state.h"

#include <iostream>
#include <fstream>
#include <chrono>
#include <cstdlib>
#include <thread>
#include <sstream>
#include <string>

namespace {

int failures = 0;
int frameReplayBackendEntries = 0;

void observeFrameReplayBackendEntry(const char*) {
    frameReplayBackendEntries += 1;
}

void expect(bool condition, const std::string& what) {
    if (!condition) {
        std::cerr << "FAIL: " << what << std::endl;
        failures += 1;
    }
}

void setFramePlanOverride(bool enabled) {
#if defined(_WIN32)
    const int result = _putenv_s("TN_FRAME_PLANS", enabled ? "1" : "");
#else
    const int result =
        enabled ? setenv("TN_FRAME_PLANS", "1", 1) : unsetenv("TN_FRAME_PLANS");
#endif
    expect(result == 0, std::string("frame-plan diagnostic override ") +
                            (enabled ? "enabled" : "cleared"));
}

void awaitFlag(mystral::Runtime* runtime, mystral::js::Engine* engine, const char* flag) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (std::chrono::steady_clock::now() < deadline) {
        runtime->pollEvents();
        engine->processMicrotasks();
        mystral::js::JSValueGuard value(*engine, engine->getGlobalProperty(flag));
        if (engine->toBoolean(value.get())) return;
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    expect(false, std::string("timed out awaiting ") + flag);
}

void expectMalformed(mystral::webgpu::BindingsState* state, const std::string& expression,
                     const std::string& expected, const std::string& what,
                     int expectedBackendEntries = 0) {
    auto* engine = state->engine;
    const int backendEntriesBefore = frameReplayBackendEntries;
    state->profiling.frameOpStreamDrain =
        engine->evalScriptWithResult(expression.c_str(), "tn-malformed-frame.js");
    mystral::webgpu::endDawnFrame(state);
    const std::string exception = engine->hasException() ? engine->getException() : "";
    expect(exception.find(expected) != std::string::npos, what + ": " + exception);
    expect(frameReplayBackendEntries - backendEntriesBefore == expectedBackendEntries,
           what + ": malformed replay entered wgpu-native");
}

void runContract(bool disableStreamControl) {
    mystral::RuntimeConfig config;
    config.width = 1;
    config.height = 1;
    config.noSdl = true;
    const auto runtime = mystral::Runtime::create(config);
    if (!runtime || !runtime->getWebGPUBindingsState()) {
        expect(false, "headless runtime with WebGPU bindings created");
        return;
    }
    auto* state = static_cast<mystral::webgpu::BindingsState*>(runtime->getWebGPUBindingsState());
    auto* engine = state->engine;
    expect(!state->profiling.captureFrameOpStreamTrace, "production replay does not allocate an operation-name trace");
    state->profiling.captureFrameOpStreamTrace = true;

    expect(engine->evalScript(
        R"JS((async () => {
          const adapter = await navigator.gpu.requestAdapter();
          const device = await adapter.requestDevice();
          globalThis.__tnDevice = device; // reused by the same-frame readback contract below.
          const src = device.createBuffer({size: 16, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST});
          const dst = device.createBuffer({size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
          globalThis.__tnUploadDst = dst;
          const renderTarget = device.createTexture({
            size: [1, 1], format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT,
          });
          const renderView = renderTarget.createView();
          globalThis.__tnRenderView = renderView;
          requestAnimationFrame(() => {
            const upload = new Uint32Array([1, 2, 3, 4]);
            device.queue.writeBuffer(src, 0, upload);
            upload.fill(99); // eager-copy negative control: replay must retain 1,2,3,4.
            const encoder = device.createCommandEncoder();
            encoder.clearBuffer(dst, 0, 16);
            encoder.copyBufferToBuffer(src, 0, dst, 0, 16);
            const render = encoder.beginRenderPass({colorAttachments: [{
              view: renderView, loadOp: "clear", storeOp: "store",
              clearValue: [0.25, 0.5, 0.75, 1],
            }]});
            render.end();
            const pass = encoder.beginComputePass();
            pass.end();
            device.queue.submit([encoder.finish()]);
            src.destroy(); // must stay ordered after submit; direct destruction invalidates replay.
            globalThis.__tnFrameCallbackRan = true;
          });
        })())JS",
        "tn-frame-op-stream-contract.js"),
        "frame command script evaluated");

    for (int pump = 0; pump < 200; ++pump) {
        if (!engine->isUndefined(engine->getGlobalProperty("__tnFrameCallbackRan"))) break;
        engine->processMicrotasks();
    }
    expect(state->profiling.frameOpStreamDrain.ptr, "production frame op stream is installed");
    const auto installedDrain = state->profiling.frameOpStreamDrain;
    if (disableStreamControl)
        state->profiling.frameOpStreamDrain = {};
    runtime->pollEvents();
    expect(engine->toBoolean(engine->getGlobalProperty("__tnFrameCallbackRan")),
           "commands ran inside a real requestAnimationFrame callback");
    expect(state->profiling.frameOpStreamReplayCrossings == 1,
           "writeBuffer, encoder, finish, and submit replay in one crossing");
    expect(state->profiling.frameOpStreamDirectCommandCalls == 0,
           "no recorded command reached a direct command callback");
    if (disableStreamControl) {
        // Restore ownership so teardown frees the protected handle and the remaining fail-closed
        // parser controls can run. The crossing assertion above must already be red.
        state->profiling.frameOpStreamDrain = installedDrain;
    }
    const std::vector<std::string> expectedOrder = {
        "writeBuffer", "createCommandEncoder", "clearBuffer", "copyBufferToBuffer",
        "beginRenderPass", "render.end",
        "beginComputePass", "compute.end", "finish", "submit", "buffer.destroy"};
    if (state->profiling.frameOpStreamLastOrder != expectedOrder) {
        std::cerr << "observed order:";
        for (const auto& op : state->profiling.frameOpStreamLastOrder)
            std::cerr << " " << op;
        std::cerr << std::endl;
    }
    expect(state->profiling.frameOpStreamLastOrder == expectedOrder,
           "native replay preserves the exact operation order and census");
    expect(state->profiling.frameOpStreamLastOpCount == expectedOrder.size(),
           "native replay reports every operation exactly once");
#if defined(MYSTRAL_WEBGPU_WGPU) && TN_WEBGPU_UPLOAD_STAGING
    expect(!state->registries.uploadStaging.retired.empty() || !state->registries.uploadStaging.ready.empty(),
           "packed writeBuffer uses the configured upload-staging backend");
#endif
    expect(engine->evalScript(
        R"JS((async () => {
          try {
            await __tnUploadDst.mapAsync(GPUMapMode.READ, 0, 16);
            globalThis.__tnUploadReadback = Array.from(new Uint32Array(__tnUploadDst.getMappedRange(0, 16)));
            __tnUploadDst.unmap();
          } catch (error) {
            globalThis.__tnUploadReadbackError = String(error);
          } finally {
            globalThis.__tnUploadReadbackDone = true;
          }
        })())JS",
        "tn-upload-readback.js"),
        "upload readback requested");
    // Metal can deliver a spontaneous Dawn map callback on the next run-loop turn. Yield between
    // polls so this contract waits for the same backend completion it is asserting rather than
    // exhausting a tight loop before the driver has had a chance to signal it.
    for (int pump = 0; pump < 5000; ++pump) {
        engine->processMicrotasks();
        if (!engine->isUndefined(engine->getGlobalProperty("__tnUploadReadbackDone"))) break;
        runtime->pollEvents();
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    expect(engine->toBoolean(engine->getGlobalProperty("__tnUploadReadbackDone")),
           "upload readback promise settled");
    expect(engine->isUndefined(engine->getGlobalProperty("__tnUploadReadbackError")),
           "upload readback completed without an error");
    if (!engine->isUndefined(engine->getGlobalProperty("__tnUploadReadback"))) {
        expect(engine->toBoolean(engine->evalScriptWithResult(
            "JSON.stringify(__tnUploadReadback) === '[1,2,3,4]'", "tn-upload-readback-check.js")),
            "writeBuffer payload was copied eagerly before source mutation");
    }

    // Same-frame readback. `queue.submit` is recorded, not executed, so the copy a game hands the
    // queue only reaches the GPU when the frame drains. `buffer.mapAsync` is the one call that
    // lets JavaScript observe the queue before that: WebGPU says a map completes after the work
    // already submitted, so the map has to force the recorded stream out first. three.js's
    // `readRenderTargetPixelsAsync` is exactly this shape — copy, submit, map, read, destroy, all
    // inside one frame — and read zeros while the deferred submit later tripped
    // "used in submit while mapped".
    const uint64_t crossingsBeforeSameFrame = state->profiling.frameOpStreamReplayCrossings;
    expect(engine->evalScript(
        R"JS((() => {
          const device = globalThis.__tnDevice;
          const src = device.createBuffer({size: 16, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST});
          const dst = device.createBuffer({size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
          requestAnimationFrame(async () => {
            device.queue.writeBuffer(src, 0, new Uint32Array([5, 6, 7, 8]));
            const encoder = device.createCommandEncoder();
            encoder.copyBufferToBuffer(src, 0, dst, 0, 16);
            device.queue.submit([encoder.finish()]);
            const mapping = dst.mapAsync(GPUMapMode.READ, 0, 16);
            globalThis.__tnSameFrameMapState = dst.mapState;
            await mapping;
            globalThis.__tnSameFrameReadback = Array.from(new Uint32Array(dst.getMappedRange(0, 16)));
            dst.destroy(); // three.js destroys instead of unmapping: the buffer stays mapped.
            globalThis.__tnSameFrameRan = true;
          });
        })())JS",
        "tn-same-frame-readback.js"),
        "same-frame readback script evaluated");
    awaitFlag(runtime.get(), engine, "__tnSameFrameRan");
    expect(engine->toBoolean(engine->getGlobalProperty("__tnSameFrameRan")),
           "same-frame readback ran inside a requestAnimationFrame callback");
    expect(engine->toBoolean(engine->evalScriptWithResult(
        "__tnSameFrameMapState === 'pending'", "tn-same-frame-map-state-check.js")),
        std::string("mapAsync returns while the mapping is pending: ") +
            engine->toString(engine->evalScriptWithResult(
                "String(__tnSameFrameMapState)", "tn-same-frame-map-state-report.js")));
    expect(engine->toBoolean(engine->evalScriptWithResult(
        "JSON.stringify(__tnSameFrameReadback) === '[5,6,7,8]'", "tn-same-frame-check.js")),
        std::string("mapAsync sees work submitted earlier in the same frame: ") +
            engine->toString(engine->evalScriptWithResult(
                "JSON.stringify(__tnSameFrameReadback)", "tn-same-frame-report.js")));
    runtime->pollEvents(); // The awaited continuation records destroy for the next drain.
    expect(state->profiling.frameOpStreamReplayCrossings - crossingsBeforeSameFrame >= 2,
           "mapAsync and the awaited destroy both drain the recorded stream");
    const std::vector<std::string> expectedSameFrameOrder = {"buffer.destroy"};
    if (state->profiling.frameOpStreamLastOrder != expectedSameFrameOrder) {
        std::cerr << "observed same-frame tail order:";
        for (const auto& op : state->profiling.frameOpStreamLastOrder)
            std::cerr << " " << op;
        std::cerr << std::endl;
    }
    expect(state->profiling.frameOpStreamLastOrder == expectedSameFrameOrder,
           "the copy and its submit left at mapAsync, leaving only the deferred destroy");

    // Exposure readback runs inside an outer render pass. The readback copy is submitted
    // after that pass opened, so no clean prefix includes it. Keep the backend map pending
    // until end-frame replays the whole interleaved stream and submits its copy.
    expect(engine->evalScript(
        R"JS((() => {
          const device = globalThis.__tnDevice;
          const src = device.createBuffer({size: 16, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST});
          const dst = device.createBuffer({size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
          requestAnimationFrame(() => {
            device.queue.writeBuffer(src, 0, new Uint32Array([9, 10, 11, 12]));
            const second = device.createCommandEncoder();
            const pass = second.beginRenderPass({colorAttachments: [{
              view: globalThis.__tnRenderView, loadOp: "clear", storeOp: "store",
              clearValue: [0, 0, 0, 1],
            }]});
            const first = device.createCommandEncoder();
            first.copyBufferToBuffer(src, 0, dst, 0, 16);
            device.queue.submit([first.finish()]);
            const mapping = dst.mapAsync(GPUMapMode.READ, 0, 16);
            mapping.then(() => {
              globalThis.__tnSplitReadback = Array.from(new Uint32Array(dst.getMappedRange(0, 16)));
              dst.unmap();
              globalThis.__tnSplitReadDone = true;
            });
            pass.end();
            device.queue.submit([second.finish()]);
            globalThis.__tnSplitRan = true;
          });
        })())JS",
        "tn-split-flush.js"),
        "split-flush script evaluated");
    runtime->pollEvents();
    expect(engine->toBoolean(engine->getGlobalProperty("__tnSplitRan")),
           "split-flush readback ran inside a requestAnimationFrame callback");
    const auto splitTailOrder = state->profiling.frameOpStreamLastOrder;
    awaitFlag(runtime.get(), engine, "__tnSplitReadDone");
    expect(engine->toBoolean(engine->evalScriptWithResult(
        "JSON.stringify(__tnSplitReadback) === '[9,10,11,12]'", "tn-split-check.js")),
        std::string("mapAsync flushes the submitted copy while an encoder is still open: ") +
            engine->toString(engine->evalScriptWithResult(
                "JSON.stringify(__tnSplitReadback)", "tn-split-report.js")));
    const std::vector<std::string> expectedSplitTailOrder = {
        "createCommandEncoder", "beginRenderPass", "createCommandEncoder", "copyBufferToBuffer",
        "finish", "submit", "render.end", "finish", "submit"};
    if (splitTailOrder != expectedSplitTailOrder) {
        std::cerr << "observed split tail order:";
        for (const auto& op : splitTailOrder)
            std::cerr << " " << op;
        std::cerr << std::endl;
    }
    expect(splitTailOrder == expectedSplitTailOrder,
           "the half-recorded encoder stayed behind and drained whole at the frame boundary");

    // No pollEvents between request and inspection: the native registry, not a JS wrapper,
    // must still own both requests. Cancellation must allow an immediate replacement map.
    expect(engine->evalScript(R"JS((() => {
      const make = () => __tnDevice.createBuffer({size:16, usage:GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
      globalThis.__tnMapA = make(); globalThis.__tnMapB = make();
      globalThis.__tnMapErrors = [];
      const check = (ok, label) => { if (!ok) __tnMapErrors.push(label); };
      const first = __tnMapA.mapAsync(1);
      const second = __tnMapB.mapAsync(1);
      globalThis.__tnConcurrentMaps = Promise.all([first, second]).then(async () => {
        check(__tnMapA.mapState === 'mapped' && __tnMapB.mapState === 'mapped', 'concurrent mapped');
        await __tnMapA.mapAsync(1).then(() => check(false, 'mapped request accepted'), () => {});
        check(__tnMapA.mapState === 'mapped', 'mapped rejection changed state');
        __tnMapA.unmap(); __tnMapB.unmap();
        const cancelled = __tnMapA.mapAsync(1).then(() => check(false, 'unmap did not cancel'), () => {});
        __tnMapA.unmap();
        const replacement = __tnMapA.mapAsync(1);
        await cancelled;
        check(__tnMapA.mapState === 'pending', 'old cancellation changed replacement state');
        await replacement;
        check(__tnMapA.mapState === 'mapped', 'replacement not mapped');
        __tnMapA.destroy();
        check(__tnMapA.mapState === 'unmapped', 'destroy did not clear mapState');
        const doomed = __tnMapB.mapAsync(1).then(() => check(false, 'destroy did not cancel'), () => {});
        __tnMapB.destroy();
        check(__tnMapB.mapState === 'unmapped', 'pending destroy state');
        await doomed;
        await __tnMapB.mapAsync(1).then(() => check(false, 'destroyed map accepted'), () => {});
        check(__tnBufferMapPendingCount() === 0, 'unsettled maps');
        globalThis.__tnMapLifecycleDone = true;
      }).catch(e => { __tnMapErrors.push(String(e)); globalThis.__tnMapLifecycleDone = true; });
      __tnMapA.mapAsync(1).then(() => check(false, 'duplicate accepted'), () => {
        check(__tnMapA.mapState === 'pending', 'duplicate rejection changed pending state');
      });
    })())JS", "tn-map-lifecycle.js"), "map lifecycle script evaluated");
    expect(state->asyncBufferMaps.pending.size() == 2,
           "two native map requests remain deferred without polling");
    for (const auto& entry : state->asyncBufferMaps.pending) {
        const auto& info = state->registries.bufferRegistry.at(entry.second->bufferId);
        expect(info.mapPending && !info.isMapped, "native map state stays pending until drain");
    }
    engine->processMicrotasks();
    awaitFlag(runtime.get(), engine, "__tnMapLifecycleDone");
    expect(engine->toBoolean(engine->evalScriptWithResult("__tnMapErrors.length === 0", "tn-map-check.js")),
           "buffer map lifecycle: " + engine->toString(engine->evalScriptWithResult("JSON.stringify(__tnMapErrors)", "tn-map-errors.js")));

    // Exercise a backend completion with an error, not just cancellation. The failed request must
    // leave both pending maps empty so the same buffer can be mapped successfully immediately
    // afterwards; otherwise a driver validation error turns into a permanent map-state leak.
    expect(engine->evalScript(R"JS((() => {
      globalThis.__tnMapFailure = __tnDevice.createBuffer({size:16, usage:GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
      globalThis.__tnMapFailureErrors = [];
      globalThis.__tnMapFailureDone = false;
      (async () => {
        const buffer = __tnMapFailure;
        await buffer.mapAsync(1, 0, 15).then(
          () => __tnMapFailureErrors.push('invalid map resolved'),
          () => {
            if (buffer.mapState !== 'unmapped') __tnMapFailureErrors.push('failed map state');
          });
        await buffer.mapAsync(1, 0, 16);
        if (buffer.mapState !== 'mapped') __tnMapFailureErrors.push('reused map state');
        buffer.unmap();
        buffer.destroy();
        globalThis.__tnMapFailureDone = true;
      })().catch((error) => {
        __tnMapFailureErrors.push(String(error));
        globalThis.__tnMapFailureDone = true;
      });
    })())JS", "tn-map-failure.js"), "backend map failure requested");
    awaitFlag(runtime.get(), engine, "__tnMapFailureDone");
    expect(engine->toBoolean(engine->evalScriptWithResult(
        "__tnMapFailureErrors.length === 0 && __tnBufferMapPendingCount() === 0",
        "tn-map-failure-check.js")),
           "backend map failures clear every promise: " +
               engine->toString(engine->evalScriptWithResult(
                   "JSON.stringify(__tnMapFailureErrors)", "tn-map-failure-errors.js")));
    expect(state->asyncBufferMaps.pending.empty(),
           "backend map failures clear every native pending request");

    expect(engine->evalScript(R"JS((() => {
      globalThis.__tnShutdownBuffer = __tnDevice.createBuffer({size:16, usage:GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST});
      globalThis.__tnShutdownSettlements = 0;
      __tnShutdownBuffer.mapAsync(1).then(
        () => { __tnShutdownSettlements++; globalThis.__tnShutdownResult = 'resolved'; },
        () => { __tnShutdownSettlements++; globalThis.__tnShutdownResult = __tnShutdownBuffer.mapState; });
    })())JS", "tn-map-shutdown.js"), "shutdown map requested");
    const auto shutdownRequest = state->asyncBufferMaps.pending.begin()->second;
    mystral::webgpu::shutdownAsyncBufferMaps(state);
    mystral::webgpu::shutdownAsyncBufferMaps(state); // idempotent, including late callbacks
    engine->processMicrotasks();
    expect(state->asyncBufferMaps.pending.empty(), "shutdown clears pending native maps");
    expect(!state->registries.bufferRegistry.at(shutdownRequest->bufferId).mapPending,
           "shutdown cancels the backend map and clears pending state");
    expect(engine->toBoolean(engine->evalScriptWithResult(
        "__tnShutdownResult === 'unmapped' && __tnShutdownSettlements === 1 && __tnBufferMapPendingCount() === 0",
        "tn-shutdown-map-check.js")), "shutdown rejects each promise exactly once");
    expect(engine->evalScript(R"JS(
      __tnShutdownBuffer.mapAsync(1).then(
        () => { globalThis.__tnAfterShutdown = false; },
        () => { globalThis.__tnAfterShutdown = true; });
    )JS", "tn-map-after-shutdown.js"), "map after shutdown requested");
    engine->processMicrotasks();
    expect(engine->toBoolean(engine->getGlobalProperty("__tnAfterShutdown")),
           "shutdown refuses new map requests");

    state->profiling.frameOpStreamNativeCallObserver = observeFrameReplayBackendEntry;
    frameReplayBackendEntries = 0;

    expectMalformed(state, "() => new ArrayBuffer(8)", "truncated header",
                    "native parser rejects a truncated header");
    expectMalformed(state,
        "() => { const b=new ArrayBuffer(16),v=new DataView(b); v.setUint32(4,1,true); v.setUint32(8,16,true); return b; }",
        "invalid header", "native parser rejects invalid header magic");
    expectMalformed(state,
        "() => { const b=new ArrayBuffer(28),v=new DataView(b); v.setUint32(0,0x544e4652,true); v.setUint32(4,1,true); v.setUint32(8,28,true); v.setUint32(12,1,true); v.setUint32(16,2,true); v.setUint32(20,12,true); v.setUint32(24,1,true); return b; }",
        "malformed record header", "native parser rejects an unaligned record length");
    expectMalformed(state,
        "() => { const b=new ArrayBuffer(24),v=new DataView(b); v.setUint32(0,0x544e4652,true); v.setUint32(4,1,true); v.setUint32(8,24,true); v.setUint32(12,1,true); v.setUint32(16,99,true); v.setUint32(20,8,true); return b; }",
        "malformed record header", "native parser rejects an unknown opcode");
    expectMalformed(state,
        "() => { const b=new ArrayBuffer(24),v=new DataView(b); v.setUint32(0,0x544e4652,true); v.setUint32(4,1,true); v.setUint32(8,24,true); v.setUint32(12,1,true); v.setUint32(16,36,true); v.setUint32(20,8,true); return b; }",
        "malformed record header", "native parser rejects unsupported query-set destroy opcode");
    expectMalformed(state,
        "() => { const b=new ArrayBuffer(40),v=new DataView(b); v.setUint32(0,0x544e4652,true); v.setUint32(4,1,true); v.setUint32(8,40,true); v.setUint32(12,1,true); v.setUint32(16,1,true); v.setUint32(20,24,true); v.setUint32(24,0xffffffff,true); return b; }",
        "unknown buffer id", "native parser rejects an unknown resource id");
    if (!state->registries.bufferRegistry.empty()) {
        const uint64_t validBufferId = state->registries.bufferRegistry.begin()->first;
        std::ostringstream truncatedWriteBuffer;
        truncatedWriteBuffer
            << "() => { const b=new ArrayBuffer(32),v=new DataView(b); "
               "v.setUint32(0,0x544e4652,true); v.setUint32(4,2,true); "
               "v.setUint32(8,32,true); v.setUint32(12,1,true); "
               "v.setUint32(16,1,true); v.setUint32(20,16,true); "
            << "v.setUint32(24," << validBufferId << ",true); return b; }";
        expectMalformed(state, truncatedWriteBuffer.str(), "truncated writeBuffer record",
                        "native parser rejects a truncated writeBuffer with a valid buffer id");
    } else {
        expect(false, "malformed writeBuffer test found a valid buffer registry entry");
    }
    expectMalformed(state,
        "() => { const b=new ArrayBuffer(40),v=new DataView(b); v.setUint32(0,0x544e4652,true); v.setUint32(4,2,true); v.setUint32(8,40,true); v.setUint32(12,1,true); v.setUint32(16,18,true); v.setUint32(20,24,true); v.setUint32(24,0xffffffff,true); v.setUint32(28,1,true); return b; }",
        "unknown command encoder id", "native parser rejects an unknown compute encoder");
    expectMalformed(state,
        "() => { const b=new ArrayBuffer(112),v=new DataView(b); v.setUint32(0,0x544e4652,true); v.setUint32(4,2,true); v.setUint32(8,112,true); v.setUint32(12,2,true); v.setUint32(16,2,true); v.setUint32(20,16,true); v.setUint32(24,1,true); v.setUint32(32,3,true); v.setUint32(36,80,true); v.setUint32(40,1,true); v.setUint32(44,2,true); v.setUint32(48,1,true); v.setUint32(52,0xffffffff,true); return b; }",
        "unknown texture view id", "native parser rejects an invalid texture-view id");
    state->profiling.frameOpStreamNativeCallObserver = nullptr;
    state->profiling.frameOpStreamDrain = {};
}

// One arm of the visual comparison: the same two frames rendered twice, with only the clear colour
// moving between them, and the pixels read back. `plans` selects the transport.
struct VisualArm {
    std::string first;
    std::string second;
    bool ran = false;
};

VisualArm runVisualArm(bool plans) {
    VisualArm arm;
    setFramePlanOverride(plans);
    // The arm has to be the transport it claims, or the comparison below would pass by comparing two
    // v2 streams. The plan arm asserts its own capture and patch where the arm is read.
    expect(plans == (std::getenv("TN_FRAME_PLANS") != nullptr),
           std::string("visual arm flag matches the transport it claims: TN_FRAME_PLANS is ") +
               (std::getenv("TN_FRAME_PLANS") ? "set" : "unset"));
    mystral::RuntimeConfig config;
    config.width = 4;
    config.height = 4;
    config.noSdl = true;
    const auto runtime = mystral::Runtime::create(config);
    if (!runtime || !runtime->getWebGPUBindingsState()) {
        expect(false, "headless runtime with WebGPU bindings created for the visual arm");
        return arm;
    }
    auto* state = static_cast<mystral::webgpu::BindingsState*>(runtime->getWebGPUBindingsState());
    auto* engine = state->engine;
    const bool evaluated = engine->evalScript(
        R"JS((async () => {
          try {
          const adapter = await navigator.gpu.requestAdapter();
          const device = await adapter.requestDevice();
          const target = device.createTexture({
            size: [4, 4], format: "rgba8unorm",
            usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
          });
          const view = target.createView();
          // One readback per frame: bytesPerRow must be a multiple of 256 for a texture copy, so the
          // mapping is padded and the comparison reads the first row of it.
          const makeReadback = () => device.createBuffer({
            size: 1024, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
          });
          const first = makeReadback();
          const second = makeReadback();
          globalThis.__tnVisualPixels = [];
          globalThis.__tnVisualDone = false;
          const render = (frame, colour, readback) => {
            const encoder = device.createCommandEncoder();
            const pass = encoder.beginRenderPass({colorAttachments: [{
              view, loadOp: "clear", storeOp: "store", clearValue: colour,
            }]});
            pass.end();
            encoder.copyTextureToBuffer(
              {texture: target},
              {buffer: readback, bytesPerRow: 256, rowsPerImage: 4},
              [4, 4, 1]);
            device.queue.submit([encoder.finish()]);
          };
          // One frame each, chained rather than registered together: a map in the same frame as a
          // render would drain that frame mid-way, which is the split case and not this comparison.
          requestAnimationFrame(() => {
            // The clear colour is the visual value under test, and it is the only thing that moves.
            render(1, [0.25, 0.5, 0.75, 1], first);
            requestAnimationFrame(() => {
              render(2, [0.75, 0.5, 0.25, 1], second);
              requestAnimationFrame(async () => {
                for (const readback of [first, second]) {
                  await readback.mapAsync(GPUMapMode.READ, 0, 1024);
                  globalThis.__tnVisualPixels.push(
                    Array.from(new Uint8Array(readback.getMappedRange(0, 1024))));
                  readback.unmap();
                }
                globalThis.__tnVisualDone = true;
              });
            });
          });
          } catch (error) {
            globalThis.__tnVisualError = String(error);
            globalThis.__tnVisualDone = true;
          }
        })())JS",
        "tn-visual.js");
    expect(evaluated, "visual scene evaluated: " +
                          (engine->hasException() ? engine->getException() : std::string("no exception")));
    awaitFlag(runtime.get(), engine, "__tnVisualDone");
    expect(engine->isUndefined(engine->getGlobalProperty("__tnVisualError")),
           "visual scene completed without an error: " +
               engine->toString(engine->evalScriptWithResult(
                   "String(globalThis.__tnVisualError || '')", "tn-visual-error.js")));
    const auto read = [&](const char* which) {
        return engine->toString(engine->evalScriptWithResult(
            (std::string("JSON.stringify(globalThis.__tnVisualPixels[") + which + "] || null)")
                .c_str(),
            "tn-visual-pixels.js"));
    };
    arm.first = read("0");
    arm.second = read("1");
    arm.ran = arm.first != "null" && arm.second != "null";
    if (plans) {
        // Otherwise the comparison above would pass because both arms sent the same v2 stream.
        expect(state->framePlan.captures >= 1 && state->framePlan.patches >= 1,
               "the plan arm of the visual comparison captured one frame and patched the next: " +
                   std::to_string(state->framePlan.captures) + " captures, " +
                   std::to_string(state->framePlan.patches) + " patches, valid " +
                   std::to_string(state->framePlan.valid ? 1 : 0));
    }
    return arm;
}

// Drives real frames until the page's own frame counter passes `frames`.
void awaitFrames(mystral::Runtime* runtime, mystral::js::Engine* engine, int frames) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(20);
    while (std::chrono::steady_clock::now() < deadline) {
        runtime->pollEvents();
        engine->processMicrotasks();
        mystral::js::JSValueGuard count(*engine, engine->getGlobalProperty("__tnPlanFrames"));
        if (!engine->isUndefined(count.get()) && engine->toNumber(count.get()) >= frames) return;
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    expect(false, "timed out awaiting frame " + std::to_string(frames));
}

// Hands the host one packet built by the test and replays it, expecting the packet to be accepted
// and to produce exactly `order`.
void expectAccepted(mystral::webgpu::BindingsState* state, const std::string& expression,
                    const std::vector<std::string>& order, const std::string& what) {
    auto* engine = state->engine;
    state->profiling.frameOpStreamLastOrder.clear();
    state->profiling.frameOpStreamDrain =
        engine->evalScriptWithResult(expression.c_str(), "tn-plan-packet.js");
    mystral::webgpu::endDawnFrame(state);
    const std::string exception = engine->hasException() ? engine->getException() : "";
    expect(exception.empty(), what + ": " + exception);
    if (state->profiling.frameOpStreamLastOrder != order) {
        std::cerr << what << " observed order:";
        for (const auto& op : state->profiling.frameOpStreamLastOrder) std::cerr << " " << op;
        std::cerr << std::endl;
    }
    expect(state->profiling.frameOpStreamLastOrder == order, what + ": operation order");
}

// Compiled frame plans (v3 transport) against a real device: the production recorder captures one
// frame and patches the next, the patch reaches the GPU, every malformed packet fails closed
// without entering a backend call, and a capture re-establishes the plan afterwards.
void runPlanContract() {
    setFramePlanOverride(true);
    mystral::RuntimeConfig config;
    config.width = 1;
    config.height = 1;
    config.noSdl = true;
    const auto runtime = mystral::Runtime::create(config);
    if (!runtime || !runtime->getWebGPUBindingsState()) {
        expect(false, "headless runtime with WebGPU bindings created for the plan contract");
        return;
    }
    auto* state = static_cast<mystral::webgpu::BindingsState*>(runtime->getWebGPUBindingsState());
    auto* engine = state->engine;
    state->profiling.captureFrameOpStreamTrace = true;

    const std::vector<std::string> sceneOrder = {"writeBuffer", "createCommandEncoder",
                                                 "copyBufferToBuffer", "beginRenderPass",
                                                 "render.end", "finish", "submit"};
    expect(engine->evalScript(
        R"JS((async () => {
          const adapter = await navigator.gpu.requestAdapter();
          const device = await adapter.requestDevice();
          const src = device.createBuffer({size: 16, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST});
          const dst = device.createBuffer({size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
          const target = device.createTexture({
            size: [1, 1], format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT,
          });
          const view = target.createView();
          globalThis.__tnPlanSrc = src;
          globalThis.__tnPlanDst = dst;
          globalThis.__tnPlanTick = 0;
          globalThis.__tnPlanFrames = 0;
          globalThis.__tnPlanPaused = false;
          globalThis.__tnPlanStop = false;
          const step = () => {
            if (globalThis.__tnPlanStop) return;
            requestAnimationFrame(step);
            if (globalThis.__tnPlanPaused) return;
            // One scene, identical in structure every frame: what moves is the uniform payload and
            // the wire ids a frame allocates for its own encoder, pass and command buffer.
            const tick = ++globalThis.__tnPlanTick;
            device.queue.writeBuffer(src, 0, new Uint32Array([tick, tick + 1, tick + 2, tick + 3]));
            const encoder = device.createCommandEncoder();
            encoder.copyBufferToBuffer(src, 0, dst, 0, 16);
            const pass = encoder.beginRenderPass({colorAttachments: [{
              view, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1],
            }]});
            pass.end();
            device.queue.submit([encoder.finish()]);
            globalThis.__tnPlanFrames += 1;
            if (globalThis.__tnPlanFrames === 3) globalThis.__tnPlanPaused = true;
          };
          requestAnimationFrame(step);
        })().catch((error) => { globalThis.__tnPlanError = String(error) + " | " + error.stack; }))JS",
        "tn-plan-scene.js"),
        "plan scene evaluated");
    awaitFrames(runtime.get(), engine, 3);

    expect(state->framePlan.valid, "three identical frames left a retained plan");
    expect(state->framePlan.captures == 1, "the first frame was the only capture: " +
                                               std::to_string(state->framePlan.captures));
    expect(state->framePlan.patches >= 2,
           "the frames that followed patched the plan: " + std::to_string(state->framePlan.patches));
    expect(state->framePlan.patchBytes / state->framePlan.patches <
               state->framePlan.captureBytes / state->framePlan.captures,
           "a patched frame carries fewer bytes than a captured one");
    expect(state->framePlan.sequence == 3, "the plan's sequence counts every packet");
    expect(state->framePlan.records.size() == state->framePlan.opCount,
           "the retained plan compiled one record per operation");
    bool ascending = true;
    for (size_t i = 1; i != state->framePlan.records.size(); ++i)
        ascending = ascending && state->framePlan.records[i].offset > state->framePlan.records[i - 1].offset;
    expect(ascending, "compiled record boundaries are strictly ascending");
    expect(state->profiling.frameOpStreamLastOrder == sceneOrder,
           "the patched frame replayed the whole plan in order");
    expect(state->profiling.frameOpStreamLastOpCount == sceneOrder.size(),
           "the patched frame replayed every operation exactly once");
    expect(static_cast<uint32_t>(state->framePlan.records.size()) == state->framePlan.opCount,
           "the compiled layout covers the whole plan");

    // The third frame's uniform payload left through a patch. Reading the destination buffer back
    // is the one observation that cannot be satisfied by a plan that was parsed but not applied.
    expect(engine->evalScript(R"JS((() => {
      requestAnimationFrame(async () => {
        try {
          await globalThis.__tnPlanDst.mapAsync(GPUMapMode.READ, 0, 16);
          globalThis.__tnPlanReadback = Array.from(new Uint32Array(globalThis.__tnPlanDst.getMappedRange(0, 16)));
          globalThis.__tnPlanDst.unmap();
        } catch (error) {
          globalThis.__tnPlanReadbackError = String(error);
        } finally {
          globalThis.__tnPlanDone = true;
        }
      });
    })())JS", "tn-plan-readback.js"), "plan readback requested");
    awaitFlag(runtime.get(), engine, "__tnPlanDone");
    expect(engine->isUndefined(engine->getGlobalProperty("__tnPlanReadbackError")),
           "plan readback completed without an error");
    expect(engine->toBoolean(engine->evalScriptWithResult(
               "JSON.stringify(__tnPlanReadback) === '[3,4,5,6]'", "tn-plan-readback-check.js")),
           "the patched upload reached the buffer: " +
               engine->toString(engine->evalScriptWithResult(
                   "JSON.stringify(__tnPlanReadback)", "tn-plan-readback-value.js")));

    state->profiling.frameOpStreamNativeCallObserver = observeFrameReplayBackendEntry;
    frameReplayBackendEntries = 0;

    // Packet-level cases run against packets the test builds by hand, so each one can be checked
    // on its own without guessing what the recorder would have sent. A capture packet is an empty
    // command buffer: encoder 900, finished into command buffer 901, submitted.
    auto capturePacket = [](int sequence) {
        std::ostringstream out;
        out << "() => { const b = new ArrayBuffer(72); const v = new DataView(b);"
               " v.setUint32(0, 0x544e4652, true); v.setUint32(4, 3, true); v.setUint32(8, 72, true);"
               " v.setUint32(12, 1, true); v.setUint32(16, "
            << sequence
            << ", true); v.setUint32(20, 3, true);"
               " v.setUint32(24, 2, true); v.setUint32(28, 16, true); v.setUint32(32, 900, true);"
               " v.setUint32(40, 28, true); v.setUint32(44, 16, true); v.setUint32(48, 900, true);"
               " v.setUint32(52, 901, true);"
               " v.setUint32(56, 29, true); v.setUint32(60, 16, true); v.setUint32(64, 1, true);"
               " v.setUint32(68, 901, true); return b; }";
        return out.str();
    };
    auto patchPacket = [](int sequence, const std::string& entries, int trailing = 0) {
        std::ostringstream out;
        out << "() => { const entries = " << entries
            << "; const size = 24 + " << trailing
            << " + entries.reduce((n, e) => n + 8 + e.runs.reduce((m, r) => m + 8 + r.words.length * 4, 0), 0);"
               " const b = new ArrayBuffer(size); const v = new DataView(b);"
               " v.setUint32(0, 0x544e4652, true); v.setUint32(4, 3, true); v.setUint32(8, size, true);"
               " v.setUint32(12, 2, true); v.setUint32(16, "
            << sequence
            << ", true); v.setUint32(20, entries.length, true);"
               " let at = 24;"
               " for (const entry of entries) { v.setUint32(at, entry.index, true);"
               " v.setUint32(at + 4, entry.runs.length, true); at += 8;"
               " for (const run of entry.runs) { v.setUint32(at, run.offset, true);"
               " v.setUint32(at + 4, run.words.length * 4, true); at += 8;"
               " new Uint32Array(b, at, run.words.length).set(run.words); at += run.words.length * 4; } }"
               " return b; }";
        return out.str();
    };
    const std::vector<std::string> emptyFrameOrder = {"createCommandEncoder", "finish", "submit"};
    // A patch that writes the same words back is accepted, applies, and replays the plan whole.
    expectAccepted(state, capturePacket(40), emptyFrameOrder, "a hand-built capture is retained");
    expectAccepted(state, patchPacket(41, "[{index:2,runs:[{offset:8,words:[1,901]}]}]"),
                   emptyFrameOrder, "a patch of unchanged words applies and replays");

    // A rejection drops the plan, so every structural case is judged against a capture it sets up
    // itself rather than against whatever the case before it left behind.
    int caseSequence = 50;
    auto rejected = [&](const std::string& entries, const char* expected, const char* what,
                        int trailing = 0) {
        expectAccepted(state, capturePacket(caseSequence), emptyFrameOrder, std::string(what) + " setup");
        expectMalformed(state, patchPacket(caseSequence + 1, entries, trailing), expected, what);
        caseSequence += 1;
    };
    auto rejectedSequence = [&](int offset, const std::string& entries, const char* expected,
                                const char* what) {
        expectAccepted(state, capturePacket(caseSequence), emptyFrameOrder, std::string(what) + " setup");
        expectMalformed(state, patchPacket(caseSequence + offset, entries), expected, what);
        caseSequence += 1;
    };
    auto rejectedPacket = [&](const std::string& packet, const char* expected, const char* what) {
        expectAccepted(state, capturePacket(caseSequence), emptyFrameOrder, std::string(what) + " setup");
        expectMalformed(state, packet, expected, what);
        caseSequence += 1;
    };
    rejectedPacket("() => { const b = new ArrayBuffer(32); const v = new DataView(b);"
                   " v.setUint32(0, 0x544e4652, true); v.setUint32(4, 3, true); v.setUint32(8, 32, true);"
                   " v.setUint32(12, 99, true); v.setUint32(16, 1, true); v.setUint32(20, 0, true); return b; }",
                   "unsupported frame plan mode", "native parser rejects an unknown plan mode");
    rejectedPacket("() => { const b = new ArrayBuffer(24); const v = new DataView(b);"
                   " v.setUint32(0, 0x544e4652, true); v.setUint32(4, 3, true); v.setUint32(8, 24, true);"
                   " v.setUint32(12, 1, true); v.setUint32(16, 1, true); v.setUint32(20, 0, true); return b; }",
                   "malformed capture record layout", "native parser rejects a capture with no records");
    {
        // A capture that names more bytes than the retained frame may hold. The bound is checked
        // before the body, so nothing walks a 32 MiB packet of zeros.
        std::ostringstream oversized;
        oversized << "() => { const b = new ArrayBuffer("
                  << (mystral::webgpu::FramePlanState::maxBytes + 32)
                  << "); const v = new DataView(b); v.setUint32(0, 0x544e4652, true); v.setUint32(4, 3, true);"
                     " v.setUint32(8, b.byteLength, true); v.setUint32(12, 1, true); v.setUint32(16, 1, true);"
                     " v.setUint32(20, 1, true); return b; }";
        rejectedPacket(oversized.str(), "capture exceeds the retained frame bound",
                       "native parser rejects a capture past the retained-frame bound");
    }
    rejected("[{index:9,runs:[{offset:8,words:[0,0]}]}]", "frame plan patch index out of range",
             "native parser rejects a patch index past the plan");
    rejected("[{index:2,runs:[{offset:8,words:[0,0]}]},{index:2,runs:[{offset:8,words:[0,0]}]}]",
             "frame plan patch indices out of order",
             "native parser rejects two entries for one record");
    rejected("[{index:2,runs:[{offset:0,words:[0,0]}]}]",
             "frame plan patch touches the record header", "native parser rejects a patch of a record header");
    rejected("[{index:2,runs:[{offset:8,words:[0]}]}]",
             "frame plan patch run is not a whole 8-byte word",
             "native parser rejects a patch run that is not a whole word");
    rejected("[{index:2,runs:[{offset:8,words:[0,0,0,0]}]}]",
             "frame plan patch run leaves its record", "native parser rejects a run that leaves its record");
    rejected("[{index:2,runs:[{offset:8,words:[0,0]},{offset:8,words:[0,0]}]}]",
             "frame plan patch runs overlap", "native parser rejects overlapping runs in one entry");
    rejected("[{index:2,runs:[]}]", "frame plan patch entry carries no runs",
             "native parser rejects an entry that carries no runs");
    rejected("[{index:2,runs:[{offset:8,words:[0,0]}]}]", "frame plan patch length mismatch",
             "native parser rejects a patch with unread trailing bytes", 8);
    rejectedSequence(9, "[{index:2,runs:[{offset:8,words:[0,0]}]}]", "stale frame plan sequence",
                     "native parser rejects a patch from a sequence it never sent");
    // The last rejection dropped the plan, so this one has nothing to patch — the state a recovery
    // has to survive. A capture and a patch after it prove the plan comes back.
    expectMalformed(state, patchPacket(1, "[{index:2,runs:[{offset:8,words:[0,0]}]}]"),
                    "patch sent without a retained plan", "native parser rejects a patch with no plan");
    expectAccepted(state, capturePacket(60), emptyFrameOrder, "a capture recovers the plan");
    expectAccepted(state, patchPacket(61, "[{index:1,runs:[{offset:8,words:[900,901]}]}]"),
                   emptyFrameOrder, "a patch applies again after recovery");
    expect(state->framePlan.valid && state->framePlan.sequence == 61,
           "the recovered plan is retained and sequenced");

    state->profiling.frameOpStreamNativeCallObserver = nullptr;
    state->profiling.frameOpStreamDrain = {};
    setFramePlanOverride(false);
}

// The lifecycle a retained plan has to survive on the real decoder: a mapAsync drain that splits a
// frame, and a device recreation.
void runPlanLifecycleContract() {
    setFramePlanOverride(true);
    mystral::RuntimeConfig config;
    config.width = 1;
    config.height = 1;
    config.noSdl = true;
    const auto runtime = mystral::Runtime::create(config);
    if (!runtime || !runtime->getWebGPUBindingsState()) {
        expect(false, "headless runtime with WebGPU bindings created for the plan lifecycle contract");
        return;
    }
    auto* state = static_cast<mystral::webgpu::BindingsState*>(runtime->getWebGPUBindingsState());
    auto* engine = state->engine;
    state->profiling.captureFrameOpStreamTrace = true;
    const uint64_t crossingsBefore = state->profiling.frameOpStreamReplayCrossings;
    const uint64_t capturesBefore = state->framePlan.captures;

    // A map mid-frame splits the frame: the prefix has to reach the host before the map can resolve,
    // and the frame boundary has to send the rest without replaying anything twice. A second
    // encoder creating the same wire id again, or a buffer copy running twice, would be a failure
    // the host reports rather than a quiet difference.
    expect(engine->evalScript(
        R"JS((async () => {
          try {
          const adapter = await navigator.gpu.requestAdapter();
          const device = await adapter.requestDevice();
          globalThis.__tnSplitDevice = device;
          const src = device.createBuffer({size: 16, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST});
          const dst = device.createBuffer({size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
          globalThis.__tnSplitFrame = 0;
          globalThis.__tnSplitDone = false;
          const step = async () => {
            const frame = ++globalThis.__tnSplitFrame;
            if (frame > 2) {
              globalThis.__tnSplitDone = true;
              return;
            }
            device.queue.writeBuffer(src, 0, new Uint32Array([frame, frame, frame, frame]));
            const encoder = device.createCommandEncoder();
            encoder.copyBufferToBuffer(src, 0, dst, 0, 16);
            device.queue.submit([encoder.finish()]);
            // WebGPU completes a map only after the work already submitted, so this drains the
            // prefix of the frame right here, in the middle of it.
            await dst.mapAsync(GPUMapMode.READ, 0, 16);
            globalThis.__tnSplitValue = Array.from(new Uint32Array(dst.getMappedRange(0, 16)));
            dst.unmap();
            // The frame keeps recording behind the cut, and its boundary sends that tail.
            const tail = device.createCommandEncoder();
            const pass = tail.beginRenderPass({colorAttachments: []});
            pass.end();
            device.queue.submit([tail.finish()]);
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
          } catch (error) {
            globalThis.__tnSplitError = String(error);
            globalThis.__tnSplitDone = true;
          }
        })())JS",
        "tn-plan-split.js"),
        "split-frame scene evaluated");
    awaitFlag(runtime.get(), engine, "__tnSplitDone");
    // The last split frame's own boundary drain lands after the scene's done flag, so let the frame
    // loop turn over before counting crossings.
    for (int pump = 0; pump < 5; ++pump) runtime->pollEvents();
    expect(engine->isUndefined(engine->getGlobalProperty("__tnSplitError")),
           "the split frame completed without an error: " +
               engine->toString(engine->evalScriptWithResult(
                   "String(globalThis.__tnSplitError || '')", "tn-split-error.js")));
    expect(engine->toBoolean(engine->evalScriptWithResult(
               "JSON.stringify(__tnSplitValue) === '[2,2,2,2]'", "tn-split-value.js")),
           "a split frame's prefix executed before its map resolved: " +
               engine->toString(engine->evalScriptWithResult(
                   "JSON.stringify(__tnSplitValue)", "tn-split-value-read.js")));
    // Two frames, and the recorded work reaches the host exactly once: the prefix of each frame
    // crosses at its map, and the tail the second split left behind crosses at the following frame
    // boundary, because the map's continuation records it after that boundary has already run.
    expect(state->profiling.frameOpStreamReplayCrossings - crossingsBefore >= 3,
           "a split frame's prefix and tail each crossed the host once: " +
               std::to_string(state->profiling.frameOpStreamReplayCrossings - crossingsBefore));
    const std::vector<std::string> tailOrder = {"createCommandEncoder", "beginRenderPass",
                                                "render.end", "finish", "submit"};
    expect(state->profiling.frameOpStreamLastOrder == tailOrder,
           "the frame boundary replayed the tail a split left behind");
    expect(state->framePlan.captures > capturesBefore,
           "a split frame dropped the retained plan and the next frame captured a new one");

    // A device recreation builds a new recorder over a new device. The host's retained plan is still
    // the old frame, so the first frame after recreation has to be a capture that replaces it, and
    // the records have to name the new device's resources.
    expect(engine->evalScript(
        R"JS((async () => {
          try {
          globalThis.__tnSplitDevice.destroy();
          const adapter = await navigator.gpu.requestAdapter();
          const device = await adapter.requestDevice();
          const src = device.createBuffer({size: 16, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST});
          const dst = device.createBuffer({size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
          globalThis.__tnRecreateDone = false;
          requestAnimationFrame(async () => {
            device.queue.writeBuffer(src, 0, new Uint32Array([9, 8, 7, 6]));
            const encoder = device.createCommandEncoder();
            encoder.copyBufferToBuffer(src, 0, dst, 0, 16);
            device.queue.submit([encoder.finish()]);
            await dst.mapAsync(GPUMapMode.READ, 0, 16);
            globalThis.__tnRecreateValue = Array.from(new Uint32Array(dst.getMappedRange(0, 16)));
            dst.unmap();
            globalThis.__tnRecreateDone = true;
          });
          } catch (error) {
            globalThis.__tnRecreateError = String(error);
            globalThis.__tnRecreateDone = true;
          }
        })())JS",
        "tn-recreate-device.js"),
        "device recreation requested");
    awaitFlag(runtime.get(), engine, "__tnRecreateDone");
    expect(engine->isUndefined(engine->getGlobalProperty("__tnRecreateError")),
           "device recreation completed without an error: " +
               engine->toString(engine->evalScriptWithResult(
                   "String(globalThis.__tnRecreateError || '')", "tn-recreate-error.js")));
    expect(engine->toBoolean(engine->evalScriptWithResult(
               "JSON.stringify(__tnRecreateValue) === '[9,8,7,6]'", "tn-recreate-value.js")),
           "a recreated device replays a frame whose resources belong to it: " +
               engine->toString(engine->evalScriptWithResult(
                   "JSON.stringify(__tnRecreateValue)", "tn-recreate-value-read.js")));
    expect(state->profiling.frameOpStreamLastOrder ==
               std::vector<std::string>{"writeBuffer", "createCommandEncoder", "copyBufferToBuffer",
                                        "finish", "submit"},
           "the frame after device recreation replayed in order");

    state->profiling.frameOpStreamDrain = {};
    setFramePlanOverride(false);
}

}  // namespace

// An array layer uploaded the way three uploads one: the whole array plus `layout.offset`. The
// recorder keeps only the layer the copy reads and replays it at offset 0, so layer k has to hold
// layer k's bytes on the GPU and its neighbour must stay untouched.
void runArrayLayerUploadContract() {
    mystral::RuntimeConfig config;
    config.width = 1;
    config.height = 1;
    config.noSdl = true;
    const auto runtime = mystral::Runtime::create(config);
    if (!runtime || !runtime->getWebGPUBindingsState()) {
        expect(false, "layer upload runtime created");
        return;
    }
    auto* state = static_cast<mystral::webgpu::BindingsState*>(runtime->getWebGPUBindingsState());
    auto* engine = state->engine;
    expect(engine->evalScript(
        R"JS((async () => {
          const adapter = await navigator.gpu.requestAdapter();
          const device = await adapter.requestDevice();
          const texture = device.createTexture({
            size: [1, 1, 4], format: "rgba8unorm",
            usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
          });
          const readback = device.createBuffer({size: 512, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ});
          requestAnimationFrame(() => {
            const layers = new Uint8Array(16);
            for (let layer = 0; layer < 4; layer += 1) layers.fill(layer + 1, layer * 4, layer * 4 + 4);
            device.queue.writeTexture({texture, origin: {x: 0, y: 0, z: 2}}, layers,
              {offset: 8, bytesPerRow: 4, rowsPerImage: 1}, {width: 1, height: 1, depthOrArrayLayers: 1});
            const encoder = device.createCommandEncoder();
            encoder.copyTextureToBuffer({texture, origin: {x: 0, y: 0, z: 2}}, {buffer: readback, bytesPerRow: 256}, [1, 1, 1]);
            encoder.copyTextureToBuffer({texture, origin: {x: 0, y: 0, z: 1}}, {buffer: readback, offset: 256, bytesPerRow: 256}, [1, 1, 1]);
            device.queue.submit([encoder.finish()]);
            globalThis.__tnLayerRecorded = true;
          });
          await new Promise((resolve) => { const wait = () => globalThis.__tnLayerRecorded ? resolve() : setTimeout(wait, 1); wait(); });
          await new Promise((resolve) => requestAnimationFrame(resolve));
          await readback.mapAsync(GPUMapMode.READ);
          const bytes = new Uint8Array(readback.getMappedRange());
          globalThis.__tnLayerReadback = JSON.stringify([Array.from(bytes.slice(0, 4)), Array.from(bytes.slice(256, 260))]);
          readback.unmap();
          globalThis.__tnLayerDone = true;
        })().catch((error) => { globalThis.__tnLayerReadback = String(error); globalThis.__tnLayerDone = true; }))JS",
        "tn-array-layer-upload.js"),
        "array layer upload script evaluated");
    awaitFlag(runtime.get(), engine, "__tnLayerDone");
    mystral::js::JSValueGuard readback(*engine, engine->getGlobalProperty("__tnLayerReadback"));
    const std::string observed = engine->isUndefined(readback.get()) ? "" : engine->toString(readback.get());
    expect(observed == "[[3,3,3,3],[0,0,0,0]]",
           "offset writeTexture lands layer 2's bytes in layer 2 and leaves layer 1 alone: " + observed);
}

void runWriteBufferContract(bool direct, const char* proofBundle) {
    mystral::RuntimeConfig config;
    config.width = 1;
    config.height = 1;
    config.noSdl = true;
    const auto runtime = mystral::Runtime::create(config);
    if (!runtime || !runtime->getWebGPUBindingsState()) {
        expect(false, "writeBuffer proof requires native WebGPU bindings");
        return;
    }
    auto* state = static_cast<mystral::webgpu::BindingsState*>(runtime->getWebGPUBindingsState());
    auto* engine = state->engine;
    state->profiling.disableFrameOpStreamForTesting = direct;
    frameReplayBackendEntries = 0;
    state->profiling.frameOpStreamNativeCallObserver = [](const char* operation) {
        if (std::string(operation) == "writeBuffer") frameReplayBackendEntries += 1;
    };
    std::ifstream input(proofBundle);
    std::ostringstream source;
    source << input.rdbuf();
    if (!input || source.str().empty()) {
        expect(false, "writeBuffer proof bundle must exist and be nonempty");
        return;
    }
    expect(engine->evalScript(source.str().c_str(), proofBundle), "shared writeBuffer proof loaded");
    expect(engine->evalScript(R"JS((async () => {
      try {
        const adapter = await navigator.gpu.requestAdapter();
        if (!adapter) throw new Error("missing native GPU adapter");
        const device = await adapter.requestDevice();
        await writeBufferProof.verifyQueueWriteBuffer(device);
        if (typeof ArrayBuffer.prototype.transfer !== "function") {
          throw new Error("ArrayBuffer.prototype.transfer is required to prove detached source rejection");
        }
        // Desktop-focused arm only: the portable shared proof stays transfer-free because Android V8
        // cannot detach a buffer, so the detached-source contract is proved here on Dawn + V8.
        const detachedBuffer = device.createBuffer({size: 16, usage: GPUBufferUsage.COPY_DST});
        try {
          const detached = [
            ["ArrayBuffer", new ArrayBuffer(4)],
            ["Uint8Array", new Uint8Array(4)],
            ["DataView", new DataView(new ArrayBuffer(4))],
          ];
          for (const [, detachedSource] of detached) {
            if (detachedSource.buffer) detachedSource.buffer.transfer();
            else detachedSource.transfer();
          }
          const accepted = [];
          for (const [name, detachedSource] of detached) {
            try {
              device.queue.writeBuffer(detachedBuffer, 0, detachedSource);
              accepted.push(name);
            } catch {}
          }
          if (accepted.length) throw new Error(`detached sources were accepted: ${accepted.join(", ")}`);
          globalThis.__tnDetachedRejected = detached.length;
        } finally {
          detachedBuffer.destroy();
        }
        globalThis.__tnWriteBufferPassed = true;
      } catch (error) {
        globalThis.__tnWriteBufferError = String(error.stack || error);
      } finally {
        globalThis.__tnWriteBufferDone = true;
      }
    })())JS", "tn-write-buffer-proof.js"), "writeBuffer proof started");
    awaitFlag(runtime.get(), engine, "__tnWriteBufferDone");
    expect(engine->toBoolean(engine->getGlobalProperty("__tnWriteBufferPassed")),
           "native writeBuffer proof: " + engine->toString(engine->getGlobalProperty("__tnWriteBufferError")));
    expect(direct ? !state->profiling.frameOpStreamDrain.ptr : !!state->profiling.frameOpStreamDrain.ptr,
           "requested direct/stream transport was installed");
    if (!direct) {
        expect(state->profiling.frameOpStreamReplayCrossings > 0,
               "writeBuffer proof crossed the native frame replay decoder");
        expect(frameReplayBackendEntries == 7,
               "decoder reached all five zero-byte and two nonzero production writeBuffer records: " +
                   std::to_string(frameReplayBackendEntries));
        std::cout << "Decoded writeBuffer records: " << frameReplayBackendEntries
                  << " (five zero-byte, two nonzero); GPU readback checked" << std::endl;
    }
}

int main(int argc, char** argv) {
    if (argc > 1 && (std::string(argv[1]) == "write-buffer-direct" ||
                     std::string(argv[1]) == "write-buffer-stream")) {
        if (argc != 3) {
            std::cerr << "write-buffer-direct|write-buffer-stream requires the shared IIFE proof bundle" << std::endl;
            return 1;
        }
        runWriteBufferContract(std::string(argv[1]) == "write-buffer-direct", argv[2]);
        return failures == 0 ? 0 : 1;
    }
    const bool disableStreamControl =
        argc > 1 && std::string(argv[1]) == "disabled-stream-control";
    runContract(disableStreamControl);
    // Compiled frame plans run after the default contract, and only then: the recorder reads the
    // diagnostic override when the device is created, so a forced-plan runtime would change what the assertions
    // above are looking at.
    if (!disableStreamControl) {
        // The same two frames on both transports, compared as pixels: the clear colour moves between
        // them, so the plan arm has to carry that value in a patch and land on the same image.
        const VisualArm withoutPlans = runVisualArm(false);
        runPlanContract();
        const VisualArm withPlans = runVisualArm(true);
        expect(withoutPlans.ran && withPlans.ran, "both visual arms read pixels back");
        expect(!withoutPlans.first.empty() && withoutPlans.first != "null",
               "the v2 arm read its first frame back");
        expect(withoutPlans.first != withoutPlans.second,
               "the visual comparison moved the pixels it compares");
        expect(withoutPlans.first == withPlans.first,
               "the v2 and plan transports render the same first frame");
        expect(withoutPlans.second == withPlans.second,
               "a patched clear colour renders the pixels the v2 stream renders");
        runPlanLifecycleContract();
        runArrayLayerUploadContract();
    }
    if (failures != 0) {
        if (disableStreamControl) {
            std::cerr << "RED observed: disabled frame stream rejected" << std::endl;
        }
        std::cerr << failures << " frame op stream assertion(s) failed" << std::endl;
        return 1;
    }
    std::cout << "frame op stream replay contract passed" << std::endl;
    return 0;
}
