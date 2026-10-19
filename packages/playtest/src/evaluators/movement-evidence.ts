import { PLAYTEST_ASSERTION_REGISTRY } from '../assertion-schema.js';
import { consoleErrors, resolveDiagnosticsPolicy, runtimeDiagnostics, parseMovementAxisExpectation, axisIndex, vectorDistance, isRecord } from '../assertion-report.js';
// Extracted verbatim from assertion-evaluators.ts (PRD-182 Phase 2); do not edit semantics here.
import type { IEvaluationContext } from "./context.js";
import { evaluateDiagnosticsPolicy, maxResolvedAxisDelta, rotationDelta, tiltDegrees, finalTiltDegrees, minimumResolvedDistance, movementFacingEvidence, finalFacingAngleToEntity, finalFacingAngleToPosition, evaluateVisibilityAssertion, runtimeGameplayAtStep, mergeEffectLogs, countMatchingEntries, countRuntimeContacts, physicsDebugContactEvidence, runtimeContactEvidence, summarizeMatchingEntries, settledCandidate, physicsDebugOmittedBodies, physicsDebugMeanPoseDistance, initialPhysicsDebugSnapshot, matchingOccludedRaycasts, initialEffectLog, runtimeAnimationObservations, runtimeGameplayBefore, animationObservationPass, footSlideRatio, strideFailure, strideReading, assertionEvaluatedByBaseProbe, assertionNotEvaluatedDiagnostic, allTrivialityEligibleAssertionsWaived } from "./helpers.js";

export function emitMovementEvidence(ctx: IEvaluationContext): void {
  const { assertions, diagnostics } = ctx;
  const { input, scenarioAssertions } = ctx;
  {
    // The run target, not the scenario file's. A native-smoke scenario says "target": "web" and
    // is driven with --target android; reading the file would keep asserting the network lane the
    // device cannot observe.
    const diagnosticsPolicy = resolveDiagnosticsPolicy(
      scenarioAssertions.diagnostics,
      input.report.target,
    );
    const policyDiagnostics = evaluateDiagnosticsPolicy(input.report, diagnosticsPolicy);
    diagnostics.push(...policyDiagnostics);
    assertions.push({
      details: {
        consoleErrors: consoleErrors(input.report.observations?.console ?? []).length,
        networkErrors: input.report.observations?.network.length ?? 0,
        policy: diagnosticsPolicy,
        runtimeDiagnostics: runtimeDiagnostics(input.report.observations?.runtimeDiagnostics).length,
      },
      id: "diagnostics",
      pass: policyDiagnostics.length === 0,
    });
  }
  if (scenarioAssertions.movement?.minVelocity !== undefined) {
    const velocity = input.report.frames <= 0 ? 0 : input.report.distance / input.report.frames;
    const observed = input.report.before !== undefined && input.report.after !== undefined;
    const pass = observed && velocity >= scenarioAssertions.movement.minVelocity;
    assertions.push({ details: { minVelocity: scenarioAssertions.movement.minVelocity, observed, velocity }, id: "movement.velocity", pass });
    if (!pass) {
      diagnostics.push({
        code: "TN_PLAYTEST_VELOCITY_ASSERTION_FAILED",
        message: observed
          ? `Entity '${input.report.entity}' velocity ${velocity.toFixed(6)} was below required ${scenarioAssertions.movement.minVelocity}.`
          : `Entity '${input.report.entity}' was not observed in both samples, so its velocity was never measured.`,
        severity: "error",
        suggestion: observed
          ? "Check input force/speed tuning and whether the scenario holds input long enough."
          : "The entity is absent from the first or last sample; it cannot carry a velocity bound.",
      });
    }
  }
  if (scenarioAssertions.movement?.minDistance !== undefined) {
    // `distance` falls back to 0 when the entity is missing from either snapshot, and the
    // maxDistance branch below already refuses to read that as evidence. This branch did read it:
    // an entity that was never there reported "moved 0.000000", which names the wrong problem. A
    // scenario that starts on a menu has no player at its first sample, and that is a different
    // failure from a player who would not walk. Fails either way; only one of them is true.
    const observed = input.report.before !== undefined && input.report.after !== undefined;
    const entityName = scenarioAssertions.movement.entity ?? input.report.entity;
    const pass = observed && input.report.distance >= scenarioAssertions.movement.minDistance;
    assertions.push({
      details: {
        distance: input.report.distance,
        entity: input.report.entity,
        minimum: scenarioAssertions.movement.minDistance,
        observed,
      },
      id: "movement.distance",
      pass,
    });
    if (!pass && !input.report.diagnostics.some((diagnostic) => diagnostic.code === "TN_PLAYTEST_INPUT_NO_EFFECT")) {
      diagnostics.push({
        code: "TN_PLAYTEST_MOVEMENT_ASSERTION_FAILED",
        message: observed
          ? `Entity '${entityName}' moved ${input.report.distance.toFixed(6)}, below required ${scenarioAssertions.movement.minDistance}.`
          : `Entity '${entityName}' was not observed in both samples, so its movement was never measured — the run reports no distance rather than a distance of zero.`,
        severity: "error",
        suggestion: observed
          ? "Check input bindings, collision response, and whether the scenario holds input long enough."
          : "The entity is absent from the first or last sample. A scenario that opens on a menu has no player until it starts the game; make sure the subject exists across the interval being measured.",
      });
    }
  }
  if (scenarioAssertions.movement?.maxDistance !== undefined) {
    // `distance` falls back to 0 when the entity is absent from the snapshot, so
    // an unobserved entity looked exactly like a stationary one. This is the
    // blocked-movement proof: the assertion whose whole job is to show something
    // did NOT move must not be satisfiable by measuring nothing.
    const observed = input.report.before !== undefined && input.report.after !== undefined;
    const pass = observed && input.report.distance <= scenarioAssertions.movement.maxDistance;
    assertions.push({ details: { distance: input.report.distance, maximum: scenarioAssertions.movement.maxDistance, observed }, id: "movement.maxDistance", pass });
    if (!pass) {
      diagnostics.push({
        code: "TN_PLAYTEST_MOVEMENT_ASSERTION_FAILED",
        message: observed
          ? `Entity '${input.report.entity}' moved ${input.report.distance.toFixed(6)}, above allowed ${scenarioAssertions.movement.maxDistance}.`
          : `Entity '${scenarioAssertions.movement.entity ?? input.report.entity}' was never observed, so its movement could not be bounded.`,
        severity: "error",
        suggestion: observed
          ? "Check bounds/blocked-cell handling and ensure the scenario drives the intended blocked direction."
          : "Register the entity with the playtest bridge under the id the assertion names.",
      });
    }
  }
  if (scenarioAssertions.movement?.pathLength !== undefined) {
    const pathLength = input.report.pathLength ?? input.report.distance;
    const observed = input.report.before !== undefined && input.report.after !== undefined;
    const pass = observed && pathLength >= scenarioAssertions.movement.pathLength;
    assertions.push({ details: { minimum: scenarioAssertions.movement.pathLength, observed, pathLength }, id: "movement.pathLength", pass });
    if (!pass) {
      diagnostics.push({
        code: "TN_PLAYTEST_PATH_LENGTH_ASSERTION_FAILED",
        message: observed
          ? `Entity '${input.report.entity}' accumulated path length ${pathLength.toFixed(6)}, below required ${scenarioAssertions.movement.pathLength}.`
          : `Entity '${input.report.entity}' was never observed, so its path length could not be bounded.`,
        severity: "error",
        suggestion: observed
          ? "Use pathLength with minDistance to distinguish actual traversal from a route that returns to its starting point."
          : "Register the entity with the playtest bridge under the id the assertion names.",
      });
    }
  }
  if (scenarioAssertions.movement?.minAxisDelta !== undefined) {
    const expectation = parseMovementAxisExpectation(scenarioAssertions.movement.minAxisDelta.axis);
    let rawDelta: number | undefined;
    if (expectation !== undefined && input.report.movementDelta !== undefined) {
      rawDelta = input.report.movementDelta[axisIndex(expectation.axis)];
    }
    const signedDelta = rawDelta === undefined || expectation === undefined ? undefined : rawDelta * (expectation.sign ?? 1);
    const pass = signedDelta !== undefined && signedDelta >= scenarioAssertions.movement.minAxisDelta.min;
    assertions.push({
      details: {
        axis: scenarioAssertions.movement.minAxisDelta.axis,
        min: scenarioAssertions.movement.minAxisDelta.min,
        rawDelta: rawDelta ?? null,
        signedDelta: signedDelta ?? null,
      },
      id: "movement.axisDelta",
      pass,
    });
    if (!pass) {
      diagnostics.push({
        code: "TN_PLAYTEST_AXIS_DELTA_ASSERTION_FAILED",
        message: `Entity '${scenarioAssertions.movement.entity ?? input.report.entity}' did not move ${scenarioAssertions.movement.minAxisDelta.min} units on ${scenarioAssertions.movement.minAxisDelta.axis}.`,
        severity: "error",
        suggestion: "Check route setup, collision response, and whether the scenario ends on the expected vertical surface.",
      });
    }
  }
  if (scenarioAssertions.movement?.minResolvedAxisDelta !== undefined) {
    const entity = scenarioAssertions.movement.entity ?? input.scenario.subject ?? input.report.entity;
    const expectation = parseMovementAxisExpectation(scenarioAssertions.movement.minResolvedAxisDelta.axis);
    const resolved = expectation === undefined ? undefined : maxResolvedAxisDelta(input.report.effectLog, entity, expectation, input.report.before?.position);
    const pass = resolved !== undefined && resolved >= scenarioAssertions.movement.minResolvedAxisDelta.min;
    assertions.push({
      details: {
        axis: scenarioAssertions.movement.minResolvedAxisDelta.axis,
        entity,
        min: scenarioAssertions.movement.minResolvedAxisDelta.min,
        signedDelta: resolved ?? null,
      },
      id: "movement.resolvedAxisDelta",
      pass,
    });
    if (!pass) {
      diagnostics.push({
        code: "TN_PLAYTEST_RESOLVED_AXIS_DELTA_ASSERTION_FAILED",
        message: `Entity '${entity}' did not resolve ${scenarioAssertions.movement.minResolvedAxisDelta.min} units on ${scenarioAssertions.movement.minResolvedAxisDelta.axis}.`,
        severity: "error",
        suggestion: "Check character.move effect-log entries, route setup, collision response, and whether the scenario reaches the expected slope or step surface.",
      });
    }
  }
  if (scenarioAssertions.movement?.rotationChanged === true) {
    const rotation = rotationDelta(
      input.report.effectLog,
      scenarioAssertions.movement.entity ?? input.report.entity,
      input.report.before?.rotation,
      input.report.after?.rotation,
    );
    const pass = rotation !== undefined && rotation > 0.0001;
    assertions.push({ details: { rotationDelta: rotation ?? null }, id: "movement.rotation", pass });
    if (!pass) {
      diagnostics.push({
        code: "TN_PLAYTEST_ROTATION_ASSERTION_FAILED",
        message: `Entity '${scenarioAssertions.movement.entity ?? input.report.entity}' did not expose a changed rotation during the playtest.`,
        severity: "error",
        suggestion: "Check turn/yaw script output and ensure Transform rotation changes are emitted.",
      });
    }
  }
  if (scenarioAssertions.movement?.maxTiltDegrees !== undefined) {
    const entity = scenarioAssertions.movement.entity ?? input.report.entity;
    const tilt = tiltDegrees(input.report.after?.rotation) ?? finalTiltDegrees(input.report.effectLog, entity);
    const pass = tilt !== undefined && tilt <= scenarioAssertions.movement.maxTiltDegrees;
    assertions.push({
      details: { entity, maxTiltDegrees: scenarioAssertions.movement.maxTiltDegrees, tiltDegrees: tilt ?? null },
      id: "movement.tilt",
      pass,
    });
    if (!pass) {
      diagnostics.push({
        code: "TN_PLAYTEST_TILT_ASSERTION_FAILED",
        message: `Entity '${entity}' final tilt ${tilt === undefined ? "was unavailable" : `${tilt.toFixed(3)} degrees`} and must not exceed ${scenarioAssertions.movement.maxTiltDegrees} degrees.`,
        severity: "error",
        suggestion: "Inspect the final Transform rotation and fix suspension, grounding, collision response, or recovery before accepting the playtest.",
      });
    }
  }
  if (scenarioAssertions.movement?.closesDistanceToPosition !== undefined) {
    const expectation = scenarioAssertions.movement.closesDistanceToPosition;
    const before = input.report.before?.position;
    const after = input.report.after?.position;
    const decrease = before === undefined || after === undefined
      ? undefined
      : vectorDistance(before, expectation.position) - vectorDistance(after, expectation.position);
    const pass = decrease !== undefined && decrease >= expectation.min;
    assertions.push({
      details: { decrease: decrease ?? null, position: expectation.position, required: expectation.min },
      id: "movement.closesDistance",
      pass,
    });
    if (!pass) diagnostics.push({
      code: "TN_PLAYTEST_DISTANCE_CLOSURE_ASSERTION_FAILED",
      message: `Entity did not close distance to the expected position by ${expectation.min}.`,
      severity: "error",
      suggestion: "Inspect pursue target ownership and character.move resolved positions.",
    });
  }
  if (scenarioAssertions.movement?.reachesPositionWithin !== undefined) {
    const expectation = scenarioAssertions.movement.reachesPositionWithin;
    const entity = scenarioAssertions.movement.entity ?? input.scenario.subject ?? input.report.entity;
    const resolvedDistance = minimumResolvedDistance(
      input.report.effectLog,
      input.report.observations?.effectLogSeries,
      entity,
      expectation.position,
      input.report.before?.position,
      expectation.atStep,
    );
    const finalDistance = (expectation.atStep === undefined || input.scenario.steps.at(-1)?.label === expectation.atStep)
      && input.report.after?.position !== undefined
      ? vectorDistance(input.report.after.position, expectation.position)
      : undefined;
    const candidates = [resolvedDistance, finalDistance].filter((value): value is number => value !== undefined);
    const closestDistance = candidates.length === 0 ? undefined : Math.min(...candidates);
    const pass = closestDistance !== undefined && closestDistance <= expectation.maxDistance;
    assertions.push({
      details: { closestDistance: closestDistance ?? null, entity, ...expectation },
      id: "movement.reachesPosition",
      pass,
    });
    if (!pass) diagnostics.push({
      code: "TN_PLAYTEST_POSITION_REACH_ASSERTION_FAILED",
      message: `Entity '${entity}' did not come within ${expectation.maxDistance} units of the expected position.`,
      severity: "error",
      suggestion: "Inspect character.move resolved positions and the owned last-known-position target.",
    });
  }
  if (scenarioAssertions.movement?.facesMovementWithinDegrees !== undefined) {
    const entity = scenarioAssertions.movement.entity ?? input.scenario.subject ?? input.report.entity;
    const evidence = movementFacingEvidence(input.report.effectLog, entity);
    const pass = evidence.sampleCount > 0
      && evidence.maxErrorDegrees <= scenarioAssertions.movement.facesMovementWithinDegrees;
    assertions.push({
      details: { entity, ...evidence, threshold: scenarioAssertions.movement.facesMovementWithinDegrees },
      id: "movement.facing",
      pass,
    });
    if (!pass) diagnostics.push({
      code: "TN_PLAYTEST_MOVEMENT_FACING_ASSERTION_FAILED",
      message: `Entity '${entity}' did not face resolved movement within ${scenarioAssertions.movement.facesMovementWithinDegrees} degrees.`,
      severity: "error",
      suggestion: "Inspect character.move direction and Transform yaw effects; slew facing before allowing translation.",
    });
  }
  if (scenarioAssertions.movement?.notFacing !== undefined) {
    const entity = scenarioAssertions.movement.entity ?? input.scenario.subject ?? input.report.entity;
    const angleDegrees = finalFacingAngleToEntity(input.report.effectLog, entity, scenarioAssertions.movement.notFacing.entity);
    const pass = angleDegrees !== undefined && angleDegrees >= scenarioAssertions.movement.notFacing.minDegrees;
    assertions.push({
      details: { angleDegrees: angleDegrees ?? null, entity, target: scenarioAssertions.movement.notFacing.entity },
      id: "movement.notFacing",
      pass,
    });
    if (!pass) diagnostics.push({
      code: "TN_PLAYTEST_NOT_FACING_ASSERTION_FAILED",
      message: `Entity '${entity}' remained pointed at '${scenarioAssertions.movement.notFacing.entity}' during movement.`,
      severity: "error",
      suggestion: "Drive patrol yaw from movement direction rather than the target entity.",
    });
  }
  if (scenarioAssertions.movement?.notFacingPosition !== undefined) {
    const entity = scenarioAssertions.movement.entity ?? input.scenario.subject ?? input.report.entity;
    const expectation = scenarioAssertions.movement.notFacingPosition;
    const angleDegrees = finalFacingAngleToPosition(input.report.effectLog, entity, expectation.position);
    const pass = angleDegrees !== undefined && angleDegrees >= expectation.minDegrees;
    assertions.push({
      details: { angleDegrees: angleDegrees ?? null, entity, position: expectation.position },
      id: "movement.notFacingPosition",
      pass,
    });
    if (!pass) diagnostics.push({
      code: "TN_PLAYTEST_NOT_FACING_POSITION_ASSERTION_FAILED",
      message: `Entity '${entity}' remained pointed at the excluded world position during movement.`,
      severity: "error",
      suggestion: "Drive patrol yaw from movement direction rather than the observed target position.",
    });
  }
  for (const assertion of scenarioAssertions.visibility ?? []) {
    const entity = assertion.entity ?? input.scenario.subject ?? input.report.entity;
    const result = evaluateVisibilityAssertion(
      assertion,
      entity,
      input.scenario.viewport,
      input.report.observations?.runtimeDiagnostics,
      input.report.observations?.runtimeDiagnosticsBefore,
    );
    assertions.push(result.assertion);
    if (result.diagnostic !== undefined) {
      diagnostics.push(result.diagnostic);
    }
  }
  for (const [contactIndex, assertion] of (scenarioAssertions.contacts ?? []).entries()) {
    const entity = assertion.entity ?? input.scenario.subject;
    const anonymous = entity === undefined;
    if (assertion.requiredOn !== undefined && !assertion.requiredOn.includes(input.scenario.target)) {
      assertions.push({
        details: { entity: entity || "anonymous", requiredOn: assertion.requiredOn, skipped: true, target: input.scenario.target },
        id: assertion.entity === undefined ? `contact.${contactIndex}` : `contact.${entity}`,
        pass: true,
      });
      continue;
    }
    const tokens = [entity, assertion.with, assertion.kind].filter((item): item is string => item !== undefined);
    const selectedSample = assertion.atStep === undefined
      ? undefined
      : input.report.observations?.physicsDebugSeries?.find((sample) => sample.label === assertion.atStep);
    const runtimeStepAvailable = assertion.atStep === undefined
      || runtimeGameplayAtStep(input.report.observations?.runtimeObservations, assertion.atStep) !== undefined;
    const stepAvailable = assertion.atStep === undefined || selectedSample !== undefined || runtimeStepAvailable;
    const effectEvidence = assertion.atStep === undefined
      ? mergeEffectLogs(input.report.effectLog, input.report.observations?.effectLogSeries)
      : [];
    const effectCount = countMatchingEntries(effectEvidence, tokens);
    const runtimeCount = assertion.atStep === undefined
      ? countRuntimeContacts(input.report.observations?.runtimeObservations, entity, assertion.with, assertion.kind)
      : 0;
    const physicsEvidence = assertion.kind === undefined || assertion.kind === "contact"
      ? physicsDebugContactEvidence(input.report.observations, entity, assertion.with, selectedSample?.snapshot)
      : { candidates: [], count: 0 };
    const runtimeEvidence = runtimeContactEvidence(
      input.report.observations?.runtimeObservations,
      entity,
      assertion.with,
      assertion.kind,
      assertion.atStep,
    );
    const candidates = [...new Set([...physicsEvidence.candidates, ...runtimeEvidence.candidates])];
    const count = effectCount + physicsEvidence.count + (assertion.atStep === undefined ? runtimeCount : runtimeEvidence.count);
    const minCount = assertion.minCount ?? (assertion.maxCount === undefined ? 1 : 0);
    const candidatesAvailable = !anonymous || candidates.length > 0;
    const pass = stepAvailable && candidatesAvailable && count >= minCount && (assertion.maxCount === undefined || count <= assertion.maxCount);
    const resultEntity = entity || "anonymous";
    assertions.push({ details: { atStep: assertion.atStep, candidates, count, entity: resultEntity, kind: assertion.kind, maxCount: assertion.maxCount, minCount, with: assertion.with }, id: assertion.entity === undefined ? `contact.${contactIndex}` : `contact.${resultEntity}`, pass });
    if (!pass) {
      const partial = summarizeMatchingEntries(effectEvidence, [entity, assertion.with].filter((item): item is string => item !== undefined));
      const hasPhysicsDebugEvidence = input.report.observations?.physicsDebug !== undefined
        || (input.report.observations?.physicsDebugSeries?.length ?? 0) > 0;
      diagnostics.push({
        artifactPath: partial !== undefined || !hasPhysicsDebugEvidence ? "effect-log.json" : "observations.json",
        code: !stepAvailable
          ? "TN_PLAYTEST_CONTACT_STEP_NOT_OBSERVED"
          : !candidatesAvailable
          ? "TN_PLAYTEST_CONTACT_CANDIDATES_UNAVAILABLE"
          : assertion.maxCount !== undefined && count > assertion.maxCount
          ? "TN_PLAYTEST_CONTACT_COUNT_EXCEEDED"
          : "TN_PLAYTEST_CONTACT_NOT_OBSERVED",
        message: !stepAvailable
          ? `Contact assertion step '${assertion.atStep}' was not retained.`
          : !candidatesAvailable
          ? "No observed contact candidate was retained for the anonymous contact assertion."
          : assertion.maxCount !== undefined && count > assertion.maxCount
          ? `Contact/trigger for '${resultEntity}' was observed ${count} time(s), above allowed ${assertion.maxCount}.`
          : `Expected contact/trigger for '${resultEntity}' was not observed ${minCount} time(s).`,
        observedRuntimePath: `observations.json/physicsDebugSeries/artifact/primitives[category=contact,entity=${resultEntity}] | effect-log.json/entries[kind=service|event,entity=${resultEntity}]`,
        path: `${input.scenario.sourcePath ?? "playtest"}/assert/contacts/${resultEntity}`,
        severity: "error",
        ...(input.scenario.sourcePath === undefined ? {} : { sourcePath: input.scenario.sourcePath }),
        ...(partial?.systemId === undefined ? {} : { systemId: partial.systemId, sourcePath: partial.sourcePath }),
        suggestion: !stepAvailable
          ? "Add a scenario step with the requested label or correct assert.contacts[].atStep."
          : partial === undefined
          ? "Check collider/trigger metadata, contact filters, and whether the scenario reaches the target. Inspect observations.json physics-debug contacts and effect-log.json."
          : `effect-log.json contains ${partial.entryCount} related runtime entr${partial.entryCount === 1 ? "y" : "ies"} from ${partial.systems}, but none satisfied the contact assertion. Check collider/trigger metadata, contact filters, and route timing in the listed system(s).`,
      });
    }
  }
  for (const [settledIndex, assertion] of (scenarioAssertions.settled ?? []).entries()) {
    if (assertion.requiredOn !== undefined && !assertion.requiredOn.includes(input.scenario.target)) {
      assertions.push({
        details: { entity: assertion.entity ?? "anonymous", requiredOn: assertion.requiredOn, skipped: true, target: input.scenario.target },
        id: `settled.${assertion.entity ?? "anonymous"}`,
        pass: true,
      });
      continue;
    }
    const snapshot = assertion.atStep === undefined
      ? input.report.observations?.physicsDebugSeries?.at(-1)?.snapshot ?? input.report.observations?.physicsDebug
      : input.report.observations?.physicsDebugSeries?.find((sample) => sample.label === assertion.atStep)?.snapshot;
    const minimum = assertion.minBodies ?? 1;
    const candidate = settledCandidate(snapshot, assertion.entity);
    const bodies = candidate?.bodies ?? [];
    const omittedBodies = physicsDebugOmittedBodies(snapshot);
    const sleeping = bodies.filter((body) => body.sleeping).length;
    const comparisonSnapshot = assertion.compareToStep === undefined
      ? undefined
      : input.report.observations?.physicsDebugSeries?.find((sample) => sample.label === assertion.compareToStep)?.snapshot;
    const selectedEntity = candidate?.selector ?? assertion.entity ?? "";
    const poseDistance = assertion.compareToStep === undefined
      ? undefined
      : physicsDebugMeanPoseDistance(snapshot, comparisonSnapshot, selectedEntity);
    const posePass = assertion.minMeanPoseDistance === undefined
      || (poseDistance !== undefined && poseDistance.sharedBodies >= minimum && poseDistance.mean >= assertion.minMeanPoseDistance);
    const complete = omittedBodies === 0;
    const comparisonPass = complete && candidate !== undefined && bodies.length >= minimum && sleeping === bodies.length && posePass;
    const initialSnapshot = initialPhysicsDebugSnapshot(input.report.observations);
    const initialCandidate = settledCandidate(initialSnapshot, assertion.entity);
    const initialBodies = initialCandidate?.bodies ?? [];
    // A pose-distance threshold is inherently a comparison between two retained samples. The
    // initial snapshot has no labeled comparison step, so it cannot make this assertion trivial
    // merely because its bodies happened to start asleep.
    const initialPosePass = assertion.minMeanPoseDistance === undefined;
    const initialPass = initialSnapshot !== undefined
      && physicsDebugOmittedBodies(initialSnapshot) === 0
      && initialCandidate !== undefined
      && initialBodies.length >= minimum
      && initialBodies.every((body) => body.sleeping)
      && initialPosePass;
    const trivial = comparisonPass && initialPass;
    const pass = comparisonPass && (!trivial || typeof assertion.allowTrivial === "string");
    const resultEntity = candidate?.selector ?? assertion.entity ?? "anonymous";
    assertions.push({
      details: {
        atStep: assertion.atStep,
        bodies: bodies.length,
        candidates: candidate?.candidates ?? [],
        compareToStep: assertion.compareToStep,
        entity: resultEntity,
        expected: assertion,
        initialPass,
        initialPosePass,
        minimum,
        omittedBodies,
        poseDistance,
        sleeping,
        trivial,
        ...(trivial && typeof assertion.allowTrivial === "string" ? { trivialityOptOut: true } : {}),
      },
      id: assertion.entity === undefined ? `settled.${settledIndex}` : `settled.${assertion.entity}`,
      pass,
    });
    if (!pass) diagnostics.push({
      artifactPath: "observations.json",
      code: trivial && typeof assertion.allowTrivial !== "string"
        ? "TN_PLAYTEST_ASSERTION_TRIVIAL"
        : !complete
        ? "TN_PLAYTEST_PHYSICS_EVIDENCE_TRUNCATED"
        : !posePass ? "TN_PLAYTEST_RAGDOLL_POSE_NOT_DISTINCT" : "TN_PLAYTEST_PHYSICS_NOT_SETTLED",
      message: trivial && typeof assertion.allowTrivial !== "string"
        ? `Assertion 'settled.${resultEntity}' was already satisfied before the scenario ran.`
        : !complete
        ? `Physics evidence omitted ${omittedBodies} bod${omittedBodies === 1 ? "y" : "ies"}; settled cannot pass on a partial snapshot.`
        : !posePass
        ? `Expected mean settled-pose distance for '${resultEntity}' to reach ${assertion.minMeanPoseDistance}m from step '${assertion.compareToStep}'; observed ${poseDistance?.mean ?? "unavailable"}m across ${poseDistance?.sharedBodies ?? 0} bodies.`
        : `Expected at least ${minimum} physics bod${minimum === 1 ? "y" : "ies"} matching '${resultEntity}' to be asleep; observed ${sleeping} of ${bodies.length}.`,
      observedRuntimePath: "observations.json/physicsDebugSeries/artifact/primitives[category=sleep]",
      path: `${input.scenario.sourcePath ?? "playtest"}/assert/settled/${resultEntity}`,
      severity: "error",
      ...(input.scenario.sourcePath === undefined ? {} : { sourcePath: input.scenario.sourcePath }),
      suggestion: trivial && typeof assertion.allowTrivial !== "string"
        ? "Drive the asserted bodies from an awake initial state, or provide allowTrivial with the reason the rest state is intentionally held."
        : "Allow a longer settle window or fix damping, contacts, joints, and persistent forces that keep the bodies awake.",
    });
  }
  for (const assertion of scenarioAssertions.occluded ?? []) {
    const matches = matchingOccludedRaycasts(input.report.effectLog, assertion.entity, assertion.target);
    const id = `occluded.${assertion.entity ?? "ray"}`;
    const initialMatches = matchingOccludedRaycasts(
      initialEffectLog(input.report.observations),
      assertion.entity,
      assertion.target,
    );
    const comparisonPass = matches > 0;
    const trivial = comparisonPass && initialMatches > 0;
    const pass = comparisonPass && (!trivial || typeof assertion.allowTrivial === "string");
    assertions.push({
      details: {
        count: matches,
        entity: assertion.entity,
        expected: assertion,
        initialMatches,
        target: assertion.target,
        trivial,
        ...(trivial && typeof assertion.allowTrivial === "string" ? { trivialityOptOut: true } : {}),
      },
      id,
      pass,
    });
    if (!pass) diagnostics.push({
      artifactPath: "effect-log.json",
      code: trivial && typeof assertion.allowTrivial !== "string"
        ? "TN_PLAYTEST_ASSERTION_TRIVIAL"
        : "TN_PLAYTEST_OCCLUSION_NOT_OBSERVED",
      message: trivial && typeof assertion.allowTrivial !== "string"
        ? `Assertion '${id}' was already satisfied before the scenario ran.`
        : "Expected a render scene-ray query or physics raycast result with hit=true, but no matching occlusion evidence was observed.",
      observedRuntimePath: "effect-log.json/entries[service=render.sceneRayQuery|physics.raycast]/payload/result/hit",
      severity: "error",
      suggestion: trivial && typeof assertion.allowTrivial !== "string"
        ? "Drive the asserted occlusion from a non-occluded initial state, or provide allowTrivial with the reason the occlusion is intentionally held."
        : "Check the listener/emitter entity ids and rendered occluder geometry, then inspect effect-log.json for the scene-query request and hit result.",
    });
  }
  for (const assertion of scenarioAssertions.animation ?? []) {
    const entity = assertion.entity ?? input.scenario.subject ?? input.report.entity;
    const runtime = runtimeAnimationObservations(input.report.observations?.runtimeObservations);
    if (runtime !== undefined) {
      const observed = isRecord(runtime[entity]) ? runtime[entity] : undefined;
      const clip = typeof observed?.clip === "string" ? observed.clip : undefined;
      const advancedFrames = typeof observed?.advancedFrames === "number" ? observed.advancedFrames : undefined;
      const finished = typeof observed?.finished === "boolean" ? observed.finished : undefined;
      // One predicate for the observed sample and the initial one. They were written twice and
      // drifted the moment a field was added to only one of them.
      const pass = animationObservationPass(assertion, observed);
      const stride = strideReading(observed);
      const slide = stride === undefined ? undefined : footSlideRatio(stride);
      const strideMiss = strideFailure(assertion, observed);
      const initialGameplay = runtimeGameplayBefore(input.report.observations?.runtimeObservations);
      const initialAnimations = isRecord(initialGameplay?.animation) ? initialGameplay.animation : undefined;
      const initialObserved = isRecord(initialAnimations?.[entity]) ? initialAnimations[entity] : undefined;
      const initialPass = animationObservationPass(assertion, initialObserved);
      const trivial = pass && initialPass;
      const guardedPass = pass && (!trivial || typeof assertion.allowTrivial === "string");
      assertions.push({
        details: {
          advancedFrames,
          clip,
          entity,
          expected: assertion,
          finished,
          initialPass,
          ...(slide === undefined ? {} : { footSlide: slide }),
          ...(stride === undefined ? {} : { stride }),
          trivial,
          ...(trivial && typeof assertion.allowTrivial === "string" ? { trivialityOptOut: true } : {}),
        },
        id: `animation.${entity}`,
        pass: guardedPass,
      });
      if (!guardedPass) {
        const triviallyHeld = trivial && typeof assertion.allowTrivial !== "string";
        diagnostics.push({
          code: triviallyHeld
            ? "TN_PLAYTEST_ASSERTION_TRIVIAL"
            : (strideMiss?.code ?? "TN_PLAYTEST_ANIMATION_NOT_OBSERVED"),
          message: triviallyHeld
            ? `Assertion 'animation.${entity}' was already satisfied before the scenario ran.`
            : strideMiss === undefined
              ? `Expected animation evidence for '${entity}'${assertion.clip === undefined ? "" : ` clip '${assertion.clip}'`} was not observed.`
              : `Stride bound on '${entity}' did not hold: ${strideMiss.detail}.`,
          severity: "error",
          suggestion: triviallyHeld
            ? "Drive the asserted animation from a different initial clip, or provide allowTrivial with the reason the clip is intentionally held."
            : strideMiss === undefined
              ? "Check model animation clip wiring and runtime animation playback state."
              : "Read the stride line in 'doctor --url', then either retime the clip, correct the body speed, or state the override the game intends.",
        });
      }
      continue;
    }
    if (assertion.finished !== undefined) {
      assertions.push({ details: { entity, expected: assertion, finished: undefined }, id: `animation.${entity}`, pass: false });
      diagnostics.push({
        code: "TN_PLAYTEST_ANIMATION_NOT_OBSERVED",
        message: `Expected runtime completion evidence for animation '${entity}', but the runtime animation channel was unavailable.`,
        severity: "error",
        suggestion: "Install the runtime animation observer and inspect runtimeObservations.gameplay.animation.",
      });
      continue;
    }
    const tokens = [entity, assertion.clip].filter((item): item is string => item !== undefined);
    const count = countMatchingEntries(input.report.effectLog, tokens);
    const minCount = Math.max(1, assertion.advancedFrames ?? 1);
    const comparisonPass = count >= minCount;
    const initialCount = countMatchingEntries(initialEffectLog(input.report.observations), tokens);
    const trivial = comparisonPass && initialCount >= minCount;
    const pass = comparisonPass && (!trivial || typeof assertion.allowTrivial === "string");
    assertions.push({
      details: {
        count,
        entity,
        clip: assertion.clip,
        advancedFrames: assertion.advancedFrames,
        expected: assertion,
        finished: assertion.finished,
        initialCount,
        trivial,
        ...(trivial && typeof assertion.allowTrivial === "string" ? { trivialityOptOut: true } : {}),
      },
      id: `animation.${entity}`,
      pass,
    });
    if (!pass) {
      diagnostics.push({
        code: trivial && typeof assertion.allowTrivial !== "string"
          ? "TN_PLAYTEST_ASSERTION_TRIVIAL"
          : "TN_PLAYTEST_ANIMATION_NOT_OBSERVED",
        message: trivial && typeof assertion.allowTrivial !== "string"
          ? `Assertion 'animation.${entity}' was already satisfied before the scenario ran.`
          : `Expected animation evidence for '${entity}'${assertion.clip === undefined ? "" : ` clip '${assertion.clip}'`} was not observed.`,
        severity: "error",
        suggestion: trivial && typeof assertion.allowTrivial !== "string"
          ? "Drive the asserted animation from a different initial clip, or provide allowTrivial with the reason the clip is intentionally held."
          : "Check model animation clip wiring and runtime animation playback state.",
      });
    }
  }
  for (const entry of PLAYTEST_ASSERTION_REGISTRY) {
    if (scenarioAssertions[entry.kind] === undefined
      || assertions.some((assertion) => assertion.id.startsWith(entry.resultIdPrefix))
      || assertionEvaluatedByBaseProbe(entry.kind, input.report)) {
      continue;
    }
    const id = `assert.${entry.kind}`;
    assertions.push({ details: { reason: "registered-without-evaluator" }, id, pass: false });
    diagnostics.push(assertionNotEvaluatedDiagnostic(id, "the registered assertion produced no evaluator result"));
  }
  if (allTrivialityEligibleAssertionsWaived(assertions)) {
    diagnostics.push({
      code: "TN_PLAYTEST_SCENARIO_ASSERTS_NOTHING",
      message: `Scenario '${input.scenario.name}' waived every triviality-eligible assertion, so it asserts nothing independently of its initial state.`,
      severity: "error",
      ...(input.scenario.sourcePath === undefined ? {} : { sourcePath: input.scenario.sourcePath }),
      suggestion: "Remove at least one triviality waiver and drive that assertion from a failing initial state or assert changed:true.",
    });
  }
}
