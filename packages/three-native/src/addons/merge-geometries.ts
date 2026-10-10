// Ported from three.js r185 (three@0.185.1). The MIT License, Copyright © 2010-2026 three.js authors.
/**
 * three's `BufferGeometryUtils.mergeGeometries`, `mergeAttributes` and `mergeVertices` (three@0.185.1
 * examples/jsm/utils/BufferGeometryUtils.js) over an engine's own BufferGeometry and
 * BufferAttribute, for both back ends.
 *
 * One order differs from three's, never a result: three builds the merged BufferAttribute around an
 * empty typed array and fills the array afterwards, which works because three keeps the array it is
 * handed. An engine attribute copies its array when it is built, so the array is filled first.
 * Every refusal is three's: `console.error` with three's message, then `null`.
 */

type TypedArray =
  | Float32Array
  | Uint8Array
  | Uint16Array
  | Uint32Array
  | Int8Array
  | Int16Array
  | Int32Array;

interface IAttributeLike {
  readonly array: TypedArray;
  readonly itemSize: number;
  readonly normalized: boolean;
  readonly count: number;
  gpuType?: number;
  readonly isInterleavedBufferAttribute?: boolean;
  getComponent(index: number, component: number): number;
}

interface IGeometryLike {
  readonly index: (IAttributeLike & { getX(index: number): number }) | null;
  readonly attributes: Readonly<Record<string, IAttributeLike>>;
  readonly morphAttributes: Readonly<Record<string, readonly IAttributeLike[]>>;
  readonly morphTargetsRelative: boolean;
}

interface IVertexGeometry extends IGeometryLike {
  getIndex(): IGeometryLike["index"];
  clone(): IMergedGeometry;
}

/** three's MathUtils.denormalize and normalize: a normalized integer attribute's stored value and its number. */
function denormalize(value: number, array: TypedArray): number {
  if (array instanceof Uint32Array) return value / 4294967295;
  if (array instanceof Uint16Array) return value / 65535;
  if (array instanceof Uint8Array) return value / 255;
  if (array instanceof Int32Array) return Math.max(value / 2147483647, -1);
  if (array instanceof Int16Array) return Math.max(value / 32767, -1);
  if (array instanceof Int8Array) return Math.max(value / 127, -1);
  return value;
}
function normalize(value: number, array: TypedArray): number {
  if (array instanceof Uint32Array) return Math.round(value * 4294967295);
  if (array instanceof Uint16Array) return Math.round(value * 65535);
  if (array instanceof Uint8Array) return Math.round(value * 255);
  if (array instanceof Int32Array) return Math.round(value * 2147483647);
  if (array instanceof Int16Array) return Math.round(value * 32767);
  if (array instanceof Int8Array) return Math.round(value * 127);
  return value;
}

/** three's `attribute.getX(index)` and its siblings for one component. */
function component(attribute: IAttributeLike, index: number, k: number): number {
  if (attribute.isInterleavedBufferAttribute) return attribute.getComponent(index, k);
  const value = attribute.array[index * attribute.itemSize + k] as number;
  return attribute.normalized ? denormalize(value, attribute.array) : value;
}

/** three's `attribute.setX(index, value)` into the array a new attribute is built from. */
function store(array: TypedArray, source: IAttributeLike, at: number, value: number): void {
  array[at] = source.normalized ? normalize(value, array) : value;
}

interface IMergedGeometry {
  addGroup(start: number, count: number, materialIndex: number): void;
  setIndex(index: IAttributeLike | number[]): void;
  setAttribute(name: string, attribute: IAttributeLike): void;
  morphAttributes: Record<string, IAttributeLike[]>;
}

/**
 * The merged index three builds with `getX` per element, from each index's array read once: an
 * engine attribute's getX is a crossing per call. Typed as three's setIndex(number[]) types it:
 * Uint32 when any value reaches 65535, each value converted as that array converts it.
 */
function mergedIndex(geometries: readonly IGeometryLike[]): Uint16Array | Uint32Array {
  let length = 0;
  for (const geometry of geometries) length += (geometry.index as IAttributeLike).count;
  const values = new Float64Array(length);
  let at = 0;
  let offset = 0;
  let wide = false;
  for (const geometry of geometries) {
    const index = geometry.index as IAttributeLike;
    const count = index.count;
    const array = index.isInterleavedBufferAttribute || index.normalized ? undefined : index.array;
    const step = index.itemSize;
    for (let j = 0; j < count; ++j) {
      const value = (array ? (array[j * step] as number) : component(index, j, 0)) + offset;
      wide ||= value >= 65535;
      values[at++] = value;
    }
    offset += (geometry.attributes.position as IAttributeLike).count;
  }
  return wide ? new Uint32Array(values) : new Uint16Array(values);
}

/** What one engine supplies: the two classes a merge builds. */
export interface IGeometryUtilsEngine {
  // quality-allow: three's PascalCase class name passed in engine constructor map.
  // biome-ignore lint/style/useNamingConvention: three's class name, so a back end passes its class map.
  readonly BufferGeometry: new () => object;
  // quality-allow: three's PascalCase class name passed in engine constructor map.
  // biome-ignore lint/style/useNamingConvention: see BufferGeometry.
  readonly BufferAttribute: new (
    array: TypedArray,
    itemSize: number,
    normalized?: boolean,
  ) => object;
}

const PREFIX = "THREE.BufferGeometryUtils:";

export function defineBufferGeometryUtils(engine: IGeometryUtilsEngine) {
  function mergeAttributes(attributes: readonly IAttributeLike[]): IAttributeLike | null {
    let Typed: (new (length: number) => TypedArray) | undefined;
    let itemSize: number | undefined;
    let normalized: boolean | undefined;
    let gpuType: number | undefined = -1;
    let arrayLength = 0;
    for (const attribute of attributes) {
      const made = attribute.array.constructor as new (length: number) => TypedArray;
      Typed ??= made;
      if (Typed !== made) {
        console.error(
          `${PREFIX} .mergeAttributes() failed. BufferAttribute.array must be of consistent array types across matching attributes.`,
        );
        return null;
      }
      itemSize ??= attribute.itemSize;
      if (itemSize !== attribute.itemSize) {
        console.error(
          `${PREFIX} .mergeAttributes() failed. BufferAttribute.itemSize must be consistent across matching attributes.`,
        );
        return null;
      }
      normalized ??= attribute.normalized;
      if (normalized !== attribute.normalized) {
        console.error(
          `${PREFIX} .mergeAttributes() failed. BufferAttribute.normalized must be consistent across matching attributes.`,
        );
        return null;
      }
      if (gpuType === -1) gpuType = attribute.gpuType;
      if (gpuType !== attribute.gpuType) {
        console.error(
          `${PREFIX} .mergeAttributes() failed. BufferAttribute.gpuType must be consistent across matching attributes.`,
        );
        return null;
      }
      arrayLength += attribute.count * itemSize;
    }
    if (Typed === undefined || itemSize === undefined) return null;
    const array = new Typed(arrayLength);
    let offset = 0;
    for (const attribute of attributes) {
      if (attribute.isInterleavedBufferAttribute) {
        for (let j = 0; j < attribute.count; j++)
          for (let c = 0; c < itemSize; c++)
            array[offset + j * itemSize + c] = attribute.getComponent(j, c);
      } else array.set(attribute.array, offset);
      offset += attribute.count * itemSize;
    }
    const result = new engine.BufferAttribute(array, itemSize, normalized) as IAttributeLike;
    // The engine attribute already holds three's default; its gpuType is written only to change it.
    if (gpuType !== undefined && result.gpuType !== gpuType) result.gpuType = gpuType;
    return result;
  }

  // Each geometry's attributes and morph attributes, grouped by name; a string is three's refusal.
  function collect(
    geometries: readonly IGeometryLike[],
    merged: IMergedGeometry,
    useGroups: boolean,
  ) {
    const first = geometries[0] as IGeometryLike;
    const isIndexed = first.index !== null;
    const attributesUsed = new Set(Object.keys(first.attributes));
    const morphAttributesUsed = new Set(Object.keys(first.morphAttributes));
    const attributes: Record<string, IAttributeLike[]> = {};
    const morphAttributes: Record<string, (readonly IAttributeLike[])[]> = {};
    let offset = 0;
    for (const [i, geometry] of geometries.entries()) {
      const at = `${PREFIX} .mergeGeometries() failed with geometry at index ${i}.`;
      if (isIndexed !== (geometry.index !== null))
        return `${at} All geometries must have compatible attributes; make sure index attribute exists among all geometries, or in none of them.`;
      let attributesCount = 0;
      for (const name of Object.keys(geometry.attributes)) {
        if (!attributesUsed.has(name))
          return `${at} All geometries must have compatible attributes; make sure "${name}" attribute exists among all geometries, or in none of them.`;
        attributes[name] ??= [];
        attributes[name].push(geometry.attributes[name] as IAttributeLike);
        attributesCount++;
      }
      if (attributesCount !== attributesUsed.size)
        return `${at} Make sure all geometries have the same number of attributes.`;
      if (first.morphTargetsRelative !== geometry.morphTargetsRelative)
        return `${at} .morphTargetsRelative must be consistent throughout all geometries.`;
      for (const name of Object.keys(geometry.morphAttributes)) {
        if (!morphAttributesUsed.has(name))
          return `${at}  .morphAttributes must be consistent throughout all geometries.`;
        morphAttributes[name] ??= [];
        morphAttributes[name].push(geometry.morphAttributes[name] as readonly IAttributeLike[]);
      }
      if (useGroups) {
        const count = isIndexed ? geometry.index?.count : geometry.attributes.position?.count;
        if (count === undefined)
          return `${at} The geometry must have either an index or a position attribute`;
        merged.addGroup(offset, count, i);
        offset += count;
      }
    }
    return { attributes, morphAttributes, isIndexed };
  }

  function mergeGeometries(geometries: readonly IGeometryLike[], useGroups = false): object | null {
    const merged = new engine.BufferGeometry() as IMergedGeometry;
    const found = collect(geometries, merged, useGroups);
    if (typeof found === "string") {
      console.error(found);
      return null;
    }
    if (found.isIndexed)
      merged.setIndex(new engine.BufferAttribute(mergedIndex(geometries), 1) as IAttributeLike);
    for (const [name, list] of Object.entries(found.attributes)) {
      const attribute = mergeAttributes(list);
      if (!attribute) {
        console.error(
          `${PREFIX} .mergeGeometries() failed while trying to merge the ${name} attribute.`,
        );
        return null;
      }
      merged.setAttribute(name, attribute);
    }
    for (const [name, perGeometry] of Object.entries(found.morphAttributes)) {
      const numMorphTargets = (perGeometry[0] as readonly IAttributeLike[]).length;
      if (numMorphTargets === 0) continue;
      const targets: IAttributeLike[] = [];
      for (let i = 0; i < numMorphTargets; ++i) {
        const attribute = mergeAttributes(perGeometry.map((list) => list[i] as IAttributeLike));
        if (!attribute) {
          console.error(
            `${PREFIX} .mergeGeometries() failed while trying to merge the ${name} morphAttribute.`,
          );
          return null;
        }
        targets.push(attribute);
      }
      merged.morphAttributes[name] = targets;
    }
    return merged;
  }

  /**
   * three's mergeVertices: vertices whose attributes hash alike (to `tolerance`) become one vertex,
   * and the clone is re-indexed. The merged attributes are engine BufferAttributes over the source
   * arrays' types, as three keeps each attribute's constructor.
   */
  function mergeVertices(geometry: IVertexGeometry, tolerance = 1e-4): object {
    const used = Math.max(tolerance, Number.EPSILON);
    const hashToIndex = new Map<string, number>();
    const indices = geometry.getIndex();
    const positions = geometry.attributes.position as IAttributeLike;
    const vertexCount = indices ? indices.count : positions.count;
    const names = Object.keys(geometry.attributes);
    const arrays: Record<string, TypedArray> = {};
    const morphArrays: Record<string, TypedArray[]> = {};
    const made = (attribute: IAttributeLike) =>
      new (attribute.array.constructor as new (length: number) => TypedArray)(
        attribute.count * attribute.itemSize,
      );
    for (const name of names) {
      arrays[name] = made(geometry.attributes[name] as IAttributeLike);
      const morphs = geometry.morphAttributes[name];
      if (morphs) morphArrays[name] = morphs.map(made);
    }
    const hashMultiplier = 10 ** Math.log10(1 / used);
    const hashAdditive = used * 0.5 * hashMultiplier;
    const newIndices: number[] = [];
    let nextIndex = 0;
    for (let i = 0; i < vertexCount; i++) {
      const index = indices ? indices.getX(i) : i;
      let hash = "";
      for (const name of names) {
        const attribute = geometry.attributes[name] as IAttributeLike;
        for (let k = 0; k < attribute.itemSize; k++)
          hash += `${~~(component(attribute, index, k) * hashMultiplier + hashAdditive)},`;
      }
      const known = hashToIndex.get(hash);
      if (known !== undefined) {
        newIndices.push(known);
        continue;
      }
      for (const name of names) {
        const attribute = geometry.attributes[name] as IAttributeLike;
        const morphs = geometry.morphAttributes[name];
        for (let k = 0; k < attribute.itemSize; k++) {
          const at = nextIndex * attribute.itemSize + k;
          store(arrays[name] as TypedArray, attribute, at, component(attribute, index, k));
          morphs?.forEach((morph, m) => {
            const target = (morphArrays[name] as TypedArray[])[m] as TypedArray;
            store(target, morph, nextIndex * morph.itemSize + k, component(morph, index, k));
          });
        }
      }
      hashToIndex.set(hash, nextIndex);
      newIndices.push(nextIndex);
      nextIndex++;
    }
    const result = geometry.clone();
    const rebuilt = (array: TypedArray, source: IAttributeLike) =>
      new engine.BufferAttribute(
        array.slice(0, nextIndex * source.itemSize),
        source.itemSize,
        source.normalized,
      ) as IAttributeLike;
    for (const name of names) {
      result.setAttribute(
        name,
        rebuilt(arrays[name] as TypedArray, geometry.attributes[name] as IAttributeLike),
      );
      const morphs = geometry.morphAttributes[name];
      if (morphs)
        result.morphAttributes[name] = morphs.map((morph, m) =>
          rebuilt((morphArrays[name] as TypedArray[])[m] as TypedArray, morph),
        );
    }
    result.setIndex(newIndices);
    return result;
  }

  return { mergeGeometries, mergeAttributes, mergeVertices };
}
