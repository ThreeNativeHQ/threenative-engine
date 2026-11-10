/**
 * `BufferAttribute.updateRanges` as three's live array of `{ start, count }` records, on the web facade.
 * The engine hands the getter canonical JSON and takes ranges through `addUpdateRange` and
 * `clearUpdateRanges`. Push appends validated records directly; other mutations replay the array.
 * An explicit clear supplies the next empty snapshot; other reads still observe native upload clears.
 * The V8 adapter installs the same surface (adapters/v8/adapter.cpp, rangesSource).
 */
interface IRange {
  start: number;
  count: number;
}

const MUTATORS = new Set([
  "push",
  "pop",
  "shift",
  "unshift",
  "splice",
  "sort",
  "reverse",
  "fill",
  "copyWithin",
]);

const UPLOAD_RANGES = Symbol("tnUploadRanges");

/**
 * The `{ start, count }` element ranges the attribute's next upload sends, or none for the whole array,
 * as three's `WebGPUAttributeUtils.updateAttribute` reads `updateRanges`. Malformed engine JSON throws.
 */
export function uploadRanges(attribute: object): readonly IRange[] {
  const read = Reflect.get(attribute, UPLOAD_RANGES) as (() => string) | undefined;
  const json = read?.call(attribute) ?? "[]";
  if (json === "[]") return [];
  const ranges = JSON.parse(json) as unknown;
  if (!Array.isArray(ranges))
    throw new TypeError(`TN_NATIVE_UNSUPPORTED updateRanges: expected a JSON array, got ${json}`);
  return ranges as IRange[];
}

export function withUpdateRanges(prototype: object): void {
  const read = Object.getOwnPropertyDescriptor(prototype, "updateRanges")?.get;
  const proto = prototype as {
    addUpdateRange?: (start: number, count: number) => unknown;
    clearUpdateRanges?: () => unknown;
  };
  const clear = proto.clearUpdateRanges;
  const add = proto.addUpdateRange;
  if (read === undefined || clear === undefined || add === undefined) return;
  const proxies = new WeakMap<object, IRange[]>();
  const emptied = new WeakSet<object>();
  proto.clearUpdateRanges = function (this: object) {
    const result = clear.call(this);
    emptied.add(this);
    return result;
  };
  proto.addUpdateRange = function (this: object, start: number, count: number) {
    const result = add.call(this, start, count);
    emptied.delete(this);
    return result;
  };
  // The ranges the engine's next upload sends, as one getter read: no proxy, no parse when empty.
  Object.defineProperty(prototype, UPLOAD_RANGES, {
    configurable: true,
    value(this: object): string {
      return emptied.has(this) ? "[]" : String(read.call(this));
    },
  });
  Object.defineProperty(prototype, "updateRanges", {
    configurable: true,
    get(this: object) {
      const cached = proxies.get(this);
      if (cached !== undefined) return cached;
      const target: IRange[] = [];
      let snapshot: unknown;
      // The records as the engine last had them: a record edited in place differs from it.
      let mirror = "[]";
      const refresh = () => {
        const current = emptied.delete(this) ? "[]" : (read.call(this) as unknown);
        if (current === snapshot) return;
        target.splice(0, target.length, ...(JSON.parse(String(current)) as IRange[]));
        snapshot = current;
        mirror = JSON.stringify(target);
      };
      const validate = (ranges: readonly IRange[]) => {
        for (const range of ranges)
          if (
            !range ||
            !Number.isSafeInteger(range.start) ||
            range.start < 0 ||
            !Number.isSafeInteger(range.count) ||
            range.count < 0
          )
            throw new TypeError(
              "TN_NATIVE_UNSUPPORTED updateRanges: expected nonnegative integer start and count",
            );
      };
      const write = () => {
        validate(target);
        clear.call(this);
        for (const range of target) add.call(this, range.start, range.count);
        snapshot = undefined;
        mirror = JSON.stringify(target);
      };
      const guarded = <T>(change: () => T): T => {
        refresh();
        const previous = target.slice();
        try {
          return change();
        } catch (error) {
          target.splice(0, target.length, ...previous);
          throw error;
        }
      };
      const owner = this;
      const proxy: IRange[] = new Proxy(target, {
        get(array, key, receiver) {
          if (key === "push")
            return (...ranges: IRange[]) => {
              validate(ranges);
              refresh();
              for (const range of ranges) add.call(owner, range.start, range.count);
              snapshot = undefined;
              const length = target.push(...ranges);
              mirror = JSON.stringify(target);
              return length;
            };
          if (typeof key === "string" && MUTATORS.has(key))
            return (...args: unknown[]) =>
              guarded(() => {
                const result: unknown = Reflect.apply(
                  Reflect.get(array, key) as () => unknown,
                  array,
                  args,
                );
                write();
                return result === array ? proxy : result;
              });
          refresh();
          return Reflect.get(array, key, receiver);
        },
        set(array, key, value) {
          return guarded(() => {
            Reflect.set(array, key, value);
            write();
            return true;
          });
        },
        ownKeys(array) {
          refresh();
          return Reflect.ownKeys(array);
        },
        getOwnPropertyDescriptor(array, key) {
          refresh();
          return Reflect.getOwnPropertyDescriptor(array, key);
        },
      });
      // A record is an ordinary object, as three's is, so an edit in place (`last.count = n`, core's
      // addRange) reaches the engine when needsUpdate publishes it, as the V8 adapter does (PRD-857).
      let holder: object | null = Object.getPrototypeOf(this) as object | null;
      let publish: PropertyDescriptor | undefined;
      while (holder !== null && publish === undefined) {
        publish = Object.getOwnPropertyDescriptor(holder, "needsUpdate");
        holder = Object.getPrototypeOf(holder) as object | null;
      }
      if (publish?.set !== undefined) {
        const set = publish.set;
        const get = publish.get;
        Object.defineProperty(this, "needsUpdate", {
          configurable: true,
          ...(get === undefined ? {} : { get: () => get.call(owner) }),
          set(value: unknown) {
            if (value && JSON.stringify(target) !== mirror) write();
            set.call(owner, value);
          },
        });
      }
      proxies.set(this, proxy);
      return proxy;
    },
  });
}
