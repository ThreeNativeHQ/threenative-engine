import type { InstancedBufferAttribute } from "three";

/**
 * The instance records of the world's shared batches, written by one engine call a frame.
 *
 * A shared batch used to write, zero, move and regroup its records in a JS copy of each instance
 * buffer and push every change through `needsUpdate`, which on the owned engine is a bridge crossing
 * per range and per attribute: the 2 km forest walk spent 4.2 ms a frame in the admission drain, 63%
 * of it in the bridge glue around those writes. Now a batch only decides where records go. What
 * happens to the bytes is queued here as ops, and `flush` hands the whole frame to the engine in
 * one `InstancedBufferAttribute.__tnRecords` call, which writes the engine's own buffers and their
 * upload ranges: the batch never reads or holds the bytes. The record boxes the batch publishes as
 * mesh bounds come back from the same call, measured from the bytes as written.
 *
 * Upstream three (`engine: "threejs"`) has no engine to call, so the same ops run on each
 * attribute's own array in {@link applyRecords}, the twin of `bindings_geometry.cpp`'s
 * `applyRecords`.
 *
 * Every op starts with its code and the attribute's index in the call's attribute list; element
 * offsets and counts are in floats of that attribute's array:
 * - `WRITE at count payloadAt`: `count` floats of the payload at `at`.
 * - `FILL at count`: zeros.
 * - `MOVE from to count`: `copyWithin(to, from, from + count)`.
 * - `COPY source count`: the first `count` floats of attribute `source` (a grown buffer's old one).
 * - `GATHER stride blocks [from count]...`: the blocks (in records) laid out from record 0 in order.
 * - `UPLOAD from count`: the range the next render uploads; `count` 0 uploads the whole array.
 * - `BOX from count payloadAt`: answers the AABB and largest basis scale of records
 *   `[from, from + count)` of a matrix buffer, for a local box whose centre and half size are the
 *   six payload floats at `payloadAt`: seven numbers per op, in op order.
 * - `LANES stride lanes values...`: the first `lanes` floats of every record set to `values`.
 */
export const RECORD_OP = {
  write: 1,
  fill: 2,
  move: 3,
  copy: 4,
  gather: 5,
  upload: 6,
  box: 7,
  lanes: 8,
} as const;

/** Numbers each `BOX` op answers: min x y z, max x y z, largest basis scale. */
export const RECORD_BOX_SIZE = 7;

/** What a queued batch does around a flush: name its upload ranges, then read its boxes back. */
export interface IRecordWriter {
  uploadRecords(): void;
  settleRecords(boxes: ArrayLike<number>): void;
}

type IRecordsCall = (
  attributes: InstancedBufferAttribute[],
  ops: Float64Array,
  payload: Float32Array,
) => ArrayLike<number>;

/** The engine's own applier, present only on the owned engine. */
interface IRecordsEngine {
  __tnRecords?: IRecordsCall;
}

function grown<T extends Float64Array | Float32Array>(array: T, needed: number): T {
  if (needed <= array.length) return array;
  const next = new (array.constructor as new (length: number) => T)(
    Math.max(needed, array.length * 2),
  );
  next.set(array);
  return next;
}

export class RecordQueue {
  #attributes: InstancedBufferAttribute[] = [];
  readonly #slots = new Map<InstancedBufferAttribute, number>();
  #ops = new Float64Array(1024);
  #opAt = 0;
  #payload = new Float32Array(16384);
  #payloadAt = 0;
  #boxes = 0;
  readonly #writers = new Set<IRecordWriter>();

  /** The payload buffer; read it after {@link reserve}, which may replace it. */
  get payload(): Float32Array {
    return this.#payload;
  }

  /** Room for `floats` payload floats at a record-aligned offset, which is returned. */
  reserve(floats: number): number {
    const at = Math.ceil(this.#payloadAt / 16) * 16;
    this.#payload = grown(this.#payload, at + floats);
    this.#payloadAt = at + floats;
    return at;
  }

  write(attribute: InstancedBufferAttribute, at: number, count: number, payloadAt: number): void {
    if (count > 0) this.#op(RECORD_OP.write, attribute, at, count, payloadAt);
  }

  fill(attribute: InstancedBufferAttribute, at: number, count: number): void {
    if (count > 0) this.#op(RECORD_OP.fill, attribute, at, count);
  }

  move(attribute: InstancedBufferAttribute, from: number, to: number, count: number): void {
    if (count > 0 && from !== to) this.#op(RECORD_OP.move, attribute, from, to, count);
  }

  copy(target: InstancedBufferAttribute, source: InstancedBufferAttribute, count: number): void {
    if (count > 0) this.#op(RECORD_OP.copy, target, this.#slot(source), count);
  }

  /** `blocks` holds `[fromRecord, records]` pairs, laid out from record 0 in order. */
  gather(attribute: InstancedBufferAttribute, stride: number, blocks: readonly number[]): void {
    if (blocks.length === 0) return;
    this.#op(RECORD_OP.gather, attribute, stride, blocks.length / 2, ...blocks);
  }

  upload(attribute: InstancedBufferAttribute, from: number, count: number): void {
    this.#op(RECORD_OP.upload, attribute, from, count);
  }

  /** Queues a box; the returned index is where its seven numbers start in the flush's answer. */
  box(
    attribute: InstancedBufferAttribute,
    from: number,
    count: number,
    center: { x: number; y: number; z: number },
    half: { x: number; y: number; z: number },
  ): number {
    const at = this.reserve(6);
    this.#payload.set([center.x, center.y, center.z, half.x, half.y, half.z], at);
    this.#op(RECORD_OP.box, attribute, from, count, at);
    const index = this.#boxes;
    this.#boxes += RECORD_BOX_SIZE;
    return index;
  }

  lanes(attribute: InstancedBufferAttribute, stride: number, values: readonly number[]): void {
    this.#op(RECORD_OP.lanes, attribute, stride, values.length, ...values);
  }

  /** `writer` names its upload ranges at the next flush and reads its boxes back after it. */
  touch(writer: IRecordWriter): void {
    this.#writers.add(writer);
  }

  /**
   * Hands the frame's ops to the engine in one call (or to {@link applyRecords} on upstream three),
   * then tells each writer what its boxes measured. A frame that queued nothing calls nothing.
   */
  flush(): void {
    if (this.#writers.size === 0 && this.#opAt === 0) return;
    const writers = [...this.#writers];
    this.#writers.clear();
    for (const writer of writers) writer.uploadRecords();
    const attributes = this.#attributes;
    const ops = this.#ops.subarray(0, this.#opAt);
    const payload = this.#payload.subarray(0, this.#payloadAt);
    this.#attributes = [];
    this.#slots.clear();
    this.#opAt = 0;
    this.#payloadAt = 0;
    this.#boxes = 0;
    const first = attributes[0] as (InstancedBufferAttribute & IRecordsEngine) | undefined;
    let boxes: ArrayLike<number> = [];
    if (first !== undefined) {
      const engine = first.__tnRecords;
      boxes =
        typeof engine === "function"
          ? engine.call(first, attributes, ops, payload)
          : applyRecords(attributes, ops, payload);
    }
    for (const writer of writers) writer.settleRecords(boxes);
  }

  #slot(attribute: InstancedBufferAttribute): number {
    let slot = this.#slots.get(attribute);
    if (slot === undefined) {
      slot = this.#attributes.length;
      this.#attributes.push(attribute);
      this.#slots.set(attribute, slot);
    }
    return slot;
  }

  #op(code: number, attribute: InstancedBufferAttribute, ...args: number[]): void {
    const slot = this.#slot(attribute);
    this.#ops = grown(this.#ops, this.#opAt + 2 + args.length);
    this.#ops[this.#opAt] = code;
    this.#ops[this.#opAt + 1] = slot;
    this.#ops.set(args, this.#opAt + 2);
    this.#opAt += 2 + args.length;
  }
}

/** The one queue every shared batch writes into, flushed at the end of `WorldCells.update`. */
export const batchRecords = new RecordQueue();

function span(array: ArrayLike<number>, at: number, count: number, what: string): void {
  if (
    !(
      Number.isInteger(at) &&
      Number.isInteger(count) &&
      at >= 0 &&
      count >= 0 &&
      at + count <= array.length
    )
  )
    throw new RangeError(
      `TN_WORLD_RECORDS: ${what} [${String(at)}, ${String(at + count)}) is outside ${String(array.length)} floats`,
    );
}

/** `GATHER stride blocks [from count]...` on one array, read whole before it is written. */
function gather(array: Float32Array, ops: Float64Array, at: number): void {
  const stride = ops[at + 2] as number;
  const blocks = ops[at + 3] as number;
  let total = 0;
  for (let block = 0; block < blocks; block += 1) total += ops[at + 5 + block * 2] as number;
  const scratch = new Float32Array(total * stride);
  let written = 0;
  for (let block = 0; block < blocks; block += 1) {
    const from = (ops[at + 4 + block * 2] as number) * stride;
    const count = (ops[at + 5 + block * 2] as number) * stride;
    span(array, from, count, "gather");
    scratch.set(array.subarray(from, from + count), written);
    written += count;
  }
  span(array, 0, written, "gather target");
  array.set(scratch);
}

/** `LANES stride lanes values...`: the first `lanes` floats of every record. */
function lanes(array: Float32Array, ops: Float64Array, at: number): void {
  const stride = ops[at + 2] as number;
  const count = ops[at + 3] as number;
  if (!(count <= stride)) throw new RangeError("TN_WORLD_RECORDS: lanes wider than the record");
  for (let record = 0; record + stride <= array.length; record += stride)
    for (let lane = 0; lane < count; lane += 1) array[record + lane] = ops[at + 4 + lane] as number;
}

/**
 * The ops of one flush on each attribute's own array: the upstream-three twin of the engine's
 * `__tnRecords`, with the same checks. Answers the `BOX` ops' numbers in order.
 */
export function applyRecords(
  attributes: readonly InstancedBufferAttribute[],
  ops: Float64Array,
  payload: Float32Array,
): number[] {
  const boxes: number[] = [];
  for (let at = 0; at < ops.length; ) at = applyOp(attributes, ops, at, payload, boxes);
  return boxes;
}

/** One op of {@link applyRecords}; answers where the next op starts. */
function applyOp(
  attributes: readonly InstancedBufferAttribute[],
  ops: Float64Array,
  at: number,
  payload: Float32Array,
  boxes: number[],
): number {
  const attribute = attributes[ops[at + 1] as number];
  if (attribute === undefined) throw new RangeError("TN_WORLD_RECORDS: an op names no attribute");
  const array = attribute.array as Float32Array;
  const a = ops[at + 2] as number;
  const b = ops[at + 3] as number;
  const c = ops[at + 4] as number;
  switch (ops[at]) {
    case RECORD_OP.write:
      span(array, a, b, "write");
      span(payload, c, b, "payload");
      array.set(payload.subarray(c, c + b), a);
      return at + 5;
    case RECORD_OP.fill:
      span(array, a, b, "fill");
      array.fill(0, a, a + b);
      return at + 4;
    case RECORD_OP.move:
      span(array, a, c, "move source");
      span(array, b, c, "move target");
      array.copyWithin(b, a, a + c);
      return at + 5;
    case RECORD_OP.copy: {
      const source = attributes[a]?.array as Float32Array | undefined;
      if (source === undefined) throw new RangeError("TN_WORLD_RECORDS: copy names no source");
      span(array, 0, b, "copy target");
      span(source, 0, b, "copy source");
      array.set(source.subarray(0, b));
      return at + 4;
    }
    case RECORD_OP.gather:
      gather(array, ops, at);
      return at + 4 + b * 2;
    case RECORD_OP.upload:
      span(array, a, b, "upload");
      attribute.clearUpdateRanges();
      if (b > 0) attribute.addUpdateRange(a, b);
      attribute.needsUpdate = true;
      return at + 4;
    case RECORD_OP.box:
      span(array, a * 16, b * 16, "box");
      span(payload, c, 6, "box payload");
      boxes.push(...boxOf(array, a, b, payload, c));
      return at + 5;
    case RECORD_OP.lanes:
      lanes(array, ops, at);
      return at + 4 + b;
    default:
      throw new RangeError(`TN_WORLD_RECORDS: unknown op ${String(ops[at])}`);
  }
}

/**
 * The AABB of records `[from, from + count)`: each record's local box centre moved by its matrix,
 * with half extents `|basis| * half`, which is the box a rotated or stretched instance actually
 * covers. The seventh number is the largest basis column, the scale a fern or a trunk is drawn at.
 */
function boxOf(
  array: Float32Array,
  from: number,
  count: number,
  local: Float32Array,
  at: number,
): number[] {
  const cx = local[at] as number;
  const cy = local[at + 1] as number;
  const cz = local[at + 2] as number;
  const hx = local[at + 3] as number;
  const hy = local[at + 4] as number;
  const hz = local[at + 5] as number;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  let scale = 0;
  for (let index = from; index < from + count; index += 1) {
    const m = index * 16;
    const m0 = array[m] as number;
    const m1 = array[m + 1] as number;
    const m2 = array[m + 2] as number;
    const m4 = array[m + 4] as number;
    const m5 = array[m + 5] as number;
    const m6 = array[m + 6] as number;
    const m8 = array[m + 8] as number;
    const m9 = array[m + 9] as number;
    const m10 = array[m + 10] as number;
    const px = m0 * cx + m4 * cy + m8 * cz + (array[m + 12] as number);
    const py = m1 * cx + m5 * cy + m9 * cz + (array[m + 13] as number);
    const pz = m2 * cx + m6 * cy + m10 * cz + (array[m + 14] as number);
    const ex = Math.abs(m0) * hx + Math.abs(m4) * hy + Math.abs(m8) * hz;
    const ey = Math.abs(m1) * hx + Math.abs(m5) * hy + Math.abs(m9) * hz;
    const ez = Math.abs(m2) * hx + Math.abs(m6) * hy + Math.abs(m10) * hz;
    if (px - ex < minX) minX = px - ex;
    if (py - ey < minY) minY = py - ey;
    if (pz - ez < minZ) minZ = pz - ez;
    if (px + ex > maxX) maxX = px + ex;
    if (py + ey > maxY) maxY = py + ey;
    if (pz + ez > maxZ) maxZ = pz + ez;
    const basis = Math.max(Math.hypot(m0, m1, m2), Math.hypot(m4, m5, m6), Math.hypot(m8, m9, m10));
    if (basis > scale) scale = basis;
  }
  return [minX, minY, minZ, maxX, maxY, maxZ, scale];
}
