/**
 * A three export the native engine does not provide, for both back ends: any call, construction or
 * property access throws `diagnostic` naming the export. A game that only imports it (core's WebGL2
 * fallback, a renderer it never builds) runs; one that uses it fails at that use, by name.
 */
export function refused(name: string, diagnostic: string): unknown {
  const fail = (): never => {
    throw new Error(`${diagnostic}: ${name} is not available on the native engine.`);
  };
  return new Proxy(function refusedExport() {}, {
    apply: fail,
    construct: fail,
    get: fail,
    set: fail,
    has: fail,
    ownKeys: fail,
    getPrototypeOf: fail,
    defineProperty: fail,
    deleteProperty: fail,
    getOwnPropertyDescriptor: fail,
  });
}

/** `refused` under the catalog's diagnostic for an unsupported export, `TN_NATIVE_UNSUPPORTED_<NAME>`. */
export function unsupportedExport(name: string): unknown {
  return refused(name, `TN_NATIVE_UNSUPPORTED_${name.toUpperCase()}`);
}
