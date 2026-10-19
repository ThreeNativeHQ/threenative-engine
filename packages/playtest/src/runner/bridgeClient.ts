import {
  PLAYTEST_BRIDGE_GLOBAL,
  PLAYTEST_ASSERTION_REGISTRY,
  PLAYTEST_ADVANCE_TICK_BUDGET_MS,
  PLAYTEST_PROTOCOL_LIMITS,
  PLAYTEST_STARTUP_COMPILE_BUDGET_MS,
  PLAYTEST_PROTOCOL_VERSION,
  assertJsonSafe,
  jsonByteLength,
  missingPlaytestCapabilities,
  playtestDiagnostic,
  unknownPlaytestCapabilities,
  type IPlaytestBridgeDescription,
  type IPlaytestBridgeReady,
  type IPlaytestObservationSnapshot,
  type IPlaytestProtocolDiagnostic,
  type IPlaytestSampleRequest,
  type IPlaytestScenario,
  type IPlaytestSetupApplication,
  type IPlaytestSetupConfirmation,
  type IPlaytestSetupRequest,
  requiredPlaytestCapabilities,
} from "../index.js";
import type { Page } from "playwright";

import { HOST_PLAYTEST_OBSERVATION_FIELDS, STANDALONE_PLAYTEST_OBSERVATION_FIELDS } from "./observationFields.js";
import { setupApplication as resolveSetupApplication } from "./setup-confirmation.js";
import { composeScenarioSetupRequest } from "./setup-request.js";
import { requestedSetupRecords } from "./shared.js";

const STANDALONE_OBSERVATION_FIELD_SET: readonly string[] = STANDALONE_PLAYTEST_OBSERVATION_FIELDS;
const HOST_OBSERVATION_FIELD_SET: readonly string[] = HOST_PLAYTEST_OBSERVATION_FIELDS;

const BROWSER_CAPABILITIES = [
  "browser.canvas",
  "browser.console",
  "browser.dom",
  "browser.input",
  "browser.network",
  "browser.screenshot",
  "browser.trace",
  "runtime.diagnostics",
  "runtime.ui",
] as const;

/** The only seam between assertion orchestration and an application bridge. */
export interface IBridgeTransport {
  readonly capabilities: readonly string[];
  call<T>(method: string, argument?: unknown, timeoutMs?: number, options?: unknown): Promise<T>;
  close(): Promise<void>;
  waitForBridge(timeoutMs: number): Promise<boolean>;
}

/**
 * The budget for one `advance` call: the round-trip allowance plus time for the ticks themselves.
 *
 * Every other bridge method is a request and a reply, so `operationTimeoutMs` fits. `advance` runs
 * the game loop N times before replying, so its honest bound grows with N. Fixed at 5 s it failed
 * `starter-game-over` — 600 ticks in one call — on a two-core runner, and reported it as
 * `TN_PLAYTEST_OPERATION_TIMEOUT`, which reads as a hung page rather than a slow one.
 */
export function advanceTimeoutMs(
  ticks: number,
  perTickMs: number = PLAYTEST_ADVANCE_TICK_BUDGET_MS,
): number {
  const requested = Number.isFinite(ticks) && ticks > 0 ? ticks : 0;
  // The base covers first-use compilation, not just a round trip. `warmupFrames` advances before
  // the startup wait, so the shortest advance in a scenario is also the one most likely to be the
  // call during which the game compiles its shaders and pipelines — 10 ticks exceeded 7500ms on a
  // two-core runner, which is ~750ms a tick against the ~100ms a tick that steady state costs.
  // STARTUP_COMPILE_BUDGET_MS is the framework's own bound on that work, so an advance that can
  // overlap it has to allow for it rather than assume steady state.
  return (
    PLAYTEST_PROTOCOL_LIMITS.operationTimeoutMs +
    PLAYTEST_STARTUP_COMPILE_BUDGET_MS +
    requested * perTickMs
  );
}

export class PlaytestBridgeError extends Error {
  constructor(readonly diagnostic: IPlaytestProtocolDiagnostic) {
    super(diagnostic.message);
  }
}

export interface IPlaytestBridgeClient {
  /** `render: true` draws a world frame per tick; the default advances without drawing. Browser bridges only. */
  advance(ticks: number, options?: { render?: boolean }): Promise<void>;
  applySetup(request: IPlaytestSetupRequest): Promise<void>;
  close(): Promise<void>;
  drainEvents(limit?: number): Promise<import("../protocol.js").JsonValue[]>;
  description: IPlaytestBridgeDescription;
  /** Setup applied before the handshake released a held game, when the scenario declared setup. */
  setupApplication?: IPlaytestSetupApplication;
  /** Re-reads the bridge's readiness, including startup progress when it reports any. */
  readiness(): Promise<IPlaytestBridgeReady>;
  /** Draws the current world once without advancing it. Requires `runtime.renderOnly`. */
  renderOnly(): Promise<void>;
  sample(request: IPlaytestSampleRequest): Promise<IPlaytestObservationSnapshot>;
}

export class PlaywrightTransport implements IBridgeTransport {
  readonly capabilities = BROWSER_CAPABILITIES;

  constructor(
    private readonly page: Page,
    private readonly operationTimeoutMs: number = PLAYTEST_PROTOCOL_LIMITS.operationTimeoutMs,
  ) {}

  async call<T>(method: string, argument?: unknown, timeoutMs?: number, options?: unknown): Promise<T> {
    return bridgeCall<T>(this.page, method, argument, timeoutMs ?? this.operationTimeoutMs, options);
  }

  async close(): Promise<void> {}

  async waitForBridge(timeoutMs: number): Promise<boolean> {
    return this.page
      .waitForFunction((globalName) => globalName in globalThis, PLAYTEST_BRIDGE_GLOBAL, {
        timeout: timeoutMs,
      })
      .then(() => true)
      .catch(() => false);
  }
}

export async function connectPlaytestBridge(
  page: Page,
  scenario: IPlaytestScenario,
  timeoutMs: number = PLAYTEST_PROTOCOL_LIMITS.operationTimeoutMs,
): Promise<IPlaytestBridgeClient | undefined> {
  // The transport keeps the operation budget; the bridge wait gets the startup one. They were the
  // same value, which meant an application's whole first-use compilation had to fit inside a
  // request/response round trip.
  return connectPlaytestBridgeTransport(
    new PlaywrightTransport(page, timeoutMs),
    scenario,
    bridgeWaitTimeoutMs(timeoutMs),
    "browser",
  );
}

/**
 * How long to wait for the page to install its playtest bridge — and for the handshake to answer.
 *
 * The bridge appears during application startup, not during a request/response round trip, so
 * `operationTimeoutMs` is the wrong budget for it by construction — the same mistake, in the same
 * direction, as timing a bulk `advance` with it. On a software-rendered two-core runner the
 * scaffolded starter spends seconds in first-use compilation before the bridge exists, and the run
 * was reported as `TN_PLAYTEST_BRIDGE_MISSING` with `frames: 0`: not a page without a bridge, a
 * page that had not finished booting yet.
 *
 * One operation plus the startup budget, matching `advanceTimeoutMs`. A page that genuinely
 * installs no bridge still fails with the same diagnostic, just later.
 */
export function bridgeWaitTimeoutMs(
  operationMs: number = PLAYTEST_PROTOCOL_LIMITS.operationTimeoutMs,
): number {
  return operationMs + PLAYTEST_STARTUP_COMPILE_BUDGET_MS;
}

export async function connectPlaytestBridgeTransport(
  transport: IBridgeTransport,
  scenario: IPlaytestScenario,
  timeoutMs: number = bridgeWaitTimeoutMs(),
  target?: string,
): Promise<IPlaytestBridgeClient | undefined> {
  const required = requiredPlaytestCapabilities(scenario, target);
  const bridgeRequired = missingPlaytestCapabilities(required, transport.capabilities);
  const exists = await transport.waitForBridge(timeoutMs);
  if (!exists) {
    if (bridgeRequired.length === 0) {
      return undefined;
    }
    throw new PlaytestBridgeError(playtestDiagnostic(
      "TN_PLAYTEST_BRIDGE_MISSING",
      `Scenario requires semantic capabilities but '${PLAYTEST_BRIDGE_GLOBAL}' is not installed.`,
      "Install an adapter before application startup and register the asserted entities.",
    ));
  }
  const setupApplication = scenario.setup === undefined
    ? undefined
    : await applySetupBeforeDescribe(transport, scenario);
  // The handshake answers while the page is still booting, so it gets the startup budget for the
  // same reason `waitForBridge` does. Left on the plain operation budget it equalled the
  // first-use compile bound exactly, and `tower-defense` timed out on `ready` at `frames: 0` —
  // a software-GPU shader compile that ran out of time inside a request and a reply.
  const description = await transport.call<IPlaytestBridgeDescription>("describe", undefined, timeoutMs);
  const unknown = unknownPlaytestCapabilities(description.capabilities);
  if (unknown.length > 0) {
    throw new PlaytestBridgeError(playtestDiagnostic(
      "TN_PLAYTEST_BRIDGE_CAPABILITY_UNKNOWN",
      `Bridge advertises capability '${unknown[0]}' that runner protocol ${PLAYTEST_PROTOCOL_VERSION} does not define.`,
      `Remove '${unknown[0]}' from the bridge description or register it in PLAYTEST_CAPABILITY_REGISTRY before running the scenario.`,
      { capability: unknown[0] },
    ));
  }
  if (description.protocolVersion !== PLAYTEST_PROTOCOL_VERSION) {
    throw new PlaytestBridgeError(playtestDiagnostic(
      "TN_PLAYTEST_BRIDGE_INCOMPATIBLE",
      `Bridge protocol ${description.protocolVersion} is incompatible with runner protocol ${PLAYTEST_PROTOCOL_VERSION}.`,
      "Install matching @threenative/playtest and adapter package versions.",
    ));
  }
  const ready = await transport.call<IPlaytestBridgeReady>("ready", undefined, timeoutMs);
  if (!ready.ready) {
    throw new PlaytestBridgeError(playtestDiagnostic(
      "TN_PLAYTEST_BRIDGE_NOT_READY",
      `Playtest bridge is not ready${ready.reason === undefined ? "." : `: ${ready.reason}`}`,
      "Wait for scene, camera, renderer, and entity registration before exposing bridge readiness.",
    ));
  }
  const missing = missingPlaytestCapabilities(required, [
    ...transport.capabilities,
    ...description.capabilities,
  ]);
  if (missing.length > 0) {
    throw new PlaytestBridgeError(playtestDiagnostic(
      "TN_PLAYTEST_CAPABILITY_MISSING",
      `Scenario requires missing capability '${missing[0]}'.`,
      `Register a provider for '${missing[0]}' or remove the assertion that requires it.`,
      { capability: missing[0] },
    ));
  }
  const unavailable = unavailableObservation(scenario);
  if (unavailable !== undefined) {
    throw new PlaytestBridgeError(playtestDiagnostic(
      "TN_PLAYTEST_OBSERVATION_UNAVAILABLE",
      `Assertion '${unavailable.assertion}' requires observation '${unavailable.path}', but this runner does not produce it.`,
      unavailable.reason,
      { path: unavailable.path },
    ));
  }
  return {
    advance: async (ticks, options) => {
      // Scaled by the work requested, not fixed. See PLAYTEST_ADVANCE_TICK_BUDGET_MS.
      await transport.call("advance", ticks, advanceTimeoutMs(ticks), options);
    },
    applySetup: async (request) => {
      assertBoundedPayload(request);
      await transport.call("applySetup", request);
    },
    close: () => transport.close(),
    drainEvents: async (limit) => {
      const events = await transport.call<import("../protocol.js").JsonValue[]>("drainEvents", limit);
      if (!Array.isArray(events)) throw new Error("Bridge drainEvents must return an array.");
      assertBoundedPayload(events);
      return events;
    },
    description,
    ...(setupApplication === undefined ? {} : { setupApplication }),
    readiness: () => transport.call<IPlaytestBridgeReady>("ready"),
    renderOnly: async () => {
      await transport.call("renderOnly");
    },
    sample: async (request) => {
      assertBoundedPayload(request);
      const snapshot = await transport.call<IPlaytestObservationSnapshot>("sample", request);
      assertBoundedPayload(snapshot);
      return snapshot;
    },
  };
}

async function applySetupBeforeDescribe(
  transport: IBridgeTransport,
  scenario: IPlaytestScenario,
): Promise<IPlaytestSetupApplication> {
  const requested = requestedSetupRecords(scenario);
  try {
    const request = await composeScenarioSetupRequest({
      sample: async (sampleRequest) => {
        assertBoundedPayload(sampleRequest);
        const snapshot = await transport.call<IPlaytestObservationSnapshot>("sample", sampleRequest);
        assertBoundedPayload(snapshot);
        return snapshot;
      },
    }, scenario);
    assertBoundedPayload(request);
    const confirmation = await transport.call<IPlaytestSetupConfirmation | undefined>(
      "applySetup",
      request,
    );
    return resolveSetupApplication(requested, confirmation);
  } catch (error) {
    if (error instanceof PlaytestBridgeError) throw error;
    throw new PlaytestBridgeError(playtestDiagnostic(
      "TN_PLAYTEST_SETUP_UNAPPLIED",
      `Scenario setup could not apply: ${error instanceof Error ? error.message : String(error)}`,
      "Register every placed entity with the playtest bridge before the run, or correct the placement.",
    ));
  }
}

function unavailableObservation(
  scenario: IPlaytestScenario,
): { assertion: string; path: string; reason: string } | undefined {
  for (const entry of PLAYTEST_ASSERTION_REGISTRY) {
    if (scenario.assert?.[entry.kind] === undefined) continue;
    if (!entry.supportedOn.includes(scenario.target)) {
      return {
        assertion: entry.kind,
        path: entry.observationPath,
        reason: `Assertion '${entry.kind}' is not supported on target '${scenario.target}'.`,
      };
    }
    for (const path of requiredObservationPaths(scenario, entry.kind, entry.observationPath)) {
      if (HOST_OBSERVATION_FIELD_SET.includes(path)) continue;
      if (!STANDALONE_OBSERVATION_FIELD_SET.includes(path)) {
        return {
          assertion: entry.kind,
          path,
          reason: `The standalone runner does not produce an ${path} observation required by this assertion.`,
        };
      }
    }
  }
  const movement = scenario.assert?.movement;
  if (movement !== undefined) {
    const effectLogAssertion = movement.notFacing !== undefined
      ? "movement.notFacing"
      : movement.notFacingPosition !== undefined
        ? "movement.notFacingPosition"
        : movement.facesMovementWithinDegrees !== undefined
          ? "movement.facesMovementWithinDegrees"
          : movement.minResolvedAxisDelta !== undefined
            ? "movement.minResolvedAxisDelta"
            : undefined;
    if (effectLogAssertion !== undefined) {
      return {
        assertion: effectLogAssertion,
        path: "effectLog",
        reason: "The standalone runner does not produce an effect log.",
      };
    }
  }
  return undefined;
}

function requiredObservationPaths(
  scenario: IPlaytestScenario,
  kind: string,
  defaultPath: string,
): readonly string[] {
  const movementStep = scenario.assert?.movement?.reachesPositionWithin?.atStep;
  if (kind === "movement" && movementStep !== undefined && scenario.steps.at(-1)?.label !== movementStep) {
    return ["effectLogSeries"];
  }
  if (kind === "contacts" && scenario.assert?.contacts?.some(({ atStep }) => atStep !== undefined) === true) {
    return ["physicsDebugSeries"];
  }
  return [defaultPath];
}

function assertBoundedPayload(value: unknown): void {
  assertJsonSafe(value);
  if (jsonByteLength(value) > PLAYTEST_PROTOCOL_LIMITS.maxPayloadBytes) {
    throw new PlaytestBridgeError(playtestDiagnostic(
      "TN_PLAYTEST_PAYLOAD_TOO_LARGE",
      `Bridge payload exceeds ${PLAYTEST_PROTOCOL_LIMITS.maxPayloadBytes} bytes.`,
      "Request fewer entities or return smaller provider observations.",
    ));
  }
}

async function bridgeCall<T = void>(
  page: Page,
  method: string,
  argument?: unknown,
  timeoutMs: number = PLAYTEST_PROTOCOL_LIMITS.operationTimeoutMs,
  options?: unknown,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      page.evaluate(
        async ({ argument, globalName, method, options }) => {
          const bridge = (globalThis as Record<string, unknown>)[globalName] as Record<string, unknown> | undefined;
          const operation = bridge?.[method];
          if (typeof operation !== "function") {
            throw new Error(`Bridge operation '${method}' is unavailable.`);
          }
          return operation.call(bridge, argument, options);
        },
        { argument, globalName: PLAYTEST_BRIDGE_GLOBAL, method, options },
      ) as Promise<T>,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new PlaytestBridgeError(playtestDiagnostic(
          "TN_PLAYTEST_OPERATION_TIMEOUT",
          `Bridge operation '${method}' exceeded ${timeoutMs}ms.`,
          "Bound the provider work or return a smaller observation payload.",
        ))), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
