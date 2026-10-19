import {
  playtestDiagnostic,
  resolveDiagnosticsPolicy,
  type IPlaytestAssertionResult,
  type IPlaytestDiagnosticsPolicy,
  type IPlaytestDiagnostic,
  type IPlaytestObservationSnapshot,
  type IPlaytestProtocolDiagnostic,
  type IPlaytestScenario,
  type IPlaytestSetupRequest,
} from "../index.js";
import type {
  IPlaytestReport,
  IPlaytestSetupRecord,
  PlaytestVec3,
} from "../report.js";
import type { ICpuWindow } from "./linuxCpuWindow.js";
import type { IStandalonePlaytestConfig } from "./config.js";

export const UNHANDLED_REJECTION_PREFIX = "__THREENATIVE_PLAYTEST_UNHANDLED_REJECTION__:";
/** How long a single screenshot may take before the runner calls it a failure. */
export const SCREENSHOT_TIMEOUT_MS = 120_000;
export const MAX_FIXED_STEP_STARTUP_RETRIES = 120;
export const STOPPED_LOOP_ERROR = "Cannot advance a stopped loop.";

export interface ILabeledPlaytestSample {
  label: string;
  signals: unknown[];
  snapshot: IPlaytestObservationSnapshot;
}

export interface IRunnerConsoleEntry {
  source?: "browser-console" | "page-error" | "unhandled-rejection";
  text: string;
  type: string;
}

export interface IMovementSampleInterval {
  after: IPlaytestObservationSnapshot;
  before: IPlaytestObservationSnapshot;
  inputDriven: boolean;
}

export interface IRunStepSamples {
  afterInput?: IPlaytestObservationSnapshot;
  afterStep?: IPlaytestObservationSnapshot;
  inputDriven: boolean;
}

export interface IStandalonePlaytestReport extends IPlaytestReport {
  artifactDirectory: string;
  acquisition?: { requestUrls: readonly string[]; cpuWindows?: readonly ICpuWindow[]; completionWindow?: import("./steps.js").ICompletionWindow };
  /**
   * The clock this run measured on, as the protocol names it: `fixed-step` for the default
   * tick-counted scenario, `wall-clock` when `--live-clock` put the host's own frame pump in
   * charge. A frame rate is only the rate of the clock that produced it, so every report says
   * which one this was — the same field the native production profile carries.
   */
  clock: "fixed-step" | "wall-clock";
  /**
   * What the run waited for before it observed anything, and what it settled on.
   *
    * `rule: "compile-settled"` means the sustained in-budget frame window was not required,
    * because the operator declared a software adapter: the wait still ran to full readiness, but
    * a CPU rasteriser reaches it on the bounded window rather than on five sustained frames. A
    * pass from such a run is not a smoothness measurement and must not be read as one, so the
    * report says which rule applied rather than leaving a reader to assume the stricter one.
   */
  startup?: {
    compileSettled?: boolean;
    phase: string;
    progress: number;
    rule: string;
    timeline?: { loadStartedMs?: number; enteredMs?: number; compileSettledMs?: number; readyMs?: number };
  };
  debugColliders?: boolean;
  input?: string;
  movementThreshold?: number;
  pass: boolean;
  runtime: "native" | "web";
  scenario: string;
  target: string;
  trivialityOptOutCount: number;
  url: string;
}

export class ManagedServerError extends Error {
  constructor(readonly diagnostic: IPlaytestProtocolDiagnostic) {
    super(diagnostic.message);
  }
}

export interface IAbortablePlaytestTarget {
  abortCleanup?: () => Promise<void>;
  abortSignal?: AbortSignal;
  name: string;
}

export function targetLabel(target: string): string {
  if (target === "android") return "Android";
  if (target === "ios") return "iOS";
  if (target === "browser" || target === "web") return "Browser";
  if (target === "desktop") return "Desktop";
  return target;
}

export function interruptedPlaytestError(target: string): Error {
  return new Error(`${targetLabel(target)} playtest interrupted by signal.`);
}

export async function throwIfAborted(target: IAbortablePlaytestTarget): Promise<void> {
  if (!target.abortSignal?.aborted) return;
  await target.abortCleanup?.();
  throw interruptedPlaytestError(target.name);
}

export function failedDiagnosticsAssertion(policy: IPlaytestDiagnosticsPolicy): IPlaytestAssertionResult {
  return {
    details: {
      consoleErrors: 0,
      networkErrors: 0,
      policy,
      reason: "not-evaluated",
      runtimeDiagnostics: 0,
    },
    id: "diagnostics",
    pass: false,
  };
}

/**
 * A page that throws while booting never installs its bridge, so the run ends on a bare
 * bridge-missing or a 30 s operation timeout. The throw is already collected: name it there.
 */
export function withPageCause<T extends { readonly code: string; readonly message: string }>(
  diagnostic: T,
  entries: readonly IRunnerConsoleEntry[],
): T {
  if (diagnostic.code !== "TN_PLAYTEST_BRIDGE_MISSING" && diagnostic.code !== "TN_PLAYTEST_OPERATION_TIMEOUT")
    return diagnostic;
  const cause = entries.find(({ type }) => type === "pageerror") ?? entries.find(({ type }) => type === "error");
  if (cause === undefined) return diagnostic;
  return { ...diagnostic, message: `${diagnostic.message} The page reported: ${cause.text.split("\n")[0]}` };
}

export function failureReport(
  config: IStandalonePlaytestConfig,
  scenario: IPlaytestScenario,
  diagnostic: IPlaytestProtocolDiagnostic,
  target: string = scenario.target,
): IStandalonePlaytestReport {
  const native = target === "android" || target === "desktop" || target === "ios";
  const diagnosticsPolicy = resolveDiagnosticsPolicy(scenario.assert?.diagnostics, target);
  const item: IPlaytestDiagnostic = { ...diagnostic, suggestion: diagnostic.fix.instruction };
  return {
    artifactDirectory: config.artifactDirectory,
    assertionResults: [failedDiagnosticsAssertion(diagnosticsPolicy)],
    clock: config.liveClock === true ? "wall-clock" : "fixed-step",
    debugColliders: false,
    diagnostics: [item],
    diagnosticsPolicy,
    distance: 0,
    entity: scenario.subject ?? "",
    expectMoved: false,
    frames: 0,
    input: "",
    movementThreshold: 0,
    pass: false,
    runtime: native ? "native" : "web",
    scenario: scenario.name,
    ...(scenario.setup === undefined ? {} : { setup: { applied: [], requested: requestedSetupRecords(scenario) } }),
    target,
    trivialityOptOutCount: 0,
    trivialityOptOuts: [],
    url: native
      ? target === "desktop"
        ? config.desktop?.executable ?? "desktop"
        : config.endpoint ?? "http://127.0.0.1:41777/playtest"
      : config.url,
  };
}

/**
 * Every key here is optional in the scenario, and the payload crosses assertJsonSafe
 * on the way to the page. An explicit `undefined` is not JSON-safe, so spreading a
 * partially-specified transform verbatim aborted the whole run before it started.
 * Absent keys must stay absent.
 */
export function setupRequest(scenario: IPlaytestScenario): IPlaytestSetupRequest {
  return {
    ...(scenario.setup?.entities === undefined
      ? {}
      : {
          entities: scenario.setup.entities.map(({ entity, position, rotation, scale }) => ({
            entity,
            transform: {
              ...(position === undefined ? {} : { position }),
              ...(rotation === undefined ? {} : { rotation }),
              ...(scale === undefined ? {} : { scale }),
            },
          })),
        }),
    ...(scenario.setup?.resources === undefined
      ? {}
      : {
          resources: scenario.setup.resources.map(({ id, path, value }) => ({
            id,
            ...(path === undefined ? {} : { path }),
            value: value as never,
          })),
        }),
  };
}

/**
 * Every override the scenario asks for, named by kind and entity. This is the honest-
 * reporting ledger: it rides into the run report as `requested`, next to `applied`.
 */
export function requestedSetupRecords(scenario: IPlaytestScenario): IPlaytestSetupRecord[] {
  const setup = scenario.setup;
  if (setup === undefined) return [];
  const asJson = (value: unknown): IPlaytestSetupRecord["value"] => value as IPlaytestSetupRecord["value"];
  return [
    ...(setup.spawn === undefined
      ? []
      : [{ entity: scenario.subject, kind: "spawn" as const, value: asJson(setup.spawn) }]),
    ...(setup.aim === undefined
      ? []
      : [{ entity: scenario.subject, kind: "aim" as const, value: asJson(setup.aim) }]),
    ...(setup.entities ?? []).map(({ entity, position, rotation, scale }) => ({
      entity,
      kind: "entities" as const,
      value: asJson({
        ...(position === undefined ? {} : { position }),
        ...(rotation === undefined ? {} : { rotation }),
        ...(scale === undefined ? {} : { scale }),
      }),
    })),
    ...(setup.place ?? []).map(({ at, entity, facing, frozen, lookAt }) => ({
      entity,
      kind: "place" as const,
      value: asJson({
        at,
        ...(facing === undefined ? {} : { facing }),
        ...(frozen === undefined ? {} : { frozen }),
        ...(lookAt === undefined ? {} : { lookAt }),
      }),
    })),
    ...(setup.resources ?? []).map(({ id, value }) => ({ entity: id, kind: "resources" as const, value: asJson(value) })),
  ];
}

export function isAnonymousMovementScenario(scenario: IPlaytestScenario): boolean {
  return scenario.assert?.movement !== undefined
    && scenario.assert.movement.entity === undefined
    && scenario.subject === undefined;
}

export function entityPosition(snapshot: IPlaytestObservationSnapshot | undefined, id: string): PlaytestVec3 | undefined {
  return snapshot?.entities?.find((entity) => entity.id === id)?.transform?.position;
}

export function observedEntityIds(scenario: IPlaytestScenario): string[] | undefined {
  if (isAnonymousMovementScenario(scenario)) return undefined;
  const ids = [...new Set([
    scenario.subject,
    scenario.assert?.movement?.entity,
    scenario.assert?.camera?.entity,
    scenario.assert?.camera?.follows,
    ...(scenario.assert?.visibility ?? []).map(({ entity }) => entity),
  ].filter((value): value is string => value !== undefined))];
  return ids.length > 0
    ? ids
    : scenario.assert?.movement === undefined
      ? []
      : undefined;
}

export function observedResourceIds(scenario: IPlaytestScenario): string[] {
  return [...new Set([
    ...(scenario.assert?.resources ?? []).map(({ id }) => id),
    ...(scenario.setup?.resources ?? []).map(({ id }) => id),
    ...scenario.steps.flatMap(({ waitForResource }) => waitForResource === undefined ? [] : [waitForResource.id]),
  ])];
}

export function appendPosition(
  positions: PlaytestVec3[],
  snapshot: IPlaytestObservationSnapshot,
  entity: string | undefined,
): void {
  const position = entity === undefined ? undefined : entityPosition(snapshot, entity);
  if (position !== undefined) positions.push(position);
}

export function subtract(a: PlaytestVec3, b: PlaytestVec3): PlaytestVec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function length(vector: PlaytestVec3): number {
  return Math.hypot(...vector);
}

export function accumulatedPathLength(positions: readonly PlaytestVec3[]): number | undefined {
  if (positions.length < 2) return undefined;
  return positions.slice(1).reduce(
    (total, position, index) => total + length(subtract(position, positions[index] ?? position)),
    0,
  );
}

export function safePart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-");
}

export function managedServerError(message: string, url: string, timeoutMs: number, output: readonly string[]): ManagedServerError {
  return new ManagedServerError(playtestDiagnostic(
    "TN_PLAYTEST_SERVER_FAILED",
    `${message} URL: ${url}. Timeout: ${timeoutMs}ms. Output: ${output.join("").slice(-4_000)}`,
    "Run the server command directly, fix its first error, then rerun the same playtest command.",
  ));
}
