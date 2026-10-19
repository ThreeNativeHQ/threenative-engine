import type { Color, Material } from "three";

import { tintableMaterial } from "./projection-skinned.js";

/**
 * The fingerprint a uniform batch is keyed on, and the per-frame proof a member still matches it.
 *
 * A group of meshes that share a geometry and a material differing **only in base colour** draws as
 * one instanced call with the colour carried per instance, so the draw's only job is to know which
 * materials are interchangeable. That question has two halves, and both are affordable every frame
 * for a scene of four thousand materials:
 *
 * - **At classification**, a material's own properties become a signature string, and the values
 *   behind it are cached by position. Two materials with the same signature differ in nothing a
 *   shader can see except the colour.
 * - **Per frame**, the material's own values are read back in one `Object.values` call and compared
 *   against that cache. Everything is compared by identity, which is what a swap is, except the
 *   small-object types three clones per material — a `Color`, a `Vector2`, an `Euler` — which a game
 *   mutates in place, so their components are read instead. A property the group cannot carry
 *   (`color` travels per instance, `defines` is walked shallowly beside this, and the identity
 *   fields are no draw's business) is skipped rather than watched, and the number of own properties
 *   is compared, because a game that attaches a draw-affecting one after the fact would otherwise be
 *   invisible here and the group would keep drawing it with a shared material that never had it.
 *
 * The comparison is deliberately a value compare and nothing else. `material.version` is not part of
 * it, because `material.needsUpdate = true` bumps it without changing a pixel, and a material that
 * set it every frame would then be reclassified every frame for nothing. Every change that *can*
 * move a pixel is a change to one of the values read here, so the values are the whole truth and
 * the version is not.
 */

/** Own properties no draw reads: the per-instance colour, and identity or bookkeeping. */
const UNREAD_PROPERTIES: ReadonlySet<string> = new Set([
  "color",
  "defines",
  "id",
  "name",
  "userData",
  "uuid",
  "version",
]);

/** How a component-compared value's own numeric fields are read back per frame. */
const READ_KEYED = 0;
const READ_RGB = 1;
const READ_XY = 2;
const READ_UNDERSCORE_XYZ = 3;

interface IUniformRecord {
  /** The values as of the last classification, by the position they were enumerated at. */
  values: unknown[];
  /** Flat `[start, end)` pairs covering the positions judged by identity, skips excluded. */
  identityRanges: Int32Array;
  /** Positions of the component-compared values, in enumeration order. */
  vectorSlots: number[];
  /** How each of those values is read back, and how many fields of it there are. */
  vectorReads: Uint8Array;
  vectorWidths: Uint8Array;
  /** The own numeric field names of every component-compared value, flattened. */
  vectorFields: string[];
  components: number[];
  /** `defines` keys, in enumeration order, and the value each held. */
  defineKeys: string[];
  defineValues: unknown[];
  signature: string;
}

const records = new WeakMap<Material, IUniformRecord>();
/**
 * A number per opaque value — anything whose components say nothing, from a `ShaderMaterial`'s
 * `uniforms` to a game's own `onBeforeCompile`. Two materials holding the *same* one are as
 * interchangeable as two holding the same texture; two holding different ones are not, and every
 * one of them stringifies to `[object Object]`, so identity has to be spoken for numerically.
 */
const opaqueIds = new WeakMap<object, number>();
let nextOpaqueId = 1;

function isTextureValue(value: unknown): boolean {
  return value !== null && (value as { isTexture?: boolean }).isTexture === true;
}

/**
 * The own **numeric** field names of a value three clones per material and a game then mutates in
 * place — a `Color`, a `Vector2`, an `Euler` — or `undefined` when the value is not one of those.
 *
 * Recognised structurally, by "every own value is a primitive and at least one is a number", rather
 * than by naming each class: that is what a clone of a `MeshStandardMaterial` actually holds, it
 * covers the classes a future three adds, and it refuses anything it cannot read — a `Texture`,
 * which is compared by identity, and anything else, which is opaque. The *numbers* are what come
 * back, because a boolean or a string field is not something the compare could ever see move: a
 * `Color`'s `isColor` reads as `0` before and after, so recording it would cost a read per frame to
 * compare a value against itself. The *names* are recorded rather than the objects so the per-frame
 * read is a handful of field reads: a material animating `normalScale` or an `envMapRotation` is
 * caught, and one that set `needsUpdate` is not mistaken for one that did.
 */
function componentFieldsOf(value: unknown): string[] | undefined {
  if (value === null || typeof value !== "object" || isTextureValue(value)) return undefined;
  const fields = Object.keys(value);
  if (fields.length === 0) return undefined;
  const numbers: string[] = [];
  for (const field of fields) {
    const kind = typeof (value as Record<string, unknown>)[field];
    if (kind === "number") numbers.push(field);
    else if (kind !== "boolean" && kind !== "string") return undefined;
  }
  return numbers.length === 0 ? undefined : numbers;
}

/**
 * How the recorded fields of one component-compared value are read back each frame.
 *
 * A field read by name through a variable — `value[name]` — is a dictionary lookup the engine
 * cannot fold, and it is the single most expensive thing a settled frame did: four small objects
 * per material, and every one of them looked up field by field. Naming the field instead makes it
 * a fixed offset, so the three shapes three actually clones (`Color`, `Vector2`, `Euler`) are read
 * directly and anything a future material brings falls back to the general path rather than being
 * assumed a shape it is not.
 */
function readKindOf(fields: string[]): number {
  if (fields.length === 3) {
    if (fields[0] === "r" && fields[1] === "g" && fields[2] === "b") return READ_RGB;
    if (fields[0] === "_x" && fields[1] === "_y" && fields[2] === "_z") return READ_UNDERSCORE_XYZ;
    return READ_KEYED;
  }
  if (fields.length === 2 && fields[0] === "x" && fields[1] === "y") return READ_XY;
  return READ_KEYED;
}

/** The base colour a tinted group carries per instance, or `undefined` when the material has none. */
export function baseColorOf(material: Material): Color | undefined {
  const color = (material as { color?: Color }).color;
  return color !== undefined && typeof color.r === "number" ? color : undefined;
}

/** Whether a material may be the shared half of a uniform group at all. */
export function uniformEligible(material: Material): boolean {
  return tintableMaterial(material) && baseColorOf(material) !== undefined;
}

function opaqueIdOf(value: object): number {
  const existing = opaqueIds.get(value);
  if (existing !== undefined) return existing;
  const id = nextOpaqueId;
  nextOpaqueId += 1;
  opaqueIds.set(value, id);
  return id;
}

/** How a value speaks for itself in a signature, which is built once per classification. */
function signatureTextOf(
  value: unknown,
  fields: string[] | undefined,
  components: number[],
): string {
  if (fields !== undefined) return `v${components.slice(-fields.length).join(",")}`;
  if (isTextureValue(value)) return `t${(value as { uuid?: string }).uuid ?? ""}`;
  if (value !== null && typeof value === "object") return `o${opaqueIdOf(value)}`;
  return `${typeof value}:${String(value)}`;
}

/**
 * The signature two materials must share to draw in one uniform group, or `undefined` when this
 * material may not be in one. Also refreshes the material's cached values, so the per-frame proof
 * below always compares against what this classification saw.
 */
export function uniformSignatureOf(material: Material): string | undefined {
  if (!uniformEligible(material)) return undefined;
  const keys = Object.keys(material);
  const values = Object.values(material);
  let record = records.get(material);
  if (record === undefined) {
    record = {
      values: [],
      identityRanges: new Int32Array(0),
      vectorSlots: [],
      vectorReads: new Uint8Array(0),
      vectorWidths: new Uint8Array(0),
      vectorFields: [],
      components: [],
      defineKeys: [],
      defineValues: [],
      signature: "",
    };
    records.set(material, record);
  }
  const { vectorSlots, vectorFields, components, defineKeys, defineValues } = record;
  const reads: number[] = [];
  const widths: number[] = [];
  vectorSlots.length = 0;
  vectorFields.length = 0;
  components.length = 0;
  const ranges: number[] = [];
  let open = -1;
  let signature = "";
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index] as string;
    const value = values[index];
    const fields = UNREAD_PROPERTIES.has(key) ? undefined : componentFieldsOf(value);
    if (fields === undefined) {
      // The unread and the component-compared are both left out of the identity walk, and either
      // one ends a run of it: the run is only worth having while the positions are consecutive.
      if (UNREAD_PROPERTIES.has(key)) continue;
      if (open === -1) open = index;
    } else {
      if (open !== -1) {
        ranges.push(open, index);
        open = -1;
      }
      vectorSlots.push(index);
      reads.push(readKindOf(fields));
      widths.push(fields.length);
      for (const field of fields) {
        vectorFields.push(field);
        components.push((value as Record<string, number>)[field] as number);
      }
    }
    signature += `${key}=${signatureTextOf(value, fields, components)}|`;
  }
  if (open !== -1) ranges.push(open, keys.length);
  record.values = values;
  record.identityRanges = Int32Array.from(ranges);
  record.vectorReads = Uint8Array.from(reads);
  record.vectorWidths = Uint8Array.from(widths);
  defineKeys.length = 0;
  defineValues.length = 0;
  const defines = material.defines as Record<string, unknown> | undefined;
  if (defines !== null && defines !== undefined) {
    for (const key in defines) {
      defineKeys.push(key);
      defineValues.push(defines[key]);
      signature += `defines.${key}=${signatureTextOf(defines[key], undefined, [])}|`;
    }
  }
  record.signature = signature;
  return signature;
}

/** The three shapes three clones per material, read by name rather than through a variable. */
interface IComponents {
  r: number;
  g: number;
  b: number;
  x: number;
  y: number;
  _x: number;
  _y: number;
  _z: number;
}

/**
 * Whether the material still holds every value its group's shared draw was built from.
 *
 * False is the safe answer: the member leaves the group and is drawn exactly, and the frame's
 * classification is re-derived. True is a claim about the material's whole own value list, read
 * whether or not any of it moved.
 */
export function uniformUnchanged(material: Material): boolean {
  const record = records.get(material);
  // No fingerprint means no group was ever derived from this material, so nothing to have drifted
  // from. Re-deriving the classification is what establishes one.
  if (record === undefined) return true;
  // One read of the material's own values, and the count that says whether a property appeared or
  // disappeared comes with it. Reading each value by name instead is what this replaced, and it is
  // several times slower: an engine cannot fold a lookup through a variable, so eighty-one of
  // them per material is eighty-one dictionary probes, against one copy of eighty-one slots.
  const current = Object.values(material);
  const {
    values,
    identityRanges,
    vectorSlots,
    vectorReads,
    vectorWidths,
    vectorFields,
    components,
  } = record;
  if (current.length !== values.length) return false;
  for (let range = 0; range < identityRanges.length; range += 2) {
    const end = identityRanges[range + 1] as number;
    for (let index = identityRanges[range] as number; index < end; index += 1) {
      if (current[index] !== values[index]) return false;
    }
  }
  let read = 0;
  for (let slot = 0; slot < vectorSlots.length; slot += 1) {
    const value = current[vectorSlots[slot] as number];
    if (value === null || typeof value !== "object") return false;
    const parts = value as IComponents;
    switch (vectorReads[slot]) {
      case READ_RGB:
        if (
          parts.r !== components[read] ||
          parts.g !== components[read + 1] ||
          parts.b !== components[read + 2]
        )
          return false;
        break;
      case READ_XY:
        if (parts.x !== components[read] || parts.y !== components[read + 1]) return false;
        break;
      case READ_UNDERSCORE_XYZ:
        if (
          parts._x !== components[read] ||
          parts._y !== components[read + 1] ||
          parts._z !== components[read + 2]
        )
          return false;
        break;
      default: {
        const fields = value as Record<string, number>;
        const width = vectorWidths[slot] as number;
        for (let part = 0; part < width; part += 1) {
          if (fields[vectorFields[read + part] as string] !== components[read + part]) return false;
        }
      }
    }
    read += vectorWidths[slot] as number;
  }
  const defines = material.defines as Record<string, unknown> | undefined;
  const defineKeys = record.defineKeys;
  let count = 0;
  if (defines !== null && defines !== undefined) {
    for (const key in defines) {
      if (key !== defineKeys[count] || defines[key] !== record.defineValues[count]) return false;
      count += 1;
    }
  }
  return count === defineKeys.length;
}
