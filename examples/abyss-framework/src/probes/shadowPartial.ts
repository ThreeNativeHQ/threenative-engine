import type { VirtualShadowNode } from "@threenative/core";
import { BoxGeometry, type DirectionalLight, Mesh, type Scene, Vector3 } from "three";
import { vec4 } from "three/tsl";
import { MeshStandardNodeMaterial, type RenderTarget, type Renderer } from "three/webgpu";

/**
 * PRD-538: the proof that a partial shadow redraw writes the same depth and transmitted-shadow colour as a whole one.
 *
 * Each step changes the scene, waits for the shadow levels to redraw it (partial: one rectangle
 * per ask), reads the finest level's depth and RGBA bytes, then forces a whole redraw of the same scene and
 * reads that back too. The two must match texel for texel, inside the rectangle and outside it.
 * The whole-map comparison is the claim; the redrawn-page counters say the partial path was the
 * one that ran, and the change against the previous map says the step was not a no-op.
 */

const MAP_BYTES = 4;
// Numeric WebGPU usage flags, so the probe needs no global the native host may not shim.
const STORAGE = 0x80;
const COPY_SRC = 0x04;
const COPY_DST = 0x08;
const MAP_READ = 0x01;

const DEPTH_TO_BUFFER = `
@group(0) @binding(0) var depth: texture_depth_2d;
@group(0) @binding(1) var<storage, read_write> out: array<f32>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let dims = textureDimensions(depth);
  if (id.x >= dims.x || id.y >= dims.y) { return; }
  out[id.y * dims.x + id.x] = textureLoad(depth, vec2<i32>(id.xy), 0);
}
`;

interface IGpuTexture {
  createView(descriptor: { aspect: string }): unknown;
  height: number;
  width: number;
}

interface IGpuDevice {
  createBindGroup(descriptor: unknown): unknown;
  createBuffer(descriptor: { size: number; usage: number }): {
    getMappedRange(): ArrayBuffer;
    mapAsync(mode: number): Promise<void>;
    unmap(): void;
  };
  createCommandEncoder(): {
    beginComputePass(): {
      dispatchWorkgroups(x: number, y: number): void;
      end(): void;
      setBindGroup(index: number, group: unknown): void;
      setPipeline(pipeline: unknown): void;
    };
    copyBufferToBuffer(from: unknown, a: number, to: unknown, b: number, size: number): void;
    finish(): unknown;
  };
  createComputePipeline(descriptor: unknown): { getBindGroupLayout(index: number): unknown };
  createShaderModule(descriptor: { code: string }): unknown;
  queue: { submit(buffers: unknown[]): void };
}

interface IBackend {
  device: IGpuDevice;
  get(texture: unknown): { texture: IGpuTexture };
}

/** The depth of a texture as the floats a shader reads, row by row. Works for any depth format. */
async function readDepth(renderer: unknown, texture: unknown): Promise<Float32Array> {
  const backend = (renderer as { backend: IBackend }).backend;
  const { device } = backend;
  const gpu = backend.get(texture).texture;
  const bytes = gpu.width * gpu.height * MAP_BYTES;
  const pipeline = device.createComputePipeline({
    compute: { entryPoint: "main", module: device.createShaderModule({ code: DEPTH_TO_BUFFER }) },
    layout: "auto",
  });
  const storage = device.createBuffer({ size: bytes, usage: STORAGE | COPY_SRC });
  const readback = device.createBuffer({ size: bytes, usage: COPY_DST | MAP_READ });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(
    0,
    device.createBindGroup({
      entries: [
        { binding: 0, resource: gpu.createView({ aspect: "depth-only" }) },
        { binding: 1, resource: { buffer: storage } },
      ],
      layout: pipeline.getBindGroupLayout(0),
    }),
  );
  pass.dispatchWorkgroups(Math.ceil(gpu.width / 8), Math.ceil(gpu.height / 8));
  pass.end();
  encoder.copyBufferToBuffer(storage, 0, readback, 0, bytes);
  device.queue.submit([encoder.finish()]);
  await readback.mapAsync(1);
  const depth = new Float32Array(readback.getMappedRange().slice(0));
  readback.unmap();
  return depth;
}

function differing(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length === 0 || b.length === 0) throw new Error("Missing shadow depth observation");
  let count = a.length === b.length ? 0 : Math.max(a.length, b.length);
  for (let at = 0; at < Math.min(a.length, b.length); at += 1) {
    if (!Object.is(a[at], b[at])) count += 1;
  }
  return count;
}

/** Everything the scenario asserts, as plain numbers. */
export type ShadowPartialResults = Record<string, number>;

/** Aggregate counts prove every redraw was partial only when no whole level could fit. */
export function isPartialRedraw(
  pagesRedrawn: number,
  renders: number,
  pagesPerAxis: number,
): boolean {
  return (
    Number.isSafeInteger(pagesRedrawn) &&
    pagesRedrawn > 0 &&
    Number.isSafeInteger(renders) &&
    renders > 0 &&
    Number.isSafeInteger(pagesPerAxis) &&
    pagesPerAxis > 0 &&
    pagesRedrawn < pagesPerAxis ** 2
  );
}

export class ShadowPartialProbe {
  readonly results: ShadowPartialResults = { shadowPartialDone: 0 };
  /** Where the play camera stands, so a step can move it without the scene following it. */
  readonly cameraOffset = new Vector3();
  readonly #scene: Scene;
  readonly #shadow: VirtualShadowNode;
  readonly #renderer: unknown;
  readonly #ready: () => boolean;
  readonly #done: () => void;
  readonly #boxes = new Map<string, Mesh>();

  constructor(options: {
    done: () => void;
    ready: () => boolean;
    renderer: unknown;
    scene: Scene;
    shadow: VirtualShadowNode;
  }) {
    this.#scene = options.scene;
    this.#shadow = options.shadow;
    this.#renderer = options.renderer;
    (options.renderer as Renderer).shadowMap.transmitted = true;
    this.#ready = options.ready;
    this.#done = options.done;
  }

  #box(name: string, x: number, z: number): Mesh {
    const material = new MeshStandardNodeMaterial({ color: 0xcccccc });
    material.castShadowNode = vec4(1, 0, 0, 0.5);
    const mesh = new Mesh(new BoxGeometry(3, 6, 3), material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.set(x, 3, z);
    mesh.name = name;
    this.#boxes.set(name, mesh);
    return mesh;
  }

  /**
   * Travel `metres` along the light, so the page window stands still and only the depth centre
   * moves: the camera a level keeps its map from is then somewhere else along its own axis, which
   * the pinned `lightDistance` of this scene cannot show. The clipmap's own basis is the light axis
   * this node places every camera on; the light's world position is only a direction when its target
   * sits at the origin.
   */
  async #travelAlongLight(metres: number): Promise<void> {
    this.cameraOffset.addScaledVector(this.#shadow.clipmap.basisW, metres);
    await this.#frames(2);
  }

  #frames(count: number): Promise<void> {
    const start = this.#shadow.stats.frame;
    return new Promise((resolve) => {
      const wait = (): void => {
        if (this.#shadow.stats.frame - start >= count) resolve();
        else requestAnimationFrame(wait);
      };
      wait();
    });
  }

  /** Idle: the world is loaded, and no level has rendered for a run of frames. */
  async #settled(): Promise<void> {
    let quiet = 0;
    let renders = this.#shadow.stats.rendersTotal;
    while (quiet < 20) {
      await this.#frames(1);
      const stats = this.#shadow.stats;
      if (this.#ready() && stats.rendersTotal === renders && stats.deferred === 0) quiet += 1;
      else quiet = 0;
      renders = stats.rendersTotal;
    }
  }

  async #finestDepth(): Promise<Float32Array> {
    const map = this.#shadow.levelNodes[0] as unknown as {
      shadowMap: { depthTexture: unknown };
    };
    return readDepth(this.#renderer, map.shadowMap.depthTexture);
  }

  async #finestColor(): Promise<Uint8Array> {
    const map = this.#shadow.levelNodes[0] as unknown as { shadowMap: RenderTarget };
    const size = this.#shadow.options.mapSize[0] as number;
    return (await (this.#renderer as Renderer).readRenderTargetPixelsAsync(
      map.shadowMap,
      0,
      0,
      size,
      size,
    )) as Uint8Array;
  }

  /** One step: change the scene, let the levels redraw it, then redraw it whole and compare. */
  async #step(name: string, change: () => void, before: Float32Array): Promise<Float32Array> {
    const stats = this.#shadow.stats;
    const start = {
      byAdmission: stats.byAdmission,
      byEviction: stats.byEviction,
      pagesRedrawn: stats.pagesRedrawn,
      rendersTotal: stats.rendersTotal,
    };
    if (name === "Eviction") {
      const color = await this.#finestColor();
      let red = 0;
      for (let at = 0; at < color.length; at += 4) {
        if ((color[at] ?? 0) > 0 && (color[at + 3] ?? 0) > 0) red += 1;
      }
      this.results.shadowPartialEvictionTransmittedTexels = red;
    }
    change();
    // The levels redraw on the frame after the change; wait until they have, then until idle.
    while (this.#shadow.stats.rendersTotal === start.rendersTotal) await this.#frames(1);
    await this.#settled();
    const partialMatrix = (
      this.#shadow.levelLights[0] as DirectionalLight
    ).shadow.matrix.elements.slice();
    const partial = await this.#finestDepth();
    const partialColor = await this.#finestColor();
    const now = this.#shadow.stats;
    this.results[`shadowPartial${name}Renders`] = now.rendersTotal - start.rendersTotal;
    this.results[`shadowPartial${name}Admission`] = now.byAdmission - start.byAdmission;
    this.results[`shadowPartial${name}Eviction`] = now.byEviction - start.byEviction;
    // The total must exclude even one whole redraw; an average can hide a whole + partial mix.
    this.results[`shadowPartial${name}Partial`] = isPartialRedraw(
      now.pagesRedrawn - start.pagesRedrawn,
      now.rendersTotal - start.rendersTotal,
      this.#shadow.clipmap.pagesAt(0),
    )
      ? 1
      : 0;
    this.results[`shadowPartial${name}Changed`] = differing(before, partial);
    // The same scene, redrawn whole.
    const mark = this.#shadow.stats.rendersTotal;
    this.#shadow.invalidateAll();
    while (this.#shadow.stats.rendersTotal === mark) await this.#frames(1);
    await this.#settled();
    const whole = await this.#finestDepth();
    this.results[`shadowPartial${name}MatrixMismatch`] = differing(
      partialMatrix,
      (this.#shadow.levelLights[0] as DirectionalLight).shadow.matrix.elements,
    );
    this.results[`shadowPartial${name}Mismatch`] = differing(partial, whole);
    this.results[`shadowPartial${name}ColorMismatch`] = differing(
      partialColor,
      await this.#finestColor(),
    );
    return whole;
  }

  async run(): Promise<void> {
    this.results.shadowPartialMapSize = this.#shadow.options.mapSize[0] as number;
    // A visible receiver compiles the shadow node before its frame counter can advance.
    const receiver = this.#box("receiver", -30, 0);
    receiver.castShadow = false;
    this.#scene.add(receiver);
    this.#scene.updateMatrixWorld(true);
    await this.#settled();
    // The first whole map, from this scene as it stands.
    this.#shadow.invalidateAll();
    await this.#frames(2);
    await this.#settled();
    const baseline = await this.#finestDepth();
    let depth = await this.#step(
      "Admission",
      () => this.#scene.add(this.#box("a", -34, 6)),
      baseline,
    );
    // Two asks in one redraw: a removal (cleared, then redrawn) and an admission (just drawn).
    depth = await this.#step(
      "Mixed",
      () => {
        const gone = this.#boxes.get("a");
        if (gone !== undefined) this.#scene.remove(gone);
        this.#scene.add(this.#box("b", -26, -8));
      },
      depth,
    );
    depth = await this.#step(
      "Eviction",
      () => {
        const gone = this.#boxes.get("b");
        if (gone !== undefined) this.#scene.remove(gone);
      },
      depth,
    );
    // Removing what the baseline never held must put the baseline back, texel for texel.
    this.results.shadowPartialRestoredMismatch = differing(baseline, depth);
    // Last, because the camera never comes back: every map after it was drawn somewhere else.
    const travelledStart = {
      byMove: this.#shadow.stats.byMove,
      windowSteps: this.#shadow.stats.windowSteps,
    };
    const travelledDepthOffset = Math.fround(
      (this.#shadow.levelLights[0] as DirectionalLight).shadow.matrix.elements[14] as number,
    );
    await this.#travelAlongLight(6);
    await this.#step("Travelled", () => this.#scene.add(this.#box("c", -30, 10)), depth);
    this.results.shadowPartialTravelledMoves = this.#shadow.stats.byMove - travelledStart.byMove;
    this.results.shadowPartialTravelledWindowSteps =
      this.#shadow.stats.windowSteps - travelledStart.windowSteps;
    this.results.shadowPartialTravelledDepthChanged =
      Math.fround(
        (this.#shadow.levelLights[0] as DirectionalLight).shadow.matrix.elements[14] as number,
      ) === travelledDepthOffset
        ? 0
        : 1;
    this.results.shadowPartialDone = 1;
    this.#done();
  }
}
