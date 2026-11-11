import { type CacheLike, cacheStorage, manifestFingerprint } from "./asset-cache.js";
import { isNative } from "./platform.js";

/**
 * Generated content kept between runs (PRD-860): `ctx.assets.memo(key, build)` returns what `build`
 * returned the last time this exact build of the game ran, read back from disk, and calls `build`
 * only when nothing is stored. A seeded world, a painted sky or a baked placement list is the same
 * every run of one build, so a repeat visit stops paying for it.
 *
 * The value is named typed arrays, the shape a generator hands to geometry, instancing and
 * textures. The build identity is the hashed entry script the web build writes into the page
 * (`__TN_BUILD_ID__`), so any code change regenerates and the old build's entries are deleted. With
 * no build identity (the dev server) or no Cache API (a native host), `build` runs every time and
 * `TN_ASSET_MEMO` says why.
 */
export type MemoArray =
  | Float32Array
  | Float64Array
  | Int8Array
  | Int16Array
  | Int32Array
  | Uint8Array
  | Uint8ClampedArray
  | Uint16Array
  | Uint32Array;

export type MemoArrays = Readonly<Record<string, MemoArray>>;
/** Every field a typed array: a record or an interface, which has no index signature. */
export type MemoShape<T> = { readonly [K in keyof T]: MemoArray };

export type AssetMemo = <T extends MemoShape<T>>(
  key: string,
  build: () => T | Promise<T>,
) => Promise<T>;

const KINDS = {
  Float32Array,
  Float64Array,
  Int16Array,
  Int32Array,
  Int8Array,
  Uint16Array,
  Uint32Array,
  Uint8Array,
  Uint8ClampedArray,
} as const;
type Kind = keyof typeof KINDS;

const BUILD_ID_GLOBAL = "__TN_BUILD_ID__";
const MEMO_CACHE = "threenative-memo";
/** A host no request ever reaches: the Cache API only needs an absolute url to key on. */
const MEMO_ORIGIN = "https://memo.threenative.invalid/";
const MAGIC = 0x4f4d4e54; // "TNMO"

function invalid(detail: string): Error {
  return new Error(`TN_ASSET_MEMO_INVALID: ${detail}`);
}

function kindOf(value: unknown): Kind | undefined {
  for (const kind of Object.keys(KINDS) as Kind[]) if (value instanceof KINDS[kind]) return kind;
  return undefined;
}

/** Header (magic, JSON length, JSON) then each array's bytes at an 8-byte boundary. */
export function encodeMemo(value: MemoArrays): ArrayBuffer {
  const entries = Object.entries(value).map(([name, array]) => {
    const kind = kindOf(array);
    if (kind === undefined) throw invalid(`"${name}" is not a typed array.`);
    return { array, kind, name };
  });
  const align = (n: number): number => Math.ceil(n / 8) * 8;
  const header = new TextEncoder().encode(
    JSON.stringify(entries.map(({ array, kind, name }) => ({ kind, length: array.length, name }))),
  );
  let offset = align(8 + header.byteLength);
  const placed = entries.map((entry) => {
    const at = offset;
    offset = align(at + entry.array.byteLength);
    return { ...entry, at };
  });
  const buffer = new ArrayBuffer(offset);
  const view = new DataView(buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, header.byteLength, true);
  new Uint8Array(buffer, 8, header.byteLength).set(header);
  for (const { array, at } of placed)
    new Uint8Array(buffer, at, array.byteLength).set(
      new Uint8Array(array.buffer, array.byteOffset, array.byteLength),
    );
  return buffer;
}

/** The inverse of `encodeMemo`; throws on anything it did not write. */
export function decodeMemo(buffer: ArrayBuffer): Record<string, MemoArray> {
  const view = new DataView(buffer);
  if (buffer.byteLength < 8 || view.getUint32(0, true) !== MAGIC)
    throw invalid("stored entry is not a memo.");
  const headerBytes = view.getUint32(4, true);
  if (8 + headerBytes > buffer.byteLength) throw invalid("stored entry is truncated.");
  const header: unknown = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buffer, 8, headerBytes)),
  );
  if (!Array.isArray(header)) throw invalid("stored entry has no array list.");
  const result: Record<string, MemoArray> = {};
  let offset = Math.ceil((8 + headerBytes) / 8) * 8;
  for (const entry of header as Array<{ kind?: unknown; length?: unknown; name?: unknown }>) {
    const kind = entry.kind as Kind;
    const Ctor = KINDS[kind];
    if (Ctor === undefined || typeof entry.name !== "string" || !Number.isInteger(entry.length))
      throw invalid("stored entry has a malformed array.");
    const length = entry.length as number;
    const bytes = length * Ctor.BYTES_PER_ELEMENT;
    if (offset + bytes > buffer.byteLength) throw invalid("stored entry is truncated.");
    result[entry.name] = new Ctor(buffer, offset, length);
    offset = Math.ceil((offset + bytes) / 8) * 8;
  }
  return result;
}

function report(fields: Record<string, unknown>): void {
  console.info(`TN_ASSET_MEMO:${JSON.stringify(fields)}`);
}

function now(): number {
  return globalThis.performance?.now() ?? Date.now();
}

export function createAssetMemo(namespace: string): AssetMemo {
  const storage = cacheStorage();
  const id = (globalThis as Record<string, unknown>)[BUILD_ID_GLOBAL];
  const buildId = typeof id === "string" && id !== "" ? id : undefined;
  const reason =
    storage === undefined
      ? isNative()
        ? "native host has no Cache API: generated content rebuilds each run"
        : "cache API unavailable: generated content rebuilds each run"
      : buildId === undefined
        ? "no build id (dev server or a page the web build did not write): generated content rebuilds each run"
        : undefined;
  const prefix = buildId === undefined ? "" : `${MEMO_ORIGIN}${encodeURIComponent(buildId)}/`;
  const name = `${MEMO_CACHE}-${manifestFingerprint([{ url: namespace }]).slice(0, 8)}`;
  let opened: Promise<CacheLike | undefined> | undefined;
  /** Opens once, deleting what another build stored, so a cache holds one build's content. */
  const open = (): Promise<CacheLike | undefined> => {
    opened ??= (async () => {
      const cache = await storage?.open(name);
      if (cache === undefined) return undefined;
      for (const request of await cache.keys())
        if (!request.url.startsWith(prefix)) await cache.delete(request.url);
      return cache;
    })().catch(() => undefined);
    return opened;
  };
  const checked = <T extends MemoShape<T>>(key: string, value: T): T => {
    if (typeof value !== "object" || value === null)
      throw invalid(`build for "${key}" returned no object.`);
    for (const [field, array] of Object.entries(value))
      if (kindOf(array) === undefined)
        throw invalid(`build for "${key}" returned "${field}", not a typed array.`);
    return value;
  };

  return async <T extends MemoShape<T>>(key: string, build: () => T | Promise<T>): Promise<T> => {
    if (typeof key !== "string" || key === "") throw invalid("key must be a non-empty string.");
    const started = now();
    if (reason !== undefined) {
      const value = checked(key, await build());
      report({ key, hit: false, ms: Math.round(now() - started), reason });
      return value;
    }
    const url = `${prefix}${encodeURIComponent(key)}`;
    const cache = await open();
    if (cache !== undefined) {
      try {
        const stored = await cache.match(url);
        if (stored !== undefined) {
          const buffer = await stored.arrayBuffer();
          const value = decodeMemo(buffer) as T;
          report({ bytes: buffer.byteLength, hit: true, key, ms: Math.round(now() - started) });
          return value;
        }
      } catch {
        // A damaged entry is a miss: delete it and build, never fail the load over a cache.
        await cache.delete(url).catch(() => undefined);
      }
    }
    const value = checked(key, await build());
    const encoded = encodeMemo(value as MemoArrays);
    const builtMs = Math.round(now() - started);
    if (cache === undefined) {
      report({ hit: false, key, ms: builtMs, reason: "cache storage refused to open" });
      return value;
    }
    void cache
      .put(url, new Response(encoded))
      .then(() => report({ bytes: encoded.byteLength, hit: false, key, ms: builtMs, stored: true }))
      .catch((error: unknown) =>
        report({ hit: false, key, ms: builtMs, stored: false, reason: String(error) }),
      );
    return value;
  };
}
