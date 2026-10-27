import { PLAYTEST_ASSERTION_REGISTRY } from "../assertions.js";
import { PLAYTEST_FRAME_BUDGET_PHASES, PLAYTEST_FRAME_PASS_KINDS } from "../protocol.js";
import { PlaytestScenarioError, invalidScenario, rejectUnknownKeys } from "./errors.js";
import { MIN_TRIVIALITY_REASON_LENGTH, NUMERIC_COMPARISON_KEYS, PLAYTEST_PER_ADAPTER_KEYS } from "./schema-base.js";
import { GENERATED_ASSERTION_FIELD_VALIDATORS } from "./generated-assertion-validators.js";
import type { IPlaytestVisualAssertion, PlaytestTarget, IPlaytestPerformanceAssertion, IPlaytestFramebufferCoverageAssertion, IPlaytestStateAssertion, IPlaytestTagCountAssertion, IPlaytestContactAssertion, IPlaytestSignalAssertion, IPlaytestAnimationAssertion,
  IPlaytestSceneAssertion, IPlaytestSceneNodesAssertion, IPlaytestFootSlipAssertion, IPlaytestSightLineAssertion, IPlaytestHudAuditAssertion, IPlaytestSceneNodeSelectorSpec, IPlaytestCausedByAssertion, IPlaytestCauseSpec, IPlaytestEffectSpec, IPlaytestVisibilityAssertion, IPlaytestPathAssertion, IPlaytestResourceAssertion, IPlaytestResourcePathAlternative, IPlaytestViewport, IPlaytestScenarioAssertions, IPlaytestDeviceMetricsAssertion, IPlaytestParityAssertion, IPlaytestRenderChainAssertion, IPlaytestRenderChainExpectation, IPlaytestStartupAssertion, IPlaytestPipelineCensusAssertion, IPlaytestVisualRegionTarget } from "./schema-base.js";
export function validateVisualAssertion(value: unknown, scenarioPath: string, objectPath: string): IPlaytestVisualAssertion {
  const record = requireRecord(value, scenarioPath, objectPath);
  // A non-record entry used to be dropped from the array, and a mistyped key
  // collapsed its sub-object to nothing, so an entry could evaluate to an empty
  // row that reported pass without ever observing a pixel. Sub-objects validate
  // strictly and at least one of them must remain.
  const frameDiff = record.frameDiff === undefined
    ? undefined
    : validateVisualFrameDiff(record.frameDiff, scenarioPath, `${objectPath}.frameDiff`);
  const regionRecord = record.region === undefined
    ? undefined
    : requireRecord(record.region, scenarioPath, `${objectPath}.region`);
  let region: IPlaytestVisualAssertion["region"] | undefined;
  if (regionRecord !== undefined) {
    const element = regionRecord.element === undefined
      ? undefined
      : validateVisualRegionTarget(regionRecord.element, scenarioPath, `${objectPath}.region.element`);
    const edgeKeys = ["height", "width", "x", "y"] as const;
    if (element !== undefined) {
      const authoredEdge = edgeKeys.find((key) => hasKey(regionRecord, key));
      if (authoredEdge !== undefined) {
        throw invalidScenario(scenarioPath, `'${objectPath}.region.${authoredEdge}' cannot be combined with an element-bound region; the element supplies its bounds.`);
      }
      if (hasKey(regionRecord, "minSharpness")) {
        throw invalidScenario(scenarioPath, `'${objectPath}.region.minSharpness' measures the rendered frame; bound a static x/y/width/height region instead of an element.`);
      }
      region = {
        element,
        ...present("maxDarkPixelRatio", optionalRatio(regionRecord, "maxDarkPixelRatio", scenarioPath, `${objectPath}.region`)),
        ...present("maxLuminance", optionalRatio(regionRecord, "maxLuminance", scenarioPath, `${objectPath}.region`)),
        ...present("minDarkPixelRatio", optionalRatio(regionRecord, "minDarkPixelRatio", scenarioPath, `${objectPath}.region`)),
        ...present("minNonblankPixelRatio", optionalRatio(regionRecord, "minNonblankPixelRatio", scenarioPath, `${objectPath}.region`)),
      };
    } else {
      const edges: Record<"height" | "width" | "x" | "y", number> = { height: 0, width: 0, x: 0, y: 0 };
      for (const key of edgeKeys) {
        const item = regionRecord[key];
        if (typeof item !== "number" || !Number.isFinite(item)) {
          throw invalidScenario(scenarioPath, `'${objectPath}.region.${key}' must be a finite number, received ${describeValue(item)}.`);
        }
        edges[key] = item;
      }
      region = {
        ...edges,
        ...present("minSharpness", optionalPositiveNumber(regionRecord, "minSharpness", scenarioPath, `${objectPath}.region`)),
        ...present("maxDarkPixelRatio", optionalRatio(regionRecord, "maxDarkPixelRatio", scenarioPath, `${objectPath}.region`)),
        ...present("maxLuminance", optionalRatio(regionRecord, "maxLuminance", scenarioPath, `${objectPath}.region`)),
        ...present("minDarkPixelRatio", optionalRatio(regionRecord, "minDarkPixelRatio", scenarioPath, `${objectPath}.region`)),
        ...present("minNonblankPixelRatio", optionalRatio(regionRecord, "minNonblankPixelRatio", scenarioPath, `${objectPath}.region`)),
      };
    }
  }
  const entityVisibleRecord = record.entityVisible === undefined
    ? undefined
    : requireRecord(record.entityVisible, scenarioPath, `${objectPath}.entityVisible`);
  let entityVisible: IPlaytestVisualAssertion["entityVisible"] | undefined;
  if (entityVisibleRecord !== undefined) {
    if (typeof entityVisibleRecord.minProjectedPixels !== "number" || !Number.isFinite(entityVisibleRecord.minProjectedPixels) || entityVisibleRecord.minProjectedPixels < 0) {
      throw invalidScenario(scenarioPath, `'${objectPath}.entityVisible.minProjectedPixels' must be a non-negative number of pixels, received ${describeValue(entityVisibleRecord.minProjectedPixels)}.`);
    }
    entityVisible = {
      entity: requireString(entityVisibleRecord, "entity", scenarioPath, `${objectPath}.entityVisible`),
      minProjectedPixels: entityVisibleRecord.minProjectedPixels,
      ...present("throughoutFrames", optionalBoolean(entityVisibleRecord, "throughoutFrames", scenarioPath, `${objectPath}.entityVisible`)),
    };
  }
  if (frameDiff === undefined && region === undefined && entityVisible === undefined) {
    throw invalidScenario(
      scenarioPath,
      `'${objectPath}' must declare 'entityVisible', 'frameDiff', or 'region'; an empty visual assertion evaluates nothing.`,
    );
  }
  return {
    ...(frameDiff === undefined ? {} : { frameDiff }),
    ...(entityVisible === undefined ? {} : { entityVisible }),
    ...(region === undefined ? {} : { region }),
  };
}

export function validateVisualRegionTarget(value: unknown, scenarioPath: string, objectPath: string): IPlaytestVisualRegionTarget {
  const record = requireRecord(value, scenarioPath, objectPath);
  rejectUnknownKeys(record, ["id", "selector"], scenarioPath, objectPath);
  const id = optionalString(record, "id", scenarioPath, objectPath);
  const selector = optionalString(record, "selector", scenarioPath, objectPath);
  if ((id === undefined) === (selector === undefined)) {
    throw invalidScenario(scenarioPath, `'${objectPath}' must declare exactly one non-empty 'id' or 'selector'.`);
  }
  return {
    ...(id === undefined ? {} : { id }),
    ...(selector === undefined ? {} : { selector }),
  };
}

export function validateVisualFrameDiff(
  value: unknown,
  scenarioPath: string,
  objectPath: string,
): IPlaytestVisualAssertion["frameDiff"] {
  const record = requireRecord(value, scenarioPath, objectPath);
  if (record.baselineImage !== undefined && !isSafeProjectRelativePng(record.baselineImage)) {
    throw invalidScenario(scenarioPath, `'${objectPath}.baselineImage' must be a project-relative .png path without '..' or absolute segments, received ${describeValue(record.baselineImage)}.`);
  }
  const frameDiff = {
    ...present("baselineImage", optionalString(record, "baselineImage", scenarioPath, objectPath)),
    ...present("maxChangedPixelRatio", optionalRatio(record, "maxChangedPixelRatio", scenarioPath, objectPath)),
    ...present("minChangedPixelRatio", optionalRatio(record, "minChangedPixelRatio", scenarioPath, objectPath)),
  };
  // A diff with no threshold compares the capture to nothing, so it passes on any frame at all.
  if (frameDiff.maxChangedPixelRatio === undefined && frameDiff.minChangedPixelRatio === undefined) {
    throw invalidScenario(scenarioPath, `'${objectPath}' must set maxChangedPixelRatio or minChangedPixelRatio; a frameDiff that bounds no ratio accepts every frame.`);
  }
  return frameDiff;
}

export function isSafeProjectRelativePng(value: unknown): value is string {
  if (
    typeof value !== "string"
    || !value.toLowerCase().endsWith(".png")
    || value.startsWith("/")
    || /^[A-Za-z]:[\\/]/.test(value)
  ) {
    return false;
  }
  return !value.split(/[\\/]/).includes("..");
}

// Typed field accessors (CHARTER.md §8).
//
// The distinction these exist to enforce: a key that is ABSENT is fine and yields
// undefined; a key that is PRESENT but wrong-typed throws. Collapsing those two
// cases into a single `undefined` is what let a malformed assertion disappear and
// leave the scenario reporting green with nothing asserted.
//
// `optionalX` returning undefined only for an absent key kills that bug class by
// construction, so it cannot be reintroduced one careless `...(cond ? {} : {})` at
// a time.

export function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") return `the string ${JSON.stringify(value)}`;
  return `${typeof value} ${JSON.stringify(value) ?? String(value)}`;
}

export function requireRecord(value: unknown, scenarioPath: string, objectPath: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw invalidScenario(scenarioPath, `'${objectPath}' must be an object, received ${describeValue(value)}.`);
  }
  return value;
}

export function requireArray(
  value: Record<string, unknown>,
  key: string,
  scenarioPath: string,
  objectPath: string,
): unknown[] {
  const raw = value[key];
  if (!Array.isArray(raw)) {
    throw invalidScenario(scenarioPath, `'${objectPath}.${key}' must be an array, received ${describeValue(raw)}.`);
  }
  return raw;
}

export function requireString(value: Record<string, unknown>, key: string, scenarioPath: string, objectPath: string): string {
  const raw = value[key];
  if (typeof raw !== "string" || raw.trim() === "") {
    throw invalidScenario(scenarioPath, `'${objectPath}.${key}' must be a non-empty string, received ${describeValue(raw)}.`);
  }
  return raw;
}

export function optionalString(value: Record<string, unknown>, key: string, scenarioPath: string, objectPath: string): string | undefined {
  if (value[key] === undefined) return undefined;
  return requireString(value, key, scenarioPath, objectPath);
}

export function optionalTrivialityReason(value: Record<string, unknown>, key: string, scenarioPath: string, objectPath: string): string | undefined {
  const raw = value[key];
  if (raw === undefined) return undefined;
  const nonWhitespaceLength = typeof raw === "string" ? raw.replace(/\s/gu, "").length : 0;
  if (typeof raw !== "string" || nonWhitespaceLength < MIN_TRIVIALITY_REASON_LENGTH) {
    throw invalidScenario(
      scenarioPath,
      `'${objectPath}.${key}' must be a string with at least ${MIN_TRIVIALITY_REASON_LENGTH} non-whitespace characters, received ${describeValue(raw)}.`,
    );
  }
  return raw;
}

export function optionalBoolean(value: Record<string, unknown>, key: string, scenarioPath: string, objectPath: string): boolean | undefined {
  const raw = value[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== "boolean") {
    throw invalidScenario(scenarioPath, `'${objectPath}.${key}' must be a boolean, received ${describeValue(raw)}.`);
  }
  return raw;
}

export function optionalNumber(value: Record<string, unknown>, key: string, scenarioPath: string, objectPath: string): number | undefined {
  const raw = value[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw invalidScenario(scenarioPath, `'${objectPath}.${key}' must be a finite number, received ${describeValue(raw)}.`);
  }
  return raw;
}

export function optionalRatio(value: Record<string, unknown>, key: string, scenarioPath: string, objectPath: string): number | undefined {
  const raw = value[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1) {
    throw invalidScenario(scenarioPath, `'${objectPath}.${key}' must be a finite number between 0 and 1, received ${describeValue(raw)}.`);
  }
  return raw;
}

export function optionalNonNegativeNumber(value: Record<string, unknown>, key: string, scenarioPath: string, objectPath: string): number | undefined {
  const raw = value[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    throw invalidScenario(scenarioPath, `'${objectPath}.${key}' must be a finite non-negative number, received ${describeValue(raw)}.`);
  }
  return raw;
}

export function optionalNonNegativeInteger(value: Record<string, unknown>, key: string, scenarioPath: string, objectPath: string): number | undefined {
  const raw = value[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    throw invalidScenario(scenarioPath, `'${objectPath}.${key}' must be a non-negative integer, received ${describeValue(raw)}.`);
  }
  return raw;
}

export function optionalPositiveInteger(value: Record<string, unknown>, key: string, scenarioPath: string, objectPath: string): number | undefined {
  const raw = value[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    throw invalidScenario(scenarioPath, `'${objectPath}.${key}' must be a positive integer, received ${describeValue(raw)}.`);
  }
  return raw;
}

export function optionalPositiveNumber(value: Record<string, unknown>, key: string, scenarioPath: string, objectPath: string): number | undefined {
  const raw = value[key];
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) {
    throw invalidScenario(scenarioPath, `'${objectPath}.${key}' must be a positive number, received ${describeValue(raw)}.`);
  }
  return raw;
}

export function optionalTargetArray(value: Record<string, unknown>, key: string, scenarioPath: string, objectPath: string): PlaytestTarget[] | undefined {
  const raw = value[key];
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw invalidScenario(scenarioPath, `'${objectPath}.${key}' must be an array of targets, received ${describeValue(raw)}.`);
  }
  return raw.map((target, index) => {
    if (target !== "web" && target !== "desktop" && target !== "bevy") {
      throw invalidScenario(scenarioPath, `'${objectPath}.${key}[${index}]' must be one of web, desktop, bevy; received ${describeValue(target)}.`);
    }
    return target;
  });
}

/** Spread helper: omits an absent key, keeps a validated one. */
export function present<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

export function validateDeviceMetricsAssertion(value: unknown, scenarioPath: string, objectPath: string): IPlaytestDeviceMetricsAssertion {
  const record = requireRecord(value, scenarioPath, objectPath);
  rejectUnknownKeys(record, ["maxTemperatureRiseC", "maxThermalStatus", "notThermallyConfounded"], scenarioPath, objectPath);
  const assertion = {
    ...present("maxTemperatureRiseC", optionalNonNegativeNumber(record, "maxTemperatureRiseC", scenarioPath, objectPath)),
    ...present("maxThermalStatus", optionalNonNegativeInteger(record, "maxThermalStatus", scenarioPath, objectPath)),
    ...present("notThermallyConfounded", optionalBoolean(record, "notThermallyConfounded", scenarioPath, objectPath)),
  };
  // An assertion with no expectation consults no observation and reports green: the vacuous
  // shape this package rejects everywhere.
  if (Object.keys(assertion).length === 0) {
    throw invalidScenario(
      scenarioPath,
      `${objectPath} must declare at least one of 'maxTemperatureRiseC', 'maxThermalStatus' or 'notThermallyConfounded'.`,
    );
  }
  if (assertion.notThermallyConfounded === false) {
    throw invalidScenario(
      scenarioPath,
      `${objectPath}.notThermallyConfounded may only be true; remove the key to stop requiring a comparable run.`,
    );
  }
  return assertion;
}

export function validatePerformanceAssertion(value: unknown, scenarioPath: string, objectPath: string): IPlaytestPerformanceAssertion {
  const record = requireRecord(value, scenarioPath, objectPath);
  rejectUnknownKeys(record, ["maxDrawCalls", "maxFrameMsP95", "maxFrameMsReason", "maxPassDrawCalls", "maxPassTriangles", "maxPhaseMsP95", "maxTriangles", "minFps"], scenarioPath, objectPath);
  const assertion = {
    ...present("maxDrawCalls", optionalNonNegativeNumber(record, "maxDrawCalls", scenarioPath, objectPath)),
    ...present("maxFrameMsP95", optionalNonNegativeNumber(record, "maxFrameMsP95", scenarioPath, objectPath)),
    ...present("maxFrameMsReason", optionalString(record, "maxFrameMsReason", scenarioPath, objectPath)),
    ...present("maxPassDrawCalls", validatePassBudget(record.maxPassDrawCalls, scenarioPath, `${objectPath}.maxPassDrawCalls`)),
    ...present("maxPassTriangles", validatePassBudget(record.maxPassTriangles, scenarioPath, `${objectPath}.maxPassTriangles`)),
    ...present("maxPhaseMsP95", validatePhaseBudget(record.maxPhaseMsP95, scenarioPath, `${objectPath}.maxPhaseMsP95`)),
    ...present("maxTriangles", optionalNonNegativeNumber(record, "maxTriangles", scenarioPath, objectPath)),
    ...present("minFps", optionalNonNegativeNumber(record, "minFps", scenarioPath, objectPath)),
  };
  if (assertion.maxFrameMsP95 !== undefined && assertion.maxFrameMsP95 > 16.7 && (assertion.maxFrameMsReason ?? "").trim() === "") {
    throw invalidScenario(
      scenarioPath,
      `'${objectPath}.maxFrameMsP95' is ${assertion.maxFrameMsP95} ms, looser than the 16.7 ms (60 fps) budget every tier gets: set 'maxFrameMsReason' to say why, or drop maxFrameMsP95.`,
    );
  }
  // A performance assertion with no ceiling reports the numbers it measured and passes; it
  // measures without judging, which is the vacuous shape this package refuses.
  if (Object.keys(assertion).length === 0) {
    throw invalidScenario(
      scenarioPath,
      `'${objectPath}' must set at least one of maxDrawCalls, maxFrameMsP95, maxPassDrawCalls, maxPassTriangles, maxPhaseMsP95, maxTriangles, or minFps.`,
    );
  }
  return assertion;
}

export function validateParityAssertion(value: unknown, scenarioPath: string, objectPath: string): IPlaytestParityAssertion {
  const record = requireRecord(value, scenarioPath, objectPath);
  rejectUnknownKeys(record, ["minFpsRatio", "minRenderParity", "reference", "referenceReport", "referenceSide"], scenarioPath, objectPath);
  const minFpsRatio = optionalNumber(record, "minFpsRatio", scenarioPath, objectPath);
  if (minFpsRatio === undefined || minFpsRatio <= 0) {
    throw invalidScenario(scenarioPath, `'${objectPath}.minFpsRatio' must be a positive number (Tier 2's Floor is 0.85).`);
  }
  const minRenderParity = optionalNumber(record, "minRenderParity", scenarioPath, objectPath);
  if (minRenderParity !== undefined && minRenderParity <= 0) {
    throw invalidScenario(scenarioPath, `'${objectPath}.minRenderParity' must be a positive number when present.`);
  }
  const referenceReport = record.referenceReport;
  if (typeof referenceReport !== "string" || referenceReport.trim() === "") {
    throw invalidScenario(scenarioPath, `'${objectPath}.referenceReport' must name the other half's saved run report.`);
  }
  const referenceSide = record.referenceSide;
  if (referenceSide !== "browser" && referenceSide !== "native") {
    throw invalidScenario(scenarioPath, `'${objectPath}.referenceSide' must be 'browser' or 'native' — the directed native ÷ web ratio needs to know which side the reference is.`);
  }
  const reference = record.reference === undefined ? undefined : requireRecord(record.reference, scenarioPath, `${objectPath}.reference`);
  const referenceFps = reference === undefined ? undefined : optionalNumber(reference, "fps", scenarioPath, `${objectPath}.reference`);
  if (referenceFps !== undefined && referenceFps <= 0) {
    throw invalidScenario(scenarioPath, `'${objectPath}.reference.fps' must be a positive number.`);
  }
  const referenceRenderP95 = reference === undefined ? undefined : optionalNumber(reference, "renderP95", scenarioPath, `${objectPath}.reference`);
  if (referenceRenderP95 !== undefined && referenceRenderP95 <= 0) {
    throw invalidScenario(scenarioPath, `'${objectPath}.reference.renderP95' must be a positive number.`);
  }
  const referenceSerial = reference?.serial;
  if (referenceSerial !== undefined && typeof referenceSerial !== "string") {
    throw invalidScenario(scenarioPath, `'${objectPath}.reference.serial' must be a string when present.`);
  }
  const referenceThermal = reference?.thermallyConfounded;
  if (referenceThermal !== undefined && typeof referenceThermal !== "boolean") {
    throw invalidScenario(scenarioPath, `'${objectPath}.reference.thermallyConfounded' must be a boolean when present.`);
  }
  return {
    minFpsRatio,
    ...(minRenderParity === undefined ? {} : { minRenderParity }),
    referenceReport,
    referenceSide,
    ...(reference === undefined || referenceFps === undefined
      ? {}
      : {
          reference: {
            fps: referenceFps,
            ...(referenceRenderP95 === undefined ? {} : { renderP95: referenceRenderP95 }),
            ...(typeof referenceSerial === "string" ? { serial: referenceSerial } : {}),
            ...(typeof referenceThermal === "boolean" ? { thermallyConfounded: referenceThermal } : {}),
          },
        }),
  };
}

export function validateRenderChainAssertion(
  value: unknown,
  scenarioPath: string,
  objectPath: string,
): IPlaytestRenderChainAssertion {
  const record = requireRecord(value, scenarioPath, objectPath);
  const perAdapter = record.perAdapter === undefined
    ? undefined
    : validateRenderChainPerAdapter(record.perAdapter, scenarioPath, `${objectPath}.perAdapter`);
  const expectation = validateRenderChainExpectation(record, scenarioPath, objectPath);
  return perAdapter === undefined ? expectation : { ...expectation, perAdapter };
}

function validateRenderChainPerAdapter(
  value: unknown,
  scenarioPath: string,
  objectPath: string,
): NonNullable<IPlaytestRenderChainAssertion["perAdapter"]> {
  const record = requireRecord(value, scenarioPath, objectPath);
  const entries = Object.entries(record);
  if (entries.length === 0) {
    throw invalidScenario(scenarioPath, `'${objectPath}' must name at least one adapter class.`);
  }
  const result: Record<string, IPlaytestRenderChainExpectation> = {};
  for (const [kind, branch] of entries) {
    if (!(PLAYTEST_PER_ADAPTER_KEYS as readonly string[]).includes(kind)) {
      throw invalidScenario(
        scenarioPath,
        `'${objectPath}.${kind}' is not an adapter class this harness can classify; expected ${PLAYTEST_PER_ADAPTER_KEYS.join(", ")}.`,
      );
    }
    // The branch is a whole render-chain expectation, validated by the same function as the flat
    // form — so an empty or mistyped one throws here rather than evaluating to nothing at runtime.
    // A nested `perAdapter` is not accepted: one level of branch is a choice between two policies,
    // and a second level would be a decision the harness cannot make.
    result[kind] = validateRenderChainExpectation(
      requireRecord(branch, scenarioPath, `${objectPath}.${kind}`),
      scenarioPath,
      `${objectPath}.${kind}`,
    );
  }
  return result as NonNullable<IPlaytestRenderChainAssertion["perAdapter"]>;
}

function validateRenderChainExpectation(
  record: Record<string, unknown>,
  scenarioPath: string,
  objectPath: string,
): IPlaytestRenderChainExpectation {
  const tier = record.tier;
  if (tier !== undefined && tier !== "high" && tier !== "medium" && tier !== "low" && tier !== "off") {
    throw invalidScenario(scenarioPath, `'${objectPath}.tier' must be high, medium, low, or off, received ${describeValue(tier)}.`);
  }
  const stagesValue = record.stages === undefined
    ? undefined
    : requireRecord(record.stages, scenarioPath, `${objectPath}.stages`);
  const stages = stagesValue === undefined
    ? undefined
    : {
        ...(stagesValue.includes === undefined
          ? {}
          : { includes: renderChainStageIds(stagesValue, "includes", scenarioPath, `${objectPath}.stages`) }),
        ...(stagesValue.excludes === undefined
          ? {}
          : { excludes: renderChainStageIds(stagesValue, "excludes", scenarioPath, `${objectPath}.stages`) }),
        ...(stagesValue.order === undefined
          ? {}
          : { order: renderChainStageIds(stagesValue, "order", scenarioPath, `${objectPath}.stages`) }),
      };
  if (stages !== undefined && Object.keys(stages).length === 0) {
    throw invalidScenario(scenarioPath, `'${objectPath}.stages' must assert includes, excludes, or order.`);
  }
  const contributionsValue = record.contributions === undefined
    ? undefined
    : requireRecord(record.contributions, scenarioPath, `${objectPath}.contributions`);
  const contributions = contributionsValue === undefined
    ? undefined
    : {
        graphOutputChanged: renderChainStageIds(
          contributionsValue,
          "graphOutputChanged",
          scenarioPath,
          `${objectPath}.contributions`,
        ),
      };
  const velocityValue = record.velocity;
  const velocity = velocityValue === undefined
    ? undefined
    : requireRecord(velocityValue, scenarioPath, `${objectPath}.velocity`);
  if (velocity !== undefined) {
    const maxRejectionFraction = optionalNumber(velocity, "maxRejectionFraction", scenarioPath, `${objectPath}.velocity`);
    if (maxRejectionFraction === undefined || maxRejectionFraction < 0 || maxRejectionFraction > 1) {
      throw invalidScenario(scenarioPath, `'${objectPath}.velocity.maxRejectionFraction' must be a finite number between 0 and 1.`);
    }
    return {
      ...(tier === undefined ? {} : { tier }),
      ...(stages === undefined ? {} : { stages }),
      ...(contributions === undefined ? {} : { contributions }),
      velocity: { maxRejectionFraction },
    };
  }
  if (tier === undefined && stages === undefined && contributions === undefined) {
    throw invalidScenario(scenarioPath, `'${objectPath}' must assert tier, stages, contributions, or velocity.maxRejectionFraction; an empty render-chain assertion observes nothing.`);
  }
  return {
    ...(tier === undefined ? {} : { tier }),
    ...(stages === undefined ? {} : { stages }),
    ...(contributions === undefined ? {} : { contributions }),
  };
}

function renderChainStageIds(
  record: Record<string, unknown>,
  key: string,
  scenarioPath: string,
  objectPath: string,
): string[] {
  const values = requireArray(record, key, scenarioPath, objectPath);
  if (values.length === 0) {
    throw invalidScenario(scenarioPath, `'${objectPath}.${key}' must contain at least one stage id.`);
  }
  const ids = values.map((value, index) => {
    if (typeof value !== "string" || value.trim() === "") {
      throw invalidScenario(scenarioPath, `'${objectPath}.${key}[${String(index)}]' must be a non-empty stage id.`);
    }
    return value;
  });
  if (new Set(ids).size !== ids.length) {
    throw invalidScenario(scenarioPath, `'${objectPath}.${key}' must not repeat a stage id.`);
  }
  return ids;
}

const STARTUP_CEILINGS = ["maxEnteredMs", "maxCompileSettledMs", "maxReadyMs"] as const;

export function validateStartupAssertion(
  value: unknown,
  scenarioPath: string,
  objectPath: string,
): IPlaytestStartupAssertion {
  const record = requireRecord(value, scenarioPath, objectPath);
  const result: { -readonly [K in (typeof STARTUP_CEILINGS)[number]]?: number } & { maxOffscreenBytes?: number; steadyCover?: true } = {};
  for (const key of STARTUP_CEILINGS) {
    const ceiling = record[key];
    if (ceiling === undefined) continue;
    if (typeof ceiling !== "number" || !Number.isFinite(ceiling) || ceiling <= 0) {
      throw invalidScenario(scenarioPath, `'${objectPath}.${key}' must be a positive finite number of milliseconds, received ${describeValue(ceiling)}.`);
    }
    result[key] = ceiling;
  }
  const bytes = record.maxOffscreenBytes;
  if (bytes !== undefined) {
    // Zero is meaningful here ("everything awaited is in view"), so it is the one ceiling allowed to be 0.
    if (typeof bytes !== "number" || !Number.isInteger(bytes) || bytes < 0) {
      throw invalidScenario(scenarioPath, `'${objectPath}.maxOffscreenBytes' must be a non-negative integer number of bytes, received ${describeValue(bytes)}.`);
    }
    result.maxOffscreenBytes = bytes;
  }
  if (record.steadyCover !== undefined) {
    if (record.steadyCover !== true) {
      throw invalidScenario(scenarioPath, `'${objectPath}.steadyCover' must be true, received ${describeValue(record.steadyCover)}; leave it out to skip the check.`);
    }
    result.steadyCover = true;
  }
  if (Object.keys(result).length === 0) {
    throw invalidScenario(scenarioPath, `'${objectPath}' must set at least one of ${[...STARTUP_CEILINGS, "maxOffscreenBytes", "steadyCover"].join(", ")}; an empty startup assertion observes nothing.`);
  }
  return result;
}

const PIPELINE_CENSUS_CEILINGS = [
  "maxNodeBuildsAfterWarmUpSettled",
  "maxRenderPipelineCreationsAfterWarmUpSettled",
  "maxNodeBuildsAfterWarmUpScope",
  "maxRenderPipelineCreationsAfterWarmUpScope",
] as const;

export function validatePipelineCensusAssertion(
  value: unknown,
  scenarioPath: string,
  objectPath: string,
): IPlaytestPipelineCensusAssertion {
  const record = requireRecord(value, scenarioPath, objectPath);
  rejectUnknownKeys(record, [...PIPELINE_CENSUS_CEILINGS, "warmUpScope"], scenarioPath, objectPath);
  const result: Partial<IPlaytestPipelineCensusAssertion> = {};
  if (record.warmUpScope !== undefined) {
    if (typeof record.warmUpScope !== "string" || record.warmUpScope.trim() === "")
      throw invalidScenario(scenarioPath, `'${objectPath}.warmUpScope' must be a non-empty string`);
    result.warmUpScope = record.warmUpScope;
  }
  for (const key of PIPELINE_CENSUS_CEILINGS) {
    const ceiling = optionalNonNegativeInteger(record, key, scenarioPath, objectPath);
    if (ceiling !== undefined) result[key] = ceiling;
  }
  const hasScopeCeiling =
    result.maxNodeBuildsAfterWarmUpScope !== undefined ||
    result.maxRenderPipelineCreationsAfterWarmUpScope !== undefined;
  if (hasScopeCeiling && result.warmUpScope === undefined)
    throw invalidScenario(scenarioPath, `'${objectPath}.warmUpScope' is required for a scoped pipeline census ceiling`);
  if (!PIPELINE_CENSUS_CEILINGS.some((key) => result[key] !== undefined)) {
    throw invalidScenario(
      scenarioPath,
      `'${objectPath}' must set at least one of ${PIPELINE_CENSUS_CEILINGS.join(", ")}; an empty pipeline census assertion observes nothing.`,
    );
  }
  return result;
}

/** Re-exported so a scenario author and the protocol never disagree about the phase names. */
export { PLAYTEST_FRAME_BUDGET_PHASES, PLAYTEST_FRAME_PASS_KINDS };

/**
 * A per-pass budget is the same shape as a per-phase one: a non-empty map of known kinds to
 * non-negative ceilings. An unknown pass kind throws rather than evaluating no bound.
 */
function validatePassBudget(value: unknown, scenarioPath: string, objectPath: string): Readonly<Record<string, number>> | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value, scenarioPath, objectPath);
  const entries = Object.entries(record);
  if (entries.length === 0)
    throw invalidScenario(scenarioPath, `${objectPath} must name at least one render pass.`);
  const budget: Record<string, number> = {};
  for (const [pass, ceiling] of entries) {
    if (!(PLAYTEST_FRAME_PASS_KINDS as readonly string[]).includes(pass))
      throw invalidScenario(
        scenarioPath,
        `${objectPath}.${pass} is not a render pass. Expected one of: ${PLAYTEST_FRAME_PASS_KINDS.join(", ")}.`,
      );
    if (typeof ceiling !== "number" || !Number.isFinite(ceiling) || ceiling < 0)
      throw invalidScenario(scenarioPath, `${objectPath}.${pass} must be a non-negative number of draw calls or triangles.`);
    budget[pass] = ceiling;
  }
  return budget;
}

function validatePhaseBudget(value: unknown, scenarioPath: string, objectPath: string): Readonly<Record<string, number>> | undefined {
  if (value === undefined) return undefined;
  const record = requireRecord(value, scenarioPath, objectPath);
  const entries = Object.entries(record);
  if (entries.length === 0)
    throw invalidScenario(scenarioPath, `${objectPath} must name at least one frame-budget phase.`);
  const budget: Record<string, number> = {};
  for (const [phase, ceiling] of entries) {
    if (!(PLAYTEST_FRAME_BUDGET_PHASES as readonly string[]).includes(phase))
      throw invalidScenario(
        scenarioPath,
        `${objectPath}.${phase} is not a frame-budget phase. Expected one of: ${PLAYTEST_FRAME_BUDGET_PHASES.join(", ")}.`,
      );
    if (typeof ceiling !== "number" || !Number.isFinite(ceiling) || ceiling < 0)
      throw invalidScenario(scenarioPath, `${objectPath}.${phase} must be a non-negative number of milliseconds.`);
    budget[phase] = ceiling;
  }
  return budget;
}

export function validateFramebufferCoverageAssertion(
  value: unknown,
  scenarioPath: string,
  objectPath: string,
): IPlaytestFramebufferCoverageAssertion {
  const record = requireRecord(value, scenarioPath, objectPath);
  rejectUnknownKeys(record, ["backdrop", "grid", "tolerance", "window"], scenarioPath, objectPath);
  const backdrop = requireArray(record, "backdrop", scenarioPath, objectPath);
  if (backdrop.length !== 3
    || backdrop.some((channel) => typeof channel !== "number" || !Number.isInteger(channel) || channel < 0 || channel > 255)) {
    throw invalidScenario(
      scenarioPath,
      `'${objectPath}.backdrop' must be three integer RGB channels from 0 to 255.`,
    );
  }
  const tolerance = optionalNonNegativeInteger(record, "tolerance", scenarioPath, objectPath);
  if (tolerance === undefined || tolerance > 255) {
    throw invalidScenario(scenarioPath, `'${objectPath}.tolerance' must be an integer from 0 to 255.`);
  }
  const window = requireRecord(record.window, scenarioPath, `${objectPath}.window`);
  rejectUnknownKeys(window, ["endStep", "startStep"], scenarioPath, `${objectPath}.window`);
  const gridValue = record.grid;
  let grid: IPlaytestFramebufferCoverageAssertion["grid"];
  if (gridValue !== undefined) {
    const gridRecord = requireRecord(gridValue, scenarioPath, `${objectPath}.grid`);
    rejectUnknownKeys(gridRecord, ["columns", "rows"], scenarioPath, `${objectPath}.grid`);
    const columns = optionalPositiveInteger(gridRecord, "columns", scenarioPath, `${objectPath}.grid`);
    const rows = optionalPositiveInteger(gridRecord, "rows", scenarioPath, `${objectPath}.grid`);
    if (columns === undefined || rows === undefined || columns > 256 || rows > 256) {
      throw invalidScenario(
        scenarioPath,
        `'${objectPath}.grid' columns and rows must be positive integers no greater than 256.`,
      );
    }
    grid = { columns, rows };
  }
  return {
    backdrop: backdrop as [number, number, number],
    ...(grid === undefined ? {} : { grid }),
    tolerance,
    window: {
      endStep: requireString(window, "endStep", scenarioPath, `${objectPath}.window`),
      startStep: requireString(window, "startStep", scenarioPath, `${objectPath}.window`),
    },
  };
}

export function validateStateAssertion(value: unknown, scenarioPath: string, objectPath: string): IPlaytestStateAssertion {
  const record = requireRecord(value, scenarioPath, objectPath);
  rejectUnknownKeys(record, ["allowTrivial", "entity", "equals"], scenarioPath, objectPath);
  return {
    ...present("allowTrivial", optionalTrivialityReason(record, "allowTrivial", scenarioPath, objectPath)),
    ...present("entity", optionalString(record, "entity", scenarioPath, objectPath)),
    equals: requireString(record, "equals", scenarioPath, objectPath),
  };
}

export function validateTagCountAssertion(value: unknown, scenarioPath: string, objectPath: string): IPlaytestTagCountAssertion {
  const record = requireRecord(value, scenarioPath, objectPath);
  rejectUnknownKeys(record, ["allowTrivial", "count", ...NUMERIC_COMPARISON_KEYS, "tag"], scenarioPath, objectPath);
  const count = optionalNonNegativeInteger(record, "count", scenarioPath, objectPath);
  const gte = optionalNonNegativeInteger(record, "gte", scenarioPath, objectPath);
  const lte = optionalNonNegativeInteger(record, "lte", scenarioPath, objectPath);
  // Without a bound the evaluator degrades to "a numeric count exists", which is
  // satisfied by a count of zero — the opposite of what `tags: [{ tag: "coin" }]`
  // was written to prove. Reject it at load time, where the author sees it.
  if (count === undefined && gte === undefined && lte === undefined) {
    throw invalidScenario(
      scenarioPath,
      `'${objectPath}' must declare 'count', 'gte', or 'lte'; a tag assertion with none passes on a count of zero.`,
    );
  }
  return {
    ...present("allowTrivial", optionalTrivialityReason(record, "allowTrivial", scenarioPath, objectPath)),
    ...present("count", count),
    ...present("gte", gte),
    ...present("lte", lte),
    tag: requireString(record, "tag", scenarioPath, objectPath),
  };
}

export function validateContactAssertion(value: unknown, scenarioPath: string, objectPath: string): IPlaytestContactAssertion {
  const record = requireRecord(value, scenarioPath, objectPath);
  // A non-record entry used to be filtered out of the array and a typo'd
  // requiredOn target was silently dropped, widening the assertion to every
  // target. Both must fail at load.
  return {
    ...present("atStep", optionalString(record, "atStep", scenarioPath, objectPath)),
    ...present("entity", optionalString(record, "entity", scenarioPath, objectPath)),
    ...present("kind", optionalString(record, "kind", scenarioPath, objectPath)),
    ...present("maxCount", optionalNonNegativeInteger(record, "maxCount", scenarioPath, objectPath)),
    ...present("minCount", optionalNumber(record, "minCount", scenarioPath, objectPath)),
    ...present("requiredOn", optionalTargetArray(record, "requiredOn", scenarioPath, objectPath)),
    ...present("with", optionalString(record, "with", scenarioPath, objectPath)),
  };
}

export function validateSignalAssertion(value: unknown, scenarioPath: string, objectPath: string): IPlaytestSignalAssertion {
  const record = requireRecord(value, scenarioPath, objectPath);
  rejectUnknownKeys(record, ["atStep", "entity", "maxCount", "minCount", "name"], scenarioPath, objectPath);
  return {
    ...present("atStep", optionalString(record, "atStep", scenarioPath, objectPath)),
    ...present("entity", optionalString(record, "entity", scenarioPath, objectPath)),
    ...present("maxCount", optionalNonNegativeInteger(record, "maxCount", scenarioPath, objectPath)),
    ...present("minCount", optionalNonNegativeInteger(record, "minCount", scenarioPath, objectPath)),
    name: requireString(record, "name", scenarioPath, objectPath),
  };
}

const SCENE_FLAGS = ["cameraClearsScene", "fogClearsScene", "litMaterialsAreLit"] as const;

export function validateSceneAssertion(
  value: unknown,
  scenarioPath: string,
  objectPath: string,
): IPlaytestSceneAssertion {
  const record = requireRecord(value, scenarioPath, objectPath);
  rejectUnknownKeys(record, ["allowTrivial", ...SCENE_FLAGS, "minVisibleLights"], scenarioPath, objectPath);
  const result: IPlaytestSceneAssertion = {
    ...present("allowTrivial", optionalTrivialityReason(record, "allowTrivial", scenarioPath, objectPath)),
    ...present("cameraClearsScene", optionalBoolean(record, "cameraClearsScene", scenarioPath, objectPath)),
    ...present("fogClearsScene", optionalBoolean(record, "fogClearsScene", scenarioPath, objectPath)),
    ...present("litMaterialsAreLit", optionalBoolean(record, "litMaterialsAreLit", scenarioPath, objectPath)),
    ...present("minVisibleLights", optionalNonNegativeInteger(record, "minVisibleLights", scenarioPath, objectPath)),
  };
  // An assertion that bounds nothing is the vacuous pass this package exists to refuse.
  if (SCENE_FLAGS.every((flag) => result[flag] === undefined) && result.minVisibleLights === undefined) {
    throw invalidScenario(
      scenarioPath,
      `'${objectPath}' must set at least one of ${[...SCENE_FLAGS, "minVisibleLights"].join(", ")}; an empty scene assertion observes nothing.`,
    );
  }
  // The evaluator reads each flag as `=== true`, and a floor of zero visible lights is satisfied
  // by an unlit scene. Both spellings would pass whatever the run reported.
  for (const flag of SCENE_FLAGS) {
    if (result[flag] === false) {
      throw invalidScenario(
        scenarioPath,
        `${objectPath}.${flag} may only be true; remove the key to stop requiring it.`,
      );
    }
  }
  if (result.minVisibleLights === 0) {
    throw invalidScenario(
      scenarioPath,
      `${objectPath}.minVisibleLights must be at least 1; a floor of zero is met by an unlit scene.`,
    );
  }
  return result;
}

const SCENE_NODE_SELECTOR_KEYS = ["limit", "name", "nameContains", "pathContains", "type"] as const;
const SCENE_NODE_BOUNDS = ["animated", "inFrustum", "maxCount", "minCount", "minTriangles", "texturesLoaded", "visible"] as const;

function validateEffectSpec(value: unknown, scenarioPath: string, objectPath: string): IPlaytestEffectSpec {
  const record = requireRecord(value, scenarioPath, objectPath);
  rejectUnknownKeys(record, ["becomes", "path"], scenarioPath, objectPath);
  const becomes = record.becomes;
  if (typeof becomes !== "string" && typeof becomes !== "number" && typeof becomes !== "boolean")
    throw invalidScenario(
      scenarioPath,
      `'${objectPath}.becomes' must be a string, number or boolean; ${describeValue(becomes)} names no value a transition can reach.`,
    );
  if (typeof becomes === "number" && !Number.isFinite(becomes))
    throw invalidScenario(scenarioPath, `'${objectPath}.becomes' must be a finite number.`);
  return { becomes, path: requireString(record, "path", scenarioPath, objectPath) };
}

function validateCauseSpec(value: unknown, scenarioPath: string, objectPath: string): IPlaytestCauseSpec {
  const record = requireRecord(value, scenarioPath, objectPath);
  rejectUnknownKeys(record, ["contact", "transition"], scenarioPath, objectPath);
  const hasContact = hasKey(record, "contact");
  const hasTransition = hasKey(record, "transition");
  // Exactly one: two causes in one row would silently make the earlier of them the cause, and a
  // row with none names nothing that could have caused anything.
  if (hasContact === hasTransition)
    throw invalidScenario(
      scenarioPath,
      `'${objectPath}' must set exactly one of contact, transition.`,
    );
  if (hasTransition)
    return { transition: validateEffectSpec(record.transition, scenarioPath, `${objectPath}.transition`) };
  const contact = requireRecord(record.contact, scenarioPath, `${objectPath}.contact`);
  rejectUnknownKeys(contact, ["entity", "kind", "with"], scenarioPath, `${objectPath}.contact`);
  return {
    contact: {
      entity: requireString(contact, "entity", scenarioPath, `${objectPath}.contact`),
      ...present("kind", optionalString(contact, "kind", scenarioPath, `${objectPath}.contact`)),
      with: requireString(contact, "with", scenarioPath, `${objectPath}.contact`),
    },
  };
}

export function validateCausedByAssertion(
  value: unknown,
  scenarioPath: string,
  objectPath: string,
): IPlaytestCausedByAssertion {
  const record = requireRecord(value, scenarioPath, objectPath);
  rejectUnknownKeys(record, ["allowTrivial", "cause", "effect", "neverBefore", "withinTicks"], scenarioPath, objectPath);
  if (!hasKey(record, "cause") || !hasKey(record, "effect"))
    throw invalidScenario(scenarioPath, `'${objectPath}' must set both 'cause' and 'effect'.`);
  const result: IPlaytestCausedByAssertion = {
    ...present("allowTrivial", optionalTrivialityReason(record, "allowTrivial", scenarioPath, objectPath)),
    cause: validateCauseSpec(record.cause, scenarioPath, `${objectPath}.cause`),
    effect: validateEffectSpec(record.effect, scenarioPath, `${objectPath}.effect`),
    ...present("neverBefore", optionalBoolean(record, "neverBefore", scenarioPath, objectPath)),
    ...present("withinTicks", optionalNonNegativeInteger(record, "withinTicks", scenarioPath, objectPath)),
  };
  // Ordering alone is what `atSteps` already does. A causedBy row that bounds neither the window
  // nor the "never before" case asserts only that both things happened at some point, which is
  // two assertions pretending to be one.
  if (result.neverBefore === undefined && result.withinTicks === undefined)
    throw invalidScenario(
      scenarioPath,
      `'${objectPath}' must set neverBefore or withinTicks; without one it asserts only that both events happened, which assert.states and assert.contacts already do separately.`,
    );
  // Only the evaluator's `neverBefore === true` branch checks anything, so `false` would satisfy
  // the same guard as omitting it.
  if (result.neverBefore === false)
    throw invalidScenario(
      scenarioPath,
      `${objectPath}.neverBefore may only be true; remove the key and set withinTicks to keep the row.`,
    );
  return result;
}

export function validateSceneNodeSelector(
  value: unknown,
  scenarioPath: string,
  objectPath: string,
): IPlaytestSceneNodeSelectorSpec {
  const record = requireRecord(value, scenarioPath, objectPath);
  rejectUnknownKeys(record, [...SCENE_NODE_SELECTOR_KEYS], scenarioPath, objectPath);
  const result: IPlaytestSceneNodeSelectorSpec = {
    ...present("limit", optionalPositiveInteger(record, "limit", scenarioPath, objectPath)),
    ...present("name", optionalString(record, "name", scenarioPath, objectPath)),
    ...present("nameContains", optionalString(record, "nameContains", scenarioPath, objectPath)),
    ...present("pathContains", optionalString(record, "pathContains", scenarioPath, objectPath)),
    ...present("type", optionalString(record, "type", scenarioPath, objectPath)),
  };
  // A selector with no filter selects every node in the scene, which bounds nothing in
  // particular and reads as a pass over whatever happened to be mounted.
  if (result.name === undefined && result.nameContains === undefined && result.pathContains === undefined && result.type === undefined)
    throw invalidScenario(
      scenarioPath,
      `'${objectPath}' must set at least one of name, nameContains, pathContains, type; a selector that filters nothing selects the whole scene.`,
    );
  return result;
}

export function validateSceneNodesAssertion(
  value: unknown,
  scenarioPath: string,
  objectPath: string,
): IPlaytestSceneNodesAssertion {
  const record = requireRecord(value, scenarioPath, objectPath);
  rejectUnknownKeys(record, ["allowTrivial", "select", ...SCENE_NODE_BOUNDS], scenarioPath, objectPath);
  if (!hasKey(record, "select"))
    throw invalidScenario(scenarioPath, `'${objectPath}' must set 'select'; an assertion with no selector observes nothing.`);
  const result: IPlaytestSceneNodesAssertion = {
    ...present("allowTrivial", optionalTrivialityReason(record, "allowTrivial", scenarioPath, objectPath)),
    ...present("animated", optionalBoolean(record, "animated", scenarioPath, objectPath)),
    ...present("inFrustum", optionalBoolean(record, "inFrustum", scenarioPath, objectPath)),
    ...present("maxCount", optionalNonNegativeInteger(record, "maxCount", scenarioPath, objectPath)),
    ...present("minCount", optionalNonNegativeInteger(record, "minCount", scenarioPath, objectPath)),
    ...present("minTriangles", optionalNonNegativeInteger(record, "minTriangles", scenarioPath, objectPath)),
    select: validateSceneNodeSelector(record.select, scenarioPath, `${objectPath}.select`),
    ...present("texturesLoaded", optionalBoolean(record, "texturesLoaded", scenarioPath, objectPath)),
    ...present("visible", optionalBoolean(record, "visible", scenarioPath, objectPath)),
  };
  if (result.minCount !== undefined && result.maxCount !== undefined && result.minCount > result.maxCount)
    throw invalidScenario(
      scenarioPath,
      `'${objectPath}' sets minCount ${result.minCount} above maxCount ${result.maxCount}; no run can satisfy it.`,
    );
  // Selecting nodes and bounding nothing about them is the vacuous pass this package refuses.
  if (SCENE_NODE_BOUNDS.every((bound) => result[bound] === undefined))
    throw invalidScenario(
      scenarioPath,
      `'${objectPath}' must set at least one of ${SCENE_NODE_BOUNDS.join(", ")}; selecting nodes without bounding them observes nothing.`,
    );
  // Only the evaluator's `texturesLoaded === true` branch checks anything, so `false` is the
  // same assertion as omitting it.
  if (result.texturesLoaded === false)
    throw invalidScenario(
      scenarioPath,
      `${objectPath}.texturesLoaded may only be true; remove the key to stop requiring loaded textures.`,
    );
  return result;
}

export function validateFootSlipAssertion(value: unknown, scenarioPath: string, objectPath: string): IPlaytestFootSlipAssertion {
  const record = requireRecord(value, scenarioPath, objectPath);
  rejectUnknownKeys(record, ["atStep", "entity", "feet", "maxSlideSpeed", "maxSlip", "stepSeconds"], scenarioPath, objectPath);
  const feet = record.feet;
  if (!Array.isArray(feet) || feet.length === 0 || feet.some((foot) => typeof foot !== "string" || foot.trim() === "")
    || new Set(feet).size !== feet.length)
    throw invalidScenario(scenarioPath, `${objectPath}.feet must be a non-empty array of unique node names; got ${describeValue(feet)}.`);
  const maxSlip = optionalPositiveNumber(record, "maxSlip", scenarioPath, objectPath);
  const maxSlideSpeed = optionalPositiveNumber(record, "maxSlideSpeed", scenarioPath, objectPath);
  if (maxSlip === undefined && maxSlideSpeed === undefined)
    throw invalidScenario(scenarioPath, `${objectPath}.maxSlip or ${objectPath}.maxSlideSpeed is required; a slip measure with no ceiling bounds nothing.`);
  return {
    atStep: requireString(record, "atStep", scenarioPath, objectPath),
    ...present("entity", optionalString(record, "entity", scenarioPath, objectPath)),
    feet: feet as string[],
    ...present("maxSlideSpeed", maxSlideSpeed),
    ...present("maxSlip", maxSlip),
    ...present("stepSeconds", optionalPositiveNumber(record, "stepSeconds", scenarioPath, objectPath)),
  };
}

export function validateSightLineAssertion(value: unknown, scenarioPath: string, objectPath: string): IPlaytestSightLineAssertion {
  const record = requireRecord(value, scenarioPath, objectPath);
  rejectUnknownKeys(record, ["entity", "maxBlockedRatio"], scenarioPath, objectPath);
  const maxBlockedRatio = optionalRatio(record, "maxBlockedRatio", scenarioPath, objectPath);
  if (maxBlockedRatio === undefined) throw invalidScenario(scenarioPath, `${objectPath}.maxBlockedRatio is required; a sight line with no allowed blocked share bounds nothing.`);
  return {
    ...present("entity", optionalString(record, "entity", scenarioPath, objectPath)),
    maxBlockedRatio,
  };
}

export function validateHudAuditAssertion(value: unknown, scenarioPath: string, objectPath: string): IPlaytestHudAuditAssertion {
  const record = requireRecord(value, scenarioPath, objectPath);
  rejectUnknownKeys(record, ["minContrast", "noDebugText"], scenarioPath, objectPath);
  const noDebugText = optionalBoolean(record, "noDebugText", scenarioPath, objectPath);
  if (noDebugText === false) {
    throw invalidScenario(scenarioPath, `'${objectPath}.noDebugText' may only be true; remove the key to stop scanning for developer text.`);
  }
  const minContrast = optionalNumber(record, "minContrast", scenarioPath, objectPath);
  if (minContrast !== undefined && (minContrast < 1 || minContrast > 21)) {
    throw invalidScenario(scenarioPath, `'${objectPath}.minContrast' must be between 1 and 21, received ${describeValue(minContrast)}.`);
  }
  if (noDebugText === undefined && minContrast === undefined) {
    throw invalidScenario(scenarioPath, `${objectPath} must declare at least one of 'minContrast' or 'noDebugText'.`);
  }
  return {
    ...present("minContrast", minContrast),
    ...(noDebugText === undefined ? {} : { noDebugText: true }),
  };
}

export function validateAnimationAssertion(value: unknown, scenarioPath: string, objectPath: string): IPlaytestAnimationAssertion {
  const record = requireRecord(value, scenarioPath, objectPath);
  rejectUnknownKeys(record, ["advancedFrames", "allowTrivial", "atStep", "clip", "entered", "entity", "finished", "maxFootSlide", "strideSynced"], scenarioPath, objectPath);
  return {
    ...present("advancedFrames", optionalNumber(record, "advancedFrames", scenarioPath, objectPath)),
    ...present("allowTrivial", optionalTrivialityReason(record, "allowTrivial", scenarioPath, objectPath)),
    ...present("atStep", optionalString(record, "atStep", scenarioPath, objectPath)),
    ...present("clip", optionalString(record, "clip", scenarioPath, objectPath)),
    ...present("entered", optionalBoolean(record, "entered", scenarioPath, objectPath)),
    ...present("entity", optionalString(record, "entity", scenarioPath, objectPath)),
    ...present("finished", optionalBoolean(record, "finished", scenarioPath, objectPath)),
    ...present("maxFootSlide", optionalNonNegativeNumber(record, "maxFootSlide", scenarioPath, objectPath)),
    ...present("strideSynced", optionalBoolean(record, "strideSynced", scenarioPath, objectPath)),
  };
}

export function validateVisibilityAssertion(value: unknown, scenarioPath: string, objectPath: string): IPlaytestVisibilityAssertion {
  const record = requireRecord(value, scenarioPath, objectPath);
  rejectUnknownKeys(record, ["allowTrivial", "entity", "maxOffscreenRatio", "minProjectedPixels", "present"], scenarioPath, objectPath);
  return {
    ...present("allowTrivial", optionalTrivialityReason(record, "allowTrivial", scenarioPath, objectPath)),
    ...present("entity", optionalString(record, "entity", scenarioPath, objectPath)),
    ...present("maxOffscreenRatio", optionalRatio(record, "maxOffscreenRatio", scenarioPath, objectPath)),
    ...present("minProjectedPixels", optionalNonNegativeNumber(record, "minProjectedPixels", scenarioPath, objectPath)),
    ...present("present", optionalBoolean(record, "present", scenarioPath, objectPath)),
  };
}

export function validatePathAssertion(value: unknown, scenarioPath: string, objectPath: string): IPlaytestPathAssertion {
  const record = requireRecord(value, scenarioPath, objectPath);
  // An entry without an id used to be filtered out of the array and a wrong-typed
  // atSteps entry dropped from the labeled series, so the assertion silently
  // evaluated fewer samples than the author declared.
  const gte = optionalNumber(record, "gte", scenarioPath, objectPath);
  const lte = optionalNumber(record, "lte", scenarioPath, objectPath);
  if (record.atSteps !== undefined && (!Array.isArray(record.atSteps) || record.atSteps.length === 0)) {
    throw invalidScenario(scenarioPath, `'${objectPath}.atSteps' must be a non-empty array of expected labeled-step values; an empty one asserts nothing.`);
  }
  // An entry with no `equals` and no `textIncludes` passes on the sample merely existing, and an
  // empty array is skipped by the evaluator's `(length ?? 0) > 0` guard.
  const atSteps = Array.isArray(record.atSteps)
    ? record.atSteps.map((step, index) => {
      const stepPath = `${objectPath}.atSteps[${index}]`;
      const entry = requireRecord(step, scenarioPath, stepPath);
      const stepLte = optionalNumber(entry, "lte", scenarioPath, stepPath);
      if (!hasKey(entry, "equals") && entry.textIncludes === undefined && stepLte === undefined) {
        throw invalidScenario(scenarioPath, `'${stepPath}' must set equals, lte or textIncludes; a labeled step with no expectation passes on any value.`);
      }
      return {
        ...(hasKey(entry, "equals") ? { equals: entry.equals } : {}),
        label: requireString(entry, "label", scenarioPath, stepPath),
        ...present("lte", stepLte),
        ...present("textIncludes", optionalString(entry, "textIncludes", scenarioPath, stepPath)),
      };
    })
    : undefined;
  return {
    ...(atSteps === undefined ? {} : { atSteps }),
    ...present("changed", optionalBoolean(record, "changed", scenarioPath, objectPath)),
    ...present("allowTrivial", optionalTrivialityReason(record, "allowTrivial", scenarioPath, objectPath)),
    ...(hasKey(record, "equals") ? { equals: record.equals } : {}),
    ...present("gte", gte),
    id: requireString(record, "id", scenarioPath, objectPath),
    ...present("lte", lte),
    ...present("path", optionalString(record, "path", scenarioPath, objectPath)),
    ...present("textIncludes", optionalString(record, "textIncludes", scenarioPath, objectPath)),
    ...present("throughoutSteps", optionalBoolean(record, "throughoutSteps", scenarioPath, objectPath)),
    ...present("visible", optionalBoolean(record, "visible", scenarioPath, objectPath)),
  };
}

export function validateResourcePathAssertion(value: unknown, scenarioPath: string, objectPath: string): IPlaytestResourceAssertion {
  const record = requireRecord(value, scenarioPath, objectPath);
  if (hasKey(record, "anyOf")) {
    rejectUnknownKeys(record, ["anyOf", "id"], scenarioPath, objectPath);
    const alternatives = requireArray(record, "anyOf", scenarioPath, objectPath);
    if (alternatives.length === 0) {
      throw invalidScenario(scenarioPath, `'${objectPath}.anyOf' must contain at least one path assertion.`);
    }
    return {
      anyOf: alternatives.map((alternative, index) => validateResourcePathAlternative(
        alternative,
        scenarioPath,
        `${objectPath}.anyOf[${index}]`,
      )),
      id: requireString(record, "id", scenarioPath, objectPath),
    };
  }
  const assertion = validatePathAssertion(record, scenarioPath, objectPath);
  if (assertion === undefined) {
    throw invalidScenario(scenarioPath, `'${objectPath}' must name a resource id.`);
  }
  return assertion;
}

export function validateResourcePathAlternative(
  value: unknown,
  scenarioPath: string,
  objectPath: string,
): IPlaytestResourcePathAlternative {
  const record = requireRecord(value, scenarioPath, objectPath);
  rejectUnknownKeys(record, ["changed", "equals", ...NUMERIC_COMPARISON_KEYS, "path", "textIncludes"], scenarioPath, objectPath);
  const changed = optionalBoolean(record, "changed", scenarioPath, objectPath);
  const gte = optionalNumber(record, "gte", scenarioPath, objectPath);
  const lte = optionalNumber(record, "lte", scenarioPath, objectPath);
  const textIncludes = optionalString(record, "textIncludes", scenarioPath, objectPath);
  if (!hasKey(record, "equals") && changed === undefined && gte === undefined && lte === undefined && textIncludes === undefined) {
    throw invalidScenario(scenarioPath, `'${objectPath}' must declare equals, gte, lte, textIncludes, or changed.`);
  }
  return {
    ...present("changed", changed),
    ...(hasKey(record, "equals") ? { equals: record.equals } : {}),
    ...present("gte", gte),
    ...present("lte", lte),
    path: requireString(record, "path", scenarioPath, objectPath),
    ...present("textIncludes", textIncludes),
  };
}

export function validateViewport(value: unknown, scenarioPath = "scenario"): IPlaytestViewport {
  if (value === undefined) {
    return { height: 720, width: 1280 };
  }
  const record = requireRecord(value, scenarioPath, "viewport");
  rejectUnknownKeys(record, ["height", "width"], scenarioPath, "viewport");
  const width = positiveInteger(record.width);
  if (width === undefined) {
    throw invalidScenario(scenarioPath, `'viewport.width' must be a positive integer, received ${describeValue(record.width)}.`);
  }
  const height = positiveInteger(record.height);
  if (height === undefined) {
    throw invalidScenario(scenarioPath, `'viewport.height' must be a positive integer, received ${describeValue(record.height)}.`);
  }
  return { height, width };
}



export function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

export function validateOptionalNumberTuple(value: Record<string, unknown>, key: "position" | "scale", length: 3, scenarioPath: string, index: number): [number, number, number] | undefined;
export function validateOptionalNumberTuple(value: Record<string, unknown>, key: "rotation", length: 4, scenarioPath: string, index: number): [number, number, number, number] | undefined;
export function validateOptionalNumberTuple(
  value: Record<string, unknown>,
  key: "position" | "rotation" | "scale",
  length: 3 | 4,
  scenarioPath: string,
  index: number,
): [number, number, number] | [number, number, number, number] | undefined {
  if (!hasKey(value, key)) {
    return undefined;
  }
  const tuple = length === 3 ? validateNumberTuple(value[key], 3) : validateNumberTuple(value[key], 4);
  if (tuple === undefined) {
    throw invalidScenario(scenarioPath, `Scenario setup.entities[${index}].${key} must be a ${length}-number tuple.`);
  }
  return tuple;
}

export function validateNumberTuple(value: unknown, length: 3): [number, number, number] | undefined;
export function validateNumberTuple(value: unknown, length: 4): [number, number, number, number] | undefined;
export function validateNumberTuple(value: unknown, length: 3 | 4): [number, number, number] | [number, number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== length || !value.every((item) => typeof item === "number" && Number.isFinite(item))) {
    return undefined;
  }
  return value as [number, number, number] | [number, number, number, number];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function hasKey(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

// CHARTER.md §8, the per-key variant. The registry owns the accepted top-level
// field shape; scripts/generate-assertion-validators.ts turns that registry into
// the executable predicates below. Composite validators still enforce their
// nested semantics after this fail-closed type gate.
export function rejectWrongTypedFields(
  kind: string,
  fields: readonly { name: string; type: string }[],
  value: Record<string, unknown>,
  scenarioPath: string,
  objectPath: string,
): void {
  const validators = GENERATED_ASSERTION_FIELD_VALIDATORS[kind];
  if (validators === undefined) {
    throw new Error(`Generated assertion validators are missing registry kind '${kind}'.`);
  }
  for (const field of fields) {
    if (value[field.name] === undefined) continue;
    const check = validators[field.name];
    if (check === undefined) {
      throw new Error(`Generated assertion validator is missing '${kind}.${field.name}'.`);
    }
    if (!check(value[field.name])) {
      const expectedType = field.type === "triviality reason"
        ? `a string with at least ${MIN_TRIVIALITY_REASON_LENGTH} non-whitespace characters`
        : field.type;
      throw invalidScenario(
        scenarioPath,
        `'${objectPath}.${field.name}' must be ${expectedType}, received ${describeValue(value[field.name])}.`,
      );
    }
  }
}


export function validateAssertionKeys(value: Record<string, unknown>, scenarioPath: string): void {
  for (const entry of PLAYTEST_ASSERTION_REGISTRY) {
    const assertionValue = value[entry.kind];
    if (assertionValue === undefined) {
      continue;
    }
    const items = Array.isArray(assertionValue) ? assertionValue : [assertionValue];
    items.forEach((item, index) => {
      if (!isRecord(item)) {
        return;
      }
      const suffix = Array.isArray(assertionValue) ? `[${index}]` : "";
      rejectUnknownKeys(item, entry.fields.map((field) => field.name), scenarioPath, `assert.${entry.kind}${suffix}`);
      const pathAssertionWithId = (entry.kind === "hud" || entry.kind === "resources") && typeof item.id === "string";
      const fields = pathAssertionWithId
        ? entry.fields.filter((field) => !NUMERIC_COMPARISON_KEYS.includes(field.name as (typeof NUMERIC_COMPARISON_KEYS)[number]))
        : entry.fields;
      rejectWrongTypedFields(entry.kind, fields, item, scenarioPath, `assert.${entry.kind}${suffix}`);
      validateNestedAssertionKeys(entry.kind, item, scenarioPath, suffix);
    });
  }
}

export function validateNestedAssertionKeys(
  kind: keyof IPlaytestScenarioAssertions,
  value: Record<string, unknown>,
  scenarioPath: string,
  suffix: string,
): void {
  if (kind === "movement") {
    for (const field of ["minAxisDelta", "minResolvedAxisDelta"] as const) {
      if (isRecord(value[field])) {
        rejectUnknownKeys(value[field], ["axis", "min"], scenarioPath, `assert.${kind}${suffix}.${field}`);
      }
    }
  }
  if (kind === "resources" || kind === "hud" || kind === "components") {
    if (kind === "resources" && hasKey(value, "anyOf")) {
      rejectUnknownKeys(value, ["anyOf", "id"], scenarioPath, `assert.${kind}${suffix}`);
      return;
    }
    if (Array.isArray(value.atSteps)) {
      value.atSteps.forEach((step, index) => {
        if (isRecord(step)) {
          rejectUnknownKeys(step, kind === "components" ? ["equals", "label"] : ["equals", "label", "lte", "textIncludes"], scenarioPath, `assert.${kind}${suffix}.atSteps[${index}]`);
        }
      });
    }
  }
  if (kind === "visual") {
    const fields = {
      entityVisible: ["entity", "minProjectedPixels", "throughoutFrames"],
      frameDiff: ["baselineImage", "maxChangedPixelRatio", "minChangedPixelRatio"],
      region: ["element", "height", "maxDarkPixelRatio", "maxLuminance", "minDarkPixelRatio", "minNonblankPixelRatio", "minSharpness", "width", "x", "y"],
    } as const;
    for (const [field, keys] of Object.entries(fields)) {
      if (isRecord(value[field])) {
        if (field === "region" && isRecord(value[field].element)) {
          rejectUnknownKeys(value[field].element, ["id", "selector"], scenarioPath, `assert.${kind}${suffix}.${field}.element`);
        }
        rejectUnknownKeys(value[field], keys, scenarioPath, `assert.${kind}${suffix}.${field}`);
      }
    }
  }
  if (kind === "aerodynamics") {
    const arrays = {
      controls: ["minAbs", "sign", "surface"],
      torques: ["axis", "label", "minAbs", "relativeToLabel", "sign"],
    } as const;
    for (const [field, keys] of Object.entries(arrays)) {
      const entries = value[field];
      if (Array.isArray(entries)) {
        entries.forEach((item, index) => {
          if (isRecord(item)) {
            rejectUnknownKeys(item, keys, scenarioPath, `assert.${kind}${suffix}.${field}[${index}]`);
          }
        });
      }
    }
  }
  if (kind === "world" && isRecord(value.runtime)) {
    rejectUnknownKeys(
      value.runtime,
      ["agent", "core", "portable", "randomState", "rapier", "step"],
      scenarioPath,
      `assert.${kind}${suffix}.runtime`,
    );
  }
  if (kind === "renderChain") {
    rejectRenderChainExpectationKeys(value, scenarioPath, `assert.${kind}${suffix}`);
    if (isRecord(value.perAdapter)) {
      const branchPath = `assert.renderChain${suffix}.perAdapter`;
      rejectUnknownKeys(value.perAdapter, [...PLAYTEST_PER_ADAPTER_KEYS], scenarioPath, branchPath);
      for (const [adapterKind, branch] of Object.entries(value.perAdapter)) {
        // A branch is the same shape as the flat assertion, so it runs the same key check at both
        // levels — and `perAdapter` is not one of its keys, which is what makes a second level a
        // load error. Without the nested pass, `perAdapter.software.stages.includess` validated
        // where the flat `stages.includess` was rejected: a typo named no stage while reading as
        // an assertion that did.
        if (isRecord(branch)) {
          rejectUnknownKeys(branch, ["contributions", "stages", "tier", "velocity"], scenarioPath, `${branchPath}.${adapterKind}`);
          rejectRenderChainExpectationKeys(branch, scenarioPath, `${branchPath}.${adapterKind}`);
        }
      }
    }
  }
}

const RENDER_CHAIN_NESTED_KEYS = {
  contributions: ["graphOutputChanged"],
  stages: ["excludes", "includes", "order"],
  velocity: ["maxRejectionFraction"],
} as const;

/** The nested `stages` / `contributions` / `velocity` of one expectation, flat form or branch. */
function rejectRenderChainExpectationKeys(
  value: Record<string, unknown>,
  scenarioPath: string,
  objectPath: string,
): void {
  for (const [field, keys] of Object.entries(RENDER_CHAIN_NESTED_KEYS)) {
    if (isRecord(value[field])) {
      rejectUnknownKeys(value[field], keys, scenarioPath, `${objectPath}.${field}`);
    }
  }
}
