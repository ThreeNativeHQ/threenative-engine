#include "../src/webgpu/bindings_commands.h"
#include "../src/webgpu/bindings_presentation.h"
#include "../src/webgpu/bindings_resources.h"
#include "../src/webgpu/bindings_pipelines.h"
#include "mystral/webgpu/wrapper_factories.h"
#include "../src/webgpu/surface_format_selection.h"
#include "mystral/webgpu/bindings.h"
#include "../src/webgpu/bindings_state.h"
#include "mystral/webgpu/context.h"
#include "mystral/runtime.h"

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <sstream>
#include <string>
#include <thread>

#if defined(_WIN32)
#include <fcntl.h>
#include <io.h>
#define TN_TEST_DUP _dup
#define TN_TEST_DUP2 _dup2
#define TN_TEST_FILENO _fileno
#define TN_TEST_CLOSE _close
#define TN_TEST_READ _read
#else
#include <unistd.h>
#define TN_TEST_DUP dup
#define TN_TEST_DUP2 dup2
#define TN_TEST_FILENO fileno
#define TN_TEST_CLOSE close
#define TN_TEST_READ read
#endif

namespace {

void writeTestLine(const std::string& line) {
    const size_t written = std::fwrite(line.data(), 1, line.size(), stdout);
    const int flushed = std::fflush(stdout);
    if (written != line.size() || flushed != 0) std::abort();
}

// Descriptor redirection captures both C stdio and synchronized C++ streams.
class StdoutCapture {
public:
    StdoutCapture() : file_(std::tmpfile()) {
        if (!file_ || std::fflush(stdout) != 0) std::abort();
        saved_ = TN_TEST_DUP(TN_TEST_FILENO(stdout));
        if (saved_ < 0 || TN_TEST_DUP2(TN_TEST_FILENO(file_), TN_TEST_FILENO(stdout)) < 0)
            std::abort();
    }
    ~StdoutCapture() { finish(); }
    std::string read() {
        if (std::fflush(stdout) != 0 || std::fseek(file_, position_, SEEK_SET) != 0)
            std::abort();
        std::string text;
        char buffer[4096];
        size_t count;
        while ((count = std::fread(buffer, 1, sizeof(buffer), file_)) != 0)
            text.append(buffer, count);
        if (std::ferror(file_)) std::abort();
        position_ = std::ftell(file_);
        if (position_ < 0 || std::fseek(file_, 0, SEEK_END) != 0) std::abort();
        return text;
    }
    void finish() {
        if (saved_ < 0) return;
        if (std::fflush(stdout) != 0 || TN_TEST_DUP2(saved_, TN_TEST_FILENO(stdout)) < 0 ||
            TN_TEST_CLOSE(saved_) != 0 || std::fclose(file_) != 0) std::abort();
        saved_ = -1;
    }
private:
    FILE* file_;
    int saved_ = -1;
    long position_ = 0;
};

constexpr const char* kScript = R"JS((async () => {
 try {
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("no adapter");

  // Check adapter properties
  const info = adapter.info || {};
  const isFallback = adapter.isFallbackAdapter;
  const adapterFeatures = adapter.features;
  const adapterLimits = adapter.limits;

  for (const f of [
    "depth-clip-control", "depth32float-stencil8", "texture-compression-bc",
    "texture-compression-etc2", "texture-compression-astc", "float32-filterable",
    "timestamp-query", "rg11b10ufloat-renderable", "shader-f16", "bgra8unorm-storage",
    "indirect-first-instance"
  ]) {
    adapter.features.has(f);
  }

  const device = await adapter.requestDevice();
  if (!device) throw new Error("no device");
  globalThis.__device = device;

  for (const f of [
    "depth-clip-control", "depth32float-stencil8", "texture-compression-bc",
    "texture-compression-etc2", "texture-compression-astc", "float32-filterable",
    "timestamp-query", "rg11b10ufloat-renderable", "shader-f16", "bgra8unorm-storage",
    "indirect-first-instance"
  ]) {
    device.features.has(f);
  }
  // float32-filterable is optional. An adapter that offers it must enable it for linear sampling.
  if (adapterFeatures.has("float32-filterable") && !device.features.has("float32-filterable"))
    throw new Error("adapter offers float32-filterable but the device did not enable it");

  // Error scopes
  device.pushErrorScope('validation');
  device.pushErrorScope('out-of-memory');
  device.pushErrorScope('internal');
  const internalErr = await device.popErrorScope();
  const oomErr = await device.popErrorScope();
  const valErr = await device.popErrorScope();

  // Create Buffers (various usages and sizes)
  const vtxBuf = device.createBuffer({
    size: 256,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    label: "vtx"
  });
  globalThis.__vtxBuf = vtxBuf;
  const idxBuf = device.createBuffer({
    size: 256,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    label: "idx"
  });
  globalThis.__idxBuf = idxBuf;
  const uboBuf = device.createBuffer({
    size: 1024,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    label: "ubo"
  });
  globalThis.__uboBuf = uboBuf;
  const storageBuf = device.createBuffer({
    size: 1024,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST | 0x0200,
    label: "storage"
  });
  globalThis.__storageBuf = storageBuf;
  const indirectBuf = device.createBuffer({
    size: 256,
    usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST,
    label: "indirect"
  });
  globalThis.__indirectBuf = indirectBuf;
  const mapWriteBuf = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.MAP_WRITE | GPUBufferUsage.COPY_SRC,
    mappedAtCreation: true,
    label: "mapWrite"
  });
  const mappedRange = mapWriteBuf.getMappedRange();
  new Uint8Array(mappedRange).fill(42);
  mapWriteBuf.unmap();

  const mapReadBuf = device.createBuffer({
    size: 64,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    label: "mapRead"
  });

  // Queue writeBuffer
  const writeData = new Float32Array([1.0, 2.0, 3.0, 4.0]);
  device.queue.writeBuffer(uboBuf, 0, writeData.buffer, 0, writeData.byteLength);
  device.queue.writeBuffer(vtxBuf, 0, new Float32Array([0,0,0, 1,0,0, 0,1,0]));
  device.queue.writeBuffer(idxBuf, 0, new Uint16Array([0, 1, 2, 0]));
  device.queue.writeBuffer(indirectBuf, 0, new Uint32Array([1, 1, 1, 0, 3, 1, 0, 0]));
  // Write with offset and size
  device.queue.writeBuffer(uboBuf, 16, writeData, 1, 2);

  // Create Textures (1D, 2D, 3D, formats, usages)
  const tex2D = device.createTexture({
    size: [16, 16, 1],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
    mipLevelCount: 2,
    sampleCount: 1,
    label: "tex2D"
  });
  const texView2D = tex2D.createView({
    format: "rgba8unorm",
    dimension: "2d",
    aspect: "all",
    baseMipLevel: 0,
    mipLevelCount: 1,
    baseArrayLayer: 0,
    arrayLayerCount: 1
  });

  const colorTex = device.createTexture({
    size: [16, 16, 1],
    format: "rgba8unorm",
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    label: "colorTex"
  });
  const colorView = colorTex.createView();
  globalThis.__colorView = colorView;
  globalThis.__tex2D = tex2D;

  const depthTex = device.createTexture({
    size: [16, 16, 1],
    format: "depth24plus",
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
    label: "depthTex"
  });
  const depthView = depthTex.createView();
  globalThis.__depthView = depthView;

  const tex3D = device.createTexture({
    size: [8, 8, 8],
    dimension: "3d",
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    label: "tex3D"
  });
  const texView3D = tex3D.createView({ dimension: "3d" });

  // device.createTextureView non-standard binding
  if (device.createTextureView) {
    device.createTextureView(tex2D, { dimension: "2d", aspect: "all" });
    device.createTextureView(depthTex, { aspect: "depth-only" });
  }

  // Queue writeTexture
  const texPixels = new Uint8Array(16 * 16 * 4).fill(255);
  device.queue.writeTexture(
    { texture: tex2D },
    texPixels,
    { bytesPerRow: 64, rowsPerImage: 16 },
    [16, 16, 1]
  );

  // Create Samplers
  const sampler = device.createSampler({
    magFilter: "linear",
    minFilter: "linear",
    mipmapFilter: "linear",
    addressModeU: "repeat",
    addressModeV: "clamp-to-edge",
    addressModeW: "mirror-repeat",
    lodMinClamp: 0,
    lodMaxClamp: 4,
    maxAnisotropy: 2
  });

  const cmpSampler = device.createSampler({
    compare: "less"
  });

  // Shader Modules
  const wgslRender = `
    struct Uniforms { scale: vec4f };
    @group(0) @binding(0) var<uniform> u: Uniforms;
    @group(0) @binding(1) var s: sampler;
    @group(0) @binding(2) var t: texture_2d<f32>;

    struct VertexInput {
      @location(0) pos: vec3f,
    };
    struct VertexOutput {
      @builtin(position) pos: vec4f,
      @location(0) uv: vec2f,
    };

    @vertex
    fn vs_main(in: VertexInput) -> VertexOutput {
      var out: VertexOutput;
      out.pos = vec4f(in.pos * u.scale.xyz, 1.0);
      out.uv = in.pos.xy;
      return out;
    }

    @fragment
    fn fs_main(in: VertexOutput) -> @location(0) vec4f {
      return textureSample(t, s, in.uv);
    }
  `;
  const renderModule = device.createShaderModule({ code: wgslRender, label: "renderModule" });
  if (renderModule.getCompilationInfo) {
    await renderModule.getCompilationInfo();
  }

  const wgslCompute = `
    @group(0) @binding(0) var<storage, read_write> data: array<u32>;
    @compute @workgroup_size(1)
    fn cs_main(@builtin(global_invocation_id) id: vec3u) {
      data[id.x] = data[id.x] + 1u;
    }
  `;
  const computeModule = device.createShaderModule({ code: wgslCompute, label: "computeModule" });

  // Bind Group Layout & Bind Group
  const bgl = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float", viewDimension: "2d" } },
    ]
  });

  const bindGroup = device.createBindGroup({
    layout: bgl,
    entries: [
      { binding: 0, resource: { buffer: uboBuf, offset: 0, size: 256 } },
      { binding: 1, resource: sampler },
      { binding: 2, resource: texView2D },
    ]
  });
  globalThis.__bindGroup = bindGroup;

  const computeBgl = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } }
    ]
  });

  // Storage texture layout entries
  device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "write-only", format: "r32float", viewDimension: "2d" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "read-only", format: "rgba8unorm", viewDimension: "2d" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, storageTexture: { access: "read-write", format: "r32float", viewDimension: "3d" } }
    ]
  });

  // Pipeline & bind group validation failure cases
  try { device.createBindGroup({ layout: bgl, entries: [] }); } catch (e) {}
  try { device.createBindGroup(); } catch (e) {}
  try { device.createBindGroupLayout(); } catch (e) {}
  try { device.createPipelineLayout(); } catch (e) {}
  try { device.createRenderPipeline(); } catch (e) {}
  try { device.createComputePipeline(); } catch (e) {}
  try { device.createShaderModule(); } catch (e) {}

  const computeBindGroup = device.createBindGroup({
    layout: computeBgl,
    entries: [
      { binding: 0, resource: { buffer: storageBuf } }
    ]
  });
  globalThis.__computeBindGroup = computeBindGroup;

  // Pipeline Layout
  const pipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [bgl]
  });
  const computePipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [computeBgl]
  });

  // Render Pipeline Descriptor
  const renderPipelineDesc = {
    layout: pipelineLayout,
    vertex: {
      module: renderModule,
      entryPoint: "vs_main",
      buffers: [
        {
          arrayStride: 12,
          stepMode: "vertex",
          attributes: [{ format: "float32x3", offset: 0, shaderLocation: 0 }]
        }
      ]
    },
    fragment: {
      module: renderModule,
      entryPoint: "fs_main",
      targets: [
        {
          format: "rgba8unorm",
          writeMask: 0xf,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "one", dstFactor: "zero", operation: "add" }
          }
        }
      ]
    },
    primitive: {
      topology: "triangle-list",
      stripIndexFormat: undefined,
      frontFace: "ccw",
      cullMode: "back"
    },
    depthStencil: {
      format: "depth24plus",
      depthWriteEnabled: true,
      depthCompare: "less-equal",
    },
    multisample: {
      count: 1,
      mask: 0xffffffff,
      alphaToCoverageEnabled: false
    }
  };

  const renderPipeline = device.createRenderPipeline(renderPipelineDesc);
  globalThis.__renderPipeline = renderPipeline;
  const asyncRenderPipeline = await device.createRenderPipelineAsync(renderPipelineDesc);

  // Additional vertex formats pipeline test
  const allFormats = [
    "float32x2", "float32x4", "uint8x2", "uint8x4", "sint8x2", "sint8x4",
    "unorm8x2", "unorm8x4", "snorm8x2", "snorm8x4", "uint16x2", "uint16x4",
    "sint16x2", "sint16x4", "unorm16x2", "unorm16x4", "snorm16x2", "snorm16x4",
    "float16x2", "float16x4", "uint32", "uint32x2", "uint32x3", "uint32x4",
    "sint32", "sint32x2", "sint32x3", "sint32x4"
  ];
  const attrs = allFormats.map((fmt, i) => ({ format: fmt, offset: 0, shaderLocation: i + 1 }));
  try {
    const multiBufDesc = {
      layout: "auto",
      vertex: {
        module: device.createShaderModule({ code: "@vertex fn vs() -> @builtin(position) vec4f { return vec4f(0); }" }),
        entryPoint: "vs",
        buffers: [{ arrayStride: 128, attributes: attrs }]
      },
      fragment: {
        module: device.createShaderModule({ code: "@fragment fn fs() -> @location(0) vec4f { return vec4f(1); }" }),
        entryPoint: "fs",
        targets: [{ format: "rgba8unorm" }]
      }
    };
    device.createRenderPipeline(multiBufDesc);
  } catch (e) {}

  // Compute Pipeline
  const computePipelineDesc = {
    layout: computePipelineLayout,
    compute: { module: computeModule, entryPoint: "cs_main" }
  };
  const computePipeline = device.createComputePipeline(computePipelineDesc);
  globalThis.__computePipeline = computePipeline;
  const asyncComputePipeline = await device.createComputePipelineAsync(computePipelineDesc);

  // Query Set
  const occlusionQuerySet = device.createQuerySet({ type: "occlusion", count: 4 });
  globalThis.__occlusionQuerySet = occlusionQuerySet;
  const tsQuerySet = device.features.has("timestamp-query")
    ? device.createQuerySet({ type: "timestamp", count: 4 })
    : null;
  globalThis.__tsQuerySet = tsQuerySet;

  // Command Encoder
  const encoder = device.createCommandEncoder({ label: "mainEncoder" });

  // Clear & copies
  encoder.clearBuffer(vtxBuf, 0, 64);
  encoder.copyBufferToBuffer(mapWriteBuf, 0, mapReadBuf, 0, 64);
  encoder.copyBufferToTexture(
    { buffer: uboBuf, bytesPerRow: 256, rowsPerImage: 16 },
    { texture: tex2D, mipLevel: 0 },
    [4, 4, 1]
  );
  encoder.copyTextureToBuffer(
    { texture: tex2D, mipLevel: 0 },
    { buffer: storageBuf, bytesPerRow: 256, rowsPerImage: 16 },
    [4, 4, 1]
  );
  encoder.copyTextureToTexture(
    { texture: tex2D, mipLevel: 0 },
    { texture: tex2D, mipLevel: 1 },
    [4, 4, 1]
  );

  // Compute Pass
  const computePass = encoder.beginComputePass({ label: "computePass" });
  computePass.setPipeline(computePipeline);
  computePass.setBindGroup(0, computeBindGroup);
  computePass.dispatchWorkgroups(1, 1, 1);
  computePass.end();

  // Render Bundle Encoder
  const bundleEncoder = device.createRenderBundleEncoder({
    colorFormats: ["rgba8unorm"],
    depthStencilFormat: "depth24plus"
  });
  bundleEncoder.setPipeline(renderPipeline);
  bundleEncoder.setBindGroup(0, bindGroup);
  bundleEncoder.setVertexBuffer(0, vtxBuf);
  bundleEncoder.setIndexBuffer(idxBuf, "uint16");
  bundleEncoder.draw(3, 1, 0, 0);
  bundleEncoder.drawIndexed(3, 1, 0, 0, 0);
  const renderBundle = bundleEncoder.finish();
  globalThis.__renderBundle = renderBundle;

  // Render Pass
  const renderPass = encoder.beginRenderPass({
    colorAttachments: [
      {
        view: colorView,
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0.1, g: 0.2, b: 0.3, a: 1.0 }
      }
    ],
    depthStencilAttachment: {
      view: depthView,
      depthClearValue: 1.0,
      depthLoadOp: "clear",
      depthStoreOp: "store",
    },
    occlusionQuerySet
  });

  renderPass.setPipeline(renderPipeline);
  renderPass.setBindGroup(0, bindGroup);
  renderPass.setVertexBuffer(0, vtxBuf, 0, 256);
  renderPass.setIndexBuffer(idxBuf, "uint16", 0, 256);
  renderPass.setViewport(0, 0, 16, 16, 0.0, 1.0);
  renderPass.setScissorRect(0, 0, 16, 16);
  renderPass.setBlendConstant([0.5, 0.5, 0.5, 1.0]);
  renderPass.setBlendConstant({ r: 0.5, g: 0.5, b: 0.5, a: 1.0 });
  renderPass.setStencilReference(1);

  renderPass.draw(3, 1, 0, 0);

  renderPass.drawIndexed(3, 1, 0, 0, 0);

  renderPass.drawIndirect(indirectBuf, 16);
  renderPass.drawIndexedIndirect(indirectBuf, 16);

  renderPass.executeBundles([renderBundle]);
  renderPass.end();

  const tempQSet = device.createQuerySet({ type: "occlusion", count: 2 });
  encoder.resolveQuerySet(tempQSet, 0, 1, storageBuf, 0);

  // Timestamp writes if available
  if (tsQuerySet) {
    const tsEnc = device.createCommandEncoder({ label: "tsEnc" });
    const tsPass = tsEnc.beginRenderPass({
      colorAttachments: [{ view: colorView, loadOp: "clear", storeOp: "store" }],
      timestampWrites: { querySet: tsQuerySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 }
    });
    tsPass.end();
    const tsCompPass = tsEnc.beginComputePass({
      timestampWrites: { querySet: tsQuerySet, beginningOfPassWriteIndex: 2, endOfPassWriteIndex: 3 }
    });
    tsCompPass.end();
    tsEnc.resolveQuerySet(tsQuerySet, 0, 4, storageBuf, 0);
    device.queue.submit([tsEnc.finish()]);
  }

  const cmdBuf = encoder.finish();
  device.queue.submit([cmdBuf]);
  await device.queue.onSubmittedWorkDone();

  // copyExternalImageToTexture
  try {
    const cvs = document.createElement("canvas");
    cvs.width = 16;
    cvs.height = 16;
    const cvsCtx = cvs.getContext("2d");
    cvsCtx.fillRect(0, 0, 16, 16);
    device.queue.copyExternalImageToTexture(
      { source: cvs, flipY: true, premultipliedAlpha: true },
      { texture: tex2D, origin: [0, 0, 0], mipLevel: 0 },
      [16, 16, 1]
    );
  } catch (e) {}

  // mapAsync read test
  try {
    await mapReadBuf.mapAsync(1, 0, 64);
    const r = mapReadBuf.getMappedRange(0, 64);
    mapReadBuf.unmap();
  } catch (e) {}

  // Canvas HTML element methods
  try {
    if (navigator.gpu.getPreferredCanvasFormat) {
      navigator.gpu.getPreferredCanvasFormat();
    }
    document.querySelector("canvas");
    const cvsEl = document.createElement("canvas");
    cvsEl.getBoundingClientRect();
    cvsEl.toDataURL("image/png");
    cvsEl.toDataURL("image/webp");
    cvsEl.toDataURL("image/jpeg");
    if (cvsEl.requestPointerLock) cvsEl.requestPointerLock();
    const dummyL = () => {};
    cvsEl.addEventListener("click", dummyL);
    cvsEl.dispatchEvent(new Event("click"));
    cvsEl.removeEventListener("click", dummyL);
    if (cvsEl.parentElement) {
      cvsEl.parentElement.appendChild(cvsEl);
      cvsEl.parentElement.removeChild(cvsEl);
    }
    const div = document.createElement("div");
    div.appendChild(div);
    div.removeChild(div);
    div.remove();
    div.addEventListener("click", dummyL);
    div.removeEventListener("click", dummyL);
    if (document.body) {
      document.body.appendChild(div);
      document.body.removeChild(div);
      document.body.appendChild(cvsEl);
      document.body.removeChild(cvsEl);
    }
  } catch (e) {}

  // Canvas WebGPU context configuration
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("webgpu");
  if (ctx) {
    ctx.configure({
      device,
      format: "bgra8unorm",
      alphaMode: "opaque"
    });
    if (ctx.unconfigure) ctx.unconfigure();
  }

  // Native WebGPU helpers
  try {
    if (globalThis.__nativeGetContext2D) {
      globalThis.__nativeGetContext2D(0, 64, 64);
    }
    if (globalThis.createOffscreenCanvas2D) {
      globalThis.createOffscreenCanvas2D(64, 64);
    }
    if (globalThis.__decodeImageDataAsync) {
      const png1x1 = new Uint8Array([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
        0x0a, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
        0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
      ]);
      globalThis.__decodeImageDataAsync(png1x1.buffer, () => {});
      globalThis.__decodeImageDataAsync(new ArrayBuffer(10), () => {});
    }
    if (typeof createImageBitmap !== "undefined") {
      try {
        await createImageBitmap(new ArrayBuffer(10));
      } catch (e) {}
    }
  } catch (e) {}

  // Resource accounting and descriptor edge cases. These formats exercise the native byte-size
  // table used by the telemetry contract, while every unsupported optional format remains an
  // honest validation error on adapters that do not advertise it.
  for (const format of [
    "r8unorm", "rg8unorm", "r16float", "rg16float", "r32float", "rg32float",
    "rgba16float", "rgba32float", "depth16unorm", "depth24plus", "depth32float",
    "rgb10a2unorm", "rg11b10ufloat", "bc1-rgba-unorm", "etc2-rgba8unorm"
  ]) {
    try {
      const tracked = device.createTexture({
        size: [8, 8, 2],
        format,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
        mipLevelCount: 3,
        sampleCount: 1
      });
      tracked.createView();
      tracked.destroy();
    } catch (e) {}
  }

  // Call the installed native surfaces with missing and malformed arguments. The JS API must
  // reject these synchronously or return a failed promise; silently treating an absent descriptor
  // as a default would make a later GPU error point at the wrong call site.
  const ignore = (fn) => { try { fn(); } catch (e) {} };
  ignore(() => adapter.requestDevice({ requiredFeatures: ["feature-that-does-not-exist"] }).catch(() => {}));
  ignore(() => device.pushErrorScope());
  ignore(() => device.pushErrorScope("not-a-real-error-filter"));
  ignore(() => device.popErrorScope());
  ignore(() => device.queue.submit());
  ignore(() => device.queue.writeBuffer());
  ignore(() => device.queue.writeTexture());
  ignore(() => device.queue.copyExternalImageToTexture());
  ignore(() => device.queue.onSubmittedWorkDone().catch(() => {}));
  ignore(() => device.createBuffer({ size: 0, usage: 0 }));
  ignore(() => device.createTexture({ size: [0, 0, 0], format: "rgba8unorm", usage: 0 }));
  ignore(() => device.createSampler({ maxAnisotropy: 0 }));
  ignore(() => device.createBindGroupLayout({ entries: [{ binding: 0 }] }));
  ignore(() => device.createBindGroup({ layout: null, entries: [] }));
  ignore(() => device.createPipelineLayout({ bindGroupLayouts: [null] }));
  ignore(() => device.createRenderBundleEncoder({ colorFormats: ["not-a-format"] }));
  ignore(() => device.createShaderModule({ code: "not valid wgsl" }));
  ignore(() => globalThis.__vtxBuf.getMappedRange());
  ignore(() => globalThis.__vtxBuf.mapAsync(1, 0, 4).catch(() => {}));
  ignore(() => globalThis.__vtxBuf.mapAsync(1, 0, 4).catch(() => {}));
  ignore(() => globalThis.__vtxBuf.unmap());
  ignore(() => globalThis.__tex2D.createView({ dimension: "not-a-dimension" }));
  ignore(() => globalThis.__renderPipeline.getBindGroupLayout(99));
  ignore(() => globalThis.__computePipeline.getBindGroupLayout(99));

  // Destroy device
  try {
    try { device.createQuerySet(); } catch (e) {}
    try { device.createQuerySet({ type: "unknown", count: 1 }); } catch (e) {}
    try { device.createQuerySet({ type: "occlusion", count: -1 }); } catch (e) {}
    try { device.createQuerySet({ type: "occlusion", count: 5000 }); } catch (e) {}
    device.destroy();
  } catch (e) {}

  globalThis.__tnWebgpuDone = true;
 } catch (err) {
   globalThis.__tnWebgpuError = String(err?.stack || err);
   console.error("WEBGPU_TEST_ERROR:", err, err?.stack);
 }
})();
)JS";

constexpr const char* kDirectScript = R"JS((() => {
  try {
    const enc = globalThis.__nativeEncoder;
    if (!enc) throw new Error('native encoder is missing');
    enc.clearBuffer(globalThis.__vtxBuf, 0, 64);
    enc.copyBufferToBuffer(globalThis.__storageBuf, 0, globalThis.__vtxBuf, 0, 64);
    enc.copyBufferToTexture(
      { buffer: globalThis.__uboBuf, offset: 0, bytesPerRow: 256, rowsPerImage: 16 },
      { texture: globalThis.__tex2D, mipLevel: 0 },
      [4, 1, 1]
    );
    enc.copyTextureToBuffer(
      { texture: globalThis.__tex2D, mipLevel: 0, origin: { x: 0, y: 0, z: 0 } },
      { buffer: globalThis.__storageBuf, offset: 0, bytesPerRow: 256, rowsPerImage: 16 },
      { width: 4, height: 1, depthOrArrayLayers: 1 }
    );
    enc.copyTextureToTexture(
      { texture: globalThis.__tex2D, mipLevel: 0, origin: [0, 0, 0] },
      { texture: globalThis.__tex2D, mipLevel: 1, origin: [0, 0, 0] },
      { width: 4, height: 1, depthOrArrayLayers: 1 }
    );

    // Encoder error cases
    try { enc.clearBuffer(); } catch(e) {}
    try { enc.copyBufferToBuffer(); } catch(e) {}
    try { enc.copyBufferToTexture(); } catch(e) {}
    try { enc.copyTextureToBuffer(); } catch(e) {}
    try { enc.copyTextureToTexture(); } catch(e) {}
    try { enc.beginRenderPass(); } catch(e) {}
    try { enc.beginComputePass(); } catch(e) {}
    try { enc.resolveQuerySet(); } catch(e) {}

    const cpDesc = globalThis.__tsQuerySet
      ? { timestampWrites: { querySet: globalThis.__tsQuerySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } }
      : {};
    const cp = enc.beginComputePass(cpDesc);
    cp.setPipeline(globalThis.__computePipeline);
    cp.setBindGroup(0, globalThis.__computeBindGroup);
    cp.dispatchWorkgroups(1, 1, 1);
    cp.end();

    if (globalThis.__tsQuerySet) {
      try {
        enc.resolveQuerySet(globalThis.__tsQuerySet, 0, 2, globalThis.__storageBuf, 0);
      } catch(e) {}
    }

    const rp = enc.beginRenderPass({
      colorAttachments: [{
        view: globalThis.__colorView,
        loadOp: "clear",
        storeOp: "store",
        clearValue: [0.1, 0.2, 0.3, 1.0]
      }],
      depthStencilAttachment: {
        view: globalThis.__depthView,
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store"
      }
    });
    rp.setPipeline(globalThis.__renderPipeline);
    rp.setBindGroup(0, globalThis.__bindGroup);
    rp.setVertexBuffer(0, globalThis.__vtxBuf);
    rp.setIndexBuffer(globalThis.__idxBuf, "uint16");
    rp.setViewport(0, 0, 16, 16, 0.0, 1.0);
    rp.setScissorRect(0, 0, 16, 16);
    rp.setBlendConstant([0.5, 0.5, 0.5, 1.0]);
    rp.setStencilReference(1);
    rp.draw(3, 1, 0, 0);
    rp.drawIndexed(3, 1, 0, 0, 0);
    rp.drawIndirect(globalThis.__indirectBuf, 0);
    rp.drawIndexedIndirect(globalThis.__indirectBuf, 0);
    rp.executeBundles([globalThis.__renderBundle]);
    rp.end();

    // Additional render pass to exercise alternate branches
    const rp2 = enc.beginRenderPass({
      colorAttachments: [{
        view: globalThis.__colorView,
        loadOp: "load",
        storeOp: "store"
      }],
      depthStencilAttachment: {
        view: globalThis.__depthView,
        depthReadOnly: true,
        stencilReadOnly: true,
        depthLoadOp: "load",
        depthStoreOp: "store"
      },
      occlusionQuerySet: globalThis.__occlusionQuerySet,
      maxDrawCount: 16
    });
    rp2.setPipeline(globalThis.__renderPipeline);
    rp2.end();

    enc.finish();
    globalThis.__tnDirectEncoderDone = true;
  } catch (err) {
    console.error("DIRECT_ENCODER_ERROR:", err, err?.stack);
    throw err;
  }
})())JS";

constexpr const char* kDirectQueueScript = R"JS((async () => {
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();
  const buffer = device.createBuffer({
    size: 256,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | GPUBufferUsage.MAP_READ,
  });
  const texture = device.createTexture({
    size: [4, 4, 1],
    format: "rgba8unorm",
    usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
  });
  const bytes = new Uint8Array(4 * 4 * 4).fill(200);
  device.queue.writeBuffer(buffer, 0, new Uint32Array([1, 2, 3, 4]));
  device.queue.writeBuffer(buffer, 16, new Uint8Array([5, 6, 7]));
  device.queue.writeTexture(
    { texture, origin: [0, 0, 0] }, bytes,
    { bytesPerRow: 16, rowsPerImage: 4 }, [4, 4, 1],
  );
  const image = { width: 4, height: 4, _data: bytes.buffer };
  device.queue.copyExternalImageToTexture(
    { source: image, origin: [0, 0], flipY: true },
    { texture, mipLevel: 0, origin: [0, 0, 0] }, [4, 4, 1],
  );
  try { device.queue.writeBuffer(); } catch (error) {}
  try { device.queue.writeBuffer(buffer, 3, new Uint32Array([1])); } catch (error) {}
  try { device.queue.writeTexture(); } catch (error) {}
  try { device.queue.copyExternalImageToTexture(); } catch (error) {}
  const encoder = device.createCommandEncoder();
  encoder.clearBuffer(buffer, 0, 16);
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
  globalThis.__tnDirectQueueDone = true;
})())JS";

// One more synchronous compile, so the checkpoint contract is proved against event lines that
// arrive between two checkpoints rather than against a stream nothing is adding to.
constexpr const char* kCheckpointCompileScript = R"JS(
  const module = __device.createShaderModule({
    code: "@compute @workgroup_size(1) fn main() {}",
    label: "checkpointModule",
  });
  const layout = __device.createPipelineLayout({ bindGroupLayouts: [] });
  globalThis.__tnCheckpointPipeline = __device.createComputePipeline({
    layout,
    compute: { module, entryPoint: "main" },
  });
)JS";

/** Reads one flat unsigned field out of a marker payload; these markers write no nested numbers. */
bool readMarkerField(const std::string& line, const char* key, uint64_t& value) {
    const std::string needle = std::string("\"") + key + "\":";
    const size_t at = line.find(needle);
    if (at == std::string::npos) return false;
    value = std::strtoull(line.c_str() + at + needle.size(), nullptr, 10);
    return true;
}

size_t countMarkers(const std::string& text, const std::string& marker) {
    size_t count = 0;
    for (size_t at = text.find(marker); at != std::string::npos; at = text.find(marker, at + 1))
        count += 1;
    return count;
}

struct PipelineCheckpoint {
    uint64_t present = 0;
    uint64_t requested = 0;
    uint64_t emitted = 0;
    uint64_t outstanding = 0;
};

bool parseCheckpoint(const std::string& text, PipelineCheckpoint& checkpoint) {
    const size_t at = text.find("TN_PIPELINE_CHECKPOINT:");
    if (at == std::string::npos) return false;
    const std::string line = text.substr(at, text.find('\n', at) - at);
    return readMarkerField(line, "present", checkpoint.present) &&
           readMarkerField(line, "requested", checkpoint.requested) &&
           readMarkerField(line, "emitted", checkpoint.emitted) &&
           readMarkerField(line, "outstanding", checkpoint.outstanding);
}

/**
 * The live capture boundary, proved on a real device without ending the process.
 *
 * The Android runner ends a run with `am force-stop`, so the finalizer's `TN_PIPELINE_COMPLETE`
 * never prints; a checkpoint is only worth reading in its place if its counts are kept apart, if
 * its line lands after every event line it claims, and if a frame that compiled nothing stays
 * silent. Nothing below kills the compile pool, and the runtime is left running afterwards.
 */
bool checkLivePipelineCheckpoint(mystral::Runtime& runtime, mystral::webgpu::BindingsState* state) {
    StdoutCapture captured;
    // Read beside the checkpoint, never after the compile below: this run keeps handing out
    // request ids, and comparing a snapshot against a later reading measures the gap, not the count.
    const uint64_t requestedAtFirst = state->asyncPipelines.nextRequestId - 1;
    mystral::webgpu::reportPipelineCheckpoint(state, 1);
    const std::string firstText = captured.read();
    // A second present that changed nothing: a checkpoint per frame would bury the log it rides in.
    mystral::webgpu::reportPipelineCheckpoint(state, 2);
    const std::string unchangedText = captured.read();
    const bool compiled = runtime.evalScript(kCheckpointCompileScript, "checkpoint_compile.js");
    mystral::webgpu::reportPipelineCheckpoint(state, 3);
    const std::string secondText = captured.read();
    captured.finish();
    writeTestLine(firstText + unchangedText + secondText);

    PipelineCheckpoint first;
    PipelineCheckpoint second;
    if (!parseCheckpoint(firstText, first)) {
        std::cerr << "no live pipeline checkpoint after a present: " << firstText << '\n';
        return false;
    }
    if (first.present != 1 || first.emitted == 0) {
        std::cerr << "live checkpoint reported present=" << first.present
                  << " emitted=" << first.emitted << ", expected the presenting frame and the "
                  << "events this run already wrote\n";
        return false;
    }
    // The three counts are maintained separately; a checkpoint is only evidence while they add up.
    if (first.requested != first.emitted + first.outstanding ||
        first.requested != requestedAtFirst) {
        std::cerr << "live checkpoint counts disagree: requested=" << first.requested
                  << " emitted=" << first.emitted << " outstanding=" << first.outstanding
                  << " requestedAtFirst=" << requestedAtFirst << '\n';
        return false;
    }
    if (!unchangedText.empty()) {
        std::cerr << "a present that compiled nothing printed a checkpoint: " << unchangedText << '\n';
        return false;
    }
    if (!compiled) {
        std::cerr << "checkpoint compile script did not run\n";
        return false;
    }
    if (!parseCheckpoint(secondText, second)) {
        std::cerr << "no checkpoint after a present that compiled: " << secondText << '\n';
        return false;
    }
    const size_t events = countMarkers(secondText, "TN_PIPELINE_EVENT:");
    if (events == 0 || second.emitted != first.emitted + events) {
        std::cerr << "checkpoint emitted " << second.emitted << " against " << first.emitted
                  << " plus " << events << " event line(s) written since\n";
        return false;
    }
    if (second.requested != second.emitted + second.outstanding) {
        std::cerr << "second live checkpoint counts disagree: requested=" << second.requested
                  << " emitted=" << second.emitted << " outstanding=" << second.outstanding << '\n';
        return false;
    }
    // Every line the checkpoint counts must already be on the stream, or a reader that trusts the
    // count reads a capture that is still being written.
    if (secondText.rfind("TN_PIPELINE_EVENT:") > secondText.find("TN_PIPELINE_CHECKPOINT:")) {
        std::cerr << "a checkpoint preceded an event line it counts: " << secondText << '\n';
        return false;
    }
    if (countMarkers(secondText, "TN_PIPELINE_COMPLETE:") != 0) {
        std::cerr << "a live checkpoint printed a completion marker: " << secondText << '\n';
        return false;
    }
    return true;
}

bool checkPipelineOutputContention(mystral::Runtime& runtime,
                                   mystral::webgpu::BindingsState* state) {
    int descriptors[2];
#if defined(_WIN32)
    if (_pipe(descriptors, 4096, _O_BINARY) != 0) std::abort();
#else
    if (pipe(descriptors) != 0) std::abort();
#endif
    if (std::fflush(stdout) != 0) std::abort();
    const int saved = TN_TEST_DUP(TN_TEST_FILENO(stdout));
    if (saved < 0 || TN_TEST_DUP2(descriptors[1], TN_TEST_FILENO(stdout)) < 0 ||
        TN_TEST_CLOSE(descriptors[1]) != 0) std::abort();
    std::string captured;
    std::thread reader([&] {
        char buffer[1024];
        for (;;) {
            const auto count = TN_TEST_READ(descriptors[0], buffer, sizeof(buffer));
            if (count < 0) std::abort();
            if (count == 0) break;
            captured.append(buffer, static_cast<size_t>(count));
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        if (TN_TEST_CLOSE(descriptors[0]) != 0) std::abort();
    });
    std::atomic<bool> started{false};
    std::atomic<bool> done{false};
    std::thread competingWriter([&] {
        do {
            writeTestLine("TN_UI_SNAPSHOT:{\"visible\":true,\"text\":\"pipeline contention\"}\n");
            started.store(true);
            std::this_thread::sleep_for(std::chrono::microseconds(100));
        } while (!done.load());
    });
    while (!started.load()) std::this_thread::yield();
    const uint64_t before = state->asyncPipelines.emitted;
    const bool compiled = runtime.evalScript(R"JS((() => {
        __device.createRenderPipeline({
            label: "stdio-contention-" + "L".repeat(96 * 1024),
            layout: __device.createPipelineLayout({ bindGroupLayouts: [] }),
            vertex: {
                module: __device.createShaderModule({
                    code: "@vertex fn vs() -> @builtin(position) vec4f { return vec4f(0, 0, 0, 1); }",
                }),
                entryPoint: "vs",
            },
            fragment: {
                module: __device.createShaderModule({
                    code: "@fragment fn fs() -> @location(0) vec4f { return vec4f(1); }",
                }),
                entryPoint: "fs",
                targets: [{ format: "rgba8unorm" }],
            },
        });
        console.log("stdio-console-" + "C".repeat(96 * 1024));
    })())JS", "stdio_contention.js");
    mystral::webgpu::reportPipelineCheckpoint(state, 4);
    done.store(true);
    competingWriter.join();
    if (std::fflush(stdout) != 0 || TN_TEST_DUP2(saved, TN_TEST_FILENO(stdout)) < 0 ||
        TN_TEST_CLOSE(saved) != 0) std::abort();
    reader.join();
    // Replay the actual producer bytes for the unchanged external strict parser.
    writeTestLine(captured);
    std::istringstream records(captured);
    std::string record;
    while (std::getline(records, record)) {
        const bool critical = record.find("TN_PIPELINE_") != std::string::npos ||
            record.find("[log] stdio-console-") != std::string::npos;
        if (critical && record.find("TN_UI_SNAPSHOT:") != std::string::npos) {
            std::cerr << "UI snapshot spliced into a pipeline/console producer record\n";
            return false;
        }
    }
    if (!compiled || state->asyncPipelines.emitted != before + 1 ||
        captured.find("stdio-contention-" + std::string(96 * 1024, 'L')) == std::string::npos ||
        captured.find("stdio-console-" + std::string(96 * 1024, 'C')) == std::string::npos) {
        std::cerr << "pipeline/console contention lost a complete large producer record\n";
        return false;
    }
    return true;
}

}  // namespace

int main() {
    // These UTF-8 FNV-1a vectors also pass through the core census in pipeline-census.spec.ts.
    // A host using a different offset cannot reconcile its timings with material provenance.
    for (const auto& [source, expected] : {
             std::pair{"", "cbf29ce484222325"},
             std::pair{"hello", "a430d84680aabd0b"},
             std::pair{"hello \xf0\x9f\x8c\x8d", "0e21106f2f89a3cf"},
         }) {
        const auto observed = mystral::webgpu::pipelineSourceHash(source);
        if (observed != expected) {
            std::cerr << "pipeline source hash mismatch: expected " << expected
                      << ", observed " << observed << '\n';
            return 1;
        }
    }
    mystral::RuntimeConfig config;
    config.width = 128;
    config.height = 128;
    config.noSdl = true;

    auto runtime = mystral::Runtime::create(config);
    if (!runtime) {
        std::cerr << "could not create headless native runtime\n";
        return 1;
    }

    auto* state = static_cast<mystral::webgpu::BindingsState*>(runtime->getWebGPUBindingsState());
    if (!state || !state->engine) {
        std::cerr << "headless runtime did not expose WebGPU binding state\n";
        return 1;
    }
    if (!runtime->evalScript(kScript, "webgpu_comprehensive_test.js")) {
        std::cerr << "webgpu comprehensive test script evaluation failed\n";
        return 1;
    }

    auto* engine = state->engine;
    // GPU callbacks advance on wall clock. A fixed number of tight polls can finish before Metal
    // or D3D12 settles the submitted-work and map promises this script awaits.
    const auto scriptDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (std::chrono::steady_clock::now() < scriptDeadline) {
        if (!runtime->pollEvents()) break;
        engine->processMicrotasks();
        mystral::js::JSValueGuard done(*engine, engine->getGlobalProperty("__tnWebgpuDone"));
        if (engine->toBoolean(done.get())) break;
        mystral::js::JSValueGuard error(*engine, engine->getGlobalProperty("__tnWebgpuError"));
        if (!engine->isUndefined(error.get())) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    if (!runtime->evalScript(
            "if (globalThis.__tnWebgpuError) throw new Error(globalThis.__tnWebgpuError);"
            "if (globalThis.__tnWebgpuDone !== true) throw new Error('webgpu script timed out');",
            "webgpu_comprehensive_assert.js")) {
        std::cerr << "webgpu comprehensive test script did not complete\n";
        return 1;
    }

    // Keep the main contract on the production recorder, then exercise the native queue binding
    // implementation through an isolated internal contract. This tests both routes without
    // publishing queue escape hatches to game code.
    mystral::RuntimeConfig directConfig;
    directConfig.width = 4;
    directConfig.height = 4;
    directConfig.noSdl = true;
    auto directRuntime = mystral::Runtime::create(directConfig);
    if (!directRuntime) {
        std::cerr << "could not create direct WebGPU binding contract runtime\n";
        return 1;
    }
    auto* directState = static_cast<mystral::webgpu::BindingsState*>(
        directRuntime->getWebGPUBindingsState());
    if (!directState || !directState->engine) {
        std::cerr << "direct WebGPU binding contract did not expose state\n";
        return 1;
    }
    directState->profiling.disableFrameOpStreamForTesting = true;
    if (!directRuntime->evalScript(kDirectQueueScript, "direct_queue_bindings.js")) return 1;
    const auto directDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (std::chrono::steady_clock::now() < directDeadline) {
        if (!directRuntime->pollEvents()) break;
        directState->engine->processMicrotasks();
        if (directState->engine->toBoolean(
                directState->engine->getGlobalProperty("__tnDirectQueueDone"))) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    if (!directState->engine->toBoolean(
            directState->engine->getGlobalProperty("__tnDirectQueueDone"))) {
        std::cerr << "direct WebGPU binding contract timed out\n";
        return 1;
    }

    {
        auto* engine = state->engine;
        if (engine->hasException()) engine->getException();
        auto deviceHandle = engine->getGlobalProperty("__device");
        if (!deviceHandle.ptr || engine->isUndefined(deviceHandle)) {
            std::cerr << "webgpu comprehensive script did not expose its device\n";
            return 1;
        }
        if (!checkLivePipelineCheckpoint(*runtime, state) ||
            !checkPipelineOutputContention(*runtime, state)) return 1;
        auto nativeEncoder = mystral::webgpu::handleGpuDeviceCreateCommandEncoder(state, deviceHandle, {});
        if (!nativeEncoder.ptr || engine->isUndefined(nativeEncoder) ||
            !engine->setGlobalProperty("__nativeEncoder", nativeEncoder)) {
            std::cerr << "could not expose the native command encoder\n";
            return 1;
        }
        if (!runtime->evalScript(kDirectScript, "direct_encoder.js")) return 1;

        // Exercise screenshot & getters
        mystral::webgpu::getCurrentRenderedTexture(state);
        mystral::webgpu::getCurrentTextureWidth(state);
        mystral::webgpu::getCurrentTextureHeight(state);
        mystral::webgpu::getCurrentSurfaceTexture(state);
        mystral::webgpu::getScreenshotBuffer(state);
        mystral::webgpu::getScreenshotBufferSize(state);
        mystral::webgpu::getScreenshotBytesPerRow(state);
        mystral::webgpu::getScreenshotFormat(state);
        mystral::webgpu::isScreenshotReady(state);
        mystral::webgpu::clearScreenshotReady(state);
        mystral::webgpu::requestFrameScreenshot(state);
        mystral::webgpu::compositeCanvas2DToWebGPU(state);
        mystral::webgpu::presentCount(state);
        if (mystral::webgpu::isSrgbSurfaceFormat(WGPUTextureFormat_RGBA8Unorm)) return 1;
        if (mystral::webgpu::linearSurfaceFormat(WGPUTextureFormat_RGBA8Unorm) != WGPUTextureFormat_RGBA8Unorm) return 1;
        if (!mystral::webgpu::setPresentationCapHz(60) || mystral::webgpu::setPresentationCapHz(1001)) return 1;
        mystral::webgpu::setVideoCaptureCallback(state, nullptr, nullptr);
        mystral::webgpu::clearVideoCaptureCallback(state);
        mystral::webgpu::readRenderThreadCpuNs();

        // Presentation functions
        if (!mystral::webgpu::isSrgbSurfaceFormat(WGPUTextureFormat_BGRA8UnormSrgb) ||
            mystral::webgpu::linearSurfaceFormat(WGPUTextureFormat_BGRA8UnormSrgb) != WGPUTextureFormat_BGRA8Unorm) return 1;
        mystral::webgpu::reportSurfaceFormatMarker(WGPUTextureFormat_RGBA8UnormSrgb, WGPUTextureFormat_RGBA8Unorm, true, WGPUPresentMode_Immediate);
        mystral::webgpu::reportSurfaceFormatMarker(WGPUTextureFormat_RGBA8UnormSrgb, WGPUTextureFormat_RGBA8Unorm, true, WGPUPresentMode_Mailbox);
        mystral::webgpu::reportSurfaceFormatMarker(WGPUTextureFormat_RGBA8UnormSrgb, WGPUTextureFormat_RGBA8Unorm, true, static_cast<WGPUPresentMode>(999));
        mystral::webgpu::setPresentationCapHz(0);
        mystral::webgpu::paceToPresentationCap();
        mystral::webgpu::setPresentationCapHz(1000);
        mystral::webgpu::paceToPresentationCap();
        mystral::webgpu::paceToPresentationCap();
        mystral::webgpu::setPresentationCapHz(60);
        mystral::webgpu::reportPresentTick(state, 60);
        mystral::webgpu::reportSurfaceFormatMarker(WGPUTextureFormat_BGRA8Unorm, WGPUTextureFormat_BGRA8Unorm, false, WGPUPresentMode_Fifo);
        const auto sentinelView = reinterpret_cast<WGPUTextureView>(static_cast<uintptr_t>(1));
        mystral::webgpu::trackCurrentSurfaceTextureView(nullptr, 998, sentinelView);
        mystral::webgpu::trackCurrentSurfaceTextureView(state, 998, nullptr);
        mystral::webgpu::untrackCurrentSurfaceTextureView(state, 998);
        mystral::webgpu::untrackCurrentSurfaceTextureView(nullptr, 998);
        if (mystral::webgpu::isCurrentSurfaceTextureView(state, nullptr) ||
            mystral::webgpu::isCurrentSurfaceTextureView(nullptr, sentinelView)) return 1;
        mystral::webgpu::releaseCurrentSurfaceTextureViews(nullptr);
        mystral::webgpu::trackCurrentSurfaceTextureView(state, 999, sentinelView);
        if (!mystral::webgpu::isCurrentSurfaceTextureView(state, sentinelView)) return 1;
        mystral::webgpu::untrackCurrentSurfaceTextureView(state, 999);
        mystral::webgpu::releaseCurrentSurfaceTextureViews(state);
        mystral::webgpu::presentPendingSurface(state);
        const auto capRead = mystral::webgpu::handleWebGpuPresentationCap(state, {}, {});
        if (engine->toNumber(capRead) != 60) return 1;
        for (const double invalidCap : {-1.0, 1001.0, 60.5}) {
            const auto invalid = engine->newNumber(invalidCap);
            const auto invalidResult = mystral::webgpu::handleWebGpuPresentationCap(state, {}, {invalid});
            if (!engine->isUndefined(invalidResult) || !engine->hasException()) return 1;
            engine->getException();
        }
        auto capNum = engine->newNumber(60);
        mystral::webgpu::handleWebGpuPresentationCap(state, {}, {capNum});

        // Wrapper factories
        mystral::webgpu::createNativeWrapper(state, "GPUDevice", state->device);
        mystral::webgpu::createNativeWrapper(state, "GPUQueue", state->queue);

        WGPUTextureDescriptor td = {};
        td.size = {16, 16, 1};
        td.mipLevelCount = 1;
        td.sampleCount = 1;
        td.dimension = WGPUTextureDimension_2D;
        td.format = WGPUTextureFormat_RGBA8Unorm;
        td.usage = WGPUTextureUsage_TextureBinding | WGPUTextureUsage_RenderAttachment;
        auto rawTex = wgpuDeviceCreateTexture(state->device, &td);
        const uint64_t regTexId = 98765;
        state->registries.textureRegistry[regTexId] = {rawTex, WGPUTextureFormat_RGBA8Unorm, 16, 16};

        const auto trackedView = wgpuTextureCreateView(rawTex, nullptr);
        if (trackedView) {
            state->registries.textureViewRegistry[12345] = trackedView;
            mystral::webgpu::trackCurrentSurfaceTextureView(state, 12345, trackedView);
            mystral::webgpu::releaseCurrentSurfaceTextureViews(state);
        }

        const auto savedOffscreenTexture = state->presentation.offscreenTexture;
        state->presentation.offscreenTexture = nullptr;
        if (mystral::webgpu::getCurrentSwapchainTexture(state) != nullptr) return 1;
        state->presentation.offscreenTexture = savedOffscreenTexture;

        auto texWrap = mystral::webgpu::createTextureWrapper(state, rawTex, regTexId, 16, 16, "rgba8unorm", false);
        engine->setGlobalProperty("__wrappedTex", texWrap);
        runtime->evalScript(R"JS((() => {
            const tw = globalThis.__wrappedTex;
            if (tw) {
                const v = tw.createView();
                tw.destroy();
            }
        })())JS");

        auto badTexWrap = mystral::webgpu::createTextureWrapper(state, nullptr, 999999, 16, 16, "rgba8unorm", true);
        engine->setGlobalProperty("__badWrappedTex", badTexWrap);
        runtime->evalScript(R"JS((() => {
            try { globalThis.__badWrappedTex.createView(); } catch(e) {}
            try { globalThis.__badWrappedTex.destroy(); } catch(e) {}
        })())JS");

        if (!state->registries.renderPipelineRegistry.empty()) {
            auto rpWrap = mystral::webgpu::createPipelineWrapper(state, state->registries.renderPipelineRegistry.begin()->second, state->registries.renderPipelineRegistry.begin()->first, true);
            engine->setGlobalProperty("__rpWrap", rpWrap);
            runtime->evalScript(R"JS((() => {
                try { globalThis.__rpWrap.getBindGroupLayout(0); } catch(e) {}
            })())JS");
        }
        if (!state->registries.computePipelineRegistry.empty()) {
            auto cpWrap = mystral::webgpu::createPipelineWrapper(state, state->registries.computePipelineRegistry.begin()->second, state->registries.computePipelineRegistry.begin()->first, false);
            engine->setGlobalProperty("__cpWrap", cpWrap);
            runtime->evalScript(R"JS((() => {
                try { globalThis.__cpWrap.getBindGroupLayout(0); } catch(e) {}
            })())JS");
        }

        auto badRpWrap = mystral::webgpu::createPipelineWrapper(state, nullptr, 888888, true);
        auto badCpWrap = mystral::webgpu::createPipelineWrapper(state, nullptr, 888889, false);
        engine->setGlobalProperty("__badRpWrap", badRpWrap);
        engine->setGlobalProperty("__badCpWrap", badCpWrap);
        runtime->evalScript(R"JS((() => {
            try { globalThis.__badRpWrap.getBindGroupLayout(0); } catch(e) {}
            try { globalThis.__badCpWrap.getBindGroupLayout(0); } catch(e) {}
        })())JS");

        // Resource releases & drains
        mystral::webgpu::releaseTextureRegistryEntry(state, 99999);
        mystral::webgpu::releaseBufferRegistryEntry(state, 99999);
        mystral::webgpu::releaseComputePipelineRegistryEntry(state, 99999);
        mystral::webgpu::releaseRenderPipelineRegistryEntry(state, 99999);
        mystral::webgpu::drainAsyncPipelineCompiles(state);
        mystral::webgpu::drainAsyncBufferMaps(state);
        mystral::webgpu::detachSurfaceForRebuild(state);
        mystral::webgpu::republishSurface(state, nullptr, 0, 0, 64, 64);

        // Texture formats and converters
        const WGPUTextureFormat allFormats[] = {
            WGPUTextureFormat_R8Unorm, WGPUTextureFormat_R8Snorm, WGPUTextureFormat_R8Uint, WGPUTextureFormat_R8Sint,
            WGPUTextureFormat_R16Uint, WGPUTextureFormat_R16Sint, WGPUTextureFormat_R16Float,
            WGPUTextureFormat_RG8Unorm, WGPUTextureFormat_RG8Snorm, WGPUTextureFormat_RG8Uint, WGPUTextureFormat_RG8Sint,
            WGPUTextureFormat_R32Float, WGPUTextureFormat_R32Uint, WGPUTextureFormat_R32Sint,
            WGPUTextureFormat_RG16Uint, WGPUTextureFormat_RG16Sint, WGPUTextureFormat_RG16Float,
            WGPUTextureFormat_RGBA8Unorm, WGPUTextureFormat_RGBA8UnormSrgb, WGPUTextureFormat_RGBA8Snorm,
            WGPUTextureFormat_RGBA8Uint, WGPUTextureFormat_RGBA8Sint,
            WGPUTextureFormat_BGRA8Unorm, WGPUTextureFormat_BGRA8UnormSrgb,
            WGPUTextureFormat_RGB10A2Uint, WGPUTextureFormat_RGB10A2Unorm,
            WGPUTextureFormat_RG11B10Ufloat, WGPUTextureFormat_RGB9E5Ufloat,
            WGPUTextureFormat_RG32Float, WGPUTextureFormat_RG32Uint, WGPUTextureFormat_RG32Sint,
            WGPUTextureFormat_RGBA16Uint, WGPUTextureFormat_RGBA16Sint, WGPUTextureFormat_RGBA16Float,
            WGPUTextureFormat_RGBA32Float, WGPUTextureFormat_RGBA32Uint, WGPUTextureFormat_RGBA32Sint,
            WGPUTextureFormat_Stencil8, WGPUTextureFormat_Depth16Unorm, WGPUTextureFormat_Depth24Plus,
            WGPUTextureFormat_Depth24PlusStencil8, WGPUTextureFormat_Depth32Float, WGPUTextureFormat_Depth32FloatStencil8,
            WGPUTextureFormat_BC1RGBAUnorm, WGPUTextureFormat_BC1RGBAUnormSrgb,
            WGPUTextureFormat_BC2RGBAUnorm, WGPUTextureFormat_BC2RGBAUnormSrgb,
            WGPUTextureFormat_BC3RGBAUnorm, WGPUTextureFormat_BC3RGBAUnormSrgb,
            WGPUTextureFormat_BC4RUnorm, WGPUTextureFormat_BC4RSnorm,
            WGPUTextureFormat_BC5RGUnorm, WGPUTextureFormat_BC5RGSnorm,
            WGPUTextureFormat_BC6HRGBUfloat, WGPUTextureFormat_BC6HRGBFloat,
            WGPUTextureFormat_BC7RGBAUnorm, WGPUTextureFormat_BC7RGBAUnormSrgb
        };
        for (const auto f : allFormats) {
            const char* str = mystral::webgpu::formatToString(f);
            if (str) mystral::webgpu::stringToFormat(str);
        }
        mystral::webgpu::formatToString(WGPUTextureFormat_Undefined);
        mystral::webgpu::stringToFormat("nonexistent_format");

        // Dimensions
        mystral::webgpu::stringToTextureViewDimension("1d");
        mystral::webgpu::stringToTextureViewDimension("2d");
        mystral::webgpu::stringToTextureViewDimension("2d-array");
        mystral::webgpu::stringToTextureViewDimension("cube");
        mystral::webgpu::stringToTextureViewDimension("cube-array");
        mystral::webgpu::stringToTextureViewDimension("3d");
        mystral::webgpu::stringToTextureViewDimension("invalid");

        // Compare functions
        mystral::webgpu::stringToCompareFunction("never");
        mystral::webgpu::stringToCompareFunction("less");
        mystral::webgpu::stringToCompareFunction("equal");
        mystral::webgpu::stringToCompareFunction("less-equal");
        mystral::webgpu::stringToCompareFunction("greater");
        mystral::webgpu::stringToCompareFunction("not-equal");
        mystral::webgpu::stringToCompareFunction("greater-equal");
        mystral::webgpu::stringToCompareFunction("always");
        mystral::webgpu::stringToCompareFunction("invalid");

        // Surface format selection
        const WGPUTextureFormat formats[] = {
            WGPUTextureFormat_BGRA8Unorm,
            WGPUTextureFormat_RGBA8UnormSrgb,
            WGPUTextureFormat_RGBA8Unorm,
            WGPUTextureFormat_BGRA8UnormSrgb
        };
        mystral::webgpu::selectSurfaceFormat(formats, 4, false);
        mystral::webgpu::selectSurfaceFormat(formats, 4, true);
        const auto emptySelection = mystral::webgpu::selectSurfaceFormat(nullptr, 0, false);
        if (emptySelection.selectedFormat != WGPUTextureFormat_Undefined || emptySelection.errorCode == nullptr) return 1;
        const WGPUTextureFormat rgbaFormats[] = {WGPUTextureFormat_RGBA8UnormSrgb, WGPUTextureFormat_R8Unorm};
        mystral::webgpu::selectSurfaceFormat(rgbaFormats, 2, false);

        // Binding table validation failure cases
        mystral::webgpu::installBindingTable(engine, state, mystral::webgpu::bindingTable({}));
        mystral::webgpu::installBindingTable(engine, state, mystral::webgpu::bindingTable({{"GPUQueue", "", 0, nullptr, nullptr, deviceHandle}}));
        mystral::webgpu::installBindingTable(engine, state, mystral::webgpu::bindingTable({{"GPUQueue", "failMethod", 0, nullptr, nullptr, {}}}));
    }

    // Direct Context methods
    {
        mystral::webgpu::Context uninitializedCtx;
        if (uninitializedCtx.createOffscreenTarget(1, 1) ||
            uninitializedCtx.configureSurface(1, 1) ||
            uninitializedCtx.getCurrentTextureView() != nullptr ||
            uninitializedCtx.saveScreenshot("uninitialized.png")) return 1;
        uninitializedCtx.resizeSurface(2, 2);
        uninitializedCtx.present();
        std::vector<uint8_t> uninitializedPixels;
        uint32_t uninitializedWidth = 0;
        uint32_t uninitializedHeight = 0;
        if (uninitializedCtx.captureFrame(uninitializedPixels, uninitializedWidth, uninitializedHeight)) return 1;
        if (uninitializedCtx.createSurface(nullptr, 0) ||
            uninitializedCtx.createSurfaceWithDisplay(nullptr, nullptr, 0) ||
            uninitializedCtx.rebuildSurface(nullptr, 0)) return 1;

        mystral::webgpu::Context standaloneCtx;
        standaloneCtx.initializeHeadless();
        standaloneCtx.createOffscreenTarget(64, 64);
        standaloneCtx.getOffscreenTexture();
        standaloneCtx.getOffscreenTextureView();
        standaloneCtx.isHeadless();
        standaloneCtx.getCurrentTextureView();
        standaloneCtx.getSurfaceWidth();
        standaloneCtx.getSurfaceHeight();
        standaloneCtx.hasIndirectFirstInstance();
        standaloneCtx.hasTimestampQuery();
        standaloneCtx.createSurface(nullptr, 0);
        standaloneCtx.createSurfaceWithDisplay(nullptr, nullptr, 0);
        standaloneCtx.rebuildSurface(nullptr, 0);
        standaloneCtx.getSurfaceNativeHandle();
        standaloneCtx.getSurfacePlatformType();
        standaloneCtx.isInitialized();
        standaloneCtx.getInstance();
        standaloneCtx.getSurface();
        standaloneCtx.getAdapter();
        standaloneCtx.getDevice();
        standaloneCtx.getQueue();
        standaloneCtx.getPreferredFormat();
        standaloneCtx.getPresentMode();
    }

    bool ok = runtime->evalScript("if (globalThis.__tnWebgpuDone !== true || globalThis.__tnDirectEncoderDone !== true) throw new Error('not done');", "check.js");
    if (!ok) {
        std::cerr << "webgpu comprehensive test did not complete successfully\n";
        return 1;
    }

    // Test Windowed/Surface & Canvas2D Compositing
    {
#ifndef _WIN32
        setenv("MYSTRAL_HEADLESS", "1", 1);
#else
        _putenv_s("MYSTRAL_HEADLESS", "1");
#endif
        mystral::RuntimeConfig surfConfig;
        surfConfig.width = 64;
        surfConfig.height = 64;
        surfConfig.noSdl = false;
        surfConfig.title = "WebGPU Surface & Composite Test";
        surfConfig.vsync = false;

        auto surfRuntime = mystral::Runtime::create(surfConfig);
        if (surfRuntime) {
            surfRuntime->evalScript(R"JS((async () => {
                const c = document.getElementById("canvas") || document.createElement("canvas");
                const ctx2d = c.getContext("2d");
                if (ctx2d) {
                    ctx2d.fillStyle = "#ff0000";
                    ctx2d.fillRect(0, 0, 64, 64);
                }
                try {
                    const adapter = await navigator.gpu.requestAdapter();
                    const device = await adapter.requestDevice();
                    const gpuCtx = c.getContext("webgpu");
                    if (gpuCtx) {
                        gpuCtx.configure({ device, format: "bgra8unorm" });
                        const tex = gpuCtx.getCurrentTexture();
                        if (tex) {
                            const enc = device.createCommandEncoder();
                            const pass = enc.beginRenderPass({
                                colorAttachments: [{ view: tex.createView(), loadOp: "clear", storeOp: "store", clearValue: [0.1, 0.2, 0.3, 1.0] }]
                            });
                            pass.end();
                            device.queue.submit([enc.finish()]);
                        }
                    }
                } catch(e) {}
                requestAnimationFrame(() => {});
            })())JS", "surf_script.js");

            for (int f = 0; f < 3; ++f) {
                surfRuntime->requestFrameScreenshot();
                if (!surfRuntime->pollEvents()) break;
            }
            auto* surfState = static_cast<mystral::webgpu::BindingsState*>(surfRuntime->getWebGPUBindingsState());
            if (surfState) {
                mystral::webgpu::compositeCanvas2DToWebGPU(surfState);
                surfState->presentation.requiresSrgbPresentationBridge = true;
                auto linearTex = mystral::webgpu::getCurrentSwapchainTexture(surfState);
                if (linearTex) {
                    WGPUTextureViewDescriptor lvd = {};
                    lvd.format = surfState->presentation.surfaceFormat;
                    lvd.dimension = WGPUTextureViewDimension_2D;
                    lvd.baseMipLevel = 0;
                    lvd.mipLevelCount = 1;
                    lvd.baseArrayLayer = 0;
                    lvd.arrayLayerCount = 1;
                    lvd.aspect = WGPUTextureAspect_All;
                    WGPUTextureView linearView = wgpuTextureCreateView(linearTex, &lvd);
                    surfState->presentation.currentTexture = linearTex;
                    surfState->presentation.currentTextureView = linearView;
                    surfState->presentation.framePresentPending = true;
                    mystral::webgpu::presentPendingSurface(surfState);
                }
                surfState->presentation.requiresSrgbPresentationBridge = false;
            }
            std::vector<uint8_t> px;
            uint32_t w = 0, h = 0;
            surfRuntime->captureFrame(px, w, h);
            surfRuntime->saveScreenshot("surf_composite.png");
            surfRuntime->resize(128, 128);
            surfRuntime->pollEvents();
        }
    }

    std::cout << "native WebGPU comprehensive contract passed\n";
    return 0;
}
