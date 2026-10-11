import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advanceFixedStep } from "../../../packages/playtest/dist/runner/index.js";
import {
  buildHdr,
  solidPng,
  undecodablePng,
} from "../../../packages/terrain/__tests__/fixtures/png.mjs";
import { compareCaptures } from "./verify-environment.mjs";

/** A 64x32 equirect sky: a blue dome, dark ground, and a sun blob of radiance `sun` at (sx, 8). */
const sky = (sun, sx) =>
  buildHdr(64, 32, (x, y) => {
    const blob = Math.exp(-((x - sx) ** 2 + (y - 8) ** 2) / 8) * sun;
    return y < 16 ? [0.4 + blob, 0.6 + blob, 1.2 + blob] : [0.05, 0.04, 0.03];
  });

const near = (actual, expected, tolerance, message) =>
  assert(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);

/**
 * AC-6: imported environment imagery changes the actual background and illumination, independently,
 * keeps its HDR radiance, rotates and scales, goes back to the procedural sky, is replaceable, and
 * a bad image never costs the valid scene.
 */
export async function verifySky(session, controller, captures) {
  const page = session.page;
  const folder = mkdtempSync(join(tmpdir(), "strata-sky-import-"));
  const revision = async () => (await controller.snapshot()).revision;
  const live = () => page.evaluate(() => window.strata.view.inspectEnvironment());
  const without = ({ revision: _revision, ...rest }) => rest;
  const operate = async (values) =>
    controller.environment({ op: "patch", values }, await revision());
  const state = async (slot, wanted) => {
    try {
      await page.waitForFunction(
        ([key, value]) => window.strata.view.inspectEnvironment().images[key].state === value,
        [slot, wanted],
        { timeout: 20000 },
      );
    } catch (error) {
      throw new Error(
        `${slot} never became ${wanted}: ${JSON.stringify(await live())} saved=${JSON.stringify((await controller.snapshot()).document.environment)} gui=${await page.evaluate(() => document.getElementById("environment-error").textContent)} (${error.message})`,
      );
    }
  };
  const shot = async () => {
    await advanceFixedStep(page, session.bridge, 30);
    await page.waitForFunction(
      (was) => window.strata.view.inspect().renderedFrames > was + 2,
      (await page.evaluate(() => window.strata.view.inspect())).renderedFrames,
      { timeout: 5000 },
    );
    return page.locator("canvas.render-canvas").screenshot();
  };
  const register = async (id, name, bytes, extra = {}) => {
    const file = join(folder, name);
    writeFileSync(file, bytes);
    return controller.asset({ op: "register", id, path: file, ...extra }, await revision());
  };
  try {
    // The sky only shows from a horizon view: the editor's own overview camera looks down at the ground.
    await controller.camera(
      {
        op: "create",
        camera: {
          id: "horizon",
          name: "Horizon",
          position: [0, 40, 150],
          target: [0, 55, -200],
          up: [0, 1, 0],
          near: 0.5,
          far: 4000,
          projection: "perspective",
          fov: 70,
        },
      },
      await revision(),
    );
    await controller.camera({ op: "activate", id: "horizon" }, await revision());
    await page.waitForFunction(
      () => window.strata.cameras.read().activeCamera === "horizon",
      {},
      { timeout: 5000 },
    );
    await advanceFixedStep(page, session.bridge, 600);
    const starter = await live();
    assert.deepEqual(
      [starter.images.background.state, starter.images.lighting.state, starter.kinds],
      ["procedural", "procedural", { background: "colour", environment: "none" }],
    );
    let last = await shot();
    const step = async (apply) => {
      await apply();
      const next = await shot();
      const result = await compareCaptures(page, last, next);
      last = next;
      return result;
    };
    const control = await step(async () => {});
    assert(control.shift < 0.3, `The control must hold the average colour: ${control.shift}`);

    // Register: an HDR from a local path (the agent), an ordinary image through the real file input.
    const hdr = await register("dusk-hdr", "dusk.hdr", sky(60, 16), {
      license: "CC0-1.0",
      source: "fixture://strata-sky",
    });
    assert.equal(hdr.asset.kind, "environment");
    await page.locator("#asset-inspector").evaluate((el) => {
      el.open = true;
    });
    await page.locator("#asset-file").setInputFiles({
      name: "Overcast.png",
      mimeType: "image/png",
      buffer: Buffer.from(solidPng(64, 32, [180, 180, 190, 255])),
    });
    await page.waitForFunction(
      () => document.querySelector("#asset-row-overcast"),
      {},
      { timeout: 15000 },
    );
    const overcast = (await controller.snapshot()).document.assets.find((a) => a.id === "overcast");
    assert.equal(overcast.kind, "image");

    // Background only, through the real GUI field: the sky changes, the light does not.
    await page.locator("#environment-inspector").evaluate((el) => {
      el.open = true;
    });
    const backgroundStep = await step(async () => {
      await page.locator("#env-sky-intensity").fill("0.5");
      await page.locator("#env-sky-intensity").press("Tab");
      await page.locator("#env-sky-image").selectOption("dusk-hdr");
      await state("background", "ready");
    });
    const onlyBackground = await live();
    assert.equal(onlyBackground.kinds.background, "texture");
    near(onlyBackground.sky.intensity, 0.5, 1e-9, "The sky takes its saved intensity");
    assert.equal(
      onlyBackground.kinds.environment,
      "none",
      "A background image does not light the world",
    );
    assert.equal(
      onlyBackground.images.background.sha256,
      hdr.asset.sha256,
      "The source hash is the saved one",
    );
    assert(
      onlyBackground.images.background.peak > 50,
      `HDR radiance is retained: ${onlyBackground.images.background.peak}`,
    );
    near(onlyBackground.fill.intensity, starter.fill.intensity, 1e-9, "Fill is untouched");
    near(onlyBackground.sun.intensity, starter.sun.intensity, 1e-9, "The sun is untouched");
    assert(
      backgroundStep.shift > control.shift + 0.5,
      `The sky image must show: ${backgroundStep.shift}`,
    );
    await captures(session, "468-environment-sky");
    // Rotation and intensity are live values on the scene.
    const turned = await step(async () => {
      await operate({ sky: { rotation: 120 } });
      await page.waitForFunction(
        () => Math.abs(window.strata.view.inspectEnvironment().sky.rotation - 120) < 1e-6,
        {},
        { timeout: 5000 },
      );
    });
    assert(
      turned.diff > control.diff + 0.3,
      `Rotating the sky must rearrange the picture: ${turned.diff} against a ${control.diff} control`,
    );
    const dimmer = await step(async () => {
      await operate({ sky: { intensity: 0.1 } });
      await page.waitForFunction(
        () => Math.abs(window.strata.view.inspectEnvironment().sky.intensity - 0.1) < 1e-6,
        {},
        { timeout: 5000 },
      );
    });
    assert(
      dimmer.lumaRight < dimmer.lumaLeft,
      `A lower sky intensity must darken: ${dimmer.lumaLeft} -> ${dimmer.lumaRight}`,
    );

    // Lighting only: the sky goes back to colour, the image now lights the world, and the
    // hemisphere fill is not counted on top of it unless it is set on purpose.
    const lit = await step(async () => {
      await operate({
        sky: { image: null, rotation: null, intensity: null },
        lighting: { image: "dusk-hdr", intensity: 1 },
      });
      await state("lighting", "ready");
    });
    const onlyLighting = await live();
    assert.equal(onlyLighting.kinds.background, "colour");
    assert.equal(onlyLighting.kinds.environment, "texture");
    assert.equal(
      onlyLighting.fill.intensity,
      0,
      "The image is the fill: it is not added to the hemisphere",
    );
    near(
      onlyLighting.sun.intensity,
      starter.sun.intensity,
      1e-9,
      "The sun stays its own contribution",
    );
    assert(
      lit.shift > control.shift + 0.3,
      `Image lighting must change the lit picture: ${lit.shift}`,
    );
    const explicit = await operate({ fill: { intensity: 0.4 } });
    await page.waitForFunction(
      (v) => window.strata.view.inspectEnvironment().revision === v,
      explicit.revision,
      { timeout: 5000 },
    );
    near((await live()).fill.intensity, 0.4, 1e-9, "An explicit fill is honoured beside the image");
    await operate({ fill: null, lighting: { rotation: 90, intensity: 0.5 } });
    await page.waitForFunction(
      () => window.strata.view.inspectEnvironment().lighting.rotation === 90,
      {},
      { timeout: 5000 },
    );
    assert.equal((await live()).lighting.intensity, 0.5);

    // Both at once, from different files: independent choices, an ordinary image works as light.
    await operate({ sky: { image: "dusk-hdr" }, lighting: { image: "overcast" } });
    await state("background", "ready");
    await state("lighting", "ready");
    const both = await live();
    assert.deepEqual(
      [both.images.background.id, both.images.lighting.id],
      ["dusk-hdr", "overcast"],
    );
    assert.equal(
      both.images.lighting.peak === null || both.images.lighting.peak <= 1,
      true,
      "An ordinary image is colour, not radiance",
    );

    // Back to the procedural sky: the scene's own objects return to the starter exactly.
    await operate({ sky: { image: null, rotation: null, intensity: null }, lighting: null });
    await state("background", "procedural");
    await state("lighting", "procedural");
    assert.deepEqual(without(await live()).kinds, starter.kinds);
    near((await live()).fill.intensity, starter.fill.intensity, 1e-9, "The fill returns");
    near((await live()).sky.intensity, 1, 1e-9, "The sky intensity returns");

    // A bad image never costs the valid scene. Header-valid but undecodable: the server saves it
    // (it is a registered file), the view fails it by name and keeps what it had.
    const broken = await register("broken-sky", "broken.png", undecodablePng(64, 32));
    assert.equal(broken.asset.kind, "image");
    await operate({ sky: { image: "dusk-hdr", intensity: 0.5 } });
    await state("background", "ready");
    const valid = await live();
    await operate({ sky: { image: "broken-sky" } });
    await state("background", "failed");
    const failed = await live();
    assert.match(failed.images.background.error, /broken-sky/);
    assert.equal(failed.kinds.background, "texture", "The last valid background stays drawn");
    assert.equal(failed.images.background.id, "broken-sky");
    // A corrupt header and a missing asset are refused before they reach the document.
    const refuse = async (bytes, name, pattern) => {
      const file = join(folder, name);
      writeFileSync(file, bytes);
      await assert.rejects(
        controller.asset({ op: "register", id: "bad-sky", path: file }, await revision()),
        pattern,
      );
    };
    await refuse(
      new TextEncoder().encode("#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\nnot a size\n"),
      "bad.hdr",
      /no resolution line/,
    );
    await assert.rejects(
      controller.environment(
        { op: "patch", values: { sky: { image: "missing" } } },
        await revision(),
      ),
      /not a registered environment or image asset/,
    );
    await page.locator("#asset-file").setInputFiles({
      name: "garbage.hdr",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("#?RADIANCE definitely not"),
    });
    await page.waitForFunction(
      () => document.getElementById("asset-error").textContent.includes("Radiance HDR"),
      {},
      { timeout: 5000 },
    );
    // Recovery: the valid image again, and the failure clears.
    await operate({ sky: { image: "dusk-hdr" } });
    await state("background", "ready");
    assert.equal((await live()).images.background.error, undefined);
    assert.equal((await live()).images.background.sha256, valid.images.background.sha256);

    // The asset an environment draws cannot be removed from under it.
    await assert.rejects(
      controller.asset({ op: "remove", id: "dusk-hdr" }, await revision()),
      /clear it first/,
    );

    // Replacement: a new file under the same id is a new hash-named load with its own radiance.
    const hdrUrls = () =>
      page.evaluate(() =>
        performance
          .getEntriesByType("resource")
          .filter((r) => r.name.includes("-dusk-hdr."))
          .map((r) => r.name),
      );
    const before = await hdrUrls();
    const swapped = await register("dusk-hdr", "dusk2.hdr", sky(25, 40), { replace: true });
    assert.notEqual(swapped.asset.sha256, hdr.asset.sha256);
    await page.waitForFunction(
      (sha) => window.strata.view.inspectEnvironment().images.background.sha256 === sha,
      swapped.asset.sha256,
      { timeout: 20000 },
    );
    const replaced = await live();
    assert.equal(replaced.images.background.state, "ready");
    near(
      replaced.images.background.peak,
      26.2,
      0.5,
      "The replacement's radiance, not the cached file's",
    );
    assert((await hdrUrls()).length > before.length, "A replacement is a new hash-named request");

    // Reopen: a second page on the saved document draws the same imagery.
    const fresh = await page.context().newPage();
    try {
      await fresh.goto(page.url());
      await fresh.waitForFunction(
        () => window.strata?.state && !window.strata.busy,
        {},
        { timeout: 60000 },
      );
      await fresh.waitForFunction(
        () => window.strata.view.inspectEnvironment().images.background.state === "ready",
        {},
        { timeout: 30000 },
      );
      const reopened = await fresh.evaluate(() => window.strata.view.inspectEnvironment());
      assert.equal(reopened.images.background.sha256, swapped.asset.sha256);
      assert.equal(reopened.kinds.background, "texture");
      near(reopened.sky.intensity, 0.5, 1e-9, "The saved sky intensity survives a reopen");
    } finally {
      await fresh.close();
      await page.bringToFront();
    }

    await controller.camera({ op: "activate", id: null }, await revision());
    await controller.camera({ op: "delete", id: "horizon" }, await revision());
    // Tidy: the environment back to the project's own, every file's palette entry out.
    await controller.environment({ op: "reset" }, await revision());
    await state("background", "procedural");
    for (const id of ["dusk-hdr", "overcast", "broken-sky"])
      await controller.asset({ op: "remove", id }, await revision());
    assert.deepEqual(without(await live()).kinds, starter.kinds);
    return {
      control: control.shift,
      background: backgroundStep.shift,
      rotated: turned.diff,
      lighting: lit.shift,
      peak: valid.images.background.peak,
    };
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}
