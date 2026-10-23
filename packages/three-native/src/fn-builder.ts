/**
 * three hands a `Fn` callback its NodeBuilder as the second argument and builds the body once per object,
 * so `builder.object` is the mesh being compiled. The engine builds a body once, at the call, for every
 * object that uses it: a body that reads the builder is refused by name rather than handed `undefined`.
 */
const refuse = (name: string) => () => {
  throw new Error(
    `TN_NATIVE_FN_BUILDER_UNSUPPORTED: Fn's builder.${name} needs a per-object shader build, which the native engine does not do`,
  );
};
const builder = Object.freeze(
  Object.defineProperties(
    {},
    Object.fromEntries(
      ["object", "geometry", "material"].map((name) => [name, { get: refuse(name) }]),
    ),
  ),
);

type Fn = (callback: unknown) => unknown;

/** The back end's `Fn`, with three's builder argument as the refusing stand-in. */
export function withFnBuilder(fn: Fn): Fn {
  return (callback) => {
    if (typeof callback !== "function") throw new TypeError("TN_TSL Fn: expected a callback");
    return fn((inputs: unknown) =>
      (callback as (inputs: unknown, b: unknown) => unknown)(inputs, builder),
    );
  };
}
