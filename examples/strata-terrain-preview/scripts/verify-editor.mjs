import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TerrainEditorController } from "@threenative/terrain/editor";
import { terrainEditor } from "@threenative/terrain/editor/server";
import { createServer } from "vite";
import {
  advanceFixedStep,
  parseStandalonePlaytestArgs,
  runStandalonePlaytest,
  withBrowserCapture,
} from "../../../packages/playtest/dist/runner/index.js";

import { verifyModelImport } from "./verify-assets.mjs";
import { verifyEditorCameras } from "./verify-cameras.mjs";
import { verifyEnvironment } from "./verify-environment.mjs";
import { verifyLandforms } from "./verify-landforms.mjs";
import { verifySky } from "./verify-sky.mjs";
import { verifySurfaces } from "./verify-surfaces.mjs";
import { verifyToolGroups } from "./verify-tool-groups.mjs";
import { verifyPropTransforms } from "./verify-transforms.mjs";

const root = resolve(".");
const temporary = mkdtempSync(join(tmpdir(), "strata-editor-proof-"));
const path = join(temporary, "world.json");
writeFileSync(path, readFileSync("terrain/world.json"));
const plugin = terrainEditor({ documentPath: path });
const server = await createServer({
  root,
  configFile: false,
  // The game's own starter maps, served as the real dev server serves them: the surface proof binds
  // imported images into these textures, so they have to be the ones that loaded.
  publicDir: resolve("../../packages/terrain/starter-assets"),
  server: { host: "127.0.0.1", port: Number(process.env.EDITOR_PORT ?? 5197) },
  plugins: [plugin],
  optimizeDeps: { exclude: ["@threenative/terrain/editor"] },
  resolve: { dedupe: ["three"] },
});
try {
  await server.listen();
  const activation = await plugin.activate();
  const controller = new TerrainEditorController(activation.editorUrl);
  assert.deepEqual(await controller.activate(), activation);
  let captured = false;
  const config = parseStandalonePlaytestArgs([
    "--scenario",
    "playtests/editor.playtest.json",
    "--url",
    activation.editorUrl,
    "--browser-recipe",
    "webgpu",
    "--headed",
    "--timeout",
    "120000",
    "--artifacts",
    "artifacts/playtest/editor",
  ]);
  await withBrowserCapture(config, async (session) => {
    const errors = [];
    session.page.on("pageerror", (error) => errors.push(error.message));
    session.page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await session.page.waitForFunction(
      () => window.strata?.state && !window.strata.busy,
      {},
      { timeout: 10000 },
    );
    await advanceFixedStep(session.page, session.bridge, 2);
    await session.screenshot("editor-initial");
    const observed = [];
    for (const amplitude of [30, 80, 50]) {
      const before = await controller.snapshot();
      const accepted = await controller.commit({
        baseRevision: before.revision,
        commands: [{ op: "update", id: "eroded-hill", patch: { params: { amplitude } } }],
      });
      const start = performance.now();
      await session.page.waitForFunction(
        (revision) => window.strata?.renderedRevision === revision,
        accepted.revision,
        { timeout: 2000 },
      );
      await advanceFixedStep(session.page, session.bridge, 2);
      const actual = await session.page.evaluate(() => window.strata.view.inspect());
      assert.equal(actual.renderedRevision, accepted.revision);
      assert(actual.vertexCount === 16641);
      // One placement can draw several instanced parts, so the placement count is the fixture.
      const placements = await session.page.evaluate(
        () => window.strata.view.inspectProps().length,
      );
      assert.equal(placements, 100, "The latency fixture must scatter 100 prop placements");
      assert(actual.propCount >= 100, "Every placement must reach the renderer");
      assert(actual.propTriangles > 0, "The observed instances must contain real triangles");
      const latencyMs = performance.now() - start;
      assert(latencyMs < 2000);
      observed.push({
        amplitude,
        revision: accepted.revision,
        heightSum: actual.heightSum,
        propCount: actual.propCount,
        propTriangles: actual.propTriangles,
        latencyMs,
      });
      await session.screenshot(`editor-hill-${amplitude}`);
    }
    assert.equal(
      new Set(observed.map((item) => item.heightSum)).size,
      3,
      "Three accepted revisions must change rendered geometry",
    );
    assert.equal(new Set(observed.map((item) => item.revision)).size, 3);
    await verifyPropTransforms(session, controller, config);
    await verifyLandforms(session, controller);
    // Every capture the PRD tracks is copied out of the artifact tree as it is taken.
    const captures = async (captureSession, name) => {
      const taken = await captureSession.screenshot(name);
      const directory = resolve("../../docs/verification/visuals/strata");
      mkdirSync(directory, { recursive: true });
      copyFileSync(taken, `${directory}/${name}.png`);
    };
    const validPreview = await session.page.evaluate(() => window.strata.view.inspect());
    const beforeMissing = await controller.snapshot();
    await controller.commit({
      baseRevision: beforeMissing.revision,
      commands: [
        {
          op: "upsert",
          layer: {
            id: "missing-model",
            type: "scatter",
            params: { asset: "missing-fixture", count: 1, avoidWater: false },
          },
        },
      ],
    });
    await session.page.waitForFunction(
      () => document.getElementById("save-status")?.textContent.includes("Preview failed"),
      {},
      { timeout: 2000 },
    );
    assert.equal(await session.page.evaluate(() => window.strata.busy), false);
    assert.match(await session.page.locator("#toast").textContent(), /missing-fixture/);
    const afterFailure = await session.page.evaluate(() => window.strata.view.inspect());
    assert.equal(
      afterFailure.renderedRevision,
      validPreview.renderedRevision,
      `a failed preview must retain its last valid geometry: ${JSON.stringify({ validPreview, afterFailure })} ${JSON.stringify(await session.page.evaluate(() => (window.__trace ?? []).slice(-14)))}`,
    );
    assert.equal(
      (await session.page.evaluate(() => window.strata.view.inspectProps())).length,
      100,
      "The retained preview must keep every scattered placement",
    );
    const broken = await controller.snapshot();
    const retainedProps = await session.page.evaluate(() => window.strata.view.inspectProps());
    const overrideKey = Object.keys(broken.document.placementOverrides)[0];
    assert(overrideKey, "The saved gizmo transform must remain in the failed document");
    const metadataWhileBroken = await controller.commit({
      baseRevision: broken.revision,
      document: {
        ...broken.document,
        placementOverrides: {
          ...broken.document.placementOverrides,
          [overrideKey]: {
            ...broken.document.placementOverrides[overrideKey],
            position: [12, 140, -4],
          },
        },
      },
    });
    await session.page.waitForFunction(
      (revision) => window.strata.revision === revision,
      metadataWhileBroken.revision,
    );
    const acceptedFrame = await session.page.evaluate(
      () => window.strata.view.inspect().renderedFrames,
    );
    await session.page.waitForFunction(
      (frame) => window.strata.view.inspect().renderedFrames > frame,
      acceptedFrame,
    );
    assert.equal(
      (await session.page.evaluate(() => window.strata.view.inspect())).renderedRevision,
      validPreview.renderedRevision,
      "Metadata cannot label retained geometry as a successful newer recipe",
    );
    assert.equal(
      await session.page.evaluate(() => window.strata.renderedRevision),
      validPreview.renderedRevision,
      "The recovered GUI must retain the actual rendered recipe revision",
    );
    assert.deepEqual(
      await session.page.evaluate(() => window.strata.view.inspectProps()),
      retainedProps,
      "Metadata for a failed recipe must retain every last-valid instance matrix",
    );
    await session.screenshot("editor-retained-recipe");
    const modelRecovery = await controller.commit({
      baseRevision: metadataWhileBroken.revision,
      commands: [{ op: "remove", id: "missing-model" }],
    });
    await session.page.waitForFunction(
      (revision) =>
        window.strata.renderedRevision === revision &&
        !window.strata.busy &&
        !window.strata.workerBusy,
      modelRecovery.revision,
      { timeout: 2000 },
    );
    await session.page.waitForFunction(
      (revision) => window.strata.view.inspect().renderedRevision === revision,
      modelRecovery.revision,
    );
    const recoveredPose = await session.page.evaluate(
      (id) => window.strata.view.inspectProps().find((item) => item.id === id),
      overrideKey,
    );
    assert.equal(
      recoveredPose.transform.position[1],
      140,
      "Recovery must apply the deferred metadata pose",
    );
    await advanceFixedStep(session.page, session.bridge, 2);
    await session.page.locator("#selected-name").fill("Human-polished hill");
    await session.page.locator("#selected-name").press("Tab");
    await session.page.waitForFunction(() => !document.body.dataset.saving, {}, { timeout: 2000 });
    const saved = await controller.snapshot();
    assert(saved.document.recipe.layers.some((layer) => layer.name === "Human-polished hill"));
    await session.screenshot("editor-gui-edit");
    const reactivation = await controller.activate();
    assert.equal(reactivation.projectId, activation.projectId);
    assert.equal(reactivation.sessionId, activation.sessionId);
    assert.equal(reactivation.revision, saved.revision);
    // AC-9: the GUI probe and the headless endpoint must agree on one rendered revision.
    const probe = { kind: "profile", from: [-40, 20], to: [30, -25] };
    await session.page.waitForFunction(
      (revision) => window.strata?.renderedRevision === revision,
      saved.revision,
      { timeout: 5000 },
    );
    const guiProfile = await session.page.evaluate((query) => window.strata.inspect(query), probe);
    const headlessProfile = (await controller.inspect(probe, saved.revision)).result;
    assert.deepEqual(
      guiProfile,
      headlessProfile,
      "GUI and headless spatial inspection must agree on the same revision",
    );
    const prior = await session.page.evaluate(() => window.strata.view.inspect());
    const current = await controller.snapshot();
    await controller.commit({
      baseRevision: current.revision,
      commands: [
        {
          op: "upsert",
          layer: {
            id: "long-erosion",
            type: "erode",
            params: { method: "hydraulic", droplets: 200000, maxSteps: 100 },
          },
        },
      ],
    });
    await session.page.waitForFunction(() => window.strata.workerBusy, {}, { timeout: 2000 });
    const pendingDocument = await controller.snapshot();
    const pendingMatrices = await session.page.evaluate(() => window.strata.view.inspectProps());
    const pendingRequests = await session.page.evaluate(() => window.strata.evaluationRequests);
    const pendingMetadata = await controller.commit({
      baseRevision: pendingDocument.revision,
      document: {
        ...pendingDocument.document,
        placementOverrides: {
          ...pendingDocument.document.placementOverrides,
          [overrideKey]: {
            ...pendingDocument.document.placementOverrides[overrideKey],
            position: [12, 150, -4],
          },
        },
      },
    });
    await session.page.waitForFunction(
      (revision) => window.strata.revision === revision,
      pendingMetadata.revision,
    );
    const pendingFrame = await session.page.evaluate(
      () => window.strata.view.inspect().renderedFrames,
    );
    await session.page.waitForFunction(
      (frame) => window.strata.view.inspect().renderedFrames > frame,
      pendingFrame,
    );
    assert.equal(await session.page.evaluate(() => window.strata.workerBusy), true);
    assert.equal(
      (await session.page.evaluate(() => window.strata.view.inspect())).renderedRevision,
      prior.renderedRevision,
    );
    assert.equal(
      await session.page.evaluate(() => window.strata.renderedRevision),
      prior.renderedRevision,
    );
    assert.deepEqual(
      await session.page.evaluate(() => window.strata.view.inspectProps()),
      pendingMatrices,
    );
    assert.equal(
      await session.page.evaluate(() => window.strata.evaluationRequests),
      pendingRequests,
      "Metadata must not replace or restart pending erosion",
    );
    await session.page.locator("#cancel-build").click();
    await session.page.waitForFunction(() => !window.strata.busy, {}, { timeout: 2000 });
    assert.equal(
      (await session.page.evaluate(() => window.strata.view.inspect())).heightSum,
      prior.heightSum,
      "Cancellation must retain the last valid geometry",
    );
    await session.screenshot("editor-cancelled");
    const canceled = await controller.snapshot();
    const recovered = await controller.commit({
      baseRevision: canceled.revision,
      commands: [{ op: "remove", id: "long-erosion" }],
    });
    await session.page.waitForFunction(
      (revision) =>
        window.strata.renderedRevision === revision &&
        !window.strata.busy &&
        !window.strata.workerBusy,
      recovered.revision,
      { timeout: 2000 },
    );
    await advanceFixedStep(session.page, session.bridge, 2);
    assert.equal(
      (await session.page.evaluate(() => window.strata.view.inspect())).renderedRevision,
      recovered.revision,
    );
    const latestPose = await session.page.evaluate(
      (id) => window.strata.view.inspectProps().find((item) => item.id === id),
      overrideKey,
    );
    assert.equal(
      latestPose.transform.position[1],
      150,
      "Recovery must retain the accepted metadata from the cancelled evaluation",
    );
    // Last: the camera block owns its document edits and needs nothing from the sections above.
    await verifyEditorCameras(session, controller, captures);
    assert.deepEqual(
      errors,
      ["Failed to load resource: the server responded with a status of 409 (Conflict)"],
      "Only the deliberately injected stale GUI transaction may produce a console error",
    );
    console.log(
      JSON.stringify({
        editorUrl: activation.editorUrl,
        projectId: activation.projectId,
        observed,
        provenance: session.provenance,
      }),
    );
    captured = true;
  });
  // The tool groups make dozens of terrain edits and undo every one of them, which is more work
  // than one capture session's budget covers. They run in a second session against the same live
  // editor and the same document, so the shared-file claim is tested across two browser sessions
  // rather than inside one.
  assert(captured, "The integration session must finish before the tool-group session");
  // Dozens of committed edits, each one a full rebuild with its own save and undo, take far longer
  // than the other stages of this proof, so this session carries its own budget rather than
  // shortening the work to fit the first stage's.
  await withBrowserCapture({ ...config, timeoutMs: 900000 }, async (session) => {
    await session.page.waitForFunction(
      () => window.strata?.state && !window.strata.busy,
      {},
      {
        timeout: 30000,
      },
    );
    await advanceFixedStep(session.page, session.bridge, 2);
    await verifyToolGroups(session, controller);
  });
  // The world controls (environment, imported models) compare captures of one fixed view, so they get
  // their own fresh page on the ordinary editor camera, not the state the camera block leaves behind.
  await controller.camera({ op: "activate", id: null }, (await controller.snapshot()).revision);
  await withBrowserCapture(config, async (session) => {
    const errors = [];
    session.page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await session.page.waitForFunction(
      () => window.strata?.state && !window.strata.busy,
      {},
      { timeout: 30000 },
    );
    await advanceFixedStep(session.page, session.bridge, 2);
    // These captures stay in the run's artifacts: the tracked evidence tree is at its size cap, so
    // the proof is the numbers the stages assert, not more committed pictures.
    const worldCaptures = (captureSession, name) => captureSession.screenshot(name);
    console.log(
      JSON.stringify({ environment: await verifyEnvironment(session, controller, worldCaptures) }),
    );
    console.log(
      JSON.stringify({ models: await verifyModelImport(session, controller, worldCaptures) }),
    );
    console.log(
      JSON.stringify({ surfaces: await verifySurfaces(session, controller, worldCaptures) }),
    );
    console.log(JSON.stringify({ sky: await verifySky(session, controller, worldCaptures) }));
    assert.deepEqual(
      errors,
      [
        // The environment proof's rejected GUI value (a negative sun intensity), the model proof's
        // garbage GUI file, and the sky proof's garbage GUI file: each is a deliberate 400. The
        // sky proof's deliberately undecodable image is a failed load the view reports itself.
        "Failed to load resource: the server responded with a status of 400 (Bad Request)",
        "Failed to load resource: the server responded with a status of 400 (Bad Request)",
        "Failed to load resource: the server responded with a status of 400 (Bad Request)",
      ],
      "Only the deliberately rejected GUI imports may produce a console error",
    );
  });
  const report = await runStandalonePlaytest(config);
  assert(report.assertionResults?.length > 0, "Scenario assertions were not observed");
  assert(
    report.assertionResults.every((result) => result.pass),
    JSON.stringify(report.assertionResults),
  );
  assert(
    !report.diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    JSON.stringify(report.diagnostics),
  );
} finally {
  await server.close();
  rmSync(temporary, { recursive: true, force: true });
}
