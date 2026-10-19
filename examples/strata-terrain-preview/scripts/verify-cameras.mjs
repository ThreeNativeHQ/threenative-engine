import assert from "node:assert/strict";
import { advanceFixedStep } from "../../../packages/playtest/dist/runner/index.js";

const SURVEY = {
  id: "survey-ridge",
  name: "Survey ridge",
  position: [46, 34, 58],
  target: [4, 12, -6],
  up: [0, 1, 0],
  projection: "perspective",
  fov: 45,
  near: 0.5,
  far: 2400,
};
const MAP = {
  id: "survey-map",
  name: "Survey map",
  position: [0, 420, 0],
  target: [0, 12, 0],
  up: [0, 0, -1],
  projection: "orthographic",
  extent: 220,
  zoom: 1,
  near: 1,
  far: 2000,
};
/** A registered landmark is a saved reference control point, so focus resolves a real position. */
const REFERENCES = [
  {
    id: "field-survey",
    kind: "top-down-map",
    hash: "a".repeat(64),
    source: "editor camera lane fixture",
    controls: [
      { id: "spring", image: [120, 90], world: [38, -44] },
      { id: "gate", image: [300, 240], world: [-52, 26] },
    ],
  },
];
const SCALED = [2.4, 0.45, 1.6];

export async function verifyEditorCameras(session, controller, captures) {
  const page = session.page;
  const operate = async (operation) =>
    controller.camera(operation, (await controller.snapshot()).revision);
  const pose = () => page.evaluate(() => window.strata.cameras.read());
  // A framing reaches the screen and the projection matrices on drawn frames, so measuring waits
  // for real presented frames rather than for simulated steps.
  const focus = async (target) => {
    const frame = await page.evaluate(() => window.strata.view.inspect().renderedFrames);
    const outcome = await page.evaluate((value) => window.strata.cameras.focus(value), target);
    await page.waitForFunction(
      (was) => window.strata.view.inspect().renderedFrames > was + 1,
      frame,
      {
        timeout: 5000,
      },
    );
    return outcome;
  };
  const boundsOf = (target) =>
    page.evaluate(
      (value) =>
        value.kind === "point"
          ? { min: value.at, max: value.at }
          : window.strata.cameras.resolve({ kind: value.kind, id: value.id }),
      target,
    );
  const measure = (bounds) =>
    page.evaluate((value) => window.strata.cameras.measure(value), bounds);
  // Damped orbit controls keep easing for a while after a drag, so a pose is only read once the
  // easing has decayed: 600 fixed steps is well past the 5 %-per-step decay of the fixture.
  const settle = async () => {
    await advanceFixedStep(page, session.bridge, 600);
    return pose();
  };
  const same = (actual, expected, message) => {
    for (let index = 0; index < expected.length; index += 1)
      assert(
        Math.abs(actual[index] - expected[index]) < 1e-3,
        `${message}: ${JSON.stringify(actual)}`,
      );
  };
  const requests = await page.evaluate(() => window.strata.evaluationRequests);
  assert.equal(
    (await pose()).activeCamera,
    null,
    "The fixture starts on the ordinary editor camera",
  );

  // AC-1: the GUI list saves and activates through the same operations an agent calls.
  await page.locator("#camera-name").fill("GUI ridge");
  await page.locator("#camera-save").click();
  await page.waitForFunction(
    () => document.querySelectorAll("#camera-list button").length === 1,
    {},
    {
      timeout: 5000,
    },
  );
  const guiCamera = (await controller.snapshot()).document.cameras[0];
  assert.equal(guiCamera.name, "GUI ridge");
  await page.locator("#camera-list button").click();
  await page.waitForFunction(
    () => window.strata.cameras.read().activeCamera !== null,
    {},
    {
      timeout: 5000,
    },
  );
  const guiActive = await pose();
  same(guiActive.position, guiCamera.position, "The GUI must move the real camera");
  await operate({ op: "delete", id: guiCamera.id });
  await page.waitForFunction(
    () => window.strata.cameras.read().activeCamera === null,
    {},
    {
      timeout: 5000,
    },
  );

  // AC-1: a controller-created camera reaches the live camera, not only the document.
  const created = await operate({ op: "create", camera: SURVEY });
  assert.equal(created.camera.id, "survey-ridge");
  await operate({ op: "activate", id: "survey-ridge" });
  await page.waitForFunction(
    () => window.strata.cameras.read().activeCamera === "survey-ridge",
    {},
    {
      timeout: 5000,
    },
  );
  const activated = await pose(page);
  same(activated.position, SURVEY.position, "The live camera must take the saved position");
  same(activated.target, SURVEY.target, "The live camera must take the saved target");
  assert.equal(activated.fov, SURVEY.fov, "The live projection must change, not only the pose");
  assert.equal(activated.projection, "perspective");
  assert(activated.aspect > 0, "The aspect is measured, never saved");
  const looking = await measure({ min: [-3, 4, -8], max: [12, 30, 6] });
  assert(
    looking.x < 1 && looking.y < 1,
    "The activated view must actually be looking at the world",
  );
  assert.equal(
    await page.evaluate(() => window.strata.evaluationRequests),
    requests,
    "Camera operations must not evaluate terrain",
  );
  await captures(session, "468-controller-camera");

  // A manual orbit is the user's, until an explicit update records it.
  const box = await page.locator("canvas.render-canvas").boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(box.x + box.width / 2 + 160, box.y + box.height / 2 - 40, { steps: 8 });
  await page.mouse.up({ button: "right" });
  const orbited = await settle();
  assert(
    orbited.position.some((value, index) => Math.abs(value - SURVEY.position[index]) > 0.01),
    "The right-drag orbit must actually move the camera",
  );
  const beforeRebake = await controller.snapshot();
  await controller.commit({
    baseRevision: beforeRebake.revision,
    commands: [{ op: "update", id: "eroded-hill", patch: { params: { amplitude: 42 } } }],
  });
  const rebaked = await controller.snapshot();
  await page.waitForFunction(
    (revision) => window.strata.view.inspect().renderedRevision === revision,
    rebaked.revision,
    { timeout: 5000 },
  );
  const afterRebake = await settle();
  same(afterRebake.position, orbited.position, "A terrain rebake must not reset the manual orbit");
  same(afterRebake.target, orbited.target, "A terrain rebake must not reset the manual orbit");
  same(
    (await controller.snapshot()).document.cameras[0].position,
    SURVEY.position,
    "An orbit is not a bookmark until it is explicitly saved",
  );
  // The deliberate rebake above is the only evaluation; from here the floor is camera work alone.
  const afterRebakeRequests = await page.evaluate(() => window.strata.evaluationRequests);
  assert(afterRebakeRequests > requests, "The fixture must actually rebake for this proof");
  const updated = await operate({
    op: "update",
    id: "survey-ridge",
    patch: { position: orbited.position, target: orbited.target },
  });
  same(updated.camera.position, orbited.position, "An explicit update is what persists an orbit");
  await page.waitForFunction(
    (position) => Math.abs(window.strata.cameras.read().position[0] - position) < 1e-3,
    orbited.position[0],
    { timeout: 5000 },
  );

  // AC-2: focus one nonuniformly scaled instance of an instanced batch, siblings untouched.
  const props = await page.evaluate(() => window.strata.view.inspectProps());
  const target = props[0];
  assert(target, "The fixture must render props");
  const posed = await controller.snapshot();
  const scaled = await controller.commit({
    baseRevision: posed.revision,
    document: {
      ...posed.document,
      placementOverrides: {
        ...posed.document.placementOverrides,
        [target.id]: {
          position: [16, 150, -8],
          quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
          scale: SCALED,
          grounding: false,
        },
      },
    },
  });
  await page.waitForFunction(
    (revision) => window.strata.view.inspect().renderedRevision === revision,
    scaled.revision,
    { timeout: 5000 },
  );
  await advanceFixedStep(page, session.bridge, 2);
  const siblingsBefore = (await page.evaluate(() => window.strata.view.inspectProps())).filter(
    (prop) => prop.id !== target.id,
  );
  const distances = [];
  for (const size of [
    { width: 1280, height: 720 },
    { width: 860, height: 1000 },
  ]) {
    await page.setViewportSize(size);
    await advanceFixedStep(page, session.bridge, 2);
    const outcome = await focus({ kind: "prop", id: target.id });
    assert.equal(outcome.diagnostic, null);
    const clip = await measure(await boundsOf({ kind: "prop", id: target.id }));
    distances.push(outcome.framing.distanceMetres);
    assert(
      clip.x < 0.9 && clip.y < 0.9,
      `the focused prop must sit inside the safe frame at ${size.width}x${size.height}: ${JSON.stringify(clip)}`,
    );
    assert.equal(clip.z, true, "The framed bounds must sit between the clipping planes");
  }
  assert.notDeepEqual(
    distances,
    "A different viewport aspect must be framed from the live viewport",
  );
  await captures(session, "468-focused-prop");
  assert.deepEqual(
    (await page.evaluate(() => window.strata.view.inspectProps())).filter(
      (prop) => prop.id !== target.id,
    ),
    siblingsBefore,
    "Focusing one instance must leave every sibling matrix untouched",
  );
  const focused = await page.evaluate(
    (id) => window.strata.view.inspectProps().find((prop) => prop.id === id),
    target.id,
  );
  focused.transform.scale.forEach((value, index) =>
    assert(Math.abs(value - SCALED[index]) < 1e-4, "Focusing must not rescale the prop"),
  );

  // A registered landmark, a terrain region and a local point all frame through the same call.
  const registered = await controller.snapshot();
  const withReferences = await controller.commit({
    baseRevision: registered.revision,
    document: { ...registered.document, references: REFERENCES },
  });
  await page.waitForFunction(
    (revision) => window.strata.revision === revision,
    withReferences.revision,
    {
      timeout: 5000,
    },
  );
  for (const requested of [
    { kind: "landmark", id: "spring" },
    { kind: "region", id: "terrain" },
    { kind: "point", at: [-30, 20, 44] },
  ]) {
    const outcome = await focus(requested);
    assert.equal(outcome.diagnostic, null, JSON.stringify(outcome.diagnostic));
    const clip = await measure(await boundsOf(requested));
    assert(
      clip.x < 0.95 && clip.y < 0.95,
      `focus ${requested.kind} must frame its target: ${JSON.stringify(clip)}`,
    );
    assert.equal(clip.z, true);
  }
  assert.equal(
    await page.evaluate(() => window.strata.evaluationRequests),
    afterRebakeRequests,
    "Focusing must not evaluate terrain",
  );

  // AC-1: an active orthographic camera drives a real top-down map view.
  await operate({ op: "create", camera: MAP });
  await operate({ op: "activate", id: "survey-map" });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForFunction(
    () => window.strata.cameras.read().projection === "orthographic",
    {},
    { timeout: 5000 },
  );
  const map = await pose(page);
  assert.equal(map.extent, MAP.extent);
  assert.equal(map.zoom, MAP.zoom);
  same(map.up, MAP.up, "The map view keeps its own up vector");
  await focus({ kind: "region", id: "terrain" });
  const worldClip = await measure(await boundsOf({ kind: "region", id: "terrain" }));
  assert(
    worldClip.x < 0.95 && worldClip.y < 0.95,
    `the map view must frame the whole terrain: ${JSON.stringify(worldClip)}`,
  );
  assert.equal(worldClip.z, true);
  await advanceFixedStep(page, session.bridge, 3);
  await captures(session, "468-orthographic-map");
  await focus({ kind: "prop", id: target.id });
  const mapClip = await measure(await boundsOf({ kind: "prop", id: target.id }));
  assert(mapClip.x < 0.9 && mapClip.y < 0.9, "The map view must frame the same prop top-down");
  // ponytail: the ortho clip range of a *prop* framing is unit-proven; the browser proves the
  // screen frame, and the drawn map view is the real orthographic render.

  // An unknown target is a named diagnostic, and the view keeps the camera it had.
  const held = await pose(page);
  const failed = await focus({ kind: "prop", id: "no-such-prop" });
  assert.equal(failed.camera, null);
  assert.match(failed.diagnostic, /No focus target for prop 'no-such-prop'/u);
  const retained = await pose(page);
  same(retained.position, held.position, "A failed focus must not move the view");
  same(retained.target, held.target, "A failed focus must not move the view");

  // AC-1: the saved cameras and the live one are read back from the server, not session state.
  const persisted = await controller.snapshot();
  assert.deepEqual(
    persisted.document.cameras.map((camera) => camera.id),
    ["survey-ridge", "survey-map"],
  );
  assert.equal(persisted.document.activeCamera, "survey-map");
  assert.equal((await controller.activate()).revision, persisted.revision);

  // Deleting the live camera falls back to the ordinary editor camera and reports it.
  const deleted = await operate({ op: "delete", id: "survey-map" });
  assert.equal(deleted.fallback, "editor-camera");
  assert.equal(deleted.activeCamera, null);
  await page.waitForFunction(
    () => window.strata.cameras.read().projection === "perspective",
    {},
    {
      timeout: 5000,
    },
  );
  assert.equal(
    await page.evaluate(() => window.strata.evaluationRequests),
    afterRebakeRequests,
    "No camera or focus path may evaluate terrain",
  );
}
