import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advanceFixedStep } from "../../../packages/playtest/dist/runner/index.js";

/**
 * Every supplied tool group, driven through its own controls, checked on the shared document.
 *
 * The claim under test is narrow and specific: a control the user can reach commits a validated
 * semantic transaction to the same file an agent writes, and undo takes it back. So each step
 * clicks the real control, waits for the real save, and reads the document off disk — never an
 * internal helper — before undoing it again so the next step starts from the same recipe.
 */
export async function verifyToolGroups(session, controller) {
  const baseline = await controller.snapshot();
  const writes = [];
  const observe = (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/document"))
      writes.push(request.postDataJSON());
  };
  session.page.on("request", observe);
  // The app refuses a second save while one is in flight, so "idle" means both the build and the
  // save have finished; waiting on only one of them can read the document before the commit lands.
  const idle = async () => {
    await session.page.waitForFunction(
      () => !window.strata.busy && !window.strata.workerBusy && !document.body.dataset.saving,
      {},
      { timeout: 30000 },
    );
    await advanceFixedStep(session.page, session.bridge, 2);
  };
  const settle = async (revision) => {
    await session.page.waitForFunction(
      (value) =>
        !window.strata.busy &&
        !window.strata.workerBusy &&
        !document.body.dataset.saving &&
        window.strata.view.inspect().renderedRevision === value,
      revision,
      { timeout: 30000 },
    );
    await advanceFixedStep(session.page, session.bridge, 2);
  };
  const undo = async () => {
    await session.page.locator("#undo-btn").click();
    await idle();
  };
  const box = await session.page.locator("#viewport").boundingBox();
  assert(box, "The editor must have a viewport to click");
  // The camera this session inherits may be looking anywhere — the previous session ends on a framed
  // prop — so the ground is found by asking the view where it actually is rather than assuming a
  // screen position. A single hit plus pixel offsets misses the terrain often enough to make a
  // stroke save nothing, so the whole viewport is sampled once and each tool then takes its own hit
  // from that list, spread far enough apart to be different ground.
  await session.page.selectOption("#view-angle", "perspective");
  await session.page.locator("#frame-btn").click();
  await advanceFixedStep(session.page, session.bridge, 4);
  const ground = await session.page.evaluate(
    ([x, y, width, height]) => {
      const found = [];
      for (let row = 4; row <= 9; row += 1)
        for (let column = 2; column <= 9; column += 1) {
          const at = [x + (width * column) / 11, y + (height * row) / 14];
          if (window.strata.view.pick(...at)) found.push(at);
        }
      return found;
    },
    [box.x, box.y, box.width, box.height],
  );
  assert(
    ground.length >= 12,
    `The framed terrain must have ground under the viewport to author on, got ${ground.length} hits`,
  );
  let slot = 0;
  const point = () => ground[(slot++ * 7) % ground.length];
  const tool = async (id) => {
    await session.page.locator(`[data-tool="${id}"]`).click();
    assert.equal(
      await session.page.evaluate(() => document.body.dataset.terrainTool),
      id,
      `Tool '${id}' must become the active tool`,
    );
  };
  const layers = (snapshot) => snapshot.document.recipe.layers;
  const countFor = (snapshot, type) =>
    layers(snapshot).filter((layer) => layer.type === type).length;
  const edited = { landforms: [], surface: [], paths: [], document: [] };

  /**
   * Run one brush tool as a real drag, prove the layer reached the shared document, then undo it.
   * The stroke is what a user makes: pointer down on the terrain, a short move, pointer up.
   */
  const stroke = async (toolId, type, { move = [30, -20] } = {}) => {
    const before = await controller.snapshot();
    const counted = countFor(before, type);
    await tool(toolId);
    const at = point();
    await session.page.mouse.move(...at);
    await session.page.mouse.down();
    await session.page.mouse.move(at[0] + move[0], at[1] + move[1], { steps: 4 });
    await session.page.mouse.up();
    // The save is asynchronous, so waiting on "not busy" reads the document before the transaction
    // lands. What is being waited for is the revision itself changing.
    try {
      await session.page.waitForFunction(
        (revision) => window.strata.revision !== revision,
        before.revision,
        {
          timeout: 30000,
        },
      );
    } catch (error) {
      assert.fail(
        `${toolId} at ${JSON.stringify(at)} saved nothing: ${JSON.stringify({
          hit: await session.page.evaluate(
            ([x, y]) => document.elementFromPoint(x, y)?.className,
            at,
          ),
          pick: await session.page.evaluate(([x, y]) => window.strata.view.pick(x, y), at),
          activeTool: await session.page.evaluate(() => document.body.dataset.terrainTool),
          status: await session.page.locator("#save-status").textContent(),
          toast: await session.page.locator("#toast").textContent(),
        })}`,
      );
    }
    await idle();
    const after = await controller.snapshot();
    assert.notEqual(after.revision, before.revision, `${toolId} must save a transaction`);
    assert.equal(
      countFor(after, type),
      counted + 1,
      `${toolId} must add one '${type}' layer to the shared recipe`,
    );
    const added = layers(after).find(
      (layer) => layer.type === type && !layers(before).includes(layer),
    );
    assert(
      added,
      `${toolId}'s layer must be a new named recipe layer: ${JSON.stringify(layers(after).slice(-2))}`,
    );
    await settle(after.revision);
    return added;
  };

  // ---- Landforms ------------------------------------------------------------------------------
  for (const id of ["sculpt", "smooth", "flatten", "stamp", "erode"])
    edited.landforms.push({ tool: id, layer: (await stroke(id, id)).id });
  // A ramp needs two endpoints, so it is two clicks rather than a drag.
  const beforeRamp = await controller.snapshot();
  const ramped = countFor(beforeRamp, "ramp");
  await tool("ramp");
  await session.page.mouse.click(...point());
  await session.page.mouse.click(...point());
  await idle();
  const afterRamp = await controller.snapshot();
  assert.equal(countFor(afterRamp, "ramp"), ramped + 1, "Ramp must save one ramp layer");
  edited.landforms.push({ tool: "ramp", layer: layers(afterRamp).at(-1).id });
  await settle(afterRamp.revision);
  await session.screenshot("editor-tools-ramp");

  // ---- Surface and population -----------------------------------------------------------------
  edited.surface.push({ tool: "paint/material", layer: (await stroke("paint", "paint")).id });
  // The same tool paints a named biome when its own option says so, which is a different semantic
  // operation over the same control.
  await tool("paint");
  await session.page.locator('[data-option="mode"]').selectOption("biome");
  const beforeBiome = await controller.snapshot();
  const atBiome = point();
  await session.page.mouse.move(...atBiome);
  await session.page.mouse.down();
  await session.page.mouse.move(atBiome[0] + 30, atBiome[1] + 20, { steps: 4 });
  await session.page.mouse.up();
  await idle();
  const afterBiome = await controller.snapshot();
  const biomeLayer = layers(afterBiome).at(-1);
  assert.equal(biomeLayer.type, "biome");
  assert.equal(typeof biomeLayer.params.name, "string", "A biome paint must name its biome");
  assert.equal(biomeLayer.params.name, "forest", "The option's biome name must be the one saved");
  await settle(afterBiome.revision);
  edited.surface.push({ tool: "paint/biome", layer: biomeLayer.id });

  // Scatter and clear are the population pair, and the palette is the project's own.
  const beforeScatter = await controller.snapshot();
  const scattered = countFor(beforeScatter, "scatter");
  await tool("scatter");
  const palette = await session.page.evaluate(() =>
    [...document.querySelectorAll('[data-option="asset"] option')].map((option) => option.value),
  );
  assert(
    ["spruce", "boulder", "grass", "fern", "poppy"].some((id) => palette.includes(id)),
    `The scatter palette must be the project's own assets, got ${JSON.stringify(palette)}`,
  );
  await session.page.locator('[data-option="asset"]').selectOption("spruce");
  await session.page.locator('[data-option="count"]').fill("12");
  // The recovered controls read their options on `change`, which a number field only raises when it
  // loses focus — exactly what the next click on the terrain does to it.
  await session.page.locator('[data-option="count"]').blur();
  const atScatter = point();
  await session.page.mouse.move(...atScatter);
  await session.page.mouse.down();
  await session.page.mouse.move(atScatter[0] + 40, atScatter[1], { steps: 3 });
  await session.page.mouse.up();
  await idle();
  const afterScatter = await controller.snapshot();
  assert.equal(countFor(afterScatter, "scatter"), scattered + 1, "Scatter must add one rule");
  const scatterLayer = layers(afterScatter).at(-1);
  assert.equal(scatterLayer.params.asset, "spruce", "The chosen asset must be the one saved");
  assert.equal(scatterLayer.params.count, 12, "The requested instance count must be the one saved");
  const scatteredInstances = await session.page.evaluate(
    () => window.strata.view.inspectProps().length,
  );
  assert(
    scatteredInstances >= 100,
    `A scatter brush must place actual instances, got ${scatteredInstances}`,
  );
  await settle(afterScatter.revision);
  edited.surface.push({ tool: "scatter", layer: scatterLayer.id, instances: scatteredInstances });
  await session.screenshot("editor-tools-scatter");

  const beforeClear = await controller.snapshot();
  const cleared = countFor(beforeClear, "clear");
  await session.page.locator('[data-option="erase"]').check();
  const atClear = point();
  await session.page.mouse.move(...atClear);
  await session.page.mouse.down();
  await session.page.mouse.move(atClear[0] + 30, atClear[1], { steps: 3 });
  await session.page.mouse.up();
  await idle();
  const afterClear = await controller.snapshot();
  assert.equal(countFor(afterClear, "clear"), cleared + 1, "Clear must add one clear operation");
  assert.equal(
    layers(afterClear).at(-1).params.asset,
    "spruce",
    "Clear must name the asset it erases",
  );
  await settle(afterClear.revision);
  edited.surface.push({ tool: "scatter/clear", layer: layers(afterClear).at(-1).id });
  await session.page.locator('[data-option="erase"]').uncheck();

  // ---- Paths and water ------------------------------------------------------------------------
  /** Two or more clicks and Enter is how the recovered GUI finishes a spline. */
  const spline = async (toolId, type, extra) => {
    const before = await controller.snapshot();
    const counted = countFor(before, type);
    await tool(toolId);
    for (let index = 0; index < 3; index += 1) await session.page.mouse.click(...point());
    if (extra) await extra();
    await session.page.keyboard.press("Enter");
    await idle();
    const after = await controller.snapshot();
    assert.equal(countFor(after, type), counted + 1, `${toolId} must add one '${type}' layer`);
    await settle(after.revision);
    return layers(after).at(-1);
  };
  const road = await spline("spline", "road");
  assert.equal(road.params.width, 12, "The spline's own width option must be the one saved");
  edited.paths.push({ tool: "spline/road", layer: road.id });
  const river = await spline("spline", "river", async () => {
    await session.page.locator('[data-option="kind"]').selectOption("river");
    await session.page.locator('[data-option="depth"]').fill("6");
    await session.page.locator('[data-option="depth"]').blur();
  });
  assert.equal(river.params.depth, 6, "A river's own depth option must be the one saved");
  assert.equal(
    river.params.enforceDownhill,
    true,
    "A GUI river must keep its downhill profile rule",
  );
  edited.paths.push({ tool: "spline/river", layer: river.id });
  const lake = await stroke("water", "water");
  assert(
    ["lake", "ocean"].includes(lake.params.kind),
    `The water tool's chosen body must be saved, got ${JSON.stringify(lake.params)}`,
  );
  edited.paths.push({ tool: "water", layer: lake.id });
  await session.screenshot("editor-tools-water");

  // ---- Document: enable, reorder, duplicate, delete, undo/redo, import ------------------------
  const beforeDocument = await controller.snapshot();
  const firstId = layers(beforeDocument).at(-1).id;
  const row = session.page.locator(`.layer-list .layer-row[data-id="${firstId}"]`);
  await row.locator(".layer-eye").click();
  await idle();
  const disabled = await controller.snapshot();
  const disabledLayer = layers(disabled).find((layer) => layer.id === firstId);
  assert.equal(disabledLayer.enabled, false, "The layer eye must disable its layer on disk");
  await session.page.locator(`.layer-row[data-id="${firstId}"] .layer-eye`).click();
  await idle();
  assert.notEqual(
    layers(await controller.snapshot()).find((layer) => layer.id === firstId).enabled,
    false,
    "Re-enabling must save the layer back on disk",
  );

  await row.click();
  await session.page.locator("#layer-up").click();
  await idle();
  const moved = await controller.snapshot();
  assert.equal(
    layers(moved).indexOf(layers(moved).find((layer) => layer.id === firstId)),
    layers(moved).length - 2,
    "Move earlier must reorder the stack on disk",
  );
  await session.page.locator("#layer-duplicate").click();
  await idle();
  const duplicated = await controller.snapshot();
  const copy = layers(duplicated).at(-1);
  assert(copy.id.endsWith("-copy-1"), `Duplicate must name its copy, got ${copy.id}`);
  assert.equal(copy.name.endsWith(" copy"), true);
  const selectedCopy = session.page.locator(`.layer-row[data-id="${copy.id}"]`);
  await selectedCopy.click();
  await session.page.locator("#layer-delete").click();
  await idle();
  const deleted = await controller.snapshot();
  assert(
    !layers(deleted).some((layer) => layer.id === copy.id),
    "Delete must remove the layer from the shared document",
  );
  // Redo follows an undo, the way the recovered history is built: a fresh edit clears the redo
  // stack, so the copy comes back through undo before redo can drop it again.
  await undo();
  assert(
    layers(await controller.snapshot()).some((layer) => layer.id === copy.id),
    "Undo must put the deleted layer back",
  );
  await session.page.locator("#redo-btn").click();
  await idle();
  assert(
    !layers(await controller.snapshot()).some((layer) => layer.id === copy.id),
    "Redo must delete the layer again",
  );
  edited.document.push({
    tool: "layer enable/reorder/duplicate/delete/redo",
    layer: firstId,
    copy: copy.id,
  });
  await session.screenshot("editor-tools-document");

  // The layer inspector's own controls: opacity is a field of its own, and the JSON box is the
  // documented way to set any parameter the GUI has no control for. Both must take the same
  // validated transaction path as every other edit.
  await session.page.locator(`.layer-row[data-id="${firstId}"]`).click();
  await session.page.locator("#selected-opacity").fill("0.5");
  await session.page.locator("#selected-opacity").blur();
  await idle();
  const applied = await controller.snapshot();
  assert.equal(
    layers(applied).find((layer) => layer.id === firstId).opacity,
    0.5,
    "The layer inspector must save a layer's own opacity",
  );
  const json = JSON.parse(await session.page.locator("#selected-json").inputValue());
  json.params.level = 7;
  await session.page.locator("#selected-json").fill(JSON.stringify(json, null, 2));
  await session.page.locator("#apply-layer").click();
  await idle();
  assert.equal(
    layers(await controller.snapshot()).find((layer) => layer.id === firstId).params.level,
    7,
    "The JSON inspector must save a layer's own parameters",
  );
  // An invalid edit must be refused without touching the document.
  const beforeInvalid = await controller.snapshot();
  await session.page.locator("#selected-json").fill("{ not json");
  await session.page.locator("#apply-layer").click();
  assert(
    (await session.page.locator("#layer-error").textContent()).length > 0,
    "A malformed edit must report why",
  );
  assert.equal(
    (await controller.snapshot()).revision,
    beforeInvalid.revision,
    "A malformed edit must not change the shared document",
  );

  // Import is the recovered browser-only path, and it lands in the same document as an undoable edit.
  const temporary = mkdtempSync(join(tmpdir(), "strata-import-"));
  try {
    writeFileSync(join(temporary, "import.json"), JSON.stringify(baseline.document.recipe));
    const beforeImport = await controller.snapshot();
    await session.page.locator("#export-btn").click();
    await session.page.locator("#import-btn").click();
    await session.page.locator("#import-file").setInputFiles(join(temporary, "import.json"));
    await idle();
    await session.page.locator("#close-export").click();
    const afterImport = await controller.snapshot();
    assert.notEqual(afterImport.revision, beforeImport.revision, "An import must save an edit");
    assert.deepEqual(
      afterImport.document.recipe,
      baseline.document.recipe,
      "Importing the project's own recipe must round-trip it exactly",
    );
    await settle(afterImport.revision);
    // The existing data exports the dialog offers, taken from the file a real click downloads.
    await session.page.locator("#export-btn").click();
    const [download] = await Promise.all([
      session.page.waitForEvent("download"),
      session.page.locator('[data-export="project"]').click(),
    ]);
    const exported = {
      name: download.suggestedFilename(),
      bytes: readFileSync(await download.path()).length,
    };
    assert.match(
      exported.name,
      /\.json$/,
      `The project export must be a recipe file, got ${exported.name}`,
    );
    assert(exported.bytes > 100, "The exported recipe must contain the document");
    await session.page.locator("#close-export").click();
    edited.document.push({ tool: "import + project export", ...exported });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }

  // Undo every transaction this section made, and the document must be the one it started from: the
  // shared file is the same whichever actor edited it. The recovered history lives in this page, so
  // stepping back until it is empty unwinds exactly this section's edits and nothing older.
  assert(writes.length > 0, "Every step above must have written through the shared endpoint");
  let steps = 0;
  while (await session.page.evaluate(() => window.strata.terrain.canUndo)) {
    await undo();
    steps += 1;
    assert(
      steps <= writes.length + 4,
      "Undo must not invent history the shared endpoint never took",
    );
  }
  const restored = await controller.snapshot();
  assert.deepEqual(
    restored.document.recipe.layers.map((layer) => layer.id),
    baseline.document.recipe.layers.map((layer) => layer.id),
    `Undo must take the shared document back to where this section found it, got ${JSON.stringify(
      restored.document.recipe.layers.map((layer) => layer.id).slice(-3),
    )}`,
  );
  await settle(restored.revision);
  await session.page.locator('[data-tool="sculpt"]').click();
  console.log(JSON.stringify({ ...edited, transactions: writes.length, undone: steps }));
}
