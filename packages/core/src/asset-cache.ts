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
}

export interface IAssetCache {
  readonly enabled: boolean;
  readonly report: IAssetCacheReport;
  /** Bytes for `url`, from disk when present and from the network otherwise. */
  fetchBytes(url: string, priority?: AssetPriority, expectedBytes?: number): Promise<ArrayBuffer>;
  /** Warm the disk with these files. Resolves when every request settles. */
  prefetch(entries: readonly IAssetCacheEntry[]): Promise<void>;
  /** Name the release and the files it publishes. Called once, when the manifest lands. */
  setManifest(fingerprint: string, entries: readonly IAssetCacheEntry[]): void;
  /** Start the post-reveal fill of everything not on disk yet. Idempotent. */
  startFill(): void;
  /** Delete the whole cache. */
  clear(): Promise<void>;
  /** Remove the disk-first fetch bridge. Idempotent. */
  dispose(): void;
}

const CACHE_PREFIX = "threenative-assets-";
const DEFAULT_CONCURRENCY = 6;
const DEFAULT_RETRY_DELAYS_MS = [500, 1000, 2000] as const;
const BYTES_HEADER = "x-tn-bytes";

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
      estimate?: () => Promise<{ quota?: number; usage?: number }>;
      persist?: () => Promise<boolean>;
    }
  | undefined {
  return (
    globalThis as {
      navigator?: {
        storage?: {
          estimate?: () => Promise<{ quota?: number; usage?: number }>;
          persist?: () => Promise<boolean>;
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
 * Content-addressed outputs never go stale, so an entry needs no revalidation and the cache name
 * carries the release fingerprint: a new build is a new cache, and the old one is deleted at
 * startup. Only a complete body reaches the disk, and a `now` request starts ahead of every fill.
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
  let entries: readonly IAssetCacheEntry[] = [];
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
  let restoreFetch: (() => void) | undefined;

  /** Every url this session read or wrote. Those are the entries a quota error must not evict. */
  const touched = new Set<string>();
  /** The whole lookup, cache read included, keyed by url so two callers share one download. */
  const requests = new Map<string, { priority: AssetPriority; promise: Promise<ArrayBuffer> }>();
  const queues: Record<AssetPriority, IJob[]> = { now: [], soon: [], idle: [] };
  let active = 0;
  let activeNow = 0;

  const openCache = async (): Promise<CacheLike | undefined> => {
    if (!enabled || cacheName === undefined || storage === undefined) return undefined;
    return storage.open(cacheName);
  };

  const measureOnDisk = async (cache: CacheLike): Promise<void> => {
    let total = 0;
    for (const request of await cache.keys()) {
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

  const evictFor = async (cache: CacheLike, needed: number): Promise<boolean> => {
    const quota = await storageManager()
      ?.estimate?.()
      .then((estimate) => estimate.quota)
      .catch(() => undefined);
    if (typeof quota !== "number" || quota <= 0) return false;
    if (bytesOnDisk + needed <= quota) return true;
    for (const request of await cache.keys()) {
      if (bytesOnDisk + needed <= quota) return true;
      if (touched.has(request.url)) continue;
      const response = await cache.match(request.url);
      const size = Number(response?.headers.get(BYTES_HEADER) ?? "0");
      if (await cache.delete(request.url)) bytesOnDisk = Math.max(0, bytesOnDisk - size);
    }
    return bytesOnDisk + needed <= quota;
  };

  const store = async (cache: CacheLike, url: string, buffer: ArrayBuffer): Promise<void> => {
    const response = new Response(buffer, {
      headers: { [BYTES_HEADER]: String(buffer.byteLength) },
    });
    try {
      await evictFor(cache, buffer.byteLength);
      await cache.put(url, response);
      if (measured) bytesOnDisk += buffer.byteLength;
    } catch (error) {
      const quotaError =
        error instanceof Error &&
        (error.name === "QuotaExceededError" || /quota/iu.test(error.message));
      if (!quotaError) return;
      // One eviction pass and one retry: an entry that still cannot fit is fetched again next
      // visit rather than growing the cache past what the browser will hold.
      await evictFor(cache, buffer.byteLength);
      try {
        await cache.put(
          url,
          new Response(buffer, { headers: { [BYTES_HEADER]: String(buffer.byteLength) } }),
        );
        if (measured) bytesOnDisk += buffer.byteLength;
      } catch {
        // The bytes are in hand and the game still gets them; only the disk write failed.
      }
    }
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
        const response = await (init === undefined ? fetch(url) : fetch(url, init));
        if (!response.ok) throw new Error(`status ${String(response.status)}`);
        const buffer = await response.arrayBuffer();
        if (expectedBytes !== undefined && buffer.byteLength !== expectedBytes) {
          throw new Error(
            `incomplete download (${String(buffer.byteLength)} of ${String(expectedBytes)} bytes)`,
          );
        }
        return buffer;
      } catch (error) {
        last = error;
        const wait = retryDelays[attempt];
        if (wait === undefined) break;
        await delay(wait);
      }
    }
    throw new Error(errorMessage(last));
  };

  const load = async (
    url: string,
    priority: AssetPriority,
    expectedBytes: number | undefined,
  ): Promise<ArrayBuffer> => {
    if (!enabled) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`status ${String(response.status)}`);
      return response.arrayBuffer();
    }
    const cache = expectedBytes === undefined ? undefined : await openCache();
    if (cache !== undefined) {
      const hit = await cache.match(url);
      if (hit !== undefined) {
        const cached = await hit.arrayBuffer();
        // A truncated entry is not a hit: drop it and download the file again, so one bad write
        // cannot leave a game permanently broken on that file.
        if (expectedBytes === undefined || cached.byteLength === expectedBytes) {
          hits += 1;
          touched.add(url);
          return cached;
        }
        bytesOnDisk = Math.max(0, bytesOnDisk - cached.byteLength);
        await cache.delete(url);
      }
    }
    misses += 1;
    const buffer = await enqueue(url, priority, expectedBytes);
    if (cache !== undefined) {
      touched.add(url);
      await askToPersist();
      await store(cache, url, buffer);
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
    const existing = requests.get(url);
    if (existing !== undefined) {
      if (PRIORITY_ORDER[priority] < PRIORITY_ORDER[existing.priority]) {
        existing.priority = priority;
        // A queued request is already in a queue; move it so the new priority is honoured.
        for (const queue of Object.values(queues)) {
          const job = queue.find((candidate) => candidate.url === url);
          if (job === undefined) continue;
          queue.splice(queue.indexOf(job), 1);
          job.priority = priority;
          queues[priority].push(job);
          break;
        }
      }
      return existing.promise;
    }
    const promise = load(url, priority, expectedBytes);
    requests.set(url, { priority, promise });
    void promise.then(
      () => requests.delete(url),
      () => requests.delete(url),
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
   * A miss delegates to the original fetch untouched; the bridge never writes and never changes a
   * response, so an uncached request behaves exactly as before. Web-only, like the cache itself.
   */
  const installFetchBridge = (name: string): void => {
    if (typeof globalThis.fetch !== "function" || storage === undefined) return;
    const original = globalThis.fetch;
    const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (method.toUpperCase() === "GET") {
        try {
          const url =
            typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
          const cache = await storage.open(name);
          const hit = await cache.match(url);
          if (hit !== undefined) {
            touched.add(url);
            hits += 1;
            return hit;
          }
        } catch {
          // A storage failure falls through to the network; the game still loads.
        }
      }
      return original(input, init);
    };
    globalThis.fetch = wrapped as typeof fetch;
    restoreFetch = () => {
      if (globalThis.fetch === wrapped) globalThis.fetch = original;
    };
  };

  const runFill = async (): Promise<void> => {
    await manifestReady;
    if (!enabled || !backgroundFill || saveDataEnabled() || entries.length === 0) return;
    filling = true;
    try {
      await prefetch(entries, "idle");
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
        ...(reason === undefined ? {} : { reason }),
      };
    },
    fetchBytes,
    prefetch: async (targets) => prefetch(targets, "soon"),
    setManifest: (fingerprint, manifestEntries) => {
      if (cacheName !== undefined) return;
      // Nothing content-addressed to store: a project with no manifest keeps the web path it had.
      if (manifestEntries.length === 0) {
        resolveManifest?.();
        return;
      }
      entries = manifestEntries;
      bytesTotal = manifestEntries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0);
      if (!enabled) {
        resolveManifest?.();
        return;
      }
      const name = `${CACHE_PREFIX}${fingerprint}`;
      cacheName = name;
      installFetchBridge(name);
      // A release cleans up after the last one: without this every build adds its full size to
      // the player's disk and nothing ever removes the old bytes.
      const current = name;
      void (async () => {
        try {
          for (const other of (await storage?.keys()) ?? []) {
            if (other.startsWith(CACHE_PREFIX) && other !== current) await storage?.delete(other);
          }
          const cache = await openCache();
          if (cache !== undefined) await measureOnDisk(cache);
        } catch {
          // A storage failure must not stop a game from starting.
        }
        resolveManifest?.();
      })();
    },
    startFill: () => {
      if (fillStarted) return;
      fillStarted = true;
      void runFill().catch(() => undefined);
    },
    clear: async () => {
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
