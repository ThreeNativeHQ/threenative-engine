import {
  Color,
  CylinderGeometry,
  Mesh,
  MeshBasicMaterial,
  type PerspectiveCamera,
  PlaneGeometry,
  type Scene,
  type Texture,
} from "three";

export function stage(scene: Scene, camera: PerspectiveCamera, png: Texture): Mesh[] {
  scene.background = new Color(0x101827);
  camera.position.set(0, 3.2, 8.8);
  camera.lookAt(0, 1.1, 0);
  camera.fov = 42;
  camera.updateProjectionMatrix();
  const objects: Mesh[] = [];
  for (const x of [-2.4, 0, 2.4]) {
    const plinth = new Mesh(
      new CylinderGeometry(1.03, 1.1, 0.25, 48),
      new MeshBasicMaterial({ color: 0x263951 }),
    );
    plinth.position.set(x, 0.15, 0);
    scene.add(plinth);
    objects.push(plinth);
  }
  const panel = new Mesh(new PlaneGeometry(1.6, 1.6), new MeshBasicMaterial({ map: png }));
  panel.position.set(2.4, 1.35, 0);
  panel.rotation.y = -0.15;
  scene.add(panel);
  objects.push(panel);
  return objects;
}
