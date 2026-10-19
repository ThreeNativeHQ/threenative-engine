/** Own allocations on a borrowed device; the proxy retains the original GPU handles and methods. */
export class GpuResourceScope {
  readonly device: GPUDevice;
  #raw: GPUDevice;
  #buffers = new Set<GPUBuffer>();
  #queries = new Set<GPUQuerySet>();
  #modules: GPUShaderModule[] = [];
  #bytes = 0;
  #maps = new Set<Promise<void>>();
  #maximum: number;
  #sealed = false;
  #ready: Promise<void> | undefined;
  #disposing: Promise<void> | undefined;

  constructor(device: GPUDevice, maximumBytes: number) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 64 * 1024 * 1024)
      throw new Error(`TN_AVBD_CAPACITY: allocation budget ${maximumBytes} exceeds 64 MiB.`);
    if (
      typeof device?.pushErrorScope !== "function" ||
      typeof device.popErrorScope !== "function" ||
      typeof device.queue?.onSubmittedWorkDone !== "function"
    )
      throw new Error(
        "TN_AVBD_UNSUPPORTED: GPU validation scopes and queue completion are required.",
      );
    for (const key of ["maxBufferSize", "maxStorageBufferBindingSize"] as const) {
      if (!Number.isSafeInteger(device.limits?.[key]) || device.limits[key] < 1)
        throw new Error(`TN_AVBD_UNSUPPORTED: ${key} is unavailable.`);
    }
    this.#raw = device;
    this.#maximum = maximumBytes;
    device.pushErrorScope("validation");
    const methods = new Map<PropertyKey, unknown>();
    this.device = new Proxy(device, {
      get: (target, key) => {
        if (key === "destroy")
          return () => {
            throw new Error(
              "TN_AVBD_SHARED_DEVICE: the solver cannot destroy its borrowed device.",
            );
          };
        if (key === "createBuffer")
          return (descriptor: GPUBufferDescriptor) => this.#buffer(descriptor);
        if (key === "createQuerySet")
          return (descriptor: GPUQuerySetDescriptor) => {
            this.#assertLive();
            if (
              !Number.isSafeInteger(descriptor.count) ||
              descriptor.count < 1 ||
              descriptor.count > 64 ||
              this.#queries.size >= 4
            )
              throw new Error(
                `TN_AVBD_CAPACITY: query count ${descriptor.count}; at most 64 per set and four live sets.`,
              );
            const query = target.createQuerySet(descriptor);
            this.#queries.add(query);
            this.#trackDestroy(query, this.#queries, () => undefined);
            return query;
          };
        if (key === "createShaderModule")
          return (descriptor: GPUShaderModuleDescriptor) => {
            this.#assertLive();
            const module = target.createShaderModule(descriptor);
            this.#modules.push(module);
            return module;
          };
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        if (!methods.has(key)) methods.set(key, value.bind(target));
        return methods.get(key);
      },
    });
  }

  get stats(): { buffers: number; bytes: number; querySets: number } {
    return { buffers: this.#buffers.size, bytes: this.#bytes, querySets: this.#queries.size };
  }

  #assertLive(): void {
    if (this.#sealed) throw new Error("TN_AVBD_RELEASED: allocation after scene detach.");
  }

  #buffer(descriptor: GPUBufferDescriptor): GPUBuffer {
    this.#assertLive();
    const size = descriptor.size;
    const maximum =
      (descriptor.usage & 128) === 0
        ? this.#raw.limits.maxBufferSize
        : Math.min(this.#raw.limits.maxBufferSize, this.#raw.limits.maxStorageBufferBindingSize);
    if (
      !Number.isSafeInteger(size) ||
      size < 4 ||
      size % 4 !== 0 ||
      size > maximum ||
      this.#bytes + size > this.#maximum
    )
      throw new Error(
        `TN_AVBD_CAPACITY: ${descriptor.label ?? "buffer"} bytes ${size}; single ${maximum}, owned ${this.#bytes}, budget ${this.#maximum}.`,
      );
    const buffer = this.#raw.createBuffer(descriptor);
    this.#buffers.add(buffer);
    this.#bytes += size;
    this.#trackDestroy(buffer, this.#buffers, () => {
      this.#bytes -= size;
    });
    if (typeof buffer.mapAsync === "function") {
      const map = buffer.mapAsync.bind(buffer);
      try {
        Object.defineProperty(buffer, "mapAsync", {
          configurable: true,
          writable: true,
          value: (mode: GPUMapModeFlags, offset?: number, bytes?: number) => {
            const pending = map(mode, offset, bytes);
            this.#maps.add(pending);
            void pending.then(
              () => this.#maps.delete(pending),
              () => this.#maps.delete(pending),
            );
            return pending;
          },
        });
      } catch (cause) {
        try {
          buffer.destroy();
        } catch (cleanup) {
          throw new AggregateError(
            [cause, cleanup],
            "TN_AVBD_RESOURCE_TRACKING_UNSUPPORTED: map tracking and cleanup failed.",
          );
        }
        throw new Error(
          "TN_AVBD_RESOURCE_TRACKING_UNSUPPORTED: host GPU handles do not permit owned map tracking.",
          { cause },
        );
      }
    }
    return buffer;
  }

  #trackDestroy<T extends { destroy(): void }>(
    resource: T,
    owned: Set<T>,
    released: () => void,
  ): void {
    const destroy = resource.destroy.bind(resource);
    try {
      // Keep the branded GPU object itself: a Proxy GPUBuffer cannot safely cross native bindings.
      Object.defineProperty(resource, "destroy", {
        configurable: true,
        writable: true,
        value: () => {
          if (!owned.has(resource)) return;
          destroy();
          owned.delete(resource);
          released();
        },
      });
    } catch (cause) {
      try {
        destroy();
        owned.delete(resource);
        released();
      } catch (cleanup) {
        throw new AggregateError(
          [cause, cleanup],
          "TN_AVBD_RESOURCE_TRACKING_UNSUPPORTED: untracked allocation remains owned.",
        );
      }
      throw new Error(
        "TN_AVBD_RESOURCE_TRACKING_UNSUPPORTED: host GPU handles do not permit owned destruction tracking.",
        { cause },
      );
    }
  }

  /** Copy through an owned staging buffer; failed maps still release their allocation. */
  async read(buffer: GPUBuffer): Promise<ArrayBuffer> {
    const staging = this.device.createBuffer({
      label: "rigging body readback",
      size: buffer.size,
      usage: 9,
    }); // MAP_READ | COPY_DST
    try {
      const encoder = this.device.createCommandEncoder();
      encoder.copyBufferToBuffer(buffer, 0, staging, 0, buffer.size);
      this.device.queue.submit([encoder.finish()]);
      await staging.mapAsync(1); // GPUMapMode.READ
      return staging.getMappedRange().slice(0);
    } finally {
      if (staging.mapState === "mapped") staging.unmap();
      staging.destroy();
    }
  }

  /** Compile actual donor kernels and close the validation scope before the scene can enter. */
  finish(): Promise<void> {
    if (this.#ready !== undefined) return this.#ready;
    const error = this.#raw.popErrorScope();
    this.#ready = Promise.all([
      error,
      this.#raw.queue.onSubmittedWorkDone(),
      ...this.#modules.map(async (module) => {
        if (typeof module.getCompilationInfo !== "function") return;
        const info = await module.getCompilationInfo();
        const failure = info.messages.find((message) => message.type === "error");
        if (failure !== undefined) throw new Error(`TN_AVBD_INITIALIZATION: ${failure.message}`);
      }),
    ]).then(([failure]) => {
      if (failure !== null)
        throw new Error(
          `TN_AVBD_INITIALIZATION: ${failure?.message ?? "missing GPU validation observation"}`,
        );
    });
    return this.#ready;
  }

  /** Stop allocation immediately; release GPU resources only after submitted use has settled. */
  dispose(): Promise<void> {
    this.#sealed = true;
    if (this.#disposing !== undefined) return this.#disposing;
    this.#disposing = this.#dispose().finally(() => {
      this.#disposing = undefined;
    });
    return this.#disposing;
  }

  async #dispose(): Promise<void> {
    const failures: unknown[] = [];
    try {
      await this.finish();
    } catch (error) {
      failures.push(error);
    }
    try {
      await this.#raw.queue.onSubmittedWorkDone();
    } catch (error) {
      failures.push(error);
    }
    // Donor timestamp maps also use owned buffers; queue completion alone does not settle maps.
    await Promise.allSettled([...this.#maps]);
    for (const buffer of this.#buffers) {
      try {
        buffer.destroy();
        // Normal destruction removes the live allocation through its tracked method.
        // An unsupported nonextensible handle stays owned until this fallback succeeds.
        if (this.#buffers.delete(buffer)) this.#bytes -= buffer.size;
      } catch (error) {
        failures.push(error);
      }
    }
    for (const query of this.#queries) {
      try {
        query.destroy();
        this.#queries.delete(query);
      } catch (error) {
        failures.push(error);
      }
    }
    this.#modules = [];
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        "TN_AVBD_RELEASE: GPU resource cleanup reported an error.",
      );
  }
}
