import * as THREE from "three/webgpu";
import { Discard, Fn, NodeUpdateType, screenUV, vec4, viewportTexture } from "three/tsl";
import { assertCondition } from "./scene-support.js";

const vertex = `@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f {
  let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));
  return vec4f(p[i],0,1);
}`;

// Read the retained physical texture, never getDepthBuffer() at the pipeline's restored sample count.
async function readDepth(device, depth) {
  const target = device.createTexture({ size: [1, 1], format: "rgba32float", usage: 17 });
  const buffer = device.createBuffer({ size: 256, usage: 9 });
  const module = device.createShaderModule({ code: `${vertex}
    @group(0) @binding(0) var d:texture_depth_multisampled_2d;
    @fragment fn fs()->@location(0) vec4f {
      return vec4f(textureLoad(d,vec2i(0),0),textureLoad(d,vec2i(0),1),
        textureLoad(d,vec2i(0),2),textureLoad(d,vec2i(0),3));
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
  const originalTexture = device.createTexture.bind(device);
  const originalEncoder = device.createCommandEncoder.bind(device);
  const privateViews = new WeakSet();
  const detail = { granted: device.features.has("transient-attachments"), privateDraws: 0, privatePasses: 0, copyCalls: 0 };
  device.createTexture = (descriptor) => {
    const texture = originalTexture(descriptor);
    if (descriptor.label === "tn-private-output-depth") {
      const createView = texture.createView.bind(texture);
      texture.createView = (...args) => {
        const view = createView(...args);
        privateViews.add(view);
        return view;
      };
    }
    return texture;
  };
  device.createCommandEncoder = (...args) => {
    const encoder = originalEncoder(...args);
    const begin = encoder.beginRenderPass.bind(encoder);
    encoder.beginRenderPass = (descriptor) => {
      const attachment = descriptor.depthStencilAttachment;
      const privateDepth = attachment && privateViews.has(attachment.view);
      if (privateDepth) {
        assertCondition(attachment.depthLoadOp === "clear" && attachment.depthStoreOp === "discard", "private depth must never LOAD or STORE");
        detail.privatePasses++;
      }
      const pass = begin(descriptor);
      const draw = pass.draw.bind(pass);
      pass.draw = (...drawArgs) => {
        if (privateDepth) detail.privateDraws++;
        return draw(...drawArgs);
      };
      return pass;
    };
    return encoder;
  };
  const copy = renderer.copyFramebufferToTexture.bind(renderer);
  renderer.copyFramebufferToTexture = (...args) => { detail.copyCalls++; return copy(...args); };

  // Force one ordinary 4x canvas pass before retaining its physical colour/depth identities.
  const toneMapping = renderer.toneMapping;
  const outputColorSpace = renderer.outputColorSpace;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.ColorManagement.workingColorSpace;
  const seed = new THREE.QuadMesh(new THREE.MeshBasicNodeMaterial({ color: 0x00ff00 }));
  seed.render(renderer);
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

  const pipeline = new THREE.RenderPipeline(renderer, vec4(0, 1, 0, 1));
  const check = async (label, expectedDepth = 0) => {
    const samples = await readDepth(device, depth);
    detail[label] = samples;
    assertCondition(samples.every((v) => Math.abs(v - expectedDepth) < 0.00001), `${label}: physical canonical depth differs`);
  };
  pipeline.render();
  await check("outputDepth");
  assertCondition(!detail.granted || detail.privateDraws > 0, "eligible output allocated private depth but never drew it");
  assertCondition(detail.granted || detail.privateDraws === 0, "feature-off/browser used private depth");
  drawSamples(device, colour, depth, true);
  detail.outputStoredColour = await colourSamples(device, colour);
  const quarter = colour.format.endsWith("srgb") ? Math.round((1.055 * 0.25 ** (1 / 2.4) - 0.055) * 255) : 64;
  assertCondition(Math.abs(detail.outputStoredColour[0] - quarter) <= 1 && detail.outputStoredColour[1] === 255 && Math.abs(detail.outputStoredColour[2] - quarter) <= 1,
    "single-sample overwrite lost the other three stored Green output samples");
  detail.outputStoredDepth = await readDepth(device, depth);
  assertCondition(detail.outputStoredDepth.every((v, i) => v === (i === 0 ? 1 : 0)), "single-sample overwrite lost stored output depth");
  pipeline.render();

  // The compiled discard shader must restore canonical depth rather than certify a full quad.
  const draws = detail.privateDraws;
  pipeline.outputNode = Fn(() => { Discard(); return vec4(0, 1, 0, 1); })();
  pipeline.needsUpdate = true;
  pipeline.render();
  await check("discardDepth", 1);
  assertCondition(detail.privateDraws === draws, "compiled discard shader drew private depth");

  // Real graph updateBefore copies and restarts the active pass before its first draw.
  pipeline.outputNode = viewportTexture();
  pipeline.needsUpdate = true;
  pipeline.render();
  await check("copyRestartDepth");
  assertCondition(detail.copyCalls > 0, "ViewportTextureNode did not execute its framebuffer copy");
  detail.copyRestartColour = await colourSamples(device, colour);
  assertCondition(detail.copyRestartColour.slice(0, 3).every((v) => v === 0), "framebuffer copy/restart changed the cleared black pixels");

  const after = new ClearAfterNode();
  pipeline.outputNode = after;
  pipeline.needsUpdate = true;
  pipeline.render();
  await check("updateAfterDepth");
  detail.updateAfterCalls = after.calls;
  detail.updateAfterColour = await colourSamples(device, colour);
  assertCondition(after.calls > 0 && detail.updateAfterColour[0] === 0 && detail.updateAfterColour[1] === 255 && detail.updateAfterColour[2] === 0,
    "updateAfter separate Red clear must submit BEFORE pending Green output");

  renderer.autoClear = false;
  const blocked = new THREE.QuadMesh(new THREE.MeshBasicNodeMaterial({ color: 0x0000ff }));
  blocked.position.z = -0.5;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.ColorManagement.workingColorSpace;
  blocked.render(renderer);
  renderer.toneMapping = toneMapping;
  renderer.outputColorSpace = outputColorSpace;
  await check("depthTestedLoad");
  detail.loadedColour = await colourSamples(device, colour);
  assertCondition(detail.loadedColour[1] === 255 && detail.loadedColour[2] === 0, "depth-tested LOAD overwrote nearer output");
  renderer.autoClear = true;
  pipeline.render();
  await check("nextFrameDepth");
  const error = await device.popErrorScope();
  assertCondition(error == null, `GPU validation: ${error?.message}`);
  device.createTexture = originalTexture;
  device.createCommandEncoder = originalEncoder;
  renderer.copyFramebufferToTexture = copy;
  console.info(`TN_TRANSIENT_OUTPUT_PROOF:${JSON.stringify(detail)}`);
  // Keep the final capture non-uniform while the preceding assertions use literal Green.
  pipeline.outputNode = vec4(screenUV.x.mul(0.5), 1, screenUV.y.mul(0.5), 1);
  pipeline.needsUpdate = true;
  function frame() { pipeline.render(); requestAnimationFrame(frame); }
  requestAnimationFrame(frame);
  globalThis.__TN_CONFORMANCE = { ok: true, type: "transient-output-depth", detail };
  return { renderer, pipeline, seed, blocked };
}
