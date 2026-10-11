import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advanceFixedStep } from "../../../packages/playtest/dist/runner/index.js";
import { buildGlb } from "../../../packages/terrain/__tests__/fixtures/glb.mjs";

const FEET = 3.28084;
const near = (actual, expected, tolerance, message) =>
  assert(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);

/**
 * AC-4: a custom GLB enters the palette through the agent path and the GUI path, is placed,
 * selected and transformed in the live editor, survives a reopen, and a bad file is named and
 * leaves the valid art alone.
 */
export async function verifyModelImport(session, controller, captures) {
  const page = session.page;
  const folder = mkdtempSync(join(tmpdir(), "strata-model-import-"));
  const revision = async () => (await controller.snapshot()).revision;
  const status = (id) =>
    page.evaluate((key) => window.strata.view.inspectAssets().find((a) => a.id === key), id);
  const ready = (id, sha) =>
    page.waitForFunction(
      ([key, hash]) =>
        window.strata.view
          .inspectAssets()
          .some((a) => a.id === key && a.status === "ready" && (!hash || a.sha256 === hash)),
      [id, sha],
      { timeout: 15000 },
    );
  const rendered = (value) =>
    page.waitForFunction(
      (target) =>
        window.strata.renderedRevision === target &&
        window.strata.view.inspect().renderedRevision === target &&
        !window.strata.busy,
      value,
      { timeout: 30000 },
    );
  const placed = (layer) =>
    page.evaluate(
      (prefix) =>
        window.strata.view.inspectProps().filter((prop) => prop.id.startsWith(`${prefix}:`)),
      layer,
    );
  const height = async (id) => {
    const bounds = await page.evaluate(
      (key) => window.strata.cameras.resolve({ kind: "prop", id: key }),
      id,
    );
    assert(bounds, `Placement '${id}' must have measurable bounds`);
    return bounds.max[1] - bounds.min[1];
  };
  try {
    const requests = await page.evaluate(() => window.strata.evaluationRequests);

    // The agent path: a local file, as an asset-MCP download result names it, in feet.
    const feetFile = join(folder, "oak-in-feet.glb");
    writeFileSync(feetFile, buildGlb({ unit: FEET }));
    const registered = await controller.asset(
      {
        op: "register",
        id: "feet-tree",
        path: feetFile,
        license: "CC0-1.0",
        source: "fixture://strata-model-import",
      },
      await revision(),
    );
    const entry = registered.asset;
    assert.equal(entry.triangles, 24);
    near(entry.bounds.max[1], 2.4 * FEET, 1e-3, "The file is measured in its own units");
    await ready("feet-tree", entry.sha256);
    near(
      (await status("feet-tree")).bounds.max[1],
      2.4 * FEET,
      1e-2,
      "Unadjusted, the model is feet",
    );
    // The scale override: feet to metres, saved beside the file, never written into it.
    await controller.asset(
      { op: "adjust", id: "feet-tree", adjust: { scale: 1 / FEET, pivot: "base" } },
      await revision(),
    );
    await page.waitForFunction(
      () =>
        window.strata.view
          .inspectAssets()
          .some((a) => a.id === "feet-tree" && Math.abs(a.bounds?.max[1] - 2.4) < 1e-2),
      {},
      { timeout: 15000 },
    );
    const metres = await status("feet-tree");
    near(metres.bounds.min[1], 0, 1e-3, "The base pivot sits the model on its placement");
    assert.equal(
      (await controller.snapshot()).document.assets[0].sha256,
      entry.sha256,
      "Adjusting never edits the file",
    );

    // The GUI path: a real file input, the same operations underneath.
    await page.locator("#asset-inspector").evaluate((el) => {
      el.open = true;
    });
    const guiFile = buildGlb({ unit: 1, extras: false });
    await page.locator("#asset-file").setInputFiles({
      name: "Gui Rock.glb",
      mimeType: "model/gltf-binary",
      buffer: Buffer.from(guiFile),
    });
    await page.waitForFunction(
      () => document.querySelector("#asset-row-gui-rock"),
      {},
      { timeout: 15000 },
    );
    await ready("gui-rock");
    const gui = (await controller.snapshot()).document.assets.find((a) => a.id === "gui-rock");
    assert.equal(gui.name, "Gui Rock.glb");

    // Both are in the palette the scatter tool offers.
    assert.deepEqual(
      await page.evaluate(() =>
        window.strata.view
          .propAssets()
          .filter((id) => /^(feet-tree|gui-rock)$/.test(id))
          .sort(),
      ),
      ["feet-tree", "gui-rock"],
    );
    await page.locator('[data-tool="scatter"]').click();
    const options = await page
      .locator('[data-option="asset"] option')
      .evaluateAll((nodes) => nodes.map((node) => node.value));
    assert(options.includes("feet-tree") && options.includes("gui-rock"), `Palette: ${options}`);

    // Placement: a scatter layer naming the imported id draws real instances of the model.
    const before = await controller.snapshot();
    const grove = await controller.commit({
      baseRevision: before.revision,
      commands: [
        {
          op: "upsert",
          layer: {
            id: "feet-grove",
            type: "scatter",
            params: { asset: "feet-tree", count: 6, avoidWater: false },
          },
        },
        {
          op: "upsert",
          layer: {
            id: "rock-grove",
            type: "scatter",
            params: { asset: "gui-rock", count: 3, avoidWater: false },
          },
        },
      ],
    });
    await rendered(grove.revision);
    const trees = await placed("feet-grove");
    assert(trees.length >= 1, "The imported model must be placed");
    assert((await placed("rock-grove")).length >= 1, "The GUI-imported model must be placed");
    for (const tree of trees.slice(0, 3)) {
      near(
        await height(tree.id),
        2.4 * tree.transform.scale[1],
        0.05 * 2.4 * tree.transform.scale[1],
        `A placed tree is 2.4 m times its own scale (${tree.id})`,
      );
    }

    // Select one instance through the real mesh and scale it with the individual transform fields.
    const target = trees[0];
    await page.locator('[data-tool="select"]').click();
    await page.getByLabel("Placement", { exact: true }).selectOption(`placement:${target.id}`);
    await page.getByRole("button", { name: "Focus selection", exact: true }).click();
    await advanceFixedStep(page, session.bridge, 4);
    const clickAt = await page.evaluate((id) => window.strata.view.projectPlacement(id), target.id);
    assert(clickAt, "An imported placement must project to the screen");
    await page.getByLabel("Placement", { exact: true }).selectOption("");
    await page.mouse.click(...clickAt);
    assert.equal(
      (await page.evaluate(() => window.strata.view.inspectSelection())).selected,
      target.id,
      "A real click on the imported mesh selects its placement",
    );
    for (const axis of ["X", "Y", "Z"])
      await page.getByLabel(`Scale ${axis}`, { exact: true }).fill("2");
    const preScale = await revision();
    await page.getByRole("button", { name: "Apply transform", exact: true }).click();
    await page.waitForFunction(
      (rev) =>
        !window.strata.view.inspectSelection().saving &&
        window.strata.view.inspect().renderedRevision !== rev,
      preScale,
      { timeout: 15000 },
    );
    const scaled = await controller.snapshot();
    assert.deepEqual(scaled.document.placementOverrides[target.id].scale, [2, 2, 2]);
    near(await height(target.id), 4.8, 0.2, "The scaled instance is twice the measured model");
    assert.equal(
      await page.evaluate(() => window.strata.evaluationRequests),
      requests + 1,
      "Placing a layer evaluates the recipe once; transforming one instance never does",
    );
    await advanceFixedStep(page, session.bridge, 4);
    await captures(session, "468-imported-model");

    // Reopen: a second page on the same saved document draws the same placements and models.
    const fresh = await page.context().newPage();
    try {
      await fresh.goto(page.url());
      await fresh.waitForFunction(
        () => window.strata?.state && !window.strata.busy,
        {},
        { timeout: 60000 },
      );
      await fresh.waitForFunction(
        (rev) => window.strata.view.inspect().renderedRevision === rev,
        scaled.revision,
        { timeout: 60000 },
      );
      const reopened = await fresh.evaluate(() => ({
        assets: window.strata.view.inspectAssets().map((a) => [a.id, a.status, a.sha256]),
        trees: window.strata.view.inspectProps().filter((p) => p.id.startsWith("feet-grove:")),
      }));
      assert.deepEqual(
        reopened.assets.sort(),
        [
          ["feet-tree", "ready", entry.sha256],
          ["gui-rock", "ready", gui.sha256],
        ].sort(),
      );
      assert.equal(reopened.trees.length, trees.length);
      for (const value of reopened.trees.find((p) => p.id === target.id).transform.scale)
        near(value, 2, 1e-6, "The saved instance scale survives a reopen");
    } finally {
      await fresh.close();
      await page.bringToFront();
    }

    // Bad files are named, and none of them replaces valid art or leaves the project.
    const valid = await controller.snapshot();
    const refuse = async (operation, pattern) => {
      await assert.rejects(controller.asset(operation, valid.revision), pattern);
      assert.equal(await revision(), valid.revision, "A refused import leaves the revision");
    };
    const external = join(folder, "external.glb");
    writeFileSync(external, buildGlb({ external: true }));
    await refuse(
      { op: "register", id: "bad", path: external },
      /external buffer 'missing-textures\.bin'/,
    );
    const nan = join(folder, "nan.glb");
    writeFileSync(nan, buildGlb({ nan: true }));
    await refuse({ op: "register", id: "bad", path: nan }, /non-finite vertex/);
    await refuse({ op: "register", id: "bad", path: "../../etc/passwd" }, /absolute/);
    const different = join(folder, "different.glb");
    writeFileSync(different, buildGlb({ unit: 1, extras: false }));
    await refuse(
      { op: "register", id: "feet-tree", path: different },
      /already exists.*replace: true/,
    );
    // A page may not name a path at all: the same operation with an Origin header is refused.
    const fromPage = await fetch(new URL("assets", controller.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json", origin: new URL(controller.baseUrl).origin },
      body: JSON.stringify({
        baseRevision: valid.revision,
        operation: { op: "register", id: "page-read", path: feetFile },
      }),
    });
    assert.equal(fromPage.status, 403);
    // The GUI names a garbage file and keeps everything it had.
    await page.locator("#asset-file").setInputFiles({
      name: "garbage.glb",
      mimeType: "model/gltf-binary",
      buffer: Buffer.from("this is not a model"),
    });
    await page.waitForFunction(
      () => document.getElementById("asset-error").textContent.includes("not a supported"),
      {},
      { timeout: 5000 },
    );
    assert.deepEqual((await controller.snapshot()).document.assets, valid.document.assets);
    assert.equal((await placed("feet-grove")).length, trees.length, "Valid art stays placed");
    assert.equal((await status("feet-tree")).status, "ready");

    // Replace with explicit consent: the placements stay and take the new model.
    const swap = await controller.asset(
      { op: "register", id: "feet-tree", path: different, replace: true },
      await revision(),
    );
    assert.notEqual(swap.asset.sha256, entry.sha256);
    await ready("feet-tree", swap.asset.sha256);
    assert.equal((await placed("feet-grove")).length, trees.length);

    // Tidy: layers out, palette entries out, so the next stage sees the project it started with.
    const cleanup = await controller.commit({
      baseRevision: await revision(),
      commands: [
        { op: "remove", id: "feet-grove" },
        { op: "remove", id: "rock-grove" },
      ],
    });
    await rendered(cleanup.revision);
    await controller.asset({ op: "remove", id: "feet-tree" }, await revision());
    await controller.asset({ op: "remove", id: "gui-rock" }, await revision());
    await page.waitForFunction(
      () => window.strata.view.inspectAssets().length === 0,
      {},
      { timeout: 5000 },
    );
    assert(
      !(await page.evaluate(() => window.strata.view.propAssets())).includes("feet-tree"),
      "A removed palette entry leaves the palette",
    );
    return { placed: trees.length };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
