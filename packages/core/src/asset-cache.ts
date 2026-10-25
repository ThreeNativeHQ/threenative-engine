import { isNative } from "./platform.js";

/**
 * What a request is worth relative to the rest of the queue.
 *
 * `now` is a file the running scene awaits, `soon` is a `WorldCells` prefetch, and `idle` is the
 * background fill. A `now` request starts at once and pauses new `soon` and `idle` starts until it
 * settles, so a fill can never sit in front of the file the frame needs.
 */
export type AssetPriority = "now" | "soon" | "idle";

export interface IAssetCacheEntry {
  /** The compiled size the manifest records, when it records one. */
  readonly bytes?: number;
  readonly url: string;
}

export interface IAssetCacheReport {
  /** False on a native host, with `reason`, or when the game passed `assets.cache: false`. */
  readonly enabled: boolean;
  /** Whether the browser granted persistent storage. False when it refused or could not answer. */
  readonly persisted: boolean;
  readonly hits: number;
  readonly misses: number;
  readonly bytesOnDisk: number;
  readonly bytesTotal: number;
  readonly filling: boolean;
  /** True when the post-reveal fill is allowed (`assets.backgroundFill` and no `saveData`). */
  readonly backgroundFill: boolean;
  readonly reason?: string;
}

export interface IAssetCacheOptions {
  /** `assets.cache: false` — the named override. */
  readonly enabled?: boolean;
  /** `assets.backgroundFill: false` — the named override. */
  readonly backgroundFill?: boolean;
  /** Requests running at once. Defaults to six, the same as the streaming loader. */
  readonly concurrency?: number;
  /** Retry delays in milliseconds. Defaults to 500, 1000 and 2000. */
  readonly retryDelaysMs?: readonly number[];
  /** A stable game identity, so two games on one origin do not delete each other's cache. */
  readonly namespace?: string;
}

export interface IAssetCache {
  readonly enabled: boolean;
  readonly report: IAssetCacheReport;
  /** Bytes for `url`, from disk when present and from the network otherwise. */
  fetchBytes(url: string, priority?: AssetPriority, expectedBytes?: number): Promise<ArrayBuffer>;
  /** Warm the disk with these files. Resolves when every request settles. */
  prefetch(entries: readonly IAssetCacheEntry[]): Promise<void>;
  /** Name the release and the files it publishes. Called once, when the manifest lands. */
  setManifest(entries: readonly IAssetCacheEntry[]): void;
  /** Start the post-reveal fill of everything not on disk yet. Idempotent. */
  startFill(): Promise<void>;
  /** Delete the whole cache. */
  clear(): Promise<void>;
  /** Remove the disk-first fetch bridge. Idempotent. */
  dispose(): void;
}

const CACHE_NAME = "threenative-assets";
const DEFAULT_CONCURRENCY = 6;
const DEFAULT_RETRY_DELAYS_MS = [500, 1000, 2000] as const;
const BYTES_HEADER = "x-tn-bytes";
const ACCESS_HEADER = "x-tn-access";
/** How often a read refreshes an entry's access stamp. Unreal purges at the same granularity. */
const ACCESS_REFRESH_MS = 3_600_000;

const PRIORITY_ORDER: Record<AssetPriority, number> = { now: 0, soon: 1, idle: 2 };

type CacheStorageLike = {
  delete(name: string): Promise<boolean>;
  keys(): Promise<readonly string[]>;
  open(name: string): Promise<CacheLike>;
};

type CacheLike = {
  delete(request: string): Promise<boolean>;
  keys(): Promise<readonly Request[]>;
  match(request: string): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
};

interface IJob {
  readonly expectedBytes: number | undefined;
  readonly reject: (error: unknown) => void;
  readonly resolve: (buffer: ArrayBuffer) => void;
  readonly url: string;
  priority: AssetPriority;
}

function cacheStorage(): CacheStorageLike | undefined {
  return (globalThis as { caches?: CacheStorageLike }).caches;
}

function storageManager():
  | {
      persist?: () => Promise<boolean>;
      persisted?: () => Promise<boolean>;
    }
  | undefined {
  return (
    globalThis as {
      navigator?: {
        storage?: {
          persist?: () => Promise<boolean>;
          persisted?: () => Promise<boolean>;
        };
      };
    }
  ).navigator?.storage;
}

function saveDataEnabled(): boolean {
  return (
    (globalThis as { navigator?: { connection?: { saveData?: boolean } } }).navigator?.connection
      ?.saveData === true
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Cache keys are compared as absolute urls; a `Request.url` always is one. */
function canonicalUrl(url: string): string {
  try {
    const base = (globalThis as { location?: { href?: string } }).location?.href;
    return new URL(url, base ?? "http://localhost/").href;
  } catch {
    return url;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** FNV-1a over the release's own file names and sizes: stable, cheap and not a security claim. */
export function manifestFingerprint(entries: readonly IAssetCacheEntry[]): string {
  let hash = 0x811c9dc5;
  for (const entry of entries) {
    const text = `${entry.url}:${entry.bytes ?? 0};`;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * The disk and network layer under the asset loader.
 *
 * Content-addressed outputs never go stale, so an entry needs no revalidation. Each game keeps one
 * cache across releases: a new build deletes only the files its manifest no longer lists, so a
 * one-file patch downloads one file. Only a complete body reaches the disk, and a `now` request
 * starts ahead of every fill.
 */
export function createAssetCache(options: IAssetCacheOptions = {}): IAssetCache {
  const storage = cacheStorage();
  const reason =
    options.enabled === false
      ? "assets.cache is false"
      : storage === undefined
        ? isNative()
          ? "native host reads installed files"
          : "cache API unavailable"
        : undefined;
  const enabled = reason === undefined;
  const backgroundFill = options.backgroundFill !== false;
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const retryDelays = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;

  let cacheName: string | undefined;
  const gameCacheName =
    options.namespace === undefined || options.namespace === ""
      ? CACHE_NAME
      : `${CACHE_NAME}-${manifestFingerprint([{ url: options.namespace }]).slice(0, 8)}`;
  let entries: readonly IAssetCacheEntry[] = [];
  /** Every manifest output and its compiled size, for the fetch bridge's hit and write checks. */
  const known = new Map<string, number | undefined>();
  let resolveManifest: (() => void) | undefined;
  const manifestReady = new Promise<void>((resolve) => {
    resolveManifest = resolve;
  });

  let persisted = false;
  let persistAsked = false;
  let hits = 0;
  let misses = 0;
  let bytesOnDisk = 0;
  let measured = false;
  let bytesTotal = 0;
  let filling = false;
  let fillStarted = false;
  let cleared = false;
  let storageFull = false;
  let cacheGeneration = 0;
  let restoreFetch: (() => void) | undefined;
  /** The fetch before the disk-first bridge: the loader's own downloads must not re-enter it. */
  let nativeFetch: typeof fetch = globalThis.fetch.bind(globalThis);

  /** Every url this session read or wrote. Those are the entries a quota error must not evict. */
  const touched = new Set<string>();
  /** The whole lookup, cache read included, keyed by url so two callers share one download. */
  const requests = new Map<string, { priority: AssetPriority; promise: Promise<ArrayBuffer> }>();
  /** Disk writes a `now` or `soon` caller did not wait for, keyed by url. */
  const writes = new Map<string, Promise<void>>();
  const queues: Record<AssetPriority, IJob[]> = { now: [], soon: [], idle: [] };
  let active = 0;
  let activeNow = 0;

  const openCache = async (): Promise<CacheLike | undefined> => {
    if (!enabled || cacheName === undefined || storage === undefined) return undefined;
    return storage.open(cacheName);
  };

  /** Delete the files this release no longer lists and sum the ones it keeps. */
  const pruneAndMeasure = async (cache: CacheLike): Promise<void> => {
    let total = 0;
    for (const request of await cache.keys()) {
      if (!known.has(canonicalUrl(request.url))) {
        await cache.delete(request.url);
        continue;
      }
      const response = await cache.match(request.url);
      const size = Number(response?.headers.get(BYTES_HEADER) ?? "0");
      if (Number.isFinite(size) && size > 0) total += size;
    }
    bytesOnDisk = total;
    measured = true;
  };

  const askToPersist = async (): Promise<void> => {
    if (persistAsked) return;
    persistAsked = true;
    try {
      persisted = (await storageManager()?.persist?.()) === true;
    } catch {
      persisted = false;
    }
  };

  /** Read the stored entries' sizes and access stamps, unsorted. */
  const readCandidates = async (
    cache: CacheLike,
  ): Promise<{ access: number; size: number; url: string }[]> => {
    const candidates: { access: number; size: number; url: string }[] = [];
    for (const request of await cache.keys()) {
      const response = await cache.match(request.url);
      candidates.push({
        access: Number(response?.headers.get(ACCESS_HEADER) ?? "0"),
        size: Number(response?.headers.get(BYTES_HEADER) ?? "0"),
        url: request.url,
      });
    }
    return candidates;
  };

  const isQuotaError = (error: unknown): boolean =>
    error instanceof Error &&
    (error.name === "QuotaExceededError" || /quota/iu.test(error.message));

  /**
   * Write one complete body. The browser's own quota is the only limit consulted: a refused write
   * gives up the least recently accessed entry this session has not touched, one at a time, and
   * retries, so a write that fits costs no quota query and no index scan.
   */
  const store = async (
    cache: CacheLike,
    url: string,
    buffer: ArrayBuffer,
    generation: number,
  ): Promise<void> => {
    if (generation !== cacheGeneration) return;
    const put = (): Promise<void> =>
      cache.put(
        url,
        new Response(buffer, {
          headers: {
            [ACCESS_HEADER]: String(Date.now()),
            [BYTES_HEADER]: String(buffer.byteLength),
          },
        }),
      );
    try {
      await put();
      if (measured) bytesOnDisk += buffer.byteLength;
      return;
    } catch (error) {
      if (!isQuotaError(error)) return;
    }
    try {
      const candidates = await readCandidates(cache);
      candidates.sort((left, right) => left.access - right.access);
      for (const candidate of candidates) {
        if (touched.has(canonicalUrl(candidate.url))) continue;
        if (!(await cache.delete(candidate.url))) continue;
        bytesOnDisk = Math.max(0, bytesOnDisk - candidate.size);
        try {
          await put();
          if (measured) bytesOnDisk += buffer.byteLength;
          return;
        } catch (error) {
          if (!isQuotaError(error)) return;
        }
      }
    } catch {
      // A storage failure while evicting is the same outcome as nothing left to evict.
    }
    // The bytes are in hand and the game still gets them; only the disk write failed. Stop the
    // fill: every later file would be downloaded again on the next visit.
    storageFull = true;
  };

  const download = async (
    url: string,
    priority: AssetPriority,
    expectedBytes: number | undefined,
  ): Promise<ArrayBuffer> => {
    let last: unknown;
    for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
      try {
        const init =
          priority === "idle" ? ({ priority: "low" } as unknown as RequestInit) : undefined;
        const response = await (init === undefined ? nativeFetch(url) : nativeFetch(url, init));
        if (!response.ok) {
          const status = response.status;
          const error = new Error(`status ${String(status)}`);
          // A 404 or a 403 will answer the same on every attempt. Retrying it only adds the
          // backoff to a startup that could already be trying its next candidate url.
          const retryable = status === 408 || status === 425 || status === 429 || status >= 500;
          if (!retryable) throw Object.assign(error, { retryable: false });
          throw error;
        }
        const buffer = await response.arrayBuffer();
        if (expectedBytes !== undefined && buffer.byteLength !== expectedBytes) {
          throw new Error(
            `incomplete download (${String(buffer.byteLength)} of ${String(expectedBytes)} bytes)`,
          );
        }
        return buffer;
      } catch (error) {
        last = error;
        if ((error as { retryable?: boolean }).retryable === false) break;
        const wait = retryDelays[attempt];
        if (wait === undefined) break;
        await delay(wait);
      }
    }
    throw new Error(errorMessage(last));
  };

  const load = async (
    url: string,
    request: { readonly priority: AssetPriority },
    expectedBytes: number | undefined,
  ): Promise<ArrayBuffer> => {
    if (!enabled) {
      const response = await nativeFetch(url);
      if (!response.ok) throw new Error(`status ${String(response.status)}`);
      return response.arrayBuffer();
    }
    const generation = cacheGeneration;
    const key = canonicalUrl(url);
    // A write still on its way to disk finishes first, so the read after it is a hit. No await
    // otherwise: a `now` request must reach the queue in the tick it was made.
    const pendingWrite = writes.get(key);
    if (pendingWrite !== undefined) await pendingWrite;
    let cache = expectedBytes === undefined ? undefined : await openCache().catch(() => undefined);
    if (cache !== undefined) {
      try {
        const hit = await cache.match(url);
        if (hit !== undefined) {
          const access = Number(hit.headers.get(ACCESS_HEADER) ?? "0");
          const cached = await hit.arrayBuffer();
          // A truncated entry is not a hit: drop it and download the file again, so one bad write
          // cannot leave a game permanently broken on that file.
          if (expectedBytes === undefined || cached.byteLength === expectedBytes) {
            hits += 1;
            touched.add(canonicalUrl(url));
            // One write per hour at most keeps the eviction order honest without paying for a
            // metadata write on every asset the game reads.
            if (Date.now() - access > ACCESS_REFRESH_MS) {
              void cache
                .put(
                  url,
                  new Response(cached, {
                    headers: {
                      [ACCESS_HEADER]: String(Date.now()),
                      [BYTES_HEADER]: String(cached.byteLength),
                    },
                  }),
                )
                .catch(() => undefined);
            }
            return cached;
          }
          console.warn(
            `TN_ASSETS_CACHE_TRUNCATED '${url}': stored ${String(cached.byteLength)} of ${String(expectedBytes)} bytes; fetching again.`,
          );
          bytesOnDisk = Math.max(0, bytesOnDisk - cached.byteLength);
          await cache.delete(url);
        }
      } catch {
        // A storage read that fails is a cache miss, never a failed asset: the network can serve
        // the bytes the player is waiting for.
        cache = undefined;
      }
    }
    misses += 1;
    // Read at enqueue time, not at call time: a `now` caller may have promoted this request while
    // it was still reading the disk.
    const buffer = await enqueue(url, request.priority, expectedBytes);
    if (cache !== undefined) {
      touched.add(key);
      // Never awaited: Firefox resolves `persist()` only after the player answers its prompt.
      void askToPersist();
      const write = store(cache, url, buffer, generation);
      // The fill waits for its own write, so it never holds more downloaded bytes than the disk
      // took. A file the frame waits on goes to the caller first.
      if (request.priority === "idle") {
        await write;
      } else {
        writes.set(key, write);
        void write.then(() => {
          if (writes.get(key) === write) writes.delete(key);
        });
      }
    }
    return buffer;
  };

  const take = (): IJob | undefined => {
    if (queues.now.length > 0) return queues.now.shift();
    // A `now` starts at once and holds every new `soon` and `idle` start until it settles.
    if (activeNow > 0) return undefined;
    if (queues.soon.length > 0) return queues.soon.shift();
    return queues.idle.shift();
  };

  const pump = (): void => {
    // A `now` file starts at once even when every lane is busy with the fill. Only `soon` and
    // `idle` respect the concurrency cap, so a large idle download can never sit in front of the
    // file the frame is waiting on.
    while (queues.now.length > 0 || active < concurrency) {
      const job = take();
      if (job === undefined) return;
      active += 1;
      if (job.priority === "now") activeNow += 1;
      void download(job.url, job.priority, job.expectedBytes)
        .then(
          (buffer) => {
            job.resolve(buffer);
          },
          (error: unknown) => {
            job.reject(error);
          },
        )
        .then(() => {
          active -= 1;
          if (job.priority === "now") activeNow -= 1;
          pump();
        });
    }
  };

  const enqueue = (
    url: string,
    priority: AssetPriority,
    expectedBytes: number | undefined,
  ): Promise<ArrayBuffer> =>
    new Promise((resolve, reject) => {
      queues[priority].push({ expectedBytes, priority, reject, resolve, url });
      pump();
    });

  const fetchBytes = (
    url: string,
    priority: AssetPriority = "now",
    expectedBytes?: number,
  ): Promise<ArrayBuffer> => {
    const key = canonicalUrl(url);
    const existing = requests.get(key);
    if (existing !== undefined) {
      if (PRIORITY_ORDER[priority] < PRIORITY_ORDER[existing.priority]) {
        existing.priority = priority;
        // A queued request is already in a queue; move it so the new priority is honoured.
        for (const queue of Object.values(queues)) {
          const job = queue.find((candidate) => canonicalUrl(candidate.url) === key);
          if (job === undefined) continue;
          queue.splice(queue.indexOf(job), 1);
          job.priority = priority;
          queues[priority].push(job);
          break;
        }
      }
      // A promoted job must start now if a lane is free; otherwise it waits for the next settle.
      pump();
      return existing.promise;
    }
    const request = { priority } as { priority: AssetPriority; promise: Promise<ArrayBuffer> };
    request.promise = load(url, request, expectedBytes);
    requests.set(key, request);
    const promise = request.promise;
    void promise.then(
      () => requests.delete(key),
      () => requests.delete(key),
    );
    return promise;
  };

  const prefetch = async (
    targets: readonly IAssetCacheEntry[],
    priority: AssetPriority,
  ): Promise<void> => {
    if (!enabled) return;
    await Promise.allSettled(targets.map((entry) => fetchBytes(entry.url, priority, entry.bytes)));
  };

  /**
   * Serve a cache hit for any GET the page makes, so a loader core does not wrap — three's
   * `KTX2Loader`, `RGBELoader`, `AudioLoader` — also reads the bytes the fill already stored.
   * Only a manifest output with a recorded size is ever on disk, so every other request goes
   * straight to the original fetch without a storage lookup. Web-only, like the cache itself.
   */
  const installFetchBridge = (name: string): void => {
    if (typeof globalThis.fetch !== "function" || storage === undefined) return;
    const original = globalThis.fetch;
    nativeFetch = original.bind(globalThis);
    const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const key = canonicalUrl(url);
      const expected = known.get(key);
      if (method.toUpperCase() !== "GET" || expected === undefined) return original(input, init);
      // A core download for the same url is already in flight: wait for it instead of fetching
      // the same bytes a second time.
      const pending = requests.get(key);
      if (pending !== undefined) {
        const buffer = await pending.promise;
        return new Response(buffer, {
          headers: { [BYTES_HEADER]: String(buffer.byteLength) },
        });
      }
      try {
        const cache = await storage.open(name);
        const hit = await cache.match(url);
        if (hit !== undefined) {
          const access = Number(hit.headers.get(ACCESS_HEADER) ?? "0");
          const cached = await hit.arrayBuffer();
          if (cached.byteLength === expected) {
            touched.add(key);
            if (Date.now() - access > ACCESS_REFRESH_MS) {
              void cache
                .put(
                  url,
                  new Response(cached, {
                    headers: {
                      [ACCESS_HEADER]: String(Date.now()),
                      [BYTES_HEADER]: String(cached.byteLength),
                    },
                  }),
                )
                .catch(() => undefined);
            }
            return new Response(cached, {
              headers: {
                [ACCESS_HEADER]: String(Date.now()),
                [BYTES_HEADER]: String(cached.byteLength),
              },
            });
          }
          console.warn(
            `TN_ASSETS_CACHE_TRUNCATED '${url}': stored ${String(cached.byteLength)} of ${String(expected)} bytes; fetching again.`,
          );
          await cache.delete(url).catch(() => undefined);
        }
      } catch {
        // A storage failure falls through to the network; the game still loads.
      }
      const response = await original(input, init);
      // The bridge normally only reads. When a loader core does not wrap fetches a manifest
      // output the fill has not reached yet, keep it: otherwise the first visit downloads that
      // file twice, once here and once in the fill.
      if (response.ok && !requests.has(key)) {
        try {
          const cache = await storage.open(name);
          const copy = response.clone();
          void copy
            .arrayBuffer()
            .then((buffer) => {
              if (buffer.byteLength === expected) return store(cache, url, buffer, cacheGeneration);
              return undefined;
            })
            .catch(() => undefined);
        } catch {
          // The clone is an optimisation; the caller's response is already on its way.
        }
      }
      return response;
    };
    globalThis.fetch = wrapped as typeof fetch;
    restoreFetch = () => {
      if (globalThis.fetch === wrapped) globalThis.fetch = original;
    };
  };

  const runFill = async (): Promise<void> => {
    await manifestReady;
    if (!enabled || !backgroundFill || entries.length === 0) return;
    filling = true;
    try {
      const chunk = Math.max(1, concurrency);
      for (let index = 0; index < entries.length; index += chunk) {
        // Checked between chunks, not once: a player who turns on data saving or frees the cache
        // mid-fill stops it at the next file boundary instead of paying for the rest of the
        // release.
        if (cleared || storageFull || saveDataEnabled()) break;
        await prefetch(entries.slice(index, index + chunk), "idle");
      }
    } finally {
      filling = false;
    }
  };

  return {
    get enabled() {
      return enabled;
    },
    get report(): IAssetCacheReport {
      return {
        enabled,
        persisted,
        hits,
        misses,
        bytesOnDisk,
        bytesTotal,
        filling,
        backgroundFill: enabled && backgroundFill && !saveDataEnabled(),
        ...(reason === undefined ? {} : { reason }),
      };
    },
    fetchBytes,
    prefetch: async (targets) => prefetch(targets, "soon"),
    setManifest: (manifestEntries) => {
      if (cacheName !== undefined) return;
      // Nothing content-addressed to store: a project with no manifest keeps the web path it had.
      if (manifestEntries.length === 0) {
        resolveManifest?.();
        return;
      }
      entries = manifestEntries;
      known.clear();
      for (const entry of manifestEntries) known.set(canonicalUrl(entry.url), entry.bytes);
      bytesTotal = manifestEntries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0);
      void storageManager()
        ?.persisted?.()
        .then((granted) => {
          persisted = granted === true;
        })
        .catch(() => undefined);
      if (!enabled) {
        resolveManifest?.();
        return;
      }
      cacheName = gameCacheName;
      installFetchBridge(gameCacheName);
      // Without the prune every build adds its changed files to the player's disk and nothing
      // ever removes the old ones.
      void (async () => {
        try {
          const cache = await openCache();
          if (cache !== undefined) await pruneAndMeasure(cache);
        } catch {
          // A storage failure must not stop a game from starting.
        }
        resolveManifest?.();
      })();
    },
    startFill: () => {
      if (fillStarted || cleared) return Promise.resolve();
      fillStarted = true;
      return runFill().catch(() => undefined);
    },
    clear: async () => {
      cleared = true;
      fillStarted = true;
      cacheGeneration += 1;
      storageFull = false;
      if (cacheName === undefined || storage === undefined) {
        bytesOnDisk = 0;
        return;
      }
      await storage.delete(cacheName);
      bytesOnDisk = 0;
      touched.clear();
    },
    dispose: () => {
      restoreFetch?.();
      restoreFetch = undefined;
    },
  };
}
