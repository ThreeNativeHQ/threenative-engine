// The L4 rung (PRD-117 §3, PRD-449 R3) as a plain three script for the native engine's game host
// (PRD-534 CP1, arm `native-v8`): the same placements, per-cube colour, bob, rotation and camera
// orbit as the browser and legacy-host arms, from the same workload.ts functions, written against
// three's class names the V8 adapter installs as globals. Bundled to an IIFE for the host.
import {
  cameraPose,
  createPlacements,
  cubeBobY,
  cubeRotationX,
  cubeRotationY,
  uniqueMaterialColor,
} from "../src/workload.js";

// The host installs these as globals (the engine's catalogued classes); three's types describe them.
declare const Scene: typeof import("three").Scene;
declare const PerspectiveCamera: typeof import("three").PerspectiveCamera;
declare const Mesh: typeof import("three").Mesh;
declare const BoxGeometry: typeof import("three").BoxGeometry;
declare const PlaneGeometry: typeof import("three").PlaneGeometry;
declare const MeshStandardMaterial: typeof import("three").MeshStandardMaterial;
declare const DirectionalLight: typeof import("three").DirectionalLight;

type MeshT = import("three").Mesh;
let cubes: MeshT[] = [];
let placements: ReturnType<typeof createPlacements> = [];
let camera: import("three").PerspectiveCamera;
let objectCount = 0;

// game.ts's authored scene: one lit material (cloned per cube under L4), a 200x200 ground, one sun.
function setup(count: number, width: number, height: number) {
  objectCount = count;
  const scene = new Scene();
  camera = new PerspectiveCamera(60, width / height, 0.1, 4000);
  const material = new MeshStandardMaterial();
  material.color.setHex(0xb8c4cc);
  material.metalness = 0;
  material.roughness = 0.75;
  const ground = new Mesh(new PlaneGeometry(200, 200), material);
  ground.rotation.x = -Math.PI / 2;
  ground.matrixAutoUpdate = false;
  ground.updateMatrix();
  scene.add(ground);
  const light = new DirectionalLight(0xffffff, 2.4);
  light.position.set(40, 80, 25);
  scene.add(light);
  const box = new BoxGeometry(1, 1, 1);
  placements = createPlacements(count);
  cubes = placements.map((placement, index) => {
    const own = new MeshStandardMaterial(); // L4: a clone of the shared material per cube
    own.metalness = 0;
    own.roughness = 0.75;
    own.color.setHex(uniqueMaterialColor(index));
    const cube = new Mesh(box, own);
    cube.position.set(placement.x, placement.y, placement.z);
    scene.add(cube);
    return cube;
  });
  return { scene, camera };
}

// writeAuthoredTransforms (mutation rate 1: every cube is dirty) and the camera's orbit.
function update(frameIndex: number) {
  const pose = cameraPose(frameIndex, objectCount);
  camera.position.set(pose.x, pose.y, pose.z);
  camera.lookAt(pose.targetX, pose.targetY, pose.targetZ);
  for (let index = 0; index < cubes.length; index += 1) {
    const cube = cubes[index] as MeshT;
    cube.position.y = cubeBobY(index, frameIndex, (placements[index] as { y: number }).y);
    cube.rotation.x = cubeRotationX(index, frameIndex);
    cube.rotation.y = cubeRotationY(index, frameIndex);
  }
}

(globalThis as unknown as { workload: unknown }).workload = { setup, update };
