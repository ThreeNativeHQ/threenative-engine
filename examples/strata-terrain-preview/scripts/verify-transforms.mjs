import assert from "node:assert/strict";
import { loadPlaytestScenario } from "../../../packages/playtest/dist/index.js";
import {
  advanceFixedStep,
  connectPlaytestBridge,
} from "../../../packages/playtest/dist/runner/index.js";

export async function verifyPropTransforms(session, controller, config) {
  const scenario = await loadPlaytestScenario(config.projectPath, config.scenarioPath);
  const beforeTransforms = await session.page.evaluate(() => window.strata.view.inspectProps());
  const selected = beforeTransforms[0];
  assert(selected, "Fixture requires an actual rendered prop");
  const priorRequests = await session.page.evaluate(() => window.strata.evaluationRequests);
  assert(priorRequests > 0);
  const freePose = {
    position: [12, 100, -4],
    quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
    scale: [2, 0.5, 1.5],
    grounding: false,
  };
  const beforePose = await controller.snapshot();
  const posed = await controller.commit({
    baseRevision: beforePose.revision,
    document: { ...beforePose.document, placementOverrides: { [selected.id]: freePose } },
  });
  await session.page.waitForFunction(
    (revision) => window.strata.view.inspect().renderedRevision === revision,
    posed.revision,
    { timeout: 2000 },
  );
  await advanceFixedStep(session.page, session.bridge, 2);
  await session.page.waitForTimeout(100);
  assert.equal(
    await session.page.evaluate(() => window.strata.evaluationRequests),
    priorRequests,
    "Placement edits must not evaluate terrain",
  );
  const transformed = await session.page.evaluate(() => window.strata.view.inspectProps());
  const actualPose = transformed.find((item) => item.id === selected.id);
  assert(actualPose);
  assert.deepEqual(actualPose.transform.position, freePose.position);
  actualPose.transform.scale.forEach((value, index) =>
    assert(Math.abs(value - freePose.scale[index]) < 1e-4),
  );
  assert.equal(actualPose.transform.grounding, false);
  assert(
    actualPose.clearance > 20,
    "Disabled grounding must still measure the actual lifted model",
  );
  assert.deepEqual(
    transformed.filter((item) => item.id !== selected.id),
    beforeTransforms.filter((item) => item.id !== selected.id),
    "Only the selected instance may change",
  );
  await session.screenshot("editor-manual-transform");
  const grounded = await controller.commit({
    baseRevision: posed.revision,
    document: {
      ...posed.document,
      placementOverrides: { [selected.id]: { ...freePose, grounding: true } },
    },
  });
  await session.page.waitForFunction(
    (revision) => window.strata.view.inspect().renderedRevision === revision,
    grounded.revision,
    { timeout: 2000 },
  );
  await advanceFixedStep(session.page, session.bridge, 2);
  const groundedPose = await session.page.evaluate(
    (id) => window.strata.view.inspectProps().find((item) => item.id === id),
    selected.id,
  );
  assert(groundedPose);
  assert(Math.abs(groundedPose.clearance) < 1e-4);
  assert(groundedPose.transform.position[1] < 100);
  const restoredPose = await controller.commit({
    baseRevision: grounded.revision,
    document: { ...grounded.document, placementOverrides: {} },
  });
  await session.page.waitForFunction(
    (revision) => window.strata.view.inspect().renderedRevision === revision,
    restoredPose.revision,
    { timeout: 2000 },
  );
  await advanceFixedStep(session.page, session.bridge, 2);
  assert.deepEqual(
    await session.page.evaluate(() => window.strata.view.inspectProps()),
    beforeTransforms,
  );
  console.log(
    JSON.stringify({
      placementKey: selected.id,
      requested: freePose,
      rendered: actualPose,
      grounded: groundedPose,
      terrainEvaluationRequests: priorRequests,
    }),
  );
  await session.page.locator('[data-tool="select"]').click();
  await session.page
    .getByLabel("Placement", { exact: true })
    .selectOption(`placement:${selected.id}`);
  await session.page.getByRole("button", { name: "Focus selection", exact: true }).click();
  await advanceFixedStep(session.page, session.bridge, 4);
  const clickAt = await session.page.evaluate(
    (id) => window.strata.view.projectPlacement(id),
    selected.id,
  );
  assert(clickAt);
  await session.page.getByLabel("Placement", { exact: true }).selectOption("");
  await session.page.mouse.click(...clickAt);
  assert.equal(
    (await session.page.evaluate(() => window.strata.view.inspectSelection())).selected,
    selected.id,
    "A real mesh click must select one durable placement key",
  );
  const guiWrites = [];
  session.page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/document"))
      guiWrites.push(request.postDataJSON());
  });
  await session.page.getByLabel("Position (m) Y", { exact: true }).fill("100");
  await session.page.getByLabel("Rotation (degrees, XYZ) Y", { exact: true }).fill("45");
  for (const [axis, value] of [
    ["X", "2"],
    ["Y", ".5"],
    ["Z", "1.5"],
  ])
    await session.page.getByLabel(`Scale ${axis}`, { exact: true }).fill(value);
  await session.page.getByLabel("Ground to terrain", { exact: true }).uncheck();
  await session.page.getByRole("button", { name: "Apply transform", exact: true }).click();
  await session.page.waitForFunction(
    (revision) =>
      !window.strata.view.inspectSelection().saving &&
      window.strata.view.inspect().renderedRevision !== revision,
    restoredPose.revision,
  );
  assert.equal(guiWrites.length, 1, "Numeric transform is one transaction");
  const numeric = await controller.snapshot();
  assert.equal(numeric.document.placementOverrides[selected.id].position[1], 100);
  assert.deepEqual(numeric.document.placementOverrides[selected.id].scale, [2, 0.5, 1.5]);
  assert.equal(await session.page.evaluate(() => window.strata.evaluationRequests), priorRequests);
  await session.page.getByRole("button", { name: "Focus selection", exact: true }).click();
  await advanceFixedStep(session.page, session.bridge, 4);
  await session.screenshot("editor-selection-gizmo");
  async function hoverHandle(mode, axis) {
    await session.page.locator(`[data-transform-mode="${mode}"]`).click();
    await advanceFixedStep(session.page, session.bridge, 2);
    const candidates = await session.page.evaluate(() => window.strata.view.inspectHandles());
    for (const candidate of candidates.filter((item) => item.axis === axis)) {
      const [x, y] = candidate.at;
      if (x < 260 || x > 1140 || y < 110 || y > 860) continue;
      await session.page.mouse.move(x, y);
      if ((await session.page.evaluate(() => window.strata.view.inspectSelection())).axis === axis)
        return candidate.at;
    }
    assert.fail(
      `No rendered ${mode} ${axis} handle could be hovered: ${JSON.stringify(candidates)}`,
    );
  }
  for (const [mode, axis] of [
    ["translate", "X"],
    ["rotate", "Y"],
    ["scale", "X"],
  ]) {
    const base = await controller.snapshot();
    const before = await session.page.evaluate(() => window.strata.view.inspectProps());
    const at = await hoverHandle(mode, axis);
    await session.page.mouse.down();
    assert.equal(
      (await session.page.evaluate(() => window.strata.view.inspectSelection())).orbitEnabled,
      false,
      "Orbit must suspend during gizmo drag",
    );
    await session.page.mouse.move(at[0] + 35, at[1] - 25, { steps: 5 });
    const during = await session.page.evaluate(() => window.strata.view.inspectProps());
    assert.notDeepEqual(
      during.find((item) => item.id === selected.id).transform,
      before.find((item) => item.id === selected.id).transform,
    );
    assert.deepEqual(
      during.filter((item) => item.id !== selected.id),
      before.filter((item) => item.id !== selected.id),
    );
    await session.page.mouse.up();
    await session.page.waitForFunction(
      (revision) =>
        !window.strata.view.inspectSelection().saving &&
        window.strata.view.inspect().renderedRevision !== revision,
      base.revision,
    );
    assert.equal(
      guiWrites.length,
      ["translate", "rotate", "scale"].indexOf(mode) + 2,
      "Exactly one transaction per completed drag",
    );
    assert.equal(
      (await session.page.evaluate(() => window.strata.view.inspectSelection())).orbitEnabled,
      true,
    );
  }
  await session.screenshot("editor-transformed-gizmo");
  const cancelBase = await controller.snapshot();
  const cancelPose = await session.page.evaluate(() => window.strata.view.inspectProps());
  const cancelAt = await hoverHandle("translate", "X");
  await session.page.mouse.down();
  await session.page.mouse.move(cancelAt[0] + 25, cancelAt[1] - 20, { steps: 3 });
  await session.page.keyboard.press("Escape");
  await session.page.mouse.up();
  await session.page.waitForTimeout(100);
  assert.equal(
    (await controller.snapshot()).revision,
    cancelBase.revision,
    "Escape must not commit",
  );
  assert.deepEqual(
    await session.page.evaluate(() => window.strata.view.inspectProps()),
    cancelPose,
  );
  await session.page.getByRole("button", { name: "Undo transform", exact: true }).click();
  await session.page.waitForFunction(
    (revision) =>
      !window.strata.view.inspectSelection().saving &&
      window.strata.view.inspect().renderedRevision !== revision,
    cancelBase.revision,
  );
  assert.equal(guiWrites.length, 5);
  assert.equal(
    await session.page.evaluate(() => window.strata.evaluationRequests),
    priorRequests,
    "Gizmos, cancel and undo must not evaluate terrain",
  );
  console.log(
    JSON.stringify({
      gizmoPlacement: selected.id,
      completedDragModes: ["translate", "rotate", "scale"],
      guiTransactions: guiWrites.length,
      cancelledRevision: cancelBase.revision,
    }),
  );
  const conflictBase = await controller.snapshot();
  const conflictAt = await hoverHandle("translate", "X");
  await session.page.mouse.down();
  await session.page.mouse.move(conflictAt[0] + 25, conflictAt[1] - 15, { steps: 3 });
  const retainedDraft = (await session.page.evaluate(() => window.strata.view.inspectSelection()))
    .draft;
  assert(retainedDraft);
  const externalPose = {
    ...conflictBase.document.placementOverrides[selected.id],
    position: [12, 120, -4],
  };
  const external = await controller.commit({
    baseRevision: conflictBase.revision,
    document: {
      ...conflictBase.document,
      placementOverrides: {
        ...conflictBase.document.placementOverrides,
        [selected.id]: externalPose,
        "removed-rule:candidate:1:0": freePose,
      },
    },
  });
  await session.page.waitForFunction(
    (revision) => window.strata.view.inspect().renderedRevision === revision,
    external.revision,
  );
  await session.page.mouse.up();
  await session.page.waitForFunction(
    () =>
      !window.strata.view.inspectSelection().saving &&
      document.getElementById("placement-status").textContent.includes("409"),
  );
  assert.equal(
    (await controller.snapshot()).revision,
    external.revision,
    "A stale drag must preserve the newer actor edit",
  );
  assert.deepEqual(
    (await session.page.evaluate(() => window.strata.view.inspectSelection())).draft,
    retainedDraft,
  );
  assert(
    (await session.page.locator("#placement-orphans").textContent()).includes(
      "removed-rule:candidate:1:0",
    ),
  );
  await session.page.getByRole("button", { name: "Apply transform", exact: true }).click();
  await session.page.waitForFunction(
    (revision) =>
      !window.strata.view.inspectSelection().saving &&
      window.strata.view.inspect().renderedRevision !== revision,
    external.revision,
  );
  const reapplied = await controller.snapshot();
  assert.deepEqual(reapplied.document.placementOverrides[selected.id], retainedDraft.transform);
  assert.deepEqual(reapplied.document.placementOverrides["removed-rule:candidate:1:0"], freePose);
  assert.equal(await session.page.evaluate(() => window.strata.evaluationRequests), priorRequests);
  const actorRecipe = await controller.commit({
    baseRevision: reapplied.revision,
    commands: [
      { op: "update", id: "eroded-hill", patch: { name: "Other actor keeps this layer edit" } },
    ],
  });
  await session.page.waitForFunction(
    (revision) => window.strata.view.inspect().renderedRevision === revision && !window.strata.busy,
    actorRecipe.revision,
  );
  await session.page.getByRole("button", { name: "Undo transform", exact: true }).click();
  await session.page.waitForFunction(
    (revision) =>
      !window.strata.view.inspectSelection().saving &&
      window.strata.view.inspect().renderedRevision !== revision,
    actorRecipe.revision,
  );
  const selectivelyUndone = await controller.snapshot();
  assert.equal(
    selectivelyUndone.document.recipe.layers.find((layer) => layer.id === "eroded-hill").name,
    "Other actor keeps this layer edit",
  );
  assert.deepEqual(selectivelyUndone.document.placementOverrides[selected.id], externalPose);
  const reassignEvaluationRequests = await session.page.evaluate(
    () => window.strata.evaluationRequests,
  );
  const target = beforeTransforms.find((item) => item.id !== selected.id);
  assert(target);
  await session.page
    .getByLabel("Placement", { exact: true })
    .selectOption(`placement:${target.id}`);
  await session.page.getByRole("button", { name: "Reassign to selected", exact: true }).click();
  await session.page.waitForFunction(
    (revision) => window.strata.view.inspect().renderedRevision !== revision,
    selectivelyUndone.revision,
  );
  const reassigned = await controller.snapshot();
  assert(!Object.hasOwn(reassigned.document.placementOverrides, "removed-rule:candidate:1:0"));
  assert.deepEqual(reassigned.document.placementOverrides[target.id], freePose);
  assert.deepEqual(reassigned.document.placementOverrides[selected.id], externalPose);
  const actualReassigned = await session.page.evaluate(
    (id) => window.strata.view.inspectProps().find((item) => item.id === id),
    target.id,
  );
  assert.deepEqual(actualReassigned.transform.position, freePose.position);
  actualReassigned.transform.scale.forEach((value, index) =>
    assert(Math.abs(value - freePose.scale[index]) < 1e-4),
  );
  assert.equal(
    await session.page.evaluate(() => window.strata.evaluationRequests),
    reassignEvaluationRequests,
  );
  await session.screenshot("editor-reassigned-override");
  const removeFixture = await controller.commit({
    baseRevision: reassigned.revision,
    document: {
      ...reassigned.document,
      placementOverrides: {
        ...reassigned.document.placementOverrides,
        "removed-rule:candidate:1:0": freePose,
      },
    },
  });
  await session.page.waitForFunction(
    (revision) => window.strata.view.inspect().renderedRevision === revision,
    removeFixture.revision,
  );
  await session.page.getByRole("button", { name: "Remove override", exact: true }).click();
  await session.page.waitForFunction(
    (revision) =>
      !window.strata.view.inspectSelection().saving &&
      window.strata.view.inspect().renderedRevision !== revision,
    removeFixture.revision,
  );
  const persistent = await controller.snapshot();
  assert(!Object.hasOwn(persistent.document.placementOverrides, "removed-rule:candidate:1:0"));
  const persistentMatrices = await session.page.evaluate(() => window.strata.view.inspectProps());
  await session.page.reload();
  const reloadedBridge = await connectPlaytestBridge(session.page, scenario, config.timeoutMs);
  assert(reloadedBridge, "Reload must complete a fresh runner handshake");
  await advanceFixedStep(session.page, reloadedBridge, 2);
  await session.page.waitForFunction(
    (revision) =>
      window.strata?.view.inspect().renderedRevision === revision && !window.strata.busy,
    persistent.revision,
    { timeout: 10000 },
  );
  await advanceFixedStep(session.page, session.bridge, 2);
  assert.deepEqual(
    await session.page.evaluate(() => window.strata.view.inspectProps()),
    persistentMatrices,
    "Reload must restore every actual instance matrix by durable key",
  );
  await session.page.locator('[data-tool="select"]').click();
  await session.page
    .getByLabel("Placement", { exact: true })
    .selectOption(`placement:${selected.id}`);
  await session.page.getByLabel("Ground to terrain", { exact: true }).check();
  await session.page.getByRole("button", { name: "Apply transform", exact: true }).click();
  await session.page.waitForFunction(
    (revision) =>
      !window.strata.view.inspectSelection().saving &&
      window.strata.view.inspect().renderedRevision !== revision,
    persistent.revision,
  );
  const onGround = await controller.snapshot();
  assert.equal(onGround.document.placementOverrides[selected.id].grounding, true);
  await session.page.getByRole("button", { name: "Focus selection", exact: true }).click();
  const liftAt = await hoverHandle("translate", "Y");
  await session.page.mouse.down();
  await session.page.mouse.move(liftAt[0], liftAt[1] - 35, { steps: 4 });
  await session.page.mouse.up();
  await session.page.waitForFunction(
    (revision) =>
      !window.strata.view.inspectSelection().saving &&
      window.strata.view.inspect().renderedRevision !== revision,
    onGround.revision,
  );
  const lifted = await controller.snapshot();
  assert.equal(
    lifted.document.placementOverrides[selected.id].grounding,
    false,
    "Y lift must record the named grounding override",
  );
  const liftMeasurement = await session.page.evaluate(
    (id) => window.strata.view.inspectProps().find((item) => item.id === id),
    selected.id,
  );
  assert(liftMeasurement.clearance > 0.001, JSON.stringify(liftMeasurement));
  await session.screenshot("editor-grounded-lift-gizmo");
  console.log(
    JSON.stringify({
      conflictPreserved: external.revision,
      persistedReload: persistent.revision,
      selectiveUndoLayer: "Other actor keeps this layer edit",
      liftMeasurement,
    }),
  );
  await session.page.locator('[data-tool="sculpt"]').click();
}
