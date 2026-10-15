export * from "./core-three.mjs";
import { BufferAttribute, Color, Material, NormalBlending } from "./core-three.mjs";
import { unsupportedExport } from "../../../../three-native/src/refused.ts";
import { syncUniforms } from "./core-tsl.mjs";
import { GAME_SPANS } from "../../../../core/src/profiling/Spans.ts";
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
  // Pipelines the player's renderer has compiled so far (three counts createRenderPipeline calls on its
  // backend; the engine counts its own pipeline cache). A window's compiles are the difference of two reads.
  pipelineCompiles = () => globalThis.tn.renderInfo().pipelineCompiles;
}

// `scene.fogNode` (three's per-material fog composition, e.g. a height-fog term) has no native
// lowering: the engine applies `scene.fog` and nothing else. Said once, by name, never silently.
let fogNodeWarned = false;
function warnFogNode(scene) {
  if (fogNodeWarned || scene?.fogNode == null) return;
  fogNodeWarned = true;
  console.warn("TN_NATIVE_FOG_NODE_IGNORED: scene.fogNode is not applied by the native engine; scene.fog is.");
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
  // three's `await renderer.init()`: the player owns the GPU and has opened it before any script runs.
  async init() { return this; }
  // WebGPUCapabilities.getMaxAnisotropy: WebGPU samplers clamp maxAnisotropy to 16.
  getMaxAnisotropy() { return 16; }
  setSize(width, height) {
    this.domElement.width = width;
    this.domElement.height = height;
  }
  // The player owns the window, so setSize cannot resize it: the drawing buffer is the surface the player opened.
  getDrawingBufferSize(target) {
    const { width, height } = globalThis.tn.surfaceSize();
    return target.set(width, height);
  }
  render(scene, camera) {
    warnFogNode(scene);
    globalThis.__tnGameSpan?.(GAME_SPANS.transport, 0);
    try { syncUniforms(); } finally { globalThis.__tnGameSpan?.(GAME_SPANS.transport, 1); }
    globalThis.__tnGameSpan?.(GAME_SPANS.publish, 0);
    try {
      globalThis.tn.scene = scene;
      globalThis.tn.camera = camera;
      globalThis.tn.setRendererState(this);
    } finally { globalThis.__tnGameSpan?.(GAME_SPANS.publish, 1); }
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
  context = {};
  outputColorTransform = true;
  _source = null;
  _graph = null;
  constructor(renderer, outputNode = null) {
    this.renderer = renderer;
    this.outputNode = outputNode;
  }
  render() {
    this.context.onBeforeRenderPipeline?.();
    try {
    syncUniforms();
    globalThis.tn.setRendererState(this.renderer);
    if (this._source !== this.outputNode) {
      this._source = this.outputNode;
      this._graph = null;
    }
    if (!this.outputColorTransform && this.outputNode !== null)
      this._graph ??= globalThis.tsl.pipelineOutput(this.outputNode, 0);
    globalThis.tn.setPostGraph(this.outputColorTransform ? this.outputNode : this._graph);
    } finally { this.context.onAfterRenderPipeline?.(); }
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

// three's BlendMode (renderers/common/BlendMode.js): the blend state an MRT output names through
// `mrt.setBlendMode(name, mode)`. The factor and equation values are three's own constants.
export class BlendMode {
  constructor(blending = NormalBlending) {
    this.blending = blending;
    this.blendSrc = 204; // SrcAlphaFactor
    this.blendDst = 205; // OneMinusSrcAlphaFactor
    this.blendEquation = 100; // AddEquation
    this.blendSrcAlpha = null;
    this.blendDstAlpha = null;
    this.blendEquationAlpha = null;
    this.premultiplyAlpha = false;
  }
  copy(source) { return Object.assign(this, source); }
  clone() { return new this.constructor().copy(this); }
}

// three's ReadbackBuffer (renderers/common/ReadbackBuffer.js): the caller-owned target of
// `renderer.getArrayBufferAsync(attribute, target)`. The class is bound so core's argument check
// (`target instanceof ReadbackBuffer`) runs; the native renderer has no `getArrayBufferAsync`, so
// core's `readback` refuses by name ("webgpu renderer does not expose getArrayBufferAsync()").
export class ReadbackBuffer {
  isReadbackBuffer = true;
  name = "";
  buffer = null;
  #listeners = new Map();
  constructor(maxByteLength) { this.maxByteLength = maxByteLength; }
  addEventListener(type, listener) {
    if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
    this.#listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.#listeners.get(type)?.delete(listener); }
  dispatchEvent(event) {
    for (const listener of [...(this.#listeners.get(event.type) ?? [])]) listener.call(this, { ...event, target: this });
  }
  release() { this.dispatchEvent({ type: "release" }); }
  dispose() { this.dispatchEvent({ type: "dispose" }); }
}

// Game-authored node lifecycles and fullscreen node materials have no V8 renderer binding. They stay
// importable, so a game that defines a node class or imports them runs; one that constructs or calls
// them fails at that use, by name. TempNode is a real constructor so `class X extends TempNode` loads.
export class TempNode {
  constructor() {
    throw new Error("TN_NATIVE_UNSUPPORTED_TEMPNODE: TempNode is not available on the native engine.");
  }
}
export const NodeMaterial = globalThis.NodeMaterial;
Object.setPrototypeOf(NodeMaterial.prototype, Material.prototype);
NodeMaterial.prototype.isNodeMaterial = true;
export const RendererUtils = unsupportedExport("RendererUtils");
