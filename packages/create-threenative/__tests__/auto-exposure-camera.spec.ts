import { PerspectiveCamera, PointLight, Scene } from "three";
import { describe, expect, it } from "vitest";
import { assertExposureCameraCut } from "./fixtures/auto-exposure/cameraProof.js";
import { createFixedExposureRooms } from "./fixtures/auto-exposure/fixedRooms.js";

function fixture(stops = 11) {
  const scene = new Scene();
  const camera = new PerspectiveCamera(48, 16 / 9, 0.1, 100);
  const rooms = createFixedExposureRooms(scene, camera, stops);
  rooms.setPose(true);
  const before = rooms.snapshot();
  rooms.setPose(false);
  const after = rooms.snapshot();
  return { scene, camera, rooms, before, after };
}

function report() {
  const { rooms, before, after } = fixture();
  rooms.dispose();
  return {
    observations: {
      console: [
        { text: `TN_EXPOSURE_SAMPLE:${JSON.stringify({ updates: 180, cameraPose: before })}` },
        { text: `TN_EXPOSURE_CUT:${JSON.stringify({ cameraCut: { before, after } })}` },
        ...Array.from({ length: 180 }, (_, i) => ({
          text: `TN_EXPOSURE_SAMPLE:${JSON.stringify({ updates: 181 + i, cameraPose: after })}`,
        })),
      ],
    },
  };
}

describe("actual camera cuts between fixed-lit exposure rooms", () => {
  it.each([1, 11])("moves the camera %s stops without mutating scene lighting", (stops) => {
    const { scene, camera, rooms, before, after } = fixture(stops);
    expect(before.position).toEqual([106, 4, 9]);
    expect(after.position).toEqual([6, 4, 9]);
    expect(before.matrixWorld).not.toEqual(after.matrixWorld);
    expect(before.projectionMatrix).toEqual(after.projectionMatrix);
    expect(before.rooms).toEqual(after.rooms);
    const lights: PointLight[] = [];
    scene.traverse((object) => {
      if (object instanceof PointLight) lights.push(object);
    });
    expect(lights.map((light) => light.intensity)).toEqual([
      2.1,
      0.36,
      2.1 * 2 ** stops,
      0.36 * 2 ** stops,
    ]);
    expect(lights.every((light) => light.distance === 25)).toBe(true);
    expect(before.layers).toBe(1);
    expect(camera.layers.mask).toBe(1);
    rooms.dispose();
    expect(scene.children).toHaveLength(0);
  });

  it("accepts paired real camera poses across all post-cut GPU samples", () => {
    expect(() => assertExposureCameraCut(report(), 11)).not.toThrow();
  });

  it.each(["room-matrix", "room-background", "light-matrix", "light-color"])(
    "rejects missing, malformed or nonfinite %s in otherwise consistent snapshots",
    (field) => {
      for (const invalid of [undefined, null, [], [1, 2], "missing", Array(16).fill(Number.NaN)]) {
        const value = report();
        for (const entry of value.observations.console) {
          const separator = entry.text.indexOf(":");
          const data = JSON.parse(entry.text.slice(separator + 1));
          const poses =
            data.cameraCut === undefined
              ? [data.cameraPose]
              : [data.cameraCut.before, data.cameraCut.after];
          for (const pose of poses) {
            for (const room of pose.rooms) {
              if (field === "room-matrix") room.matrixWorld = invalid;
              if (field === "room-background") room.background = invalid;
              for (const light of room.lights) {
                if (field === "light-matrix") light.matrixWorld = invalid;
                if (field === "light-color") light.color = invalid;
              }
            }
          }
          entry.text = `${entry.text.slice(0, separator + 1)}${JSON.stringify(data)}`;
        }
        expect(() => assertExposureCameraCut(value, 11)).toThrow(/CAMERA_CUT/);
      }
    },
  );

  it.each(["missing", "stationary", "light-change", "stale-sample", "wrong-layer", "fake-matrix"])(
    "rejects %s camera evidence",
    (fault) => {
      const value = report();
      if (fault === "missing") value.observations.console.shift();
      else if (fault === "stale-sample") {
        const sample = JSON.parse(value.observations.console[0]?.text.slice(19) ?? "{}");
        value.observations.console[2] = {
          text: `TN_EXPOSURE_SAMPLE:${JSON.stringify({ ...sample, updates: 181 })}`,
        };
      } else {
        const cut = JSON.parse(value.observations.console[1]?.text.slice(16) ?? "{}");
        if (fault === "stationary") cut.cameraCut.after = cut.cameraCut.before;
        if (fault === "light-change") cut.cameraCut.after.rooms[0].lights[0].intensity *= 2;
        if (fault === "wrong-layer") cut.cameraCut.after.layers = 2;
        if (fault === "fake-matrix")
          cut.cameraCut.after.matrixWorld = cut.cameraCut.before.matrixWorld;
        value.observations.console[1] = { text: `TN_EXPOSURE_CUT:${JSON.stringify(cut)}` };
      }
      expect(() => assertExposureCameraCut(value, 11)).toThrow(/CAMERA_CUT/);
    },
  );
});
