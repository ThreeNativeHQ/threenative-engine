import { Matrix4, Quaternion, Vector3 } from "three";
import type { createFixedExposureRooms } from "./fixedRooms.js";

type CameraPose = ReturnType<ReturnType<typeof createFixedExposureRooms>["snapshot"]>;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
function fail(): never {
  throw new Error("TN_EXPOSURE_CAMERA_CUT: Camera poses or fixed lighting evidence is invalid.");
}

function finiteVector(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length && value.every(Number.isFinite);
}

function validateRooms(rooms: CameraPose["rooms"], stops: number): void {
  if (!Array.isArray(rooms) || rooms.length !== 2) fail();
  for (const [index, room] of rooms.entries()) {
    if (
      room === null ||
      typeof room !== "object" ||
      !same(room.position, [index * 100, 0, 0]) ||
      room.layers !== 1 ||
      !finiteVector(room.matrixWorld, 16) ||
      !finiteVector(room.background, 3) ||
      !Array.isArray(room.lights) ||
      room.lights.length !== 2
    )
      fail();
    for (const [lightIndex, light] of room.lights.entries()) {
      if (
        light === null ||
        typeof light !== "object" ||
        light.intensity !== (lightIndex === 0 ? 2.1 : 0.36) * 2 ** (index * stops) ||
        light.distance !== 25 ||
        light.decay !== 2 ||
        light.layers !== 1 ||
        !finiteVector(light.matrixWorld, 16) ||
        !finiteVector(light.color, 3)
      )
        fail();
    }
  }
}

function validatePose(value: CameraPose, bright: boolean, stops: number): void {
  if (value === undefined || value === null || ![1, 11].includes(stops)) fail();
  const offset = bright ? 100 : 0;
  const arrays = [value.position, value.quaternion, value.matrixWorld, value.projectionMatrix];
  if (
    arrays.some(
      (array, i) =>
        !Array.isArray(array) ||
        array.length !== [3, 4, 16, 16][i] ||
        !array.every(Number.isFinite),
    )
  )
    fail();
  const matrix = new Matrix4().compose(
    new Vector3().fromArray(value.position),
    new Quaternion().fromArray(value.quaternion),
    new Vector3(1, 1, 1),
  );
  if (
    !same(value.position, [offset + 6, 4, 9]) ||
    value.layers !== 1 ||
    matrix.elements.some((n, i) => Math.abs(n - (value.matrixWorld[i] ?? Number.NaN)) > 1e-9)
  )
    fail();
  validateRooms(value.rooms, stops);
}

/** Camera proof is mandatory even when the same-budget raw-luminance mutation is expected red. */
export function assertExposureCameraCut(
  report: { observations?: { console: readonly { text: string }[] } },
  stops: number,
): void {
  const entries = report.observations?.console ?? [];
  const cuts = entries.flatMap(({ text }, index) =>
    text.startsWith("TN_EXPOSURE_CUT:") ? [index] : [],
  );
  if (cuts.length !== 1) fail();
  const cutIndex = cuts[0];
  if (cutIndex === undefined) fail();
  const { cameraCut } = JSON.parse(entries[cutIndex]?.text.slice(16) ?? "{}");
  if (cameraCut === undefined) fail();
  const { before, after } = cameraCut as { before: CameraPose; after: CameraPose };
  const bright = before?.position?.[0] === 106;
  validatePose(before, bright, stops);
  validatePose(after, !bright, stops);
  if (
    !same(before.rooms, after.rooms) ||
    !same(before.projectionMatrix, after.projectionMatrix) ||
    before.quaternion.some((n, i) => Math.abs(n - (after.quaternion[i] ?? Number.NaN)) > 1e-9)
  )
    fail();
  const samples = (part: readonly { text: string }[]) =>
    part
      .filter(({ text }) => text.startsWith("TN_EXPOSURE_SAMPLE:"))
      .map(({ text }) => JSON.parse(text.slice(19)));
  const warmup = samples(entries.slice(0, cutIndex));
  const changed = samples(entries.slice(cutIndex + 1));
  if (
    warmup.length === 0 ||
    changed.length !== 180 ||
    warmup.some((sample) => !same(sample.cameraPose, before)) ||
    changed.some((sample) => !same(sample.cameraPose, after))
  )
    fail();
}
