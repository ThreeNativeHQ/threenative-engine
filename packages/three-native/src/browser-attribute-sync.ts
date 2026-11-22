/**
 * three's `attribute.array` and the engine's copy of it, on the browser back end (PRD-540, PRD-617,
 * PRD-803): the array the constructor was handed or a copy of the engine's data on first read, and
 * the ranges an engine mutator writes back. A view of Wasm memory would detach when it grows, so the
 * shadow is a JS array; the two are kept in step, and `needsUpdate` sends the array to the engine.
 * Each engine keeps its own shadows, so the back end builds them per engine.
 */
import type { IBrowserRuntime, IEngineRef } from "./browser-abi-types.js";
import type { TypedArray } from "./browser-marshal.js";

/** three's MathUtils.denormalize: a normalized integer lane to [-1, 1] or [0, 1]. */
export function denormalize(value: number, array: TypedArray): number {
  if (array instanceof Float32Array || array instanceof Float64Array) return value;
  if (array instanceof Uint32Array) return value / 4294967295;
  if (array instanceof Uint16Array) return value / 65535;
  if (array instanceof Uint8Array) return value / 255;
  if (array instanceof Int32Array) return Math.max(value / 2147483647, -1);
  if (array instanceof Int16Array) return Math.max(value / 32767, -1);
  return Math.max(value / 127, -1);
}

export const ATTRIBUTE_CLASSES = new Set([
  "BufferAttribute",
  "Float32BufferAttribute",
  "Uint16BufferAttribute",
  "Uint32BufferAttribute",
  "InstancedBufferAttribute",
]);

/** What an attribute's shadow needs from the back end that owns the object. */
export interface IAttributeSyncHost {
  readonly runtime: IBrowserRuntime;
  refOf(self: unknown): IEngineRef;
}

/** The attribute shadows one engine keeps, and the range bookkeeping an engine mutator's call needs. */
export interface IAttributeSync {
  readonly attributeArray: IBrowserRuntime["attributeArray"];
  readonly attributeWrite: IBrowserRuntime["attributeWrite"];
  readonly arrays: WeakMap<object, { array: TypedArray }>;
  readonly itemSizes: WeakMap<object, number>;
  /** Shape survives data uploads and transform calls; only copy/replacement changes it. */
  readonly shapes: WeakMap<object, Map<string, unknown>>;
  readonly pending: Set<object>;
  /** Item ranges a mesh-level write put in an attribute's array, sent with `pending` (PRD-860). */
  readonly dirty: Map<object, { from: number; to: number }>;
  writeBack(): void;
  itemSizeOf(attribute: object): number;
  rangeOf(method: string, args: readonly unknown[], itemSize: number): readonly [number, number];
  syncRange(attribute: object, entry: { array: TypedArray }, offset: number, count: number): void;
  syncFull(attribute: object, entry: { array: TypedArray }): void;
  syncRecords(attributes: readonly object[], ops: unknown): void;
  instanceItem(
    mesh: object,
    attribute: string,
    index: unknown,
    argument: unknown,
  ): { array: TypedArray; at: number; values: ArrayLike<number> } | undefined;
  writeItemAt(
    mesh: object,
    name: "instanceMatrix" | "instanceColor",
    index: unknown,
    value: unknown,
  ): boolean;
}

interface IRecordDirtyPlan {
  readonly from: number[];
  readonly to: number[];
  readonly full: boolean[];
}

function addDirtySpan(plan: IRecordDirtyPlan, slot: number, start: number, end: number): boolean {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start)
    return false;
  if (end > start) {
    if (start < (plan.from[slot] as number)) plan.from[slot] = start;
    if (end > (plan.to[slot] as number)) plan.to[slot] = end;
  }
  return true;
}

function advanceGatherOp(
  opList: ArrayLike<number>,
  at: number,
  slot: number,
  plan: IRecordDirtyPlan,
): number {
  if (at + 4 > opList.length) return -1;
  const stride = opList[at + 2] as number;
  const blocks = opList[at + 3] as number;
  if (
    !Number.isSafeInteger(stride) ||
    stride < 1 ||
    !Number.isSafeInteger(blocks) ||
    blocks < 0 ||
    at + 4 + blocks * 2 > opList.length
  )
    return -1;
  let total = 0;
  for (let b = 0; b < blocks; b += 1) {
    const count = opList[at + 5 + b * 2] as number;
    if (!Number.isSafeInteger(count) || count < 0) return -1;
    total += count;
  }
  return addDirtySpan(plan, slot, 0, total * stride) ? at + 4 + blocks * 2 : -1;
}

function advanceLanesOp(
  opList: ArrayLike<number>,
  at: number,
  slot: number,
  plan: IRecordDirtyPlan,
): number {
  if (at + 4 > opList.length) return -1;
  const lanesCount = opList[at + 3] as number;
  if (!Number.isSafeInteger(lanesCount) || lanesCount < 0 || at + 4 + lanesCount > opList.length)
    return -1;
  plan.full[slot] = true;
  return at + 4 + lanesCount;
}

function stepRecordOp(
  opList: ArrayLike<number>,
  at: number,
  slotCount: number,
  plan: IRecordDirtyPlan,
): number {
  const code = opList[at];
  const slot = opList[at + 1] as number;
  if (!Number.isSafeInteger(slot) || slot < 0 || slot >= slotCount) return -1;
  switch (code) {
    case 1: {
      if (at + 5 > opList.length) return -1;
      const start = opList[at + 2] as number;
      const count = opList[at + 3] as number;
      return addDirtySpan(plan, slot, start, start + count) ? at + 5 : -1;
    }
    case 2: {
      if (at + 4 > opList.length) return -1;
      const start = opList[at + 2] as number;
      const count = opList[at + 3] as number;
      return addDirtySpan(plan, slot, start, start + count) ? at + 4 : -1;
    }
    case 3: {
      if (at + 5 > opList.length) return -1;
      const to = opList[at + 3] as number;
      const count = opList[at + 4] as number;
      return addDirtySpan(plan, slot, to, to + count) ? at + 5 : -1;
    }
    case 4: {
      if (at + 4 > opList.length) return -1;
      const count = opList[at + 3] as number;
      return addDirtySpan(plan, slot, 0, count) ? at + 4 : -1;
    }
    case 5:
      return advanceGatherOp(opList, at, slot, plan);
    case 6:
      return at + 4 <= opList.length ? at + 4 : -1;
    case 7:
      return at + 5 <= opList.length ? at + 5 : -1;
    case 8:
      return advanceLanesOp(opList, at, slot, plan);
    default:
      return -1;
  }
}

function collectRecordDirty(ops: unknown, slotCount: number): IRecordDirtyPlan | undefined {
  if (
    ops === null ||
    ops === undefined ||
    typeof ops !== "object" ||
    typeof (ops as ArrayLike<number>).length !== "number"
  )
    return undefined;
  const opList = ops as ArrayLike<number>;
  const plan: IRecordDirtyPlan = {
    from: new Array<number>(slotCount).fill(Number.POSITIVE_INFINITY),
    to: new Array<number>(slotCount).fill(0),
    full: new Array<boolean>(slotCount).fill(false),
  };
  for (let at = 0; at < opList.length; ) {
    const next = stepRecordOp(opList, at, slotCount, plan);
    if (next <= at) return undefined;
    at = next;
  }
  return plan;
}

export function defineAttributeSync(host: IAttributeSyncHost): IAttributeSync {
  const { runtime, refOf } = host;
  // three's `attribute.array` is the attribute's own JS typed array (PRD-540): the array the
  // constructor was handed, or a copy of the engine's data on first read. A view of Wasm memory
  // would detach when the memory grows, so the shadow is a JS array. The shadow and the engine's
  // store are kept in step (PRD-617): an engine mutator copies back ONLY the range it wrote, so a
  // later game edit to the array wins, and `needsUpdate` sends the array to the engine. A read hands
  // the game the array, so the attribute is `pending` until its array is written back before the next
  // engine call (a per-vertex setter reads no kept array and flushes nothing).
  const { attributeArray, attributeReadInto, attributeWrite } = runtime;
  const arrays = new WeakMap<object, { array: TypedArray }>();
  const itemSizes = new WeakMap<object, number>();
  // Shape survives data uploads and transform calls; only copy/replacement changes it.
  const shapes = new WeakMap<object, Map<string, unknown>>();
  const pending = new Set<object>();
  const dirty = new Map<object, { from: number; to: number }>();
  const writeBack = (): void => {
    for (const [attribute, { from, to }] of dirty) {
      const entry = arrays.get(attribute);
      if (entry !== undefined && !pending.has(attribute))
        attributeWrite?.call(runtime, refOf(attribute), entry.array.subarray(from, to), from);
    }
    dirty.clear();
    for (const attribute of pending) {
      const entry = arrays.get(attribute);
      if (entry !== undefined) attributeWrite?.call(runtime, refOf(attribute), entry.array);
    }
    pending.clear();
  };
  const itemSizeOf = (attribute: object): number => {
    let size = itemSizes.get(attribute);
    if (size === undefined) {
      size = Number(runtime.get(refOf(attribute), "itemSize"));
      itemSizes.set(attribute, size);
    }
    return size;
  };
  // The scalar range an attribute mutator wrote: derived from the method and its arguments, so the
  // engine syncs back only those elements. A component setter writes one, setXY/XYZ/XYZW an item's
  // lanes, copyAt a whole destination item.
  const lanes: Record<string, number> = { setX: 0, setY: 1, setZ: 2, setW: 3 };
  const rangeOf = (
    method: string,
    args: readonly unknown[],
    itemSize: number,
  ): readonly [number, number] => {
    const at = Number(args[0]) * itemSize;
    if (method === "copyAt") return [at, itemSize];
    const component = lanes[method];
    if (component !== undefined) return [at + component, 1];
    if (method === "setComponent") return [at + Number(args[1]), 1];
    return [at, method === "setXY" ? 2 : method === "setXYZ" ? 3 : 4];
  };
  const syncRange = (
    attribute: object,
    entry: { array: TypedArray },
    offset: number,
    count: number,
  ): void => {
    // A malformed range (a fraction, NaN, Infinity, a negative offset or a non-positive count) names
    // no element: it must fail, not slip to element 0 through subarray's own coercion. A range that
    // only runs past the end is the engine's documented bounds no-op (`setComponent`/`setRaw`
    // ignore it, as JS does), so there is nothing to read back. A required range read that comes
    // back missing or short is a provider fault, never a silently stale shadow.
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(count) || offset < 0 || count <= 0)
      throw new RangeError(
        `TN_NATIVE_ATTRIBUTE_RANGE: [${String(offset)}, ${String(count)}) is not a valid element range`,
      );
    if (offset + count > entry.array.length) return;
    if (attributeReadInto !== undefined) {
      const copied = attributeReadInto.call(
        runtime,
        refOf(attribute),
        entry.array,
        offset,
        count,
        offset,
      );
      if (copied !== count)
        throw new TypeError(
          `TN_NATIVE_ATTRIBUTE_SYNC: attributeReadInto gave ${String(copied)} elements for [${String(offset)}, ${String(count)})`,
        );
      return;
    }
    const fresh = attributeArray?.call(runtime, refOf(attribute), offset, count);
    if (fresh === undefined || fresh.length !== count)
      throw new TypeError(
        `TN_NATIVE_ATTRIBUTE_SYNC: attributeArray gave ${fresh === undefined ? "no array" : `${String(fresh.length)} elements`} for [${String(offset)}, ${String(count)})`,
      );
    entry.array.set(fresh, offset);
  };
  const syncFull = (attribute: object, entry: { array: TypedArray }): void => {
    if (attributeReadInto !== undefined) {
      try {
        const copied = attributeReadInto.call(
          runtime,
          refOf(attribute),
          entry.array,
          0,
          undefined,
          0,
        );
        if (copied === entry.array.length) return;
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
      }
    }
    const fresh = attributeArray?.call(runtime, refOf(attribute));
    if (fresh === undefined) return;
    if (fresh.length === entry.array.length) entry.array.set(fresh);
    else entry.array = fresh;
  };
  const syncRecords = (attributes: readonly object[], ops: unknown): void => {
    const plan = collectRecordDirty(ops, attributes.length);
    if (plan === undefined) {
      for (const attribute of attributes) {
        const entry = arrays.get(attribute);
        if (entry !== undefined) syncFull(attribute, entry);
      }
      return;
    }
    for (let slot = 0; slot < attributes.length; slot += 1) {
      const attribute = attributes[slot] as object;
      const entry = arrays.get(attribute);
      if (entry === undefined) continue;
      if (plan.full[slot]) {
        syncFull(attribute, entry);
        continue;
      }
      const from = plan.from[slot] as number;
      const to = plan.to[slot] as number;
      if (from >= to || from >= entry.array.length) continue;
      syncRange(attribute, entry, from, Math.min(to, entry.array.length) - from);
    }
  };
  // three's `InstancedMesh.setMatrixAt`/`setColorAt` write the mesh's own `instanceMatrix`/
  // `instanceColor` array item (`index * 16`, `index * 3`); the engine's mesh-level call writes only
  // its own store, so the shadow a game already holds (core's velocity capture reads one per mesh a
  // frame) would send its frozen snapshot back at `needsUpdate` and leave the mesh where it stood.
  // Take the item the call writes into that same array, as three does. No shadow, no work: this is
  // a pair of map lookups and an array copy, never an engine call.
  const instanceItem = (
    mesh: object,
    attribute: string,
    index: unknown,
    argument: unknown,
  ): { array: TypedArray; at: number; values: ArrayLike<number> } | undefined => {
    const held = shapes.get(mesh)?.get(attribute);
    if (held === null || held === undefined) return undefined;
    const entry = arrays.get(held as object);
    if (entry === undefined) return undefined;
    const source = argument as {
      elements?: ArrayLike<number>;
      r?: number;
      g?: number;
      b?: number;
    } | null;
    const values =
      attribute === "instanceMatrix"
        ? source?.elements
        : [Number(source?.r), Number(source?.g), Number(source?.b)];
    if (values === undefined) return undefined;
    const at = Number(index) * values.length;
    // three's `toArray` writes one lane at a time, so a lane outside the array is ignored, not an error.
    if (!Number.isSafeInteger(at) || at < 0 || at + values.length > entry.array.length)
      return undefined;
    return { array: entry.array, at, values };
  };
  // three's `setMatrixAt` and `setColorAt` write the item into the attribute's array, and so does
  // this: one engine call an instance made a meadow of a few thousand tufts cost 60 ms of a laptop
  // load (PRD-860). The written range goes to the engine once, before the next engine call, which is
  // the first thing that can read it. Anything three would not write (a bad index, no value) and the
  // first colour (the engine creates `instanceColor` then) take the engine's call.
  const writeItemAt = (
    mesh: object,
    name: "instanceMatrix" | "instanceColor",
    index: unknown,
    value: unknown,
  ): boolean => {
    const source = value as {
      elements?: ArrayLike<number>;
      r?: unknown;
      g?: unknown;
      b?: unknown;
    } | null;
    const size = name === "instanceMatrix" ? 16 : 3;
    const values =
      name === "instanceMatrix"
        ? source?.elements
        : typeof source?.r === "number" &&
            typeof source.g === "number" &&
            typeof source.b === "number"
          ? [source.r, source.g, source.b]
          : undefined;
    const attribute = (mesh as Record<string, unknown>)[name];
    const at = Number(index) * size;
    if (
      attributeArray === undefined ||
      values?.length !== size ||
      typeof attribute !== "object" ||
      attribute === null ||
      !Number.isSafeInteger(at) ||
      at < 0
    )
      return false;
    let entry = arrays.get(attribute);
    if (entry === undefined) {
      entry = { array: attributeArray.call(runtime, refOf(attribute)) };
      arrays.set(attribute, entry);
    }
    if (at + size > entry.array.length) return false;
    entry.array.set(values, at);
    const range = dirty.get(attribute);
    if (range === undefined) dirty.set(attribute, { from: at, to: at + size });
    else {
      range.from = Math.min(range.from, at);
      range.to = Math.max(range.to, at + size);
    }
    return true;
  };
  return {
    attributeArray,
    attributeWrite,
    arrays,
    itemSizes,
    shapes,
    pending,
    dirty,
    writeBack,
    itemSizeOf,
    rangeOf,
    syncRange,
    syncFull,
    syncRecords,
    instanceItem,
    writeItemAt,
  };
}
