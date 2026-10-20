import {
  PLAYTEST_BRIDGE_GLOBAL,
  PLAYTEST_FROZEN_MARKER,
  PLAYTEST_PROTOCOL_LIMITS,
  PLAYTEST_PROTOCOL_VERSION,
  assertJsonSafe,
  type IPlaytestBridgeHost,
  type IPlaytestBridgeV1,
  type IPlaytestGameplayObservation,
  type IPlaytestRuntimeDiagnosticsSample,
  type IPlaytestRenderChainObservation,
  type IPlaytestSetupConfirmation,
  type IPlaytestSetupRequest,
  type IPlaytestStartupObservation,
  type JsonValue,
  type PlaytestClockMode,
  requestedPlaytestClockMode,
} from "../protocol.js";
import type { Camera, Scene } from "three";

import { ThreePlaytestEntityRegistry, type IThreePlaytestEntity } from "./entities.js";
import { isResourceOnlySample, sampleThreeObservations, type IThreePlaytestRenderer } from "./observations.js";
import { ThreePlaytestPhysicsRecorder, type IThreePlaytestPhysics } from "./physics.js";
import {
  connectDevicePlaytestBridge,
  type IDeviceBridgeInstallation,
  readPlaytestEndpoint,
} from "./device.js";

export interface IThreePlaytestResources {
  read(): Record<string, JsonValue>;
  write?(id: string, path: string | undefined, value: JsonValue): boolean;
}

export interface IThreePlaytestBridgeOptions {
  camera: Camera;
  /**
   * The clock this producer is actually running on, reported verbatim in every observation.
   *
   * `wall-clock` is a producer that lets its own frame pump move the simulation, which is the only
   * way to observe a game *playing*: on that clock `advance` delivers the span of wall time the tick
   * count names and reports the ticks that clock really ran, instead of stepping the loop itself.
   * A production profile asks for it; a deterministic scenario never does.
   */
  clockMode?: PlaytestClockMode;
  components?: () => Record<string, Record<string, JsonValue>>;
  /**
   * Runtime diagnostics for the current frame.
   *
   * An entry shaped `{ label: string, value: string | number | boolean }` is treated as a
   * **readout** — publish your FPS counter, coin tally or backend name here freely, and a proof
   * asserting `noRuntimeDiagnostics` will not fail because of it. Anything else counts as a
   * runtime **error**, including an entry carrying `severity: "error"`, `type: "error"` or an
   * `error` field. Ambiguous entries count as errors on purpose: this harness fails closed.
   */
  diagnostics?: () => JsonValue[];
  entities?: readonly IThreePlaytestEntity[] | (() => readonly IThreePlaytestEntity[]);
  fixedStep?: (ticks: number, options?: { render?: boolean }) => Promise<number | void> | number | void;
  /**
   * Draw the current world once without advancing it, for a capture taken while the loop is driven
   * and presents nothing between ticks. Optional: a bridge without it advertises no
   * `runtime.renderOnly`, and a capture that needs a render-only frame is never sent one.
   */
  renderCurrent?: () => Promise<number | void> | number | void;
  gameplay?: () => IPlaytestGameplayObservation;
  gameplayChannels?: () => readonly ("runtime.contacts" | "runtime.tags" | "runtime.transitions" | "runtime.world")[];
  runtimeDiagnosticsSeries?: () => readonly IPlaytestRuntimeDiagnosticsSample[];
  events?: () => JsonValue[];
  /** Physics bodies to retain per labelled step. Requires the authoritative tick provider. */
  physics?: IThreePlaytestPhysics;
  renderer: IThreePlaytestRenderer;
  renderChain?: () => IPlaytestRenderChainObservation | undefined;
  resources?: IThreePlaytestResources;
  scene: Scene;
  /** First-use startup progress, so a runner can wait for the world instead of the loader. */
  startup?: () => IPlaytestStartupObservation;
  tick?: () => number;
}

export interface IThreePlaytestBridgeInstallation {
  bridge: IPlaytestBridgeV1;
  dispose(): void;
  registerEntity(entry: IThreePlaytestEntity): void;
  syncEntities(): void;
}

export function installThreePlaytestBridge(options: IThreePlaytestBridgeOptions): IThreePlaytestBridgeInstallation {
  if ((options.fixedStep === undefined) !== (options.tick === undefined))
    throw new Error("fixedStep and its authoritative tick provider must be installed together.");
  // A settle or aerodynamics assertion compares snapshots taken at different scenario steps.
  // Without an authoritative tick the runner is racing the render loop rather than driving it,
  // so the comparison would be timing noise wearing an assertion's name.
  if (options.physics !== undefined && options.tick === undefined)
    throw new Error("A physics provider requires the authoritative tick provider, and therefore fixedStep.");
  const recorder = options.physics === undefined ? undefined : new ThreePlaytestPhysicsRecorder(options.physics);
  // The producer's own answer, with the capability-gated default every existing installation has
  // always reported, and the host's request read at the moment it is needed: an installer that
  // passed a mode outranks it, and a bridge installed without one still honours a wall clock the
  // runner asked for, rather than judging a live frame pump by a count it never chose. A
  // wall-clock producer still needs `fixedStep`, so the capability is unchanged.
  const clockMode = (): PlaytestClockMode =>
    options.clockMode ?? requestedPlaytestClockMode() ?? (options.fixedStep === undefined ? "render-frame" : "fixed-step");
  const host = globalThis as IPlaytestBridgeHost;
  const previous = host[PLAYTEST_BRIDGE_GLOBAL];
  const registry = new ThreePlaytestEntityRegistry();
  syncEntities(registry, options.entities);
  const capabilities = () => [
    "camera.observe",
    "entity.bounds",
    "entity.observe",
    "entity.setup",
    "scene.nodes",
    "scene.observe",
    ...(options.fixedStep === undefined ? [] : ["runtime.fixedStep"]),
    ...(options.resources === undefined ? [] : ["runtime.resources"]),
    ...(options.diagnostics === undefined ? [] : ["runtime.diagnostics"]),
    ...(Object.keys(options.components?.() ?? {}).length === 0 ? [] : ["runtime.components"]),
    ...(options.events === undefined ? [] : ["runtime.events"]),
    ...(options.gameplay === undefined ? [] : ["runtime.animation", "runtime.state"]),
    ...(options.physics === undefined ? [] : ["runtime.physics"]),
    ...(options.runtimeDiagnosticsSeries === undefined ? [] : ["runtime.performance"]),
    ...(options.renderChain === undefined ? [] : ["runtime.renderChain"]),
    ...(options.renderCurrent === undefined ? [] : ["runtime.renderOnly"]),
    ...(options.startup === undefined ? [] : ["runtime.startup"]),
    ...(options.gameplayChannels?.().includes("runtime.contacts") === true ? ["runtime.contacts"] : []),
    ...(options.gameplayChannels?.().includes("runtime.tags") === true ? ["runtime.tags"] : []),
    ...(options.gameplayChannels?.().includes("runtime.transitions") === true ? ["runtime.transitions"] : []),
    ...(options.gameplayChannels?.().includes("runtime.world") === true ? ["runtime.world"] : []),
  ];
  const bridge: IPlaytestBridgeV1 = {
    ...(options.fixedStep === undefined
      ? {}
      : {
          advance: async (ticks, advanceOptions) => {
            if (!Number.isInteger(ticks) || ticks <= 0) throw new Error("advance ticks must be a positive integer.");
            const startTick = options.tick!();
            await options.fixedStep!(ticks, advanceOptions);
            const tick = options.tick!();
            const advanced = tick - startTick;
            // A fixed-step producer is asked for a count and must deliver exactly that count. A
            // wall-clock producer is asked for the span those ticks cover and reports what the
            // host's own frame pump ran in it, so the only count that can fail closed here is none
            // at all: a game nobody is presenting never simulates, and that is not a run.
            if (clockMode() === "wall-clock" ? advanced < 1 : advanced !== ticks)
              throw new Error(clockMode() === "wall-clock"
                ? `wall-clock advance moved no tick in ${ticks} step(s) of wall time; the host presented no frame.`
                : `fixedStep advanced ${advanced} actual ticks; expected ${ticks}.`);
            return { clock: { mode: clockMode(), tick }, ticks: advanced };
          },
        }),
    applySetup: async (request) => {
      syncEntities(registry, options.entities);
      return applySetup(registry, options.resources, request);
    },
    ...(options.events === undefined
      ? {}
      : {
          drainEvents: async (limit = PLAYTEST_PROTOCOL_LIMITS.maxEventsPerDrain) => {
            if (!Number.isInteger(limit) || limit < 0) throw new Error("drainEvents limit must be a non-negative integer.");
            const events = options.events!();
            assertJsonSafe(events);
            return events.slice(0, Math.min(limit, PLAYTEST_PROTOCOL_LIMITS.maxEventsPerDrain));
          },
        }),
    ...(options.renderCurrent === undefined
      ? {}
      : {
          renderOnly: async (): Promise<number | void> => {
            await options.renderCurrent!();
          },
        }),
    describe: () => ({
      capabilities: capabilities(),
      limits: PLAYTEST_PROTOCOL_LIMITS,
      name: "@threenative/playtest/three",
      protocolVersion: PLAYTEST_PROTOCOL_VERSION,
    }),
    ready: () => {
      const startup = options.startup?.();
      if (startup === undefined) return { ready: true };
      // Reported rather than folded into `ready`: the bridge is ready to answer the moment it
      // is installed, and a runner that refused to talk to a still-loading game could never
      // watch it finish loading.
      assertJsonSafe(startup);
      return { ready: true, startup };
    },
    sample: (request) => {
      const resourceOnly = isResourceOnlySample(request);
      if (!resourceOnly) syncEntities(registry, options.entities);
      const snapshot = sampleThreeObservations({
        camera: options.camera,
        clockMode: clockMode(),
        diagnostics: options.diagnostics,
        gameplay: options.gameplay,
        runtimeDiagnosticsSeries: options.runtimeDiagnosticsSeries,
        renderChain: options.renderChain,
        registry,
        renderer: options.renderer,
        resources: options.resources === undefined ? undefined : () => options.resources!.read(),
        scene: options.scene,
        tick: options.tick?.(),
      }, request);
      const components = resourceOnly ? undefined : options.components?.();
      const withComponents = components === undefined || Object.keys(components).length === 0
        ? snapshot
        : { ...snapshot, components };
      const result = recorder === undefined || request.include?.includes("physicsDebugSeries") !== true
        ? withComponents
        : { ...withComponents, physicsDebugSeries: recorder.sample(request, options.tick!()) };
      assertJsonSafe(result);
      return result;
    },
  };
  host[PLAYTEST_BRIDGE_GLOBAL] = bridge;
  const endpoint = readPlaytestEndpoint();
  let device: IDeviceBridgeInstallation | undefined;
  if (endpoint !== undefined) device = connectDevicePlaytestBridge(bridge, endpoint);
  return {
    bridge,
    dispose: () => {
      device?.close();
      if (host[PLAYTEST_BRIDGE_GLOBAL] !== bridge) return;
      if (previous === undefined) delete host[PLAYTEST_BRIDGE_GLOBAL];
      else host[PLAYTEST_BRIDGE_GLOBAL] = previous;
    },
    registerEntity: (entry) => registry.register(entry),
    syncEntities: () => syncEntities(registry, options.entities),
  };
}

function syncEntities(
  registry: ThreePlaytestEntityRegistry,
  entities: IThreePlaytestBridgeOptions["entities"],
): void {
  if (entities === undefined) return;
  registry.replace(typeof entities === "function" ? entities() : entities);
}

function applySetup(
  registry: ThreePlaytestEntityRegistry,
  resources: IThreePlaytestResources | undefined,
  request: IPlaytestSetupRequest,
): IPlaytestSetupConfirmation {
  // Every id this returns was applied by the loops below, so the runner's report is a read-back
  // rather than its own request echoed back. The throw contract still holds; this is what makes
  // it visible in the report when it does not.
  const entities: string[] = [];
  const resourceIds: string[] = [];
  // Presence semantics: every named entity must exist in the registry right now. A miss
  // throws with the id named — placement is never silently skipped.
  request.entities?.forEach(({ entity, frozen, transform }) => {
    const object = registry.get(entity)?.object;
    if (object === undefined) throw new Error(`Setup entity '${entity}' is not registered.`);
    if (transform.position !== undefined) object.position.fromArray(transform.position);
    if (transform.rotation !== undefined) object.quaternion.fromArray(transform.rotation);
    if (transform.scale !== undefined) object.scale.fromArray(transform.scale);
    if (frozen === true) object.userData[PLAYTEST_FROZEN_MARKER] = true;
    object.updateMatrix();
    entities.push(entity);
  });
  request.resources?.forEach(({ id, path, value }) => {
    assertJsonSafe(value);
    if (resources?.write === undefined) throw new Error(`Resource setup '${id}' requires a writable resources provider.`);
    if (!resources.write(id, path, value)) throw new Error(`Resource setup '${id}' was rejected by the application provider.`);
    resourceIds.push(id);
  });
  return { entities, resources: resourceIds };
}
