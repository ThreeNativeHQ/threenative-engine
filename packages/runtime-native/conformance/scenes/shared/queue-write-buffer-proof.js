export async function verifyQueueWriteBuffer(device) {
  if (!device?.queue || typeof device.createBuffer !== "function") {
    throw new Error("writeBuffer proof requires a real GPU device");
  }
  const buffer = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });
  const readback = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const failures = [];
  try {
    device.queue.writeBuffer(buffer, 0, new Uint32Array([11, 22, 33, 44]));
    const source = new Uint32Array([99]);
    const emptyWrites = [
      [new Uint8Array(0)],
      [new ArrayBuffer(0)],
      [new DataView(new ArrayBuffer(0))],
      [source, 0, 0],
      [source, 1, 0],
    ];
    for (const args of emptyWrites) {
      try {
        if (device.queue.writeBuffer(buffer, 0, ...args) !== undefined) {
          failures.push("zero-length write did not return undefined");
        }
      } catch (error) {
        failures.push(`zero-length ${args[0].constructor.name}: ${String(error.message || error)}`);
      }
    }
    const invalidSources = [
      [source, -1],
      [source, 0, 2],
      [{}],
      [{ byteLength: 0 }],
      [new Uint8Array(0), 1],
      [new ArrayBuffer(0), 0, 1],
      [new DataView(new ArrayBuffer(0)), 1],
    ];
    for (const args of invalidSources) {
      let rejected = false;
      try {
        device.queue.writeBuffer(buffer, 0, ...args);
      } catch {
        rejected = true;
      }
      if (!rejected) failures.push("invalid nonempty source was accepted");
    }
    device.queue.writeBuffer(buffer, 8, new Uint32Array([55, 66]));
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(buffer, 0, readback, 0, 16);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const observed = Array.from(new Uint32Array(readback.getMappedRange()));
    readback.unmap();
    if (observed.join(",") !== "11,22,55,66") {
      failures.push(`nonzero writes or no-op preservation failed: ${observed}`);
    }
    if (failures.length) throw new Error(failures.join("; "));
    return {
      emptyWrites: emptyWrites.length,
      invalidSourcesRejected: invalidSources.length,
      observed,
    };
  } finally {
    buffer.destroy();
    readback.destroy();
  }
}
