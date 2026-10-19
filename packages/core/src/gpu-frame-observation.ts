export interface IGpuFrameObservationOptions {
  readonly maxFrames: number;
  /** Timestamp slots, two per allocated pass; bounds pending plus queued observations. */
  readonly maxQueries: number;
}
export interface IGpuObservedQuery {
  readonly uid: string;
  readonly begin: number;
  readonly end: number;
  readonly ms: number;
}
export interface IGpuObservedFrame {
  readonly generation: number;
  readonly batch: number;
  /** Three render-query frame, which may belong to an overlay; not a world callback ID. */
  readonly frame: number;
  readonly ms: number;
  readonly queries: readonly IGpuObservedQuery[];
}
export interface IGpuFrameObservationStatus {
  readonly generation: number;
  readonly state: "active" | "stopped" | "failed" | "disposed";
  readonly stopFrame: number | undefined;
  readonly maxFrames: number;
  readonly maxQueries: number;
  readonly expectedFrames: number;
  readonly expectedQueries: number;
  readonly resolvedFrames: number;
  readonly resolvedQueries: number;
  readonly deliveredFrames: number;
  readonly deliveredQueries: number;
  readonly pendingFrames: number;
  readonly pendingQueries: number;
  /** Eligible allocated membership waiting behind an older resolve; included in capacity. */
  readonly undrainedFrames: number;
  readonly undrainedQueries: number;
  readonly queuedFrames: number;
  readonly queuedQueries: number;
  readonly droppedFrames: number;
  readonly droppedQueries: number;
  /** Allocation attempts are not instrumented. Saturation cannot prove zero lost queries. */
  readonly allocationLoss: "not-observed" | "unknown-after-saturation";
  readonly ignoredCompletions: number;
  readonly failure: string | undefined;
}
export interface IGpuFrameObservation {
  take(): readonly IGpuObservedFrame[];
  status(): IGpuFrameObservationStatus;
  /** Fence selection now; existing renderer resolves continue draining eligible older frames. */
  stop(): void;
  dispose(): void;
}
interface IPool {
  readonly trackTimestamp: boolean;
  readonly isDisposed: boolean;
  readonly maxQueries: number;
  readonly currentQueryIndex: number;
  readonly queryOffsets: Map<string, number>;
  readonly timestamps: Map<string, number>;
  readonly frames: number[];
  readonly pendingResolve: Promise<unknown> | false | null;
}
interface IMember {
  readonly uid: string;
  readonly begin: number;
  readonly frame: number;
}
interface IBatch {
  readonly pool: IPool;
  readonly previousFrames: number[];
  readonly timestamps: Map<string, number>;
  readonly members: readonly IMember[];
  readonly frames: readonly number[];
  readonly selected: ReadonlyMap<number, readonly IMember[]>;
  readonly slots: number;
}
const PREFIX = "TN_GPU_FRAME_OBSERVATION_";
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value);
function readPool(value: unknown): IPool {
  if (typeof value !== "object" || value === null) throw new Error(`${PREFIX}UNSUPPORTED_POOL`);
  const p = value as Partial<IPool>;
  if (
    p.trackTimestamp !== true ||
    p.isDisposed !== false ||
    !integer(p.maxQueries) ||
    p.maxQueries < 2 ||
    p.maxQueries > 131072 ||
    p.maxQueries % 2 !== 0 ||
    !integer(p.currentQueryIndex) ||
    p.currentQueryIndex < 0 ||
    p.currentQueryIndex > p.maxQueries ||
    p.currentQueryIndex % 2 !== 0 ||
    !(p.queryOffsets instanceof Map) ||
    !(p.timestamps instanceof Map) ||
    !Array.isArray(p.frames) ||
    (p.pendingResolve !== false &&
      p.pendingResolve !== null &&
      !(p.pendingResolve instanceof Promise))
  )
    throw new Error(`${PREFIX}UNSUPPORTED_POOL`);
  return p as IPool;
}

/** Opt-in, read-only observer of the pinned Three render pool. It submits no GPU work. */
export class GpuFrameObservation implements IGpuFrameObservation {
  #state: IGpuFrameObservationStatus["state"] = "active";
  #stopFrame: number | undefined;
  #failure: string | undefined;
  #pool: IPool | undefined;
  #batches = new Map<number, IBatch>();
  #queue: IGpuObservedFrame[] = [];
  #nextBatch = 0;
  #highestFrame = -1;
  #expectedFrames = 0;
  #expectedQueries = 0;
  #resolvedFrames = 0;
  #resolvedQueries = 0;
  #deliveredFrames = 0;
  #deliveredQueries = 0;
  #pendingFrames = 0;
  #pendingQueries = 0;
  #queuedQueries = 0;
  #undrainedFrames = 0;
  #undrainedQueries = 0;
  #droppedFrames = 0;
  #droppedQueries = 0;
  #allocationLoss: IGpuFrameObservationStatus["allocationLoss"] = "not-observed";
  #ignoredCompletions = 0;
  readonly #maxFrames: number;
  readonly #maxQueries: number;
  constructor(
    readonly generation: number,
    readonly firstFrame: number,
    private readonly getPool: () => unknown,
    private readonly getFrame: () => number,
    options: IGpuFrameObservationOptions,
  ) {
    if (
      !integer(generation) ||
      generation < 1 ||
      !integer(firstFrame) ||
      firstFrame < 0 ||
      !integer(options?.maxFrames) ||
      options.maxFrames < 1 ||
      options.maxFrames > 16384 ||
      !integer(options?.maxQueries) ||
      options.maxQueries < 2 ||
      options.maxQueries > 131072 ||
      options.maxQueries % 2 !== 0
    )
      throw new Error(`${PREFIX}LIMITS`);
    this.#maxFrames = options.maxFrames;
    this.#maxQueries = options.maxQueries;
  }
  #fail(reason: string) {
    if (this.#state === "failed" || this.#state === "disposed") return;
    this.#failure = reason.startsWith(PREFIX) ? reason : `${PREFIX}${reason}`;
    this.#state = "failed";
    this.#expectedFrames += this.#undrainedFrames;
    this.#expectedQueries += this.#undrainedQueries;
    this.#droppedFrames += this.#pendingFrames + this.#queue.length + this.#undrainedFrames;
    this.#droppedQueries += this.#pendingQueries + this.#queuedQueries + this.#undrainedQueries;
    this.#clear();
  }
  #clear() {
    this.#batches.clear();
    this.#queue = [];
    this.#pendingFrames =
      this.#pendingQueries =
      this.#queuedQueries =
      this.#undrainedFrames =
      this.#undrainedQueries =
        0;
  }
  #refreshUndrained(): IBatch | undefined {
    const value = this.getPool();
    if (value === undefined && this.#pool === undefined) return;
    const pool = readPool(value);
    if (this.#pool !== undefined && this.#pool !== pool) throw new Error(`${PREFIX}POOL_RESET`);
    this.#pool = pool;
    if (pool.queryOffsets.size * 2 !== pool.currentQueryIndex)
      throw new Error(`${PREFIX}PAIR_CONSERVATION`);
    const used = new Set<number>();
    const members: IMember[] = [];
    const groups = new Map<number, IMember[]>();
    const currentFrame = this.getFrame();
    for (const [uid, begin] of pool.queryOffsets) {
      const match = typeof uid === "string" ? /^r:[^\s]+:f(\d+)$/.exec(uid) : null;
      const frame = Number(match?.[1]);
      if (
        match === null ||
        !integer(frame) ||
        frame < 0 ||
        !integer(begin) ||
        begin < 0 ||
        begin % 2 !== 0 ||
        begin + 1 >= pool.currentQueryIndex ||
        used.has(begin) ||
        !integer(currentFrame) ||
        frame > currentFrame
      )
        throw new Error(`${PREFIX}MEMBERSHIP`);
      if (pool.timestamps.has(uid)) throw new Error(`${PREFIX}REUSED_QUERY`);
      used.add(begin);
      const member = { uid, begin, frame };
      members.push(member);
      const group = groups.get(frame) ?? [];
      group.push(member);
      groups.set(frame, group);
    }
    const frames = [...groups.keys()];
    const selected = new Map(
      [...groups].filter(
        ([frame]) =>
          frame >= this.firstFrame && (this.#stopFrame === undefined || frame <= this.#stopFrame),
      ),
    );
    const slots = [...selected.values()].reduce((sum, group) => sum + group.length * 2, 0);
    this.#undrainedFrames = selected.size;
    this.#undrainedQueries = slots;
    if (pool.currentQueryIndex >= pool.maxQueries) {
      this.#allocationLoss = "unknown-after-saturation";
      throw new Error(`${PREFIX}SATURATED_POOL`);
    }
    if (
      this.#pendingFrames + this.#queue.length + selected.size > this.#maxFrames ||
      this.#pendingQueries + this.#queuedQueries + slots > this.#maxQueries
    )
      throw new Error(`${PREFIX}OVERFLOW`);
    return {
      pool,
      previousFrames: pool.frames,
      timestamps: pool.timestamps,
      members,
      frames,
      selected,
      slots,
    };
  }
  /** Capture before the existing resolve; failure stays on the receipt, never on rendering. */
  capture(): number | undefined {
    if (this.#state === "failed" || this.#state === "disposed") return;
    try {
      const batch = this.#refreshUndrained();
      // Pending older work cannot own the newly queued offsets, which remain counted separately.
      if (batch === undefined || batch.pool.pendingResolve || batch.pool.currentQueryIndex === 0)
        return;
      const selectedFrames = [...batch.selected.keys()];
      if (selectedFrames.some((frame) => frame <= this.#highestFrame))
        throw new Error(`${PREFIX}REPEATED_FRAME`);
      if (selectedFrames.length) this.#highestFrame = Math.max(...selectedFrames);
      this.#expectedFrames += batch.selected.size;
      this.#expectedQueries += batch.slots;
      const id = ++this.#nextBatch;
      this.#batches.set(id, batch);
      this.#pendingFrames += batch.selected.size;
      this.#pendingQueries += batch.slots;
      this.#undrainedFrames = this.#undrainedQueries = 0;
      return id;
    } catch (error) {
      this.#fail(error instanceof Error ? error.message : "CAPTURE_FAILED");
    }
  }
  /** Called immediately after the raw resolve has synchronously drained its allocation map. */
  submitted(id: number | undefined): void {
    if (id === undefined) return;
    const batch = this.#batches.get(id);
    if (batch === undefined) return;
    try {
      const pending = batch.pool.pendingResolve;
      if (
        this.getPool() !== batch.pool ||
        !(pending instanceof Promise) ||
        batch.pool.currentQueryIndex !== 0 ||
        batch.pool.queryOffsets.size !== 0
      ) {
        this.#fail("NOT_SUBMITTED");
        return;
      }
      // Observe the actual pool promise, not a wrapper that may merely return an older lastValue.
      void pending.then(
        () => this.#complete(id),
        () => this.#fail("RESOLVE_REJECTED"),
      );
    } catch (error) {
      this.#fail(error instanceof Error ? error.message : "SUBMISSION_FAILED");
    }
  }
  #complete(id: number) {
    const batch = this.#batches.get(id);
    if (batch === undefined) {
      this.#ignoredCompletions += 1;
      return;
    }
    try {
      const pool = batch.pool;
      if (this.getPool() !== pool || pool.isDisposed || pool.timestamps !== batch.timestamps)
        throw new Error(`${PREFIX}POOL_RESET`);
      if (
        pool.frames === batch.previousFrames ||
        pool.frames.length !== batch.frames.length ||
        pool.frames.some((f, i) => f !== batch.frames[i])
      )
        throw new Error(`${PREFIX}STALE_RESOLUTION`);
      // Fresh publication is atomic in Three. Missing members now cannot be repaired by later maps.
      const values = new Map<string, number>();
      for (const member of batch.members) {
        const ms = pool.timestamps.get(member.uid);
        if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0)
          throw new Error(`${PREFIX}INCOMPLETE_RESOLUTION`);
        values.set(member.uid, ms);
      }
      const samples: IGpuObservedFrame[] = [];
      for (const [frame, group] of batch.selected) {
        const queries = group.map((member) => {
          const ms = values.get(member.uid);
          if (ms === undefined) throw new Error(`${PREFIX}INCOMPLETE_RESOLUTION`);
          return Object.freeze({
            uid: member.uid,
            begin: member.begin,
            end: member.begin + 1,
            ms,
          });
        });
        const ms = queries.reduce((sum, query) => sum + query.ms, 0);
        if (!Number.isFinite(ms)) throw new Error(`${PREFIX}INVALID_DURATION`);
        samples.push(
          Object.freeze({
            generation: this.generation,
            batch: id,
            frame,
            ms,
            queries: Object.freeze(queries),
          }),
        );
      }
      this.#batches.delete(id);
      this.#pendingFrames -= batch.selected.size;
      this.#pendingQueries -= batch.slots;
      this.#resolvedFrames += samples.length;
      this.#resolvedQueries += batch.slots;
      this.#queuedQueries += batch.slots;
      this.#queue.push(...samples);
    } catch (error) {
      this.#fail(error instanceof Error ? error.message : "COMPLETION_FAILED");
    }
  }
  take(): readonly IGpuObservedFrame[] {
    if (this.#state === "failed") throw new Error(this.#failure);
    if (this.#state === "disposed") throw new Error(`${PREFIX}DISPOSED`);
    const samples = this.#queue;
    this.#queue = [];
    this.#deliveredFrames += samples.length;
    this.#deliveredQueries += this.#queuedQueries;
    this.#queuedQueries = 0;
    return Object.freeze(samples);
  }
  status(): IGpuFrameObservationStatus {
    if (this.#state === "active" || this.#state === "stopped") {
      try {
        this.#refreshUndrained();
      } catch (error) {
        this.#fail(error instanceof Error ? error.message : "BACKLOG_FAILED");
      }
    }
    return Object.freeze({
      generation: this.generation,
      state: this.#state,
      stopFrame: this.#stopFrame,
      maxFrames: this.#maxFrames,
      maxQueries: this.#maxQueries,
      expectedFrames: this.#expectedFrames + this.#undrainedFrames,
      expectedQueries: this.#expectedQueries + this.#undrainedQueries,
      resolvedFrames: this.#resolvedFrames,
      resolvedQueries: this.#resolvedQueries,
      deliveredFrames: this.#deliveredFrames,
      deliveredQueries: this.#deliveredQueries,
      pendingFrames: this.#pendingFrames,
      pendingQueries: this.#pendingQueries,
      undrainedFrames: this.#undrainedFrames,
      undrainedQueries: this.#undrainedQueries,
      queuedFrames: this.#queue.length,
      queuedQueries: this.#queuedQueries,
      droppedFrames: this.#droppedFrames,
      droppedQueries: this.#droppedQueries,
      allocationLoss: this.#allocationLoss,
      ignoredCompletions: this.#ignoredCompletions,
      failure: this.#failure,
    });
  }
  stop(): void {
    if (this.#state !== "active") return;
    const frame = this.getFrame();
    if (!integer(frame) || frame < -1) {
      this.#fail("FRAME_RESET");
      return;
    }
    this.#stopFrame = frame;
    this.#state = "stopped";
    try {
      this.#refreshUndrained();
    } catch (error) {
      this.#fail(error instanceof Error ? error.message : "BACKLOG_FAILED");
    }
  }
  dispose(): void {
    if (this.#state === "disposed") return;
    if (this.#state === "active" || this.#state === "stopped") {
      try {
        this.#refreshUndrained();
      } catch (error) {
        this.#fail(error instanceof Error ? error.message : "BACKLOG_FAILED");
      }
    }
    this.#expectedFrames += this.#undrainedFrames;
    this.#expectedQueries += this.#undrainedQueries;
    this.#droppedFrames += this.#pendingFrames + this.#queue.length + this.#undrainedFrames;
    this.#droppedQueries += this.#pendingQueries + this.#queuedQueries + this.#undrainedQueries;
    this.#clear();
    this.#pool = undefined;
    this.#state = "disposed";
  }
}
