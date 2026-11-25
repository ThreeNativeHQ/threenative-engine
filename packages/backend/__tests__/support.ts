import { createRequire } from "node:module";

/** The narrowest `Storage` the client can use, so the local layer is testable off-browser. */
export class MemoryStorage implements Storage {
  private readonly entries = new Map<string, string>();

  get length(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.entries.delete(key);
  }

  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }
}

/**
 * A room is a socket, and a socket is the platform's: Node 22 has the global `WebSocket`, Node 20
 * (what CI runs) does not. `ws` stands in for it so the same specs prove rooms on both, and it
 * ships no types of its own, so it is loaded with `require` rather than a typed import.
 *
 * A spec that opens a room socket imports this module for the side effect: `import "./support.js"`.
 */
if ((globalThis as { WebSocket?: unknown }).WebSocket === undefined) {
  const { WebSocket } = createRequire(import.meta.url)("ws") as { WebSocket: unknown };
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: WebSocket });
}
