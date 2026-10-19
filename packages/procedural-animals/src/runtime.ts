import { BufferAttribute, BufferGeometry } from "three";
import { ANIMAL_LIMITS, animalError, parseAnimalBake, requireValidatedBake } from "./format.js";
import type { IAnimalBake } from "./format.js";

export interface IAnimalAssetResolver {
  resolve(path: string): Promise<readonly string[]>;
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw animalError("ABORTED", "animal load cancelled");
}

function abortable<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
  cancel?: () => void,
): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cancel?.();
      signal.removeEventListener("abort", onAbort);
      reject(animalError("ABORTED", "animal load cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) onAbort();
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        if (signal.aborted) onAbort();
        else reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

async function readBoundedBody(response: Response, signal?: AbortSignal): Promise<ArrayBuffer> {
  // The current native fetch host supplies an already-buffered body without Response.body.
  // This still rejects oversized bytes before geometry; it does not claim a native transport cap.
  if (!response.body) {
    const bytes = await abortable(response.arrayBuffer(), signal);
    if (bytes.byteLength > ANIMAL_LIMITS.bytes)
      throw animalError("LIMIT", "decoded body exceeds the payload byte limit");
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  try {
    for (;;) {
      checkCancelled(signal);
      const result = await abortable(reader.read(), signal, cancel);
      checkCancelled(signal);
      if (result.done) break;
      length += result.value.byteLength;
      if (length > ANIMAL_LIMITS.bytes)
        throw animalError("LIMIT", "decoded body exceeds the payload byte limit");
      chunks.push(result.value);
    }
    const buffer = new ArrayBuffer(length);
    const bytes = new Uint8Array(buffer);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return buffer;
  } catch (error) {
    cancel();
    checkCancelled(signal);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

/** Resolve a cooked logical asset with ctx.assets and load only a validated bake. */
export async function loadAnimalBake(
  assets: IAnimalAssetResolver,
  logicalPath: string,
  options: { readonly signal?: AbortSignal } = {},
): Promise<IAnimalBake> {
  checkCancelled(options.signal);
  const urls = await abortable(assets.resolve(logicalPath), options.signal);
  checkCancelled(options.signal);
  if (urls.length === 0) throw animalError("LOAD", `${logicalPath} resolved to no asset`);
  const failures: string[] = [];
  for (const url of urls) {
    let response: Response;
    try {
      response = await fetch(url, { signal: options.signal });
    } catch (error) {
      checkCancelled(options.signal);
      failures.push(`${url}: ${String(error)}`);
      continue;
    }
    if (options.signal?.aborted) {
      await response.body?.cancel().catch(() => undefined);
      checkCancelled(options.signal);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      failures.push(`${url}: HTTP ${response.status}`);
      continue;
    }
    const announced = response.headers.get("content-length");
    if (announced !== null && Number(announced) > ANIMAL_LIMITS.bytes) {
      await response.body?.cancel().catch(() => undefined);
      throw animalError("LIMIT", `${logicalPath} exceeds the payload byte limit`);
    }
    const buffer = await readBoundedBody(response, options.signal);
    checkCancelled(options.signal);
    // A corrupt served file is an error, never a fallback to another animal/source.
    return parseAnimalBake(buffer);
  }
  throw animalError("LOAD", `${logicalPath} failed: ${failures.join("; ")}`);
}

/** Create geometry only after the complete binary has passed validation. */
export function createAnimalGeometry(buffer: ArrayBuffer): {
  readonly bake: IAnimalBake;
  readonly geometry: BufferGeometry;
} {
  const bake = parseAnimalBake(buffer);
  return { bake, geometry: geometryFromValidatedBake(bake) };
}

export function geometryFromValidatedBake(bake: IAnimalBake): BufferGeometry {
  requireValidatedBake(bake);
  const geometry = new BufferGeometry();
  for (const [name, data, size] of [
    ["position", bake.pos, 3],
    ["normal", bake.nrm, 3],
    ["skinIndex", bake.skinIndex, 4],
    ["skinWeight", bake.skinWeight, 4],
    ["aComb", bake.comb, 3],
    ["aTint", bake.tint, 4],
    ["aCoat", bake.coat, 4],
    ["aPat", bake.pat, 4],
    ["aSurf", bake.surf, 4],
  ] as const)
    geometry.setAttribute(name, new BufferAttribute(data.slice(), size));
  geometry.setIndex(new BufferAttribute(bake.index.slice(), 1));
  return geometry;
}
