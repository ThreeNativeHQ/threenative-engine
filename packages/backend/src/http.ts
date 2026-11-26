/**
 * The handler's HTTP surface: one response shape, the marker header every answer carries, and the
 * body/name parsing that decides between `400` and a route.
 */
import {
  type BackendErrorCode,
  type IBackendErrorResponse,
  MARKER_HEADER,
  MARKER_VALUE,
  isRecord,
} from "./protocol.js";

export function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      [MARKER_HEADER]: MARKER_VALUE,
    },
  });
}

export function fail(error: BackendErrorCode, status: number): Response {
  return respond({ error } satisfies IBackendErrorResponse, status);
}

export function conflict(value: unknown, version: number): Response {
  return respond({ error: "version_conflict", value, version }, 409);
}

/** One decoded path segment, or `undefined` when it was not valid percent-encoding. */
export function segment(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

export async function readObject(request: Request): Promise<Record<string, unknown> | undefined> {
  const text = await request.text();
  if (text.trim().length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** `undefined` when absent; a non-negative integer, or `null` when present and unusable. */
export function ifVersionOf(body: Record<string, unknown>): number | null | undefined {
  const raw = body.ifVersion;
  if (raw === undefined) return undefined;
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : null;
}
