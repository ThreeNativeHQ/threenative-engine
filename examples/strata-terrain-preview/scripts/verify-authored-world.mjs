// PRD-467 AC-8, producer half. A world is polished through the editor's real controls (a sculpt
// stroke, a scatter brush stroke, the numeric transform panel), the page is reloaded from the saved
// document, and the world is exported. What the reloaded editor and its exported GLB hold is then
// recorded in `scripts/fixtures/editor-authored.json`, which `test:consumer` reproduces from the
// packed install alone. Set RECORD=1 to rewrite the fixture; otherwise the run must reproduce it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { TerrainEditorController } from "@threenative/terrain/editor";
import { terrainEditor } from "@threenative/terrain/editor/server";
import { createServer } from "vite";
import {
  advanceFixedStep,
  parseStandalonePlaytestArgs,
  withBrowserCapture,
} from "../../../packages/playtest/dist/runner/index.js";

const FIXTURE = resolve("scripts/fixtures/editor-authored.json");
const LOOK = {
  sun: { azimuth: 200, elevation: 25, intensity: 3.2, colour: "#ffe2b8" },
  fill: { intensity: 0.35 },
  sky: { colour: "#7fb0d8" },
  fog: { mode: "exp2", colour: "#a9c4d6", density: 0.0012 },
  exposure: 1.2,
};
const SPREAD = [0, 129, 4096, 8256, 8320, 12000, 16512, 16640];
const root = resolve(".");
const temporary = mkdtempSync(join(tmpdir(), "strata-authored-"));
const path = join(temporary, "world.json");
writeFileSync(path, readFileSync("terrain/world.json"));
const plugin = terrainEditor({ documentPath: path });
const server = await createServer({
  root,
  configFile: false,
  publicDir: resolve("../../packages/terrain/starter-assets"),
  server: { host: "127.0.0.1", port: Number(process.env.EDITOR_PORT ?? 5184), strictPort: true },
  plugins: [plugin],
  optimizeDeps: { exclude: ["@threenative/terrain/editor"] },
  resolve: { dedupe: ["three"] },
});
try {
  await server.listen();
  const activation = await plugin.activate();
  const controller = new TerrainEditorController(activation.editorUrl);
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
    "artifacts/playtest/authored-world",
  ]);
  let recorded;
  await withBrowserCapture(config, async (session) => {
    const page = session.page;
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
    const idle = async () => {
      await page.waitForFunction(
        () => !window.strata.busy && !window.strata.workerBusy && !document.body.dataset.saving,
        {},
        { timeout: 30000 },
      );
      await advanceFixedStep(page, session.bridge, 2);
    };
    const ready = async () => {
      await page.waitForFunction(
        () => window.strata?.state && !window.strata.busy,
        {},
        { timeout: 60000 },
      );
      await advanceFixedStep(page, session.bridge, 2);
    };
    await ready();

    // ---- GUI edits ------------------------------------------------------------------------------
    const box = await page.locator("#viewport").boundingBox();
    assert(box, "The editor must have a viewport");
    await page.selectOption("#view-angle", "perspective");
    await page.locator("#frame-btn").click();
    await advanceFixedStep(page, session.bridge, 4);
    // Ground under the viewport, as the view reports it, and well inside the 512 m world.
    const findGround = () =>
      page.evaluate(
        ([x, y, width, height]) => {
          const found = [];
          for (let row = 4; row <= 9; row += 1)
            for (let column = 2; column <= 9; column += 1) {
              const at = [x + (width * column) / 11, y + (height * row) / 14];
              const hit = window.strata.view.pick(...at);
              if (hit && Math.abs(hit[0]) < 150 && Math.abs(hit[2]) < 150) found.push(at);
            }
          return found;
        },
        [box.x, box.y, box.width, box.height],
      );
    const ground = await findGround();
    assert(ground.length >= 4, `Not enough ground to author on: ${ground.length}`);
    const drag = async (tool, at, move) => {
      const before = await controller.snapshot();
      await page.locator(`[data-tool="${tool}"]`).click();
      await page.mouse.move(...at);
      await page.mouse.down();
      await page.mouse.move(at[0] + move[0], at[1] + move[1], { steps: 4 });
      await page.mouse.up();
      await page.waitForFunction((rev) => window.strata.revision !== rev, before.revision, {
        timeout: 30000,
      });
      await idle();
      const after = await controller.snapshot();
      assert.equal(
        after.document.recipe.layers.length,
        before.document.recipe.layers.length + 1,
        `${tool} must save one new layer`,
      );
      return after.document.recipe.layers.at(-1);
    };
    const sculpt = await drag("sculpt", ground[0], [30, -20]);
    // Samples spread over the world plus every point of the sculpt stroke, so the terrain the GUI
    // edited is among the numbers compared and not only terrain nothing touched.
    const grid = await page.evaluate(() => ({
      n: window.strata.state.resolution,
      size: window.strata.state.size,
    }));
    const samples = [
      ...SPREAD,
      ...sculpt.params.points.map(([x, z]) => {
        const cell = (v) => Math.round(((v + grid.size / 2) / grid.size) * (grid.n - 1));
        return cell(z) * grid.n + cell(x);
      }),
    ];
    await page.locator('[data-tool="scatter"]').click();
    await page.locator('[data-option="asset"]').selectOption("spruce");
    await page.locator('[data-option="count"]').fill("12");
    await page.locator('[data-option="count"]').blur();
    const scatterAt = (await findGround()).at(-1);
    const scatter = await drag("scatter", scatterAt, [40, 0]);
    assert.equal(scatter.params.asset, "spruce");
    const afterBrush = await controller.snapshot();
    await page.waitForFunction(
      (rev) => window.strata.view.inspect().renderedRevision === rev,
      afterBrush.revision,
    );
    const chosen = (await page.evaluate(() => window.strata.view.inspectProps())).find((p) =>
      p.id.startsWith(`${scatter.id}:`),
    );
    assert(
      chosen,
      `The scatter stroke must place an instance to polish: ${JSON.stringify(scatter)} ${JSON.stringify(await page.evaluate(() => [...new Set(window.strata.view.inspectProps().map((p) => p.id.split(":")[0]))]))}`,
    );
    await page.locator('[data-tool="select"]').click();
    await page.getByLabel("Placement", { exact: true }).selectOption(`placement:${chosen.id}`);
    await page.getByLabel("Position (m) Y", { exact: true }).fill("55");
    await page.getByLabel("Rotation (degrees, XYZ) Y", { exact: true }).fill("45");
    for (const [axis, value] of [
      ["X", "2"],
      ["Y", ".5"],
      ["Z", "1.5"],
    ])
      await page.getByLabel(`Scale ${axis}`, { exact: true }).fill(value);
    await page.getByLabel("Ground to terrain", { exact: true }).uncheck();
    await page.getByRole("button", { name: "Apply transform", exact: true }).click();
    await page.waitForFunction((rev) => window.strata.revision !== rev, afterBrush.revision, {
      timeout: 30000,
    });
    await idle();
    // The look the game will adopt, saved as the explicit settings the handoff carries.
    await controller.environment(
      { op: "patch", values: LOOK },
      (await controller.snapshot()).revision,
    );
    const saved = await controller.snapshot();
    await page.waitForFunction(
      (rev) => window.strata.view.inspectEnvironment().revision === rev,
      saved.revision,
      { timeout: 10000 },
    );
    assert.deepEqual(saved.document.environment, LOOK, "The environment settings were saved");
    assert(
      saved.document.placementOverrides?.[chosen.id],
      "The numeric panel must save the override",
    );
    await page.waitForFunction(
      (rev) => window.strata.view.inspect().renderedRevision === rev,
      saved.revision,
      { timeout: 30000 },
    );
    await advanceFixedStep(page, session.bridge, 2);
    const before = await page.evaluate(
      async (indices) => (await import("/scripts/fixtures/editor-readback.mjs")).readBack(indices),
      samples,
    );

    // ---- Reload: a fresh page on the saved document --------------------------------------------
    const reloaded = await page.context().newPage();
    reloaded.on("pageerror", (error) => errors.push(error.message));
    await reloaded.goto(activation.editorUrl);
    await reloaded.waitForFunction(
      (rev) =>
        window.strata?.state &&
        !window.strata.busy &&
        window.strata.view?.inspect().renderedRevision === rev,
      saved.revision,
      { timeout: 90000 },
    );
    const after = await reloaded.evaluate(
      async (indices) => (await import("/scripts/fixtures/editor-readback.mjs")).readBack(indices),
      samples,
    );
    await reloaded.close();
    assert.equal(after.revision, saved.revision, "The reloaded export names the saved revision");
    assert.deepEqual(
      after.live,
      before.live,
      "Terrain samples and placement transforms survive reload",
    );
    assert.deepEqual(after.glbHeights, after.live.heights, "The GLB terrain is the live terrain");
    assert.deepEqual(after.waterIds, ["river"]);

    // JSON round trip: the document as text commits back as the same revision.
    const roundTripped = JSON.parse(JSON.stringify(saved.document));
    assert.deepEqual(roundTripped, saved.document);
    assert.equal(
      (await controller.commit({ baseRevision: saved.revision, document: roundTripped })).revision,
      saved.revision,
    );

    // Placement matrices in the exported file: exact for the hand-posed one, and every id arrives.
    const posed = after.placements.find((p) => p.id === chosen.id);
    assert.deepEqual(
      posed.matrix.slice(12, 15).map((v) => Math.round(v * 1e4) / 1e4),
      [
        after.live.props.find((p) => p.id === chosen.id).position[0],
        55,
        after.live.props.find((p) => p.id === chosen.id).position[2],
      ].map((v) => Math.round(v * 1e4) / 1e4),
    );
    assert.deepEqual(
      after.placements.map((p) => p.id).sort(),
      after.live.props.map((p) => p.id).sort(),
    );
    assert.deepEqual(errors, []);
    recorded = {
      guiEdits: [sculpt.id, scatter.id, `override:${chosen.id}`],
      document: saved.document,
      revision: saved.revision,
      resolution: after.resolution,
      size: after.size,
      sampleIndices: samples,
      heights: after.live.heights,
      glbHeights: after.glbHeights,
      posedId: chosen.id,
      placements: after.placements.map((p) => ({
        id: p.id,
        position: p.matrix.slice(12, 15).map((v) => Math.round(v * 1e4) / 1e4),
      })),
      posedMatrix: posed.matrix.map((v) => Math.round(v * 1e6) / 1e6),
      waterIds: after.waterIds,
    };
  });
  if (process.env.RECORD === "1") {
    writeFileSync(FIXTURE, `${JSON.stringify(recorded)}\n`);
    // The repo formats JSON; the comparison below is structural, so only the layout changes.
    execFileSync(
      "pnpm",
      ["exec", "biome", "format", "--write", relative(resolve("../.."), FIXTURE)],
      {
        cwd: resolve("../.."),
        stdio: "pipe",
      },
    );
  } else {
    const committed = JSON.parse(readFileSync(FIXTURE, "utf8"));
    assert.deepEqual(
      recorded,
      committed,
      "The GUI-polished world no longer reproduces the committed fixture (RECORD=1 rewrites it)",
    );
  }
  console.log(
    JSON.stringify({
      guiEdits: recorded.guiEdits,
      revision: recorded.revision,
      placements: recorded.placements.length,
      samples: recorded.heights,
      fixtureBytes: JSON.stringify(recorded).length,
      recorded: process.env.RECORD === "1",
    }),
  );
} finally {
  await server.close();
  rmSync(temporary, { recursive: true, force: true });
}
