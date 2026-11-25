/**
 * The browser half of `@threenative/backend`: cloud saves that never stop a game.
 *
 * A write lands in `localStorage` first and reaches the host second, so the game's progress is
 * already durable when the network answers — or never does. A read asks the host when there is
 * one, refreshes the local copy from the answer, and falls back to the local copy otherwise.
 * With no host, no `fetch` and no storage every call still resolves: reads give `undefined`/`[]`.
 */
import {
  type ICachedDoc,
  type ICachedValue,
  cachedKeys,
  dropItem,
  item,
  putItem,
} from "./cache.js";
import {
  type DocScope,
  type ICollectionItem,
  type ICollectionListResponse,
  type IDbItem,
  type IDbListResponse,
  type IDbValueResponse,
  isValidName,
} from "./protocol.js";
import {
  BackendError,
  type IBackendContext,
  type IBackendOptions,
  conflictBody,
  createContext,
  failureOf,
  hosted,
  readJson,
  send,
} from "./wire.js";

export type { BackendErrorCode, DocScope, ICollectionItem, IDbItem } from "./protocol.js";
export { BackendError, type IBackendOptions } from "./wire.js";

export interface IBackendWriteOptions {
  /** `undefined` writes unconditionally, `0` creates, anything else must equal the stored version. */
  readonly ifVersion?: number;
}

/** What `createBackend` hands a game: one namespace of keys and any number of collections. */
export interface IBackend {
  readonly db: BackendDb;
}

function requireName(value: string): void {
  if (!isValidName(value)) throw new BackendError("invalid_key");
}

/**
 * One promise chain per cache key, so two writes to the same key can never share a base version.
 *
 * A save the game fires without awaiting (`set` every room) used to race itself: both writes read
 * the cached base, the second took a 409, the game swallowed it and the cache settled on the first
 * value, losing the newest save locally and on the host. A write therefore queues behind the one
 * before it and reads its own base version only when its turn starts. Reads never queue: they
 * answer from the cache and refresh it, and a read behind a write would wait on the network.
 */
const writeChains = new WeakMap<IBackendContext, Map<string, Promise<unknown>>>();

function serialized<T>(
  context: IBackendContext,
  cacheKey: string,
  write: () => Promise<T>,
): Promise<T> {
  const chains = writeChains.get(context) ?? new Map<string, Promise<unknown>>();
  writeChains.set(context, chains);
  const previous = chains.get(cacheKey) ?? Promise.resolve();
  // A failed write still runs the next one, and its rejection stays the caller's alone.
  const next = previous.then(write, write);
  chains.set(
    cacheKey,
    next.catch(() => undefined),
  );
  return next;
}

/**
 * The caller's own key/value store: private per player, per game.
 *
 * @situation save game progress in the cloud so clearing the browser cache does not lose it
 * @situation keep the player's last write when the network fails, because it lands locally first
 * @requires npm i @threenative/backend
 * @example const backend = createBackend();
 * @example await backend.db.set("save", { level: 4, gold: 20 });
 * @example const save = await backend.db.get("save");
 */
export class BackendDb {
  constructor(private readonly context: IBackendContext) {}

  /** The player's keys, capped at `LIST_MAX`. */
  async list(): Promise<readonly IDbItem[]> {
    const local: IDbItem[] = cachedKeys(this.context, "kv:").map((key) => {
      const cached = item<ICachedValue>(this.context, `kv:${key}`);
      return { key, value: cached?.value, version: cached?.version ?? 0 };
    });
    if (!(await hosted(this.context))) return local;

    const response = await this.context.fetch?.(`${this.context.endpoint}/v1/db`);
    const body = response?.ok === true ? await readJson(response) : undefined;
    const items = (body as IDbListResponse | undefined)?.items;
    if (items === undefined) return local;
    for (const entry of items) {
      if (item<ICachedValue>(this.context, `kv:${entry.key}`)?.dirty === true) continue;
      putItem(this.context, `kv:${entry.key}`, {
        value: entry.value,
        version: entry.version,
        dirty: false,
      });
    }
    return items;
  }

  /** The stored value, or `undefined` when there is none here and none on the host. */
  async get(key: string): Promise<unknown> {
    requireName(key);
    const cacheKey = `kv:${key}`;
    const cached = item<ICachedValue>(this.context, cacheKey);
    // A write the host never took is the newest copy there is, so it is the answer until the game
    // writes again. Re-queueing it is a sync engine's job: no host has promised one yet.
    if (cached?.dirty === true) return cached.value;
    if (!(await hosted(this.context))) return cached?.value;

    const response = await this.context.fetch?.(
      `${this.context.endpoint}/v1/db/${encodeURIComponent(key)}`,
    );
    if (response === undefined || !response.ok) return cached?.value;
    const body = (await readJson(response)) as IDbValueResponse | undefined;
    if (body === undefined) return cached?.value;
    putItem(this.context, cacheKey, { value: body.value, version: body.version, dirty: false });
    return body.value;
  }

  /**
   * Writes locally at once, then uploads. Resolves with the version the host holds for this key;
   * an upload that never landed leaves the last confirmed one, so the next write is not stale.
   * Rejects with `version_conflict` when the caller's copy was stale, keeping the host's copy.
   */
  async set(key: string, value: unknown, options: IBackendWriteOptions = {}): Promise<number> {
    requireName(key);
    const cacheKey = `kv:${key}`;
    // The local copy is written now, ahead of the queue: a save is durable before the network, and
    // the queued half re-writes it with the version the previous write confirmed.
    putItem(this.context, cacheKey, {
      value,
      version: options.ifVersion ?? item<ICachedValue>(this.context, cacheKey)?.version ?? 0,
      dirty: true,
    });
    return serialized(this.context, cacheKey, () => this.#upload(key, cacheKey, value, options));
  }

  /** The queued half of `set`: it runs only once every earlier write to this key has settled. */
  async #upload(
    key: string,
    cacheKey: string,
    value: unknown,
    options: IBackendWriteOptions,
  ): Promise<number> {
    const baseVersion =
      options.ifVersion ?? item<ICachedValue>(this.context, cacheKey)?.version ?? 0;
    // An unconfirmed write keeps the host's version, never the one it would take: sending
    // `ifVersion = base + 1` to a host still holding `base` is a guaranteed 409, and the 409 would
    // overwrite the player's offline progress with the host's older copy.
    putItem(this.context, cacheKey, { value, version: baseVersion, dirty: true });
    if (!(await hosted(this.context))) return baseVersion;

    const response = await send(this.context, "PUT", `/v1/db/${encodeURIComponent(key)}`, {
      value,
      ifVersion: baseVersion,
    });
    if (response === undefined) return baseVersion;
    const body = await readJson(response);
    if (response.ok) {
      const version = typeof body?.version === "number" ? body.version : baseVersion;
      putItem(this.context, cacheKey, { value, version, dirty: false });
      return version;
    }
    if (response.status === 409) {
      putItem(this.context, cacheKey, { ...conflictBody(body), dirty: false });
    }
    throw failureOf(response, body);
  }

  /** Deletes locally and on the host; a conflict carries the host's copy back into the cache. */
  async delete(key: string, options: IBackendWriteOptions = {}): Promise<void> {
    requireName(key);
    const cacheKey = `kv:${key}`;
    return serialized(this.context, cacheKey, () => this.#remove(key, cacheKey, options));
  }

  /** The queued half of `delete`, so a delete cannot overtake a write to the same key. */
  async #remove(key: string, cacheKey: string, options: IBackendWriteOptions): Promise<void> {
    const cached = item<ICachedValue>(this.context, cacheKey);
    const ifVersion = options.ifVersion ?? cached?.version ?? 0;
    dropItem(this.context, cacheKey);
    if (!(await hosted(this.context))) return;

    const response = await send(this.context, "DELETE", `/v1/db/${encodeURIComponent(key)}`, {
      ifVersion,
    });
    if (response === undefined) return;
    const body = await readJson(response);
    if (response.ok) return;
    if (response.status === 409) {
      putItem(this.context, cacheKey, { ...conflictBody(body), dirty: false });
    }
    throw failureOf(response, body);
  }

  /**
   * One per-game collection of documents: `private` ones only the owner sees, `public` ones
   * every player of the game reads and only the owner writes or deletes.
   */
  collection(name: string): BackendCollection {
    requireName(name);
    return new BackendCollection(this.context, name);
  }
}

/**
 * Documents shared inside one game: published levels, shared builds, public profiles.
 *
 * @situation publish a player-built level that other players of the same game can load
 * @situation list the documents other players have made public in this game
 * @requires npm i @threenative/backend
 * @example const levels = createBackend().db.collection("levels");
 * @example await levels.put("canyon", { blocks: 12, title: "Canyon run" }, "public");
 * @example const shared = await levels.get("canyon");
 */
export class BackendCollection {
  constructor(
    private readonly context: IBackendContext,
    private readonly name: string,
  ) {}

  /** The caller's documents of any scope plus other players' public ones, capped at `LIST_MAX`. */
  async list(): Promise<readonly ICollectionItem[]> {
    const prefix = `doc:${this.name}/`;
    const local: ICollectionItem[] = cachedKeys(this.context, prefix).map((id) => {
      const cached = item<ICachedDoc>(this.context, `${prefix}${id}`);
      return {
        id,
        data: cached?.data,
        scope: cached?.scope ?? "private",
        version: cached?.version ?? 0,
        isOwner: cached?.isOwner ?? true,
      };
    });
    if (!(await hosted(this.context))) return local;

    const response = await this.context.fetch?.(
      `${this.context.endpoint}/v1/collections/${encodeURIComponent(this.name)}`,
    );
    const body = response?.ok === true ? await readJson(response) : undefined;
    const items = (body as ICollectionListResponse | undefined)?.items;
    if (items === undefined) return local;
    for (const entry of items) {
      const cacheKey = `${prefix}${entry.id}`;
      if (item<ICachedDoc>(this.context, cacheKey)?.dirty === true) continue;
      putItem(this.context, cacheKey, { ...entry, dirty: false });
    }
    return items;
  }

  /** One document, with its scope and whether the caller may write it. */
  async get(id: string): Promise<ICollectionItem | undefined> {
    requireName(id);
    const cacheKey = `doc:${this.name}/${id}`;
    const cached = item<ICachedDoc>(this.context, cacheKey);
    // Same rule as `BackendDb.get`: an unconfirmed local write is the newest copy there is.
    if (cached?.dirty === true) {
      return { id, data: cached.data, scope: cached.scope, version: cached.version, isOwner: true };
    }
    if (!(await hosted(this.context))) {
      if (cached === undefined) return undefined;
      return {
        id,
        data: cached.data,
        scope: cached.scope,
        version: cached.version,
        isOwner: cached.isOwner,
      };
    }

    const response = await this.context.fetch?.(
      `${this.context.endpoint}/v1/collections/${encodeURIComponent(this.name)}/${encodeURIComponent(id)}`,
    );
    if (response === undefined || !response.ok) {
      if (cached === undefined) return undefined;
      return {
        id,
        data: cached.data,
        scope: cached.scope,
        version: cached.version,
        isOwner: cached.isOwner,
      };
    }
    const body = (await readJson(response)) as ICollectionItem | undefined;
    if (body === undefined) return undefined;
    putItem(this.context, cacheKey, { ...body, dirty: false });
    return body;
  }

  /**
   * Writes locally at once, then uploads. Resolves with the version the host holds, and an upload
   * that never landed keeps the last confirmed one, exactly like `BackendDb.set`. Another player's
   * document rejects with `forbidden`.
   */
  async put(
    id: string,
    data: unknown,
    scope: DocScope,
    options: IBackendWriteOptions = {},
  ): Promise<number> {
    requireName(id);
    const cacheKey = `doc:${this.name}/${id}`;
    // Same rule as `BackendDb.set`: the local copy lands before the queue, never after it.
    putItem(this.context, cacheKey, {
      data,
      scope,
      version: options.ifVersion ?? item<ICachedDoc>(this.context, cacheKey)?.version ?? 0,
      isOwner: true,
      dirty: true,
    });
    return serialized(this.context, cacheKey, () =>
      this.#uploadDoc(cacheKey, id, data, scope, options),
    );
  }

  /** The queued half of `put`: it runs only once every earlier write to this document settled. */
  async #uploadDoc(
    cacheKey: string,
    id: string,
    data: unknown,
    scope: DocScope,
    options: IBackendWriteOptions,
  ): Promise<number> {
    const cached = item<ICachedDoc>(this.context, cacheKey);
    const baseVersion = options.ifVersion ?? cached?.version ?? 0;
    // Same rule as `BackendDb.set`: the cached version stays the host's while the write is pending.
    putItem(this.context, cacheKey, {
      data,
      scope,
      version: baseVersion,
      isOwner: true,
      dirty: true,
    });
    if (!(await hosted(this.context))) return baseVersion;

    const response = await send(
      this.context,
      "PUT",
      `/v1/collections/${encodeURIComponent(this.name)}/${encodeURIComponent(id)}`,
      { data, scope, ifVersion: baseVersion },
    );
    if (response === undefined) return baseVersion;
    const body = await readJson(response);
    if (response.ok) {
      const version = typeof body?.version === "number" ? body.version : baseVersion;
      putItem(this.context, cacheKey, { data, scope, version, isOwner: true, dirty: false });
      return version;
    }
    if (response.status === 409) {
      putItem(this.context, cacheKey, {
        ...conflictBody(body),
        scope,
        isOwner: true,
        dirty: false,
      });
    }
    throw failureOf(response, body);
  }

  /** Deletes the caller's own document; another player's rejects with `forbidden`. */
  async delete(id: string): Promise<void> {
    requireName(id);
    const cacheKey = `doc:${this.name}/${id}`;
    return serialized(this.context, cacheKey, () => this.#removeDoc(cacheKey, id));
  }

  /** The queued half of `delete`, so a document delete cannot overtake a write to it. */
  async #removeDoc(cacheKey: string, id: string): Promise<void> {
    dropItem(this.context, cacheKey);
    if (!(await hosted(this.context))) return;

    const response = await send(
      this.context,
      "DELETE",
      `/v1/collections/${encodeURIComponent(this.name)}/${encodeURIComponent(id)}`,
      {},
    );
    if (response === undefined) return;
    const body = await readJson(response);
    if (response.ok) return;
    throw failureOf(response, body);
  }
}

/**
 * The cloud store a published game saves into. With no host, no `fetch` and no `localStorage`
 * every call still resolves, so a preview build runs the same game code.
 *
 * @situation save player progress in the cloud on a published game so it survives a cache clear
 * @situation share documents between the players of one game
 * @situation keep working in a preview build that has no backend
 * @requires npm i @threenative/backend
 * @example const backend = createBackend();
 * @example await backend.db.set("save", { level: 3 });
 * @example const shared = await backend.db.collection("levels").list();
 */
export function createBackend(options: IBackendOptions = {}): IBackend {
  return { db: new BackendDb(createContext(options)) };
}
