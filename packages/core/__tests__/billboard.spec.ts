import { Group, OrthographicCamera, PerspectiveCamera, Quaternion, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { Billboard3D } from "../src/billboard.js";

const FRONT = new Vector3(0, 0, 1);
const UP = new Vector3(0, 1, 0);

function worldFront(object: Group): Vector3 {
  const quaternion = object.getWorldQuaternion(new Quaternion());
  return FRONT.clone().applyQuaternion(quaternion);
}

function worldUp(object: Group): Vector3 {
  const quaternion = object.getWorldQuaternion(new Quaternion());
  return UP.clone().applyQuaternion(quaternion);
}

function projectedCameraUp(camera: PerspectiveCamera, normal: Vector3): Vector3 {
  const quaternion = camera.getWorldQuaternion(new Quaternion());
  return UP.clone().applyQuaternion(quaternion).projectOnPlane(normal).normalize();
}

describe("Billboard3D", () => {
  it("faces a perspective camera through a rotated parent", () => {
    const camera = new PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(5, 3, 7);
    camera.lookAt(0, 1, 0);

    const parent = new Group();
    parent.position.set(-2, 0.5, 1);
    parent.rotation.set(0.35, -0.8, 0.2);
    const label = new Group();
    label.position.set(1, 1.5, -0.5);
    parent.add(label);

    const billboard = new Billboard3D(label, { camera });
    billboard.update();

    const labelPosition = label.getWorldPosition(new Vector3());
    const cameraPosition = camera.getWorldPosition(new Vector3());
    const expectedDirection = cameraPosition.sub(labelPosition).normalize();
    expect(worldFront(label).angleTo(expectedDirection)).toBeCloseTo(0, 6);
  });

  it("uses an orthographic camera's forward direction instead of its position", () => {
    const camera = new OrthographicCamera(-4, 4, 4, -4, 0.1, 100);
    camera.position.set(100, 40, 80);
    camera.lookAt(100, 40, 79);
    camera.updateWorldMatrix(true, false);

    const label = new Group();
    label.position.set(-30, 12, 20);
    const billboard = new Billboard3D(label, { camera });
    billboard.update();
    const firstFront = worldFront(label);

    camera.position.set(-500, -300, 900);
    camera.updateWorldMatrix(true, false);
    billboard.update();

    const cameraQuaternion = camera.getWorldQuaternion(new Quaternion());
    const expectedDirection = new Vector3(0, 0, -1).applyQuaternion(cameraQuaternion).negate();
    expect(firstFront.angleTo(expectedDirection)).toBeCloseTo(0, 6);
    expect(worldFront(label).angleTo(firstFront)).toBeCloseTo(0, 6);
  });

  it("keeps camera-relative up when the camera rolls", () => {
    const camera = new PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(5, 4, 8);
    camera.lookAt(0, 0.5, 0);
    camera.rotateZ(0.8);
    camera.updateWorldMatrix(true, false);

    const parent = new Group();
    parent.position.set(-1.5, 0.75, 1.25);
    parent.rotation.set(0.4, -0.65, 0.3);
    const label = new Group();
    label.position.set(0.8, 1.2, -0.4);
    parent.add(label);

    new Billboard3D(label, { camera }).update();

    const expectedDirection = camera
      .getWorldPosition(new Vector3())
      .sub(label.getWorldPosition(new Vector3()))
      .normalize();
    const expectedUp = projectedCameraUp(camera, expectedDirection);
    expect(worldFront(label).angleTo(expectedDirection)).toBeCloseTo(0, 6);
    expect(worldUp(label).angleTo(expectedUp)).toBeCloseTo(0, 6);
  });

  it("faces an overhead nameplate when no axis is locked", () => {
    const camera = new PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 20, 0.1);
    camera.lookAt(0, 0, 0);

    const parent = new Group();
    parent.rotation.y = 0.22;
    const label = new Group();
    parent.add(label);

    new Billboard3D(label, { camera }).update();

    const expected = camera
      .getWorldPosition(new Vector3())
      .sub(label.getWorldPosition(new Vector3()))
      .normalize();
    expect(worldFront(label).angleTo(expected)).toBeCloseTo(0, 6);
  });

  it("locks a nameplate to the world's y axis", () => {
    const camera = new PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(4, 8, 6);
    camera.lookAt(0, 0, 0);
    const parent = new Group();
    parent.rotation.y = 1.2;
    const label = new Group();
    parent.add(label);

    new Billboard3D(label, { camera, lockAxis: "y" }).update();

    const front = worldFront(label);
    const expected = camera
      .getWorldPosition(new Vector3())
      .sub(label.getWorldPosition(new Vector3()))
      .setY(0)
      .normalize();
    expect(front.y).toBeCloseTo(0, 6);
    expect(front.angleTo(expected)).toBeCloseTo(0, 6);
  });

  it("fails closed for a missing camera and invalid lock axis", () => {
    const label = new Group();
    expect(() => new Billboard3D(label, {} as never)).toThrow("Billboard3D.camera");
    expect(
      () => new Billboard3D(label, { camera: new PerspectiveCamera(), lockAxis: "q" as never }),
    ).toThrow("Billboard3D.lockAxis");
  });

  it("delegates to __tnBillboardFace once when provided by the owned engine", () => {
    const camera = new PerspectiveCamera();
    const label = new Group();
    let worldCalls = 0;
    label.updateWorldMatrix = () => {
      worldCalls += 1;
    };
    const seen: unknown[] = [];
    Object.assign(label, {
      __tnBillboardFace(this: unknown, cam: unknown, lock: number) {
        seen.push(this, cam, lock);
        return this;
      },
    });
    new Billboard3D(label, { camera }).update();
    new Billboard3D(label, { camera, lockAxis: "x" }).update();
    new Billboard3D(label, { camera, lockAxis: "y" }).update();
    new Billboard3D(label, { camera, lockAxis: "z" }).update();
    expect(seen).toEqual([label, camera, 0, label, camera, 1, label, camera, 2, label, camera, 3]);
    expect(worldCalls).toBe(0);
  });
});
