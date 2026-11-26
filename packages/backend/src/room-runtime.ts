/**
 * The slice of the Workers runtime `BackendRoom` runs on, described here rather than pulled from
 * `@cloudflare/workers-types` so this package keeps zero runtime and zero global-type
 * dependencies: a game's browser build never sees a Durable Object.
 *
 * Types only, and imported with `import type`, so nothing here reaches any bundle: `workerd`
 * provides the objects at runtime.
 */

/** A WebSocket the Workers runtime owns; the hibernation API hangs off `accept` and attachments. */
export interface IWorkerSocket {
  accept(): void;
  send(message: string): void;
  close(code?: number, reason?: string): void;
  /** Durable per-socket metadata, restored with the socket after a hibernation wake. */
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

/** The SQLite-backed storage a Durable Object keeps its room metadata and shared state in. */
export interface IWorkerDurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  list<T = unknown>(options?: {
    readonly prefix?: string;
  }): Promise<ReadonlyMap<string, T>>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

/** What the runtime hands a Durable Object as its first constructor argument (`ctx`). */
export interface IWorkerDurableObjectContext {
  acceptWebSocket(socket: IWorkerSocket): void;
  getWebSockets(): IWorkerSocket[];
  readonly storage: IWorkerDurableObjectStorage;
}
