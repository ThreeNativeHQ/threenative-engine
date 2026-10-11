export * from "./core-three.mjs";
import { BufferAttribute, Color } from "./core-three.mjs";
import { unsupportedExport } from "../../../../three-native/src/refused.ts";
import { syncUniforms } from "./core-tsl.mjs";
import { ShadowMap } from "../../../../three-native/src/shadow-map.ts";
import { defineRenderTargets } from "../../../../three-native/src/render-target.ts";
import { defineQuadMesh } from "../../../../three-native/src/quad-mesh.ts";

export const { MeshBasicNodeMaterial, MeshStandardNodeMaterial, SpriteNodeMaterial } = globalThis;
Object.setPrototypeOf(MeshBasicNodeMaterial.prototype, globalThis.MeshBasicMaterial.prototype);
Object.setPrototypeOf(MeshStandardNodeMaterial.prototype, globalThis.MeshStandardMaterial.prototype);
Object.setPrototypeOf(SpriteNodeMaterial.prototype, globalThis.SpriteMaterial.prototype);
for (const material of [MeshBasicNodeMaterial, MeshStandardNodeMaterial, SpriteNodeMaterial]) {
  material.prototype.isNodeMaterial = true;
  material.prototype[`is${material.name}`] = true;
}

// Core still owns createRenderer/wrapRenderer; the player owns the GPU and draws these handles.
// The facade's backend answers three's adapter request with the player's GPU adapter, so core reads
// the same `adapter.info` identity (and software-adapter verdict) it reads in a browser.
class NativeBackend {
  gpu = { requestAdapter: () => globalThis.tn.requestAdapter() };
}

export class WebGPURenderer {
  constructor({ canvas, antialias = false } = {}) {
    this.domElement = canvas;
    this.samples = antialias ? 4 : 0;
  }
  backend = new NativeBackend();
  // three's `renderer.info`, read from the last frame the player drew (one frame behind the
  // simulation, as a GPU-timed reading is). `reset` has nothing to clear: the player counts per frame.
  info = {
    render: {
      get drawCalls() { return globalThis.tn.renderInfo().drawCalls; },
      get calls() { return globalThis.tn.renderInfo().drawCalls; },
      get triangles() { return globalThis.tn.renderInfo().triangles; },
    },
    compute: {},
    frame: 0,
    reset() {},
  };
  // WebGPURenderer's defaults; the player applies them before each frame it draws.
  shadowMap = new ShadowMap();
  toneMapping = 0;
  toneMappingExposure = 1;
  outputColorSpace = "srgb";
  // three's clear colour and alpha (linear), black and opaque by default; the player clears each frame
  // and each render target to them (`__clearColor`, read by tn.setRendererState).
  __clearColor = [0, 0, 0, 1];
  setClearColor(color, alpha = 1) {
    const value = typeof color === "object" && color !== null ? color : new Color(color);
    this.__clearColor = [value.r, value.g, value.b, alpha];
  }
  getClearColor(target) { return target.setRGB(this.__clearColor[0], this.__clearColor[1], this.__clearColor[2]); }
  getClearAlpha() { return this.__clearColor[3]; }
  setClearAlpha(alpha) { this.__clearColor[3] = alpha; }
  setPixelRatio() {}
  // WebGPUCapabilities.getMaxAnisotropy: WebGPU samplers clamp maxAnisotropy to 16.
  getMaxAnisotropy() { return 16; }
  setSize(width, height) {
    this.domElement.width = width;
    this.domElement.height = height;
  }
  getDrawingBufferSize(target) { return target.set(this.domElement.width, this.domElement.height); }
  render(scene, camera) {
    globalThis.__tnGameSpan?.(23, 0);
    try { syncUniforms(); } finally { globalThis.__tnGameSpan?.(23, 1); }
    globalThis.__tnGameSpan?.(24, 0);
    try {
      globalThis.tn.scene = scene;
      globalThis.tn.camera = camera;
      globalThis.tn.setRendererState(this);
    } finally { globalThis.__tnGameSpan?.(24, 1); }
  }
  compileAsync(root, camera, scene) {
    syncUniforms();
    globalThis.tn.setRendererState(this);
    return globalThis.tn.compileAsync(root, camera, scene);
  }
  dispose() {}
}

// three's render targets (shared with the Wasm back end): render() while a target is set draws into
// it at the call, and readRenderTargetPixelsAsync reads it back once the GPU copy lands.
defineRenderTargets(WebGPURenderer.prototype, (renderer) => ({
  draw(target, root, camera) {
    syncUniforms();
    globalThis.tn.setRendererState(renderer);  // the target clears to the renderer's current clear colour
    globalThis.tn.renderTarget(target, root, camera);
  },
  read: (target, x, y, width, height) => globalThis.tn.readTarget(target, x, y, width, height),
}));
// three's QuadMesh over the engine Mesh (shared with the Wasm back end).
export const QuadMesh = defineQuadMesh(globalThis);

// three's RenderPipeline(renderer, outputNode): the player installs the node graph as its post pass
// (once per graph) and draws it with the renderer's settings.
export class RenderPipeline {
  constructor(renderer, outputNode = null) {
    this.renderer = renderer;
    this.outputNode = outputNode;
  }
  render() {
    syncUniforms();
    globalThis.tn.setRendererState(this.renderer);
    globalThis.tn.setPostGraph(this.outputNode);
  }
  dispose() { globalThis.tn.setPostGraph(null); }
}
// three's NodeUpdateType, the constants a node's update schedule names.
export const NodeUpdateType = Object.freeze({ NONE: "none", FRAME: "frame", RENDER: "render", OBJECT: "object" });
// three's StorageBufferAttribute: a BufferAttribute that TSL storage() binds as a storage buffer.
export class StorageBufferAttribute extends BufferAttribute {
  constructor(count, itemSize, typeClass = Float32Array) {
    super(ArrayBuffer.isView(count) ? count : new typeClass(count * itemSize), itemSize);
  }
}
StorageBufferAttribute.prototype.isStorageBufferAttribute = true;
export const MeshLambertNodeMaterial = unsupportedExport("MeshLambertNodeMaterial");
export const MeshMatcapNodeMaterial = unsupportedExport("MeshMatcapNodeMaterial");
export const MeshNormalNodeMaterial = unsupportedExport("MeshNormalNodeMaterial");
export const MeshPhongNodeMaterial = unsupportedExport("MeshPhongNodeMaterial");
export const MeshPhysicalNodeMaterial = unsupportedExport("MeshPhysicalNodeMaterial");
export const MeshToonNodeMaterial = unsupportedExport("MeshToonNodeMaterial");
