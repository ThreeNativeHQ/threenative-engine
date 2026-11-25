/**
 * The client's wire layer: where the host is, whether it answered at all, and the one retry rule
 * every write shares. No class here holds a cache; that is `cache.ts`.
 */
import { type IStorageContext, readStorage } from "./cache.js";
import {
  BACKEND_ERROR_CODES,
  type BackendErrorCode,
  DEFAULT_PREFIX,
  MARKER_HEADER,
  MARKER_VALUE,
  isRecord,
} from "./protocol.js";

/** Three retries for a write the network did not take; a game waits 350 ms at worst. */
const RETRY_DELAYS_MS = [50, 100, 200];
const ERROR_CODES = new Set<string>(BACKEND_ERROR_CODES);
const STATUS_CODES: Readonly<Record<number, BackendErrorCode>> = {
  400: "invalid_key",
  403: "forbidden",
  404: "not_found",
  409: "version_conflict",
  413: "too_large",
  429: "rate_limited",
};

export interface IBackendOptions {
  /** Where the host mounted the handler: an absolute URL, or a path off `location.origin`. */
  readonly endpoint?: string;
  /** The `fetch` to use. Defaults to the page's; absent means this backend is local only. */
  readonly fetch?: typeof fetch;
  /** `null` turns the local cache off. Defaults to `localStorage` when the page has one. */
  readonly storage?: Storage | null;
}

/**
 * The one failure shape a game handles: the code, plus the server's copy on a conflict.
 *
 * @situation branch on a failed save without parsing an error message
 * @situation recover from a stale write by settling on `error.value` and saving again
 * @requires npm i @threenative/backend
 * @example const backend = createBackend();
 * @example backend.db.set("save", next).catch((error) => { if (error.code === "version_conflict") merge(error.value); });
 */
export class BackendError extends Error {
  readonly code: BackendErrorCode;
  readonly value: unknown;
  readonly version: number | undefined;

  constructor(code: BackendErrorCode, value?: unknown, version?: number) {
    super(`@threenative/backend: ${code}`);
    this.name = "BackendError";
    this.code = code;
    this.value = value;
    this.version = version;
  }
}

export interface IBackendContext extends IStorageContext {
  readonly endpoint: string;
  readonly fetch: typeof fetch | undefined;
  /** `undefined` until the first probe answers, then true or false for this client's life. */
  host: boolean | undefined;
  probe: Promise<boolean> | undefined;
}

function readFetch(options: IBackendOptions): typeof fetch | undefined {
  if (options.fetch !== undefined) return options.fetch;
  const candidate = (globalThis as { fetch?: typeof fetch }).fetch;
  // A page's `fetch` is a method of `window`: called as a bare reference it throws "Illegal
  // invocation", so the one the client keeps is bound to the global it came from.
  return typeof candidate === "function" ? candidate.bind(globalThis) : undefined;
}

function readEndpoint(options: IBackendOptions): string {
  const endpoint = (options.endpoint ?? DEFAULT_PREFIX).replace(/\/+$/u, "");
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
  return endpoint.startsWith("/") && origin !== undefined ? `${origin}${endpoint}` : endpoint;
}

export function createContext(options: IBackendOptions): IBackendContext {
  return {
    endpoint: readEndpoint(options),
    fetch: readFetch(options),
    storage: readStorage(options.storage),
    host: undefined,
    probe: undefined,
  };
}

export async function readJson(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed: unknown = await response.json();
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function codeOf(status: number, reported: unknown): BackendErrorCode {
  if (typeof reported === "string" && ERROR_CODES.has(reported)) {
    return reported as BackendErrorCode;
  }
  return STATUS_CODES[status] ?? "not_found";
}

/** The typed failure a non-`2xx` answer stands for, carrying the server's copy when there is one. */
export function failureOf(
  response: Response,
  body: Record<string, unknown> | undefined,
): BackendError {
  const version = typeof body?.version === "number" ? body.version : undefined;
  return new BackendError(codeOf(response.status, body?.error), body?.value, version);
}

/** A conflict's body is the server's copy: `{ error, value, version }`. */
export function conflictBody(body: Record<string, unknown> | undefined): {
  readonly value: unknown;
  readonly version: number;
} {
  return {
    value: body?.value,
    version: typeof body?.version === "number" ? body.version : 0,
  };
}

async function probeHost(context: IBackendContext): Promise<boolean> {
  if (context.fetch === undefined) return false;
  try {
    const response = await context.fetch(`${context.endpoint}/v1/db`);
    return response.headers.get(MARKER_HEADER) === MARKER_VALUE;
  } catch {
    return false;
  }
}

/** One shared probe for every call made before the answer arrives: one cookie, not N. */
export function hosted(context: IBackendContext): Promise<boolean> {
  if (context.host !== undefined) return Promise.resolve(context.host);
  context.probe ??= probeHost(context).then((answer) => {
    context.host = answer;
    return answer;
  });
  return context.probe;
}

/**
 * A write, with the three retries a dropped connection or a 5xx earns. `undefined` means the
 * network never answered: the caller keeps its local copy and the game carries on.
 */
export async function send(
  context: IBackendContext,
  method: string,
  path: string,
  body: unknown,
): Promise<Response | undefined> {
  if (context.fetch === undefined) return undefined;
  for (let attempt = 0; ; attempt += 1) {
    let answered: Response | undefined;
    try {
      answered = await context.fetch(`${context.endpoint}${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      });
    } catch {
      answered = undefined;
    }
    if (answered !== undefined && answered.status < 500) return answered;
    const delay = RETRY_DELAYS_MS[attempt];
    if (delay === undefined) return undefined;
    await new Promise<void>((resolve) => setTimeout(resolve, delay));
  }
}
