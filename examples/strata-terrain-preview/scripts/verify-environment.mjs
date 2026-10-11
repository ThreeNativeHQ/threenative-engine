import assert from "node:assert/strict";
import { advanceFixedStep } from "../../../packages/playtest/dist/runner/index.js";

/**
 * Mean absolute per-channel difference (0-255) between two captures, and each one's mean
 * luminance, decoded in the page so the proof needs no image library.
 */
export async function compareCaptures(page, first, second, region = [0, 0, 1, 1]) {
  return page.evaluate(
    async ([a, b, [fx, fy, fw, fh]]) => {
      const read = async (data) => {
        const bitmap = await createImageBitmap(
          await (await fetch(`data:image/png;base64,${data}`)).blob(),
        );
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext("2d");
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(
          Math.floor(bitmap.width * fx),
          Math.floor(bitmap.height * fy),
          Math.floor(bitmap.width * fw),
          Math.floor(bitmap.height * fh),
        ).data;
      };
      const [left, right] = [await read(a), await read(b)];
      let diff = 0;
      let lumaLeft = 0;
      let lumaRight = 0;
      const meanLeft = [0, 0, 0];
      const meanRight = [0, 0, 0];
      for (let index = 0; index < left.length; index += 4) {
        for (let channel = 0; channel < 3; channel += 1) {
          diff += Math.abs(left[index + channel] - right[index + channel]);
          meanLeft[channel] += left[index + channel];
          meanRight[channel] += right[index + channel];
        }
        lumaLeft += (left[index] + left[index + 1] + left[index + 2]) / 3;
        lumaRight += (right[index] + right[index + 1] + right[index + 2]) / 3;
      }
      const pixels = left.length / 4;
      // How far the picture's average colour moved. A moving sea shuffles pixels without moving
      // the average, so this is the measure a lighting, haze or tint change has to beat.
      const shift =
        meanLeft.reduce((sum, value, channel) => sum + Math.abs(value - meanRight[channel]), 0) /
        pixels;
      return {
        shift,
        diff: diff / (pixels * 3),
        lumaLeft: lumaLeft / pixels,
        lumaRight: lumaRight / pixels,
      };
    },
    [first.toString("base64"), second.toString("base64"), region],
  );
}

const near = (actual, expected, tolerance, message) =>
  assert(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);

export async function verifyEnvironment(session, controller, captures) {
  const page = session.page;
  const live = () => page.evaluate(() => window.strata.view.inspectEnvironment());
  const state = () => page.evaluate(() => window.strata.view.inspect());
  const operate = async (operation) =>
    controller.environment(operation, (await controller.snapshot()).revision);
  const applied = (revision) =>
    page.waitForFunction(
      (value) => window.strata.view.inspectEnvironment().revision === value,
      revision,
      { timeout: 5000 },
    );
  const settled = async () => {
    await advanceFixedStep(page, session.bridge, 30);
    await page.waitForFunction(
      (was) => window.strata.view.inspect().renderedFrames > was + 2,
      (await state()).renderedFrames,
      { timeout: 5000 },
    );
    // The canvas alone: page chrome (status text, panel layout) is not the world under test.
    return page.locator("canvas.render-canvas").screenshot();
  };

  // The terrain, its collision source arrays and the placements are the control: no environment
  // edit may touch them, and none may evaluate the recipe again.
  const terrainBefore = await state();
  const propsBefore = await page.evaluate(() => window.strata.view.inspectProps());
  const heightsBefore = await page.evaluate(() => Array.from(window.strata.state.height));
  const requests = await page.evaluate(() => window.strata.evaluationRequests);
  const starter = await live();
  near(starter.sun.intensity, 2.8, 1e-6, "The starter sun is the project's own value");
  near(starter.fog.density, 0.0008, 1e-9, "The starter haze is the project's own value");
  near(starter.exposure, 1, 1e-9, "The starter exposure is untoned");

  // Every change is judged against the capture taken just before it, and against a control that
  // changes nothing: the sea and the camera's easing also move, so a far-off base is not a fair
  // reference, and a bare difference is not a measurement without a floor beside it.
  // The editor camera eases after a re-frame; let it come to rest before anything is compared.
  await advanceFixedStep(page, session.bridge, 600);
  await settled("env-warmup");
  let last = await settled("env-before");
  const step = async (label, apply) => {
    await apply();
    const next = await settled();
    const result = await compareCaptures(page, last, next);
    console.log(JSON.stringify({ environmentStep: label, ...result }));
    last = next;
    return result;
  };
  const control = await step("env-control", async () => {});
  assert(control.shift < 0.3, `The control must hold the average colour: ${control.shift}`);

  // AI path: a patch through the public endpoint, sun swung low and strong.
  const sunStep = await step("env-sun", async () => {
    const sun = await operate({
      op: "patch",
      values: { sun: { azimuth: -60, elevation: 18, intensity: 6 } },
    });
    await applied(sun.revision);
  });
  const afterSun = await live();
  near(afterSun.sun.azimuth, -60, 1e-6, "The live sun must take the requested azimuth");
  near(afterSun.sun.elevation, 18, 1e-6, "The live sun must take the requested elevation");
  near(afterSun.sun.intensity, 6, 1e-9, "The live sun must take the requested intensity");
  assert(
    sunStep.shift > control.shift + 0.3,
    `A swung sun must move the average colour: ${sunStep.shift} against a ${control.shift} control`,
  );
  await captures(session, "468-environment-sun");

  // GUI path: the same operation through a real field, and the same live scene.
  const density = page.locator("#env-fog-density");
  await page.locator("#environment-inspector > summary").click();
  const hazeStep = await step("env-haze", async () => {
    await density.fill("0.006");
    await density.press("Tab");
    await page.waitForFunction(() => !document.body.dataset.saving, {}, { timeout: 2000 });
    await page.waitForFunction(
      () => Math.abs(window.strata.view.inspectEnvironment().fog.density - 0.006) < 1e-9,
      {},
      { timeout: 5000 },
    );
  });
  assert.equal((await controller.snapshot()).document.environment.fog.density, 0.006);
  assert(
    hazeStep.shift > control.shift + 0.3,
    `Denser haze must move the average colour: ${hazeStep.shift} against a ${control.shift} control`,
  );

  // Colour fields and the sea: independent groups, each one visible.
  const tintStep = await step("env-tint", async () => {
    const tints = await operate({
      op: "patch",
      values: {
        sky: { colour: "#d8a070" },
        fog: { colour: "#d8a070" },
        ocean: { shallow: "#ff3030", deep: "#601010" },
      },
    });
    await applied(tints.revision);
  });
  const afterTints = await live();
  assert.equal(afterTints.sky.colour, "#d8a070");
  assert.equal(afterTints.fog.colour, "#d8a070");
  assert.equal(afterTints.ocean.shallow, "#ff3030");
  assert.equal(afterTints.ocean.deep, "#601010");
  assert(
    tintStep.shift > control.shift + 0.3,
    `Sky, haze and sea tints must show: ${tintStep.shift} against a ${control.shift} control`,
  );
  await captures(session, "468-environment-tint");

  // Exposure: a darker exposure must lower the mean luminance of the same view.
  const exposureStep = await step("env-exposure", async () => {
    const exposure = await operate({ op: "patch", values: { exposure: 0.35 } });
    await applied(exposure.revision);
  });
  near((await live()).exposure, 0.35, 1e-9, "The live renderer must take the exposure");
  assert(
    exposureStep.lumaRight < exposureStep.lumaLeft * 0.8,
    `Lower exposure must darken the view: ${exposureStep.lumaLeft} -> ${exposureStep.lumaRight}`,
  );

  // Rejected values leave the document, the scene and the revision where they were.
  const valid = await controller.snapshot();
  const validLook = await live();
  await assert.rejects(
    controller.environment({ op: "patch", values: { sun: { intensity: -3 } } }, valid.revision),
    /400/,
  );
  await assert.rejects(
    controller.environment({ op: "patch", values: { fog: { mode: "height" } } }, valid.revision),
    /not supported.*exp2/,
  );
  const intensity = page.locator("#env-sun-intensity");
  await intensity.fill("-5");
  await intensity.press("Tab");
  await page.waitForFunction(
    () =>
      document
        .getElementById("environment-error")
        .textContent.includes("environment.sun.intensity"),
    {},
    { timeout: 5000 },
  );
  assert.equal(
    (await controller.snapshot()).revision,
    valid.revision,
    "Rejected edits keep the revision",
  );
  assert.deepEqual(await live(), { ...validLook, revision: (await live()).revision });

  assert.equal(
    await page.evaluate(() => window.strata.evaluationRequests),
    requests,
    "Environment edits must not evaluate the terrain",
  );

  // Persistence: a second page opened on the same saved document draws the saved overrides, from
  // the scene's own objects. (A reload of this page would also drop the capture bridge.)
  const fresh = await page.context().newPage();
  try {
    await fresh.goto(page.url());
    await fresh.waitForFunction(
      () => window.strata?.state && !window.strata.busy,
      {},
      { timeout: 60000 },
    );
    await fresh.waitForFunction(
      () => window.strata.view.inspect().renderedFrames > 3,
      {},
      { timeout: 10000 },
    );
    const reloaded = await fresh.evaluate(() => window.strata.view.inspectEnvironment());
    assert.deepEqual(
      { ...reloaded, revision: "" },
      { ...validLook, revision: "" },
      "A reopened editor must restore the saved look",
    );
  } finally {
    await fresh.close();
    await page.bringToFront();
  }

  // Terrain and its collision source are untouched by all of the above.
  const terrainAfter = await state();
  assert.equal(terrainAfter.heightSum, terrainBefore.heightSum);
  assert.equal(terrainAfter.vertexCount, terrainBefore.vertexCount);
  assert.deepEqual(
    await page.evaluate(() => Array.from(window.strata.state.height)),
    heightsBefore,
  );
  assert.deepEqual(await page.evaluate(() => window.strata.view.inspectProps()), propsBefore);

  // Reset returns the whole look to the project's own: the scene's objects say so exactly, and
  // the picture moves back by as much as the overrides had moved it.
  const resetStep = await step("env-reset", async () => {
    const restored = await operate({ op: "reset" });
    await applied(restored.revision);
  });
  assert.deepEqual({ ...(await live()), revision: "" }, { ...starter, revision: "" });
  assert(
    resetStep.shift > control.shift + 0.3,
    `Reset must change the picture back: ${resetStep.shift} against a ${control.shift} control`,
  );
  return {
    control: control.shift,
    sun: sunStep.shift,
    haze: hazeStep.shift,
    tint: tintStep.shift,
    reset: resetStep.shift,
    exposureLuma: [exposureStep.lumaLeft, exposureStep.lumaRight],
  };
}
