/**
 * What a JS value becomes on its way to the engine (PRD-532, PRD-803): three's typed arrays with the
 * engine's scalar order they name, the symbol that keeps a value's storage type, the ref slot every
 * engine wrapper carries, and the parameter rules three's own `Color.set` and `Material.setValues`
 * apply to a constructor's parameters object.
 */

export type TypedArray =
  | Float32Array
  | Float64Array
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array;

export const REF = Symbol("tn.engineRef");

/** A number list that came from a typed array names it, so the engine keeps three's storage type. */
export const TYPED = Symbol("tn.typedArray");
// The engine's Scalar order: F32, F64, I8, U8, I16, U16, I32, U32.
export const SCALARS = [
  Float32Array,
  Float64Array,
  Int8Array,
  Uint8Array,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
];

export function isPlainObject(value: unknown): boolean {
  return (
    typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}

export function isWrapperOf(
  value: unknown,
  className: string,
): value is Record<string, (...args: unknown[]) => unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    REF in value &&
    value.constructor.name === className
  );
}

/** three's `Color.set`: a hex number, a CSS string, or another Color. */
export function setColor(
  color: Record<string, (...args: unknown[]) => unknown>,
  value: unknown,
): void {
  if (typeof value === "number") color.setHex?.(value);
  else if (typeof value === "string") color.setStyle?.(value);
  else color.copy?.(value);
}

/**
 * three's `Material.setValues`: an undefined value is skipped, a Color member is set from a hex,
 * a CSS string or another Color, a Vector3 member copies a Vector3, everything else is assigned.
 * three warns and drops a key the object does not have; here that key fails.
 */
export function setValues(target: object, className: string, values: object): void {
  const self = target as Record<string, unknown>;
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    const current = self[key];
    if (current === undefined)
      throw new TypeError(`TN_BROWSER_PARAMETER_UNSUPPORTED: ${className} has no '${key}'`);
    if (isWrapperOf(current, "Color")) setColor(current, value);
    else if (isWrapperOf(current, "Vector3") && (value as { isVector3?: boolean }).isVector3)
      current.copy?.(value);
    else self[key] = value;
  }
}
