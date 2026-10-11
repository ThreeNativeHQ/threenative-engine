import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advanceFixedStep } from "../../../packages/playtest/dist/runner/index.js";
import { solidPng } from "../../../packages/terrain/__tests__/fixtures/png.mjs";
import { compareCaptures } from "./verify-environment.mjs";

const MAGENTA = [255, 0, 255, 255];
const TILT = [200, 128, 160, 255];
const MATTE = [250, 250, 250, 255];
const GREEN = [0, 255, 0, 255];

/**
 * AC-5: imported PBR images replace chosen live surface inputs and keep their numerical meaning.
 * The inputs are this game's own prop surfaces; each swap puts an image into a texture a material
 * already samples, so no sampler is added, and the asset loader serves a hash-named URL so a
 * replacement can never be a stale copy.
 */
export async function verifySurfaces(session, controller, captures) {
  const page = session.page;
  const folder = mkdtempSync(join(tmpdir(), "strata-surface-import-"));
  const revision = async () => (await controller.snapshot()).revision;
  const readings = () => page.evaluate(() => window.strata.view.inspectSurfaces());
  const reading = async (input) => (await readings()).find((entry) => entry.input === input);
  const waitSource = (input, source, sha) =>
    page.waitForFunction(
      ([key, wanted, hash]) =>
        window.strata.view
          .inspectSurfaces()
          .some((r) => r.input === key && r.source === wanted && (!hash || r.sha256 === hash)),
      [input, source, sha],
      { timeout: 15000 },
    );
  const requests = (needle) =>
    page.evaluate(
      (text) =>
        performance.getEntriesByType("resource").filter((r) => r.name.includes(text)).length,
      needle,
    );
  const register = async (id, name, rgba, extra = {}) => {
    const file = join(folder, name);
    writeFileSync(file, solidPng(16, 16, rgba));
    return controller.asset({ op: "register", id, path: file, ...extra }, await revision());
  };
  try {
    // The starter: five live inputs, each read in the space its channel name says.
    const starter = await readings();
    assert.deepEqual(starter.map((r) => r.input).sort(), [
      "bark.albedo",
      "bark.normal",
      "bark.roughness",
      "stone.albedo",
      "stone.normal",
    ]);
    for (const r of starter) {
      assert.equal(r.source, "starter");
      assert.equal(r.actualSpace, r.expectedSpace, `${r.input} starts in its channel's space`);
      assert.equal(r.expectedSpace, r.input.endsWith("albedo") ? "srgb" : "linear");
    }
    const barkStarterRequests = await requests("bark_brown_02");
    assert(barkStarterRequests > 0, "The starter bark maps are what draws before any mapping");

    // Both import paths: a real file input (GUI) and a local path an asset-MCP result names.
    await page.locator("#asset-inspector").evaluate((el) => {
      el.open = true;
    });
    await page.locator("#asset-file").setInputFiles({
      name: "Tint Albedo.png",
      mimeType: "image/png",
      buffer: Buffer.from(solidPng(16, 16, MAGENTA)),
    });
    await page.waitForFunction(
      () => document.querySelector("#asset-row-tint-albedo"),
      {},
      { timeout: 15000 },
    );
    const tint = (await controller.snapshot()).document.assets.find((a) => a.id === "tint-albedo");
    assert.deepEqual([tint.kind, tint.format, tint.width, tint.height], ["image", "png", 16, 16]);
    const tilt = (
      await register("tilt-normal", "tilt.png", TILT, {
        license: "CC0-1.0",
        source: "fixture://strata",
      })
    ).asset;
    const matte = (await register("matte-rough", "matte.png", MATTE)).asset;

    // GUI mapping: the row's own "use as" control, the same operation an agent calls.
    // The placement inspector crowds the sidebar; the sculpt tool's panel leaves room for the rows.
    await page.locator('[data-tool="sculpt"]').click();
    const row = page.locator("#asset-row-tint-albedo");
    await row.scrollIntoViewIfNeeded();
    await row.locator("select").selectOption("bark.albedo");
    await row.getByRole("button", { name: "Use", exact: true }).click();
    await waitSource("bark.albedo", "tint-albedo", tint.sha256);
    // The agent path for the other two.
    await controller.asset(
      { op: "map", input: "bark.normal", asset: "tilt-normal" },
      await revision(),
    );
    await controller.asset(
      { op: "map", input: "bark.roughness", asset: "matte-rough" },
      await revision(),
    );
    await waitSource("bark.normal", "tilt-normal", tilt.sha256);
    await waitSource("bark.roughness", "matte-rough", matte.sha256);

    const mapped = await readings();
    const byInput = Object.fromEntries(mapped.map((r) => [r.input, r]));
    // Numerical meaning: the bytes the texture holds are the file's bytes, unconverted, and each
    // input is configured in its channel's space, down to the GPU format the sampler reads.
    assert.deepEqual(byInput["bark.albedo"].pixel, MAGENTA);
    assert.deepEqual(byInput["bark.normal"].pixel, TILT);
    assert.deepEqual(byInput["bark.roughness"].pixel, MATTE);
    for (const r of mapped)
      assert.equal(r.actualSpace, r.expectedSpace, `${r.input} keeps its space`);
    // The GPU texture itself: an -srgb format is decoded to linear by the hardware when sampled, and
    // the others are read raw, which is the whole difference between colour and data.
    const formats = Object.fromEntries(mapped.map((r) => [r.input, r.gpuFormat]));
    assert.match(
      formats["bark.albedo"],
      /-srgb$/,
      `albedo samples as sRGB: ${JSON.stringify(formats)}`,
    );
    for (const key of ["bark.normal", "bark.roughness"])
      assert.doesNotMatch(
        formats[key],
        /srgb/,
        `${key} samples as data: ${JSON.stringify(formats)}`,
      );
    assert.equal(byInput["bark.albedo"].actualSpace, "srgb");
    assert.equal(byInput["bark.normal"].actualSpace, "linear");
    assert.equal(byInput["bark.roughness"].actualSpace, "linear");
    for (const key of ["bark.albedo", "bark.normal", "bark.roughness"])
      assert.deepEqual([byInput[key].width, byInput[key].height], [16, 16]);
    // The texture a material samples is the same object, holding a different image: no new sampler.
    for (const r of starter) {
      assert.equal(byInput[r.input].textureId, r.textureId, `${r.input} keeps its texture object`);
    }
    for (const key of ["bark.albedo", "bark.normal", "bark.roughness"])
      assert.notEqual(byInput[key].imageId, starter.find((r) => r.input === key).imageId);
    for (const key of ["stone.albedo", "stone.normal"])
      assert.equal(byInput[key].source, "starter", "An unmapped input keeps the starter art");
    assert.equal(
      await requests("bark_brown_02"),
      barkStarterRequests,
      "Mapping never reloads the starter's art",
    );
    assert.deepEqual(Object.keys((await controller.snapshot()).document.surfaces).sort(), [
      "bark.albedo",
      "bark.normal",
      "bark.roughness",
    ]);

    // The picture changes where the input is drawn: a close view of one tree before and after.
    const tree = (await page.evaluate(() => window.strata.view.inspectProps())).find((p) =>
      p.id.includes(":candidate:"),
    );
    assert(tree, "The fixture must render a prop to look at");
    await page.evaluate(
      (id) => window.strata.cameras.focus(id ? { kind: "prop", id } : undefined, {}),
      tree.id,
    );
    await advanceFixedStep(page, session.bridge, 600);
    // Time is not stepped between these captures: the wind sways the crown whenever it is, and the
    // only thing that may differ between two frames is the surface under test.
    const shot = async () => {
      await page.waitForFunction(
        (was) => window.strata.view.inspect().renderedFrames > was + 3,
        (await page.evaluate(() => window.strata.view.inspect())).renderedFrames,
        { timeout: 5000 },
      );
      return page.locator("canvas.render-canvas").screenshot();
    };
    const withMaps = await shot();
    await controller.asset({ op: "unmap", input: "bark.albedo" }, await revision());
    await waitSource("bark.albedo", "starter");
    const withoutAlbedo = await shot();
    // The focused tree fills the middle of the view; judge only that window, where the sea and the
    // sky cannot move the number.
    const crop = [0.3, 0.3, 0.4, 0.4];
    const swing = await compareCaptures(page, withMaps, withoutAlbedo, crop);
    const still = await compareCaptures(page, withoutAlbedo, await shot(), crop);
    assert(
      swing.diff > still.diff + 0.01,
      `An imported albedo must change the drawn prop: ${JSON.stringify({ swing, still })}`,
    );
    // Unmapping put the starter's original image back without a request.
    const restored = await reading("bark.albedo");
    assert.equal(restored.imageId, starter.find((r) => r.input === "bark.albedo").imageId);
    assert.equal(
      await requests("bark_brown_02"),
      barkStarterRequests,
      "Restoring the starter makes no request",
    );
    await controller.asset(
      { op: "map", input: "bark.albedo", asset: "tint-albedo" },
      await revision(),
    );
    await waitSource("bark.albedo", "tint-albedo", tint.sha256);

    // A boulder wears the stone surface across most of its pixels, so the same swap is plain to see.
    const rocks = await controller.commit({
      baseRevision: await revision(),
      commands: [
        {
          op: "upsert",
          layer: {
            id: "surface-rocks",
            type: "scatter",
            params: { asset: "boulder", count: 4, avoidWater: false },
          },
        },
      ],
    });
    await page.waitForFunction(
      (rev) =>
        window.strata.renderedRevision === rev &&
        window.strata.view.inspect().renderedRevision === rev &&
        !window.strata.busy,
      rocks.revision,
      { timeout: 30000 },
    );
    const rock = (await page.evaluate(() => window.strata.view.inspectProps())).find((p) =>
      p.id.startsWith("surface-rocks:"),
    );
    assert(rock, "The boulder layer must place a rock to look at");
    await controller.asset(
      { op: "map", input: "stone.albedo", asset: "tint-albedo" },
      await revision(),
    );
    await waitSource("stone.albedo", "tint-albedo", tint.sha256);
    await page.evaluate((id) => window.strata.cameras.focus({ kind: "prop", id }, {}), rock.id);
    await advanceFixedStep(page, session.bridge, 600);
    const stoneWith = await shot();
    await controller.asset({ op: "unmap", input: "stone.albedo" }, await revision());
    await waitSource("stone.albedo", "starter");
    const stoneWithout = await shot();
    const stoneSwing = await compareCaptures(page, stoneWith, stoneWithout, crop);
    assert(
      stoneSwing.diff > 0.5,
      `An imported stone albedo must change the drawn boulder: ${JSON.stringify(stoneSwing)}`,
    );
    await captures(session, "468-imported-surface");
    await controller.commit({
      baseRevision: await revision(),
      commands: [{ op: "remove", id: "surface-rocks" }],
    });

    // Reopen: a second page on the same saved document binds the same images.
    const fresh = await page.context().newPage();
    try {
      await fresh.goto(page.url());
      await fresh.waitForFunction(
        () => window.strata?.state && !window.strata.busy,
        {},
        { timeout: 60000 },
      );
      await fresh.waitForFunction(
        () =>
          window.strata.view.inspectSurfaces().filter((r) => r.source !== "starter").length === 3,
        {},
        { timeout: 30000 },
      );
      const reopened = await fresh.evaluate(() =>
        window.strata.view
          .inspectSurfaces()
          .map((r) => [r.input, r.source, r.sha256, r.pixel.join()]),
      );
      assert.deepEqual(reopened.filter((r) => r[1] !== "starter").sort(), [
        ["bark.albedo", "tint-albedo", tint.sha256, MAGENTA.join()],
        ["bark.normal", "tilt-normal", tilt.sha256, TILT.join()],
        ["bark.roughness", "matte-rough", matte.sha256, MATTE.join()],
      ]);
    } finally {
      await fresh.close();
      await page.bringToFront();
    }

    // Explicit replacement of one asset: a new hash-named file, the new pixels, and no stale copy.
    const tintUrls = await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .filter((r) => r.name.includes("-tint-albedo."))
        .map((r) => r.name),
    );
    const replaced = await register("tint-albedo", "tint2.png", GREEN, { replace: true });
    assert.notEqual(replaced.asset.sha256, tint.sha256);
    await waitSource("bark.albedo", "tint-albedo", replaced.asset.sha256);
    assert.deepEqual(
      (await reading("bark.albedo")).pixel,
      GREEN,
      "The replacement's pixels, not the cached ones",
    );
    const afterUrls = await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .filter((r) => r.name.includes("-tint-albedo."))
        .map((r) => r.name),
    );
    assert(afterUrls.length > tintUrls.length, "The replacement is a new hash-named request");
    assert.equal(
      await requests("bark_brown_02"),
      barkStarterRequests,
      "Replacing never reloads the starter",
    );

    // Refusals: a name that is not <surface>.<channel>, a missing image, a mapped image removed.
    const valid = await controller.snapshot();
    await assert.rejects(
      controller.asset({ op: "map", input: "bark.shine", asset: "tint-albedo" }, valid.revision),
      /must be <surface>\.<channel>/,
    );
    await assert.rejects(
      controller.asset({ op: "map", input: "bark.albedo", asset: "nope" }, valid.revision),
      /No registered image 'nope'/,
    );
    await assert.rejects(
      controller.asset({ op: "remove", id: "tint-albedo" }, valid.revision),
      /unmap it first/,
    );
    assert.equal(await revision(), valid.revision);
    // An input this game's render source does not have is saved but reported, never drawn.
    await controller.asset(
      { op: "map", input: "ground-moss.albedo", asset: "matte-rough" },
      valid.revision,
    );
    await page.waitForFunction(
      () =>
        window.strata.view
          .inspectSurfaceDiagnostics()
          .some((d) => d.includes("ground-moss.albedo")),
      {},
      { timeout: 10000 },
    );
    assert.equal(
      (await reading("bark.albedo")).source,
      "tint-albedo",
      "A bad input leaves the valid mapping alone",
    );
    await controller.asset({ op: "unmap", input: "ground-moss.albedo" }, await revision());

    // Tidy: every mapping out, every image out.
    for (const input of ["bark.albedo", "bark.normal", "bark.roughness"])
      await controller.asset({ op: "unmap", input }, await revision());
    for (const id of ["tint-albedo", "tilt-normal", "matte-rough"])
      await controller.asset({ op: "remove", id }, await revision());
    await waitSource("bark.albedo", "starter");
    assert.deepEqual(
      (await readings()).filter((r) => r.source !== "starter"),
      [],
    );
    return {
      starterRequests: barkStarterRequests,
      swing: swing.diff,
      control: still.diff,
      stone: stoneSwing.diff,
    };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
