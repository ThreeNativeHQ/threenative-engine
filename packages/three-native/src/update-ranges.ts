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
  Object.defineProperty(prototype, "updateRanges", {
    configurable: true,
    get(this: object) {
      const cached = proxies.get(this);
      if (cached !== undefined) return cached;
      const target: IRange[] = [];
      let snapshot: unknown;
      const refresh = () => {
        const current = emptied.delete(this) ? "[]" : (read.call(this) as unknown);
        if (current === snapshot) return;
        target.splice(0, target.length, ...(JSON.parse(String(current)) as IRange[]));
        snapshot = current;
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
              return target.push(...ranges);
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
      proxies.set(this, proxy);
      return proxy;
    },
  });
}
