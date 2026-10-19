import {
  AmbientLight,
  BoxGeometry,
  DirectionalLight,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  SphereGeometry,
} from "three";

/** Neutral ramp and lit 3D subjects make the exposure mutation inspectable in a real render. */
export function createToneCalibration(): { camera: OrthographicCamera; scene: Scene } {
  const scene = new Scene();
  const camera = new OrthographicCamera(-2, 2, 1.125, -1.125, 0.1, 20);
  camera.position.z = 5;
  const panel = new PlaneGeometry(4 / 256, 2.25);
  for (let value = 0; value < 256; value += 1) {
    const material = new MeshBasicMaterial();
    material.color.setRGB(value / 255, value / 255, value / 255);
    const strip = new Mesh(panel, material);
    strip.position.x = -2 + (value + 0.5) * (4 / 256);
    scene.add(strip);
  }
  const material = new MeshStandardMaterial({ color: 0x999999, roughness: 0.35 });
  const sphere = new Mesh(new SphereGeometry(0.32, 32, 24), material);
  sphere.position.set(-0.65, 0, 0.4);
  const cube = new Mesh(new BoxGeometry(0.48, 0.48, 0.48), material);
  cube.position.set(0.65, 0, 0.4);
  cube.rotation.set(0.3, 0.5, 0);
  const key = new DirectionalLight(0xffffff, 3);
  key.position.set(-2, 3, 4);
  scene.add(sphere, cube, new AmbientLight(0xffffff, 0.4), key);
  return { camera, scene };
}
