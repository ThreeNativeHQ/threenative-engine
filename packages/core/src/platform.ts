export type PlatformRuntime = "web" | "native";
export type PlatformOS = "android" | "ios" | "linux" | "macos" | "windows" | "unknown";
export type PlatformFormFactor = "mobile" | "desktop" | "unknown";

export interface IPlatformInfo {
  readonly runtime: PlatformRuntime;
  readonly os: PlatformOS;
  readonly formFactor: PlatformFormFactor;
  readonly maxTouchPoints: number;
}

interface IPlatformDetectionSource {
  readonly document?: unknown;
  readonly native?: unknown;
  readonly navigator?: unknown;
}

interface IUserAgentData {
  readonly mobile?: unknown;
  readonly platform?: unknown;
}

const DESKTOP_OS = new Set<PlatformOS>(["linux", "macos", "windows"]);
const MOBILE_OS = new Set<PlatformOS>(["android", "ios"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function freezePlatform(value: IPlatformInfo): Readonly<IPlatformInfo> {
  return Object.freeze(value);
}

function invalidNativePlatform(reason: string): never {
  throw new Error(`TN_NATIVE_PLATFORM_INVALID: ${reason}`);
}

function nativePlatform(source: unknown): Readonly<IPlatformInfo> {
  if (!isRecord(source)) invalidNativePlatform("the native marker is not an object");
  const descriptor = source.platform;
  if (!isRecord(descriptor)) invalidNativePlatform("platform descriptor is missing");

  const runtime = descriptor.runtime;
  const os = descriptor.os;
  const formFactor = descriptor.formFactor;
  const maxTouchPoints = descriptor.maxTouchPoints;
  if (runtime !== "native") invalidNativePlatform("runtime must be native");
  if (
    os !== "android" &&
    os !== "ios" &&
    os !== "linux" &&
    os !== "macos" &&
    os !== "windows" &&
    os !== "unknown"
  ) {
    invalidNativePlatform("os is unknown");
  }
  if (formFactor !== "mobile" && formFactor !== "desktop" && formFactor !== "unknown") {
    invalidNativePlatform("formFactor is unknown");
  }
  if (!Number.isInteger(maxTouchPoints) || (maxTouchPoints as number) < 0) {
    invalidNativePlatform("maxTouchPoints must be a non-negative integer");
  }

  const expectedFormFactor = MOBILE_OS.has(os as PlatformOS)
    ? "mobile"
    : DESKTOP_OS.has(os as PlatformOS)
      ? "desktop"
      : "unknown";
  if (formFactor !== expectedFormFactor) {
    invalidNativePlatform("os and formFactor disagree");
  }

  return freezePlatform({
    formFactor,
    maxTouchPoints,
    os,
    runtime,
  } as IPlatformInfo);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function parseOS(value: string | undefined): PlatformOS | undefined {
  if (value === undefined) return undefined;
  const normalized = value.toLowerCase();
  if (normalized.includes("android")) return "android";
  if (/(iphone|ipad|ipod|ios)/u.test(normalized)) return "ios";
  if (/(windows|win32|win64|winnt|wince)/u.test(normalized)) return "windows";
  if (/(macintosh|mac os|macos|macintel|macppc|mac68k)/u.test(normalized)) return "macos";
  if (/(linux|x11)/u.test(normalized)) return "linux";
  return undefined;
}

function compatibleBrowserOS(left: PlatformOS, right: PlatformOS, iosUserAgent: boolean): boolean {
  if (left === right) return true;
  if ((left === "android" && right === "linux") || (left === "linux" && right === "android"))
    return true;
  if (
    iosUserAgent &&
    ((left === "ios" && right === "macos") || (left === "macos" && right === "ios"))
  )
    return true;
  return false;
}

function resolveBrowserOS(
  userAgentDataOS: PlatformOS | undefined,
  navigatorOS: PlatformOS | undefined,
  userAgentOS: PlatformOS | undefined,
  iosUserAgent: boolean,
): PlatformOS {
  let resolved: PlatformOS | undefined;
  for (const candidate of [userAgentDataOS, navigatorOS, userAgentOS]) {
    if (candidate === undefined) continue;
    if (resolved === undefined) {
      resolved = candidate;
      continue;
    }
    if (!compatibleBrowserOS(resolved, candidate, iosUserAgent)) return "unknown";
    if (
      (resolved === "linux" && candidate === "android") ||
      (resolved === "macos" && candidate === "ios")
    ) {
      resolved = candidate;
    }
  }
  return resolved ?? "unknown";
}

function readTouchPoints(value: unknown): number {
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : 0;
}

function browserPlatform(source: unknown): Readonly<IPlatformInfo> {
  if (!isRecord(source)) {
    return freezePlatform({
      formFactor: "unknown",
      maxTouchPoints: 0,
      os: "unknown",
      runtime: "web",
    });
  }

  const userAgentData = isRecord(source.userAgentData)
    ? (source.userAgentData as IUserAgentData)
    : undefined;
  const userAgentDataOS = parseOS(text(userAgentData?.platform));
  const navigatorOS = parseOS(text(source.platform));
  const userAgent = text(source.userAgent);
  const userAgentOS = parseOS(userAgent);
  const iosUserAgent = userAgentOS === "ios";
  const os = resolveBrowserOS(userAgentDataOS, navigatorOS, userAgentOS, iosUserAgent);

  let formFactor: PlatformFormFactor = "unknown";
  if (typeof userAgentData?.mobile === "boolean") {
    formFactor = userAgentData.mobile ? "mobile" : "desktop";
  } else if (MOBILE_OS.has(os)) {
    formFactor = "mobile";
  } else if (DESKTOP_OS.has(os)) {
    formFactor = "desktop";
  }
  if (os === "unknown") formFactor = "unknown";

  return freezePlatform({
    formFactor,
    maxTouchPoints: readTouchPoints(source.maxTouchPoints),
    os,
    runtime: "web",
  });
}

function globalPlatformSource(): IPlatformDetectionSource {
  const globals = globalThis as Record<string, unknown>;
  return { native: globals.__THREENATIVE_NATIVE__, navigator: globals.navigator };
}

/** Internal source seam for unit tests; it is intentionally not a root package export. */
export function detectPlatform(
  source: IPlatformDetectionSource = globalPlatformSource(),
): Readonly<IPlatformInfo> {
  return source.native === undefined
    ? browserPlatform(source.navigator)
    : nativePlatform(source.native);
}

let platformSnapshot: Readonly<IPlatformInfo> | undefined;

export function getPlatform(): Readonly<IPlatformInfo> {
  platformSnapshot ??= detectPlatform();
  return platformSnapshot;
}

export function isWeb(): boolean {
  return getPlatform().runtime === "web";
}

export function isNative(): boolean {
  return getPlatform().runtime === "native";
}

export function isMobile(): boolean {
  return getPlatform().formFactor === "mobile";
}

export function isTouchscreenAvailable(): boolean {
  return getPlatform().maxTouchPoints > 0;
}

/** The page's `window`, or undefined in a worker or on a host without one. Core reads it only here (PRD-752). */
export function hostWindow(): (Window & typeof globalThis) | undefined {
  return typeof window === "undefined" ? undefined : window;
}

/** The page's `document`, or undefined in a worker or on a host without one. */
export function hostDocument(): Document | undefined {
  return typeof document === "undefined" ? undefined : document;
}

/** `ResizeObserver`, or undefined where the host has none. */
export function hostResizeObserver(): typeof ResizeObserver | undefined {
  return typeof ResizeObserver === "undefined" ? undefined : ResizeObserver;
}
