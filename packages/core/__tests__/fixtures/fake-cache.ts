/** A smallest-useful Cache API double for `asset-cache.spec.ts` and its priority sibling. */

/** The Cache API stores an entry under the request's absolute url, even when put as a string. */
export function fakeKey(url: string): string {
  try {
    const base = (globalThis as { location?: { href?: string } }).location?.href;
    return new URL(url, base ?? "http://localhost/").href;
  } catch {
    return url;
  }
}

export interface IFakeCacheOptions {
  /** Throw this name on `put` while total stored bytes plus the new body exceed `quotaBytes`. */
  readonly quotaBytes?: number;
  /** Number of `put` calls that throw a quota error regardless of size. */
  readonly failPuts?: number;
  /** Reject every `cache.open`, as a browser with storage blocked does. */
  readonly openError?: boolean;
  /** Hold each `put` this long before it lands, as a real disk write does. */
  readonly putDelayMs?: number;
}

export class FakeCache {
  readonly store = new Map<string, Response>();
  readonly #options: IFakeCacheOptions;
  #puts = 0;

  constructor(options: IFakeCacheOptions = {}) {
    this.#options = options;
  }

  async delete(url: string): Promise<boolean> {
    return this.store.delete(fakeKey(url));
  }

  async keys(): Promise<readonly Request[]> {
    return [...this.store.keys()].map((url) => ({ url }) as Request);
  }

  async match(url: string): Promise<Response | undefined> {
    return this.store.get(fakeKey(url))?.clone();
  }

  async put(url: string, response: Response): Promise<void> {
    this.#puts += 1;
    const wait = this.#options.putDelayMs ?? 0;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    const failPuts = this.#options.failPuts ?? 0;
    if (this.#puts <= failPuts) {
      throw Object.assign(new Error("quota"), { name: "QuotaExceededError" });
    }
    const quota = this.#options.quotaBytes;
    if (quota !== undefined) {
      const stored = [...this.store.values()].reduce(
        (sum, entry) => sum + Number(entry.headers.get("x-tn-bytes") ?? "0"),
        0,
      );
      const incoming = Number(response.headers.get("x-tn-bytes") ?? "0");
      if (stored + incoming > quota) {
        throw Object.assign(new Error("quota"), { name: "QuotaExceededError" });
      }
    }
    this.store.set(fakeKey(url), response.clone());
  }
}

export class FakeCacheStorage {
  readonly caches = new Map<string, FakeCache>();
  readonly #options: IFakeCacheOptions;

  constructor(options: IFakeCacheOptions = {}) {
    this.#options = options;
  }

  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name);
  }

  async keys(): Promise<readonly string[]> {
    return [...this.caches.keys()];
  }

  async open(name: string): Promise<FakeCache> {
    if (this.#options.openError === true) throw new Error("storage blocked");
    let cache = this.caches.get(name);
    if (cache === undefined) {
      cache = new FakeCache(this.#options);
      this.caches.set(name, cache);
    }
    return cache;
  }
}

/** Store one entry as a previous visit would have left it. */
export function seedEntry(cache: FakeCache, url: string, bytes: number, access = 0): void {
  cache.store.set(
    fakeKey(url),
    new Response(new Uint8Array(bytes), {
      headers: { "x-tn-access": String(access), "x-tn-bytes": String(bytes) },
    }),
  );
}
