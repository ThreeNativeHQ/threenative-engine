import type { BufferAttribute, BufferGeometry, InterleavedBufferAttribute } from "three";

/**
 * Content identity for the render projection's instanced lanes.
 *
 * An agent-written game builds `new Mesh(new CylinderGeometry(...), material)` for every copy, so
 * no two copies share a geometry object and a lane keyed on geometry identity batches nothing. The
 * lanes key on a content class instead: every geometry whose attribute layout and bytes are equal
 * shares one class, and the class's `canonical` geometry is what the instanced draw references for
 * all its members. A class is decided once per geometry and kept while the geometry's attributes and
 * versions hold; a geometry whose data moves after that is game-owned live data and leaves for a class
 * of its own, never hashed again, so a streaming geometry costs a version check and nothing more.
 */

/** One set of geometries with byte-identical vertex data. */
export interface IGeometryContentClass {
  /** The member the batch draws for every member. Re-chosen when it leaves the scan or its data moves. */
  canonical: BufferGeometry;
  /** Attribute names, array types, item sizes and lengths, and the index: "" for a class of one. */
  readonly layout: string;
  /** The content hash, computed only once a second geometry of the same layout needs comparing. */
  hash: number | undefined;
  /** The scan that last saw a member, the first member it saw, and whether `canonical` was among them. */
  scan: number;
  first: BufferGeometry | undefined;
  canonicalSeen: boolean;
}

/** A geometry's class, with the attribute identities and version sum that keep it valid. */
export interface IGeometryContentEntry {
  /** Unset only between a first sighting and the end of the scan that classifies it. */
  cls: IGeometryContentClass | undefined;
  /** The attributes in iteration order, then the index: a swapped attribute moves no version. */
  readonly parts: unknown[];
  sum: number;
  scan: number;
  /** Its data moved after it was classed: a class of its own from then on. */
  streamed: boolean;
}

function versionOf(attribute: BufferAttribute | InterleavedBufferAttribute): number {
  if ("isInterleavedBufferAttribute" in attribute) return attribute.data.version;
  return attribute.version;
}

/** Records the attribute identities and version sum the entry is valid for. */
export function recordContentParts(entry: IGeometryContentEntry, geometry: BufferGeometry): void {
  let count = 0;
  let sum = 0;
  for (const name in geometry.attributes) {
    if (!Object.hasOwn(geometry.attributes, name)) continue;
    const attribute = geometry.attributes[name] as BufferAttribute;
    entry.parts[count] = attribute;
    count += 1;
    sum += versionOf(attribute);
  }
  const index = geometry.getIndex();
  entry.parts[count] = index;
  entry.parts.length = count + 1;
  entry.sum = index === null ? sum : sum + versionOf(index);
}

/** Whether the geometry still holds the attributes, index and versions the entry recorded. */
export function contentPartsUnchanged(
  entry: IGeometryContentEntry,
  geometry: BufferGeometry,
): boolean {
  const parts = entry.parts;
  let count = 0;
  let sum = 0;
  for (const name in geometry.attributes) {
    if (!Object.hasOwn(geometry.attributes, name)) continue;
    const attribute = geometry.attributes[name] as BufferAttribute;
    if (parts[count] !== attribute) return false;
    count += 1;
    sum += versionOf(attribute);
  }
  const index = geometry.getIndex();
  if (parts[count] !== index || parts.length !== count + 1) return false;
  return (index === null ? sum : sum + versionOf(index)) === entry.sum;
}

/**
 * Whether content identity applies at all. An instanced geometry's draw count and an interleaved
 * buffer's stride are not in the bytes compared, so each keeps a class of its own.
 */
export function contentMergeable(geometry: BufferGeometry): boolean {
  if ((geometry as { isInstancedBufferGeometry?: boolean }).isInstancedBufferGeometry === true)
    return false;
  for (const name in geometry.attributes) {
    if (!Object.hasOwn(geometry.attributes, name)) continue;
    if ("isInterleavedBufferAttribute" in (geometry.attributes[name] as object)) return false;
  }
  return true;
}

function arrayOf(attribute: BufferAttribute): ArrayBufferView & { length: number } {
  return attribute.array as unknown as ArrayBufferView & { length: number };
}

/** Everything but the bytes: two geometries with different layouts can never share a class. */
export function contentLayout(geometry: BufferGeometry): string {
  const index = geometry.getIndex();
  let layout =
    index === null ? "n" : `i${arrayOf(index).constructor.name}:${arrayOf(index).length}`;
  const names = Object.keys(geometry.attributes).sort();
  for (let at = 0; at < names.length; at += 1) {
    const name = names[at] as string;
    const attribute = geometry.attributes[name] as BufferAttribute;
    const array = arrayOf(attribute);
    layout += ` ${name}:${attribute.itemSize}:${attribute.normalized ? 1 : 0}:${array.constructor.name}:${array.length}`;
  }
  return layout;
}

function words(view: ArrayBufferView): Int32Array | undefined {
  return view.byteOffset % 4 === 0
    ? new Int32Array(view.buffer, view.byteOffset, view.byteLength >> 2)
    : undefined;
}

function hashView(seed: number, view: ArrayBufferView): number {
  let hash = seed;
  const packed = words(view);
  let tail = 0;
  if (packed !== undefined) {
    for (let at = 0; at < packed.length; at += 1)
      hash = Math.imul(hash ^ (packed[at] as number), 0x01000193);
    tail = packed.length * 4;
  }
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  for (let at = tail; at < bytes.length; at += 1)
    hash = Math.imul(hash ^ (bytes[at] as number), 0x01000193);
  return hash;
}

/** FNV-1a over the index and every attribute's bytes, in name order. */
export function contentHash(geometry: BufferGeometry): number {
  let hash = 0x811c9dc5;
  const index = geometry.getIndex();
  if (index !== null) hash = hashView(hash, arrayOf(index));
  const names = Object.keys(geometry.attributes).sort();
  for (let at = 0; at < names.length; at += 1)
    hash = hashView(hash, arrayOf(geometry.attributes[names[at] as string] as BufferAttribute));
  return hash >>> 0;
}

function sameView(a: ArrayBufferView, b: ArrayBufferView): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const wordsA = words(a);
  const wordsB = words(b);
  let tail = 0;
  if (wordsA !== undefined && wordsB !== undefined) {
    for (let at = 0; at < wordsA.length; at += 1) if (wordsA[at] !== wordsB[at]) return false;
    tail = wordsA.length * 4;
  }
  const bytesA = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const bytesB = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  for (let at = tail; at < bytesA.length; at += 1) if (bytesA[at] !== bytesB[at]) return false;
  return true;
}

/** The full byte compare behind an equal hash, for two geometries of one layout: no false merge. */
export function sameContent(a: BufferGeometry, b: BufferGeometry): boolean {
  const indexA = a.getIndex();
  const indexB = b.getIndex();
  if ((indexA === null) !== (indexB === null)) return false;
  if (indexA !== null && !sameView(arrayOf(indexA), arrayOf(indexB as BufferAttribute)))
    return false;
  for (const name in a.attributes) {
    if (!Object.hasOwn(a.attributes, name)) continue;
    const other = b.attributes[name] as BufferAttribute | undefined;
    if (other === undefined) return false;
    if (!sameView(arrayOf(a.attributes[name] as BufferAttribute), arrayOf(other))) return false;
  }
  return true;
}

/** A class of one: a geometry that content identity does not apply to, or whose data moved. */
export function ownContentClass(geometry: BufferGeometry): IGeometryContentClass {
  return {
    canonical: geometry,
    layout: "",
    hash: undefined,
    scan: 0,
    first: undefined,
    canonicalSeen: false,
  };
}
