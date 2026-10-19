// game-v8-demo.js (PRD-531 phase 3): the inspect-demo's world, built entirely in JS through the V8
// adapter. The adapter installs the engine's classes as globals, so `THREE` is just the global
// object and the bundle imports nothing. The `tn` host object is the player's; its shape is
// documented in src/engine/player/v8_main.cpp.
const THREE = globalThis;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1280 / 720, 0.1, 200);
camera.position.set(3.4, 2.6, 4.4);
camera.lookAt(0, 0.8, -1);

function material(hex, roughness) {
  const own = new THREE.MeshStandardMaterial();
  own.color.setHex(hex);
  own.roughness = roughness;
  own.metalness = 0;
  return own;
}

// The floor, drawn as in the C++ demo: a plane rotated flat about X.
const floor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), material(0x383d47, 0.9));
floor.name = "floor";
floor.rotation.x = -Math.PI / 2;
scene.add(floor);

// `player`: the subject the held keys move on the floor, 0.1 per tick at 6 m/s.
const player = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 1.4), material(0xd95a33, 0.35));
player.name = "player";
player.position.set(0, 0.7, 0);
scene.add(player);

// `beacon`: the screenshot's subject, a sphere the game never moves.
const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.7, 32, 16), material(0x40b3e6, 0.25));
beacon.name = "beacon";
beacon.position.set(-2.4, 0.7, 0.8);
scene.add(beacon);

const light = new THREE.DirectionalLight(0xffffff, 3);
light.position.set(4, 8, 4);
scene.add(light);

THREE.tn.scene = scene;
THREE.tn.camera = camera;

THREE.tn.onUpdate((dt) => {
  const step = 6 * dt;
  if (THREE.tn.input.isDown("w") || THREE.tn.input.isDown("ArrowUp")) player.position.z -= step;
  if (THREE.tn.input.isDown("s") || THREE.tn.input.isDown("ArrowDown")) player.position.z += step;
  if (THREE.tn.input.isDown("a") || THREE.tn.input.isDown("ArrowLeft")) player.position.x -= step;
  if (THREE.tn.input.isDown("d") || THREE.tn.input.isDown("ArrowRight")) player.position.x += step;
  player.position.y = 0.7; // the floor keeps its feet on it
});
