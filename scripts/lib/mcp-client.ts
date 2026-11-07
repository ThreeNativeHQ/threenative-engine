// One client for a stdio MCP server, because four scripts each handshook their own: one matched
// replies by scanning a buffer for `"id":2`, one kept a pending map, two used a readline listener,
// and their timeouts ranged from 20 s to none. A server that dies, answers with an error or never
// answers now produces one failure shape, carrying the server's own stderr.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** How to reach a stdio MCP server. */
export interface IMcpServerOptions {
  /** The command that runs it, e.g. `node`. */
  readonly command: string;
  /** Its arguments, e.g. the entry script. */
  readonly args: readonly string[];
  /** Working directory: the project whose `node_modules` the server resolves from. */
  readonly cwd?: string;
  /** Per-request deadline, in milliseconds. */
  readonly timeoutMs?: number;
  /** What the failure calls this server, e.g. `"terrain server"`. */
  readonly label?: string;
}

/** A live stdio MCP server, from the first request to `close()`. */
export interface IMcpClient {
  /** Sends one request and resolves with its `result`. */
  request(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Everything the server wrote to stderr so far, for a failure that needs it. */
  stderr(): string;
  /** Whether the server is still running. */
  alive(): boolean;
  /** Kills the server. Safe to call twice. */
  close(): void;
}

const DEFAULT_TIMEOUT_MS = 20_000;

interface IPending {
  readonly method: string;
  readonly reject: (error: Error) => void;
  readonly resolve: (result: Record<string, unknown>) => void;
  readonly timer: NodeJS.Timeout;
}

/** A server that exited, timed out, or answered with a JSON-RPC error. */
export class McpError extends Error {
  constructor(
    readonly code: "TN_MCP_EXITED" | "TN_MCP_TIMEOUT" | "TN_MCP_REPLY",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "McpError";
  }
}

/**
 * Starts a stdio MCP server and returns the client that talks to it.
 *
 * The client does not handshake for you — `initialize` then `notifications/initialized` are the
 * caller's, because a server's `serverInfo` is part of what some callers record.
 *
 * @situation talk to an MCP server over stdio from a script
 * @constraint every failure carries the server's own stderr, and no request outlives its deadline
 */
export function startMcpServer(options: IMcpServerOptions): IMcpClient {
  const label = options.label ?? "MCP server";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let stderr = "";
  let nextId = 1;
  let closed = false;
  const pending = new Map<number, IPending>();

  const child: ChildProcessWithoutNullStreams = spawn(options.command, [...options.args], {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += String(chunk);
  });

  const fail = (error: Error): void => {
    for (const [id, entry] of pending) {
      clearTimeout(entry.timer);
      pending.delete(id);
      entry.reject(error);
    }
  };

  child.once("error", (error) => {
    fail(new McpError("TN_MCP_EXITED", `${label} could not start: ${error.message}`));
  });
  child.once("exit", (code, signal) => {
    if (closed || pending.size === 0) return;
    const detail = stderr.trim().slice(-500);
    fail(
      new McpError(
        "TN_MCP_EXITED",
        `${label} exited (${code === null ? `signal ${String(signal)}` : `code ${String(code)}`}) before replying${detail === "" ? "" : `: ${detail}`}`,
      ),
    );
  });

  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let parsed: { error?: { message?: string }; id?: unknown; result?: Record<string, unknown> };
    try {
      parsed = JSON.parse(line) as typeof parsed;
    } catch {
      // A server may print a banner; only JSON-RPC replies are for this client.
      return;
    }
    if (typeof parsed.id !== "number") return;
    const entry = pending.get(parsed.id);
    if (entry === undefined) return;
    clearTimeout(entry.timer);
    pending.delete(parsed.id);
    if (parsed.error !== undefined) {
      entry.reject(
        new McpError(
          "TN_MCP_REPLY",
          `${label} ${entry.method}: ${parsed.error.message ?? "error"}`,
        ),
      );
      return;
    }
    entry.resolve(parsed.result ?? {});
  });

  return {
    alive: () => !closed && child.exitCode === null && child.signalCode === null,
    close: () => {
      if (closed) return;
      closed = true;
      lines.close();
      child.kill();
    },
    request: (method, params = {}) => {
      const id = nextId++;
      return new Promise<Record<string, unknown>>((resolve, reject) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          reject(
            new McpError(
              "TN_MCP_EXITED",
              `${label} is not running, so ${method} cannot be asked: ${stderr.trim().slice(-500)}`,
            ),
          );
          return;
        }
        const timer = setTimeout(() => {
          pending.delete(id);
          const detail = stderr.trim().slice(-500);
          reject(
            new McpError(
              "TN_MCP_TIMEOUT",
              `${label} ${method} timed out after ${String(timeoutMs)}ms${detail === "" ? "" : `: ${detail}`}`,
            ),
          );
        }, timeoutMs);
        pending.set(id, { method, reject, resolve, timer });
        try {
          child.stdin.write(`${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`);
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          reject(new McpError("TN_MCP_EXITED", `${label} ${method}: ${String(error)}`));
        }
      });
    },
    stderr: () => stderr,
  };
}

/** The `initialize` params this repository's clients send; the protocol date is part of the contract. */
export function initializeParams(name: string, version = "0"): Record<string, unknown> {
  return {
    capabilities: {},
    clientInfo: { name, version },
    protocolVersion: "2025-06-18",
  };
}
