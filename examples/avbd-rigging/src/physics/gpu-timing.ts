import { requiredAt } from "./vendor/required-at.js";

export interface IGpuTimingReceipt {
  readonly generation: object;
  readonly tick: number;
  /** Nanoseconds relative to the first marker; absent until the entire batch has landed. */
  read(): readonly number[] | undefined;
}
export interface IGpuTimingTick {
  stamp(encoder: GPUCommandEncoder, index: number): void;
  writes(begin: number, end: number): GPUComputePassTimestampWrites;
  bookend(index: number): void;
  finish(): IGpuTimingReceipt;
  /** A failed donor pass retires this timing generation, including already completed receipts. */
  abort(cause: unknown): never;
}
interface IRow {
  tick: number;
  values?: readonly number[];
}
interface IBatch {
  queries: GPUQuerySet;
  resolve: GPUBuffer;
  read: GPUBuffer;
  rows: IRow[];
  busy: boolean;
}

function relativeStamps(stamps: BigUint64Array): readonly number[] {
  const first = requiredAt(stamps, 0);
  if (first === 0n) throw new Error("TN_AVBD_TIMING_INVALID: missing first timestamp.");
  const relative: number[] = [];
  let previous = first;
  for (const value of stamps) {
    if (value < previous) throw new Error("TN_AVBD_TIMING_INVALID: timestamps moved backwards.");
    const nanoseconds = Number(value - first);
    if (!Number.isSafeInteger(nanoseconds))
      throw new Error("TN_AVBD_TIMING_INVALID: timestamp span exceeds safe representation.");
    relative.push(nanoseconds);
    previous = value;
  }
  if (requiredAt(relative, stamps.length - 1) <= 0)
    throw new Error("TN_AVBD_TIMING_INVALID: total interval must be positive.");
  return Object.freeze(relative);
}

/** Bounded async timestamps on the borrowed device. The allocation scope owns every handle. */
export class GpuTimingBatches {
  readonly #device: GPUDevice;
  readonly #generation = Object.freeze({});
  readonly #stamps: number;
  readonly #ticksPerBatch: number;
  readonly #batches: IBatch[] = [];
  readonly #pending = new Set<Promise<void>>();
  #active: IBatch | undefined;
  #open = false;
  #retired = false;
  #accepting = true;
  #lastTick = -1;
  #count = 0;
  #failed = false;
  #failure: unknown;

  constructor(device: GPUDevice, stamps: number) {
    if (!Number.isSafeInteger(stamps) || stamps < 2 || stamps > 16)
      throw new Error("TN_AVBD_TIMING_CAPACITY: expected 2..16 stamps per tick.");
    if (
      device === null ||
      typeof device !== "object" ||
      typeof device.features?.has !== "function" ||
      device.features.has("timestamp-query") !== true ||
      typeof device.createQuerySet !== "function" ||
      typeof device.createBuffer !== "function" ||
      typeof device.createCommandEncoder !== "function" ||
      typeof device.queue?.submit !== "function"
    )
      throw new Error("TN_AVBD_TIMING_UNSUPPORTED: timestamp-query is required.");
    this.#device = device;
    this.#stamps = stamps;
    this.#ticksPerBatch = Math.floor(64 / stamps);
    const count = this.#ticksPerBatch * stamps;
    for (let batch = 0; batch < 4; batch++) {
      this.#batches.push({
        queries: device.createQuerySet({ type: "timestamp", count }),
        resolve: device.createBuffer({
          label: "rigging timing resolve",
          size: count * 8,
          usage: 516,
        }),
        read: device.createBuffer({ label: "rigging timing read", size: count * 8, usage: 9 }),
        rows: [],
        busy: false,
      });
    }
  }

  #live(): void {
    if (this.#retired) throw new Error("TN_AVBD_TIMING_STALE: timing generation retired.");
    if (this.#failed) throw this.#failure;
  }
  #invalidate(error: unknown): never {
    this.#failed = true;
    this.#failure = error;
    throw error;
  }

  #gpu<T>(operation: () => T): T {
    this.#live();
    try {
      return operation();
    } catch (cause) {
      return this.#invalidate(new Error(`TN_AVBD_TIMING_GPU: ${String(cause)}`, { cause }));
    }
  }

  begin(tick: number): IGpuTimingTick {
    this.#live();
    if (!this.#accepting) throw new Error("TN_AVBD_TIMING_SEALED: final window is settling.");
    if (this.#open || !Number.isSafeInteger(tick) || tick < 0 || tick <= this.#lastTick)
      throw new Error("TN_AVBD_TIMING_MEMBERSHIP: nested, invalid or reused tick.");
    if (this.#count >= 12_000)
      throw new Error("TN_AVBD_TIMING_CAPACITY: bounded receipt capacity 12000 exceeded.");
    this.#active ??= this.#batches.find((batch) => !batch.busy && batch.rows.length === 0);
    const batch = this.#active;
    if (batch === undefined)
      return this.#invalidate(
        new Error("TN_AVBD_TIMING_CAPACITY: all four query batches are busy."),
      );
    this.#lastTick = tick;
    this.#count += 1;
    this.#open = true;
    const row: IRow = { tick };
    const offset = batch.rows.length * this.#stamps;
    const used = new Set<number>();
    let active = true;
    const liveCapture = () => {
      this.#live();
      if (!active) throw new Error("TN_AVBD_TIMING_STALE: tick capture ended.");
    };
    const indexOf = (index: number) => {
      liveCapture();
      if (!Number.isSafeInteger(index) || index < 0 || index >= this.#stamps || used.has(index))
        return this.#invalidate(
          new Error("TN_AVBD_TIMING_MEMBERSHIP: invalid or duplicate stamp."),
        );
      used.add(index);
      return offset + index;
    };
    const stamp = (encoder: GPUCommandEncoder, index: number) => {
      liveCapture();
      return this.#gpu(() => {
        const pass = encoder.beginComputePass({
          label: "rigging queue marker",
          timestampWrites: { querySet: batch.queries, beginningOfPassWriteIndex: indexOf(index) },
        });
        pass.end();
      });
    };
    return Object.freeze({
      stamp,
      writes: (begin: number, end: number) => ({
        querySet: batch.queries,
        beginningOfPassWriteIndex: indexOf(begin),
        endOfPassWriteIndex: indexOf(end),
      }),
      bookend: (index: number) => {
        liveCapture();
        return this.#gpu(() => {
          const encoder = this.#device.createCommandEncoder({ label: "rigging queue bookend" });
          stamp(encoder, index);
          this.#device.queue.submit([encoder.finish()]);
        });
      },
      abort: (cause: unknown): never => {
        liveCapture();
        active = false;
        return this.#invalidate(
          new Error(`TN_AVBD_TIMING_GPU: donor dispatch failed: ${String(cause)}`, { cause }),
        );
      },
      finish: () => {
        liveCapture();
        if (used.size !== this.#stamps)
          return this.#invalidate(
            new Error("TN_AVBD_TIMING_MISSING: incomplete tick stamp coverage."),
          );
        active = false;
        this.#open = false;
        batch.rows.push(row);
        if (batch.rows.length === this.#ticksPerBatch) this.#flush(batch);
        let consumed = false;
        return Object.freeze({
          generation: this.#generation,
          tick,
          read: () => {
            this.#live();
            if (consumed) throw new Error("TN_AVBD_TIMING_DUPLICATE: receipt already consumed.");
            if (row.values !== undefined) consumed = true;
            return row.values;
          },
        });
      },
    });
  }

  #flush(batch: IBatch): void {
    const rows = batch.rows.splice(0);
    if (rows.length === 0) return;
    batch.busy = true;
    this.#active = undefined;
    const count = rows.length * this.#stamps;
    this.#gpu(() => {
      const encoder = this.#device.createCommandEncoder({ label: "rigging timing batch" });
      encoder.resolveQuerySet(batch.queries, 0, count, batch.resolve, 0);
      encoder.copyBufferToBuffer(batch.resolve, 0, batch.read, 0, count * 8);
      this.#device.queue.submit([encoder.finish()]);
    });
    const pending = this.#land(batch, rows);
    this.#pending.add(pending);
    void pending.then(
      () => this.#pending.delete(pending),
      (error: unknown) => {
        this.#pending.delete(pending);
        this.#failed = true;
        this.#failure = error;
      },
    );
  }

  async #land(batch: IBatch, rows: readonly IRow[]): Promise<void> {
    try {
      await batch.read.mapAsync(1);
      const values = new BigUint64Array(batch.read.getMappedRange()).slice();
      if (this.#retired) return; // An old map cannot publish into a retired scene.
      const complete = rows.map((_row, i) => {
        const stamps = values.subarray(i * this.#stamps, (i + 1) * this.#stamps);
        if (stamps.length !== this.#stamps)
          throw new Error("TN_AVBD_TIMING_MISSING: mapped stamp prefix is incomplete.");
        return relativeStamps(stamps);
      });
      for (const [i, row] of rows.entries()) row.values = requiredAt(complete, i);
    } catch (error) {
      this.#failed = true;
      this.#failure = error;
      throw error;
    } finally {
      if (batch.read.mapState === "mapped") batch.read.unmap();
      batch.busy = false;
    }
  }

  /** Called outside fixed/render dispatch at the end of a window; never stalls a tick. */
  async settle(): Promise<void> {
    this.#live();
    if (this.#open) throw new Error("TN_AVBD_TIMING_MISSING: the current tick has not finished.");
    this.#accepting = false;
    if (this.#active !== undefined) this.#flush(this.#active);
    await Promise.all([...this.#pending]);
    this.#live();
  }

  /** The allocation scope waits for these maps before it destroys any owned handles. */
  async retire(): Promise<void> {
    this.#retired = true;
    await Promise.allSettled([...this.#pending]);
  }
}
