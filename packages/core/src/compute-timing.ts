/** Exact per-call timings from Three 0.185.1's compute pool; Three owns all GPU resources. */
export interface IComputeTimingSample {
  readonly call: number;
  readonly uid: string;
  readonly gpuMs: number;
}
export interface IComputeTimingReceipt {
  readonly generation: object;
  readonly calls: readonly number[];
  /** Incomplete membership is absent; a completed receipt can be consumed only once. */
  read(): readonly IComputeTimingSample[] | undefined;
}
interface IQueryPool {
  readonly queryOffsets: Map<string, number>;
  readonly timestamps: Map<string, number>;
  readonly maxQueries: number;
  readonly currentQueryIndex: number;
  readonly isDisposed: boolean;
  readonly trackTimestamp: boolean;
}
interface IComputeSource {
  readonly info: { frame: number };
  readonly backend: {
    readonly isWebGPUBackend: true;
    readonly device: object;
    trackTimestamp: boolean;
    readonly timestampQueryPool?: { readonly compute?: IQueryPool | null };
  };
  compute(node: unknown): unknown;
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function thenable(value: unknown): boolean {
  return (object(value) || typeof value === "function") && "then" in value;
}
function source(value: unknown): IComputeSource {
  if (!object(value) || !object(value.backend) || !object(value.info))
    throw new Error("TN_COMPUTE_TIMING_UNSUPPORTED: initialized renderer fields are absent.");
  const backend = value.backend;
  const device = backend.device;
  if (
    backend.isWebGPUBackend !== true ||
    typeof backend.trackTimestamp !== "boolean" ||
    !object(device) ||
    !object(device.features) ||
    typeof device.features.has !== "function" ||
    device.features.has("timestamp-query") !== true ||
    typeof value.compute !== "function" ||
    !Number.isSafeInteger(value.info.frame) ||
    Number(value.info.frame) < 0
  )
    throw new Error(
      "TN_COMPUTE_TIMING_UNSUPPORTED: initialized WebGPU timestamp queries are required.",
    );
  // quality-allow: the guard above proved every field of IComputeSource that the renderer needs.
  return value as unknown as IComputeSource;
}
function poolOf(raw: IComputeSource): IQueryPool | undefined {
  const pool = raw.backend.timestampQueryPool?.compute;
  if (pool === undefined || pool === null) return undefined;
  if (
    !(pool.queryOffsets instanceof Map) ||
    !(pool.timestamps instanceof Map) ||
    typeof pool.isDisposed !== "boolean" ||
    typeof pool.trackTimestamp !== "boolean" ||
    !Number.isSafeInteger(pool.maxQueries) ||
    pool.maxQueries < 2 ||
    pool.maxQueries % 2 !== 0 ||
    !Number.isSafeInteger(pool.currentQueryIndex) ||
    pool.currentQueryIndex < 0 ||
    pool.currentQueryIndex > pool.maxQueries ||
    pool.currentQueryIndex % 2 !== 0
  )
    throw new Error(
      "TN_COMPUTE_TIMING_UNSUPPORTED: compute query maps and capacity are unavailable.",
    );
  return pool;
}
function checkQueryCapacity(pool: IQueryPool | undefined): void {
  if (pool === undefined) return; // Three allocates its first pool lazily.
  if (pool.isDisposed) throw new Error("TN_COMPUTE_TIMING_STALE: compute pool retired.");
  if (!pool.trackTimestamp)
    throw new Error("TN_COMPUTE_TIMING_UNSUPPORTED: compute pool tracking disabled.");
  if (pool.currentQueryIndex + 2 > pool.maxQueries)
    throw new Error(`TN_COMPUTE_TIMING_CAPACITY: query pair exceeds ${pool.maxQueries}.`);
}
function allocated(
  raw: IComputeSource,
  before: ReadonlySet<string>,
  call: number,
): { pool: IQueryPool; uid: string } {
  const pool = poolOf(raw);
  if (pool === undefined) throw new Error("TN_COMPUTE_TIMING_MISSING: no compute pool allocated.");
  const added = [...pool.queryOffsets.keys()].filter((uid) => !before.has(uid));
  const uid = added[0];
  const offset = uid === undefined ? undefined : pool.queryOffsets.get(uid);
  if (
    added.length !== 1 ||
    typeof uid !== "string" ||
    !uid.endsWith(`:f${call}`) ||
    !Number.isSafeInteger(offset) ||
    Number(offset) < 0 ||
    Number(offset) % 2 !== 0 ||
    Number(offset) + 2 > pool.maxQueries ||
    raw.info.frame !== call
  )
    throw new Error(
      `TN_COMPUTE_TIMING_MISSING: call ${call} allocated ${added.length} valid query UIDs.`,
    );
  if (pool.timestamps.has(uid))
    throw new Error("TN_COMPUTE_TIMING_DUPLICATE: query UID already resolved.");
  return { pool, uid };
}
function maximumCalls(operation: unknown, options: unknown): number {
  if (
    typeof operation !== "function" ||
    !object(options) ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => key !== "maxCalls")
  )
    throw new Error(
      "TN_COMPUTE_TIMING_CAPACITY: operation and named maxCalls options are required.",
    );
  const maximum = options.maxCalls === undefined ? 64 : options.maxCalls;
  if (typeof maximum !== "number" || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 64)
    throw new Error(`TN_COMPUTE_TIMING_CAPACITY: maxCalls ${String(maximum)}; expected 1..64.`);
  return maximum;
}
function restore(
  raw: IComputeSource,
  descriptor: PropertyDescriptor | undefined,
  tracking: boolean,
): unknown[] {
  const errors: unknown[] = [];
  try {
    const restored =
      descriptor === undefined
        ? Reflect.deleteProperty(raw, "compute")
        : Reflect.defineProperty(raw, "compute", descriptor);
    if (!restored) throw new Error("Original compute descriptor was not restored.");
  } catch (error) {
    errors.push(error);
  }
  try {
    raw.backend.trackTimestamp = tracking;
  } catch (error) {
    errors.push(error);
  }
  return errors;
}

/** Lazy and opt-in: ordinary compute calls receive no wrapper, allocation or extra branch. */
export class ComputeTimingScopes {
  readonly #readSource: () => unknown;
  readonly #generation = Object.freeze({});
  #disposed = false;
  #active = false;
  #failed = false;
  #failure: unknown;
  #raw: IComputeSource | undefined;
  #device: object | undefined;
  #pool: IQueryPool | undefined;
  #offsets: Map<string, number> | undefined;
  #timestamps: Map<string, number> | undefined;
  #lastCall = -1;

  constructor(readSource: () => unknown) {
    this.#readSource = readSource;
  }

  #bindPool(pool: IQueryPool | undefined): void {
    if (this.#pool !== undefined || pool === undefined) return;
    this.#pool = pool;
    this.#offsets = pool.queryOffsets;
    this.#timestamps = pool.timestamps;
  }
  #current(raw: IComputeSource): void {
    if (
      this.#disposed ||
      this.#readSource() !== raw ||
      raw !== this.#raw ||
      raw.backend.device !== this.#device ||
      // Three's own animation loop rewrites info.frame lower every rAF; per-call order is checked in #compute.
      !Number.isSafeInteger(raw.info.frame)
    )
      throw new Error("TN_COMPUTE_TIMING_STALE: renderer, device or compute frame changed.");
    const pool = poolOf(raw);
    if (
      this.#pool !== undefined &&
      (pool !== this.#pool ||
        pool.isDisposed ||
        pool.queryOffsets !== this.#offsets ||
        pool.timestamps !== this.#timestamps)
    )
      throw new Error("TN_COMPUTE_TIMING_STALE: compute pool or query maps changed.");
  }
  #compute(
    raw: IComputeSource,
    original: IComputeSource["compute"],
    node: unknown,
    captured: { call: number; uid: string }[],
    maxCalls: number,
  ): unknown {
    this.#current(raw);
    if (captured.length >= maxCalls)
      throw new Error(`TN_COMPUTE_TIMING_CAPACITY: compute calls exceed ${maxCalls}.`);
    const pool = poolOf(raw);
    checkQueryCapacity(pool); // Three's exhausted allocator otherwise passes null into timestampWrites.
    const call = raw.info.frame;
    if (call <= this.#lastCall)
      throw new Error("TN_COMPUTE_TIMING_STALE: compute call frame was reused.");
    const before = new Set(pool?.queryOffsets.keys());
    this.#lastCall = call; // Reserve it even if the dispatch throws and its caller catches the failure.
    raw.backend.trackTimestamp = true; // Core's sampler has already run for this call.
    const result = original.call(raw, node);
    if (thenable(result))
      throw new Error("TN_COMPUTE_TIMING_ASYNC: compute must already be warmed.");
    const query = allocated(raw, before, call);
    this.#bindPool(query.pool);
    this.#current(raw);
    captured.push({ call, uid: query.uid });
    return result;
  }

  capture(
    operation: () => unknown,
    options: { readonly maxCalls?: number } = {},
  ): IComputeTimingReceipt {
    if (this.#disposed)
      throw new Error("TN_COMPUTE_TIMING_STALE: renderer timing generation retired.");
    if (this.#active) {
      this.#failed = true;
      this.#failure = new Error("TN_COMPUTE_TIMING_NESTED: synchronous scopes cannot nest.");
      throw this.#failure;
    }
    const maxCalls = maximumCalls(operation, options);
    const raw = source(this.#readSource());
    this.#raw ??= raw;
    this.#device ??= raw.backend.device;
    this.#bindPool(poolOf(raw));
    this.#current(raw);
    const original = raw.compute;
    const descriptor = Object.getOwnPropertyDescriptor(raw, "compute");
    const tracking = raw.backend.trackTimestamp;
    const captured: { call: number; uid: string }[] = [];
    const token = { active: true };
    let installed = false;
    let failed = false;
    let failure: unknown;
    let cleanup: unknown[] = [];
    this.#active = true;
    this.#failed = false;
    this.#failure = undefined;
    try {
      installed = Reflect.set(raw, "compute", (node: unknown) => {
        if (!token.active) throw new Error("TN_COMPUTE_TIMING_STALE: capture scope has ended.");
        try {
          return this.#compute(raw, original, node, captured, maxCalls);
        } catch (error) {
          this.#failed = true;
          this.#failure = error;
          throw error;
        }
      });
      if (!installed || raw.compute === original)
        throw new Error("TN_COMPUTE_TIMING_UNSUPPORTED: compute method cannot be scoped.");
      const result = operation();
      if (thenable(result))
        throw new Error("TN_COMPUTE_TIMING_ASYNC: operation must complete synchronously.");
      if (this.#failed) throw this.#failure;
      this.#current(raw);
      if (captured.length === 0)
        throw new Error("TN_COMPUTE_TIMING_MISSING: scope dispatched no compute calls.");
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      token.active = false;
      if (installed) cleanup = restore(raw, descriptor, tracking);
      this.#active = false;
      if (cleanup.length > 0) this.#disposed = true; // Any retained wrapper now rejects before dispatch.
    }
    if (cleanup.length > 0)
      throw new AggregateError(
        failed ? [failure, ...cleanup] : cleanup,
        "TN_COMPUTE_TIMING_RESTORE: timing generation retired after restoration failed.",
      );
    if (failed) throw failure;
    let consumed = false;
    const queries = Object.freeze(captured.map((sample) => Object.freeze(sample)));
    return Object.freeze({
      generation: this.#generation,
      calls: Object.freeze(queries.map((sample) => sample.call)),
      read: (): readonly IComputeTimingSample[] | undefined => {
        this.#current(raw);
        if (consumed) throw new Error("TN_COMPUTE_TIMING_DUPLICATE: receipt already consumed.");
        const pool = this.#pool;
        if (pool === undefined)
          throw new Error("TN_COMPUTE_TIMING_MISSING: compute query pool is absent.");
        const samples: IComputeTimingSample[] = [];
        for (const sample of queries) {
          if (!pool.timestamps.has(sample.uid)) return undefined;
          const gpuMs = pool.timestamps.get(sample.uid);
          if (typeof gpuMs !== "number" || !Number.isFinite(gpuMs) || gpuMs <= 0)
            throw new Error(`TN_COMPUTE_TIMING_INVALID: query ${sample.uid} duration ${gpuMs}.`);
          samples.push(Object.freeze({ ...sample, gpuMs }));
        }
        consumed = true;
        return Object.freeze(samples);
      },
    });
  }

  dispose(): void {
    this.#disposed = true;
  }
}
