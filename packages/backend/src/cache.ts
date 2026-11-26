/**
 * The client's local layer: one `localStorage` namespace, written first and read as the fallback.
 *
 * Every call is total — a denied, full or absent storage answers `undefined` and nothing throws —
 * because a game must not stop for a cache it does not need.
 */
import { isRecord } from "./protocol.js";

/** Where the cache lives in `localStorage`, so one page's other keys never collide with ours. */
const NAMESPACE = "tn-backend:";

/** Everything in this module needs only the storage it writes to, never the network. */
export interface IStorageContext {
  readonly storage: Storage | null;
}

export interface ICachedValue {
  readonly value: unknown;
  readonly version: number;
  /** A local write the host never confirmed. It is newer than anything the host holds. */
  readonly dirty: boolean;
}

export interface ICachedDoc {
  readonly data: unknown;
  readonly scope: "private" | "public";
  readonly version: number;
  readonly isOwner: boolean;
  readonly dirty: boolean;
}

/** The caller's `storage` option, else the page's, or `null` when there is none to trust. */
export function readStorage(option: Storage | null | undefined): Storage | null {
  if (option === null) return null;
  if (option !== undefined) return option;
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

export function item<T>(context: IStorageContext, key: string): T | undefined {
  if (context.storage === null) return undefined;
  try {
    const raw = context.storage.getItem(NAMESPACE + key);
    if (raw === null) return undefined;
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? (parsed as T) : undefined;
  } catch {
    return undefined;
  }
}

export function putItem(context: IStorageContext, key: string, value: unknown): void {
  if (context.storage === null) return;
  try {
    context.storage.setItem(NAMESPACE + key, JSON.stringify(value));
  } catch {
    // A full or denied storage is not a game-stopping event; the host holds the durable copy.
  }
}

export function dropItem(context: IStorageContext, key: string): void {
  if (context.storage === null) return;
  try {
    context.storage.removeItem(NAMESPACE + key);
  } catch {
    // Nothing to do: a key that will not delete is read back only when it is otherwise missing.
  }
}

/** Cache keys under one prefix, so a list prefers the caller's own documents to anyone's. */
export function cachedKeys(context: IStorageContext, prefix: string): readonly string[] {
  const keys: string[] = [];
  if (context.storage === null) return keys;
  try {
    for (let index = 0; index < context.storage.length; index += 1) {
      const key = context.storage.key(index);
      if (key?.startsWith(NAMESPACE + prefix) === true) {
        keys.push(key.slice(NAMESPACE.length + prefix.length));
      }
    }
  } catch {
    return keys;
  }
  return keys;
}
