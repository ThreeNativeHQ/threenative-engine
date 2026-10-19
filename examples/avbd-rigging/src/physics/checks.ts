import { C_CLASHES, C_CONTACTS, C_OVERFLOW } from "./vendor/avbd2d/gpu/layout.js";
/** Accumulates nonfinite GPU body observations on every tick; sparse CPU samples cannot prove this. */
export class RiggingChecks {
  #device: GPUDevice;
  #bodyCount: number;
  #buffer: GPUBuffer;
  #pipeline: GPUComputePipeline;
  #group: GPUBindGroup;

  constructor(device: GPUDevice, bodies: GPUBuffer, bodyCount: number, solverCounters: GPUBuffer) {
    if (!Number.isSafeInteger(bodyCount) || bodyCount < 1 || bodyCount > 2048)
      throw new Error(`TN_AVBD_CHECKS_CAPACITY: bodies ${bodyCount} must be in 1..2048.`);
    this.#device = device;
    this.#bodyCount = bodyCount;
    this.#buffer = device.createBuffer({
      label: "rigging finite counters",
      size: 24,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(this.#buffer, 0, new Uint32Array(6));
    const module = device.createShaderModule({
      label: "rigging every-tick finite check",
      code: `
@group(0) @binding(0) var<storage, read> bodies: array<vec4<f32>>;
@group(0) @binding(1) var<storage, read_write> counters: array<atomic<u32>>;
@group(0) @binding(2) var<storage, read> solverCounters: array<u32>;
@compute @workgroup_size(256)
fn check(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= ${bodyCount}u) { return; }
  if (id.x == 0u) {
    atomicAdd(&counters[0], 1u);
    atomicOr(&counters[3], solverCounters[${C_OVERFLOW}u]);
    atomicMax(&counters[4], solverCounters[${C_CLASHES}u]);
    atomicMax(&counters[5], solverCounters[${C_CONTACTS}u]);
  }
  let position = bitcast<vec3<u32>>(bodies[id.x * 10u].xyz);
  if (any((position & vec3<u32>(0x7f800000u)) == vec3<u32>(0x7f800000u))) { atomicAdd(&counters[1], 1u); }
  let rotation = bitcast<vec4<u32>>(bodies[id.x * 10u + 1u]);
  if (any((rotation & vec4<u32>(0x7f800000u)) == vec4<u32>(0x7f800000u))) { atomicAdd(&counters[2], 1u); }
}`,
    });
    this.#pipeline = device.createComputePipeline({
      label: "rigging finite check",
      layout: "auto",
      compute: { module, entryPoint: "check" },
    });
    this.#group = device.createBindGroup({
      layout: this.#pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: bodies } },
        { binding: 1, resource: { buffer: this.#buffer } },
        { binding: 2, resource: { buffer: solverCounters } },
      ],
    });
  }

  /** One diagnostic dispatch follows one solver tick, without any awaited readback. */
  process(): void {
    const encoder = this.#device.createCommandEncoder({ label: "rigging finite check" });
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.#pipeline);
    pass.setBindGroup(0, this.#group);
    pass.dispatchWorkgroups(Math.ceil(this.#bodyCount / 256));
    pass.end();
    this.#device.queue.submit([encoder.finish()]);
  }

  async read(): Promise<{
    ticks: number;
    nonfinitePositions: number;
    nonfiniteRotations: number;
    overflow: number;
    colorClashes: number;
    contactsMaximum: number;
    bytes: number;
  }> {
    const staging = this.#device.createBuffer({
      label: "rigging finite readback",
      size: 24,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
    try {
      const encoder = this.#device.createCommandEncoder();
      encoder.copyBufferToBuffer(this.#buffer, 0, staging, 0, 24);
      this.#device.queue.submit([encoder.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const words = new Uint32Array(staging.getMappedRange().slice(0));
      const [
        ticks,
        nonfinitePositions,
        nonfiniteRotations,
        overflow,
        colorClashes,
        contactsMaximum,
      ] = words;
      if (
        ticks === undefined ||
        nonfinitePositions === undefined ||
        nonfiniteRotations === undefined ||
        overflow === undefined ||
        colorClashes === undefined ||
        contactsMaximum === undefined
      )
        throw new Error("TN_AVBD_CHECKS_MISSING: incomplete finite counters.");
      return {
        ticks,
        nonfinitePositions,
        nonfiniteRotations,
        overflow,
        colorClashes,
        contactsMaximum,
        bytes: 24,
      };
    } finally {
      if (staging.mapState === "mapped") staging.unmap();
      staging.destroy();
    }
  }
}
