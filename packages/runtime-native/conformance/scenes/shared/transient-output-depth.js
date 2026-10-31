import * as THREE from "three/webgpu";
import { Discard, Fn, NodeUpdateType, screenUV, vec4, viewportTexture } from "three/tsl";
import { assertCondition } from "./scene-support.js";

const vertex = `@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
  let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
  return vec4f(p[i],0,1);
}`;

// Read one physical depth, per sample at 4x and the single value at 1x.
async function readDepthSamples(device, depth, samples) {
  const target = device.createTexture({ size: [1, 1], format: "rgba32float", usage: 17 });
  const buffer = device.createBuffer({ size: 256, usage: 9 });
  const module = device.createShaderModule({ code: `${vertex}
    @group(0) @binding(0) var d:${samples > 1 ? "texture_depth_multisampled_2d" : "texture_depth_2d"};
    @fragment fn fs()->@location(0) vec4f {
      return ${samples > 1
        ? "vec4f(textureLoad(d,vec2i(0),0),textureLoad(d,vec2i(0),1),textureLoad(d,vec2i(0),2),textureLoad(d,vec2i(0),3))"
        : "vec4f(textureLoad(d,vec2i(0),0))"};
    }` });
  const pipeline = device.createRenderPipeline({ layout: "auto", vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format: "rgba32float" }] } });
  const bindings = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
    { binding: 0, resource: depth.createView({ aspect: "depth-only" }) },
  ] });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store" }] });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindings);
  pass.draw(3);
  pass.end();
  encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow: 256 }, [1, 1]);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(1);
  const values = Array.from(new Float32Array(buffer.getMappedRange().slice(0, 16)));
  buffer.unmap();
  buffer.destroy();
  target.destroy();
  return values;
}

// Read the retained physical texture, never getDepthBuffer() at the pipeline's restored sample count.
const readDepth = (device, depth) => readDepthSamples(device, depth, 4);

// The 1x canvas depth a one-sample (fullscreen) pass draws into.
const readDepth1 = (device, depth) => readDepthSamples(device, depth, 1);

// Positive control for readDepth1: a cleared 1-sample depth must read back, so a zero from a pass means the
// pass stored zero and not that the reader is broken.
async function controlDepth(device, value) {
  const texture = device.createTexture({ size: [1, 1], format: "depth32float", usage: 20 });
  const encoder = device.createCommandEncoder();
  encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: {
    view: texture.createView(), depthLoadOp: "clear", depthClearValue: value, depthStoreOp: "store" } }).end();
  device.queue.submit([encoder.finish()]);
  const read = await readDepth1(device, texture);
  texture.destroy();
  assertCondition(Math.abs(read[0] - value) < 0.00001, `1-sample depth reader control differs (${read[0]} vs ${value})`);
}

// Resolve to a separate ordinary target: the original canvas MSAA colour has no TextureBinding usage.
async function colourSamples(device, colour) {
  const target = device.createTexture({ size: [colour.width, colour.height], format: colour.format, usage: 17 });
  const buffer = device.createBuffer({ size: 256, usage: 9 });
  const encoder = device.createCommandEncoder();
  encoder.beginRenderPass({ colorAttachments: [{ view: colour.createView(), resolveTarget: target.createView(), loadOp: "load", storeOp: "store" }] }).end();
  encoder.copyTextureToBuffer({ texture: target }, { buffer, bytesPerRow: 256 }, [1, 1]);
  device.queue.submit([encoder.finish()]);
  await buffer.mapAsync(1);
  const bytes = Array.from(new Uint8Array(buffer.getMappedRange().slice(0, 4)));
  buffer.unmap();
  buffer.destroy();
  target.destroy();
  return colour.format.startsWith("bgra") ? [bytes[2], bytes[1], bytes[0], bytes[3]] : bytes;
}

function drawSamples(device, colour, depth, partial) {
  const module = device.createShaderModule({ code: `${vertex}
    struct Out { @location(0) c:vec4f, @builtin(frag_depth) d:f32 }
    @fragment fn fs(@builtin(sample_index) s:u32)->Out {
      ${partial ? "if (s != 0u) { discard; }" : ""}
      let v=${partial ? "1.0" : "f32(s+1u)*0.2"};
      return Out(vec4f(v,v,v,1),v);
    }` });
  const pipeline = device.createRenderPipeline({ layout: "auto", vertex: { module, entryPoint: "vs" },
    fragment: { module, entryPoint: "fs", targets: [{ format: colour.format }] },
    depthStencil: { format: depth.format, depthWriteEnabled: true, depthCompare: "always" }, multisample: { count: 4 } });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({ colorAttachments: [{ view: colour.createView(), loadOp: "load", storeOp: "store" }],
    depthStencilAttachment: { view: depth.createView(), depthLoadOp: "load", depthStoreOp: "store" } });
  pass.setPipeline(pipeline);
  pass.draw(3);
  pass.end();
  device.queue.submit([encoder.finish()]);
}

class ClearAfterNode extends THREE.Node {
  constructor() {
    super("vec4");
    this.updateAfterType = NodeUpdateType.RENDER;
    this.calls = 0;
  }
  setup() { return vec4(0, 1, 0, 1); }
  updateAfter({ renderer }) {
    this.calls++;
    renderer.setClearColor(0xff0000, 1);
    renderer.clear(true, true, false);
    renderer.setClearColor(0x000000, 1);
  }
}

export async function startScene(canvas, dimensions) {
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: true });
  await renderer.init();
  renderer.setPixelRatio(1);
  renderer.setSize(dimensions.width, dimensions.height, false);
  const { backend } = renderer;
  const { device } = backend;
  device.pushErrorScope("validation");
  const detail = { copyCalls: 0 };
  const copy = renderer.copyFramebufferToTexture.bind(renderer);
  renderer.copyFramebufferToTexture = (...args) => { detail.copyCalls++; return copy(...args); };

  // Force one ordinary 4x canvas pass before retaining its physical colour/depth identities.
  const toneMapping = renderer.toneMapping;
  const outputColorSpace = renderer.outputColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.ColorManagement.workingColorSpace;
  // A real scene and camera, because three 0.187 renders a QuadMesh straight to screen as a
  // fullscreen pass at one sample: merge/src/renderers/common/Renderer.js:2198 sets `fullscreenPass`,
  // :3006 zeroes `currentSamples` for it, so a quad seed retains no 4x canvas texture at all.
  const seedScene = new THREE.Scene();
  const seedQuad = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.MeshBasicNodeMaterial({ color: 0x00ff00 }),
  );
  seedQuad.position.z = -1;
  seedScene.add(seedQuad);
  renderer.render(seedScene, new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10));
  const target = renderer.getCanvasTarget();
  const depth = backend.get(target.depthTexture).texture;
  const colour = backend.get(target.colorTexture).texture;
  assertCondition(depth.sampleCount === 4 && colour.sampleCount === 4, "fixture requires retained canonical 4x textures");
  renderer.toneMapping = toneMapping;
  renderer.outputColorSpace = outputColorSpace;

  drawSamples(device, colour, depth, false);
  detail.seedDepth = await readDepth(device, depth);
  assertCondition(detail.seedDepth.every((v, i) => Math.abs(v - (i + 1) * 0.2) < 0.00001), "four distinct physical depth samples were not seeded");
  drawSamples(device, colour, depth, true);
  detail.preservedColour = await colourSamples(device, colour);
  const expected = colour.format.endsWith("srgb") ? Math.round((1.055 * 0.7 ** (1 / 2.4) - 0.055) * 255) : 179;
  assertCondition(detail.preservedColour.slice(0, 3).every((v) => Math.abs(v - expected) <= 2), "partial sample draw lost stored colour samples");

  // An output pass is a fullscreen pass at one sample: three zeroes `currentSamples` for a QuadMesh
  // (merge/src/renderers/common/Renderer.js:2198, :3006), allocates that pass its own canvas depth beside the
  // retained 4x one (merge/src/renderers/webgpu/utils/WebGPUTextureUtils.js:599-655) and presents its colour
  // straight to the swapchain (merge/src/renderers/webgpu/WebGPUBackend.js:491). So the retained 4x colour and
  // depth must come out untouched, and the pass's own 1x depth carries the value the desktop arm replays at
  // 4x. Snapshot the retained pair here, the last moment before the first output pass.
  const retainedDepth = await readDepth(device, depth);
  const retainedColour = await colourSamples(device, colour);
  await controlDepth(device, 0.75);
  const assertRetainedColour = (label, samples) => assertCondition(samples.every((v, i) => v === retainedColour[i]),
    `${label}: output pass wrote the retained 4x colour`);
  const liveDepth = async () => {
    const texture = backend.get(target.depthTexture).texture;
    assertCondition(texture !== depth && texture.sampleCount === 1, "output pass did not swap in its own 1x canvas depth");
    return readDepth1(device, texture);
  };
  const pipeline = new THREE.RenderPipeline(renderer, vec4(0, 1, 0, 1));
  const check = async (label, expectedDepth = 0) => {
    const samples = await readDepth(device, depth);
    detail[label] = samples;
    assertCondition(depth.sampleCount === 4 && samples.every((v, i) => v === retainedDepth[i]), `${label}: output pass wrote the retained 4x canonical depth`);
    detail[`${label}Output`] = await liveDepth();
    assertCondition(detail[`${label}Output`][0] === expectedDepth, `${label}: output pass depth differs (${detail[`${label}Output`][0]} vs ${expectedDepth})`);
  };
  pipeline.render();
  await check("outputDepth");
  drawSamples(device, colour, depth, true);
  detail.outputStoredColour = await colourSamples(device, colour);
  assertRetainedColour("outputStoredColour", detail.outputStoredColour);
  detail.outputStoredDepth = await readDepth(device, depth);
  assertCondition(detail.outputStoredDepth.every((v, i) => v === retainedDepth[i]), "single-sample overwrite wrote the retained 4x canonical depth");
  detail.outputStoredDepthOutput = await liveDepth();
  assertCondition(detail.outputStoredDepthOutput[0] === 0, "single-sample overwrite lost the output pass's own depth");
  pipeline.render();

  // The compiled discard shader must leave canonical depth alone.
  pipeline.outputNode = Fn(() => { Discard(); return vec4(0, 1, 0, 1); })();
  pipeline.needsUpdate = true;
  pipeline.render();
  await check("discardDepth", 1);

  // Real graph updateBefore copies and restarts the active pass before its first draw.
  pipeline.outputNode = viewportTexture();
  pipeline.needsUpdate = true;
  pipeline.render();
  await check("copyRestartDepth");
  assertCondition(detail.copyCalls > 0, "ViewportTextureNode did not execute its framebuffer copy");
  detail.copyRestartColour = await colourSamples(device, colour);
  assertRetainedColour("copyRestartColour", detail.copyRestartColour);

  const after = new ClearAfterNode();
  pipeline.outputNode = after;
  pipeline.needsUpdate = true;
  pipeline.render();
  await check("updateAfterDepth");
  detail.updateAfterCalls = after.calls;
  detail.updateAfterColour = await colourSamples(device, colour);
  assertCondition(after.calls > 0, "updateAfter hook never ran");
  assertRetainedColour("updateAfterColour", detail.updateAfterColour);

  renderer.autoClear = false;
  const blocked = new THREE.QuadMesh(new THREE.MeshBasicNodeMaterial({ color: 0x0000ff }));
  blocked.position.z = -0.5;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.ColorManagement.workingColorSpace;
  blocked.render(renderer);
  renderer.toneMapping = toneMapping;
  renderer.outputColorSpace = outputColorSpace;
  // This direct QuadMesh pass loads the output pass's own 1x depth, the buffer it draws against, so `check`
  // reading it back unchanged is the block: an unwritten test would have stored the quad's own depth.
  await check("depthTestedLoad");
  detail.loadedColour = await colourSamples(device, colour);
  assertRetainedColour("loadedColour", detail.loadedColour);
  renderer.autoClear = true;
  pipeline.render();
  await check("nextFrameDepth");
  const error = await device.popErrorScope();
  assertCondition(error == null, `GPU validation: ${error?.message}`);
  renderer.copyFramebufferToTexture = copy;
  console.info(`TN_TRANSIENT_OUTPUT_PROOF:${JSON.stringify(detail)}`);
  // Keep the final capture non-uniform while the preceding assertions use literal Green.
  pipeline.outputNode = vec4(screenUV.x.mul(0.5), 1, screenUV.y.mul(0.5), 1);
  pipeline.needsUpdate = true;
  function frame() { pipeline.render(); requestAnimationFrame(frame); }
  requestAnimationFrame(frame);
  globalThis.__TN_CONFORMANCE = { ok: true, type: "transient-output-depth", detail };
  return { renderer, pipeline, seedScene, blocked };
}
