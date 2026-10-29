import { TONE_METRICS } from "../tone.js";
import type { IToneRegion } from "../tone.js";
import type { IPlaytestToneAssertion } from "./schema-base.js";
import { PLAYTEST_ASSERTION_REGISTRY } from "../assertions.js";
import { invalidScenario, invalidStep, rejectUnknownKeys } from "./errors.js";
import { isRecord, validateViewport, positiveInteger, hasKey, validateOptionalNumberTuple, validateAssertionKeys, validateDeviceMetricsAssertion, validateParityAssertion, validatePerformanceAssertion, validateFramebufferCoverageAssertion, validateRenderChainAssertion, validateStartupAssertion, validatePipelineCensusAssertion, validateSceneAssertion, validateSceneNodesAssertion, validateFootSlipAssertion, validateSightLineAssertion, validateHudAuditAssertion, validateEngineCostAssertion, validateCausedByAssertion, validateAnimationAssertion, validateContactAssertion, validatePathAssertion, validateNumberTuple, validateResourcePathAssertion, validateSignalAssertion, validateStateAssertion, validateTagCountAssertion, validateVisibilityAssertion, validateVisualAssertion, requireRecord, optionalNumber, requireString, optionalPositiveNumber, present, optionalTrivialityReason, optionalString, optionalPositiveInteger, optionalTargetArray, optionalBoolean, requireArray, describeValue, optionalNonNegativeNumber, optionalNonNegativeInteger } from "./schema-accessors.js";
import { NUMERIC_COMPARISON_KEYS } from "./schema-base.js";
import type { IPlaytestGeometryCaptureRequest } from "../protocol.js";
import type { IPlaytestAimRequest, IPlaytestAimTarget, IPlaytestPlaceRequest, IPlaytestSpawnRequest, IPlaytestScenario, IPlaytestArtifactRequest, IPlaytestNetworkProfile, IPlaytestParityConfig, PlaytestTarget, IPlaytestScenarioSetup, IPlaytestSetupResource, IPlaytestSetupEntityTransform, IPlaytestStep, IPlaytestPointer, IPlaytestScenarioAssertions, IPlaytestAudioAssertion, IPlaytestWorldAssertion, IPlaytestReachabilityAssertion, IPlaytestSettledAssertion, IPlaytestOverlayNodeAssertion, IPlaytestComponentAssertion, IPlaytestAerodynamicsAssertion, IPlaytestOccludedAssertion, IPlaytestResourceWait } from "./schema-base.js";
export const PLAYTEST_ROOT_KEYS = [
  "acceptanceId",
  "artifacts",
  "assert",
  "awaitStartup",
  "bootFailure",
  "clock",
  "inputDelivery",
  "name",
  "network",
  "parity",
  "reducedMotion",
  "schemaVersion",
  "setup",
  "startTick",
  "steps",
  "subject",
  "target",
  "viewport",
  "warmupFrames",
] as const;

export function validatePlaytestScenario(value: unknown, scenarioPath: string, absolutePath?: string): IPlaytestScenario {
  if (!isRecord(value)) {
    throw invalidScenario(scenarioPath, "Scenario root must be a JSON object.");
  }
  rejectUnknownKeys(value, PLAYTEST_ROOT_KEYS, scenarioPath, "scenario root");
  if (value.schemaVersion !== 1) {
    throw invalidScenario(scenarioPath, "Scenario schemaVersion must be 1.");
  }
  if (value.acceptanceId !== undefined && (typeof value.acceptanceId !== "string" || value.acceptanceId.length === 0)) {
    throw invalidScenario(scenarioPath, "Scenario acceptanceId must be a non-empty string when present.");
  }
  const name = typeof value.name === "string" ? value.name : undefined;
  if (name === undefined || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw invalidScenario(scenarioPath, "Scenario name must be a stable file-safe identifier.");
  }
  if (value.awaitStartup !== undefined && typeof value.awaitStartup !== "boolean") {
    throw invalidScenario(scenarioPath, "Scenario awaitStartup must be a boolean when present.");
  }
  if (value.startTick !== undefined && (!Number.isSafeInteger(value.startTick) || (value.startTick as number) < 0)) {
    throw invalidScenario(scenarioPath, "Scenario startTick must be a nonnegative safe integer when present.");
  }
  if (value.bootFailure !== undefined && value.bootFailure !== "renderer-no-adapter") {
    throw invalidScenario(scenarioPath, "Scenario bootFailure must be 'renderer-no-adapter' when present.");
  }
  const target = value.target === undefined ? "web" : value.target;
  if (target !== "web" && target !== "desktop" && target !== "bevy") {
    throw invalidScenario(scenarioPath, "Scenario target must be one of: web, desktop, bevy.");
  }
  if (value.bootFailure !== undefined && target !== "web") {
    throw invalidScenario(scenarioPath, "Scenario bootFailure is browser-only and requires target 'web'.");
  }
  if (value.clock !== undefined && value.clock !== "wall-clock") {
    throw invalidScenario(scenarioPath, "Scenario clock must be 'wall-clock' when present.");
  }
  if (value.clock !== undefined && target !== "web") {
    throw invalidScenario(scenarioPath, "Scenario clock is browser-only and requires target 'web'.");
  }
  if (value.reducedMotion !== undefined && value.reducedMotion !== "reduce") {
    throw invalidScenario(scenarioPath, "Scenario reducedMotion must be 'reduce' when present.");
  }
  if (value.reducedMotion !== undefined && target !== "web") {
    throw invalidScenario(scenarioPath, "Scenario reducedMotion is browser-only and requires target 'web'.");
  }
  if (value.network !== undefined && !isRecord(value.network)) {
    throw invalidScenario(scenarioPath, "Scenario network must be an object with downloadKbps and latencyMs.");
  }
  const network = value.network === undefined
    ? undefined
    : validateNetworkProfile(value.network, scenarioPath);
  if (network !== undefined && target !== "web") {
    throw invalidScenario(scenarioPath, "Scenario network is browser-only and requires target 'web'.");
  }
  const inputDelivery = value.inputDelivery ?? "deterministic";
  if (inputDelivery !== "deterministic" && inputDelivery !== "focused-dom") {
    throw invalidScenario(scenarioPath, "Scenario inputDelivery must be deterministic or focused-dom.");
  }
  if (value.assert !== undefined && !isRecord(value.assert)) {
    throw invalidScenario(scenarioPath, "Scenario assert must be a JSON object keyed by supported assertion kinds.");
  }
  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    throw invalidStep(scenarioPath, "Scenario steps[] must contain at least one step.");
  }
  // `subject`, `setup`, `artifacts` and `parity` used to be read through `isRecord(...)` /
  // `typeof === "string"` guards, so a wrong-typed value vanished and the scenario ran without
  // the subject it aimed, the setup it placed, or the parity it compared.
  if (value.subject !== undefined && (typeof value.subject !== "string" || value.subject.trim() === "")) {
    throw invalidScenario(scenarioPath, "Scenario subject must be a non-empty entity id when present.");
  }
  const subject = typeof value.subject === "string" ? value.subject : undefined;
  const steps = value.steps
    .flatMap((step, index) => isRecord(step) && step.kind === "explore" ? expandExploreStep(step, scenarioPath, index) : [step])
    .map((step, index) => validateStep(step, scenarioPath, index));
  if (steps.some(({ kind }) => kind === "aimAt") && subject === undefined) {
    throw invalidScenario(scenarioPath, "A step with kind 'aimAt' aims the subject player start; declare scenario.subject or replace the step.");
  }
  const assertions = isRecord(value.assert) ? validateAssertions(value.assert, scenarioPath) : undefined;
  validateStepLabels(steps, assertions, scenarioPath);
  return {
    ...(typeof value.acceptanceId === "string" ? { acceptanceId: value.acceptanceId } : {}),
    ...(value.artifacts === undefined
      ? {}
      : { artifacts: validateArtifacts(requireRecord(value.artifacts, scenarioPath, "artifacts"), scenarioPath) }),
    ...(assertions === undefined ? {} : { assert: assertions }),
    ...(typeof value.awaitStartup === "boolean" ? { awaitStartup: value.awaitStartup } : {}),
    ...(value.bootFailure === "renderer-no-adapter" ? { bootFailure: value.bootFailure } : {}),
    ...(value.clock === "wall-clock" ? { clock: value.clock } : {}),
    inputDelivery,
    name,
    ...(network === undefined ? {} : { network }),
    ...(value.parity === undefined
      ? {}
      : { parity: validateParityConfig(requireRecord(value.parity, scenarioPath, "parity"), scenarioPath) }),
    ...(value.reducedMotion === "reduce" ? { reducedMotion: value.reducedMotion } : {}),
    schemaVersion: 1,
    ...(value.setup === undefined
      ? {}
      : { setup: validateSetup(requireRecord(value.setup, scenarioPath, "setup"), scenarioPath, subject) }),
    ...(absolutePath === undefined ? {} : { sourcePath: absolutePath }),
    ...(value.startTick === undefined ? {} : { startTick: value.startTick as number }),
    steps,
    ...(subject === undefined ? {} : { subject }),
    target,
    viewport: validateViewport(value.viewport, scenarioPath),
    warmupFrames: optionalNonNegativeInteger(value, "warmupFrames", scenarioPath, "scenario") ?? 0,
  };
}

/**
 * Expand one `explore` step into the seeded run of ordinary `input` steps a player would make.
 *
 * Scripted steps only visit the places their author thought of; this drives the game's own bindings
 * from wherever the scenario stands, so a crash, a NaN or a fall out of the world that only a
 * player finds surfaces in the scenario's assertions. It expands at load, so every runner and every
 * target that takes an `input` step takes it, and the same seed is the same run.
 */
export function expandExploreStep(value: Record<string, unknown>, scenarioPath: string, index: number): Record<string, unknown>[] {
  rejectUnknownKeys(value, ["actions", "kind", "label", "move", "pointer", "seed", "ticks"], scenarioPath, `steps[${index}]`);
  const keys = (field: "actions" | "move"): string[] => {
    const list = value[field];
    if (list === undefined && field === "actions") return [];
    if (!Array.isArray(list) || list.length === 0 || list.some((key) => typeof key !== "string" || key.trim() === "") || new Set(list).size !== list.length) {
      throw invalidStep(scenarioPath, `Scenario step ${index} with kind 'explore' must define ${field} as a non-empty array of unique key names.`);
    }
    return list as string[];
  };
  if (!Number.isSafeInteger(value.seed)) throw invalidStep(scenarioPath, `Scenario step ${index} with kind 'explore' must define seed as an integer.`);
  const ticks = positiveInteger(value.ticks);
  if (ticks === undefined) throw invalidStep(scenarioPath, `Scenario step ${index} with kind 'explore' must define ticks as a positive integer.`);
  if (value.pointer !== undefined && typeof value.pointer !== "boolean") throw invalidStep(scenarioPath, `Scenario step ${index} with kind 'explore' pointer must be a boolean.`);
  if (value.label !== undefined && (typeof value.label !== "string" || value.label.trim() === "")) throw invalidStep(scenarioPath, `Scenario step ${index} label must be a non-empty string.`);
  const move = keys("move");
  const actions = keys("actions");
  // mulberry32: the playtest package may not depend on core's createRandom, and the run must replay.
  let state = (value.seed as number) >>> 0;
  const random = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pick = (list: readonly string[]): string => list[Math.floor(random() * list.length)]!;
  const steps: Record<string, unknown>[] = [];
  let heading = pick(move);
  for (let left = ticks; left > 0;) {
    // Held for 10-59 ticks: long enough to build speed and leave the ground, short enough to turn often.
    const holdTicks = Math.min(left, 10 + Math.floor(random() * 50));
    // A player keeps a heading for a while: a fresh key every step is a random walk that never
    // leaves the spawn, and the walls, ledges and enemies a crash needs are further out.
    if (random() < 0.2) heading = pick(move);
    const press = new Set([heading]);
    if (move.length > 1 && random() < 0.35) press.add(pick(move));
    // Half the steps press an action, and a quarter of those a second one in the same tick: the
    // combinations (crouch + jump, attack in the air) are where move sets interact and break.
    if (actions.length > 0 && random() < 0.5) {
      press.add(pick(actions));
      if (random() < 0.25) press.add(pick(actions));
    }
    steps.push({
      holdTicks,
      kind: "input",
      press: [...press],
      ...(value.pointer === true ? { pointerPosition: { x: random(), y: random() } } : {}),
      release: true,
    });
    left -= holdTicks;
  }
  if (typeof value.label === "string") steps[steps.length - 1]!.label = value.label;
  return steps;
}

export function validateArtifacts(value: Record<string, unknown>, scenarioPath: string): IPlaytestArtifactRequest {
  rejectUnknownKeys(value, ["console", "contactSheet", "effectLog", "network", "runtimeTrace", "screenshots"], scenarioPath, "artifacts");
  // The request used to be cast straight to the interface, so `screenshots: "no"` asked for a
  // screenshot mode the runner has no branch for and still captured.
  for (const key of ["console", "contactSheet", "network", "runtimeTrace"] as const) {
    optionalBoolean(value, key, scenarioPath, "artifacts");
  }
  const effectLog = value.effectLog;
  if (effectLog !== undefined && effectLog !== "focused" && typeof effectLog !== "boolean") {
    throw invalidScenario(scenarioPath, `'artifacts.effectLog' must be true, false or 'focused', received ${describeValue(effectLog)}.`);
  }
  const screenshots = value.screenshots;
  if (screenshots !== undefined && screenshots !== "before-after" && screenshots !== "after" && typeof screenshots !== "boolean") {
    throw invalidScenario(scenarioPath, `'artifacts.screenshots' must be 'before-after', 'after', true or false, received ${describeValue(screenshots)}.`);
  }
  return value as IPlaytestArtifactRequest;
}

export function validateParityConfig(value: Record<string, unknown>, scenarioPath: string): IPlaytestParityConfig {
  rejectUnknownKeys(value, ["animation", "axisDelta", "compare", "contacts", "movementDistance", "resources", "targets"], scenarioPath, "parity");
  const animation = value.animation === undefined
    ? undefined
    : requireArray(value, "animation", scenarioPath, "parity").map((item, index) => validateParityAnimation(item, scenarioPath, `parity.animation[${index}]`));
  const resources = value.resources === undefined
    ? undefined
    : validateParityResourceIds(value.resources, scenarioPath, "parity.resources");
  const targets = value.targets === undefined
    ? undefined
    : validateParityTargets(value.targets, scenarioPath, "parity.targets");
  let compareValue = value;
  let comparePath = "parity";
  if (value.compare !== undefined) {
    compareValue = requireRecord(value.compare, scenarioPath, "parity.compare");
    rejectUnknownKeys(compareValue, ["animation", "axisDelta", "contacts", "movementDistance", "resources"], scenarioPath, "parity.compare");
    comparePath = "parity.compare";
  }
  const compare = validateParityCompare(compareValue, scenarioPath, comparePath);
  return {
    ...(animation === undefined ? {} : { animation }),
    ...compare,
    ...(resources === undefined ? {} : { resources }),
    ...(targets === undefined ? {} : { targets }),
  };
}

export function validateParityCompare(
  value: Record<string, unknown>,
  scenarioPath = "scenario",
  objectPath = "parity",
): Omit<IPlaytestParityConfig, "targets"> {
  const animation = value.animation === undefined
    ? undefined
    : requireArray(value, "animation", scenarioPath, objectPath).map((item, index) => validateParityAnimation(item, scenarioPath, `${objectPath}.animation[${index}]`));
  const resources = value.resources === undefined
    ? undefined
    : validateParityResourceIds(value.resources, scenarioPath, `${objectPath}.resources`);
  const movementDistance = isRecord(value.movementDistance) && typeof value.movementDistance.maxDelta === "number" && Number.isFinite(value.movementDistance.maxDelta)
    ? { maxDelta: value.movementDistance.maxDelta }
    : undefined;
  const axisDelta = isRecord(value.axisDelta)
    ? Object.fromEntries(Object.entries(value.axisDelta).filter((entry): entry is ["x" | "y" | "z", number] =>
        (entry[0] === "x" || entry[0] === "y" || entry[0] === "z") && typeof entry[1] === "number" && Number.isFinite(entry[1]),
      ))
    : undefined;
  const contacts = isRecord(value.contacts) && typeof value.contacts.minSharedCount === "number" && Number.isFinite(value.contacts.minSharedCount)
    ? { minSharedCount: value.contacts.minSharedCount }
    : undefined;
  return {
    ...(axisDelta !== undefined && Object.keys(axisDelta).length > 0 ? { axisDelta } : {}),
    ...(animation === undefined ? {} : { animation }),
    ...(contacts === undefined ? {} : { contacts }),
    ...(movementDistance === undefined ? {} : { movementDistance }),
    ...(resources === undefined ? {} : { resources }),
  };
}

export function validateParityAnimation(
  value: unknown,
  scenarioPath = "scenario",
  objectPath = "parity.animation",
): NonNullable<IPlaytestParityConfig["animation"]>[number] {
  const record = requireRecord(value, scenarioPath, objectPath);
  rejectUnknownKeys(record, ["clip", "entity", "requiredOn"], scenarioPath, objectPath);
  return {
    ...present("clip", optionalString(record, "clip", scenarioPath, objectPath)),
    entity: requireString(record, "entity", scenarioPath, objectPath),
    ...present("requiredOn", optionalTargetArray(record, "requiredOn", scenarioPath, objectPath)),
  };
}

function validateParityResourceIds(value: unknown, scenarioPath: string, objectPath: string): string[] {
  if (!Array.isArray(value)) {
    throw invalidScenario(scenarioPath, `'${objectPath}' must be an array of resource ids, received ${describeValue(value)}.`);
  }
  return value.map((resource, index) => {
    if (typeof resource !== "string" || resource.trim() === "") {
      throw invalidScenario(scenarioPath, `'${objectPath}[${index}]' must be a non-empty resource id string, received ${describeValue(resource)}.`);
    }
    return resource;
  });
}

function validateParityTargets(value: unknown, scenarioPath: string, objectPath: string): PlaytestTarget[] {
  if (!Array.isArray(value)) {
    throw invalidScenario(scenarioPath, `'${objectPath}' must be an array of targets, received ${describeValue(value)}.`);
  }
  return value.map((target, index) => {
    if (target !== "web" && target !== "desktop" && target !== "bevy") {
      throw invalidScenario(scenarioPath, `'${objectPath}[${index}]' must be one of web, desktop, bevy; received ${describeValue(target)}.`);
    }
    return target;
  });
}

/** A browser-only throttle; every key is required, so a typo fails the scenario rather than running unthrottled. */
function validateNetworkProfile(
  value: Record<string, unknown>,
  scenarioPath: string,
): IPlaytestNetworkProfile {
  rejectUnknownKeys(value, ["downloadKbps", "latencyMs"], scenarioPath, "network");
  const downloadKbps = value.downloadKbps;
  if (
    typeof downloadKbps !== "number" ||
    !Number.isFinite(downloadKbps) ||
    downloadKbps <= 0
  ) {
    throw invalidScenario(
      scenarioPath,
      "Scenario network.downloadKbps must be a positive number of kilobits per second.",
    );
  }
  const latencyMs = value.latencyMs;
  if (typeof latencyMs !== "number" || !Number.isFinite(latencyMs) || latencyMs < 0) {
    throw invalidScenario(scenarioPath, "Scenario network.latencyMs must be a non-negative number.");
  }
  return { downloadKbps, latencyMs };
}

export function validateSetup(value: Record<string, unknown>, scenarioPath: string, subject?: string): IPlaytestScenarioSetup {
  rejectUnknownKeys(value, ["aim", "entities", "place", "resources", "spawn"], scenarioPath, "setup");
  const spawn = validateSpawnRequest(value.spawn, scenarioPath);
  const aim = validateAimRequest(value.aim, scenarioPath);
  const place = validatePlaceRequests(value.place, scenarioPath);
  // spawn and aim address the SUBJECT player start — the "one owner of the player
  // start" convention. Without a declared subject they would silently no-op or hit
  // the wrong entity, so they are rejected at load instead.
  if (spawn !== undefined && subject === undefined) {
    throw invalidScenario(scenarioPath, "Scenario setup.spawn overrides the subject player start, but the scenario declares no subject.");
  }
  if (aim !== undefined && subject === undefined) {
    throw invalidScenario(scenarioPath, "Scenario setup.aim overrides the subject player start, but the scenario declares no subject.");
  }
  const claimed = new Map<string, string>();
  for (const [index, entity] of (Array.isArray(value.entities) ? value.entities : []).entries()) {
    if (isRecord(entity) && typeof entity.entity === "string") {
      claimed.set(entity.entity, `setup.entities[${index}]`);
    }
  }
  for (const [index, entry] of (place ?? []).entries()) {
    const previous = claimed.get(entry.entity);
    if (previous !== undefined) {
      throw invalidScenario(scenarioPath, `Entity '${entry.entity}' is placed twice (${previous} and setup.place[${index}]); each id may be placed once.`);
    }
    claimed.set(entry.entity, `setup.place[${index}]`);
  }
  return {
    ...(aim === undefined ? {} : { aim }),
    ...(Array.isArray(value.entities) ? { entities: value.entities.map((entity, index) => validateSetupEntity(entity, scenarioPath, index)) } : {}),
    ...(place === undefined ? {} : { place }),
    ...(Array.isArray(value.resources) ? { resources: value.resources.map((resource, index) => validateSetupResource(resource, scenarioPath, index)) } : {}),
    ...(spawn === undefined ? {} : { spawn }),
  };
}

function validateSpawnRequest(value: unknown, scenarioPath: string): IPlaytestSpawnRequest | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value, scenarioPath, "setup.spawn");
  rejectUnknownKeys(record, ["x", "y", "z"], scenarioPath, "setup.spawn");
  const x = optionalNumber(record, "x", scenarioPath, "setup.spawn");
  const y = optionalNumber(record, "y", scenarioPath, "setup.spawn");
  const z = optionalNumber(record, "z", scenarioPath, "setup.spawn");
  if (x === undefined || z === undefined) {
    throw invalidScenario(scenarioPath, "'setup.spawn' must define finite x and z; y is optional and preserves the game's current height when absent.");
  }
  return { x, ...(y === undefined ? {} : { y }), z };
}

function validateAimRequest(value: unknown, scenarioPath: string): IPlaytestAimRequest | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value, scenarioPath, "setup.aim");
  rejectUnknownKeys(record, ["pitch", "yaw"], scenarioPath, "setup.aim");
  const pitch = optionalNumber(record, "pitch", scenarioPath, "setup.aim");
  const yaw = optionalNumber(record, "yaw", scenarioPath, "setup.aim");
  if (pitch === undefined || yaw === undefined) {
    throw invalidScenario(scenarioPath, "'setup.aim' must define finite yaw and pitch angles in radians.");
  }
  return { pitch, yaw };
}

function validatePlaceRequests(value: unknown, scenarioPath: string): IPlaytestPlaceRequest[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw invalidScenario(scenarioPath, `'setup.place' must be an array of placements, received ${describeValue(value)}.`);
  }
  if (value.length === 0) {
    throw invalidScenario(scenarioPath, "'setup.place' must contain at least one placement; an empty array places nothing.");
  }
  return value.map((entry, index) => validatePlaceRequest(entry, scenarioPath, index));
}

function validatePlaceRequest(value: unknown, scenarioPath: string, index: number): IPlaytestPlaceRequest {
  const objectPath = `setup.place[${index}]`;
  const record = requireRecord(value, scenarioPath, objectPath);
  rejectUnknownKeys(record, ["at", "entity", "facing", "frozen", "lookAt"], scenarioPath, objectPath);
  const entity = requireString(record, "entity", scenarioPath, objectPath);
  const at = validatePoint(record.at, scenarioPath, `${objectPath}.at`, "placement is absolute");
  const facingYaw = record.facing === undefined
    ? undefined
    : (() => {
        const facingRecord = requireRecord(record.facing, scenarioPath, `${objectPath}.facing`);
        rejectUnknownKeys(facingRecord, ["yaw"], scenarioPath, `${objectPath}.facing`);
        const yaw = optionalNumber(facingRecord, "yaw", scenarioPath, `${objectPath}.facing`);
        if (yaw === undefined) {
          throw invalidScenario(scenarioPath, `'${objectPath}.facing.yaw' must be a finite angle in radians.`);
        }
        return yaw;
      })();
  const lookAt = record.lookAt === undefined ? undefined : validatePoint(record.lookAt, scenarioPath, `${objectPath}.lookAt`, "lookAt names a world point");
  if (facingYaw !== undefined && lookAt !== undefined) {
    throw invalidScenario(scenarioPath, `'${objectPath}' must choose facing or lookAt, not both.`);
  }
  return {
    at,
    entity,
    ...(facingYaw === undefined ? {} : { facing: { yaw: facingYaw } }),
    ...present("frozen", optionalBoolean(record, "frozen", scenarioPath, objectPath)),
    ...(lookAt === undefined ? {} : { lookAt }),
  };
}

function validatePoint(
  value: unknown,
  scenarioPath: string,
  objectPath: string,
  requirement: string,
): { x: number; y: number; z: number } {
  const record = requireRecord(value, scenarioPath, objectPath);
  rejectUnknownKeys(record, ["x", "y", "z"], scenarioPath, objectPath);
  const x = optionalNumber(record, "x", scenarioPath, objectPath);
  const y = optionalNumber(record, "y", scenarioPath, objectPath);
  const z = optionalNumber(record, "z", scenarioPath, objectPath);
  if (x === undefined || y === undefined || z === undefined) {
    throw invalidScenario(scenarioPath, `'${objectPath}' must define finite x, y, and z; ${requirement}.`);
  }
  return { x, y, z };
}

export function validateSetupResource(value: unknown, scenarioPath: string, index: number): IPlaytestSetupResource {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) {
    throw invalidScenario(scenarioPath, `Scenario setup.resources[${index}] must name a resource id.`);
  }
  rejectUnknownKeys(value, ["id", "path", "value"], scenarioPath, `setup.resources[${index}]`);
  if (!hasKey(value, "value")) {
    throw invalidScenario(scenarioPath, `Scenario setup.resources[${index}] must define value.`);
  }
  if (value.path !== undefined && (typeof value.path !== "string" || value.path.split(".").some((part) => part.length === 0))) {
    throw invalidScenario(scenarioPath, `Scenario setup.resources[${index}].path must be a non-empty dot path when present.`);
  }
  return {
    id: value.id,
    ...(typeof value.path === "string" ? { path: value.path } : {}),
    value: value.value,
  };
}

export function validateSetupEntity(value: unknown, scenarioPath: string, index: number): IPlaytestSetupEntityTransform {
  if (!isRecord(value) || typeof value.entity !== "string" || value.entity.length === 0) {
    throw invalidScenario(scenarioPath, `Scenario setup.entities[${index}] must name an entity.`);
  }
  rejectUnknownKeys(value, ["entity", "position", "rotation", "scale"], scenarioPath, `setup.entities[${index}]`);
  const position = validateOptionalNumberTuple(value, "position", 3, scenarioPath, index);
  const rotation = validateOptionalNumberTuple(value, "rotation", 4, scenarioPath, index);
  const scale = validateOptionalNumberTuple(value, "scale", 3, scenarioPath, index);
  if (position === undefined && rotation === undefined && scale === undefined) {
    throw invalidScenario(scenarioPath, `Scenario setup.entities[${index}] must define position, rotation, or scale.`);
  }
  return {
    entity: value.entity,
    ...(position === undefined ? {} : { position }),
    ...(rotation === undefined ? {} : { rotation }),
    ...(scale === undefined ? {} : { scale }),
  };
}

/** Keys one step accepts; exported for the documentation-drift gate alongside {@link PLAYTEST_ROOT_KEYS}. */
export const PLAYTEST_STEP_KEYS = [
  "at",
  "holdFrames",
  "holdTicks",
  "kind",
  "label",
  "lifecycle",
  "media",
  "overlayMessage",
  "pitch",
  "pointerPosition",
  "pointers",
  "press",
  "release",
  "screenshot",
  "target",
  "timeoutMs",
  "waitFrames",
  "waitForResource",
  "waitTicks",
  "wheel",
  "window",
] as const;

// A multi-gigabyte web release on a 20 Mbit/s link can legitimately take minutes to reach its
// final tier. The bound exists to fail a predicate that will never be true, not to cap a slow link.
const MAX_RESOURCE_WAIT_TIMEOUT_MS = 300_000;

export function validateStep(value: unknown, scenarioPath: string, index: number): IPlaytestStep {
  if (!isRecord(value)) {
    throw invalidStep(scenarioPath, `Scenario step ${index} must be a JSON object.`);
  }
  rejectUnknownKeys(value, PLAYTEST_STEP_KEYS, scenarioPath, `steps[${index}]`);
  const waitForResource = value.waitForResource === undefined
    ? undefined
    : validateResourceWait(value.waitForResource, scenarioPath, index);
  const timeoutMs = positiveInteger(value.timeoutMs);
  if (waitForResource === undefined) {
    if (value.timeoutMs !== undefined) {
      throw invalidStep(scenarioPath, `Scenario step ${index} timeoutMs belongs to waitForResource.`);
    }
  } else {
    if (timeoutMs === undefined || timeoutMs > MAX_RESOURCE_WAIT_TIMEOUT_MS) {
      throw invalidStep(scenarioPath, `Scenario step ${index} timeoutMs must be a positive integer no greater than ${MAX_RESOURCE_WAIT_TIMEOUT_MS}.`);
    }
    for (const forbidden of [
      "at",
      "holdFrames",
      "holdTicks",
      "kind",
      "lifecycle",
      "media",
      "overlayMessage",
      "pitch",
      "pointerPosition",
      "pointers",
      "press",
      "target",
      "waitFrames",
      "waitTicks",
      "wheel",
      "window",
    ] as const) {
      if (value[forbidden] !== undefined) {
        throw invalidStep(scenarioPath, `Scenario step ${index} waitForResource cannot mix with ${forbidden}.`);
      }
    }
  }
  const press = typeof value.press === "string" && value.press.length > 0
    ? value.press
    : Array.isArray(value.press)
      && value.press.every((key) => typeof key === "string" && key.length > 0)
      && new Set(value.press).size === value.press.length
      ? [...value.press]
      : undefined;
  const overlayMessage = isRecord(value.overlayMessage)
    && typeof value.overlayMessage.overlayId === "string"
    && value.overlayMessage.overlayId.length > 0
    && typeof value.overlayMessage.type === "string"
    && value.overlayMessage.type.length > 0
    ? {
        overlayId: value.overlayMessage.overlayId,
        payload: value.overlayMessage.payload ?? {},
        type: value.overlayMessage.type,
      }
    : undefined;
  const pointerButtons = isRecord(value.pointerPosition)
    && typeof value.pointerPosition.buttons === "number"
    && Number.isInteger(value.pointerPosition.buttons)
    && value.pointerPosition.buttons >= 0
    ? value.pointerPosition.buttons
    : undefined;
  const pointerPosition = isRecord(value.pointerPosition)
    && typeof value.pointerPosition.x === "number"
    && Number.isFinite(value.pointerPosition.x)
    && value.pointerPosition.x >= 0
    && value.pointerPosition.x <= 1
    && typeof value.pointerPosition.y === "number"
    && Number.isFinite(value.pointerPosition.y)
    && value.pointerPosition.y >= 0
    && value.pointerPosition.y <= 1
    && (value.pointerPosition.buttons === undefined || pointerButtons !== undefined)
    ? {
        ...(pointerButtons === undefined ? {} : { buttons: pointerButtons }),
        x: value.pointerPosition.x,
        y: value.pointerPosition.y,
      }
    : undefined;
  const pointers = Array.isArray(value.pointers)
    ? value.pointers.map((pointer, pointerIndex) =>
        validatePointer(pointer, scenarioPath, index, pointerIndex))
    : undefined;
  // Preserve a validated wheel sample for every transport. A runner whose target cannot turn the
  // wheel must reject this field before startup; dropping it would report green while the game
  // never received the requested input.
  const unit = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
  const wheel = isRecord(value.wheel)
    && typeof value.wheel.deltaY === "number"
    && Number.isFinite(value.wheel.deltaY)
    && (value.wheel.deltaX === undefined
      || (typeof value.wheel.deltaX === "number" && Number.isFinite(value.wheel.deltaX)))
    && ((value.wheel.x === undefined && value.wheel.y === undefined)
      || (unit(value.wheel.x) && unit(value.wheel.y)))
    ? {
        ...(typeof value.wheel.deltaX === "number" ? { deltaX: value.wheel.deltaX } : {}),
        deltaY: value.wheel.deltaY,
        ...(unit(value.wheel.x) && unit(value.wheel.y) ? { x: value.wheel.x, y: value.wheel.y } : {}),
      }
    : undefined;
  if (isRecord(value.overlayMessage)) {
    rejectUnknownKeys(value.overlayMessage, ["overlayId", "payload", "type"], scenarioPath, `steps[${index}].overlayMessage`);
  }
  if (isRecord(value.pointerPosition)) {
    rejectUnknownKeys(value.pointerPosition, ["buttons", "x", "y"], scenarioPath, `steps[${index}].pointerPosition`);
  }
  if (isRecord(value.wheel)) {
    rejectUnknownKeys(value.wheel, ["deltaX", "deltaY", "x", "y"], scenarioPath, `steps[${index}].wheel`);
  }
  const media = validateMedia(value.media, scenarioPath, index);
  if (pointers !== undefined && new Set(pointers.map(({ id }) => id)).size !== pointers.length) {
    throw invalidStep(scenarioPath, `Scenario step ${index} pointers must use unique ids.`);
  }
  const holdFrames = positiveInteger(value.holdFrames);
  const holdTicks = positiveInteger(value.holdTicks);
  const waitFrames = positiveInteger(value.waitFrames);
  const waitTicks = positiveInteger(value.waitTicks);
  const kind = value.kind === "aimAt"
    ? "aimAt"
    : value.kind === "click"
      ? "click"
      : value.kind === "lifecycle"
        ? "lifecycle"
        : value.kind === "wait"
          ? "wait"
          : value.kind === "input"
            ? "input"
            : undefined;
  if (value.kind !== undefined && kind === undefined) {
    throw invalidStep(scenarioPath, `Scenario step ${index} kind must be 'aimAt', 'click', 'explore', 'input', 'lifecycle', or 'wait'.`);
  }
  const at = validateClickTarget(value.at, scenarioPath, index);
  const target = validateAimTarget(value.target, scenarioPath, index);
  const pitch = typeof value.pitch === "number" && Number.isFinite(value.pitch) ? value.pitch : undefined;
  const screenshot = typeof value.screenshot === "string" && /^[A-Za-z0-9._-]+$/.test(value.screenshot)
    ? value.screenshot
    : undefined;
  const window: IPlaytestStep["window"] = isRecord(value.window)
    && (value.window.operation === "minimize" || value.window.operation === "resize" || value.window.operation === "restore")
    && (value.window.operation !== "resize"
      || (typeof value.window.width === "number" && Number.isFinite(value.window.width) && value.window.width >= 1
        && typeof value.window.height === "number" && Number.isFinite(value.window.height) && value.window.height >= 1))
    ? {
        operation: value.window.operation as NonNullable<IPlaytestStep["window"]>["operation"],
        ...(typeof value.window.width === "number" ? { width: value.window.width } : {}),
        ...(typeof value.window.height === "number" ? { height: value.window.height } : {}),
      }
    : undefined;
  if (isRecord(value.window)) {
    rejectUnknownKeys(value.window, ["height", "operation", "width"], scenarioPath, `steps[${index}].window`);
  }
  if (isRecord(value.lifecycle)) {
    rejectUnknownKeys(value.lifecycle, ["operation", "rotation"], scenarioPath, `steps[${index}].lifecycle`);
  }
  const lifecycle = validateLifecycleStep(value.lifecycle, scenarioPath, index);
  if (kind !== "click" && (at !== undefined || value.at !== undefined)) {
    throw invalidStep(scenarioPath, `Scenario step ${index} declares at, which belongs to kind 'click'.`);
  }
  if (kind === "click") {
    if (at === undefined) {
      throw invalidStep(scenarioPath, `Scenario step ${index} with kind 'click' must define at as { x, y } or { entity }.`);
    }
    for (const forbidden of ["media", "overlayMessage", "pointerPosition", "pointers", "press", "target", "wheel", "window"] as const) {
      if (value[forbidden] !== undefined) {
        throw invalidStep(scenarioPath, `Scenario step ${index} with kind 'click' cannot define ${forbidden}.`);
      }
    }
    if (holdFrames !== undefined || holdTicks !== undefined) {
      throw invalidStep(scenarioPath, `Scenario step ${index} with kind 'click' cannot define holdFrames/holdTicks; use waitFrames or waitTicks after the click.`);
    }
  }
  if (value.press !== undefined && press === undefined) {
    throw invalidStep(scenarioPath, `Scenario step ${index} press must be a non-empty key or a unique array of non-empty keys.`);
  }
  if (kind !== "aimAt" && (target !== undefined || pitch !== undefined)) {
    throw invalidStep(scenarioPath, `Scenario step ${index} declares ${target !== undefined ? "target" : "pitch"}, which belongs to kind 'aimAt'.`);
  }
  if (kind === "aimAt") {
    // An aimAt instant steers the subject; it is not an input hold, and holdTicks
    // without a press is silently ignored by the tick math, so both are rejected.
    if (target === undefined) {
      throw invalidStep(scenarioPath, `Scenario step ${index} with kind 'aimAt' must define target as { x, z } or { entity }.`);
    }
    for (const forbidden of ["media", "overlayMessage", "pointerPosition", "pointers", "press", "wheel", "window"] as const) {
      if (value[forbidden] !== undefined) {
        throw invalidStep(scenarioPath, `Scenario step ${index} with kind 'aimAt' cannot define ${forbidden}; apply aim in its own step.`);
      }
    }
    if (holdFrames !== undefined || holdTicks !== undefined) {
      throw invalidStep(scenarioPath, `Scenario step ${index} with kind 'aimAt' cannot define holdFrames/holdTicks; use waitTicks to hold the aimed pose.`);
    }
  }
  if (value.pitch !== undefined && pitch === undefined) {
    throw invalidStep(scenarioPath, `Scenario step ${index} pitch must be a finite angle in radians.`);
  }
  if (value.target !== undefined && target === undefined) {
    throw invalidStep(scenarioPath, `Scenario step ${index} target must be { x, z } or { entity }, not both forms.`);
  }
  const hasPress = press !== undefined && (typeof press === "string" || press.length > 0);
  if (kind === "wait" && hasPress) {
    throw invalidStep(scenarioPath, `Scenario step ${index} kind wait cannot define press.`);
  }
  if (value.overlayMessage !== undefined && overlayMessage === undefined) {
    throw invalidStep(scenarioPath, `Scenario step ${index} overlayMessage must define non-empty overlayId and type fields.`);
  }
  if (value.pointerPosition !== undefined && pointerPosition === undefined) {
    throw invalidStep(scenarioPath, `Scenario step ${index} pointerPosition must define normalized x and y values from 0 through 1.`);
  }
  if (value.pointers !== undefined && pointers === undefined) {
    throw invalidStep(scenarioPath, `Scenario step ${index} pointers must be an array.`);
  }
  if (value.wheel !== undefined && wheel === undefined) {
    throw invalidStep(scenarioPath, `Scenario step ${index} wheel must define finite deltaY, optional finite deltaX, and optionally both normalized x and y from 0 through 1.`);
  }
  if (value.screenshot !== undefined && screenshot === undefined) {
    throw invalidStep(scenarioPath, `Scenario step ${index} screenshot must be a stable file-safe name.`);
  }
  if (value.label !== undefined && (typeof value.label !== "string" || value.label.trim() === "")) {
    throw invalidStep(scenarioPath, `Scenario step ${index} label must be a non-empty string.`);
  }
  // `release` was read as `typeof value.release === "boolean" ? value.release : true`, so a
  // mistyped release silently became a held key.
  if (value.release !== undefined && typeof value.release !== "boolean") {
    throw invalidStep(scenarioPath, `Scenario step ${index} release must be a boolean, received ${describeValue(value.release)}.`);
  }
  if (value.window !== undefined && window === undefined) {
    throw invalidStep(scenarioPath, `Scenario step ${index} window must define minimize, restore, or resize with positive width and height.`);
  }
  if (value.lifecycle !== undefined && lifecycle === undefined) {
    throw invalidStep(scenarioPath, `Scenario step ${index} lifecycle must define an operation of 'background', 'foreground', or 'rotate', and 'rotate' must name a rotation from 0 through 3.`);
  }
  if (kind !== "lifecycle" && value.lifecycle !== undefined) {
    throw invalidStep(scenarioPath, `Scenario step ${index} declares lifecycle, which belongs to kind 'lifecycle'.`);
  }
  if (kind === "lifecycle") {
    if (lifecycle === undefined) {
      throw invalidStep(scenarioPath, `Scenario step ${index} with kind 'lifecycle' must define lifecycle.operation.`);
    }
    // A lifecycle step is an instant the device performs, not an input and not a tick count, and
    // nothing on it could be honoured. `label` and `screenshot` are here for the same reason: the
    // runner skips the per-step observation path for these steps, so accepting either would
    // silently drop a sample the scenario asked for.
    for (const forbidden of [
      "holdFrames",
      "holdTicks",
      "label",
      "media",
      "overlayMessage",
      "pointerPosition",
      "pointers",
      "press",
      "screenshot",
      "target",
      "waitFrames",
      "waitTicks",
      "wheel",
      "window",
    ] as const) {
      if (value[forbidden] !== undefined) {
        throw invalidStep(scenarioPath, `Scenario step ${index} with kind 'lifecycle' cannot define ${forbidden}; a lifecycle step is one device operation and nothing else.`);
      }
    }
  }
  if (at === undefined && press === undefined && overlayMessage === undefined && pointerPosition === undefined && pointers === undefined && wheel === undefined && media === undefined && window === undefined && waitFrames === undefined && waitTicks === undefined && target === undefined && waitForResource === undefined && lifecycle === undefined) {
    throw invalidStep(scenarioPath, `Scenario step ${index} must define click at, press, overlayMessage, pointerPosition, pointers, wheel, media, window, aimAt target, lifecycle operation, or waitFrames/waitTicks.`);
  }
  if (value.holdFrames !== undefined && holdFrames === undefined) {
    throw invalidStep(scenarioPath, `Scenario step ${index} holdFrames must be a positive integer.`);
  }
  if (value.waitFrames !== undefined && waitFrames === undefined) {
    throw invalidStep(scenarioPath, `Scenario step ${index} waitFrames must be a positive integer.`);
  }
  if (value.holdTicks !== undefined && holdTicks === undefined) {
    throw invalidStep(scenarioPath, `Scenario step ${index} holdTicks must be a positive integer.`);
  }
  if (value.waitTicks !== undefined && waitTicks === undefined) {
    throw invalidStep(scenarioPath, `Scenario step ${index} waitTicks must be a positive integer.`);
  }
  if (holdTicks !== undefined && holdFrames !== undefined) {
    throw invalidStep(scenarioPath, `Scenario step ${index} must choose holdTicks or holdFrames, not both.`);
  }
  if (waitTicks !== undefined && waitFrames !== undefined) {
    throw invalidStep(scenarioPath, `Scenario step ${index} must choose waitTicks or waitFrames, not both.`);
  }
  if (
    (holdTicks !== undefined || waitTicks !== undefined) &&
    (holdFrames !== undefined || waitFrames !== undefined)
  ) {
    throw invalidStep(scenarioPath, `Scenario step ${index} must choose frame timing or fixed ticks, not both.`);
  }
  return {
    ...(kind === undefined ? {} : { kind }),
    ...(holdFrames === undefined ? {} : { holdFrames }),
    ...(holdTicks === undefined ? {} : { holdTicks }),
    ...(typeof value.label === "string" ? { label: value.label } : {}),
    ...(at === undefined ? {} : { at }),
    ...(lifecycle === undefined ? {} : { lifecycle }),
    ...(media === undefined ? {} : { media }),
    ...(overlayMessage === undefined ? {} : { overlayMessage }),
    ...(pitch === undefined ? {} : { pitch }),
    ...(pointerPosition === undefined ? {} : { pointerPosition }),
    ...(pointers === undefined ? {} : { pointers }),
    ...(press === undefined ? {} : { press }),
    release: typeof value.release === "boolean" ? value.release : true,
    ...(target === undefined ? {} : { target }),
    ...(screenshot === undefined ? {} : { screenshot }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(waitFrames === undefined ? {} : { waitFrames }),
    ...(waitForResource === undefined ? {} : { waitForResource }),
    ...(waitTicks === undefined ? {} : { waitTicks }),
    ...(wheel === undefined ? {} : { wheel }),
    ...(window === undefined ? {} : { window }),
  };
}

/** `media` names at least one feature, each with one of its own values; nothing is defaulted. */
function validateMedia(value: unknown, scenarioPath: string, index: number): IPlaytestStep["media"] {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw invalidStep(scenarioPath, `Scenario step ${index} media must be an object.`);
  rejectUnknownKeys(value, ["colorScheme", "reducedMotion"], scenarioPath, `steps[${index}].media`);
  const { colorScheme, reducedMotion } = value;
  if (colorScheme !== undefined && colorScheme !== "dark" && colorScheme !== "light") {
    throw invalidStep(scenarioPath, `Scenario step ${index} media.colorScheme must be 'dark' or 'light'.`);
  }
  if (reducedMotion !== undefined && reducedMotion !== "reduce" && reducedMotion !== "no-preference") {
    throw invalidStep(scenarioPath, `Scenario step ${index} media.reducedMotion must be 'reduce' or 'no-preference'.`);
  }
  if (colorScheme === undefined && reducedMotion === undefined) {
    throw invalidStep(scenarioPath, `Scenario step ${index} media must set colorScheme or reducedMotion.`);
  }
  return {
    ...(colorScheme === undefined ? {} : { colorScheme }),
    ...(reducedMotion === undefined ? {} : { reducedMotion }),
  };
}

function validateLifecycleStep(
  value: unknown,
  scenarioPath: string,
  index: number,
): IPlaytestStep["lifecycle"] {
  if (!isRecord(value)) return undefined;
  const objectPath = `steps[${index}].lifecycle`;
  const rotation = value.rotation;
  const rotationValue = typeof rotation === "number" && Number.isInteger(rotation) && rotation >= 0 && rotation <= 3
    ? rotation
    : undefined;
  if (value.operation === "rotate") {
    if (rotationValue === undefined) {
      throw invalidStep(scenarioPath, `Scenario step ${index} lifecycle.operation 'rotate' must name a rotation from 0 through 3.`);
    }
    return { operation: "rotate", rotation: rotationValue };
  }
  if (value.operation !== "background" && value.operation !== "foreground") return undefined;
  if (rotation !== undefined) {
    throw invalidStep(scenarioPath, `Scenario step ${index} lifecycle.operation '${value.operation}' cannot define rotation; only 'rotate' takes one.`);
  }
  return { operation: value.operation };
}

function validateResourceWait(value: unknown, scenarioPath: string, index: number): IPlaytestResourceWait {
  const objectPath = `steps[${index}].waitForResource`;
  if (!isRecord(value)) {
    throw invalidStep(scenarioPath, `Scenario step ${index} waitForResource must be an object.`);
  }
  rejectUnknownKeys(value, ["equals", "gte", "id", "lte", "path"], scenarioPath, objectPath);
  const hasEquals = hasKey(value, "equals");
  const hasGte = hasKey(value, "gte");
  const hasLte = hasKey(value, "lte");
  if (Number(hasEquals) + Number(hasGte) + Number(hasLte) !== 1) {
    throw invalidStep(scenarioPath, `Scenario step ${index} waitForResource must define exactly one of equals, gte, or lte.`);
  }
  const gte = hasGte ? optionalNumber(value, "gte", scenarioPath, objectPath) : undefined;
  const lte = hasLte ? optionalNumber(value, "lte", scenarioPath, objectPath) : undefined;
  if (hasGte && gte === undefined) {
    throw invalidStep(scenarioPath, `Scenario step ${index} waitForResource.gte must be a finite number.`);
  }
  if (hasLte && lte === undefined) {
    throw invalidStep(scenarioPath, `Scenario step ${index} waitForResource.lte must be a finite number.`);
  }
  const id = requireString(value, "id", scenarioPath, objectPath);
  const path = requireString(value, "path", scenarioPath, objectPath);
  if (path.split(".").some((part) => part.length === 0)) {
    throw invalidStep(scenarioPath, `Scenario step ${index} waitForResource.path must be a non-empty dot path.`);
  }
  return {
    ...(hasEquals ? { equals: value.equals } : {}),
    ...(gte === undefined ? {} : { gte }),
    id,
    ...(lte === undefined ? {} : { lte }),
    path,
  } as IPlaytestResourceWait;
}

function validateClickTarget(value: unknown, scenarioPath: string, index: number): IPlaytestStep["at"] | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.entity === "string") {
    rejectUnknownKeys(value, ["entity"], scenarioPath, `steps[${index}].at`);
    return value.entity.length === 0 ? undefined : { entity: value.entity };
  }
  if (value.entity !== undefined) return undefined;
  if (value.element !== undefined) {
    const objectPath = `steps[${index}].at`;
    rejectUnknownKeys(value, ["element"], scenarioPath, objectPath);
    const element = requireRecord(value.element, scenarioPath, `${objectPath}.element`);
    rejectUnknownKeys(element, ["id", "selector"], scenarioPath, `${objectPath}.element`);
    const id = optionalString(element, "id", scenarioPath, `${objectPath}.element`);
    const selector = optionalString(element, "selector", scenarioPath, `${objectPath}.element`);
    if ((id === undefined) === (selector === undefined)) {
      throw invalidStep(scenarioPath, `Scenario ${objectPath}.element must name exactly one of id or selector.`);
    }
    return { element: id === undefined ? { selector: selector as string } : { id } };
  }
  rejectUnknownKeys(value, ["x", "y"], scenarioPath, `steps[${index}].at`);
  return typeof value.x === "number"
    && Number.isFinite(value.x)
    && value.x >= 0
    && typeof value.y === "number"
    && Number.isFinite(value.y)
    && value.y >= 0
    ? { x: value.x, y: value.y }
    : undefined;
}

/** An aimAt target is exactly one of a world xz position or a registered entity id. */
export function validateAimTarget(value: unknown, scenarioPath: string, stepIndex: number): IPlaytestAimTarget | undefined {
  if (value === undefined) return undefined;
  const objectPath = `steps[${stepIndex}].target`;
  if (!isRecord(value)) {
    throw invalidStep(scenarioPath, `Scenario ${objectPath} must be an object, received ${describeValue(value)}.`);
  }
  if (value.entity !== undefined && (value.x !== undefined || value.z !== undefined)) {
    throw invalidStep(scenarioPath, `Scenario ${objectPath} must be { x, z } or { entity }, not both forms.`);
  }
  if (value.entity !== undefined) {
    rejectUnknownKeys(value, ["entity"], scenarioPath, objectPath);
    return { entity: requireString(value, "entity", scenarioPath, objectPath) };
  }
  rejectUnknownKeys(value, ["x", "z"], scenarioPath, objectPath);
  const x = optionalNumber(value, "x", scenarioPath, objectPath);
  const z = optionalNumber(value, "z", scenarioPath, objectPath);
  if (x === undefined || z === undefined) {
    throw invalidStep(scenarioPath, `Scenario ${objectPath} must define finite x and z world coordinates.`);
  }
  return { x, z };
}

export function validatePointer(
  value: unknown,
  scenarioPath: string,
  stepIndex: number,
  pointerIndex: number,
): IPlaytestPointer {  const path = `steps[${stepIndex}].pointers[${pointerIndex}]`;
  if (!isRecord(value)) throw invalidStep(scenarioPath, `${path} must be an object.`);
  rejectUnknownKeys(value, ["buttons", "id", "x", "y"], scenarioPath, path);
  if (!Number.isInteger(value.id) || (value.id as number) < 1) {
    throw invalidStep(scenarioPath, `${path}.id must be a positive integer.`);
  }
  if (typeof value.x !== "number" || !Number.isFinite(value.x) || value.x < 0 || value.x > 1
    || typeof value.y !== "number" || !Number.isFinite(value.y) || value.y < 0 || value.y > 1) {
    throw invalidStep(scenarioPath, `${path} must define normalized x and y values from 0 through 1.`);
  }
  if (value.buttons !== undefined && (!Number.isInteger(value.buttons) || (value.buttons as number) < 1)) {
    throw invalidStep(scenarioPath, `${path}.buttons must be a positive integer when present.`);
  }
  return {
    ...(typeof value.buttons === "number" ? { buttons: value.buttons } : {}),
    id: value.id as number,
    x: value.x,
    y: value.y,
  };
}

export function validateStepLabels(
  steps: readonly IPlaytestStep[],
  assertions: IPlaytestScenarioAssertions | undefined,
  scenarioPath: string,
): void {
  const labels = new Set<string>();
  for (const [index, step] of steps.entries()) {
    if (step.label === undefined) continue;
    if (step.label.trim() === "") {
      throw invalidStep(scenarioPath, `Scenario step ${index} label must be a non-empty string.`);
    }
    if (labels.has(step.label)) {
      throw invalidStep(scenarioPath, `Scenario step ${index} repeats duplicate label '${step.label}'.`);
    }
    labels.add(step.label);
  }
  if (assertions === undefined) return;
  const requireLabel = (label: string | undefined, path: string): void => {
    if (label !== undefined && !labels.has(label)) {
      throw invalidScenario(scenarioPath, `Assertion '${path}' names step label '${label}', but no scenario step defines it.`);
    }
  };
  for (const [index, assertion] of (assertions.resources ?? []).entries()) {
    for (const [stepIndex, step] of (assertion.atSteps ?? []).entries()) {
      requireLabel(step.label, `assert.resources[${index}].atSteps[${stepIndex}].label`);
    }
  }
  for (const [index, assertion] of (assertions.components ?? []).entries()) {
    for (const [stepIndex, step] of (assertion.atSteps ?? []).entries()) {
      requireLabel(step.label, `assert.components[${index}].atSteps[${stepIndex}].label`);
    }
  }
  for (const [index, assertion] of (assertions.tone ?? []).entries()) {
    requireLabel(assertion.atStep, `assert.tone[${index}].atStep`);
  }
  for (const [index, assertion] of (assertions.animation ?? []).entries()) {
    requireLabel(assertion.atStep, `assert.animation[${index}].atStep`);
  }
  for (const [index, assertion] of (assertions.footSlip ?? []).entries()) {
    requireLabel(assertion.atStep, `assert.footSlip[${index}].atStep`);
    // The runner samples one set of feet per step; a second assertion there would never be measured.
    if (assertions.footSlip!.findIndex(({ atStep }) => atStep === assertion.atStep) !== index)
      throw invalidScenario(scenarioPath, `Assertion 'assert.footSlip[${index}]' repeats atStep '${assertion.atStep}'; list every foot in one assertion.`);
  }
  for (const [index, assertion] of (assertions.signals ?? []).entries()) {
    requireLabel(assertion.atStep, `assert.signals[${index}].atStep`);
  }
  for (const [index, assertion] of (assertions.contacts ?? []).entries()) {
    requireLabel(assertion.atStep, `assert.contacts[${index}].atStep`);
  }
  for (const [index, assertion] of (assertions.settled ?? []).entries()) {
    requireLabel(assertion.atStep, `assert.settled[${index}].atStep`);
    requireLabel(assertion.compareToStep, `assert.settled[${index}].compareToStep`);
  }
  requireLabel(assertions.movement?.reachesPositionWithin?.atStep, "assert.movement.reachesPositionWithin.atStep");
  requireLabel(assertions.framebufferCoverage?.window.startStep, "assert.framebufferCoverage.window.startStep");
  requireLabel(assertions.framebufferCoverage?.window.endStep, "assert.framebufferCoverage.window.endStep");
  if (assertions.framebufferCoverage !== undefined) {
    const startIndex = steps.findIndex(({ label }) => label === assertions.framebufferCoverage?.window.startStep);
    const endIndex = steps.findIndex(({ label }) => label === assertions.framebufferCoverage?.window.endStep);
    if (endIndex < startIndex) {
      throw invalidScenario(
        scenarioPath,
        "Assertion 'assert.framebufferCoverage.window.endStep' must not precede startStep.",
      );
    }
  }
}

export function playtestStepHoldTicks(step: IPlaytestStep, fallback = 1): number {
  // A touch or mouse hold authored in `holdTicks` is held for those ticks. Dropping it left a
  // 90-tick drag lasting one display frame, so the scenario passed or failed on wall-clock luck.
  const pointerHold =
    (step.pointers !== undefined || step.pointerPosition !== undefined) && step.holdTicks !== undefined;
  if ((step.press === undefined && !pointerHold) || step.holdFrames !== undefined || step.waitFrames !== undefined)
    return 0;
  return Math.max(1, step.holdTicks ?? fallback);
}

export function playtestStepWaitTicks(step: IPlaytestStep): number {
  return step.waitFrames === undefined ? Math.max(0, step.waitTicks ?? 0) : 0;
}

export function validateAssertions(value: Record<string, unknown>, scenarioPath: string): IPlaytestScenarioAssertions {
  // `geometry` is a capture request, not a comparison assertion, so it carries no registry entry
  // and no result id; it is still a valid `assert` key and is validated fail-closed below.
  rejectUnknownKeys(value, [...PLAYTEST_ASSERTION_REGISTRY.map((entry) => entry.kind), "geometry"], scenarioPath, "assert");
  validateAssertionShapes(value, scenarioPath);
  validateAssertionKeys(value, scenarioPath);
  if (Array.isArray(value.signals) && value.signals.length === 0) {
    throw invalidScenario(scenarioPath, "Assertion 'assert.signals' must contain at least one signal assertion.");
  }
  if (Array.isArray(value.footSlip) && value.footSlip.length === 0) {
    throw invalidScenario(scenarioPath, "Assertion 'assert.footSlip' must contain at least one foot-slip assertion.");
  }
  if (Array.isArray(value.tone) && value.tone.length === 0) {
    throw invalidScenario(scenarioPath, "Assertion 'assert.tone' must contain at least one tone assertion.");
  }
  const movement = isRecord(value.movement) ? value.movement : undefined;
  if (movement !== undefined) {
    validateMovementBounds(movement, scenarioPath);
  }
  const camera = isRecord(value.camera) ? value.camera : undefined;
  if (
    camera !== undefined &&
    !(
      (typeof camera.within === "number" && Number.isFinite(camera.within)) ||
      camera.targetInViewport === true
    )
  ) {
    // entity/follows only select what to observe; without a binding predicate the camera
    // assertion passes on zero observations, the vacuous-green shape rejected everywhere else.
    throw invalidScenario(
      scenarioPath,
      "Assertion 'assert.camera' must declare 'within' or 'targetInViewport: true'; a camera assertion with neither passes without consulting any observation.",
    );
  }
  const diagnostics = isRecord(value.diagnostics) ? value.diagnostics : undefined;
  const performance = isRecord(value.performance)
    ? validatePerformanceAssertion(value.performance, scenarioPath, "assert.performance")
    : undefined;
  // Present-but-not-an-object is a validation failure, not a dropped assertion: a scenario that
  // says `"deviceMetrics": "cool"` must never run with the thermal check silently missing.
  const deviceMetrics = value.deviceMetrics === undefined
    ? undefined
    : validateDeviceMetricsAssertion(value.deviceMetrics, scenarioPath, "assert.deviceMetrics");
  const parity = value.parity === undefined
    ? undefined
    : validateParityAssertion(value.parity, scenarioPath, "assert.parity");
  const framebufferCoverage = isRecord(value.framebufferCoverage)
    ? validateFramebufferCoverageAssertion(
        value.framebufferCoverage,
        scenarioPath,
        "assert.framebufferCoverage",
      )
    : undefined;
  const renderChain = value.renderChain === undefined
    ? undefined
    : validateRenderChainAssertion(value.renderChain, scenarioPath, "assert.renderChain");
  const startup = value.startup === undefined
    ? undefined
    : validateStartupAssertion(value.startup, scenarioPath, "assert.startup");
  const pipelineCensus = value.pipelineCensus === undefined
    ? undefined
    : validatePipelineCensusAssertion(value.pipelineCensus, scenarioPath, "assert.pipelineCensus");
  const scene = value.scene === undefined
    ? undefined
    : validateSceneAssertion(value.scene, scenarioPath, "assert.scene");
  const geometry = value.geometry === undefined
    ? undefined
    : validateGeometryCaptureRequest(value.geometry, scenarioPath, "assert.geometry");
  const world = isRecord(value.world) ? value.world : undefined;
  const optOuts = [
    ["noConsoleErrors", "consoleErrorsOptOutReason"],
    ["noNetworkErrors", "networkErrorsOptOutReason"],
    ["noRuntimeDiagnostics", "runtimeDiagnosticsOptOutReason"],
  ] as const;
  for (const [policyKey, reasonKey] of optOuts) {
    if (diagnostics?.[policyKey] === false
      && (typeof diagnostics[reasonKey] !== "string" || diagnostics[reasonKey].trim() === "")) {
      throw invalidScenario(
        scenarioPath,
        `Assertion 'assert.diagnostics.${policyKey}' may be false only when '${reasonKey}' explains the bounded exception.`,
      );
    }
  }
  return {
    ...(Array.isArray(value.aerodynamics) ? { aerodynamics: value.aerodynamics.map((entry, index) => validateAerodynamicsAssertion(entry, scenarioPath, `assert.aerodynamics[${index}]`)) } : {}),
    ...(Array.isArray(value.animation) ? { animation: value.animation.map((entry, index) => validateAnimationAssertion(entry, scenarioPath, `assert.animation[${index}]`)) } : {}),
    ...(Array.isArray(value.audio) ? { audio: value.audio.map((entry, index) => validateAudioAssertion(entry, scenarioPath, `assert.audio[${index}]`)) } : {}),
    ...(camera === undefined
      ? {}
      : {
          camera: {
            ...(typeof camera.entity === "string" ? { entity: camera.entity } : {}),
            ...(typeof camera.follows === "string" ? { follows: camera.follows } : {}),
            ...(typeof camera.targetInViewport === "boolean" ? { targetInViewport: camera.targetInViewport } : {}),
            ...(typeof camera.within === "number" && Number.isFinite(camera.within) ? { within: camera.within } : {}),
          },
        }),
    ...(Array.isArray(value.components)
      ? {
          components: value.components.map((entry, index) =>
            validateComponentAssertion(entry, scenarioPath, `assert.components[${index}]`),
          ),
        }
      : {}),
    ...(Array.isArray(value.contacts) ? { contacts: value.contacts.map((entry, index) => validateContactAssertion(entry, scenarioPath, `assert.contacts[${index}]`)) } : {}),
    ...(diagnostics === undefined
      ? {}
      : {
          diagnostics: {
            ...(typeof diagnostics.noConsoleErrors === "boolean" ? { noConsoleErrors: diagnostics.noConsoleErrors } : {}),
            ...(typeof diagnostics.noNetworkErrors === "boolean" ? { noNetworkErrors: diagnostics.noNetworkErrors } : {}),
            ...(typeof diagnostics.noRuntimeDiagnostics === "boolean" ? { noRuntimeDiagnostics: diagnostics.noRuntimeDiagnostics } : {}),
            ...(typeof diagnostics.consoleErrorsOptOutReason === "string" ? { consoleErrorsOptOutReason: diagnostics.consoleErrorsOptOutReason } : {}),
            ...(typeof diagnostics.networkErrorsOptOutReason === "string" ? { networkErrorsOptOutReason: diagnostics.networkErrorsOptOutReason } : {}),
            ...(typeof diagnostics.runtimeDiagnosticsOptOutReason === "string" ? { runtimeDiagnosticsOptOutReason: diagnostics.runtimeDiagnosticsOptOutReason } : {}),
            ...(typeof diagnostics.runtimeReady === "boolean" ? { runtimeReady: diagnostics.runtimeReady } : {}),
          },
        }),
    ...(Array.isArray(value.hud)
      ? {
          hud: value.hud
            .map((entry, index) => validatePathAssertion(entry, scenarioPath, `assert.hud[${index}]`)),
        }
      : {}),
    ...(performance === undefined ? {} : { performance }),
    ...(renderChain === undefined ? {} : { renderChain }),
    ...(startup === undefined ? {} : { startup }),
    ...(pipelineCensus === undefined ? {} : { pipelineCensus }),
    ...(scene === undefined ? {} : { scene }),
    ...(geometry === undefined ? {} : { geometry }),
    ...(hasKey(value, "causedBy")
      ? {
          causedBy: requireArray(value, "causedBy", scenarioPath, "assert.causedBy").map((entry, index) =>
            validateCausedByAssertion(entry, scenarioPath, `assert.causedBy[${index}]`)),
        }
      : {}),
    ...(hasKey(value, "footSlip")
      ? {
          footSlip: requireArray(value, "footSlip", scenarioPath, "assert.footSlip").map((entry, index) =>
            validateFootSlipAssertion(entry, scenarioPath, `assert.footSlip[${index}]`)),
        }
      : {}),
    ...(hasKey(value, "sightLine")
      ? { sightLine: validateSightLineAssertion(value.sightLine, scenarioPath, "assert.sightLine") }
      : {}),
    ...(hasKey(value, "hudAudit")
      ? { hudAudit: validateHudAuditAssertion(value.hudAudit, scenarioPath, "assert.hudAudit") }
      : {}),
    ...(hasKey(value, "engineCost")
      ? { engineCost: validateEngineCostAssertion(value.engineCost, scenarioPath, "assert.engineCost") }
      : {}),
    ...(hasKey(value, "sceneNodes")
      ? {
          sceneNodes: requireArray(value, "sceneNodes", scenarioPath, "assert.sceneNodes").map((entry, index) =>
            validateSceneNodesAssertion(entry, scenarioPath, `assert.sceneNodes[${index}]`)),
        }
      : {}),
    ...(deviceMetrics === undefined ? {} : { deviceMetrics }),
    ...(parity === undefined ? {} : { parity }),
    ...(framebufferCoverage === undefined ? {} : { framebufferCoverage }),
    ...(movement === undefined
      ? {}
      : {
          movement: {
            ...(typeof movement.axis === "string" ? { axis: movement.axis } : {}),
            ...(isRecord(movement.closesDistanceToPosition) && validateNumberTuple(movement.closesDistanceToPosition.position, 3) !== undefined && typeof movement.closesDistanceToPosition.min === "number" && Number.isFinite(movement.closesDistanceToPosition.min)
              ? { closesDistanceToPosition: { position: validateNumberTuple(movement.closesDistanceToPosition.position, 3)!, min: movement.closesDistanceToPosition.min } }
              : {}),
            ...(typeof movement.entity === "string" ? { entity: movement.entity } : {}),
            ...(typeof movement.facesMovementWithinDegrees === "number" && Number.isFinite(movement.facesMovementWithinDegrees)
              ? { facesMovementWithinDegrees: movement.facesMovementWithinDegrees }
              : {}),
            ...(isRecord(movement.minAxisDelta) && typeof movement.minAxisDelta.axis === "string" && typeof movement.minAxisDelta.min === "number" && Number.isFinite(movement.minAxisDelta.min)
              ? { minAxisDelta: { axis: movement.minAxisDelta.axis, min: movement.minAxisDelta.min } }
              : {}),
            ...(isRecord(movement.minResolvedAxisDelta) && typeof movement.minResolvedAxisDelta.axis === "string" && typeof movement.minResolvedAxisDelta.min === "number" && Number.isFinite(movement.minResolvedAxisDelta.min)
              ? { minResolvedAxisDelta: { axis: movement.minResolvedAxisDelta.axis, min: movement.minResolvedAxisDelta.min } }
              : {}),
            ...(typeof movement.maxTiltDegrees === "number" && Number.isFinite(movement.maxTiltDegrees) && movement.maxTiltDegrees >= 0 && movement.maxTiltDegrees <= 180
              ? { maxTiltDegrees: movement.maxTiltDegrees }
              : {}),
            ...(typeof movement.minDistance === "number" && Number.isFinite(movement.minDistance) ? { minDistance: movement.minDistance } : {}),
            ...(typeof movement.maxDistance === "number" && Number.isFinite(movement.maxDistance) && movement.maxDistance >= 0 ? { maxDistance: movement.maxDistance } : {}),
            ...(typeof movement.minVelocity === "number" && Number.isFinite(movement.minVelocity) ? { minVelocity: movement.minVelocity } : {}),
            ...(typeof movement.pathLength === "number" && Number.isFinite(movement.pathLength) && movement.pathLength >= 0 ? { pathLength: movement.pathLength } : {}),
            ...(isRecord(movement.notFacing) && typeof movement.notFacing.entity === "string" && typeof movement.notFacing.minDegrees === "number" && Number.isFinite(movement.notFacing.minDegrees)
              ? { notFacing: { entity: movement.notFacing.entity, minDegrees: movement.notFacing.minDegrees } }
              : {}),
            ...(isRecord(movement.notFacingPosition) && validateNumberTuple(movement.notFacingPosition.position, 3) !== undefined && typeof movement.notFacingPosition.minDegrees === "number" && Number.isFinite(movement.notFacingPosition.minDegrees)
              ? { notFacingPosition: { position: validateNumberTuple(movement.notFacingPosition.position, 3)!, minDegrees: movement.notFacingPosition.minDegrees } }
              : {}),
            ...(isRecord(movement.reachesPositionWithin) && validateNumberTuple(movement.reachesPositionWithin.position, 3) !== undefined && typeof movement.reachesPositionWithin.maxDistance === "number" && Number.isFinite(movement.reachesPositionWithin.maxDistance)
              ? {
                reachesPositionWithin: {
                  ...(typeof movement.reachesPositionWithin.atStep === "string"
                    ? { atStep: movement.reachesPositionWithin.atStep }
                    : {}),
                  position: validateNumberTuple(movement.reachesPositionWithin.position, 3)!,
                  maxDistance: movement.reachesPositionWithin.maxDistance,
                },
              }
              : {}),
            ...(typeof movement.rotationChanged === "boolean" ? { rotationChanged: movement.rotationChanged } : {}),
          },
    }),
    ...(Array.isArray(value.occluded) ? { occluded: value.occluded.map((entry, index) => validateOccludedAssertion(entry, scenarioPath, `assert.occluded[${index}]`)) } : {}),
    ...(Array.isArray(value.overlayNodes)
      ? {
          overlayNodes: value.overlayNodes.map((entry, index) =>
            validateOverlayNodeAssertion(entry, scenarioPath, `assert.overlayNodes[${index}]`),
          ),
        }
      : {}),
    ...(isRecord(value.reachability) ? { reachability: validateReachabilityAssertion(value.reachability, scenarioPath) } : {}),
    ...(Array.isArray(value.resources) ? { resources: value.resources.map((item, index) => validateResourcePathAssertion(item, scenarioPath, `assert.resources[${index}]`)) } : {}),
    ...(Array.isArray(value.settled)
      ? {
          settled: value.settled.map((entry, index) =>
            validateSettledAssertion(entry, scenarioPath, `assert.settled[${index}]`),
          ),
        }
      : {}),
    ...(Array.isArray(value.signals)
      ? {
          signals: value.signals.map((entry, index) =>
            validateSignalAssertion(entry, scenarioPath, `assert.signals[${index}]`),
          ),
        }
      : {}),
    ...(Array.isArray(value.states) ? { states: value.states.map((entry, index) => validateStateAssertion(entry, scenarioPath, `assert.states[${index}]`)) } : {}),
    ...(Array.isArray(value.tags) ? { tags: value.tags.map((entry, index) => validateTagCountAssertion(entry, scenarioPath, `assert.tags[${index}]`)) } : {}),
    ...(Array.isArray(value.visibility) ? { visibility: value.visibility.map((entry, index) => validateVisibilityAssertion(entry, scenarioPath, `assert.visibility[${index}]`)) } : {}),
    ...(Array.isArray(value.tone) ? { tone: value.tone.map((entry, index) => validateToneAssertion(entry, scenarioPath, `assert.tone[${index}]`)) } : {}),
    ...(Array.isArray(value.visual) ? { visual: value.visual.map((entry, index) => validateVisualAssertion(entry, scenarioPath, `assert.visual[${index}]`)) } : {}),
    ...(world === undefined ? {} : { world: validateWorldAssertion(world, scenarioPath) }),
  };
}

/**
 * A movement bound that failed validation used to vanish from the `typeof x === "number" ? { x } : {}`
 * spread below, so the assertion narrowed to whatever else it still checked and reported green on
 * that. A present bound must be a real one.
 */
function validateMovementBounds(movement: Record<string, unknown>, scenarioPath: string): void {
  for (const [key, unit] of [["maxDistance", "a non-negative distance"], ["pathLength", "a non-negative distance"]] as const) {
    const raw = movement[key];
    if (raw !== undefined && (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0)) {
      throw invalidScenario(scenarioPath, `Assertion 'assert.movement.${key}' must be ${unit}, received ${describeValue(raw)}.`);
    }
  }
  for (const key of ["closesDistanceToPosition", "minAxisDelta", "minResolvedAxisDelta", "notFacing", "notFacingPosition", "reachesPositionWithin"] as const) {
    if (movement[key] !== undefined) {
      requireRecord(movement[key], scenarioPath, `assert.movement.${key}`);
    }
  }
  if (movement.rotationChanged === false) {
    throw invalidScenario(
      scenarioPath,
      "assert.movement.rotationChanged may only be true; remove the key to stop requiring rotation.",
    );
  }
}

/** One cue-count claim: a label, and how many times it may or must have sounded. */
export function validateAudioAssertion(value: unknown, scenarioPath: string, objectPath: string): IPlaytestAudioAssertion {
  const record = requireRecord(value, scenarioPath, objectPath);
  rejectUnknownKeys(record, ["cue", "maxPlays", "minGapMs", "minPlays"], scenarioPath, objectPath);
  if (typeof record.cue !== "string" || record.cue.trim() === "")
    throw invalidScenario(scenarioPath, `Assertion '${objectPath}.cue' must be a non-empty string.`);
  const bound = (name: "maxPlays" | "minGapMs" | "minPlays"): number | undefined => {
    const raw = record[name];
    if (raw === undefined) return undefined;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0)
      throw invalidScenario(scenarioPath, `Assertion '${objectPath}.${name}' must be a non-negative integer.`);
    return raw;
  };
  const minPlays = bound("minPlays");
  const maxPlays = bound("maxPlays");
  const minGapMs = bound("minGapMs");
  if (minPlays !== undefined && maxPlays !== undefined && maxPlays < minPlays) {
    throw invalidScenario(
      scenarioPath,
      `Assertion '${objectPath}' cannot require at least ${minPlays} play(s) and at most ${maxPlays}.`,
    );
  }
  return {
    cue: record.cue,
    ...(maxPlays === undefined ? {} : { maxPlays }),
    ...(minGapMs === undefined ? {} : { minGapMs }),
    ...(minPlays === undefined ? {} : { minPlays }),
  };
}

export function validateWorldAssertion(value: Record<string, unknown>, scenarioPath: string): IPlaytestWorldAssertion {
  rejectUnknownKeys(value, ["runtime", "seed"], scenarioPath, "assert.world");
  if (!hasKey(value, "seed") || (value.seed !== null && (typeof value.seed !== "number" || !Number.isFinite(value.seed)))) {
    throw invalidScenario(scenarioPath, "Assertion 'assert.world.seed' must be a finite number or null.");
  }
  const runtimeValue = value.runtime;
  if (runtimeValue === undefined) return { seed: value.seed as number | null };
  const runtime = requireRecord(runtimeValue, scenarioPath, "assert.world.runtime");
  rejectUnknownKeys(runtime, ["agent", "core", "portable", "randomState", "rapier", "step"], scenarioPath, "assert.world.runtime");
  const portable = runtime.portable;
  if (portable !== undefined && typeof portable !== "boolean") {
    throw invalidScenario(scenarioPath, "'assert.world.runtime.portable' must be a boolean.");
  }
  const randomState = optionalNumber(runtime, "randomState", scenarioPath, "assert.world.runtime");
  if (randomState === undefined || !Number.isInteger(randomState)) {
    throw invalidScenario(scenarioPath, "'assert.world.runtime.randomState' must be an integer.");
  }
  const rapier = runtime.rapier;
  if (rapier !== null && typeof rapier !== "string") {
    throw invalidScenario(scenarioPath, "'assert.world.runtime.rapier' must be a string or null.");
  }
  return {
    runtime: {
      agent: requireString(runtime, "agent", scenarioPath, "assert.world.runtime"),
      core: requireString(runtime, "core", scenarioPath, "assert.world.runtime"),
      ...(portable === undefined ? {} : { portable }),
      randomState,
      rapier: rapier as string | null,
      step: optionalPositiveNumber(runtime, "step", scenarioPath, "assert.world.runtime") ?? (() => {
        throw invalidScenario(scenarioPath, "'assert.world.runtime.step' must be a positive number.");
      })(),
    },
    seed: value.seed as number | null,
  };
}

export function validateReachabilityAssertion(value: Record<string, unknown>, scenarioPath: string): IPlaytestReachabilityAssertion {
  if (typeof value.artifact !== "string" || value.artifact.trim() === "") {
    throw invalidScenario(scenarioPath, "Assertion 'assert.reachability.artifact' must be a non-empty project-relative path.");
  }
  if (!Array.isArray(value.entities) || value.entities.length < 2
    || value.entities.some((entity) => typeof entity !== "string" || entity.trim() === "")) {
    throw invalidScenario(scenarioPath, "Assertion 'assert.reachability.entities' must contain at least two non-empty entity ids.");
  }
  const entities = value.entities as string[];
  if (entities.some((entity, index) => index > 0 && entity === entities[index - 1])) {
    throw invalidScenario(scenarioPath, "Assertion 'assert.reachability.entities' must not repeat a consecutive entity id.");
  }
  return {
    artifact: value.artifact,
    entities,
  };
}

export function validateSettledAssertion(value: unknown, scenarioPath: string, objectPath: string): IPlaytestSettledAssertion {
  const record = requireRecord(value, scenarioPath, objectPath);
  rejectUnknownKeys(record, ["allowTrivial", "atStep", "compareToStep", "entity", "minBodies", "minMeanPoseDistance", "requiredOn"], scenarioPath, objectPath);
  return {
    ...present("allowTrivial", optionalTrivialityReason(record, "allowTrivial", scenarioPath, objectPath)),
    ...present("atStep", optionalString(record, "atStep", scenarioPath, objectPath)),
    ...present("compareToStep", optionalString(record, "compareToStep", scenarioPath, objectPath)),
    ...present("entity", optionalString(record, "entity", scenarioPath, objectPath)),
    ...present("minBodies", optionalPositiveInteger(record, "minBodies", scenarioPath, objectPath)),
    ...present("minMeanPoseDistance", optionalPositiveNumber(record, "minMeanPoseDistance", scenarioPath, objectPath)),
    ...present("requiredOn", optionalTargetArray(record, "requiredOn", scenarioPath, objectPath)),
  };
}

export function validateOverlayNodeAssertion(value: unknown, scenarioPath: string, objectPath: string): IPlaytestOverlayNodeAssertion {
  const record = requireRecord(value, scenarioPath, objectPath);
  rejectUnknownKeys(record, ["attribute", "equals", "overlayId", "selector", "textIncludes", "visible"], scenarioPath, objectPath);
  return {
    ...present("attribute", optionalString(record, "attribute", scenarioPath, objectPath)),
    // `equals` is deliberately untyped: an overlay node may be compared against any
    // JSON value, so presence is the only check that can be made here.
    ...(hasKey(record, "equals") ? { equals: record.equals } : {}),
    overlayId: requireString(record, "overlayId", scenarioPath, objectPath),
    selector: requireString(record, "selector", scenarioPath, objectPath),
    ...present("textIncludes", optionalString(record, "textIncludes", scenarioPath, objectPath)),
    ...present("visible", optionalBoolean(record, "visible", scenarioPath, objectPath)),
  };
}

export function validateComponentAssertion(value: unknown, scenarioPath: string, objectPath: string): IPlaytestComponentAssertion {
  const record = requireRecord(value, scenarioPath, objectPath);
  rejectUnknownKeys(record, ["allowTrivial", "atSteps", "changed", "component", "entity", "equals", ...NUMERIC_COMPARISON_KEYS, "path"], scenarioPath, objectPath);
  return {
    ...(record.atSteps === undefined
      ? {}
      : {
        atSteps: requireArray(record, "atSteps", scenarioPath, objectPath).map((step, index) => {
          const stepPath = `${objectPath}.atSteps[${index}]`;
          const stepRecord = requireRecord(step, scenarioPath, stepPath);
          rejectUnknownKeys(stepRecord, ["equals", "label"], scenarioPath, stepPath);
          return {
            ...(hasKey(stepRecord, "equals") ? { equals: stepRecord.equals } : {}),
            label: requireString(stepRecord, "label", scenarioPath, stepPath),
          };
        }),
      }),
    ...present("changed", optionalBoolean(record, "changed", scenarioPath, objectPath)),
    component: requireString(record, "component", scenarioPath, objectPath),
    entity: requireString(record, "entity", scenarioPath, objectPath),
    ...present("allowTrivial", optionalTrivialityReason(record, "allowTrivial", scenarioPath, objectPath)),
    // As above: any JSON value is a legal comparison target.
    ...(hasKey(record, "equals") ? { equals: record.equals } : {}),
    ...present("gte", optionalNumber(record, "gte", scenarioPath, objectPath)),
    ...present("lte", optionalNumber(record, "lte", scenarioPath, objectPath)),
    ...present("path", optionalString(record, "path", scenarioPath, objectPath)),
  };
}

export function validateAssertionShapes(value: Record<string, unknown>, scenarioPath: string): void {
  for (const entry of PLAYTEST_ASSERTION_REGISTRY) {
    const assertionValue = value[entry.kind];
    if (assertionValue === undefined) {
      continue;
    }
    const valid = entry.cardinality === "array"
      ? Array.isArray(assertionValue)
      : isRecord(assertionValue);
    if (!valid) {
      throw invalidScenario(
        scenarioPath,
        `Assertion 'assert.${entry.kind}' must be ${entry.cardinality === "array" ? "an array" : "an object"}; the declared assertion cannot be executed.`,
      );
    }
  }
}

export function validateAerodynamicsAssertion(value: unknown, scenarioPath: string, objectPath: string): IPlaytestAerodynamicsAssertion {
  const record = requireRecord(value, scenarioPath, objectPath);
  // A wrong-typed entry used to be dropped from the array and an absent entity
  // dropped the whole assertion, so the control check could shrink to [] whose
  // .every() passes vacuously. Every declared entry must load or nothing loads.
  const controls: IPlaytestAerodynamicsAssertion["controls"] = Array.isArray(record.controls)
    ? record.controls.map((control, index) => {
        const entryPath = `${objectPath}.controls[${index}]`;
        const entry = requireRecord(control, scenarioPath, entryPath);
        if (entry.sign !== "negative" && entry.sign !== "positive") {
          throw invalidScenario(scenarioPath, `'${entryPath}.sign' must be "negative" or "positive", received ${describeValue(entry.sign)}.`);
        }
        return {
          ...present("minAbs", optionalNonNegativeNumber(entry, "minAbs", scenarioPath, entryPath)),
          sign: entry.sign as "negative" | "positive",
          surface: requireString(entry, "surface", scenarioPath, entryPath),
        };
      })
    : undefined;
  const torques: IPlaytestAerodynamicsAssertion["torques"] = Array.isArray(record.torques)
    ? record.torques.map((torque, index) => {
        const entryPath = `${objectPath}.torques[${index}]`;
        const entry = requireRecord(torque, scenarioPath, entryPath);
        if (entry.axis !== "x" && entry.axis !== "y" && entry.axis !== "z") {
          throw invalidScenario(scenarioPath, `'${entryPath}.axis' must be one of x, y, z, received ${describeValue(entry.axis)}.`);
        }
        if (entry.sign !== "negative" && entry.sign !== "positive") {
          throw invalidScenario(scenarioPath, `'${entryPath}.sign' must be "negative" or "positive", received ${describeValue(entry.sign)}.`);
        }
        return {
          axis: entry.axis as "x" | "y" | "z",
          label: requireString(entry, "label", scenarioPath, entryPath),
          ...present("minAbs", optionalNonNegativeNumber(entry, "minAbs", scenarioPath, entryPath)),
          ...present("relativeToLabel", optionalString(entry, "relativeToLabel", scenarioPath, entryPath)),
          sign: entry.sign as "negative" | "positive",
        };
      })
    : undefined;
  return {
    ...(controls === undefined ? {} : { controls }),
    entity: requireString(record, "entity", scenarioPath, objectPath),
    ...present("minForceSamples", optionalPositiveInteger(record, "minForceSamples", scenarioPath, objectPath)),
    ...(torques === undefined ? {} : { torques }),
  };
}

export function validateOccludedAssertion(value: unknown, scenarioPath: string, objectPath: string): IPlaytestOccludedAssertion {
  const record = requireRecord(value, scenarioPath, objectPath);
  rejectUnknownKeys(record, ["allowTrivial", "entity", "target"], scenarioPath, objectPath);
  return {
    ...present("allowTrivial", optionalTrivialityReason(record, "allowTrivial", scenarioPath, objectPath)),
    ...present("entity", optionalString(record, "entity", scenarioPath, objectPath)),
    ...present("target", optionalString(record, "target", scenarioPath, objectPath)),
  };
}

/**
 * One armed per-object geometry capture request. Fail-closed like every other key path: an unknown
 * key, a limit outside 1..500, a sort outside the three literals, or a non-positive timeout throws
 * and names the field, rather than silently dropping the capture the scenario asked for.
 */
export function validateGeometryCaptureRequest(
  value: unknown,
  scenarioPath: string,
  objectPath: string,
): IPlaytestGeometryCaptureRequest {
  const record = requireRecord(value, scenarioPath, objectPath);
  rejectUnknownKeys(record, ["limit", "sort", "timeoutMs"], scenarioPath, objectPath);
  if (record.limit !== undefined && (typeof record.limit !== "number" || !Number.isInteger(record.limit) || record.limit < 1 || record.limit > 500)) {
    throw invalidScenario(scenarioPath, `'${objectPath}.limit' must be an integer from 1 to 500, received ${describeValue(record.limit)}.`);
  }
  if (record.sort !== undefined && record.sort !== "triangles" && record.sort !== "draws" && record.sort !== "projected") {
    throw invalidScenario(scenarioPath, `'${objectPath}.sort' must be one of triangles, draws, projected, received ${describeValue(record.sort)}.`);
  }
  if (record.timeoutMs !== undefined && (typeof record.timeoutMs !== "number" || !Number.isFinite(record.timeoutMs) || record.timeoutMs <= 0)) {
    throw invalidScenario(scenarioPath, `'${objectPath}.timeoutMs' must be a positive finite number, received ${describeValue(record.timeoutMs)}.`);
  }
  return {
    ...(record.limit === undefined ? {} : { limit: record.limit as number }),
    ...(record.sort === undefined ? {} : { sort: record.sort as NonNullable<IPlaytestGeometryCaptureRequest["sort"]> }),
    ...(record.timeoutMs === undefined ? {} : { timeoutMs: record.timeoutMs as number }),
  };
}

function validateToneAssertion(value: unknown, scenarioPath: string, objectPath: string): IPlaytestToneAssertion {
  const record = requireRecord(value, scenarioPath, objectPath);
  rejectUnknownKeys(record, ["atStep", "region", "compare", ...TONE_METRICS], scenarioPath, objectPath);
  const result: IPlaytestToneAssertion = {};
  if (record.region !== undefined) result.region = validateToneRegion(record.region, scenarioPath, `${objectPath}.region`);
  if (record.compare !== undefined) {
    if (result.region === undefined) throw invalidScenario(scenarioPath, `${objectPath}.compare requires region.`);
    const compare = requireRecord(record.compare, scenarioPath, `${objectPath}.compare`);
    rejectUnknownKeys(compare, ["region", "metric", "minDelta"], scenarioPath, `${objectPath}.compare`);
    if (!TONE_METRICS.includes(compare.metric as keyof import("../tone.js").IToneMetrics)) throw invalidScenario(scenarioPath, `${objectPath}.compare.metric is unsupported.`);
    const metric = compare.metric as keyof import("../tone.js").IToneMetrics;
    const maximum = metric.endsWith("Fraction") ? 1 : 255;
    if (typeof compare.minDelta !== "number" || !Number.isFinite(compare.minDelta) || Math.abs(compare.minDelta) > maximum) throw invalidScenario(scenarioPath, `${objectPath}.compare.minDelta must be finite in [-${maximum}, ${maximum}].`);
    result.compare = { region: validateToneRegion(compare.region, scenarioPath, `${objectPath}.compare.region`), metric, minDelta: compare.minDelta };
  }
  if (record.atStep !== undefined) result.atStep = requireString(record, "atStep", scenarioPath, objectPath);
  for (const metric of TONE_METRICS) {
    if (record[metric] === undefined) continue;
    const path = `${objectPath}.${metric}`;
    const bound = requireRecord(record[metric], scenarioPath, path);
    rejectUnknownKeys(bound, ["min", "max"], scenarioPath, path);
    if (bound.min === undefined && bound.max === undefined) throw invalidScenario(scenarioPath, `${path} requires min or max.`);
    const maximum = metric.endsWith("Fraction") ? 1 : 255;
    for (const key of ["min", "max"] as const) {
      if (bound[key] !== undefined && (typeof bound[key] !== "number" || !Number.isFinite(bound[key]) || bound[key] < 0 || bound[key] > maximum)) {
        throw invalidScenario(scenarioPath, `${path}.${key} must be a finite number in [0, ${maximum}].`);
      }
    }
    if (typeof bound.min === "number" && typeof bound.max === "number" && bound.min > bound.max) {
      throw invalidScenario(scenarioPath, `${path}: min must not exceed max.`);
    }
    result[metric] = { ...present("min", bound.min as number | undefined), ...present("max", bound.max as number | undefined) };
  }
  if (result.compare === undefined && !TONE_METRICS.some((key) => result[key] !== undefined)) throw invalidScenario(scenarioPath, `${objectPath} requires at least one metric bound.`);
  return result;
}

function validateToneRegion(value: unknown, scenarioPath: string, objectPath: string): IToneRegion {
  const record = requireRecord(value, scenarioPath, objectPath);
  rejectUnknownKeys(record, ["x", "y", "width", "height"], scenarioPath, objectPath);
  for (const key of ["x", "y", "width", "height"] as const) {
    const minimum = key === "x" || key === "y" ? 0 : 1;
    if (
      typeof record[key] !== "number" ||
      !Number.isSafeInteger(record[key]) ||
      record[key] < minimum
    )
      throw invalidScenario(
        scenarioPath,
        `${objectPath}.${key} must be a safe integer >= ${minimum}.`,
      );
  }
  return {
    x: record.x as number,
    y: record.y as number,
    width: record.width as number,
    height: record.height as number,
  };
}
