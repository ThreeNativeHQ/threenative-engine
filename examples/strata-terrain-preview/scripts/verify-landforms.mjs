import assert from "node:assert/strict";
import { advanceFixedStep } from "../../../packages/playtest/dist/runner/index.js";

export async function verifyLandforms(session, controller) {
  await session.page.locator('[data-tool="select"]').click();
  const initial = await controller.snapshot();
  const writes = [];
  const observe = (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/document"))
      writes.push(request.postDataJSON());
  };
  session.page.on("request", observe);
  const waitRevision = async (revision) => {
    await session.page.waitForFunction(
      (value) =>
        !window.strata.busy &&
        !window.strata.view.inspectSelection().saving &&
        window.strata.view.inspect().renderedRevision === value,
      revision,
      { timeout: 5000 },
    );
    await advanceFixedStep(session.page, session.bridge, 2);
  };
  const layer = (snapshot) =>
    snapshot.document.recipe.layers.find((item) => item.id === "eroded-hill");
  await session.page.getByLabel("Placement", { exact: true }).selectOption("landform:eroded-hill");
  assert.equal(
    (await session.page.evaluate(() => window.strata.view.inspectSelection())).selectedLayer,
    "eroded-hill",
  );
  assert.equal(
    (await session.page.evaluate(() => window.strata.view.inspectSelection())).footprintVisible,
    true,
  );
  await session.page.getByRole("button", { name: "Focus selection", exact: true }).click();
  await session.page.locator('[data-transform-mode="rotate"]').click();
  assert.equal(
    await session.page.getByLabel("Rotation (degrees, XYZ) X", { exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await session.page.getByLabel("Rotation (degrees, XYZ) Z", { exact: true }).isDisabled(),
    true,
  );
  assert.deepEqual(
    (await session.page.evaluate(() => window.strata.view.inspectSelection())).rotationAxes,
    { x: false, y: true, z: false },
  );
  assert.match(await session.page.locator("#placement-clearance").innerText(), /cannot overhang/);
  assert.equal(
    await session.page.locator("#placement-grounding-label").isVisible(),
    false,
    "Prop grounding must not appear on a recipe landform",
  );
  assert.equal(await session.page.locator("#placement-reset").isVisible(), false);
  await session.screenshot("editor-landform-footprint");
  const before = await session.page.evaluate(() => window.strata.view.inspect());
  for (const [name, value] of [
    ["Position (m) X", "35"],
    ["Position (m) Y", "8"],
    ["Position (m) Z", "-25"],
    ["Rotation (degrees, XYZ) Y", "30"],
    ["Scale X", "100"],
    ["Scale Y", "1.25"],
    ["Scale Z", "75"],
  ])
    await session.page.getByLabel(name, { exact: true }).fill(value);
  await session.page.getByRole("button", { name: "Apply transform", exact: true }).click();
  await session.page.waitForFunction(() => !window.strata.view.inspectSelection().saving);
  const numeric = await controller.snapshot();
  await waitRevision(numeric.revision);
  assert.equal(writes.length, 1, "Numeric landform transform commits once");
  assert.deepEqual(layer(numeric).params.at, [35, -25]);
  assert.deepEqual(layer(numeric).params.radius, [100, 75]);
  assert.equal(layer(numeric).params.offset, 8);
  assert.equal(layer(numeric).params.scale, 1.25);
  assert(Math.abs(layer(numeric).params.rotation - 30) < 1e-6);
  assert.notEqual(
    (await session.page.evaluate(() => window.strata.view.inspect())).heightSum,
    before.heightSum,
  );
  assert.deepEqual(numeric.document.placementOverrides, initial.document.placementOverrides);
  await session.screenshot("editor-landform-numeric");
  async function hover(mode, axis) {
    await session.page.locator(`[data-transform-mode="${mode}"]`).click();
    await advanceFixedStep(session.page, session.bridge, 2);
    const handles = await session.page.evaluate(() => window.strata.view.inspectHandles());
    for (const handle of handles.filter((item) => item.axis === axis)) {
      const [x, y] = handle.at;
      if (x < 260 || x > 1140 || y < 110 || y > 860) continue;
      await session.page.mouse.move(x, y);
      if ((await session.page.evaluate(() => window.strata.view.inspectSelection())).axis === axis)
        return handle.at;
    }
    assert.fail(`No visible landform ${mode} ${axis} handle: ${JSON.stringify(handles)}`);
  }
  for (const [mode, axis, parameter] of [
    ["translate", "X", "at"],
    ["rotate", "Y", "rotation"],
    ["scale", "Y", "scale"],
    ["translate", "Y", "offset"],
  ]) {
    const base = await controller.snapshot();
    const rendered = await session.page.evaluate(() => window.strata.view.inspect());
    const count = writes.length;
    const at = await hover(mode, axis);
    await session.page.mouse.down();
    await session.page.mouse.move(at[0] + 35, at[1] - 25, { steps: 5 });
    const during = await session.page.evaluate(() => window.strata.view.inspectSelection());
    assert.equal(during.orbitEnabled, false);
    assert(during.landformDraft);
    assert.notDeepEqual(during.landformDraft.params[parameter], layer(base).params[parameter]);
    assert.equal(
      (await session.page.evaluate(() => window.strata.view.inspect())).heightSum,
      rendered.heightSum,
      "Only the footprint previews during drag; no fictional mesh moves",
    );
    assert.equal(writes.length, count);
    await session.page.mouse.up();
    await session.page.waitForFunction(() => !window.strata.view.inspectSelection().saving);
    const saved = await controller.snapshot();
    await waitRevision(saved.revision);
    assert.equal(writes.length, count + 1);
    assert.notDeepEqual(layer(saved).params[parameter], layer(base).params[parameter]);
    assert.equal(
      (await session.page.evaluate(() => window.strata.view.inspectSelection())).orbitEnabled,
      true,
    );
  }
  await session.screenshot("editor-landform-gizmo");
  const cancelBase = await controller.snapshot();
  const at = await hover("translate", "X");
  await session.page.mouse.down();
  await session.page.mouse.move(at[0] + 30, at[1] - 15, { steps: 3 });
  await session.page.keyboard.press("Escape");
  await session.page.mouse.up();
  assert.equal((await controller.snapshot()).revision, cancelBase.revision);
  const external = await controller.commit({
    baseRevision: cancelBase.revision,
    commands: [
      {
        op: "update",
        id: "eroded-hill",
        patch: { name: "Actor retains this name", params: { roughness: 0.21 } },
      },
    ],
  });
  await waitRevision(external.revision);
  await session.page.getByRole("button", { name: "Undo transform", exact: true }).click();
  await session.page.waitForFunction(() => !window.strata.view.inspectSelection().saving);
  await session.page.waitForFunction(
    (revision) => window.strata.view.inspect().renderedRevision !== revision,
    external.revision,
  );
  const undone = await controller.snapshot();
  await waitRevision(undone.revision);
  assert.equal(layer(undone).name, "Actor retains this name");
  assert.equal(layer(undone).params.roughness, 0.21);
  assert.notEqual(layer(undone).params.offset, layer(cancelBase).params.offset);
  console.log(
    JSON.stringify({
      landform: "eroded-hill",
      numeric: layer(numeric).params,
      completedDrags: ["translate X", "rotate Y", "scale Y", "translate Y"],
      cancelledRevision: cancelBase.revision,
      selectiveUndo: layer(undone).params,
    }),
  );
  for (const type of ["heightmap", "paste"]) {
    const base = await controller.snapshot();
    const id = `fixture-${type}`;
    const added = await controller.commit({
      baseRevision: base.revision,
      commands: [
        {
          op: "upsert",
          layer: {
            id,
            name: `Test ${type}`,
            type,
            params: {
              data: { width: 3, height: 3, values: [0, 0, 0, 0, 20, 0, 0, 0, 0] },
              size: [120, 80],
              at: [-80, 80],
              scale: 1,
              offset: 2,
              falloff: 0,
            },
          },
        },
      ],
    });
    await waitRevision(added.revision);
    await session.page.locator(".layer-list").getByText(`Test ${type}`, { exact: true }).click();
    assert.equal(
      (await session.page.evaluate(() => window.strata.view.inspectSelection())).selectedLayer,
      id,
    );
    const previous = await session.page.evaluate(() => window.strata.view.inspect());
    await session.page.getByLabel("Position (m) X", { exact: true }).fill("-30");
    await session.page.getByLabel("Rotation (degrees, XYZ) Y", { exact: true }).fill("90");
    await session.page.getByLabel("Scale X", { exact: true }).fill("70");
    await session.page.getByLabel("Scale Z", { exact: true }).fill("50");
    await session.page.getByLabel("Scale Y", { exact: true }).fill("1.5");
    const count = writes.length;
    await session.page.getByRole("button", { name: "Apply transform", exact: true }).click();
    await session.page.waitForFunction(() => !window.strata.view.inspectSelection().saving);
    const transformed = await controller.snapshot();
    await waitRevision(transformed.revision);
    const actual = transformed.document.recipe.layers.find((item) => item.id === id);
    assert.deepEqual(actual.params.at, [-30, 80]);
    assert.deepEqual(actual.params.size, [140, 100]);
    assert(Math.abs(actual.params.rotation - 90) < 1e-6);
    assert.equal(actual.params.scale, 1.5);
    assert.equal(writes.length, count + 1);
    assert.notEqual(
      (await session.page.evaluate(() => window.strata.view.inspect())).heightSum,
      previous.heightSum,
    );
    await session.page.getByRole("button", { name: "Focus selection", exact: true }).click();
    await advanceFixedStep(session.page, session.bridge, 2);
    await session.screenshot(`editor-landform-${type}`);
    console.log(
      JSON.stringify({
        landformType: type,
        transformed: actual.params,
        renderedRevision: transformed.revision,
      }),
    );
    const removed = await controller.commit({
      baseRevision: transformed.revision,
      commands: [{ op: "remove", id }],
    });
    await waitRevision(removed.revision);
  }
  const identityBase = await controller.snapshot();
  const identityFixture = await controller.commit({
    baseRevision: identityBase.revision,
    commands: [
      {
        op: "upsert",
        layer: {
          id: "landform",
          type: "scatter",
          params: { asset: "spruce", count: 1, avoidWater: false },
        },
      },
    ],
  });
  await waitRevision(identityFixture.revision);
  const placement = await session.page.evaluate(() =>
    window.strata.view.inspectProps().find((item) => item.id.startsWith("landform:")),
  );
  assert(placement, "A scatter layer named landform must produce an ordinary placement");
  await session.page
    .getByLabel("Placement", { exact: true })
    .selectOption(`placement:${placement.id}`);
  const identitySelection = await session.page.evaluate(() =>
    window.strata.view.inspectSelection(),
  );
  assert.equal(identitySelection.selected, placement.id);
  assert.equal(identitySelection.selectedLayer, undefined);
  console.log(JSON.stringify({ namespaceSafePlacement: placement.id }));
  session.page.off("request", observe);
  const restored = await controller.commit({
    baseRevision: (await controller.snapshot()).revision,
    document: initial.document,
  });
  await waitRevision(restored.revision);
  await session.page.locator('[data-tool="sculpt"]').click();
}
