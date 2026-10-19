import {
  BackSide,
  BoxGeometry,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type PerspectiveCamera,
  PointLight,
  type Scene,
  SphereGeometry,
} from "three";

/** Both rooms stay resident and lit. A cut moves only the camera; no light/layer is toggled. */
export function createFixedExposureRooms(scene: Scene, camera: PerspectiveCamera, stops: number) {
  const floor = new BoxGeometry(12, 0.2, 12);
  const block = new BoxGeometry(1, 1, 1);
  const shell = new SphereGeometry(30, 16, 12);
  const materials = [0x9a9a9a, 0xa34a25, 0x246d95, 0xd9c989].map(
    (color) => new MeshStandardMaterial({ color, roughness: 0.85 }),
  );
  const rooms = [0, 1].map((index) => {
    const group = new Group();
    group.position.x = index * 100;
    const multiplier = 2 ** (index * stops);
    const ground = new Mesh(floor, materials[0]);
    ground.position.y = -0.1;
    group.add(ground);
    for (let i = 0; i < 12; i++) {
      const box = new Mesh(block, materials[i % materials.length]);
      box.position.set(
        (i % 4) * 1.8 - 2.7,
        0.5 + Math.floor(i / 4) * 0.2,
        Math.floor(i / 4) * 1.8 - 1.8,
      );
      box.scale.y = 1 + Math.floor(i / 4) * 0.4;
      group.add(box);
    }
    // Local finite-radius lights have identical relative placement and no cross-room influence.
    const sun = new PointLight(0xfff4df, 2.1 * multiplier, 25, 2);
    sun.position.set(4, 7, 3);
    const fill = new PointLight(0xffffff, 0.36 * multiplier, 25, 2);
    fill.position.set(0, 6, 0);
    const background = new MeshBasicMaterial({
      color: new Color(0x445565).multiplyScalar(0.01 * multiplier),
      side: BackSide,
    });
    const backdrop = new Mesh(shell, background);
    group.add(sun, fill, backdrop);
    scene.add(group);
    return { group, lights: [sun, fill], background };
  });
  const snapshot = () => {
    scene.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
    return {
      position: camera.position.toArray(),
      quaternion: camera.quaternion.toArray(),
      matrixWorld: camera.matrixWorld.toArray(),
      projectionMatrix: camera.projectionMatrix.toArray(),
      layers: camera.layers.mask,
      rooms: rooms.map(({ group, lights, background }) => ({
        position: group.position.toArray(),
        matrixWorld: group.matrixWorld.toArray(),
        layers: group.layers.mask,
        background: background.color.toArray(),
        lights: lights.map((light) => ({
          intensity: light.intensity,
          distance: light.distance,
          decay: light.decay,
          color: light.color.toArray(),
          layers: light.layers.mask,
          matrixWorld: light.matrixWorld.toArray(),
        })),
      })),
    };
  };
  return {
    snapshot,
    setPose(bright: boolean) {
      const offset = bright ? 100 : 0;
      camera.position.set(offset + 6, 4, 9);
      camera.lookAt(offset, 1.2, 0);
      camera.updateMatrixWorld(true);
    },
    dispose() {
      for (const { group, background } of rooms) {
        scene.remove(group);
        background.dispose();
      }
      for (const material of materials) material.dispose();
      floor.dispose();
      block.dispose();
      shell.dispose();
    },
  };
}
