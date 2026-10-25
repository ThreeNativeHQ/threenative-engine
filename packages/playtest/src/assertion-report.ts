import type { IPlaytestToneCaptureObservation } from "./tone.js";
import type {
  IPlaytestComponentAssertion,
  IPlaytestDiagnosticsAssertion,
  IPlaytestPathAssertion,
  IPlaytestVisualRegionBounds,
  IPlaytestVisualRegionTarget,
} from "./scenario.js";
import type { IPlaytestDeviceLifecycleObservation } from "./runner/android.js";
import type { IPlaytestDeviceMetricsObservation } from "./runner/deviceMetrics.js";
import type { IPlaytestDiagnosticsPolicy } from "./report.js";
import type {
  IPlaytestRenderChainObservation,
  IPlaytestSceneNodesObservation,
  IPlaytestSceneObservation,
  IPlaytestStartupOffscreenBytes,
  IPlaytestStartupTimeline,
  JsonValue,
} from "./protocol.js";

export type Vec3 = [number, number, number];

export interface IPlaytestDiagnostic {
  artifactPath?: string;
  code: string;
  exportName?: string;
  gate?: "waived-headless";
  message: string;
  modulePath?: string;
  observedRuntimePath?: string;
  path?: string;
  resourceId?: string;
  severity: "error" | "warning";
  sourcePath?: string;
  suggestion?: string;
  systemId?: string;
}

export interface IPlaytestAssertionResult {
  details?: Record<string, unknown>;
  id: string;
  pass: boolean;
}

export interface IPlaytestVisualElementRegionObservation {
  assertionIndex: number;
  bounds?: IPlaytestVisualRegionBounds;
  darkPixelRatio?: number;
  element: IPlaytestVisualRegionTarget;
  nonblankPixelRatio?: number;
  rendered: boolean;
}

export interface IPlaytestObservations {
  tone?: IPlaytestToneCaptureObservation[];
  animation?: unknown;
  components?: Record<string, Record<string, { after?: unknown; before?: unknown }>>;
  componentSeries?: Array<{ label: string; snapshots: Record<string, Record<string, unknown>>; tick: number }>;
  console: Array<{ source?: "browser-console" | "page-error" | "unhandled-rejection"; text: string; type: string }>;
  contacts?: unknown;
  debugColliderCount?: number;
  /**
   * Host-measured device lifecycle: the phases a `lifecycle` step drove and what the device said
   * about the app at each one. Produced by the android target, never by the game.
   */
  deviceLifecycle?: IPlaytestDeviceLifecycleObservation;
  /** Host-measured device thermal, power and battery state; produced by the android target. */
  deviceMetrics?: IPlaytestDeviceMetricsObservation;
  effectLog?: unknown;
  effectLogBefore?: unknown;
  effectLogSeries?: Array<{ label: string; snapshot: unknown; tick: number }>;
  entityTransforms?: Record<string, { halfExtents?: Vec3; position?: Vec3; scale?: Vec3 }>;
  framebufferCoverage?: IPlaytestFramebufferCoverageObservation;
  /** The per-object geometry capture report, present only when the scenario requested one. */
  geometry?: JsonValue;
  hud: Record<string, { after?: unknown; before?: unknown }>;
  overlayNodes?: Record<string, { after?: unknown; before?: unknown }>;
  network: Array<{ method: string; url: string }>;
  physicsDebug?: unknown;
  physicsDebugBefore?: unknown;
  physicsDebugSeries?: Array<{ label: string; snapshot: unknown; tick: number }>;
  performanceSeries?: unknown[];
  /** Bounded shader/pipeline creation capture from the engine's renderer boundary. */
  pipelineCensus?: JsonValue;
  renderChain?: IPlaytestRenderChainObservation;
  resources: Record<string, { after?: unknown; before?: unknown }>;
  /** Lights, materials, fog, background, camera framing and world extent, as the bridge found them. */
  scene?: IPlaytestSceneObservation;
  sceneNodes?: IPlaytestSceneNodesObservation[];
  /** The startup observation the runner waited on, with the rule it resolved under. */
  startup?: {
    compileSettled?: boolean;
    offscreenBytes?: IPlaytestStartupOffscreenBytes;
    phase: string;
    progress: number;
    rule?: string;
    timeline?: IPlaytestStartupTimeline;
  };
  resourceSeries?: Array<{ label: string; snapshots: Record<string, unknown>; tick: number }>;
  runtimeObservations?: unknown;
  runtimeDiagnostics?: unknown;
  runtimeDiagnosticsBefore?: unknown;
  signals?: unknown[];
  signalSeries?: Array<{ label: string; signals: unknown[]; tick: number }>;
  visibility?: Record<string, unknown>;
  visual?: {
    captureFailure?: { code: "TN_CAPTURE_BLANK"; label: string; reason: string };
    changedPixelRatio?: number;
    comparisonSource?: string;
    elementRegions?: IPlaytestVisualElementRegionObservation[];
    nonblankRegions?: Array<{ darkPixelRatio?: number; height: number; nonblankPixelRatio: number; width: number; x: number; y: number }>;
    /** Visual frame observations only; performance samples live in performanceSeries. */
    runtimeDiagnosticsSeries?: unknown[];
  };
}

/**
 * Targets whose network observation is hardwired empty.
 *
 * Android and iOS do not yet consume a network observer. Desktop reads the native host
 * fetch observation through its playtest mailbox; browser uses request events.
 */
const NETWORK_BLIND_TARGETS = new Set(["android", "ios"]);

/** The reason the runner writes for itself when it waives a channel the target cannot observe. */
export const UNOBSERVABLE_NETWORK_REASON =
  "The run target has no network observer; its network observation is hardwired empty, so the default network policy is waived rather than evaluated against nothing.";

/**
 * The policy the evaluator actually applies, defaults included.
 *
 * `target` is the target the run *executed on*, not the scenario file's `target` field — the two
 * differ routinely, because `examples/native-smoke/playtests/*.json` say `"target": "web"` and are
 * driven with `--target android`.
 *
 * Why the target matters: the three channels default to on, and the evaluator applies that default
 * on every run. On a device lane the network observation is hardwired empty, so
 * `noNetworkErrors: true` was compared against an empty array and reported a passing row — a green
 * computed from evidence the target structurally cannot produce, which is the one thing this
 * harness exists not to do. The asymmetry was visible in the scenarios too: one that spelled out
 * `noNetworkErrors: true` failed honestly with `TN_PLAYTEST_UNSUPPORTED_ON_TARGET`, and the same
 * scenario with the field omitted passed.
 *
 * So on a network-blind target the default is **off, with the reason recorded in the policy the
 * report prints**. An explicit `true` is left exactly as written, because that is a scenario asking
 * for something the target cannot do, and the runner still fails it by name.
 */
export function resolveDiagnosticsPolicy(
  policy: IPlaytestDiagnosticsAssertion | undefined,
  target?: string,
): IPlaytestDiagnosticsPolicy {
  const networkBlind = target !== undefined && NETWORK_BLIND_TARGETS.has(target);
  const waivedByTarget = networkBlind && policy?.noNetworkErrors === undefined;
  return {
    ...(policy?.consoleErrorsOptOutReason === undefined ? {} : { consoleErrorsOptOutReason: policy.consoleErrorsOptOutReason }),
    ...(policy?.networkErrorsOptOutReason === undefined
      ? (waivedByTarget ? { networkErrorsOptOutReason: UNOBSERVABLE_NETWORK_REASON } : {})
      : { networkErrorsOptOutReason: policy.networkErrorsOptOutReason }),
    noConsoleErrors: policy?.noConsoleErrors ?? true,
    noNetworkErrors: policy?.noNetworkErrors ?? !networkBlind,
    noRuntimeDiagnostics: policy?.noRuntimeDiagnostics ?? true,
    ...(policy?.runtimeReady === undefined ? {} : { runtimeReady: policy.runtimeReady }),
    ...(policy?.runtimeDiagnosticsOptOutReason === undefined ? {} : { runtimeDiagnosticsOptOutReason: policy.runtimeDiagnosticsOptOutReason }),
  };
}

export interface IPlaytestFramebufferCoverageObservation {
  boundarySource: "scenario-steps" | "video-backdrop-dominance";
  firstViolation?: {
    frameIndex: number;
    grid: {
      columns: number;
      rows: number;
      samples: Array<[number, number, number]>;
    };
    screenshotPath: string;
  };
  frameCount: number;
  unreadableReason?: string;
  windowCompleted: boolean;
  windowStarted: boolean;
}
export function trivialAssertionDiagnostic(id: string, path: string | undefined, before: unknown, sourcePath: string | undefined): IPlaytestDiagnostic {
  return {
    code: "TN_PLAYTEST_ASSERTION_TRIVIAL",
    message: `Assertion '${id}'${path === undefined ? "" : ` at path '${path}'`} was already satisfied before the scenario ran (value ${JSON.stringify(before)}).`,
    path,
    severity: "error",
    ...(sourcePath === undefined ? {} : { sourcePath }),
    suggestion: "Drive the asserted value from a failing initial state, or assert changed:true. If the value is genuinely a held invariant, allowTrivial takes the reason it is held — it is recorded in the report and counted against the run.",
  };
}

export function componentAssertionDiagnostic(assertion: IPlaytestComponentAssertion, before: unknown, after: unknown): IPlaytestDiagnostic {
  return {
    code: "TN_PLAYTEST_COMPONENT_ASSERTION_FAILED",
    message: `Component '${assertion.component}' on entity '${assertion.entity}'${assertion.path === undefined ? "" : ` path '${assertion.path}'`} did not satisfy the assertion.`,
    observedRuntimePath: `observations.json/components/${assertion.entity}/${assertion.component}`,
    severity: "error",
    suggestion: `Expected ${JSON.stringify(assertion)}, observed before=${JSON.stringify(before)} after=${JSON.stringify(after)}. Check the owning script and runtime component synchronization.`,
  };
}

export function finiteVector(value: unknown): boolean {
  return Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function expectedPathAssertion(assertion: IPlaytestPathAssertion): Record<string, unknown> {
  return {
    ...(assertion.atSteps === undefined ? {} : { atSteps: assertion.atSteps }),
    ...(Object.hasOwn(assertion, "equals") ? { equals: assertion.equals } : {}),
    ...(assertion.gte === undefined ? {} : { gte: assertion.gte }),
    ...(assertion.lte === undefined ? {} : { lte: assertion.lte }),
    ...(assertion.textIncludes === undefined ? {} : { textIncludes: assertion.textIncludes }),
    ...(assertion.throughoutSteps === undefined ? {} : { throughoutSteps: assertion.throughoutSteps }),
    ...(assertion.changed === undefined ? {} : { changed: assertion.changed }),
    ...(assertion.allowTrivial === undefined ? {} : { allowTrivial: assertion.allowTrivial }),
    ...(assertion.visible === undefined ? {} : { visible: assertion.visible }),
  };
}

function unchangedPathValue(before: unknown, after: unknown): boolean {
  return before !== undefined && after !== undefined && jsonEqual(before, after);
}

export function pathAssertionDiagnostic(
  kind: "hud" | "resource",
  assertion: IPlaytestPathAssertion,
  before: unknown,
  after: unknown,
  context: { effectLog?: unknown; movedDistance?: number; scenarioSourcePath?: string },
): IPlaytestDiagnostic {
  const unchanged = unchangedPathValue(before, after);
  if (kind === "resource" && unchanged && (context.movedDistance ?? 0) > 0.01) {
    const summary = summarizeResourceEffectLog(context.effectLog, assertion.id, assertion.path);
    return {
      code: "TN_PLAYTEST_RESOURCE_STATE_STAGNATED",
      message: `Resource '${assertion.id}'${assertion.path === undefined ? "" : ` path '${assertion.path}'`} did not change after the scenario moved the subject ${formatNumber(context.movedDistance ?? 0)} units.`,
      artifactPath: "effect-log.json",
      observedRuntimePath: `effect-log.json/entries[kind=resource,resource=${assertion.id}]`,
      path: assertion.path === undefined ? `${context.scenarioSourcePath ?? "playtest"}/assert/resources/${assertion.id}` : `${context.scenarioSourcePath ?? "playtest"}/assert/resources/${assertion.id}/${assertion.path}`,
      resourceId: assertion.id,
      severity: "error",
      ...(context.scenarioSourcePath === undefined ? {} : { sourcePath: context.scenarioSourcePath }),
      ...(summary?.systemId === undefined ? {} : { systemId: summary.systemId, sourcePath: summary.sourcePath }),
      suggestion: summary === undefined
        ? "The scenario movement path executed but the asserted resource never changed. Capture effect-log.json, then check pickup/contact predicates, route coordinates, resource write declarations, and stale duplicate systems before rerunning."
        : `The scenario movement path executed and effect-log.json shows ${summary.entryCount} '${assertion.id}' resource snapshot(s) from ${summary.systems}; observed values stayed ${summary.distinctValues}. Check pickup/contact predicates, route coordinates, resource write declarations, and stale duplicate systems in the listed system(s).`,
    };
  }
  return {
    code: "",
    message: `${kind === "hud" ? "HUD" : "Resource"} assertion failed for '${assertion.id}'${assertion.path === undefined ? "" : ` path '${assertion.path}'`}.`,
    severity: "error",
    suggestion: unchanged
      ? `${kind === "hud" ? "Observed HUD value" : "Observed resource value"} did not change during the scenario. Inspect effect-log.json for the owning system's resource writes, run tn build --project . --json for undeclared writes, and check whether duplicate/stale systems or route/collision setup prevented the state transition.`
      : kind === "hud" ? "Check UI binding IDs and whether the backing resource changes during the scenario." : "Check resource IDs, script writes, and assertion path spelling.",
  };
}

function summarizeResourceEffectLog(effectLog: unknown, resourceId: string, path: string | undefined): { distinctValues: string; entryCount: number; sourcePath?: string; systemId?: string; systems: string } | undefined {
  if (!isRecord(effectLog) || !Array.isArray(effectLog.entries)) {
    return undefined;
  }
  const entries = effectLog.entries
    .filter((entry): entry is Record<string, unknown> => isRecord(entry))
    .filter((entry) => entry.kind === "resource" && entry.resource === resourceId);
  if (entries.length === 0) {
    return undefined;
  }
  const systems = new Set<string>();
  const values = new Set<string>();
  for (const entry of entries) {
    if (typeof entry.system === "string") {
      systems.add(entry.system);
    }
    values.add(shortJson(readPath(entry.value, path)));
  }
  return {
    distinctValues: Array.from(values).slice(0, 3).join(", "),
    entryCount: entries.length,
    ...([...(systems)].at(0) === undefined ? {} : { sourcePath: sourcePathForSystem([...(systems)][0] as string), systemId: [...(systems)][0] as string }),
    systems: systems.size === 0 ? "unknown systems" : Array.from(systems).slice(0, 5).join(", "),
  };
}

export function sourcePathForSystem(systemId: string): string {
  return `content/systems/${systemId}.systems.json`;
}

function shortJson(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) {
    return "undefined";
  }
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

export function runtimeDiagnostics(value: unknown): unknown[] {
  const snapshot = runtimeDiagnosticsSnapshot(value);
  if (snapshot !== value) {
    return runtimeDiagnostics(snapshot);
  }
  if (!isRecord(snapshot)) {
    return [];
  }
  const recentRuntimeErrors = Array.isArray(snapshot.recentRuntimeErrors) ? snapshot.recentRuntimeErrors : [];
  const resourceFailures = isRecord(snapshot.assets) && Array.isArray(snapshot.assets.resourceFailures) ? snapshot.assets.resourceFailures : [];
  return [...recentRuntimeErrors, ...resourceFailures];
}

export function runtimeDiagnosticsSnapshot(value: unknown): unknown {
  if (isRecord(value) && isRecord(value.diagnostics)) {
    return value.diagnostics;
  }
  return value;
}

export function consoleErrors(entries: Array<{ type: string }>): Array<{ type: string }> {
  return entries.filter((entry) => entry.type === "error" || entry.type === "assert" || entry.type === "pageerror");
}

export function readPath(value: unknown, path: string | undefined): unknown {
  if (path === undefined || path.length === 0) {
    return value;
  }
  return path.split(".").reduce<unknown>((current, part) => {
    if (Array.isArray(current) && /^(0|[1-9]\d*)$/u.test(part)) {
      return current[Number(part)];
    }
    if (!isRecord(current)) {
      return undefined;
    }
    return current[part];
  }, value);
}

export type MovementAxis = "x" | "y" | "z";

export function parseMovementAxisExpectation(value: string): { axis: MovementAxis; sign?: 1 | -1 } | undefined {
  if (value === "x" || value === "y" || value === "z") {
    return { axis: value };
  }
  const match = /^([+-])([xyz])$/.exec(value);
  if (match === null) {
    return undefined;
  }
  return { axis: match[2] as MovementAxis, sign: match[1] === "-" ? -1 : 1 };
}

export function axisIndex(axis: MovementAxis): 0 | 1 | 2 {
  return axis === "x" ? 0 : axis === "y" ? 1 : 2;
}

export function textValue(value: unknown): unknown {
  if (isRecord(value)) {
    return value.text ?? value.label ?? value.valueText ?? value.value;
  }
  return value;
}

export function readRotation(value: unknown): Vec3 | undefined {
  if (!isRecord(value) || !Array.isArray(value.rotation) || value.rotation.length < 3) {
    return undefined;
  }
  const rotation = value.rotation.slice(0, 3).map((item) => typeof item === "number" && Number.isFinite(item) ? item : Number.NaN);
  return rotation.every(Number.isFinite) ? rotation as Vec3 : undefined;
}

export function readVec3(value: unknown): Vec3 | undefined {
  if (!Array.isArray(value) || value.length < 3) {
    return undefined;
  }
  const vector = value.slice(0, 3).map((item) => typeof item === "number" && Number.isFinite(item) ? item : Number.NaN);
  return vector.every(Number.isFinite) ? vector as Vec3 : undefined;
}

export function vectorDistance(left: Vec3, right: Vec3): number {
  const dx = right[0] - left[0];
  const dy = right[1] - left[1];
  const dz = right[2] - left[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

export function jsonEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(sortedKeys(left)) === JSON.stringify(sortedKeys(right));
}

// Key insertion order is incidental to a published state object, so objects are compared by
// their keys' names; arrays keep their order. Non-plain objects (Date, class instances with a
// toJSON) are left to JSON.stringify untouched.
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortedKeys);
  }
  if (!isRecord(value)) {
    return value;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return value;
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortedKeys(value[key]);
  }
  return sorted;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
