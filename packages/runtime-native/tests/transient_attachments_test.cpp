// Private lifetime plumbing only: renderer eligibility is a separate, still-open proof.
#include "mystral/runtime.h"
#include "../src/webgpu/bindings_state.h"
#include "../src/webgpu/bindings_presentation.h"
#include "../src/webgpu/bindings_frame_stream.h"

#include <chrono>
#include <cstdlib>
#include <iostream>
#include <sstream>
#include <string>
#include <thread>

int main(int argc, char** argv) {
    const bool off = argc > 1 && std::string(argv[1]) == "--feature-off";
    const bool direct = argc > 1 && std::string(argv[1]) == "--direct";
#if defined(_WIN32)
    _putenv_s("TN_TRANSIENT_ATTACHMENTS", off ? "0" : "1");
#else
    setenv("TN_TRANSIENT_ATTACHMENTS", off ? "0" : "1", 1);
#endif
    mystral::RuntimeConfig config;
    config.width = 4;
    config.height = 4;
    config.noSdl = true;
    auto runtime = mystral::Runtime::create(config);
    if (!runtime || !runtime->getWebGPUBindingsState())
        return 1;
    auto* state = static_cast<mystral::webgpu::BindingsState*>(runtime->getWebGPUBindingsState());
    auto* engine = state->engine;
    state->profiling.disableFrameOpStreamForTesting = direct;
    bool granted = false;
#if defined(MYSTRAL_WEBGPU_DAWN)
    const bool supported = wgpuAdapterHasFeature(state->adapter, WGPUFeatureName_TransientAttachments);
    granted = wgpuDeviceHasFeature(state->device, WGPUFeatureName_TransientAttachments);
    if (granted != (supported && !off)) {
        std::cerr << "FAIL: advertised transient feature must be requested unless explicitly disabled\n";
        return 1;
    }
#endif
    engine->setGlobalProperty("__tnTransientGranted", engine->newBoolean(granted));
    engine->setGlobalProperty(
        "__tnFlush",
        engine->newFunction("flush", [state, engine](void*, const std::vector<mystral::js::JSValueHandle>&) {
            mystral::webgpu::flushRecordedFrameOps(state);
            return engine->newUndefined();
        }));
    if (!engine->evalScript(R"JS(
      globalThis.device = navigator.gpu.requestAdapter().requestDevice();
      globalThis.makeTarget = (extra = {}) => device.createTexture({
        size: [4, 4], format: 'rgba8unorm', usage: 16, sampleCount: 4, ...extra,
      });
      globalThis.local = makeTarget({ _tnPassLocalMSAA: true });
      globalThis.persistent = makeTarget();
      globalThis.single = makeTarget({ sampleCount: 1, _tnPassLocalMSAA: true });
      globalThis.depth = makeTarget({ format: 'depth32float', usage: 20, _tnPassLocalMSAA: true });
      globalThis.resolve = makeTarget({ sampleCount: 1, usage: 17 });
      let rejected = false;
      try { makeTarget({ _tnPassLocalMSAA: 'true' }); }
      catch (error) { rejected = String(error).includes('_tnPassLocalMSAA must be boolean'); }
      if (!rejected) throw Error('malformed private lifetime must throw');
    )JS",
                            "transient-setup.js"))
        return 1;
    unsigned transientCount = 0;
    for (const auto& [id, info] : state->registries.textureRegistry) {
#if defined(MYSTRAL_WEBGPU_DAWN)
        if (wgpuTextureGetUsage(info.texture) & WGPUTextureUsage_TransientAttachment)
            ++transientCount;
#endif
    }
    if (transientCount != (granted ? 1u : 0u)) {
        std::cerr << "FAIL: only explicitly pass-local multisample allocation may become transient\n";
        return 1;
    }
    // Run the same passes through the production packed stream and the direct binding path.
    if (!engine->evalScript(R"JS(
      globalThis.__tnDone = false;
      (async () => {
        const check = (ok, message) => { if (!ok) throw Error(message); };
        const lv = local.createView(), pv = persistent.createView(), rv = resolve.createView();
        const pass = (view, loadOp, storeOp, resolveTarget) => {
          const encoder = device.createCommandEncoder();
          encoder.beginRenderPass({ colorAttachments: [{
            view, loadOp, storeOp, resolveTarget, clearValue: [0.25, 0.5, 0.75, 1],
          }] }).end();
          device.queue.submit([encoder.finish()]);
        };
        const scopedPass = async (load, store, rejected) => {
          device.pushErrorScope('validation');
          pass(lv, load, store, rv);
          __tnFlush();
          await device.queue.onSubmittedWorkDone();
          const error = await device.popErrorScope();
          console.log('TN_TRANSIENT_OPS:' + JSON.stringify({load, store, rejected: !!error}));
          check(!!error === rejected, 'unexpected Dawn transient load/store result: ' + load + '/' + store);
        };
        let readbackIndex = 0;
        const pixels = async () => {
          readbackIndex++;
          const read = device.createBuffer({size: 1024, usage: 9});
          const e = device.createCommandEncoder();
          e.copyTextureToBuffer({texture: resolve, mipLevel: 0}, {buffer: read, offset: 0, bytesPerRow: 256, rowsPerImage: 4}, [4, 4, 1]);
          device.queue.submit([e.finish()]);
          await read.mapAsync(1);
          const data = new Uint8Array(read.getMappedRange());
          for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
            const p = y * 256 + x * 4;
            check(Math.abs(data[p] - 64) <= 1 && Math.abs(data[p+1] - 128) <= 1 &&
              Math.abs(data[p+2] - 191) <= 1 && data[p+3] === 255, 'resolve pixels lost at readback ' + readbackIndex + ' pixel ' + x + ',' + y + ': ' + Array.from(data.subarray(p, p+4)));
          }
          read.unmap(); read.destroy();
        };
        device.pushErrorScope('validation');
        pass(lv, 'clear', 'discard', rv);
        await pixels();
        // Copy between passes and a later-frame load preserve ordinary allocations.
        pass(pv, 'clear', 'store', rv);
        await pixels();
        pass(pv, 'load', 'store', rv);
        await pixels();
        await new Promise(resolve => requestAnimationFrame(resolve));
        pass(pv, 'load', 'store', rv);
        await pixels();
        // Sampled depth must keep its ordinary usage and clear/store/load semantics.
        const dv = depth.createView();
        for (const load of ['clear', 'load']) {
          const e = device.createCommandEncoder();
          e.beginRenderPass({colorAttachments: [], depthStencilAttachment: {
            view: dv, depthClearValue: 0.5, depthLoadOp: load, depthStoreOp: 'store',
          }}).end();
          device.queue.submit([e.finish()]);
        }
        __tnFlush();
        await device.queue.onSubmittedWorkDone();
        check(await device.popErrorScope() === null, 'ordinary or transient clear/discard pass invalid');
        await scopedPass('load', 'discard', __tnTransientGranted);
        await scopedPass('clear', 'store', __tnTransientGranted);
        // A fresh valid pass must still work after captured validation errors.
        await scopedPass('clear', 'discard', false);
        await pixels();
      })().catch(e => { globalThis.__tnError = String(e); }).finally(() => { __tnDone = true; });
    )JS",
                            "transient-passes.js"))
        return 1;
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(15);
    while (std::chrono::steady_clock::now() < deadline) {
        runtime->pollEvents();
        engine->processMicrotasks();
        if (engine->toBoolean(engine->getGlobalProperty("__tnDone")))
            break;
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    const auto error = engine->getGlobalProperty("__tnError");
    if (!engine->isUndefined(error) || !engine->toBoolean(engine->getGlobalProperty("__tnDone"))) {
        std::cerr << "FAIL: transient binding passes: " << engine->toString(error) << '\n';
        return 1;
    }
    std::ostringstream markers;
    auto* saved = std::cout.rdbuf(markers.rdbuf());
    mystral::webgpu::reportPresentTick(state, 1);
    std::cout.rdbuf(saved);
    const std::string expected =
        std::string("TN_TRANSIENT_ATTACHMENTS:{\"granted\":") +
        (granted ? "true,\"count\":1,\"nominalBytes\":256}" : "false,\"count\":0,\"nominalBytes\":0}");
    if (markers.str().find(expected) == std::string::npos) {
        std::cerr << "FAIL: transient marker: expected " << expected << '\n' << markers.str();
        return 1;
    }
    std::cout << markers.str();
    if (!engine->evalScript("local.destroy(); local.destroy(); __tnFlush();", "transient-release.js"))
        return 1;
    markers.str("");
    saved = std::cout.rdbuf(markers.rdbuf());
    mystral::webgpu::reportPresentTick(state, 2);
    std::cout.rdbuf(saved);
    if (markers.str().find("\"count\":0,\"nominalBytes\":0}") == std::string::npos) {
        std::cerr << "FAIL: transient allocation was not unaccounted exactly once\n";
        return 1;
    }
    std::cout << "native transient attachments host contract passed: granted=" << granted << " direct=" << direct
              << '\n';
    return 0;
}
