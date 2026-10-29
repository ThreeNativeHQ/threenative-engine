import { readFileSync } from "node:fs";
import {
  InstancedMesh,
  Matrix4,
  OrthographicCamera,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from "three";
import { expect, it, vi } from "vitest";
import { createArmy } from "../templates/rts/src/render/army.js";
import { applyRtsCamera, createRtsView } from "../templates/rts/src/render/camera.js";
import { createUnitModels } from "../templates/rts/src/render/models.js";
import { Game } from "../templates/rts/src/sim/game.js";
import { SIM_STEP } from "../templates/rts/src/sim/types.js";

// Owner, 2026-10-28: "movement is not 100% smooth", and the health bar border looked "slightly
// moving". The rules step 20 times a second and the screen draws 60: a unit drawn where the rules
// left it moved on one frame in three, and a bar on a fractional pixel shimmered as it travelled.
const SIZE = { height: 913, width: 1920 };
const FRAME = 1 / 60;

function match() {
  const game = new Game({ seed: 471 });
  const tank = game.spawn("tank", 0, -62, 38);
  game.command([tank.id], "move", { x: -20, z: -20 }, 0);
  const camera = new OrthographicCamera();
  const view = createRtsView(-62, 38);
  const models = createUnitModels();
  const army = createArmy(models);
  const batch = army.root.children.find(
    (child) =>
      child instanceof InstancedMesh && child.geometry === models.parts("tank", 0)[0]?.geometry,
  );
  const bars = army.root.children.find(
    (child) => child instanceof InstancedMesh && child.geometry instanceof PlaneGeometry,
  );
  return { army, bars, batch: () => batch, camera, game, models, tank, view };
}

it("moves a walking unit on every drawn frame, at an even pace", () => {
  const { army, camera, game, models, tank, view } = match();
  const selected = new Set([tank.id]);
  let accumulator = 0;
  const tracks: Vector3[] = [];
  const bound = vi.spyOn(InstancedMesh.prototype, "computeBoundingSphere");
  for (let frame = 0; frame < 120; frame += 1) {
    accumulator += FRAME;
    while (accumulator >= SIM_STEP) {
      army.step(game);
      game.update(SIM_STEP);
      accumulator -= SIM_STEP;
    }
    applyRtsCamera(camera, view, SIZE, FRAME);
    const pixels = SIZE.height / ((camera.top - camera.bottom) / camera.zoom);
    army.sync(
      game,
      selected,
      game.time,
      FRAME,
      camera,
      pixels,
      accumulator / SIM_STEP,
      camera.position,
    );
    const batch = army.root.children.find(
      (child) =>
        child instanceof InstancedMesh && child.geometry === models.parts("tank", 0)[0]?.geometry,
    ) as InstancedMesh;
    // The spawned tank is the batch's last copy: the base's own tanks come first.
    const matrix = new Matrix4().fromArray(batch.instanceMatrix.array, (batch.count - 1) * 16);
    tracks.push(new Vector3().setFromMatrixPosition(matrix));
  }
  const steps = tracks
    .slice(61)
    .map((point, index) => point.distanceTo(tracks[index + 60] as Vector3));
  const mean = steps.reduce((a, b) => a + b, 0) / steps.length;
  // Every part mesh is `frustumCulled = false`: a per-frame bound is read by nobody, and on the
  // native engine each call crosses the bridge and walks every instance in the batch.
  expect(bound, "computeBoundingSphere calls over 120 drawn frames").not.toHaveBeenCalled();
  bound.mockRestore();
  expect(mean, "the tank must be walking").toBeGreaterThan(0.05);
  // Even motion: every frame moves, and no frame moves twice as far as an ordinary one.
  expect(Math.min(...steps) / mean).toBeGreaterThan(0.7);
  expect(Math.max(...steps) / mean).toBeLessThan(1.3);
  army.dispose();
  models.dispose();
});

it("puts every bar edge on a whole pixel, at AstraCraft's 30 x 3 px with a 1 px frame", () => {
  const { army, bars, camera, game, models, tank, view } = match();
  const selected = new Set([tank.id]);
  const right = new Vector3();
  const up = new Vector3();
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();
  const sizes = new Set<string>();
  for (let frame = 0; frame < 30; frame += 1) {
    game.update(FRAME);
    // A pan that never lands on a whole pixel.
    view.target.x += 0.0173;
    applyRtsCamera(camera, view, SIZE, FRAME);
    const pixels = SIZE.height / ((camera.top - camera.bottom) / camera.zoom);
    army.sync(game, selected, game.time, FRAME, camera, pixels, 1, camera.position);
    right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    const mesh = bars as InstancedMesh;
    expect(mesh.count).toBeGreaterThan(1);
    for (let index = 0; index < mesh.count; index += 1) {
      new Matrix4()
        .fromArray(mesh.instanceMatrix.array, index * 16)
        .decompose(position, rotation, scale);
      position.sub(camera.position);
      const width = scale.x * pixels;
      const height = scale.y * pixels;
      const left = SIZE.width / 2 + position.dot(right) * pixels - width / 2;
      const top = SIZE.height / 2 - position.dot(up) * pixels - height / 2;
      for (const edge of [left, top, width, height])
        expect(Math.abs(edge - Math.round(edge))).toBeLessThan(1e-3);
      sizes.add(`${Math.round(width)}x${Math.round(height)}`);
    }
  }
  // The frame, then the fill: a full-health unit's bar, and the base's buildings at twice the width.
  expect([...sizes].sort()).toEqual(["30x3", "32x5", "60x3", "62x5"]);
  army.dispose();
  models.dispose();
});

it("publishes the HUD state on a 50 ms clock, not once per rendered frame", () => {
  // The scene republishes the camera and the selection every frame, so on the per-frame default
  // each frame paid a JSON serialization and a React render for a HUD read off a 20 Hz clock.
  const source = readFileSync(new URL("../templates/rts/src/game.ts", import.meta.url), "utf8");
  expect(source, "the kit names a UI publication interval").toMatch(/stateFlushMs:\s*50\b/);
});

it("gives the bars and order markers their colour attribute before the first draw", () => {
  // three.js compiles a material once: a batch first drawn without `instanceColor` stays white on
  // `engine: "threejs"`, as the bars did beside AstraCraft (PRD-765 judge round 2).
  const models = createUnitModels();
  const army = createArmy(models);
  const coloured = army.root.children.filter(
    (child) =>
      child instanceof InstancedMesh &&
      (child.geometry instanceof PlaneGeometry ||
        (child.material as { opacity?: number }).opacity === 0.7),
  ) as InstancedMesh[];
  expect(coloured.length, "the bar batch and the marker ring batch").toBe(2);
  for (const mesh of coloured)
    expect(mesh.instanceColor, "colour attribute at creation").not.toBeNull();
  army.dispose();
  models.dispose();
});
