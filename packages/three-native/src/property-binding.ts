/**
 * three's PropertyBinding and console function over the engine's PropertyBinding, for both back ends
 * (the V8 player and the Wasm engine). The engine binds; this keeps three's JS surface: the static
 * `parseTrackName` and `findNode`, `targetObject` as a property, and a failed bind reported through
 * `setConsoleFunction`'s function (three's utils `error()`), or `console.error` without one.
 */

type ConsoleFunction = (type: string, message: string, ...params: unknown[]) => void;

interface IEngineBinding {
  bind(): string;
  __bind?(): [string, unknown];
  unbind(): void;
  targetObject(): unknown;
  parseTrackName(path: string): Record<string, string | undefined>;
  findNode(root: unknown, nodeName?: string): unknown;
}

type EngineClass = (new (...args: unknown[]) => object) & Record<string, unknown>;

export function definePropertyBinding(Native: EngineClass) {
  let consoleFunction: ConsoleFunction | null = null;
  const prototype = Native.prototype as IEngineBinding;
  const bind = prototype.bind;
  const bindWithTarget = prototype.__bind;
  const unbind = prototype.unbind;
  const target = prototype.targetObject;
  // Games bind every track of every clip while they load: `__bind` answers the reason and the target
  // in one engine call, and the target is kept until the next bind or unbind. A path's parse depends
  // on the path alone, so each is parsed once.
  const targets = new WeakMap<object, unknown>();
  const parsed = new Map<string, Record<string, string | undefined>>();
  // One engine object with no root answers the statics.
  let helper: IEngineBinding | undefined;
  const statics = (): IEngineBinding => {
    // quality-allow: Native engine PropertyBinding constructor produces instance satisfying IEngineBinding interface.
    helper ??= new Native() as unknown as IEngineBinding;
    return helper;
  };

  Object.defineProperties(prototype, {
    bind: {
      configurable: true,
      writable: true,
      value(this: IEngineBinding): void {
        let reason: string;
        if (bindWithTarget === undefined) reason = bind.call(this);
        else {
          const [text, object] = bindWithTarget.call(this);
          reason = text;
          targets.set(this, object);
        }
        if (reason === "") return;
        if (consoleFunction !== null) consoleFunction("error", reason);
        else console.error(reason);
      },
    },
    targetObject: {
      configurable: true,
      get(this: IEngineBinding): unknown {
        return targets.has(this) ? targets.get(this) : target.call(this);
      },
    },
    unbind: {
      configurable: true,
      writable: true,
      value(this: IEngineBinding): void {
        targets.delete(this);
        unbind.call(this);
      },
    },
  });
  Object.assign(Native, {
    parseTrackName: (path: string) => {
      let known = parsed.get(path);
      if (known === undefined) {
        known = statics().parseTrackName(path);
        parsed.set(path, known);
      }
      return { ...known };
    },
    findNode: (root: unknown, nodeName?: string) => statics().findNode(root, nodeName),
  });

  const PropertyBinding = Native;
  return {
    PropertyBinding,
    getConsoleFunction: (): ConsoleFunction | null => consoleFunction,
    setConsoleFunction: (fn: ConsoleFunction | null | undefined): void => {
      consoleFunction = fn ?? null;
    },
  };
}
