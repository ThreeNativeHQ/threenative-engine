/**
 * Per-pass GPU time on any WebGPU page, for the perf lane: the device asks for timestamp-query, every pass that has
 * no timestamp writes gets some, each submit resolves them into a pooled readback buffer, and while
 * `__tnGpuPasses` is a Map each pass adds its time to "<kind> <target WxH format> <label>". Ported from the
 * profile:wasm-page --gpu-passes of lane/ne-hygiene (2af9b0db0), which the PRD-573 squash did not carry. A submit
 * with no free readback buffer goes untimed: its passes count and take the mean of their timed runs.
 * Use: TN_UNREAL_LOOK_GPU_PASSES=1 on `unreal-look:capture --measure`; it writes `<cell>.gpu-passes.json`.
 */
import type { Page } from "@playwright/test";

export const GPU_PASSES = `(() => {
  // tsx names the arrow functions of readPasses with a helper the page lacks.
  globalThis.__name ??= (fn) => fn;
  const adapterProto = globalThis.GPUAdapter?.prototype;
  if (!adapterProto) return;
  const devices = new WeakMap(), encoders = new WeakMap(), views = new WeakMap();
  const requestDevice = adapterProto.requestDevice;
  adapterProto.requestDevice = async function (desc = {}) {
    const features = [...(desc.requiredFeatures ?? [])];
    if (this.features.has("timestamp-query") && !features.includes("timestamp-query")) features.push("timestamp-query");
    const device = await requestDevice.call(this, { ...desc, requiredFeatures: features });
    if (device.features.has("timestamp-query")) {
      const capacity = 1024;
      devices.set(device.queue, { device, capacity, cursor: 0, pending: [], free: [],
        querySet: device.createQuerySet({ type: "timestamp", count: capacity }),
        resolve: device.createBuffer({ size: capacity * 8, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC }) });
    }
    return device;
  };
  const deviceProto = GPUDevice.prototype;
  const createCommandEncoder = deviceProto.createCommandEncoder;
  deviceProto.createCommandEncoder = function (...args) {
    const encoder = createCommandEncoder.apply(this, args);
    const state = devices.get(this.queue);
    if (state) encoders.set(encoder, state);
    return encoder;
  };
  const createView = GPUTexture.prototype.createView;
  GPUTexture.prototype.createView = function (...args) {
    const view = createView.apply(this, args);
    views.set(view, this.width + "x" + this.height + " " + this.format);
    return view;
  };
  const getCurrentTexture = GPUCanvasContext.prototype.getCurrentTexture;
  const timed = (kind, original) => function (desc = {}) {
    const state = encoders.get(this);
    if (!globalThis.__tnGpuPasses || !state || desc.timestampWrites || state.cursor + 2 > state.capacity) return original.call(this, desc);
    const at = state.cursor;
    state.cursor += 2;
    const target = desc.colorAttachments?.[0]?.view ?? desc.depthStencilAttachment?.view;
    state.pending.push(kind + " " + (target ? views.get(target) ?? "canvas" : "-") + (desc.label ? " " + desc.label : ""));
    return original.call(this, { ...desc, timestampWrites: { querySet: state.querySet, beginningOfPassWriteIndex: at, endOfPassWriteIndex: at + 1 } });
  };
  GPUCommandEncoder.prototype.beginRenderPass = timed("render", GPUCommandEncoder.prototype.beginRenderPass);
  GPUCommandEncoder.prototype.beginComputePass = timed("compute", GPUCommandEncoder.prototype.beginComputePass);
  const submit = GPUQueue.prototype.submit;
  GPUQueue.prototype.submit = function (buffers) {
    const state = devices.get(this);
    if (!state || state.pending.length === 0) return submit.call(this, buffers);
    const names = state.pending, count = state.cursor;
    state.pending = [];
    state.cursor = 0;
    let read = state.free.pop();
    if (!read && (state.made ?? 0) < 16) {
      state.made = (state.made ?? 0) + 1;
      read = state.device.createBuffer({ size: state.capacity * 8, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    }
    if (!read) {
      const totals = globalThis.__tnGpuPasses;
      for (const name of names) {
        const row = totals?.get(name) ?? { ms: 0, n: 0, untimed: 0 };
        row.untimed += 1;
        totals?.set(name, row);
      }
      return submit.call(this, buffers);
    }
    const encoder = createCommandEncoder.call(state.device);
    encoder.resolveQuerySet(state.querySet, 0, count, state.resolve, 0);
    encoder.copyBufferToBuffer(state.resolve, 0, read, 0, count * 8);
    const result = submit.call(this, [...buffers, encoder.finish()]);
    read.mapAsync(GPUMapMode.READ, 0, count * 8).then(() => {
      const ns = new BigUint64Array(read.getMappedRange(0, count * 8));
      const totals = globalThis.__tnGpuPasses;
      for (let i = 0; totals && i < names.length; ++i) {
        const ms = ns[2 * i + 1] > ns[2 * i] ? Number(ns[2 * i + 1] - ns[2 * i]) / 1e6 : 0;
        const row = totals.get(names[i]) ?? { ms: 0, n: 0, untimed: 0 };
        row.ms += ms; row.n += 1;
        totals.set(names[i], row);
      }
      read.unmap();
      state.free.push(read);
    }, () => {});
    return result;
  };
})();`;

export interface IPassRow {
  readonly name: string;
  /** Mean GPU ms of one run times how often it ran per rendered frame. */
  readonly ms: number;
  readonly perFrame: number;
}

/** Collects the passes of  of drawn frames; undefined when the page has no timestamp-query. */
export async function readPasses(page: Page, seconds: number): Promise<IPassRow[] | undefined> {
  return page.evaluate(
    (duration) =>
      new Promise<IPassRow[] | undefined>((resolve) => {
        type Row = { ms: number; n: number; untimed: number };
        const g = globalThis as { __tnGpuPasses?: Map<string, Row> };
        g.__tnGpuPasses = new Map();
        let frames = 0;
        const end = performance.now() + duration * 1000;
        const step = () => {
          frames += 1;
          if (performance.now() < end) {
            requestAnimationFrame(step);
            return;
          }
          const rows = [...(g.__tnGpuPasses as Map<string, Row>)].filter(([, row]) => row.n > 0);
          g.__tnGpuPasses = undefined;
          const perPass = ([name, row]: [string, Row]) => {
            const perFrame = (row.n + row.untimed) / frames;
            return { name, ms: (row.ms / row.n) * perFrame, perFrame };
          };
          resolve(rows.length === 0 ? undefined : rows.map(perPass).sort((x, y) => y.ms - x.ms));
        };
        requestAnimationFrame(step);
      }),
    seconds,
  );
}
