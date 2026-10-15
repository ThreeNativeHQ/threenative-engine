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
    bool supported = false;
    bool granted = false;
#if defined(MYSTRAL_WEBGPU_DAWN)
    supported = wgpuAdapterHasFeature(state->adapter, WGPUFeatureName_TransientAttachments);
    granted = wgpuDeviceHasFeature(state->device, WGPUFeatureName_TransientAttachments);
    if (granted != (supported && !off)) {
        std::cerr << "FAIL: advertised transient feature must be requested unless explicitly disabled\n";
        return 1;
    }
#endif
    engine->setGlobalProperty("__tnTransientSupported", engine->newBoolean(supported));
    engine->setGlobalProperty("__tnTransientGranted", engine->newBoolean(granted));
    engine->setGlobalProperty(
        "__tnFlush",
        engine->newFunction("flush", [state, engine](void*, const std::vector<mystral::js::JSValueHandle>&) {
            mystral::webgpu::flushRecordedFrameOps(state);
            return engine->newUndefined();
        }));
    if (!engine->evalScript(R"JS(
      globalThis.adapter = navigator.gpu.requestAdapter();
      globalThis.device = adapter.requestDevice();
      const adapterVisible = adapter.features.has('transient-attachments');
      const deviceVisible = device.features.has('transient-attachments');
      if (adapterVisible !== __tnTransientSupported)
        throw Error('adapter transient feature visibility differs from actual support');
      if (deviceVisible !== __tnTransientGranted)
        throw Error('device transient feature visibility differs from actual grant');
      if (adapter.features.has('unknown-feature') || device.features.has('unknown-feature'))
        throw Error('unknown feature must remain absent');
      console.log('TN_TRANSIENT_FEATURES:' + JSON.stringify({adapter: adapterVisible, device: deviceVisible}));
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
        // Resolve averages cannot prove that individual colour/depth samples survived a load.
        const sampleColour = makeTarget({usage: 20});
        const sampleDepth = makeTarget({format: 'depth32float', usage: 20});
        const sampleOutput = device.createTexture({size: [2, 4], format: 'rgba8unorm', usage: 17});
        const cv = sampleColour.createView(), sdv = sampleDepth.createView();
        const vertex = `
          @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
            var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
            return vec4f(p[i], 0, 1);
          }
          struct Output { @location(0) colour: vec4f, @builtin(frag_depth) depth: f32 }
        `;
        const drawPipeline = (fragment, compare) => {
          const module = device.createShaderModule({code: vertex + fragment});
          return device.createRenderPipeline({
            layout: device.createPipelineLayout({bindGroupLayouts: []}),
            vertex: {module, entryPoint: 'vs'},
            fragment: {module, entryPoint: 'fs', targets: [{format: 'rgba8unorm'}]},
            primitive: {topology: 'triangle-list'}, multisample: {count: 4},
            depthStencil: {format: 'depth32float', depthWriteEnabled: true, depthCompare: compare},
          });
        };
        const initial = drawPipeline(`
          @fragment fn fs(@builtin(sample_index) s: u32) -> Output {
            let v = f32(s + 1u) * 0.2;
            return Output(vec4f(v, 0, 1 - v, 1), v);
          }`, 'always');
        const later = drawPipeline(`
          @fragment fn fs() -> Output { return Output(vec4f(1, 0, 0, 1), 0.5); }
        `, 'less');
        const nextFrame = drawPipeline(`
          @fragment fn fs() -> Output { return Output(vec4f(0, 0, 1, 1), 0.3); }
        `, 'less');
        const sampleLayout = device.createBindGroupLayout({entries: [
          {binding: 0, visibility: 2, texture: {sampleType: 'unfilterable-float', viewDimension: '2d', multisampled: true}},
          {binding: 1, visibility: 2, texture: {sampleType: 'depth', viewDimension: '2d', multisampled: true}},
        ]});
        const sampleGroup = device.createBindGroup({layout: sampleLayout, entries: [
          {binding: 0, resource: cv}, {binding: 1, resource: sdv},
        ]});
        const readModule = device.createShaderModule({code: vertex + `
          @group(0) @binding(0) var colour: texture_multisampled_2d<f32>;
          @group(0) @binding(1) var depth: texture_depth_multisampled_2d;
          @fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
            let s = i32(p.y);
            if (p.x < 1) { return textureLoad(colour, vec2i(0, 0), s); }
            let d = textureLoad(depth, vec2i(0, 0), s);
            return vec4f(d, d, d, 1);
          }
        `});
        const readPipeline = device.createRenderPipeline({
          layout: device.createPipelineLayout({bindGroupLayouts: [sampleLayout]}),
          vertex: {module: readModule, entryPoint: 'vs'},
          fragment: {module: readModule, entryPoint: 'fs', targets: [{format: 'rgba8unorm'}]},
          primitive: {topology: 'triangle-list'},
        });
        const drawSamples = (pipeline, loadOp) => {
          const encoder = device.createCommandEncoder();
          const pass = encoder.beginRenderPass({
            colorAttachments: [{view: cv, loadOp, storeOp: 'store', clearValue: [0, 0, 0, 1]}],
            depthStencilAttachment: {view: sdv, depthLoadOp: loadOp, depthStoreOp: 'store', depthClearValue: 1},
          });
          pass.setPipeline(pipeline); pass.draw(3); pass.end();
          device.queue.submit([encoder.finish()]);
        };
        const readSamples = async (stage, colours, depths) => {
          const read = device.createBuffer({size: 1024, usage: 9});
          const encoder = device.createCommandEncoder();
          const pass = encoder.beginRenderPass({colorAttachments: [{
            view: sampleOutput.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 0],
          }]});
          pass.setPipeline(readPipeline); pass.setBindGroup(0, sampleGroup); pass.draw(3); pass.end();
          encoder.copyTextureToBuffer({texture: sampleOutput, mipLevel: 0},
            {buffer: read, offset: 0, bytesPerRow: 256, rowsPerImage: 4}, [2, 4, 1]);
          device.queue.submit([encoder.finish()]);
          await read.mapAsync(1);
          const data = new Uint8Array(read.getMappedRange());
          const samples = [];
          for (let s = 0; s < 4; s++) {
            const colour = Array.from(data.subarray(s * 256, s * 256 + 4));
            const depth = Array.from(data.subarray(s * 256 + 4, s * 256 + 8));
            samples.push({colour, depth: depth[0]});
            check(colour.every((v, c) => Math.abs(v - colours[s][c] * 255) <= 1),
              stage + ' sample ' + s + ' colour lost: ' + colour + ' expected ' + colours[s]);
            check(depth.every((v, c) => Math.abs(v - (c === 3 ? 1 : depths[s]) * 255) <= 1),
              stage + ' sample ' + s + ' depth lost: ' + depth + ' expected ' + depths[s]);
          }
          console.log('TN_PERSISTENT_SAMPLES:' + JSON.stringify({stage, samples}));
          read.unmap(); read.destroy();
        };
        drawSamples(initial, 'clear');
        await readSamples('initial', [[.2,0,.8,1], [.4,0,.6,1], [.6,0,.4,1], [.8,0,.2,1]], [.2,.4,.6,.8]);
        drawSamples(later, 'load');
        await readSamples('later-load', [[.2,0,.8,1], [.4,0,.6,1], [1,0,0,1], [1,0,0,1]], [.2,.4,.5,.5]);
        await new Promise(resolve => requestAnimationFrame(resolve));
        await readSamples('frame-preserved', [[.2,0,.8,1], [.4,0,.6,1], [1,0,0,1], [1,0,0,1]], [.2,.4,.5,.5]);
        drawSamples(nextFrame, 'load');
        await readSamples('next-frame-load', [[.2,0,.8,1], [0,0,1,1], [0,0,1,1], [0,0,1,1]], [.2,.3,.3,.3]);
        sampleColour.destroy(); sampleDepth.destroy(); sampleOutput.destroy();
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
