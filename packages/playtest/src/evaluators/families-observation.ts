import type { IPlaytestAnimationAssertion, IPlaytestAudioAssertion, IPlaytestComponentAssertion, IPlaytestContactAssertion, IPlaytestPathAssertion, IPlaytestResourceAnyOfAssertion, IPlaytestScenario, IPlaytestSignalAssertion, IPlaytestStateAssertion, IPlaytestTagCountAssertion, IPlaytestVisibilityAssertion, IPlaytestWorldAssertion, IPlaytestPerformanceAssertion } from "../scenario.js";
import type { IPlaytestReport, IPlaytestDiagnosticsPolicy } from "../report.js";
import type { IPlaytestRuntimeDiagnosticsSample } from "../protocol.js";
import { physicsDebugContactEvidence } from "./measures.js";
import type { IContactEvidence } from "./measures.js";
// Extracted verbatim from assertion-evaluators.ts (PRD-182 Phase 2); do not edit semantics here.
import { PLAYTEST_ASSERTION_REGISTRY } from "../assertion-schema.js";
import {
  type IPlaytestAssertionResult,
  type IPlaytestDiagnostic,
  type IPlaytestFramebufferCoverageObservation,
  type IPlaytestObservations,
  type MovementAxis,
  type Vec3,
  axisIndex,
  componentAssertionDiagnostic,
  consoleErrors,
  expectedPathAssertion,
  finiteVector,
  isRecord,
  jsonEqual,
  parseMovementAxisExpectation,
  pathAssertionDiagnostic,
  readPath,
  readRotation,
  readVec3,
  record,
  resolveDiagnosticsPolicy,
  sourcePathForSystem,
  runtimeDiagnostics,
  runtimeDiagnosticsSnapshot,
  textValue,
  trivialAssertionDiagnostic,
  vectorDistance,
} from "../assertion-report.js";

export function evaluateTagCountAssertion(
  assertion: IPlaytestTagCountAssertion,
  observations: unknown,
): { assertion: IPlaytestAssertionResult; diagnostic?: IPlaytestDiagnostic } {
  const gameplay = gameplayObservations(observations);
  const count = tagCount(gameplay, assertion.tag);
  const comparisonPass = count !== undefined
    && (assertion.count === undefined || count === assertion.count)
    && (assertion.gte === undefined || count >= assertion.gte)
    && (assertion.lte === undefined || count <= assertion.lte);
  const initialCount = tagCount(runtimeGameplayBefore(observations), assertion.tag);
  const initialPass = initialCount !== undefined
    && (assertion.count === undefined || initialCount === assertion.count)
    && (assertion.gte === undefined || initialCount >= assertion.gte)
    && (assertion.lte === undefined || initialCount <= assertion.lte);
  const trivial = comparisonPass && initialPass;
  const pass = comparisonPass && (!trivial || typeof assertion.allowTrivial === "string");
  const result = {
    details: {
      count: count ?? null,
      expected: assertion,
      initialCount: initialCount ?? null,
      initialPass,
      tag: assertion.tag,
      trivial,
      ...(trivial && typeof assertion.allowTrivial === "string" ? { trivialityOptOut: true } : {}),
    },
    id: `tags.${assertion.tag}`,
    pass,
  };
  return pass
    ? { assertion: result }
    : {
        assertion: result,
        diagnostic: {
          code: trivial && typeof assertion.allowTrivial !== "string"
            ? "TN_PLAYTEST_ASSERTION_TRIVIAL"
            : "TN_PLAYTEST_TAG_COUNT_ASSERTION_FAILED",
          message: trivial && typeof assertion.allowTrivial !== "string"
            ? `Assertion 'tags.${assertion.tag}' was already satisfied before the scenario ran.`
            : `Tag '${assertion.tag}' count ${count === undefined ? "was unavailable" : count} did not satisfy the expected count.`,
          severity: "error",
          suggestion: trivial && typeof assertion.allowTrivial !== "string"
            ? "Drive the asserted tag count from a different initial count, or provide allowTrivial with the reason the count is intentionally held."
            : "Ensure the runtime entity tags are authored and inspect runtimeObservations.gameplay.tags in the playtest artifact.",
        },
      };
}

/**
 * `index` identifies an assertion that names no entity.
 *
 * Naming the row after the entity the run happened to discover makes the identifier depend on the
 * build rather than on the proof, so two arms of a paired round emit different ids for the same
 * sealed assertion — `states.mission` against `states.anonymous` — and nothing can join them. The
 * discovered entity stays in `details`, where it is evidence rather than identity.
 */
export function evaluateStateAssertion(
  assertion: IPlaytestStateAssertion,
  observations: unknown,
  scenario: IPlaytestScenario,
  index: number,
): { assertion: IPlaytestAssertionResult; diagnostic?: IPlaytestDiagnostic } {
  const gameplay = gameplayObservations(runtimeObservationValue(observations));
  const states = isRecord(gameplay?.states) ? gameplay.states : undefined;
  const candidates = Object.entries(states ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string");
  const matching = assertion.entity === undefined
    ? candidates.filter(([, state]) => state === assertion.equals)
    : candidates.filter(([entity]) => entity === assertion.entity);
  const terminalStep = assertion.entity === undefined
    ? terminalContactStep(scenario, assertion.equals)
    : undefined;
  const terminal: { contactObserved: boolean; historyComplete: boolean; preExisting: boolean; preExistingEntities: string[]; step: string | null } = terminalStep === undefined
    ? { contactObserved: true, historyComplete: true, preExisting: false, preExistingEntities: [], step: null }
    : terminalStateEvidence(terminalStep, observations, scenario, matching.map(([entity]) => entity));
  const selected = matching.find(([entity]) => !terminal.preExistingEntities.includes(entity)) ?? matching[0];
  const selectedEntity = selected?.[0] ?? assertion.entity;
  const observed = selected?.[1];
  const selectedPreExisting = selected === undefined
    ? terminal.preExisting
    : terminal.preExistingEntities.includes(selected[0]);
  const comparisonPass = observed === assertion.equals && terminal.contactObserved && terminal.historyComplete && !selectedPreExisting;
  const initialStates = runtimeGameplayBefore(observations);
  const initialStateMap = isRecord(initialStates?.states) ? initialStates.states : undefined;
  const initialPass = assertion.entity === undefined
    ? Object.values(initialStateMap ?? {}).some((state) => state === assertion.equals)
    : initialStateMap?.[assertion.entity] === assertion.equals;
  const trivial = comparisonPass && initialPass;
  const pass = comparisonPass && (!trivial || typeof assertion.allowTrivial === "string");
  const result = {
    details: {
      candidates: candidates.map(([entity, state]) => ({ entity, state })),
      entity: selectedEntity ?? "anonymous",
      expected: assertion,
      expectedState: assertion.equals,
      initialPass,
      observed: observed ?? null,
      terminal: { contactObserved: terminal.contactObserved, historyComplete: terminal.historyComplete, preExisting: selectedPreExisting, step: terminal.step },
      trivial,
      ...(trivial && typeof assertion.allowTrivial === "string" ? { trivialityOptOut: true } : {}),
    },
    id: assertion.entity === undefined ? `states.${index}` : `states.${assertion.entity}`,
    pass,
  };
  return pass
    ? { assertion: result }
    : {
        assertion: result,
        diagnostic: {
          code: trivial && typeof assertion.allowTrivial !== "string"
            ? "TN_PLAYTEST_ASSERTION_TRIVIAL"
            : observed === assertion.equals && (!terminal.contactObserved || !terminal.historyComplete || selectedPreExisting)
            ? "TN_PLAYTEST_STATE_ORDERING_FAILED"
            : "TN_PLAYTEST_STATE_ASSERTION_FAILED",
          message: trivial && typeof assertion.allowTrivial !== "string"
            ? `Assertion '${result.id}' was already satisfied before the scenario ran.`
            : observed === assertion.equals && (!terminal.contactObserved || !terminal.historyComplete || selectedPreExisting)
            ? `Terminal state '${assertion.equals}' was not observed after retained contact evidence at '${terminal.step ?? "an unavailable step"}'.`
            : `Entity '${selectedEntity ?? "anonymous"}' state ${observed === undefined ? "was unavailable" : `'${observed}'`} did not equal '${assertion.equals}'.`,
          severity: "error",
          suggestion: trivial && typeof assertion.allowTrivial !== "string"
            ? "Drive the asserted state from a different initial state, or provide allowTrivial with the reason the state is intentionally held."
            : "Ensure the entity has a StateMachine component and inspect runtimeObservations.gameplay.states in the playtest artifact.",
        },
      };
}

export function terminalContactStep(scenario: IPlaytestScenario, expectedState: string): string | undefined {
  if (expectedState !== "won") return undefined;
  return [...(scenario.assert?.contacts ?? [])]
    .reverse()
    .find((assertion) => {
      const minimum = assertion.minCount ?? (assertion.maxCount === undefined ? 1 : 0);
      return assertion.atStep !== undefined
        && minimum > 0
        && (assertion.requiredOn === undefined || assertion.requiredOn.includes(scenario.target));
    })?.atStep;
}

export function terminalStateEvidence(
  contactStep: string,
  observations: unknown,
  scenario: IPlaytestScenario,
  candidateEntities: readonly string[],
): { contactObserved: boolean; historyComplete: boolean; preExisting: boolean; preExistingEntities: string[]; step: string } {
  const contactAssertion = [...(scenario.assert?.contacts ?? [])]
    .reverse()
    .find((assertion) => assertion.atStep === contactStep);
  const contactObserved = contactAssertion === undefined
    ? false
    : contactAssertionSatisfiedAtStep(contactAssertion, observations, scenario);
  const labeledSteps = scenario.steps.flatMap(({ label }) => label === undefined ? [] : [label]);
  const contactIndex = labeledSteps.indexOf(contactStep);
  const samples = runtimeGameplaySeries(observations);
  const samplesByLabel = new Map(samples.map((sample) => [sample.label, sample.states] as const));
  const historyComplete = contactIndex >= 0
    && labeledSteps.slice(0, contactIndex + 1).every((label) => samplesByLabel.has(label));
  const preExistingEntities = candidateEntities.filter((entity) => {
    if (contactIndex < 0) return false;
    return labeledSteps.slice(0, contactIndex).some((label) => samplesByLabel.get(label)?.[entity] === "won");
  });
  return {
    contactObserved,
    historyComplete,
    preExisting: preExistingEntities.length > 0,
    preExistingEntities,
    step: contactStep,
  };
}

export function contactAssertionSatisfiedAtStep(
  assertion: IPlaytestContactAssertion,
  observations: unknown,
  scenario: IPlaytestScenario,
): boolean {
  const selectedSample = physicsDebugSeries(observations).find((sample) => sample.label === assertion.atStep);
  const runtimeSamples = runtimeGameplaySeries(observations);
  const runtimeStepAvailable = runtimeSamples.some(({ label }) => label === assertion.atStep);
  const stepAvailable = selectedSample !== undefined || runtimeStepAvailable;
  const entity = assertion.entity ?? scenario.subject;
  const anonymous = assertion.entity === undefined && scenario.subject === undefined;
  const physicsEvidence = assertion.kind === undefined || assertion.kind === "contact"
    ? physicsDebugContactEvidence(
        observationsForPhysics(observations),
        entity,
        assertion.with,
        selectedSample?.snapshot,
      )
    : { candidates: [], count: 0 };
  const runtimeEvidence = runtimeContactEvidence(observations, entity, assertion.with, assertion.kind, assertion.atStep);
  const candidates = [...new Set([...physicsEvidence.candidates, ...runtimeEvidence.candidates])];
  const count = physicsEvidence.count + runtimeEvidence.count;
  const minimum = assertion.minCount ?? (assertion.maxCount === undefined ? 1 : 0);
  return stepAvailable
    && (!anonymous || candidates.length > 0)
    && count >= minimum
    && (assertion.maxCount === undefined || count <= assertion.maxCount);
}

/**
 * Reads the runtime cue ledger, which is the only observation that can say what the game played.
 *
 * A missing ledger is a failure, not a pass: a target whose bridge never published `audio` cannot
 * support the claim, and reporting green on an absent observation is how an audio defect ships
 * under a green gate.
 */
/** Milliseconds between a play of `cue` and whatever sounded immediately before it, smallest first. */
function smallestGapBefore(recent: readonly unknown[], cue: string): number | undefined {
  let smallest: number | undefined;
  for (let index = 1; index < recent.length; index += 1) {
    const entry = recent[index];
    const previous = recent[index - 1];
    if (!isRecord(entry) || !isRecord(previous)) continue;
    if (entry.cue !== cue) continue;
    if (typeof entry.atMs !== "number" || typeof previous.atMs !== "number") continue;
    const gap = entry.atMs - previous.atMs;
    if (smallest === undefined || gap < smallest) smallest = gap;
  }
  return smallest;
}

export function evaluateAudioAssertion(
  assertion: IPlaytestAudioAssertion,
  observations: unknown,
): { assertion: IPlaytestAssertionResult; diagnostic?: IPlaytestDiagnostic } {
  const gameplay = gameplayObservations(observations);
  const audio = isRecord(gameplay?.audio) ? gameplay.audio : undefined;
  const cues = isRecord(audio?.cues) ? audio.cues : undefined;
  const observed = cues === undefined ? undefined : cues[assertion.cue];
  const plays = typeof observed === "number" ? observed : 0;
  const minimum = assertion.minPlays ?? 1;
  // The recent log is ordered across every bus, so the gap is measured against whatever sounded
  // last — not against the previous play of this same cue, which is not what cuts a line off.
  const recent = Array.isArray(audio?.recentCues) ? audio.recentCues : [];
  const gap = smallestGapBefore(recent as readonly unknown[], assertion.cue);
  const gapPass = assertion.minGapMs === undefined || (Array.isArray(audio?.recentCues) && gap !== undefined && gap >= assertion.minGapMs);
  const pass =
    cues !== undefined &&
    plays >= minimum &&
    (assertion.maxPlays === undefined || plays <= assertion.maxPlays) &&
    gapPass;
  const result = {
    details: {
      cue: assertion.cue,
      maxPlays: assertion.maxPlays ?? null,
      minGapMs: assertion.minGapMs ?? null,
      minPlays: minimum,
      observed: cues === undefined ? null : plays,
      observedGapMs: gap ?? null,
    },
    id: `audio.${assertion.cue}`,
    pass,
  };
  return pass
    ? { assertion: result }
    : {
        assertion: result,
        diagnostic: {
          code: "TN_PLAYTEST_AUDIO_ASSERTION_FAILED",
          message:
            cues === undefined
              ? `No runtime audio ledger was published, so cue '${assertion.cue}' cannot be proved either way.`
              : gapPass
                ? `Cue '${assertion.cue}' played ${plays} time(s); expected at least ${minimum}${assertion.maxPlays === undefined ? "" : ` and at most ${assertion.maxPlays}`}.`
                : assertion.minGapMs !== undefined && !Array.isArray(audio?.recentCues)
                  ? `Cue '${assertion.cue}' asserts a minimum gap, but no recentCues ledger was published, so the gap between plays was never measured.`
                  : `Cue '${assertion.cue}' started ${gap ?? 0} ms after the line before it, which is under the ${String(assertion.minGapMs)} ms it needs; one of them was cut off.`,
          observedRuntimePath: "observations.json/runtimeObservations/gameplay/audio/cues",
          severity: "error",
          suggestion:
            cues === undefined
              ? "Run on a target whose bridge advertises runtime.audio, and pass `cue` to AudioBus.play/playAt for the lines under test."
              : "Read observations.json/runtimeObservations/gameplay/audio/recentCues for when each play happened, and check the one-shot flag that gates the cue.",
        },
      };
}

export function evaluateWorldAssertion(
  assertion: IPlaytestWorldAssertion,
  observations: unknown,
): { assertion: IPlaytestAssertionResult; diagnostic?: IPlaytestDiagnostic } {
  const gameplay = gameplayObservations(observations);
  const world = isRecord(gameplay?.world) ? gameplay.world : undefined;
  const observed = world?.seed;
  const seedPass = (typeof observed === "number" || observed === null) && observed === assertion.seed;
  const observedRuntime = isRecord(world?.runtime) ? world.runtime : undefined;
  const expectedRuntime = assertion.runtime;
  const runtimePass = expectedRuntime === undefined || (
    observedRuntime !== undefined &&
    (expectedRuntime.portable === true || observedRuntime.agent === expectedRuntime.agent) &&
    observedRuntime.core === expectedRuntime.core &&
    observedRuntime.randomState === expectedRuntime.randomState &&
    observedRuntime.rapier === expectedRuntime.rapier &&
    observedRuntime.step === expectedRuntime.step
  );
  const pass = seedPass && runtimePass;
  const result = {
    details: {
      expected: assertion.seed,
      expectedRuntime: expectedRuntime ?? null,
      observed: observed ?? null,
      observedRuntime: observedRuntime ?? null,
    },
    id: "world.seed",
    pass,
  };
  return pass
    ? { assertion: result }
    : {
        assertion: result,
        diagnostic: {
          code: "TN_PLAYTEST_WORLD_ASSERTION_FAILED",
          message: !seedPass
            ? `Runtime world seed ${observed === undefined ? "was unavailable" : JSON.stringify(observed)} did not equal ${JSON.stringify(assertion.seed)}.`
            : `Runtime world fingerprint ${observedRuntime === undefined ? "was unavailable" : JSON.stringify(observedRuntime)} did not equal ${JSON.stringify(expectedRuntime)}.`,
          observedRuntimePath: !seedPass
            ? "observations.json/runtimeObservations/gameplay/world/seed"
            : "observations.json/runtimeObservations/gameplay/world/runtime",
          severity: "error",
          suggestion: "Expose the configured world seed and deterministic runtime fingerprint through the runtime bridge and rerun the scenario.",
        },
      };
}

export function gameplayObservations(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const gameplay = value.gameplay;
  return isRecord(gameplay) ? gameplay : undefined;
}

export function runtimeObservationValue(value: unknown): unknown {
  if (!isRecord(value) || !Object.hasOwn(value, "runtimeObservations")) return value;
  return value.runtimeObservations;
}

export function runtimeGameplayBefore(value: unknown): Record<string, unknown> | undefined {
  const runtime = runtimeObservationValue(value);
  if (!isRecord(runtime)) return undefined;
  return isRecord(runtime.gameplayBefore) ? runtime.gameplayBefore : undefined;
}

export function tagCount(gameplay: Record<string, unknown> | undefined, tag: string): number | undefined {
  const tags = isRecord(gameplay?.tags) ? gameplay.tags : undefined;
  const summary = isRecord(tags?.[tag]) ? tags[tag] : undefined;
  return typeof summary?.count === "number" ? summary.count : tags === undefined ? undefined : 0;
}

export function initialPhysicsDebugSnapshot(observations: IPlaytestObservations | undefined): unknown {
  return observations?.physicsDebugBefore;
}

export function initialEffectLog(observations: IPlaytestObservations | undefined): unknown {
  return observations?.effectLogBefore;
}

export function animationObservationPass(assertion: IPlaytestAnimationAssertion, observed: unknown): boolean {
  if (!isRecord(observed)) return false;
  const clip = typeof observed.clip === "string" ? observed.clip : undefined;
  const advancedFrames = typeof observed.advancedFrames === "number" ? observed.advancedFrames : undefined;
  const finished = typeof observed.finished === "boolean" ? observed.finished : undefined;
  return (assertion.clip === undefined || clip === assertion.clip)
    && (assertion.entered !== true || clip !== undefined)
    && (assertion.finished === undefined || (finished !== undefined && finished === assertion.finished))
    && (assertion.advancedFrames === undefined || (advancedFrames !== undefined && advancedFrames >= assertion.advancedFrames))
    && strideFailure(assertion, observed) === undefined;
}

export interface IStrideReading {
  clipGroundSpeed: number;
  groundSpeed: number;
  overridden: boolean;
  rate: number;
  synced: boolean;
}

/**
 * The producer's stride report, or nothing.
 *
 * A partially shaped report is nothing: a stride number the producer did not send would otherwise
 * be read as a measurement, and an unmeasured number is the failure this package exists to stop.
 */
export function strideReading(observed: unknown): IStrideReading | undefined {
  if (!isRecord(observed)) return undefined;
  const stride = observed.stride;
  if (!isRecord(stride)) return undefined;
  const numbers = ["clipGroundSpeed", "groundSpeed", "rate"] as const;
  if (!numbers.every((key) => typeof stride[key] === "number" && Number.isFinite(stride[key]))) return undefined;
  if (typeof stride.overridden !== "boolean" || typeof stride.synced !== "boolean") return undefined;
  return {
    clipGroundSpeed: stride.clipGroundSpeed as number,
    groundSpeed: stride.groundSpeed as number,
    overridden: stride.overridden,
    rate: stride.rate as number,
    synced: stride.synced,
  };
}

/** Below this the body is standing still, and a slide ratio would divide by noise. */
const STRIDE_GROUND_SPEED_FLOOR = 1e-3;

/**
 * The rate the clip is actually playing at.
 *
 * `rate` is what the producer *measured*, and it reports that whether or not it applied it —
 * which is the point of the convention's override being honest. The feet, though, move at the
 * rate the action is running at: the measured rate when the convention applied it, and the
 * clip's authored rate when the game declined. Reading `rate` unconditionally made an
 * overridden run compute zero slide, which is the exact case the bound exists to catch.
 */
export function appliedStrideRate(reading: IStrideReading): number {
  return reading.synced ? reading.rate : 1;
}

/** Metres of ground the feet carry per second at the rate the clip is actually playing. */
export function strideFeetSpeed(reading: IStrideReading): number {
  return reading.clipGroundSpeed * appliedStrideRate(reading);
}

/** |feet - ground| / ground, or nothing when the body covered no ground to compare against. */
export function footSlideRatio(reading: IStrideReading): number | undefined {
  if (Math.abs(reading.groundSpeed) <= STRIDE_GROUND_SPEED_FLOOR) return undefined;
  return Math.abs(strideFeetSpeed(reading) - reading.groundSpeed) / Math.abs(reading.groundSpeed);
}

/**
 * Why a stride bound did not hold, or nothing when it did (or was never asked for).
 *
 * Every branch fails closed. The stride convention is on by default, so a producer that reports
 * no stride has not reported agreement — it has reported nothing, and a bound evaluated against
 * nothing is the vacuous pass this harness refuses.
 */
export function strideFailure(
  assertion: IPlaytestAnimationAssertion,
  observed: unknown,
): { code: string; detail: string } | undefined {
  if (assertion.maxFootSlide === undefined && assertion.strideSynced === undefined) return undefined;
  const reading = strideReading(observed);
  if (reading === undefined)
    return {
      code: "TN_PLAYTEST_STRIDE_UNOBSERVED",
      detail:
        "the runtime reported no stride for this clip, so neither the feet nor the ground were measured",
    };
  if (assertion.strideSynced !== undefined && reading.synced !== assertion.strideSynced)
    return {
      code: "TN_PLAYTEST_STRIDE_NOT_SYNCED",
      detail: `stride sync is ${reading.synced ? "applied" : "not applied"}, expected ${assertion.strideSynced ? "applied" : "not applied"}${reading.overridden ? " (the game set strideSync: false)" : ""}`,
    };
  if (assertion.maxFootSlide === undefined) return undefined;
  const ratio = footSlideRatio(reading);
  if (ratio === undefined)
    return {
      code: "TN_PLAYTEST_STRIDE_UNOBSERVED",
      detail:
        "the body covered no ground between samples, so foot slide was not measurable — drive the subject before bounding it",
    };
  if (ratio > assertion.maxFootSlide)
    return {
      code: "TN_PLAYTEST_FOOT_SLIDE",
      detail: `feet carry ${strideFeetSpeed(reading).toFixed(3)} m/s against ${reading.groundSpeed.toFixed(3)} m/s of ground — ${(ratio * 100).toFixed(0)}% apart, ceiling ${(assertion.maxFootSlide * 100).toFixed(0)}%`,
    };
  return undefined;
}

export function runtimeGameplaySamples(value: unknown): Array<{ gameplay: Record<string, unknown>; label: string }> {
  const runtime = runtimeObservationValue(value);
  if (!isRecord(runtime) || !Array.isArray(runtime.gameplaySeries)) return [];
  return runtime.gameplaySeries.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.label !== "string") return [];
    const direct = isRecord(entry.gameplay) ? entry.gameplay : undefined;
    const nested = isRecord(entry.snapshot) && isRecord(entry.snapshot.gameplay) ? entry.snapshot.gameplay : undefined;
    return direct === undefined && nested === undefined ? [] : [{ gameplay: direct ?? nested!, label: entry.label }];
  });
}

export function runtimeGameplaySeries(value: unknown): Array<{ label: string; states: Record<string, string> }> {
  return runtimeGameplaySamples(value).map(({ gameplay, label }) => ({
    label,
    states: isRecord(gameplay.states)
      ? Object.fromEntries(Object.entries(gameplay.states).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
      : {},
  }));
}

export function runtimeGameplayAtStep(value: unknown, atStep: string | undefined): Record<string, unknown> | undefined {
  const runtime = runtimeObservationValue(value);
  if (atStep === undefined) return gameplayObservations(runtime);
  return runtimeGameplaySamples(runtime).find(({ label }) => label === atStep)?.gameplay;
}

export function physicsDebugSeries(value: unknown): Array<{ label: string; snapshot: unknown }> {
  if (!isRecord(value) || !Array.isArray(value.physicsDebugSeries)) return [];
  return value.physicsDebugSeries.flatMap((sample) => {
    if (!isRecord(sample) || typeof sample.label !== "string") return [];
    return [{ label: sample.label, snapshot: sample.snapshot }];
  });
}

export function observationsForPhysics(value: unknown): IPlaytestObservations | undefined {
  return isRecord(value) ? value as unknown as IPlaytestObservations : undefined;
}

export function runtimeContactEvidence(
  observations: unknown,
  entity: string | undefined,
  withEntity: string | undefined,
  kind: string | undefined,
  atStep: string | undefined,
): IContactEvidence {
  const gameplay = runtimeGameplayAtStep(observations, atStep);
  if (!Array.isArray(gameplay?.contacts)) return { candidates: [], count: 0 };
  const candidates: string[] = [];
  for (const contact of gameplay.contacts) {
    if (!isRecord(contact)
      || typeof contact.entity !== "string"
      || typeof contact.with !== "string"
      || typeof contact.kind !== "string"
      || (entity !== undefined && contact.entity !== entity)
      || (withEntity !== undefined && contact.with !== withEntity)
      || (kind !== undefined && contact.kind !== kind)) continue;
    candidates.push(`${contact.entity}:${contact.with}:${contact.kind}`);
  }
  return { candidates: [...new Set(candidates)], count: candidates.length };
}

export function countRuntimeContacts(observations: unknown, entity: string | undefined, withEntity: string | undefined, kind: string | undefined): number {
  const gameplay = gameplayObservations(observations);
  if (!Array.isArray(gameplay?.contacts)) return 0;
  return gameplay.contacts.filter((contact) => {
    if (!isRecord(contact)) return false;
    return (entity === undefined || contact.entity === entity)
      && (withEntity === undefined || contact.with === withEntity)
      && (kind === undefined || contact.kind === kind);
  }).length;
}

export function runtimeAnimationObservations(value: unknown): Record<string, unknown> | undefined {
  const gameplay = gameplayObservations(value);
  return isRecord(gameplay?.animation) ? gameplay.animation : undefined;
}

