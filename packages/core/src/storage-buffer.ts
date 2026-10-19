import { StaticDrawUsage } from "three";
import type { StorageBufferAttribute } from "three/webgpu";

/** The standard buffer fields this renderer seam verifies; the device handle stays opaque. */
export interface IRendererStorageBuffer {
  readonly size: number;
  readonly usage: number;
  readonly mapState: string;
  destroy(): void;
}

/** Exclusive allocation receipt. The solver borrows its handles and never destroys them. */
export interface IStorageBufferLease {
  readonly device: object;
  readonly buffer: IRendererStorageBuffer;
  readonly byteLength: number;
  readonly released: boolean;
  assertCurrent(): void;
  dispose(): void;
}

/** Exact Three 0.185.1 attribute-manager contract, confined to the renderer adapter. */
export interface IStorageBufferSource {
  backend?: {
    isWebGPUBackend?: boolean;
    device?: unknown;
    get?: (attribute: StorageBufferAttribute) => unknown;
    destroyAttribute?: (attribute: StorageBufferAttribute) => void;
  };
  _attributes?: {
    update(attribute: StorageBufferAttribute, type: number): void;
    delete(attribute: StorageBufferAttribute): unknown;
    info?: { destroyAttribute(attribute: StorageBufferAttribute): void };
  };
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function deviceLimit(device: unknown): number {
  if (
    !object(device) ||
    typeof device.createBuffer !== "function" ||
    !object(device.queue) ||
    typeof device.queue.writeBuffer !== "function" ||
    !object(device.limits)
  )
    throw new Error("TN_STORAGE_BUFFER_UNSUPPORTED: initialized WebGPU device is required.");
  const { maxBufferSize, maxStorageBufferBindingSize } = device.limits;
  if (
    typeof maxBufferSize !== "number" ||
    !Number.isSafeInteger(maxBufferSize) ||
    maxBufferSize <= 0 ||
    typeof maxStorageBufferBindingSize !== "number" ||
    !Number.isSafeInteger(maxStorageBufferBindingSize) ||
    maxStorageBufferBindingSize <= 0
  )
    throw new Error("TN_STORAGE_BUFFER_UNSUPPORTED: device buffer limits are unavailable.");
  return Math.min(maxBufferSize, maxStorageBufferBindingSize);
}

function validateLayout(attribute: StorageBufferAttribute): Float32Array {
  const a = attribute;
  if (
    a?.isStorageBufferAttribute !== true ||
    !(a.array instanceof Float32Array) ||
    !Number.isSafeInteger(a.version) ||
    a.version < 0 ||
    a.itemSize !== 4 ||
    a.usage !== StaticDrawUsage ||
    !Number.isSafeInteger(a.count) ||
    a.count < 1 ||
    a.array.byteLength !== a.count * 16 ||
    !a.array.every(Number.isFinite)
  )
    throw new Error("TN_STORAGE_BUFFER_LAYOUT: finite Float32 vec4 static storage is required.");
  return a.array;
}

type StorageLayout = { array: Float32Array; bytes: number; count: number; version: number };

function matches(attribute: StorageBufferAttribute, layout: StorageLayout): boolean {
  return (
    attribute.array === layout.array &&
    attribute.array.byteLength === layout.bytes &&
    attribute.count === layout.count &&
    attribute.version === layout.version &&
    attribute.itemSize === 4 &&
    attribute.usage === StaticDrawUsage
  );
}

function bufferAt(source: IStorageBufferSource, attribute: StorageBufferAttribute): unknown {
  const data = source.backend?.get?.(attribute);
  return object(data) ? data.buffer : undefined;
}

function buffer(value: unknown, bytes: number): value is IRendererStorageBuffer {
  // Standard WebGPU usage bits: COPY_SRC=4, COPY_DST=8, STORAGE=128.
  return (
    object(value) &&
    value.size === bytes &&
    typeof value.usage === "number" &&
    (value.usage & 140) === 140 &&
    value.mapState === "unmapped" &&
    typeof value.destroy === "function"
  );
}

function releaseOwned(
  source: IStorageBufferSource,
  attribute: StorageBufferAttribute,
  attributes: NonNullable<IStorageBufferSource["_attributes"]>,
  ownedBuffer: unknown,
): void {
  if (bufferAt(source, attribute) === ownedBuffer) {
    attributes.delete(attribute);
    // Three deletes its manager record before backend destruction. A previous throw leaves
    // the backend allocation alive even though a repeated manager delete now returns null.
    if (bufferAt(source, attribute) === ownedBuffer) {
      if (
        typeof source.backend?.destroyAttribute !== "function" ||
        typeof attributes.info?.destroyAttribute !== "function"
      )
        throw new Error(
          "TN_STORAGE_BUFFER_CLEANUP: backend allocation remains owned; pinned destruction/accounting retry is unavailable.",
        );
      source.backend.destroyAttribute(attribute);
      attributes.info.destroyAttribute(attribute);
      if (bufferAt(source, attribute) === ownedBuffer)
        throw new Error(
          "TN_STORAGE_BUFFER_CLEANUP: backend retained the owned allocation after destruction.",
        );
    }
  } else if (object(ownedBuffer) && typeof ownedBuffer.destroy === "function")
    ownedBuffer.destroy();
}

/** Owns only explicitly leased attributes, including loads aborted before the first draw. */
export class StorageBufferLeases {
  readonly #source: () => IStorageBufferSource;
  readonly #releases = new Map<StorageBufferAttribute, () => void>();
  #disposed = false;

  constructor(source: () => IStorageBufferSource) {
    this.#source = source;
  }

  allocate(attribute: StorageBufferAttribute): IStorageBufferLease {
    if (this.#disposed) throw new Error("TN_STORAGE_BUFFER_DISPOSED: renderer is disposed.");
    if (this.#releases.has(attribute))
      throw new Error("TN_STORAGE_BUFFER_LEASED: attribute is already leased.");
    const array = validateLayout(attribute);
    const source = this.#source();
    const backend = source.backend;
    const attributes = source._attributes;
    if (
      backend?.isWebGPUBackend !== true ||
      typeof backend.get !== "function" ||
      typeof attributes?.update !== "function" ||
      typeof attributes.delete !== "function"
    )
      throw new Error(
        "TN_STORAGE_BUFFER_UNSUPPORTED: pinned WebGPU attribute-manager seam is unavailable.",
      );
    const device = backend.device;
    const maximum = deviceLimit(device);
    const bytes = array.byteLength;
    if (bytes > maximum)
      throw new Error(`TN_STORAGE_BUFFER_CAPACITY: ${bytes} bytes exceeds ${maximum}.`);
    if (bufferAt(source, attribute) !== undefined)
      throw new Error("TN_STORAGE_BUFFER_OWNERSHIP: attribute already has a buffer.");
    // deviceLimit validated this opaque handle. Consumers validate the compute APIs they need.
    if (!object(device))
      throw new Error("TN_STORAGE_BUFFER_UNSUPPORTED: WebGPU device is unavailable.");
    const layout = { array, bytes, count: attribute.count, version: attribute.version };
    let gpuBuffer: unknown;
    try {
      // AttributeType.STORAGE=3 in the pinned Three cohort. This path also records allocation metrics.
      attributes.update(attribute, 3);
      gpuBuffer = bufferAt(source, attribute);
      if (!matches(attribute, layout) || !buffer(gpuBuffer, bytes))
        throw new Error(
          "TN_STORAGE_BUFFER_LAYOUT: backend storage buffer does not match the requested layout.",
        );
    } catch (error) {
      const failedBuffer = bufferAt(source, attribute);
      const release = () => {
        releaseOwned(source, attribute, attributes, failedBuffer);
        this.#releases.delete(attribute);
      };
      this.#releases.set(attribute, release);
      try {
        release();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "TN_STORAGE_BUFFER_CLEANUP: failed allocation remains owned until teardown.",
        );
      }
      throw error;
    }
    const ownedBuffer = gpuBuffer;
    let released = false;
    const lease: IStorageBufferLease = {
      device,
      buffer: ownedBuffer,
      byteLength: bytes,
      get released() {
        return released;
      },
      assertCurrent: () => {
        const current = this.#source();
        if (
          released ||
          this.#disposed ||
          current.backend !== backend ||
          current._attributes !== attributes ||
          backend.device !== device ||
          bufferAt(source, attribute) !== ownedBuffer ||
          !matches(attribute, layout)
        )
          throw new Error(
            "TN_STORAGE_BUFFER_STALE: renderer, device, buffer or attribute changed.",
          );
      },
      dispose: () => {
        if (released) return;
        // Cleanup must work even after the version/layout becomes stale. Never delete a replacement.
        releaseOwned(source, attribute, attributes, ownedBuffer);
        released = true;
        this.#releases.delete(attribute);
      },
    };
    this.#releases.set(attribute, lease.dispose);
    return lease;
  }

  dispose(): void {
    if (this.#disposed && this.#releases.size === 0) return;
    this.#disposed = true;
    const failures: unknown[] = [];
    for (const release of [...this.#releases.values()]) {
      try {
        release();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw failures[0];
  }
}
